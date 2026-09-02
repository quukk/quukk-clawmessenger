# Task 9 integration report: authenticated retry channel

## Outcome and design choice

The retry action now travels over a durable, authenticated server channel instead of re-reading progress:

1. The Web client sends the strict `ai.retryPairing` command with the scanned ticket, a bounded unique candidate list, and a fresh `crypto.randomUUID()` idempotency key. The verified command sender remains the only user identity source.
2. The server atomically validates ownership, exact expiry, `partial` state, frozen selection membership, and persisted retryable-failure eligibility. It stores an opaque retry request and replays only byte-equivalent uses of the same idempotency key.
3. The already-running local package polls the device-authenticated retry endpoint with the in-memory device secret, consumes each request ID at most once per process, calls the existing `retryFailed(candidateIds)` path, and acknowledges the request with a stable per-request key. Partial results keep the watcher alive; completion, cancellation, and exact expiry stop it.
4. The server derives `processing`, `partial`, and `completed` progress from persisted candidate results. The frozen selection is never expanded or reconfirmed.

Device responses expose only `requestId` and `candidateIds`. They do not include user identity, installation abuse keys, runtime identifiers or paths, secrets, tokens, or raw server errors.

## Files changed

### Server

- `app.py`
- `migrations/20260902_agent_pairing_retry_requests.sql`
- `pairing_repository.py`
- `pairing_service.py`
- `rongcloud/command_handler.py`
- `tests/test_pairing_api.py`
- `tests/test_pairing_migrations.py`
- `tests/test_pairing_repository.py`
- `tests/test_pairing_service.py`
- `tests/test_system_host.py`

### npm package

- `packages/quukk-clawmessenger/src/pairing/schema.ts`
- `packages/quukk-clawmessenger/src/pairing/client.ts`
- `packages/quukk-clawmessenger/src/pairing/client.test.ts`
- `packages/quukk-clawmessenger/src/pairing/service.ts`
- `packages/quukk-clawmessenger/src/pairing/service.test.ts`

### Web core/service

- `src/lib/pairing.ts`
- `src/lib/pairing.test.ts`
- `src/services/pairing.ts`
- `src/services/pairing.test.ts`

`BindDeviceDialog.tsx` was intentionally not modified.

## TDD red evidence

Tests were added and run before each implementation layer.

- Server focused red: `.\.venv\Scripts\python.exe -m pytest tests/test_pairing_repository.py tests/test_pairing_service.py tests/test_pairing_api.py tests/test_pairing_migrations.py tests/test_system_host.py -q` -> **15 failed, 1 passed**. Failures were the missing durable retry repository methods, eligibility/service behavior, user command, and device poll/ack routes.
- Package focused red: `corepack pnpm --filter quukk-clawmessenger test` -> **5 failed, 988 passed**. Failures were the missing retry schemas/client methods and the missing partial-session watcher.
- Web focused red: `npm test -- src/services/pairing.test.ts src/lib/pairing.test.ts` -> **4 failed, 31 passed**. Failures were the missing strict retry parser and retry command service.

## Green and full verification evidence

### Server

- Focused: `.\.venv\Scripts\python.exe -m pytest tests/test_pairing_repository.py tests/test_pairing_service.py tests/test_pairing_api.py tests/test_pairing_migrations.py tests/test_system_host.py -q` -> **166 passed, 3 subtests passed**.
- Full: `.\.venv\Scripts\python.exe -m pytest -q` -> **5 failed, 747 passed, 15 skipped, 9 warnings, 156 subtests passed**.
- The five full-suite failures are unrelated baseline failures and were not claimed as fixed:
  - three `tests/test_admin_routes.py` message endpoint cases;
  - `tests/test_server_regressions.py::AdminConsolidationVerifierTest`;
  - `tests/test_system_host_contract.py` `recommendRoles` fixture/contract case.

### npm package

- Full package tests: `corepack pnpm --filter quukk-clawmessenger test` -> **35 test files, 993 passed**.
- Type check: `corepack pnpm --filter quukk-clawmessenger typecheck` -> **passed**.

### Web

- Focused: `npm test -- src/services/pairing.test.ts src/lib/pairing.test.ts` -> **2 test files, 35 passed**.
- Full (with `CLAWMESSENGER_DISCUSSION_WIRE_CONTRACT` and `CLAWMESSENGER_SYSTEM_HOST_CONTRACT` pointing to the server worktree fixtures): `npm test` -> **26 test files, 250 passed**.
- Production build: `npm run build` -> **passed**. Existing warnings remained for stale Browserslist data, ignored `use client` directives, source maps, and the large output chunk.
- Lint: `npm run lint` -> **passed**.
- `git diff --check` -> **passed** before commit.

## Commits

- Server: `63b00f2 feat: deliver authenticated pairing retries`
- npm package: `5d3434cd2 feat(clawmessenger): consume server pairing retries`
- Web: `bdfc01e feat(web): request authenticated pairing retries`
- This report is committed separately in the npm package repository.

No branch was merged or pushed.

## Repository status

Immediately before this report commit:

- Server `git status --short`: `?? .venv/` (preserved as required).
- npm package `git status --short`: only this new report before staging.
- Web `git status --short`: clean.

## Remaining risks and follow-up

- The durable retry repository has SQLite coverage and a PostgreSQL-safe migration, but no live PostgreSQL contention/runtime exercise was performed in this task.
- This integration task does not include the dialog wiring by design. The original UI implementer must call the new Web `retryPairing(ticket, candidateIds)` service and then exercise the browser-visible interaction.
- A deployed end-to-end run spanning real command delivery, the production-like backend, and an installed npm package remains for later integration/manual test tasks.
- The five unrelated server full-suite baseline failures listed above remain unresolved.

## Independent review fix round 1

All three Important findings and the Minor polling finding were addressed with tests first.

### Changes

- The Server `ai.retryPairing` command boundary now accepts a ticket only when it is exactly 43 URL-safe characters, equivalent to the generated credential contract. Tests cover 42 characters, 44 characters, and an illegal character at the correct length.
- A Server device-route contract test confirms a remotely cancelled retry poll returns only the strict safe DTO `{ "code": 410, "error": "session_cancelled" }`. This endpoint behavior was already correct; the package interpretation was the defect.
- The package client now bounded-parses HTTP 410 bodies with a strict discriminated DTO and maps `session_cancelled` to `pairing_cancelled` separately from `session_expired`. Unknown or extra response fields become `pairing_response_invalid` without retaining response data.
- The package retry watcher now retries ACK independently after registration has reached `completed`. Every attempt reuses the same request ID and ACK idempotency key, and the consumed request is not registered twice.
- Empty retry polls are paced at 2.5 seconds (at most 24 ordinary polls/minute). Retryable poll and ACK failures use injected-sleep exponential backoff of 5, 10, 20, then at most 30 seconds, leaving room below the Server's 30/minute device-IP limit even when the HTTP client uses its bounded second attempt.

### TDD evidence

- Server red: `.\.venv\Scripts\python.exe -m pytest tests/test_system_host.py::TestPairingCommand::test_retry_pairing_rejects_ticket_outside_exact_43_char_urlsafe_contract tests/test_pairing_api.py::test_device_retry_poll_returns_strict_safe_cancelled_error -q` -> **3 failed, 1 passed**. The three credential-boundary cases reached the service instead of returning malformed-request errors; the strict cancelled DTO contract already passed.
- Server green focused: `.\.venv\Scripts\python.exe -m pytest tests/test_pairing_repository.py tests/test_pairing_service.py tests/test_pairing_api.py tests/test_pairing_migrations.py tests/test_system_host.py -q` -> **170 passed, 3 subtests passed**.
- Server full: `.\.venv\Scripts\python.exe -m pytest -q` -> **5 failed, 751 passed, 15 skipped, 9 warnings, 156 subtests passed**. The same five unrelated baseline failures listed above remain.
- Package red: `corepack pnpm --filter quukk-clawmessenger test -- src/pairing/client.test.ts src/pairing/service.test.ts` -> **4 failed, 995 passed**. The failures reproduced cancelled-as-expired, acceptance of an unsafe extra DTO field, loss of a transient ACK after completion, and 500 ms retry polling.
- Package green/full: the same command executed the package suite -> **35 test files, 999 passed**.
- Package type check: `corepack pnpm --filter quukk-clawmessenger typecheck` -> **passed**.
- `git diff --check` passed in both repositories before their commits.

### Fix commits

- Server: `461d874 fix: validate retry tickets at command boundary`
- npm package: `bec6932a0 fix(clawmessenger): harden retry delivery lifecycle`
- This report update is committed separately in the npm package repository.
