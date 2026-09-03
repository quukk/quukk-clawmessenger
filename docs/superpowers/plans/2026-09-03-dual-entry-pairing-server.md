# Dual-Entry Pairing Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a secure v2 pairing protocol that lets authenticated Web and uni-app users claim a local agent bridge by QR ticket or an eight-character pairing code, while keeping the existing v1 QR protocol compatible.

**Architecture:** The server remains the authority for pairing state. It stores only keyed hashes of human codes and client claim keys, atomically locks each v2 session on first resolve, and addresses later operations through an opaque `sessionRef`. A persistent attempt ledger backs account and IP throttling across workers. Existing v1 routes and commands keep their response shapes and claim-on-confirm semantics.

**Tech Stack:** Python 3, Flask 3, PostgreSQL, SQLite test repository, psycopg2/pg8000, pytest.

**Spec:** `D:/A-project/clawmessenger/quukk-clawmessenger-worktrees/fix-runtime-manifest-beta2/docs/superpowers/specs/2026-09-03-dual-entry-pairing-code-design.md`

## Global Constraints

- Work in `D:/A-project/clawmessenger/clawmessenger-server`; preserve existing unrelated changes in `admin/bootstrap.py` and `tests/test_admin_bootstrap.py`.
- Keep `POST /api/ai/pairing/sessions` and all five v1 RongCloud actions byte-for-byte compatible at the JSON contract level.
- v2 TTL is 600 seconds. A v2 session is claimed on resolve, initially with an empty candidate selection; v1 still claims on confirm.
- Pairing-code transport uses eight compact characters from `ABCDEFGHJKMNPQRSTVWXYZ23456789`. Resolve accepts lowercase, spaces, or one hyphen and normalizes to compact uppercase; clients alone render `XXXX-XXXX`.
- Never persist or log the raw pairing code, raw client claim key, raw IP address, device secret, or QR ticket.
- Derive lookup values with HMAC-SHA256 under dedicated configuration keys; do not use an unhashed digest for low-entropy codes.
- PostgreSQL indexes are created with `CREATE INDEX CONCURRENTLY` or `CREATE UNIQUE INDEX CONCURRENTLY`, one index per migration file and outside a transaction.
- Manual code failures are limited to five per account and twenty per keyed IP hash in a rolling ten-minute window. Rate-limit rows are shared across workers and do not mutate the target pairing session.
- The same user, client key, and source may retry idempotently. Before ownership is established, invalid, unknown, expired, cancelled, or already-claimed manual codes—and a competing user, client key, or source—receive only `pairing_code_unavailable`.
- Read `PAIRING_CODE_HMAC_KEY`, `PAIRING_CLIENT_KEY_HMAC_KEY`, and `PAIRING_IP_HMAC_KEY` from the deployment environment and reject malformed values at the v2 boundary without affecting v1.
- Read `PAIRING_TRUSTED_PROXY_CIDRS` as a comma-separated list. Ignore `X-Forwarded-For` unless the immediate peer belongs to this list, then select the rightmost untrusted address from the chain.

---

## Task 1: Pairing Code Cryptography and Normalization

**Files:**

- Create: `D:/A-project/clawmessenger/clawmessenger-server/pairing_code.py`
- Create: `D:/A-project/clawmessenger/clawmessenger-server/tests/test_pairing_code.py`

**Interfaces:**

- Produces: `normalize_pairing_code(value: str) -> str`
- Produces: `derive_pairing_code(session_id: str, nonce: int, key: bytes) -> str`
- Produces: `lookup_hash(value: str, key: bytes) -> str`
- Produces: `client_key_hash(value: str, key: bytes) -> str`
- Produces: `decode_hmac_key(value: str) -> bytes` for unpadded base64url values encoding exactly 32 bytes.

- [ ] Write the failing unit tests:

```python
from pairing_code import (
    client_key_hash,
    derive_pairing_code,
    decode_hmac_key,
    lookup_hash,
    normalize_pairing_code,
)


def test_normalizes_human_input_without_ambiguous_characters():
    assert normalize_pairing_code("ab cd-ef 23") == "ABCDEF23"


def test_derivation_is_deterministic_and_renderable():
    compact = derive_pairing_code("ps_123", 7, b"code-key")
    assert len(compact) == 8
    assert set(compact) <= set("ABCDEFGHJKMNPQRSTVWXYZ23456789")


def test_code_and_client_keys_use_domain_separated_hashes():
    assert lookup_hash("ABCDEF23", b"lookup") != client_key_hash("ABCDEF23", b"lookup")


def test_hmac_key_must_be_32_base64url_bytes():
    assert decode_hmac_key("BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc") == bytes([7]) * 32
    with pytest.raises(ValueError, match="invalid_pairing_hmac_key"):
        decode_hmac_key("short")
```

- [ ] Run `python -m pytest tests/test_pairing_code.py -q` and confirm collection fails because `pairing_code` does not exist.
- [ ] Implement strict normalization, deterministic HMAC expansion into the approved alphabet, and domain-separated HMAC lookup helpers. Raise `ValueError("invalid_pairing_code")` unless normalized input is exactly eight approved characters.

```python
ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789"


def normalize_pairing_code(value: str) -> str:
    if not isinstance(value, str):
        raise ValueError("invalid_pairing_code")
    separated = "".join(value.upper().split())
    if separated.count("-") > 1:
        raise ValueError("invalid_pairing_code")
    compact = separated.replace("-", "")
    if len(compact) != 8 or any(char not in ALPHABET for char in compact):
        raise ValueError("invalid_pairing_code")
    return compact


def derive_pairing_code(session_id: str, nonce: int, key: bytes) -> str:
    space = len(ALPHABET) ** 8
    limit = (1 << 256) - ((1 << 256) % space)
    round_id = 0
    while True:
        digest = hmac.new(
            key, f"pairing-code\0{session_id}\0{nonce}\0{round_id}".encode(), hashlib.sha256
        ).digest()
        value = int.from_bytes(digest, "big")
        if value < limit:
            value %= space
            break
        round_id += 1
    chars = []
    for _ in range(8):
        value, index = divmod(value, len(ALPHABET))
        chars.append(ALPHABET[index])
    return "".join(reversed(chars))


def lookup_hash(value: str, key: bytes) -> str:
    return hmac.new(key, b"lookup\0" + value.encode(), hashlib.sha256).hexdigest()


def client_key_hash(value: str, key: bytes) -> str:
    return hmac.new(key, b"client\0" + value.encode(), hashlib.sha256).hexdigest()


def decode_hmac_key(value: str) -> bytes:
    try:
        decoded = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (ValueError, binascii.Error):
        raise ValueError("invalid_pairing_hmac_key") from None
    if len(decoded) != 32 or base64.urlsafe_b64encode(decoded).rstrip(b"=").decode() != value:
        raise ValueError("invalid_pairing_hmac_key")
    return decoded
```
- [ ] Run `python -m pytest tests/test_pairing_code.py -q` and confirm all tests pass.
- [ ] Commit only these files:

```powershell
git add pairing_code.py tests/test_pairing_code.py
git commit -m "feat: add secure human pairing codes"
```

---

## Task 2: PostgreSQL Schema and Persistent Attempt Ledger

**Files:**

- Create: `D:/A-project/clawmessenger/clawmessenger-server/migrations/20260903_agent_pairing_v2_columns.sql`
- Create: `D:/A-project/clawmessenger/clawmessenger-server/migrations/20260903_agent_pairing_code_hash_unique_idx.sql`
- Create: `D:/A-project/clawmessenger/clawmessenger-server/migrations/20260903_agent_pairing_attempts.sql`
- Create: `D:/A-project/clawmessenger/clawmessenger-server/migrations/20260903_agent_pairing_attempt_account_idx.sql`
- Create: `D:/A-project/clawmessenger/clawmessenger-server/migrations/20260903_agent_pairing_attempt_ip_idx.sql`
- Modify: `D:/A-project/clawmessenger/clawmessenger-server/database.py`
- Modify: `D:/A-project/clawmessenger/clawmessenger-server/tests/test_admin_postgres_integration.py`

**Interfaces:**

- Produces nullable `agent_pairing_sessions.pairing_code_lookup_hash TEXT`, `pairing_code_nonce INTEGER`, `claim_client_key_hash TEXT`, `claim_source TEXT`, and `claimed_at TIMESTAMPTZ`; `sessionRef` is the existing cryptographically random public session identifier, never a sequential database key.
- Produces `im_pairing_attempts(attempt_id BIGSERIAL, user_id TEXT, ip_lookup_hash TEXT, attempted_at TIMESTAMPTZ, result TEXT)` without foreign keys.
- Produces indexes `uq_agent_pairing_code_lookup_hash`, `idx_pairing_attempt_account_time`, and `idx_pairing_attempt_ip_time`.

- [ ] Add a failing PostgreSQL integration assertion that runs the migration installer twice, inspects `information_schema.columns`, and verifies the three named indexes in `pg_indexes`.

```python
def test_pairing_v2_schema_is_idempotent(postgres_connection):
    apply_pairing_migrations(postgres_connection)
    apply_pairing_migrations(postgres_connection)
    with postgres_connection.cursor() as cursor:
        cursor.execute("""SELECT column_name FROM information_schema.columns
                          WHERE table_name = 'im_pairing_sessions'""")
        columns = {row[0] for row in cursor.fetchall()}
        assert {"pairing_code_lookup_hash", "pairing_code_nonce",
                "claim_client_key_hash", "claim_source", "claimed_at"} <= columns
        cursor.execute("""SELECT indexname FROM pg_indexes
                          WHERE tablename IN ('im_pairing_sessions', 'im_pairing_attempts')""")
        indexes = {row[0] for row in cursor.fetchall()}
        assert {"uq_agent_pairing_code_lookup_hash", "idx_pairing_attempt_account_time",
                "idx_pairing_attempt_ip_time"} <= indexes
```
- [ ] Run `python -m pytest tests/test_admin_postgres_integration.py -q -k pairing_v2_schema` and confirm it fails on the missing columns.
- [ ] Implement idempotent column/table migrations. Put each concurrent index in its own migration file and update `database.py` so concurrent-index files run with autocommit instead of inside the normal migration transaction.

```sql
ALTER TABLE im_pairing_sessions ADD COLUMN IF NOT EXISTS pairing_code_lookup_hash TEXT;
ALTER TABLE im_pairing_sessions ADD COLUMN IF NOT EXISTS pairing_code_nonce INTEGER;
ALTER TABLE im_pairing_sessions ADD COLUMN IF NOT EXISTS claim_client_key_hash TEXT;
ALTER TABLE im_pairing_sessions ADD COLUMN IF NOT EXISTS claim_source TEXT;
ALTER TABLE im_pairing_sessions ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
```

```sql
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_agent_pairing_code_lookup_hash
ON im_pairing_sessions (pairing_code_lookup_hash)
WHERE pairing_code_lookup_hash IS NOT NULL;
```

```sql
CREATE TABLE IF NOT EXISTS im_pairing_attempts (
    attempt_id BIGSERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    ip_lookup_hash TEXT NOT NULL,
    attempted_at TIMESTAMPTZ NOT NULL,
    result TEXT NOT NULL CHECK (result IN ('unavailable', 'rate_limited'))
);
```
- [ ] Run `python -m pytest tests/test_admin_postgres_integration.py -q -k pairing_v2_schema` and confirm the schema and second-run checks pass.
- [ ] Commit the schema unit:

```powershell
git add database.py migrations/20260903_*.sql tests/test_admin_postgres_integration.py
git commit -m "feat: persist pairing v2 claims and rate limits"
```

---

## Task 3: Repository-Level v2 Creation, Resolution, and Throttling

**Files:**

- Modify: `D:/A-project/clawmessenger/clawmessenger-server/pairing_repository.py`
- Modify: `D:/A-project/clawmessenger/clawmessenger-server/tests/test_pairing_api.py`

**Interfaces:**

- Produces internal `PairingV2Credentials(session_id, ticket, device_secret, pairing_code, expires_at, candidates)`; the computer-facing response does not expose `session_id`.
- Produces `PairingRepositoryError(code: str)` for stable repository failures.
- Produces `PairingRepository(connection_factory, *, code_hmac_key: bytes | None = None, client_hmac_key: bytes | None = None, ip_hmac_key: bytes | None = None, clock=None)`; missing keys disable v2 with `pairing_unavailable` while v1 remains usable.
- Produces `create_session_v2(candidates, abuse_key, idempotency_key=None) -> PairingV2Credentials`.
- Produces `resolve_v2(source, credential, user_id, client_claim_key, ip_address, now=None) -> PairingSnapshot`.
- Produces `locked_v2(session_ref, user_id, client_claim_key, source=None) -> PairingSnapshot`.

- [ ] Extend the in-memory SQLite schema in `PairingRepository.initialize_schema` and add failing tests for: 600-second expiry, collision nonce retry, lookup by code, lookup by ticket, first-resolve atomic claim, same-source idempotency, alternate-source rejection, different-client rejection, and five/account plus twenty/IP throttles.
- [ ] Add a two-connection race test that releases QR and code resolves simultaneously with a barrier and asserts exactly one returns `claimed`; the loser must receive the public unavailable error.

```python
def test_v2_first_resolve_locks_source_and_client(pairing_repository):
    created = pairing_repository.create_session_v2(CANDIDATES, "bridge-a")
    claimed = pairing_repository.resolve_v2(
        "code", created.pairing_code, "user-a", "client-a", "203.0.113.7"
    )
    assert claimed.status == "claimed"
    assert claimed.selected_candidate_ids == ()
    replay = pairing_repository.resolve_v2(
        "code", created.pairing_code, "user-a", "client-a", "203.0.113.7"
    )
    assert replay.session_id == claimed.session_id
    with pytest.raises(PairingRepositoryError, match="pairing_code_unavailable"):
        pairing_repository.resolve_v2(
            "qr", created.ticket, "user-a", "client-a", "203.0.113.7"
        )


def test_v2_qr_and_code_race_has_one_winner(repository_factory, created_v2):
    barrier = threading.Barrier(2)
    outcomes = []

    def attempt(source, credential, client_key):
        repository = repository_factory()
        barrier.wait()
        try:
            outcomes.append(("ok", repository.resolve_v2(
                source, credential, "user-a", client_key, "203.0.113.7"
            ).status))
        except PairingRepositoryError as error:
            outcomes.append(("error", error.code))

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [
            executor.submit(attempt, "qr", created_v2.ticket, "client-a"),
            executor.submit(attempt, "code", created_v2.pairing_code, "client-b"),
        ]
        for future in futures:
            future.result()
    assert outcomes.count(("ok", "claimed")) == 1
    assert outcomes.count(("error", "pairing_code_unavailable")) == 1
```
- [ ] Run `python -m pytest tests/test_pairing_api.py -q -k "v2 or pairing_code or rate_limit"` and confirm the new tests fail because v2 methods are absent.
- [ ] Implement `create_session_v2` with a bounded collision retry loop, returning the raw display code only from the creation call. Implement `resolve_v2` in a write transaction that locks the row, validates expiry/state, atomically writes `user_id`, `claim_client_key_hash`, `claim_source`, `claimed_at`, and state `claimed`, then records a coarse attempt result. Key the IP with a separate HMAC key before persistence.

```python
class PairingRepositoryError(RuntimeError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class PairingV2Credentials(PairingCredentials):
    pairing_code: str = ""


def create_session_v2(self, candidates, abuse_key, idempotency_key=None):
    if None in (self.code_hmac_key, self.client_hmac_key, self.ip_hmac_key):
        raise PairingRepositoryError("pairing_unavailable")
    replay = self._locked_v2_create_replay(abuse_key, idempotency_key)
    if replay is not None:
        compact = derive_pairing_code(
            str(_value(replay, "session_id")), int(_value(replay, "pairing_code_nonce")),
            self.code_hmac_key,
        )
        return self._v2_credentials_from_row(replay, compact, abuse_key, idempotency_key)
    session_id = str(uuid.uuid4())
    for nonce in range(32):
        compact = derive_pairing_code(session_id, nonce, self.code_hmac_key)
        code_hash = lookup_hash(compact, self.code_hmac_key)
        if not self._active_code_hash_exists(code_hash):
            return self._insert_v2_session(
                session_id, nonce, code_hash, compact,
                candidates, abuse_key, idempotency_key,
            )
    raise PairingRepositoryError("pairing_unavailable")
```

```python
lookup_column = "ticket_hash" if source == "qr" else "pairing_code_lookup_hash"
supplied_lookup_hash = (
    _hash(credential) if source == "qr"
    else lookup_hash(normalize_pairing_code(credential), self.code_hmac_key)
)
row = self._locked_by_lookup(cursor, lookup_column, supplied_lookup_hash)
if row is None or not hmac.compare_digest(
    str(_value(row, lookup_column)), supplied_lookup_hash
):
    raise PairingRepositoryError("pairing_code_unavailable")
session_id = str(_value(row, "session_id"))
client_hash = client_key_hash(client_claim_key, self.client_hmac_key)
if _value(row, "status") == "claimed":
    same_claim = (
        hmac.compare_digest(str(_value(row, "claimant_user_id")), user_id)
        and hmac.compare_digest(str(_value(row, "claim_client_key_hash")), client_hash)
        and hmac.compare_digest(str(_value(row, "claim_source")), source)
    )
    if same_claim:
        return _snapshot(row)
    raise PairingRepositoryError("pairing_code_unavailable")
cursor.execute(
    """UPDATE im_pairing_sessions
       SET claimant_user_id = {p}, claim_client_key_hash = {p},
           claim_source = {p}, claimed_at = {p}, status = 'claimed', updated_at = {p}
       WHERE session_id = {p} AND status = 'waiting' AND expires_at > {p}""".format(
        p=self._placeholder(conn)
    ),
    (user_id, client_hash, source, self._db_datetime(now),
     self._db_datetime(now), session_id, self._db_datetime(now)),
)
if cursor.rowcount != 1:
    raise PairingRepositoryError("pairing_code_unavailable")
```
- [ ] Make failed code attempts append ledger rows before raising; prune rows older than the configured retention window without touching the pairing row. Return `pairing_rate_limited` with a retryable authentication-safe envelope once either threshold is reached.

```python
def _manual_attempt_counts(self, cursor, user_id, ip_lookup_hash, cutoff):
    cursor.execute(
        """SELECT
             SUM(CASE WHEN user_id = {p} THEN 1 ELSE 0 END) AS account_count,
             SUM(CASE WHEN ip_lookup_hash = {p} THEN 1 ELSE 0 END) AS ip_count
           FROM im_pairing_attempts WHERE attempted_at >= {p}""".format(
            p=self._placeholder(cursor.connection)
        ),
        (user_id, ip_lookup_hash, self._db_datetime(cutoff)),
    )
    row = cursor.fetchone()
    return int(_value(row, "account_count") or 0), int(_value(row, "ip_count") or 0)
```
- [ ] Run `python -m pytest tests/test_pairing_api.py -q -k "v2 or pairing_code or rate_limit"` and confirm all focused tests pass.
- [ ] Commit repository behavior:

```powershell
git add pairing_repository.py tests/test_pairing_api.py
git commit -m "feat: add atomic pairing v2 repository flow"
```

---

## Task 4: Service State Machine and Opaque Session References

**Files:**

- Modify: `D:/A-project/clawmessenger/clawmessenger-server/pairing_service.py`
- Modify: `D:/A-project/clawmessenger/clawmessenger-server/tests/test_pairing_api.py`

**Interfaces:**

- Produces `create_session_v2(candidates, abuse_key, idempotency_key=None)`.
- Produces `resolve_v2(source, ticket, code, client_claim_key, user_id, ip_address)`.
- Produces `confirm_v2(session_ref, client_claim_key, user_id, candidate_ids)`.
- Produces `progress_v2(session_ref, client_claim_key, user_id)`.
- Produces `retry_v2(session_ref, client_claim_key, user_id, candidate_ids, idempotency_key)`.
- Produces `cancel_v2(session_ref, client_claim_key, user_id)`.

- [ ] Add failing service tests proving v2 creation accepts zero to sixteen sanitized candidates, resolve returns an opaque `sessionRef` and an empty selected-candidate list, confirm accepts only candidates from the frozen snapshot, and progress/retry/cancel require the verified user plus matching client key.

```python
def test_service_v2_resolve_then_confirm(pairing_service):
    created = pairing_service.create_session_v2(CANDIDATES, "bridge-a")
    resolved = pairing_service.resolve_v2(
        "code", None, created["pairingCode"], "client-a", "user-a", "203.0.113.7"
    )
    assert resolved["status"] == "claimed"
    assert resolved["selectedCandidateIds"] == []
    confirmed = pairing_service.confirm_v2(
        resolved["sessionRef"], "client-a", "user-a", ["runtime-opencode"]
    )
    assert confirmed["selectedCandidateIds"] == ["runtime-opencode"]
```
- [ ] Run `python -m pytest tests/test_pairing_api.py -q -k "service_v2"` and confirm failures identify missing v2 service methods.
- [ ] Implement the six v2 methods without relaxing v1 validation. Before ownership, map invalid, unknown, expired, cancelled, or already-claimed manual codes and competing claims to `pairing_code_unavailable`; map throttling to `pairing_rate_limited`. After a client owns `sessionRef`, retain specific terminal-state errors where they do not disclose another session.

```python
def resolve_v2(self, source, ticket, code, client_claim_key, user_id, ip_address):
    if source == "qr" and ticket and code is None:
        credential = ticket
    elif source == "code" and code and ticket is None:
        credential = normalize_pairing_code(code)
    else:
        raise PairingError("pairing_request_invalid")
    try:
        snapshot = self.repository.resolve_v2(
            source, credential, user_id, client_claim_key, ip_address
        )
    except PairingRepositoryError as error:
        if source == "code" and error.code != "pairing_rate_limited":
            raise PairingError("pairing_code_unavailable") from None
        raise PairingError(error.code) from None
    return {"sessionRef": snapshot.session_id, **self._dto_v2(snapshot)}


def create_session_v2(self, candidates, abuse_key, idempotency_key=None):
    normalized = self._validate_candidates(candidates, allow_empty=True)
    credentials = self.repository.create_session_v2(normalized, abuse_key, idempotency_key)
    return {
        "ticket": credentials.ticket, "deviceSecret": credentials.device_secret,
        "pairingCode": credentials.pairing_code,
        "expiresAt": self._timestamp(credentials.expires_at), "status": "waiting",
        "candidates": self._safe_candidates(credentials.candidates),
    }
```

```python
def confirm_v2(self, session_ref, client_claim_key, user_id, candidate_ids):
    snapshot = self.repository.locked_v2(session_ref, user_id, client_claim_key)
    selected = self._validate_selection(snapshot, self._validate_selection_shape(candidate_ids))
    return self._dto_v2(self.repository.select_v2(session_ref, selected))
```
- [ ] Run `python -m pytest tests/test_pairing_api.py -q -k "service_v2"` and confirm all focused tests pass.
- [ ] Commit service behavior:

```powershell
git add pairing_service.py tests/test_pairing_api.py
git commit -m "feat: add pairing v2 service state machine"
```

---

## Task 5: v2 Computer Creation and Authenticated User Resolve Endpoints

**Files:**

- Modify: `D:/A-project/clawmessenger/clawmessenger-server/app.py`
- Modify: `D:/A-project/clawmessenger/clawmessenger-server/tests/test_pairing_api.py`
- Create: `D:/A-project/clawmessenger/clawmessenger-server/pairing_network.py`
- Create: `D:/A-project/clawmessenger/clawmessenger-server/tests/test_pairing_network.py`

**Interfaces:**

- Consumes `POST /api/ai/pairing/v2/sessions` with authenticated bridge credentials, `Idempotency-Key`, and `{ candidates }`.
- Produces exact JSON `{ code: 201, data: { ticket, deviceSecret, pairingCode, expiresAt, status: "waiting", candidates } }`; `pairingCode` is compact and the route itself carries version v2.
- Consumes `POST /api/ai/pairing/v2/resolve` with the existing user `Authorization: Bearer <rongcloud_token>` and `{ source, ticket | code, clientClaimKey }`.
- Produces `{ code: 200, data: { sessionRef, status, expiresAt, candidates, selectedCandidateIds } }` and obtains the rate-limit IP only from `request.remote_addr` after trusted-proxy normalization.
- Produces `resolve_client_ip(remote_addr: str, forwarded_for: str | None, trusted_cidrs: str) -> str`.
- Preserves `POST /api/ai/pairing/sessions` v1 response exactly.
- Produces credential-free structured telemetry `pairing_protocol_use version=<1|2> action=<create|resolve|confirm|progress|retry|cancel>`.
- Produces a fresh non-secret `g.pairing_correlation_id = uuid.uuid4().hex` in the existing pairing `before_request` hook.

- [ ] Add failing API tests for successful v2 creation, missing bridge authentication, zero and invalid candidates, idempotent replay, 600-second TTL, authenticated QR/code resolve, missing/invalid Bearer token, per-account/IP limits, trusted proxy handling, and a v1 golden response regression.
- [ ] Add strict-payload tests proving resolve rejects unknown keys, user identity fields, both credential fields, a source/credential mismatch, codes longer than nine display characters, and client claim keys not matching `[A-Za-z0-9_-]{43}`.
- [ ] Add a `caplog` assertion that v1/v2 telemetry contains only version/action/correlation ID and does not contain the request's ticket, code, device secret, client key, or IP.

```python
def test_resolve_client_ip_ignores_untrusted_forwarding():
    assert resolve_client_ip("198.51.100.9", "203.0.113.4", "10.0.0.0/8") == "198.51.100.9"


def test_resolve_client_ip_uses_rightmost_untrusted_hop():
    assert resolve_client_ip(
        "10.0.0.5", "203.0.113.4, 10.0.0.4", "10.0.0.0/8"
    ) == "203.0.113.4"
```

```python
def test_create_pairing_v2(client, bridge_headers):
    response = client.post(
        "/api/ai/pairing/v2/sessions",
        headers=bridge_headers,
        json={"candidates": CANDIDATES, "idempotencyKey": "create-v2-0000001"},
    )
    assert response.status_code == 201
    assert response.json["code"] == 201
    assert response.json["data"]["status"] == "waiting"
    assert re.fullmatch(
        r"[ABCDEFGHJKMNPQRSTVWXYZ23456789]{8}",
        response.json["data"]["pairingCode"],
    )


def test_resolve_pairing_v2_uses_authenticated_user_and_remote_ip(
    client, user_bearer_headers, created_v2
):
    response = client.post(
        "/api/ai/pairing/v2/resolve",
        headers=user_bearer_headers,
        environ_base={"REMOTE_ADDR": "203.0.113.7"},
        json={"source": "code", "code": created_v2.pairing_code.lower(),
              "clientClaimKey": "K" * 43},
    )
    assert response.status_code == 200
    assert response.json["data"]["status"] == "claimed"
    assert response.json["data"]["selectedCandidateIds"] == []
```
- [ ] Run `python -m pytest tests/test_pairing_network.py tests/test_pairing_api.py -q -k "client_ip or create_pairing_v2 or resolve_pairing_v2 or v1_contract"` and confirm the v2 endpoints/helper are absent.
- [ ] Add both v2 Flask routes next to the existing v1 route, pass the authenticated bridge abuse key to creation, and serialize the code only in the creation response. Resolve the true client IP through the trusted-proxy helper. Keep raw secrets out of application logs and exception text.

```python
def resolve_client_ip(remote_addr: str, forwarded_for: str | None, trusted_cidrs: str) -> str:
    peer = ipaddress.ip_address(remote_addr)
    trusted = [ipaddress.ip_network(value.strip()) for value in trusted_cidrs.split(",") if value.strip()]
    if not any(peer in network for network in trusted) or not forwarded_for:
        return str(peer)
    chain = [ipaddress.ip_address(value.strip()) for value in forwarded_for.split(",")] + [peer]
    for address in reversed(chain):
        if not any(address in network for network in trusted):
            return str(address)
    return str(peer)
```

```python
@app.post("/api/ai/pairing/v2/sessions")
def create_agent_pairing_session_v2():
    abuse_key = request.headers.get("X-Install-Abuse-Key")
    idempotency_key = _pairing_idempotency_key()
    if not isinstance(abuse_key, str) or re.fullmatch(r"[0-9a-fA-F]{64}", abuse_key) is None:
        return jsonify({"code": 400, "error": "invalid_abuse_key"}), 400
    if idempotency_key is None:
        return jsonify({"code": 400, "error": "invalid_idempotency_key"}), 400
    payload, error = _pairing_json_body()
    if error:
        return error
    if set(payload) != {"candidates"}:
        return jsonify({"code": 400, "error": "invalid_request"}), 400
    result = get_pairing_service().create_session_v2(
        payload.get("candidates"), abuse_key.lower(), idempotency_key,
    )
    return jsonify({"code": 201, "data": result}), 201
```

```python
g.pairing_correlation_id = uuid.uuid4().hex
logger.info(
    "pairing_protocol_use version=%s action=%s correlation_id=%s",
    2, "create", g.pairing_correlation_id,
)
```

```python
def get_pairing_service():
    global _pairing_service
    if _pairing_service is None:
        def optional_key(name):
            value = os.getenv(name)
            if not value:
                return None
            try:
                return decode_hmac_key(value)
            except ValueError:
                return None
        _pairing_service = PairingService(PairingRepository(
            get_db_connection,
            code_hmac_key=optional_key("PAIRING_CODE_HMAC_KEY"),
            client_hmac_key=optional_key("PAIRING_CLIENT_KEY_HMAC_KEY"),
            ip_hmac_key=optional_key("PAIRING_IP_HMAC_KEY"),
        ))
    return _pairing_service
```

```python
@app.post("/api/ai/pairing/v2/resolve")
def resolve_agent_pairing_session_v2():
    user_id = _authenticated_user_id()
    if not user_id:
        return jsonify({"code": 401, "error": "unauthorized"}), 401
    payload, error = _pairing_json_body()
    if error:
        return error
    source = payload.get("source")
    expected_keys = (
        {"source", "ticket", "clientClaimKey"} if source == "qr"
        else {"source", "code", "clientClaimKey"} if source == "code"
        else set()
    )
    if set(payload) != expected_keys or re.fullmatch(
        r"[A-Za-z0-9_-]{43}", str(payload.get("clientClaimKey") or "")
    ) is None:
        return jsonify({"code": 400, "error": "pairing_request_invalid"}), 400
    try:
        result = get_pairing_service().resolve_v2(
            source, payload.get("ticket"), payload.get("code"),
            payload.get("clientClaimKey"), user_id,
            resolve_client_ip(
                request.remote_addr or "0.0.0.0",
                request.headers.get("X-Forwarded-For"),
                os.getenv("PAIRING_TRUSTED_PROXY_CIDRS", ""),
            ),
        )
        return jsonify({"code": 200, "data": result})
    except PairingError as exc:
        status = {"pairing_code_unavailable": 404, "pairing_rate_limited": 429,
                  "pairing_unavailable": 503}.get(exc.code, 400)
        return jsonify({"code": status, "error": exc.code}), status
```
- [ ] Run `python -m pytest tests/test_pairing_network.py tests/test_pairing_api.py -q -k "client_ip or create_pairing_v2 or resolve_pairing_v2 or v1_contract"` and confirm both v2 endpoints, proxy handling, and v1 tests pass.
- [ ] Commit the REST endpoint:

```powershell
git add app.py pairing_network.py tests/test_pairing_network.py tests/test_pairing_api.py
git commit -m "feat: expose pairing v2 session creation"
```

---

## Task 6: Authenticated User Follow-up Commands

**Files:**

- Modify: `D:/A-project/clawmessenger/clawmessenger-server/rongcloud/command_handler.py`
- Modify: `D:/A-project/clawmessenger/clawmessenger-server/tests/test_pairing_api.py`

**Interfaces:**

- Consumes `ai.confirmPairingV2({ sessionRef, clientClaimKey, candidateIds })`.
- Consumes `ai.getPairingProgressV2({ sessionRef, clientClaimKey })`.
- Consumes `ai.retryPairingV2({ sessionRef, clientClaimKey, candidateIds, idempotencyKey })`.
- Consumes `ai.cancelPairingV2({ sessionRef, clientClaimKey })`.
- Produces v2 command data with `sessionRef`, `status`, `expiresAt`, frozen candidates, selected candidate IDs, and results where applicable; the v2 action names carry the protocol version.

- [ ] Add command-handler tests for wrong client key, confirm/progress/retry/cancel, rejection of payload user-identity fields, and stable v1 command fixtures. Resolution itself is tested at the authenticated HTTPS boundary in Task 5 so rate limiting uses the real client IP rather than the shared RongCloud webhook IP.
- [ ] Assert v1 follow-up telemetry names only protocol version and action and contains no payload representation.

```python
def test_confirm_pairing_v2_command(command_handler, verified_context, claimed_v2):
    response = command_handler.handle({
        "fromUserId": verified_context.user_id,
        "content": json.dumps({
            "service": "ai", "action": "confirmPairingV2", "requestId": "req-1",
            "payload": {"sessionRef": claimed_v2.session_ref,
                        "clientClaimKey": claimed_v2.client_key,
                        "candidateIds": ["runtime-opencode"]},
        }),
    })
    assert response["code"] == 200
    assert response["data"]["status"] == "claimed"
    assert response["data"]["selectedCandidateIds"] == ["runtime-opencode"]
```
- [ ] Run `python -m pytest tests/test_pairing_api.py -q -k "command_v2 or command_v1_contract"` and confirm dispatch fails because v2 follow-up handlers are missing.
- [ ] Implement `_handle_ai_confirmPairingV2`, `_handle_ai_getPairingProgressV2`, `_handle_ai_retryPairingV2`, and `_handle_ai_cancelPairingV2`. Obtain user identity only from `from_user_id`; reject identity fields in payloads.

```python
def _handle_ai_confirmPairingV2(self, payload, from_user_id):
    user_id = self._active_resolved_user(from_user_id)
    result = get_pairing_service().confirm_v2(
        payload.get("sessionRef"), payload.get("clientClaimKey"),
        user_id, payload.get("candidateIds"),
    )
    return {"code": 200, "data": result}
```
- [ ] Run `python -m pytest tests/test_pairing_api.py -q -k "command_v2 or command_v1_contract"` and confirm all focused tests pass.
- [ ] Run the backend regression suite: `python -m pytest -q`. Confirm no v1 pairing, single-chat, group-chat, discussion-group, admin, or migration regression.
- [ ] Commit command support:

```powershell
git add rongcloud/command_handler.py tests/test_pairing_api.py
git commit -m "feat: add authenticated pairing v2 commands"
```

---

## Completion Gate

- [ ] Verify `git diff origin/main...HEAD -- migrations` contains no raw-code column, no raw-IP column, no new foreign key, and every new index includes `CONCURRENTLY`.
- [ ] Verify `rg -n "pairing_code|clientClaimKey|deviceSecret|ticket" . --glob "*.py"` shows no log statement containing secret values.
- [ ] Record the final test command, pass count, commit range, and migration order in the integration report named by the rollout plan.
