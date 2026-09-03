# Task 12 report: canonical pairing contract and clean-install acceptance

Date: 2026-09-03 (Asia/Shanghai)

## Outcome

Task 12 Steps 1-5, 7 and 8 are complete. Interactive browser and production-test-backend
testing in Step 6 is intentionally left to the coordinating agent and is not represented as
complete.

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

Focused final results:

- Package pairing schema/client: 27 passed.
- Server pairing service/API: 95 passed.
- Web pairing parser/service: 38 passed.
- UniApp pairing contract/service: 37 passed.

## Full verification

- Package: 35 files, 1007 tests passed; typecheck and build passed. A first run shared CPU and
  disk with the other three full suites and produced seven 5-second timeouts plus one shutdown
  timing assertion; the immediate isolated serial rerun was fully green.
- Server: 756 passed, 15 skipped, 156 subtests passed, 5 failed. The exact five failures match
  the declared baseline: three `tests/test_admin_routes.py` message cases,
  `AdminConsolidationVerifierTest`, and the `SystemHostContractTest` role-recommendation case.
- Web: 26 files, 257 tests passed; production build and lint passed with existing bundle
  warnings.
- UniApp: 13 files, 145 tests passed; H5 and Weixin mini-program builds passed with existing
  Vue/Sass warnings.
- `git diff --check` passed in every worktree before commit.

Web full tests used the server worktree fixtures via
`CLAWMESSENGER_DISCUSSION_WIRE_CONTRACT` and `CLAWMESSENGER_SYSTEM_HOST_CONTRACT`.

## Pack and clean install

The plan's root-level `npm pack --workspace packages/quukk-clawmessenger --json` was attempted
and correctly rejected because the repository is pnpm-only and has no npm workspace
declaration. Running `npm pack --json` inside the real package directory succeeded:

- tarball:
  `D:\A-project\clawmessenger\quukk-clawmessenger-worktrees\fix-runtime-manifest-beta2\packages\quukk-clawmessenger\quukk-clawmessenger-0.1.0-beta.7.tgz`
- size: 363,726 bytes; unpacked: 1,652,107 bytes; entries: 106
- SHA-1: `205a3da1afbfbe90784fb570318be2071de358d6`
- temporary project:
  `D:\A-project\clawmessenger\.tmp\pairing-install-71e435dfa35e4e2fb072ff310024758f`

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

## Security canary evidence

Each isolated installed service received five explicitly fictitious canaries representing a
ticket, device secret, Pairing Authorization value, node token and private filesystem path.
The two generated bridge logs were scanned after the requests and each reported zero matches.
The sanitized evidence log is:

```text
D:\A-project\clawmessenger\.tmp\task12-logs\installed-canary-check.log
```

No real secret was written to this report, command output, or retained evidence log.

## Commits

- Package: the commit containing this report (resolve with `git rev-parse HEAD`).
- Server: `e1bfb7f` (`test: lock pairing protocol contract`).
- Web: `0734abb` (`test: lock pairing protocol contract`).
- UniApp: `dccf6c7` (`test: lock pairing protocol contract`).

The pre-existing package `task-9-report.md` modification and server `.venv/` directory were
neither changed nor committed. The generated tarball remains an untracked acceptance artifact.

## Remaining Step 6

The production-test host returned HTTP 404 for both
`/im-test/api/ai/pairing/sessions` and `/im/api/ai/pairing/sessions`. Consequently the installed
plugin surfaced its safe `operation_unavailable` response, and a production QR could not be
created. After that backend route is deployed, the coordinating agent still needs to perform
and record real browser click-through, authenticated scan/claim/confirm, user selection,
retry/cancel/expiry, and the resulting Web/UniApp platform-list behavior.

No npm publication, push, merge, or production registration was performed.
