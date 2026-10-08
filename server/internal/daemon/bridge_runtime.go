package daemon

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"path/filepath"
	"strings"
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
	InteractiveRounds bool `json:"interactive_rounds,omitempty"`
	SessionResume     bool `json:"session_resume"`
	Cancel            bool `json:"cancel"`
	TextEvents        bool `json:"text_events"`
	ToolEvents        bool `json:"tool_events"`
	ApprovalEvents    bool `json:"approval_events"`
}

type BridgeRuntime struct {
	InteractiveUnavailableReason string                    `json:"interactive_unavailable_reason,omitempty"`
	ID                           string                    `json:"id,omitempty"`
	Provider                     string                    `json:"provider"`
	Version                      string                    `json:"version,omitempty"`
	Path                         string                    `json:"path,omitempty"`
	Status                       BridgeRuntimeStatus       `json:"status"`
	Capabilities                 BridgeRuntimeCapabilities `json:"capabilities"`
}

const (
	// bridgeRuntimeCount is derived from bridgeRuntimeSpecs so the catalog
	// tracks its declaration; the fixed-size array layout is preserved.
	bridgeRuntimeCount            = len(bridgeRuntimeSpecs)
	defaultBridgeProbeConcurrency = 2
	// Must exceed agent.InteractiveProbeTimeout: the interactive proof runs
	// inside this budget, after version detection has already spent part of it,
	// so an outer bound below the inner one makes the proof unreachable.
	defaultBridgeProbeTimeout = 60 * time.Second
)

type bridgeRuntimeSpec struct {
	provider string
	command  string
	// interactiveUnavailableReason is reported while the runtime is ready but
	// interactive rounds have not been probe-verified. Empty means the generic
	// default ("%s requires verified cancellation, session resume and text
	// events").
	interactiveUnavailableReason string
	capabilities                 BridgeRuntimeCapabilities
}

// bridgeRuntimeSpecs is the single declaration of the providers exposed in
// the bridge runtime catalog. Capabilities come from agent.Capabilities so
// protocol capability declarations stay in the agent package; per-provider
// interactive-probe requirements live next to each entry. Add a
// backendCapabilities entry (pkg/agent/capabilities.go) before adding a
// provider here.
var bridgeRuntimeSpecs = [...]bridgeRuntimeSpec{
	{provider: "opencode", command: "opencode", interactiveUnavailableReason: "opencode requires ACP protocol 1 with advertised session resume support", capabilities: bridgeRuntimeCapabilitiesFromAgent("opencode")},
	{provider: "openclaw", command: "openclaw", interactiveUnavailableReason: "openclaw requires protocol 4 Gateway, exact read/write scopes, session create/patch/resolve, chat send/abort/history and chat events", capabilities: bridgeRuntimeCapabilitiesFromAgent("openclaw")},
	{provider: "codex", command: "codex", capabilities: bridgeRuntimeCapabilitiesFromAgent("codex")},
	{provider: "hermes", command: "hermes", interactiveUnavailableReason: "hermes requires ACP protocol 1 with advertised session resume support", capabilities: bridgeRuntimeCapabilitiesFromAgent("hermes")},
	// Tier 1 expansion providers (provider-expansion-plan.md §2.2). All run
	// non-interactive probes; interactive rounds stay off until the
	// interactive probe supports them.
	{provider: "claude", command: "claude", capabilities: bridgeRuntimeCapabilitiesFromAgent("claude")},
	{provider: "copilot", command: "copilot", capabilities: bridgeRuntimeCapabilitiesFromAgent("copilot")},
	{provider: "grok", command: "grok", capabilities: bridgeRuntimeCapabilitiesFromAgent("grok")},
	{provider: "qwen", command: "qwen", capabilities: bridgeRuntimeCapabilitiesFromAgent("qwen")},
	{provider: "dim", command: "dim", capabilities: bridgeRuntimeCapabilitiesFromAgent("dim")},
	{provider: "mcode", command: "mcode", capabilities: bridgeRuntimeCapabilitiesFromAgent("mcode")},
	{provider: "zeroclaw", command: "zeroclaw", capabilities: bridgeRuntimeCapabilitiesFromAgent("zeroclaw")},
}

// bridgeRuntimeCapabilitiesFromAgent projects the agent package capability
// declaration into the wire-facing bridge capabilities. InteractiveRounds and
// ApprovalEvents stay false: the former is probe-derived, the latter is not
// supported by the bridge protocol.
func bridgeRuntimeCapabilitiesFromAgent(provider string) BridgeRuntimeCapabilities {
	caps := agent.Capabilities(provider)
	return BridgeRuntimeCapabilities{
		SessionResume: caps.SessionResume,
		Cancel:        caps.Cancel,
		TextEvents:    caps.TextEvents,
		ToolEvents:    caps.ToolEvents,
	}
}

// validateBridgeRuntimeSpecs guards the catalog declaration at construction
// time: providers must be declared, unique, and backed by an explicit
// backendCapabilities entry so no catalog entry silently advertises nothing.
func validateBridgeRuntimeSpecs() {
	if len(bridgeRuntimeSpecs) == 0 {
		panic("daemon: bridgeRuntimeSpecs must declare at least one provider")
	}
	seen := make(map[string]struct{}, len(bridgeRuntimeSpecs))
	for _, spec := range bridgeRuntimeSpecs {
		if spec.provider == "" {
			panic("daemon: bridgeRuntimeSpecs entry with empty provider")
		}
		if _, dup := seen[spec.provider]; dup {
			panic("daemon: duplicate bridge runtime provider " + spec.provider)
		}
		seen[spec.provider] = struct{}{}
		if !agent.HasDeclaredCapabilities(spec.provider) {
			panic("daemon: bridge runtime provider " + spec.provider + " lacks a pkg/agent backendCapabilities entry")
		}
	}
}

// BridgeRuntimeProviders returns the catalog providers in declaration order.
// Callers use it to derive provider whitelists instead of hardcoding them.
func BridgeRuntimeProviders() []string {
	providers := make([]string, 0, len(bridgeRuntimeSpecs))
	for _, spec := range bridgeRuntimeSpecs {
		providers = append(providers, spec.provider)
	}
	return providers
}

type bridgeDeps struct {
	probeInteractive           func(context.Context, string, agent.Command, string) (bool, error)
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
		probeInteractive:           agent.ProbeInteractiveRuntime,
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
	if strings.TrimSpace(version) == "" {
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
	runtime.InteractiveUnavailableReason = spec.interactiveUnavailableReason
	if runtime.InteractiveUnavailableReason == "" {
		runtime.InteractiveUnavailableReason = spec.provider + " requires verified cancellation, session resume and text events"
	}
	if b.deps.probeInteractive != nil {
		proof, err := b.deps.probeInteractive(probeCtx, spec.provider, agent.NewCommand(candidate.launchPath, nil), version)
		if err == nil && proof {
			runtime.InteractiveUnavailableReason = ""
			runtime.Capabilities.InteractiveRounds = true
			runtime.Capabilities.SessionResume = true
			runtime.Capabilities.Cancel = true
			runtime.Capabilities.TextEvents = true
		}
	}
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
