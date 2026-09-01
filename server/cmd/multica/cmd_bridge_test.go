package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/daemon"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

const (
	bridgeCommandTestSecret  = "SENSITIVE_BRIDGE_SECRET"
	bridgeCommandTestInstall = "SENSITIVE_INSTALL_ID"
)

type bridgeCommandFakeAddr string

func (a bridgeCommandFakeAddr) Network() string { return "tcp" }
func (a bridgeCommandFakeAddr) String() string  { return string(a) }

type bridgeCommandFakeListener struct {
	addr       net.Addr
	closeCalls atomic.Int32
}

func (l *bridgeCommandFakeListener) Accept() (net.Conn, error) {
	return nil, errors.New("fake listener does not accept")
}
func (l *bridgeCommandFakeListener) Close() error {
	l.closeCalls.Add(1)
	return nil
}
func (l *bridgeCommandFakeListener) Addr() net.Addr { return l.addr }

func bridgeCommandValidInput(providerOverrides any) string {
	value := map[string]any{
		"secret":     bridgeCommandTestSecret,
		"install_id": bridgeCommandTestInstall,
		"version":    version,
	}
	if providerOverrides != nil {
		value["provider_path_overrides"] = providerOverrides
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return string(encoded)
}

func bridgeCommandExecute(t *testing.T, deps bridgeCommandDeps, input string, args ...string) (string, error) {
	t.Helper()
	command := newBridgeCommand(deps)
	command.SetIn(strings.NewReader(input))
	var stdout bytes.Buffer
	command.SetOut(&stdout)
	command.SetErr(io.Discard)
	command.SetArgs(args)
	err := command.ExecuteContext(context.Background())
	return stdout.String(), err
}

func TestBridgeCommandMetadataIsHiddenAndFlagless(t *testing.T) {
	command := newBridgeCommand(bridgeCommandDeps{})
	if command.Use != "bridge" || !command.Hidden {
		t.Fatalf("command metadata = Use %q Hidden %v", command.Use, command.Hidden)
	}
	flagCount := 0
	command.LocalNonPersistentFlags().VisitAll(func(_ *pflag.Flag) { flagCount++ })
	if flagCount != 0 {
		t.Fatalf("local flag count = %d, want 0", flagCount)
	}
}

func TestBridgeCommandBindsFixedLoopbackAndPrintsOneSharedReadinessLine(t *testing.T) {
	listener := &bridgeCommandFakeListener{addr: bridgeCommandFakeAddr("127.0.0.1:49152")}
	randomBytes := make([]byte, 16)
	for i := range randomBytes {
		randomBytes[i] = byte(i)
	}
	now := time.Date(2026, 8, 26, 16, 0, 0, 123, time.FixedZone("UTC+8", 8*60*60))
	var network, address string
	pidCalls := 0
	serveCalls := 0
	input := bridgeCommandValidInput(map[string]string{
		"opencode": `C:\tools\opencode.exe`,
		"openclaw": `C:\tools\openclaw.exe`,
		"codex":    `C:\tools\codex.exe`,
		"hermes":   `C:\tools\hermes.exe`,
	})
	var stdout bytes.Buffer
	deps := bridgeCommandDeps{
		listen: func(gotNetwork, gotAddress string) (net.Listener, error) {
			network, address = gotNetwork, gotAddress
			return listener, nil
		},
		now: func() time.Time { return now },
		pid: func() int {
			pidCalls++
			return 1234
		},
		random: bytes.NewReader(randomBytes),
		serve: func(ctx context.Context, gotListener net.Listener, cfg daemon.BridgeHTTPConfig) error {
			serveCalls++
			if stdout.Len() != 0 {
				t.Fatalf("stdout before initial refresh readiness = %q", stdout.String())
			}
			if ctx == nil || ctx.Err() != nil {
				t.Fatalf("invalid command-lifetime root: %v", ctx)
			}
			if gotListener != listener {
				t.Fatal("ServeBridgeHTTP received a different listener")
			}
			if cfg.Secret != bridgeCommandTestSecret || cfg.InstallID != bridgeCommandTestInstall || cfg.Version != version {
				t.Fatalf("serve config identity/version mismatch: %#v", cfg)
			}
			if cfg.PID != 1234 || cfg.InstanceID != "br_000102030405060708090a0b0c0d0e0f" || !cfg.StartedAt.Equal(now.UTC()) || cfg.StartedAt.Location() != time.UTC {
				t.Fatalf("serve process identity mismatch: %#v", cfg)
			}
			if cfg.ProviderPathOverrides["opencode"] != `C:\tools\opencode.exe` || cfg.ProviderPathOverrides["hermes"] != `C:\tools\hermes.exe` {
				t.Fatalf("provider overrides changed: %#v", cfg.ProviderPathOverrides)
			}
			if err := cfg.Ready(); err != nil {
				return err
			}
			return nil
		},
	}
	command := newBridgeCommand(deps)
	command.SetIn(strings.NewReader(input))
	command.SetOut(&stdout)
	command.SetErr(io.Discard)
	command.SetArgs(nil)
	if err := command.ExecuteContext(context.Background()); err != nil {
		t.Fatal(err)
	}
	if network != "tcp4" || address != "127.0.0.1:0" {
		t.Fatalf("listen arguments = %q %q", network, address)
	}
	if pidCalls != 1 || serveCalls != 1 {
		t.Fatalf("pid calls = %d, serve calls = %d", pidCalls, serveCalls)
	}
	want := fmt.Sprintf("{\"address\":\"127.0.0.1:49152\",\"pid\":1234,\"version\":%q,\"instance_id\":\"br_000102030405060708090a0b0c0d0e0f\",\"started_at\":\"2026-08-26T08:00:00.000000123Z\"}\n", version)
	if got := stdout.String(); got != want {
		t.Fatalf("readiness = %q, want %q", got, want)
	}
	if strings.Count(stdout.String(), "\n") != 1 {
		t.Fatalf("readiness line count != 1: %q", stdout.String())
	}
	for _, sentinel := range []string{bridgeCommandTestSecret, bridgeCommandTestInstall, `C:\tools\opencode.exe`, "prompt-sentinel", "environment-sentinel"} {
		if strings.Contains(stdout.String(), sentinel) {
			t.Fatalf("readiness leaked %q", sentinel)
		}
	}
	if listener.closeCalls.Load() != 1 {
		t.Fatalf("listener close calls = %d, want 1", listener.closeCalls.Load())
	}
}

func TestBridgeCommandStrictStartupValidationRunsBeforeListen(t *testing.T) {
	valid := bridgeCommandValidInput(map[string]string{"opencode": "provider-path-sentinel"})
	tests := []struct {
		name  string
		input string
		args  []string
	}{
		{"empty", "", nil},
		{"malformed", "{", nil},
		{"unknown field", strings.TrimSuffix(valid, "}") + `,"unknown":true}`, nil},
		{"trailing object", valid + `{}`, nil},
		{"pinned runtimes rejected", strings.TrimSuffix(valid, "}") + `,"pinned_runtime_paths":{}}`, nil},
		{"missing secret", fmt.Sprintf(`{"install_id":"i","version":%q}`, version), nil},
		{"empty secret", fmt.Sprintf(`{"secret":"","install_id":"i","version":%q}`, version), nil},
		{"leading secret whitespace", fmt.Sprintf(`{"secret":" %s","install_id":"i","version":%q}`, bridgeCommandTestSecret, version), nil},
		{"trailing install whitespace", fmt.Sprintf(`{"secret":"s","install_id":"i ","version":%q}`, version), nil},
		{"whitespace version", `{"secret":"s","install_id":"i","version":" dev"}`, nil},
		{"version mismatch", `{"secret":"s","install_id":"i","version":"definitely-not-compiled"}`, nil},
		{"unknown provider", fmt.Sprintf(`{"secret":"s","install_id":"i","version":%q,"provider_path_overrides":{"claude":"x"}}`, version), nil},
		{"positional argument", valid, []string{bridgeCommandTestSecret}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			listenCalls := 0
			serveCalls := 0
			deps := bridgeCommandDeps{
				listen: func(string, string) (net.Listener, error) {
					listenCalls++
					return &bridgeCommandFakeListener{addr: bridgeCommandFakeAddr("127.0.0.1:1")}, nil
				},
				now:    time.Now,
				pid:    func() int { return 1 },
				random: bytes.NewReader(make([]byte, 16)),
				serve: func(context.Context, net.Listener, daemon.BridgeHTTPConfig) error {
					serveCalls++
					return nil
				},
			}
			stdout, err := bridgeCommandExecute(t, deps, tt.input, tt.args...)
			if err == nil {
				t.Fatal("invalid startup input succeeded")
			}
			if stdout != "" || listenCalls != 0 || serveCalls != 0 {
				t.Fatalf("invalid input side effects: stdout=%q listen=%d serve=%d", stdout, listenCalls, serveCalls)
			}
			for _, sentinel := range []string{bridgeCommandTestSecret, bridgeCommandTestInstall, "provider-path-sentinel"} {
				if strings.Contains(err.Error(), sentinel) {
					t.Fatalf("validation error leaked %q: %v", sentinel, err)
				}
			}
		})
	}
}

func TestBridgeCommandAcceptsOnlySupportedProviderOverrideShapes(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  map[string]string
	}{
		{"absent", fmt.Sprintf(`{"secret":"s","install_id":"i","version":%q}`, version), nil},
		{"null", fmt.Sprintf(`{"secret":"s","install_id":"i","version":%q,"provider_path_overrides":null}`, version), nil},
		{"empty", fmt.Sprintf(`{"secret":"s","install_id":"i","version":%q,"provider_path_overrides":{}}`, version), map[string]string{}},
		{"all four unchanged", fmt.Sprintf(`{"secret":"s","install_id":"i","version":%q,"provider_path_overrides":{"opencode":" open ","openclaw":"claw","codex":"codex","hermes":"hermes"}}`, version), map[string]string{"opencode": " open ", "openclaw": "claw", "codex": "codex", "hermes": "hermes"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			listener := &bridgeCommandFakeListener{addr: bridgeCommandFakeAddr("127.0.0.1:2")}
			deps := bridgeCommandDeps{
				listen: func(string, string) (net.Listener, error) { return listener, nil },
				now:    func() time.Time { return time.Unix(0, 0).UTC() },
				pid:    func() int { return 1 },
				random: bytes.NewReader(make([]byte, 16)),
				serve: func(_ context.Context, _ net.Listener, cfg daemon.BridgeHTTPConfig) error {
					if !mapsEqual(cfg.ProviderPathOverrides, tt.want) {
						t.Fatalf("overrides = %#v, want %#v", cfg.ProviderPathOverrides, tt.want)
					}
					return cfg.Ready()
				},
			}
			if _, err := bridgeCommandExecute(t, deps, tt.input); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestBridgeCommandStartupInputBoundary(t *testing.T) {
	exact := bridgeCommandInputOfSize(t, 65_536)
	listener := &bridgeCommandFakeListener{addr: bridgeCommandFakeAddr("127.0.0.1:3")}
	listenCalls := 0
	deps := bridgeCommandDeps{
		listen: func(string, string) (net.Listener, error) {
			listenCalls++
			return listener, nil
		},
		now:    func() time.Time { return time.Unix(0, 0).UTC() },
		pid:    func() int { return 1 },
		random: bytes.NewReader(make([]byte, 16)),
		serve: func(_ context.Context, _ net.Listener, cfg daemon.BridgeHTTPConfig) error {
			return cfg.Ready()
		},
	}
	stdout, err := bridgeCommandExecute(t, deps, exact)
	if err != nil || listenCalls != 1 || strings.Count(stdout, "\n") != 1 {
		t.Fatalf("exact boundary result: err=%v listen=%d stdout=%q", err, listenCalls, stdout)
	}

	listenCalls = 0
	stdout, err = bridgeCommandExecute(t, deps, exact+" ")
	if err == nil || listenCalls != 0 || stdout != "" {
		t.Fatalf("overflow boundary result: err=%v listen=%d stdout=%q", err, listenCalls, stdout)
	}
}

func TestBridgeCommandPreServeFailuresPrintNoReadinessAndCloseBoundListener(t *testing.T) {
	t.Run("randomness", func(t *testing.T) {
		listenCalls := 0
		deps := bridgeCommandDeps{
			listen: func(string, string) (net.Listener, error) {
				listenCalls++
				return nil, nil
			},
			now:    time.Now,
			pid:    func() int { return 1 },
			random: errorReader{},
			serve:  func(context.Context, net.Listener, daemon.BridgeHTTPConfig) error { return nil },
		}
		stdout, err := bridgeCommandExecute(t, deps, bridgeCommandValidInput(nil))
		if err == nil || stdout != "" || listenCalls != 0 {
			t.Fatalf("random failure: err=%v stdout=%q listen=%d", err, stdout, listenCalls)
		}
	})

	t.Run("listen", func(t *testing.T) {
		deps := bridgeCommandDeps{
			listen: func(string, string) (net.Listener, error) { return nil, errors.New("bind failed") },
			now:    time.Now,
			pid:    func() int { return 1 },
			random: bytes.NewReader(make([]byte, 16)),
			serve: func(context.Context, net.Listener, daemon.BridgeHTTPConfig) error {
				t.Fatal("serve called")
				return nil
			},
		}
		stdout, err := bridgeCommandExecute(t, deps, bridgeCommandValidInput(nil))
		if err == nil || stdout != "" {
			t.Fatalf("listen failure: err=%v stdout=%q", err, stdout)
		}
	})

	t.Run("non-loopback listener", func(t *testing.T) {
		listener := &bridgeCommandFakeListener{addr: bridgeCommandFakeAddr("192.0.2.1:4")}
		deps := bridgeCommandDeps{
			listen: func(string, string) (net.Listener, error) { return listener, nil },
			now:    time.Now,
			pid:    func() int { return 1 },
			random: bytes.NewReader(make([]byte, 16)),
			serve: func(context.Context, net.Listener, daemon.BridgeHTTPConfig) error {
				t.Fatal("serve called")
				return nil
			},
		}
		stdout, err := bridgeCommandExecute(t, deps, bridgeCommandValidInput(nil))
		if err == nil || stdout != "" || listener.closeCalls.Load() != 1 {
			t.Fatalf("non-loopback listener: err=%v stdout=%q closes=%d", err, stdout, listener.closeCalls.Load())
		}
	})

	t.Run("serve before ready", func(t *testing.T) {
		listener := &bridgeCommandFakeListener{addr: bridgeCommandFakeAddr("127.0.0.1:5")}
		deps := bridgeCommandDeps{
			listen: func(string, string) (net.Listener, error) { return listener, nil },
			now:    time.Now,
			pid:    func() int { return 1 },
			random: bytes.NewReader(make([]byte, 16)),
			serve: func(context.Context, net.Listener, daemon.BridgeHTTPConfig) error {
				return errors.New("initial refresh failed")
			},
		}
		stdout, err := bridgeCommandExecute(t, deps, bridgeCommandValidInput(nil))
		if err == nil || stdout != "" || listener.closeCalls.Load() != 1 {
			t.Fatalf("serve failure: err=%v stdout=%q closes=%d", err, stdout, listener.closeCalls.Load())
		}
	})
}

func TestBridgeCommandUsesInjectedShutdownContext(t *testing.T) {
	listener := &bridgeCommandFakeListener{addr: bridgeCommandFakeAddr("127.0.0.1:6")}
	seamCalled := make(chan struct{})
	serveStarted := make(chan struct{})
	cancellationReachedServe := make(chan struct{})
	var trigger context.CancelFunc
	deps := bridgeCommandDeps{
		listen: func(string, string) (net.Listener, error) { return listener, nil },
		now:    func() time.Time { return time.Unix(0, 0).UTC() },
		pid:    func() int { return 1 },
		random: bytes.NewReader(make([]byte, 16)),
		shutdownContext: func(parent context.Context) (context.Context, context.CancelFunc) {
			ctx, cancel := context.WithCancel(parent)
			trigger = cancel
			close(seamCalled)
			return ctx, cancel
		},
		serve: func(ctx context.Context, _ net.Listener, cfg daemon.BridgeHTTPConfig) error {
			if err := cfg.Ready(); err != nil {
				return err
			}
			close(serveStarted)
			<-ctx.Done()
			close(cancellationReachedServe)
			return nil
		},
	}
	done := make(chan error, 1)
	go func() {
		_, err := bridgeCommandExecute(t, deps, bridgeCommandValidInput(nil))
		done <- err
	}()
	<-seamCalled
	<-serveStarted
	trigger()
	select {
	case <-cancellationReachedServe:
	case <-time.After(time.Second):
		t.Fatal("shutdown-context cancellation did not reach ServeBridgeHTTP")
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("bridge command did not return after shutdown cancellation")
	}
}

type bridgeCommandCountingReader struct{ calls atomic.Int32 }

func (r *bridgeCommandCountingReader) Read([]byte) (int, error) {
	r.calls.Add(1)
	return 0, errors.New("stdin must not be read")
}

func TestBridgeCommandRejectsChangedInheritedFlagsBeforeStartupIO(t *testing.T) {
	for _, flag := range []string{"--debug", "--server-url=https://sentinel.invalid"} {
		t.Run(flag, func(t *testing.T) {
			stdin := &bridgeCommandCountingReader{}
			listenCalls := 0
			serveCalls := 0
			deps := bridgeCommandDeps{
				listen: func(string, string) (net.Listener, error) {
					listenCalls++
					return &bridgeCommandFakeListener{addr: bridgeCommandFakeAddr("127.0.0.1:7")}, nil
				},
				now:    time.Now,
				pid:    func() int { return 1 },
				random: errorReader{},
				serve: func(context.Context, net.Listener, daemon.BridgeHTTPConfig) error {
					serveCalls++
					return nil
				},
			}
			root := &cobra.Command{Use: "multica", SilenceUsage: true, SilenceErrors: true}
			root.PersistentFlags().Bool("debug", false, "")
			root.PersistentFlags().String("server-url", "", "")
			parent := &cobra.Command{Use: "daemon"}
			parent.AddCommand(newBridgeCommand(deps))
			root.AddCommand(parent)
			root.SetIn(stdin)
			var stdout bytes.Buffer
			root.SetOut(&stdout)
			root.SetErr(io.Discard)
			root.SetArgs([]string{"daemon", "bridge", flag})
			err := root.ExecuteContext(context.Background())
			if err == nil {
				t.Fatal("changed inherited flag was accepted")
			}
			if stdin.calls.Load() != 0 || listenCalls != 0 || serveCalls != 0 || stdout.Len() != 0 {
				t.Fatalf("flag rejection side effects: reads=%d listen=%d serve=%d stdout=%q", stdin.calls.Load(), listenCalls, serveCalls, stdout.String())
			}
		})
	}
}

type errorReader struct{}

func (errorReader) Read([]byte) (int, error) { return 0, errors.New("random unavailable") }

func bridgeCommandInputOfSize(t *testing.T, size int) string {
	t.Helper()
	type startup struct {
		Secret                string            `json:"secret"`
		InstallID             string            `json:"install_id"`
		Version               string            `json:"version"`
		ProviderPathOverrides map[string]string `json:"provider_path_overrides"`
	}
	value := startup{Secret: "s", InstallID: "i", Version: version, ProviderPathOverrides: map[string]string{"opencode": ""}}
	base, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	value.ProviderPathOverrides["opencode"] = strings.Repeat("p", size-len(base))
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if len(encoded) != size {
		t.Fatalf("startup input size = %d, want %d", len(encoded), size)
	}
	return string(encoded)
}

func mapsEqual(got, want map[string]string) bool {
	if len(got) != len(want) {
		return false
	}
	for key, value := range want {
		if got[key] != value {
			return false
		}
	}
	return true
}
