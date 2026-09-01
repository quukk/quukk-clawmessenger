import { join, resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  BridgeBinaryError,
  bridgeRuntimePackage,
  resolveBridgeBinary,
  type BridgeBinaryDependencies,
} from './binary.js';

const version = '0.1.0-beta.1';
const abcSHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version,
    goVersion: 'go1.26.6',
    sourceCommit: 'a'.repeat(40),
    sha256: abcSHA256,
    binary: 'multica.exe',
    modules: [
      'github.com/go-chi/chi/v5@v5.3.0',
      'github.com/gorilla/websocket@v1.5.3',
    ],
    ...overrides,
  };
}

function dependencies(overrides: Partial<BridgeBinaryDependencies> = {}): BridgeBinaryDependencies {
  return {
    platform: 'win32',
    arch: 'x64',
    expectedVersion: version,
    resolvePackageRoot: async () => ({ root: 'D:\\fixture\\runtime', packageVersion: version }),
    readFile: async () => Buffer.from(JSON.stringify(manifest())),
    stat: async () => ({ isFile: () => true }),
    readBinary: () =>
      (async function* () {
        yield Buffer.from('a');
        yield Buffer.from('bc');
      })(),
    ...overrides,
  };
}

describe('bridgeRuntimePackage', () => {
  it('maps exactly the six supported platform and architecture pairs', () => {
    expect([
      bridgeRuntimePackage('win32', 'x64'),
      bridgeRuntimePackage('win32', 'arm64'),
      bridgeRuntimePackage('darwin', 'x64'),
      bridgeRuntimePackage('darwin', 'arm64'),
      bridgeRuntimePackage('linux', 'x64'),
      bridgeRuntimePackage('linux', 'arm64'),
    ]).toEqual([
      { packageName: '@quukk/clawmessenger-runtime-win32-x64', binary: 'multica.exe' },
      { packageName: '@quukk/clawmessenger-runtime-win32-arm64', binary: 'multica.exe' },
      { packageName: '@quukk/clawmessenger-runtime-darwin-x64', binary: 'multica' },
      { packageName: '@quukk/clawmessenger-runtime-darwin-arm64', binary: 'multica' },
      { packageName: '@quukk/clawmessenger-runtime-linux-x64', binary: 'multica' },
      { packageName: '@quukk/clawmessenger-runtime-linux-arm64', binary: 'multica' },
    ]);
  });

  it('rejects unsupported pairs before package resolution', async () => {
    const resolvePackageRoot = vi.fn<BridgeBinaryDependencies['resolvePackageRoot']>();
    expect(() => bridgeRuntimePackage('freebsd', 'x64')).toThrowError(
      expect.objectContaining({ code: 'unsupported_platform' }),
    );
    await expect(
      resolveBridgeBinary(
        dependencies({ platform: 'linux', arch: 'ia32', resolvePackageRoot }),
      ),
    ).rejects.toMatchObject({ code: 'unsupported_platform' });
    expect(resolvePackageRoot).not.toHaveBeenCalled();
  });
});

describe('resolveBridgeBinary', () => {
  it('accepts the generated runtime manifest including its Go module inventory', async () => {
    await expect(resolveBridgeBinary(dependencies())).resolves.toMatchObject({
      version,
      sha256: abcSHA256,
    });
  });

  it.each([
    ['an empty', []],
    ['an oversized', Array.from({ length: 257 }, (_, index) => `example.com/module${index}@v1.0.0`)],
    ['a malformed', ['github.com/go-chi/chi/v5@5.3.0']],
  ])('rejects %s Go module inventory', async (_name, modules) => {
    await expect(
      resolveBridgeBinary(
        dependencies({
          readFile: async () => Buffer.from(JSON.stringify(manifest({ modules }))),
        }),
      ),
    ).rejects.toMatchObject({ code: 'manifest_invalid' });
  });

  it('strictly validates package metadata and manifest fields', async () => {
    const invalid: Array<[string, Partial<BridgeBinaryDependencies>]> = [
      ['missing package', { resolvePackageRoot: async () => { throw new Error('path-sentinel'); } }],
      ['package version', { resolvePackageRoot: async () => ({ root: 'D:\\fixture', packageVersion: '9.9.9' }) }],
      ['malformed manifest', { readFile: async () => Buffer.from('{') }],
      ['oversize manifest', { readFile: async () => Buffer.alloc((64 << 10) + 1, 0x20) }],
      ['unknown field', { readFile: async () => Buffer.from(JSON.stringify(manifest({ extra: true }))) }],
      ['manifest version', { readFile: async () => Buffer.from(JSON.stringify(manifest({ version: '9.9.9' }))) }],
      ['filename', { readFile: async () => Buffer.from(JSON.stringify(manifest({ binary: '../multica.exe' }))) }],
      ['source commit', { readFile: async () => Buffer.from(JSON.stringify(manifest({ sourceCommit: 'abc' }))) }],
      ['go version', { readFile: async () => Buffer.from(JSON.stringify(manifest({ goVersion: 'devel' }))) }],
      ['digest shape', { readFile: async () => Buffer.from(JSON.stringify(manifest({ sha256: 'A'.repeat(64) }))) }],
    ];
    for (const [name, override] of invalid) {
      const error = (await resolveBridgeBinary(dependencies(override)).catch(
        (caught: unknown) => caught,
      )) as BridgeBinaryError;
      expect(error, name).toBeInstanceOf(BridgeBinaryError);
      expect(error.code, name).not.toBe('binary_hash_mismatch');
      expect(error.message, name).not.toContain('path-sentinel');
    }
  });

  it('rejects non-files and a digest mismatch without executing anything', async () => {
    await expect(
      resolveBridgeBinary(dependencies({ stat: async () => ({ isFile: () => false }) })),
    ).rejects.toMatchObject({ code: 'binary_not_file' });
    await expect(
      resolveBridgeBinary(
        dependencies({
          readBinary: () =>
            (async function* () {
              yield Buffer.from('different');
            })(),
        }),
      ),
    ).rejects.toMatchObject({ code: 'binary_hash_mismatch' });
  });

  it('stream-hashes and returns only the verified fixed binary path', async () => {
    const runtimeRoot = resolve('fixture/runtime');
    const resolvePackageRoot = vi.fn(async () => ({
      root: runtimeRoot,
      packageVersion: version,
    }));
    const readBinary = vi.fn<BridgeBinaryDependencies['readBinary']>(() =>
      (async function* () {
        yield Buffer.from('a');
        yield Buffer.from('b');
        yield Buffer.from('c');
      })(),
    );
    const readFile = vi.fn<BridgeBinaryDependencies['readFile']>(async () =>
      Buffer.from(JSON.stringify(manifest())),
    );
    await expect(
      resolveBridgeBinary(dependencies({ resolvePackageRoot, readFile, readBinary })),
    ).resolves.toEqual({
      path: join(runtimeRoot, 'multica.exe'),
      packageName: '@quukk/clawmessenger-runtime-win32-x64',
      version,
      sha256: abcSHA256,
    });
    expect(resolvePackageRoot).toHaveBeenCalledWith(
      '@quukk/clawmessenger-runtime-win32-x64',
    );
    expect(readFile).toHaveBeenCalledWith(join(runtimeRoot, 'manifest.json'), 64 << 10);
    expect(readBinary).toHaveBeenCalledWith(join(runtimeRoot, 'multica.exe'));
  });
});
