package agent

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func init() {
	if os.Getenv("MULTICA_INTERACTIVE_PROBE_FIXTURE") != "1" {
		return
	}
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		var request struct {
			ID     int    `json:"id"`
			Method string `json:"method"`
		}
		_ = json.Unmarshal(scanner.Bytes(), &request)
		file, _ := os.OpenFile(os.Getenv("MULTICA_INTERACTIVE_PROBE_TRACE"), os.O_APPEND|os.O_WRONLY|os.O_CREATE, 0600)
		_, _ = file.WriteString(request.Method + "\n")
		_ = file.Close()
		if os.Getenv("MULTICA_INTERACTIVE_PROBE_REPLY") == "timeout" {
			time.Sleep(30 * time.Second)
			continue
		}
		var result any
		_ = json.Unmarshal([]byte(os.Getenv("MULTICA_INTERACTIVE_PROBE_REPLY")), &result)
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": result})
	}
	os.Exit(0)
}

func TestInteractiveACPProbeUsesOnlyInitialize(t *testing.T) {
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(self)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "interactive-fixture.exe")
	if err := os.WriteFile(path, data, 0700); err != nil {
		t.Fatal(err)
	}
	trace := filepath.Join(t.TempDir(), "trace.txt")
	t.Setenv("MULTICA_INTERACTIVE_PROBE_FIXTURE", "1")
	t.Setenv("MULTICA_INTERACTIVE_PROBE_TRACE", trace)
	for _, tc := range []struct {
		provider, reply string
		want            bool
	}{
		{"opencode", `{"protocolVersion":1,"agentCapabilities":{"loadSession":true}}`, true},
		{"opencode", `{"protocolVersion":1,"agentCapabilities":{"loadSession":false}}`, false},
		{"hermes", `{"protocolVersion":1,"agentCapabilities":{"sessionCapabilities":{"resume":{}}}}`, true},
		{"hermes", `{"protocolVersion":1,"agentCapabilities":{}}`, false},
		{"hermes", `{"protocolVersion":9,"agentCapabilities":{"sessionCapabilities":{"resume":{}}}}`, false},
	} {
		t.Setenv("MULTICA_INTERACTIVE_PROBE_REPLY", tc.reply)
		got, _ := ProbeInteractiveRuntime(t.Context(), tc.provider, NewCommand(path, nil), "1.0.0")
		if got != tc.want {
			t.Fatalf("%s %s: got %v", tc.provider, tc.reply, got)
		}
	}
	t.Setenv("MULTICA_INTERACTIVE_PROBE_REPLY", "timeout")
	ctx, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
	defer cancel()
	if got, _ := ProbeInteractiveRuntime(ctx, "hermes", NewCommand(path, nil), "1.0.0"); got {
		t.Fatal("timeout advertised support")
	}
	calls, err := os.ReadFile(trace)
	if err != nil {
		t.Fatal(err)
	}
	for _, method := range strings.Fields(string(calls)) {
		if method != "initialize" {
			t.Fatalf("probe invoked %s", method)
		}
	}
}

func TestInteractiveCodexProbeRequiresKnownVersion(t *testing.T) {
	command := NewCommand(filepath.Join(t.TempDir(), "missing-codex.exe"), nil)
	for _, tc := range []struct {
		version string
		want    bool
	}{{"0.100.0", true}, {"0.99.0", false}, {"unknown", false}, {"", false}} {
		got, _ := ProbeInteractiveRuntime(t.Context(), "codex", command, tc.version)
		if got != tc.want {
			t.Fatalf("%s: %v", tc.version, got)
		}
	}
}

func TestInteractiveGatewayProbeRequiresMethodsAndTextEvents(t *testing.T) {
	for _, mode := range []string{"interactive", "plain"} {
		t.Run(mode, func(t *testing.T) {
			fixture := newOpenclawGatewayFixture(t, mode)
			t.Setenv("OPENCLAW_CONFIG_PATH", fixture.config)
			got, _ := ProbeInteractiveRuntime(t.Context(), "openclaw", NewCommand(filepath.Join(t.TempDir(), "fake-openclaw.exe"), nil), "1.0.0")
			if got != (mode == "interactive") {
				t.Fatalf("proof %s: %v", mode, got)
			}
			fixture.mu.Lock()
			defer fixture.mu.Unlock()
			for _, request := range fixture.requests {
				if request.Method != "connect" {
					t.Fatalf("probe invoked %s", request.Method)
				}
			}
		})
	}
}
