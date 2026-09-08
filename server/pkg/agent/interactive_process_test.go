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
	"testing"
	"time"
)

// This test executable is the only child launched by these regressions.
func TestInteractiveProcessFixture(t *testing.T) {
	if os.Getenv("MULTICA_PROCESS_FIXTURE") != "1" {
		return
	}
	defer os.Exit(0)
	_ = os.WriteFile(os.Getenv("MULTICA_PROCESS_MARKER"), []byte("started"), 0600)
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		var request struct {
			ID     any    `json:"id"`
			Method string `json:"method"`
		}
		_ = json.Unmarshal(scanner.Bytes(), &request)
		reply := func(result any) {
			_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": result})
		}
		fail := os.Getenv("MULTICA_PROCESS_FAIL")
		phase := ""
		switch request.Method {
		case "initialize":
			phase = "initialize"
		case "thread/start", "thread/resume", "session/new", "session/load", "session/resume":
			phase = "setup"
		case "turn/start", "session/prompt":
			phase = "prompt"
		case "session/set_model", "session/set_config_option":
			phase = "model"
		}
		if phase != "" && (phase == fail || phase == "setup" && fail == "resume") {
			_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"jsonrpc": "2.0", "id": request.ID, "error": map[string]any{"code": -32000, "message": "injected protocol failure"}})
			continue
		}
		switch phase {
		case "initialize":
			reply(map[string]any{"protocolVersion": 1})
		case "setup":
			if fail == "missing_session" {
				reply(map[string]any{})
			} else {
				reply(map[string]any{"thread": map[string]any{"id": "fake-thread"}, "sessionId": "fake-session"})
			}
		case "prompt":
			_ = os.WriteFile(os.Getenv("MULTICA_PROCESS_PROMPT"), []byte("prompt"), 0600)
			if fail == "completed" {
				if request.Method == "turn/start" {
					reply(map[string]any{"turn": map[string]any{"id": "fake-turn"}})
					fmt.Fprintln(os.Stdout, `{"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{"threadId":"fake-thread","turnId":"fake-turn","itemId":"text","delta":"fixture complete"}}`)
					fmt.Fprintln(os.Stdout, `{"jsonrpc":"2.0","method":"turn/completed","params":{"turn":{"id":"fake-turn","status":"completed"}}}`)
				} else {
					fmt.Fprintln(os.Stdout, `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"fake-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"fixture complete"}}}}`)
					reply(map[string]any{"stopReason": "end_turn"})
				}
			}
			// A pending request lets the parent exercise caller cancellation.
		}
	}
}

func interactiveProcessConfig(t *testing.T, phase string) Config {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	return Config{ExecutablePath: executable, LaunchPrefix: []string{"-test.run=^TestInteractiveProcessFixture$", "--"}, CodexVersion: "0.116.0", Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), Env: map[string]string{
		"MULTICA_PROCESS_FIXTURE": "1", "MULTICA_PROCESS_MARKER": filepath.Join(dir, "started"), "MULTICA_PROCESS_PROMPT": filepath.Join(dir, "prompt"), "MULTICA_PROCESS_FAIL": phase, "CODEX_HOME": dir,
	}}
}

func TestInteractiveProcessCleanupProof(t *testing.T) {
	for _, provider := range []string{"codex", "opencode", "hermes"} {
		phases := []string{"initialize", "setup", "prompt", "cancel", "completed"}
		if provider != "codex" {
			phases = append(phases, "resume", "missing_session", "model")
		}
		for _, phase := range phases {
			for _, confirmed := range []bool{false, true} {
				t.Run(fmt.Sprintf("%s/%s/confirmed=%v", provider, phase, confirmed), func(t *testing.T) {
					cfg := interactiveProcessConfig(t, phase)
					var checked bool
					cfg.processTreeOptions.waitStopped = func(cmd *exec.Cmd, timeout time.Duration) bool {
						checked = true
						if cmd.ProcessState == nil {
							t.Error("proof queried before direct-child reap")
						}
						if !waitProcessGroupGone(cmd, timeout) {
							t.Error("owned fixture did not actually stop")
						}
						return confirmed // Inject uncertainty only after actually stopping the owned fixture.
					}
					backend, err := New(provider, cfg)
					if err != nil {
						t.Fatal(err)
					}
					ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
					defer cancel()
					opts := ExecOptions{RequireProcessTree: true, StreamText: true, Cwd: t.TempDir(), HandshakeTimeout: time.Second}
					if phase == "resume" {
						opts.ResumeSessionID = "fake-session"
					}
					if phase == "model" {
						opts.Model = "fake/model"
					}
					session, err := backend.Execute(ctx, "fixture", opts)
					if err != nil {
						t.Fatal(err)
					}
					if phase == "cancel" {
						deadline := time.Now().Add(2 * time.Second)
						for {
							if _, err := os.Stat(cfg.Env["MULTICA_PROCESS_PROMPT"]); err == nil {
								break
							}
							if time.Now().After(deadline) {
								t.Fatal("fixture never reached prompt")
							}
							time.Sleep(5 * time.Millisecond)
						}
						cancel()
					}
					for range session.Messages {
					}
					result := <-session.Result
					if !checked || result.CancelUnconfirmed == confirmed {
						t.Fatalf("cleanup proof lost: checked=%v result=%+v", checked, result)
					}
					if phase == "completed" && (result.Status != "completed" || result.Output != "fixture complete") {
						t.Fatalf("completion lost: %+v", result)
					}
				})
			}
		}
	}
}

func TestInteractiveProcessLegacyCleanupCompatibility(t *testing.T) {
	for _, provider := range []string{"codex", "opencode", "hermes"} {
		t.Run(provider, func(t *testing.T) {
			cfg := interactiveProcessConfig(t, "initialize")
			cfg.processTreeOptions.waitStopped = func(cmd *exec.Cmd, timeout time.Duration) bool { return false }
			backend, err := New(provider, cfg)
			if err != nil {
				t.Fatal(err)
			}
			session, err := backend.Execute(t.Context(), "fixture", ExecOptions{StreamText: true, Cwd: t.TempDir(), Timeout: 3 * time.Second})
			if err != nil {
				t.Fatal(err)
			}
			for range session.Messages {
			}
			result := <-session.Result
			if result.CancelUnconfirmed || result.Status != "failed" {
				t.Fatalf("legacy result changed: %+v", result)
			}
		})
	}
}
