package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
)

// ACP emits agent_message_chunk on model deltas; run --format json waits for
// completed text parts. Only callers opting into text backpressure use ACP.
func (b *opencodeBackend) executeACP(ctx context.Context, prompt string, opts ExecOptions) (*Session, error) {
	executable := b.cfg.ExecutablePath
	if executable == "" {
		executable = "opencode"
	}
	resolved, err := exec.LookPath(executable)
	if err != nil {
		return nil, fmt.Errorf("opencode executable not found: %w", err)
	}
	if runtime.GOOS == "windows" {
		if native := resolveOpenCodeNativeFromShim(resolved, os.Stat); native != "" {
			resolved = native
		}
	}
	cwd := opts.Cwd
	if cwd == "" {
		cwd, err = os.Getwd()
	} else {
		cwd, err = filepath.Abs(cwd)
	}
	if err != nil {
		return nil, fmt.Errorf("opencode cwd: %w", err)
	}
	mcpContent, err := buildOpenCodeMCPConfigContent(opts.McpConfig)
	if err != nil {
		return nil, err
	}
	// ACP has a different flag surface. Reject custom CLI flags explicitly:
	// forwarding run flags can change listener, sharing, or permission policy.
	if len(opts.CustomArgs) != 0 {
		return nil, fmt.Errorf("opencode streaming ACP does not support custom_args")
	}
	runCtx, cancel := runContext(ctx, opts.Timeout)
	args := []string{"acp", "--cwd", cwd}
	cmd := b.cfg.commandAt(resolved).exec(runCtx, args...)
	hideAgentWindow(cmd)
	cmd.Cancel = func() error { return nil }
	cmd.WaitDelay = time.Second
	cmd.Dir = cwd
	// ACP omits CLI-only plan tools. Disable the question-tool opt-in too,
	// preserving run's headless policy without reordering permission rules.
	cmd.Env = append(buildEnv(b.cfg.Env), "PWD="+cwd, "OPENCODE_ENABLE_QUESTION_TOOL=false")
	if mcpContent != "" {
		cmd.Env = append(cmd.Env, "OPENCODE_CONFIG_CONTENT="+mcpContent)
	}
	b.cfg.logAgentCommand(cmd, newAgentCommandLogArgs(args, trustAgentCommandPositional(0, "acp")))
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		_ = stdout.Close()
		cancel()
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		_ = stdout.Close()
		_ = stdin.Close()
		cancel()
		return nil, err
	}
	if err := startOwnedProcessTree(cmd, b.cfg.Logger); err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		_ = stderr.Close()
		cancel()
		return nil, fmt.Errorf("start opencode ACP: %w", err)
	}
	msgCh := make(chan Message, 256)
	resCh := make(chan Result, 1)
	var active atomic.Bool
	var session atomic.Value
	session.Store("")
	var deliverable acpDeliverableTracker
	transportCtx, stopTransport := context.WithCancel(runCtx)
	activity := make(chan struct{}, 1)
	c := &hermesClient{cfg: b.cfg, stdin: stdin, pending: make(map[int]*pendingRPC), pendingTools: make(map[string]*pendingToolCall)}
	c.selectPermission = func(params json.RawMessage) (string, bool, bool) {
		var request struct {
			SessionID string                `json:"sessionId"`
			Options   []acpPermissionOption `json:"options"`
		}
		if json.Unmarshal(params, &request) != nil {
			return "", false, false
		}
		if active.Load() && runCtx.Err() == nil && request.SessionID == session.Load().(string) {
			// OpenCode evaluates explicit deny rules before asking its client.
			// The shared selector never selects a persistent allow_always grant.
			return selectACPPermissionOption(params)
		}
		for _, option := range request.Options {
			if option.Kind == acpKindRejectOnce && option.OptionID != "" {
				return option.OptionID, false, true
			}
		}
		return "", false, false
	}
	c.acceptNotification = func(string) bool { return active.Load() && runCtx.Err() == nil }
	c.onActivity = func() {
		select {
		case activity <- struct{}{}:
		default:
		}
	}
	c.onMessage = func(msg Message) {
		if runCtx.Err() != nil || !active.Load() {
			return
		}
		deliverable.observe(msg)
		select {
		case msgCh <- msg:
		case <-runCtx.Done():
		}
	}
	readerDone := make(chan struct{})
	go func() {
		defer close(readerDone)
		defer stopTransport()
		scanner := newAgentStreamScanner(stdout)
		for scanner.Scan() {
			line := scanner.Text()
			// The shared ACP client gates update kinds but does not validate the
			// session ID. Filter the envelope before any stateful shared handler.
			var frame struct {
				Method string `json:"method"`
				Params struct {
					SessionID string `json:"sessionId"`
				} `json:"params"`
			}
			if json.Unmarshal([]byte(line), &frame) != nil {
				continue
			}
			if frame.Method == "session/update" || frame.Method == "session/notification" {
				if !active.Load() || frame.Params.SessionID != session.Load().(string) {
					continue
				}
			}
			c.handleLine(line)
		}
		err := scanner.Err()
		if err == nil {
			err = io.ErrUnexpectedEOF
		}
		c.closeAllPending(fmt.Errorf("opencode ACP stdout: %w", err))
	}()
	request := func(method string, params any) (json.RawMessage, error) {
		response, err := c.request(transportCtx, method, params)
		if errors.Is(err, context.Canceled) && transportCtx.Err() != nil && runCtx.Err() == nil {
			return nil, fmt.Errorf("opencode ACP %s: %w", method, io.ErrUnexpectedEOF)
		}
		return response, err
	}
	providerErr := newACPProviderErrorSniffer("opencode")
	stderrDone := make(chan struct{})
	go func() {
		defer close(stderrDone)
		_, _ = io.Copy(io.MultiWriter(newLogWriter(b.cfg.Logger, "[opencode:stderr] "), providerErr), stderr)
	}()
	finished := make(chan struct{})
	watchDone := make(chan struct{})
	go func() {
		defer close(watchDone)
		select {
		case <-finished:
			return
		case <-runCtx.Done():
		}
		// The writer may be blocked on a large prompt. Closing stdin after the
		// grace releases both that writer and this best-effort cancel writer.
		cancelWritten := make(chan struct{})
		go func() {
			defer close(cancelWritten)
			if id := session.Load().(string); id != "" {
				data, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": "session/cancel", "params": map[string]any{"sessionId": id}})
				_ = c.writeLine(append(data, '\n'))
			}
		}()
		timer := time.NewTimer(300 * time.Millisecond)
		select {
		case <-finished:
			if !timer.Stop() {
				<-timer.C
			}
		case <-timer.C:
		}
		_ = stdin.Close()
		// Always terminate the owned tree, even when the direct child already
		// exited: a descendant can still be running a provider request.
		signalProcessGroup(cmd, syscall.SIGKILL)
		<-cancelWritten
	}()
	go func() {
		start := time.Now()
		result := Result{Status: "completed"}
		var callErr error
		var promptResponse json.RawMessage
		defer func() {
			if runCtx.Err() != nil {
				// Let targeted cancellation reach ACP before closing its input.
				<-watchDone
			}
			// Drain before freezing output. The bounded fallback also covers an
			// ACP process that keeps its local listener alive after stdin EOF.
			_ = stdin.Close()
			if !waitForHermesPipeDrain(readerDone, stderrDone, 500*time.Millisecond) {
				signalProcessGroup(cmd, syscall.SIGKILL)
				_ = stdout.Close()
				_ = stderr.Close()
			}
			<-readerDone
			<-stderrDone
			active.Store(false)
			close(finished)
			<-watchDone
			// Reap only after readers finish, so Wait cannot truncate stdout.
			signalProcessGroup(cmd, syscall.SIGKILL)
			_ = cmd.Wait()
			releaseProcessGroup(cmd)
			if runCtx.Err() == context.Canceled {
				result.Status = "aborted"
				result.Error = "execution cancelled"
			} else if runCtx.Err() == context.DeadlineExceeded {
				result.Status = "timeout"
				result.Error = "opencode execution timed out"
			} else if callErr != nil {
				result.Status = "failed"
				result.Error = callErr.Error()
				result.ResumeRejected = opts.ResumeSessionID != "" && isACPSessionNotFound(callErr)
			}
			result.SessionID = session.Load().(string)
			if result.ResumeRejected {
				result.SessionID = ""
			}
			output, full := deliverable.result()
			result.Output = output
			result.Status, result.Error = promoteACPResultOnProviderError(result.Status, result.Error, full, providerErr)
			if result.Status == "completed" && strings.TrimSpace(result.Output) == "" {
				result.Status = "failed"
				result.Error = "opencode returned empty output"
			}
			result.DurationMs = time.Since(start).Milliseconds()
			cancel()
			close(msgCh)
			resCh <- result
			close(resCh)
		}()
		_, callErr = request("initialize", map[string]any{"protocolVersion": 1, "clientCapabilities": map[string]any{}, "clientInfo": map[string]any{"name": "bridge", "version": "1"}})
		if callErr != nil {
			return
		}
		// OpenCode loads configured MCPs itself. Project them only through its
		// native inline config above, retaining enabled/timeout/OAuth semantics
		// and avoiding a second ACP registration of each server.
		params := map[string]any{"cwd": cwd, "mcpServers": []any{}}
		method := "session/new"
		if opts.ResumeSessionID != "" {
			method = "session/load"
			params["sessionId"] = opts.ResumeSessionID
			session.Store(opts.ResumeSessionID)
		}
		var setup json.RawMessage
		setup, callErr = request(method, params)
		if callErr != nil {
			return
		}
		if opts.ResumeSessionID == "" {
			session.Store(extractACPSessionID(setup))
		}
		id := session.Load().(string)
		if id == "" {
			callErr = fmt.Errorf("opencode ACP returned no session ID")
			return
		}
		for _, setting := range []struct{ key, value string }{{"model", opts.Model}, {"effort", opts.ThinkingLevel}} {
			if setting.value == "" {
				continue
			}
			_, callErr = request("session/set_config_option", map[string]any{"sessionId": id, "configId": setting.key, "value": setting.value})
			if callErr != nil {
				callErr = fmt.Errorf("opencode could not apply %s %q: %w", setting.key, setting.value, callErr)
				return
			}
		}
		select {
		case msgCh <- Message{Type: MessageStatus, Status: "running", SessionID: id}:
		case <-runCtx.Done():
			return
		}
		active.Store(true)
		promptResponse, callErr = request("session/prompt", map[string]any{"sessionId": id, "prompt": []map[string]any{{"type": "text", "text": prompt}}})
		if callErr != nil {
			return
		}
		var pr struct {
			StopReason string `json:"stopReason"`
		}
		if json.Unmarshal(promptResponse, &pr) != nil || pr.StopReason == "" {
			callErr = fmt.Errorf("opencode ACP prompt returned no stop reason")
			return
		}
		if pr.StopReason == "cancelled" {
			result.Status = "aborted"
			result.Error = "opencode cancelled the prompt"
		}
		waitForACPNotificationQuiescence(runCtx, activity, readerDone, acpNotificationQuietTime, 500*time.Millisecond)
	}()
	return &Session{Messages: msgCh, Result: resCh}, nil
}
