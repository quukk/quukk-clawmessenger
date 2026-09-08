//go:build windows

package agent

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
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

func TestInteractiveWindowsLaunchRejectsUnownedChild(t *testing.T) {
	for _, provider := range []string{"codex", "opencode", "hermes"} {
		t.Run(provider, func(t *testing.T) {
			cfg := interactiveProcessConfig(t, "initialize")
			var child *exec.Cmd
			cfg.processTreeOptions.takeOwnership = func(cmd *exec.Cmd) error { child = cmd; return errors.New("injected ownership denied") }
			backend, err := New(provider, cfg)
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
			defer cancel()
			session, err := backend.Execute(ctx, "fixture", ExecOptions{RequireProcessTree: true, StreamText: true, Cwd: t.TempDir()})
			if session != nil {
				for range session.Messages {
				}
				<-session.Result
			}
			if err == nil || !strings.Contains(err.Error(), "required process tree ownership") {
				t.Fatalf("unowned launch accepted: %v", err)
			}
			if child == nil || child.ProcessState == nil {
				t.Fatal("suspended child not reaped")
			}
			if _, err := os.Stat(cfg.Env["MULTICA_PROCESS_MARKER"]); !os.IsNotExist(err) {
				t.Fatal("unowned child ran")
			}
		})
	}
}

func TestInteractiveWindowsLaunchCleanupFailure(t *testing.T) {
	for _, provider := range []string{"codex", "opencode", "hermes"} {
		t.Run(provider, func(t *testing.T) {
			cfg := interactiveProcessConfig(t, "initialize")
			cfg.processTreeOptions.takeOwnership = func(*exec.Cmd) error { return errors.New("injected assignment failure") }
			cfg.processTreeOptions.stopSuspended = func(cmd *exec.Cmd) error {
				_ = cmd.Process.Kill()
				_ = cmd.Wait()
				if cmd.ProcessState == nil {
					t.Fatal("fixture not reaped")
				}
				return errors.New("injected reap proof failure")
			}
			backend, err := New(provider, cfg)
			if err != nil {
				t.Fatal(err)
			}
			_, err = backend.Execute(t.Context(), "fixture", ExecOptions{RequireProcessTree: true, StreamText: true, Cwd: t.TempDir()})
			if !errors.Is(err, ErrProcessTreeStopUnconfirmed) {
				t.Fatalf("failed start lost cleanup uncertainty: %v", err)
			}
		})
	}
}

func TestInteractiveWindowsResumeFailureRequiresTreeProof(t *testing.T) {
	cfg := interactiveProcessConfig(t, "initialize")
	cfg.processTreeOptions.resume = func(pid int) error {
		if err := resumeProcess(pid); err != nil {
			return err
		}
		return errors.New("injected partial resume failure")
	}
	checked := false
	cfg.processTreeOptions.waitStopped = func(cmd *exec.Cmd, timeout time.Duration) bool {
		checked = true
		if !waitProcessGroupGone(cmd, timeout) {
			t.Error("owned fixture was not killed")
		}
		return false
	}
	backend, err := New("hermes", cfg)
	if err != nil {
		t.Fatal(err)
	}
	session, err := backend.Execute(t.Context(), "fixture", ExecOptions{RequireProcessTree: true, Cwd: t.TempDir()})
	if session != nil {
		for range session.Messages {
		}
		<-session.Result
	}
	if !checked || !errors.Is(err, ErrProcessTreeStopUnconfirmed) {
		t.Fatalf("resume failed without tree proof: checked=%v err=%v", checked, err)
	}
}

func TestInteractiveWindowsLegacyLaunchRemainsPermissive(t *testing.T) {
	for _, provider := range []string{"codex", "opencode", "hermes"} {
		t.Run(provider, func(t *testing.T) {
			cfg := interactiveProcessConfig(t, "initialize")
			cfg.processTreeOptions.takeOwnership = func(*exec.Cmd) error { return errors.New("injected assignment failure") }
			backend, err := New(provider, cfg)
			if err != nil {
				t.Fatal(err)
			}
			session, err := backend.Execute(t.Context(), "fixture", ExecOptions{StreamText: true, Cwd: t.TempDir(), Timeout: 3 * time.Second})
			if err != nil {
				t.Fatalf("legacy launch rejected: %v", err)
			}
			for range session.Messages {
			}
			if result := <-session.Result; result.CancelUnconfirmed {
				t.Fatalf("legacy result changed: %+v", result)
			}
			if _, err := os.Stat(cfg.Env["MULTICA_PROCESS_MARKER"]); err != nil {
				t.Fatal("legacy fixture did not execute")
			}
		})
	}
}
