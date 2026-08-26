package daemon

import "sync"

// Bridge owns local ClawMessenger runtime discovery independently from the
// existing daemon Run lifecycle.
type Bridge struct {
	installID string
	overrides map[string]string
	deps      bridgeDeps

	refreshMu sync.Mutex
	runtimeMu sync.RWMutex
	runtimes  [bridgeRuntimeCount]bridgeRuntimeRecord
}

func newBridge(installID string, overrides map[string]string, deps bridgeDeps) *Bridge {
	if deps.probeTimeout <= 0 {
		deps.probeTimeout = defaultBridgeProbeTimeout
	}
	if deps.maxConcurrent <= 0 {
		deps.maxConcurrent = defaultBridgeProbeConcurrency
	}
	b := &Bridge{
		installID: installID,
		overrides: make(map[string]string, len(overrides)),
		deps:      deps,
	}
	for provider, path := range overrides {
		b.overrides[provider] = path
	}
	for i, spec := range bridgeRuntimeSpecs {
		b.runtimes[i].runtime = BridgeRuntime{
			Provider:     spec.provider,
			Status:       BridgeRuntimeNotFound,
			Capabilities: spec.capabilities,
		}
	}
	return b
}

func newDefaultBridge(installID string, overrides map[string]string) *Bridge {
	return newBridge(installID, overrides, defaultBridgeDeps())
}

// Runtimes returns a snapshot callers may mutate without changing Bridge
// state.
func (b *Bridge) Runtimes() []BridgeRuntime {
	b.runtimeMu.RLock()
	defer b.runtimeMu.RUnlock()
	runtimes := make([]BridgeRuntime, bridgeRuntimeCount)
	for i := range b.runtimes {
		runtimes[i] = b.runtimes[i].runtime
	}
	return runtimes
}
