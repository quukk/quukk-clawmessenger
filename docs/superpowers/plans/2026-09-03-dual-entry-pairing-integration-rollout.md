# Dual-Entry Pairing Integration and Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy and prove the complete QR/code pairing workflow across the backend, published NPM plugin, Web client, and uni-app clients without breaking existing v1 pairing or messaging flows.

**Architecture:** Roll out from the stateful core outward: configuration and database migrations, backend v2 APIs, single beta NPM package, Web, then uni-app. A versioned shared fixture and a single acceptance report tie contract evidence together. Production-like tests use clean installs and two distinct user devices, with secrets redacted from artifacts.

**Tech Stack:** PostgreSQL, Flask/pytest, Node.js 22, pnpm/npm, Vitest, Web browser, uni-app H5/WeChat build, PowerShell, GitHub Actions/NPM.

**Spec:** `D:/A-project/clawmessenger/quukk-clawmessenger-worktrees/fix-runtime-manifest-beta2/docs/superpowers/specs/2026-09-03-dual-entry-pairing-code-design.md`

## Global Constraints

- Execute only after the four subsystem plans have passed their completion gates.
- Treat deployment and NPM publication as separate external-change checkpoints; obtain explicit execution-time approval immediately before each action.
- Roll back by component version; never roll back database columns or delete pairing-attempt history during an incident.
- Do not publish or deploy if any v1 contract fixture changes unexpectedly.
- Never paste active tokens, QR tickets, pairing codes, cookies, CSRF values, passwords, or device secrets into committed reports, shell history screenshots, issue trackers, or chat.
- Use a dedicated test account pair and disposable pairing sessions. Stop the bridge after testing to invalidate its local setup session.
- The rollout order is configuration key, database, server, NPM beta, Web, uni-app. Do not expose manual-code UI before the v2 server is healthy.

---

## Task 1: Freeze and Compare the Cross-Repository v2 Contract

**Files:**

- Modify: `D:/A-project/clawmessenger/quukk-clawmessenger-worktrees/fix-runtime-manifest-beta2/packages/quukk-clawmessenger/src/protocol/fixtures/pairing-v2-create.json`
- Create: `D:/A-project/clawmessenger/quukk-clawmessenger-worktrees/fix-runtime-manifest-beta2/packages/quukk-clawmessenger/src/protocol/fixtures/pairing-errors-v2.json`
- Create: `D:/A-project/clawmessenger/clawmessenger-server/tests/fixtures/pairing_v2_command.json`
- Create: `D:/A-project/clawmessenger/clawmessenger-server/tests/fixtures/pairing_v2_errors.json`
- Modify: `D:/A-project/clawmessenger/clawmessenger-web/src/test/fixtures/pairing_v2.json`
- Create: `D:/A-project/clawmessenger/clawmessenger-web/src/test/fixtures/pairing_errors_v2.json`
- Modify: `D:/A-project/clawmessenger/clawmessenger-uniapp/src/utils/__fixtures__/pairing-v2.json`
- Create: `D:/A-project/clawmessenger/clawmessenger-uniapp/src/utils/__fixtures__/pairing-errors-v2.json`
- Create: `D:/A-project/clawmessenger/quukk-clawmessenger-worktrees/fix-runtime-manifest-beta2/.superpowers/sdd/2026-09-03-dual-entry-pairing/acceptance-report.md`

**Interfaces:**

- Produces one exact computer-create fixture for the plugin and one canonical sanitized command snapshot shared by server, Web, and uni-app with `sessionRef`, `status`, `expiresAt`, candidates, empty initial selection, and no secret credential.
- Consumes each repository's parser test for its side of the v2 boundary.

- [ ] Add a failing plugin assertion that checks the exact `{ code: 201, data: { ticket, deviceSecret, pairingCode, expiresAt, status, candidates } }` creation envelope. In server, Web, and uni-app tests, check the same opaque `sessionRef`, status `claimed`, two frozen candidates, and `selectedCandidateIds: []` command snapshot.
- [ ] Run the three focused parser tests from their respective repositories and confirm at least one fails before fixture synchronization.
- [ ] Make the server/Web/uni-app command fixtures byte-identical after line-ending normalization. Keep the plugin creation fixture separate because it necessarily contains ticket, compact code, and device secret; use only fixed fake values.

```json
{
  "code": 200,
  "data": {
    "sessionRef": "48ced580-7bd2-4b90-98e2-e81d470dc4b0",
    "status": "claimed",
    "selectedCandidateIds": [],
    "candidates": [
      {"candidateId":"rt_opencode","provider":"opencode","displayName":"OpenCode","version":"1.0.0","readiness":"ready","statusReason":null,"registrationState":"unregistered"},
      {"candidateId":"rt_openclaw","provider":"openclaw","displayName":"OpenClaw","version":"1.0.0","readiness":"ready","statusReason":null,"registrationState":"unregistered"}
    ],
    "expiresAt": "2026-09-03T09:10:00+00:00"
  }
}
```

- [ ] Make all four error fixtures byte-identical with this safe public set. Assert the server emits only its applicable subset and every client maps all entries it can receive without falling back to a generic error:

```json
[
  "pairing_code_unavailable",
  "pairing_rate_limited",
  "pairing_unavailable",
  "pairing_timeout",
  "pairing_transport",
  "pairing_unauthorized",
  "pairing_response_invalid"
]
```
- [ ] Run all three focused parser tests and confirm they pass.
- [ ] Start `acceptance-report.md` with commit hashes, individual fixture SHA-256 values, exact test commands, and redacted results. Commit the fixture/report changes in their owning repositories with `test: align pairing v2 contract fixtures`; do not combine repositories in one Git commit.

---

## Task 2: Configure, Migrate, and Deploy the Test Backend

**Files:**

- Update through the deployment secret manager, not Git: dedicated pairing-code HMAC key, client-claim HMAC key, and IP-lookup HMAC key.
- Update ordinary environment configuration: `PAIRING_TRUSTED_PROXY_CIDRS` with only the test ingress proxy/LB network ranges.
- Append evidence: `D:/A-project/clawmessenger/quukk-clawmessenger-worktrees/fix-runtime-manifest-beta2/.superpowers/sdd/2026-09-03-dual-entry-pairing/acceptance-report.md`

**Interfaces:**

- Produces healthy `POST /api/ai/pairing/v2/sessions`, authenticated `POST /api/ai/pairing/v2/resolve`, and four authenticated v2 follow-up commands.
- Preserves `POST /api/ai/pairing/sessions` and v1 user commands.

- [ ] Generate three independent 32-byte production-strength keys in the test environment's secret manager. Record only secret names and configured version identifiers, never values.
- [ ] Set `PAIRING_TRUSTED_PROXY_CIDRS` to the exact ingress proxy/LB CIDRs, then verify a direct request cannot spoof its rate-limit address with `X-Forwarded-For` while a request arriving through the trusted proxy resolves the original client address.
- [ ] Take a database backup/snapshot and record its recovery identifier.
- [ ] Deploy schema migrations in order: columns/table first, then each concurrent index migration separately. Verify columns with `information_schema.columns`, verify index validity with `pg_index.indisvalid`, and verify there are no invalid indexes.
- [ ] Deploy the backend commit and wait for all application workers to report healthy.
- [ ] Probe the public health endpoint and v1 create endpoint, then create one v2 session through an authenticated disposable bridge request. Confirm HTTP response time is below the existing client timeout and the v2 response expires approximately 600 seconds later.
- [ ] Exercise wrong code five times for one account and confirm only that account is throttled; verify the real target session remains waiting and a different account is governed independently.
- [ ] Append redacted timestamps, deployment version, migration output, latency, and rollback identifiers to the acceptance report.
- [ ] If any gate fails, stop rollout, restore the previous backend application version while leaving additive migrations in place, and document the failure.

---

## Task 3: Publish and Clean-Install the Single beta.8 NPM Package

**Files:**

- Modify only release metadata already named in the plugin plan.
- Append evidence: `D:/A-project/clawmessenger/quukk-clawmessenger-worktrees/fix-runtime-manifest-beta2/.superpowers/sdd/2026-09-03-dual-entry-pairing/acceptance-report.md`

**Interfaces:**

- Produces `quukk-clawmessenger@0.1.0-beta.8` under NPM dist-tag `beta`.
- Consumes the deployed v2 test server URL.

- [ ] Verify `npm view quukk-clawmessenger@0.1.0-beta.8 version` is absent before publishing and that the current branch/tag points to the fully verified commit.
- [ ] Use `superpowers:finishing-a-development-branch` to review and integrate the verified plugin commit series into protected `main`, push `main`, and confirm GitHub shows the intended commit before requesting the publication checkpoint.
- [ ] Trigger `.github/workflows/quukk-clawmessenger-runtime.yml` from protected `main` with `publish=true` and `entry_only=true`, using the repository environment's `NPM_TOKEN`. Apply the already approved `--provenance=false` adjustment only to the entry-only publish step for this beta, and confirm the workflow publishes exactly one package while reusing the verified beta.5 runtime dependencies.
- [ ] Verify registry state:

```powershell
npm view quukk-clawmessenger@0.1.0-beta.8 version dist.integrity dist.tarball
npm view quukk-clawmessenger dist-tags --json
```

- [ ] On a clean Windows device, unset `NODE_TLS_REJECT_UNAUTHORIZED`, install `npm install -g quukk-clawmessenger@0.1.0-beta.8`, and confirm `quukk-clawmessenger --version` returns `0.1.0-beta.8`.
- [ ] Run `quukk-clawmessenger stop`, then run setup with a PowerShell argument array containing the plain test server URL, workdir, and authorized work root. Confirm automatic launch retains `#ticket=` or the terminal prints the complete one-time fallback URL.
- [ ] Run `quukk-clawmessenger doctor --json` and `quukk-clawmessenger rescan --json`; confirm at least the installed OpenCode/OpenClaw runtime appears ready and `config_unavailable` is absent after valid setup.
- [ ] Confirm the Setup page renders one QR, one `XXXX-XXXX` code, copy action, and one countdown. Append package integrity, workflow run, installed path, diagnostic summary, and redacted screenshot references to the report.
- [ ] If publication succeeds but installation fails, move the `beta` dist-tag back to the previous verified version and do not unpublish the immutable beta.8 artifact.

---

## Task 4: Web End-to-End Pairing and Messaging Regression

**Files:**

- Append evidence: `D:/A-project/clawmessenger/quukk-clawmessenger-worktrees/fix-runtime-manifest-beta2/.superpowers/sdd/2026-09-03-dual-entry-pairing/acceptance-report.md`

**Interfaces:**

- Consumes the deployed Web build, beta.8 bridge, and test backend.
- Produces successful QR and manual-code pairing records for separate disposable sessions.

- [ ] Deploy the verified Web build after the server and beta package are healthy.
- [ ] Sign in on Web device A. Generate session 1 on the Windows bridge, scan/upload its QR, select only OpenCode, confirm, and verify the bridge shows the claimed/connected state.
- [ ] Generate session 2. Enter the displayed code manually on Web, select only OpenClaw, confirm, and verify the same result UI and progress behavior.
- [ ] Generate session 3. Resolve by QR on device A, then attempt the code on signed-in device B; confirm device B receives only `pairing_code_unavailable` and cannot list or select runtimes.
- [ ] Verify same-device retry with the same entry source is idempotent, while switching source after resolve is rejected.
- [ ] With the paired agent, execute one single chat, one group chat, and one discussion-group flow. For the discussion group, verify the configured host AI can join, receive context, respond, and leave/finish without duplicate events.
- [ ] Append redacted user IDs, session timestamps, selected provider names, message IDs, screenshots, and outcomes to the acceptance report.

---

## Task 5: uni-app H5 and Mini-Program End-to-End Pairing

**Files:**

- Append evidence: `D:/A-project/clawmessenger/quukk-clawmessenger-worktrees/fix-runtime-manifest-beta2/.superpowers/sdd/2026-09-03-dual-entry-pairing/acceptance-report.md`

**Interfaces:**

- Consumes deployed H5 and a locally loaded signed mini-program build against the same test backend.

- [ ] Deploy H5 after the Web flow passes. On H5, pair one fresh session by manual code, select multiple ready runtimes, and verify progress/results.
- [ ] On a physical mobile device or approved emulator, load the mini-program build and pair a fresh session by scanning the QR. Verify camera permission denial and retry before the successful path.
- [ ] Repeat one mini-program session by manual code to verify keyboard, paste where supported, auto-formatting, and touch layout.
- [ ] Test expiry, cancellation, wrong-code feedback, per-account throttling, app background/foreground, and page teardown. Confirm no session resumes after a process restart.
- [ ] Execute one single chat, one group chat, and one discussion-group flow from uni-app against the paired agent.
- [ ] Append target versions, build hashes, device/OS, redacted screenshots, message IDs, and outcomes to the acceptance report.

---

## Task 6: Final Security, Compatibility, and Rollout Decision

**Files:**

- Finalize: `D:/A-project/clawmessenger/quukk-clawmessenger-worktrees/fix-runtime-manifest-beta2/.superpowers/sdd/2026-09-03-dual-entry-pairing/acceptance-report.md`

**Interfaces:**

- Produces a signed-off go/no-go record for beta.8 and the three client deployments.

- [ ] Query the database for sampled v2 rows and confirm no raw pairing code, client key, ticket, device secret, or IP address is stored. Verify attempt rows contain only user ID, keyed IP hash, timestamp, and coarse result.
- [ ] Search backend and bridge logs for the redacted test credential fingerprints and confirm none appear.
- [ ] Run v1 pairing once from a compatibility client and confirm its exact old response/state behavior still works.
- [ ] Confirm all subsystem test suites/builds and every E2E row in the report is green. Link exact commit hashes and deployment versions.
- [ ] Mark the rollout `GO` only if QR, manual code, claim exclusivity, rate limits, Web messaging, uni-app messaging, and discussion host all pass. Otherwise mark `NO-GO`, name the failed gate, and execute the component rollback described above.
- [ ] Commit the sanitized final report:

```powershell
git add .superpowers/sdd/2026-09-03-dual-entry-pairing/acceptance-report.md
git commit -m "test: record dual-entry pairing acceptance"
```

---

## Completion Gate

- [ ] The NPM registry exposes one beta package, not seven user-facing packages.
- [ ] QR and manual code each work once and lock the other device/source after first resolve.
- [ ] Existing v1 pairing, single chat, group chat, and discussion-group behavior remains green.
- [ ] All evidence is sanitized, all temporary bridges are stopped, and all disposable active pairing sessions are expired or cancelled.
