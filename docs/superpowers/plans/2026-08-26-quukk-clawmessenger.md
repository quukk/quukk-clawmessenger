# Quukk ClawMessenger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. In the current session, `superpowers:subagent-driven-development` may be used with the same RED/GREEN/review checkpoints.

**Goal:** Ship one npm package, `quukk-clawmessenger`, that detects local OpenCode, OpenClaw, Codex, and Hermes installations, lets the user choose which runtimes to connect, assigns one independent RongCloud identity to each selected runtime, and preserves the existing ClawMessenger message behaviors.

**Architecture:** Keep the Multica fork and its Go runtime adapters as the execution layer. Add a loopback-only Go Bridge API, a Node.js control plane with one RongCloud child process per selected runtime, and a small React/Vite local UI. The default npm path remains independent of PostgreSQL, Docker, and the hosted Multica server. The separate ClawMessenger registration service receives the minimal Hermes node-type compatibility change.

**Tech stack:** Go 1.26.6, Node.js 22+, TypeScript 5.9, pnpm, React 19, Vite, Vitest, Testing Library, Zod, `@rongcloud/imlib-next` 5.36.6, Node built-ins for CLI/process/config/HTTP, GitHub Actions, npm optional platform packages.

**Spec:** `docs/superpowers/specs/2026-08-26-quukk-clawmessenger-fork-design.md`

## Global constraints

- Work in the Multica fork at `D:\A-DM\dm-im\quukk-clawmessenger` on `codex/quukk-clawmessenger`. Keep `upstream` read-only.
- Work in `D:\A-DM\dm-im\clawmessenger-server` only for the isolated Hermes registration compatibility change. Do not copy server code into the fork.
- Preserve the complete upstream `LICENSE`, `NOTICE`, Git history, Multica product/Logo/copyright areas, and add prominent modification and third-party notices to every release artifact.
- Do not copy source from `opencode-clawmessenger` until its missing distributable license notice is resolved. Codex/OpenClaw bridges may be adapted with their MIT notices retained.
- Default tests must inject fake runtimes and fake transports. They must never execute a locally installed agent CLI or connect to production RongCloud.
- The main Node process must never import the RongCloud SDK or its browser polyfill. Each enabled runtime owns one child process and one SDK singleton.
- Tokens, prompts, browser tickets, bearer secrets, and inherited environment dumps must never be logged or sent in child argv/env.
- A runtime is `ready` when its executable and version probe work. `needs_auth` is only learned from a confirmed task authentication failure.
- Runtime capability `approval_events` is `false` in v1. Existing headless adapters keep their current internal permission behavior; the UI must disclose it.
- Node owns authorized working-directory roots and provider session IDs. Go only receives a canonical existing directory and optional `resume_session_id`.
- On this workstation, direct all temporary/cache/toolchain writes to `D:` because `C:` has no free space:

  ```powershell
  $env:TEMP = 'D:\A-DM\dm-im\.task-tmp'
  $env:TMP = $env:TEMP
  $env:npm_config_cache = 'D:\A-DM\dm-im\.npm-cache'
  $pnpm = 'C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd'
  ```

- Use `0.1.0-beta.1` for the first fully verified prerelease. Recheck registry availability immediately before publishing.
- Do not run `npm publish` until all release gates pass and the npm identity, 2FA path, version, and tag are confirmed at the release checkpoint.

---

## Task 1: Lock fork governance and workspace scaffolding

**Files:**

- Modify: `docs/superpowers/specs/2026-08-26-quukk-clawmessenger-fork-design.md`
- Create: `MODIFICATIONS.md`
- Create: `THIRD_PARTY_NOTICES.md`
- Create: `packages/quukk-clawmessenger/package.json`
- Create: `packages/quukk-clawmessenger/tsconfig.json`
- Create: `packages/quukk-clawmessenger/vitest.config.ts`
- Create: `packages/quukk-clawmessenger/src/index.ts`
- Create: `packages/quukk-clawmessenger/src/version.ts`
- Create: `packages/quukk-clawmessenger/src/version.test.ts`
- Create: `packages/quukk-clawmessenger/bin/quukk-clawmessenger.js`
- Create: `apps/bridge/package.json`
- Create: `apps/bridge/tsconfig.json`
- Create: `apps/bridge/vite.config.ts`
- Create: `apps/bridge/index.html`
- Modify: `.gitignore`

**Step 1: Create the failing package metadata test**

`src/version.test.ts` must assert one source of truth and the public name:

```ts
import { describe, expect, it } from 'vitest';
import packageJson from '../package.json' with { type: 'json' };
import { PACKAGE_NAME, VERSION } from './version.js';

describe('release identity', () => {
  it('uses the Quukk package name and one version', () => {
    expect(PACKAGE_NAME).toBe('quukk-clawmessenger');
    expect(VERSION).toBe(packageJson.version);
  });
});
```

**Step 2: Run the focused test and observe RED**

```powershell
& $pnpm --dir packages/quukk-clawmessenger exec vitest run src/version.test.ts
```

Expected: failure because the package and exported constants do not exist yet.

**Step 3: Add the minimal publishable skeleton**

Use an ESM package with Node 22, a single bin, explicit `files`, and no runtime dependency until its owning task:

```json
{
  "name": "quukk-clawmessenger",
  "version": "0.1.0-beta.1",
  "description": "Connect local AI agents to ClawMessenger, built on Multica",
  "type": "module",
  "engines": { "node": ">=22" },
  "bin": { "quukk-clawmessenger": "bin/quukk-clawmessenger.js" },
  "files": ["bin", "dist", "LICENSE", "NOTICE", "MODIFICATIONS.md", "THIRD_PARTY_NOTICES.md", "README.md"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "license": "SEE LICENSE IN LICENSE",
  "devDependencies": {
    "@multica/tsconfig": "workspace:*",
    "@types/node": "catalog:",
    "typescript": "catalog:",
    "vitest": "catalog:"
  }
}
```

The bin imports `../dist/cli.js`; it must not contain business logic. Copy the root license documents into the tarball during Task 14, rather than maintaining divergent text copies in source control.

`MODIFICATIONS.md` records the fork baseline `54027ba763fa7da0699b2fe89df4a6b2c13d1c6f`, branch, Bridge additions, and every modified upstream file. `THIRD_PARTY_NOTICES.md` records Multica, Codex ClawMessenger, OpenClaw ClawMessenger, RongCloud SDK metadata, and source URLs without resolving the RongCloud license discrepancy by assumption.

**Step 4: Add the private UI workspace shell**

Name the app `@quukk/clawmessenger-bridge-ui`, set `private: true`, add `build`, `typecheck`, and `test` scripts plus catalog-pinned React/Vite/Vitest/Testing Library dependencies, and configure Vite output to `../../packages/quukk-clawmessenger/dist/ui`. Do not add UI implementation yet.

**Step 5: Run GREEN and workspace checks**

```powershell
& $pnpm install --store-dir 'D:\A-DM\dm-im\.pnpm-store'
& $pnpm --dir packages/quukk-clawmessenger test
& $pnpm --dir packages/quukk-clawmessenger typecheck
git diff --check
```

Expected: focused test and typecheck pass; lockfile includes only the skeleton tooling changes.

**Step 6: Commit**

```powershell
git add docs/superpowers/specs/2026-08-26-quukk-clawmessenger-fork-design.md MODIFICATIONS.md THIRD_PARTY_NOTICES.md packages/quukk-clawmessenger apps/bridge .gitignore pnpm-lock.yaml
git commit -m "chore: scaffold Quukk ClawMessenger workspaces"
```

---

## Task 2: Add Hermes identity support to the ClawMessenger registration service

**Files in `D:\A-DM\dm-im\clawmessenger-server`:**

- Modify: `id_generator.py:11`
- Modify: `tests/test_ai_node_ids.py`

**Step 1: Inspect and protect unrelated work**

```powershell
git status --short
git diff -- id_generator.py tests/test_ai_node_ids.py
```

If either file already has user changes, preserve them and patch only the Hermes assertions.

**Step 2: Add failing tests**

Extend the existing ID cases with:

```python
self.assertTrue(is_ai_node_id("hermes_123"))
self.assertEqual(get_ai_node_type("hermes_123"), "hermes")
self.assertEqual(ensure_ai_node_id("123", "hermes"), "hermes_123")
```

Add `test_registration_accepts_and_reuses_hermes_identity` that registers the same MAC and `node_type="hermes"` twice and asserts the same `hermes_` node ID is returned with a non-empty token.

**Step 3: Run RED**

```powershell
python -m unittest tests.test_ai_node_ids -v
```

Expected: Hermes is rejected as an unsupported AI node type.

**Step 4: Make the one-line production change**

Add `"hermes"` to `AI_NODE_TYPES`. Do not modify the database schema or registration route; those already derive behavior from the tuple.

**Step 5: Run GREEN and regression tests**

```powershell
python -m unittest tests.test_ai_node_ids -v
python -m pytest -q tests/test_ai_node_ids.py tests/test_server_regressions.py
python -m pytest -q
```

**Step 6: Commit in the server repository**

```powershell
git add id_generator.py tests/test_ai_node_ids.py
git commit -m "feat: register Hermes AI node identities"
```

Record the resulting server commit and required deployment ordering in the fork's `MODIFICATIONS.md` without copying server code.

**Step 7: Commit the cross-repository dependency record in the fork**

```powershell
Set-Location D:\A-DM\dm-im\quukk-clawmessenger
git add MODIFICATIONS.md
git commit -m "docs: record Hermes registration prerequisite"
```

---

## Task 3: Harden version probes and implement Bridge runtime discovery

**Files:**

- Modify: `server/pkg/agent/launch.go`
- Modify: `server/pkg/agent/agent_test.go`
- Create: `server/internal/daemon/bridge.go`
- Create: `server/internal/daemon/bridge_runtime.go`
- Create: `server/internal/daemon/bridge_runtime_test.go`
- Modify: `MODIFICATIONS.md`

**Step 1: Install a portable official Go toolchain on `D:`**

Download the official Go 1.26.6 archive for Windows amd64 from `go.dev/dl`, verify its published SHA-256, and extract to `D:\A-DM\dm-im\.toolchains\go1.26.6`. Set only the current process path:

```powershell
$env:Path = 'D:\A-DM\dm-im\.toolchains\go1.26.6\go\bin;' + $env:Path
go version
```

Do not install system-wide or commit the toolchain.

**Step 2: Add RED tests for bounded version output**

In `agent_test.go`, inject a fake executable that writes more than the chosen 64 KiB cap and assert `DetectVersion` returns a classified output-limit error without retaining the entire output.

```powershell
go test ./pkg/agent -run 'TestDetectVersion.*Output' -count=1
```

Expected: failure because `launch.go` currently buffers without a size cap.

**Step 3: Apply the minimal global probe cap**

Use a small bounded writer in `launch.go`; preserve the existing timeout/process ownership behavior and redact output from returned errors.

**Step 4: Add RED runtime discovery tests**

`bridge_runtime_test.go` must cover:

- Only `opencode`, `openclaw`, `codex`, and `hermes` are returned.
- Stable ID equality and path-change matrix.
- Precedence: absolute user override, process PATH, cached login-shell PATH, then Codex macOS app bundle.
- `ready`, `found_not_runnable`, `not_found`, and `probe_failed` classifications.
- Prior ready path remains sticky across a transient probe failure; missing pinned path triggers rediscovery.
- Four-provider probing has bounded concurrency and timeout.
- Runtime capabilities always report `approval_events: false`; OpenClaw reports final-text-only capability.

Use only injected functions; no test may call installed CLIs.

```powershell
go test ./internal/daemon -run '^TestBridgeRuntime' -count=1
```

Expected: compile failure because Bridge runtime types do not exist.

**Step 5: Implement the runtime contracts**

Use these public JSON contracts:

```go
type BridgeRuntimeStatus string

const (
    BridgeRuntimeReady       BridgeRuntimeStatus = "ready"
    BridgeRuntimeNeedsAuth   BridgeRuntimeStatus = "needs_auth"
    BridgeRuntimeNotRunnable BridgeRuntimeStatus = "found_not_runnable"
    BridgeRuntimeNotFound    BridgeRuntimeStatus = "not_found"
    BridgeRuntimeProbeFailed BridgeRuntimeStatus = "probe_failed"
)

type BridgeRuntimeCapabilities struct {
    SessionResume  bool `json:"session_resume"`
    Cancel         bool `json:"cancel"`
    TextEvents     bool `json:"text_events"`
    ToolEvents     bool `json:"tool_events"`
    ApprovalEvents bool `json:"approval_events"`
}
```

Create runtime IDs as `rt_` plus the first 16 bytes of SHA-256 over `installID + NUL + provider + NUL + canonicalExecutablePath`. `not_found` has no runtime ID.

Reuse `probeAgentCLIs`, `resolveAgentExecutablePath`, `agent.DetectVersion`, and `agent.CheckMinVersion` behind `bridgeDeps`. Do not broaden the exported surface of existing daemon helpers.

**Step 6: Run GREEN and regression tests**

```powershell
go test ./pkg/agent -count=1
go test ./internal/daemon -run '^TestBridgeRuntime' -count=1
go test ./internal/daemon -run 'Agent.*Probe|CanonicalPath' -count=1
```

**Step 7: Commit**

```powershell
git add server/pkg/agent/launch.go server/pkg/agent/agent_test.go server/internal/daemon/bridge.go server/internal/daemon/bridge_runtime.go server/internal/daemon/bridge_runtime_test.go MODIFICATIONS.md
git commit -m "feat: detect local Bridge runtimes"
```

---

## Task 4: Implement Go Bridge task lifecycle and replayable events

**Files:**

- Create: `server/internal/daemon/bridge_task.go`
- Create: `server/internal/daemon/bridge_task_test.go`

**Step 1: Add RED task tests**

Cover exact `agent.Config` and `agent.ExecOptions`, event mapping, session propagation, bounded tool output, sensitive input redaction, fresh-session retry, cancellation, per-conversation serialization, subscriber disconnect, ring replay, overflow status, and terminal retention.

The request and event contracts are:

```go
type BridgeTaskRequest struct {
    RuntimeID       string `json:"runtime_id"`
    ConversationKey string `json:"conversation_key"`
    ResumeSessionID string `json:"resume_session_id,omitempty"`
    WorkDir         string `json:"workdir"`
    Prompt          string `json:"prompt"`
}

type BridgeTaskEvent struct {
    ID        uint64          `json:"id"`
    Type      BridgeEventType `json:"type"`
    TaskID    string          `json:"task_id"`
    Time      time.Time       `json:"time"`
    SessionID string          `json:"session_id,omitempty"`
    Text      string          `json:"text,omitempty"`
    Tool      string          `json:"tool,omitempty"`
    CallID    string          `json:"call_id,omitempty"`
    Output    string          `json:"output,omitempty"`
    Status    string          `json:"status,omitempty"`
    Error     *BridgeError    `json:"error,omitempty"`
}
```

```powershell
go test ./internal/daemon -run '^TestBridgeTask' -count=1
```

Expected: compile failure.

**Step 2: Implement the minimal task manager**

- Resolve the backend with `agent.ResolveBackend` in production and an injected fake in tests.
- Derive task contexts from the Bridge root, never from POST/SSE request contexts.
- Pass `OpenclawMode: "local"`, canonical workdir, timeout, and optional resume session.
- Reuse `shouldRetryWithFreshSession`; retry at most once and never after a tool event, authentication/network failure, a fresh task, or a second failure. When a resumed task chooses the fresh retry, every authoritative terminal event carries `status: "resume_invalidated"` so Node can compare-and-swap clear the submitted session before applying a replacement.
- Emit only `started`, `text_delta`, `tool_started`, `tool_finished`, `status`, `completed`, `failed`, and `cancelled`.
- Keep a bounded ring per task and a bounded terminal TTL. Cancellation reaches the adapter context and emits exactly one terminal event after cleanup.

**Step 3: Run GREEN, race checks, and package regressions**

```powershell
go test ./internal/daemon -run '^TestBridgeTask' -count=1
go test -race ./internal/daemon -run '^TestBridgeTask' -count=1
go test ./pkg/agent -count=1
```

If the local Windows Go toolchain does not support `-race`, record that precise limitation and require the CI race job before release; do not treat an unrun race test as passing.

**Step 4: Commit**

```powershell
git add server/internal/daemon/bridge_task.go server/internal/daemon/bridge_task_test.go
git commit -m "feat: execute and replay Bridge tasks"
```

---

## Task 5: Expose the authenticated Go Bridge HTTP/SSE command

**Files:**

- Create: `server/internal/daemon/bridge_http.go`
- Create: `server/internal/daemon/bridge_http_test.go`
- Create: `server/cmd/multica/cmd_bridge.go`
- Create: `server/cmd/multica/cmd_bridge_test.go`
- Modify: `MODIFICATIONS.md`

**Step 1: Add RED HTTP tests**

Test the global loopback-before-bearer boundary, wrong methods, strict task JSON and body limits, unknown runtime/task, invalid workdir, exact health/readiness schemas, SSE replay with `Last-Event-ID`, overflow, heartbeat/flush/terminal closure, subscriber-only disconnect, and graceful shutdown. Assert health never includes secrets, prompts, environment values, install identity, paths, or bearer material.

```powershell
go test ./internal/daemon -run '^TestBridgeHTTP' -count=1
```

**Step 2: Implement the handler**

Expose:

- `GET /v1/runtimes`
- `POST /v1/runtimes/refresh`
- `POST /v1/tasks`
- `GET /v1/tasks/{id}/events`
- `POST /v1/tasks/{id}/cancel`
- `GET /healthz`
- `POST /shutdown`

Require `Authorization: Bearer …` for every route, including unknown routes. Reject non-loopback peers before authentication; compare SHA-256 digests of the received and expected authorization headers with `subtle.ConstantTimeCompare`. Apply `http.MaxBytesReader`, use `DisallowUnknownFields`, set `Cache-Control: no-store`, and set no CORS headers. SSE replays strictly after the supplied event ID, flushes headers/events and `: heartbeat\n\n` comments, and closes after a terminal event. Use read/header/idle server timeouts but no global `WriteTimeout`, because SSE is long-lived.

**Step 3: Add RED command tests**

Test bounded strict startup JSON from stdin, missing secret/install ID/version, version mismatch, unsupported provider keys and `pinned_runtime_paths`, fixed `tcp4 127.0.0.1:0` listener arguments, and exactly one readiness line after binding and initial refresh. Inject a fake serving function so command tests do not scan the machine.

Startup input:

```json
{"secret":"...","install_id":"...","version":"0.1.0-beta.1","provider_path_overrides":{}}
```

Readiness output:

```json
{"address":"127.0.0.1:49152","pid":1234,"version":"0.1.0-beta.1","instance_id":"br_0123456789abcdef0123456789abcdef","started_at":"2026-08-26T08:00:00Z"}
```

```powershell
go test ./cmd/multica -run '^TestBridgeCommand' -count=1
```

**Step 4: Implement hidden `multica daemon bridge`**

Register from the new file's `init` hook, bind `tcp4` to `127.0.0.1:0`, receive the secret only over at-most-64-KiB stdin, and require the supplied version to equal the compiled binary version. Perform one initial runtime refresh and print readiness only after successful bind and refresh. Readiness and authenticated health both carry the same `pid`, version, `instance_id`, and `started_at` values for supervisor fencing. `POST /shutdown` flushes `202` before asynchronously cancelling the Bridge root so Windows can stop gracefully. Do not attach to `Daemon.Run` or modify its existing health server.

**Step 5: Run GREEN and full Go verification**

```powershell
go test ./internal/daemon -run '^TestBridge' -count=1
go test ./cmd/multica -run '^TestBridge' -count=1
go test ./pkg/agent -count=1
go test ./...
```

**Step 6: Commit**

```powershell
git add server/internal/daemon/bridge_http.go server/internal/daemon/bridge_http_test.go server/cmd/multica/cmd_bridge.go server/cmd/multica/cmd_bridge_test.go MODIFICATIONS.md
git commit -m "feat: expose loopback Bridge API"
```

---

## Task 6: Build atomic local state, registration, and runtime bindings

**Files:**

- Create: `packages/quukk-clawmessenger/src/config/schema.ts`
- Create: `packages/quukk-clawmessenger/src/config/paths.ts`
- Create: `packages/quukk-clawmessenger/src/config/atomic-json.ts`
- Create: `packages/quukk-clawmessenger/src/config/store.ts`
- Create: `packages/quukk-clawmessenger/src/config/store.test.ts`
- Create: `packages/quukk-clawmessenger/src/registration/capabilities.ts`
- Create: `packages/quukk-clawmessenger/src/registration/client.ts`
- Create: `packages/quukk-clawmessenger/src/registration/client.test.ts`
- Create: `packages/quukk-clawmessenger/src/bindings/service.ts`
- Create: `packages/quukk-clawmessenger/src/bindings/service.test.ts`
- Modify: `packages/quukk-clawmessenger/package.json`
- Modify: `pnpm-lock.yaml`

**Step 1: Add RED state tests**

Test config precedence, the exact `~/.quukk-clawmessenger` path matrix, bounded reads, atomic replacement and failure windows, malformed-config quarantine, fail-closed state/credential corruption, Unix mode requests, redaction, stable install ID and Bridge secret, credentials-first token-reference swaps, restart reconciliation, and empty authorized roots that deny every work directory. Sessions and deduplication remain Task 10 work.

```powershell
& $pnpm --dir packages/quukk-clawmessenger exec vitest run src/config/store.test.ts
```

**Step 2: Implement schemas and atomic stores**

Add `zod` and model:

```ts
export type RuntimeBinding = {
  runtimeId: string;
  runtimePath: string;
  provider: 'opencode' | 'openclaw' | 'codex' | 'hermes';
  enabled: boolean;
  nodeId?: string;
  nodeName: string;
  tokenRef?: string;
  registrationState: 'unregistered' | 'registering' | 'online' | 'offline' | 'error';
  lastErrorCode?: string;
  updatedAt: string;
};
```

Persist three strict versioned documents: non-secret `config.json` (`serverUrl`, nullable `defaultWorkdir`, fail-closed `authorizedWorkRoots`, provider path overrides, log level), identity/binding `state.json`, and protected `credentials.json`. Credentials contain a stable random per-install `bridgeSecret` plus token records keyed by opaque references; no token or bearer is written into config/state. Implement bounded reads, same-directory temp-file write, file sync, atomic rename, directory sync where supported, `0600` files, and `0700` directories. Windows relies on the current user's profile ACL and must not invoke shell ACL commands or delete-before-rename.

**Step 3: Add RED registration tests**

Use a fake `fetch` to assert `GET /api/config/rongcloud`, four provider-specific `POST /api/ai/register` requests, and `POST /api/claw/refresh-token/{nodeId}`. Cover idempotent reuse of an existing node ID, partial success, exactly one retry for transient failures, no retry for validation/auth failures, strict response checks for business code, prefix, node type, non-empty token, AppKey, and this exact ordered capability tuple: `discussion_host`, `discussion_participant`, `artifact_markdown`, `artifact_html`, `discussion_roundtable`, `discussion_model_routing`.

```powershell
& $pnpm --dir packages/quukk-clawmessenger exec vitest run src/registration/client.test.ts src/bindings/service.test.ts
```

**Step 4: Implement registration and binding service**

Use `os.networkInterfaces()` to derive the existing service's MAC registration value; derive an injected stable, locally administered unicast fallback from the install ID when no hardware MAC is usable. Registration occurs only from an explicit `enableSelected(runtimeIds)` call whose IDs are resolved against one fresh trusted Go runtime snapshot; UI input never controls provider, path, node type, name, MAC, or capabilities. Permit at most one binding per provider. Write a new credential first, atomically switch the binding's `tokenRef` second, and remove the old credential last; persist each success independently. Disabling preserves identity/credential, explicit unregister removes them only locally, and refresh failure preserves the old credential.

**Step 5: Run GREEN**

```powershell
& $pnpm --dir packages/quukk-clawmessenger test
& $pnpm --dir packages/quukk-clawmessenger typecheck
```

**Step 6: Commit**

```powershell
git add packages/quukk-clawmessenger
git commit -m "feat: persist runtime bindings and identities"
```

---

## Task 7: Supervise the Go binary and implement its typed client

**Files:**

- Create: `packages/quukk-clawmessenger/src/go/types.ts`
- Create: `packages/quukk-clawmessenger/src/go/sse.ts`
- Create: `packages/quukk-clawmessenger/src/go/client.ts`
- Create: `packages/quukk-clawmessenger/src/go/client.test.ts`
- Create: `packages/quukk-clawmessenger/src/go/binary.ts`
- Create: `packages/quukk-clawmessenger/src/go/binary.test.ts`
- Create: `packages/quukk-clawmessenger/src/process/identity.ts`
- Create: `packages/quukk-clawmessenger/src/process/supervisor.ts`
- Create: `packages/quukk-clawmessenger/src/process/supervisor.test.ts`

**Step 1: Add RED client tests**

Test bearer injection, zod validation, HTTP error classification, incremental SSE parsing across chunk boundaries, `Last-Event-ID`, replay/overflow/reconnect, cancellation, graceful authenticated shutdown, propagation of returned session IDs, and transparent `resume_invalidated` terminals. The test server binds loopback only.

```powershell
& $pnpm --dir packages/quukk-clawmessenger exec vitest run src/go/client.test.ts
```

**Step 2: Implement the typed client with Node built-ins**

Use global `fetch`, `TextDecoder`, and an async-generator SSE parser. Do not add an HTTP or EventSource dependency.

```ts
export interface BridgeTaskPort {
  startTask(input: {
    runtimeId: string;
    conversationKey: string;
    prompt: string;
    workdir: string;
    resumeSessionId?: string;
  }): Promise<{ taskId: string; eventsUrl: string }>;
  events(taskId: string, afterEventId?: number): AsyncIterable<BridgeTaskEvent>;
  cancelTask(taskId: string): Promise<void>;
}
```

**Step 3: Add RED binary/supervisor tests**

Test exact platform package mapping, manifest version/hash validation, absence of network fallback, startup JSON over stdin, one readiness line, secret absence from argv/env, PID + `started_at` + instance-ID fencing against authenticated health, graceful stop, crash recovery, and refusal to kill an unverified process.

```powershell
& $pnpm --dir packages/quukk-clawmessenger exec vitest run src/go/binary.test.ts src/process/supervisor.test.ts
```

**Step 4: Implement minimal supervision**

Use `child_process.spawn(binary, ['daemon', 'bridge'], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] })`. Send startup data through stdin and close it. Bound readiness output and startup time. Persist only non-secret process identity metadata.

**Step 5: Run GREEN**

```powershell
& $pnpm --dir packages/quukk-clawmessenger test
& $pnpm --dir packages/quukk-clawmessenger typecheck
```

**Step 6: Commit**

```powershell
git add packages/quukk-clawmessenger/src/go packages/quukk-clawmessenger/src/process
git commit -m "feat: supervise the Multica Bridge daemon"
```

---

## Task 8: Extract the shared ClawMessenger protocol and CardKit compatibility

**Files:**

- Create: `packages/quukk-clawmessenger/src/protocol/messages.ts`
- Create: `packages/quukk-clawmessenger/src/protocol/messages.test.ts`
- Create: `packages/quukk-clawmessenger/src/protocol/discussion-v1.ts`
- Create: `packages/quukk-clawmessenger/src/protocol/discussion-v1.test.ts`
- Create: `packages/quukk-clawmessenger/src/protocol/discussion-v2.ts`
- Create: `packages/quukk-clawmessenger/src/protocol/discussion-v2.test.ts`
- Create: `packages/quukk-clawmessenger/src/protocol/discussion-wire.ts`
- Create: `packages/quukk-clawmessenger/src/protocol/discussion-wire.test.ts`
- Create: `packages/quukk-clawmessenger/src/protocol/fixtures/*`
- Create: `packages/quukk-clawmessenger/src/cardkit/schema.ts`
- Create: `packages/quukk-clawmessenger/src/cardkit/builders.ts`
- Create: `packages/quukk-clawmessenger/src/cardkit/validate.ts`
- Create: `packages/quukk-clawmessenger/src/cardkit/parse-marker.ts`
- Create: `packages/quukk-clawmessenger/src/cardkit/templates.ts`
- Create: `packages/quukk-clawmessenger/src/cardkit/action-router.ts`
- Create: `packages/quukk-clawmessenger/src/cardkit/cardkit.test.ts`
- Modify: `THIRD_PARTY_NOTICES.md`

**Step 1: Port compatibility fixtures and write RED parsers first**

Cover plain/nested content, camel/snake aliases, unknown types, size bounds, discussion v1 duplicate/turn/timeout rules, discussion v2 validation/replay/cancellation, canonical Base64, 9,000-byte frames, 8 MiB ceiling, CardKit sanitization, streaming markers, action validation, and a complete result card in `command_result`.

```powershell
& $pnpm --dir packages/quukk-clawmessenger exec vitest run src/protocol src/cardkit
```

Expected: compile failures because implementations are absent.

**Step 2: Implement the smallest provider-neutral protocol**

Preserve these external wire names even though the bridge is multi-provider:

- `create_opencode_session`, `opencode_session_created`, `delete_opencode_session`
- `/new`, `/session`, `/sessions`, `/switch`, `/delete`, `/status`, `/stop`
- `device_status_request/report`, `device_control/result`, `command_result`
- `chatroom_invite`, `chatroom_message`
- discussion v1/v2 messages and wire chunks
- `card_message`, `card_update`, `card_action`

For a permission CardKit action, return a deterministic `unsupported_interactive_approval` result. Do not expose a fake allow/deny operation.

Derive only from the MIT Codex/OpenClaw implementations, preserve their notices, and document file-level provenance. Treat OpenCode code as behavior-only until its license gap is fixed.

**Step 3: Run GREEN and fixture compatibility**

```powershell
& $pnpm --dir packages/quukk-clawmessenger exec vitest run src/protocol src/cardkit
& $pnpm --dir packages/quukk-clawmessenger typecheck
```

**Step 4: Commit**

```powershell
git add packages/quukk-clawmessenger/src/protocol packages/quukk-clawmessenger/src/cardkit THIRD_PARTY_NOTICES.md
git commit -m "feat: unify ClawMessenger wire protocols"
```

---

## Task 9: Isolate RongCloud identities in child workers

**Files:**

- Create: `packages/quukk-clawmessenger/src/rongcloud/worker-protocol.ts`
- Create: `packages/quukk-clawmessenger/src/rongcloud/worker-protocol.test.ts`
- Create: `packages/quukk-clawmessenger/src/rongcloud/env-polyfill.ts`
- Create: `packages/quukk-clawmessenger/src/rongcloud/client.ts`
- Create: `packages/quukk-clawmessenger/src/rongcloud/client.test.ts`
- Create: `packages/quukk-clawmessenger/src/rongcloud/worker-entry.ts`
- Create: `packages/quukk-clawmessenger/src/rongcloud/worker-supervisor.ts`
- Create: `packages/quukk-clawmessenger/src/rongcloud/worker-supervisor.test.ts`
- Create: `packages/quukk-clawmessenger/src/rongcloud/worker.integration.test.ts`
- Modify: `packages/quukk-clawmessenger/package.json`
- Modify: `THIRD_PARTY_NOTICES.md`

**Step 1: Add pinned dependencies and RED protocol tests**

Pin `@rongcloud/imlib-next` to `5.36.6`; add `fake-indexeddb`, `jsdom`, and `ws` only for the worker/polyfill boundary. Validate IPC with zod and assert tokens can never occur in worker events or serialized errors.

```ts
type WorkerInit = {
  type: 'init';
  binding: { runtimeId: string; nodeId: string; appKey: string; storageDir: string };
  token: string;
};

type WorkerEvent =
  | { type: 'ready'; runtimeId: string; instanceId: string }
  | { type: 'connection'; runtimeId: string; instanceId: string; state: 'connecting' | 'online' | 'offline' | 'auth_error' }
  | { type: 'message'; runtimeId: string; instanceId: string; message: NormalizedRongCloudMessage }
  | { type: 'result'; runtimeId: string; instanceId: string; requestId: string; ok: boolean; messageUid?: string; errorCode?: string };
```

**Step 2: Write RED single-identity client tests**

With an injected SDK facade, assert exact custom registrations:

```ts
[
  ['command', false, false],
  ['command_result', false, false],
  ['card_message', true, true],
  ['card_update', true, true],
  ['card_action', false, false],
  ['chatroom_invite', true, false],
]
```

Also cover one token refresh, one shared 5 messages/sec queue, lifecycle generation fencing, V5→V2→V1 receipt fallback, chatroom join, and disconnect cancellation.

**Step 3: Implement worker-only SDK loading**

`worker-entry.ts` must install polyfills before dynamically importing `@rongcloud/imlib-next`. Spawn it with an explicit minimal environment allowlist (platform-required process variables and no application credentials), while sending the RongCloud token only through the post-spawn IPC handshake. The main-package import graph test must prove `src/index.ts`, CLI, router, and HTTP service cannot reach SDK/polyfill modules.

**Step 4: Write RED supervisor/isolation tests**

Assert four enabled bindings create four child PIDs, tokens are absent from argv/env, one crash restarts only its own binding with bounded backoff, stale generation events are ignored, and one disconnect does not cancel another worker or a Go task.

**Step 5: Implement and run GREEN**

```powershell
& $pnpm --dir packages/quukk-clawmessenger exec vitest run src/rongcloud
& $pnpm --dir packages/quukk-clawmessenger typecheck
```

**Step 6: Commit**

```powershell
git add packages/quukk-clawmessenger/src/rongcloud packages/quukk-clawmessenger/package.json pnpm-lock.yaml THIRD_PARTY_NOTICES.md
git commit -m "feat: isolate RongCloud runtime identities"
```

---

## Task 10: Route messages with per-binding sessions and deduplication

**Files:**

- Create: `packages/quukk-clawmessenger/src/router/conversation.ts`
- Create: `packages/quukk-clawmessenger/src/router/dedup.ts`
- Create: `packages/quukk-clawmessenger/src/router/session-store.ts`
- Create: `packages/quukk-clawmessenger/src/router/message-router.ts`
- Create: `packages/quukk-clawmessenger/src/router/message-router.test.ts`
- Create: `packages/quukk-clawmessenger/src/router/router.integration.test.ts`

**Step 1: Add RED isolation and behavior tests**

Test that the same sender/group/message UID across OpenCode and Codex never shares a dedup claim, session, task, cancellation, or response. Cover all plain chat, media context, session, command, device, chatroom, discussion, and CardKit routes.

Admission order must be asserted explicitly:

1. Validate and size-bound input.
2. Claim `(runtimeId, messageUid)` dedup.
3. Start the Go task.
4. Persist the returned session ID from task events. On `resume_invalidated`, compare-and-swap clear only the originally submitted resume ID before applying any new non-empty authoritative session ID.
5. Only after successful task creation, send receipt and “processing” feedback.

```powershell
& $pnpm --dir packages/quukk-clawmessenger exec vitest run src/router/message-router.test.ts
```

**Step 2: Implement scoped stores and router**

Use a canonical tuple encoding that includes binding identity and cannot collide when an identifier contains punctuation:

```ts
const conversationKey = JSON.stringify([runtimeId, nodeId, conversationType, targetId, senderId]);
```

Persist bounded dedup claims and sessions atomically. A claim has `claimed` then `admitted` state: release it when task creation fails before admission, but retain it after admission so redelivery cannot start a second task. `/new` clears only the current binding/conversation. `/stop` cancels only the active task for that key. Authentication-shaped task failures update only that runtime to `needs_auth`.

**Step 3: Map Bridge events to RongCloud output**

Coalesce text deltas with a bounded flush interval; always flush terminal content. OpenClaw final-only events use the same completed path. Buffer only bounded coarse/terminal output while a worker reconnects.

**Step 4: Run GREEN**

```powershell
& $pnpm --dir packages/quukk-clawmessenger exec vitest run src/router
& $pnpm --dir packages/quukk-clawmessenger test
& $pnpm --dir packages/quukk-clawmessenger typecheck
```

**Step 5: Commit**

```powershell
git add packages/quukk-clawmessenger/src/router
git commit -m "feat: route isolated runtime conversations"
```

---

## Task 11: Add the secure local API, CLI, and install behavior

**Files:**

- Create: `packages/quukk-clawmessenger/src/http/tickets.ts`
- Create: `packages/quukk-clawmessenger/src/http/security.ts`
- Create: `packages/quukk-clawmessenger/src/http/routes.ts`
- Create: `packages/quukk-clawmessenger/src/http/server.ts`
- Create: `packages/quukk-clawmessenger/src/http/server.test.ts`
- Create: `packages/quukk-clawmessenger/src/service.ts`
- Create: `packages/quukk-clawmessenger/src/cli.ts`
- Create: `packages/quukk-clawmessenger/src/cli.test.ts`
- Create: `packages/quukk-clawmessenger/scripts/postinstall.mjs`
- Create: `packages/quukk-clawmessenger/scripts/postinstall.test.ts`
- Create: `packages/quukk-clawmessenger/src/logging/logger.ts`
- Create: `packages/quukk-clawmessenger/src/logging/redact.test.ts`
- Modify: `packages/quukk-clawmessenger/package.json`

**Step 1: Add RED browser/API security tests**

Test loopback binding, Host allowlist, strict Origin checks for state changes, one-use/short-lived launch ticket, HttpOnly + SameSite=Strict cookie, CSRF token, CSP, no token-bearing URL after ticket exchange, body bounds, and no secret fields in diagnostics.

Expose only the UI needs:

- `POST /api/session/exchange`
- `GET /api/runtimes`
- `POST /api/runtimes/rescan`
- `POST /api/bindings/enable`
- `POST /api/bindings/{runtimeId}/disable`
- `POST /api/bindings/{runtimeId}/reregister`
- `GET /api/activity`
- `GET /api/diagnostics`
- `GET /api/settings`
- `PUT /api/settings`

**Step 2: Implement the local service**

Use `node:http`, `crypto`, `URL`, and zod. Do not add Express/Fastify. Bind to random loopback port, serve the built UI from `dist/ui`, and inject dependencies for tests.

**Step 3: Add RED CLI tests**

Test `setup`, `start`, `stop`, `status`, `logs`, `doctor`, and `rescan`; JSON output; no-open behavior; already-running behavior; stale PID safety; and correct exit codes. Use `util.parseArgs`, not Commander.

**Step 4: Implement CLI and postinstall gating**

`postinstall` may asynchronously open setup only when all are true: global install, interactive desktop, not CI, and `QUUKK_CLAWMESSENGER_NO_OPEN != 1`. It must never register identities, wait for input, or fail npm installation. In every other branch print `quukk-clawmessenger setup`.

**Step 5: Run GREEN**

```powershell
& $pnpm --dir packages/quukk-clawmessenger exec vitest run src/http src/cli.test.ts scripts/postinstall.test.ts src/logging
& $pnpm --dir packages/quukk-clawmessenger test
& $pnpm --dir packages/quukk-clawmessenger typecheck
```

**Step 6: Commit**

```powershell
git add packages/quukk-clawmessenger
git commit -m "feat: add local service and CLI"
```

---

## Task 12: Build the Multica-branded runtime selection UI

**Files:**

- Create: `apps/bridge/src/main.tsx`
- Create: `apps/bridge/src/app.tsx`
- Create: `apps/bridge/src/api.ts`
- Create: `apps/bridge/src/types.ts`
- Create: `apps/bridge/src/styles.css`
- Create: `apps/bridge/src/components/brand.tsx`
- Create: `apps/bridge/src/components/runtime-card.tsx`
- Create: `apps/bridge/src/components/status-pill.tsx`
- Create: `apps/bridge/src/pages/setup.tsx`
- Create: `apps/bridge/src/pages/runtimes.tsx`
- Create: `apps/bridge/src/pages/activity.tsx`
- Create: `apps/bridge/src/pages/diagnostics.tsx`
- Create: `apps/bridge/src/pages/settings.tsx`
- Create: `apps/bridge/src/app.test.tsx`
- Create: `apps/bridge/src/setup.test.tsx`
- Modify: `apps/bridge/package.json`

**Step 1: Run the frontend pre-flight and write RED flow tests**

Use the `design-taste-frontend` skill before visual implementation. Test:

- OpenCode + OpenClaw detected while Codex + Hermes absent.
- All `ready` runtimes selected by default.
- Individual selection and “select all”.
- No registration request before the explicit submit click.
- Independent progress and partial registration failure.
- `probe_failed`, `found_not_runnable`, and post-task `needs_auth` guidance.
- Permission-policy disclosure before registration.
- Explicit authorization of at least one real working-directory root and a default work directory before the bridge is described as task-ready.
- Rescan, disable, reregister, activity, diagnostics, and settings flows.
- Multica name/attribution and adjacent Quukk ClawMessenger derivative label remain visible.

```powershell
& $pnpm --dir apps/bridge exec vitest run src/setup.test.tsx src/app.test.tsx
```

Expected: failures because UI files do not exist.

**Step 2: Implement the four-page interface**

Reuse focused exports from `@multica/ui` (`Button`, `Checkbox`, `Card`, `Badge`, `Dialog`) and Multica CSS tokens; do not import the full web app or server-dependent state. Use `runtimeDisplayLabel`/`runtimeDisplayName`/`runtimeRowLabel` rules for visible runtime names.

The setup sequence is Detect → Select → Register → Complete. Registration progress is per runtime and successful rows stay successful when another row fails.

**Step 3: Verify responsive and accessible behavior**

Run Testing Library accessibility checks for labels, focus order, keyboard selection, live status announcements, and error summaries. Check desktop and narrow mobile widths with Playwright screenshots; the UI is browser-based even though install automation only opens it on desktops.

**Step 4: Run GREEN and build into the npm package**

```powershell
& $pnpm --dir apps/bridge test
& $pnpm --dir apps/bridge typecheck
& $pnpm --dir apps/bridge build
Test-Path packages/quukk-clawmessenger/dist/ui/index.html
```

**Step 5: Commit**

```powershell
git add apps/bridge packages/quukk-clawmessenger/dist/ui MODIFICATIONS.md
git commit -m "feat: add local runtime selection UI"
```

If generated `dist/ui` is intentionally excluded from Git, omit it from the commit and make package build generate it deterministically before packing; document that decision in `MODIFICATIONS.md`.

---

## Task 13: Create platform runtime packages and reproducible binary builds

**Files:**

- Create: `packages/quukk-clawmessenger-runtime-win32-x64/package.json`
- Create: `packages/quukk-clawmessenger-runtime-win32-arm64/package.json`
- Create: `packages/quukk-clawmessenger-runtime-darwin-x64/package.json`
- Create: `packages/quukk-clawmessenger-runtime-darwin-arm64/package.json`
- Create: `packages/quukk-clawmessenger-runtime-linux-x64/package.json`
- Create: `packages/quukk-clawmessenger-runtime-linux-arm64/package.json`
- Create: `scripts/build-clawmessenger-runtime.mjs`
- Create: `scripts/verify-clawmessenger-runtime.mjs`
- Create: `scripts/clawmessenger-runtime.test.ts`
- Create: `.github/workflows/quukk-clawmessenger-runtime.yml`
- Modify: `packages/quukk-clawmessenger/package.json`

**Step 1: Add RED package-selection and manifest tests**

Assert exact mapping for six `process.platform/process.arch` pairs, clear failure for unsupported platforms, version equality, SHA-256 verification, executable filename, and no postinstall download fallback.

**Step 2: Define platform packages**

Each package contains only `package.json`, the platform binary, `manifest.json`, full `LICENSE`, `NOTICE`, `MODIFICATIONS.md`, and source attribution. Set npm `os` and `cpu` fields. Add all six at exact matching version under the entry package's `optionalDependencies`.

The build script writes the manifest from measured inputs rather than editable constants:

```js
const manifest = {
  version: packageJson.version,
  goVersion: readGoVersion(goBinary),
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sha256: await sha256File(outputBinary),
  binary: process.platform === 'win32' ? 'multica.exe' : 'multica',
};
```

The verifier rejects an invalid full Git object ID, an unrecognized Go version, or a digest that does not match the packaged binary.

**Step 3: Implement reproducible cross-build scripts**

Build `./cmd/multica` with `CGO_ENABLED=0`, `-trimpath`, and version/source flags already supported by Multica. CI matrix covers Windows/darwin/Linux x64/arm64. Upload tarballs and provenance; publishing remains a separate protected job.

**Step 4: Run local package checks**

```powershell
& $pnpm exec vitest run scripts/clawmessenger-runtime.test.ts
node scripts/build-clawmessenger-runtime.mjs --platform win32 --arch x64
node scripts/verify-clawmessenger-runtime.mjs packages/quukk-clawmessenger-runtime-win32-x64
```

**Step 5: Commit**

```powershell
git add packages/quukk-clawmessenger-runtime-* packages/quukk-clawmessenger/package.json scripts .github/workflows/quukk-clawmessenger-runtime.yml pnpm-lock.yaml
git commit -m "build: package Bridge runtimes by platform"
```

---

## Task 14: Add end-to-end tests, migration, docs, and artifact audits

**Files:**

- Create: `packages/quukk-clawmessenger/src/migration/discover.ts`
- Create: `packages/quukk-clawmessenger/src/migration/import.ts`
- Create: `packages/quukk-clawmessenger/src/migration/import.test.ts`
- Create: `packages/quukk-clawmessenger/test/e2e/fake-runtime.ts`
- Create: `packages/quukk-clawmessenger/test/e2e/fake-registration.ts`
- Create: `packages/quukk-clawmessenger/test/e2e/fake-rongcloud-worker.ts`
- Create: `packages/quukk-clawmessenger/test/e2e/setup.test.ts`
- Create: `packages/quukk-clawmessenger/test/e2e/message-routing.test.ts`
- Create: `packages/quukk-clawmessenger/test/e2e/restart.test.ts`
- Create: `packages/quukk-clawmessenger/README.md`
- Create: `packages/quukk-clawmessenger/scripts/prepare-package.mjs`
- Create: `packages/quukk-clawmessenger/scripts/audit-tarball.mjs`
- Modify: `README.md`
- Modify: `MODIFICATIONS.md`
- Modify: `THIRD_PARTY_NOTICES.md`

**Step 1: Add RED migration tests**

Detect existing OpenCode/Codex/OpenClaw config files without moving or deleting them. Show importable non-secret settings, require explicit confirmation, and write only new Quukk files after validation. A failed import leaves legacy files untouched.

**Step 2: Add fake end-to-end tests**

Exercise the actual Node service and Go Bridge HTTP boundary with fake runtime backends and fake RongCloud child workers:

- OpenCode and OpenClaw appear in UI, user selects one or both.
- Four selected providers produce four distinct node types/tokens/workers.
- Same conversation across providers stays isolated.
- Session IDs survive restart.
- One worker crash or registration failure does not affect others.
- Cancel, reconnect, dedup, CardKit unsupported approval, diagnostics redaction, and graceful stop.

No production network calls and no installed agent execution are allowed.

**Step 3: Write user and operator docs**

Document install, `setup --no-open`, every CLI command, four provider login prerequisites, internal headless permission policy, config locations, migration, diagnostics, uninstall, server Hermes deployment prerequisite, supported platform matrix, and “Built on Multica” attribution. Do not claim commercial hosting rights.

**Step 4: Prepare and audit tarballs**

`prepare-package.mjs` copies the exact root `LICENSE`, `NOTICE`, `MODIFICATIONS.md`, and `THIRD_PARTY_NOTICES.md` into the entry and platform staging directories. `audit-tarball.mjs` opens `npm pack --json` output and fails unless required legal files, README, bin, UI assets, worker entry, and manifest are present; it also rejects source maps containing tokens/absolute developer paths and rejects unexpected files.

**Step 5: Run complete local verification**

```powershell
go test ./...
& $pnpm test
& $pnpm typecheck
& $pnpm lint
& $pnpm --dir packages/quukk-clawmessenger build
& $pnpm --dir apps/bridge build
npm pack --dry-run --json packages/quukk-clawmessenger
node packages/quukk-clawmessenger/scripts/audit-tarball.mjs
git diff --check
git status --short
```

Capture exact failures; do not weaken a test merely to reach green.

**Step 6: Request correctness and simplicity reviews**

Use `superpowers:requesting-code-review` for spec/correctness/security review and `ponytail-review` for over-engineering review. Fix verified findings with new RED tests, rerun affected suites, then rerun the complete verification above.

**Step 7: Commit**

```powershell
git add README.md MODIFICATIONS.md THIRD_PARTY_NOTICES.md packages/quukk-clawmessenger
git commit -m "test: verify Quukk ClawMessenger end to end"
```

---

## Task 15: Verify clean-install matrix and stage the npm prerelease

**Files:**

- Modify only files required by verified release findings.
- Create release artifacts under an ignored, explicit directory such as `D:\A-DM\dm-im\.release-artifacts\quukk-clawmessenger\0.1.0-beta.1`.

**Step 1: Recheck external release preconditions**

Use the official npm registry to confirm `quukk-clawmessenger` and all six platform package names remain available. Verify current Multica license/NOTICE requirements against the retained upstream files and resolve the RongCloud 5.36.6 package-metadata versus bundled-license discrepancy before publishing.

**Step 2: Build from a clean commit**

Require `git status --short` to be empty. Record fork commit, server Hermes commit, Go version, Node version, pnpm version, and every binary SHA-256. Build each platform in CI from that commit.

**Step 3: Run the install matrix from tarballs**

For Windows x64/arm64, macOS x64/arm64, and Linux glibc x64/arm64, install the platform tarball and entry tarball in a clean disposable workspace, then run:

```text
quukk-clawmessenger setup --no-open
quukk-clawmessenger doctor --json
quukk-clawmessenger rescan --json
quukk-clawmessenger start --no-open
quukk-clawmessenger status --json
quukk-clawmessenger stop
```

Each job uses fake runtimes and a mock registration/RongCloud environment. Verify no install-time registration and no unexpected network download.

**Step 4: Apply the verification-before-completion gate**

Use `superpowers:verification-before-completion`. Confirm all Go, Node, UI, integration, race-capable CI, license, tarball, and install-matrix results from fresh output. A skipped required platform or unresolved license finding blocks release.

**Step 5: Confirm publish identity and immutable inputs**

Immediately before external mutation, confirm:

- npm account is the intended publisher and has 2FA available;
- exact version is `0.1.0-beta.1`;
- exact dist-tag is `next`;
- all seven package names and tarball hashes match the audited manifest;
- server Hermes support is deployed and verified;
- no package version has already been published.

**Step 6: Publish in dependency order after the release checkpoint**

Publish the six platform packages first with provenance and `--tag next`, verify each registry manifest, then publish `quukk-clawmessenger@0.1.0-beta.1`. If any platform publish fails, do not publish the entry package. Never reuse or overwrite a published version.

**Step 7: Post-publish smoke and completion record**

Install `quukk-clawmessenger@next` from the public registry on one supported clean host, repeat setup/doctor/start/status/stop with fake runtimes, verify legal files in the installed package, and record registry URLs, integrity hashes, source commit, and known limitations in the release notes. Stable promotion is a separate verified release action; do not retag automatically.

---

## Definition of done

- One user-facing npm install produces a local Multica-branded setup UI without Docker/PostgreSQL.
- OpenCode/OpenClaw/Codex/Hermes detection is accurate and side-effect-free under default tests.
- The user can choose one or all ready runtimes; registration happens only after explicit confirmation.
- Every selected provider has its own validated RongCloud identity, child process, sessions, dedup state, connection state, and failure boundary.
- Existing chat/session/command/device/discussion/CardKit compatibility tests pass, including deterministic unsupported interactive approval behavior.
- Restart restores selected identities and sessions; logs and diagnostics contain no secrets or prompts.
- Go, Node, UI, E2E, CI platform matrix, license audit, tarball audit, and clean-install smoke all pass from fresh output.
- The npm prerelease exists only after its server prerequisite and release checkpoint; its tarballs retain Multica and third-party legal/branding notices.
