// @vitest-environment node

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const temporaryDirectories: string[] = [];
const script = fileURLToPath(
  new URL('../../../scripts/check-project-copy.mjs', import.meta.url),
);
const forbiddenVendorWording = '\u878d\u4e91';

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'quukk-project-copy-'));
  temporaryDirectories.push(root);
  await execute('git', ['init', '--quiet'], { cwd: root });
  await writeFile(join(root, 'safe.md'), '# Neutral product copy\n');
  return root;
}

async function run(root: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return execute(process.execPath, [script, '--root', root])
    .then(({ stdout, stderr }) => ({ code: 0, stdout, stderr }))
    .catch((error: { code?: number; stdout?: string; stderr?: string }) => ({
      code: error.code ?? -1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    }));
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('project copy policy', () => {
  it('accepts neutral copy and rejects the forbidden vendor wording in an untracked file', async () => {
    const root = await fixture();

    await expect(run(root)).resolves.toEqual({
      code: 0,
      stdout: 'Project copy policy clean.\n',
      stderr: '',
    });

    await writeFile(join(root, 'blocked.md'), `Do not publish ${forbiddenVendorWording}.\n`);
    const rejected = await run(root);

    expect(rejected.code).toBe(1);
    expect(rejected.stdout).toBe('');
    expect(rejected.stderr).toContain('blocked.md');
    expect(rejected.stderr).toContain('forbidden_vendor_wording');
  });
});
