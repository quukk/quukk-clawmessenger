# Dual-Entry Pairing uni-app Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let authenticated uni-app users bind a local agent platform by camera QR scan or an eight-character pairing code, choose discovered runtimes, and complete pairing consistently on H5 and supported mini-program targets.

**Architecture:** A platform-neutral pairing contract and service sit below the remote-management page. A focused entry component handles QR/manual selection and resolves through the existing authenticated HTTPS client so the backend sees the real source IP. The page keeps a random client claim key and opaque session reference in memory, then uses RongCloud system commands for selection/progress/retry/cancel and reuses the existing platform picker and result UI for both sources.

**Tech Stack:** Vue 3, uni-app, JavaScript, Vitest, H5, WeChat mini-program APIs.

**Spec:** `D:/A-project/clawmessenger/quukk-clawmessenger-worktrees/fix-runtime-manifest-beta2/docs/superpowers/specs/2026-09-03-dual-entry-pairing-code-design.md`

## Global Constraints

- Work in `D:/A-project/clawmessenger/clawmessenger-uniapp` and preserve unrelated local changes.
- Require the existing logged-in IM user. Do not persist the pairing code, QR ticket, client key, or session reference.
- Generate exactly 32 secure random bytes for one pairing attempt. Support Web Crypto and `wx.getRandomValues`; fail closed if neither exists.
- QR and manual code must converge on the same platform picker, progress polling, retry, cancellation, and result components.
- Keep the existing QR version-1 server-origin check in the normalized scanner adapter; manual entry always resolves against `API_BASE_URL` and cannot select another server.
- Support a 600-second v2 lifetime while retaining v1 fixture/parser compatibility.

---

## Task 1: v2 Contract, Code Input Rules, and Secure Client Key

**Files:**

- Modify: `src/utils/pairing-contract.js`
- Modify: `src/utils/pairing-contract.test.js`
- Create: `src/utils/__fixtures__/pairing-v2.json`

**Interfaces:**

- Produces `normalizePairingCode(value)` and `formatPairingCode(value)`.
- Produces `createPairingClientKey(environment = globalThis)` encoded as unpadded base64url.
- Produces `parsePairingSnapshotV2(value)` allowing claimed state with zero selected candidates.
- Produces `PAIRING_V2_MAX_TTL_MS = 600000`.

- [ ] Add failing tests for code normalization/formatting/rejection, 32-byte browser randomness, 32-byte WeChat randomness, unavailable randomness, v2 state parsing, 600-second TTL, and unchanged v1 parsing.

```js
it('normalizes manual code and creates a 32-byte client key', async () => {
  const cryptoApi = { getRandomValues: vi.fn((bytes) => bytes.fill(7)) };
  expect(normalizePairingCode('abcd ef23')).toBe('ABCDEF23');
  expect(formatPairingCode('ABCDEF23')).toBe('ABCD-EF23');
  expect(await createPairingClientKey({ cryptoApi })).toMatch(/^[A-Za-z0-9_-]{43}$/);
});
```
- [ ] Run `npm test -- src/utils/pairing-contract.test.js` and confirm the new exports are absent.
- [ ] Implement the approved alphabet rules and secure key generation. Do not fall back to `Math.random`.

```js
const PAIRING_CODE = /^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{8}$/;

export function normalizePairingCode(value) {
  const separated = String(value).toUpperCase().replace(/\s/g, '');
  if ((separated.match(/-/g) || []).length > 1) fail('pairing_code_invalid');
  const compact = separated.replace('-', '');
  if (!PAIRING_CODE.test(compact)) fail('pairing_code_invalid');
  return compact;
}

export async function createPairingClientKey(options = {}) {
  const bytes = new Uint8Array(32);
  const cryptoApi = options.cryptoApi || globalThis.crypto;
  const wxApi = options.wxApi || globalThis.wx;
  if (typeof cryptoApi?.getRandomValues === 'function') {
    cryptoApi.getRandomValues(bytes);
  } else if (typeof wxApi?.getRandomValues === 'function') {
    const miniProgramBytes = await randomBytesFromMiniProgram(wxApi, 32);
    bytes.set(miniProgramBytes);
  } else {
    fail('secure_random_unavailable');
  }
  return bytesToBase64Url(bytes);
}
```
- [ ] Run `npm test -- src/utils/pairing-contract.test.js` and confirm all tests pass.
- [ ] Commit the contract slice:

```powershell
git add src/utils/pairing-contract.js src/utils/pairing-contract.test.js src/utils/__fixtures__/pairing-v2.json
git commit -m "feat: add uni-app pairing v2 contract"
```

---

## Task 2: v2 System Commands and Pairing Service

**Files:**

- Modify: `src/utils/system-service-client.js`
- Modify: `src/utils/system-service-client.test.js`
- Modify: `src/utils/request.js`
- Modify: `src/utils/pairing-service.js`
- Modify: `src/utils/pairing-service.test.js`

**Interfaces:**

- Produces authenticated HTTP `resolvePairingV2Http` through `post('/api/ai/pairing/v2/resolve', payload)` and command-client methods `confirmPairingV2`, `getPairingProgressV2`, `retryPairingV2`, and `cancelPairingV2` using exact server payloads.
- Produces `createPairingService(commandApi = aiService, options = {}, resolveHttp = resolvePairingV2Http)` and methods matching Web: resolve input plus a `{ sessionRef, clientClaimKey }` claim for all later calls.
- Preserves v1 methods until the compatibility window ends.

- [ ] Add failing client tests for the authenticated HTTPS QR/code resolve request, all four follow-up action names, exact payload discrimination, required client key/session reference, and rejection of payloads containing both ticket and code.

```js
it('sends code resolve through authenticated HTTP', async () => {
  await resolvePairingV2Http({
    source: 'code', code: 'ABCDEF23', clientClaimKey: 'K'.repeat(43),
  });
  expect(post).toHaveBeenCalledWith('/api/ai/pairing/v2/resolve', {
    source: 'code', code: 'ABCDEF23', clientClaimKey: 'K'.repeat(43),
  }, { timeout: 30_000 });
});
```
- [ ] Add failing service tests proving later operations never resend ticket/code and stable server errors retain their codes.
- [ ] Run `npm test -- src/utils/system-service-client.test.js src/utils/pairing-service.test.js` and confirm v2 functions are undefined.
- [ ] Implement validators and methods in `system-service-client.js`, then expose the same operations through `createPairingService`.

```js
export const aiService = {
  ...existingAiService,
  confirmPairingV2: (payload) => sendValidated('ai', 'confirmPairingV2', payload, validateClaimCommand),
  getPairingProgressV2: (payload) => sendValidated('ai', 'getPairingProgressV2', payload, validateClaimCommand),
  retryPairingV2: (payload) => sendValidated('ai', 'retryPairingV2', payload, validateRetryV2),
  cancelPairingV2: (payload) => sendValidated('ai', 'cancelPairingV2', payload, validateClaimCommand),
};

export function resolvePairingV2Http(payload) {
  validateResolveV2(payload);
  return post('/api/ai/pairing/v2/resolve', payload, { timeout: 30_000 });
}
```

```js
async resolvePairingV2(input) {
  try {
    const data = unwrapResponse(await resolveHttp(input));
    const snapshot = parsePairingSnapshotV2(data, options);
    return {
      claim: { sessionRef: snapshot.sessionRef, clientClaimKey: input.clientClaimKey },
      snapshot,
    };
  } catch (error) {
    const code = error?.data?.error;
    if (code === 'pairing_code_unavailable' || code === 'pairing_rate_limited') {
      throw new PairingError(code, error.statusCode);
    }
    throw normalizePairingError(error);
  }
}
```
- [ ] Run the focused test command and confirm all v1/v2 tests pass.
- [ ] Commit the transport slice:

```powershell
git add src/utils/system-service-client.js src/utils/system-service-client.test.js src/utils/request.js src/utils/pairing-service.js src/utils/pairing-service.test.js
git commit -m "feat: add uni-app pairing v2 service"
```

---

## Task 3: Reusable QR or Manual Entry Component

**Files:**

- Create: `src/subPackages/remote/components/pairing-entry.vue`
- Create: `src/subPackages/remote/components/pairing-entry.test.js`
- Modify: `src/subPackages/remote/utils/pairing-qr.js`
- Modify: `src/subPackages/remote/utils/pairing-qr.test.js`

**Interfaces:**

- Component emits `resolve` with `{ source: "qr", ticket }` or `{ source: "code", code }`.
- Component emits `cancel` without secrets.
- Existing QR helper continues to accept the approved QR URI and returns only the ticket.

- [ ] Add failing component tests for the two entry tabs, camera QR result, image QR result, pasted lowercase code, `XXXX-XXXX` display, disabled incomplete submission, and reset after an invalid-code error.

```js
it('emits a normalized manual code', async () => {
  const wrapper = mount(PairingEntry);
  await wrapper.get('[data-testid="code-tab"]').trigger('click');
  await wrapper.get('[data-testid="pairing-code"]').setValue('abcd ef23');
  await wrapper.get('[data-testid="continue"]').trigger('click');
  expect(wrapper.emitted('resolve')[0]).toEqual([{ source: 'code', code: 'ABCDEF23' }]);
});
```
- [ ] Run `npm test -- src/subPackages/remote/components/pairing-entry.test.js src/subPackages/remote/utils/pairing-qr.test.js` and confirm the new component is missing.
- [ ] Implement a touch-friendly component using uni-app controls, numeric-independent text input, paste support on H5, and the existing QR helpers. Keep the raw ticket/code only in component memory until it emits resolve, then clear the field.

```vue
<template>
  <view class="pairing-entry">
    <view role="tablist">
      <button data-testid="qr-tab" @click="mode = 'qr'">扫码绑定</button>
      <button data-testid="code-tab" @click="mode = 'code'">输入配对码</button>
    </view>
    <input v-if="mode === 'code'" data-testid="pairing-code"
      :value="displayCode" maxlength="9" @input="onCodeInput" />
    <button v-if="mode === 'code'" data-testid="continue"
      :disabled="compactCode.length !== 8" @click="submitCode">继续</button>
  </view>
</template>
```

```js
function submitCode() {
  emit('resolve', { source: 'code', code: normalizePairingCode(compactCode.value) });
  compactCode.value = '';
}
```
- [ ] Run the focused tests and confirm both camera/manual paths pass.
- [ ] Commit the entry component:

```powershell
git add src/subPackages/remote/components/pairing-entry.vue src/subPackages/remote/components/pairing-entry.test.js src/subPackages/remote/utils/pairing-qr.js src/subPackages/remote/utils/pairing-qr.test.js
git commit -m "feat: add mobile dual-entry pairing"
```

---

## Task 4: Remote Page v2 State Machine and Shared Platform Picker

**Files:**

- Modify: `src/subPackages/remote/pages/remote/index.vue`
- Modify: `src/subPackages/remote/pages/remote/index.pairing.test.js`
- Modify: `src/subPackages/remote/components/pairing-platform-picker.vue`
- Modify: `src/subPackages/remote/components/pairing-platform-picker.test.js`

**Interfaces:**

- Page state stores `pairingClaim = { sessionRef, clientClaimKey } | null`, never the original credential after resolution.
- Both entry sources transition through `entry -> resolving -> selecting -> connecting -> complete/error`.
- Picker emits only candidate IDs from the frozen resolved snapshot.

- [ ] Add failing page tests for one client key per attempt, QR/code convergence, empty selection after resolve, multi-runtime selection, progress polling, retry idempotency, explicit cancellation, dialog close cleanup, and error recovery.

```js
it.each([
  [{ source: 'qr', ticket: 'T'.repeat(43) }],
  [{ source: 'code', code: 'ABCDEF23' }],
])('routes %o to the same platform picker', async (entry) => {
  const wrapper = mountRemotePage();
  await wrapper.findComponent(PairingEntry).vm.$emit('resolve', entry);
  await flushPromises();
  expect(wrapper.findComponent(PairingPlatformPicker).props('candidates')).toEqual(candidates);
});
```
- [ ] Add a platform-picker test that rejects stale or unknown candidate IDs after the resolved snapshot changes.
- [ ] Run `npm test -- src/subPackages/remote/pages/remote/index.pairing.test.js src/subPackages/remote/components/pairing-platform-picker.test.js` and confirm current v1 ticket state fails the new expectations.
- [ ] Replace `pairingTicket` follow-up state with `pairingClaim`, mount `pairing-entry.vue`, call v2 resolve, and route both sources into the existing picker. Use the claim for confirm/progress/retry/cancel and clear it on terminal state or unmount.

```js
const pairingClaim = ref(null);
const clientClaimKey = ref(null);

async function resolveEntry(entry) {
  clientClaimKey.value ||= await createPairingClientKey({
    cryptoApi: globalThis.crypto,
    wxApi: globalThis.wx,
  });
  const result = await pairingService.resolvePairingV2({
    ...entry,
    clientClaimKey: clientClaimKey.value,
  });
  pairingClaim.value = result.claim;
  pairingSnapshot.value = result.snapshot;
  pairingStep.value = 'selecting';
}
```
- [ ] Map pre-claim `pairing_code_unavailable`, `pairing_rate_limited`, and owned-session terminal errors to concise Chinese guidance without disclosing whether an entered code was invalid, expired, cancelled, or already claimed.
- [ ] Run the focused tests and confirm all flows pass.
- [ ] Commit the page migration:

```powershell
git add src/subPackages/remote/pages/remote/index.vue src/subPackages/remote/pages/remote/index.pairing.test.js src/subPackages/remote/components/pairing-platform-picker.vue src/subPackages/remote/components/pairing-platform-picker.test.js
git commit -m "feat: connect remote page to pairing v2"
```

---

## Task 5: H5 and Mini-Program Regression Gate

**Files:**

- Test: `src/utils/pairing-contract.test.js`
- Test: `src/utils/system-service-client.test.js`
- Test: `src/utils/pairing-service.test.js`
- Test: `src/subPackages/remote/components/pairing-entry.test.js`
- Test: `src/subPackages/remote/components/pairing-platform-picker.test.js`
- Test: `src/subPackages/remote/pages/remote/index.pairing.test.js`
- No source change is planned in this verification-only task; any discovered defect starts a new TDD task naming its exact source/test pair.

**Interfaces:**

- Produces build artifacts for the repository's supported H5 and mini-program targets.

- [ ] Run the full unit suite with `npm test`.
- [ ] Run the H5 build with `npm run build` and the WeChat mini-program build with `npm run build:mp-weixin`; record both outputs in the integration report.
- [ ] Start H5 locally and test code paste, QR image selection, platform selection, cancellation, expiry, and responsive touch targets in the in-app browser.
- [ ] Load the generated mini-program build in the configured developer tool and verify `wx.getRandomValues`, camera permission denial/retry, scanning, manual entry, and picker behavior.
- [ ] If a target-specific issue appears, add a failing unit test where possible, make the smallest target-aware fix, and rerun the focused test plus both builds.
- [ ] Commit only evidence-backed fixes; if no fix is needed, do not create an empty commit.

---

## Completion Gate

- [ ] Run `rg -n "uni\.setStorage|localStorage|sessionStorage" src/subPackages/remote src/utils/pairing-*` and confirm no pairing secret or claim is persisted.
- [ ] Verify `Math.random` is absent from client-claim key generation.
- [ ] Capture H5 and mini-program screenshots for both entry methods without exposing a still-valid code or QR ticket in the committed report.
