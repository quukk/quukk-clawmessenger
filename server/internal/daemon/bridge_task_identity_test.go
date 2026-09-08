package daemon

import (
	"context"
	"errors"
	"fmt"
	"github.com/multica-ai/multica/server/pkg/agent"
	"testing"
	"time"
)

func TestBridgeTaskRequestIdentityFence(t *testing.T) {
	runtime := BridgeRuntime{ID: "rt-test", Provider: "codex", Status: BridgeRuntimeReady}
	started := make(chan context.Context, 4)
	cleanup := make(chan struct{})
	backend := &bridgeTaskFakeBackend{execute: func(ctx context.Context, _ string, _ agent.ExecOptions) (*agent.Session, error) {
		started <- ctx
		messages := make(chan agent.Message)
		result := make(chan agent.Result, 1)
		go func() {
			<-ctx.Done()
			<-cleanup
			close(messages)
			result <- agent.Result{Status: "cancelled"}
			close(result)
		}()
		return &agent.Session{Messages: messages, Result: result}, nil
	}}
	root, cancel := context.WithCancel(context.Background())
	defer cancel()
	defer close(cleanup)
	manager := newBridgeTaskManager(root, bridgeTaskTestDeps(runtime, backend))
	request := BridgeTaskRequest{RequestID: fmt.Sprintf("task_%x_a", time.Now().UnixMilli()), RuntimeID: runtime.ID, ConversationKey: "a", WorkDir: `D:\work`, Prompt: "hello"}
	id, err := manager.Start(request)
	if err != nil || id != request.RequestID {
		t.Fatalf("identity: %s %v", id, err)
	}
	a := <-started
	again, err := manager.Start(request)
	if err != nil || again != id {
		t.Fatalf("retry: %s %v", again, err)
	}
	conflict := request
	conflict.Prompt = "different"
	if _, err := manager.Start(conflict); !errors.Is(err, ErrBridgeTaskRequestConflict) {
		t.Fatalf("conflict: %v", err)
	}
	bRequest := request
	bRequest.RequestID += "b"
	bRequest.ConversationKey = "b"
	if _, err := manager.Start(bRequest); err != nil {
		t.Fatal(err)
	}
	b := <-started
	ctx, stop := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer stop()
	if _, err := manager.Fence(ctx, id); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("premature proof: %v", err)
	}
	if a.Err() == nil || b.Err() != nil {
		t.Fatal("cancellation did not isolate exact request")
	}
	missing := request
	missing.RequestID += "c"
	if result, err := manager.Fence(context.Background(), missing.RequestID); err != nil || result != "not_started" {
		t.Fatalf("fence: %s %v", result, err)
	}
	if _, err := manager.Start(missing); !errors.Is(err, ErrBridgeTaskRequestFenced) {
		t.Fatalf("late start: %v", err)
	}
}

func TestBridgeTaskRequestExpiryRejectsReplay(t *testing.T) {
	manager := newBridgeTaskManager(context.Background(), bridgeTaskDeps{})
	request := BridgeTaskRequest{RequestID: "task_1_a", RuntimeID: "rt-test", ConversationKey: "a", WorkDir: `D:\work`, Prompt: "hello"}
	if _, err := manager.Start(request); !errors.Is(err, ErrBridgeTaskRequestExpired) {
		t.Fatalf("expired: %v", err)
	}
}

func TestBridgeTaskIdentityRetrySurvivesReadinessChange(t *testing.T) {
	runtime := BridgeRuntime{ID: "rt-test", Provider: "opencode", Status: BridgeRuntimeReady}
	deps := bridgeTaskTestDeps(runtime, &bridgeTaskFakeBackend{execute: func(context.Context, string, agent.ExecOptions) (*agent.Session, error) {
		return nil, errors.New("test")
	}})
	ready := true
	deps.runtimeByID = func(string) (BridgeRuntime, bool) {
		if !ready {
			return BridgeRuntime{}, false
		}
		return runtime, true
	}
	manager := newBridgeTaskManager(context.Background(), deps)
	req := BridgeTaskRequest{RequestID: fmt.Sprintf("task_%x_a", time.Now().UnixMilli()), RuntimeID: runtime.ID, ConversationKey: "a", WorkDir: `D:\work`, Prompt: "hello"}
	id, err := manager.Start(req)
	if err != nil {
		t.Fatal(err)
	}
	ready = false
	if retry, err := manager.Start(req); err != nil || retry != id {
		t.Fatalf("retry %s %v", retry, err)
	}
}

func TestBridgeTaskFenceCapacityFailsClosed(t *testing.T) {
	manager := newBridgeTaskManager(context.Background(), bridgeTaskDeps{})
	for i := 0; i < 2048; i++ {
		id := fmt.Sprintf("task_%x_%x", time.Now().UnixMilli(), i)
		if _, err := manager.Fence(context.Background(), id); err != nil {
			t.Fatal(err)
		}
	}
	if result, err := manager.Fence(context.Background(), fmt.Sprintf("task_%x_ffff", time.Now().UnixMilli())); err == nil {
		t.Fatalf("unbounded fence accepted: %s", result)
	}
}

func TestBridgeTaskModelsAreTaskLocalAndImmutable(t *testing.T) {
	runtime := BridgeRuntime{ID: "rt-test", Provider: "opencode", Status: BridgeRuntimeReady}
	models := make(chan string, 2)
	backend := &bridgeTaskFakeBackend{execute: func(_ context.Context, _ string, opts agent.ExecOptions) (*agent.Session, error) {
		models <- opts.Model
		messages := make(chan agent.Message)
		close(messages)
		result := make(chan agent.Result, 1)
		result <- agent.Result{Status: "completed"}
		close(result)
		return &agent.Session{Messages: messages, Result: result}, nil
	}}
	manager := newBridgeTaskManager(context.Background(), bridgeTaskTestDeps(runtime, backend))
	request := BridgeTaskRequest{RequestID: fmt.Sprintf("task_%x_a", time.Now().UnixMilli()), RuntimeID: runtime.ID, ConversationKey: "a", WorkDir: `D:\work`, Prompt: "hello", Model: "openai/model-a"}
	if _, err := manager.Start(request); err != nil {
		t.Fatal(err)
	}
	conflict := request
	conflict.Model = "anthropic/model-b"
	if _, err := manager.Start(conflict); !errors.Is(err, ErrBridgeTaskRequestConflict) {
		t.Fatalf("model conflict: %v", err)
	}
	conflict.RequestID += "b"
	conflict.ConversationKey = "b"
	if _, err := manager.Start(conflict); err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{<-models: true, <-models: true}
	if !got["openai/model-a"] || !got["anthropic/model-b"] {
		t.Fatalf("task-local models: %v", got)
	}
}

func TestBridgeTaskFenceWinsAgainstStartPreparingWorkdir(t *testing.T) {
	runtime := BridgeRuntime{ID: "rt-test", Provider: "opencode", Status: BridgeRuntimeReady}
	deps := bridgeTaskTestDeps(runtime, &bridgeTaskFakeBackend{execute: func(context.Context, string, agent.ExecOptions) (*agent.Session, error) {
		t.Error("fenced task executed")
		return nil, errors.New("fenced")
	}})
	entered, release := make(chan struct{}), make(chan struct{})
	deps.canonicalWorkDir = func(path string) (string, error) { close(entered); <-release; return path, nil }
	manager := newBridgeTaskManager(context.Background(), deps)
	req := BridgeTaskRequest{RequestID: fmt.Sprintf("task_%x_a", time.Now().UnixMilli()), RuntimeID: runtime.ID, ConversationKey: "a", WorkDir: `D:\work`, Prompt: "hello"}
	started := make(chan error, 1)
	go func() { _, err := manager.Start(req); started <- err }()
	<-entered
	if proof, err := manager.Fence(context.Background(), req.RequestID); err != nil || proof != "not_started" {
		t.Fatalf("fence %s %v", proof, err)
	}
	close(release)
	if err := <-started; !errors.Is(err, ErrBridgeTaskRequestFenced) {
		t.Fatalf("late Start: %v", err)
	}
}

func TestBridgeTaskFenceWaitsForTerminalAndPreservesSession(t *testing.T) {
	runtime := BridgeRuntime{ID: "rt-test", Provider: "opencode", Status: BridgeRuntimeReady}
	messages := make(chan agent.Message)
	results := make(chan agent.Result, 1)
	started := make(chan struct{})
	backend := &bridgeTaskFakeBackend{execute: func(context.Context, string, agent.ExecOptions) (*agent.Session, error) {
		close(started)
		return &agent.Session{Messages: messages, Result: results}, nil
	}}
	manager := newBridgeTaskManager(context.Background(), bridgeTaskTestDeps(runtime, backend))
	req := BridgeTaskRequest{RequestID: fmt.Sprintf("task_%x_a", time.Now().UnixMilli()), RuntimeID: runtime.ID, ConversationKey: "a", WorkDir: `D:\work`, Prompt: "hello"}
	id, err := manager.Start(req)
	if err != nil {
		t.Fatal(err)
	}
	<-started
	proof := make(chan string, 1)
	go func() {
		value, err := manager.Fence(context.Background(), id)
		if err != nil {
			value = err.Error()
		}
		proof <- value
	}()
	select {
	case value := <-proof:
		t.Fatalf("premature proof %s", value)
	case <-time.After(20 * time.Millisecond):
	}
	close(messages)
	results <- agent.Result{Status: "aborted", SessionID: "preserved"}
	close(results)
	if value := <-proof; value != "cancelled" {
		t.Fatalf("proof %s", value)
	}
	if value, err := manager.Fence(context.Background(), id); err != nil || value != "already_terminal" {
		t.Fatalf("repeat %s %v", value, err)
	}
	if value := manager.TerminalSession(id); value != "preserved" {
		t.Fatalf("session %s", value)
	}
}
