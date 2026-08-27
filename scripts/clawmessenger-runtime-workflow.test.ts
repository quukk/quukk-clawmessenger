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
  it('builds and attests the entry package after the Bridge UI and TypeScript builds', async () => {
    const workflow = await loadWorkflow();
    const entry = requiredJob(workflow, 'build-entry');
    expect(entry.needs).toBe('runtime-contracts');
    expect(JSON.stringify(entry)).not.toContain('NPM_TOKEN');

    const bridgeBuild = requiredStep(entry, 'Build Bridge UI');
    const entryBuild = requiredStep(entry, 'Build entry TypeScript');
    const licenseAudit = requiredStep(entry, 'Audit Bridge licenses');
    const prepare = requiredStep(entry, 'Prepare entry package');
    const dryRun = requiredStep(entry, 'Dry-run and audit entry package');
    const pack = requiredStep(entry, 'Pack entry package');
    const attest = requiredStep(entry, 'Attest entry package provenance');
    const upload = requiredStep(entry, 'Upload entry package');
    const orderedSteps = [
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
    expect(attest.uses).toBe('actions/attest-build-provenance@v2');
    expect(attest.with?.['subject-path']).toBe('.artifacts/entry/*.tgz');
    expect(upload.uses).toBe('actions/upload-artifact@v4');
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
    expect(actions).toContain('actions/upload-artifact@v4');
    expect(actions).toContain('actions/attest-build-provenance@v2');
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
      (step) => step.uses === 'actions/download-artifact@v4',
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
});
