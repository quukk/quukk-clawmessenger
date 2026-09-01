# Quukk Single-Entry Resumable Beta Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep `quukk-clawmessenger` as the only user-facing npm package while making the seven-package beta publication safe to rerun after partial success.

**Architecture:** Add one Node.js release planner that compares each local tarball with the exact npm registry version and emits `publish` or `skip` actions. The protected GitHub Actions job consumes that plan, publishes missing runtimes first, revalidates them, publishes the entry last, and verifies the complete set; documentation presents the runtime packages only as automatically selected implementation details.

**Tech Stack:** Node.js 22 ESM, TypeScript/Vitest, GitHub Actions YAML, npm CLI, pnpm.

**Spec:** `docs/superpowers/specs/2026-09-01-quukk-single-entry-resumable-beta-release-design.md`

## Global Constraints

- `quukk-clawmessenger` remains the only package users install, upgrade, invoke, and remove.
- Keep the six exact runtime package names and the Windows/macOS/Linux × x64/arm64 matrix unchanged.
- Keep all seven package versions exactly synchronized and preserve exact-version `optionalDependencies`.
- Publish only through the protected `npm-runtime-prerelease` GitHub environment after explicit `workflow_dispatch` opt-in on protected `main` or an exact release tag.
- Expose `NPM_TOKEN` only to publish-job steps and retain `--provenance` in GitHub Actions.
- Publish or verify all six runtimes before publishing the entry package.
- Existing npm versions may be skipped only when both SHA-1 and SHA-512 integrity match the locally built tarball; ambiguous or mismatched registry responses fail closed.
- Use Node.js 22.13 or newer for the entry package and release tooling.

---

### Task 1: Add a deterministic resumable release planner

**Files:**

- Create: `scripts/plan-clawmessenger-npm-release.mjs`
- Create: `scripts/plan-clawmessenger-npm-release.test.ts`

**Interfaces:**

- Consumes: tab-separated release manifest rows with `name` then `archive`, the release version file, npm registry `dist.shasum` and `dist.integrity`, and mode `preflight | runtimes | complete`.
- Produces: four tab-separated plan fields in the order `name`, `archive`, `role`, `action`, where role is `runtime | entry` and action is `publish | skip`; exports `compareDistribution(local, remote)` and `classifyReleaseSet(packages, mode)` for focused tests.

- [ ] **Step 1: Write failing tests for digest comparison and release states**

Create `scripts/plan-clawmessenger-npm-release.test.ts` with literal fixtures for one entry and six runtimes. Cover these observable behaviors:

```ts
// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  classifyReleaseSet,
  compareDistribution,
} from './plan-clawmessenger-npm-release.mjs';

const runtimeNames = [
  '@quukk/clawmessenger-runtime-win32-x64',
  '@quukk/clawmessenger-runtime-win32-arm64',
  '@quukk/clawmessenger-runtime-darwin-x64',
  '@quukk/clawmessenger-runtime-darwin-arm64',
  '@quukk/clawmessenger-runtime-linux-x64',
  '@quukk/clawmessenger-runtime-linux-arm64',
];

function release(state: 'missing' | 'matching') {
  return [
    ...runtimeNames.map((name) => ({ name, archive: `${name}.tgz`, role: 'runtime' as const, state })),
    { name: 'quukk-clawmessenger', archive: 'entry.tgz', role: 'entry' as const, state },
  ];
}

describe('npm distribution comparison', () => {
  it('accepts an existing tarball only when both registry digests match', () => {
    expect(compareDistribution(
      { shasum: 'a'.repeat(40), integrity: `sha512-${'YQ=='.repeat(1)}` },
      { shasum: 'a'.repeat(40), integrity: `sha512-${'YQ=='.repeat(1)}` },
    )).toBe('matching');
  });

  it('fails closed when either registry digest differs', () => {
    expect(() => compareDistribution(
      { shasum: 'a'.repeat(40), integrity: 'sha512-YQ==' },
      { shasum: 'b'.repeat(40), integrity: 'sha512-YQ==' },
    )).toThrowError('registry_content_mismatch');
  });
});

describe('resumable npm release classification', () => {
  it('publishes every package when all versions are missing', () => {
    expect(classifyReleaseSet(release('missing'), 'preflight').map((item) => item.action))
      .toEqual(Array(7).fill('publish'));
  });

  it('skips matching runtimes and publishes only missing packages', () => {
    const packages = release('missing');
    packages[0].state = 'matching';
    expect(classifyReleaseSet(packages, 'preflight')[0].action).toBe('skip');
  });

  it('rejects an existing entry when any runtime is missing', () => {
    const packages = release('matching');
    packages[0].state = 'missing';
    expect(() => classifyReleaseSet(packages, 'preflight'))
      .toThrowError('entry_without_complete_runtime_set');
  });

  it('requires all runtimes after runtime publication', () => {
    expect(() => classifyReleaseSet(release('missing'), 'runtimes'))
      .toThrowError('runtime_release_incomplete');
  });

  it('reports a complete matching release as a no-op', () => {
    expect(classifyReleaseSet(release('matching'), 'complete').every((item) => item.action === 'skip'))
      .toBe(true);
  });
});
```

- [ ] **Step 2: Run the planner tests and verify RED**

Run:

```bash
pnpm exec vitest run scripts/plan-clawmessenger-npm-release.test.ts
```

Expected: FAIL because `scripts/plan-clawmessenger-npm-release.mjs` does not exist.

- [ ] **Step 3: Implement the minimal planner and CLI**

Create `scripts/plan-clawmessenger-npm-release.mjs` with these exact public contracts:

```js
export function compareDistribution(local, remote) {
  if (local.shasum !== remote.shasum || local.integrity !== remote.integrity) {
    throw new Error('registry_content_mismatch');
  }
  return 'matching';
}

export function classifyReleaseSet(packages, mode = 'preflight') {
  const entry = packages.filter((item) => item.role === 'entry');
  const runtimes = packages.filter((item) => item.role === 'runtime');
  if (entry.length !== 1 || runtimes.length !== 6) throw new Error('invalid_release_set');
  if (entry[0].state === 'matching' && runtimes.some((item) => item.state !== 'matching')) {
    throw new Error('entry_without_complete_runtime_set');
  }
  if ((mode === 'runtimes' || mode === 'complete') && runtimes.some((item) => item.state !== 'matching')) {
    throw new Error('runtime_release_incomplete');
  }
  if (mode === 'complete' && entry[0].state !== 'matching') {
    throw new Error('entry_release_incomplete');
  }
  return packages.map((item) => ({
    ...item,
    action: item.state === 'matching' ? 'skip' : 'publish',
  }));
}
```

The CLI must:

1. Parse `--manifest`, `--version-file`, `--output`, and `--mode` without shell evaluation.
2. Reject duplicate names, non-files, roles other than the one exact entry plus six exact runtimes, and versions that are not valid semver.
3. Hash each tarball with SHA-1 and SHA-512.
4. Run `npm view "${name}@${version}" dist --json --registry=https://registry.npmjs.org` with `spawnSync(..., { shell: false })`.
5. Classify only an explicit npm `E404` as missing; malformed JSON, timeouts, and all other failures throw fixed redacted error codes.
6. Require both registry `shasum` and `integrity` to match the local tarball before returning `matching`.
7. Write the release plan atomically with four tab-separated fields in the order `name`, `archive`, `role`, `action`.

- [ ] **Step 4: Run the planner tests and verify GREEN**

Run:

```bash
pnpm exec vitest run scripts/plan-clawmessenger-npm-release.test.ts
```

Expected: all planner tests PASS with no warnings.

- [ ] **Step 5: Commit the planner**

```bash
git add scripts/plan-clawmessenger-npm-release.mjs scripts/plan-clawmessenger-npm-release.test.ts
git commit -m "feat(release): add resumable npm release planner"
```

### Task 2: Wire safe retry into the protected GitHub workflow

**Files:**

- Modify: `scripts/clawmessenger-runtime-workflow.test.ts`
- Modify: `.github/workflows/quukk-clawmessenger-runtime.yml`

**Interfaces:**

- Consumes: Task 1 CLI and the existing `.artifacts/release-set.tsv` plus `.artifacts/release-version.txt`.
- Produces: `.artifacts/release-plan.tsv` refreshed at preflight, after runtime publication, and after entry publication.

- [ ] **Step 1: Change the workflow contract test first**

Replace the single-use preflight assertions with required ordered steps:

```ts
const plan = requiredStep(publish, 'Plan resumable beta publication');
const publishRuntimes = requiredStep(publish, 'Publish missing runtime beta packages');
const verifyRuntimes = requiredStep(publish, 'Verify runtime beta packages');
const publishEntry = requiredStep(publish, 'Publish missing entry beta package');
const verifyComplete = requiredStep(publish, 'Verify complete beta release');

expect(plan.run).toContain('scripts/plan-clawmessenger-npm-release.mjs');
expect(plan.run).toContain('--mode preflight');
expect(publishRuntimes.run).toContain("[ \"$action\" = 'publish' ]");
expect(verifyRuntimes.run).toContain('--mode runtimes');
expect(publishEntry.run).toContain("[ \"$action\" = 'publish' ]");
expect(verifyComplete.run).toContain('--mode complete');
```

Keep the assertions for explicit protected dispatch, protected environment, seven unique artifact downloads, credential isolation, exact package validation, runtime-before-entry ordering, and `--provenance`.

- [ ] **Step 2: Run the workflow test and verify RED**

Run:

```bash
pnpm exec vitest run scripts/clawmessenger-runtime-workflow.test.ts
```

Expected: FAIL because the five resumable publication steps are absent.

- [ ] **Step 3: Replace fail-on-existing preflight with the planner**

In `.github/workflows/quukk-clawmessenger-runtime.yml`:

1. Replace `Preflight npm package versions` with `Plan resumable beta publication`, invoking Task 1 with `--mode preflight`.
2. Rename the runtime step to `Publish missing runtime beta packages`; read all four TSV fields, skip entry rows and `skip` actions, and publish only runtime rows marked `publish`.
3. Add `Verify runtime beta packages`, rerunning the planner with `--mode runtimes` so the registry must contain matching copies of all six runtimes.
4. Rename the entry step to `Publish missing entry beta package`; require exactly one entry row and publish it only when marked `publish`.
5. Add `Verify complete beta release`, rerunning the planner with `--mode complete`.
6. Keep `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` only on npm credential/planning/publish/verification steps and keep both publish commands on `--access public --tag beta --provenance`.

- [ ] **Step 4: Run planner and workflow tests and verify GREEN**

Run:

```bash
pnpm exec vitest run scripts/plan-clawmessenger-npm-release.test.ts scripts/clawmessenger-runtime-workflow.test.ts
```

Expected: both files PASS.

- [ ] **Step 5: Commit the workflow integration**

```bash
git add .github/workflows/quukk-clawmessenger-runtime.yml scripts/clawmessenger-runtime-workflow.test.ts
git commit -m "fix(release): resume partial npm beta publications"
```

### Task 3: Make the one-package user experience explicit

**Files:**

- Modify: `packages/quukk-clawmessenger/README.md`
- Create: `packages/quukk-clawmessenger-runtime-win32-x64/README.md`
- Create: `packages/quukk-clawmessenger-runtime-win32-arm64/README.md`
- Create: `packages/quukk-clawmessenger-runtime-darwin-x64/README.md`
- Create: `packages/quukk-clawmessenger-runtime-darwin-arm64/README.md`
- Create: `packages/quukk-clawmessenger-runtime-linux-x64/README.md`
- Create: `packages/quukk-clawmessenger-runtime-linux-arm64/README.md`
- Modify: all six runtime `package.json` files
- Modify: `packages/quukk-clawmessenger/scripts/audit-tarball.mjs`
- Modify: `scripts/verify-clawmessenger-runtime.mjs`
- Modify: `packages/quukk-clawmessenger/scripts/package-artifacts.test.ts`
- Modify: `scripts/clawmessenger-runtime.test.ts`

**Interfaces:**

- Consumes: the existing platform-package `files` allowlist and tarball audit/verification contracts.
- Produces: one main install instruction and six npm package pages that explicitly redirect users to `quukk-clawmessenger`.

- [ ] **Step 1: Make packaging tests require the runtime README**

Add `README.md` to the literal expected platform file lists in `packages/quukk-clawmessenger/scripts/package-artifacts.test.ts` and `scripts/clawmessenger-runtime.test.ts`. Add an audit fixture assertion that a platform tarball without `README.md` is rejected as `missing_required_file`.

- [ ] **Step 2: Run the packaging tests and verify RED**

Run:

```bash
pnpm exec vitest run packages/quukk-clawmessenger/scripts/package-artifacts.test.ts scripts/clawmessenger-runtime.test.ts
```

Expected: FAIL because current runtime package manifests and tarballs omit `README.md`.

- [ ] **Step 3: Add the user-facing and runtime documentation**

After the main install command in `packages/quukk-clawmessenger/README.md`, add:

```md
This is the only package users install. npm automatically selects the matching signed native
runtime for the current operating system and CPU; do not install the scoped runtime packages
directly.
```

Add this content to each runtime README. Use the exact corresponding heading from this list:

- `# @quukk/clawmessenger-runtime-win32-x64`
- `# @quukk/clawmessenger-runtime-win32-arm64`
- `# @quukk/clawmessenger-runtime-darwin-x64`
- `# @quukk/clawmessenger-runtime-darwin-arm64`
- `# @quukk/clawmessenger-runtime-linux-x64`
- `# @quukk/clawmessenger-runtime-linux-arm64`

The remainder of every file is identical:

```md
This package is an internal native runtime selected automatically by npm for
[`quukk-clawmessenger`](https://www.npmjs.com/package/quukk-clawmessenger).

Do not install it directly. Install the user-facing beta package instead:

```bash
npm install --global quukk-clawmessenger@beta
```
```

- [ ] **Step 4: Include and validate runtime READMEs**

Add `README.md` to each runtime package's `files` array and to the exact platform allowlists in `packages/quukk-clawmessenger/scripts/audit-tarball.mjs` and `scripts/verify-clawmessenger-runtime.mjs`. Do not relax any other tarball restriction.

- [ ] **Step 5: Run packaging tests and verify GREEN**

Run:

```bash
pnpm exec vitest run packages/quukk-clawmessenger/scripts/package-artifacts.test.ts scripts/clawmessenger-runtime.test.ts
```

Expected: both files PASS.

- [ ] **Step 6: Commit the package UX changes**

```bash
git add packages/quukk-clawmessenger/README.md packages/quukk-clawmessenger-runtime-* scripts/verify-clawmessenger-runtime.mjs scripts/clawmessenger-runtime.test.ts packages/quukk-clawmessenger/scripts/audit-tarball.mjs packages/quukk-clawmessenger/scripts/package-artifacts.test.ts
git commit -m "docs(npm): present ClawMessenger as one installable package"
```

### Task 4: Verify the implementation and prepare integration

**Files:**

- Modify: `docs/superpowers/plans/2026-09-01-quukk-single-entry-resumable-beta-release.md` checkbox state only.

**Interfaces:**

- Consumes: all implementation tasks.
- Produces: fresh verification evidence and an integration-ready branch.

- [ ] **Step 1: Run the release and packaging suites together**

```bash
pnpm exec vitest run scripts/plan-clawmessenger-npm-release.test.ts scripts/clawmessenger-runtime-workflow.test.ts scripts/clawmessenger-runtime.test.ts packages/quukk-clawmessenger/scripts/package-artifacts.test.ts packages/quukk-clawmessenger/scripts/postinstall.test.ts
```

Expected: all tests PASS with zero failures.

- [ ] **Step 2: Run entry-package tests and typechecks**

```bash
pnpm --dir packages/quukk-clawmessenger test
pnpm --dir packages/quukk-clawmessenger typecheck
pnpm --dir packages/quukk-clawmessenger typecheck:e2e
```

Expected: all three commands exit 0.

- [ ] **Step 3: Run repository hygiene checks**

```bash
git diff --check
git status --short
```

Expected: no whitespace errors and only the tracked plan checkbox update remains.

- [ ] **Step 4: Commit the checked implementation plan state**

```bash
git add docs/superpowers/plans/2026-09-01-quukk-single-entry-resumable-beta-release.md
git commit -m "docs: record resumable beta release implementation"
```

### Task 5: Merge, publish, and perform a real clean-profile installation

**Files:**

- No repository file changes expected.
- Preserve the clean test profile directory until the user finishes observing the running setup page.

**Interfaces:**

- Consumes: the verified branch, GitHub Actions, protected environment secret `NPM_TOKEN`, npm public registry, and the published `beta` dist-tag.
- Produces: a merged release workflow, seven matching registry artifacts exposed as one user install, and real Windows x64 lifecycle evidence.

- [ ] **Step 1: Push an integration branch and open a pull request**

Rename the local branch before first push so the old merged branch remains untouched:

```bash
git branch -m codex/single-entry-resumable-beta-release
git push -u origin codex/single-entry-resumable-beta-release
gh pr create --base main --head codex/single-entry-resumable-beta-release --title "fix(release): make npm beta publication safely resumable" --body "Keep quukk-clawmessenger as the only user-facing install. Add digest-verified retry planning, publish or verify all six runtimes before the entry, and document runtime packages as internal implementation details. Verification: focused release, workflow, packaging, postinstall, and entry typecheck suites."
```

The PR body must summarize the one-package UX, digest-verified retry behavior, runtime-before-entry ordering, and exact verification commands.

- [ ] **Step 2: Wait for required CI and merge only after success**

```bash
gh pr checks --watch
gh pr merge --squash --delete-branch
```

Expected: every required check succeeds before merge.

- [ ] **Step 3: Confirm the protected npm credential without exposing it**

Check the GitHub `npm-runtime-prerelease` environment for an `NPM_TOKEN` secret by name only. If missing, use the signed-in browser session to create a granular npm automation token restricted to the seven packages, then store it as the environment secret without printing, copying into chat, or writing it to disk. Stop for user password/2FA entry if npm requires reauthentication.

- [ ] **Step 4: Dispatch and watch the protected publication**

```bash
gh workflow run quukk-clawmessenger-runtime.yml --ref main -f publish=true
$releaseRun = gh run list --workflow quukk-clawmessenger-runtime.yml --branch main --event workflow_dispatch --limit 1 --json databaseId | ConvertFrom-Json
$releaseRunId = $releaseRun[0].databaseId
gh run watch $releaseRunId --exit-status
```

Expected: build/attestation jobs pass; the protected publish job reports matching or newly published runtimes, publishes the entry last, and completes with the seven-package verification step passing.

- [ ] **Step 5: Verify public registry metadata**

Query all seven exact `0.1.0-beta.3` versions and confirm `quukk-clawmessenger@beta` resolves to `0.1.0-beta.3`. Confirm the entry's six `optionalDependencies` are exact `0.1.0-beta.3` and Windows x64 npm selection installs only `@quukk/clawmessenger-runtime-win32-x64`.

- [ ] **Step 6: Install from npm into a clean Windows profile**

Create a dedicated temporary prefix and profile with native PowerShell paths. Set `QUUKK_CLAWMESSENGER_NO_OPEN=1` during installation, then run:

```powershell
npm install --global --prefix $testPrefix quukk-clawmessenger@beta
& "$testPrefix\quukk-clawmessenger.cmd" --help
& "$testPrefix\quukk-clawmessenger.cmd" setup --no-open
& "$testPrefix\quukk-clawmessenger.cmd" status --json
& "$testPrefix\quukk-clawmessenger.cmd" doctor --json
npm ls --global --prefix $testPrefix --depth=1
```

Expected: install exits 0, CLI help renders, setup starts the verified Windows x64 runtime, status reports ready, doctor contains no fatal diagnostic, and the dependency tree contains the entry plus only the matching runtime package.

- [ ] **Step 7: Open the local setup page for user observation**

Open the setup URL emitted by the installed CLI in the Codex in-app browser. Keep the clean-profile service and files running while the user checks the interface and confirms the result.

- [ ] **Step 8: Clean up only after user confirmation**

After the user confirms the observed result, run the installed CLI `stop`, uninstall from the temporary prefix, and remove only the exact validated temporary test directory. Report what was removed and that the npm registry publication remains immutable.
