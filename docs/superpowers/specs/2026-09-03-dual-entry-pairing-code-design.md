# Dual-Entry Device Pairing Code Design

**Date:** 2026-09-03

**Status:** Approved in chat; awaiting final document review

**Extends:** `2026-09-02-agent-platform-pairing-design.md`

**Scope:** `quukk-clawmessenger`, `clawmessenger-server`, `clawmessenger-web`, and `clawmessenger-uniapp`

## Summary

Device pairing must support two equivalent entry methods: scanning the existing QR code or manually entering a short pairing code. The computer-side `quukk-clawmessenger` Setup UI displays both at the same time. Signed-in Web and UniApp clients let the user choose either method, then show the same detected-agent selection and registration flow.

The short code is an alias for the existing high-entropy pairing session, not a replacement for its public ticket or private device credential. Both entry methods converge on one authenticated resolve-and-claim operation. The first client to resolve the session owns that pairing attempt; the other entry method and all other clients are rejected. A fresh computer-side session is required after interruption, expiry, cancellation, or regeneration.

## Product Decisions

- Pairing codes contain eight unambiguous Crockford-style Base32 characters, displayed as `XXXX-XXXX`.
- Codes are case-insensitive and exclude `0`, `O`, `1`, and `I`.
- QR codes and manual codes are valid for ten minutes and are single-use.
- A ClawMessenger login is required before either entry method can resolve a pairing session.
- QR and manual entry point to the same session. The first successful resolve locks that attempt to one authenticated client, not merely one account.
- Pairing cannot be resumed on another browser or device. The user regenerates the pairing session on the computer instead.
- Invalid and expired manual codes use the same public error response.
- An account may submit at most five incorrect manual codes in ten minutes. An IP address may submit at most twenty. Limits apply across application workers.
- Rate limiting never invalidates the target session, preventing an attacker from denying service to a valid code by guessing it.

## Goals

- Make pairing usable when a camera is unavailable or the Web client runs on the same computer as the plugin.
- Preserve the existing QR experience and high-entropy device-side credentials.
- Give Web and mobile users the same platform-selection and progress behavior regardless of entry method.
- Claim a session atomically on first successful resolution so another client cannot inspect or complete it.
- Keep raw short codes, QR tickets, device secrets, client claim keys, local paths, and node credentials out of persistent logs.
- Preserve older v1 clients during a staged rollout.

## Non-goals

- Using the short code as a node ID, device ID, login code, or reusable credential.
- Pairing without an authenticated ClawMessenger account.
- Resuming one pairing attempt on a second browser or phone.
- Replacing server-mediated pairing with LAN discovery.
- Changing conversations, remote operations, discussion groups, or node ownership after a node has been registered.

## Chosen Architecture

### Short code as a server-side alias

The server continues to create a high-entropy public ticket and a separate high-entropy device secret. Protocol v2 additionally creates a short pairing code for the same session. The QR payload remains version 1 and continues to contain only the server origin, public ticket, and expiration.

The server derives an unpredictable code from a cryptographically random session identifier with HMAC-SHA-256 under a dedicated pairing-code key and a domain-separated nonce. Forty output bits are encoded with the approved alphabet. If the unique lookup hash collides with an active or retained code, the server increments the persisted nonce and derives another code before committing the session.

The database stores only:

- a keyed HMAC-SHA-256 lookup hash of the normalized short code;
- the derivation nonce required to reproduce the code for an idempotent create replay;
- the existing ticket hash and device-secret hash;
- claim metadata described below.

The plaintext code is returned to the plugin and held in memory for display. It is never stored in logs, audit payloads, analytics, or ordinary database columns. The dedicated key is required for protocol-v2 creation; missing or malformed key configuration fails closed with a safe `pairing_unavailable` response while v1 behavior remains available.

### Authenticated resolve and client lock

New Web and UniApp clients generate a 256-bit random `clientClaimKey` when a bind dialog begins. The value stays in component/session memory and is never persisted. Both entry methods call the same authenticated `ai.resolvePairingV2` command:

- QR input supplies `{ source: "qr", ticket, clientClaimKey }`.
- Manual input supplies `{ source: "code", code, clientClaimKey }`.

The server derives the user exclusively from the verified RongCloud sender. In one database transaction it:

1. validates and rate-limits the request;
2. finds the active session by ticket hash or code lookup hash;
3. expires it when its deadline has passed;
4. rejects an existing claim whose user or client-claim-key hash differs;
5. stores the claiming user and HMAC-SHA-256 hash of `clientClaimKey` when unclaimed;
6. appends a redacted claim audit event; and
7. returns a public `sessionRef` and sanitized candidate snapshot.

`sessionRef` is an opaque, random identifier for authenticated user-side operations. Subsequent v2 commands include `sessionRef` and `clientClaimKey`; the server also checks the verified sender. A copied `sessionRef` alone is insufficient. The device-side plugin continues authenticating with the original ticket and private device secret.

Claiming does not select platforms. The session remains in the pre-selection state until the same client confirms one or more ready candidates. The plugin can distinguish “waiting to be claimed” from “claimed and awaiting selection” without receiving claimant identity.

### Compatibility boundary

Protocol v1 remains unchanged:

- `POST /api/ai/pairing/sessions` keeps its exact request and response shape.
- QR payload version 1 remains valid.
- Existing ticket-based user commands remain available for the compatibility window defined by the original design.

Protocol v2 uses a new computer-facing route, `POST /api/ai/pairing/v2/sessions`, so additive fields cannot break strict beta.7 response parsing. New Web and UniApp releases use v2 resolve and follow-up commands for both QR and manual entry. Old clients can continue using the QR v1 command path, but only new clients receive first-resolve client locking and manual-code support.

The compatibility exception is deliberate: v1 has no `clientClaimKey`, so it cannot prove that repeated commands came from one browser or phone. Its existing claim-on-confirm behavior remains unchanged for the compatibility window. Telemetry counts v1 use without recording pairing credentials, and v1 user commands are removed only after supported Web and UniApp releases have migrated. The first-resolve, one-client guarantee applies to v2 clients.

## Protocol Contracts

### Computer-facing v2 create response

The request retains the sanitized candidate list and existing abuse/idempotency headers. A successful response is exact and versioned:

```json
{
  "code": 201,
  "data": {
    "ticket": "opaque-high-entropy-value",
    "deviceSecret": "separate-high-entropy-value",
    "pairingCode": "7K3MP9QX",
    "expiresAt": "2026-09-03T09:10:00+00:00",
    "status": "waiting",
    "candidates": []
  }
}
```

The transport value has no hyphen; clients format it as `XXXX-XXXX`. Parsers reject lowercase-normalization ambiguity, unsupported characters, extra fields, malformed timestamps, and responses larger than the existing bound.

### QR payload

The QR contract remains unchanged:

```json
{
  "type": "clawmessenger_pairing",
  "version": 1,
  "server": "https://configured.example",
  "ticket": "opaque-high-entropy-value",
  "expiresAt": 1788426600000
}
```

The short code and device secret are not embedded in the QR code.

### User-facing v2 commands

The authenticated system command surface adds:

- `ai.resolvePairingV2({ source, ticket | code, clientClaimKey })`;
- `ai.confirmPairingV2({ sessionRef, clientClaimKey, candidateIds })`;
- `ai.getPairingProgressV2({ sessionRef, clientClaimKey })`;
- `ai.retryPairingV2({ sessionRef, clientClaimKey, candidateIds, idempotencyKey })`;
- `ai.cancelPairingV2({ sessionRef, clientClaimKey })`.

Each command uses a strict, bounded payload. Exactly one of `ticket` and `code` is allowed according to `source`. User identity fields in client payloads are rejected rather than ignored. Candidate membership and selection immutability follow the original pairing protocol.

## Persistence and Migration

The pairing-session schema gains nullable v2 fields for the compatibility window:

- `pairing_code_lookup_hash`;
- `pairing_code_nonce`;
- `claim_client_key_hash`;
- `claim_source`, set to `qr` or `code` on first resolution;
- `claimed_at` when not already represented by an equivalent timestamp.

Existing rows remain valid v1 sessions and cannot be resolved by manual code. New relationships do not add database foreign keys or cascading actions. PostgreSQL indexes follow repository migration rules:

- the unique partial index for non-null `pairing_code_lookup_hash` is created concurrently in its own single-statement migration;
- lookup and attempt-ledger indexes are also created concurrently in separate migration files;
- schema changes are idempotent and safe when an earlier optional object is absent.

A persistent attempt ledger enforces limits consistently across Gunicorn workers. It stores the resolved user ID, a keyed hash of the source IP, attempt timestamp, and a coarse result class; it never stores the submitted code, ticket, claim key, request body, or raw IP. Expired attempt rows are removed by bounded cleanup outside the claim transaction.

## End-to-End Data Flow

1. The plugin scans local runtimes and creates sanitized candidates.
2. The plugin calls the v2 session-creation endpoint.
3. The server returns ticket, device secret, pairing code, and expiration.
4. The plugin renders the existing QR and a copyable `XXXX-XXXX` code with one countdown.
5. A signed-in Web or UniApp user chooses camera scan, image scan, or manual entry.
6. The client creates an in-memory `clientClaimKey` and calls `ai.resolvePairingV2` with the selected source.
7. The server atomically locks the session to the verified user, client key, and entry source; it moves the session to `claimed` with an empty selection and returns `sessionRef` with candidates.
8. The user selects ready platforms and confirms through `ai.confirmPairingV2`.
9. The plugin polls with ticket plus device secret, receives the frozen selection, and registers only selected runtimes.
10. The client polls with session reference plus claim key and displays per-platform progress.
11. Completion refreshes the ordinary device list. Cancellation, expiry, regeneration, or completion invalidates both entry methods.

## User Experience

### Plugin Setup UI

- The pairing card places a scannable QR code and the formatted short code in the same visual group.
- The code has a copy action, accessible label, and text explaining that it is entered in ClawMessenger.
- One countdown applies to both values.
- Once claimed, the QR and code are hidden and replaced by “Awaiting platform selection.”
- Regeneration cancels the previous server session before showing a new QR and code.
- Network, timeout, authentication, rate-limit, and invalid-response failures use distinct safe messages rather than the beta.7 generic `operation_unavailable` message.

### Web

- “添加本地智能体” starts with tabs or equivalent controls for “扫码绑定” and “输入配对码.”
- QR mode keeps camera and image-upload support.
- Code mode uses one paste-friendly input, visually formats `XXXX-XXXX`, ignores case and a single separator, and does not autocorrect excluded characters.
- A successful resolve enters the existing platform-selection screen.
- Closing, refreshing, or losing the claim key cancels local continuation and instructs the user to regenerate on the computer.

### UniApp

- App, H5, and mini-program builds expose the same “扫码绑定 / 输入配对码” choice.
- Native camera and album scanning remain behind the existing normalized scanner adapter.
- Code entry shares normalization, validation, state, and error semantics with Web.
- Successful resolution reuses the current candidate selection, progress, retry, and device-list refresh flow.

## Error Handling and Security

- Invalid, unknown, expired, already-claimed, and cancelled manual codes return the same public `pairing_code_unavailable` result before a client owns the session.
- Rate limiting returns `pairing_rate_limited` with no information about code validity.
- Manual-code failure accounting uses the verified account and a keyed IP hash. Successful claims are not counted as failures.
- The account limit is five incorrect attempts per rolling ten-minute window; the IP limit is twenty.
- A second user, a second client key, or the alternate entry method receives the same unavailable response after first claim.
- The same user, exact client key, and same entry source may retry a lost resolve response idempotently. Changing from QR to code or code to QR is not an idempotent retry.
- Constant-time comparisons are used for supplied secrets after indexed lookup narrows the row.
- Pairing-code and IP lookup hashes are keyed to prevent practical offline enumeration after a database leak.
- Logs expose stable error codes and correlation IDs only. They exclude raw codes, tickets, device secrets, claim keys, paths, authorization headers, and upstream bodies.
- The server origin in a QR must still match the client's configured environment. Manual entry always resolves only against the already configured environment and cannot select another server.
- The v2 creation route fails closed when its HMAC key is unavailable; health and v1 pairing remain observable.

## Adjacent Beta Reliability Fixes

The same beta release addresses two failures found during real Windows installation testing:

1. Pairing-client errors such as `pairing_timeout`, `pairing_transport`, `pairing_unauthorized`, and `pairing_response_invalid` must survive service and local-HTTP normalization with correct status, category, and retryability. The Setup UI maps these stable codes to actionable messages.
2. Windows Setup launch must preserve the complete one-time `#ticket` URL. If the system browser launch cannot be confirmed, the CLI prints the complete short-lived URL for manual opening without logging it to persistent files.

These fixes do not mask a remote backend outage. The production-test `/health` and pairing endpoints must return within their configured bounds before end-to-end acceptance.

## Testing Strategy

### Server

- Format, alphabet, entropy source, derivation nonce, collision retry, and idempotent create replay.
- Persistence proves raw codes, tickets, device secrets, claim keys, and raw IPs are absent.
- PostgreSQL migration and real transaction tests, including concurrent index expectations.
- SQLite repository tests where supported without weakening PostgreSQL requirements.
- Atomic races for QR versus code, two accounts, and two client claim keys; exactly one client wins.
- Same-client, same-source resolve retry is idempotent; switching source after a claim is rejected.
- Invalid and expired codes are externally indistinguishable.
- Persistent account/IP rolling-window limits work across separate service instances.
- Confirmation, progress, retry, and cancellation reject wrong users or claim keys.
- Existing v1 creation, QR inspection, confirmation, progress, retry, and cancellation remain unchanged.

### Plugin

- Strict v2 response parsing and rejection of malformed or oversized codes.
- QR and short code project from one session and share expiration.
- Plaintext short codes never enter persisted configuration, logs, diagnostics, or activity.
- Regeneration cancels the old session.
- Pairing transport errors retain their exact safe public code.
- Setup renders, copies, hides, expires, and regenerates the short code accessibly.
- Windows CLI preserves the fragment ticket or prints the one-time fallback URL.

### Web and UniApp

- Manual normalization, paste, excluded characters, local validation, and submission fencing.
- QR and code resolve into the same candidate selection state.
- No candidate is selected by default.
- First-client lock, same-client retry, second-client rejection, expiry, and rate-limit copy.
- Closing or refreshing cannot continue without the in-memory claim key.
- Progress, partial failure, retry, cancellation, and device-list refresh are identical for both entry methods.
- Existing Web camera/upload and UniApp native/album scan regressions remain covered.

### Shared contract and real acceptance

- Server, plugin, Web, and UniApp consume matching protocol-v2 fixtures and stable error-code fixtures.
- A clean globally installed beta is tested on Windows with OpenCode and OpenClaw discovery.
- One session is completed by QR on mobile; another by manual code on Web.
- QR/code simultaneous races prove only one client can proceed.
- Attempt limits are exercised without invalidating a legitimate session.
- Registered nodes appear in remote management and pass single-chat, group-chat, and discussion-group workflows.
- Persistent logs and database rows are inspected for secret leakage.

## Rollout

1. Configure and validate the pairing-code HMAC key in the production-test environment.
2. Deploy database columns, the attempt ledger, and concurrent indexes.
3. Deploy server v2 creation and authenticated command handlers while retaining v1.
4. Verify `/health`, v1 regression behavior, and v2 contract probes.
5. Release and clean-install the npm beta with dual display and diagnostic fixes.
6. Deploy Web with QR/manual choice and complete both paths against production test.
7. Build UniApp App, H5, and mini-program targets and complete both paths.
8. Run chat and discussion-group acceptance for the resulting nodes.
9. Promote components together only after cross-version and secret-redaction checks pass.

## Acceptance Criteria

- The plugin displays one QR code and one `XXXX-XXXX` code for the same ten-minute session.
- A signed-in Web or mobile user can choose scan or manual entry and see the same sanitized platform list.
- Manual entry never asks for a node ID, local path, server URL, or device credential.
- The first successful resolve locks the session to one account and one client claim key.
- A second client cannot inspect, select, or continue the pairing attempt, even under the same account.
- Invalid and expired codes do not reveal whether a session exists.
- Account and IP attempt limits hold across application workers and cannot invalidate a valid code.
- Raw short codes and all other pairing secrets are absent from storage and persistent logs.
- Old v1 QR clients remain functional during the compatibility window.
- Selected platforms are registered exactly once and appear in the ordinary device list.
- Nodes created through either entry method pass single-chat, group-chat, and discussion-group flows.
- Remote transport failures produce actionable safe errors, and Windows Setup opens or prints a usable one-time URL.
