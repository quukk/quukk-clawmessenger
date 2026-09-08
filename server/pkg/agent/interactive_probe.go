package agent

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"path/filepath"
	"time"
)

// ProbeInteractiveRuntime checks the installed protocol without starting a turn.
// ACP probes initialize only; Gateway probes authenticate only. Neither creates
// a session, sends a prompt, or requests model output.
func ProbeInteractiveRuntime(ctx context.Context, provider string, command Command, version string) (bool, error) {
	return probeInteractiveRuntime(ctx, provider, command, version, processTreeStartOptions{})
}

func probeInteractiveRuntime(ctx context.Context, provider string, command Command, version string, startOptions processTreeStartOptions) (bool, error) {
	if !filepath.IsAbs(command.Path) {
		return false, errors.New("interactive probe requires an explicit executable")
	}
	switch provider {
	case "codex":
		// This established floor is the first app-server stdio thread/resume build.
		if err := CheckMinVersion("codex", version); err != nil {
			return false, err
		}
		return true, nil
	case "opencode", "hermes":
		supported := false
		_, err := discoverACPModels(ctx, command, acpDiscoveryProvider{
			processStartOptions: startOptions,
			defaultBin:          provider, clientName: "bridge-capability-probe", tmpdirPrefix: "bridge-probe-", strictErrors: true, initializeOnly: true, timeout: 5 * time.Second,
			inspectInit: func(raw json.RawMessage) {
				var result struct {
					ProtocolVersion   int `json:"protocolVersion"`
					AgentCapabilities struct {
						LoadSession         bool `json:"loadSession"`
						SessionCapabilities struct {
							Resume json.RawMessage `json:"resume"`
						} `json:"sessionCapabilities"`
					} `json:"agentCapabilities"`
				}
				if json.Unmarshal(raw, &result) != nil || result.ProtocolVersion != 1 {
					return
				}
				if provider == "opencode" {
					supported = result.AgentCapabilities.LoadSession
					return
				}
				var resume map[string]json.RawMessage
				supported = json.Unmarshal(result.AgentCapabilities.SessionCapabilities.Resume, &resume) == nil && resume != nil
			},
		})
		if err != nil {
			return false, err
		}
		if !supported {
			return false, errors.New("interactive resume capability was not advertised by ACP initialize")
		}
		return true, nil
	case "openclaw":
		backend := &openclawBackend{cfg: Config{ExecutablePath: command.Path, Logger: slog.Default()}}
		config, err := backend.gatewayConfig()
		if err != nil {
			return false, err
		}
		client, err := dialOpenclawGateway(ctx, config)
		if err != nil {
			return false, err
		}
		defer client.close()
		if !client.interactive {
			return false, errors.New("Gateway does not advertise required session, stop and text event methods")
		}
		return true, nil
	default:
		return false, errors.New("interactive protocol unsupported")
	}
}
