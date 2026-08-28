# Quukk ClawMessenger Modifications

## Fork baseline

- Fork repository: https://github.com/quukk/quukk-clawmessenger
- Upstream repository: https://github.com/multica-ai/multica
- Upstream baseline commit: `54027ba763fa7da0699b2fe89df4a6b2c13d1c6f`
- Fork development branch: `codex/quukk-clawmessenger`
- Upstream remote is read-only for fork development.

## Bridge additions

- `packages/quukk-clawmessenger`: publishable Node.js entry package for the local ClawMessenger bridge.
- `apps/bridge`: private React/Vite workspace that builds local Bridge UI assets into the entry package.
- `server/internal/daemon/bridge*.go`: injected, bounded discovery for local OpenCode, OpenClaw, Codex, and Hermes runtimes, kept separate from the existing daemon lifecycle.
- Synchronous agent probe output shares a 64 KiB cap so noisy version and catalog commands safely fail instead of growing daemon memory without bound; Task 14/CI must watch for real catalog output above that limit.
- The fork now includes the runtime workers, registration transport, session routing, local
  service/CLI, and Bridge UI described below.

## Local runtime selection UI

- `apps/bridge/src` adds the Multica-attributed Quukk ClawMessenger setup and local operations interface for OpenCode, OpenClaw, Codex, and Hermes.
- Setup defaults to detected ready runtimes, requires an explicit submit, discloses headless permissions, and requires a real authorized work root plus a default working directory before describing a registered runtime as task-ready.
- Registration progress is isolated per runtime so a successful RongCloud identity stays successful when another runtime fails.
- The UI uses one-use local session tickets, removes the ticket from browser history before exchange, and adds the returned CSRF token only to same-origin mutations.
- Generated `packages/quukk-clawmessenger/dist/ui` assets are intentionally excluded from Git. `pnpm --dir apps/bridge build` creates them deterministically before package assembly.

## Authenticated Bridge transport

- `server/internal/daemon/bridge_http.go` and `server/internal/daemon/bridge_http_test.go` add the loopback-only, per-install bearer-authenticated Bridge JSON/SSE API, bounded request decoding, runtime refresh, task streaming/cancellation, health reporting, and graceful shutdown. The Node supervisor owns and protects the installation secret; the Go child receives it only through bounded startup stdin and retains it only in memory.
- `server/cmd/multica/cmd_bridge.go` and `server/cmd/multica/cmd_bridge_test.go` add the hidden `multica daemon bridge` entrypoint with bounded strict stdin, fixed ephemeral IPv4 loopback binding, process identity generation, and a single post-refresh readiness record.
- The serving lifecycle synchronously fences parent cancellation against discovery/readiness, seals new handler entries at shutdown, drains cooperative handlers and every started Bridge task within one deadline, and force-closes timed-out HTTP connections without waiting indefinitely for a non-cooperative Go handler. The command reuses the existing cross-platform shutdown context and rejects changed inherited flags before startup I/O.

## External service prerequisite

- `clawmessenger-server` commit `68496a3edf934c90b9af03a5c1c81422ab2d9ef7` adds Hermes to the server's supported AI node identity types. Deploy that server commit before enabling Hermes registration from the Quukk bridge; existing node types remain unchanged.
- `clawmessenger-server` commit `8a29e4e24af00145c072ccca568a0e9049842d29` retires the anonymous user-token route, allowlists public node responses, redacts RongCloud token logs/errors, and adds no-store to sensitive responses. Enrollment enforcement and owner/node authorization remain mandatory follow-up server gates before npm publication.

## Local identity and enrollment

- `packages/quukk-clawmessenger/src/config`, `src/registration`, and `src/bindings` add strict versioned config/state/credential storage, protected per-install identity, fail-closed work-directory authorization, bounded atomic JSON recovery, four-provider registration, per-runtime enrollment proof, credentials-first token swaps, and provider-isolated lifecycle coordination.
- The enrollment proof is derived locally from the decoded 32-byte Bridge secret, full normalized server base URL, and runtime ID. Only the domain-separated HMAC result crosses HTTPS; raw Bridge and RongCloud credentials remain outside request bodies, URLs, errors, logs, state, and ordinary config.

## Legacy migration and package audit

- `packages/quukk-clawmessenger/src/migration` discovers only the fixed OpenCode
  ClawMessenger configuration locations under an explicitly supplied home directory. It reads
  only the bounded main settings file, projects validated non-secret server/work-directory/path
  settings, reports registration caches without opening them, and requires explicit confirmation
  before writing through `LocalStore`.
- Migration never moves or deletes a legacy file and never imports tokens, AppKey/AppSecret,
  passwords, node/MAC identity, bindings, sessions, or logs. Validation and atomic-write failures
  leave the legacy bytes and destination config unchanged.
- `packages/quukk-clawmessenger/scripts/prepare-package.mjs` copies the exact four root legal
  files into the entry package and the exact root `LICENSE`, `NOTICE`, and `MODIFICATIONS.md`
  into either zero or the complete six binary-only platform staging packages while rejecting
  partial matrices, traversal, and symbolic-link/junction components. Platform source
  attribution remains the build-generated `SOURCE.md` from the reproducible runtime task.
- `packages/quukk-clawmessenger/scripts/audit-tarball.mjs` consumes bounded `npm pack --json`
  reports and strictly checks legal files, README, npm/platform manifests, bin, compiled worker,
  Bridge UI assets, source-map absence, path containment, symlinks, credential-like literals, and
  developer-specific paths. Failure output is a fixed code and does not echo matched content.
- The entry TypeScript build excludes tests and disables source/declaration maps so rejected
  development artifacts cannot enter the npm tarball.

## Modified upstream files

- `.gitignore`: excludes a repository-local Quukk ClawMessenger runtime-data directory.
- `docs/superpowers/specs/2026-08-26-quukk-clawmessenger-fork-design.md`: records the initial workspace scaffold and its intentionally limited scope.
- `pnpm-workspace.yaml`: adds the catalog-pinned Vite version required by the Bridge UI workspace.
- `pnpm-lock.yaml`: records the fork workspaces and the focused Bridge UI dependencies used by the local package build.
- `README.md`: adds the Quukk ClawMessenger derivative entry point while retaining Multica as the
  primary product and attribution.
- `MODIFICATIONS.md` and `THIRD_PARTY_NOTICES.md`: record migration/package hardening and retain
  the unresolved RongCloud licensing metadata discrepancy as a publication gate.
- `server/pkg/agent/launch.go`: bounds synchronous probe output while preserving process ownership and timeout errors.
- `server/pkg/agent/agent_test.go`: covers oversized version output and timeout precedence without executing an installed agent CLI.

New fork-specific files are listed in this task's commit and do not replace upstream source files.
