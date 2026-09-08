package agent

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestInteractiveACPExecutionHelper(t *testing.T) {
	if os.Getenv("MULTICA_INTERACTIVE_EXECUTION_FIXTURE") != "1" {
		return
	}
	defer os.Exit(0)
	var mu sync.Mutex
	send := func(value any) { mu.Lock(); defer mu.Unlock(); _ = json.NewEncoder(os.Stdout).Encode(value) }
	scanner := bufio.NewScanner(os.Stdin)
	sessionID := ""
	for scanner.Scan() {
		var request struct {
			ID     any            `json:"id"`
			Method string         `json:"method"`
			Params map[string]any `json:"params"`
		}
		_ = json.Unmarshal(scanner.Bytes(), &request)
		reply := func(result any) { send(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": result}) }
		switch request.Method {
		case "initialize":
			reply(map[string]any{"protocolVersion": 1, "agentCapabilities": map[string]any{"loadSession": true, "sessionCapabilities": map[string]any{"resume": map[string]any{}}}})
		case "session/load", "session/resume":
			sessionID, _ = request.Params["sessionId"].(string)
			_ = os.WriteFile(os.Getenv("MULTICA_INTERACTIVE_EXECUTION_TRACE"), []byte(request.Method+":"+sessionID), 0600)
			reply(map[string]any{"sessionId": sessionID})
		case "session/new":
			os.Exit(5)
		case "session/prompt":
			id := request.ID
			session := sessionID
			chunk := func(text string) {
				send(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{"sessionId": session, "update": map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": text}}}})
			}
			chunk("partial-" + session)
			go func() {
				for {
					if _, err := os.Stat(os.Getenv("MULTICA_INTERACTIVE_EXECUTION_RELEASE")); err == nil {
						break
					}
					time.Sleep(5 * time.Millisecond)
				}
				chunk("-continued")
				send(map[string]any{"jsonrpc": "2.0", "id": id, "result": map[string]any{"stopReason": "end_turn"}})
			}()
		}
	}
}

func TestInteractiveACPExactCancellationAndSessionResume(t *testing.T) {
	for _, provider := range []string{"opencode", "hermes"} {
		t.Run(provider, func(t *testing.T) {
			executable, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			start := func(name string) (*Session, context.CancelFunc, string) {
				dir := t.TempDir()
				release := filepath.Join(dir, "release")
				backend, err := New(provider, Config{ExecutablePath: executable, LaunchPrefix: []string{"-test.run=^TestInteractiveACPExecutionHelper$", "--"}, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), Env: map[string]string{"MULTICA_INTERACTIVE_EXECUTION_FIXTURE": "1", "MULTICA_INTERACTIVE_EXECUTION_TRACE": filepath.Join(dir, "trace"), "MULTICA_INTERACTIVE_EXECUTION_RELEASE": release}})
				if err != nil {
					t.Fatal(err)
				}
				ctx, cancel := context.WithCancel(t.Context())
				t.Cleanup(cancel)
				session, err := backend.Execute(ctx, "fixture", ExecOptions{StreamText: true, Cwd: dir, ResumeSessionID: name, Timeout: 10 * time.Second})
				if err != nil {
					t.Fatal(err)
				}
				deadline := time.After(3 * time.Second)
				for found := false; !found; {
					select {
					case message := <-session.Messages:
						if message.Type == MessageText {
							if message.Content != "partial-"+name {
								t.Fatalf("wrong current session text: %+v", message)
							}
							found = true
						}
					case <-deadline:
						t.Fatal("missing current turn text")
					}
				}
				trace, err := os.ReadFile(filepath.Join(dir, "trace"))
				if err != nil {
					t.Fatal(err)
				}
				method := "session/load"
				if provider == "hermes" {
					method = "session/resume"
				}
				if string(trace) != method+":"+name {
					t.Fatalf("resume: %s", trace)
				}
				return session, cancel, release
			}
			a, cancelA, _ := start("saved-a")
			b, _, releaseB := start("saved-b")
			cancelA()
			drained := make(chan struct{})
			go func() {
				for range a.Messages {
				}
				close(drained)
			}()
			select {
			case <-drained:
			case <-time.After(3 * time.Second):
				t.Fatal("A did not reach cleanup boundary")
			}
			result := <-a.Result
			if result.Status == "completed" || result.CancelUnconfirmed {
				t.Fatalf("cancel result: %+v", result)
			}
			select {
			case result := <-b.Result:
				t.Fatalf("B stopped with A: %+v", result)
			default:
			}
			if err := os.WriteFile(releaseB, nil, 0600); err != nil {
				t.Fatal(err)
			}
			var remaining string
			for message := range b.Messages {
				if message.Type == MessageText {
					remaining += message.Content
				}
			}
			result = <-b.Result
			if result.Status != "completed" || result.SessionID != "saved-b" || remaining != "-continued" {
				t.Fatalf("B continuity: text=%q result=%+v", remaining, result)
			}
		})
	}
}
