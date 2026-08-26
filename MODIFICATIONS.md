# Quukk ClawMessenger Modifications

## Fork baseline

- Upstream repository: https://github.com/multica-ai/multica
- Upstream baseline commit: `54027ba763fa7da0699b2fe89df4a6b2c13d1c6f`
- Fork development branch: `codex/quukk-clawmessenger`
- Upstream remote is read-only for fork development.

## Bridge additions

- `packages/quukk-clawmessenger`: publishable Node.js entry package for the local ClawMessenger bridge.
- `apps/bridge`: private React/Vite workspace that builds local Bridge UI assets into the entry package.
- This initial scaffold deliberately has no RongCloud, registration-server, daemon, or provider runtime implementation.

## External service prerequisite

- `clawmessenger-server` commit `68496a3edf934c90b9af03a5c1c81422ab2d9ef7` adds Hermes to the server's supported AI node identity types. Deploy that server commit before enabling Hermes registration from the Quukk bridge; existing node types remain unchanged.

## Modified upstream files

- `.gitignore`: excludes a repository-local Quukk ClawMessenger runtime-data directory.
- `docs/superpowers/specs/2026-08-26-quukk-clawmessenger-fork-design.md`: records the initial workspace scaffold and its intentionally limited scope.
- `pnpm-workspace.yaml`: adds the catalog-pinned Vite version required by the Bridge UI workspace.
- `pnpm-lock.yaml`: records only the Task 1 workspace importers and their resolved tooling dependencies.

New fork-specific files are listed in this task's commit and do not replace upstream source files.
