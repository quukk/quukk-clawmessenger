# Dual-Entry Pairing NPM Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade `quukk-clawmessenger` so its local Setup page shows one v2 QR ticket and one matching human pairing code, preserves actionable pairing errors, and reliably opens or prints the complete one-time setup URL on Windows.

**Architecture:** The daemon creates a v2 session through the production server, keeps the returned raw code only in memory, and exposes it through the authenticated loopback bridge API. The React bridge UI presents QR and code as two representations of one session. CLI launch uses an argument-safe Windows URL handler and always prints a short-lived fallback URL when automatic opening cannot be proven.

**Tech Stack:** TypeScript, Node.js 22, pnpm, Vitest, React, Vite, Zod, NPM packaging.

**Spec:** `D:/A-project/clawmessenger/quukk-clawmessenger-worktrees/fix-runtime-manifest-beta2/docs/superpowers/specs/2026-09-03-dual-entry-pairing-code-design.md`

## Global Constraints

- Work in `D:/A-project/clawmessenger/quukk-clawmessenger-worktrees/fix-runtime-manifest-beta2` on `codex/beta5-ws-security`.
- Do not modify or stage `.superpowers/sdd/2026-09-02-agent-platform-pairing/task-9-report.md` or `packages/quukk-clawmessenger/quukk-clawmessenger-0.1.0-beta.7.tgz`.
- Keep v1 parsing available during the compatibility window, but create new sessions with server v2.
- Keep the QR payload exactly at version 1 with only `type`, `version`, `server`, `ticket`, and `expiresAt`; never embed the short code or device secret.
- Never write the raw pairing code, setup ticket, QR ticket, device secret, client key, or authenticated setup URL to persistent log files.
- The code is display-only on the local computer. The plugin never resolves the code itself.
- Pairing-specific server errors remain pairing-specific through client, service, local HTTP, and UI layers.
- A v2 waiting session lasts 600 seconds and exposes one countdown for both QR and code.

---

## Task 1: v2 Pairing Contract and Production Client

**Files:**

- Modify: `packages/quukk-clawmessenger/src/pairing/schema.ts`
- Modify: `packages/quukk-clawmessenger/src/pairing/schema.test.ts`
- Modify: `packages/quukk-clawmessenger/src/pairing/client.ts`
- Modify: `packages/quukk-clawmessenger/src/pairing/client.test.ts`
- Create: `packages/quukk-clawmessenger/src/protocol/fixtures/pairing-v2-create.json`

**Interfaces:**

- Produces `PairingSessionV2` with `ticket`, `deviceSecret`, compact `pairingCode`, `expiresAt`, `status`, and zero to sixteen candidates.
- Produces `parsePairingSessionV2(value: unknown, options?: { now?: () => number }): PairingSessionV2` with a maximum 600-second future expiry.
- Produces `PairingClient.createSessionV2(input: CreatePairingSessionInput, signal?: AbortSignal): Promise<PairingSessionV2>` using the existing required install abuse key and idempotency key.
- Consumes `POST /api/ai/pairing/v2/sessions`.
- Preserves `parsePairingSessionV1` and the v1 fixture unchanged.

- [ ] Add failing schema tests that accept compact `ABCDEF23`, reject lowercase, separators, or malformed server codes, require a 600-second-compatible future expiry, and still parse `pairing-v1.json`.

```ts
it('parses a v2 creation response', () => {
  const parsed = parsePairingSessionV2({
    ticket: 'A'.repeat(43),
    deviceSecret: 'B'.repeat(43),
    pairingCode: 'ABCDEF23',
    expiresAt: '2026-09-03T08:40:00.000Z',
    candidates: [readyOpenCodeCandidate],
  }, { now: () => Date.parse('2026-09-03T08:30:00.000Z') })
  expect(parsed.pairingCode).toBe('ABCDEF23')
})
```
- [ ] Add a failing client test that asserts the exact v2 URL, request body, bridge authentication headers, response parsing, and stable error codes for `pairing_rate_limited`, `pairing_expired`, `pairing_unavailable`, and network timeout.
- [ ] Run `corepack pnpm --dir packages/quukk-clawmessenger exec vitest run src/pairing/schema.test.ts src/pairing/client.test.ts` and confirm failures identify the absent v2 parser/client method.
- [ ] Implement the v2 Zod schema, fixture, and `createSessionV2`; keep timeout cancellation behavior and v1 exports intact.

```ts
export function pairingSessionV2SchemaFor(options: PairingClockOptions = {}) {
  const now = clock(options)
  return z.strictObject({
    ticket: credentialSchema,
    deviceSecret: credentialSchema,
    pairingCode: z.string().regex(/^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{8}$/),
    expiresAt: z.iso.datetime({ offset: true }).superRefine((value, context) => {
      const remaining = Date.parse(value) - now()
      if (remaining <= 0 || remaining > 600_000) {
        context.addIssue({ code: 'custom', message: 'pairing_response_invalid' })
      }
    }),
    status: z.literal('waiting'),
    candidates: z.array(pairingCandidateSchema).max(16),
  })
}

export const pairingSessionV2Schema = pairingSessionV2SchemaFor()

async function createSessionV2(input: CreatePairingInput): Promise<PairingSessionV2> {
  return request('/api/ai/pairing/v2/sessions', input, z.strictObject({
    code: z.literal(201), data: pairingSessionV2Schema,
  })).then((envelope) => envelope.data)
}
```
- [ ] Run the same focused Vitest command and confirm all schema/client tests pass.
- [ ] Commit this contract slice:

```powershell
git add packages/quukk-clawmessenger/src/pairing/schema.ts packages/quukk-clawmessenger/src/pairing/schema.test.ts packages/quukk-clawmessenger/src/pairing/client.ts packages/quukk-clawmessenger/src/pairing/client.test.ts packages/quukk-clawmessenger/src/protocol/fixtures/pairing-v2-create.json
git commit -m "feat: consume pairing v2 sessions"
```

---

## Task 2: In-Memory Pairing Session and Specific Error Preservation

**Files:**

- Modify: `packages/quukk-clawmessenger/src/pairing/service.ts`
- Modify: `packages/quukk-clawmessenger/src/pairing/service.test.ts`
- Modify: `packages/quukk-clawmessenger/src/service.ts`
- Modify: `packages/quukk-clawmessenger/src/service.test.ts`

**Interfaces:**

- Produces a waiting-session snapshot `{ schemaVersion: 2, state: "waiting", expiresAt, qrContent, pairingCode, candidates }`.
- Produces creation/client errors `pairing_timeout`, `pairing_transport`, `pairing_unauthorized`, `pairing_response_invalid`, `pairing_rate_limited`, and `pairing_unavailable`; uses `operation_unavailable` only for an unclassified failure.

- [ ] Add failing tests showing `startPairing` calls `createSessionV2`, retains `pairingCode` only until claim/expiry/cancel, uses a 600-second TTL, and preserves `pairing_timeout`, `pairing_transport`, `pairing_unauthorized`, `pairing_response_invalid`, `pairing_rate_limited`, and `pairing_unavailable` without collapsing them.

```ts
it.each([
  'pairing_timeout', 'pairing_transport', 'pairing_unauthorized',
  'pairing_response_invalid', 'pairing_rate_limited', 'pairing_unavailable',
])(
  'preserves %s',
  async (code) => {
    client.createSessionV2.mockRejectedValueOnce(new PairingClientError(code))
    await expect(service.startPairing(candidates)).rejects.toMatchObject({ code })
  },
)
```
- [ ] Run `corepack pnpm --dir packages/quukk-clawmessenger exec vitest run src/pairing/service.test.ts src/service.test.ts` and confirm the old v1 call and generic error assertions fail.
- [ ] Update the pairing service to use v2, keep code state in memory, erase the code as soon as progress is no longer `waiting`, and pass known error codes through `service.ts` unchanged.

```ts
const creation = await client.createSessionV2({ candidates, idempotencyKey })
activeSession = {
  schemaVersion: 2,
  state: 'waiting',
  expiresAt: creation.expiresAt,
  qrContent: createPairingQrContent(creation),
  pairingCode: creation.pairingCode,
  candidates: creation.candidates,
  results: [],
}

function publicSnapshot(state: PairingState): PairingEnvelope {
  return state.state === 'waiting' ? state : { ...state, pairingCode: null, qrContent: null }
}
```
- [ ] Run the same focused Vitest command and confirm all tests pass.
- [ ] Commit the service slice:

```powershell
git add packages/quukk-clawmessenger/src/pairing/service.ts packages/quukk-clawmessenger/src/pairing/service.test.ts packages/quukk-clawmessenger/src/service.ts packages/quukk-clawmessenger/src/service.test.ts
git commit -m "feat: retain pairing code and preserve errors"
```

---

## Task 3: Authenticated Loopback API Contract

**Files:**

- Modify: `packages/quukk-clawmessenger/src/http/routes.ts`
- Modify: `packages/quukk-clawmessenger/src/http/routes.test.ts`
- Modify: `apps/bridge/src/types.ts`
- Modify: `apps/bridge/src/api.ts`
- Modify: `apps/bridge/src/api.test.ts`

**Interfaces:**

- Produces `POST /api/pairing/session` response `{ schemaVersion: 2, state, expiresAt, qrContent, pairingCode, candidates, results }`.
- Produces local HTTP errors with the same stable pairing `code`, `category`, and `retryable` values emitted by the service.
- Keeps loopback session-cookie and `X-Quukk-CSRF` protection mandatory.

- [ ] Add failing route/API tests for a successful v2 response, no raw code after `claimed`, and exact propagation of each stable pairing error. Retain tests for `session_required` and CSRF rejection.

```ts
it('returns the v2 waiting envelope', async () => {
  pairing.start.mockResolvedValueOnce(waitingV2)
  const response = await authenticatedPost('/api/pairing/session')
  expect(await response.json()).toMatchObject({
    schemaVersion: 2,
    state: 'waiting',
    pairingCode: 'ABCDEF23',
  })
})
```
- [ ] Run `corepack pnpm --dir packages/quukk-clawmessenger exec vitest run src/http/routes.test.ts` and `corepack pnpm --dir apps/bridge exec vitest run src/api.test.ts`; confirm the new response field/error cases fail.
- [ ] Extend the local route serializer and bridge parser/types. Add known pairing errors to the local error registry rather than mapping them to `operation_unavailable`.

```ts
const PAIRING_ERRORS = {
  pairing_timeout: { status: 504, category: 'transport', retryable: true },
  pairing_transport: { status: 502, category: 'transport', retryable: true },
  pairing_unauthorized: { status: 401, category: 'authentication', retryable: false },
  pairing_response_invalid: { status: 502, category: 'policy', retryable: false },
  pairing_rate_limited: { status: 429, category: 'transport', retryable: true },
  pairing_unavailable: { status: 503, category: 'transport', retryable: true },
} as const
```
- [ ] Run both focused commands again and confirm all tests pass.
- [ ] Commit the local API slice:

```powershell
git add packages/quukk-clawmessenger/src/http/routes.ts packages/quukk-clawmessenger/src/http/routes.test.ts apps/bridge/src/types.ts apps/bridge/src/api.ts apps/bridge/src/api.test.ts
git commit -m "feat: expose dual-entry pairing locally"
```

---

## Task 4: Setup Page QR, Pairing Code, Copy, and Countdown

**Files:**

- Modify: `apps/bridge/src/components/pairing-panel.tsx`
- Modify: `apps/bridge/src/components/pairing-panel.test.tsx`
- Modify: `apps/bridge/src/pages/setup.tsx`
- Modify: `apps/bridge/src/pages/setup.test.tsx`

**Interfaces:**

- Consumes the v2 local pairing envelope from `apps/bridge/src/api.ts`.
- Produces accessible controls labeled `Copy pairing code` and `Generate a new pairing session`.
- Produces one visible expiry countdown shared by QR and code.
- Produces local helper `formatPairingCode(compact: string): string` for display/copy only.

- [ ] Add failing UI tests proving the QR and `ABCD-EF23` appear together, copy writes the display code to the clipboard, one countdown is rendered, sensitive entry data disappears after claim/expiry/cancel, regeneration cancels the old server session before starting a new one, and timeout/transport/unauthorized/rate-limit/invalid-response errors show distinct actionable messages.

```tsx
it('shows and copies the pairing code beside the QR', async () => {
  render(<PairingPanel session={waitingV2} onRegenerate={vi.fn()} />)
  expect(screen.getByText('ABCD-EF23')).toBeVisible()
  await userEvent.click(screen.getByRole('button', { name: 'Copy pairing code' }))
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith('ABCD-EF23')
  expect(screen.getAllByRole('timer')).toHaveLength(1)
})
```
- [ ] Run `corepack pnpm --dir apps/bridge exec vitest run src/components/pairing-panel.test.tsx src/pages/setup.test.tsx` and confirm the code/copy assertions fail.
- [ ] Update the pairing panel with a two-column responsive layout: QR on the left, large monospace code and copy action on the right, one countdown below, and a regenerate action after expiry. Use live-region status text for copy and error feedback.

```tsx
function formatPairingCode(compact: string): string {
  return `${compact.slice(0, 4)}-${compact.slice(4)}`
}

<section className="pairing-grid" aria-label="Pair this computer">
  <QrCode value={session.qrContent} />
  <div>
    <output className="pairing-code">{formatPairingCode(session.pairingCode)}</output>
    <button type="button" onClick={() => copy(formatPairingCode(session.pairingCode))}>
      Copy pairing code
    </button>
  </div>
  <output role="timer">{formatRemaining(expiresAt - now)}</output>
  <p aria-live="polite">{statusMessage}</p>
</section>
```
- [ ] Run the focused tests and `corepack pnpm --dir apps/bridge build`; confirm both pass.
- [ ] Commit the UI slice:

```powershell
git add apps/bridge/src/components/pairing-panel.tsx apps/bridge/src/components/pairing-panel.test.tsx apps/bridge/src/pages/setup.tsx apps/bridge/src/pages/setup.test.tsx
git commit -m "feat: show QR and pairing code in setup"
```

---

## Task 5: Windows Setup Launch and Recoverable One-Time URL

**Files:**

- Modify: `packages/quukk-clawmessenger/src/cli.ts`
- Modify: `packages/quukk-clawmessenger/src/cli.test.ts`

**Interfaces:**

- Produces `BrowserOpenResult = { status: "opened" } | { status: "manual_required"; reason: string }`.
- Windows browser launch invokes `%SystemRoot%/System32/rundll32.exe` with arguments `url.dll,FileProtocolHandler` and the complete URL as one argument.
- `setup` prints the complete short-lived `http://127.0.0.1:<port>/setup#ticket=<ticket>` recovery URL to the interactive terminal on Windows and whenever automatic launch reports `manual_required`.

- [ ] Add failing tests that capture the spawned executable/argument array and prove a URL containing `#ticket=` is not truncated, no shell is used, spawn failure prints the exact fallback URL, and the fallback URL never enters the persistent logger.

```ts
it('opens a complete setup URL on Windows without a shell', async () => {
  await openSystemBrowser(setupUrl, { platform: 'win32', env, spawn })
  expect(spawn).toHaveBeenCalledWith(
    'C:\\Windows\\System32\\rundll32.exe',
    ['url.dll,FileProtocolHandler', setupUrl],
    expect.objectContaining({ shell: false }),
  )
  expect(setupUrl).toContain('#ticket=')
})
```
- [ ] Run `corepack pnpm --dir packages/quukk-clawmessenger exec vitest run src/cli.test.ts -t "setup browser"` and confirm the current Explorer launch behavior fails.
- [ ] Replace Windows Explorer invocation with argument-safe `rundll32.exe`; return a structured launch result. Print a clearly labeled, 30-second one-time fallback URL to stdout on Windows because process spawn cannot confirm browser navigation. Keep Linux/macOS launch behavior and output compatible.

```ts
const executable = join(environment.SystemRoot ?? environment.WINDIR ?? 'C:\\Windows', 'System32', 'rundll32.exe')
const child = spawn(executable, ['url.dll,FileProtocolHandler', url], {
  shell: false,
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
})
child.unref()
writeLine(`If the browser did not open, use this one-time URL within 30 seconds: ${url}`)
return { status: 'opened' }
```
- [ ] Run `corepack pnpm --dir packages/quukk-clawmessenger exec vitest run src/cli.test.ts` and confirm the full CLI suite passes.
- [ ] Commit the Windows fix:

```powershell
git add packages/quukk-clawmessenger/src/cli.ts packages/quukk-clawmessenger/src/cli.test.ts
git commit -m "fix: preserve setup ticket on Windows launch"
```

---

## Task 6: Package Verification and Beta Artifact

**Files:**

- Modify: `packages/quukk-clawmessenger/package.json`
- Modify: `pnpm-lock.yaml` through `corepack pnpm install --lockfile-only` after the package-version change.
- Modify: `.github/workflows/quukk-clawmessenger-runtime.yml`
- Modify: `scripts/clawmessenger-runtime-workflow.test.ts`
- Create during verification, then remove before commit: a temporary `npm pack` output outside the repository.

**Interfaces:**

- Produces a single installable `quukk-clawmessenger@0.1.0-beta.8` package.
- Preserves CLI commands `setup`, `status`, `doctor`, `rescan`, and `stop`.
- Produces an entry-only workflow publish command `npm publish "$entry_archive" --access public --tag beta --provenance=false`.

- [ ] Run package and bridge verification before the version bump:

```powershell
corepack pnpm --dir packages/quukk-clawmessenger test
corepack pnpm --dir packages/quukk-clawmessenger build
corepack pnpm --dir apps/bridge test
corepack pnpm --dir apps/bridge build
```

- [ ] Set the package version to `0.1.0-beta.8`, update the lockfile through the repository package manager, and run `npm pack --dry-run --json` from `packages/quukk-clawmessenger`. Confirm `dist`, `bin/quukk-clawmessenger.js`, and bridge assets are included and source tests/secrets are excluded.

```json
{
  "name": "quukk-clawmessenger",
  "version": "0.1.0-beta.8"
}
```

- [ ] Change only the entry-only publish step to the explicitly approved no-provenance form and update its workflow contract test:

```ts
expect(publishEntry.run).toContain(
  'npm publish "$entry_archive" --access public --tag beta --provenance=false',
)
```

- [ ] Run `corepack pnpm exec vitest run scripts/clawmessenger-runtime-workflow.test.ts` and confirm the workflow test passes.
- [ ] Pack into a new temporary directory, install it into a clean temporary NPM prefix, and run the actual installed binary:

```powershell
$artifactDir = New-Item -ItemType Directory -Path ([IO.Path]::Combine([IO.Path]::GetTempPath(), [guid]::NewGuid().ToString()))
$prefixDir = New-Item -ItemType Directory -Path ([IO.Path]::Combine([IO.Path]::GetTempPath(), [guid]::NewGuid().ToString()))
npm pack --pack-destination $artifactDir.FullName
npm install --global --prefix $prefixDir.FullName (Get-ChildItem $artifactDir.FullName -Filter '*.tgz').FullName
& "$($prefixDir.FullName)\quukk-clawmessenger.cmd" --version
& "$($prefixDir.FullName)\quukk-clawmessenger.cmd" doctor --json
```

- [ ] Confirm the installed CLI reports `0.1.0-beta.8`, starts a loopback service, and returns structured JSON. Stop it with the installed binary.
- [ ] Commit only version metadata:

```powershell
git add packages/quukk-clawmessenger/package.json pnpm-lock.yaml .github/workflows/quukk-clawmessenger-runtime.yml scripts/clawmessenger-runtime-workflow.test.ts
git commit -m "chore: prepare quukk-clawmessenger beta.8"
```

---

## Completion Gate

- [ ] Search the staged diff with `git diff --cached` before every commit and confirm the unrelated report and beta.7 tarball never appear.
- [ ] Run `git grep -n "console.*ticket\|logger.*ticket\|console.*deviceSecret\|logger.*pairingCode" -- packages/quukk-clawmessenger apps/bridge` and inspect every match for secret leakage.
- [ ] Do not publish from this plan; publishing and production-like installation are controlled by the integration rollout plan.
