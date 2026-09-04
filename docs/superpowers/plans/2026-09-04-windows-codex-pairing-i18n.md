# Windows Codex Discovery, Pairing Diagnostics, and Bridge Localization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect the ChatGPT-installed Codex agent on Windows, make pairing failures actionable and IPv6-stall tolerant, and localize the full bridge UI with Chinese as the default.

**Architecture:** Extend daemon discovery with a platform-specific executable candidate provider, introduce a narrowly scoped pairing HTTP transport fallback and typed bridge errors, and add a small React locale context backed by complete Chinese and English dictionaries. Existing protocol schemas and the four-provider model remain unchanged.

**Tech Stack:** Go daemon, Node.js 22, TypeScript, React, Vitest, Testing Library, pnpm.

**Spec:** `docs/superpowers/specs/2026-09-04-windows-codex-pairing-i18n.md`

## Global Constraints

- Never execute the ChatGPT GUI as an agent runtime.
- Keep TLS certificate verification enabled.
- Pairing v2 remains mandatory; do not fall back to v1.
- Default locale is Simplified Chinese; an explicit English choice persists.
- Preserve Windows, macOS, and Linux behavior.
- Write each behavior test first and observe the expected failure before implementation.

---

### Task 1: Windows ChatGPT-installed Codex discovery

**Files:**
- Modify: `server/internal/daemon/config.go`
- Modify: `server/internal/daemon/agents_probe.go`
- Test: `server/internal/daemon/config_windows_test.go`
- Test: `server/internal/daemon/config_test.go`

**Interfaces:**
- Produces: `codexDesktopExecutablePaths() []string`, ordered executable candidates used only after configured and PATH discovery fail.
- Consumes: existing `resolveAgentExecutablePath` and `probeAgentCLIs` validation flow.

- [x] Add a Windows test whose fixture contains `OpenAI/Codex/bin/<build>/codex.exe` and expects the canonical executable path.
- [x] Run the focused Go test and confirm it fails because Windows desktop candidates do not exist.
- [x] Add platform-specific candidate construction with deterministic newest-first ordering and preserve macOS candidates.
- [ ] Run the focused and daemon test suites and confirm they pass in CI or an available Go runtime.

### Task 2: Pairing transport and actionable failure codes

**Files:**
- Modify: `packages/quukk-clawmessenger/src/pairing/client.ts`
- Modify: `packages/quukk-clawmessenger/src/pairing/client.test.ts`
- Modify: `packages/quukk-clawmessenger/src/service.ts`
- Modify: `packages/quukk-clawmessenger/src/service.test.ts`
- Modify: `apps/bridge/src/api.ts`
- Modify: `apps/bridge/src/api.test.ts`
- Modify: `apps/bridge/src/pages/setup.tsx`
- Test: `apps/bridge/src/setup.test.tsx`

**Interfaces:**
- Produces: an IPv4 retry port used only after a retryable transport failure; `BridgeApiError.code` values preserved for UI mapping.
- Consumes: the existing `PairingClient` fetch injection and local bridge error envelope.

- [x] Add a client test proving a transport timeout gets one IPv4-only retry while HTTP 404 does not retry as transport.
- [x] Run it and confirm the missing fallback fails.
- [x] Implement the smallest scoped IPv4 fallback without changing TLS validation.
- [x] Add service/API tests proving server 404 maps to `pairing_api_unavailable` and transport failure maps to `pairing_transport`.
- [x] Run them and confirm the current generic error mapping fails.
- [x] Preserve the structured code through the local API and render distinct actionable messages.
- [x] Run package and bridge pairing tests until green.

### Task 3: Complete Chinese/English bridge localization

**Files:**
- Create: `apps/bridge/src/i18n.tsx`
- Create: `apps/bridge/src/i18n.test.tsx`
- Modify: `apps/bridge/src/main.tsx`
- Modify: `apps/bridge/src/app.tsx`
- Modify: `apps/bridge/src/components/brand.tsx`
- Modify: `apps/bridge/src/components/pairing-panel.tsx`
- Modify: `apps/bridge/src/components/runtime-card.tsx`
- Modify: `apps/bridge/src/components/status-pill.tsx`
- Modify: `apps/bridge/src/pages/activity.tsx`
- Modify: `apps/bridge/src/pages/diagnostics.tsx`
- Modify: `apps/bridge/src/pages/runtimes.tsx`
- Modify: `apps/bridge/src/pages/settings.tsx`
- Modify: `apps/bridge/src/pages/setup.tsx`
- Modify: `apps/bridge/src/app.test.tsx`
- Modify: `apps/bridge/src/setup.test.tsx`
- Modify: `apps/bridge/src/components/pairing-panel.test.tsx`

**Interfaces:**
- Produces: `LocaleProvider`, `useI18n()`, and a typed `t(key, values?)` translator for `zh-CN | en`.
- Consumes: browser local storage key `quukk-clawmessenger.locale` and updates `document.documentElement.lang`.

- [x] Add tests proving first load is Chinese, switching to English updates visible navigation, and reload restores English.
- [x] Run the tests and confirm they fail because no locale provider or switch exists.
- [x] Implement the provider, complete dictionaries, interpolation, persistence, and document language update.
- [x] Replace visible hard-coded bridge copy and accessible labels with translation keys.
- [x] Add a Chinese Codex-not-found hint instructing the user to initialize Codex in ChatGPT and rescan.
- [x] Run all Bridge tests and type checking until green.

### Task 4: Package and end-to-end verification

**Files:**
- Modify only if verification exposes a regression: files already listed above.

**Interfaces:**
- Consumes: built bridge assets, Go runtime packages, and the npm package tarball.
- Produces: verification evidence and a test-environment deployment requirement.

- [x] Run Bridge tests, package tests, type checks, and production builds.
- [ ] Run Go daemon tests where a Go runtime is available; otherwise require the repository CI matrix before merge.
- [x] Pack the npm package and install it into an isolated npm prefix.
- [x] Launch setup from that installed tarball and verify Chinese default, English switch, and Codex detection on Windows.
- [ ] Probe the configured `/api/ai/pairing/v2/sessions` endpoint through IPv4 and verify it no longer returns 404 after backend redeployment.
- [x] Review the diff against the spec and record any external deployment blocker without claiming end-to-end success.
