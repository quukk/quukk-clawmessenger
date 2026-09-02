# Agent Platform Discovery and QR Pairing Design

**Date:** 2026-09-02

**Status:** Approved in chat

**Scope:** `quukk-clawmessenger`, `clawmessenger-server`, `clawmessenger-web`, and `clawmessenger-uniapp`

## Summary

Installing and starting `quukk-clawmessenger` must automatically discover supported local agent platforms. The computer displays one short-lived QR code. After scanning it in ClawMessenger, the signed-in user sees the detected platforms and explicitly selects which ones to add. Only selected platforms receive server-side node identities and account bindings. Users never need to find or enter a node ID.

The pairing protocol is server-mediated so the phone and computer do not need to share a LAN. The QR code contains only an opaque, one-time ticket. It contains no node ID, local path, MAC address, access token, or reusable credential.

## Goals

- Detect supported local platforms automatically after package installation or service start.
- Use one QR code per computer-side pairing session, even when several platforms are detected.
- Show the detected platform list on Web, App, H5, and mini-program clients after scanning.
- Require the signed-in user to choose platforms explicitly; do not preselect all candidates.
- Register and bind only selected, ready platforms.
- Make registration and account ownership atomic and idempotent.
- Preserve already-bound nodes while removing manual node-ID entry from new clients.
- Give per-platform progress and actionable errors when a batch partially succeeds.

## Non-goals

- Automatic installation or repair of agent platforms that are missing or not ready.
- Direct LAN discovery with mDNS, broadcast, or a phone-to-localhost connection.
- Automatic transfer of a node owned by another account.
- Exposing local filesystem paths, runtime configuration, or credentials to ClawMessenger clients.
- Replacing the existing device conversation, operations, or discussion-group flows.

## Existing Behavior

The package already discovers supported runtimes and exposes them in the local bridge Setup UI. Setup currently asks the local user to select runtimes and calls `/api/bindings/enable`, which immediately creates one server node per selected runtime.

The Web client currently asks for a node ID in `BindDeviceDialog.tsx`. The UniApp remote-management page supports scanning a QR code that names one node and falls back to manual node-ID input. Both paths call the `ai.scanBind` system command. The server verifies the message sender through RongCloud, but the QR format still identifies one pre-registered node.

The new flow separates local discovery from cloud registration and replaces the single-node QR contract with a computer-level pairing session.

## Chosen Approach

Use a server-mediated, one-time pairing session.

Two alternatives were rejected:

- **LAN direct pairing:** simpler server state, but unreliable across phone networks, browser security boundaries, firewalls, and HTTPS requirements.
- **Pre-register every detected runtime and group them under a machine ID:** smaller package change, but creates credentials and orphan nodes for platforms the user never selected.

## Architecture

### 1. Package discovery and pairing service

The package keeps the existing trusted runtime discovery and runtime-ID model. Discovery remains local. A new pairing service converts the current trusted runtime catalog into sanitized candidates and manages one active pairing session at a time.

Each candidate has one random, session-scoped `candidateId`. The candidate description contains only:

- provider type;
- display name;
- detected version when available;
- readiness state;
- a safe status reason;
- whether this local runtime already has a package binding.

Runtime IDs, executable paths, authorized roots, tokens, and bridge secrets never appear in QR data or client-facing responses. The package retains a private map from `candidateId` to trusted runtime ID for the life of the session.

The local Setup UI becomes a two-stage experience:

1. Configure local permissions and review automatically detected runtimes.
2. Generate a pairing QR code and monitor its state.

The computer UI does not choose which platforms are added. Selection belongs to the signed-in ClawMessenger user after scanning.

### 2. Server pairing subsystem

Add a focused pairing repository and service rather than extending the current `ai.scanBind` handler. The subsystem owns session creation, inspection, confirmation, selection delivery, per-candidate completion, expiration, cancellation, and audit events.

Persistent state contains:

- `session_id`: internal random identifier;
- `ticket_hash`: hash of the public QR ticket;
- `device_secret_hash`: hash of the private computer credential;
- `status`: `waiting`, `claimed`, `processing`, `completed`, `partial`, `cancelled`, or `expired`;
- sanitized candidate snapshots;
- selected candidate IDs;
- claiming user ID, set only by a verified RongCloud command;
- creation, expiration, claim, and completion timestamps;
- per-candidate result code and resulting node ID, where applicable;
- an idempotency key for each registration attempt.

Raw public tickets and private computer secrets are never stored. Expired session rows may be retained for a limited audit period without credentials or sensitive local metadata.

### 3. Client pairing UI

Web and UniApp share the same pairing states and response schema.

After decoding a QR code, a client sends the public ticket through the authenticated RongCloud system-service channel. The response contains the sanitized candidate list and session expiration. Ready, unbound candidates may be selected. Not-ready or unavailable candidates remain visible with a reason but are disabled.

No platform is selected by default. The user confirms the selection once, then sees per-platform progress. Completion refreshes the existing device list, so all downstream conversation, operations, and discussion-group screens continue consuming ordinary node records.

## End-to-End Data Flow

1. The package scans local runtimes and creates sanitized candidates with random candidate IDs.
2. The package calls the server session-creation endpoint over TLS.
3. The server returns a high-entropy public `ticket`, a separate high-entropy `deviceSecret`, and `expiresAt`.
4. The package stores `deviceSecret` in memory and renders QR content containing protocol version, server origin, public ticket, and expiration only.
5. Web or UniApp scans or imports the QR image.
6. The client calls `ai.getPairingSession` through the signed RongCloud command channel. The server derives the user from the verified sender and ignores any client-supplied user ID.
7. The client displays candidates and calls `ai.confirmPairing` with the public ticket and selected candidate IDs.
8. The server atomically assigns the unclaimed session to that user and freezes the selected set. A second user cannot inspect private progress or change the selection after the claim.
9. The package polls the server with `ticket` plus `deviceSecret`, receives the frozen selected candidate IDs, and maps them back to trusted local runtime IDs.
10. For each selected candidate, the package performs just-in-time registration using a session-scoped registration authorization and idempotency key.
11. The server creates or resolves the node and records the claiming user as owner in the same transaction. It then returns the node credential to the package and records a safe candidate result for the client.
12. The client polls through authenticated system commands until all selected candidates reach terminal states, then reloads the device list.
13. The server invalidates both session credentials on completion, cancellation, or expiration.

## Protocol Contracts

### QR payload

The QR payload is versioned and minimal:

```json
{
  "type": "clawmessenger_pairing",
  "version": 1,
  "server": "https://configured.example",
  "ticket": "opaque-high-entropy-value",
  "expiresAt": 1788336300000
}
```

Clients accept only HTTPS production origins. Local development may allow explicit loopback HTTP origins. Clients reject unknown versions, malformed tickets, expired timestamps, and origins that do not match the configured server unless the user explicitly switches environments outside the pairing flow.

### Computer-facing REST operations

Exact route naming may follow current server conventions, but the contract must provide these operations:

- create a session with sanitized candidates;
- poll session selection using both public ticket and private device secret;
- register one selected candidate atomically for the claiming user;
- report or retrieve per-candidate results;
- cancel the session.

Every mutating request uses an idempotency key. Session secrets are sent in authorization headers, never query parameters. Responses use bounded JSON bodies and safe stable error codes.

### User-facing system commands

Add authenticated commands:

- `ai.getPairingSession(ticket)`;
- `ai.confirmPairing(ticket, candidateIds)`;
- `ai.getPairingProgress(ticket)`;
- `ai.cancelPairing(ticket)`.

The command handler always derives the user from `from_user_id`. It validates that candidate IDs belong to the ticket, rejects empty selections, freezes the selection on first confirmation, and returns idempotent results to repeated requests from the same user.

### Candidate status

Client-visible readiness values are `ready`, `not_ready`, and `already_registered`. Processing results are `pending`, `registering`, `bound`, `already_bound`, and `failed`. Failures expose stable codes plus localized client messages; they never expose stack traces, paths, credentials, or raw upstream responses.

## Ownership and Existing Registrations

- A selected unregistered runtime is registered and assigned to the claiming user as `owner` atomically.
- A runtime already owned by the same account completes idempotently as `already_bound`.
- A runtime owned by another account cannot be transferred by this QR flow. It is shown as unavailable when that can be determined safely, or registration finishes with `owned_by_other_account`.
- Requesting viewer access to another account's node remains a separate approval flow and is not triggered automatically by computer pairing.
- Unselected candidates never create or mutate server nodes.

## User Experience

### Package Setup

- Automatically scan when Setup opens and allow an explicit rescan.
- Show detected platforms, versions, and readiness without checkboxes for cloud registration.
- Keep local authorization settings independent from account pairing.
- Primary action: **Generate pairing QR code**.
- Pairing status: waiting for scan, awaiting selection, registering, partially completed, completed, expired, or cancelled.
- Regenerating a QR code cancels the previous active session.

### Web

- Replace manual node-ID entry with camera scanning and QR-image upload.
- After decoding, show a multi-select platform dialog.
- Select nothing by default.
- Show an expiration countdown and a clear path to rescan.
- Show per-platform progress and retry only failed, still-valid selections.

### UniApp

- App and mini-program builds use native scanning and album import.
- H5 uses camera scanning when permitted and QR-image upload as a fallback.
- Remove all visible manual node-ID entry actions.
- Reuse the same platform list, selection, progress, and result semantics as Web.

## Error Handling

- **Expired QR:** reject inspection or confirmation and direct the user to regenerate it on the computer.
- **Plugin temporarily offline:** retain a confirmed selection for up to one additional minute within the session deadline; resume when the package polls again.
- **Plugin process restart:** because the private device secret and candidate-to-runtime map are memory-only, startup creates a fresh session with the same installation abuse key; the server atomically expires that installation's previous active session. Already committed bindings remain valid.
- **Runtime disappears after selection:** fail only that candidate with `runtime_unavailable`; other candidates continue.
- **Partial failure:** keep successful bindings and expose retry for eligible failed candidates. Do not delete successfully created nodes.
- **Duplicate requests:** return the recorded result for the same idempotency key.
- **User cancellation:** close the session and prevent new registrations; an already committed node binding remains valid.
- **Second scanner:** once claimed, return `session_claimed` without revealing the owner or candidate progress.
- **Server mismatch:** never silently send a ticket to a different configured environment.

## Security Requirements

- Use at least 256 bits of cryptographic randomness for public tickets and private device secrets.
- Hash secrets at rest and compare them in constant time.
- Rate-limit creation by IP and installation-derived abuse bucket without exposing a stable hardware identifier to clients.
- Rate-limit inspection and confirmation by ticket and verified user.
- Bind selection to the verified RongCloud sender, not a payload `user_id`.
- Freeze candidates at session creation and freeze selection at confirmation.
- Require both computer secrets and a confirmed candidate selection before registration.
- Validate server origin, protocol version, ticket syntax, candidate membership, TTL, state transitions, provider, and node identity.
- Redact QR tickets, private secrets, node tokens, local paths, and authorization headers from logs.
- Record safe audit events for session creation, claim, selection, candidate completion, cancellation, and expiry.

## Compatibility and Migration

- Existing node records, credentials, conversations, and discussion-group assignments are unchanged.
- The new package continues to start already-enabled bindings normally.
- New Web and UniApp clients do not expose manual node-ID binding.
- The server keeps the existing `ai.scanBind` command for one compatibility release so older clients can bind previously registered nodes. It is marked deprecated, monitored, and removed only after supported clients migrate.
- The disabled unauthenticated `/api/scan/bind` REST route remains disabled.
- QR payloads use an explicit version so clients can reject incompatible future contracts.

## Code Boundaries

### `quukk-clawmessenger`

- Add an isolated pairing client/service and schemas.
- Reuse the trusted runtime source and existing per-runtime registration service.
- Add bridge API routes for session creation, status, cancellation, and retry.
- Replace Setup registration checkboxes with discovery summary and pairing state UI.

### `clawmessenger-server`

- Add pairing database migration, repository, state machine, and service.
- Add computer-facing REST routes with secret verification and idempotency.
- Add authenticated RongCloud command handlers for inspection, confirmation, progress, and cancellation.
- Refactor node registration so node creation and owner association can run in one transaction while preserving the legacy registration route.

### `clawmessenger-web`

- Replace `BindDeviceDialog` node-ID input with QR capture/import and platform selection.
- Add typed pairing service contracts and progress UI.
- Reuse existing device-list refresh and notification patterns.

### `clawmessenger-uniapp`

- Replace manual-node fallback in remote management with camera/album QR handling.
- Add the shared pairing command client and platform selection/progress views.
- Keep platform-specific scanning implementations behind one normalized interface.

## Testing Strategy

### Package

- Unit-test sanitized candidate mapping and ensure paths, runtime IDs, and secrets never leak.
- Test session lifecycle, expiration, cancellation, polling, selection mapping, partial completion, and retry.
- Test that unselected runtimes never call registration.
- Test runtime disappearance and duplicate registration callbacks.
- Test Setup UI states and accessibility.

### Server

- Repository and state-machine tests for every valid and invalid transition.
- Concurrent claim test proving exactly one user wins.
- Tests for forged user IDs, wrong device secrets, expired tickets, replay, cross-session candidate IDs, and selection expansion.
- Transaction tests proving node creation and owner binding commit or roll back together.
- Idempotency tests for repeated create, confirm, registration, and completion calls.
- Regression tests for existing nodes, legacy clients, ownership protection, and system-reserved nodes.

### Web and UniApp

- Contract tests against the same fixture set for QR payloads, candidates, progress, and errors.
- Component tests for scan/import, no default selection, disabled candidates, confirmation, expiry, partial failure, retry, and device-list refresh.
- Platform-specific UniApp tests for App, H5, and mini-program scan adapters.
- Web camera permission-denied tests with image upload fallback.

### Real installation acceptance

1. Pack or publish a beta package and install it into a clean local project.
2. Start Setup and verify supported local platforms are detected without manual IDs.
3. Generate a QR code and scan it separately with Web and UniApp test accounts.
4. Select different subsets and verify only selected platforms create nodes.
5. Verify successful nodes appear in remote management and support chat and operations.
6. Verify the nodes can be selected in discussion-group roles and participate normally.
7. Exercise expiry, second-scanner rejection, plugin restart, partial failure, and retry.
8. Inspect server and package logs to confirm secrets and local paths are absent.

## Rollout

1. Deploy the server migration and pairing protocol while preserving legacy `ai.scanBind`.
2. Release a beta package implementing computer pairing.
3. Release Web and UniApp beta clients with QR selection and no manual node-ID UI.
4. Run clean-install acceptance against the production test backend.
5. Promote all components together after protocol and end-to-end tests pass.
6. Monitor pairing error codes and legacy-command usage before removing compatibility support in a later release.

## Acceptance Criteria

- A fresh package installation detects supported local platforms automatically.
- One QR code produces a platform list on every supported client.
- The user can select one or more ready platforms without seeing or entering a node ID.
- No unselected platform creates a server node or credential.
- Each selected successful platform is registered, owned by the scanning account, online, and visible in the device list.
- Duplicate confirmations and retries do not create duplicate nodes.
- A QR code cannot be reused, expanded after confirmation, or used to steal another account's node.
- Partial failures are visible and retryable without rolling back successes.
- Existing bound nodes continue to support chat, operations, and discussion groups.
