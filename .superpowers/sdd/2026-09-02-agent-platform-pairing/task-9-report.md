# Task 9 report — Web Platform Selection and Device Refresh

## Status

DONE

- Worktree: `D:\A-project\clawmessenger\clawmessenger-web-worktrees\agent-platform-pairing`
- Base: `6054426269df532370dd62800fd31e43ac93eaf8`
- Commit: `0355f37 feat(web): select local agents after QR scan`
- Scope: `BindDeviceDialog.tsx`, `BindDeviceDialog.test.tsx`, `Home.tsx`, and `device.ts` only.
- The controller explicitly prohibited subagent dispatch, so the implementer, task-review, and final-review checkpoints were performed locally and recorded here. The central `progress.md` was not edited.

## Implementation

- Replaced the manual node-ID form with an accessible three-stage camera/image-upload, candidate-selection, and per-candidate progress dialog.
- Kept all candidates unselected initially. Only `ready` + `unregistered` candidates can be checked; unavailable candidates remain visible with a server-safe reason or a bounded fallback reason.
- Confirmation derives candidate IDs from the checked, still-selectable snapshot entries in server order and calls `confirmPairing(ticket, candidateIds)` once.
- Added expiration countdown, rescan, normalized safe error copy, pending/registering/bound/already-bound/failed states, and terminal summaries.
- Polling is serialized and stops at terminal state. Generation, mounted/open, submission, completion, cancellation, and terminal refs prevent StrictMode duplication, stale-promise updates, post-unmount updates, overlapping confirmation, duplicate callbacks, and duplicate cancellation.
- Closing before confirmation cancels an inspected ticket once. Confirmed or terminal sessions are never cancelled on close. Countdown expiry exposes rescan without issuing a redundant cancel.
- Retry is exposed only for a selected `failed` result whose server-projected safe code is `registration_failed` and whose session is still valid. The user command protocol has no retry mutation; the button safely resumes progress observation and never reconfirms or expands the frozen selection. `runtime_unavailable` and `owned_by_other_account` are permanent and never get retry controls.
- `Home` consumes terminal results and calls its existing `loadDevices(userId)` exactly once per dialog completion callback only when at least one result is `bound` or `already_bound`. Partial success refreshes; all-failed, cancelled, and expired outcomes do not.
- Repository-wide search found no remaining `bindNode` consumer after removing the Home UI path, so the Web `scanBind` wrapper was removed instead of retaining a dead deprecated export. Server-side legacy compatibility is unchanged.

## RED evidence

1. Initial dialog RED:
   - Command: `npm test -- src/sections/BindDeviceDialog.test.tsx`
   - Result: 1 file failed, 6/6 tests failed.
   - Expected first failure: no accessible `Scan with camera` button; rendered DOM still contained the legacy node-ID textbox.
2. Home refresh decision RED:
   - Command: `npm test -- src/sections/BindDeviceDialog.test.tsx -t "Home pairing refresh decision"`
   - Result: 1 failed, 6 skipped.
   - Expected failure: `Home` had no pairing completion refresh predicate/callback contract.
3. Real scanner-hook identity RED:
   - Command: `npm test -- src/sections/BindDeviceDialog.test.tsx -t "offers camera/upload"`
   - Result: 1 failed, 6 skipped.
   - Expected failure after making the mock match the real hook's fresh wrapper object: `Maximum update depth exceeded`. Fixed by depending only on the hook's stable methods/state members.
4. Terminal expiry RED:
   - Command: `npm test -- src/sections/BindDeviceDialog.test.tsx -t "countdown expiry"`
   - Result: 1 failed, 7 skipped.
   - Expected failure: terminal expiry had no accessible `Rescan` action. The subsequent fix also prevents redundant cancellation after expiry.

## GREEN evidence

- Dialog/Home decision suite: `npm test -- src/sections/BindDeviceDialog.test.tsx` → 1 file, 8/8 tests passed during the final focused cycle.
- Focused integration: `npm test -- src/sections/BindDeviceDialog.test.tsx src/pages/Home.discussion.test.tsx src/services/pairing.test.ts src/hooks/useQrScanner.test.tsx` → 4 files, 35/35 tests passed.
- Full Web suite with canonical current-server fixtures:
  - `CLAWMESSENGER_DISCUSSION_WIRE_CONTRACT=D:\A-project\clawmessenger\clawmessenger-server-worktrees\agent-platform-pairing\tests\fixtures\discussion_wire_cross_runtime.json`
  - `CLAWMESSENGER_SYSTEM_HOST_CONTRACT=D:\A-project\clawmessenger\clawmessenger-server-worktrees\agent-platform-pairing\tests\fixtures\system_host_role_recommendation.json`
  - `npm test` → 26 files, 246/246 tests passed.
- `npm run build` → exit 0; TypeScript and Vite production build completed. Existing informational warnings remain for stale Browserslist data, ignored dependency `use client` directives/source maps, and the pre-existing large bundle.
- `npm run lint` → exit 0, no findings.
- `git diff --check` → exit 0; only the existing Windows LF/CRLF working-copy notices were printed.
- Scope comparison → exactly the four Task 9 files changed.
- Production pairing UI search → no manual node-ID input, `scanBind`, `bindNode`, private device secret, runtime ID, local authorization root, bridge secret, or MAC field in the dialog path.

## Self-review

### Spec compliance

- Camera and upload are both always available at scan stage, including permission/error fallback.
- No platform defaults selected; confirmation stays disabled until a selectable candidate is checked.
- Disabled cards retain display/version and a clear reason; expiry has live countdown and rescan.
- Progress includes every selected candidate and all five result states; terminal completed/partial/cancelled/expired states stop scheduled polling.
- Confirm request contains exactly checked ready/unregistered candidate IDs; no payload user ID or node ID is created by the UI.
- Close/rescan/unmount/StrictMode/stale asynchronous results are guarded; cancellation is at most once and only before confirmation/nonterminal state.
- Home refresh gating covers bound, already-bound, partial success, all-failed, cancelled, and empty results.

### Code quality

- No Critical or Important findings remain after two local fix rounds (hook wrapper dependency loop; expired terminal cancellation/rescan).
- The dialog is intentionally self-contained in the plan-mandated file; protocol parsing/scanning/transport remain in the Task 8 modules rather than being duplicated.
- All user-visible transport failures are mapped from stable codes; raw errors, tickets, paths, credentials, and upstream bodies are never rendered or logged.

## Concerns / ruling

- Ruling: Web cannot initiate a computer-side retry because the approved user-facing protocol exposes inspect/confirm/progress/cancel only and confirmation is selection-frozen. Therefore the retry control only resumes authenticated progress observation for the one public error class (`registration_failed`) that current server strict projection maps from retryable registration failures. Adding a retry mutation would be a cross-repository protocol expansion outside Task 9.
- Non-blocking existing build warnings are unchanged and unrelated to Task 9.

## Retry-channel integration addendum

The earlier ruling that Web could only resume progress observation is superseded by the approved cross-repository retry-channel integration recorded in `task-9-retry-channel-report.md`.

- Web core now exposes an authenticated, idempotent `ai.retryPairing` command; the dialog wiring remains a separate UI concern.
- Server persists and delivers retry requests only for the claimed session's frozen, retryable failed selection.
- The installed package consumes each retry request once, retries registration through the existing path, and acknowledges with a stable idempotency key.
- Review rounds hardened exact ticket validation, strict cancelled/expired device errors, rate-compatible polling/backoff, and an independently bounded ACK lifecycle after registration reaches `completed`.
- Latest package verification after retry-channel review round 2: **35 test files, 1001 tests passed**, and package TypeScript typecheck passed.
- Retry-channel commits through round 2: Server `63b00f2` and `461d874`; Web `bdfc01e`; package `5d3434cd2`, `bec6932a0`, and `1530e6184`.
- The central `progress.md` remains intentionally untouched by these integration fixes.
