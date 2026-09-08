# Discussion host compatibility acceptance — 2026-09-08

## Approved integration and bubble role follow-up

Integration completed: backend `main` is pushed and remote-verified at **a795e6131bc8a07506bb4ab55f29ac5208888c01**. The merged-main focused suite passed **259 tests with 20 optional/environment skips**; no production source differs from the full-suite tested feature tree. Source deployment must run real database initialization/schema checks for migration 011 before the existing multi-worker service is restarted. Long-discussion and final-summary live acceptance is still pending user deployment. Temporary native PostgreSQL was stopped and task worktrees were preserved for that acceptance.

Backend final standard suite: **927 passed, 47 skipped**, 16 existing warnings (203.10s). Code was fast-forwarded to local main `a795e61`, preserving the original checkout's two unrelated untracked documents. Final main smoke verification and remote push are checked separately. Real browser refresh confirmed both exact labels `小久 · Codex · 最小功能规划师` and `小久 · OpenClaw · 验收风险评估师`; the old discussion still has event 7/summarizing until the backend update and a legitimate recovery action.

The user approved integration despite the three independently reproduced baseline PostgreSQL admin failures, and approved discussion bubble labels in the form `nickname · role`. Web commit `5f5b83f` implements the label using the current discussion role snapshot, preserving plain avatar nicknames and name-only display when no role exists. Three render regressions failed before the fix; root full verification then passed **363/363 tests**, TypeScript and production build. Independent scoped review passed. The feature branch was pushed and its remote SHA verified. Backend main integration/deployment status will be recorded after the standard suite rerun completes; earlier paused status below is superseded by this explicit approval, not by an assumption that the baseline failures are fixed.

## Shared delivery implementation and integration gate

This section supersedes earlier implementation status, but does not establish live acceptance.

- Backend commits `0051d0e` and `54d1dc9` implement additive PostgreSQL shared wire/delta buffers, ordered producer sequences, locked terminal-state validation, and complete bounded host context. Final synthesis excludes unused member text from its budget and preserves the newest checkpoint using UTF-8 excerpts without changing history. Independent task and final scoped reviews passed; direct delta TTL/cap exhaustion tests remain a deferred Minor coverage gap.
- Root native PostgreSQL 17.11 full run on `0051d0e`: **962 passed, 1 skipped, 3 failed**. All three failures were independently reproduced on unchanged main `e169a9b`: user-node PUT HTTP 503, statistics HTTP 503, and a missing expected audit `binding_policy` field. They are not silently suppressed or claimed fixed. Final focused native PostgreSQL run on `54d1dc9`: **278 passed, 1 skipped**, covering discussion service, shared delivery, wire and server regressions.
- Bridge `db8f24d` is pushed on `feat/chat-stream-stop`; root verified **1,160/1,160 tests**, TypeScript and compilation. The original SDK normalizer now retains only the known host fields required by the strict parser; prompts include exact action schemas, host instructions and bounded context. Local CLI restart reached ready at 17:32:44 (PID25912, port57871), without rebinding devices.
- Web `1c30828` is pushed on `feat/chat-stream-stop`; root verified **360/360 tests**, TypeScript and production build. Completed contributions no longer resume streaming after late deltas. Existing discussion classification survives refreshed login, and five tabs fit the actual narrow sidebar.
- Backend integration is paused pending the user's decision on the three known baseline failures, per the branch-finishing verification gate. Remote main remains `e169a9b`; do not pull main expecting the shared-buffer repair yet. Migration 011 and two actual `init_db()` / schema-readiness checks are required when deployment proceeds. Preserve all bindings, memberships and history.
- Live long-output order, host checkpoint, final Markdown artifact and refresh persistence are **NOT ACCEPTED**. Short Codex/OpenClaw responses and topic-based role recommendations previously succeeded, but the existing discussion stopped before host completion under the old runtime. A new bounded long-discussion test must follow backend deployment.

## SDK and classification repair; additional delivery findings (17:05 local time)

This section supersedes earlier receiver assumptions and acceptance claims below. Investigation history is retained, not treated as final success.

- The real private SDK envelope uses `senderId=system,targetId=system` (the conversation peer), not the receiving node. Bridge commit `625decb` consistently accepts this exact peer envelope or the legacy exact receiving-node envelope for assignments, host work, wire, cancellation and acknowledgements. Other senders/peers remain rejected. Real SDK normalization-to-router regressions pass; the coordinating agent ran **1,144/1,144 tests across 37 files**, TypeScript check and compilation. Independent review passed. The feature branch was pushed and the owned local bridge restarted at16:40:59 (PID23748, port56695), preserving bindings.
- Backend classification commit `e169a9b` was reviewed, merged and pushed to `main`. Existing creation records determine optional `conversationKind=discussion|chatroom`; no classification migration is required. SQLite and actual pg8000/PostgreSQL-wire checks passed 7/7; full main verification passed **894 tests, 28 skips**. The user controls source deployment.
- Web classification commit `1c379f7` was reviewed and pushed to `feat/chat-stream-stop`. Discussions have an independent tab, creation selects it, room listings exclude them, and missing metadata preserves known classification. Review corrections include complete pagination, invitation fallback, active-tab synchronization and five-column narrow layout. Root verification: **355/355 tests across 36 files**, TypeScript and production build passed, with existing dependency/build warnings. Original dirty main was not changed. Touched-source comments were also made provider-neutral.
- Fresh login and refresh recovered the account and discussion list. UI checks confirmed existing discussions under the discussion tab and absent from the chatroom tab. New room `rt_dde1f817849251718f3d7f7be069e4aa` (`讨论输出验收-0908-1655`, created16:53) automatically selected the discussion tab. OpenCode recommended two appropriate roles; Codex and OpenClaw each returned a complete short contribution, and the discussion reached host summarization. This is short-contribution success, not final-discussion success.
- Existing long-output room `rt_c6d5a70768ca56b59b5fa9ed994faa68` has visibly interleaved partial text and a streaming indicator even after refresh. Source/reproduction found process-local wire assembly in a documented multi-worker backend, discarded producer delta sequence, and a late-delta/terminal transaction race. Web projection independently permits a late delta to overwrite completed-message finality.
- Host summarization has another hard envelope mismatch: backend sends `hostPrompt/configVersion`, but the bridge's strict host parser omits them. The host prompt also lacks action schemas/context, and backend summary requests omit current participant contributions. These require further contract repairs; the new discussion remains in summarization, not completed.
- The user explicitly approved PostgreSQL shared buffering and sequence validation with additive buffer tables. A separate delivery-repair plan is now executing in the three isolated repositories with TDD and independent review. No account, device, membership or historical message was reset. Long output, host checkpoint and final Markdown artifact remain **NOT ACCEPTED** until these changes are deployed and retested.

## Deployment retest update (15:09 local time)

This section supersedes the earlier deployment gate and live status below; those sections retain the investigation history.

- Backend commits `dbd29b2` and `1ef17ab` were fast-forwarded and pushed to `main` (`1ef17abf5ebcf351204967ef31f5dc8e7611c538`). The user reported updating and restarting the source deployment. The latter commit repairs the nullable-owner PostgreSQL parameter typing with `IS NOT DISTINCT FROM`; actual project-driver PostgreSQL tests passed 8 cases, and the full backend run passed 888 tests with 27 separately explained skips.
- Local bridge restart at 14:45:12 succeeded (PID 26348, port 61645), without a fresh capability-sync failure. A freshly loaded admin page confirmed `opencode_372291` online, reserved/unbound to an ordinary user, and advertising `discussion_role_auto_assignment`.
- Web recommendation now returns topic-specific roles and automatic device assignments. The first result assigned a historical offline test node as a third participant. Removing that role in the wizard caused `INVALID_ROUNDTABLE_REQUEST`: the frontend permits adding/removing roles, but the backend requires the exact recommended role-ID set. No binding or server record was changed to bypass this constraint.
- Two subsequent two-role recommendations failed strict output validation. Read-only inspection of the corresponding local OpenCode task records found an explanatory prefix in one response and a Markdown JSON fence in the other. No parser bypass was used. With explicit plain-JSON instructions in the test goal, the next recommendation succeeded with two roles: fact-checking/architecture on Codex and risk/testing on OpenClaw.
- Web model-directory requests for Codex and OpenClaw timed out. Source tracing found that the actual SDK message ingress discarded non-system catalog responses before the pending request registry could receive them. A bounded frontend fix and SDK-entry regression tests are being verified separately. The creation test used the explicit node-default-model option; it does not establish model-selection acceptance.
- Discussion creation PASSED for `rt_b336ffa0477c5225913ba51ab046d87a` (display name `讨论验收-20260908`), with human `1473896952`, host `opencode_372291`, and participants `codex_2436795` and `openclaw_1952105045`. The Web UI and freshly loaded admin room listing both confirm the resource and four members.
- Conversation is NOT PASSING yet. The one-round discussion started at 15:04, emitted start/round/task events, then remained at its first Codex task with no contribution. Local dedup metadata recorded admission within 6 ms, with no corresponding new conversation-session activity. Request-contract investigation is ongoing; do not describe creation success as conversation success.

## Follow-up fixes and verification (15:33 local time)

- The bridge's V2 task receiver compared the logical `chatroomId` with the IM envelope destination. Actual server requests arrive as private messages from `system` to the node, so that comparison rejected valid assignments. The corrected private path requires the system sender and the exact receiving node; room delivery retains its room-address check. Assignment-target and host-role validation remain in place.
- Private discussion session storage is now scoped to the discussion ID, separate from the actual reply destination. Different discussions do not resume each other's agent context; same-discussion continuation remains supported. Replies still go to `system`. Artifact acknowledgements validate both their transport identity and the active logical room before consuming the pending acknowledgement.
- Bridge regression tests exercise private direct/framed assignments, host turns, wrong senders and targets, room delivery, separate/same-discussion sessions, and private acknowledgements. Coordinating-agent full run: **1,128 tests passed across 37 files**; TypeScript check and production compilation passed.
- The Web directory fix now admits catalog traffic only for a sender with an outstanding directory request. Node directory fragments use their own bounded reassembler, separate from authoritative system events. Pending sender and login generation are checked again before asynchronous reassembly commits. Normal node-origin messages cannot forge system discussion events or artifacts.
- An independent review found the first version's shared fragment-capacity issue; it was corrected before commit. The full frontend run after that correction passed **344 tests across 35 files**. TypeScript and Vite production build passed, with existing dependency/directive/sourcemap/chunk-size warnings. The isolated worktree uses the existing `CLAWMESSENGER_DISCUSSION_WIRE_CONTRACT` and `CLAWMESSENGER_SYSTEM_HOST_CONTRACT` overrides to locate the sibling backend fixtures.
- Before the additional fragment-isolation correction, real Codex and OpenClaw directory requests both completed and displayed the node-default-model controls instead of a timeout. Current bridge catalogs are empty, so this verifies response delivery, not selectable-model discovery or model switching. Final-build live revalidation still requires restored Web login.
- Reopening the existing discussion also displayed `Internal Server Error` during synchronization, with only partial UI state. No server traceback is available yet; this is a separate unverified recovery failure, not proof of lost members or records. The final frontend reload did not restore login, and the user has been asked to sign in again. No account, binding, role, or history reset was performed.
- The subsequent independent bridge review blocked integration on three additional private-transport gaps: shared fragment capacity, queue keys still using the physical private conversation, and cancel validation not checking the receiving node/logical room before consuming guard state. These are being repaired with regressions; the 1,128-test result above is not final integration approval.
- Read-only backend recovery investigation found no confirmed SQL/serialization defect. An exception from first-use `ensure_discussion_runtime_ready()` / `resume_active()` can propagate as HTTP 500; this is a candidate path, not an established cause. Continue with the exact failed URL/status/response and matching server traceback before changing backend behavior. The backend remains unchanged at `1ef17ab`.
- Final Web review accepted the pending-sender and fragment-isolation correction with no blocking findings. A fresh coordinating-agent run passed 344/344 tests at 15:39, followed by TypeScript and production build success. The six-file fix was committed and pushed as `65d4d7c` on `feat/chat-stream-stop`; the original dirty Web `main` checkout was not modified.
- The original Web tab still retains its authenticated in-memory four-member discussion at event 3, allowing existing-discussion conversation testing after the bridge repair. The separate final-build tab remains signed out; final-build UI acceptance remains separate and incomplete.

## Bridge integration verification (16:00 local time)

- Correct system-to-current-node private fragments now use a separate bounded reassembler. Cancellation and binding disposal clear both pools. A regression first reproduced 64 unrelated partials blocking a valid private assignment, then passed after isolation.
- Validated private V2 work uses discussion-scoped queue and session keys. Different discussions can progress concurrently, while work in the same discussion remains serialized. Physical message admission and response destinations remain unchanged.
- Cancellation validates transport, receiver, sender ID bounds, and the known logical room before consuming cancellation state. Queued/prestart tasks use room-scoped local cancellation records; matching active work still uses the existing guard to cancel tasks and pending artifact acknowledgements.
- Review caught an intermediate cancellation-expiry regression. The added expiry was removed: local cancellation records retain the original bounded FIFO, non-expiring semantics so a cancelled queued task cannot become runnable merely by waiting beyond the logical replay TTL.
- Final coordinating-agent verification at 16:00: **1,138/1,138 tests passed across 37 files**, including 161 router tests. TypeScript check, production compilation, and diff whitespace checks passed. Independent final review and post-restart live acceptance are recorded below when available; this automated result alone does not establish discussion conversation success.
- Independent final bridge review accepted the repair with no Critical/Important findings. The owned bridge was stopped and started through its CLI, reaching `ready` at 16:03:09 (PID 25464, port 49325), with no fresh capability-sync warning. No account binding reset or shared gateway shutdown was performed.
- A freshly reloaded admin page confirmed `opencode_372291` still online, enabled as the system host, unbound to ordinary users, and retaining the required discussion capabilities.
- The original Web tab's “结束并生成纪要” action briefly disabled its button but produced no observed new discussion event or artifact; it remained at event 3. Browser error logs were empty. This does not establish that the server action succeeded or that host work reached the repaired bridge. No repeated action, account reset, or duplicate group was used to force progression.
- Live acceptance remains incomplete: sign in to the final-build Web tab to revalidate against fresh authoritative state, and obtain the corresponding server traceback for the earlier recovery HTTP 500. The user was asked for sanitized error logs around 15:15–15:30. Role-output strict-format instability and the add/remove-role contract mismatch recorded above are also not resolved by these transport fixes.


## Scope

Repair role recommendation compatibility, synchronize existing node capabilities without changing ownership or history, and retest the real discussion workflow with local OpenCode as system host. No remote backend deployment or account/binding reset is included.

## Reproduced failures

- The configured system host was already enabled and online: `opencode_372291` (小久 · OpenCode), display name 主持人, timeout 60 seconds.
- Admin recommendation audit record 23 reported `ROLE_RECOMMENDATION_TIMEOUT` on 2026-09-08. The browser's 30-second default request limit showed a generic network failure first.
- Web discussion creation stopped at role recommendation with a generic operation-failed notice. No discussion was created by that failed attempt.
- The compiled bridge accepted the candidate-based server fixture but rejected the same valid admin payload without `candidates`.
- The wire reassembly allowlist omitted role recommendation requests.
- Installed bindings with valid IM credentials did not refresh capability declarations at startup; the host's server record lacked `discussion_role_auto_assignment` although the current registration client advertised it.

## Implemented changes

- Preserve strict candidate assignment validation while supporting role-only requests and responses. Role-only output contains no invented node/model assignment.
- Dispatch reassembled recommendation requests through the existing system-sender and binding-generation checks.
- Map the eight known discussion response/frame payloads from the internal reply type to wire `objectName=command`, which the backend callback actually consumes. Other message carriers are unchanged.
- Synchronize capabilities through authenticated refresh of the same node/server at startup. Do not implicitly register a node on another server.
- Admin: request-specific bounded timeout based on saved configuration, plus 5 seconds of transport allowance; distinguish known server/client timeout from network failure without displaying arbitrary backend details.
- The existing credential is now passed to same-server refresh through the Bearer header only. Cross-server registration does not receive that credential.
- Backend: reserved-node refresh requires the exact canonical identity and stored token before request validation, upstream calls, or writes. Unknown/invalid identities receive the same generic 404.
- Backend: a single compare-and-swap transaction updates only token and explicitly supplied capabilities, checking canonical/internal IDs, old token, reservation, and unchanged owner. Name, ownership, membership, and history are not rewritten. Failed upstream responses never partially commit capabilities.
- Admin: recommendation requests opt into page-owned error notices, preventing the generic Axios interceptor from displaying upstream message/detail text. Normal authentication refresh/retry/logout remains enabled.

## Verification evidence

- Protocol/router baseline: 163 tests passed.
- New protocol/router regression tests: 4 expected failures before implementation; 169 passed after the fix and additional sender-authorization checks.
- Admin independent rerun: 41 unit/component tests, 4 backend-contract checks, 4 release-lock checks passed; production build passed with the existing large-chunk warning.
- Capability synchronization passed independent identity-boundary review and an integrated 1,111-test rerun.
- Real retest exposed a second protocol boundary: replies used `objectName=command_result`, whereas the server's discussion handler only accepts `command`. Eight new SDK-boundary tests failed before the carrier fix; the complete bridge then passed 1,119 tests and the production TypeScript build.
- Bearer propagation regression: one expected failure before implementation; 101 binding/registration tests and a fresh complete 1,119-test bridge run passed, with TypeScript check/build passing.
- Admin interceptor regressions: three expected failures reproduced unsafe HTTP/envelope toasts and duplicate network notices. After repair, 45 tests, 8 contract/release checks, and production build passed. The existing large-chunk warning remains.
- Backend: 145 targeted tests passed, 1 deployment-workspace check skipped. New SQLite-backed route tests execute the actual UPDATE with only PostgreSQL placeholder/JSON-cast adaptation; they cover persisted identity/history, omitted capabilities, invalid request shape, upstream failure, and four concurrent identity changes. They do not replace live PostgreSQL deployment verification.
- Complete backend run: 884 passed, 19 skipped, 16 existing Python 3.12 SQLite-adapter deprecation warnings (209.87 seconds). The four additional request-shape cases were added after this run collected tests and passed in the subsequent 145-test targeted run. Skips are 18 PostgreSQL integration tests without `TEST_POSTGRES_DSN` and one unavailable deployment-workspace check. The original broken virtual environment was not changed; checks used bundled Python 3.12 with temporary pytest dependencies.
- Independent review accepted the client credential boundary, the admin timeout/error handling (after repairing the global toast finding), and the backend authenticated CAS flow. No blocking findings remain. Backend tests were rerun by the coordinating agent; the reviewer performed a source review, not an additional Python run.

## Preservation checkpoints before service restart

- OpenCode node: `opencode_372291`.
- Codex node: `codex_2436795`.
- OpenClaw node: `openclaw_1952105045`.
- All three bindings enabled.
- Local sessions file SHA-256: `5AF995B74FCE1A0ECF2E809EEFF68734F6402E1056CA4200E46368A404FFA15A`.

## Real retest status

- First repaired service start: PID 17736, port 63078; all three node IDs remained unchanged. Existing local session records remained (9 records); the sessions file hash changed during stop/start, so byte-for-byte preservation is not claimed.
- Codex and OpenClaw capability refresh succeeded. OpenCode refresh returned `token_refresh_failed`, and the service retained its old credential.
- Backend source explains this refusal: `claw_refresh_token` returns HTTP 404 for every `is_system_reserved` node before capability updates. Registration also refuses reserved nodes. Simply removing the guard is unsafe because this refresh route does not authenticate the submitted node credential.
- Admin audit 24 (13:18:23 local time) still reported `ROLE_RECOMMENDATION_TIMEOUT`. A reply from OpenCode to system was archived as a generic message (message `im:537835`), prompting the wire-carrier investigation above.
- Second repaired service start after carrier correction: PID 20548, port 54926.
- Admin real recommendation PASSED: recommendation `d88b51c7-860a-5d2f-b288-e2945bae26fa` returned three complementary topic-specific roles: 需求与事实核验员, 同步架构师, 验收与风险审查员. Each included an actionable prompt covering MVP scope, offline/multi-device synchronization, or acceptance/risk analysis.
- Web real retry remains blocked at recommendation with the generic operation-failed notice. The host still lacks `discussion_role_auto_assignment`; server source explicitly requires it for the Web recommendation flow. No bypass of that check was attempted.
- Discussion creation and group conversation remain UNVERIFIED, not passing.

## Backend implementation and remaining deployment gate

The approved authenticated same-node refresh path is implemented in the backend worktree `clawmessenger-server-worktrees/fix-system-host-refresh`, branch `fix/system-host-refresh`, based on `1f5b81c`. It does not remove the reserved-node isolation guard, trust enrollment headers, or change ownership. No schema migration or binding reset is needed. The existing ordinary-node refresh behavior is retained; a broader legacy authentication migration is outside this repair.

The remote test backend remains source-deployed by the user and has not been updated by this task. After the backend branch is deployed using the existing process configuration, restart the owned local bridge through its CLI, verify `opencode_372291` now declares `discussion_role_auto_assignment`, then repeat Web recommendation, creation, and actual discussion conversation. Do not treat local test success or the earlier admin recommendation success as completion of this live acceptance gate.

Local implementation is retained in the existing isolated bridge worktree (`feat/chat-stream-stop`), the separate admin worktree (`codex/fix-role-recommendation-timeout`), and the backend worktree above. User edits in the original checkouts are preserved. Commit/push status is recorded separately at handoff; deployment must select the backend feature branch, not assume that pulling unchanged `main` includes it.
