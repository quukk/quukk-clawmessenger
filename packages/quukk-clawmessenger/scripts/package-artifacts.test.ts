import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { auditTarball } from './audit-tarball.mjs';
import {
  LEGAL_FILES,
  PLATFORM_LEGAL_FILES,
  PLATFORM_PACKAGE_DIRECTORIES,
  preparePackage,
} from './prepare-package.mjs';

const execute = promisify(execFile);
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'quukk-package-artifacts-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function write(path: string, content: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function makeLegalRoot(root: string): Promise<void> {
  for (const [index, name] of LEGAL_FILES.entries()) {
    await write(join(root, name), Buffer.from(`root-${index}-${name}\r\n\0exact`, 'utf8'));
  }
}

describe('publish lifecycle', () => {
  it('runs the exact tarball audit before any direct npm publish', async () => {
    const packageJson = JSON.parse(
      await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as {
      files?: string[];
      publishConfig?: Record<string, unknown>;
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.prepublishOnly).toBe('node scripts/audit-tarball.mjs');
    expect(packageJson.files).toContain('scripts/audit-tarball.mjs');
    expect(packageJson.publishConfig).toEqual({
      access: 'public',
      provenance: true,
      tag: 'beta',
    });
  });
});

describe('prepare-package', () => {
  it('copies the exact root legal bytes into the required entry package with no platform packages', async () => {
    const root = await temporaryDirectory();
    const entry = join(root, 'packages', 'quukk-clawmessenger');
    await mkdir(entry, { recursive: true });
    await makeLegalRoot(root);

    const result = await preparePackage({ repositoryRoot: root });

    expect(result).toEqual({ targetCount: 1, fileCount: LEGAL_FILES.length });
    for (const name of LEGAL_FILES) {
      expect(await readFile(join(entry, name))).toEqual(await readFile(join(root, name)));
    }
  });

  it('copies only the three platform legal files into the complete six-package staging matrix', async () => {
    const root = await temporaryDirectory();
    const packages = join(root, 'packages');
    await mkdir(join(packages, 'quukk-clawmessenger'), { recursive: true });
    for (const name of PLATFORM_PACKAGE_DIRECTORIES) {
      await mkdir(join(packages, name), { recursive: true });
    }
    await makeLegalRoot(root);

    const result = await preparePackage({ repositoryRoot: root });

    expect(result).toEqual({
      targetCount: 7,
      fileCount: LEGAL_FILES.length + PLATFORM_PACKAGE_DIRECTORIES.length * PLATFORM_LEGAL_FILES.length,
    });
    for (const name of LEGAL_FILES) {
      expect(await readFile(join(packages, 'quukk-clawmessenger', name)))
        .toEqual(await readFile(join(root, name)));
    }
    for (const directory of PLATFORM_PACKAGE_DIRECTORIES) {
      for (const name of PLATFORM_LEGAL_FILES) {
        expect(await readFile(join(packages, directory, name)))
          .toEqual(await readFile(join(root, name)));
      }
      expect(await lstat(join(packages, directory, 'THIRD_PARTY_NOTICES.md')).then(
        () => true,
        () => false,
      )).toBe(false);
    }
  });

  it('rejects partial platform matrices before writing any target', async () => {
    const root = await temporaryDirectory();
    const entry = join(root, 'packages', 'quukk-clawmessenger');
    await mkdir(entry, { recursive: true });
    await mkdir(join(root, 'packages', PLATFORM_PACKAGE_DIRECTORIES[0]!), { recursive: true });
    await makeLegalRoot(root);

    await expect(preparePackage({ repositoryRoot: root }))
      .rejects.toMatchObject({ code: 'platform_package_set_incomplete' });
    for (const name of LEGAL_FILES) {
      expect(await lstat(join(entry, name)).then(() => true, () => false)).toBe(false);
    }
  });

  it('rejects symlinked source or target components instead of copying outside staging', async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await makeLegalRoot(root);
    await mkdir(join(root, 'packages'), { recursive: true });
    await mkdir(join(outside, 'entry'), { recursive: true });
    await symlink(
      join(outside, 'entry'),
      join(root, 'packages', 'quukk-clawmessenger'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await expect(preparePackage({ repositoryRoot: root }))
      .rejects.toMatchObject({ code: 'symlink_rejected' });
    for (const name of LEGAL_FILES) {
      expect(await lstat(join(outside, 'entry', name)).then(() => true, () => false)).toBe(false);
    }
  });
});

const ENTRY_MODULES = [
  'bindings/service',
  'cardkit/action-router',
  'cardkit/builders',
  'cardkit/parse-marker',
  'cardkit/schema',
  'cardkit/templates',
  'cardkit/validate',
  'cli',
  'config/atomic-json',
  'config/paths',
  'config/schema',
  'config/store',
  'go/binary',
  'go/client',
  'go/sse',
  'go/types',
  'http/routes',
  'http/security',
  'http/server',
  'http/tickets',
  'index',
  'logging/logger',
  'migration/discover',
  'migration/import',
  'process/identity',
  'process/service-identity',
  'process/supervisor',
  'protocol/discussion-v1',
  'protocol/discussion-v2',
  'protocol/discussion-wire',
  'protocol/messages',
  'registration/capabilities',
  'registration/client',
  'rongcloud/client',
  'rongcloud/env-polyfill',
  'rongcloud/worker-entry',
  'rongcloud/worker-protocol',
  'rongcloud/worker-supervisor',
  'router/conversation',
  'router/dedup',
  'router/message-router',
  'router/session-store',
  'service',
  'version',
] as const;

const ENTRY_FILES = [...new Set([
  'package.json',
  'README.md',
  'LICENSE',
  'NOTICE',
  'MODIFICATIONS.md',
  'THIRD_PARTY_NOTICES.md',
  'bin/quukk-clawmessenger.js',
  'scripts/audit-tarball.mjs',
  'scripts/postinstall.mjs',
  'dist/cli.js',
  'dist/index.js',
  'dist/rongcloud/worker-entry.js',
  'dist/ui/index.html',
  ...ENTRY_MODULES.flatMap((module) => [`dist/${module}.js`, `dist/${module}.d.ts`]),
  'dist/ui/assets/app-123.js',
  'dist/ui/assets/app-123.css',
])] as const;

const PLATFORM_FILES = [
  'package.json',
  'multica.exe',
  'manifest.json',
  'LICENSE',
  'NOTICE',
  'MODIFICATIONS.md',
  'SOURCE.md',
] as const;

const ENTRY_DEPENDENCIES = {
  '@rongcloud/engine': '5.36.6',
  '@rongcloud/imlib-next': '5.36.6',
  'fake-indexeddb': '6.2.5',
  jsdom: '29.0.1',
  ws: '8.20.0',
  zod: '4.3.6',
} as const;
const ENTRY_DEV_DEPENDENCIES = {
  '@multica/tsconfig': 'workspace:*',
  '@types/jsdom': '21.1.7',
  '@types/node': 'catalog:',
  '@types/ws': '8.18.1',
  typescript: 'catalog:',
  vitest: 'catalog:',
} as const;
const ENTRY_PACKAGE_FILES = [
  'bin',
  'dist',
  'scripts/audit-tarball.mjs',
  'scripts/postinstall.mjs',
  'LICENSE',
  'NOTICE',
  'MODIFICATIONS.md',
  'THIRD_PARTY_NOTICES.md',
  'README.md',
] as const;
const ENTRY_PACKAGE_SCRIPTS = {
  build: 'tsc -p tsconfig.json',
  typecheck: 'tsc --noEmit',
  'typecheck:e2e': 'tsc -p test/e2e/tsconfig.json',
  test: 'vitest run',
  prepublishOnly: 'node scripts/audit-tarball.mjs',
  postinstall: 'node scripts/postinstall.mjs',
} as const;

const ENTRY_OPTIONAL_DEPENDENCIES = {
  '@quukk/clawmessenger-runtime-win32-x64': '0.1.0-beta.1',
  '@quukk/clawmessenger-runtime-win32-arm64': '0.1.0-beta.1',
  '@quukk/clawmessenger-runtime-darwin-x64': '0.1.0-beta.1',
  '@quukk/clawmessenger-runtime-darwin-arm64': '0.1.0-beta.1',
  '@quukk/clawmessenger-runtime-linux-x64': '0.1.0-beta.1',
  '@quukk/clawmessenger-runtime-linux-arm64': '0.1.0-beta.1',
} as const;

type EntryFixture = {
  root: string;
  entry: string;
  report: string;
  writeReport(extraPaths?: readonly string[]): Promise<void>;
};

async function entryFixture(): Promise<EntryFixture> {
  const root = await temporaryDirectory();
  const entry = join(root, 'package');
  const report = join(root, 'npm-pack.json');
  await Promise.all(ENTRY_FILES.map(async (path) => {
    const content = path === 'package.json'
      ? JSON.stringify({
          name: 'quukk-clawmessenger',
          version: '0.1.0-beta.1',
          description: 'Connect local AI agents to ClawMessenger, built on Multica',
          type: 'module',
          engines: { node: '>=22.13.0' },
          bin: { 'quukk-clawmessenger': 'bin/quukk-clawmessenger.js' },
          files: ENTRY_PACKAGE_FILES,
          scripts: ENTRY_PACKAGE_SCRIPTS,
          license: 'SEE LICENSE IN LICENSE',
          publishConfig: { access: 'public', provenance: true, tag: 'beta' },
          dependencies: ENTRY_DEPENDENCIES,
          optionalDependencies: ENTRY_OPTIONAL_DEPENDENCIES,
          devDependencies: ENTRY_DEV_DEPENDENCIES,
        })
      : path.endsWith('.css')
        ? 'body{color:#123456}'
        : path.endsWith('.html')
          ? '<!doctype html><script type="module" src="/assets/app-123.js"></script>'
          : `safe fixture for ${path}\n`;
    await write(join(entry, ...path.split('/')), content);
  }));
  const writeReport = async (extraPaths: readonly string[] = []): Promise<void> => {
    const paths = [...ENTRY_FILES, ...extraPaths];
    const files = await Promise.all(paths.map(async (path) => ({
      path,
      size: (await stat(join(entry, ...path.split('/')))).size,
      mode: 0o644,
    })));
    await write(report, JSON.stringify([{
      id: 'quukk-clawmessenger@0.1.0-beta.1',
      name: 'quukk-clawmessenger',
      version: '0.1.0-beta.1',
      filename: 'quukk-clawmessenger-0.1.0-beta.1.tgz',
      files,
    }]));
  };
  await writeReport();
  return { root, entry, report, writeReport };
}

async function platformFixture(): Promise<EntryFixture> {
  const root = await temporaryDirectory();
  const entry = join(root, 'package');
  const report = join(root, 'npm-pack.json');
  const packageName = '@quukk/clawmessenger-runtime-win32-x64';
  const version = '0.1.0-beta.1';
  const packageFiles = PLATFORM_FILES.filter((path) => path !== 'package.json');
  const binary = Buffer.from('safe platform fixture for multica.exe\n');
  for (const path of PLATFORM_FILES) {
    const content = path === 'package.json'
      ? JSON.stringify({
          name: packageName,
          version,
          os: ['win32'],
          cpu: ['x64'],
          files: packageFiles,
        })
      : path === 'manifest.json'
        ? JSON.stringify({
            version,
            goVersion: 'go1.26.6',
            sourceCommit: 'a'.repeat(40),
            sha256: createHash('sha256').update(binary).digest('hex'),
            binary: 'multica.exe',
          })
        : path === 'multica.exe'
          ? binary
        : `safe platform fixture for ${path}\n`;
    await write(join(entry, path), content);
  }
  const writeReport = async (extraPaths: readonly string[] = []): Promise<void> => {
    const paths = [...PLATFORM_FILES, ...extraPaths];
    const files = await Promise.all(paths.map(async (path) => ({
      path,
      size: (await stat(join(entry, ...path.split('/')))).size,
      mode: 0o644,
    })));
    await write(report, JSON.stringify([{
      id: `${packageName}@${version}`,
      name: packageName,
      version,
      filename: 'quukk-clawmessenger-runtime-win32-x64-0.1.0-beta.1.tgz',
      files,
    }]));
  };
  await writeReport();
  return { root, entry, report, writeReport };
}

describe('audit-tarball', () => {
  it('maps missing explicit report arguments to a fixed code', async () => {
    await expect(auditTarball({} as { packJsonPath: string; packageDirectory: string }))
      .rejects.toMatchObject({ code: 'invalid_arguments' });
  });

  it('accepts an exact entry listing with legal files, bin, UI assets, worker, and npm manifest', async () => {
    const fixture = await entryFixture();

    expect(ENTRY_FILES).toHaveLength(100);
    await expect(auditTarball({
      packJsonPath: fixture.report,
      packageDirectory: fixture.entry,
    })).resolves.toEqual({ packageCount: 1, fileCount: ENTRY_FILES.length });
  });

  it.each([
    [
      'a pnpm catalog production dependency',
      { dependencies: { ...ENTRY_DEPENDENCIES, zod: 'catalog:' } },
    ],
    [
      'an unexpected production dependency',
      { dependencies: { ...ENTRY_DEPENDENCIES, payload: '1.0.0' } },
    ],
    [
      'a missing production dependency',
      { dependencies: Object.fromEntries(
        Object.entries(ENTRY_DEPENDENCIES).filter(([name]) => name !== 'zod'),
      ) },
    ],
    [
      'a mismatched platform runtime version',
      { optionalDependencies: {
        ...ENTRY_OPTIONAL_DEPENDENCIES,
        '@quukk/clawmessenger-runtime-linux-x64': '0.1.0-beta.2',
      } },
    ],
    [
      'an incomplete platform runtime set',
      { optionalDependencies: Object.fromEntries(
        Object.entries(ENTRY_OPTIONAL_DEPENDENCIES).filter(
          ([name]) => name !== '@quukk/clawmessenger-runtime-linux-x64',
        ),
      ) },
    ],
    [
      'an unexpected lifecycle script',
      { scripts: { postinstall: 'node payload.js' } },
    ],
    [
      'a mismatched Node engine',
      { engines: { node: '>=18' } },
    ],
    [
      'a latest-tag publish configuration',
      { publishConfig: { access: 'public', provenance: true, tag: 'latest' } },
    ],
    [
      'an unexpected manifest field',
      { payload: '1.0.0' },
    ],
  ])('rejects %s in the entry manifest', async (_label, override) => {
    const fixture = await entryFixture();
    const packageJson = JSON.parse(
      await readFile(join(fixture.entry, 'package.json'), 'utf8'),
    ) as object;
    await writeFile(
      join(fixture.entry, 'package.json'),
      JSON.stringify({ ...packageJson, ...override }),
    );
    await fixture.writeReport();

    await expect(auditTarball({
      packJsonPath: fixture.report,
      packageDirectory: fixture.entry,
    })).rejects.toMatchObject({ code: 'manifest_invalid' });
  });

  it('accepts the exact seven-file scoped platform package contract', async () => {
    const fixture = await platformFixture();

    await expect(auditTarball({
      packJsonPath: fixture.report,
      packageDirectory: fixture.entry,
    })).resolves.toEqual({ packageCount: 1, fileCount: PLATFORM_FILES.length });
  });

  it.each([
    ['README.md', 'unexpected_file'],
    ['THIRD_PARTY_NOTICES.md', 'unexpected_file'],
  ])('rejects platform-only unexpected file %s', async (path, code) => {
    const fixture = await platformFixture();
    await write(join(fixture.entry, path), 'unexpected platform artifact');
    await fixture.writeReport([path]);

    await expect(auditTarball({
      packJsonPath: fixture.report,
      packageDirectory: fixture.entry,
    })).rejects.toMatchObject({ code });
  });

  it.each([
    [{ os: ['linux'] }, 'manifest_invalid'],
    [{ files: ['multica.exe'] }, 'manifest_invalid'],
    [{ private: false }, 'manifest_invalid'],
    [{ scripts: {} }, 'manifest_invalid'],
  ])('rejects an invalid platform package manifest override %j', async (override, code) => {
    const fixture = await platformFixture();
    const packageJson = JSON.parse(await readFile(join(fixture.entry, 'package.json'), 'utf8')) as object;
    await writeFile(join(fixture.entry, 'package.json'), JSON.stringify({ ...packageJson, ...override }));
    await fixture.writeReport();

    await expect(auditTarball({
      packJsonPath: fixture.report,
      packageDirectory: fixture.entry,
    })).rejects.toMatchObject({ code });
  });

  it.each([
    [{ goVersion: 'devel go1.27-deadbeef' }, 'manifest_invalid'],
    [{ sha256: 'b'.repeat(64) }, 'manifest_invalid'],
    [{ unexpected: true }, 'manifest_invalid'],
  ])('rejects an invalid runtime manifest override %j', async (override, code) => {
    const fixture = await platformFixture();
    const manifest = JSON.parse(await readFile(join(fixture.entry, 'manifest.json'), 'utf8')) as object;
    await writeFile(join(fixture.entry, 'manifest.json'), JSON.stringify({ ...manifest, ...override }));
    await fixture.writeReport();

    await expect(auditTarball({
      packJsonPath: fixture.report,
      packageDirectory: fixture.entry,
    })).rejects.toMatchObject({ code });
  });

  it.each([
    'README.md',
    'LICENSE',
    'NOTICE',
    'MODIFICATIONS.md',
    'THIRD_PARTY_NOTICES.md',
    'bin/quukk-clawmessenger.js',
    'dist/cli.js',
    'dist/rongcloud/worker-entry.js',
    'dist/ui/index.html',
    'dist/ui/assets/app-123.js',
    'dist/ui/assets/app-123.css',
  ])('rejects a listing missing required artifact %s', async (missing) => {
    const fixture = await entryFixture();
    const report = JSON.parse(await readFile(fixture.report, 'utf8')) as Array<{
      files: Array<{ path: string; size: number; mode: number }>;
    }>;
    report[0]!.files = report[0]!.files.filter((file) => file.path !== missing);
    await writeFile(fixture.report, JSON.stringify(report));

    await expect(auditTarball({
      packJsonPath: fixture.report,
      packageDirectory: fixture.entry,
    })).rejects.toMatchObject({ code: 'required_file_missing' });
  });

  it.each([
    'dist/index.js',
    'dist/registration/client.js',
    'dist/registration/client.d.ts',
  ])('rejects a listing missing required build artifact %s', async (missing) => {
    const fixture = await entryFixture();
    const report = JSON.parse(await readFile(fixture.report, 'utf8')) as Array<{
      files: Array<{ path: string; size: number; mode: number }>;
    }>;
    report[0]!.files = report[0]!.files.filter((file) => file.path !== missing);
    await writeFile(fixture.report, JSON.stringify(report));

    await expect(auditTarball({
      packJsonPath: fixture.report,
      packageDirectory: fixture.entry,
    })).rejects.toMatchObject({ code: 'required_file_missing' });
  });

  it('maps a malformed npm manifest to a fixed audit code', async () => {
    const fixture = await entryFixture();
    await writeFile(join(fixture.entry, 'package.json'), '{malformed');
    await fixture.writeReport();

    await expect(auditTarball({
      packJsonPath: fixture.report,
      packageDirectory: fixture.entry,
    })).rejects.toMatchObject({ code: 'manifest_invalid' });
  });

  it.each([
    ['dist/service.test.js', 'unexpected_file'],
    ['dist/cli.js.map', 'source_map_rejected'],
  ])('rejects %s with a fixed code', async (path, code) => {
    const fixture = await entryFixture();
    await write(join(fixture.entry, ...path.split('/')), 'unexpected');
    await fixture.writeReport([path]);

    await expect(auditTarball({
      packJsonPath: fixture.report,
      packageDirectory: fixture.entry,
    })).rejects.toMatchObject({ code });
  });

  it.each([
    'const token = "super-secret-value-never-print";',
    'const cwd = "D:\\Users\\developer\\private-project";',
    'const cwd = "/home/developer/private-project";',
    '//# sourceMappingURL=hidden-artifact',
  ])('rejects sensitive or developer-specific generated content without echoing it', async (content) => {
    const fixture = await entryFixture();
    await writeFile(join(fixture.entry, 'dist', 'cli.js'), content);
    await fixture.writeReport();

    await expect(auditTarball({
      packJsonPath: fixture.report,
      packageDirectory: fixture.entry,
    })).rejects.toMatchObject({ code: 'sensitive_content' });
  });

  it('honors explicit checkout roots but does not classify remote URLs as local paths', async () => {
    const fixture = await entryFixture();
    const checkout = resolve(fixture.root, 'external-checkout', 'project');
    await writeFile(join(fixture.entry, 'dist', 'cli.js'), `checkout=${checkout}`);
    await fixture.writeReport();

    await expect(auditTarball({
      packJsonPath: fixture.report,
      packageDirectory: fixture.entry,
      knownCheckoutRoots: [checkout],
    })).rejects.toMatchObject({ code: 'sensitive_content' });

    const urlPath = checkout.replaceAll('\\', '/');
    await writeFile(
      join(fixture.entry, 'dist', 'cli.js'),
      `docs=https://docs.example.invalid/${urlPath}`,
    );
    await fixture.writeReport();
    await expect(auditTarball({
      packJsonPath: fixture.report,
      packageDirectory: fixture.entry,
      knownCheckoutRoots: [checkout],
    })).resolves.toEqual({ packageCount: 1, fileCount: ENTRY_FILES.length });
  });

  it('rejects package checkout ancestors outside user-home conventions', async () => {
    const fixture = await entryFixture();
    await writeFile(join(fixture.entry, 'README.md'), `checkout=${fixture.root}`);
    await fixture.writeReport();

    await expect(auditTarball({
      packJsonPath: fixture.report,
      packageDirectory: fixture.entry,
    })).rejects.toMatchObject({ code: 'sensitive_content' });
  });

  it('allows generic cross-platform path placeholders used by the setup UI', async () => {
    const fixture = await entryFixture();
    await writeFile(
      join(fixture.entry, 'dist', 'cli.js'),
      'const examples = ["C:\\\\work", "/Users/me/work", "/home/user/work"];',
    );
    await fixture.writeReport();

    await expect(auditTarball({
      packJsonPath: fixture.report,
      packageDirectory: fixture.entry,
    })).resolves.toEqual({ packageCount: 1, fileCount: ENTRY_FILES.length });
  });

  it.each([
    ['README.md', resolve(fileURLToPath(new URL('../../..', import.meta.url)))],
    [
      'dist/cli.js',
      resolve(fileURLToPath(new URL('../../..', import.meta.url))).replaceAll('\\', '/'),
    ],
    [
      'dist/cli.js',
      resolve(fileURLToPath(new URL('../../..', import.meta.url))).replaceAll('/', '\\'),
    ],
    [
      'dist/cli.js',
      JSON.stringify(resolve(fileURLToPath(new URL('../../..', import.meta.url)))),
    ],
  ])('rejects the active checkout path in %s without echoing it', async (path, checkout) => {
    const fixture = await entryFixture();
    await writeFile(join(fixture.entry, ...path.split('/')), `checkout=${checkout}`);
    await fixture.writeReport();

    await expect(auditTarball({
      packJsonPath: fixture.report,
      packageDirectory: fixture.entry,
    })).rejects.toMatchObject({ code: 'sensitive_content' });
  });

  it('rejects traversal, duplicate paths, and symlinked package components', async () => {
    const traversal = await entryFixture();
    const traversalReport = JSON.parse(await readFile(traversal.report, 'utf8')) as Array<{
      files: Array<{ path: string; size: number; mode: number }>;
    }>;
    traversalReport[0]!.files.push({ path: '../outside', size: 1, mode: 0o644 });
    await writeFile(traversal.report, JSON.stringify(traversalReport));
    await expect(auditTarball({
      packJsonPath: traversal.report,
      packageDirectory: traversal.entry,
    })).rejects.toMatchObject({ code: 'invalid_pack_path' });

    const duplicate = await entryFixture();
    const duplicateReport = JSON.parse(await readFile(duplicate.report, 'utf8')) as Array<{
      files: Array<{ path: string; size: number; mode: number }>;
    }>;
    duplicateReport[0]!.files.push({ ...duplicateReport[0]!.files[0]! });
    await writeFile(duplicate.report, JSON.stringify(duplicateReport));
    await expect(auditTarball({
      packJsonPath: duplicate.report,
      packageDirectory: duplicate.entry,
    })).rejects.toMatchObject({ code: 'duplicate_pack_path' });

    const linked = await entryFixture();
    const outside = join(linked.root, 'outside-assets');
    await write(join(outside, 'app-123.js'), 'safe fixture');
    await write(join(outside, 'app-123.css'), 'safe fixture');
    await rm(join(linked.entry, 'dist', 'ui', 'assets'), { recursive: true, force: true });
    await symlink(
      outside,
      join(linked.entry, 'dist', 'ui', 'assets'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await linked.writeReport();
    await expect(auditTarball({
      packJsonPath: linked.report,
      packageDirectory: linked.entry,
    })).rejects.toMatchObject({ code: 'symlink_rejected' });
  });

  it('prints only a fixed error code when the executable audit fails', async () => {
    const fixture = await entryFixture();
    const secret = 'super-secret-value-never-print';
    await writeFile(join(fixture.entry, 'dist', 'cli.js'), `const token = "${secret}";`);
    await fixture.writeReport();
    const script = fileURLToPath(new URL('./audit-tarball.mjs', import.meta.url));

    const result = await execute(process.execPath, [script, fixture.report, fixture.entry])
      .then(({ stdout, stderr }) => ({ code: 0, stdout, stderr }))
      .catch((error: { code?: number; stdout?: string; stderr?: string }) => ({
        code: error.code,
        stdout: error.stdout ?? '',
        stderr: error.stderr ?? '',
      }));

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim()).toBe('quukk-clawmessenger audit: sensitive_content');
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
    expect(`${result.stdout}${result.stderr}`).not.toContain(fixture.root);
  });
});
