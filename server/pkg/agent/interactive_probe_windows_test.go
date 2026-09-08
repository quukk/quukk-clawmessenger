//go:build windows

package agent

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestInteractiveWindowsProbeRejectsUnownedSuspendedChild(t *testing.T) {
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(self)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "probe-fixture.exe")
	if err := os.WriteFile(path, data, 0700); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(t.TempDir(), "started")
	t.Setenv("MULTICA_INTERACTIVE_PROBE_FIXTURE", "1")
	t.Setenv("MULTICA_INTERACTIVE_PROBE_STARTED_MARKER", marker)
	t.Setenv("MULTICA_INTERACTIVE_PROBE_REPLY", `{"protocolVersion":1,"agentCapabilities":{"loadSession":true}}`)
	var child *exec.Cmd
	available, err := probeInteractiveRuntime(t.Context(), "opencode", NewCommand(path, nil), "1.0.0", processTreeStartOptions{takeOwnership: func(cmd *exec.Cmd) error { child = cmd; return errors.New("injected job assignment denied") }})
	if err == nil || available {
		t.Fatalf("unowned capability: %v %v", available, err)
	}
	if child == nil || child.ProcessState == nil {
		t.Fatal("suspended direct child was not reaped")
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("unowned child executed: %v", err)
	}
	if _, ok := lookupProcessTree(child); ok {
		t.Fatal("failed launch retained job ownership")
	}
}
