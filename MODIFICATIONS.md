# Quukk ClawMessenger Modifications

## Fork baseline

- Upstream repository: https://github.com/multica-ai/multica
- Upstream baseline commit: `54027ba763fa7da0699b2fe89df4a6b2c13d1c6f`
- Fork development branch: `codex/quukk-clawmessenger`
- Upstream remote is read-only for fork development.

## Bridge additions

- `packages/quukk-clawmessenger`: publishable Node.js entry package for the local ClawMessenger bridge.
- `apps/bridge`: private React/Vite workspace that builds local Bridge UI assets into the entry package.
- `server/internal/daemon/bridge*.go`: injected, bounded discovery for local OpenCode, OpenClaw, Codex, and Hermes runtimes, kept separate from the existing daemon lifecycle.
- Synchronous agent probe output shares a 64 KiB cap so noisy version and catalog commands safely fail instead of growing daemon memory without bound; Task 14/CI must watch for real catalog output above that limit.
- RongCloud workers, Node-side registration transport, session persistence, and the local Bridge UI remain intentionally unimplemented at this stage.

## Authenticated Bridge transport

- `server/internal/daemon/bridge_http.go` and `server/internal/daemon/bridge_http_test.go` add the loopback-only, per-process bearer-authenticated Bridge JSON/SSE API, bounded request decoding, runtime refresh, task streaming/cancellation, health reporting, and graceful shutdown.
- `server/cmd/multica/cmd_bridge.go` and `server/cmd/multica/cmd_bridge_test.go` add the hidden `multica daemon bridge` entrypoint with bounded strict stdin, fixed ephemeral IPv4 loopback binding, process identity generation, and a single post-refresh readiness record.
- The serving lifecycle synchronously fences parent cancellation against discovery/readiness, seals new handler entries at shutdown, drains cooperative handlers and every started Bridge task within one deadline, and force-closes timed-out HTTP connections without waiting indefinitely for a non-cooperative Go handler. The command reuses the existing cross-platform shutdown context and rejects changed inherited flags before startup I/O.

## External service prerequisite

- `clawmessenger-server` commit `68496a3edf934c90b9af03a5c1c81422ab2d9ef7` adds Hermes to the server's supported AI node identity types. Deploy that server commit before enabling Hermes registration from the Quukk bridge; existing node types remain unchanged.

## Modified upstream files

- `.gitignore`: excludes a repository-local Quukk ClawMessenger runtime-data directory.
- `docs/superpowers/specs/2026-08-26-quukk-clawmessenger-fork-design.md`: records the initial workspace scaffold and its intentionally limited scope.
- `pnpm-workspace.yaml`: adds the catalog-pinned Vite version required by the Bridge UI workspace.
- `pnpm-lock.yaml`: records only the Task 1 workspace importers and their resolved tooling dependencies.
- `server/pkg/agent/launch.go`: bounds synchronous probe output while preserving process ownership and timeout errors.
- `server/pkg/agent/agent_test.go`: covers oversized version output and timeout precedence without executing an installed agent CLI.

New fork-specific files are listed in this task's commit and do not replace upstream source files.
