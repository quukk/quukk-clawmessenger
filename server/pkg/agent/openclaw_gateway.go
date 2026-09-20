package agent

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

const openclawGatewayStopBudget = 3 * time.Second

var openclawAgentID = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`)

type openclawGatewayConfig struct {
	address, token string
	// Ephemeral execution-owned identity preserves run ownership across a
	// reconnect. The documented local backend exception does not pair or store it.
	identity ed25519.PrivateKey
}

var errOpenclawGatewayTransport = errors.New("openclaw Gateway disconnected; run outcome may be unknown")

// This adapter uses the documented authenticated local backend connection.
// Remote/device/SecretRef configuration must not silently become localhost or
// another account. These unsupported forms fail before a socket is opened.
func (b *openclawBackend) gatewayConfig() (openclawGatewayConfig, error) {
	env := func(key string) string {
		if v, ok := b.cfg.Env[key]; ok {
			return strings.TrimSpace(v)
		}
		return strings.TrimSpace(os.Getenv(key))
	}
	fail := func() (openclawGatewayConfig, error) {
		return openclawGatewayConfig{}, errors.New("openclaw streaming requires a local token-authenticated Gateway and plain JSON configuration; remote, includes, profiles, TLS and SecretRef configuration are not supported")
	}
	if p := env("OPENCLAW_PROFILE"); p != "" && p != "default" {
		return fail()
	}
	home := env("OPENCLAW_HOME")
	if home == "" {
		var err error
		home, err = os.UserHomeDir()
		if err != nil {
			return fail()
		}
	}
	expand := func(path string) string {
		if strings.HasPrefix(path, "~/") || strings.HasPrefix(path, `~\`) {
			return filepath.Join(home, path[2:])
		}
		return path
	}
	configPath := env("OPENCLAW_CONFIG_PATH")
	if configPath == "" {
		state := env("OPENCLAW_STATE_DIR")
		if state == "" {
			state = filepath.Join(home, ".openclaw")
		}
		configPath = filepath.Join(expand(state), "openclaw.json")
	}
	data, err := os.ReadFile(expand(configPath))
	if err != nil {
		return openclawGatewayConfig{}, errors.New("openclaw streaming cannot read Gateway configuration; set OPENCLAW_CONFIG_PATH to the intended OpenClaw config")
	}
	var raw map[string]json.RawMessage
	if json.Unmarshal(data, &raw) != nil || raw["$include"] != nil {
		return fail()
	}
	var config struct {
		Gateway struct {
			Mode string `json:"mode"`
			Port int    `json:"port"`
			TLS  struct {
				Enabled bool `json:"enabled"`
			} `json:"tls"`
			Auth struct {
				Mode  string          `json:"mode"`
				Token json.RawMessage `json:"token"`
			} `json:"auth"`
			Remote struct {
				URL   string          `json:"url"`
				Token json.RawMessage `json:"token"`
			} `json:"remote"`
		} `json:"gateway"`
	}
	if json.Unmarshal(data, &config) != nil || config.Gateway.Mode != "" && config.Gateway.Mode != "local" || config.Gateway.TLS.Enabled || config.Gateway.Auth.Mode != "" && config.Gateway.Auth.Mode != "token" {
		return fail()
	}
	// Includes at nested levels also change routing/auth semantics.
	var hasInclude func(any) bool
	hasInclude = func(v any) bool {
		switch x := v.(type) {
		case map[string]any:
			for k, v := range x {
				if k == "$include" || hasInclude(v) {
					return true
				}
			}
		case []any:
			for _, v := range x {
				if hasInclude(v) {
					return true
				}
			}
		}
		return false
	}
	var generic any
	_ = json.Unmarshal(data, &generic)
	if hasInclude(generic) {
		return fail()
	}
	port := config.Gateway.Port
	if port == 0 {
		port = 18789
	}
	if p := env("OPENCLAW_GATEWAY_PORT"); p != "" {
		port, err = strconv.Atoi(p)
		if err != nil {
			return fail()
		}
	}
	if port < 1 || port > 65535 {
		return fail()
	}
	address := "ws://127.0.0.1:" + strconv.Itoa(port)
	token := ""
	if override := env("OPENCLAW_GATEWAY_URL"); override != "" {
		address = override
		token = env("OPENCLAW_GATEWAY_TOKEN")
	} else {
		if len(config.Gateway.Auth.Token) > 0 && string(config.Gateway.Auth.Token) != "null" {
			if json.Unmarshal(config.Gateway.Auth.Token, &token) != nil {
				return fail()
			}
		}
		if strings.Contains(token, "${") {
			return fail()
		}
		if strings.TrimSpace(token) == "" {
			token = env("OPENCLAW_GATEWAY_TOKEN")
		}
		if token == "" && len(config.Gateway.Remote.Token) > 0 {
			if json.Unmarshal(config.Gateway.Remote.Token, &token) != nil {
				return fail()
			}
		}
	}
	u, err := url.Parse(address)
	if err != nil || u.Scheme != "ws" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" && u.Path != "/" {
		return fail()
	}
	// Numeric loopback avoids DNS rebinding and proxy routing of shared tokens.
	ip := net.ParseIP(u.Hostname())
	if ip == nil || !ip.IsLoopback() || strings.TrimSpace(token) == "" || strings.Contains(token, "${") {
		return fail()
	}
	_, identity, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return openclawGatewayConfig{}, errors.New("openclaw Gateway ephemeral identity generation failed")
	}
	return openclawGatewayConfig{address: address, token: strings.TrimSpace(token), identity: identity}, nil
}

func openclawGatewaySettings(opts ExecOptions) (string, string, error) {
	agentID, thinking := opts.Model, opts.ThinkingLevel
	if len(opts.ExtraArgs) > 0 || len(opts.McpConfig) > 0 || opts.ServiceTier != "" || opts.OpenclawMode != "" && opts.OpenclawMode != "gateway" {
		return "", "", errors.New("openclaw streaming does not support extra_args, per-session MCP, service tier or explicit local mode; configure tools on the Gateway")
	}
	for i := 0; i < len(opts.CustomArgs); i++ {
		flag, value, inline := strings.Cut(opts.CustomArgs[i], "=")
		if flag != "--agent" && flag != "--thinking" {
			return "", "", errors.New("openclaw streaming custom_args supports only --agent and --thinking")
		}
		if !inline {
			i++
			if i >= len(opts.CustomArgs) {
				return "", "", errors.New("openclaw streaming custom argument requires a value")
			}
			value = opts.CustomArgs[i]
		}
		if value == "" {
			return "", "", errors.New("openclaw streaming custom argument requires a value")
		}
		if flag == "--agent" {
			agentID = value
		} else {
			thinking = value
		}
	}
	if agentID != "" && !openclawAgentID.MatchString(agentID) {
		return "", "", errors.New("openclaw streaming agent ID is invalid")
	}
	if thinking != "" && !slices.Contains([]string{"off", "minimal", "low", "medium", "high", "xhigh", "adaptive"}, thinking) {
		return "", "", errors.New("openclaw streaming thinking level is unsupported")
	}
	return strings.ToLower(agentID), thinking, nil
}

type openclawGatewayFrame struct {
	Type    string          `json:"type"`
	ID      string          `json:"id"`
	Event   string          `json:"event"`
	OK      bool            `json:"ok"`
	Payload json.RawMessage `json:"payload"`
	Error   struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// One execution goroutine owns writes and dispatch; the reader is bounded by
// socket close. No subprocess or shared Gateway lifecycle is owned here.
type openclawGatewayClient struct {
	interactive    bool
	modelSelection bool
	conn           *websocket.Conn
	frames         chan openclawGatewayFrame
	done           chan struct{}
	onEvent        func(openclawGatewayFrame)
	next           int
}

func dialOpenclawGateway(ctx context.Context, cfg openclawGatewayConfig) (*openclawGatewayClient, error) {
	dialer := websocket.Dialer{HandshakeTimeout: 5 * time.Second}
	conn, _, err := dialer.DialContext(ctx, cfg.address, nil)
	if err != nil {
		return nil, errors.New("openclaw Gateway connection failed; start the configured local Gateway and check token authentication")
	}
	conn.SetReadLimit(32 << 20)
	c := &openclawGatewayClient{conn: conn, frames: make(chan openclawGatewayFrame, 64), done: make(chan struct{})}
	go func() {
		defer close(c.frames)
		for {
			var frame openclawGatewayFrame
			if conn.ReadJSON(&frame) != nil {
				return
			}
			select {
			case c.frames <- frame:
			case <-c.done:
				return
			}
		}
	}()
	setup, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	frame, err := c.read(setup)
	if err != nil || frame.Event != "connect.challenge" {
		c.close()
		return nil, errors.New("openclaw Gateway handshake challenge missing")
	}
	var challenge struct {
		Nonce string `json:"nonce"`
		TS    *int64 `json:"ts"`
	}
	if json.Unmarshal(frame.Payload, &challenge) != nil || challenge.Nonce == "" || challenge.TS == nil || *challenge.TS < 0 || len(cfg.identity) != ed25519.PrivateKeySize {
		c.close()
		return nil, errors.New("openclaw Gateway handshake challenge is invalid")
	}
	public := cfg.identity.Public().(ed25519.PublicKey)
	hash := sha256.Sum256(public)
	deviceID := hex.EncodeToString(hash[:])
	platform := runtime.GOOS
	if platform == "windows" {
		platform = "win32"
	}
	signed := strings.Join([]string{"v3", deviceID, "gateway-client", "backend", "operator", "operator.read,operator.write", strconv.FormatInt(*challenge.TS, 10), cfg.token, challenge.Nonce, platform, ""}, "|")
	device := map[string]any{"id": deviceID, "publicKey": base64.RawURLEncoding.EncodeToString(public), "signature": base64.RawURLEncoding.EncodeToString(ed25519.Sign(cfg.identity, []byte(signed))), "signedAt": *challenge.TS, "nonce": challenge.Nonce}
	response, err := c.request(setup, "connect", map[string]any{"minProtocol": 4, "maxProtocol": 4, "client": map[string]any{"id": "gateway-client", "version": "1", "platform": platform, "mode": "backend"}, "role": "operator", "scopes": []string{"operator.read", "operator.write"}, "caps": []string{}, "auth": map[string]string{"token": cfg.token}, "device": device})
	if err != nil {
		c.close()
		return nil, errors.New("openclaw Gateway authentication failed; verify local token and operator.read/operator.write access")
	}
	var hello struct {
		Features struct {
			Methods []string `json:"methods"`
			Events  []string `json:"events"`
		} `json:"features"`
		Type     string `json:"type"`
		Protocol int    `json:"protocol"`
		Auth     struct {
			Scopes []string `json:"scopes"`
		} `json:"auth"`
	}
	if json.Unmarshal(response, &hello) != nil || hello.Type != "hello-ok" || hello.Protocol != 4 || !slices.Contains(hello.Auth.Scopes, "operator.read") || !slices.Contains(hello.Auth.Scopes, "operator.write") {
		c.close()
		return nil, errors.New("openclaw Gateway requires protocol 4 and operator.read/operator.write access")
	}
	c.interactive = slices.Contains(hello.Features.Events, "chat")
	// OpenClaw 2026.9.x registers sessions.resolve with advertise:false (the
	// method still executes; it is only hidden from the advertised list), so
	// the capability probe must not require it to be advertised here.
	for _, method := range []string{"agents.list", "chat.send", "chat.abort", "chat.history"} {
		c.interactive = c.interactive && slices.Contains(hello.Features.Methods, method)
	}
	c.modelSelection = slices.Contains(hello.Features.Methods, "sessions.create") && slices.Contains(hello.Features.Methods, "sessions.patch") && len(hello.Auth.Scopes) == 2
	c.interactive = c.interactive && c.modelSelection
	return c, nil
}

func (c *openclawGatewayClient) close() { close(c.done); _ = c.conn.Close() }
func (c *openclawGatewayClient) read(ctx context.Context) (openclawGatewayFrame, error) {
	select {
	case f, ok := <-c.frames:
		if ok {
			return f, nil
		}
		return f, errOpenclawGatewayTransport
	case <-ctx.Done():
		return openclawGatewayFrame{}, ctx.Err()
	}
}
func (c *openclawGatewayClient) request(ctx context.Context, method string, params any) (json.RawMessage, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	c.next++
	id := strconv.Itoa(c.next)
	deadline := time.Now().Add(5 * time.Second)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	if err := c.conn.SetWriteDeadline(deadline); err != nil {
		return nil, errors.New("openclaw Gateway write deadline failed")
	}
	if err := c.conn.WriteJSON(map[string]any{"type": "req", "id": id, "method": method, "params": params}); err != nil {
		return nil, errOpenclawGatewayTransport
	}
	for {
		frame, err := c.read(ctx)
		if err != nil {
			return nil, err
		}
		if frame.Type == "res" && frame.ID == id {
			if !frame.OK {
				return nil, fmt.Errorf("openclaw Gateway %s rejected; check agent, session and Gateway permissions", method)
			}
			return frame.Payload, nil
		}
		if c.onEvent != nil && frame.Type == "event" {
			c.onEvent(frame)
		}
	}
}

func (b *openclawBackend) executeGateway(ctx context.Context, prompt string, opts ExecOptions) (*Session, error) {
	agentID, thinking, err := openclawGatewaySettings(opts)
	if err != nil {
		return nil, err
	}
	if len(b.cfg.LaunchPrefix) > 0 {
		return nil, errors.New("openclaw streaming cannot apply a custom executable launch prefix")
	}
	config, err := b.gatewayConfig()
	if err != nil {
		return nil, err
	}
	runCtx, cancel := runContext(ctx, opts.Timeout)
	msgCh := make(chan Message, 256)
	resCh := make(chan Result, 1)
	go func() {
		start := time.Now()
		result := Result{Status: "failed", SessionID: opts.ResumeSessionID}
		var output string
		defer func() {
			cancel()
			result.Output = output
			result.DurationMs = time.Since(start).Milliseconds()
			close(msgCh)
			resCh <- result
			close(resCh)
		}()
		c, err := dialOpenclawGateway(runCtx, config)
		if err != nil {
			result.Error = err.Error()
			return
		}
		defer c.close()
		setup, stopSetup := context.WithTimeout(runCtx, 15*time.Second)
		defer stopSetup()
		if agentID == "" && opts.ResumeSessionID == "" {
			raw, err := c.request(setup, "agents.list", map[string]any{})
			if err != nil {
				result.Error = err.Error()
				return
			}
			var agents struct {
				DefaultID string `json:"defaultId"`
			}
			if json.Unmarshal(raw, &agents) != nil || !openclawAgentID.MatchString(agents.DefaultID) {
				result.Error = "openclaw Gateway did not identify its default agent"
				return
			}
			agentID = strings.ToLower(agents.DefaultID)
		}
		key := opts.ResumeSessionID
		if key != "" {
			params := map[string]any{}
			if agentID != "" {
				params["agentId"] = agentID
			}
			if strings.HasPrefix(key, "agent:") {
				params["key"] = key
			} else {
				params["sessionId"] = key
			}
			raw, err := c.request(setup, "sessions.resolve", params)
			if err != nil {
				result.Error = err.Error()
				return
			}
			var resolved struct {
				Key     string `json:"key"`
				AgentID string `json:"agentId"`
			}
			if json.Unmarshal(raw, &resolved) != nil {
				result.Error = "openclaw Gateway session resolution was invalid"
				return
			}
			if agentID == "" {
				agentID = resolved.AgentID
				if agentID == "" {
					parts := strings.SplitN(resolved.Key, ":", 3)
					if len(parts) == 3 && parts[0] == "agent" {
						agentID = parts[1]
					}
				}
			}
			if !openclawAgentID.MatchString(agentID) || !strings.HasPrefix(resolved.Key, "agent:"+agentID+":") {
				result.Error = "openclaw Gateway could not resolve the existing session for the selected agent"
				return
			}
			key = resolved.Key
		} else {
			key = "agent:" + agentID + ":clawmessenger:" + uuid.NewString()
		}
		result.SessionID = key
		if opts.TaskModel != "" {
			if !c.modelSelection || !strings.HasPrefix(key, "agent:"+agentID+":clawmessenger:") {
				result.Error = "openclaw task model requires session create/patch support, exact read/write scopes, and a ClawMessenger-owned session"
				return
			}
			if opts.ResumeSessionID == "" {
				raw, err := c.request(setup, "sessions.create", map[string]any{"key": key, "idempotencyKey": key, "agentId": agentID, "model": opts.TaskModel})
				var created struct {
					OK  bool   `json:"ok"`
					Key string `json:"key"`
				}
				if err != nil || json.Unmarshal(raw, &created) != nil || !created.OK || created.Key != key {
					result.Error = "openclaw task model session creation was not confirmed"
					return
				}
			}
			raw, err := c.request(setup, "sessions.patch", map[string]any{"key": key, "model": opts.TaskModel})
			var patched struct {
				OK       bool   `json:"ok"`
				Key      string `json:"key"`
				Resolved struct {
					Provider string `json:"modelProvider"`
					Model    string `json:"model"`
				} `json:"resolved"`
			}
			if err != nil || json.Unmarshal(raw, &patched) != nil || !patched.OK || patched.Key != key || patched.Resolved.Provider+"/"+patched.Resolved.Model != opts.TaskModel {
				result.Error = "openclaw task model selection was not confirmed for the exact session"
				return
			}
		}
		select {
		case msgCh <- Message{Type: MessageStatus, Status: "running", SessionID: key}:
		case <-runCtx.Done():
			result.Error = "execution cancelled before prompt submission"
			result.Status = "aborted"
			return
		}
		runID := uuid.NewString()
		terminal := false
		remoteAborted := false
		active := true
		c.onEvent = func(frame openclawGatewayFrame) {
			if !active || terminal || frame.Event != "chat" {
				return
			}
			var event struct {
				RunID      string         `json:"runId"`
				SessionKey string         `json:"sessionKey"`
				State      string         `json:"state"`
				Usage      map[string]any `json:"usage"`
				Message    struct {
					Model   string         `json:"model"`
					Usage   map[string]any `json:"usage"`
					Content []struct {
						Type string `json:"type"`
						Text string `json:"text"`
					} `json:"content"`
				} `json:"message"`
			}
			if json.Unmarshal(frame.Payload, &event) != nil || event.RunID != runID || event.SessionKey != key {
				return
			}
			if event.State == "delta" || event.State == "final" {
				var parts []string
				for _, block := range event.Message.Content {
					if block.Type == "text" {
						parts = append(parts, block.Text)
					}
				}
				full := strings.Join(parts, "\n")
				if runCtx.Err() == nil && strings.HasPrefix(full, output) && len(full) > len(output) {
					delta := full[len(output):]
					select {
					case msgCh <- Message{Type: MessageText, Content: delta}:
						output = full
					case <-runCtx.Done():
					}
				}
				if event.State == "final" && runCtx.Err() == nil {
					usage := event.Usage
					if usage == nil {
						usage = event.Message.Usage
					}
					if u := parseOpenclawUsage(usage); acpTokenUsagePresent(u) {
						model := event.Message.Model
						if model == "" {
							model = "unknown"
						}
						result.Usage = map[string]TokenUsage{model: u}
					}
					if len(parts) > 0 {
						output = full
					}
					result.Status = "completed"
					result.CompletionConfirmed = true
					terminal = true
					if strings.TrimSpace(output) == "" {
						result.Status = "failed"
						result.Error = "openclaw Gateway returned empty output"
					}
				}
			} else if event.State == "error" {
				terminal = true
				result.Status = "failed"
				result.Error = "openclaw Gateway run failed; check provider and Gateway logs"
			} else if event.State == "aborted" && runCtx.Err() == nil {
				remoteAborted = true
			}
		}
		if opts.SystemPrompt != "" {
			prompt = opts.SystemPrompt + "\n\n" + prompt
		}
		params := map[string]any{"sessionKey": key, "agentId": agentID, "message": prompt, "idempotencyKey": runID, "deliver": false}
		if thinking != "" {
			params["thinking"] = thinking
		}
		if opts.Timeout > 0 {
			params["timeoutMs"] = opts.Timeout.Milliseconds()
		}
		var ack json.RawMessage
		ack, err = c.request(runCtx, "chat.send", params)
		if err == nil && !terminal {
			var response struct {
				RunID  string `json:"runId"`
				Status string `json:"status"`
			}
			if json.Unmarshal(ack, &response) != nil || response.RunID != runID {
				// An uncorrelated acknowledgement cannot establish that submission
				// failed. Clean up using our known idempotency key below.
				err = errOpenclawGatewayTransport
			} else if response.Status == "error" || response.Status == "ok" {
				result.Error = "openclaw Gateway returned a terminal acknowledgement without output"
				return
			} else if response.Status == "timeout" {
				remoteAborted = true
			}
		}
		for err == nil && !terminal && !remoteAborted {
			var frame openclawGatewayFrame
			frame, err = c.read(runCtx)
			if err == nil {
				c.onEvent(frame)
			}
		}
		if terminal {
			return
		}
		active = false
		if runCtx.Err() != nil || remoteAborted || errors.Is(err, errOpenclawGatewayTransport) {
			stopCtx, stop := context.WithTimeout(context.Background(), openclawGatewayStopBudget)
			defer stop()
			stopClient := c
			var stopErr error
			if errors.Is(err, errOpenclawGatewayTransport) {
				stopClient, stopErr = dialOpenclawGateway(stopCtx, config)
				if stopErr == nil {
					defer stopClient.close()
				}
			}
			if stopErr == nil {
				stopErr = stopClient.confirmStop(stopCtx, key, agentID, runID)
			}
			if stopErr != nil {
				result.Status = "failed"
				result.CancelUnconfirmed = true
				result.Error = "openclaw Gateway stop unconfirmed; the run may still be active. Check the Gateway before retrying"
				return
			}
			if runCtx.Err() == nil && !remoteAborted {
				result.Error = "openclaw Gateway disconnected; the original run was stopped"
				return
			}
			result.Status = "aborted"
			result.Error = "execution cancelled"
			if runCtx.Err() == context.DeadlineExceeded {
				result.Status = "timeout"
				result.Error = "openclaw execution timed out; Gateway stop confirmed"
			}
		} else if err != nil {
			result.Error = err.Error()
		}
	}()
	return &Session{Messages: msgCh, Result: resCh}, nil
}

// A send may still be in asynchronous pre-admission when cancellation arrives.
// A no-op abort and history absence are not a fence against later admission.
// Require a positive abort acknowledgement naming this exact run, then its
// absence from history's active-run projection (including terminal persistence).
// Until that fence exists, retry only the targeted abort within the stop budget.
func (c *openclawGatewayClient) confirmStop(ctx context.Context, key, agentID, runID string) error {
	abortConfirmed := false
	for {
		if !abortConfirmed {
			raw, err := c.request(ctx, "chat.abort", map[string]any{"sessionKey": key, "agentId": agentID, "runId": runID})
			if err != nil {
				return err
			}
			var acknowledgement struct {
				Aborted bool     `json:"aborted"`
				RunIDs  []string `json:"runIds"`
			}
			if json.Unmarshal(raw, &acknowledgement) != nil {
				return errors.New("invalid Gateway abort acknowledgement")
			}
			abortConfirmed = acknowledgement.Aborted && slices.Contains(acknowledgement.RunIDs, runID)
		}
		raw, err := c.request(ctx, "chat.history", map[string]any{"sessionKey": key, "agentId": agentID, "limit": 1})
		if err != nil {
			return err
		}
		var history struct {
			SessionInfo struct {
				HasActiveRun *bool     `json:"hasActiveRun"`
				ActiveRunIDs *[]string `json:"activeRunIds"`
			} `json:"sessionInfo"`
		}
		if json.Unmarshal(raw, &history) != nil {
			return errors.New("invalid Gateway stop confirmation")
		}
		info := history.SessionInfo
		if abortConfirmed && (info.HasActiveRun != nil && !*info.HasActiveRun || info.ActiveRunIDs != nil && !slices.Contains(*info.ActiveRunIDs, runID)) {
			return nil
		}
		timer := time.NewTimer(100 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}
