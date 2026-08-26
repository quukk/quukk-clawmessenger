package daemon

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

const bridgeHTTPTaskBodyLimit int64 = 1 << 20

const (
	bridgeHTTPHeartbeatInterval = 15 * time.Second
	bridgeHTTPShutdownTimeout   = 5 * time.Second
)

type BridgeHTTPConfig struct {
	Secret                string
	InstallID             string
	Version               string
	ProviderPathOverrides map[string]string
	PID                   int
	InstanceID            string
	StartedAt             time.Time
	Ready                 func() error
}

type bridgeHTTPDeps struct {
	runtimes   func() []BridgeRuntime
	refresh    func(context.Context) []BridgeRuntime
	start      func(BridgeTaskRequest) (string, error)
	subscribe  func(context.Context, string, uint64) (<-chan BridgeTaskEvent, error)
	cancelTask func(string) error
	newTicker  func(time.Duration) bridgeHTTPTicker
}

type bridgeHTTPTicker interface {
	C() <-chan time.Time
	Stop()
}

type bridgeHTTPRealTicker struct{ *time.Ticker }

func (t bridgeHTTPRealTicker) C() <-chan time.Time { return t.Ticker.C }

type bridgeHTTPHandler struct {
	root       context.Context
	cancelRoot context.CancelFunc
	cfg        BridgeHTTPConfig
	deps       bridgeHTTPDeps
	refreshing atomic.Int32
}

func newBridgeHTTPHandler(root context.Context, cancelRoot context.CancelFunc, cfg BridgeHTTPConfig, deps bridgeHTTPDeps) http.Handler {
	if root == nil {
		root = context.Background()
	}
	if cancelRoot == nil {
		cancelRoot = func() {}
	}
	if deps.runtimes == nil {
		deps.runtimes = func() []BridgeRuntime { return []BridgeRuntime{} }
	}
	if deps.refresh == nil {
		deps.refresh = func(context.Context) []BridgeRuntime { return []BridgeRuntime{} }
	}
	if deps.start == nil {
		deps.start = func(BridgeTaskRequest) (string, error) { return "", ErrBridgeTaskInvalidRequest }
	}
	if deps.subscribe == nil {
		deps.subscribe = func(context.Context, string, uint64) (<-chan BridgeTaskEvent, error) {
			return nil, ErrBridgeTaskUnknown
		}
	}
	if deps.cancelTask == nil {
		deps.cancelTask = func(string) error { return ErrBridgeTaskUnknown }
	}
	if deps.newTicker == nil {
		deps.newTicker = func(interval time.Duration) bridgeHTTPTicker {
			return bridgeHTTPRealTicker{time.NewTicker(interval)}
		}
	}
	return &bridgeHTTPHandler{root: root, cancelRoot: cancelRoot, cfg: cfg, deps: deps}
}

func (h *bridgeHTTPHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !bridgeHTTPLoopbackRemote(r.RemoteAddr) {
		writeBridgeHTTPError(w, http.StatusForbidden, "loopback_required")
		return
	}
	values := r.Header.Values("Authorization")
	if len(values) != 1 || !bridgeHTTPAuthorizationEqual(values[0], "Bearer "+h.cfg.Secret) {
		writeBridgeHTTPError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	switch r.URL.Path {
	case "/v1/runtimes":
		if !bridgeHTTPMethod(w, r, http.MethodGet) {
			return
		}
		writeBridgeHTTPJSON(w, http.StatusOK, h.deps.runtimes())
	case "/v1/runtimes/refresh":
		if !bridgeHTTPMethod(w, r, http.MethodPost) {
			return
		}
		if !bridgeHTTPEmptyBody(r) {
			writeBridgeHTTPError(w, http.StatusBadRequest, "invalid_request")
			return
		}
		h.refreshing.Add(1)
		runtimes := h.deps.refresh(h.root)
		h.refreshing.Add(-1)
		writeBridgeHTTPJSON(w, http.StatusOK, runtimes)
	case "/v1/tasks":
		if !bridgeHTTPMethod(w, r, http.MethodPost) {
			return
		}
		h.handleTaskStart(w, r)
	case "/healthz":
		if !bridgeHTTPMethod(w, r, http.MethodGet) {
			return
		}
		probeStatus := "ready"
		if h.refreshing.Load() > 0 {
			probeStatus = "refreshing"
		}
		writeBridgeHTTPJSON(w, http.StatusOK, struct {
			Status      string    `json:"status"`
			Version     string    `json:"version"`
			PID         int       `json:"pid"`
			InstanceID  string    `json:"instance_id"`
			StartedAt   time.Time `json:"started_at"`
			ProbeStatus string    `json:"probe_status"`
		}{"ok", h.cfg.Version, h.cfg.PID, h.cfg.InstanceID, h.cfg.StartedAt, probeStatus})
	case "/shutdown":
		if !bridgeHTTPMethod(w, r, http.MethodPost) {
			return
		}
		h.handleShutdown(w, r)
	default:
		taskID, action, ok := bridgeHTTPTaskPath(r.URL.Path)
		if !ok {
			writeBridgeHTTPError(w, http.StatusNotFound, "not_found")
			return
		}
		switch action {
		case "events":
			if !bridgeHTTPMethod(w, r, http.MethodGet) {
				return
			}
			h.handleTaskEvents(w, r, taskID)
		case "cancel":
			if !bridgeHTTPMethod(w, r, http.MethodPost) {
				return
			}
			h.handleTaskCancel(w, r, taskID)
		}
	}
}

func (h *bridgeHTTPHandler) handleTaskStart(w http.ResponseWriter, r *http.Request) {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		writeBridgeHTTPError(w, http.StatusUnsupportedMediaType, "unsupported_media_type")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, bridgeHTTPTaskBodyLimit)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var request BridgeTaskRequest
	if err := decoder.Decode(&request); err != nil {
		h.writeTaskDecodeError(w, err)
		return
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		h.writeTaskDecodeError(w, err)
		return
	}

	taskID, err := h.deps.start(request)
	if err != nil {
		switch {
		case errors.Is(err, ErrBridgeTaskInvalidRequest):
			writeBridgeHTTPError(w, http.StatusBadRequest, "invalid_request")
		case errors.Is(err, ErrBridgeTaskInvalidWorkDir):
			writeBridgeHTTPError(w, http.StatusBadRequest, "invalid_workdir")
		case errors.Is(err, ErrBridgeTaskUnknownRuntime):
			writeBridgeHTTPError(w, http.StatusNotFound, "runtime_not_found")
		case errors.Is(err, ErrBridgeTaskRuntimeNotReady):
			writeBridgeHTTPError(w, http.StatusConflict, "runtime_not_ready")
		default:
			writeBridgeHTTPError(w, http.StatusInternalServerError, "internal_error")
		}
		return
	}
	writeBridgeHTTPJSON(w, http.StatusCreated, struct {
		TaskID    string `json:"task_id"`
		EventsURL string `json:"events_url"`
	}{taskID, "/v1/tasks/" + taskID + "/events"})
}

func (h *bridgeHTTPHandler) writeTaskDecodeError(w http.ResponseWriter, err error) {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		writeBridgeHTTPError(w, http.StatusRequestEntityTooLarge, "payload_too_large")
		return
	}
	writeBridgeHTTPError(w, http.StatusBadRequest, "invalid_request")
}

func (h *bridgeHTTPHandler) handleTaskEvents(w http.ResponseWriter, r *http.Request, taskID string) {
	afterID, ok := bridgeHTTPLastEventID(r.Header.Values("Last-Event-ID"))
	if !ok {
		writeBridgeHTTPError(w, http.StatusBadRequest, "invalid_last_event_id")
		return
	}
	events, err := h.deps.subscribe(r.Context(), taskID, afterID)
	if err != nil {
		switch {
		case errors.Is(err, ErrBridgeTaskUnknown):
			writeBridgeHTTPError(w, http.StatusNotFound, "task_not_found")
		case errors.Is(err, ErrBridgeTaskFutureCursor):
			writeBridgeHTTPError(w, http.StatusConflict, "future_cursor")
		default:
			writeBridgeHTTPError(w, http.StatusInternalServerError, "internal_error")
		}
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeBridgeHTTPError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	ticker := h.deps.newTicker(bridgeHTTPHeartbeatInterval)
	defer func() { ticker.Stop() }()
	w.Header().Set("Content-Type", "text/event-stream")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	for {
		select {
		case event, open := <-events:
			if !open {
				return
			}
			ticker.Stop()
			ticker = h.deps.newTicker(bridgeHTTPHeartbeatInterval)
			data, err := json.Marshal(event)
			if err != nil {
				return
			}
			if _, err := fmt.Fprintf(w, "id: %d\nevent: %s\ndata: %s\n\n", event.ID, event.Type, data); err != nil {
				return
			}
			flusher.Flush()
		case <-ticker.C():
			if _, err := io.WriteString(w, ": heartbeat\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case <-r.Context().Done():
			return
		}
	}
}

func (h *bridgeHTTPHandler) handleTaskCancel(w http.ResponseWriter, r *http.Request, taskID string) {
	if !bridgeHTTPEmptyBody(r) {
		writeBridgeHTTPError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	if err := h.deps.cancelTask(taskID); err != nil {
		if errors.Is(err, ErrBridgeTaskUnknown) {
			writeBridgeHTTPError(w, http.StatusNotFound, "task_not_found")
		} else {
			writeBridgeHTTPError(w, http.StatusInternalServerError, "internal_error")
		}
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

func (h *bridgeHTTPHandler) handleShutdown(w http.ResponseWriter, r *http.Request) {
	if !bridgeHTTPEmptyBody(r) {
		writeBridgeHTTPError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	w.WriteHeader(http.StatusAccepted)
	flusher, ok := w.(http.Flusher)
	if !ok {
		return
	}
	flusher.Flush()
	go h.cancelRoot()
}

func bridgeHTTPTaskPath(path string) (taskID, action string, ok bool) {
	remainder, ok := strings.CutPrefix(path, "/v1/tasks/")
	if !ok {
		return "", "", false
	}
	parts := strings.Split(remainder, "/")
	if len(parts) != 2 || parts[0] == "" || (parts[1] != "events" && parts[1] != "cancel") {
		return "", "", false
	}
	return parts[0], parts[1], true
}

func bridgeHTTPLastEventID(values []string) (uint64, bool) {
	if len(values) == 0 {
		return 0, true
	}
	if len(values) != 1 || values[0] == "" {
		return 0, false
	}
	for _, char := range values[0] {
		if char < '0' || char > '9' {
			return 0, false
		}
	}
	value, err := strconv.ParseUint(values[0], 10, 64)
	return value, err == nil
}

func bridgeHTTPLoopbackRemote(remoteAddr string) bool {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func bridgeAuthorizationDigest(value string) [sha256.Size]byte {
	return sha256.Sum256([]byte(value))
}

func bridgeHTTPAuthorizationEqual(received, expected string) bool {
	receivedDigest := bridgeAuthorizationDigest(received)
	expectedDigest := bridgeAuthorizationDigest(expected)
	return subtle.ConstantTimeCompare(receivedDigest[:], expectedDigest[:]) == 1
}

func bridgeHTTPMethod(w http.ResponseWriter, r *http.Request, method string) bool {
	if r.Method == method {
		return true
	}
	w.Header().Set("Allow", method)
	writeBridgeHTTPError(w, http.StatusMethodNotAllowed, "method_not_allowed")
	return false
}

func bridgeHTTPEmptyBody(r *http.Request) bool {
	data, err := io.ReadAll(io.LimitReader(r.Body, 1))
	return err == nil && len(data) == 0
}

func writeBridgeHTTPError(w http.ResponseWriter, status int, code string) {
	writeBridgeHTTPJSON(w, status, struct {
		Error string `json:"error"`
	}{code})
}

func writeBridgeHTTPJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func newBridgeHTTPServer(handler http.Handler) *http.Server {
	return &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      0,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}
}

func ServeBridgeHTTP(ctx context.Context, listener net.Listener, cfg BridgeHTTPConfig) error {
	return serveBridgeHTTPWithBridge(ctx, listener, cfg, newDefaultBridge(cfg.InstallID, cfg.ProviderPathOverrides))
}

func serveBridgeHTTPWithBridge(ctx context.Context, listener net.Listener, cfg BridgeHTTPConfig, bridge *Bridge) error {
	if ctx == nil {
		ctx = context.Background()
	}
	root, cancelRoot := context.WithCancel(ctx)
	defer cancelRoot()
	defer listener.Close()

	bridge.Refresh(root)
	if err := root.Err(); err != nil {
		return err
	}
	tasks := newDefaultBridgeTaskManager(root, bridge, nil)
	handler := newBridgeHTTPHandler(root, cancelRoot, cfg, bridgeHTTPDeps{
		runtimes:   bridge.Runtimes,
		refresh:    bridge.Refresh,
		start:      tasks.Start,
		subscribe:  tasks.Subscribe,
		cancelTask: tasks.Cancel,
	})
	server := newBridgeHTTPServer(handler)
	shutdownDone := make(chan error, 1)
	go func() {
		<-root.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), bridgeHTTPShutdownTimeout)
		defer cancel()
		shutdownDone <- server.Shutdown(shutdownCtx)
	}()

	if cfg.Ready != nil {
		if err := cfg.Ready(); err != nil {
			return err
		}
	}
	if root.Err() != nil {
		return nil
	}
	err := server.Serve(listener)
	if errors.Is(err, http.ErrServerClosed) {
		shutdownErr := <-shutdownDone
		if errors.Is(shutdownErr, http.ErrServerClosed) {
			return nil
		}
		return shutdownErr
	}
	return err
}
