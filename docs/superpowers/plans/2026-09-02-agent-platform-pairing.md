# Agent Platform QR Pairing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace manual node-ID binding with a one-time QR flow that discovers local agent platforms, lets the signed-in user choose platforms, and registers and binds only the selected platforms.

**Architecture:** A server-mediated pairing session carries sanitized runtime candidates and separates a public QR ticket from a private computer secret. Authenticated Web/UniApp commands claim and select candidates; the package then performs session-authorized just-in-time registration, while existing device, chat, operations, and discussion-group flows continue using normal node records.

**Tech Stack:** Node.js 22, TypeScript, Zod, React, Vite, Vitest, Python 3, Flask, PostgreSQL/SQLite test doubles, RongCloud system commands, Vue 3/UniApp, jsQR.

**Spec:** `docs/superpowers/specs/2026-09-02-agent-platform-pairing-design.md`

## Global Constraints

- The QR payload contains only `type`, `version`, configured `server`, opaque `ticket`, and `expiresAt`.
- Production QR origins must use HTTPS; loopback HTTP is allowed only for explicit local development.
- Public tickets and private device secrets use at least 256 bits of cryptographic randomness and are stored only as hashes on the server.
- Runtime IDs, executable paths, authorized roots, tokens, bridge secrets, and MAC addresses never appear in QR data or user-facing pairing responses.
- No candidate is selected by default.
- Only selected, ready candidates may register; unselected candidates must not call any registration endpoint.
- The verified RongCloud sender determines the claiming user; payload `user_id` is ignored.
- Node creation and owner association commit together; failed external credential provisioning must not leave a server node row.
- Existing bindings remain operational, and `ai.scanBind` remains server-compatible for one release while disappearing from new client UI.
- Stable errors are machine-readable; logs never contain tickets, private secrets, node tokens, authorization headers, or local paths.

## Repository and File Map

The four repositories form one protocol and are not independently shippable for this feature, so this is one ordered plan rather than four divergent plans.

### `clawmessenger-server`

- Create `migrations/20260902_add_agent_pairing.sql`: pairing session/result/audit tables and indexes.
- Create `pairing_repository.py`: hashed-secret persistence and atomic state transitions.
- Create `pairing_service.py`: validation, ownership, expiration, selection, progress, and safe DTOs.
- Create `node_registration_service.py`: reusable node provisioning plus atomic owner association.
- Modify `app.py`: computer-facing pairing routes and legacy registration delegation.
- Modify `rongcloud/command_handler.py`: authenticated pairing commands.
- Create `tests/test_pairing_repository.py`, `tests/test_pairing_service.py`, and `tests/test_pairing_api.py`.
- Modify `tests/test_server_regressions.py`: legacy compatibility and ownership regressions.

### `quukk-clawmessenger`

- Create `packages/quukk-clawmessenger/src/pairing/schema.ts`: package-side protocol schemas and types.
- Create `packages/quukk-clawmessenger/src/pairing/client.ts`: bounded, redacted server transport.
- Create `packages/quukk-clawmessenger/src/pairing/service.ts`: local session orchestration and candidate-to-runtime map.
- Modify `packages/quukk-clawmessenger/src/registration/client.ts`: session-authorized registration transport.
- Modify `packages/quukk-clawmessenger/src/bindings/service.ts`: register a selected runtime with pairing context.
- Modify `packages/quukk-clawmessenger/src/service.ts` and `src/http/routes.ts`: local bridge pairing API.
- Create matching `*.test.ts` files beside these modules.
- Modify `apps/bridge/src/types.ts`, `api.ts`, and tests: typed local bridge calls.
- Create `apps/bridge/src/components/pairing-panel.tsx` and test.
- Modify `apps/bridge/src/pages/setup.tsx` and `setup.test.tsx`: discovery summary plus QR lifecycle.
- Modify `apps/bridge/package.json` and `pnpm-lock.yaml`: add `react-qr-code@2.0.18`.

### `clawmessenger-web`

- Create `src/lib/pairing.ts` and `src/lib/pairing.test.ts`: QR and command schemas.
- Create `src/services/pairing.ts` and `src/services/pairing.test.ts`: authenticated system-command adapter.
- Create `src/hooks/useQrScanner.ts` and test: camera/image decoding with cleanup.
- Rewrite `src/sections/BindDeviceDialog.tsx` and add `BindDeviceDialog.test.tsx`.
- Modify `src/pages/Home.tsx`: replace `bindNode` callback with pairing completion refresh.
- Modify `package.json` and lockfile: add `jsqr@1.4.0`.

### `clawmessenger-uniapp`

- Create `src/utils/pairing-contract.js` and test.
- Create `src/utils/pairing-service.js` and test.
- Create `src/subPackages/remote/utils/pairing-qr.js` and test.
- Create `src/subPackages/remote/components/pairing-platform-picker.vue` and test.
- Modify `src/subPackages/remote/pages/remote/index.vue`: remove node-ID entry and connect scanning to selection/progress.

---

### Task 1: Server Pairing Repository and State Machine

**Files:**
- Create: `clawmessenger-server/migrations/20260902_add_agent_pairing.sql`
- Create: `clawmessenger-server/pairing_repository.py`
- Create: `clawmessenger-server/pairing_service.py`
- Test: `clawmessenger-server/tests/test_pairing_repository.py`
- Test: `clawmessenger-server/tests/test_pairing_service.py`

**Interfaces:**
- Produces: `PairingService.create_session(candidates, abuse_key) -> dict`
- Produces: `PairingService.inspect(ticket, user_id) -> dict`
- Produces: `PairingService.confirm(ticket, user_id, candidate_ids) -> dict`
- Produces: `PairingService.poll_selection(ticket, device_secret) -> dict`
- Produces: `PairingService.progress(ticket, user_id) -> dict`
- Produces: `PairingService.cancel_by_user(ticket, user_id) -> dict`
- Produces: `PairingService.cancel_by_device(ticket, device_secret) -> dict`

- [ ] **Step 1: Write repository transition tests**

```python
def test_only_one_user_can_claim_a_waiting_session(repository, session):
    first = repository.claim(session.ticket, "user-a", ["cand-a"])
    second = repository.claim(session.ticket, "user-b", ["cand-a"])
    assert first.status == "claimed"
    assert second.error_code == "session_claimed"

def test_secrets_are_hashed_and_expired_session_cannot_transition(repository, clock):
    created = repository.create_session([ready_candidate("cand-a")], "bucket")
    assert repository.raw_row(created.session_id)["ticket_hash"] != created.ticket
    assert repository.raw_row(created.session_id)["device_secret_hash"] != created.device_secret
    clock.advance(seconds=301)
    assert repository.poll_selection(created.ticket, created.device_secret).error_code == "session_expired"

def test_audit_records_safe_transition_metadata_only(repository, session):
    repository.claim(session.ticket, "user-a", ["cand-a"])
    event = repository.audit_events(session.session_id)[-1]
    assert event["event_type"] == "session_claimed"
    assert "ticket" not in json.dumps(event)
    assert "device_secret" not in json.dumps(event)
```

- [ ] **Step 2: Run the new repository tests and verify failure**

Run: `cd D:\A-project\clawmessenger\clawmessenger-server; python -m pytest tests/test_pairing_repository.py -q`

Expected: FAIL because `pairing_repository` and the migration do not exist.

- [ ] **Step 3: Add the migration and repository**

Implement `im_pairing_sessions` with hashed credentials, JSON candidate snapshots, frozen selection, claimant, status, and timestamps. Implement `im_pairing_results` with `(session_id, candidate_id)` uniqueness and a unique idempotency key. Implement `im_pairing_audit` with event type, session ID, candidate ID, resolved user ID, safe error code, and timestamp only. All claim/state transitions use a transaction plus PostgreSQL row locks with `FOR UPDATE` and the repository's existing SQLite-compatible locking convention in tests.

```python
@dataclass(frozen=True)
class PairingCredentials:
    session_id: str
    ticket: str
    device_secret: str
    expires_at: datetime
```

The repository exposes these exact methods: `create_session(candidates: list[dict], abuse_key: str) -> PairingCredentials`, `claim(ticket: str, user_id: str, candidate_ids: list[str]) -> PairingSnapshot`, `authenticate_device(ticket: str, device_secret: str) -> PairingSnapshot`, `record_result(session_id: str, candidate_id: str, result: dict, idempotency_key: str) -> PairingSnapshot`, and `append_audit(session_id: str, event_type: str, candidate_id: str | None, user_id: str | None, error_code: str | None) -> None`.

- [ ] **Step 4: Write service validation and safe-DTO tests**

```python
def test_create_session_rejects_sensitive_or_duplicate_candidates(service):
    with pytest.raises(PairingError, match="invalid_candidates"):
        service.create_session([
            {"candidateId": "same", "provider": "opencode", "displayName": "OpenCode", "path": "C:/secret"},
            {"candidateId": "same", "provider": "codex", "displayName": "Codex"},
        ], "bucket")

def test_confirm_freezes_exact_ready_selection(service, session):
    confirmed = service.confirm(session.ticket, "user-a", ["cand-ready"])
    assert confirmed["selectedCandidateIds"] == ["cand-ready"]
    with pytest.raises(PairingError, match="selection_frozen"):
        service.confirm(session.ticket, "user-a", ["cand-ready", "cand-other"])
```

- [ ] **Step 5: Implement the service state machine**

Use constants `PAIRING_TTL_SECONDS = 300`, `PAIRING_OFFLINE_GRACE_SECONDS = 60`, and candidate limits of 16 items, 64-character candidate IDs, 32-character provider names, 80-character display names, and 64-character versions. Return only `candidateId`, `provider`, `displayName`, `version`, `readiness`, `statusReason`, and `registrationState` to clients.

- [ ] **Step 6: Run server unit tests**

Run: `python -m pytest tests/test_pairing_repository.py tests/test_pairing_service.py -q`

Expected: PASS, including concurrency, expiry, claim, freeze, cancellation, and redaction cases.

- [ ] **Step 7: Commit Task 1**

```powershell
git add migrations/20260902_add_agent_pairing.sql pairing_repository.py pairing_service.py tests/test_pairing_repository.py tests/test_pairing_service.py
git commit -m "feat: add agent pairing state machine"
```

### Task 2: Authenticated User Pairing Commands

**Files:**
- Modify: `clawmessenger-server/rongcloud/command_handler.py`
- Test: `clawmessenger-server/tests/test_system_host.py`
- Test: `clawmessenger-server/tests/test_server_regressions.py`

**Interfaces:**
- Consumes: Task 1 `PairingService.inspect`, `confirm`, `progress`, and `cancel_by_user`.
- Produces: RongCloud actions `ai.getPairingSession`, `ai.confirmPairing`, `ai.getPairingProgress`, and `ai.cancelPairing`.

- [ ] **Step 1: Write failing command identity tests**

```python
def test_confirm_pairing_uses_verified_sender_not_payload_user(handler, pairing_service):
    result = handler._handle_ai_confirmPairing(
        {"ticket": "ticket-a", "candidateIds": ["cand-a"], "user_id": "attacker"},
        "rongcloud-user-a",
    )
    pairing_service.confirm.assert_called_once_with("ticket-a", "resolved-user-a", ["cand-a"])
    assert result["code"] == 200

def test_progress_is_hidden_from_second_scanner(handler, claimed_session):
    result = handler._handle_ai_getPairingProgress({"ticket": claimed_session.ticket}, "user-b")
    assert result == {"code": 409, "message": "配对会话已被其他账号认领"}
```

- [ ] **Step 2: Run targeted tests and verify failure**

Run: `python -m pytest tests/test_system_host.py -k Pairing tests/test_server_regressions.py -k pairing -q`

Expected: FAIL because the four handlers do not exist.

- [ ] **Step 3: Implement four thin command handlers**

Each handler validates scalar/list shape, calls `_resolve_user_id(from_user_id)`, checks the resolved user is active, and delegates to `PairingService`. Map stable domain codes to HTTP-like command codes: malformed `400`, inactive user `403`, missing `404`, expired `410`, claimed/frozen `409`, rate limited `429`.

```python
def _handle_ai_confirmPairing(self, payload: dict, from_user_id: str) -> dict:
    ticket = _required_pairing_ticket(payload)
    candidate_ids = _required_candidate_ids(payload)
    user_id = self._active_resolved_user(from_user_id)
    return {"code": 200, "data": get_pairing_service().confirm(ticket, user_id, candidate_ids)}
```

- [ ] **Step 4: Run command and regression tests**

Run: `python -m pytest tests/test_system_host.py tests/test_server_regressions.py -q`

Expected: PASS; existing `ai.scanBind` ownership tests remain green.

- [ ] **Step 5: Commit Task 2**

```powershell
git add rongcloud/command_handler.py tests/test_system_host.py tests/test_server_regressions.py
git commit -m "feat: expose authenticated pairing commands"
```

### Task 3: Computer Pairing API and Atomic Node Ownership

**Files:**
- Create: `clawmessenger-server/node_registration_service.py`
- Modify: `clawmessenger-server/app.py`
- Test: `clawmessenger-server/tests/test_pairing_api.py`
- Modify: `clawmessenger-server/tests/test_server_regressions.py`

**Interfaces:**
- Consumes: Task 1 session/device authentication and frozen selection.
- Produces: `POST /api/ai/pairing/sessions`, `GET /api/ai/pairing/sessions/<ticket>/selection`, `POST /api/ai/pairing/sessions/<ticket>/candidates/<candidate_id>/register`, and `DELETE /api/ai/pairing/sessions/<ticket>`.
- Produces: `NodeRegistrationService.register_pairing_candidate(session_id, user_id, candidate_id, idempotency_key, request) -> RegistrationResult`.

- [ ] **Step 1: Write failing API security and idempotency tests**

```python
def test_register_requires_private_secret_confirmed_selection_and_idempotency(client, session):
    response = client.post(
        f"/api/ai/pairing/sessions/{session.ticket}/candidates/cand-a/register",
        headers={"Authorization": "Pairing wrong", "Idempotency-Key": "pair-cand-a-v1"},
        json=valid_registration_body("opencode"),
    )
    assert response.status_code == 401

def test_registration_rolls_back_node_when_owner_insert_fails(service, db, confirmed_session):
    db.fail_next("im_user_nodes")
    with pytest.raises(NodeRegistrationError):
        service.register_pairing_candidate(confirmed_session, "cand-a", request())
    assert db.count("im_nodes") == 0
```

- [ ] **Step 2: Run the API tests and verify failure**

Run: `python -m pytest tests/test_pairing_api.py -q`

Expected: FAIL with missing routes/service.

- [ ] **Step 3: Extract reusable node registration**

Move validation and node/RongCloud provisioning used by `/api/ai/register` into `NodeRegistrationService`. Provision the RongCloud identity before the database transaction; then insert/update `im_nodes` and upsert `im_user_nodes(role='owner')` in one database transaction. If credential provisioning fails, write no database node. If the database transaction fails after RongCloud provisioning, keep no server node row and allow the same idempotency key to reuse the external identity on retry.

```python
@dataclass(frozen=True)
class PairingRegistrationRequest:
    provider: str
    name: str
    mac_address: str
    capabilities: list[str]

def register_pairing_candidate(
    self,
    *,
    session_id: str,
    user_id: str,
    candidate_id: str,
    idempotency_key: str,
    request: PairingRegistrationRequest,
) -> dict:
    snapshot = self.pairing_repository.require_selected(session_id, candidate_id, user_id)
    credential = self.rongcloud_provisioner.provision(request.provider, request.name)
    return self.pairing_repository.commit_node_and_owner(
        snapshot=snapshot,
        candidate_id=candidate_id,
        idempotency_key=idempotency_key,
        request=request,
        credential=credential,
    )
```

- [ ] **Step 4: Add hardened computer routes**

Session creation accepts only sanitized candidates and a 64-hex-character `X-Install-Abuse-Key`. Device-authenticated routes require `Authorization: Pairing <deviceSecret>`. Registration additionally requires a 16-128 character `Idempotency-Key`; the provider must equal the frozen candidate provider. Apply bounded request size, IP/abuse-bucket rate limits, constant-time secret checks, safe error envelopes, and redacted logging.

- [ ] **Step 5: Delegate legacy registration without changing its response**

Keep `/api/ai/register` and `/api/claw/register` response fields `node_id`, `node_type`, `name`, `token`, and `capabilities`. Add regression assertions that old clients still register unowned nodes and that `/api/scan/bind` remains `410`.

- [ ] **Step 6: Run API and full server tests**

Run: `python -m pytest tests/test_pairing_api.py tests/test_server_regressions.py tests/test_system_host.py -q`

Expected: PASS, including wrong secret, expired session, unselected candidate, provider mismatch, duplicate idempotency key, partial completion, and cross-account ownership cases.

- [ ] **Step 7: Commit Task 3**

```powershell
git add node_registration_service.py app.py tests/test_pairing_api.py tests/test_server_regressions.py
git commit -m "feat: register paired agents atomically"
```

### Task 4: Package Pairing Protocol and Server Client

**Files:**
- Create: `packages/quukk-clawmessenger/src/pairing/schema.ts`
- Create: `packages/quukk-clawmessenger/src/pairing/client.ts`
- Create: `packages/quukk-clawmessenger/src/pairing/schema.test.ts`
- Create: `packages/quukk-clawmessenger/src/pairing/client.test.ts`
- Modify: `packages/quukk-clawmessenger/src/logging/redact.test.ts`

**Interfaces:**
- Produces: `PairingCandidate`, `PairingSession`, `PairingSelection`, `PairingProgress`, and `PairingRegistrationAuthorization`.
- Produces: `PairingClient.createSession`, `pollSelection`, `registerCandidate`, and `cancelSession`.

- [ ] **Step 1: Write schema and transport failure tests**

```ts
it('rejects a QR/session response containing a local path', () => {
  const unsafeCandidate = Object.assign({}, candidate, { path: 'C:\\secret' });
  const unsafeSession = Object.assign({}, validSession, { candidates: [unsafeCandidate] });
  expect(() => pairingSessionSchema.parse(unsafeSession)).toThrow();
});

it('never puts pairing credentials in a URL or loggable error', async () => {
  await expect(client.pollSelection(ticket, deviceSecret)).rejects.toMatchObject({ code: 'pairing_transport' });
  expect(fetchSpy.mock.calls[0]![0]).not.toContain(deviceSecret);
  expect(JSON.stringify(fetchSpy.mock.calls[0]![1])).not.toContain(`?ticket=${ticket}`);
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `pnpm --filter quukk-clawmessenger test -- src/pairing/schema.test.ts src/pairing/client.test.ts`

Expected: FAIL because the pairing modules do not exist.

- [ ] **Step 3: Implement strict Zod contracts**

Define exact enums from the spec, cap all string/list sizes, use `.strict()` for QR/session/candidate objects, and expose `pairingQrContent(session, serverUrl)` that serializes only the five approved QR fields. Permit `http://127.0.0.1` and `http://localhost` only when `allowLoopbackHttp` is true.

- [ ] **Step 4: Implement bounded server transport**

Follow `registration/client.ts` response-size, timeout, retry, redirect, and error normalization patterns. Put `deviceSecret` only in `Authorization`, put idempotency only in `Idempotency-Key`, and return stable `PairingClientError` codes without response bodies.

- [ ] **Step 5: Add pairing redaction assertions**

Extend logging tests with `ticket`, `deviceSecret`, `Authorization: Pairing`, and pairing URL cases. The redactor must replace credential values while retaining safe route templates and error codes.

- [ ] **Step 6: Run package tests and typecheck**

Run: `pnpm --filter quukk-clawmessenger test -- src/pairing src/logging/redact.test.ts`

Run: `pnpm --filter quukk-clawmessenger typecheck`

Expected: both PASS.

- [ ] **Step 7: Commit Task 4**

```powershell
git add packages/quukk-clawmessenger/src/pairing packages/quukk-clawmessenger/src/logging/redact.test.ts
git commit -m "feat(clawmessenger): add pairing protocol client"
```

### Task 5: Package Just-in-Time Selection Orchestrator

**Files:**
- Create: `packages/quukk-clawmessenger/src/pairing/service.ts`
- Create: `packages/quukk-clawmessenger/src/pairing/service.test.ts`
- Modify: `packages/quukk-clawmessenger/src/registration/client.ts`
- Modify: `packages/quukk-clawmessenger/src/registration/client.test.ts`
- Modify: `packages/quukk-clawmessenger/src/bindings/service.ts`
- Modify: `packages/quukk-clawmessenger/src/bindings/service.test.ts`

**Interfaces:**
- Consumes: Task 4 `PairingClient` and `PairingRegistrationAuthorization`.
- Produces: `PairingService.start()`, `snapshot()`, `cancel()`, and `retryFailed(candidateIds)`.
- Produces: `BindingService.enablePairingSelection({ runtimeId, authorization })`.

- [ ] **Step 1: Write failing orchestration tests**

```ts
it('registers exactly the selected ready runtimes', async () => {
  await service.start();
  selection.resolve({ selectedCandidateIds: ['cand-opencode'] });
  await service.waitForTerminal();
  expect(bindings.enablePairingSelection).toHaveBeenCalledTimes(1);
  expect(bindings.enablePairingSelection).toHaveBeenCalledWith(expect.objectContaining({ runtimeId: opencode.id }));
  expect(bindings.enablePairingSelection).not.toHaveBeenCalledWith(expect.objectContaining({ runtimeId: codex.id }));
});

it('invalidates an in-memory session after service restart', async () => {
  const first = await service.start();
  await restartedService.recover();
  expect(client.cancelSession).toHaveBeenCalledWith(first.ticket, expect.any(String));
  expect(restartedService.snapshot().state).toBe('idle');
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm --filter quukk-clawmessenger test -- src/pairing/service.test.ts src/bindings/service.test.ts src/registration/client.test.ts`

Expected: FAIL with missing pairing service and registration context.

- [ ] **Step 3: Implement sanitized candidate mapping**

Create cryptographically random 128-bit `candidateId` values and keep `Map<candidateId, runtimeId>` only in memory. Map only trusted runtimes. Mark candidates `ready` only when current discovery status is ready and the provider has no conflicting runtime binding.

- [ ] **Step 4: Add session-authorized registration**

```ts
export type PairingRegistrationAuthorization = {
  ticket: string;
  deviceSecret: string;
  candidateId: string;
  idempotencyKey: string;
};
```

When present, `RegistrationClient.register` calls the new pairing candidate endpoint instead of `/api/ai/register`. `BindingService.enablePairingSelection` validates the runtime is still trusted and ready, then reuses existing binding persistence and worker startup behavior.

- [ ] **Step 5: Implement lifecycle and partial retry**

Allow one active session. Poll with abortable backoff, stop at expiry/cancel, record each candidate independently, and retry only selected failed candidates whose stable error is retryable. A missing runtime yields `runtime_unavailable` without calling registration.

- [ ] **Step 6: Run package service tests**

Run: `pnpm --filter quukk-clawmessenger test -- src/pairing/service.test.ts src/bindings/service.test.ts src/registration/client.test.ts`

Expected: PASS for no selection, subset selection, partial failure, idempotent retry, cancellation, expiry, and restart invalidation.

- [ ] **Step 7: Commit Task 5**

```powershell
git add packages/quukk-clawmessenger/src/pairing/service.ts packages/quukk-clawmessenger/src/pairing/service.test.ts packages/quukk-clawmessenger/src/registration packages/quukk-clawmessenger/src/bindings
git commit -m "feat(clawmessenger): register selected paired agents"
```

### Task 6: Local Bridge Pairing API

**Files:**
- Modify: `packages/quukk-clawmessenger/src/service.ts`
- Modify: `packages/quukk-clawmessenger/src/service.test.ts`
- Modify: `packages/quukk-clawmessenger/src/http/routes.ts`
- Modify: `packages/quukk-clawmessenger/src/http/routes.test.ts`

**Interfaces:**
- Consumes: Task 5 package `PairingService`.
- Produces: local bridge routes `POST /api/pairing/session`, `GET /api/pairing/session`, `DELETE /api/pairing/session`, and `POST /api/pairing/session/retry`.

- [ ] **Step 1: Write failing local-route tests**

```ts
it('returns only local UI pairing fields and hardened headers', async () => {
  const response = await request('POST', '/api/pairing/session');
  expect(response.status).toBe(200);
  expect(response.json()).toEqual(expect.objectContaining({ state: 'waiting', qrContent: expect.any(String) }));
  expect(JSON.stringify(response.json())).not.toMatch(/deviceSecret|runtimePath|runtimeId/);
});
```

- [ ] **Step 2: Run route tests and verify failure**

Run: `pnpm --filter quukk-clawmessenger test -- src/http/routes.test.ts src/service.test.ts`

Expected: FAIL with route not found.

- [ ] **Step 3: Expose pairing snapshots through the service facade**

Return `state`, `expiresAt`, `qrContent`, sanitized candidates, and safe results. Never return the private device secret or candidate-to-runtime map. Reuse the existing external-mutation guard for start, cancel, and retry.

- [ ] **Step 4: Add strict local HTTP routes**

Use the route parser's exact-method allowlist, same-origin ticket checks, bounded JSON parser, timeout/abort behavior, and hardened response headers. Retry accepts `{ "candidateIds": ["cand-a"] }` with a maximum of 16 unique IDs.

- [ ] **Step 5: Run local service tests**

Run: `pnpm --filter quukk-clawmessenger test -- src/http/routes.test.ts src/service.test.ts`

Expected: PASS for start, status, cancel, retry, wrong methods, malformed bodies, concurrent starts, and redaction.

- [ ] **Step 6: Commit Task 6**

```powershell
git add packages/quukk-clawmessenger/src/service.ts packages/quukk-clawmessenger/src/service.test.ts packages/quukk-clawmessenger/src/http/routes.ts packages/quukk-clawmessenger/src/http/routes.test.ts
git commit -m "feat(clawmessenger): expose local pairing API"
```

### Task 7: Bridge Setup Discovery and QR Experience

**Files:**
- Modify: `apps/bridge/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `apps/bridge/src/types.ts`
- Modify: `apps/bridge/src/api.ts`
- Modify: `apps/bridge/src/api.test.ts`
- Create: `apps/bridge/src/components/pairing-panel.tsx`
- Create: `apps/bridge/src/components/pairing-panel.test.tsx`
- Modify: `apps/bridge/src/pages/setup.tsx`
- Modify: `apps/bridge/src/setup.test.tsx`

**Interfaces:**
- Consumes: Task 6 local bridge pairing routes.
- Produces: Setup UI states `idle`, `waiting`, `claimed`, `processing`, `completed`, `partial`, `expired`, and `cancelled`.

- [ ] **Step 1: Write failing UI behavior tests**

```tsx
it('shows discovered agents without registration checkboxes and starts one QR session', async () => {
  render(<SetupPage api={api} />);
  expect(await screen.findByText('OpenCode')).toBeVisible();
  expect(screen.queryByRole('checkbox', { name: /OpenCode/ })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: /generate pairing qr code/i }));
  expect(api.startPairing).toHaveBeenCalledTimes(1);
  expect(await screen.findByLabelText(/pairing qr code/i)).toBeVisible();
});
```

- [ ] **Step 2: Run bridge tests and verify failure**

Run: `pnpm --filter @quukk/clawmessenger-bridge-ui test -- setup.test.tsx pairing-panel.test.tsx api.test.ts`

Expected: FAIL because pairing API/UI does not exist and old checkboxes remain.

- [ ] **Step 3: Add typed API methods and QR dependency**

Add `react-qr-code@2.0.18`. Parse every local response with strict Zod schemas. Implement `startPairing`, `getPairing`, `cancelPairing`, and `retryPairing` with the existing same-origin request helper.

- [ ] **Step 4: Build the focused pairing panel**

Render the QR from `qrContent`, expiration countdown, sanitized platform rows, and safe progress. Poll only while non-terminal and cancel polling on unmount. Regeneration calls cancel before start. Failed selected candidates expose one retry action.

- [ ] **Step 5: Simplify Setup registration behavior**

Keep authorized-root/default-workdir/local policy controls. Remove cloud-registration checkboxes and `enableBindings` calls from Setup. The primary action after policy completion is `Generate pairing QR code`; the Runtimes page continues managing already-bound runtimes.

- [ ] **Step 6: Run bridge tests, accessibility assertions, and build**

Run: `pnpm --filter @quukk/clawmessenger-bridge-ui test`

Run: `pnpm --filter @quukk/clawmessenger-bridge-ui typecheck`

Run: `pnpm --filter @quukk/clawmessenger-bridge-ui build`

Expected: all PASS.

- [ ] **Step 7: Commit Task 7**

```powershell
git add apps/bridge/package.json pnpm-lock.yaml apps/bridge/src
git commit -m "feat(bridge): add QR platform pairing"
```

### Task 8: Web Pairing Contract, Command Service, and QR Decoder

**Files:**
- Modify: `clawmessenger-web/package.json`
- Modify: `clawmessenger-web/package-lock.json`
- Create: `clawmessenger-web/src/lib/pairing.ts`
- Create: `clawmessenger-web/src/lib/pairing.test.ts`
- Create: `clawmessenger-web/src/services/pairing.ts`
- Create: `clawmessenger-web/src/services/pairing.test.ts`
- Create: `clawmessenger-web/src/hooks/useQrScanner.ts`
- Create: `clawmessenger-web/src/hooks/useQrScanner.test.tsx`

**Interfaces:**
- Consumes: Task 2 authenticated pairing system commands.
- Produces: `parsePairingQr`, `getPairingSession`, `confirmPairing`, `getPairingProgress`, `cancelPairing`, and `useQrScanner`.

- [ ] **Step 1: Write failing contract and QR-origin tests**

```ts
it('rejects production http and accepts explicit loopback development', () => {
  expect(() => parsePairingQr(qr({ server: 'http://example.com' }), configuredOrigin)).toThrow('pairing_server_invalid');
  expect(parsePairingQr(qr({ server: 'http://127.0.0.1:5000' }), 'http://127.0.0.1:5000').ticket).toBe(ticket);
});

it('does not send payload user_id', async () => {
  await confirmPairing(ticket, ['cand-a']);
  expect(sendSystemRequest).toHaveBeenCalledWith('ai', 'confirmPairing', { ticket, candidateIds: ['cand-a'] }, 30_000);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test -- src/lib/pairing.test.ts src/services/pairing.test.ts src/hooks/useQrScanner.test.tsx`

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Add strict contract parsing and command service**

Mirror the server enums and limits. Normalize command `202/409/410/429` failures into `PairingError` with stable codes. Send only ticket and candidate IDs through `sendSystemRequest`; never include stored user identity.

- [ ] **Step 4: Implement camera and image decoding**

Add `jsqr@1.4.0`. `useQrScanner` owns `getUserMedia`, video/canvas frame decoding, image-file decoding, cancellation, and track cleanup. Expose `{ startCamera, decodeFile, stopCamera, state, error }`. Unit tests mock media tracks and `jsQR` and assert every track stops on success, error, dialog close, and unmount.

- [ ] **Step 5: Run Web contract and scanner tests**

Run: `npm test -- src/lib/pairing.test.ts src/services/pairing.test.ts src/hooks/useQrScanner.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit Task 8**

```powershell
git add package.json package-lock.json src/lib/pairing.ts src/lib/pairing.test.ts src/services/pairing.ts src/services/pairing.test.ts src/hooks/useQrScanner.ts src/hooks/useQrScanner.test.tsx
git commit -m "feat(web): add pairing protocol and QR scanner"
```

### Task 9: Web Platform Selection and Device Refresh

**Files:**
- Modify: `clawmessenger-web/src/sections/BindDeviceDialog.tsx`
- Create: `clawmessenger-web/src/sections/BindDeviceDialog.test.tsx`
- Modify: `clawmessenger-web/src/pages/Home.tsx`
- Modify: `clawmessenger-web/src/services/device.ts`

**Interfaces:**
- Consumes: Task 8 parsing, scanning, and pairing commands.
- Produces: completed bindings returned to `Home` for one device-list refresh.

- [ ] **Step 1: Write failing interaction tests**

```tsx
it('offers camera/upload, defaults to no platforms, and submits only checked candidates', async () => {
  render(<BindDeviceDialog open onClose={close} onCompleted={completed} />);
  expect(screen.queryByPlaceholderText(/node id/i)).not.toBeInTheDocument();
  await decodeValidQr();
  expect(screen.getByRole('checkbox', { name: /OpenCode/ })).not.toBeChecked();
  expect(screen.getByRole('button', { name: /confirm add/i })).toBeDisabled();
  await user.click(screen.getByRole('checkbox', { name: /OpenCode/ }));
  await user.click(screen.getByRole('button', { name: /confirm add/i }));
  expect(confirmPairing).toHaveBeenCalledWith(ticket, ['cand-opencode']);
});
```

- [ ] **Step 2: Run dialog tests and verify failure**

Run: `npm test -- src/sections/BindDeviceDialog.test.tsx`

Expected: FAIL because the dialog still requires a node ID.

- [ ] **Step 3: Implement the three-stage dialog**

Stage 1 offers camera and image upload. Stage 2 shows expiration plus disabled/not-ready and selectable ready platform cards with no defaults. Stage 3 polls and shows each selected candidate as registering, bound, already bound, or failed, with retry for eligible failures. Closing before confirmation calls cancellation; closing after terminal completion stops polling.

- [ ] **Step 4: Replace Home's node-ID callback**

Remove the `bindNode(nodeId, userId)` UI path. Pass `onCompleted` to the dialog and call the existing device reload once when at least one candidate is `bound` or `already_bound`. Keep `device.bindNode` temporarily exported only if another legacy consumer or test still imports it; mark it deprecated and remove after the compatibility release.

- [ ] **Step 5: Run Web tests and build**

Run: `npm test`

Run: `npm run build`

Expected: all tests and TypeScript/Vite build PASS; no visible manual node-ID input remains.

- [ ] **Step 6: Commit Task 9**

```powershell
git add src/sections/BindDeviceDialog.tsx src/sections/BindDeviceDialog.test.tsx src/pages/Home.tsx src/services/device.ts
git commit -m "feat(web): select local agents after QR scan"
```

### Task 10: UniApp Pairing Contract and Scan Adapters

**Files:**
- Create: `clawmessenger-uniapp/src/utils/pairing-contract.js`
- Create: `clawmessenger-uniapp/src/utils/pairing-contract.test.js`
- Create: `clawmessenger-uniapp/src/utils/pairing-service.js`
- Create: `clawmessenger-uniapp/src/utils/pairing-service.test.js`
- Create: `clawmessenger-uniapp/src/subPackages/remote/utils/pairing-qr.js`
- Create: `clawmessenger-uniapp/src/subPackages/remote/utils/pairing-qr.test.js`

**Interfaces:**
- Consumes: Task 2 authenticated pairing commands.
- Produces: the same normalized methods and DTOs as the Web service.
- Produces: `scanPairingQr()` and `decodePairingImage(path)` platform adapters.

- [ ] **Step 1: Write failing UniApp contract and adapter tests**

```js
it('sends no user_id when confirming selection', async () => {
  await pairingService.confirmPairing('ticket-a', ['cand-a'])
  expect(aiService.confirmPairing).toHaveBeenCalledWith({ ticket: 'ticket-a', candidateIds: ['cand-a'] })
})

it('rejects a legacy bind_openclaw QR as a pairing session', () => {
  expect(() => parsePairingQr(JSON.stringify({ type: 'bind_openclaw', node_id: 'openclaw_1' })))
    .toThrowError('pairing_qr_invalid')
})
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test -- src/utils/pairing-contract.test.js src/utils/pairing-service.test.js src/subPackages/remote/utils/pairing-qr.test.js`

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement contracts and system-command adapter**

Use explicit validators for exact keys, lengths, enums, TTL, and origin. Add `getPairingSession`, `confirmPairing`, `getPairingProgress`, and `cancelPairing` methods to the existing system-service wrapper without accepting a user ID argument.

- [ ] **Step 4: Implement platform scan adapters**

App/mini-program use `uni.scanCode({ scanType: ['qrCode'] })` with album support where the platform provides it. H5 reuses existing `jsqr` image decoding and adds camera capture through browser media APIs. Normalize all successful adapters to the raw QR string; keep parsing in `pairing-contract.js`.

- [ ] **Step 5: Run UniApp contract tests**

Run: `npm test -- src/utils/pairing-contract.test.js src/utils/pairing-service.test.js src/subPackages/remote/utils/pairing-qr.test.js`

Expected: PASS for native scan, image import, H5 permission denial, invalid QR, expiry, and server mismatch.

- [ ] **Step 6: Commit Task 10**

```powershell
git add src/utils/pairing-contract.js src/utils/pairing-contract.test.js src/utils/pairing-service.js src/utils/pairing-service.test.js src/subPackages/remote/utils/pairing-qr.js src/subPackages/remote/utils/pairing-qr.test.js
git commit -m "feat(uniapp): add pairing protocol and scan adapters"
```

### Task 11: UniApp Platform Selection and Remote Management Integration

**Files:**
- Create: `clawmessenger-uniapp/src/subPackages/remote/components/pairing-platform-picker.vue`
- Create: `clawmessenger-uniapp/src/subPackages/remote/components/pairing-platform-picker.test.js`
- Modify: `clawmessenger-uniapp/src/subPackages/remote/pages/remote/index.vue`
- Create: `clawmessenger-uniapp/src/subPackages/remote/pages/remote/index.pairing.test.js`

**Interfaces:**
- Consumes: Task 10 QR adapter and pairing service.
- Produces: device-list refresh after one or more successful candidate bindings.

- [ ] **Step 1: Write failing component and page tests**

```js
it('does not expose manual node input and leaves all ready platforms unchecked', async () => {
  const wrapper = mount(RemotePage, pairingStubs())
  await wrapper.vm.scanQRCode()
  expect(wrapper.text()).not.toContain('手动输入节点ID')
  expect(wrapper.findAll('[role="checkbox"][aria-checked="true"]')).toHaveLength(0)
})

it('refreshes devices after partial success and names each failed platform', async () => {
  progress.mockResolvedValue(partialProgress)
  await wrapper.vm.confirmPairingSelection(['cand-opencode', 'cand-codex'])
  expect(wrapper.vm.loadDevices).toHaveBeenCalledTimes(1)
  expect(wrapper.text()).toContain('Codex')
  expect(wrapper.text()).toContain('重试')
})
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test -- src/subPackages/remote/components/pairing-platform-picker.test.js src/subPackages/remote/pages/remote/index.pairing.test.js`

Expected: FAIL because the picker does not exist and manual node input is still reachable.

- [ ] **Step 3: Build the reusable picker**

Render sanitized candidates, readiness/binding badges, expiration countdown, no-default multi-select, confirm/cancel actions, per-candidate progress, and retry. Emit `confirm(candidateIds)`, `cancel`, `retry(candidateIds)`, and `completed` events.

- [ ] **Step 4: Replace remote-page binding flow**

Delete `showManualInputDialog`, `bindByNodeId`, and all scan failure branches that offer manual entry. `scanQRCode` invokes the normalized adapter, parses the pairing QR, loads candidates, and opens the picker. On `completed`, close the picker and call `loadDevices` once if any candidate succeeded.

- [ ] **Step 5: Run UniApp tests and builds**

Run: `npm test`

Run: `npm run build`

Run: `npm run build:mp-weixin`

Expected: tests, H5 build, and Weixin mini-program build PASS with no manual node-ID UI string in production source.

- [ ] **Step 6: Commit Task 11**

```powershell
git add src/subPackages/remote/components src/subPackages/remote/pages/remote/index.vue src/subPackages/remote/pages/remote/index.pairing.test.js
git commit -m "feat(uniapp): select agents after QR scan"
```

### Task 12: Cross-Repository Contract and Clean-Install Acceptance

**Files:**
- Create: `packages/quukk-clawmessenger/src/protocol/fixtures/pairing-v1.json`
- Create: `clawmessenger-server/tests/fixtures/pairing_v1.json`
- Create: `clawmessenger-web/src/test/fixtures/pairing_v1.json`
- Create: `clawmessenger-uniapp/src/test/fixtures/pairing_v1.json`
- Create: `docs/pairing-beta-acceptance.md`
- Modify: contract tests created in Tasks 1, 4, 8, and 10 to load the fixture.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: one canonical set of valid/invalid QR, candidate, progress, and error vectors used by all four implementations.

- [ ] **Step 1: Add identical protocol fixtures**

The fixture contains one valid session with ready/not-ready candidates, one partial result, and invalid vectors for extra QR keys, expired timestamp, HTTP production origin, duplicate candidate IDs, oversized display name, selection expansion, and cross-session candidate ID. Copy the exact UTF-8 bytes into all four listed fixture paths.

- [ ] **Step 2: Make each contract suite consume every fixture vector**

Add parameterized tests asserting every valid vector parses to the same normalized fields and every invalid vector produces the named stable error code.

- [ ] **Step 3: Verify fixture hashes match**

Run from `D:\A-project\clawmessenger`:

```powershell
Get-FileHash .\quukk-clawmessenger-worktrees\fix-runtime-manifest-beta2\packages\quukk-clawmessenger\src\protocol\fixtures\pairing-v1.json, .\clawmessenger-server\tests\fixtures\pairing_v1.json, .\clawmessenger-web\src\test\fixtures\pairing_v1.json, .\clawmessenger-uniapp\src\test\fixtures\pairing_v1.json | Select-Object Hash,Path
```

Expected: all four SHA-256 hashes are identical.

- [ ] **Step 4: Run all automated verification**

```powershell
cd D:\A-project\clawmessenger\clawmessenger-server
python -m pytest -q

cd D:\A-project\clawmessenger\quukk-clawmessenger-worktrees\fix-runtime-manifest-beta2
pnpm --filter quukk-clawmessenger test
pnpm --filter quukk-clawmessenger typecheck
pnpm --filter @quukk/clawmessenger-bridge-ui test
pnpm --filter @quukk/clawmessenger-bridge-ui build

cd D:\A-project\clawmessenger\clawmessenger-web
npm test
npm run build

cd D:\A-project\clawmessenger\clawmessenger-uniapp
npm test
npm run build
npm run build:mp-weixin
```

Expected: every command exits `0`.

- [ ] **Step 5: Pack and install the package into a clean temporary project**

Run `pnpm --filter quukk-clawmessenger build`, `npm pack --workspace packages/quukk-clawmessenger`, create a new temporary directory, run `npm init -y`, and install the generated tarball. Verify `npx quukk-clawmessenger setup` detects local runtimes and displays a QR without asking for a node ID or pre-registering unselected runtimes.

- [ ] **Step 6: Perform browser and UniApp interaction acceptance**

Use the production test backend. Scan the same fresh-session workflow once from Web and once from UniApp using separate sessions. Select different platform subsets. Verify device-list appearance, direct chat, operations entry, discussion-group role selection, expiry, second-scanner rejection, partial failure, retry, and plugin-restart invalidation. Record timestamps, selected providers, resulting node IDs, and safe error codes in `docs/pairing-beta-acceptance.md`; do not record tickets or tokens.

- [ ] **Step 7: Inspect logs for secret/path leakage**

Search package and server test logs for the known test ticket, device secret, authorization value, node token, and injected local path. The acceptance document records zero matches or the exact redaction fix and rerun result.

- [ ] **Step 8: Commit fixtures and acceptance evidence in each repository**

```powershell
# server
git add tests/fixtures/pairing_v1.json tests/test_pairing_repository.py tests/test_pairing_service.py tests/test_pairing_api.py
git commit -m "test: lock pairing protocol contract"

# package worktree
git add packages/quukk-clawmessenger/src/protocol/fixtures/pairing-v1.json packages/quukk-clawmessenger/src/pairing docs/pairing-beta-acceptance.md
git commit -m "test(clawmessenger): verify clean pairing install"

# web
git add src/test/fixtures/pairing_v1.json src/lib/pairing.test.ts src/services/pairing.test.ts
git commit -m "test(web): lock pairing protocol contract"

# uniapp
git add src/test/fixtures/pairing_v1.json src/utils/pairing-contract.test.js src/utils/pairing-service.test.js
git commit -m "test(uniapp): lock pairing protocol contract"
```

## Completion Gate

Before claiming completion, capture fresh output for all commands in Task 12, confirm all four worktrees contain only intended changes, verify no manual node-ID entry remains in Web/UniApp UI, and verify an unselected detected platform has no server node row. Do not publish an npm version or deploy production clients until the clean-install acceptance document is complete and reviewed.
