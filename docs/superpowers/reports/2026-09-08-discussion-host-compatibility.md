# Discussion host compatibility acceptance — 2026-09-08

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
