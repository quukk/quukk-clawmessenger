package agent

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestCodexRawAgentDeltasArriveBeforeCompletion(t *testing.T) {
	c, _, _ := newTestCodexClient(t)
	c.notificationProtocol = "raw"
	gate := &codexTurnNotificationGate{}
	gate.arm()
	c.acceptNotification = gate.accept
	c.threadID = "thread"
	var fragments []string
	var final string
	var done bool
	c.onMessage = func(m Message) {
		if m.Type == MessageText {
			fragments = append(fragments, m.Content)
		}
	}
	c.onFinalAnswer = func(text string) { final = text }
	c.onTurnDone = func(bool) { done = true }
	c.handleLine(`{"method":"turn/started","params":{"threadId":"thread","turn":{"id":"turn"}}}`)
	c.handleLine(`{"method":"item/agentMessage/delta","params":{"threadId":"thread","turnId":"turn","itemId":"answer","delta":"Hello "}}`)
	c.handleLine(`{"method":"item/agentMessage/delta","params":{"threadId":"thread","turnId":"turn","itemId":"answer","delta":"world"}}`)
	if !reflect.DeepEqual(fragments, []string{"Hello ", "world"}) {
		t.Fatalf("live fragments before any completion = %q, want [Hello  world]", fragments)
	}
	if done || final != "" {
		t.Fatal("deltas must not complete the turn or claim a final answer")
	}
	c.handleLine(`{"method":"item/completed","params":{"threadId":"thread","turnId":"turn","item":{"type":"agentMessage","id":"answer","text":"Hello world","phase":"final_answer"}}}`)
	if len(fragments) != 2 || final != "Hello world" || done {
		t.Fatalf("completion duplicated text or ended turn: fragments=%q final=%q done=%v", fragments, final, done)
	}
	c.handleLine(`{"method":"turn/completed","params":{"threadId":"thread","turn":{"id":"turn","status":"completed"}}}`)
	if !done {
		t.Fatal("turn/completed must finish the turn")
	}
}

func TestCodexRawAgentDeltaLifecycleAndOwnership(t *testing.T) {
	c, _, _ := newTestCodexClient(t)
	c.notificationProtocol = "raw"
	gate := &codexTurnNotificationGate{}
	c.acceptNotification = gate.accept
	c.threadID = "thread"
	var text string
	c.onMessage = func(m Message) {
		if m.Type == MessageText {
			text += m.Content
		}
	}
	delta := func(thread, turn, content string) {
		c.handleLine(fmt.Sprintf(`{"method":"item/agentMessage/delta","params":{"threadId":%q,"turnId":%q,"itemId":"answer","delta":%q}}`, thread, turn, content))
	}
	delta("thread", "old", "replay")
	gate.arm()
	c.handleLine(`{"method":"turn/started","params":{"threadId":"thread","turn":{"id":"turn"}}}`)
	delta("other", "turn", "foreign")
	delta("thread", "old", "stale")
	c.handleLine(`{"method":"item/reasoning/textDelta","params":{"threadId":"thread","turnId":"turn","itemId":"reasoning","delta":"private reasoning"}}`)
	delta("thread", "turn", "answer")
	c.handleLine(`{"method":"item/completed","params":{"threadId":"thread","turnId":"turn","item":{"type":"agentMessage","id":"answer","text":"answer"}}}`)
	delta("thread", "turn", "late item delta")
	c.handleLine(`{"method":"turn/completed","params":{"threadId":"thread","turn":{"id":"turn","status":"completed"}}}`)
	c.handleLine(`{"method":"item/agentMessage/delta","params":{"threadId":"thread","turnId":"turn","itemId":"late","delta":"late turn delta"}}`)
	if text != "answer" {
		t.Fatalf("accepted text = %q, want only current answer", text)
	}
}

// The subprocess is this test binary, so these tests never resolve an installed
// agent or touch an authenticated account. The file release handshake lets the
// parent assert on live messages before the fake sends completion notifications.
func TestCodexDeltaAppServerHelper(t *testing.T) {
	if os.Getenv("MULTICA_CODEX_DELTA_HELPER") != "1" {
		return
	}
	scenario := os.Getenv("MULTICA_CODEX_DELTA_SCENARIO")
	encoder := json.NewEncoder(os.Stdout)
	notify := func(method string, params map[string]any) {
		params["threadId"] = "delta-fixture"
		params["turnId"] = "turn"
		_ = encoder.Encode(map[string]any{"method": method, "params": params})
	}
	delta := func(id, text string) {
		notify("item/agentMessage/delta", map[string]any{"itemId": id, "delta": text})
	}
	complete := func(id, text, phase string) {
		notify("item/completed", map[string]any{"item": map[string]any{"id": id, "type": "agentMessage", "text": text, "phase": phase}})
	}
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		var request struct {
			ID     int    `json:"id"`
			Method string `json:"method"`
		}
		if json.Unmarshal(scanner.Bytes(), &request) != nil || request.ID == 0 {
			continue
		}
		result := map[string]any{}
		if request.Method == "thread/start" {
			result["thread"] = map[string]any{"id": "delta-fixture"}
		}
		_ = encoder.Encode(map[string]any{"id": request.ID, "result": result})
		if request.Method != "turn/start" {
			continue
		}
		notify("turn/started", map[string]any{"turn": map[string]any{"id": "turn"}})
		switch scenario {
		case "slow", "cancel":
			for i := 0; i < 600; i++ {
				delta("answer", "x")
			}
		case "legacy":
			notify("codex/event", map[string]any{"msg": map[string]any{"type": "agent_message", "message": "Hello world"}})
		case "multiple":
			delta("narration", "Checking. ")
			complete("narration", "Checking. ", "commentary")
			delta("answer", "Hello ")
			delta("answer", "world")
		default:
			delta("answer", "Hello ")
			delta("answer", "world")
		}
		if scenario == "live" {
			for {
				if _, err := os.Stat(os.Getenv("MULTICA_CODEX_DELTA_RELEASE")); err == nil {
					break
				}
				time.Sleep(5 * time.Millisecond)
			}
		}
		switch scenario {
		case "suffix":
			complete("answer", "Hello world!", "")
		case "mismatch":
			complete("answer", "Corrected answer", "")
		case "mismatch_final":
			complete("answer", "Corrected answer", "final_answer")
		case "empty":
			complete("answer", "", "final_answer")
		case "delta_only":
		case "slow", "cancel":
			complete("answer", strings.Repeat("x", 600), "final_answer")
		case "legacy":
			notify("codex/event", map[string]any{"msg": map[string]any{"type": "task_complete"}})
		default:
			complete("answer", "Hello world", "final_answer")
		}
		notify("turn/completed", map[string]any{"turn": map[string]any{"id": "turn", "status": "completed"}})
	}
	os.Exit(0)
}

func startCodexDeltaFixture(t *testing.T, scenario string) (*Session, context.CancelFunc, string) {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	taskHome := t.TempDir()
	if err := os.Mkdir(taskHome+"/sessions", 0700); err != nil {
		t.Fatal(err)
	}
	release := taskHome + "/release"
	backend := &codexBackend{cfg: Config{
		ExecutablePath: self,
		LaunchPrefix:   []string{"-test.run=^TestCodexDeltaAppServerHelper$", "--"},
		Logger:         slog.New(slog.NewTextHandler(io.Discard, nil)),
		Env:            map[string]string{"MULTICA_CODEX_DELTA_HELPER": "1", "MULTICA_CODEX_DELTA_SCENARIO": scenario, "MULTICA_CODEX_DELTA_RELEASE": release, "CODEX_HOME": taskHome},
	}}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	execution, err := backend.Execute(ctx, "fixture", ExecOptions{Timeout: 10 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	return execution, cancel, release
}

func TestCodexExecuteAgentDeltasBeforeCompletion(t *testing.T) {
	execution, _, release := startCodexDeltaFixture(t, "live")
	var fragments []string
	deadline := time.After(3 * time.Second)
	for len(fragments) < 2 {
		select {
		case message := <-execution.Messages:
			if message.Type == MessageText {
				fragments = append(fragments, message.Content)
			}
		case <-deadline:
			t.Fatalf("no two live deltas before completion: %q", fragments)
		}
	}
	if !reflect.DeepEqual(fragments, []string{"Hello ", "world"}) {
		t.Fatalf("fragments = %q", fragments)
	}
	if err := os.WriteFile(release, nil, 0600); err != nil {
		t.Fatal(err)
	}
	for message := range execution.Messages {
		if message.Type == MessageText {
			t.Fatalf("completion duplicated text: %q", message.Content)
		}
	}
	result := <-execution.Result
	if result.Status != "completed" || result.Output != "Hello world" {
		t.Fatalf("result = %+v", result)
	}
}

func TestCodexExecuteAgentDeltaCompletion(t *testing.T) {
	for _, tc := range []struct{ scenario, live, output string }{
		{"suffix", "Hello world!", "Hello world!"},
		{"mismatch", "Hello world", "Corrected answer"},
		{"mismatch_final", "Hello world", "Corrected answer"},
		{"empty", "Hello world", "Hello world"},
		{"delta_only", "Hello world", "Hello world"},
		{"multiple", "Checking. Hello world", "Hello world"},
		{"legacy", "Hello world", "Hello world"},
	} {
		t.Run(tc.scenario, func(t *testing.T) {
			execution, _, _ := startCodexDeltaFixture(t, tc.scenario)
			var live strings.Builder
			for message := range execution.Messages {
				if message.Type == MessageText {
					live.WriteString(message.Content)
				}
			}
			result := <-execution.Result
			if live.String() != tc.live || result.Output != tc.output || result.Status != "completed" {
				t.Fatalf("live=%q result=%+v, want live=%q output=%q", live.String(), result, tc.live, tc.output)
			}
		})
	}
}

func TestCodexExecuteAgentDeltasSlowConsumer(t *testing.T) {
	execution, _, _ := startCodexDeltaFixture(t, "slow")
	// Leave the 256-message channel full while the fixture emits 600 deltas.
	waitForCodexDeltaBackpressure(t, execution)
	var live strings.Builder
	var fragments int
	for message := range execution.Messages {
		if message.Type == MessageText {
			live.WriteString(message.Content)
			fragments++
		}
	}
	result := <-execution.Result
	if fragments != 600 || live.String() != strings.Repeat("x", 600) || result.Output != strings.Repeat("x", 600) || result.Status != "completed" {
		t.Fatalf("lost text under backpressure: fragments=%d live length=%d result=%+v", fragments, live.Len(), result)
	}
}

func TestCodexExecuteAgentDeltasCancelBlockedConsumer(t *testing.T) {
	execution, cancel, _ := startCodexDeltaFixture(t, "cancel")
	waitForCodexDeltaBackpressure(t, execution)
	cancel()
	select {
	case result := <-execution.Result:
		if result.Status != "aborted" {
			t.Fatalf("cancel result = %+v", result)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("cancellation did not unblock text delivery and process cleanup")
	}
}

func waitForCodexDeltaBackpressure(t *testing.T, session *Session) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for len(session.Messages) < cap(session.Messages) {
		if time.Now().After(deadline) {
			t.Fatalf("message buffer never filled: got %d messages", len(session.Messages))
		}
		time.Sleep(5 * time.Millisecond)
	}
}
