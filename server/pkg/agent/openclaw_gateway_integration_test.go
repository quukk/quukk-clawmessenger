//go:build agentintegration

package agent

import (
	"context"
	"os"
	"testing"
	"time"
)

// Only authenticates and performs a deliberately missing session lookup. No
// model prompt, configuration mutation, device pairing or quota consumption.
func TestOpenclawGatewayIntegrationHandshake(t *testing.T) {
	if os.Getenv("MULTICA_RUN_REAL_AGENT_SMOKE") != "1" {
		t.Skip("explicit account access opt-in required")
	}
	b := &openclawBackend{}
	config, err := b.gatewayConfig()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, err := dialOpenclawGateway(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer c.close()
	_, err = c.request(ctx, "sessions.resolve", map[string]any{"sessionId": "00000000-0000-4000-8000-000000000009"})
	if err == nil {
		t.Fatal("expected nonexistent session lookup to fail")
	}
	t.Log("protocol 4 authenticated local handshake passed; missing session rejected")
}
