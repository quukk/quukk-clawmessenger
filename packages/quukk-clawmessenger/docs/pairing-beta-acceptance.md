# Pairing beta acceptance evidence

Date: 2026-09-03 (Asia/Shanghai)

## Scope and immutable contract

The four repositories consume one byte-identical `pairing-v1.json` contract. Its SHA-256 is
`AEC1CD20BEDAE51F2130551DC8888E4A8C9E166490FDD6D490FCA62D08223625`.
It covers valid QR, candidate, snapshot, progress, retry, cancelled and expired examples plus
strict invalid vectors with stable error codes. Server-only selection expansion and
cross-session candidate vectors are intentionally not passed to client parsers.

The package parser and Web parser were tightened after contract-first tests showed that
`status: partial` incorrectly accepted a result set with no failure. `partial` now requires
exact selected-candidate coverage, terminal results, and at least one failed result. Existing
strict QR and candidate boundaries were not relaxed.

## Automated verification

- Package focused pairing schemas and client: 27 passed.
- Package full suite: 35 files, 1007 passed. `typecheck` and `build` passed.
- Server focused pairing service and API: 95 passed.
- Server full suite: 756 passed, 15 skipped, 156 subtests passed, with the exact five known
  unrelated baseline failures: three admin-message cases, the admin-consolidation verifier,
  and the system-host role-recommendation contract case.
- Web focused pairing libraries and service: 38 passed. Full suite: 26 files, 257 passed;
  production build and lint passed.
- UniApp focused pairing contract and service: 37 passed. Full suite: 13 files, 145 passed;
  H5 and Weixin mini-program builds passed with the repository's existing Vue/Sass warnings.
- `git diff --check` passed in all four worktrees.

Representative commands:

```text
corepack pnpm --filter quukk-clawmessenger test
corepack pnpm --filter quukk-clawmessenger typecheck
corepack pnpm --filter quukk-clawmessenger build
python -m pytest -q
npm test
npm run build
npm run build:mp-weixin
npm run lint
```

Web tests used the canonical server worktree paths in
`CLAWMESSENGER_DISCUSSION_WIRE_CONTRACT` and `CLAWMESSENGER_SYSTEM_HOST_CONTRACT`.

## Clean tarball installation

`npm pack --json` was run from `packages/quukk-clawmessenger` because this pnpm monorepo does
not declare npm workspaces, so the plan's root-level `npm pack --workspace ...` form is not
applicable. The resulting `quukk-clawmessenger-0.1.0-beta.7.tgz` was installed with npm into a
new temporary project. The installed package reported beta.7 and its real CLI help, setup,
status, rescan and stop commands executed successfully.

Against an isolated loopback pairing service, the installed CLI served `/setup` with HTTP 200,
detected local Codex and OpenCode runtimes, showed zero bindings before selection, started a
waiting pairing session, and emitted a QR containing exactly `type`, `version`, `server`,
`ticket`, and `expiresAt`. Two discovered ready candidates were offered; nothing was
pre-registered and no node-ID entry is part of this flow.

Five fictitious ticket/device-secret/Authorization/token/path canaries were sent through each
isolated installed-service boundary. Both generated bridge logs contained zero canary matches.
No real credential is recorded in this document or the retained evidence logs.

## Commit identity

- Package evidence: the commit containing this file (resolve with `git rev-parse HEAD`).
- Server, Web and UniApp commit hashes are recorded in the central Task 12 report because this
  package commit cannot safely self-reference its own hash.

## Pending interactive and production acceptance

Interactive browser and real production-test-backend evidence is deliberately **not claimed**
here. Automated probing on 2026-09-03 found HTTP 404 at both
`/im-test/api/ai/pairing/sessions` and `/im/api/ai/pairing/sessions`; the installed package
therefore correctly returned the safe local `operation_unavailable` response instead of a QR.
After the backend pairing route is deployed, the coordinating agent must complete and record:

1. browser rendering and click-through of setup, QR, candidate selection, retry, cancel and
   expiry states;
2. authenticated scan/claim/confirm against the production-test backend;
3. verification that only user-selected platforms register and appear in Web and UniApp;
4. screenshots or equivalent interactive evidence and the production deployment identity.

No npm publication, push, merge, or production mutation was performed by this acceptance run.
