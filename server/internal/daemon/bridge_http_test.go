package daemon

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/pkg/agent"
)

const bridgeHTTPTestSecret = "test-bridge-secret"

func newBridgeHTTPPhase1Handler(t *testing.T, deps bridgeHTTPDeps) http.Handler {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	return newBridgeHTTPHandler(ctx, cancel, BridgeHTTPConfig{
		Secret:                bridgeHTTPTestSecret,
		InstallID:             "install-sentinel",
		Version:               "0.1.0-beta.1",
		ProviderPathOverrides: map[string]string{"opencode": "provider-path-sentinel"},
		PID:                   4321,
		InstanceID:            "br_0123456789abcdef0123456789abcdef",
		StartedAt:             time.Date(2026, 8, 26, 8, 0, 0, 123, time.UTC),
	}, deps)
}

func bridgeHTTPRequest(method, target, remoteAddr, bearer string, body []byte) *http.Request {
	req := httptest.NewRequest(method, target, bytes.NewReader(body))
	req.RemoteAddr = remoteAddr
	if bearer != "" {
		req.Header.Set("Authorization", bearer)
	}
	return req
}

func bridgeHTTPDo(handler http.Handler, req *http.Request) *httptest.ResponseRecorder {
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)
	return recorder
}

func bridgeHTTPAuthorizedRequest(method, target string, body []byte) *http.Request {
	return bridgeHTTPRequest(method, target, "127.0.0.42:49152", "Bearer "+bridgeHTTPTestSecret, body)
}

func TestBridgeHTTPTrustBoundaryPrecedesRoutingAndBearer(t *testing.T) {
	handler := newBridgeHTTPPhase1Handler(t, bridgeHTTPDeps{})

	tests := []struct {
		name       string
		remoteAddr string
		bearer     string
		wantStatus int
		wantBody   string
	}{
		{"non-loopback beats bad bearer", "192.0.2.1:1234", "Bearer wrong", http.StatusForbidden, "{\"error\":\"loopback_required\"}\n"},
		{"malformed remote is forbidden", "127.0.0.1", "Bearer " + bridgeHTTPTestSecret, http.StatusForbidden, "{\"error\":\"loopback_required\"}\n"},
		{"loopback bad bearer is unauthorized", "127.0.0.1:1234", "Bearer wrong", http.StatusUnauthorized, "{\"error\":\"unauthorized\"}\n"},
		{"ipv6 loopback is accepted", "[::1]:1234", "Bearer " + bridgeHTTPTestSecret, http.StatusNotFound, "{\"error\":\"not_found\"}\n"},
		{"authenticated unknown route is hidden", "127.0.0.1:1234", "Bearer " + bridgeHTTPTestSecret, http.StatusNotFound, "{\"error\":\"not_found\"}\n"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			recorder := bridgeHTTPDo(handler, bridgeHTTPRequest(http.MethodGet, "/unknown", tt.remoteAddr, tt.bearer, nil))
			if recorder.Code != tt.wantStatus || recorder.Body.String() != tt.wantBody {
				t.Fatalf("response = %d %q, want %d %q", recorder.Code, recorder.Body.String(), tt.wantStatus, tt.wantBody)
			}
			if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
				t.Fatalf("Cache-Control = %q, want no-store", got)
			}
			if got := recorder.Header().Get("Access-Control-Allow-Origin"); got != "" {
				t.Fatalf("unexpected CORS header %q", got)
			}
		})
	}

	req := bridgeHTTPRequest(http.MethodGet, "/unknown", "127.0.0.1:1234", "", nil)
	req.Header.Add("Authorization", "Bearer "+bridgeHTTPTestSecret)
	req.Header.Add("Authorization", "Bearer "+bridgeHTTPTestSecret)
	recorder := bridgeHTTPDo(handler, req)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("duplicate Authorization status = %d, want 401", recorder.Code)
	}
}

func TestBridgeHTTPAuthorizationUsesFixedLengthDigests(t *testing.T) {
	short := bridgeAuthorizationDigest("x")
	long := bridgeAuthorizationDigest(strings.Repeat("x", 4096))
	if len(short) != sha256.Size || len(long) != sha256.Size {
		t.Fatalf("digest lengths = %d, %d; want %d", len(short), len(long), sha256.Size)
	}
	if short == long {
		t.Fatal("different authorization values produced identical digest")
	}
}

func TestBridgeHTTPKnownRouteMethodsAndHeaders(t *testing.T) {
	handler := newBridgeHTTPPhase1Handler(t, bridgeHTTPDeps{})
	tests := []struct {
		path string
		want string
	}{
		{"/v1/runtimes", http.MethodGet},
		{"/v1/runtimes/refresh", http.MethodPost},
		{"/v1/tasks", http.MethodPost},
		{"/healthz", http.MethodGet},
	}
	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			wrong := http.MethodPost
			if tt.want == http.MethodPost {
				wrong = http.MethodGet
			}
			recorder := bridgeHTTPDo(handler, bridgeHTTPAuthorizedRequest(wrong, tt.path, nil))
			if recorder.Code != http.StatusMethodNotAllowed {
				t.Fatalf("status = %d, want 405", recorder.Code)
			}
			if got := recorder.Header().Get("Allow"); got != tt.want {
				t.Fatalf("Allow = %q, want %q", got, tt.want)
			}
			if got := recorder.Body.String(); got != "{\"error\":\"method_not_allowed\"}\n" {
				t.Fatalf("body = %q", got)
			}
			if got := recorder.Header().Get("Content-Type"); got != "application/json; charset=utf-8" {
				t.Fatalf("Content-Type = %q", got)
			}
		})
	}
}

func TestBridgeHTTPHealthHasExactSchemaAndRedactsSensitiveValues(t *testing.T) {
	handler := newBridgeHTTPPhase1Handler(t, bridgeHTTPDeps{})
	recorder := bridgeHTTPDo(handler, bridgeHTTPAuthorizedRequest(http.MethodGet, "/healthz", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var got map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	wantKeys := []string{"instance_id", "pid", "probe_status", "started_at", "status", "version"}
	gotKeys := make([]string, 0, len(got))
	for key := range got {
		gotKeys = append(gotKeys, key)
	}
	slicesSort(gotKeys)
	if !reflect.DeepEqual(gotKeys, wantKeys) {
		t.Fatalf("health keys = %v, want %v", gotKeys, wantKeys)
	}
	if got["status"] != "ok" || got["probe_status"] != "ready" || got["version"] != "0.1.0-beta.1" || got["pid"] != float64(4321) {
		t.Fatalf("unexpected health payload: %#v", got)
	}
	body := recorder.Body.String()
	for _, sentinel := range []string{bridgeHTTPTestSecret, "install-sentinel", "provider-path-sentinel", "prompt-sentinel", "environment-sentinel"} {
		if strings.Contains(body, sentinel) {
			t.Fatalf("health leaked %q: %s", sentinel, body)
		}
	}
}

func TestBridgeHTTPRuntimesReturnsDirectSnapshotWithoutRefresh(t *testing.T) {
	refreshCalls := 0
	want := []BridgeRuntime{{ID: "rt_one", Provider: "opencode", Version: "1.2.3", Path: "provider-path-sentinel", Status: BridgeRuntimeReady}}
	handler := newBridgeHTTPPhase1Handler(t, bridgeHTTPDeps{
		runtimes: func() []BridgeRuntime { return want },
		refresh: func(context.Context) []BridgeRuntime {
			refreshCalls++
			return nil
		},
	})
	recorder := bridgeHTTPDo(handler, bridgeHTTPAuthorizedRequest(http.MethodGet, "/v1/runtimes", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var got []BridgeRuntime
	if err := json.Unmarshal(recorder.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("runtimes = %#v, want %#v", got, want)
	}
	if refreshCalls != 0 {
		t.Fatalf("GET triggered %d refresh calls", refreshCalls)
	}
}

func TestBridgeHTTPRefreshUsesLongLivedRootAndReportsRefreshing(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	var refreshCtx context.Context
	want := []BridgeRuntime{{ID: "rt_recovered", Provider: "codex", Status: BridgeRuntimeReady}}
	handler := newBridgeHTTPPhase1Handler(t, bridgeHTTPDeps{
		refresh: func(ctx context.Context) []BridgeRuntime {
			refreshCtx = ctx
			once.Do(func() { close(entered) })
			<-release
			return want
		},
	})
	requestCtx, cancelRequest := context.WithCancel(context.Background())
	request := bridgeHTTPAuthorizedRequest(http.MethodPost, "/v1/runtimes/refresh", nil).WithContext(requestCtx)
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- bridgeHTTPDo(handler, request) }()
	<-entered
	cancelRequest()

	health := bridgeHTTPDo(handler, bridgeHTTPAuthorizedRequest(http.MethodGet, "/healthz", nil))
	if !strings.Contains(health.Body.String(), `"probe_status":"refreshing"`) {
		t.Fatalf("health during refresh = %s", health.Body.String())
	}
	select {
	case <-refreshCtx.Done():
		t.Fatal("request cancellation propagated to long-lived refresh root")
	default:
	}
	close(release)
	recorder := <-done
	if recorder.Code != http.StatusOK {
		t.Fatalf("refresh status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var got []BridgeRuntime
	if err := json.Unmarshal(recorder.Body.Bytes(), &got); err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("refresh result = %#v, err = %v", got, err)
	}
	health = bridgeHTTPDo(handler, bridgeHTTPAuthorizedRequest(http.MethodGet, "/healthz", nil))
	if !strings.Contains(health.Body.String(), `"probe_status":"ready"`) {
		t.Fatalf("health after refresh = %s", health.Body.String())
	}

	recorder = bridgeHTTPDo(handler, bridgeHTTPAuthorizedRequest(http.MethodPost, "/v1/runtimes/refresh", []byte(" ")))
	if recorder.Code != http.StatusBadRequest || recorder.Body.String() != "{\"error\":\"invalid_request\"}\n" {
		t.Fatalf("whitespace refresh body = %d %q", recorder.Code, recorder.Body.String())
	}
}

func TestBridgeHTTPRefreshIsExplicitNeedsAuthRecovery(t *testing.T) {
	path := `C:\tools\codex.exe`
	bridge := newBridge("install", map[string]string{"codex": path}, bridgeDeps{
		probeAgentCLIs: func() map[string]AgentEntry { return map[string]AgentEntry{} },
		resolveAgentExecutablePath: func(candidate string) (string, error) {
			if candidate == path {
				return candidate, nil
			}
			return "", errors.New("not found")
		},
		canonicalExecutablePath: func(candidate string) string { return strings.ToLower(candidate) },
		executablePresent:       func(string) bool { return true },
		detectVersion: func(context.Context, agent.Command) (string, error) {
			return "1.2.3", nil
		},
		checkMinVersion: func(string, string) error { return nil },
		probeTimeout:    time.Second,
		maxConcurrent:   1,
	})
	bridge.Refresh(context.Background())
	var runtimeID string
	for _, runtime := range bridge.Runtimes() {
		if runtime.Provider == "codex" {
			runtimeID = runtime.ID
		}
	}
	bridge.markBridgeRuntimeNeedsAuth(runtimeID)
	if got, _ := bridge.bridgeRuntimeByID(runtimeID); got.Status != BridgeRuntimeNeedsAuth {
		t.Fatalf("precondition status = %q", got.Status)
	}
	handler := newBridgeHTTPPhase1Handler(t, bridgeHTTPDeps{runtimes: bridge.Runtimes, refresh: bridge.Refresh})
	recorder := bridgeHTTPDo(handler, bridgeHTTPAuthorizedRequest(http.MethodPost, "/v1/runtimes/refresh", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("refresh response = %d %s", recorder.Code, recorder.Body.String())
	}
	got, ok := bridge.bridgeRuntimeByID(runtimeID)
	if !ok || got.Status != BridgeRuntimeReady || got.Version != "1.2.3" {
		t.Fatalf("recovered runtime = %#v, found=%v", got, ok)
	}
}

func TestBridgeHTTPTaskContentTypeSizeStrictJSONAndSuccess(t *testing.T) {
	var started BridgeTaskRequest
	handler := newBridgeHTTPPhase1Handler(t, bridgeHTTPDeps{
		start: func(req BridgeTaskRequest) (string, error) {
			started = req
			return "task_123", nil
		},
	})
	valid := BridgeTaskRequest{RuntimeID: "rt_one", ConversationKey: "conversation", WorkDir: `C:\work`, Prompt: "hello"}
	validJSON, err := json.Marshal(valid)
	if err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name        string
		contentType string
		body        []byte
		wantStatus  int
		wantBody    string
	}{
		{"missing media type", "", validJSON, http.StatusUnsupportedMediaType, "{\"error\":\"unsupported_media_type\"}\n"},
		{"wrong media type", "text/plain", validJSON, http.StatusUnsupportedMediaType, "{\"error\":\"unsupported_media_type\"}\n"},
		{"malformed media type", "application/json; broken", validJSON, http.StatusUnsupportedMediaType, "{\"error\":\"unsupported_media_type\"}\n"},
		{"empty JSON", "application/json", nil, http.StatusBadRequest, "{\"error\":\"invalid_request\"}\n"},
		{"unknown field", "application/json", []byte(`{"runtime_id":"x","conversation_key":"c","workdir":"C:\\work","prompt":"p","extra":true}`), http.StatusBadRequest, "{\"error\":\"invalid_request\"}\n"},
		{"trailing value", "application/json", append(append([]byte{}, validJSON...), []byte(` {}`)...), http.StatusBadRequest, "{\"error\":\"invalid_request\"}\n"},
		{"valid charset", "application/json; charset=utf-8", validJSON, http.StatusCreated, "{\"task_id\":\"task_123\",\"events_url\":\"/v1/tasks/task_123/events\"}\n"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := bridgeHTTPAuthorizedRequest(http.MethodPost, "/v1/tasks", tt.body)
			if tt.contentType != "" {
				req.Header.Set("Content-Type", tt.contentType)
			}
			recorder := bridgeHTTPDo(handler, req)
			if recorder.Code != tt.wantStatus || recorder.Body.String() != tt.wantBody {
				t.Fatalf("response = %d %q, want %d %q", recorder.Code, recorder.Body.String(), tt.wantStatus, tt.wantBody)
			}
		})
	}
	if !reflect.DeepEqual(started, valid) {
		t.Fatalf("started request = %#v, want %#v", started, valid)
	}

	exact := bridgeHTTPTaskBodyOfSize(t, 1<<20)
	req := bridgeHTTPAuthorizedRequest(http.MethodPost, "/v1/tasks", exact)
	req.Header.Set("Content-Type", "application/json")
	recorder := bridgeHTTPDo(handler, req)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("exact 1 MiB status = %d, body = %s", recorder.Code, recorder.Body.String())
	}

	tooLarge := append(append([]byte{}, exact...), ' ')
	req = bridgeHTTPAuthorizedRequest(http.MethodPost, "/v1/tasks", tooLarge)
	req.Header.Set("Content-Type", "application/json")
	recorder = bridgeHTTPDo(handler, req)
	if recorder.Code != http.StatusRequestEntityTooLarge || recorder.Body.String() != "{\"error\":\"payload_too_large\"}\n" {
		t.Fatalf("1 MiB + 1 response = %d %q", recorder.Code, recorder.Body.String())
	}
}

func TestBridgeHTTPTaskErrorMapping(t *testing.T) {
	tests := []struct {
		err        error
		wantStatus int
		wantBody   string
	}{
		{ErrBridgeTaskInvalidRequest, http.StatusBadRequest, "{\"error\":\"invalid_request\"}\n"},
		{ErrBridgeTaskInvalidWorkDir, http.StatusBadRequest, "{\"error\":\"invalid_workdir\"}\n"},
		{ErrBridgeTaskUnknownRuntime, http.StatusNotFound, "{\"error\":\"runtime_not_found\"}\n"},
		{ErrBridgeTaskRuntimeNotReady, http.StatusConflict, "{\"error\":\"runtime_not_ready\"}\n"},
		{errors.New("sentinel internal detail"), http.StatusInternalServerError, "{\"error\":\"internal_error\"}\n"},
	}
	valid := []byte(`{"runtime_id":"rt","conversation_key":"c","workdir":"C:\\work","prompt":"p"}`)
	for _, tt := range tests {
		handler := newBridgeHTTPPhase1Handler(t, bridgeHTTPDeps{start: func(BridgeTaskRequest) (string, error) { return "", tt.err }})
		req := bridgeHTTPAuthorizedRequest(http.MethodPost, "/v1/tasks", valid)
		req.Header.Set("Content-Type", "application/json")
		recorder := bridgeHTTPDo(handler, req)
		if recorder.Code != tt.wantStatus || recorder.Body.String() != tt.wantBody {
			t.Fatalf("error %v response = %d %q, want %d %q", tt.err, recorder.Code, recorder.Body.String(), tt.wantStatus, tt.wantBody)
		}
		if strings.Contains(recorder.Body.String(), "sentinel") {
			t.Fatal("raw Go error leaked in response")
		}
	}
}

func bridgeHTTPTaskBodyOfSize(t *testing.T, size int) []byte {
	t.Helper()
	base := BridgeTaskRequest{RuntimeID: "rt", ConversationKey: "c", WorkDir: `C:\work`}
	baseJSON, err := json.Marshal(base)
	if err != nil {
		t.Fatal(err)
	}
	// The empty prompt is encoded as two quotes. Replacing it with ASCII keeps
	// the JSON size increase equal to the prompt length.
	baseSize := len(baseJSON)
	base.Prompt = strings.Repeat("p", size-baseSize)
	body, err := json.Marshal(base)
	if err != nil {
		t.Fatal(err)
	}
	if len(body) != size {
		t.Fatalf("task body size = %d, want %d", len(body), size)
	}
	return body
}

func slicesSort(values []string) {
	for i := 1; i < len(values); i++ {
		for j := i; j > 0 && values[j] < values[j-1]; j-- {
			values[j], values[j-1] = values[j-1], values[j]
		}
	}
}

type bridgeHTTPFlushRecorder struct {
	*httptest.ResponseRecorder
	mu        sync.Mutex
	flushes   int
	firstBody string
	flushed   chan struct{}
	onFlush   func()
}

func newBridgeHTTPFlushRecorder() *bridgeHTTPFlushRecorder {
	return &bridgeHTTPFlushRecorder{ResponseRecorder: httptest.NewRecorder(), flushed: make(chan struct{})}
}

func (r *bridgeHTTPFlushRecorder) Flush() {
	r.mu.Lock()
	r.flushes++
	if r.flushes == 1 {
		r.firstBody = r.Body.String()
		close(r.flushed)
	}
	onFlush := r.onFlush
	r.mu.Unlock()
	r.ResponseRecorder.Flush()
	if onFlush != nil {
		onFlush()
	}
}

func (r *bridgeHTTPFlushRecorder) flushCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.flushes
}

func TestBridgeHTTPEventCursorErrorsPrecedeSSEHeaders(t *testing.T) {
	handler := newBridgeHTTPPhase1Handler(t, bridgeHTTPDeps{
		subscribe: func(_ context.Context, taskID string, afterID uint64) (<-chan BridgeTaskEvent, error) {
			if taskID == "missing" {
				return nil, ErrBridgeTaskUnknown
			}
			if afterID > 3 {
				return nil, ErrBridgeTaskFutureCursor
			}
			ch := make(chan BridgeTaskEvent)
			close(ch)
			return ch, nil
		},
	})

	invalid := []string{"", "+1", "-1", " 1", "1 ", "1,2", "18446744073709551616"}
	for _, value := range invalid {
		req := bridgeHTTPAuthorizedRequest(http.MethodGet, "/v1/tasks/task/events", nil)
		req.Header["Last-Event-Id"] = []string{value}
		recorder := bridgeHTTPDo(handler, req)
		if recorder.Code != http.StatusBadRequest || recorder.Body.String() != "{\"error\":\"invalid_last_event_id\"}\n" {
			t.Fatalf("Last-Event-ID %q response = %d %q", value, recorder.Code, recorder.Body.String())
		}
	}
	req := bridgeHTTPAuthorizedRequest(http.MethodGet, "/v1/tasks/task/events", nil)
	req.Header["Last-Event-Id"] = []string{"1", "2"}
	recorder := bridgeHTTPDo(handler, req)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("duplicate Last-Event-ID status = %d", recorder.Code)
	}

	tests := []struct {
		path       string
		cursor     string
		wantStatus int
		wantBody   string
	}{
		{"/v1/tasks/missing/events", "", http.StatusNotFound, "{\"error\":\"task_not_found\"}\n"},
		{"/v1/tasks/task/events", "4", http.StatusConflict, "{\"error\":\"future_cursor\"}\n"},
	}
	for _, tt := range tests {
		req := bridgeHTTPAuthorizedRequest(http.MethodGet, tt.path, nil)
		if tt.cursor != "" {
			req.Header.Set("Last-Event-ID", tt.cursor)
		}
		recorder := bridgeHTTPDo(handler, req)
		if recorder.Code != tt.wantStatus || recorder.Body.String() != tt.wantBody {
			t.Fatalf("%s response = %d %q, want %d %q", tt.path, recorder.Code, recorder.Body.String(), tt.wantStatus, tt.wantBody)
		}
		if got := recorder.Header().Get("Content-Type"); got == "text/event-stream" {
			t.Fatalf("%s committed SSE headers before subscribe error", tt.path)
		}
	}
}

func TestBridgeHTTPSSEFlushesHeadersAndEveryEvent(t *testing.T) {
	events := make(chan BridgeTaskEvent, 2)
	handler := newBridgeHTTPPhase1Handler(t, bridgeHTTPDeps{
		subscribe: func(context.Context, string, uint64) (<-chan BridgeTaskEvent, error) { return events, nil },
	})
	req := bridgeHTTPAuthorizedRequest(http.MethodGet, "/v1/tasks/task_123/events", nil)
	recorder := newBridgeHTTPFlushRecorder()
	done := make(chan struct{})
	go func() {
		handler.ServeHTTP(recorder, req)
		close(done)
	}()
	select {
	case <-recorder.flushed:
	case <-time.After(time.Second):
		t.Fatal("SSE headers were not flushed immediately")
	}
	if recorder.firstBody != "" {
		t.Fatalf("body before first event = %q", recorder.firstBody)
	}
	if recorder.Code != http.StatusOK || recorder.Header().Get("Content-Type") != "text/event-stream" {
		t.Fatalf("SSE response = %d %q", recorder.Code, recorder.Header().Get("Content-Type"))
	}

	eventTime := time.Date(2026, 8, 26, 8, 0, 1, 0, time.UTC)
	events <- BridgeTaskEvent{ID: 7, Type: BridgeEventTextDelta, TaskID: "task_123", Time: eventTime, Text: "hello"}
	events <- BridgeTaskEvent{ID: 8, Type: BridgeEventCompleted, TaskID: "task_123", Time: eventTime.Add(time.Second), SessionID: "session-new", Output: "done", Status: BridgeTaskStatusResumeInvalidated}
	close(events)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("SSE handler did not end after terminal replay EOF")
	}
	want := "id: 7\nevent: text_delta\ndata: {\"id\":7,\"type\":\"text_delta\",\"task_id\":\"task_123\",\"time\":\"2026-08-26T08:00:01Z\",\"text\":\"hello\"}\n\n" +
		"id: 8\nevent: completed\ndata: {\"id\":8,\"type\":\"completed\",\"task_id\":\"task_123\",\"time\":\"2026-08-26T08:00:02Z\",\"session_id\":\"session-new\",\"output\":\"done\",\"status\":\"resume_invalidated\"}\n\n"
	if got := recorder.Body.String(); got != want {
		t.Fatalf("SSE frames = %q, want %q", got, want)
	}
	if got := recorder.flushCount(); got != 3 {
		t.Fatalf("flush count = %d, want header + 2 events", got)
	}
}

func TestBridgeHTTPReplayOverflowIsTransportedAsOrdinaryEvent(t *testing.T) {
	now := time.Date(2026, 8, 26, 8, 0, 0, 0, time.UTC)
	task := &bridgeTask{
		id:          "task_overflow",
		cancel:      func() {},
		now:         func() time.Time { return now },
		eventLimit:  2,
		nextEventID: 5,
		events: []BridgeTaskEvent{
			{ID: 4, Type: BridgeEventTextDelta, TaskID: "task_overflow", Time: now, Text: "retained"},
			{ID: 5, Type: BridgeEventCompleted, TaskID: "task_overflow", Time: now, Output: "done"},
		},
		subscribers: make(map[chan BridgeTaskEvent]chan struct{}),
		terminal:    true,
		terminalAt:  now,
	}
	manager := newBridgeTaskManager(context.Background(), bridgeTaskDeps{now: func() time.Time { return now }})
	manager.tasks[task.id] = task
	handler := newBridgeHTTPPhase1Handler(t, bridgeHTTPDeps{subscribe: manager.Subscribe})
	req := bridgeHTTPAuthorizedRequest(http.MethodGet, "/v1/tasks/task_overflow/events", nil)
	req.Header.Set("Last-Event-ID", "1")
	recorder := bridgeHTTPDo(handler, req)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), `"status":"replay_overflow"`) || !strings.Contains(recorder.Body.String(), "event: completed") {
		t.Fatalf("overflow replay was not transported intact: %s", recorder.Body.String())
	}
}

func TestBridgeHTTPSSEDisconnectCancelsOnlySubscriber(t *testing.T) {
	now := time.Date(2026, 8, 26, 8, 0, 0, 0, time.UTC)
	task := &bridgeTask{
		id:          "task_live",
		cancel:      func() {},
		now:         func() time.Time { return now },
		eventLimit:  8,
		subscribers: make(map[chan BridgeTaskEvent]chan struct{}),
	}
	manager := newBridgeTaskManager(context.Background(), bridgeTaskDeps{now: func() time.Time { return now }})
	manager.tasks[task.id] = task
	handler := newBridgeHTTPPhase1Handler(t, bridgeHTTPDeps{subscribe: manager.Subscribe})
	ctx, cancel := context.WithCancel(context.Background())
	req := bridgeHTTPAuthorizedRequest(http.MethodGet, "/v1/tasks/task_live/events", nil).WithContext(ctx)
	recorder := newBridgeHTTPFlushRecorder()
	done := make(chan struct{})
	go func() {
		handler.ServeHTTP(recorder, req)
		close(done)
	}()
	select {
	case <-recorder.flushed:
	case <-time.After(time.Second):
		t.Fatal("SSE headers were not flushed")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("disconnected SSE handler did not return")
	}

	task.publish(BridgeTaskEvent{Type: BridgeEventCompleted, Output: "continued"})
	replay, err := manager.Subscribe(context.Background(), task.id, 0)
	if err != nil {
		t.Fatal(err)
	}
	event, ok := <-replay
	if !ok || event.Type != BridgeEventCompleted || event.Output != "continued" {
		t.Fatalf("task did not continue after subscriber disconnect: %#v, open=%v", event, ok)
	}
}

func TestBridgeHTTPCancelAndShutdownRequireEmptyBodies(t *testing.T) {
	cancelledTask := make(chan struct{}, 1)
	handler := newBridgeHTTPPhase1Handler(t, bridgeHTTPDeps{
		cancelTask: func(id string) error {
			if id == "missing" {
				return ErrBridgeTaskUnknown
			}
			cancelledTask <- struct{}{}
			return nil
		},
	})
	for _, path := range []string{"/v1/tasks/task_123/cancel", "/shutdown"} {
		recorder := bridgeHTTPDo(handler, bridgeHTTPAuthorizedRequest(http.MethodPost, path, []byte(" ")))
		if recorder.Code != http.StatusBadRequest || recorder.Body.String() != "{\"error\":\"invalid_request\"}\n" {
			t.Fatalf("whitespace %s response = %d %q", path, recorder.Code, recorder.Body.String())
		}
	}

	recorder := bridgeHTTPDo(handler, bridgeHTTPAuthorizedRequest(http.MethodPost, "/v1/tasks/task_123/cancel", nil))
	if recorder.Code != http.StatusAccepted || recorder.Body.Len() != 0 {
		t.Fatalf("cancel response = %d %q", recorder.Code, recorder.Body.String())
	}
	select {
	case <-cancelledTask:
	default:
		t.Fatal("cancel route did not invoke Task 4 manager")
	}
	recorder = bridgeHTTPDo(handler, bridgeHTTPAuthorizedRequest(http.MethodPost, "/v1/tasks/missing/cancel", nil))
	if recorder.Code != http.StatusNotFound || recorder.Body.String() != "{\"error\":\"task_not_found\"}\n" {
		t.Fatalf("unknown cancel response = %d %q", recorder.Code, recorder.Body.String())
	}
}

func TestBridgeHTTPShutdownFlushesBeforeRootCancellation(t *testing.T) {
	root, baseCancel := context.WithCancel(context.Background())
	defer baseCancel()
	recorder := newBridgeHTTPFlushRecorder()
	cancelObserved := make(chan bool, 1)
	cancelRoot := func() {
		cancelObserved <- recorder.flushCount() > 0 && recorder.Code == http.StatusAccepted
		baseCancel()
	}
	handler := newBridgeHTTPHandler(root, cancelRoot, BridgeHTTPConfig{Secret: bridgeHTTPTestSecret}, bridgeHTTPDeps{})
	handler.ServeHTTP(recorder, bridgeHTTPAuthorizedRequest(http.MethodPost, "/shutdown", nil))
	select {
	case flushedFirst := <-cancelObserved:
		if !flushedFirst {
			t.Fatal("root cancellation ran before 202 was flushed")
		}
	case <-time.After(time.Second):
		t.Fatal("shutdown did not cancel Bridge root")
	}
}

func TestBridgeHTTPDynamicRouteMethods(t *testing.T) {
	handler := newBridgeHTTPPhase1Handler(t, bridgeHTTPDeps{})
	for _, tt := range []struct {
		path string
		want string
	}{
		{"/v1/tasks/task/events", http.MethodGet},
		{"/v1/tasks/task/cancel", http.MethodPost},
		{"/shutdown", http.MethodPost},
	} {
		wrong := http.MethodGet
		if tt.want == http.MethodGet {
			wrong = http.MethodPost
		}
		recorder := bridgeHTTPDo(handler, bridgeHTTPAuthorizedRequest(wrong, tt.path, nil))
		if recorder.Code != http.StatusMethodNotAllowed || recorder.Header().Get("Allow") != tt.want {
			t.Fatalf("%s wrong method response = %d Allow=%q", tt.path, recorder.Code, recorder.Header().Get("Allow"))
		}
	}
}

type bridgeHTTPFakeTicker struct {
	c       chan time.Time
	stopped chan struct{}
}

func (t *bridgeHTTPFakeTicker) C() <-chan time.Time { return t.c }
func (t *bridgeHTTPFakeTicker) Stop()               { close(t.stopped) }

func TestBridgeHTTPHeartbeatUsesInjectedFifteenSecondTicker(t *testing.T) {
	ticker := &bridgeHTTPFakeTicker{c: make(chan time.Time, 1), stopped: make(chan struct{})}
	var interval time.Duration
	events := make(chan BridgeTaskEvent)
	handler := newBridgeHTTPPhase1Handler(t, bridgeHTTPDeps{
		subscribe: func(context.Context, string, uint64) (<-chan BridgeTaskEvent, error) { return events, nil },
		newTicker: func(got time.Duration) bridgeHTTPTicker {
			interval = got
			return ticker
		},
	})
	ctx, cancel := context.WithCancel(context.Background())
	req := bridgeHTTPAuthorizedRequest(http.MethodGet, "/v1/tasks/task/events", nil).WithContext(ctx)
	recorder := newBridgeHTTPFlushRecorder()
	heartbeatFlushed := make(chan struct{}, 1)
	recorder.onFlush = func() {
		if recorder.flushCount() >= 2 {
			select {
			case heartbeatFlushed <- struct{}{}:
			default:
			}
		}
	}
	done := make(chan struct{})
	go func() {
		handler.ServeHTTP(recorder, req)
		close(done)
	}()
	<-recorder.flushed
	if interval != 15*time.Second {
		t.Fatalf("ticker interval = %s, want 15s", interval)
	}
	ticker.c <- time.Now()
	select {
	case <-heartbeatFlushed:
	case <-time.After(time.Second):
		t.Fatal("heartbeat was not flushed")
	}
	if got := recorder.Body.String(); got != ": heartbeat\n\n" {
		t.Fatalf("heartbeat = %q", got)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("SSE handler did not stop on disconnect")
	}
	select {
	case <-ticker.stopped:
	default:
		t.Fatal("heartbeat ticker was not stopped")
	}
}

func TestBridgeHTTPHeartbeatIntervalRestartsAfterEveryEvent(t *testing.T) {
	created := make(chan *bridgeHTTPFakeTicker, 2)
	events := make(chan BridgeTaskEvent, 1)
	handler := newBridgeHTTPPhase1Handler(t, bridgeHTTPDeps{
		subscribe: func(context.Context, string, uint64) (<-chan BridgeTaskEvent, error) { return events, nil },
		newTicker: func(time.Duration) bridgeHTTPTicker {
			ticker := &bridgeHTTPFakeTicker{c: make(chan time.Time, 1), stopped: make(chan struct{})}
			created <- ticker
			return ticker
		},
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	recorder := newBridgeHTTPFlushRecorder()
	eventFlushed := make(chan struct{}, 1)
	recorder.onFlush = func() {
		if recorder.flushCount() >= 2 {
			select {
			case eventFlushed <- struct{}{}:
			default:
			}
		}
	}
	done := make(chan struct{})
	go func() {
		handler.ServeHTTP(recorder, bridgeHTTPAuthorizedRequest(http.MethodGet, "/v1/tasks/task/events", nil).WithContext(ctx))
		close(done)
	}()
	<-recorder.flushed
	first := <-created
	events <- BridgeTaskEvent{ID: 1, Type: BridgeEventTextDelta, TaskID: "task", Time: time.Unix(0, 0).UTC(), Text: "event"}
	select {
	case <-eventFlushed:
	case <-time.After(time.Second):
		t.Fatal("event was not flushed")
	}
	var second *bridgeHTTPFakeTicker
	select {
	case second = <-created:
	case <-time.After(time.Second):
		t.Fatal("heartbeat interval was not restarted after an event")
	}
	select {
	case <-first.stopped:
	default:
		t.Fatal("previous heartbeat ticker was not stopped")
	}
	second.c <- time.Now()
	select {
	case <-eventFlushed:
	case <-time.After(time.Second):
		t.Fatal("restarted heartbeat was not flushed")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("SSE handler did not stop")
	}
}

func TestBridgeHTTPServerUsesExactStreamingTimeouts(t *testing.T) {
	server := newBridgeHTTPServer(http.NotFoundHandler())
	if server.ReadHeaderTimeout != 5*time.Second || server.ReadTimeout != 10*time.Second || server.WriteTimeout != 0 || server.IdleTimeout != 60*time.Second || server.MaxHeaderBytes != 16<<10 {
		t.Fatalf("server limits = header %s read %s write %s idle %s headers %d", server.ReadHeaderTimeout, server.ReadTimeout, server.WriteTimeout, server.IdleTimeout, server.MaxHeaderBytes)
	}
}

func TestBridgeHTTPServeRefreshesBeforeReadinessAndShutsDownWithRoot(t *testing.T) {
	bridge := newBridge("install", nil, bridgeDeps{
		probeAgentCLIs: func() map[string]AgentEntry { return map[string]AgentEntry{} },
		resolveAgentExecutablePath: func(string) (string, error) {
			return "", errors.New("not found")
		},
	})
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ready := make(chan error, 1)
	readyCalls := 0
	cfg := BridgeHTTPConfig{
		Secret:     bridgeHTTPTestSecret,
		InstallID:  "install",
		Version:    "0.1.0-beta.1",
		PID:        4321,
		InstanceID: "br_0123456789abcdef0123456789abcdef",
		StartedAt:  time.Now().UTC(),
		Ready: func() error {
			readyCalls++
			for _, runtime := range bridge.Runtimes() {
				if runtime.Status != BridgeRuntimeNotFound {
					err := fmt.Errorf("readiness preceded initial refresh: %#v", runtime)
					ready <- err
					return err
				}
			}
			ready <- nil
			return nil
		},
	}
	serveDone := make(chan error, 1)
	go func() { serveDone <- serveBridgeHTTPWithBridge(ctx, listener, cfg, bridge) }()
	select {
	case err := <-ready:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("server did not report readiness")
	}
	if readyCalls != 1 {
		t.Fatalf("Ready calls = %d, want 1", readyCalls)
	}
	cancel()
	select {
	case err := <-serveDone:
		if err != nil {
			t.Fatalf("serve returned %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("server did not shut down after root cancellation")
	}
}

type bridgeHTTPCleanupBackend struct {
	started    chan struct{}
	cancelSeen chan struct{}
	release    chan struct{}
}

func (b *bridgeHTTPCleanupBackend) Execute(ctx context.Context, _ string, _ agent.ExecOptions) (*agent.Session, error) {
	messages := make(chan agent.Message)
	close(messages)
	result := make(chan agent.Result, 1)
	close(b.started)
	go func() {
		<-ctx.Done()
		close(b.cancelSeen)
		<-b.release
		result <- agent.Result{Status: "cancelled"}
		close(result)
	}()
	return &agent.Session{Messages: messages, Result: result}, nil
}

func newBridgeHTTPReadyTestBridge() *Bridge {
	path := `C:\tools\codex.exe`
	return newBridge("install", map[string]string{"codex": path}, bridgeDeps{
		probeAgentCLIs: func() map[string]AgentEntry { return map[string]AgentEntry{} },
		resolveAgentExecutablePath: func(candidate string) (string, error) {
			if candidate == path {
				return candidate, nil
			}
			return "", errors.New("not found")
		},
		canonicalExecutablePath: func(candidate string) string { return strings.ToLower(candidate) },
		executablePresent:       func(string) bool { return true },
		detectVersion:           func(context.Context, agent.Command) (string, error) { return "1.2.3", nil },
		checkMinVersion:         func(string, string) error { return nil },
		probeTimeout:            time.Second,
		maxConcurrent:           1,
	})
}

func TestBridgeHTTPServeWaitsForTaskTerminalAfterShutdownWithoutSSE(t *testing.T) {
	bridge := newBridgeHTTPReadyTestBridge()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	backend := &bridgeHTTPCleanupBackend{
		started:    make(chan struct{}),
		cancelSeen: make(chan struct{}),
		release:    make(chan struct{}),
	}
	var manager *bridgeTaskManager
	ready := make(chan string, 1)
	cfg := BridgeHTTPConfig{
		Secret:     bridgeHTTPTestSecret,
		InstallID:  "install",
		Version:    "0.1.0-beta.1",
		PID:        1,
		InstanceID: "br_0123456789abcdef0123456789abcdef",
		StartedAt:  time.Unix(0, 0).UTC(),
		Ready: func() error {
			for _, runtime := range bridge.Runtimes() {
				if runtime.Provider == "codex" {
					ready <- runtime.ID
					return nil
				}
			}
			return errors.New("codex runtime missing")
		},
	}
	serveDone := make(chan error, 1)
	go func() {
		serveDone <- serveBridgeHTTPWithDeps(context.Background(), listener, cfg, bridge, bridgeHTTPServeDeps{
			newTasks: func(root context.Context, bridge *Bridge) *bridgeTaskManager {
				manager = newBridgeTaskManager(root, bridgeTaskDeps{
					resolveBackend:   func(string, agent.Config) (agent.Backend, error) { return backend, nil },
					runtimeByID:      bridge.bridgeRuntimeByID,
					markNeedsAuth:    bridge.markBridgeRuntimeNeedsAuth,
					canonicalWorkDir: canonicalBridgeTaskWorkDir,
				})
				return manager
			},
		})
	}()
	runtimeID := <-ready

	requestBody, err := json.Marshal(BridgeTaskRequest{
		RuntimeID:       runtimeID,
		ConversationKey: "conversation",
		WorkDir:         t.TempDir(),
		Prompt:          "hello",
	})
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodPost, "http://"+listener.Addr().String()+"/v1/tasks", bytes.NewReader(requestBody))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+bridgeHTTPTestSecret)
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("task response status = %d", response.StatusCode)
	}
	<-backend.started

	shutdown, err := http.NewRequest(http.MethodPost, "http://"+listener.Addr().String()+"/shutdown", nil)
	if err != nil {
		t.Fatal(err)
	}
	shutdown.Header.Set("Authorization", "Bearer "+bridgeHTTPTestSecret)
	shutdownResponse, err := http.DefaultClient.Do(shutdown)
	if err != nil {
		t.Fatal(err)
	}
	shutdownResponse.Body.Close()
	if shutdownResponse.StatusCode != http.StatusAccepted {
		t.Fatalf("shutdown response status = %d", shutdownResponse.StatusCode)
	}
	<-backend.cancelSeen
	select {
	case err := <-serveDone:
		t.Fatalf("ServeBridgeHTTP returned before task terminal cleanup: %v", err)
	default:
	}
	close(backend.release)
	select {
	case err := <-serveDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("ServeBridgeHTTP did not return after task became terminal")
	}
	if manager == nil {
		t.Fatal("task manager was not constructed")
	}
}

func TestBridgeHTTPServeTimeoutForceClosesAndJoinsBlockedHandler(t *testing.T) {
	bridge := newBridge("install", nil, bridgeDeps{
		probeAgentCLIs:             func() map[string]AgentEntry { return map[string]AgentEntry{} },
		resolveAgentExecutablePath: func(string) (string, error) { return "", errors.New("not found") },
	})
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ready := make(chan struct{})
	handlerEntered := make(chan struct{})
	handlerExited := make(chan struct{})
	serveDone := make(chan error, 1)
	go func() {
		serveDone <- serveBridgeHTTPWithDeps(ctx, listener, BridgeHTTPConfig{
			Secret: bridgeHTTPTestSecret,
			Ready: func() error {
				close(ready)
				return nil
			},
		}, bridge, bridgeHTTPServeDeps{
			shutdownTimeout: 20 * time.Millisecond,
			wrapHandler: func(next http.Handler) http.Handler {
				return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.URL.Path != "/blocked" {
						next.ServeHTTP(w, r)
						return
					}
					close(handlerEntered)
					<-r.Context().Done()
					close(handlerExited)
				})
			},
		})
	}()
	<-ready
	clientDone := make(chan error, 1)
	go func() {
		request, err := http.NewRequest(http.MethodGet, "http://"+listener.Addr().String()+"/blocked", nil)
		if err != nil {
			clientDone <- err
			return
		}
		_, err = http.DefaultClient.Do(request)
		clientDone <- err
	}()
	<-handlerEntered
	cancel()
	select {
	case <-handlerExited:
	case <-time.After(time.Second):
		t.Fatal("Shutdown timeout did not force-close the blocked connection")
	}
	select {
	case err := <-serveDone:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("ServeBridgeHTTP error = %v, want deadline exceeded", err)
		}
	case <-time.After(time.Second):
		t.Fatal("ServeBridgeHTTP did not join forced-close cleanup")
	}
	select {
	case <-clientDone:
	case <-time.After(time.Second):
		t.Fatal("force-closed client request did not return")
	}
}

func TestBridgeHTTPServeTimeoutDoesNotWaitForHandlerIgnoringRequestCancellation(t *testing.T) {
	bridge := newBridge("install", nil, bridgeDeps{
		probeAgentCLIs:             func() map[string]AgentEntry { return map[string]AgentEntry{} },
		resolveAgentExecutablePath: func(string) (string, error) { return "", errors.New("not found") },
	})
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ready := make(chan struct{})
	handlerEntered := make(chan struct{})
	handlerRelease := make(chan struct{})
	handlerExited := make(chan struct{})
	var releaseOnce sync.Once
	releaseHandler := func() { releaseOnce.Do(func() { close(handlerRelease) }) }
	defer releaseHandler()
	serveDone := make(chan error, 1)
	go func() {
		serveDone <- serveBridgeHTTPWithDeps(ctx, listener, BridgeHTTPConfig{
			Secret: bridgeHTTPTestSecret,
			Ready: func() error {
				close(ready)
				return nil
			},
		}, bridge, bridgeHTTPServeDeps{
			shutdownTimeout: 20 * time.Millisecond,
			wrapHandler: func(next http.Handler) http.Handler {
				return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.URL.Path != "/blocked-ignoring-cancel" {
						next.ServeHTTP(w, r)
						return
					}
					close(handlerEntered)
					<-handlerRelease
					close(handlerExited)
				})
			},
		})
	}()
	<-ready
	clientDone := make(chan error, 1)
	go func() {
		request, err := http.NewRequest(http.MethodGet, "http://"+listener.Addr().String()+"/blocked-ignoring-cancel", nil)
		if err != nil {
			clientDone <- err
			return
		}
		_, err = http.DefaultClient.Do(request)
		clientDone <- err
	}()
	<-handlerEntered
	cancel()
	select {
	case err := <-serveDone:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("ServeBridgeHTTP error = %v, want deadline exceeded", err)
		}
	case <-time.After(250 * time.Millisecond):
		releaseHandler()
		<-serveDone
		t.Fatal("ServeBridgeHTTP waited beyond its lifecycle deadline for a handler that ignored cancellation")
	}
	select {
	case <-handlerExited:
		t.Fatal("test handler exited before its release barrier")
	default:
	}
	select {
	case <-clientDone:
	case <-time.After(time.Second):
		t.Fatal("server.Close did not release the blocked client connection")
	}
	releaseHandler()
	select {
	case <-handlerExited:
	case <-time.After(time.Second):
		t.Fatal("released test handler did not exit")
	}
}

func TestBridgeHTTPHandlerTrackerAbortsBusinessEntriesAfterSeal(t *testing.T) {
	tracker := newBridgeHTTPHandlerTracker()
	businessCalls := 0
	handler := tracker.wrap(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		businessCalls++
	}))
	tracker.seal()
	waitCtx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := tracker.wait(waitCtx); err != nil {
		t.Fatalf("sealed empty tracker wait error = %v", err)
	}
	var recovered any
	func() {
		defer func() { recovered = recover() }()
		handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "http://127.0.0.1/late", nil))
	}()
	if recovered != http.ErrAbortHandler {
		t.Fatalf("sealed handler panic = %v, want http.ErrAbortHandler", recovered)
	}
	if businessCalls != 0 {
		t.Fatalf("business handler calls after seal = %d, want 0", businessCalls)
	}
}

func TestBridgeHTTPHandlerTrackerSealedRealServerAbortsWithoutResponse(t *testing.T) {
	tracker := newBridgeHTTPHandlerTracker()
	businessCalls := atomic.Int32{}
	server := httptest.NewUnstartedServer(tracker.wrap(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		businessCalls.Add(1)
	})))
	var serverLog bytes.Buffer
	server.Config.ErrorLog = log.New(&serverLog, "", 0)
	server.Start()
	defer server.Close()
	tracker.seal()

	response, err := server.Client().Get(server.URL)
	if err == nil {
		response.Body.Close()
		t.Fatalf("sealed late request received HTTP %d, want connection error", response.StatusCode)
	}
	if businessCalls.Load() != 0 {
		t.Fatalf("business handler calls after seal = %d, want 0", businessCalls.Load())
	}
	if serverLog.Len() != 0 {
		t.Fatalf("http.ErrAbortHandler produced server log noise: %q", serverLog.String())
	}
}

func TestBridgeHTTPServeCancellationWinsPostRefreshPreReadyGate(t *testing.T) {
	bridge := newBridge("install", nil, bridgeDeps{
		probeAgentCLIs:             func() map[string]AgentEntry { return map[string]AgentEntry{} },
		resolveAgentExecutablePath: func(string) (string, error) { return "", errors.New("not found") },
	})
	listener := &bridgeCommandlessTestListener{addr: bridgeCommandlessTestAddr("127.0.0.1:8")}
	ctx, cancel := context.WithCancel(context.Background())
	readyCalls := atomic.Int32{}
	barrierEntered := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- serveBridgeHTTPWithDeps(ctx, listener, BridgeHTTPConfig{
			Secret: bridgeHTTPTestSecret,
			Ready: func() error {
				readyCalls.Add(1)
				return nil
			},
		}, bridge, bridgeHTTPServeDeps{
			beforeReady: func(root context.Context) {
				close(barrierEntered)
				<-root.Done()
			},
		})
	}()
	<-barrierEntered
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("serve error = %v, want context canceled", err)
		}
	case <-time.After(time.Second):
		t.Fatal("post-refresh cancellation did not finish startup")
	}
	if readyCalls.Load() != 0 {
		t.Fatalf("Ready calls = %d, want 0", readyCalls.Load())
	}
	if listener.closeCalls.Load() != 1 {
		t.Fatalf("listener close calls = %d, want 1", listener.closeCalls.Load())
	}
}

func TestBridgeHTTPServeAlreadyCancelledParentSkipsRefreshAndReadiness(t *testing.T) {
	refreshCalls := atomic.Int32{}
	bridge := newBridge("install", nil, bridgeDeps{
		probeAgentCLIs: func() map[string]AgentEntry {
			refreshCalls.Add(1)
			return map[string]AgentEntry{}
		},
		resolveAgentExecutablePath: func(string) (string, error) { return "", errors.New("not found") },
	})
	listener := &bridgeCommandlessTestListener{addr: bridgeCommandlessTestAddr("127.0.0.1:10")}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	readyCalls := atomic.Int32{}
	err := serveBridgeHTTPWithDeps(ctx, listener, BridgeHTTPConfig{
		Secret: bridgeHTTPTestSecret,
		Ready: func() error {
			readyCalls.Add(1)
			return nil
		},
	}, bridge, bridgeHTTPServeDeps{})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("serve error = %v, want context canceled", err)
	}
	if refreshCalls.Load() != 0 {
		t.Fatalf("Refresh calls = %d, want 0", refreshCalls.Load())
	}
	if readyCalls.Load() != 0 {
		t.Fatalf("Ready calls = %d, want 0", readyCalls.Load())
	}
	if listener.closeCalls.Load() != 1 {
		t.Fatalf("listener close calls = %d, want 1", listener.closeCalls.Load())
	}
}

func TestBridgeHTTPStartupGateParentCancellationWinsBeforeReadyLock(t *testing.T) {
	parent, cancel := context.WithCancel(context.Background())
	gate := newBridgeHTTPStartupGate(parent)
	cancel()
	readyCalls := 0
	err := gate.markReady(func() error {
		readyCalls++
		return nil
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("markReady error = %v, want context canceled", err)
	}
	if readyCalls != 0 {
		t.Fatalf("Ready calls = %d, want 0", readyCalls)
	}
}

func TestBridgeHTTPServeUnexpectedServeErrorCancelsAndJoinsTaskCleanup(t *testing.T) {
	bridge := newBridgeHTTPReadyTestBridge()
	backend := &bridgeHTTPCleanupBackend{
		started:    make(chan struct{}),
		cancelSeen: make(chan struct{}),
		release:    make(chan struct{}),
	}
	serveFailure := errors.New("listener accept failed")
	listener := &bridgeHTTPFailingTestListener{
		addr:    bridgeCommandlessTestAddr("127.0.0.1:9"),
		release: make(chan struct{}),
		err:     serveFailure,
	}
	var manager *bridgeTaskManager
	done := make(chan error, 1)
	go func() {
		done <- serveBridgeHTTPWithDeps(context.Background(), listener, BridgeHTTPConfig{
			Secret: bridgeHTTPTestSecret,
			Ready: func() error {
				var runtimeID string
				for _, runtime := range bridge.Runtimes() {
					if runtime.Provider == "codex" {
						runtimeID = runtime.ID
						break
					}
				}
				if runtimeID == "" {
					return errors.New("codex runtime missing")
				}
				if _, err := manager.Start(BridgeTaskRequest{
					RuntimeID:       runtimeID,
					ConversationKey: "conversation",
					WorkDir:         t.TempDir(),
					Prompt:          "hello",
				}); err != nil {
					return err
				}
				select {
				case <-backend.started:
					listener.releaseAccept()
					return nil
				case <-time.After(time.Second):
					return errors.New("task backend did not start")
				}
			},
		}, bridge, bridgeHTTPServeDeps{
			newTasks: func(root context.Context, bridge *Bridge) *bridgeTaskManager {
				manager = newBridgeTaskManager(root, bridgeTaskDeps{
					resolveBackend:   func(string, agent.Config) (agent.Backend, error) { return backend, nil },
					runtimeByID:      bridge.bridgeRuntimeByID,
					markNeedsAuth:    bridge.markBridgeRuntimeNeedsAuth,
					canonicalWorkDir: canonicalBridgeTaskWorkDir,
				})
				return manager
			},
		})
	}()
	select {
	case <-backend.cancelSeen:
	case err := <-done:
		t.Fatalf("ServeBridgeHTTP returned before cancelling the task: %v", err)
	case <-time.After(time.Second):
		t.Fatal("unexpected Serve error did not cancel the task root")
	}
	select {
	case err := <-done:
		t.Fatalf("ServeBridgeHTTP returned before task cleanup completed: %v", err)
	default:
	}
	close(backend.release)
	select {
	case err := <-done:
		if !errors.Is(err, serveFailure) {
			t.Fatalf("ServeBridgeHTTP error = %v, want listener failure", err)
		}
	case <-time.After(time.Second):
		t.Fatal("ServeBridgeHTTP did not return after unexpected-error cleanup")
	}
}

type bridgeHTTPFailingTestListener struct {
	addr        net.Addr
	release     chan struct{}
	releaseOnce sync.Once
	err         error
	closeCalls  atomic.Int32
}

func (l *bridgeHTTPFailingTestListener) releaseAccept() {
	l.releaseOnce.Do(func() { close(l.release) })
}

func (l *bridgeHTTPFailingTestListener) Accept() (net.Conn, error) {
	<-l.release
	return nil, l.err
}

func (l *bridgeHTTPFailingTestListener) Close() error {
	l.closeCalls.Add(1)
	l.releaseAccept()
	return nil
}

func (l *bridgeHTTPFailingTestListener) Addr() net.Addr { return l.addr }

type bridgeCommandlessTestAddr string

func (a bridgeCommandlessTestAddr) Network() string { return "tcp" }
func (a bridgeCommandlessTestAddr) String() string  { return string(a) }

type bridgeCommandlessTestListener struct {
	addr       net.Addr
	closeCalls atomic.Int32
}

func (l *bridgeCommandlessTestListener) Accept() (net.Conn, error) { return nil, net.ErrClosed }
func (l *bridgeCommandlessTestListener) Close() error {
	l.closeCalls.Add(1)
	return nil
}
func (l *bridgeCommandlessTestListener) Addr() net.Addr { return l.addr }
