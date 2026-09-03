# Dual-Entry Pairing Web Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let signed-in Web users bind a local agent platform either by scanning/uploading its QR code or by entering the matching eight-character pairing code, then select which discovered runtimes to connect.

**Architecture:** `BindDeviceDialog` owns an in-memory random client claim key for one dialog lifetime. Both entry methods call the authenticated HTTPS v2 resolve endpoint so the server can enforce the real client-IP limit and return an opaque `sessionRef`; selection, progress, retry, and cancellation continue over the existing RongCloud system-request transport. No claim state or client key is persisted across reloads or devices.

**Tech Stack:** React, TypeScript, Vite, Vitest, Testing Library, `input-otp`, existing RongCloud system-request transport.

**Spec:** `D:/A-project/clawmessenger/quukk-clawmessenger-worktrees/fix-runtime-manifest-beta2/docs/superpowers/specs/2026-09-03-dual-entry-pairing-code-design.md`

## Global Constraints

- Work in `D:/A-project/clawmessenger/clawmessenger-web` and preserve unrelated local changes.
- Require the existing authenticated Web session; do not add anonymous pairing endpoints or cache credentials in local/session storage.
- Generate a 256-bit random `clientClaimKey` once per dialog opening and discard it when the dialog closes.
- Normalize manual input locally for usability, while treating the server as the validation authority.
- QR and code converge immediately after resolve; the candidate picker and all later states must be identical.
- Keep the existing QR version-1 parser and reject a QR whose `server` origin differs from the configured Web API origin before calling resolve. Manual entry always uses that configured origin.
- A refresh cannot resume a v2 claim. Tell the user to generate a new pairing session on the computer.

---

## Task 1: v2 Types, Validation, and Client Claim Key

**Files:**

- Modify: `src/lib/pairing.ts`
- Modify: `src/lib/pairing.test.ts`
- Modify: `src/test/fixtures/pairing_v1.json` only if the test loader must explicitly distinguish versions; do not alter v1 fixture contents.
- Create: `src/test/fixtures/pairing_v2.json`

**Interfaces:**

- Produces `type PairingClaim = { sessionRef: string; clientClaimKey: string }`.
- Produces `type PairingResolveInput = { source: "qr"; ticket: string; clientClaimKey: string } | { source: "code"; code: string; clientClaimKey: string }`.
- Produces `normalizePairingCode(value: string): string` returning compact uppercase form.
- Produces `formatPairingCode(value: string): string` returning `XXXX-XXXX` when eight valid characters are present.
- Produces `createClientClaimKey(): string` containing 32 random bytes encoded base64url without padding.
- Produces v2 snapshot parsing that allows `state: "claimed"` with an empty selection.

- [ ] Add failing tests for lowercase/space/hyphen normalization, ambiguous-character rejection, cryptographic client-key length/encoding, v2 claimed-empty-selection parsing, and unchanged v1 parsing.

```ts
it('normalizes and formats a pasted pairing code', () => {
  expect(normalizePairingCode('abcd ef23')).toBe('ABCDEF23')
  expect(formatPairingCode('abcd ef23')).toBe('ABCD-EF23')
  expect(() => normalizePairingCode('ABCI-EF23')).toThrow('pairing_code_invalid')
})

it('accepts an empty selection immediately after v2 resolve', () => {
  expect(parsePairingSnapshotV2(claimedV2).selectedCandidateIds).toEqual([])
})
```
- [ ] Run `npm test -- src/lib/pairing.test.ts` and confirm new exports and fixture parsing fail.
- [ ] Implement the helpers and discriminated v1/v2 parsers. Use `crypto.getRandomValues(new Uint8Array(32))`; fail closed with a user-visible unsupported-browser error if secure randomness is unavailable.

```ts
const PAIRING_ALPHABET = /^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{8}$/

export function normalizePairingCode(value: string): string {
  const separated = value.toUpperCase().replace(/\s/g, '')
  if ((separated.match(/-/g) ?? []).length > 1) throw new PairingError('pairing_code_invalid')
  const compact = separated.replace('-', '')
  if (!PAIRING_ALPHABET.test(compact)) throw new PairingError('pairing_code_invalid')
  return compact
}

export function createClientClaimKey(): string {
  if (!globalThis.crypto?.getRandomValues) throw new PairingError('secure_random_unavailable')
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}
```
- [ ] Run `npm test -- src/lib/pairing.test.ts` and confirm all tests pass.
- [ ] Commit the contract slice:

```powershell
git add src/lib/pairing.ts src/lib/pairing.test.ts src/test/fixtures/pairing_v2.json
git commit -m "feat: add web pairing v2 contract"
```

---

## Task 2: v2 RongCloud Service Methods

**Files:**

- Modify: `src/lib/api.ts`
- Create: `src/lib/api.test.ts`
- Modify: `src/services/pairing.ts`
- Modify: `src/services/pairing.test.ts`

**Interfaces:**

- Produces `resolvePairingV2(input: PairingResolveInput): Promise<{ claim: PairingClaim; snapshot: PairingSnapshotV2 }>`.
- Produces `confirmPairingV2(claim: PairingClaim, candidateIds: string[]): Promise<PairingSnapshotV2>`.
- Produces `getPairingProgressV2(claim: PairingClaim): Promise<PairingSnapshotV2>`.
- Produces `retryPairingV2(claim: PairingClaim, candidateIds: string[], idempotencyKey: string): Promise<PairingSnapshotV2>`.
- Produces `cancelPairingV2(claim: PairingClaim): Promise<void>`.
- Produces `ApiError.businessCode?: string`, populated from a bounded server `error` field without changing existing numeric `ApiError.code` behavior.
- Preserves all existing v1 service exports for compatibility.

- [ ] Add failing transport tests that assert the exact authenticated HTTPS request for QR/code resolve and exact RongCloud action names/payloads for confirm, progress, retry, and cancel. Verify no later method sends the original ticket/code.
- [ ] Add a failing `src/lib/api.test.ts` case proving `{ code: 404, error: "pairing_code_unavailable" }` becomes an `ApiError` with `businessCode === "pairing_code_unavailable"`.

```ts
it('resolves a manual code through v2', async () => {
  apiPostMock.mockResolvedValueOnce(claimedV2)
  const input = { source: 'code' as const, code: 'ABCDEF23', clientClaimKey: 'client-key' }
  await resolvePairingV2(input)
  expect(apiPostMock).toHaveBeenCalledWith('/api/ai/pairing/v2/resolve', input)
})
```
- [ ] Run `npm test -- src/lib/api.test.ts src/services/pairing.test.ts` and confirm business-code propagation and v2 calls fail.
- [ ] Implement `resolvePairingV2` through `api.post('/api/ai/pairing/v2/resolve', input)` so the existing Bearer token and client IP reach the backend. Implement the other four methods through `sendSystemRequest('ai', action, payload, 30000)`, validate v2 envelopes, and map stable server codes to the existing typed pairing error class.

```ts
export interface ApiResponse<T = unknown> {
  code: number
  message?: string
  error?: string
  data?: T
}

export interface ApiError extends Error {
  code: number
  businessCode?: string
}

error.businessCode = typeof body?.error === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(body.error)
  ? body.error
  : undefined
```

```ts
export async function resolvePairingV2(input: PairingResolveInput) {
  const snapshot = parsePairingSnapshotV2(
    await api.post<unknown>('/api/ai/pairing/v2/resolve', input),
  )
  return {
    claim: { sessionRef: snapshot.sessionRef, clientClaimKey: input.clientClaimKey },
    snapshot,
  }
}

export function confirmPairingV2(claim: PairingClaim, candidateIds: string[]) {
  return requestV2('confirmPairingV2', { ...claim, candidateIds })
}

function normalizePairingV2Error(error: unknown): PairingError {
  const businessCode = (error as ApiError | null)?.businessCode
  if (businessCode === 'pairing_code_unavailable' || businessCode === 'pairing_rate_limited') {
    return new PairingError(businessCode)
  }
  return normalizePairingError(error)
}
```
- [ ] Run `npm test -- src/lib/api.test.ts src/services/pairing.test.ts` and confirm API-error, v1, and v2 tests pass.
- [ ] Commit the service slice:

```powershell
git add src/lib/api.ts src/lib/api.test.ts src/services/pairing.ts src/services/pairing.test.ts
git commit -m "feat: add web pairing v2 service"
```

---

## Task 3: Dual Entry UI and Converged Candidate Selection

**Files:**

- Modify: `src/sections/BindDeviceDialog.tsx`
- Modify: `src/sections/BindDeviceDialog.test.tsx`

**Interfaces:**

- Produces entry choices labeled `Scan QR code` and `Enter pairing code`.
- Manual entry accepts paste and keyboard input, displays `XXXX-XXXX`, and enables `Continue` only after eight approved characters.
- On resolve, stores only `{ sessionRef, clientClaimKey }` and the returned snapshot in React memory.

- [ ] Add failing interaction tests for switching entry method, pasting `abcd ef23`, local format feedback, code resolve payload, QR resolve payload, one generated client key per opening, candidate selection after either source, and claim cleanup on close.

```tsx
it('enters a code and opens the shared candidate picker', async () => {
  render(<BindDeviceDialog open onOpenChange={vi.fn()} />)
  await user.click(screen.getByRole('tab', { name: 'Enter pairing code' }))
  await user.paste(screen.getByLabelText('Pairing code'), 'abcd ef23')
  await user.click(screen.getByRole('button', { name: 'Continue' }))
  expect(resolvePairingV2Mock).toHaveBeenCalledWith({
    source: 'code', code: 'ABCDEF23', clientClaimKey: expect.any(String),
  })
  expect(await screen.findByText('OpenCode')).toBeVisible()
})
```
- [ ] Add failing tests for error UX: `pairing_code_unavailable` keeps the field editable without disclosing why it failed, rate limit shows retry guidance, owned-session expiry returns to entry state, and refresh guidance never promises resume.
- [ ] Run `npm test -- src/sections/BindDeviceDialog.test.tsx` and confirm the manual-entry controls and v2 calls are absent.
- [ ] Refactor the dialog state to `entry -> resolving -> selecting -> connecting -> complete/error`. Reuse the existing QR camera/upload path to extract the ticket, then call `resolvePairingV2`; use `input-otp` for the manual path and call the same resolver with `source: "code"`.

```tsx
const clientClaimKeyRef = useRef<string | null>(null)
if (open && clientClaimKeyRef.current === null) {
  clientClaimKeyRef.current = createClientClaimKey()
}

async function resolveCode(value: string) {
  setPhase('resolving')
  const result = await resolvePairingV2({
    source: 'code',
    code: normalizePairingCode(value),
    clientClaimKey: clientClaimKeyRef.current!,
  })
  setClaim(result.claim)
  setSnapshot(result.snapshot)
  setPhase('selecting')
}
```
- [ ] Replace later v1 calls with v2 methods using the in-memory claim, preserving existing result cards and retry controls. Call v2 cancel on explicit cancel while the claim is active.
- [ ] Run `npm test -- src/sections/BindDeviceDialog.test.tsx` and confirm every QR/manual flow and error state passes.
- [ ] Commit the UI flow:

```powershell
git add src/sections/BindDeviceDialog.tsx src/sections/BindDeviceDialog.test.tsx
git commit -m "feat: bind devices by QR or pairing code"
```

---

## Task 4: Web Regression and Browser Interaction Gate

**Files:**

- Test: `src/lib/api.test.ts`
- Test: `src/lib/pairing.test.ts`
- Test: `src/services/pairing.test.ts`
- Test: `src/sections/BindDeviceDialog.test.tsx`
- No source change is planned in this verification-only task; any discovered defect starts a new TDD task naming its exact source/test pair.

**Interfaces:**

- Produces a production Web build that supports both v1 compatibility parsing and v2 binding.

- [ ] Run the complete unit suite with `npm test`.
- [ ] Run `npm run lint` and `npm run build`.
- [ ] Start the Web app with its existing dev command and open the device-binding dialog in the in-app browser.
- [ ] Against the test backend, verify keyboard-only manual entry, paste normalization, QR upload/scan, candidate selection, cancellation, rate-limit message, expired-session message, and responsive layout at desktop and mobile widths.
- [ ] If any issue appears, add a failing focused test, make the smallest fix, rerun the focused test, then rerun all three commands above.
- [ ] Commit only evidence-backed fixes; if no fix is needed, do not create an empty commit.

---

## Completion Gate

- [ ] Verify `rg -n "localStorage|sessionStorage" src/sections/BindDeviceDialog.tsx src/lib/pairing.ts` finds no storage of claim keys, tickets, codes, or session references.
- [ ] Verify a successful QR flow and successful code flow render the same candidate picker and call identical v2 confirm/progress methods.
- [ ] Record build output, browser URLs, screenshots, and test account identifiers without passwords or tokens in the integration report.
