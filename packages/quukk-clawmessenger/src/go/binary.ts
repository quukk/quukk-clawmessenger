import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open as fsOpen, stat as fsStat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import { VERSION } from '../version.js';

const MANIFEST_LIMIT = 64 << 10;

export type BridgeRuntimePackage = { packageName: string; binary: 'multica.exe' | 'multica' };

export type BridgeBinaryErrorCode =
  | 'unsupported_platform'
  | 'runtime_package_missing'
  | 'package_version_mismatch'
  | 'manifest_too_large'
  | 'manifest_invalid'
  | 'manifest_version_mismatch'
  | 'binary_not_file'
  | 'binary_read_failed'
  | 'binary_hash_mismatch';

export class BridgeBinaryError extends Error {
  readonly code: BridgeBinaryErrorCode;

  constructor(code: BridgeBinaryErrorCode) {
    super(code);
    this.name = 'BridgeBinaryError';
    this.code = code;
  }

  toJSON(): { code: BridgeBinaryErrorCode } {
    return { code: this.code };
  }
}

export type BridgeBinaryDependencies = {
  platform: NodeJS.Platform;
  arch: string;
  expectedVersion: string;
  resolvePackageRoot(packageName: string): Promise<{ root: string; packageVersion?: string }>;
  readFile(path: string, maximumBytes: number): Promise<Uint8Array>;
  stat(path: string): Promise<{ isFile(): boolean }>;
  readBinary(path: string): AsyncIterable<Uint8Array>;
};

const ManifestSchema = z.strictObject({
  version: z.string().min(1).max(128),
  goVersion: z.string().regex(/^go1\.[1-9]\d*(?:\.(?:0|[1-9]\d*))?(?:[a-z]+\d*)?$/),
  sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  binary: z.enum(['multica.exe', 'multica']),
  modules: z.array(z.string().regex(/^[^\s@]+@v[^\s@]+$/)).min(1).max(256),
});

const packageMatrix: Record<string, BridgeRuntimePackage> = {
  'win32/x64': {
    packageName: '@quukk/clawmessenger-runtime-win32-x64',
    binary: 'multica.exe',
  },
  'win32/arm64': {
    packageName: '@quukk/clawmessenger-runtime-win32-arm64',
    binary: 'multica.exe',
  },
  'darwin/x64': {
    packageName: '@quukk/clawmessenger-runtime-darwin-x64',
    binary: 'multica',
  },
  'darwin/arm64': {
    packageName: '@quukk/clawmessenger-runtime-darwin-arm64',
    binary: 'multica',
  },
  'linux/x64': {
    packageName: '@quukk/clawmessenger-runtime-linux-x64',
    binary: 'multica',
  },
  'linux/arm64': {
    packageName: '@quukk/clawmessenger-runtime-linux-arm64',
    binary: 'multica',
  },
};

async function readBoundedFile(path: string, maximumBytes: number): Promise<Uint8Array> {
  const handle = await fsOpen(path, 'r');
  try {
    const bytes = Buffer.allocUnsafe(maximumBytes + 1);
    let total = 0;
    while (total < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, total, bytes.byteLength - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    return bytes.subarray(0, total);
  } finally {
    await handle.close();
  }
}

export function bridgeRuntimePackage(platform: string, arch: string): BridgeRuntimePackage {
  const found = packageMatrix[`${platform}/${arch}`];
  if (found === undefined) throw new BridgeBinaryError('unsupported_platform');
  return found;
}

async function defaultResolvePackageRoot(
  packageName: string,
): Promise<{ root: string; packageVersion?: string }> {
  try {
    const require = createRequire(import.meta.url);
    const manifestPath = require.resolve(`${packageName}/manifest.json`);
    const root = dirname(manifestPath);
    const packageBytes = await readBoundedFile(join(root, 'package.json'), MANIFEST_LIMIT);
    if (packageBytes.byteLength > MANIFEST_LIMIT) throw new Error('oversize');
    const value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(packageBytes),
    ) as unknown;
    const parsed = z.object({ version: z.string().min(1).max(128) }).safeParse(value);
    if (!parsed.success) throw new Error('invalid');
    return { root, packageVersion: parsed.data.version };
  } catch {
    throw new BridgeBinaryError('runtime_package_missing');
  }
}

function defaults(
  overrides: Partial<BridgeBinaryDependencies>,
): BridgeBinaryDependencies {
  return {
    platform: overrides.platform ?? process.platform,
    arch: overrides.arch ?? process.arch,
    expectedVersion: overrides.expectedVersion ?? VERSION,
    resolvePackageRoot: overrides.resolvePackageRoot ?? defaultResolvePackageRoot,
    readFile: overrides.readFile ?? readBoundedFile,
    stat: overrides.stat ?? fsStat,
    readBinary:
      overrides.readBinary ??
      ((path) => createReadStream(path) as AsyncIterable<Uint8Array>),
  };
}

export type ResolvedBridgeBinary = {
  path: string;
  packageName: string;
  version: string;
  sha256: string;
};

export async function resolveBridgeBinary(
  overrides: Partial<BridgeBinaryDependencies> = {},
): Promise<ResolvedBridgeBinary> {
  const deps = defaults(overrides);
  const selected = bridgeRuntimePackage(deps.platform, deps.arch);
  let resolved: { root: string; packageVersion?: string };
  try {
    resolved = await deps.resolvePackageRoot(selected.packageName);
  } catch (error) {
    if (error instanceof BridgeBinaryError) throw error;
    throw new BridgeBinaryError('runtime_package_missing');
  }
  if (
    resolved.packageVersion !== undefined &&
    resolved.packageVersion !== deps.expectedVersion
  ) {
    throw new BridgeBinaryError('package_version_mismatch');
  }

  let bytes: Uint8Array;
  try {
    bytes = await deps.readFile(join(resolved.root, 'manifest.json'), MANIFEST_LIMIT);
  } catch {
    throw new BridgeBinaryError('manifest_invalid');
  }
  if (bytes.byteLength > MANIFEST_LIMIT) throw new BridgeBinaryError('manifest_too_large');
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new BridgeBinaryError('manifest_invalid');
  }
  const manifest = ManifestSchema.safeParse(value);
  if (!manifest.success || manifest.data.binary !== selected.binary) {
    throw new BridgeBinaryError('manifest_invalid');
  }
  if (manifest.data.version !== deps.expectedVersion) {
    throw new BridgeBinaryError('manifest_version_mismatch');
  }

  const path = join(resolved.root, selected.binary);
  let info: { isFile(): boolean };
  try {
    info = await deps.stat(path);
  } catch {
    throw new BridgeBinaryError('binary_not_file');
  }
  if (!info.isFile()) throw new BridgeBinaryError('binary_not_file');

  const hash = createHash('sha256');
  try {
    for await (const chunk of deps.readBinary(path)) {
      if (!(chunk instanceof Uint8Array)) throw new Error('invalid chunk');
      hash.update(chunk);
    }
  } catch {
    throw new BridgeBinaryError('binary_read_failed');
  }
  const digest = hash.digest('hex');
  if (digest !== manifest.data.sha256) throw new BridgeBinaryError('binary_hash_mismatch');
  return {
    path,
    packageName: selected.packageName,
    version: manifest.data.version,
    sha256: digest,
  };
}
