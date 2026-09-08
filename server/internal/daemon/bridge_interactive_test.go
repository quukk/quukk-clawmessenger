package daemon

import (
	"context"
	"errors"
	"github.com/multica-ai/multica/server/pkg/agent"
	"testing"
)

func TestBridgeInteractiveCapabilityRequiresRuntimeProof(t *testing.T) {
	deps := bridgeTestDeps()
	deps.resolveAgentExecutablePath = func(command string) (string, error) { return "D:/fake/" + command + ".exe", nil }
	deps.probeInteractive = func(_ context.Context, provider string, _ agent.Command, _ string) (bool, error) {
		if provider == "hermes" {
			return false, errors.New("unknown")
		}
		return true, nil
	}
	runtimes := newBridge("test", nil, deps).Refresh(context.Background())
	for _, runtime := range runtimes {
		want := runtime.Provider != "hermes"
		if runtime.Capabilities.InteractiveRounds != want {
			t.Fatalf("%s proof=%v", runtime.Provider, runtime.Capabilities.InteractiveRounds)
		}
		if !want && runtime.InteractiveUnavailableReason == "" {
			t.Fatal("unavailable runtime has no actionable protocol reason")
		}
		if want && (!runtime.Capabilities.TextEvents || !runtime.Capabilities.Cancel || !runtime.Capabilities.SessionResume) {
			t.Fatalf("contradictory evidence %+v", runtime)
		}
	}
}
