package agent

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// This subprocess speaks ACP only; no test can fall through to installed agents.
func TestOpenCodeACPHelper(t *testing.T) {
	mode := os.Getenv("TEST_OPENCODE_ACP")
	if mode == "" {
		return
	}
	defer os.Exit(0)
	if mode == "descendant" {
		for {
			_ = os.WriteFile(filepath.Join(os.Getenv("TEST_OPENCODE_DIR"), "heartbeat"), []byte(time.Now().String()), 0600)
			time.Sleep(20 * time.Millisecond)
		}
	}
	enc := json.NewEncoder(os.Stdout)
	send := func(v any) {
		if enc.Encode(v) != nil {
			os.Exit(2)
		}
	}
	chunk := func(id, value string) {
		send(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{"sessionId": id, "update": map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": value}}}})
	}
	if !strings.Contains(strings.Join(os.Args, " "), " acp") {
		os.Exit(3)
	}
	if mode == "startup" {
		time.Sleep(20 * time.Second)
		return
	}
	if mode == "policy" {
		cwd, _ := os.Getwd()
		if os.Getenv("OPENCODE_PERMISSION") != `{"bash":"deny"}` || os.Getenv("OPENCODE_ENABLE_QUESTION_TOOL") != "false" || os.Getenv("PWD") != cwd {
			os.Exit(8)
		}
	}
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4096), 2*1024*1024)
	var promptID any
	for scanner.Scan() {
		var req struct {
			ID     any            `json:"id"`
			Method string         `json:"method"`
			Params map[string]any `json:"params"`
			Result map[string]any `json:"result"`
		}
		if json.Unmarshal(scanner.Bytes(), &req) != nil {
			os.Exit(4)
		}
		response := func(v any) { send(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": v}) }
		fail := func(message string) {
			send(map[string]any{"jsonrpc": "2.0", "id": req.ID, "error": map[string]any{"code": -32602, "message": message}})
		}
		switch req.Method {
		case "initialize":
			response(map[string]any{"protocolVersion": 1, "agentCapabilities": map[string]any{"loadSession": true, "mcpCapabilities": map[string]any{"http": true, "sse": true}}})
		case "session/new", "session/load":
			if mode == "mcp" {
				servers, ok := req.Params["mcpServers"].([]any)
				var config struct {
					MCP map[string]struct {
						Type    string   `json:"type"`
						Command []string `json:"command"`
					} `json:"mcp"`
				}
				if !ok || len(servers) != 0 || json.Unmarshal([]byte(os.Getenv("OPENCODE_CONFIG_CONTENT")), &config) != nil || config.MCP["local"].Type != "local" || strings.Join(config.MCP["local"].Command, " ") != "test-mcp --stdio" {
					os.Exit(10)
				}
			}
			if mode == "setup-eof" {
				return
			}
			if mode == "missing" || mode == "missing-exit" {
				fail("session not found: old")
				if mode == "missing-exit" {
					return
				}
				continue
			}
			if mode == "network" {
				fail("network connection unavailable")
				continue
			}
			if req.Method == "session/load" && req.Params["sessionId"] != "active" {
				os.Exit(5)
			}
			chunk("active", "replayed history")
			if req.Method == "session/load" {
				response(map[string]any{})
			} else {
				response(map[string]any{"sessionId": "active"})
			}
			if mode == "blocked-writer" {
				_, _ = io.ReadFull(os.Stdin, make([]byte, 4096))
				_ = os.WriteFile(filepath.Join(os.Getenv("TEST_OPENCODE_DIR"), "blocked"), nil, 0600)
				time.Sleep(20 * time.Second)
				return
			}
		case "session/set_config_option":
			if mode == "setting-fail" {
				fail("model not found")
				continue
			}
			key, _ := req.Params["configId"].(string)
			value, _ := req.Params["value"].(string)
			_ = os.WriteFile(filepath.Join(os.Getenv("TEST_OPENCODE_DIR"), key), []byte(value), 0600)
			response(map[string]any{})
		case "session/prompt":
			promptID = req.ID
			if req.Params["sessionId"] != "active" {
				os.Exit(6)
			}
			if mode == "descendant-cancel" {
				exe, _ := os.Executable()
				child := exec.Command(exe, "-test.run=^TestOpenCodeACPHelper$", "--", "acp")
				child.Env = append(os.Environ(), "TEST_OPENCODE_ACP=descendant")
				if child.Start() != nil {
					os.Exit(9)
				}
				_ = os.WriteFile(filepath.Join(os.Getenv("TEST_OPENCODE_DIR"), "child-pid"), []byte(strconv.Itoa(child.Process.Pid)), 0600)
				for i := 0; i < 100; i++ {
					if _, err := os.Stat(filepath.Join(os.Getenv("TEST_OPENCODE_DIR"), "heartbeat")); err == nil {
						break
					}
					time.Sleep(10 * time.Millisecond)
				}
			}
			if mode == "eof" {
				return
			}
			if mode == "prompt-fail" {
				fail("provider unavailable")
				continue
			}
			if mode == "empty" {
				response(map[string]any{"stopReason": "end_turn"})
				continue
			}
			if mode == "provider-error" {
				fmt.Fprintln(os.Stderr, "API call failed after 3 retries: provider unavailable")
				response(map[string]any{"stopReason": "end_turn"})
				continue
			}
			chunk("foreign", "foreign text")
			chunk("active", "Hello ")
			if mode == "flood" {
				for i := 0; i < 1024; i++ {
					chunk("active", "x")
				}
				continue
			}
			if mode == "cancel" || mode == "descendant-cancel" {
				continue
			}
			if mode == "permission" || mode == "foreign-permission" {
				id := "active"
				options := []map[string]string{{"optionId": "reject", "kind": "reject_once"}}
				if mode == "foreign-permission" {
					id = "foreign"
					options = append(options, map[string]string{"optionId": "once", "kind": "allow_once"})
				}
				send(map[string]any{"jsonrpc": "2.0", "id": "permission", "method": "session/request_permission", "params": map[string]any{"sessionId": id, "toolCall": map[string]any{"title": "blocked", "kind": "execute"}, "options": options}})
				continue
			}
			if mode == "hold" {
				for i := 0; i < 500; i++ {
					if _, err := os.Stat(filepath.Join(os.Getenv("TEST_OPENCODE_DIR"), "release")); err == nil {
						break
					}
					time.Sleep(10 * time.Millisecond)
				}
			}
			chunk("active", "world!")
			if mode == "many" {
				for i := 0; i < 1024; i++ {
					chunk("active", "x")
				}
			}
			response(map[string]any{"stopReason": "end_turn"})
			if mode == "late" {
				time.Sleep(25 * time.Millisecond)
				chunk("active", " last")
			}
			if mode == "linger" {
				time.Sleep(20 * time.Second)
				return
			}
		case "session/cancel":
			id, _ := req.Params["sessionId"].(string)
			_ = os.WriteFile(filepath.Join(os.Getenv("TEST_OPENCODE_DIR"), "cancel"), []byte(id), 0600)
			if mode == "descendant-cancel" {
				return
			}
			send(map[string]any{"jsonrpc": "2.0", "id": promptID, "result": map[string]any{"stopReason": "cancelled"}})
		default:
			if req.ID == "permission" {
				outcome, _ := req.Result["outcome"].(map[string]any)
				if outcome["optionId"] != "reject" {
					os.Exit(7)
				}
				chunk("active", "denied")
				send(map[string]any{"jsonrpc": "2.0", "id": promptID, "result": map[string]any{"stopReason": "end_turn"}})
			}
		}
	}
}

func openCodeACPTestSession(t *testing.T, ctx context.Context, mode string, opts ExecOptions) (*Session, string) {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	b, err := New("opencode", Config{ExecutablePath: exe, LaunchPrefix: []string{"-test.run=^TestOpenCodeACPHelper$", "--"}, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), Env: map[string]string{"TEST_OPENCODE_ACP": mode, "TEST_OPENCODE_DIR": dir, "OPENCODE_PERMISSION": "{\"bash\":\"deny\"}", "OPENCODE_ENABLE_QUESTION_TOOL": "true"}})
	if err != nil {
		t.Fatal(err)
	}
	opts.StreamText = true
	opts.Cwd = dir
	prompt := "hello"
	if mode == "blocked-writer" {
		prompt = strings.Repeat("x", 1024*1024)
	}
	s, err := b.Execute(ctx, prompt, opts)
	if err != nil {
		t.Fatal(err)
	}
	return s, dir
}

func openCodeACPResult(t *testing.T, s *Session) Result {
	t.Helper()
	select {
	case r := <-s.Result:
		return r
	case <-time.After(8 * time.Second):
		t.Fatal("ACP result did not terminate")
		return Result{}
	}
}

func TestOpenCodeACPStreamsBeforePromptResponse(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s, dir := openCodeACPTestSession(t, ctx, "hold", ExecOptions{ResumeSessionID: "active"})
	var got strings.Builder
	for {
		select {
		case m, ok := <-s.Messages:
			if !ok {
				t.Fatal("no early text before prompt response")
			}
			if m.Type != MessageText {
				continue
			}
			got.WriteString(m.Content)
			if got.String() != "Hello " {
				t.Fatalf("early text %q", got.String())
			}
		case <-time.After(3 * time.Second):
			t.Fatal("no early text before prompt response")
		}
		break
	}
	select {
	case r := <-s.Result:
		t.Fatalf("terminal before release: %+v", r)
	default:
	}
	if err := os.WriteFile(filepath.Join(dir, "release"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	for m := range s.Messages {
		if m.Type == MessageText {
			got.WriteString(m.Content)
		}
	}
	r := openCodeACPResult(t, s)
	if r.Status != "completed" || r.Output != "Hello world!" || got.String() != r.Output || r.SessionID != "active" {
		t.Fatalf("result %+v; streamed %q", r, got.String())
	}
}

func TestOpenCodeACPFailuresAndSettings(t *testing.T) {
	for _, tc := range []struct {
		mode, status, output string
		reject               bool
	}{
		{"missing", "failed", "", true}, {"network", "failed", "", false}, {"eof", "failed", "", false}, {"prompt-fail", "failed", "", false}, {"empty", "failed", "", false}, {"provider-error", "failed", "", false}, {"setting-fail", "failed", "", false}, {"permission", "completed", "Hello denied", false}, {"linger", "completed", "Hello world!", false}, {"settings", "completed", "Hello world!", false},
		{"setup-eof", "failed", "", false}, {"policy", "completed", "Hello world!", false}, {"late", "completed", "Hello world! last", false}, {"many", "completed", "Hello world!" + strings.Repeat("x", 1024), false},
		{"foreign-permission", "completed", "Hello denied", false},
		{"mcp", "completed", "Hello world!", false},
		{"missing-exit", "failed", "", true},
	} {
		t.Run(tc.mode, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 7*time.Second)
			defer cancel()
			opts := ExecOptions{ResumeSessionID: "active"}
			if tc.mode == "mcp" {
				opts.McpConfig = json.RawMessage(`{"mcpServers":{"local":{"command":"test-mcp","args":["--stdio"]}}}`)
			}
			if tc.mode == "settings" || tc.mode == "setting-fail" {
				opts.Model = "test/model"
				opts.ThinkingLevel = "high"
			}
			s, dir := openCodeACPTestSession(t, ctx, tc.mode, opts)
			var streamed strings.Builder
			for m := range s.Messages {
				if m.Type == MessageText {
					streamed.WriteString(m.Content)
				}
			}
			r := openCodeACPResult(t, s)
			if r.Status != tc.status || r.Output != tc.output || r.ResumeRejected != tc.reject {
				t.Fatalf("result %+v", r)
			}
			if r.Status == "completed" && streamed.String() != tc.output {
				t.Fatalf("lost streaming output %q", streamed.String())
			}
			if r.Status == "failed" && r.Error == "" {
				t.Fatal("failure has no explanation")
			}
			if tc.mode == "settings" {
				for key, want := range map[string]string{"model": "test/model", "effort": "high"} {
					b, err := os.ReadFile(filepath.Join(dir, key))
					if err != nil || string(b) != want {
						t.Fatalf("%s = %q, %v", key, b, err)
					}
				}
			}
		})
	}
}

func TestOpenCodeACPCancelAndBackpressure(t *testing.T) {
	for _, mode := range []string{"cancel", "flood", "startup", "descendant-cancel", "blocked-writer"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			s, dir := openCodeACPTestSession(t, ctx, mode, ExecOptions{})
			if mode != "startup" {
				for m := range s.Messages {
					if m.Type == MessageText || mode == "blocked-writer" {
						break
					}
				}
			}
			if mode == "flood" {
				deadline := time.Now().Add(3 * time.Second)
				for len(s.Messages) < cap(s.Messages) {
					if time.Now().After(deadline) {
						t.Fatal("text buffer did not fill")
					}
					time.Sleep(time.Millisecond)
				}
			}
			if mode == "blocked-writer" {
				deadline := time.Now().Add(3 * time.Second)
				for {
					if _, err := os.Stat(filepath.Join(dir, "blocked")); err == nil {
						break
					}
					if time.Now().After(deadline) {
						t.Fatal("prompt did not reach blocked writer")
					}
					time.Sleep(time.Millisecond)
				}
			}
			cancel()
			r := openCodeACPResult(t, s)
			if r.Status != "aborted" {
				t.Fatalf("result %+v", r)
			}
			if mode == "cancel" {
				data, err := os.ReadFile(filepath.Join(dir, "cancel"))
				if err != nil || string(data) != "active" {
					t.Fatalf("targeted cancel %q: %v", data, err)
				}
				if r.Output != "Hello " {
					t.Fatalf("partial text %q", r.Output)
				}
			}
			if mode == "descendant-cancel" {
				pidData, _ := os.ReadFile(filepath.Join(dir, "child-pid"))
				pid, _ := strconv.Atoi(string(pidData))
				if pid <= 0 {
					t.Fatal("no child process")
				}
				t.Cleanup(func() {
					if p, err := os.FindProcess(pid); err == nil {
						_ = p.Kill()
					}
				})
				before, err := os.ReadFile(filepath.Join(dir, "heartbeat"))
				if err != nil {
					t.Fatal(err)
				}
				time.Sleep(150 * time.Millisecond)
				after, _ := os.ReadFile(filepath.Join(dir, "heartbeat"))
				if string(before) != string(after) {
					t.Fatal("descendant survived parent normal exit without cancel acknowledgement")
				}
			}
			for range s.Messages {
			}
		})
	}
}
