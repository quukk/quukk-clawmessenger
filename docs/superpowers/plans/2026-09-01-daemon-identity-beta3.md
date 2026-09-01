# Daemon Identity beta.3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a public clean installation create its missing daemon identity directory and complete the normal CLI service lifecycle.

**Architecture:** Keep `DaemonIdentityStore` responsible for its own persistence directory. Before the first exclusive identity write, create and validate only the direct storage directory, then retain the existing `wx` identity-file claim and recovery machinery unchanged. Release the immutable fix as the coordinated seven-package `0.1.0-beta.3` set.

**Tech Stack:** TypeScript, Node.js file APIs, Vitest, pnpm 10, GitHub Actions, npm registry.

**Spec:** `docs/superpowers/specs/2026-09-01-daemon-identity-first-start-design.md`

## Global Constraints

- The regression test must use the real filesystem and start with the `run` parent absent.
- The identity file remains an exclusive `wx` write with mode `0o600`.
- The storage directory must be a non-symbolic-link directory and use mode `0o700` on Unix.
- The entry package and all six runtime packages use the exact version `0.1.0-beta.3`.
- Publishing uses the existing `beta` tag and the already approved `--provenance=false` override.

---

### Task 1: Protect first-start identity claiming

**Files:**
- Modify: `packages/quukk-clawmessenger/src/process/service-identity.test.ts`
- Modify: `packages/quukk-clawmessenger/src/process/service-identity.ts`

**Interfaces:**
- Consumes: `new DaemonIdentityStore({ filePath }).claim(startingIdentity)`
- Produces: the existing `Promise<boolean>` claim contract, now valid when `dirname(filePath)` does not exist

- [ ] **Step 1: Write the failing regression test**

  Create a temporary home, derive `localPaths(home).daemonPid` without creating its parent, call `claim(starting())`, and assert it resolves `true`, persists the exact identity, and leaves a real parent directory.

- [ ] **Step 2: Verify RED**

  Run `pnpm --filter quukk-clawmessenger exec vitest run src/process/service-identity.test.ts -t "creates its missing storage directory before the first claim"` and confirm it fails with `identity_write_failed` because `open(..., 'wx')` sees `ENOENT`.

- [ ] **Step 3: Implement the minimal directory initialization**

  Add a private directory-initialization step used by `claim()` immediately before `#writeExclusive`: create the directory recursively with mode `0o700`, reject a non-directory or symbolic link using `lstat`, and harden the directory to `0o700` on Unix. Normalize all failures to `identity_write_failed`; do not change identity-file claim or recovery logic.

- [ ] **Step 4: Verify GREEN and regression coverage**

  Re-run the focused test, then the complete `service-identity.test.ts` suite, package typecheck, and the full entry-package test suite.

### Task 2: Prepare the coordinated beta.3 package set

**Files:**
- Modify: `packages/quukk-clawmessenger/package.json`
- Modify: `packages/quukk-clawmessenger-runtime-win32-x64/package.json`
- Modify: `packages/quukk-clawmessenger-runtime-win32-arm64/package.json`
- Modify: `packages/quukk-clawmessenger-runtime-darwin-x64/package.json`
- Modify: `packages/quukk-clawmessenger-runtime-darwin-arm64/package.json`
- Modify: `packages/quukk-clawmessenger-runtime-linux-x64/package.json`
- Modify: `packages/quukk-clawmessenger-runtime-linux-arm64/package.json`
- Modify: `scripts/clawmessenger-runtime.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: seven-package release workflow and entry optional-dependency equality checks
- Produces: seven exact `0.1.0-beta.3` packages with entry optional dependencies pinned to the six beta.3 runtimes

- [ ] **Step 1: Change all release coordinates to beta.3**

  Update the seven package versions, all six entry optional dependency versions, the runtime release contract version, and the lockfile importer specifiers.

- [ ] **Step 2: Verify release contracts and tarball contents**

  Run the runtime/workflow contract tests, build and typecheck the entry package and Bridge UI, pack the entry tarball, and audit the tarball file list and optional dependency versions.

### Task 3: Review, merge, and produce release artifacts

**Files:** No additional production files.

**Interfaces:**
- Consumes: the verified beta.3 branch
- Produces: a merged pull request and successful main-branch seven-artifact workflow run

- [ ] **Step 1: Run final local verification and diff checks**

  Run targeted and full tests, typechecks, release contracts, `git diff --check`, and inspect the complete branch diff.

- [ ] **Step 2: Commit, push, open a pull request, and review**

  Commit the bounded fix, push `codex/fix-daemon-identity-beta3`, open a pull request, perform an independent code review, and address any actionable findings.

- [ ] **Step 3: Wait for required CI and merge**

  Require all repository checks to pass, merge the pull request, and wait for the resulting main-branch runtime workflow to finish all build jobs.

### Task 4: Publish and prove the public beta.3 lifecycle

**Files:** No repository changes.

**Interfaces:**
- Consumes: seven attested workflow artifacts and the authorized npm token
- Produces: seven public beta.3 registry versions and a verified local service lifecycle

- [ ] **Step 1: Audit and publish all seven artifacts**

  Download the main-branch artifacts, verify hashes, package names, versions, runtime manifests, source commit, and entry optional dependencies; publish the six runtimes first and entry last with `--access public --tag beta --provenance=false`.

- [ ] **Step 2: Verify the anonymous registry view**

  Without credentials, confirm every exact package version and each `beta` dist-tag resolves to `0.1.0-beta.3`.

- [ ] **Step 3: Perform a clean public install and lifecycle test**

  Install into a new temporary directory and use a new empty profile. Verify binary resolution, `start --json --no-open`, `status --json`, ready `doctor --json`, `logs --json`, `stop --json`, and final offline `doctor --json`.

