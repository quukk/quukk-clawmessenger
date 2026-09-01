# Quukk seven-package beta release chain implementation plan

**Goal:** Make the entry package and six platform runtime packages one protected, opt-in beta release set while keeping ordinary pushes and credential-free runs publish-safe.

**Architecture:** Keep runtime cross-builds in the existing six-target matrix and add one independent entry-package build job. Both jobs produce immutable tarball artifacts; one guarded publish job downloads each artifact explicitly, validates the complete seven-package set, checks registry availability for every exact `name@version`, publishes all runtimes, and publishes the entry package last.

**Tech stack:** GitHub Actions YAML, pnpm, npm CLI, Node.js 22, Vitest/YAML contract tests.

---

## Task 1: Protect the release contract with focused tests

**Files:**

- Create: `scripts/clawmessenger-runtime-workflow.test.ts`
- Modify: `scripts/clawmessenger-runtime.test.ts`

1. Move the declarative workflow contract out of the runtime builder suite so it can run independently of platform-build module imports.
2. Assert the entry build step order: Bridge UI build, entry TypeScript build, Bridge license audit, package preparation, real dry-run pack, tarball audit, actual pack, attestation, upload.
3. Assert exactly seven explicit artifact downloads and a fail-closed validation/preflight/publish sequence.
4. Assert publication remains `workflow_dispatch`-only, defaults to `false`, requires a protected ref and protected environment, publishes six runtimes before the entry, and never exposes npm credentials to build jobs.
5. Run the focused workflow test and confirm it fails against the current workflow for the missing entry/release-set behavior.

## Task 2: Implement the protected seven-package workflow

**File:** `.github/workflows/quukk-clawmessenger-runtime.yml`

1. Add `build-entry` after contract tests, with sequential Bridge UI build then entry `tsc`, the pinned Bridge license audit, preparation, `npm pack --dry-run --json --ignore-scripts`, audit, actual tarball creation, attestation, and upload.
2. Keep six runtime matrix artifacts unique and unchanged.
3. Replace the runtime-only publish job with a serialized release-set job needing both build jobs, guarded by explicit dispatch opt-in, `github.ref_protected`, an allowed main/release-tag ref, and the existing protected npm environment.
4. Download all seven named artifacts into distinct directories; validate one tarball per directory, seven unique expected names, one exact shared version, and entry optional-dependency equality.
5. Preflight all seven exact npm versions fail-closed, then publish the six runtimes with `beta`/provenance and the entry last with `beta`/provenance.

## Task 3: Verify and commit

1. Run the focused workflow contract test.
2. Parse the YAML independently and run `git diff --check`.
3. Review the diff for credential scope, job guards, package ordering, and accidental main-worktree changes.
4. Commit atomically on `codex/quukk-seven-package-beta-release` and report the commit hash.
