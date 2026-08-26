package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/multica-ai/multica/server/pkg/agent"
)

type bridgeTaskFakeBackend struct {
	execute func(context.Context, string, agent.ExecOptions) (*agent.Session, error)
}

func (f *bridgeTaskFakeBackend) Execute(ctx context.Context, prompt string, opts agent.ExecOptions) (*agent.Session, error) {
	return f.execute(ctx, prompt, opts)
}

func TestBridgeTaskPublicJSONContracts(t *testing.T) {
	requestType := reflect.TypeFor[BridgeTaskRequest]()
	wantRequestFields := []struct {
		name string
		tag  string
	}{
		{"RuntimeID", "runtime_id"},
		{"ConversationKey", "conversation_key"},
		{"ResumeSessionID", "resume_session_id,omitempty"},
		{"WorkDir", "workdir"},
		{"Prompt", "prompt"},
	}
	if requestType.NumField() != len(wantRequestFields) {
		t.Fatalf("BridgeTaskRequest field count = %d, want %d", requestType.NumField(), len(wantRequestFields))
	}
	for i, want := range wantRequestFields {
		field := requestType.Field(i)
		if field.Name != want.name || field.Tag.Get("json") != want.tag {
			t.Errorf("BridgeTaskRequest field %d = %s %q, want %s %q", i, field.Name, field.Tag.Get("json"), want.name, want.tag)
		}
	}

	eventType := reflect.TypeFor[BridgeTaskEvent]()
	wantEventFields := []struct {
		name string
		tag  string
	}{
		{"ID", "id"},
		{"Type", "type"},
		{"TaskID", "task_id"},
		{"Time", "time"},
		{"SessionID", "session_id,omitempty"},
		{"Text", "text,omitempty"},
		{"Tool", "tool,omitempty"},
		{"CallID", "call_id,omitempty"},
		{"Output", "output,omitempty"},
		{"Status", "status,omitempty"},
		{"Error", "error,omitempty"},
	}
	if eventType.NumField() != len(wantEventFields) {
		t.Fatalf("BridgeTaskEvent field count = %d, want %d", eventType.NumField(), len(wantEventFields))
	}
	for i, want := range wantEventFields {
		field := eventType.Field(i)
		if field.Name != want.name || field.Tag.Get("json") != want.tag {
			t.Errorf("BridgeTaskEvent field %d = %s %q, want %s %q", i, field.Name, field.Tag.Get("json"), want.name, want.tag)
		}
	}

	gotValues := []BridgeEventType{
		BridgeEventStarted,
		BridgeEventTextDelta,
		BridgeEventToolStarted,
		BridgeEventToolFinished,
		BridgeEventStatus,
		BridgeEventCompleted,
		BridgeEventFailed,
		BridgeEventCancelled,
	}
	wantValues := []BridgeEventType{
		"started", "text_delta", "tool_started", "tool_finished",
		"status", "completed", "failed", "cancelled",
	}
	if !reflect.DeepEqual(gotValues, wantValues) {
		t.Fatalf("Bridge event values = %q, want %q", gotValues, wantValues)
	}

	blob, err := json.Marshal(BridgeTaskEvent{
		ID:     1,
		Type:   BridgeEventFailed,
		TaskID: "task-1",
		Time:   time.Date(2026, 8, 26, 12, 0, 0, 0, time.UTC),
		Error:  &BridgeError{Category: "transport", Message: "runtime transport failed"},
	})
	if err != nil {
		t.Fatalf("marshal event: %v", err)
	}
	const wantJSON = `{"id":1,"type":"failed","task_id":"task-1","time":"2026-08-26T12:00:00Z","error":{"category":"transport","message":"runtime transport failed"}}`
	if string(blob) != wantJSON {
		t.Fatalf("event JSON = %s, want %s", blob, wantJSON)
	}
}

func TestBridgeTaskStartValidationErrorsAreClassifiable(t *testing.T) {
	runtime := BridgeRuntime{ID: "rt-ready", Provider: "codex", Version: "1.2.3", Path: `D:\fake\codex.exe`, Status: BridgeRuntimeReady}
	deps := bridgeTaskTestDeps(runtime, &bridgeTaskFakeBackend{execute: func(context.Context, string, agent.ExecOptions) (*agent.Session, error) {
		t.Fatal("invalid request reached backend")
		return nil, nil
	}})

	valid := BridgeTaskRequest{RuntimeID: runtime.ID, ConversationKey: "chat-1", WorkDir: `D:\work`, Prompt: "hello"}
	for name, mutate := range map[string]func(*BridgeTaskRequest){
		"runtime":      func(req *BridgeTaskRequest) { req.RuntimeID = "" },
		"conversation": func(req *BridgeTaskRequest) { req.ConversationKey = "" },
		"workdir":      func(req *BridgeTaskRequest) { req.WorkDir = "" },
		"prompt":       func(req *BridgeTaskRequest) { req.Prompt = "" },
	} {
		t.Run(name, func(t *testing.T) {
			req := valid
			mutate(&req)
			manager := newBridgeTaskManager(context.Background(), deps)
			if _, err := manager.Start(req); !errors.Is(err, ErrBridgeTaskInvalidRequest) {
				t.Fatalf("Start error = %v, want ErrBridgeTaskInvalidRequest", err)
			}
		})
	}

	t.Run("invalid workdir", func(t *testing.T) {
		badDeps := deps
		badDeps.canonicalWorkDir = func(string) (string, error) { return "", errors.New("not an absolute existing directory") }
		if _, err := newBridgeTaskManager(context.Background(), badDeps).Start(valid); !errors.Is(err, ErrBridgeTaskInvalidWorkDir) {
			t.Fatalf("Start error = %v, want ErrBridgeTaskInvalidWorkDir", err)
		}
	})

	t.Run("unknown runtime", func(t *testing.T) {
		unknownDeps := deps
		unknownDeps.runtimeByID = func(string) (BridgeRuntime, bool) { return BridgeRuntime{}, false }
		if _, err := newBridgeTaskManager(context.Background(), unknownDeps).Start(valid); !errors.Is(err, ErrBridgeTaskUnknownRuntime) {
			t.Fatalf("Start error = %v, want ErrBridgeTaskUnknownRuntime", err)
		}
	})

	t.Run("runtime not ready", func(t *testing.T) {
		notReadyDeps := deps
		notReadyDeps.runtimeByID = func(string) (BridgeRuntime, bool) {
			runtime.Status = BridgeRuntimeProbeFailed
			return runtime, true
		}
		if _, err := newBridgeTaskManager(context.Background(), notReadyDeps).Start(valid); !errors.Is(err, ErrBridgeTaskRuntimeNotReady) {
			t.Fatalf("Start error = %v, want ErrBridgeTaskRuntimeNotReady", err)
		}
	})
}

func TestBridgeTaskCanonicalWorkDirRequiresAbsoluteExistingDirectory(t *testing.T) {
	dir := t.TempDir()
	canonical, err := canonicalBridgeTaskWorkDir(dir)
	if err != nil {
		t.Fatalf("canonicalBridgeTaskWorkDir(valid): %v", err)
	}
	if !filepath.IsAbs(canonical) {
		t.Fatalf("canonical path = %q, want absolute", canonical)
	}
	if _, err := canonicalBridgeTaskWorkDir("relative"); err == nil {
		t.Fatal("relative workdir was accepted")
	}
	if _, err := canonicalBridgeTaskWorkDir(filepath.Join(dir, "missing")); err == nil {
		t.Fatal("missing workdir was accepted")
	}
	file := filepath.Join(dir, "file.txt")
	if err := os.WriteFile(file, []byte("not a directory"), 0o600); err != nil {
		t.Fatalf("write test file: %v", err)
	}
	if _, err := canonicalBridgeTaskWorkDir(file); err == nil {
		t.Fatal("ordinary file was accepted as workdir")
	}
}

func TestBridgeTaskAgentInputsAndEventMapping(t *testing.T) {
	fixedTime := time.Date(2026, 8, 26, 12, 30, 0, 0, time.UTC)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	runtime := BridgeRuntime{
		ID:       "rt-codex",
		Provider: "codex",
		Version:  "0.144.5",
		Path:     `D:\fake\codex.exe`,
		Status:   BridgeRuntimeReady,
	}
	var capturedPrompt string
	var capturedOpts agent.ExecOptions
	backend := &bridgeTaskFakeBackend{execute: func(_ context.Context, prompt string, opts agent.ExecOptions) (*agent.Session, error) {
		capturedPrompt, capturedOpts = prompt, opts
		return bridgeTaskBufferedSession([]agent.Message{
			{Type: agent.MessageText, Content: "delta"},
			{Type: agent.MessageThinking, Content: "private chain"},
			{Type: agent.MessageToolUse, Tool: "shell", CallID: "call-1", Input: map[string]any{"password": "input-secret"}},
			{Type: agent.MessageToolResult, CallID: "call-1", Output: "Authorization: Bearer bridge-secret " + strings.Repeat("界", 3000)},
			{Type: agent.MessageStatus, Status: "working", SessionID: "sess-live"},
			{Type: agent.MessageError, Content: "non-terminal raw diagnostic"},
			{Type: agent.MessageLog, Content: "private log"},
		}, agent.Result{Status: "completed", Output: "done", SessionID: "sess-final"}), nil
	}}

	deps := bridgeTaskTestDeps(runtime, backend)
	deps.logger = logger
	deps.timeout = 3 * time.Minute
	deps.now = func() time.Time { return fixedTime }
	var capturedProvider string
	var capturedConfig agent.Config
	deps.resolveBackend = func(provider string, cfg agent.Config) (agent.Backend, error) {
		capturedProvider, capturedConfig = provider, cfg
		return backend, nil
	}
	canonicalCalls := 0
	deps.canonicalWorkDir = func(got string) (string, error) {
		canonicalCalls++
		if got != `D:\requested` {
			t.Fatalf("canonicalWorkDir input = %q, want requested path", got)
		}
		return `D:\canonical`, nil
	}

	manager := newBridgeTaskManager(context.Background(), deps)
	taskID, err := manager.Start(BridgeTaskRequest{
		RuntimeID:       runtime.ID,
		ConversationKey: "chat-1",
		ResumeSessionID: "sess-old",
		WorkDir:         `D:\requested`,
		Prompt:          "do the work",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	events := bridgeTaskCollectEvents(t, manager, taskID, 0)

	if canonicalCalls != 1 {
		t.Fatalf("canonicalWorkDir calls = %d, want 1", canonicalCalls)
	}
	if capturedProvider != runtime.Provider {
		t.Fatalf("resolve provider = %q, want %q", capturedProvider, runtime.Provider)
	}
	wantConfig := agent.Config{
		ExecutablePath: runtime.Path,
		CLIVersion:     runtime.Version,
		Logger:         logger,
		TaskID:         "task-1",
		RuntimeID:      runtime.ID,
		CodexVersion:   runtime.Version,
		BuiltinRuntime: true,
	}
	if !reflect.DeepEqual(capturedConfig, wantConfig) {
		t.Fatalf("agent.Config = %#v, want %#v", capturedConfig, wantConfig)
	}
	if capturedPrompt != "do the work" {
		t.Fatalf("prompt = %q, want exact prompt", capturedPrompt)
	}
	wantOpts := agent.ExecOptions{
		Cwd:             `D:\canonical`,
		Timeout:         3 * time.Minute,
		ResumeSessionID: "sess-old",
		ResumeExpected:  true,
		OpenclawMode:    "local",
	}
	if !reflect.DeepEqual(capturedOpts, wantOpts) {
		t.Fatalf("agent.ExecOptions = %#v, want %#v", capturedOpts, wantOpts)
	}

	wantTypes := []BridgeEventType{
		BridgeEventStarted,
		BridgeEventTextDelta,
		BridgeEventToolStarted,
		BridgeEventToolFinished,
		BridgeEventStatus,
		BridgeEventCompleted,
	}
	if len(events) != len(wantTypes) {
		t.Fatalf("events = %+v, want %d mapped events", events, len(wantTypes))
	}
	for i, want := range wantTypes {
		if events[i].Type != want || events[i].ID != uint64(i+1) || events[i].TaskID != taskID || !events[i].Time.Equal(fixedTime) {
			t.Errorf("event[%d] = %+v, want type=%q id=%d task/time propagated", i, events[i], want, i+1)
		}
	}
	if events[1].Text != "delta" {
		t.Errorf("text event = %+v", events[1])
	}
	if events[2].Tool != "shell" || events[2].CallID != "call-1" {
		t.Errorf("tool_started event = %+v", events[2])
	}
	if events[3].Tool != "shell" || events[3].CallID != "call-1" {
		t.Errorf("tool_finished did not restore tool by call ID: %+v", events[3])
	}
	if strings.Contains(events[3].Output, "bridge-secret") {
		t.Fatalf("tool output leaked bearer secret: %q", events[3].Output)
	}
	if len([]byte(events[3].Output)) > 8192 || !utf8.ValidString(events[3].Output) {
		t.Fatalf("tool output bytes/UTF-8 = %d/%v, want <=8192/valid", len([]byte(events[3].Output)), utf8.ValidString(events[3].Output))
	}
	if events[4].Status != "working" || events[4].SessionID != "sess-live" {
		t.Errorf("status event = %+v", events[4])
	}
	if events[5].Output != "done" || events[5].SessionID != "sess-final" {
		t.Errorf("completed event = %+v", events[5])
	}
	blob, err := json.Marshal(events)
	if err != nil {
		t.Fatalf("marshal events: %v", err)
	}
	for _, secret := range []string{"input-secret", "bridge-secret", "private chain", "non-terminal raw diagnostic", "private log"} {
		if strings.Contains(string(blob), secret) {
			t.Errorf("marshalled events leaked %q: %s", secret, blob)
		}
	}
}

func TestBridgeTaskToolOutputNormalizesInvalidUTF8BeforeLimit(t *testing.T) {
	for _, testCase := range []struct {
		name  string
		input string
		want  string
	}{
		{
			name:  "short invalid input",
			input: string([]byte{'a', 0xff, 'b'}),
			want:  "a\uFFFDb",
		},
		{
			name:  "invalid input near byte limit",
			input: strings.Repeat("a", 8180) + string([]byte{0xff}) + strings.Repeat("b", 20),
			want:  strings.Repeat("a", 8180) + "\uFFFD" + strings.Repeat("b", 9),
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			got := truncateBridgeTaskUTF8(testCase.input, bridgeTaskToolOutputLimit)
			if got != testCase.want {
				t.Fatalf("normalized output bytes = %d, want exact %d-byte normalized prefix", len(got), len(testCase.want))
			}
			if !utf8.ValidString(got) || len(got) > bridgeTaskToolOutputLimit {
				t.Fatalf("output bytes/UTF-8 = %d/%v, want <=%d/valid", len(got), utf8.ValidString(got), bridgeTaskToolOutputLimit)
			}
		})
	}
}

func TestBridgeTaskResumeFallbackPolicy(t *testing.T) {
	runtime := BridgeRuntime{ID: "rt-codex", Provider: "codex", Version: "1.2.3", Path: `D:\fake\codex.exe`, Status: BridgeRuntimeReady}

	t.Run("retries once and clears resume", func(t *testing.T) {
		var mu sync.Mutex
		var opts []agent.ExecOptions
		attempt := 0
		backend := &bridgeTaskFakeBackend{execute: func(_ context.Context, _ string, got agent.ExecOptions) (*agent.Session, error) {
			mu.Lock()
			defer mu.Unlock()
			opts = append(opts, got)
			attempt++
			if attempt == 1 {
				return bridgeTaskBufferedSession(nil, agent.Result{Status: "failed", Error: "resume rejected", ResumeRejected: true}), nil
			}
			return bridgeTaskBufferedSession(nil, agent.Result{Status: "completed", Output: "fresh", SessionID: "sess-new"}), nil
		}}
		manager := newBridgeTaskManager(context.Background(), bridgeTaskTestDeps(runtime, backend))
		taskID, err := manager.Start(BridgeTaskRequest{RuntimeID: runtime.ID, ConversationKey: "chat", ResumeSessionID: "sess-old", WorkDir: `D:\work`, Prompt: "hello"})
		if err != nil {
			t.Fatalf("Start: %v", err)
		}
		events := bridgeTaskCollectEvents(t, manager, taskID, 0)
		mu.Lock()
		defer mu.Unlock()
		if len(opts) != 2 {
			t.Fatalf("Execute calls = %d, want 2", len(opts))
		}
		if opts[0].ResumeSessionID != "sess-old" || !opts[0].ResumeExpected {
			t.Errorf("first options = %+v, want resumed execution", opts[0])
		}
		if opts[1].ResumeSessionID != "" || opts[1].ResumeExpected {
			t.Errorf("retry options = %+v, want fresh execution", opts[1])
		}
		if terminal := bridgeTaskTerminalEvents(events); len(terminal) != 1 || terminal[0].Type != BridgeEventCompleted || terminal[0].Output != "fresh" || terminal[0].Status != "resume_invalidated" {
			t.Fatalf("terminal events = %+v, want one authoritative completion", terminal)
		}
	})

	t.Run("second failure is authoritative", func(t *testing.T) {
		var mu sync.Mutex
		attempts := 0
		backend := &bridgeTaskFakeBackend{execute: func(context.Context, string, agent.ExecOptions) (*agent.Session, error) {
			mu.Lock()
			attempts++
			mu.Unlock()
			return bridgeTaskBufferedSession(nil, agent.Result{Status: "failed", Error: "resume rejected", ResumeRejected: true}), nil
		}}
		manager := newBridgeTaskManager(context.Background(), bridgeTaskTestDeps(runtime, backend))
		taskID, err := manager.Start(BridgeTaskRequest{RuntimeID: runtime.ID, ConversationKey: "chat", ResumeSessionID: "sess-old", WorkDir: `D:\work`, Prompt: "hello"})
		if err != nil {
			t.Fatalf("Start: %v", err)
		}
		events := bridgeTaskCollectEvents(t, manager, taskID, 0)
		mu.Lock()
		gotAttempts := attempts
		mu.Unlock()
		if gotAttempts != 2 {
			t.Fatalf("Execute calls = %d, want exactly 2", gotAttempts)
		}
		if terminal := bridgeTaskTerminalEvents(events); len(terminal) != 1 || terminal[0].Type != BridgeEventFailed || terminal[0].Status != "resume_invalidated" {
			t.Fatalf("terminal events = %+v, want one final failure", terminal)
		}
	})

	t.Run("only final retry authentication failure mutates status", func(t *testing.T) {
		attempt := 0
		backend := &bridgeTaskFakeBackend{execute: func(context.Context, string, agent.ExecOptions) (*agent.Session, error) {
			attempt++
			if attempt == 1 {
				return bridgeTaskBufferedSession(nil, agent.Result{Status: "failed", Error: "resume rejected", SessionID: "sess-poisoned", ResumeRejected: true}), nil
			}
			return bridgeTaskBufferedSession(nil, agent.Result{Status: "failed", Error: "API Error: 401 Unauthorized"}), nil
		}}
		deps := bridgeTaskTestDeps(runtime, backend)
		var marked []string
		deps.markNeedsAuth = func(id string) { marked = append(marked, id) }
		manager := newBridgeTaskManager(context.Background(), deps)
		taskID, err := manager.Start(BridgeTaskRequest{RuntimeID: runtime.ID, ConversationKey: "chat", ResumeSessionID: "sess-old", WorkDir: `D:\work`, Prompt: "hello"})
		if err != nil {
			t.Fatalf("Start: %v", err)
		}
		events := bridgeTaskCollectEvents(t, manager, taskID, 0)
		if attempt != 2 {
			t.Fatalf("Execute calls = %d, want 2", attempt)
		}
		if !reflect.DeepEqual(marked, []string{runtime.ID}) {
			t.Fatalf("needs_auth marks = %v, want one final exact runtime ID", marked)
		}
		if terminal := bridgeTaskTerminalEvents(events); len(terminal) != 1 || terminal[0].Error == nil || terminal[0].Error.Category != "authentication" || terminal[0].SessionID != "" || terminal[0].Status != "resume_invalidated" {
			t.Fatalf("terminal events = %+v, want final authentication failure", terminal)
		}
	})

	t.Run("fresh Execute error invalidates rejected resume", func(t *testing.T) {
		attempts := 0
		backend := &bridgeTaskFakeBackend{execute: func(context.Context, string, agent.ExecOptions) (*agent.Session, error) {
			attempts++
			if attempts == 1 {
				return bridgeTaskBufferedSession(nil, agent.Result{Status: "failed", Error: "resume rejected", ResumeRejected: true}), nil
			}
			return nil, errors.New("fresh backend unavailable")
		}}
		manager := newBridgeTaskManager(context.Background(), bridgeTaskTestDeps(runtime, backend))
		taskID, err := manager.Start(BridgeTaskRequest{RuntimeID: runtime.ID, ConversationKey: "chat", ResumeSessionID: "sess-old", WorkDir: `D:\work`, Prompt: "hello"})
		if err != nil {
			t.Fatalf("Start: %v", err)
		}
		terminal := bridgeTaskTerminalEvents(bridgeTaskCollectEvents(t, manager, taskID, 0))
		if attempts != 2 {
			t.Fatalf("Execute calls = %d, want 2", attempts)
		}
		if len(terminal) != 1 || terminal[0].Type != BridgeEventFailed || terminal[0].SessionID != "" || terminal[0].Status != "resume_invalidated" || terminal[0].Error == nil || terminal[0].Error.Category != "runtime" {
			t.Fatalf("terminal events = %+v, want marked safe failure without session", terminal)
		}
	})

	t.Run("cancelled fresh retry invalidates rejected resume", func(t *testing.T) {
		attempts := 0
		freshStarted := make(chan struct{})
		backend := &bridgeTaskFakeBackend{execute: func(ctx context.Context, _ string, _ agent.ExecOptions) (*agent.Session, error) {
			attempts++
			if attempts == 1 {
				return bridgeTaskBufferedSession(nil, agent.Result{Status: "failed", Error: "resume rejected", ResumeRejected: true}), nil
			}
			close(freshStarted)
			messages := make(chan agent.Message)
			results := make(chan agent.Result, 1)
			go func() {
				<-ctx.Done()
				close(messages)
				results <- agent.Result{Status: "cancelled"}
				close(results)
			}()
			return &agent.Session{Messages: messages, Result: results}, nil
		}}
		manager := newBridgeTaskManager(context.Background(), bridgeTaskTestDeps(runtime, backend))
		taskID, err := manager.Start(BridgeTaskRequest{RuntimeID: runtime.ID, ConversationKey: "chat", ResumeSessionID: "sess-old", WorkDir: `D:\work`, Prompt: "hello"})
		if err != nil {
			t.Fatalf("Start: %v", err)
		}
		select {
		case <-freshStarted:
		case <-time.After(3 * time.Second):
			t.Fatal("fresh retry did not start")
		}
		if err := manager.Cancel(taskID); err != nil {
			t.Fatalf("Cancel: %v", err)
		}
		terminal := bridgeTaskTerminalEvents(bridgeTaskCollectEvents(t, manager, taskID, 0))
		if attempts != 2 {
			t.Fatalf("Execute calls = %d, want 2", attempts)
		}
		if len(terminal) != 1 || terminal[0].Type != BridgeEventCancelled || terminal[0].Status != "resume_invalidated" {
			t.Fatalf("terminal events = %+v, want marked cancellation", terminal)
		}
	})

	noRetryCases := []struct {
		name           string
		resumeID       string
		messages       []agent.Message
		errorText      string
		wantCategory   string
		resumeRejected bool
	}{
		{name: "fresh task", errorText: "resume rejected", wantCategory: "runtime", resumeRejected: true},
		{name: "tool observed", resumeID: "sess-old", messages: []agent.Message{{Type: agent.MessageToolUse, Tool: "write", CallID: "c1"}}, errorText: "resume rejected", wantCategory: "runtime", resumeRejected: true},
		{name: "authentication", resumeID: "sess-old", errorText: "API Error: 401 Unauthorized", wantCategory: "authentication", resumeRejected: true},
		{name: "network", resumeID: "sess-old", errorText: "dial tcp: connection refused", wantCategory: "transport", resumeRejected: true},
		{name: "quota", resumeID: "sess-old", errorText: "API Error: 402 Payment Required", wantCategory: "runtime", resumeRejected: true},
		{name: "capacity", resumeID: "sess-old", errorText: "API Error: 429 Too Many Requests", wantCategory: "runtime", resumeRejected: true},
		{name: "server", resumeID: "sess-old", errorText: "API Error: 503 Service unavailable", wantCategory: "runtime", resumeRejected: true},
	}
	for _, testCase := range noRetryCases {
		t.Run("no retry after "+testCase.name, func(t *testing.T) {
			var mu sync.Mutex
			attempts := 0
			backend := &bridgeTaskFakeBackend{execute: func(context.Context, string, agent.ExecOptions) (*agent.Session, error) {
				mu.Lock()
				attempts++
				mu.Unlock()
				return bridgeTaskBufferedSession(testCase.messages, agent.Result{Status: "failed", Error: testCase.errorText, ResumeRejected: testCase.resumeRejected}), nil
			}}
			deps := bridgeTaskTestDeps(runtime, backend)
			var marked []string
			deps.markNeedsAuth = func(id string) { marked = append(marked, id) }
			manager := newBridgeTaskManager(context.Background(), deps)
			taskID, err := manager.Start(BridgeTaskRequest{RuntimeID: runtime.ID, ConversationKey: "chat", ResumeSessionID: testCase.resumeID, WorkDir: `D:\work`, Prompt: "hello"})
			if err != nil {
				t.Fatalf("Start: %v", err)
			}
			events := bridgeTaskCollectEvents(t, manager, taskID, 0)
			mu.Lock()
			gotAttempts := attempts
			mu.Unlock()
			if gotAttempts != 1 {
				t.Fatalf("Execute calls = %d, want 1", gotAttempts)
			}
			terminal := bridgeTaskTerminalEvents(events)
			if len(terminal) != 1 || terminal[0].Type != BridgeEventFailed || terminal[0].Error == nil || terminal[0].Error.Category != testCase.wantCategory {
				t.Fatalf("terminal events = %+v, want one %s failure", terminal, testCase.wantCategory)
			}
			if terminal[0].Status != "" {
				t.Fatalf("non-retried terminal status = %q, want empty", terminal[0].Status)
			}
			if testCase.wantCategory == "authentication" {
				if !reflect.DeepEqual(marked, []string{runtime.ID}) {
					t.Fatalf("needs_auth marks = %v, want exact runtime ID", marked)
				}
			} else if len(marked) != 0 {
				t.Fatalf("non-auth failure marked needs_auth: %v", marked)
			}
		})
	}
}

func TestBridgeTaskTerminalResultStatusMapping(t *testing.T) {
	runtime := BridgeRuntime{ID: "rt-codex", Provider: "codex", Version: "1.2.3", Path: `D:\fake\codex.exe`, Status: BridgeRuntimeReady}
	for _, testCase := range []struct {
		status   string
		error    string
		wantType BridgeEventType
	}{
		{status: "failed", error: "runtime failed", wantType: BridgeEventFailed},
		{status: "timeout", error: "timed out after 1m", wantType: BridgeEventFailed},
		{status: "unknown", error: "unknown result", wantType: BridgeEventFailed},
		{status: "aborted", wantType: BridgeEventCancelled},
		{status: "cancelled", wantType: BridgeEventCancelled},
	} {
		t.Run(testCase.status, func(t *testing.T) {
			backend := &bridgeTaskFakeBackend{execute: func(context.Context, string, agent.ExecOptions) (*agent.Session, error) {
				return bridgeTaskBufferedSession(nil, agent.Result{Status: testCase.status, Error: testCase.error, SessionID: "sess-final"}), nil
			}}
			manager := newBridgeTaskManager(context.Background(), bridgeTaskTestDeps(runtime, backend))
			taskID, err := manager.Start(BridgeTaskRequest{RuntimeID: runtime.ID, ConversationKey: "chat", WorkDir: `D:\work`, Prompt: "hello"})
			if err != nil {
				t.Fatalf("Start: %v", err)
			}
			terminal := bridgeTaskTerminalEvents(bridgeTaskCollectEvents(t, manager, taskID, 0))
			if len(terminal) != 1 || terminal[0].Type != testCase.wantType || terminal[0].SessionID != "sess-final" {
				t.Fatalf("terminal events = %+v, want one %q with final session", terminal, testCase.wantType)
			}
		})
	}
}

func TestBridgeTaskNeedsAuthOnlyMarksExactCurrentRuntimeID(t *testing.T) {
	oldRuntime := BridgeRuntime{ID: "rt-old", Provider: "codex", Version: "1.2.3", Path: `D:\old\codex.exe`, Status: BridgeRuntimeReady}
	replacement := BridgeRuntime{ID: "rt-new", Provider: "codex", Version: "1.2.4", Path: `D:\new\codex.exe`, Status: BridgeRuntimeReady}
	bridge := newBridge("install", nil, bridgeDeps{})
	bridge.runtimes[0].runtime = oldRuntime

	executed := make(chan struct{})
	release := make(chan struct{})
	backend := &bridgeTaskFakeBackend{execute: func(context.Context, string, agent.ExecOptions) (*agent.Session, error) {
		close(executed)
		messages := make(chan agent.Message)
		results := make(chan agent.Result, 1)
		go func() {
			<-release
			close(messages)
			results <- agent.Result{Status: "failed", Error: "API Error: 401 Unauthorized"}
			close(results)
		}()
		return &agent.Session{Messages: messages, Result: results}, nil
	}}
	deps := bridgeTaskTestDeps(oldRuntime, backend)
	deps.runtimeByID = bridge.bridgeRuntimeByID
	deps.markNeedsAuth = bridge.markBridgeRuntimeNeedsAuth
	manager := newBridgeTaskManager(context.Background(), deps)
	taskID, err := manager.Start(BridgeTaskRequest{RuntimeID: oldRuntime.ID, ConversationKey: "chat", WorkDir: `D:\work`, Prompt: "hello"})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	<-executed
	if got, _ := bridge.bridgeRuntimeByID(oldRuntime.ID); got.Status != BridgeRuntimeReady {
		t.Fatalf("runtime changed before final result: %+v", got)
	}
	bridge.runtimeMu.Lock()
	bridge.runtimes[0].runtime = replacement
	bridge.runtimeMu.Unlock()
	close(release)
	events := bridgeTaskCollectEvents(t, manager, taskID, 0)
	if terminal := bridgeTaskTerminalEvents(events); len(terminal) != 1 || terminal[0].Error == nil || terminal[0].Error.Category != "authentication" {
		t.Fatalf("terminal events = %+v, want authentication failure", terminal)
	}
	got, ok := bridge.bridgeRuntimeByID(replacement.ID)
	if !ok || got.Status != BridgeRuntimeReady {
		t.Fatalf("replacement runtime was incorrectly marked: %+v, ok=%v", got, ok)
	}
}

func TestBridgeTaskExplicitAndRootCancellationWaitForCleanup(t *testing.T) {
	for _, cancelFirst := range []string{"explicit", "root"} {
		t.Run(cancelFirst, func(t *testing.T) {
			root, rootCancel := context.WithCancel(context.Background())
			defer rootCancel()
			cancelSeen := make(chan struct{})
			cleanup := make(chan struct{})
			runtime := BridgeRuntime{ID: "rt-codex", Provider: "codex", Version: "1.2.3", Path: `D:\fake\codex.exe`, Status: BridgeRuntimeReady}
			backend := &bridgeTaskFakeBackend{execute: func(ctx context.Context, _ string, _ agent.ExecOptions) (*agent.Session, error) {
				messages := make(chan agent.Message)
				results := make(chan agent.Result, 1)
				go func() {
					<-ctx.Done()
					close(cancelSeen)
					<-cleanup
					close(messages)
					results <- agent.Result{Status: "cancelled", SessionID: "sess-cancelled"}
					close(results)
				}()
				return &agent.Session{Messages: messages, Result: results}, nil
			}}
			manager := newBridgeTaskManager(root, bridgeTaskTestDeps(runtime, backend))
			taskID, err := manager.Start(BridgeTaskRequest{RuntimeID: runtime.ID, ConversationKey: "chat", WorkDir: `D:\work`, Prompt: "hello"})
			if err != nil {
				t.Fatalf("Start: %v", err)
			}
			subCtx, subCancel := context.WithCancel(context.Background())
			defer subCancel()
			eventsCh, err := manager.Subscribe(subCtx, taskID, 0)
			if err != nil {
				t.Fatalf("Subscribe: %v", err)
			}
			if event := bridgeTaskReceiveEvent(t, eventsCh); event.Type != BridgeEventStarted {
				t.Fatalf("first event = %+v, want started", event)
			}

			if cancelFirst == "explicit" {
				if err := manager.Cancel(taskID); err != nil {
					t.Fatalf("Cancel: %v", err)
				}
			} else {
				rootCancel()
			}
			select {
			case <-cancelSeen:
			case <-time.After(time.Second):
				t.Fatal("adapter context did not observe cancellation")
			}
			if cancelFirst == "explicit" {
				rootCancel()
			} else if err := manager.Cancel(taskID); err != nil {
				t.Fatalf("Cancel after root cancel: %v", err)
			}
			select {
			case event := <-eventsCh:
				t.Fatalf("terminal event arrived before adapter cleanup: %+v", event)
			case <-time.After(50 * time.Millisecond):
			}
			close(cleanup)
			var tail []BridgeTaskEvent
			for event := range eventsCh {
				tail = append(tail, event)
			}
			if terminal := bridgeTaskTerminalEvents(tail); len(terminal) != 1 || terminal[0].Type != BridgeEventCancelled || terminal[0].SessionID != "sess-cancelled" {
				t.Fatalf("terminal events = %+v, want one cancelled after cleanup", terminal)
			}
			if err := manager.Cancel(taskID); err != nil {
				t.Fatalf("Cancel known terminal task: %v", err)
			}
		})
	}

	manager := newBridgeTaskManager(context.Background(), bridgeTaskDeps{})
	if err := manager.Cancel("missing"); !errors.Is(err, ErrBridgeTaskUnknown) {
		t.Fatalf("Cancel unknown error = %v, want ErrBridgeTaskUnknown", err)
	}
}

func TestBridgeTaskSubscriberCancellationDoesNotCancelTask(t *testing.T) {
	runtime := BridgeRuntime{ID: "rt-codex", Provider: "codex", Version: "1.2.3", Path: `D:\fake\codex.exe`, Status: BridgeRuntimeReady}
	adapterContext := make(chan context.Context, 1)
	release := make(chan struct{})
	backend := &bridgeTaskFakeBackend{execute: func(ctx context.Context, _ string, _ agent.ExecOptions) (*agent.Session, error) {
		adapterContext <- ctx
		messages := make(chan agent.Message)
		results := make(chan agent.Result, 1)
		go func() {
			<-release
			close(messages)
			results <- agent.Result{Status: "completed", Output: "done"}
			close(results)
		}()
		return &agent.Session{Messages: messages, Result: results}, nil
	}}
	manager := newBridgeTaskManager(context.Background(), bridgeTaskTestDeps(runtime, backend))
	taskID, err := manager.Start(BridgeTaskRequest{RuntimeID: runtime.ID, ConversationKey: "chat", WorkDir: `D:\work`, Prompt: "hello"})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	eventsCh, err := manager.Subscribe(ctx, taskID, 0)
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	if event := bridgeTaskReceiveEvent(t, eventsCh); event.Type != BridgeEventStarted {
		t.Fatalf("first event = %+v, want started", event)
	}
	taskCtx := <-adapterContext
	cancel()
	select {
	case _, ok := <-eventsCh:
		if ok {
			t.Fatal("cancelled subscriber received another event")
		}
	case <-time.After(time.Second):
		t.Fatal("cancelled subscriber was not closed")
	}
	select {
	case <-taskCtx.Done():
		t.Fatal("subscriber context cancelled adapter task")
	case <-time.After(50 * time.Millisecond):
	}
	close(release)
	events := bridgeTaskCollectEvents(t, manager, taskID, 0)
	if terminal := bridgeTaskTerminalEvents(events); len(terminal) != 1 || terminal[0].Type != BridgeEventCompleted {
		t.Fatalf("terminal events = %+v, want completed task", terminal)
	}
}

func TestBridgeTaskCancellationDoesNotStartFreshRetry(t *testing.T) {
	runtime := BridgeRuntime{ID: "rt-codex", Provider: "codex", Version: "1.2.3", Path: `D:\fake\codex.exe`, Status: BridgeRuntimeReady}
	executed := make(chan struct{})
	var mu sync.Mutex
	attempts := 0
	backend := &bridgeTaskFakeBackend{execute: func(ctx context.Context, _ string, _ agent.ExecOptions) (*agent.Session, error) {
		mu.Lock()
		attempts++
		attempt := attempts
		mu.Unlock()
		if attempt > 1 {
			return bridgeTaskBufferedSession(nil, agent.Result{Status: "completed"}), nil
		}
		close(executed)
		messages := make(chan agent.Message)
		results := make(chan agent.Result, 1)
		go func() {
			<-ctx.Done()
			close(messages)
			results <- agent.Result{Status: "failed", Error: "resume rejected", ResumeRejected: true}
			close(results)
		}()
		return &agent.Session{Messages: messages, Result: results}, nil
	}}
	manager := newBridgeTaskManager(context.Background(), bridgeTaskTestDeps(runtime, backend))
	taskID, err := manager.Start(BridgeTaskRequest{RuntimeID: runtime.ID, ConversationKey: "chat", ResumeSessionID: "sess-old", WorkDir: `D:\work`, Prompt: "hello"})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	<-executed
	if err := manager.Cancel(taskID); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	events := bridgeTaskCollectEvents(t, manager, taskID, 0)
	mu.Lock()
	gotAttempts := attempts
	mu.Unlock()
	if gotAttempts != 1 {
		t.Fatalf("Execute calls after cancellation = %d, want no fresh retry", gotAttempts)
	}
	if terminal := bridgeTaskTerminalEvents(events); len(terminal) != 1 || terminal[0].Type != BridgeEventCancelled {
		t.Fatalf("terminal events = %+v, want one cancellation", terminal)
	}
}

func TestBridgeTaskQueuedCancellationNeverStartsBackend(t *testing.T) {
	for _, cancelMode := range []string{"explicit", "root"} {
		t.Run(cancelMode, func(t *testing.T) {
			root, rootCancel := context.WithCancel(context.Background())
			defer rootCancel()
			runtime := BridgeRuntime{ID: "rt-codex", Provider: "codex", Version: "1.2.3", Path: `D:\fake\codex.exe`, Status: BridgeRuntimeReady}
			firstEntered := make(chan struct{})
			releaseFirst := make(chan struct{})
			secondAcquired := make(chan struct{})
			releaseSecond := make(chan struct{})
			var callsMu sync.Mutex
			resolveCalls := 0
			executeCalls := 0
			backend := &bridgeTaskFakeBackend{execute: func(_ context.Context, prompt string, _ agent.ExecOptions) (*agent.Session, error) {
				callsMu.Lock()
				executeCalls++
				callsMu.Unlock()
				if prompt == "first" {
					close(firstEntered)
					<-releaseFirst
				}
				return bridgeTaskBufferedSession(nil, agent.Result{Status: "completed"}), nil
			}}
			deps := bridgeTaskTestDeps(runtime, backend)
			deps.newTaskID = bridgeTaskSequentialIDs()
			deps.afterConversationAcquire = func(taskID string) {
				if taskID == "task-2" {
					close(secondAcquired)
					<-releaseSecond
				}
			}
			deps.resolveBackend = func(string, agent.Config) (agent.Backend, error) {
				callsMu.Lock()
				resolveCalls++
				callsMu.Unlock()
				return backend, nil
			}
			manager := newBridgeTaskManager(root, deps)
			firstID, err := manager.Start(BridgeTaskRequest{RuntimeID: runtime.ID, ConversationKey: "chat", WorkDir: `D:\work`, Prompt: "first"})
			if err != nil {
				t.Fatalf("Start first: %v", err)
			}
			<-firstEntered
			secondID, err := manager.Start(BridgeTaskRequest{
				RuntimeID: runtime.ID, ConversationKey: "chat", WorkDir: `D:\work`, Prompt: "second",
			})
			if err != nil {
				t.Fatalf("Start second: %v", err)
			}
			close(releaseFirst)
			select {
			case <-secondAcquired:
			case <-time.After(3 * time.Second):
				t.Fatal("second task did not acquire the conversation gate")
			}
			if cancelMode == "root" {
				rootCancel()
			} else {
				if err := manager.Cancel(secondID); err != nil {
					t.Fatalf("Cancel queued task %q: %v", secondID, err)
				}
			}
			close(releaseSecond)

			events := bridgeTaskCollectEvents(t, manager, secondID, 0)
			if len(events) != 1 || events[0].Type != BridgeEventCancelled {
				t.Fatalf("queued task %q events = %+v, want only cancelled", secondID, events)
			}
			bridgeTaskCollectEvents(t, manager, firstID, 0)
			callsMu.Lock()
			gotResolveCalls, gotExecuteCalls := resolveCalls, executeCalls
			callsMu.Unlock()
			if gotResolveCalls != 1 || gotExecuteCalls != 1 {
				t.Fatalf("resolve/Execute calls = %d/%d, want only predecessor's 1/1", gotResolveCalls, gotExecuteCalls)
			}
		})
	}
}

func TestBridgeTaskConversationSerialization(t *testing.T) {
	runtimeA := BridgeRuntime{ID: "rt-a", Provider: "codex", Version: "1.2.3", Path: `D:\fake\codex.exe`, Status: BridgeRuntimeReady}
	runtimeB := BridgeRuntime{ID: "rt-b", Provider: "hermes", Version: "2.0.0", Path: `D:\fake\hermes.exe`, Status: BridgeRuntimeReady}

	t.Run("same runtime and conversation serialize", func(t *testing.T) {
		entered := make(chan string, 2)
		releases := map[string]chan struct{}{"one": make(chan struct{}), "two": make(chan struct{})}
		backend := &bridgeTaskFakeBackend{execute: func(_ context.Context, prompt string, _ agent.ExecOptions) (*agent.Session, error) {
			entered <- prompt
			<-releases[prompt]
			return bridgeTaskBufferedSession(nil, agent.Result{Status: "completed", Output: prompt}), nil
		}}
		deps := bridgeTaskTestDeps(runtimeA, backend)
		deps.newTaskID = bridgeTaskSequentialIDs()
		manager := newBridgeTaskManager(context.Background(), deps)
		firstID, err := manager.Start(BridgeTaskRequest{RuntimeID: runtimeA.ID, ConversationKey: "chat", WorkDir: `D:\work`, Prompt: "one"})
		if err != nil {
			t.Fatalf("Start first: %v", err)
		}
		if got := <-entered; got != "one" {
			t.Fatalf("first entered prompt = %q, want one", got)
		}
		secondID, err := manager.Start(BridgeTaskRequest{RuntimeID: runtimeA.ID, ConversationKey: "chat", WorkDir: `D:\work`, Prompt: "two"})
		if err != nil {
			t.Fatalf("Start second: %v", err)
		}
		select {
		case got := <-entered:
			close(releases["one"])
			close(releases["two"])
			t.Fatalf("same-key task %q entered before predecessor completed", got)
		case <-time.After(75 * time.Millisecond):
		}
		close(releases["one"])
		select {
		case got := <-entered:
			if got != "two" {
				t.Fatalf("second entered prompt = %q, want two", got)
			}
		case <-time.After(time.Second):
			t.Fatal("second same-key task did not enter after first completed")
		}
		close(releases["two"])
		bridgeTaskCollectEvents(t, manager, firstID, 0)
		bridgeTaskCollectEvents(t, manager, secondID, 0)
	})

	for name, second := range map[string]BridgeTaskRequest{
		"different conversation": {RuntimeID: runtimeA.ID, ConversationKey: "chat-2", WorkDir: `D:\work`, Prompt: "two"},
		"different runtime":      {RuntimeID: runtimeB.ID, ConversationKey: "chat", WorkDir: `D:\work`, Prompt: "two"},
	} {
		t.Run(name+" execute concurrently", func(t *testing.T) {
			entered := make(chan string, 2)
			release := make(chan struct{})
			backend := &bridgeTaskFakeBackend{execute: func(_ context.Context, prompt string, _ agent.ExecOptions) (*agent.Session, error) {
				entered <- prompt
				<-release
				return bridgeTaskBufferedSession(nil, agent.Result{Status: "completed"}), nil
			}}
			deps := bridgeTaskTestDeps(runtimeA, backend)
			deps.newTaskID = bridgeTaskSequentialIDs()
			deps.runtimeByID = func(id string) (BridgeRuntime, bool) {
				if id == runtimeA.ID {
					return runtimeA, true
				}
				return runtimeB, id == runtimeB.ID
			}
			manager := newBridgeTaskManager(context.Background(), deps)
			firstID, err := manager.Start(BridgeTaskRequest{RuntimeID: runtimeA.ID, ConversationKey: "chat", WorkDir: `D:\work`, Prompt: "one"})
			if err != nil {
				t.Fatalf("Start first: %v", err)
			}
			secondID, err := manager.Start(second)
			if err != nil {
				t.Fatalf("Start second: %v", err)
			}
			seen := map[string]bool{}
			for len(seen) < 2 {
				select {
				case prompt := <-entered:
					seen[prompt] = true
				case <-time.After(time.Second):
					close(release)
					t.Fatalf("tasks did not execute concurrently: entered=%v", seen)
				}
			}
			close(release)
			bridgeTaskCollectEvents(t, manager, firstID, 0)
			bridgeTaskCollectEvents(t, manager, secondID, 0)
		})
	}
}

func TestBridgeTaskReplayRingOverflowAndFutureCursor(t *testing.T) {
	runtime := BridgeRuntime{ID: "rt-codex", Provider: "codex", Version: "1.2.3", Path: `D:\fake\codex.exe`, Status: BridgeRuntimeReady}
	backend := &bridgeTaskFakeBackend{execute: func(context.Context, string, agent.ExecOptions) (*agent.Session, error) {
		return bridgeTaskBufferedSession([]agent.Message{
			{Type: agent.MessageText, Content: "one"},
			{Type: agent.MessageText, Content: "two"},
			{Type: agent.MessageText, Content: "three"},
			{Type: agent.MessageText, Content: "four"},
			{Type: agent.MessageText, Content: "five"},
		}, agent.Result{Status: "completed", Output: "done"}), nil
	}}
	deps := bridgeTaskTestDeps(runtime, backend)
	deps.eventLimit = 3
	deps.subscriberSize = 8
	deps.now = func() time.Time { return time.Date(2026, 8, 26, 15, 0, 0, 0, time.UTC) }
	manager := newBridgeTaskManager(context.Background(), deps)
	taskID, err := manager.Start(BridgeTaskRequest{RuntimeID: runtime.ID, ConversationKey: "chat", WorkDir: `D:\work`, Prompt: "hello"})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	bridgeTaskCollectEvents(t, manager, taskID, 0)

	replay := bridgeTaskCollectEvents(t, manager, taskID, 4)
	if got := bridgeTaskEventIDs(replay); !reflect.DeepEqual(got, []uint64{5, 6, 7}) {
		t.Fatalf("replay IDs = %v, want [5 6 7]", got)
	}
	overflow := bridgeTaskCollectEvents(t, manager, taskID, 0)
	if got := bridgeTaskEventIDs(overflow); !reflect.DeepEqual(got, []uint64{4, 5, 6, 7}) {
		t.Fatalf("overflow replay IDs = %v, want synthetic 4 then retained events", got)
	}
	if overflow[0].Type != BridgeEventStatus || overflow[0].Status != "replay_overflow" || overflow[0].TaskID != taskID {
		t.Fatalf("overflow marker = %+v", overflow[0])
	}
	if _, err := manager.Subscribe(context.Background(), taskID, 8); !errors.Is(err, ErrBridgeTaskFutureCursor) {
		t.Fatalf("future cursor error = %v, want ErrBridgeTaskFutureCursor", err)
	}

	manager.mu.Lock()
	task := manager.tasks[taskID]
	manager.mu.Unlock()
	task.mu.Lock()
	retained := append([]BridgeTaskEvent(nil), task.events...)
	task.mu.Unlock()
	if got := bridgeTaskEventIDs(retained); !reflect.DeepEqual(got, []uint64{5, 6, 7}) {
		t.Fatalf("retained ring IDs = %v, want bounded logical order", got)
	}
}

func TestBridgeTaskTerminalReplayDoesNotBlockOnSubscriberSize(t *testing.T) {
	runtime := BridgeRuntime{ID: "rt-codex", Provider: "codex", Version: "1.2.3", Path: `D:\fake\codex.exe`, Status: BridgeRuntimeReady}
	backend := &bridgeTaskFakeBackend{execute: func(context.Context, string, agent.ExecOptions) (*agent.Session, error) {
		return bridgeTaskBufferedSession([]agent.Message{
			{Type: agent.MessageText, Content: "one"},
			{Type: agent.MessageText, Content: "two"},
			{Type: agent.MessageText, Content: "three"},
		}, agent.Result{Status: "completed"}), nil
	}}
	deps := bridgeTaskTestDeps(runtime, backend)
	deps.eventLimit = 5
	deps.subscriberSize = 1
	manager := newBridgeTaskManager(context.Background(), deps)
	taskID, err := manager.Start(BridgeTaskRequest{RuntimeID: runtime.ID, ConversationKey: "chat", WorkDir: `D:\work`, Prompt: "hello"})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	bridgeTaskWaitTerminal(t, manager, taskID)

	type subscription struct {
		events <-chan BridgeTaskEvent
		err    error
	}
	returned := make(chan subscription, 1)
	go func() {
		events, err := manager.Subscribe(context.Background(), taskID, 0)
		returned <- subscription{events: events, err: err}
	}()
	select {
	case got := <-returned:
		if got.err != nil {
			t.Fatalf("Subscribe: %v", got.err)
		}
		var events []BridgeTaskEvent
		for event := range got.events {
			events = append(events, event)
		}
		if len(events) != 5 {
			t.Fatalf("terminal replay length = %d, want complete retained ring", len(events))
		}
	case <-time.After(200 * time.Millisecond):
		t.Fatal("Subscribe blocked while synchronously filling replay larger than subscriberSize")
	}
}

func TestBridgeTaskSlowSubscriberDisconnectsWithoutBlockingAdapterDrain(t *testing.T) {
	runtime := BridgeRuntime{ID: "rt-codex", Provider: "codex", Version: "1.2.3", Path: `D:\fake\codex.exe`, Status: BridgeRuntimeReady}
	messages := make(chan agent.Message)
	results := make(chan agent.Result, 1)
	executed := make(chan struct{})
	backend := &bridgeTaskFakeBackend{execute: func(context.Context, string, agent.ExecOptions) (*agent.Session, error) {
		close(executed)
		return &agent.Session{Messages: messages, Result: results}, nil
	}}
	deps := bridgeTaskTestDeps(runtime, backend)
	deps.subscriberSize = 1
	manager := newBridgeTaskManager(context.Background(), deps)
	taskID, err := manager.Start(BridgeTaskRequest{RuntimeID: runtime.ID, ConversationKey: "chat", WorkDir: `D:\work`, Prompt: "hello"})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	<-executed
	subscriber, err := manager.Subscribe(context.Background(), taskID, 0)
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}

	drained := make(chan struct{})
	go func() {
		for i := 0; i < 5; i++ {
			messages <- agent.Message{Type: agent.MessageText, Content: fmt.Sprintf("delta-%d", i)}
		}
		close(messages)
		close(drained)
		results <- agent.Result{Status: "completed"}
		close(results)
	}()

	blocked := false
	select {
	case <-drained:
	case <-time.After(200 * time.Millisecond):
		blocked = true
		go func() {
			for range subscriber {
			}
		}()
		select {
		case <-drained:
		case <-time.After(time.Second):
			t.Fatal("adapter message producer stayed blocked after test cleanup began draining")
		}
	}
	if blocked {
		t.Fatal("slow subscriber backpressured adapter message draining")
	}

	var delivered []BridgeTaskEvent
	for {
		select {
		case event, ok := <-subscriber:
			if !ok {
				if len(delivered) > 1 {
					t.Fatalf("slow subscriber was not disconnected on overflow: %+v", delivered)
				}
				return
			}
			delivered = append(delivered, event)
		case <-time.After(time.Second):
			t.Fatal("slow subscriber was not closed after overflow")
		}
	}
}

func TestBridgeTaskTerminalTTLEviction(t *testing.T) {
	runtime := BridgeRuntime{ID: "rt-codex", Provider: "codex", Version: "1.2.3", Path: `D:\fake\codex.exe`, Status: BridgeRuntimeReady}
	backend := &bridgeTaskFakeBackend{execute: func(context.Context, string, agent.ExecOptions) (*agent.Session, error) {
		return bridgeTaskBufferedSession(nil, agent.Result{Status: "completed"}), nil
	}}
	var clockMu sync.Mutex
	now := time.Date(2026, 8, 26, 16, 0, 0, 0, time.UTC)
	deps := bridgeTaskTestDeps(runtime, backend)
	deps.terminalTTL = time.Second
	deps.now = func() time.Time {
		clockMu.Lock()
		defer clockMu.Unlock()
		return now
	}
	manager := newBridgeTaskManager(context.Background(), deps)
	taskID, err := manager.Start(BridgeTaskRequest{RuntimeID: runtime.ID, ConversationKey: "chat", WorkDir: `D:\work`, Prompt: "hello"})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	bridgeTaskCollectEvents(t, manager, taskID, 0)
	clockMu.Lock()
	now = now.Add(2 * time.Second)
	clockMu.Unlock()
	if _, err := manager.Subscribe(context.Background(), taskID, 0); !errors.Is(err, ErrBridgeTaskUnknown) {
		t.Fatalf("Subscribe after terminal TTL error = %v, want ErrBridgeTaskUnknown", err)
	}
}

func bridgeTaskTestDeps(runtime BridgeRuntime, backend agent.Backend) bridgeTaskDeps {
	return bridgeTaskDeps{
		resolveBackend: func(string, agent.Config) (agent.Backend, error) { return backend, nil },
		runtimeByID: func(id string) (BridgeRuntime, bool) {
			return runtime, id == runtime.ID
		},
		markNeedsAuth:    func(string) {},
		canonicalWorkDir: func(path string) (string, error) { return path, nil },
		newTaskID:        func() string { return "task-1" },
		now:              time.Now,
		logger:           slog.New(slog.NewTextHandler(io.Discard, nil)),
		timeout:          time.Minute,
		eventLimit:       64,
		subscriberSize:   64,
		terminalTTL:      time.Hour,
	}
}

func bridgeTaskBufferedSession(messages []agent.Message, result agent.Result) *agent.Session {
	messageCh := make(chan agent.Message, len(messages))
	for _, message := range messages {
		messageCh <- message
	}
	close(messageCh)
	resultCh := make(chan agent.Result, 1)
	resultCh <- result
	close(resultCh)
	return &agent.Session{Messages: messageCh, Result: resultCh}
}

func bridgeTaskCollectEvents(t *testing.T, manager *bridgeTaskManager, taskID string, afterID uint64) []BridgeTaskEvent {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	eventsCh, err := manager.Subscribe(ctx, taskID, afterID)
	if err != nil {
		t.Fatalf("Subscribe(%q, %d): %v", taskID, afterID, err)
	}
	var events []BridgeTaskEvent
	for {
		select {
		case event, ok := <-eventsCh:
			if !ok {
				return events
			}
			events = append(events, event)
		case <-ctx.Done():
			t.Fatalf("timed out collecting events: %+v", events)
		}
	}
}

func bridgeTaskReceiveEvent(t *testing.T, events <-chan BridgeTaskEvent) BridgeTaskEvent {
	t.Helper()
	select {
	case event, ok := <-events:
		if !ok {
			t.Fatal("event channel closed early")
		}
		return event
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for event")
	}
	return BridgeTaskEvent{}
}

func bridgeTaskTerminalEvents(events []BridgeTaskEvent) []BridgeTaskEvent {
	var terminal []BridgeTaskEvent
	for _, event := range events {
		if bridgeTaskTerminalEvent(event.Type) {
			terminal = append(terminal, event)
		}
	}
	return terminal
}

func bridgeTaskSequentialIDs() func() string {
	var mu sync.Mutex
	next := 0
	return func() string {
		mu.Lock()
		defer mu.Unlock()
		next++
		return fmt.Sprintf("task-%d", next)
	}
}

func bridgeTaskEventIDs(events []BridgeTaskEvent) []uint64 {
	ids := make([]uint64, len(events))
	for i, event := range events {
		ids[i] = event.ID
	}
	return ids
}

func bridgeTaskWaitTerminal(t *testing.T, manager *bridgeTaskManager, taskID string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		manager.mu.Lock()
		task := manager.tasks[taskID]
		manager.mu.Unlock()
		if task != nil {
			task.mu.Lock()
			terminal := task.terminal
			task.mu.Unlock()
			if terminal {
				return
			}
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("task did not become terminal")
}

var _ agent.Backend = (*bridgeTaskFakeBackend)(nil)
