package agent

import (
	"context"
	"testing"
)

func TestInteractiveModelUsesKnownRuntimeMapping(t *testing.T) {
	for _, tc := range []struct {
		provider, model, want string
		valid                 bool
	}{
		{"codex", "openai/gpt-5.5", "gpt-5.5", true},
		{"codex", "unknown/gpt-5.5", "", false},
		{"opencode", "openai/gpt-5.5", "openai/gpt-5.5", true},
		{"hermes", "anthropic/claude", "anthropic/claude", true},
		{"openclaw", "openai/gpt-5.5", "openai/gpt-5.5", true},
	} {
		got, err := InteractiveModelSelector(tc.provider, tc.model)
		if (err == nil) != tc.valid || got != tc.want {
			t.Fatalf("%+v: %q %v", tc, got, err)
		}
	}
}

func TestInteractiveOpenclawConcurrentModelsDoNotShareSession(t *testing.T) {
	f := newOpenclawGatewayFixture(t, "model-valid")
	a, err := f.execute(t, context.Background(), ExecOptions{TaskModel: "openai/model-a"})
	if err != nil {
		t.Fatal(err)
	}
	b, err := f.execute(t, context.Background(), ExecOptions{TaskModel: "anthropic/model-b"})
	if err != nil {
		t.Fatal(err)
	}
	for range a.Messages {
	}
	for range b.Messages {
	}
	ar, br := openCodeACPResult(t, a), openCodeACPResult(t, b)
	if ar.Status != "completed" || br.Status != "completed" || ar.SessionID == br.SessionID {
		t.Fatalf("sessions %+v %+v", ar, br)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	selections := map[string]any{}
	for _, req := range f.requests {
		if req.Method == "sessions.patch" {
			selections[req.Params["key"].(string)] = req.Params["model"]
		}
	}
	if selections[ar.SessionID] != "openai/model-a" || selections[br.SessionID] != "anthropic/model-b" {
		t.Fatalf("model leakage %v", selections)
	}
}

func TestInteractiveOpenclawModelIsSessionLocal(t *testing.T) {
	for _, tc := range []struct {
		mode, resume string
		success      bool
	}{
		{"model-valid", "", true}, {"model-valid", "agent:writer:clawmessenger:saved", true},
		{"model-admin", "", false}, {"model-wrong", "", false}, {"normal", "", false},
	} {
		t.Run(tc.mode+tc.resume, func(t *testing.T) {
			f := newOpenclawGatewayFixture(t, tc.mode)
			s, err := f.execute(t, context.Background(), ExecOptions{Model: "writer", TaskModel: "openai/model-a", ResumeSessionID: tc.resume})
			if err != nil {
				t.Fatal(err)
			}
			for range s.Messages {
			}
			result := openCodeACPResult(t, s)
			if (result.Status == "completed") != tc.success {
				t.Fatalf("result: %+v", result)
			}
			f.mu.Lock()
			defer f.mu.Unlock()
			patched, created, sent := false, false, false
			for _, req := range f.requests {
				switch req.Method {
				case "sessions.create":
					created = true
					if req.Params["model"] != "openai/model-a" || req.Params["agentId"] != "writer" {
						t.Fatalf("create %+v", req)
					}
				case "sessions.patch":
					patched = true
					if req.Params["model"] != "openai/model-a" || req.Params["key"] != result.SessionID {
						t.Fatalf("patch %+v result %+v", req, result)
					}
				case "chat.send":
					sent = true
				case "connect", "agents.list", "sessions.resolve":
				default:
					t.Fatalf("unexpected mutation: %+v", req)
				}
			}
			if sent != tc.success || tc.success && (!patched || created != (tc.resume == "")) {
				t.Fatalf("create=%v patch=%v send=%v", created, patched, sent)
			}
			if tc.mode == "model-admin" && (created || patched) {
				t.Fatal("elevated scope used for model mutation")
			}
		})
	}
}
