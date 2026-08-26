package daemon

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/pkg/agent"
)

var errBridgeTestMissing = errors.New("missing test executable")

func TestBridgeRuntimeProvidersCapabilitiesAndCopies(t *testing.T) {
	deps := bridgeTestDeps()
	var discoveryCalls atomic.Int32
	deps.probeAgentCLIs = func() map[string]AgentEntry {
		discoveryCalls.Add(1)
		return map[string]AgentEntry{
			"claude": {Path: "/ignored/claude"},
		}
	}
	deps.resolveAgentExecutablePath = func(command string) (string, error) {
		return "/launch/" + command, nil
	}

	bridge := newBridge("install-a", nil, deps)
	got := bridge.Refresh(context.Background())
	wantProviders := []string{"opencode", "openclaw", "codex", "hermes"}
	wantCapabilities := map[string]BridgeRuntimeCapabilities{
		"opencode": {SessionResume: true, Cancel: true, TextEvents: true, ToolEvents: true},
		"openclaw": {SessionResume: true, Cancel: true},
		"codex":    {SessionResume: true, Cancel: true, TextEvents: true, ToolEvents: true},
		"hermes":   {SessionResume: true, Cancel: true, TextEvents: true, ToolEvents: true},
	}

	if len(got) != len(wantProviders) {
		t.Fatalf("runtime count = %d, want %d: %+v", len(got), len(wantProviders), got)
	}
	for i, runtime := range got {
		if runtime.Provider != wantProviders[i] {
			t.Errorf("runtime[%d].provider = %q, want %q", i, runtime.Provider, wantProviders[i])
		}
		if runtime.Status != BridgeRuntimeReady {
			t.Errorf("%s status = %q, want ready", runtime.Provider, runtime.Status)
		}
		if runtime.Capabilities != wantCapabilities[runtime.Provider] {
			t.Errorf("%s capabilities = %+v, want %+v", runtime.Provider, runtime.Capabilities, wantCapabilities[runtime.Provider])
		}
		if runtime.Capabilities.ApprovalEvents {
			t.Errorf("%s advertised unsupported approval events", runtime.Provider)
		}
	}
	if discoveryCalls.Load() != 1 {
		t.Fatalf("probeAgentCLIs calls = %d, want one discovery pass", discoveryCalls.Load())
	}

	got[0].Provider = "mutated"
	if fresh := bridge.Runtimes(); fresh[0].Provider != "opencode" {
		t.Fatalf("Runtimes exposed mutable publication: %+v", fresh)
	}
}

func TestBridgeRuntimeIDUsesCanonicalPathMatrix(t *testing.T) {
	const want = "rt_1c71bba2d4377ab205dfbb4cdf3aa34d"
	if got := bridgeRuntimeID("install-a", "opencode", "/canonical/opencode"); got != want {
		t.Fatalf("bridgeRuntimeID = %q, want %q", got, want)
	}

	base := bridgeRuntimeID("install-a", "opencode", "/canonical/opencode")
	for name, got := range map[string]string{
		"install changed":  bridgeRuntimeID("install-b", "opencode", "/canonical/opencode"),
		"provider changed": bridgeRuntimeID("install-a", "codex", "/canonical/opencode"),
		"path changed":     bridgeRuntimeID("install-a", "opencode", "/canonical/opencode-v2"),
	} {
		if got == base {
			t.Errorf("%s did not change runtime ID", name)
		}
	}
	if len(base) != len("rt_")+32 || !strings.HasPrefix(base, "rt_") || strings.ToLower(base) != base {
		t.Fatalf("runtime ID shape = %q, want rt_ plus 32 lowercase hex characters", base)
	}
}

func TestBridgeRuntimeCanonicalPathHashesButLaunchPathIsPublished(t *testing.T) {
	deps := bridgeTestDeps()
	deps.resolveAgentExecutablePath = func(command string) (string, error) {
		if command == "opencode" {
			return "/shim/opencode", nil
		}
		return "", errBridgeTestMissing
	}
	deps.canonicalExecutablePath = func(path string) string {
		if path == "/shim/opencode" {
			return "/real/opencode"
		}
		return path
	}

	runtime := runtimeByProvider(t, newBridge("install-a", nil, deps).Refresh(context.Background()), "opencode")
	if runtime.Path != "/shim/opencode" {
		t.Fatalf("published path = %q, want launch-safe shim path", runtime.Path)
	}
	if runtime.ID != "rt_c86a6741db3b515570e49688b52e5e1f" {
		t.Fatalf("runtime ID = %q, want hash of canonical target", runtime.ID)
	}
}

func TestBridgeRuntimeCandidatePrecedence(t *testing.T) {
	root := t.TempDir()
	override := filepath.Join(root, "override", "opencode")
	processPath := filepath.Join(root, "process", "openclaw")
	shellPath := filepath.Join(root, "shell", "hermes")
	bundlePath := filepath.Join(root, "Applications", "Codex.app", "codex")

	deps := bridgeTestDeps()
	deps.resolveAgentExecutablePath = func(command string) (string, error) {
		switch command {
		case override:
			return override, nil
		case "opencode":
			t.Fatal("process PATH must not be checked after an absolute override resolves")
		case "openclaw":
			return processPath, nil
		}
		return "", errBridgeTestMissing
	}
	deps.probeAgentCLIs = func() map[string]AgentEntry {
		return map[string]AgentEntry{
			"opencode": {Path: filepath.Join(root, "lower", "opencode")},
			"openclaw": {Path: filepath.Join(root, "lower", "openclaw")},
			"codex":    {Path: bundlePath},
			"hermes":   {Path: shellPath},
			"claude":   {Path: filepath.Join(root, "ignored", "claude")},
		}
	}

	got := newBridge("install-a", map[string]string{"opencode": override}, deps).Refresh(context.Background())
	wantPaths := map[string]string{
		"opencode": override,
		"openclaw": processPath,
		"codex":    bundlePath,
		"hermes":   shellPath,
	}
	for provider, want := range wantPaths {
		if runtime := runtimeByProvider(t, got, provider); runtime.Path != want {
			t.Errorf("%s path = %q, want %q", provider, runtime.Path, want)
		}
	}
}

func TestBridgeRuntimeDiscoveryStatusesKeepFoundIdentity(t *testing.T) {
	deps := bridgeTestDeps()
	deps.resolveAgentExecutablePath = func(command string) (string, error) {
		if command == "hermes" {
			return "", errBridgeTestMissing
		}
		return "/found/" + command, nil
	}
	deps.detectVersion = func(_ context.Context, command agent.Command) (string, error) {
		if command.Path == "/found/codex" {
			return "", errors.New("transient probe failure")
		}
		return "1.2.3", nil
	}
	deps.checkMinVersion = func(provider, version string) error {
		if provider == "openclaw" {
			return &agent.BelowMinimumError{AgentType: provider, Detected: version, Minimum: "2.0.0"}
		}
		return nil
	}

	got := newBridge("install-a", nil, deps).Refresh(context.Background())
	want := map[string]BridgeRuntimeStatus{
		"opencode": BridgeRuntimeReady,
		"openclaw": BridgeRuntimeNotRunnable,
		"codex":    BridgeRuntimeProbeFailed,
		"hermes":   BridgeRuntimeNotFound,
	}
	for provider, wantStatus := range want {
		runtime := runtimeByProvider(t, got, provider)
		if runtime.Status != wantStatus {
			t.Errorf("%s status = %q, want %q", provider, runtime.Status, wantStatus)
		}
		if runtime.Status == BridgeRuntimeNotFound {
			if runtime.ID != "" || runtime.Path != "" {
				t.Errorf("not_found runtime retained identity: %+v", runtime)
			}
		} else if runtime.ID == "" || runtime.Path == "" {
			t.Errorf("found runtime lost ID/path after failed validation: %+v", runtime)
		}
		if runtime.Status == BridgeRuntimeNeedsAuth {
			t.Errorf("discovery guessed needs_auth for %s", provider)
		}
	}
}

func TestBridgeRuntimeExecFormatIsFoundNotRunnable(t *testing.T) {
	path := "/found/codex"
	execErr := &os.PathError{Op: "fork/exec", Path: path, Err: syscall.ENOEXEC}
	if !agent.IsExecFormatError(execErr) {
		t.Fatalf("test fixture is not classified as an executable-format error: %v", execErr)
	}

	deps := bridgeTestDeps()
	deps.resolveAgentExecutablePath = func(command string) (string, error) {
		if command == "codex" {
			return path, nil
		}
		return "", errBridgeTestMissing
	}
	deps.detectVersion = func(context.Context, agent.Command) (string, error) {
		return "", execErr
	}

	runtime := runtimeByProvider(t, newBridge("install-a", nil, deps).Refresh(context.Background()), "codex")
	if runtime.Status != BridgeRuntimeNotRunnable {
		t.Fatalf("exec-format status = %q, want found_not_runnable", runtime.Status)
	}
	if runtime.ID == "" || runtime.Path != path {
		t.Fatalf("exec-format runtime lost found identity: %+v", runtime)
	}
}

func TestBridgeRuntimeInvalidAbsoluteOverrideDoesNotFallback(t *testing.T) {
	override := filepath.Join(t.TempDir(), "missing", "opencode")
	deps := bridgeTestDeps()
	deps.resolveAgentExecutablePath = func(command string) (string, error) {
		if command == "opencode" {
			t.Fatalf("invalid override fell back to %q", command)
		}
		return "", errBridgeTestMissing
	}
	deps.probeAgentCLIs = func() map[string]AgentEntry {
		return map[string]AgentEntry{"opencode": {Path: "/lower/opencode"}}
	}

	runtime := runtimeByProvider(t, newBridge("install-a", map[string]string{"opencode": override}, deps).Refresh(context.Background()), "opencode")
	if runtime.Status != BridgeRuntimeNotRunnable {
		t.Fatalf("invalid override status = %q, want found_not_runnable", runtime.Status)
	}
	if runtime.ID == "" || runtime.Path != override {
		t.Fatalf("invalid absolute override lost configured identity: %+v", runtime)
	}
}

func TestBridgeRuntimeStickyReadyPathSurvivesProbeFailureAndRediscover(t *testing.T) {
	v1, v2 := "/versions/opencode-v1", "/versions/opencode-v2"
	current := v1
	v1Present := true
	v1ProbeFails := false

	deps := bridgeTestDeps()
	deps.resolveAgentExecutablePath = func(command string) (string, error) {
		if command == "opencode" {
			return current, nil
		}
		return "", errBridgeTestMissing
	}
	deps.executablePresent = func(path string) bool {
		return path != v1 || v1Present
	}
	deps.detectVersion = func(_ context.Context, command agent.Command) (string, error) {
		if command.Path == v1 && v1ProbeFails {
			return "", errors.New("temporary timeout")
		}
		return "1.2.3", nil
	}

	bridge := newBridge("install-a", nil, deps)
	first := runtimeByProvider(t, bridge.Refresh(context.Background()), "opencode")
	current, v1ProbeFails = v2, true
	second := runtimeByProvider(t, bridge.Refresh(context.Background()), "opencode")
	if second.Status != BridgeRuntimeProbeFailed || second.Path != first.Path || second.ID != first.ID {
		t.Fatalf("transient failure replaced sticky runtime: first=%+v second=%+v", first, second)
	}

	v1Present = false
	third := runtimeByProvider(t, bridge.Refresh(context.Background()), "opencode")
	if third.Status != BridgeRuntimeReady || third.Path != v2 || third.ID == first.ID {
		t.Fatalf("missing sticky path did not rediscover: first=%+v third=%+v", first, third)
	}
}

func TestBridgeRuntimeProbesHaveBoundedConcurrencyAndTimeout(t *testing.T) {
	deps := bridgeTestDeps()
	deps.resolveAgentExecutablePath = func(command string) (string, error) {
		return "/found/" + command, nil
	}
	deps.probeTimeout = 20 * time.Millisecond
	deps.maxConcurrent = 2

	var active atomic.Int32
	var maximum atomic.Int32
	deps.detectVersion = func(ctx context.Context, _ agent.Command) (string, error) {
		current := active.Add(1)
		defer active.Add(-1)
		for old := maximum.Load(); current > old && !maximum.CompareAndSwap(old, current); old = maximum.Load() {
		}
		deadline, ok := ctx.Deadline()
		if !ok || time.Until(deadline) > 100*time.Millisecond {
			return "", errors.New("probe did not receive its short deadline")
		}
		<-ctx.Done()
		return "", ctx.Err()
	}

	started := time.Now()
	got := newBridge("install-a", nil, deps).Refresh(context.Background())
	if elapsed := time.Since(started); elapsed > 250*time.Millisecond {
		t.Fatalf("four timed probes took %v, want bounded two-wave completion", elapsed)
	}
	if maximum.Load() != 2 {
		t.Fatalf("maximum concurrent probes = %d, want 2", maximum.Load())
	}
	for _, runtime := range got {
		if runtime.Status != BridgeRuntimeProbeFailed {
			t.Errorf("%s status = %q, want probe_failed after timeout", runtime.Provider, runtime.Status)
		}
	}
}

func TestBridgeRuntimeRefreshIsSerialized(t *testing.T) {
	deps := bridgeTestDeps()
	deps.resolveAgentExecutablePath = func(command string) (string, error) {
		return "/found/" + command, nil
	}
	release := make(chan struct{})
	firstDiscovery := make(chan struct{})
	var once sync.Once
	var discoveryCalls atomic.Int32
	deps.probeAgentCLIs = func() map[string]AgentEntry {
		discoveryCalls.Add(1)
		once.Do(func() { close(firstDiscovery) })
		return map[string]AgentEntry{}
	}
	deps.detectVersion = func(context.Context, agent.Command) (string, error) {
		<-release
		return "1.2.3", nil
	}

	bridge := newBridge("install-a", nil, deps)
	done1, done2 := make(chan struct{}), make(chan struct{})
	go func() {
		bridge.Refresh(context.Background())
		close(done1)
	}()
	<-firstDiscovery
	go func() {
		bridge.Refresh(context.Background())
		close(done2)
	}()
	time.Sleep(50 * time.Millisecond)
	if discoveryCalls.Load() != 1 {
		close(release)
		t.Fatalf("concurrent Refresh entered discovery %d times before first completed", discoveryCalls.Load())
	}
	close(release)
	for i, done := range []chan struct{}{done1, done2} {
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatalf("Refresh %d did not finish", i+1)
		}
	}
}

func bridgeTestDeps() bridgeDeps {
	return bridgeDeps{
		probeAgentCLIs: func() map[string]AgentEntry { return map[string]AgentEntry{} },
		resolveAgentExecutablePath: func(string) (string, error) {
			return "", errBridgeTestMissing
		},
		canonicalExecutablePath: func(path string) string { return path },
		executablePresent:       func(string) bool { return true },
		detectVersion: func(context.Context, agent.Command) (string, error) {
			return "1.2.3", nil
		},
		checkMinVersion: func(string, string) error { return nil },
		probeTimeout:    time.Second,
		maxConcurrent:   2,
	}
}

func runtimeByProvider(t *testing.T, runtimes []BridgeRuntime, provider string) BridgeRuntime {
	t.Helper()
	for _, runtime := range runtimes {
		if runtime.Provider == provider {
			return runtime
		}
	}
	t.Fatalf("provider %q missing from runtimes: %+v", provider, runtimes)
	return BridgeRuntime{}
}

func TestBridgeRuntimeStatusJSONValues(t *testing.T) {
	got := []BridgeRuntimeStatus{
		BridgeRuntimeReady,
		BridgeRuntimeNeedsAuth,
		BridgeRuntimeNotRunnable,
		BridgeRuntimeNotFound,
		BridgeRuntimeProbeFailed,
	}
	want := []BridgeRuntimeStatus{"ready", "needs_auth", "found_not_runnable", "not_found", "probe_failed"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("status values = %q, want %q", got, want)
	}
}
