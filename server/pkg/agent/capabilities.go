package agent

// CapabilitySet declares the per-backend protocol capabilities that the
// ClawMessenger bridge catalog republishes to clients. Every field stays
// false until the backend is verified to support it, so unknown or
// not-yet-assessed backends fail closed with the zero value.
type CapabilitySet struct {
	// SessionResume reports whether sessions can be resumed across runs.
	// Backends whose resume rejection is undetectable (see
	// resumeRejectionUndetectable) stay false because an unconfirmed resume
	// cannot be distinguished from a silent fresh session.
	SessionResume bool
	// Cancel reports whether in-flight runs can be cancelled.
	Cancel bool
	// TextEvents reports whether streaming text deltas are emitted.
	TextEvents bool
	// ToolEvents reports whether tool invocations are surfaced as events.
	ToolEvents bool
}

// backendCapabilities is the single declaration point for bridge catalog
// capabilities. The daemon bridge runtime specs derive their advertised
// capabilities from this map; providers without an entry resolve to the
// zero CapabilitySet (fail-closed) and are rejected by the daemon spec
// guard. Interactive rounds are intentionally absent: that capability is
// probe-derived at runtime, never declared.
var backendCapabilities = map[string]CapabilitySet{
	// Long-supported bridge providers.
	"codex":    {SessionResume: true, Cancel: true, TextEvents: true, ToolEvents: true},
	"hermes":   {SessionResume: true, Cancel: true, TextEvents: true, ToolEvents: true},
	"opencode": {SessionResume: true, Cancel: true, TextEvents: true, ToolEvents: true},
	"openclaw": {SessionResume: true, Cancel: true},

	// Tier 1 expansion providers (provider-expansion-plan.md §2.2): verified
	// protocols with enforced minimum versions (see MinVersions).
	"claude": {SessionResume: true, Cancel: true, TextEvents: true, ToolEvents: true},
	// copilot resume rejection is undetectable, so session resume stays off.
	"copilot": {Cancel: true, TextEvents: true},
	"grok":    {SessionResume: true, Cancel: true, TextEvents: true},
	"qwen":    {SessionResume: true, Cancel: true, TextEvents: true},
	"dim":     {SessionResume: true, Cancel: true, TextEvents: true},
	"mcode":   {SessionResume: true, Cancel: true, TextEvents: true},
	"zeroclaw": {SessionResume: true, Cancel: true, TextEvents: true},
}

// Capabilities returns the declared capability set for agentType. Unknown
// types resolve to the zero value so callers fail closed.
func Capabilities(agentType string) CapabilitySet {
	return backendCapabilities[agentType]
}

// HasDeclaredCapabilities reports whether agentType has an explicit
// backendCapabilities entry. Catalog specs for providers without one are a
// declaration mistake (they would silently advertise no capabilities) and
// are rejected by the daemon guard test.
func HasDeclaredCapabilities(agentType string) bool {
	_, ok := backendCapabilities[agentType]
	return ok
}
