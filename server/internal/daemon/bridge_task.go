package daemon

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/multica-ai/multica/server/pkg/agent"
	"github.com/multica-ai/multica/server/pkg/redact"
	"github.com/multica-ai/multica/server/pkg/taskfailure"
)

type BridgeTaskRequest struct {
	RuntimeID       string `json:"runtime_id"`
	ConversationKey string `json:"conversation_key"`
	ResumeSessionID string `json:"resume_session_id,omitempty"`
	WorkDir         string `json:"workdir"`
	Prompt          string `json:"prompt"`
}

type BridgeEventType string

const (
	BridgeEventStarted      BridgeEventType = "started"
	BridgeEventTextDelta    BridgeEventType = "text_delta"
	BridgeEventToolStarted  BridgeEventType = "tool_started"
	BridgeEventToolFinished BridgeEventType = "tool_finished"
	BridgeEventStatus       BridgeEventType = "status"
	BridgeEventCompleted    BridgeEventType = "completed"
	BridgeEventFailed       BridgeEventType = "failed"
	BridgeEventCancelled    BridgeEventType = "cancelled"
)

const BridgeTaskStatusResumeInvalidated = "resume_invalidated"

type BridgeError struct {
	Category string `json:"category"`
	Message  string `json:"message"`
}

type BridgeTaskEvent struct {
	ID        uint64          `json:"id"`
	Type      BridgeEventType `json:"type"`
	TaskID    string          `json:"task_id"`
	Time      time.Time       `json:"time"`
	SessionID string          `json:"session_id,omitempty"`
	Text      string          `json:"text,omitempty"`
	Tool      string          `json:"tool,omitempty"`
	CallID    string          `json:"call_id,omitempty"`
	Output    string          `json:"output,omitempty"`
	Status    string          `json:"status,omitempty"`
	Error     *BridgeError    `json:"error,omitempty"`
}

var (
	ErrBridgeTaskInvalidRequest  = errors.New("invalid bridge task request")
	ErrBridgeTaskInvalidWorkDir  = errors.New("invalid bridge task workdir")
	ErrBridgeTaskUnknownRuntime  = errors.New("unknown bridge runtime")
	ErrBridgeTaskRuntimeNotReady = errors.New("bridge runtime is not ready")
	ErrBridgeTaskUnknown         = errors.New("unknown bridge task")
	ErrBridgeTaskFutureCursor    = errors.New("bridge task replay cursor is in the future")
)

const (
	defaultBridgeTaskTimeout        = 2 * time.Hour
	defaultBridgeTaskEventLimit     = 512
	defaultBridgeSubscriberSize     = 64
	defaultBridgeTaskTerminalTTL    = 5 * time.Minute
	bridgeTaskToolOutputLimit       = 8192
	bridgeTaskAuthenticationMessage = "runtime authentication failed"
	bridgeTaskTransportMessage      = "runtime transport failed"
	bridgeTaskRuntimeMessage        = "runtime execution failed"
)

type bridgeTaskDeps struct {
	resolveBackend           func(string, agent.Config) (agent.Backend, error)
	runtimeByID              func(string) (BridgeRuntime, bool)
	markNeedsAuth            func(string)
	canonicalWorkDir         func(string) (string, error)
	newTaskID                func() string
	now                      func() time.Time
	logger                   *slog.Logger
	timeout                  time.Duration
	eventLimit               int
	subscriberSize           int
	terminalTTL              time.Duration
	afterConversationAcquire func(string)
}

type bridgeTaskManager struct {
	root context.Context
	deps bridgeTaskDeps

	mu            sync.Mutex
	tasks         map[string]*bridgeTask
	conversations map[string]*bridgeConversation
}

type bridgeConversation struct {
	gate chan struct{}
	refs int
}

type bridgeTask struct {
	id         string
	cancel     context.CancelFunc
	now        func() time.Time
	eventLimit int

	mu          sync.Mutex
	nextEventID uint64
	events      []BridgeTaskEvent
	subscribers map[chan BridgeTaskEvent]chan struct{}
	terminal    bool
	terminalAt  time.Time
}

var bridgeTaskIDSequence atomic.Uint64

func newBridgeTaskManager(root context.Context, deps bridgeTaskDeps) *bridgeTaskManager {
	if root == nil {
		root = context.Background()
	}
	if deps.resolveBackend == nil {
		deps.resolveBackend = agent.ResolveBackend
	}
	if deps.markNeedsAuth == nil {
		deps.markNeedsAuth = func(string) {}
	}
	if deps.canonicalWorkDir == nil {
		deps.canonicalWorkDir = canonicalBridgeTaskWorkDir
	}
	if deps.newTaskID == nil {
		deps.newTaskID = defaultBridgeTaskID
	}
	if deps.now == nil {
		deps.now = time.Now
	}
	if deps.logger == nil {
		deps.logger = slog.Default()
	}
	if deps.timeout <= 0 {
		deps.timeout = defaultBridgeTaskTimeout
	}
	if deps.eventLimit <= 0 {
		deps.eventLimit = defaultBridgeTaskEventLimit
	}
	if deps.subscriberSize <= 0 {
		deps.subscriberSize = defaultBridgeSubscriberSize
	}
	if deps.terminalTTL <= 0 {
		deps.terminalTTL = defaultBridgeTaskTerminalTTL
	}
	return &bridgeTaskManager{
		root:          root,
		deps:          deps,
		tasks:         make(map[string]*bridgeTask),
		conversations: make(map[string]*bridgeConversation),
	}
}

func newDefaultBridgeTaskManager(root context.Context, bridge *Bridge, logger *slog.Logger) *bridgeTaskManager {
	return newBridgeTaskManager(root, bridgeTaskDeps{
		resolveBackend: agent.ResolveBackend,
		runtimeByID:    bridge.bridgeRuntimeByID,
		markNeedsAuth:  bridge.markBridgeRuntimeNeedsAuth,
		logger:         logger,
	})
}

func (m *bridgeTaskManager) Start(req BridgeTaskRequest) (string, error) {
	m.pruneExpired()
	if strings.TrimSpace(req.RuntimeID) == "" || strings.TrimSpace(req.ConversationKey) == "" ||
		strings.TrimSpace(req.WorkDir) == "" || strings.TrimSpace(req.Prompt) == "" {
		return "", ErrBridgeTaskInvalidRequest
	}
	workDir, err := m.deps.canonicalWorkDir(req.WorkDir)
	if err != nil || workDir == "" {
		return "", fmt.Errorf("%w: %v", ErrBridgeTaskInvalidWorkDir, err)
	}
	if m.deps.runtimeByID == nil {
		return "", ErrBridgeTaskUnknownRuntime
	}
	runtime, ok := m.deps.runtimeByID(req.RuntimeID)
	if !ok {
		return "", ErrBridgeTaskUnknownRuntime
	}
	if runtime.Status != BridgeRuntimeReady {
		return "", ErrBridgeTaskRuntimeNotReady
	}

	taskID := m.deps.newTaskID()
	taskCtx, cancel := context.WithCancel(m.root)
	task := &bridgeTask{
		id:          taskID,
		cancel:      cancel,
		now:         m.deps.now,
		eventLimit:  m.deps.eventLimit,
		subscribers: make(map[chan BridgeTaskEvent]chan struct{}),
	}
	m.mu.Lock()
	m.tasks[taskID] = task
	m.mu.Unlock()

	go func() {
		release, ok := m.acquireConversation(taskCtx, req.RuntimeID+"\x00"+req.ConversationKey)
		if !ok {
			task.publish(BridgeTaskEvent{Type: BridgeEventCancelled})
			return
		}
		defer release()
		if m.deps.afterConversationAcquire != nil {
			m.deps.afterConversationAcquire(task.id)
		}
		if taskCtx.Err() != nil {
			task.publish(BridgeTaskEvent{Type: BridgeEventCancelled})
			return
		}
		m.execute(taskCtx, task, runtime, req, workDir)
	}()
	return taskID, nil
}

func (m *bridgeTaskManager) Subscribe(ctx context.Context, taskID string, afterID uint64) (<-chan BridgeTaskEvent, error) {
	m.pruneExpired()
	m.mu.Lock()
	task, ok := m.tasks[taskID]
	m.mu.Unlock()
	if !ok {
		return nil, ErrBridgeTaskUnknown
	}

	task.mu.Lock()
	if afterID > task.nextEventID {
		task.mu.Unlock()
		return nil, ErrBridgeTaskFutureCursor
	}
	var replay []BridgeTaskEvent
	if len(task.events) > 0 && afterID < task.events[0].ID-1 {
		replay = append(replay, BridgeTaskEvent{
			ID:     task.events[0].ID - 1,
			Type:   BridgeEventStatus,
			TaskID: task.id,
			Time:   task.now(),
			Status: "replay_overflow",
		})
	}
	for _, event := range task.events {
		if event.ID > afterID {
			replay = append(replay, event)
		}
	}
	bufferSize := max(m.deps.subscriberSize, len(replay))
	ch := make(chan BridgeTaskEvent, bufferSize)
	for _, event := range replay {
		ch <- event
	}
	if task.terminal {
		close(ch)
		task.mu.Unlock()
		return ch, nil
	}
	done := make(chan struct{})
	task.subscribers[ch] = done
	task.mu.Unlock()

	go func() {
		select {
		case <-ctx.Done():
			task.removeSubscriber(ch)
		case <-done:
		}
	}()
	return ch, nil
}

func (m *bridgeTaskManager) Cancel(taskID string) error {
	m.pruneExpired()
	m.mu.Lock()
	task, ok := m.tasks[taskID]
	m.mu.Unlock()
	if !ok {
		return ErrBridgeTaskUnknown
	}
	task.cancel()
	return nil
}

func (m *bridgeTaskManager) pruneExpired() {
	now := m.deps.now()
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, task := range m.tasks {
		task.mu.Lock()
		expired := task.terminal && !task.terminalAt.IsZero() && !now.Before(task.terminalAt.Add(m.deps.terminalTTL))
		task.mu.Unlock()
		if expired {
			delete(m.tasks, id)
		}
	}
}

func (m *bridgeTaskManager) acquireConversation(ctx context.Context, key string) (func(), bool) {
	m.mu.Lock()
	conversation := m.conversations[key]
	if conversation == nil {
		conversation = &bridgeConversation{gate: make(chan struct{}, 1)}
		m.conversations[key] = conversation
	}
	conversation.refs++
	m.mu.Unlock()

	select {
	case conversation.gate <- struct{}{}:
		return func() {
			<-conversation.gate
			m.releaseConversation(key, conversation)
		}, true
	case <-ctx.Done():
		m.releaseConversation(key, conversation)
		return nil, false
	}
}

func (m *bridgeTaskManager) releaseConversation(key string, conversation *bridgeConversation) {
	m.mu.Lock()
	conversation.refs--
	if conversation.refs == 0 && m.conversations[key] == conversation {
		delete(m.conversations, key)
	}
	m.mu.Unlock()
}

func (m *bridgeTaskManager) execute(ctx context.Context, task *bridgeTask, runtime BridgeRuntime, req BridgeTaskRequest, workDir string) {
	task.publish(BridgeTaskEvent{Type: BridgeEventStarted})
	codexVersion := ""
	if runtime.Provider == "codex" {
		codexVersion = runtime.Version
	}
	backend, err := m.deps.resolveBackend(runtime.Provider, agent.Config{
		ExecutablePath: runtime.Path,
		CLIVersion:     runtime.Version,
		Logger:         m.deps.logger,
		TaskID:         task.id,
		RuntimeID:      runtime.ID,
		CodexVersion:   codexVersion,
		BuiltinRuntime: true,
	})
	if err != nil {
		m.finishError(ctx, task, runtime.ID, err.Error(), "")
		return
	}

	opts := agent.ExecOptions{
		Cwd:             workDir,
		Timeout:         m.deps.timeout,
		ResumeSessionID: req.ResumeSessionID,
		ResumeExpected:  req.ResumeSessionID != "",
		OpenclawMode:    "local",
	}
	result, tools, err := m.executeAttempt(ctx, task, backend, req.Prompt, opts)
	if err != nil {
		m.finishError(ctx, task, runtime.ID, err.Error(), "")
		return
	}
	terminalStatus := ""
	if ctx.Err() == nil && bridgeTaskShouldRetry(result, req.ResumeSessionID, tools, runtime.Provider) {
		terminalStatus = BridgeTaskStatusResumeInvalidated
		opts.ResumeSessionID = ""
		opts.ResumeExpected = false
		result, _, err = m.executeAttempt(ctx, task, backend, req.Prompt, opts)
		if err != nil {
			m.finishError(ctx, task, runtime.ID, err.Error(), terminalStatus)
			return
		}
	}
	m.finishResult(ctx, task, runtime.ID, result, terminalStatus)
}

func (m *bridgeTaskManager) executeAttempt(ctx context.Context, task *bridgeTask, backend agent.Backend, prompt string, opts agent.ExecOptions) (agent.Result, int32, error) {
	session, err := backend.Execute(ctx, prompt, opts)
	if err != nil {
		return agent.Result{}, 0, err
	}
	if session == nil {
		return agent.Result{}, 0, errors.New("backend returned no session")
	}

	tools := make(map[string]string)
	var toolCount int32
	if session.Messages != nil {
		for message := range session.Messages {
			switch message.Type {
			case agent.MessageText:
				task.publish(BridgeTaskEvent{Type: BridgeEventTextDelta, Text: message.Content})
			case agent.MessageToolUse:
				toolCount++
				tools[message.CallID] = message.Tool
				task.publish(BridgeTaskEvent{Type: BridgeEventToolStarted, Tool: message.Tool, CallID: message.CallID})
			case agent.MessageToolResult:
				tool := message.Tool
				if tool == "" {
					tool = tools[message.CallID]
				}
				task.publish(BridgeTaskEvent{
					Type:   BridgeEventToolFinished,
					Tool:   tool,
					CallID: message.CallID,
					Output: truncateBridgeTaskUTF8(redact.Text(message.Output), bridgeTaskToolOutputLimit),
				})
			case agent.MessageStatus:
				task.publish(BridgeTaskEvent{Type: BridgeEventStatus, Status: message.Status, SessionID: message.SessionID})
			}
		}
	}
	if session.Result == nil {
		return agent.Result{}, toolCount, errors.New("backend returned no result")
	}
	result, ok := <-session.Result
	if !ok {
		return agent.Result{}, toolCount, errors.New("backend result channel closed")
	}
	return result, toolCount, nil
}

func (m *bridgeTaskManager) finishResult(ctx context.Context, task *bridgeTask, runtimeID string, result agent.Result, terminalStatus string) {
	if ctx.Err() != nil || result.Status == "aborted" || result.Status == "cancelled" {
		task.publish(BridgeTaskEvent{Type: BridgeEventCancelled, SessionID: result.SessionID, Status: terminalStatus})
		return
	}
	if result.Status == "completed" {
		task.publish(BridgeTaskEvent{Type: BridgeEventCompleted, Output: result.Output, SessionID: result.SessionID, Status: terminalStatus})
		return
	}
	reason := taskfailure.Classify(result.Error)
	if reason == taskfailure.ReasonAgentProviderAuthOrAccess {
		m.deps.markNeedsAuth(runtimeID)
	}
	task.publish(BridgeTaskEvent{Type: BridgeEventFailed, SessionID: result.SessionID, Status: terminalStatus, Error: bridgeTaskSafeErrorReason(reason)})
}

func (m *bridgeTaskManager) finishError(ctx context.Context, task *bridgeTask, runtimeID, raw, terminalStatus string) {
	if ctx.Err() != nil {
		task.publish(BridgeTaskEvent{Type: BridgeEventCancelled, Status: terminalStatus})
		return
	}
	reason := taskfailure.Classify(raw)
	if reason == taskfailure.ReasonAgentProviderAuthOrAccess {
		m.deps.markNeedsAuth(runtimeID)
	}
	task.publish(BridgeTaskEvent{Type: BridgeEventFailed, Status: terminalStatus, Error: bridgeTaskSafeErrorReason(reason)})
}

func (t *bridgeTask) publish(event BridgeTaskEvent) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.terminal {
		return
	}
	t.nextEventID++
	event.ID = t.nextEventID
	event.TaskID = t.id
	event.Time = t.now()
	t.events = append(t.events, event)
	if len(t.events) > t.eventLimit {
		dropped := len(t.events) - t.eventLimit
		copy(t.events, t.events[dropped:])
		clear(t.events[t.eventLimit:])
		t.events = t.events[:t.eventLimit]
	}
	for subscriber, done := range t.subscribers {
		select {
		case subscriber <- event:
		default:
			delete(t.subscribers, subscriber)
			close(done)
			close(subscriber)
		}
	}
	if bridgeTaskTerminalEvent(event.Type) {
		t.terminal = true
		t.terminalAt = event.Time
		t.cancel()
		for subscriber, done := range t.subscribers {
			delete(t.subscribers, subscriber)
			close(done)
			close(subscriber)
		}
	}
}

func (t *bridgeTask) removeSubscriber(subscriber chan BridgeTaskEvent) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if done, ok := t.subscribers[subscriber]; ok {
		delete(t.subscribers, subscriber)
		close(done)
		close(subscriber)
	}
}

func bridgeTaskTerminalEvent(eventType BridgeEventType) bool {
	return eventType == BridgeEventCompleted || eventType == BridgeEventFailed || eventType == BridgeEventCancelled
}

func bridgeTaskSafeErrorReason(reason taskfailure.Reason) *BridgeError {
	switch reason {
	case taskfailure.ReasonAgentProviderAuthOrAccess:
		return &BridgeError{Category: "authentication", Message: bridgeTaskAuthenticationMessage}
	case taskfailure.ReasonAgentProviderNetwork:
		return &BridgeError{Category: "transport", Message: bridgeTaskTransportMessage}
	default:
		return &BridgeError{Category: "runtime", Message: bridgeTaskRuntimeMessage}
	}
}

func bridgeTaskShouldRetry(result agent.Result, originalResumeID string, toolCount int32, provider string) bool {
	switch taskfailure.Classify(result.Error) {
	case taskfailure.ReasonAgentProviderAuthOrAccess,
		taskfailure.ReasonAgentProviderNetwork,
		taskfailure.ReasonAgentProviderQuotaLimit,
		taskfailure.ReasonAgentProviderCapacityOrRateLimit,
		taskfailure.ReasonAgentProviderServerError:
		return false
	}
	return shouldRetryWithFreshSession(result, originalResumeID, toolCount, provider)
}

func truncateBridgeTaskUTF8(value string, limit int) string {
	value = strings.ToValidUTF8(value, "\uFFFD")
	if len(value) <= limit {
		return value
	}
	end := limit
	for end > 0 && !utf8.ValidString(value[:end]) {
		end--
	}
	return value[:end]
}

func canonicalBridgeTaskWorkDir(path string) (string, error) {
	if !filepath.IsAbs(path) {
		return "", errors.New("workdir must be absolute")
	}
	canonical, err := filepath.EvalSymlinks(filepath.Clean(path))
	if err != nil {
		return "", err
	}
	info, err := os.Stat(canonical)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", errors.New("workdir is not a directory")
	}
	return canonical, nil
}

func defaultBridgeTaskID() string {
	return fmt.Sprintf("task_%x_%x", time.Now().UnixNano(), bridgeTaskIDSequence.Add(1))
}

func (b *Bridge) bridgeRuntimeByID(id string) (BridgeRuntime, bool) {
	b.runtimeMu.RLock()
	defer b.runtimeMu.RUnlock()
	for i := range b.runtimes {
		if b.runtimes[i].runtime.ID == id {
			return b.runtimes[i].runtime, true
		}
	}
	return BridgeRuntime{}, false
}

func (b *Bridge) markBridgeRuntimeNeedsAuth(id string) {
	b.runtimeMu.Lock()
	defer b.runtimeMu.Unlock()
	for i := range b.runtimes {
		if b.runtimes[i].runtime.ID == id {
			b.runtimes[i].runtime.Status = BridgeRuntimeNeedsAuth
			return
		}
	}
}
