import {
  readFile,
  writeFile,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  buildRuntime,
  parseBuildArguments,
  runtimeTarget,
  type RuntimeCommandExecutor,
} from './build-clawmessenger-runtime.mjs';
import { verifyRuntimePackage } from './verify-clawmessenger-runtime.mjs';

const VERSION = '0.1.0-beta.5';
const ENTRY_VERSION = '0.1.0-beta.7';
const SOURCE_COMMIT = 'a'.repeat(40);
const MODULES = [
  'github.com/example/common@v1.2.3',
  'github.com/example/windows-only@v4.5.6',
];
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectories: string[] = [];
const PLATFORM_LABELS: Record<string, string> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
};
const EXPECTED_SOURCE_DOCUMENT = [
  '# Source attribution',
  '',
  "This package contains a platform build of Multica's `server/cmd/multica` entrypoint for Quukk ClawMessenger.",
  '',
  '- Fork source: https://github.com/quukk/quukk-clawmessenger',
  '- Upstream source: https://github.com/multica-ai/multica',
  '- Exact source commit, Go toolchain version, linked Go modules, binary filename, and SHA-256: `manifest.json`',
  '- Fork modifications: `MODIFICATIONS.md`',
  '- License and attribution: `LICENSE`, `NOTICE`, and `GO_THIRD_PARTY_NOTICES.md`',
  '',
].join('\n');

async function fixtureRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'quukk-runtime-build-'));
  temporaryDirectories.push(root);
  await mkdir(join(root, 'server', 'cmd', 'multica'), { recursive: true });
  await mkdir(join(root, 'packages', 'quukk-clawmessenger'), { recursive: true });
  const targets = [
    runtimeTarget('win32', 'x64'),
    runtimeTarget('win32', 'arm64'),
    runtimeTarget('darwin', 'x64'),
    runtimeTarget('darwin', 'arm64'),
    runtimeTarget('linux', 'x64'),
    runtimeTarget('linux', 'arm64'),
  ];
  await writeFile(
    join(root, 'GO_THIRD_PARTY_NOTICES.md'),
    `# Go third-party notices\n\n- Go standard library/runtime \`go1.26.6\`\n\n${MODULES.map((module) => `## \`${module}\`\n\nLicense text.\n`).join('\n')}`,
  );
  await writeFile(
    join(root, 'packages', 'quukk-clawmessenger', 'package.json'),
    `${JSON.stringify({
      name: 'quukk-clawmessenger',
      version: ENTRY_VERSION,
      optionalDependencies: Object.fromEntries(
        targets.map((target) => [target.packageName, VERSION]),
      ),
    }, null, 2)}\n`,
  );
  for (const target of targets) {
    const packageDirectory = join(root, 'packages', target.directory);
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(
      join(packageDirectory, 'package.json'),
      `${JSON.stringify({ name: target.packageName, version: VERSION }, null, 2)}\n`,
    );
  }
  return root;
}

async function validRuntimePackage(
  platform = 'win32',
  arch = 'x64',
): Promise<{ root: string; packageDirectory: string }> {
  const root = await fixtureRepository();
  const target = runtimeTarget(platform, arch);
  const packageDirectory = join(root, 'packages', target.directory);
  const files = [
    target.binary,
    'manifest.json',
    'LICENSE',
    'NOTICE',
    'MODIFICATIONS.md',
    'GO_THIRD_PARTY_NOTICES.md',
    'SOURCE.md',
    'README.md',
  ];
  await writeFile(
    join(packageDirectory, 'package.json'),
    `${JSON.stringify(
      {
        name: target.packageName,
        version: VERSION,
        description: `Multica Bridge runtime for Quukk ClawMessenger on ${PLATFORM_LABELS[platform]} ${arch}`,
        license: 'SEE LICENSE IN LICENSE',
        repository: {
          type: 'git',
          url: 'git+https://github.com/quukk/quukk-clawmessenger.git',
          directory: `packages/${target.directory}`,
        },
        bugs: { url: 'https://github.com/quukk/quukk-clawmessenger/issues' },
        homepage: `https://github.com/quukk/quukk-clawmessenger/tree/main/packages/${target.directory}#readme`,
        files,
        os: [platform],
        cpu: [arch],
        publishConfig: {
          access: 'public',
          provenance: true,
        },
      },
      null,
      2,
    )}\n`,
  );
  for (const name of ['LICENSE', 'NOTICE', 'MODIFICATIONS.md', 'GO_THIRD_PARTY_NOTICES.md']) {
    const bytes = name === 'GO_THIRD_PARTY_NOTICES.md'
      ? await readFile(join(root, name))
      : `root-${name}\n`;
    await writeFile(join(root, name), bytes);
    await writeFile(join(packageDirectory, name), bytes);
  }
  await writeFile(
    join(packageDirectory, 'SOURCE.md'),
    EXPECTED_SOURCE_DOCUMENT,
  );
  await writeFile(
    join(packageDirectory, 'README.md'),
    `# ${target.packageName}\n\nInstall quukk-clawmessenger instead.\n`,
  );
  await writeFile(join(packageDirectory, target.binary), 'tiny-runtime');
  await writeFile(
    join(packageDirectory, 'manifest.json'),
    `${JSON.stringify(
      {
        version: VERSION,
        goVersion: 'go1.26.6',
        sourceCommit: SOURCE_COMMIT,
        modules: MODULES,
        sha256: '24b177832d55e5d95f2aad204a2d6575ebdf1deca301df7df25ce55cf90f5530',
        binary: target.binary,
      },
      null,
      2,
    )}\n`,
  );
  return { root, packageDirectory };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('runtime build target selection', () => {
  it('maps only the six supported npm and Go target pairs', () => {
    expect([
      runtimeTarget('win32', 'x64'),
      runtimeTarget('win32', 'arm64'),
      runtimeTarget('darwin', 'x64'),
      runtimeTarget('darwin', 'arm64'),
      runtimeTarget('linux', 'x64'),
      runtimeTarget('linux', 'arm64'),
    ]).toEqual([
      {
        platform: 'win32',
        arch: 'x64',
        goos: 'windows',
        goarch: 'amd64',
        binary: 'multica.exe',
        directory: 'quukk-clawmessenger-runtime-win32-x64',
        packageName: '@quukk/clawmessenger-runtime-win32-x64',
      },
      {
        platform: 'win32',
        arch: 'arm64',
        goos: 'windows',
        goarch: 'arm64',
        binary: 'multica.exe',
        directory: 'quukk-clawmessenger-runtime-win32-arm64',
        packageName: '@quukk/clawmessenger-runtime-win32-arm64',
      },
      {
        platform: 'darwin',
        arch: 'x64',
        goos: 'darwin',
        goarch: 'amd64',
        binary: 'multica',
        directory: 'quukk-clawmessenger-runtime-darwin-x64',
        packageName: '@quukk/clawmessenger-runtime-darwin-x64',
      },
      {
        platform: 'darwin',
        arch: 'arm64',
        goos: 'darwin',
        goarch: 'arm64',
        binary: 'multica',
        directory: 'quukk-clawmessenger-runtime-darwin-arm64',
        packageName: '@quukk/clawmessenger-runtime-darwin-arm64',
      },
      {
        platform: 'linux',
        arch: 'x64',
        goos: 'linux',
        goarch: 'amd64',
        binary: 'multica',
        directory: 'quukk-clawmessenger-runtime-linux-x64',
        packageName: '@quukk/clawmessenger-runtime-linux-x64',
      },
      {
        platform: 'linux',
        arch: 'arm64',
        goos: 'linux',
        goarch: 'arm64',
        binary: 'multica',
        directory: 'quukk-clawmessenger-runtime-linux-arm64',
        packageName: '@quukk/clawmessenger-runtime-linux-arm64',
      },
    ]);
    expect(() => runtimeTarget('freebsd', 'x64')).toThrow('unsupported runtime target');
    expect(() => runtimeTarget('linux', 'ia32')).toThrow('unsupported runtime target');
  });

  it('requires one exact platform and architecture argument', () => {
    expect(parseBuildArguments(['--platform', 'win32', '--arch', 'x64'])).toEqual({
      platform: 'win32',
      arch: 'x64',
    });
    for (const argv of [
      [],
      ['--platform', 'win32'],
      ['--arch', 'x64'],
      ['--platform=win32', '--arch=x64'],
      ['--platform', 'win32', '--platform', 'linux', '--arch', 'x64'],
      ['--platform', 'linux', '--arch', 'x64', '--output', '..'],
    ]) {
      expect(() => parseBuildArguments(argv), argv.join(' ')).toThrow('usage:');
    }
  });
});

describe('buildRuntime', () => {
  it('uses shell-free reproducible Go argv and writes a measured manifest inside the package', async () => {
    const root = await fixtureRepository();
    const calls: Array<{
      file: string;
      args: readonly string[];
      options: { cwd: string; env: NodeJS.ProcessEnv; shell: false };
    }> = [];
    const execute = vi.fn<RuntimeCommandExecutor>(async (file, args, options) => {
      calls.push({ file, args: [...args], options });
      if (file === 'go' && args.length === 1 && args[0] === 'version') {
        return { stdout: 'go version go1.26.6 windows/amd64\n', stderr: '' };
      }
      if (file === 'git' && args[0] === 'rev-parse') {
        return { stdout: `${SOURCE_COMMIT}\n`, stderr: '' };
      }
      if (file === 'git' && args[0] === 'show') {
        return { stdout: '2026-08-27T20:34:56+08:00\n', stderr: '' };
      }
      if (file === 'go' && args[0] === 'build') {
        const outputIndex = args.indexOf('-o');
        await writeFile(args[outputIndex + 1], 'tiny-runtime');
        return { stdout: '', stderr: '' };
      }
      if (file === 'go' && args[0] === 'version' && args[1] === '-m') {
        return {
          stdout: [
            args[2],
            '\tgo\tgo1.26.6',
            ...MODULES.map((module) => {
              const separator = module.lastIndexOf('@');
              return `\tdep\t${module.slice(0, separator)}\t${module.slice(separator + 1)}\th1:test`;
            }),
            '',
          ].join('\n'),
          stderr: '',
        };
      }
      throw new Error(`unexpected command: ${file} ${args.join(' ')}`);
    });

    const result = await buildRuntime({
      repoRoot: root,
      platform: 'win32',
      arch: 'x64',
      env: {
        PATH: process.env.PATH,
        SystemRoot: 'C:\\Windows',
        TEMP: 'D:\\task-cache\\tmp',
        GOCACHE: 'D:\\task-cache\\go-build',
        GOMODCACHE: 'D:\\task-cache\\go-mod',
        GOPATH: 'D:\\task-cache\\go-path',
        GOENV: 'D:\\user-go-env',
        GOFLAGS: '-race',
        GOAMD64: 'v3',
        GOWORK: 'D:\\rogue\\go.work',
        GOTOOLCHAIN: 'auto',
        GOEXPERIMENT: 'arenas',
        GOFIPS140: 'latest',
        GODEBUG: 'gotypesalias=0',
        GOPPC64: 'power10',
        CGO_CFLAGS: '-DROGUE_BUILD=1',
        CGO_LDFLAGS: '-lrogue',
        CC: 'rogue-cc',
        SOURCE_DATE_EPOCH: '1',
      },
      execute,
    });

    const expectedRoot = await realpath(root);
    const expectedDirectory = join(
      expectedRoot,
      'packages',
      'quukk-clawmessenger-runtime-win32-x64',
    );
    expect(result).toEqual({
      packageDirectory: expectedDirectory,
      binaryPath: join(expectedDirectory, 'multica.exe'),
      manifest: {
        version: VERSION,
        goVersion: 'go1.26.6',
        sourceCommit: SOURCE_COMMIT,
        modules: MODULES,
        sha256: '24b177832d55e5d95f2aad204a2d6575ebdf1deca301df7df25ce55cf90f5530',
        binary: 'multica.exe',
      },
    });
    await expect(readFile(join(expectedDirectory, 'manifest.json'), 'utf8')).resolves.toBe(
      `${JSON.stringify(result.manifest, null, 2)}\n`,
    );
    await expect(readFile(join(expectedDirectory, 'SOURCE.md'), 'utf8')).resolves.toBe(
      EXPECTED_SOURCE_DOCUMENT,
    );

    const build = calls.find(({ file, args }) => file === 'go' && args[0] === 'build');
    const expectedBuildEnvironment = {
      PATH: process.env.PATH,
      SystemRoot: 'C:\\Windows',
      TEMP: 'D:\\task-cache\\tmp',
      GOCACHE: 'D:\\task-cache\\go-build',
      GOMODCACHE: 'D:\\task-cache\\go-mod',
      GOPATH: 'D:\\task-cache\\go-path',
      CGO_ENABLED: '0',
      GOENV: 'off',
      GOFLAGS: '',
      GOWORK: 'off',
      GOTOOLCHAIN: 'local',
      GOEXPERIMENT: '',
      GOFIPS140: 'off',
      GODEBUG: '',
      GOOS: 'windows',
      GOARCH: 'amd64',
      GOAMD64: 'v1',
    };
    expect(build).toEqual({
      file: 'go',
      args: [
        'build',
        '-trimpath',
        '-buildvcs=false',
        '-ldflags',
        `-s -w -X main.version=${VERSION} -X main.commit=${SOURCE_COMMIT} -X main.date=2026-08-27T12:34:56Z`,
        '-o',
        join(expectedDirectory, 'multica.exe'),
        './cmd/multica',
      ],
      options: expect.objectContaining({
        cwd: join(expectedRoot, 'server'),
        shell: false,
        env: expectedBuildEnvironment,
      }),
    });
    expect(calls.every(({ options }) => options.shell === false)).toBe(true);
    for (const { options } of calls) expect(options.env).toEqual(expectedBuildEnvironment);
  });

  it('rejects missing or mixed entry runtime dependency pins before invoking Go', async () => {
    for (const mutate of [
      (dependencies: Record<string, string>) => {
        delete dependencies['@quukk/clawmessenger-runtime-linux-arm64'];
      },
      (dependencies: Record<string, string>) => {
        dependencies['@quukk/clawmessenger-runtime-linux-arm64'] = '0.1.0-beta.4';
      },
    ]) {
      const root = await fixtureRepository();
      const entryPath = join(root, 'packages', 'quukk-clawmessenger', 'package.json');
      const entryPackage = JSON.parse(await readFile(entryPath, 'utf8')) as {
        optionalDependencies: Record<string, string>;
      };
      mutate(entryPackage.optionalDependencies);
      await writeFile(entryPath, JSON.stringify(entryPackage));
      const execute = vi.fn<RuntimeCommandExecutor>();

      await expect(
        buildRuntime({ repoRoot: root, platform: 'win32', arch: 'x64', execute }),
      ).rejects.toThrow(/runtime dependency pins/);
      expect(execute).not.toHaveBeenCalled();
    }
  });

  it('rejects a package path redirected outside the repository before invoking Go', async () => {
    const root = await fixtureRepository();
    const outside = await mkdtemp(join(tmpdir(), 'quukk-runtime-outside-'));
    temporaryDirectories.push(outside);
    const targetDirectory = join(
      root,
      'packages',
      'quukk-clawmessenger-runtime-win32-x64',
    );
    await rm(targetDirectory, { recursive: true, force: true });
    const { symlink } = await import('node:fs/promises');
    await symlink(outside, targetDirectory, 'junction');
    const execute = vi.fn<RuntimeCommandExecutor>();

    await expect(
      buildRuntime({ repoRoot: root, platform: 'win32', arch: 'x64', execute }),
    ).rejects.toThrow('outside repository package directory');
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects a repository packages directory redirected outside the repository', async () => {
    const root = await fixtureRepository();
    const outsideParent = await mkdtemp(join(tmpdir(), 'quukk-runtime-packages-'));
    temporaryDirectories.push(outsideParent);
    const outsidePackages = join(outsideParent, 'packages');
    await rename(join(root, 'packages'), outsidePackages);
    await symlink(outsidePackages, join(root, 'packages'), 'junction');
    const execute = vi.fn<RuntimeCommandExecutor>();

    await expect(
      buildRuntime({ repoRoot: root, platform: 'win32', arch: 'x64', execute }),
    ).rejects.toThrow('repository packages directory');
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects a pre-existing output symlink before invoking Go', async () => {
    const root = await fixtureRepository();
    const outside = await mkdtemp(join(tmpdir(), 'quukk-runtime-output-'));
    temporaryDirectories.push(outside);
    await symlink(
      outside,
      join(
        root,
        'packages',
        'quukk-clawmessenger-runtime-win32-x64',
        'multica.exe',
      ),
      'junction',
    );
    const execute = vi.fn<RuntimeCommandExecutor>();

    await expect(
      buildRuntime({ repoRoot: root, platform: 'win32', arch: 'x64', execute }),
    ).rejects.toThrow('runtime output path');
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects unrecognized toolchain and non-full source identities before build output', async () => {
    const cases = [
      { go: 'go version devel go1.27-deadbeef windows/amd64\n', commit: SOURCE_COMMIT },
      { go: 'go version go1.26.6 windows/amd64\n', commit: 'abc123' },
    ];
    for (const testCase of cases) {
      const root = await fixtureRepository();
      const execute = vi.fn<RuntimeCommandExecutor>(async (file, args) => {
        if (file === 'go' && args[0] === 'version') {
          return { stdout: testCase.go, stderr: '' };
        }
        if (file === 'git' && args[0] === 'rev-parse') {
          return { stdout: `${testCase.commit}\n`, stderr: '' };
        }
        if (file === 'git' && args[0] === 'show') {
          return { stdout: '2026-08-27T12:34:56Z\n', stderr: '' };
        }
        throw new Error('build must not execute');
      });
      await expect(
        buildRuntime({ repoRoot: root, platform: 'win32', arch: 'x64', execute }),
      ).rejects.toThrow(/Go version|source commit/);
      expect(
        execute.mock.calls.some(([file, args]) => file === 'go' && args[0] === 'build'),
      ).toBe(false);
    }
  });

  it('rejects a package version that could alter Go linker arguments', async () => {
    const root = await fixtureRepository();
    const unsafeVersion = '0.1.0 -X main.commit=forged';
    for (const path of [
      join(root, 'packages', 'quukk-clawmessenger', 'package.json'),
      join(root, 'packages', 'quukk-clawmessenger-runtime-win32-x64', 'package.json'),
    ]) {
      const packageJson = JSON.parse(await readFile(path, 'utf8'));
      packageJson.version = unsafeVersion;
      await writeFile(path, JSON.stringify(packageJson));
    }
    const execute = vi.fn<RuntimeCommandExecutor>();
    await expect(
      buildRuntime({ repoRoot: root, platform: 'win32', arch: 'x64', execute }),
    ).rejects.toThrow(/package version/);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('verifyRuntimePackage', () => {
  it('accepts an exact package whose binary, manifest, platform metadata, and legal files agree', async () => {
    const { root, packageDirectory } = await validRuntimePackage();
    await expect(verifyRuntimePackage(packageDirectory, { repoRoot: root })).resolves.toEqual({
      packageName: '@quukk/clawmessenger-runtime-win32-x64',
      platform: 'win32',
      arch: 'x64',
      version: VERSION,
      binary: 'multica.exe',
      sha256: '24b177832d55e5d95f2aad204a2d6575ebdf1deca301df7df25ce55cf90f5530',
      sourceCommit: SOURCE_COMMIT,
      goVersion: 'go1.26.6',
      modules: MODULES,
    });
  });

  it('rejects a runtime package when the entry dependency pins are mixed', async () => {
    const { root, packageDirectory } = await validRuntimePackage();
    const entryPath = join(root, 'packages', 'quukk-clawmessenger', 'package.json');
    const entryPackage = JSON.parse(await readFile(entryPath, 'utf8')) as {
      optionalDependencies: Record<string, string>;
    };
    entryPackage.optionalDependencies['@quukk/clawmessenger-runtime-linux-arm64'] =
      '0.1.0-beta.4';
    await writeFile(entryPath, JSON.stringify(entryPackage));

    await expect(
      verifyRuntimePackage(packageDirectory, { repoRoot: root }),
    ).rejects.toThrow(/runtime dependency pins/);
  });

  it('rejects malformed provenance and a digest that is not the packaged binary', async () => {
    const cases: Array<{
      name: string;
      mutate: (packageDirectory: string) => Promise<void>;
      error: RegExp;
    }> = [
      {
        name: 'short source identity',
        mutate: async (packageDirectory) => {
          const manifest = JSON.parse(
            await readFile(join(packageDirectory, 'manifest.json'), 'utf8'),
          );
          manifest.sourceCommit = 'abc123';
          await writeFile(join(packageDirectory, 'manifest.json'), JSON.stringify(manifest));
        },
        error: /source commit/,
      },
      {
        name: 'development Go version',
        mutate: async (packageDirectory) => {
          const manifest = JSON.parse(
            await readFile(join(packageDirectory, 'manifest.json'), 'utf8'),
          );
          manifest.goVersion = 'devel go1.27-deadbeef';
          await writeFile(join(packageDirectory, 'manifest.json'), JSON.stringify(manifest));
        },
        error: /Go version/,
      },
      {
        name: 'unknown manifest field',
        mutate: async (packageDirectory) => {
          const manifest = JSON.parse(
            await readFile(join(packageDirectory, 'manifest.json'), 'utf8'),
          );
          manifest.download = 'https://example.invalid/binary';
          await writeFile(join(packageDirectory, 'manifest.json'), JSON.stringify(manifest));
        },
        error: /manifest fields/,
      },
      {
        name: 'path-like binary name',
        mutate: async (packageDirectory) => {
          const manifest = JSON.parse(
            await readFile(join(packageDirectory, 'manifest.json'), 'utf8'),
          );
          manifest.binary = '../multica.exe';
          await writeFile(join(packageDirectory, 'manifest.json'), JSON.stringify(manifest));
        },
        error: /binary filename/,
      },
      {
        name: 'tampered binary',
        mutate: async (packageDirectory) => {
          await writeFile(join(packageDirectory, 'multica.exe'), 'different');
        },
        error: /SHA-256/,
      },
    ];

    for (const testCase of cases) {
      const { root, packageDirectory } = await validRuntimePackage();
      await testCase.mutate(packageDirectory);
      await expect(
        verifyRuntimePackage(packageDirectory, { repoRoot: root }),
        testCase.name,
      ).rejects.toThrow(testCase.error);
    }
  });

  it('rejects drift in every canonical runtime package metadata field', async () => {
    const mutations: Array<[string, (manifest: Record<string, unknown>) => void]> = [
      ['name', (value) => { value.name = '@quukk/wrong'; }],
      ['version', (value) => { value.version = '9.9.9'; }],
      ['description', (value) => { value.description = 'replacement runtime'; }],
      ['license', (value) => { value.license = 'MIT'; }],
      ['repository URL', (value) => {
        value.repository = {
          type: 'git',
          url: 'git+https://github.com/example/wrong.git',
          directory: 'packages/quukk-clawmessenger-runtime-win32-x64',
        };
      }],
      ['repository directory', (value) => {
        value.repository = {
          type: 'git',
          url: 'git+https://github.com/quukk/quukk-clawmessenger.git',
          directory: 'packages/wrong',
        };
      }],
      ['bugs', (value) => { value.bugs = { url: 'https://example.invalid/issues' }; }],
      ['homepage', (value) => { value.homepage = 'https://example.invalid'; }],
      ['os', (value) => { value.os = ['linux']; }],
      ['cpu', (value) => { value.cpu = ['arm64']; }],
      ['files', (value) => { value.files = ['multica.exe']; }],
      ['publishConfig access', (value) => {
        value.publishConfig = { access: 'restricted', provenance: true };
      }],
      ['publishConfig provenance', (value) => {
        value.publishConfig = { access: 'public', provenance: false };
      }],
    ];
    for (const [name, mutate] of mutations) {
      const { root, packageDirectory } = await validRuntimePackage();
      const packageJson = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'));
      mutate(packageJson);
      await writeFile(join(packageDirectory, 'package.json'), JSON.stringify(packageJson));
      await expect(
        verifyRuntimePackage(packageDirectory, { repoRoot: root }),
        name,
      ).rejects.toThrow(/package/);
    }
  });

  it('rejects every field outside the exact runtime package metadata schema', async () => {
    const additions: Array<[string, unknown]> = [
      ['dependencies', { payload: '1.0.0' }],
      ['optionalDependencies', { payload: '1.0.0' }],
      ['peerDependencies', { payload: '1.0.0' }],
      ['devDependencies', { payload: '1.0.0' }],
      ['bin', { payload: 'install.js' }],
      ['main', 'install.js'],
      ['module', 'install.mjs'],
      ['exports', './install.js'],
      ['scripts', { postinstall: 'node install.js' }],
      ['config', { executable: 'install.js' }],
      ['private', false],
      ['x-unknown', 'unexpected'],
    ];
    for (const [field, value] of additions) {
      const { root, packageDirectory } = await validRuntimePackage();
      const packageJson = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'));
      packageJson[field] = value;
      await writeFile(join(packageDirectory, 'package.json'), JSON.stringify(packageJson));
      await expect(
        verifyRuntimePackage(packageDirectory, { repoRoot: root }),
        field,
      ).rejects.toThrow(/package metadata/);
    }
  });

  it('rejects a mutually matching package and manifest version that is not SemVer', async () => {
    const { root, packageDirectory } = await validRuntimePackage();
    const unsafeVersion = '0.1.0 -X main.commit=forged';
    for (const path of [
      join(root, 'packages', 'quukk-clawmessenger', 'package.json'),
      join(packageDirectory, 'package.json'),
      join(packageDirectory, 'manifest.json'),
    ]) {
      const value = JSON.parse(await readFile(path, 'utf8'));
      value.version = unsafeVersion;
      await writeFile(path, JSON.stringify(value));
    }
    await expect(
      verifyRuntimePackage(packageDirectory, { repoRoot: root }),
    ).rejects.toThrow(/package version/);
  });

  it('requires byte-identical root legal files and source attribution', async () => {
    const legal = await validRuntimePackage();
    await writeFile(join(legal.packageDirectory, 'NOTICE'), 'edited notice\n');
    await expect(
      verifyRuntimePackage(legal.packageDirectory, { repoRoot: legal.root }),
    ).rejects.toThrow(/legal file/);

    const source = await validRuntimePackage();
    await writeFile(join(source.packageDirectory, 'SOURCE.md'), '# Source\n');
    await expect(
      verifyRuntimePackage(source.packageDirectory, { repoRoot: source.root }),
    ).rejects.toThrow(/source attribution/);
  });

  it('rejects a linked Go module that is absent from the packaged notices', async () => {
    const { root, packageDirectory } = await validRuntimePackage();
    const incomplete = '# Go third-party notices\n\n- Go standard library/runtime `go1.26.6`\n';
    await writeFile(join(root, 'GO_THIRD_PARTY_NOTICES.md'), incomplete);
    await writeFile(join(packageDirectory, 'GO_THIRD_PARTY_NOTICES.md'), incomplete);

    await expect(
      verifyRuntimePackage(packageDirectory, { repoRoot: root }),
    ).rejects.toThrow(/Go module.*third-party notices/);
  });

  it('rejects notices that omit the exact Go runtime version', async () => {
    const { root, packageDirectory } = await validRuntimePackage();
    const modulesOnly = MODULES.map((module) => `- \`${module}\``).join('\n');
    await writeFile(join(root, 'GO_THIRD_PARTY_NOTICES.md'), modulesOnly);
    await writeFile(join(packageDirectory, 'GO_THIRD_PARTY_NOTICES.md'), modulesOnly);

    await expect(
      verifyRuntimePackage(packageDirectory, { repoRoot: root }),
    ).rejects.toThrow(/Go runtime.*third-party notices/);
  });

  it('requires the exact canonical source document instead of matching attribution substrings', async () => {
    const { root, packageDirectory } = await validRuntimePackage();
    await writeFile(
      join(packageDirectory, 'SOURCE.md'),
      'Forged package from https://github.com/multica-ai/multica using server/cmd/multica.\n',
    );
    await expect(
      verifyRuntimePackage(packageDirectory, { repoRoot: root }),
    ).rejects.toThrow(/source attribution/);
  });

  it('rejects redirected package paths, symlinks, and unexpected binaries', async () => {
    const redirected = await validRuntimePackage();
    const outsideParent = await mkdtemp(join(tmpdir(), 'quukk-runtime-redirect-'));
    temporaryDirectories.push(outsideParent);
    const outsidePackage = join(outsideParent, 'package');
    await rename(redirected.packageDirectory, outsidePackage);
    await symlink(outsidePackage, redirected.packageDirectory, 'junction');
    await expect(
      verifyRuntimePackage(redirected.packageDirectory, { repoRoot: redirected.root }),
    ).rejects.toThrow(/symlink|outside/);

    const unexpected = await validRuntimePackage();
    await writeFile(join(unexpected.packageDirectory, 'multica'), 'second binary');
    await expect(
      verifyRuntimePackage(unexpected.packageDirectory, { repoRoot: unexpected.root }),
    ).rejects.toThrow(/unexpected package entry/);

    const arbitrary = await validRuntimePackage();
    await expect(
      verifyRuntimePackage(arbitrary.root, { repoRoot: arbitrary.root }),
    ).rejects.toThrow(/outside supported runtime package/);
  });

  it('rejects a repository packages directory redirected outside the repository', async () => {
    const redirected = await validRuntimePackage();
    const outsideParent = await mkdtemp(join(tmpdir(), 'quukk-runtime-verify-packages-'));
    temporaryDirectories.push(outsideParent);
    const outsidePackages = join(outsideParent, 'packages');
    await rename(join(redirected.root, 'packages'), outsidePackages);
    await symlink(outsidePackages, join(redirected.root, 'packages'), 'junction');
    const outsidePackage = join(
      outsidePackages,
      'quukk-clawmessenger-runtime-win32-x64',
    );

    await expect(
      verifyRuntimePackage(outsidePackage, { repoRoot: redirected.root }),
    ).rejects.toThrow(/repository packages directory/);
  });
});

describe('published runtime package metadata', () => {
  it('pins the public entry package to the patched ws release', async () => {
    const entryPackage = JSON.parse(
      await readFile(join(REPO_ROOT, 'packages', 'quukk-clawmessenger', 'package.json'), 'utf8'),
    );

    expect(entryPackage.dependencies.ws).toBe('8.21.0');
  });

  it('keeps every platform runtime pinned in the cross-platform lockfile importer', async () => {
    const lockfile = parseYaml(await readFile(join(REPO_ROOT, 'pnpm-lock.yaml'), 'utf8')) as {
      importers?: Record<string, {
        optionalDependencies?: Record<string, { specifier?: string }>;
      }>;
    };
    const optionalDependencies = lockfile.importers?.['packages/quukk-clawmessenger']
      ?.optionalDependencies;
    const targets = [
      runtimeTarget('win32', 'x64'),
      runtimeTarget('win32', 'arm64'),
      runtimeTarget('darwin', 'x64'),
      runtimeTarget('darwin', 'arm64'),
      runtimeTarget('linux', 'x64'),
      runtimeTarget('linux', 'arm64'),
    ];

    expect(optionalDependencies).toEqual(Object.fromEntries(
      targets.map((target) => [target.packageName, {
        specifier: VERSION,
        version: `link:../${target.directory}`,
      }]),
    ));
  });

  it('pins the entry and all six optional platform packages to their release versions', async () => {
    const entryPackage = JSON.parse(
      await readFile(join(REPO_ROOT, 'packages', 'quukk-clawmessenger', 'package.json'), 'utf8'),
    );
    const targets = [
      runtimeTarget('win32', 'x64'),
      runtimeTarget('win32', 'arm64'),
      runtimeTarget('darwin', 'x64'),
      runtimeTarget('darwin', 'arm64'),
      runtimeTarget('linux', 'x64'),
      runtimeTarget('linux', 'arm64'),
    ];
    expect(entryPackage.version).toBe(ENTRY_VERSION);
    expect(entryPackage.optionalDependencies).toEqual(
      Object.fromEntries(targets.map((target) => [target.packageName, VERSION])),
    );
    expect(entryPackage.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/quukk/quukk-clawmessenger.git',
      directory: 'packages/quukk-clawmessenger',
    });

    for (const target of targets) {
      const packageDirectory = join(REPO_ROOT, 'packages', target.directory);
      const packageJson = JSON.parse(
        await readFile(join(packageDirectory, 'package.json'), 'utf8'),
      );
      expect(packageJson, target.packageName).toMatchObject({
        name: target.packageName,
        version: VERSION,
        license: 'SEE LICENSE IN LICENSE',
        repository: {
          type: 'git',
          url: 'git+https://github.com/quukk/quukk-clawmessenger.git',
          directory: `packages/${target.directory}`,
        },
        bugs: { url: 'https://github.com/quukk/quukk-clawmessenger/issues' },
        homepage: `https://github.com/quukk/quukk-clawmessenger/tree/main/packages/${target.directory}#readme`,
        os: [target.platform],
        cpu: [target.arch],
        files: [
          target.binary,
          'manifest.json',
          'LICENSE',
          'NOTICE',
          'MODIFICATIONS.md',
          'GO_THIRD_PARTY_NOTICES.md',
          'SOURCE.md',
          'README.md',
        ],
      });
      expect(packageJson.scripts, target.packageName).toBeUndefined();
      for (const legalFile of ['LICENSE', 'NOTICE', 'MODIFICATIONS.md', 'GO_THIRD_PARTY_NOTICES.md']) {
        await expect(readFile(join(packageDirectory, legalFile))).resolves.toEqual(
          await readFile(join(REPO_ROOT, legalFile)),
        );
      }
      const source = await readFile(join(packageDirectory, 'SOURCE.md'));
      expect(source).toEqual(Buffer.from(EXPECTED_SOURCE_DOCUMENT));
      await expect(readFile(join(packageDirectory, 'README.md'), 'utf8')).resolves.toContain(
        'npm install --global quukk-clawmessenger@beta',
      );
    }
  });
});
