# Pairing beta acceptance evidence

Date: 2026-09-03 (Asia/Shanghai)

## Acceptance status

Task 12 and its Completion Gate remain **pending**. Focused suites, the package/Web/UniApp
full suites, builds and clean-install checks pass, but Step 4 is not complete because the
server full suite still has five failures and no baseline waiver was granted. Interactive
production testing is also pending. The successful automated checks below are evidence for
individual surfaces, not a claim that Task 12 is green overall.

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
- Package full suite after Fix Round 1: 35 files, 1007 passed. The round adds an assertion to
  an existing registration test, so the test count is unchanged. `typecheck` and `build`
  passed.
- Server focused pairing service and API: 95 passed.
- Server full suite is blocked: 756 passed, 15 skipped, 156 subtests passed and five failed.
  The failures match the recorded baseline (three admin-message cases, the
  admin-consolidation verifier and the system-host role-recommendation contract case), but
  that comparison is not a waiver and must not be read as an all-green result.
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

The earlier `/api/canary` probe did not reach a pairing handler and is invalid as Step 7
evidence. It is retained only as superseded diagnostic history.

Fix Round 1 instead ran an actually installed tarball's `PairingClient` and
`RegistrationClient` over TCP into the real Flask create, device-poll and candidate-register
handlers backed by an isolated SQLite database and fake external provisioner. The initial run
proved a real integration defect: create returned 201 and poll returned 200, but register
returned 400 `invalid_registration_request` because the package sent legacy `node_type` and
`ai_type` fields. A package RED test reproduced the mismatch. The minimal correction sends
the server's strict `provider`, `name`, `mac_address`, `capabilities` DTO only for the pairing
authorization path and preserves the legacy DTO for legacy registration.

The clean re-pack/re-install GREEN run returned 201/200/200 and independently proved handler
reach through `session_created` and `session_claimed` audit events, one pairing result row, one
node commit and exactly one provisioner call. Package stdout/stderr and the configured server
application logger were captured separately and scanned for five fictitious canary categories;
both scans found zero matches. Only 12-character SHA-256 prefixes are present in the sanitized
summary. The successful server handlers emitted no application log records, so the server log
file is genuinely empty. Step 7 remains pending until the same canaries can be exercised under
the non-empty production access/application logging stack; an empty capture is not treated as
proof of deployed-log redaction.

Fresh Fix Round 1 package full, typecheck, build and server-focused outputs are retained under
`D:\A-project\clawmessenger\.tmp\task12-logs\round1-verification`.

## Commit identity

- Package canonical contract: `dd58dc3e5`.
- Fix Round 1 pairing registration DTO: `503974a9c`.
- Evidence-status correction: the commit containing this file (resolve with `git rev-parse HEAD`).
- Server, Web and UniApp commit hashes are recorded in the central Task 12 report because this
  package commit cannot safely self-reference its own hash.

## Pending interactive and production acceptance

Interactive browser and real production-test-backend evidence is deliberately **not claimed**
here. Task 12 remains pending. Automated probing on 2026-09-03 found HTTP 404 at both
`/im-test/api/ai/pairing/sessions` and `/im/api/ai/pairing/sessions`; the installed package
therefore correctly returned the safe local `operation_unavailable` response instead of a QR.
After the backend pairing route is deployed, the coordinating agent must complete and record:

1. browser rendering and click-through of setup, QR, candidate selection, retry, cancel and
   expiry states;
2. authenticated scan/claim/confirm against the production-test backend;
3. verification that only user-selected platforms register and appear in Web and UniApp;
4. screenshots or equivalent interactive evidence and the production deployment identity.

No npm publication, push, merge, or production mutation was performed by this acceptance run.
