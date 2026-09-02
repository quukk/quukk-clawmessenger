// @vitest-environment node

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  classifyReleaseSet,
  compareDistribution,
  createReleasePlan,
  queryNpmDistribution,
} from './plan-clawmessenger-npm-release.mjs';

const runtimeNames = [
  '@quukk/clawmessenger-runtime-win32-x64',
  '@quukk/clawmessenger-runtime-win32-arm64',
  '@quukk/clawmessenger-runtime-darwin-x64',
  '@quukk/clawmessenger-runtime-darwin-arm64',
  '@quukk/clawmessenger-runtime-linux-x64',
  '@quukk/clawmessenger-runtime-linux-arm64',
];
const temporaryDirectories: string[] = [];

type ReleaseState = 'missing' | 'matching';
type ReleaseRole = 'runtime' | 'entry';

function release(state: ReleaseState): Array<{
  name: string;
  archive: string;
  role: ReleaseRole;
  state: ReleaseState;
}> {
  return [
    ...runtimeNames.map((name) => ({
      name,
      archive: `${name.replaceAll('/', '-')}.tgz`,
      role: 'runtime' as const,
      state,
    })),
    {
      name: 'quukk-clawmessenger',
      archive: 'quukk-clawmessenger.tgz',
      role: 'entry' as const,
      state,
    },
  ];
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('npm distribution comparison', () => {
  const matching = {
    shasum: 'a'.repeat(40),
    integrity: 'sha512-YQ==',
  };

  it('accepts an existing tarball only when both registry digests match', () => {
    expect(compareDistribution(matching, matching)).toBe('matching');
  });

  it('fails closed when the registry SHA-1 differs', () => {
    expect(() =>
      compareDistribution(matching, {
        ...matching,
        shasum: 'b'.repeat(40),
      }),
    ).toThrowError('registry_content_mismatch');
  });

  it('fails closed when the registry integrity differs', () => {
    expect(() =>
      compareDistribution(matching, {
        ...matching,
        integrity: 'sha512-Yg==',
      }),
    ).toThrowError('registry_content_mismatch');
  });
});

describe('resumable npm release classification', () => {
  it('supports a resumable entry-only release', () => {
    expect(classifyReleaseSet([{
      name: 'quukk-clawmessenger',
      archive: 'quukk-clawmessenger.tgz',
      role: 'entry',
      state: 'missing',
    }], 'entry')).toEqual([{
      name: 'quukk-clawmessenger',
      archive: 'quukk-clawmessenger.tgz',
      role: 'entry',
      state: 'missing',
      action: 'publish',
    }]);
  });

  it('rejects runtime packages in an entry-only release', () => {
    expect(() => classifyReleaseSet([release('missing')[0]], 'entry')).toThrowError(
      'invalid_release_set',
    );
  });

  it('publishes every package when all versions are missing', () => {
    expect(
      classifyReleaseSet(release('missing'), 'preflight').map(
        (item: { action: string }) => item.action,
      ),
    ).toEqual(Array(7).fill('publish'));
  });

  it('skips matching runtimes and publishes only missing packages', () => {
    const packages = release('missing');
    packages[0].state = 'matching';

    expect(
      classifyReleaseSet(packages, 'preflight').map(
        (item: { action: string }) => item.action,
      ),
    ).toEqual(['skip', 'publish', 'publish', 'publish', 'publish', 'publish', 'publish']);
  });

  it('rejects an existing entry when any runtime is missing', () => {
    const packages = release('matching');
    packages[0].state = 'missing';

    expect(() => classifyReleaseSet(packages, 'preflight')).toThrowError(
      'entry_without_complete_runtime_set',
    );
  });

  it('requires all runtimes after runtime publication', () => {
    expect(() => classifyReleaseSet(release('missing'), 'runtimes')).toThrowError(
      'runtime_release_incomplete',
    );
  });

  it('requires the entry package for a complete release', () => {
    const packages = release('matching');
    packages.at(-1)!.state = 'missing';

    expect(() => classifyReleaseSet(packages, 'complete')).toThrowError(
      'entry_release_incomplete',
    );
  });

  it('reports a complete matching release as a no-op', () => {
    expect(
      classifyReleaseSet(release('matching'), 'complete').every(
        (item: { action: string }) => item.action === 'skip',
      ),
    ).toBe(true);
  });
});

describe('npm registry query boundary', () => {
  it('returns missing only for an explicit npm E404 response', () => {
    const result = queryNpmDistribution('@quukk/example', '0.1.0-beta.3', () => ({
      status: 1,
      stdout: '',
      stderr: 'npm error code E404\nnpm error 404 Not Found',
      error: undefined,
    }));

    expect(result).toEqual({ state: 'missing' });
  });

  it('fails closed for a non-404 registry failure', () => {
    expect(() =>
      queryNpmDistribution('@quukk/example', '0.1.0-beta.3', () => ({
        status: 1,
        stdout: '',
        stderr: 'npm error code E503',
        error: undefined,
      })),
    ).toThrowError('registry_lookup_failed');
  });

  it('returns both digests from a successful registry response', () => {
    const result = queryNpmDistribution('@quukk/example', '0.1.0-beta.3', () => ({
      status: 0,
      stdout: JSON.stringify({ shasum: 'a'.repeat(40), integrity: 'sha512-YQ==' }),
      stderr: '',
      error: undefined,
    }));

    expect(result).toEqual({
      state: 'found',
      shasum: 'a'.repeat(40),
      integrity: 'sha512-YQ==',
    });
  });
});

describe('release plan file', () => {
  it('writes a deterministic entry-only release plan', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'quukk-entry-release-plan-'));
    temporaryDirectories.push(directory);
    const manifest = join(directory, 'release-set.tsv');
    const versionFile = join(directory, 'release-version.txt');
    const output = join(directory, 'release-plan.tsv');
    const archive = join(directory, 'entry.tgz');
    await writeFile(archive, 'entry-archive');
    await writeFile(manifest, `quukk-clawmessenger\t${archive}\n`);
    await writeFile(versionFile, '0.1.0-beta.6\n');

    await createReleasePlan({
      manifestPath: manifest,
      versionPath: versionFile,
      outputPath: output,
      mode: 'entry',
      queryDistribution: () => ({ state: 'missing' as const }),
    });

    expect(await readFile(output, 'utf8')).toBe(
      `quukk-clawmessenger\t${archive}\tentry\tpublish\n`,
    );
  });

  it('hashes real archives and writes deterministic publish and skip actions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'quukk-release-plan-'));
    temporaryDirectories.push(directory);
    const manifest = join(directory, 'release-set.tsv');
    const versionFile = join(directory, 'release-version.txt');
    const output = join(directory, 'release-plan.tsv');
    const packages = release('missing');

    for (const [index, item] of packages.entries()) {
      item.archive = join(directory, `${index}.tgz`);
      await writeFile(item.archive, `archive-${index}`);
    }
    await writeFile(
      manifest,
      `${packages.map((item) => `${item.name}\t${item.archive}`).join('\n')}\n`,
    );
    await writeFile(versionFile, '0.1.0-beta.3\n');

    const firstBytes = Buffer.from('archive-0');
    const matchingDistribution = {
      state: 'found' as const,
      shasum: createHash('sha1').update(firstBytes).digest('hex'),
      integrity: `sha512-${createHash('sha512').update(firstBytes).digest('base64')}`,
    };

    await createReleasePlan({
      manifestPath: manifest,
      versionPath: versionFile,
      outputPath: output,
      mode: 'preflight',
      queryDistribution: (name: string) =>
        name === runtimeNames[0] ? matchingDistribution : { state: 'missing' as const },
    });

    expect(await readFile(output, 'utf8')).toBe(
      `${runtimeNames[0]}\t${packages[0].archive}\truntime\tskip\n${[
        ...packages.slice(1, 6).map((item) => `${item.name}\t${item.archive}\truntime\tpublish`),
        `quukk-clawmessenger\t${packages[6].archive}\tentry\tpublish`,
      ].join('\n')}\n`,
    );
  });
});
