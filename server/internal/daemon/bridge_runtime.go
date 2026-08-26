package daemon

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"path/filepath"
	"sync"
	"time"

	"github.com/multica-ai/multica/server/pkg/agent"
)

type BridgeRuntimeStatus string

const (
	BridgeRuntimeReady       BridgeRuntimeStatus = "ready"
	BridgeRuntimeNeedsAuth   BridgeRuntimeStatus = "needs_auth"
	BridgeRuntimeNotRunnable BridgeRuntimeStatus = "found_not_runnable"
	BridgeRuntimeNotFound    BridgeRuntimeStatus = "not_found"
	BridgeRuntimeProbeFailed BridgeRuntimeStatus = "probe_failed"
)

type BridgeRuntimeCapabilities struct {
	SessionResume  bool `json:"session_resume"`
	Cancel         bool `json:"cancel"`
	TextEvents     bool `json:"text_events"`
	ToolEvents     bool `json:"tool_events"`
	ApprovalEvents bool `json:"approval_events"`
}

type BridgeRuntime struct {
	ID           string                    `json:"id,omitempty"`
	Provider     string                    `json:"provider"`
	Version      string                    `json:"version,omitempty"`
	Path         string                    `json:"path,omitempty"`
	Status       BridgeRuntimeStatus       `json:"status"`
	Capabilities BridgeRuntimeCapabilities `json:"capabilities"`
}

const (
	bridgeRuntimeCount            = 4
	defaultBridgeProbeConcurrency = 2
	defaultBridgeProbeTimeout     = 10 * time.Second
)

type bridgeRuntimeSpec struct {
	provider     string
	command      string
	capabilities BridgeRuntimeCapabilities
}

var bridgeRuntimeSpecs = [bridgeRuntimeCount]bridgeRuntimeSpec{
	{provider: "opencode", command: "opencode", capabilities: BridgeRuntimeCapabilities{SessionResume: true, Cancel: true, TextEvents: true, ToolEvents: true}},
	{provider: "openclaw", command: "openclaw", capabilities: BridgeRuntimeCapabilities{SessionResume: true, Cancel: true}},
	{provider: "codex", command: "codex", capabilities: BridgeRuntimeCapabilities{SessionResume: true, Cancel: true, TextEvents: true, ToolEvents: true}},
	{provider: "hermes", command: "hermes", capabilities: BridgeRuntimeCapabilities{SessionResume: true, Cancel: true, TextEvents: true, ToolEvents: true}},
}

type bridgeDeps struct {
	probeAgentCLIs             func() map[string]AgentEntry
	resolveAgentExecutablePath func(string) (string, error)
	canonicalExecutablePath    func(string) string
	executablePresent          func(string) bool
	detectVersion              func(context.Context, agent.Command) (string, error)
	checkMinVersion            func(string, string) error
	probeTimeout               time.Duration
	maxConcurrent              int
}

func defaultBridgeDeps() bridgeDeps {
	return bridgeDeps{
		probeAgentCLIs:             probeAgentCLIs,
		resolveAgentExecutablePath: resolveAgentExecutablePath,
		canonicalExecutablePath:    canonicalExecutablePath,
		executablePresent:          agentExecutablePresent,
		detectVersion:              agent.DetectVersion,
		checkMinVersion:            agent.CheckMinVersion,
		probeTimeout:               defaultBridgeProbeTimeout,
		maxConcurrent:              defaultBridgeProbeConcurrency,
	}
}

type bridgeRuntimeRecord struct {
	runtime       BridgeRuntime
	canonicalPath string
	sticky        bool
}

type bridgeRuntimeCandidate struct {
	launchPath      string
	canonicalPath   string
	previousVersion string
	sticky          bool
	status          BridgeRuntimeStatus
}

// Refresh discovers candidates once, probes providers with bounded
// concurrency, and atomically publishes the fixed provider indexes.
func (b *Bridge) Refresh(ctx context.Context) []BridgeRuntime {
	b.refreshMu.Lock()
	defer b.refreshMu.Unlock()

	discovered := b.deps.probeAgentCLIs()
	b.runtimeMu.RLock()
	previous := b.runtimes
	b.runtimeMu.RUnlock()

	var candidates [bridgeRuntimeCount]bridgeRuntimeCandidate
	var runtimes [bridgeRuntimeCount]BridgeRuntime
	for i, spec := range bridgeRuntimeSpecs {
		candidates[i] = b.runtimeCandidate(spec, previous[i], discovered)
		if candidates[i].status != "" {
			runtimes[i] = b.runtimeFromCandidate(spec, candidates[i], candidates[i].status)
		}
	}

	sem := make(chan struct{}, b.deps.maxConcurrent)
	var wg sync.WaitGroup
	for i, spec := range bridgeRuntimeSpecs {
		if candidates[i].status != "" {
			continue
		}
		wg.Add(1)
		go func(i int, spec bridgeRuntimeSpec) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
				defer func() { <-sem }()
			case <-ctx.Done():
				runtimes[i] = b.runtimeFromCandidate(spec, candidates[i], BridgeRuntimeProbeFailed)
				return
			}
			runtimes[i] = b.probeRuntime(ctx, spec, candidates[i])
		}(i, spec)
	}
	wg.Wait()

	b.runtimeMu.Lock()
	for i := range b.runtimes {
		b.runtimes[i] = bridgeRuntimeRecord{
			runtime:       runtimes[i],
			canonicalPath: candidates[i].canonicalPath,
			sticky:        runtimes[i].Status == BridgeRuntimeReady || candidates[i].sticky,
		}
	}
	b.runtimeMu.Unlock()
	return b.Runtimes()
}

func (b *Bridge) runtimeCandidate(spec bridgeRuntimeSpec, previous bridgeRuntimeRecord, discovered map[string]AgentEntry) bridgeRuntimeCandidate {
	if override := b.overrides[spec.provider]; override != "" {
		candidate := bridgeRuntimeCandidate{launchPath: override}
		if !filepath.IsAbs(override) {
			candidate.canonicalPath = b.deps.canonicalExecutablePath(override)
			candidate.status = BridgeRuntimeNotRunnable
			return candidate
		}
		resolved, err := b.deps.resolveAgentExecutablePath(override)
		if err != nil {
			candidate.canonicalPath = b.deps.canonicalExecutablePath(override)
			candidate.status = BridgeRuntimeNotRunnable
			return candidate
		}
		candidate.launchPath = resolved
		candidate.canonicalPath = b.deps.canonicalExecutablePath(resolved)
		return candidate
	}

	if previous.sticky && b.deps.executablePresent(previous.runtime.Path) {
		return bridgeRuntimeCandidate{
			launchPath:      previous.runtime.Path,
			canonicalPath:   previous.canonicalPath,
			previousVersion: previous.runtime.Version,
			sticky:          true,
		}
	}

	if path, err := b.deps.resolveAgentExecutablePath(spec.command); err == nil {
		return bridgeRuntimeCandidate{
			launchPath:    path,
			canonicalPath: b.deps.canonicalExecutablePath(path),
		}
	}
	if entry, ok := discovered[spec.provider]; ok && entry.Path != "" {
		return bridgeRuntimeCandidate{
			launchPath:    entry.Path,
			canonicalPath: b.deps.canonicalExecutablePath(entry.Path),
		}
	}
	return bridgeRuntimeCandidate{status: BridgeRuntimeNotFound}
}

func (b *Bridge) probeRuntime(ctx context.Context, spec bridgeRuntimeSpec, candidate bridgeRuntimeCandidate) BridgeRuntime {
	runtime := b.runtimeFromCandidate(spec, candidate, BridgeRuntimeProbeFailed)
	runtime.Version = candidate.previousVersion
	probeCtx, cancel := context.WithTimeout(ctx, b.deps.probeTimeout)
	defer cancel()
	version, err := b.deps.detectVersion(probeCtx, agent.NewCommand(candidate.launchPath, nil))
	if err != nil {
		if agent.IsExecFormatError(err) {
			runtime.Status = BridgeRuntimeNotRunnable
		}
		return runtime
	}
	runtime.Version = version
	if err := b.deps.checkMinVersion(spec.provider, version); err != nil {
		var belowMinimum *agent.BelowMinimumError
		if errors.As(err, &belowMinimum) {
			runtime.Status = BridgeRuntimeNotRunnable
		}
		return runtime
	}
	runtime.Status = BridgeRuntimeReady
	return runtime
}

func (b *Bridge) runtimeFromCandidate(spec bridgeRuntimeSpec, candidate bridgeRuntimeCandidate, status BridgeRuntimeStatus) BridgeRuntime {
	runtime := BridgeRuntime{
		Provider:     spec.provider,
		Path:         candidate.launchPath,
		Status:       status,
		Capabilities: spec.capabilities,
	}
	if candidate.canonicalPath != "" {
		runtime.ID = bridgeRuntimeID(b.installID, spec.provider, candidate.canonicalPath)
	}
	return runtime
}

func bridgeRuntimeID(installID, provider, canonicalExecutablePath string) string {
	digest := sha256.Sum256([]byte(installID + "\x00" + provider + "\x00" + canonicalExecutablePath))
	return "rt_" + hex.EncodeToString(digest[:16])
}
