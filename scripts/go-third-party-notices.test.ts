import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const MODULE = 'example.com/library@v1.2.3';
const CHECKSUM = 'h1:AbCdEf0123456789+/=';
const temporaryDirectories: string[] = [];

function legalBlock(name: string, content: string): string {
  return `#### ${name}\n\n\`\`\`text\n${content}\n\`\`\``;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'quukk-go-notices-'));
  temporaryDirectories.push(root);
  const packageDirectory = join(root, 'packages', 'runtime');
  const goRoot = join(root, 'go-root');
  const moduleDirectory = join(root, 'go-module');
  await Promise.all([
    mkdir(join(root, 'server'), { recursive: true }),
    mkdir(packageDirectory, { recursive: true }),
    mkdir(goRoot, { recursive: true }),
    mkdir(moduleDirectory, { recursive: true }),
  ]);
  await writeFile(join(root, 'server', 'go.sum'), `example.com/library v1.2.3 ${CHECKSUM}\n`);
  await writeFile(
    join(packageDirectory, 'manifest.json'),
    `${JSON.stringify({ goVersion: 'go1.26.6', modules: [MODULE] }, null, 2)}\n`,
  );
  await writeFile(join(goRoot, 'LICENSE'), 'Go license text.\n');
  await writeFile(join(goRoot, 'PATENTS'), 'Go patent text.\n');
  await writeFile(join(moduleDirectory, 'LICENSE'), 'Module license text.\n');
  await writeFile(join(moduleDirectory, 'NOTICE.txt'), 'Module notice text.\n');

  const notice = [
    '# Go Third-Party Notices',
    '',
    '## Included Go runtime',
    '',
    '- Go standard library/runtime `go1.26.6`',
    '',
    '## Included modules',
    '',
    `- \`${MODULE}\` — \`${CHECKSUM}\``,
    '',
    '## License and notice texts',
    '',
    legalBlock('LICENSE', 'Go license text.'),
    '',
    legalBlock('PATENTS', 'Go patent text.'),
    '',
    legalBlock('LICENSE', 'Module license text.'),
    '',
    legalBlock('NOTICE.txt', 'Module notice text.'),
    '',
  ].join('\n');
  await writeFile(join(root, 'GO_THIRD_PARTY_NOTICES.md'), notice);
  await writeFile(join(packageDirectory, 'GO_THIRD_PARTY_NOTICES.md'), notice);

  const execute = async (_file: string, args: readonly string[]) => {
    if (args.join(' ') === 'env GOVERSION') return { stdout: 'go1.26.6\n', stderr: '' };
    if (args.join(' ') === 'env GOROOT') return { stdout: `${goRoot}\n`, stderr: '' };
    if (args.join(' ') === `mod download -json ${MODULE}`) {
      return {
        stdout: `${JSON.stringify({
          Path: 'example.com/library',
          Version: 'v1.2.3',
          Sum: CHECKSUM,
          Dir: moduleDirectory,
        })}\n`,
        stderr: '',
      };
    }
    throw new Error(`unexpected command: ${args.join(' ')}`);
  };
  return { root, packageDirectory, moduleDirectory, execute };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('Go third-party notice verification', () => {
  it('binds the notice to go.sum and the exact upstream legal files', async () => {
    const module = await import('./verify-go-third-party-notices.mjs').catch(() => ({}));
    expect(module.verifyGoThirdPartyNotices).toBeTypeOf('function');
    if (typeof module.verifyGoThirdPartyNotices !== 'function') return;
    const input = await fixture();

    await expect(module.verifyGoThirdPartyNotices(input.packageDirectory, {
      repoRoot: input.root,
      execute: input.execute,
    })).resolves.toEqual({ goVersion: 'go1.26.6', moduleCount: 1, legalFileCount: 4 });
  });

  it('rejects a names-only notice even when every module identifier is present', async () => {
    const { verifyGoThirdPartyNotices } = await import('./verify-go-third-party-notices.mjs');
    const input = await fixture();
    const namesOnly = [
      '# Go Third-Party Notices',
      '',
      '## Included Go runtime',
      '',
      '- Go standard library/runtime `go1.26.6`',
      '',
      '## Included modules',
      '',
      `- \`${MODULE}\` — \`${CHECKSUM}\``,
      '',
      '## License and notice texts',
      '',
    ].join('\n');
    await writeFile(join(input.root, 'GO_THIRD_PARTY_NOTICES.md'), namesOnly);
    await writeFile(join(input.packageDirectory, 'GO_THIRD_PARTY_NOTICES.md'), namesOnly);

    await expect(verifyGoThirdPartyNotices(input.packageDirectory, {
      repoRoot: input.root,
      execute: input.execute,
    })).rejects.toThrow('Go LICENSE text is missing');
  });

  it('rejects a checksum inventory that differs from server/go.sum', async () => {
    const { verifyGoThirdPartyNotices } = await import('./verify-go-third-party-notices.mjs');
    const input = await fixture();
    await writeFile(
      join(input.root, 'server', 'go.sum'),
      'example.com/library v1.2.3 h1:different=\n',
    );

    await expect(verifyGoThirdPartyNotices(input.packageDirectory, {
      repoRoot: input.root,
      execute: input.execute,
    })).rejects.toThrow('notice checksum differs from server/go.sum');
  });

  it('rejects omitted module NOTICE files', async () => {
    const { verifyGoThirdPartyNotices } = await import('./verify-go-third-party-notices.mjs');
    const input = await fixture();
    await writeFile(join(input.moduleDirectory, 'NOTICE.txt'), 'Changed upstream notice.\n');

    await expect(verifyGoThirdPartyNotices(input.packageDirectory, {
      repoRoot: input.root,
      execute: input.execute,
    })).rejects.toThrow('module legal text is missing');
  });

  it('rejects notice inventory entries that are absent from server/go.sum', async () => {
    const { verifyGoThirdPartyNotices } = await import('./verify-go-third-party-notices.mjs');
    const input = await fixture();
    const noticePath = join(input.root, 'GO_THIRD_PARTY_NOTICES.md');
    const notice = await readFile(noticePath, 'utf8');
    const tampered = notice.replace(
      `- \`${MODULE}\` — \`${CHECKSUM}\``,
      `- \`${MODULE}\` — \`${CHECKSUM}\`\n- \`example.com/unlinked@v9.9.9\` — \`h1:not-in-go-sum=\``,
    );
    await writeFile(noticePath, tampered);
    await writeFile(join(input.packageDirectory, 'GO_THIRD_PARTY_NOTICES.md'), tampered);

    await expect(verifyGoThirdPartyNotices(input.packageDirectory, {
      repoRoot: input.root,
      execute: input.execute,
    })).rejects.toThrow('notice checksum differs from server/go.sum');
  });

  it('accepts a parent module listed before its submodule', async () => {
    const { verifyGoThirdPartyNotices } = await import('./verify-go-third-party-notices.mjs');
    const input = await fixture();
    const submodule = 'example.com/library/sub@v1.0.0';
    const submoduleChecksum = 'h1:SubmoduleChecksum=';
    const submoduleDirectory = join(input.root, 'go-submodule');
    await mkdir(submoduleDirectory);
    await writeFile(join(submoduleDirectory, 'LICENSE'), 'Module license text.\n');
    await writeFile(
      join(input.root, 'server', 'go.sum'),
      `example.com/library v1.2.3 ${CHECKSUM}\nexample.com/library/sub v1.0.0 ${submoduleChecksum}\n`,
    );
    const noticePath = join(input.root, 'GO_THIRD_PARTY_NOTICES.md');
    const notice = (await readFile(noticePath, 'utf8')).replace(
      `- \`${MODULE}\` — \`${CHECKSUM}\``,
      `- \`${MODULE}\` — \`${CHECKSUM}\`\n- \`${submodule}\` — \`${submoduleChecksum}\``,
    );
    await writeFile(noticePath, notice);
    await writeFile(join(input.packageDirectory, 'GO_THIRD_PARTY_NOTICES.md'), notice);
    const execute = async (file: string, args: readonly string[]) => {
      if (args.join(' ') === `mod download -json ${submodule}`) {
        return {
          stdout: `${JSON.stringify({
            Path: 'example.com/library/sub',
            Version: 'v1.0.0',
            Sum: submoduleChecksum,
            Dir: submoduleDirectory,
          })}\n`,
          stderr: '',
        };
      }
      return input.execute(file, args);
    };

    await expect(verifyGoThirdPartyNotices(input.packageDirectory, {
      repoRoot: input.root,
      execute,
    })).resolves.toMatchObject({ moduleCount: 2 });
  });
});
