package agent

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// A test-owned Gateway validates actual socket frames; no installed CLI or
// account is resolved. History deliberately contains text that must not stream.
type openclawGatewayFixture struct {
	t        *testing.T
	mode     string
	mu       sync.Mutex
	requests []struct {
		Method string
		Params map[string]any
	}
	release  chan struct{}
	aborted  chan struct{}
	config   string
	run, key string
}

func newOpenclawGatewayFixture(t *testing.T, mode string) *openclawGatewayFixture {
	t.Helper()
	f := &openclawGatewayFixture{t: t, mode: mode, release: make(chan struct{}), aborted: make(chan struct{})}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		var writeMu sync.Mutex
		send := func(frame any) { writeMu.Lock(); defer writeMu.Unlock(); _ = conn.WriteJSON(frame) }
		send(map[string]any{"type": "event", "event": "connect.challenge", "payload": map[string]any{"nonce": "challenge", "ts": time.Now().UnixMilli()}})
		f.mu.Lock()
		run, key := f.run, f.key
		f.mu.Unlock()
		var historyChecks int
		for {
			var req struct {
				ID     string         `json:"id"`
				Method string         `json:"method"`
				Params map[string]any `json:"params"`
			}
			if conn.ReadJSON(&req) != nil {
				return
			}
			f.mu.Lock()
			f.requests = append(f.requests, struct {
				Method string
				Params map[string]any
			}{req.Method, req.Params})
			f.mu.Unlock()
			reply := func(payload any) { send(map[string]any{"type": "res", "id": req.ID, "ok": true, "payload": payload}) }
			fail := func() {
				send(map[string]any{"type": "res", "id": req.ID, "ok": false, "error": map[string]any{"code": "INVALID_REQUEST", "message": "do not leak secret-token"}})
			}
			chunk := func(rid, state, text string) {
				if f.mode == "usage" && state == "final" {
					send(map[string]any{"type": "event", "event": "chat", "payload": map[string]any{"runId": rid, "sessionKey": key, "state": state, "usage": map[string]any{"inputTokens": 11, "outputTokens": 7, "cacheRead": 3}, "message": map[string]any{"model": "test-model", "content": []any{map[string]any{"type": "text", "text": text}}}}})
					return
				}
				send(map[string]any{"type": "event", "event": "chat", "payload": map[string]any{"runId": rid, "sessionKey": key, "state": state, "message": map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "text", "text": text}}}}})
			}
			switch req.Method {
			case "connect":
				auth, _ := req.Params["auth"].(map[string]any)
				device, _ := req.Params["device"].(map[string]any)
				client, _ := req.Params["client"].(map[string]any)
				pub, _ := base64.RawURLEncoding.DecodeString(fmt.Sprint(device["publicKey"]))
				sig, _ := base64.RawURLEncoding.DecodeString(fmt.Sprint(device["signature"]))
				hash := sha256.Sum256(pub)
				signed := strings.Join([]string{"v3", hex.EncodeToString(hash[:]), "gateway-client", "backend", "operator", "operator.read,operator.write", fmt.Sprintf("%.0f", device["signedAt"]), "secret-token", "challenge", fmt.Sprint(client["platform"]), ""}, "|")
				if auth["token"] != "secret-token" || len(pub) != ed25519.PublicKeySize || !ed25519.Verify(pub, []byte(signed), sig) || req.Params["role"] != "operator" {
					fail()
					continue
				}
				reply(map[string]any{"type": "hello-ok", "protocol": 4, "auth": map[string]any{"role": "operator", "scopes": []string{"operator.read", "operator.write"}}})
			case "agents.list":
				reply(map[string]any{"defaultId": "main", "agents": []any{map[string]any{"id": "main"}, map[string]any{"id": "writer"}}})
			case "sessions.resolve":
				if f.mode == "missing" {
					fail()
					continue
				}
				resolved := "agent:writer:old-conversation"
				if requested, ok := req.Params["key"].(string); ok {
					resolved = requested
				}
				reply(map[string]any{"ok": true, "key": resolved})
			case "chat.send":
				run, _ = req.Params["idempotencyKey"].(string)
				key, _ = req.Params["sessionKey"].(string)
				f.mu.Lock()
				f.run, f.key = run, key
				f.mu.Unlock()
				if run == "" || key == "" {
					fail()
					continue
				}
				if f.mode == "send-error" {
					fail()
					continue
				}
				if f.mode == "ack-error" || f.mode == "ack-empty" {
					status := "error"
					if f.mode == "ack-empty" {
						status = "ok"
					}
					reply(map[string]any{"runId": run, "status": status})
					continue
				}
				if f.mode != "before-ack" {
					reply(map[string]any{"runId": run, "status": "started"})
				}
				chunk("foreign-run", "final", "foreign text")
				chunk(run, "delta", "Hello ")
				if f.mode == "eof" {
					return
				}
				if f.mode == "cancel" || f.mode == "timeout" || f.mode == "unconfirmed" || f.mode == "before-ack" {
					continue
				}
				if f.mode == "hold" {
					select {
					case <-f.release:
					case <-time.After(5 * time.Second):
						return
					}
				}
				if f.mode == "many" {
					for i := 1; i <= 1024; i++ {
						chunk(run, "delta", "Hello "+strings.Repeat("x", i))
					}
				}
				if f.mode == "error" {
					chunk(run, "error", "")
					continue
				}
				if f.mode == "many" {
					chunk(run, "final", "Hello "+strings.Repeat("x", 1024))
				} else if f.mode == "replace" {
					chunk(run, "final", "Corrected final")
				} else {
					chunk(run, "delta", "Hello world!")
					chunk(run, "final", "Hello world!")
				}
				chunk(run, "delta", "Hello world! LATE")
			case "chat.abort":
				if req.Params["runId"] != run || req.Params["sessionKey"] != key {
					fail()
					continue
				}
				select {
				case <-f.aborted:
				default:
					close(f.aborted)
				}
				chunk(run, "aborted", "")
				reply(map[string]any{"ok": true, "aborted": true, "runIds": []string{run}})
			case "chat.history":
				historyChecks++
				ids := []string{"other-running-turn"}
				if historyChecks == 1 || f.mode == "unconfirmed" {
					ids = append(ids, run)
				}
				reply(map[string]any{"sessionKey": key, "sessionInfo": map[string]any{"hasActiveRun": true, "activeRunIds": ids}, "messages": []any{map[string]any{"role": "assistant", "content": "OLD HISTORY"}}})
			default:
				fail()
			}
		}
	}))
	t.Cleanup(srv.Close)
	u, _ := url.Parse(srv.URL)
	port, _ := strconv.Atoi(u.Port())
	f.config = filepath.Join(t.TempDir(), "openclaw.json")
	data, _ := json.Marshal(map[string]any{"gateway": map[string]any{"mode": "local", "port": port, "auth": map[string]any{"mode": "token", "token": "secret-token"}}})
	if err := os.WriteFile(f.config, data, 0600); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *openclawGatewayFixture) execute(t *testing.T, ctx context.Context, opts ExecOptions) (*Session, error) {
	t.Helper()
	b, err := New("openclaw", Config{ExecutablePath: filepath.Join(t.TempDir(), "missing-cli"), Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), Env: map[string]string{"OPENCLAW_CONFIG_PATH": f.config, "OPENCLAW_GATEWAY_URL": "", "OPENCLAW_GATEWAY_TOKEN": "", "OPENCLAW_GATEWAY_PORT": "", "OPENCLAW_PROFILE": "", "OPENCLAW_HOME": "", "OPENCLAW_STATE_DIR": ""}})
	if err != nil {
		t.Fatal(err)
	}
	opts.StreamText = true
	return b.Execute(ctx, "test prompt", opts)
}

func TestOpenclawGatewayEarlyTextAndContinuity(t *testing.T) {
	f := newOpenclawGatewayFixture(t, "hold")
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	s, err := f.execute(t, ctx, ExecOptions{Model: "writer", ResumeSessionID: "11111111-1111-4111-8111-111111111111", ThinkingLevel: "high", SystemPrompt: "system"})
	if err != nil {
		t.Fatal(err)
	}
	var text strings.Builder
	for m := range s.Messages {
		if m.Type == MessageText {
			text.WriteString(m.Content)
			break
		}
	}
	if text.String() != "Hello " {
		t.Fatalf("early text %q", text.String())
	}
	select {
	case r := <-s.Result:
		t.Fatalf("terminal before release: %+v", r)
	default:
	}
	close(f.release)
	for m := range s.Messages {
		if m.Type == MessageText {
			text.WriteString(m.Content)
		}
	}
	r := openCodeACPResult(t, s)
	if r.Status != "completed" || r.Output != "Hello world!" || text.String() != r.Output || r.SessionID != "agent:writer:old-conversation" {
		t.Fatalf("result %+v; stream %q", r, text.String())
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, req := range f.requests {
		if req.Method == "sessions.resolve" && (req.Params["sessionId"] != "11111111-1111-4111-8111-111111111111" || req.Params["agentId"] != "writer") {
			t.Fatalf("wrong legacy resolution: %+v", req)
		}
		if req.Method == "chat.send" && (req.Params["message"] != "system\n\ntest prompt" || req.Params["thinking"] != "high") {
			t.Fatalf("discarded requested settings: %+v", req)
		}
	}
}

func TestOpenclawGatewayTerminalAndLosslessOutput(t *testing.T) {
	for _, tc := range []struct{ mode, status, output string }{{"normal", "completed", "Hello world!"}, {"many", "completed", "Hello " + strings.Repeat("x", 1024)}, {"replace", "completed", "Corrected final"}, {"error", "failed", "Hello "}, {"send-error", "failed", ""}, {"eof", "failed", "Hello "}, {"missing", "failed", ""}} {
		t.Run(tc.mode, func(t *testing.T) {
			f := newOpenclawGatewayFixture(t, tc.mode)
			ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
			defer cancel()
			opts := ExecOptions{}
			if tc.mode == "missing" {
				opts.ResumeSessionID = "11111111-1111-4111-8111-111111111111"
			}
			s, err := f.execute(t, ctx, opts)
			if err != nil {
				t.Fatal(err)
			}
			var streamed strings.Builder
			for m := range s.Messages {
				if m.Type == MessageText {
					streamed.WriteString(m.Content)
				}
			}
			r := openCodeACPResult(t, s)
			if r.Status != tc.status || r.Output != tc.output || strings.Contains(r.Error, "secret-token") {
				t.Fatalf("result %+v; stream %q", r, streamed.String())
			}
			if tc.mode == "normal" || tc.mode == "many" {
				if streamed.String() != tc.output {
					t.Fatalf("lost or late text: %q", streamed.String())
				}
			}
			if tc.mode == "normal" && !strings.HasPrefix(r.SessionID, "agent:main:clawmessenger:") {
				t.Fatalf("non-isolated session %q", r.SessionID)
			}
		})
	}
}

func TestOpenclawGatewayCancellationRequiresExactRunConfirmation(t *testing.T) {
	for _, mode := range []string{"cancel", "timeout", "before-ack", "unconfirmed"} {
		t.Run(mode, func(t *testing.T) {
			f := newOpenclawGatewayFixture(t, mode)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			opts := ExecOptions{}
			if mode == "timeout" {
				opts.Timeout = 200 * time.Millisecond
			}
			s, err := f.execute(t, ctx, opts)
			if err != nil {
				t.Fatal(err)
			}
			for m := range s.Messages {
				if m.Type == MessageText {
					break
				}
			}
			if mode != "timeout" {
				cancel()
			}
			r := openCodeACPResult(t, s)
			want := "aborted"
			if mode == "timeout" {
				want = "timeout"
			}
			if mode == "unconfirmed" {
				want = "failed"
			}
			if r.Status != want || r.Output != "Hello " {
				t.Fatalf("result %+v", r)
			}
			if mode == "unconfirmed" && !strings.Contains(r.Error, "stop unconfirmed") {
				t.Fatalf("unconfirmed stop disguised: %+v", r)
			}
			select {
			case <-f.aborted:
			default:
				t.Fatal("no exact Gateway abort")
			}
			f.mu.Lock()
			count := 0
			for _, req := range f.requests {
				if req.Method == "chat.history" {
					count++
				}
			}
			f.mu.Unlock()
			if count < 2 {
				t.Fatal("accepted eager aborted event without checking active run removal")
			}
			for m := range s.Messages {
				if m.Type == MessageText {
					t.Fatalf("late text after cancel: %+v", m)
				}
			}
		})
	}
}

func TestOpenclawGatewayDisconnectStopsOriginalRun(t *testing.T) {
	f := newOpenclawGatewayFixture(t, "eof")
	s, err := f.execute(t, context.Background(), ExecOptions{})
	if err != nil {
		t.Fatal(err)
	}
	for range s.Messages {
	}
	r := openCodeACPResult(t, s)
	if r.Status != "failed" || r.Output != "Hello " {
		t.Fatalf("result %+v", r)
	}
	select {
	case <-f.aborted:
	default:
		t.Fatal("disconnected run left active without targeted reconnect cleanup")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	var identity string
	connections := 0
	for _, req := range f.requests {
		if req.Method == "connect" {
			connections++
			device, _ := req.Params["device"].(map[string]any)
			id, _ := device["id"].(string)
			if id == "" || identity != "" && identity != id {
				t.Fatal("reconnect lost run owner identity")
			}
			identity = id
		}
	}
	if connections != 2 {
		t.Fatalf("connections %d", connections)
	}
}

func TestOpenclawGatewayResumesUnspecifiedAgentAndTerminalAck(t *testing.T) {
	for _, tc := range []struct{ mode, resume, status string }{
		{"normal", "11111111-1111-4111-8111-111111111111", "completed"},
		{"normal", "agent:writer:old-conversation", "completed"},
		{"ack-error", "", "failed"}, {"ack-empty", "", "failed"},
	} {
		t.Run(tc.mode+tc.resume, func(t *testing.T) {
			f := newOpenclawGatewayFixture(t, tc.mode)
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			s, err := f.execute(t, ctx, ExecOptions{ResumeSessionID: tc.resume})
			if err != nil {
				t.Fatal(err)
			}
			for range s.Messages {
			}
			r := openCodeACPResult(t, s)
			if r.Status != tc.status || ctx.Err() != nil {
				t.Fatalf("result %+v, context %v", r, ctx.Err())
			}
			if tc.resume != "" && r.SessionID != "agent:writer:old-conversation" {
				t.Fatalf("lost selected agent history: %+v", r)
			}
		})
	}
}

func TestOpenclawGatewayRejectsUnsupportedSettingsBeforeDial(t *testing.T) {
	for _, opts := range []ExecOptions{{Model: "../bad"}, {CustomArgs: []string{"--model", "unavailable"}}, {ExtraArgs: []string{"--anything"}}, {ThinkingLevel: "invalid"}, {McpConfig: json.RawMessage(`{}`)}, {ServiceTier: "priority"}, {OpenclawMode: "local"}} {
		f := newOpenclawGatewayFixture(t, "normal")
		if _, err := f.execute(t, context.Background(), opts); err == nil {
			t.Fatalf("silently accepted unsupported settings %+v", opts)
		}
		f.mu.Lock()
		n := len(f.requests)
		f.mu.Unlock()
		if n != 0 {
			t.Fatal("validation reached Gateway")
		}
	}
}

func TestOpenclawGatewayConfigRejectsAmbiguousCredentials(t *testing.T) {
	for _, config := range []string{
		`{"gateway":{"mode":"remote","remote":{"url":"ws://127.0.0.1:18789","token":"private"}}}`,
		`{"gateway":{"auth":{"mode":"token","token":{"source":"env","id":"KEY"}}}}`,
		`{"gateway":{"auth":{"mode":"token","token":"${KEY}"}}}`,
		`{"gateway":{"auth":{"mode":"password","password":"private"}}}`,
		`{"gateway":{"$include":"other.json","auth":{"mode":"token","token":"private"}}}`,
		`{gateway:{auth:{token:'private'}}}`,
	} {
		dir := t.TempDir()
		path := filepath.Join(dir, "openclaw.json")
		if err := os.WriteFile(path, []byte(config), 0600); err != nil {
			t.Fatal(err)
		}
		b := &openclawBackend{cfg: Config{Env: map[string]string{"OPENCLAW_CONFIG_PATH": path, "OPENCLAW_GATEWAY_TOKEN": "fallback-token", "OPENCLAW_GATEWAY_URL": "", "OPENCLAW_PROFILE": ""}}}
		_, err := b.gatewayConfig()
		if err == nil || strings.Contains(err.Error(), "private") || strings.Contains(err.Error(), "fallback-token") {
			t.Fatalf("unsupported config accepted or leaked: %v", err)
		}
	}
}

func TestOpenclawGatewayFinalUsage(t *testing.T) {
	f := newOpenclawGatewayFixture(t, "usage")
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	s, err := f.execute(t, ctx, ExecOptions{})
	if err != nil {
		t.Fatal(err)
	}
	for range s.Messages {
	}
	r := openCodeACPResult(t, s)
	if r.Status != "completed" || r.Usage["test-model"] != (TokenUsage{InputTokens: 11, OutputTokens: 7, CacheReadTokens: 3}) {
		t.Fatalf("lost provider usage: %+v", r)
	}
}

func TestOpenclawGatewayCancellationReleasesBackpressure(t *testing.T) {
	f := newOpenclawGatewayFixture(t, "many")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s, err := f.execute(t, ctx, ExecOptions{})
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for len(s.Messages) < cap(s.Messages) {
		if time.Now().After(deadline) {
			t.Fatal("stream did not fill")
		}
		time.Sleep(time.Millisecond)
	}
	cancel()
	r := openCodeACPResult(t, s)
	if r.Status != "aborted" || r.Output == "" || r.CancelUnconfirmed {
		t.Fatalf("backpressure blocked cancellation: %+v", r)
	}
	for range s.Messages {
	}
}

func TestOpenclawGatewayLegacyHelper(t *testing.T) {
	if os.Getenv("TEST_OPENCLAW_LEGACY") != "1" {
		return
	}
	if slices.Contains(os.Args, "--version") {
		fmt.Println("2026.9.2")
	} else {
		fmt.Println(`{"payloads":[{"text":"legacy output"}],"meta":{"agentMeta":{"sessionId":"legacy-session"}}}`)
	}
	os.Exit(0)
}

func TestOpenclawGatewayOptInKeepsLegacyCLI(t *testing.T) {
	// The historical version probe inherits the process environment, whereas
	// execution additionally receives Config.Env.
	t.Setenv("TEST_OPENCLAW_LEGACY", "1")
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	b, err := New("openclaw", Config{ExecutablePath: exe, LaunchPrefix: []string{"-test.run=^TestOpenclawGatewayLegacyHelper$", "--"}, Env: map[string]string{"TEST_OPENCLAW_LEGACY": "1"}, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	s, err := b.Execute(ctx, "legacy", ExecOptions{})
	if err != nil {
		t.Fatal(err)
	}
	for range s.Messages {
	}
	r := openCodeACPResult(t, s)
	if r.Status != "completed" || r.Output != "legacy output" || r.SessionID != "legacy-session" {
		t.Fatalf("legacy behavior changed: %+v", r)
	}
}
