# Task 12 report: canonical pairing contract and clean-install acceptance

Date: 2026-09-03 (Asia/Shanghai)

## Outcome

Task 12 and its Completion Gate are **pending**. Focused suites and the package, Web and UniApp
full suites pass, but Step 4 is not complete: the server full suite still has five failures and
no baseline waiver was granted. Step 6 interactive production testing and the non-empty
production-log portion of Step 7 are also pending. Results below describe individual verified
surfaces and do not imply an all-green Task 12 outcome.

One canonical UTF-8 `pairing-v1.json` fixture was copied byte-for-byte into the package,
server, Web and UniApp worktrees. All four SHA-256 hashes are:

```text
AEC1CD20BEDAE51F2130551DC8888E4A8C9E166490FDD6D490FCA62D08223625
```

The fixture covers valid five-field QR, candidates, waiting/cancelled/expired snapshots,
partial/cancelled/expired progress, retry requests, device terminal errors and command errors.
Invalid vectors cover extra/expired/insecure QR input, duplicate and oversized candidates,
duplicate retry IDs, contradictory partial results, server-only selection expansion and
cross-session candidates. `appliesTo` keeps the server-only authorization vectors out of the
client parsers.

## TDD evidence and production corrections

The package contract test first failed because a `partial` progress snapshot containing only
successful results was accepted (1 failed, 8 passed). The Web parser exposed the same defect
(1 failed, 25 passed). Both production parsers were minimally tightened so `partial` requires
exact selected-candidate result coverage, only terminal result states and at least one failed
result. No parser was relaxed to accommodate the fixture; no server-only selection behavior was
added to either client.

Fix Round 1 then exposed a separate real cross-repository RED. An installed package successfully
reached server create (201) and poll (200), but register returned 400
`invalid_registration_request`: the pairing-authorized package path sent the legacy
`node_type`/`ai_type` body while the strict server handler accepts
`provider`/`name`/`mac_address`/`capabilities`. A package contract test failed on that exact
body. The minimal production fix branches the DTO only for pairing authorization and preserves
the legacy registration payload.

Focused final results:

- Package pairing schema/client: 27 passed.
- Server pairing service/API: 95 passed.
- Web pairing parser/service: 38 passed.
- UniApp pairing contract/service: 37 passed.

## Full verification

- Package after Fix Round 1: 35 files, 1007 tests passed; typecheck and build passed. The new
  assertion extends an existing test, so the count is unchanged. A first run shared CPU and
  disk with the other three full suites and produced seven 5-second timeouts plus one shutdown
  timing assertion; the immediate isolated serial rerun was fully green.
- Server full suite is blocked: 756 passed, 15 skipped, 156 subtests passed, 5 failed. The exact five failures match
  the declared baseline: three `tests/test_admin_routes.py` message cases,
  `AdminConsolidationVerifierTest`, and the `SystemHostContractTest` role-recommendation case.
  This comparison is not a waiver; Step 4 and the overall Completion Gate remain pending.
- Web: 26 files, 257 tests passed; production build and lint passed with existing bundle
  warnings.
- UniApp: 13 files, 145 tests passed; H5 and Weixin mini-program builds passed with existing
  Vue/Sass warnings.
- `git diff --check` passed in every worktree before commit.

Fresh Fix Round 1 GREEN logs for the package full suite/typecheck/build and server focused suite
are retained at `D:\A-project\clawmessenger\.tmp\task12-logs\round1-verification`.

Web full tests used the server worktree fixtures via
`CLAWMESSENGER_DISCUSSION_WIRE_CONTRACT` and `CLAWMESSENGER_SYSTEM_HOST_CONTRACT`.

## Pack and clean install

The plan's root-level `npm pack --workspace packages/quukk-clawmessenger --json` was attempted
and correctly rejected because the repository is pnpm-only and has no npm workspace
declaration. Running `npm pack --json` inside the real package directory succeeded:

- tarball:
  `D:\A-project\clawmessenger\quukk-clawmessenger-worktrees\fix-runtime-manifest-beta2\packages\quukk-clawmessenger\quukk-clawmessenger-0.1.0-beta.7.tgz`
- Fix Round 1 size: 363,757 bytes; unpacked: 1,652,439 bytes; entries: 106
- Fix Round 1 SHA-1: `a0e728911b10350ae30642e64c9f9822dde51610`
- temporary project:
  `D:\A-project\clawmessenger\.tmp\pairing-install-71e435dfa35e4e2fb072ff310024758f`
- Fix Round 1 clean re-install:
  `D:\A-project\clawmessenger\.tmp\pairing-round1-install-65a63f61960646a29f01bbd4bd538365`

`npm init` and `npm install <tarball>` installed `quukk-clawmessenger@0.1.0-beta.7`.
The installed CLI version/help/setup/status/rescan/doctor/stop paths were exercised. The first
isolated home detected installed Codex and OpenCode runtimes, retained zero bindings, served the
browser SPA when requested with normal browser HTML negotiation, and shut down cleanly.

An isolated loopback contract backend allowed the installed package to exercise the entire
pre-selection QR flow without depending on deployment state. Result:

```json
{"setupHttp":200,"setupShell":true,"installedVersion":"0.1.0-beta.7","readyProviders":["codex","opencode"],"bindingsBefore":0,"pairingHttp":200,"pairingState":"waiting","qrFiveFields":true,"qrLoopbackServer":true,"candidateCount":2}
```

Nothing was pre-registered, only detected ready platforms were offered, and the QR had exactly
the five public fields. Both installed daemons were stopped and subsequently returned
`not_running`; the loopback backend process was also terminated.

## Security canary evidence and limitation

The earlier `/api/canary` request did not enter a pairing handler. It is invalid as Step 7
evidence and is superseded; its zero-match result is not used for acceptance.

Fix Round 1 used the actual installed `PairingClient` and `RegistrationClient` against the real
Flask create, poll and register handlers, an isolated SQLite test database and a fake external
credential provisioner. RED and GREEN evidence are stored separately:

```text
D:\A-project\clawmessenger\.tmp\task12-logs\round1-red\summary.json
D:\A-project\clawmessenger\.tmp\task12-logs\round1-green\summary.json
```

The GREEN run observed HTTP 201/200/200, `session_created` and `session_claimed` audit events,
one result row, one committed node and one provisioner call. Five fictitious ticket,
device-secret, Authorization, node-token and local-path categories were scanned in the package
client output and server application log, with zero matches. The sanitized summary contains
only hash prefixes, not canary values.

The configured real server application logger emitted zero bytes for the successful handlers.
That empty capture is truthful but does not establish behavior of the non-empty production
access/application logging stack. Step 7 therefore remains pending until the deployed stack
can be captured and scanned. No real secret was written to either report.

## Commits

- Package canonical contract: `dd58dc3e5`.
- Package Fix Round 1 registration DTO: `503974a9c`.
- Package evidence-status correction: the commit containing this report (resolve with
  `git rev-parse HEAD`).
- Server: `e1bfb7f` (`test: lock pairing protocol contract`).
- Web: `0734abb` (`test: lock pairing protocol contract`).
- UniApp: `dccf6c7` (`test: lock pairing protocol contract`).

The pre-existing package `task-9-report.md` modification and server `.venv/` directory were
neither changed nor committed. The generated tarball remains an untracked acceptance artifact.

## Remaining gates

The production-test host returned HTTP 404 for both
`/im-test/api/ai/pairing/sessions` and `/im/api/ai/pairing/sessions`. Consequently the installed
plugin surfaced its safe `operation_unavailable` response, and a production QR could not be
created. After that backend route is deployed, the coordinating agent still needs to perform
and record real browser click-through, authenticated scan/claim/confirm, user selection,
retry/cancel/expiry, and the resulting Web/UniApp platform-list behavior.

Separately, Step 4 requires a green server full suite or an explicit baseline waiver, and Step 7
requires non-empty production logging-stack evidence. Until those are satisfied, Task 12 must
not be marked complete.

No npm publication, push, merge, or production registration was performed.
