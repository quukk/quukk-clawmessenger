// @vitest-environment node

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  'working-directory'?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  if?: string;
  needs?: string | string[];
  environment?: string;
  concurrency?: {
    group: string;
    'cancel-in-progress': boolean;
  };
  env?: Record<string, string>;
  strategy?: {
    matrix: {
      include: Array<Record<string, string>>;
    };
  };
  steps: WorkflowStep[];
}

interface RuntimeWorkflow {
  on: {
    workflow_dispatch: {
      inputs: {
        publish: Record<string, unknown>;
      };
    };
  };
  jobs: Record<string, WorkflowJob>;
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_RUNTIME_TARGETS = [
  'win32/x64',
  'win32/arm64',
  'darwin/x64',
  'darwin/arm64',
  'linux/x64',
  'linux/arm64',
];
const EXPECTED_ARTIFACTS = [
  ['quukk-runtime-win32-x64', '.artifacts/incoming/win32-x64'],
  ['quukk-runtime-win32-arm64', '.artifacts/incoming/win32-arm64'],
  ['quukk-runtime-darwin-x64', '.artifacts/incoming/darwin-x64'],
  ['quukk-runtime-darwin-arm64', '.artifacts/incoming/darwin-arm64'],
  ['quukk-runtime-linux-x64', '.artifacts/incoming/linux-x64'],
  ['quukk-runtime-linux-arm64', '.artifacts/incoming/linux-arm64'],
  ['quukk-entry-package', '.artifacts/incoming/entry'],
];
const EXPECTED_PACKAGE_NAMES = [
  '@quukk/clawmessenger-runtime-win32-x64',
  '@quukk/clawmessenger-runtime-win32-arm64',
  '@quukk/clawmessenger-runtime-darwin-x64',
  '@quukk/clawmessenger-runtime-darwin-arm64',
  '@quukk/clawmessenger-runtime-linux-x64',
  '@quukk/clawmessenger-runtime-linux-arm64',
  'quukk-clawmessenger',
];
const PINNED_ACTIONS = new Set([
  'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
  'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
  'actions/setup-go@40f1582b2485089dde7abd97c1529aa768e1baff',
  'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
  'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093',
  'actions/attest-build-provenance@e8998f949152b193b063cb0ec769d69d929409be',
  'pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1',
]);

async function loadWorkflow(): Promise<RuntimeWorkflow> {
  return parseYaml(
    await readFile(
      join(REPO_ROOT, '.github', 'workflows', 'quukk-clawmessenger-runtime.yml'),
      'utf8',
    ),
  ) as RuntimeWorkflow;
}

function requiredJob(workflow: RuntimeWorkflow, id: string): WorkflowJob {
  const job = workflow.jobs[id];
  expect(job, `missing ${id} job`).toBeDefined();
  return job;
}

function requiredStep(job: WorkflowJob, name: string): WorkflowStep {
  const step = job.steps.find((candidate) => candidate.name === name);
  expect(step, `missing ${name} step`).toBeDefined();
  return step;
}

describe('Quukk ClawMessenger seven-package workflow', () => {
  it('runs the exact Bridge and runtime-access Go contracts before artifact builds', async () => {
    const workflow = await loadWorkflow();
    const contracts = requiredJob(workflow, 'runtime-contracts');
    const test = requiredStep(contracts, 'Test Bridge Go contracts');
    expect(test['working-directory']).toBe('server');
    expect(test.run).toContain("go test -count=1 -run '^TestBridgeCommand' ./cmd/multica");
    expect(test.run).toContain("go test -count=1 -run '^TestBridge' ./internal/daemon");
    expect(test.run).toContain(
      "go test -count=1 -run '^(TestClaimTaskByRuntime|TestBuildClaimedTaskResponse)' ./internal/handler",
    );
    expect(test.run).toContain(
      "go test -count=1 -run '^(TestRuntimeAccessGates|TestClaimTask)' ./internal/service",
    );
  });

  it('builds and attests the entry package after the Bridge UI and TypeScript builds', async () => {
    const workflow = await loadWorkflow();
    const entry = requiredJob(workflow, 'build-entry');
    expect(entry.needs).toBe('runtime-contracts');
    expect(JSON.stringify(entry)).not.toContain('NPM_TOKEN');

    const bridgeTest = requiredStep(entry, 'Test Bridge UI');
    const bridgeTypecheck = requiredStep(entry, 'Typecheck Bridge UI');
    const entryTest = requiredStep(entry, 'Test entry package');
    const entryTypecheck = requiredStep(entry, 'Typecheck entry package');
    const e2eTypecheck = requiredStep(entry, 'Typecheck fake end-to-end');
    const bridgeBuild = requiredStep(entry, 'Build Bridge UI');
    const entryBuild = requiredStep(entry, 'Build entry TypeScript');
    const licenseAudit = requiredStep(entry, 'Audit Bridge licenses');
    const prepare = requiredStep(entry, 'Prepare entry package');
    const dryRun = requiredStep(entry, 'Dry-run and audit entry package');
    const pack = requiredStep(entry, 'Pack entry package');
    const attest = requiredStep(entry, 'Attest entry package provenance');
    const upload = requiredStep(entry, 'Upload entry package');
    const orderedSteps = [
      bridgeTest,
      bridgeTypecheck,
      entryTest,
      entryTypecheck,
      e2eTypecheck,
      bridgeBuild,
      entryBuild,
      licenseAudit,
      prepare,
      dryRun,
      pack,
      attest,
      upload,
    ].map((step) => entry.steps.indexOf(step));
    expect(orderedSteps.every((index, position) => (
      index >= 0 && (position === 0 || index > orderedSteps[position - 1])
    ))).toBe(true);

    expect(bridgeTest.run).toBe('pnpm --dir apps/bridge test');
    expect(bridgeTypecheck.run).toBe('pnpm --dir apps/bridge typecheck');
    expect(entryTest.run).toBe('pnpm --dir packages/quukk-clawmessenger test');
    expect(entryTypecheck.run).toBe('pnpm --dir packages/quukk-clawmessenger typecheck');
    expect(e2eTypecheck.run).toBe('pnpm --dir packages/quukk-clawmessenger typecheck:e2e');
    expect(bridgeBuild.run).toBe('pnpm --dir apps/bridge build');
    expect(entryBuild.run).toBe(
      'pnpm --dir packages/quukk-clawmessenger exec tsc -p tsconfig.json',
    );
    expect(licenseAudit.run).toBe('pnpm audit:bridge-licenses');
    expect(prepare.run).toBe(
      'node packages/quukk-clawmessenger/scripts/prepare-package.mjs',
    );
    expect(dryRun.run).toContain('npm pack --dry-run --json --ignore-scripts');
    expect(dryRun.run).toContain('packages/quukk-clawmessenger/scripts/audit-tarball.mjs');
    expect(pack.run).toContain('npm pack --ignore-scripts');
    expect(pack.run).not.toContain('--dry-run');
    expect(attest.uses).toBe(
      'actions/attest-build-provenance@e8998f949152b193b063cb0ec769d69d929409be',
    );
    expect(attest.with?.['subject-path']).toBe('.artifacts/entry/*.tgz');
    expect(upload.uses).toBe(
      'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
    );
    expect(upload.with).toMatchObject({
      name: 'quukk-entry-package',
      path: '.artifacts/entry/*.tgz',
      'if-no-files-found': 'error',
    });
  });

  it('keeps all six runtime builds reproducible, attested, and credential-free', async () => {
    const workflow = await loadWorkflow();
    const build = requiredJob(workflow, 'build-runtime');
    expect(build.env).toEqual({
      CGO_ENABLED: '0',
      GOENV: 'off',
      GOFLAGS: '',
      GOWORK: 'off',
      GOTOOLCHAIN: 'local',
      GOEXPERIMENT: '',
      GOFIPS140: 'off',
      GODEBUG: '',
    });
    expect(
      build.strategy?.matrix.include.map(
        (target) => `${target.platform}/${target.arch}`,
      ),
    ).toEqual(EXPECTED_RUNTIME_TARGETS);
    const actions = build.steps.map((step) => step.uses).filter(Boolean);
    const commands = build.steps.map((step) => step.run).filter(Boolean).join('\n');
    expect(commands).toContain('scripts/build-clawmessenger-runtime.mjs');
    expect(commands).toContain('scripts/verify-clawmessenger-runtime.mjs');
    expect(commands).toContain('first_sha256');
    expect(commands).toContain('second_sha256');
    expect(commands).toContain('npm pack "./packages/');
    expect(actions).toContain(
      'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
    );
    expect(actions).toContain(
      'actions/attest-build-provenance@e8998f949152b193b063cb0ec769d69d929409be',
    );
    expect(JSON.stringify(build)).not.toContain('NPM_TOKEN');
  });

  it('publishes only an explicitly requested protected beta release set, runtimes first', async () => {
    const workflow = await loadWorkflow();
    expect(workflow.on.workflow_dispatch.inputs.publish).toMatchObject({
      type: 'boolean',
      required: true,
      default: false,
    });

    const publish = requiredJob(workflow, 'publish-runtime-packages');
    expect(publish.if?.replace(/\s+/g, ' ').trim()).toBe(
      "github.event_name == 'workflow_dispatch' && inputs.publish == true && github.ref_protected == true && (github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/quukk-clawmessenger-v'))",
    );
    expect(publish.environment).toBe('npm-runtime-prerelease');
    expect(publish.needs).toEqual(['build-runtime', 'build-entry']);
    expect(publish.concurrency).toEqual({
      group: 'quukk-clawmessenger-beta-publish',
      'cancel-in-progress': false,
    });
    expect(publish.env).toBeUndefined();

    const downloads = publish.steps.filter(
      (step) =>
        step.uses ===
        'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093',
    );
    expect(downloads.map((step) => [step.with?.name, step.with?.path])).toEqual(
      EXPECTED_ARTIFACTS,
    );
    expect(new Set(downloads.map((step) => step.with?.name)).size).toBe(7);
    expect(new Set(downloads.map((step) => step.with?.path)).size).toBe(7);

    const credential = requiredStep(publish, 'Require npm publish credential');
    const validate = requiredStep(publish, 'Validate seven-package release set');
    const preflight = requiredStep(publish, 'Preflight npm package versions');
    const publishRuntimes = requiredStep(publish, 'Publish runtime beta packages');
    const publishEntry = requiredStep(publish, 'Publish entry beta package');
    const orderedSteps = [credential, validate, preflight, publishRuntimes, publishEntry].map(
      (step) => publish.steps.indexOf(step),
    );
    expect(orderedSteps.every((index, position) => (
      index >= 0 && (position === 0 || index > orderedSteps[position - 1])
    ))).toBe(true);

    expect(credential.env?.NODE_AUTH_TOKEN).toBe('${{ secrets.NPM_TOKEN }}');
    expect(credential.run).toContain('${NODE_AUTH_TOKEN:-}');
    expect(credential.run).toContain('npm whoami');
    expect(validate.run).toContain('find "$artifact_directory" -mindepth 1 -maxdepth 1');
    expect(validate.run).toContain('tar -xOf "$archive" package/package.json');
    expect(validate.run).toContain('optionalDependencies');
    expect(validate.run).toContain('release-set.tsv');
    for (const packageName of EXPECTED_PACKAGE_NAMES) {
      expect(validate.run, packageName).toContain(packageName);
    }

    expect(preflight.run).toContain('npm view "$package_name@$expected_version"');
    expect(preflight.run).toContain('E404');
    expect(preflight.run).toContain('release-set.tsv');
    expect(publishRuntimes.run).toContain('release-set.tsv');
    expect(publishRuntimes.run).toContain('npm publish "$archive" --access public --tag beta --provenance');
    expect(publishEntry.run).toContain('quukk-clawmessenger');
    expect(publishEntry.run).toContain('npm publish "$entry_archive" --access public --tag beta --provenance');
    expect(publishRuntimes.env?.NODE_AUTH_TOKEN).toBe('${{ secrets.NPM_TOKEN }}');
    expect(publishEntry.env?.NODE_AUTH_TOKEN).toBe('${{ secrets.NPM_TOKEN }}');

    const allPublishCommands = publish.steps.map((step) => step.run ?? '').join('\n');
    expect(allPublishCommands.match(/npm publish /g)).toHaveLength(2);
  });

  it('pins every third-party action to one reviewed commit', async () => {
    const workflow = await loadWorkflow();
    const uses = Object.values(workflow.jobs).flatMap((job) =>
      job.steps.map((step) => step.uses).filter((value): value is string => value !== undefined),
    );
    expect(uses.length).toBeGreaterThan(0);
    for (const action of uses) {
      expect(action).toMatch(/@[0-9a-f]{40}$/);
      expect(PINNED_ACTIONS.has(action), action).toBe(true);
    }
  });
});
