import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';

import type { z } from 'zod';

type AtomicFileHandle = {
  writeFile?(data: string): Promise<unknown>;
  read?(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  stat?(): Promise<{ size: number }>;
  sync(): Promise<unknown>;
  close(): Promise<unknown>;
};

export type AtomicJsonDependencies = {
  platform?: NodeJS.Platform;
  now?: () => Date;
  randomHex?: () => string;
  mkdir?: (path: string, options: { recursive: true; mode: number }) => Promise<unknown>;
  chmod?: (path: string, mode: number) => Promise<unknown>;
  open?: (path: string, flags: string, mode?: number) => Promise<AtomicFileHandle>;
  rename?: (from: string, to: string) => Promise<unknown>;
  readdir?: (path: string) => Promise<string[]>;
  unlink?: (path: string) => Promise<unknown>;
  sleep?: (milliseconds: number) => Promise<unknown>;
};

type AtomicJsonErrorCode =
  | 'file_missing'
  | 'file_empty'
  | 'file_too_large'
  | 'invalid_json'
  | 'schema_invalid'
  | 'atomic_write_failed'
  | 'quarantine_failed';

export class AtomicJsonError extends Error {
  readonly code: AtomicJsonErrorCode;

  constructor(code: AtomicJsonErrorCode) {
    super(code);
    this.name = 'AtomicJsonError';
    this.code = code;
  }

  toJSON(): { code: AtomicJsonErrorCode } {
    return { code: this.code };
  }
}

function dependencies(overrides: AtomicJsonDependencies = {}) {
  return {
    platform: overrides.platform ?? process.platform,
    now: overrides.now ?? (() => new Date()),
    randomHex: overrides.randomHex ?? (() => randomBytes(4).toString('hex')),
    mkdir: overrides.mkdir ?? fs.mkdir,
    chmod: overrides.chmod ?? fs.chmod,
    open: overrides.open ?? fs.open,
    rename: overrides.rename ?? fs.rename,
    readdir: overrides.readdir ?? fs.readdir,
    unlink: overrides.unlink ?? fs.unlink,
    sleep:
      overrides.sleep ??
      ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))),
  };
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}

export async function readJsonFile<T>(
  filePath: string,
  schema: z.ZodType<T>,
  maximumBytes: number,
  overrides: AtomicJsonDependencies = {},
): Promise<T> {
  const deps = dependencies(overrides);
  let handle: AtomicFileHandle;
  try {
    handle = await deps.open(filePath, 'r');
  } catch (error) {
    if (isMissing(error)) throw new AtomicJsonError('file_missing');
    throw new AtomicJsonError('invalid_json');
  }
  try {
    if (!handle.stat || !handle.read) throw new AtomicJsonError('invalid_json');
    const { size } = await handle.stat();
    if (size > maximumBytes) throw new AtomicJsonError('file_too_large');
    const bytes = Buffer.alloc(maximumBytes + 1);
    let bytesRead = 0;
    while (bytesRead < bytes.byteLength) {
      const result = await handle.read(
        bytes,
        bytesRead,
        bytes.byteLength - bytesRead,
        bytesRead,
      );
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > maximumBytes) throw new AtomicJsonError('file_too_large');
    if (bytesRead === 0) throw new AtomicJsonError('file_empty');
    let value: unknown;
    try {
      value = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')) as unknown;
    } catch {
      throw new AtomicJsonError('invalid_json');
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new AtomicJsonError('schema_invalid');
    return parsed.data;
  } catch (error) {
    if (error instanceof AtomicJsonError) throw error;
    throw new AtomicJsonError('invalid_json');
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function readJsonFileIfExists<T>(
  filePath: string,
  schema: z.ZodType<T>,
  maximumBytes: number,
  overrides: AtomicJsonDependencies = {},
): Promise<T | undefined> {
  try {
    return await readJsonFile(filePath, schema, maximumBytes, overrides);
  } catch (error) {
    if (error instanceof AtomicJsonError && error.code === 'file_missing') return undefined;
    throw error;
  }
}

async function atomicRename(
  from: string,
  to: string,
  deps: ReturnType<typeof dependencies>,
): Promise<void> {
  const attempts = deps.platform === 'win32' ? 3 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await deps.rename(from, to);
      return;
    } catch (error) {
      const retryable = errorCode(error) === 'EACCES' || errorCode(error) === 'EPERM';
      if (!retryable || attempt === attempts - 1) throw error;
      await deps.sleep(10 * (attempt + 1));
    }
  }
}

function unsupportedDirectorySync(error: unknown, platform: NodeJS.Platform): boolean {
  const code = errorCode(error);
  return (
    code === 'EINVAL' ||
    code === 'ENOTSUP' ||
    code === 'EISDIR' ||
    (platform === 'win32' && code === 'EPERM')
  );
}

async function syncDirectory(
  directory: string,
  deps: ReturnType<typeof dependencies>,
): Promise<void> {
  let handle: AtomicFileHandle | undefined;
  try {
    handle = await deps.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (!unsupportedDirectorySync(error, deps.platform)) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function atomicWriteJson(
  filePath: string,
  value: unknown,
  overrides: AtomicJsonDependencies = {},
): Promise<void> {
  const deps = dependencies(overrides);
  const directory = dirname(filePath);
  const temporary = join(directory, `${basename(filePath)}.tmp.${deps.randomHex()}`);
  let temporaryExists = false;
  let handle: AtomicFileHandle | undefined;
  try {
    await deps.mkdir(directory, { recursive: true, mode: 0o700 });
    if (deps.platform !== 'win32') await deps.chmod(directory, 0o700);
    handle = await deps.open(temporary, 'wx', 0o600);
    temporaryExists = true;
    if (!handle.writeFile) throw new Error('write unavailable');
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await atomicRename(temporary, filePath, deps);
    temporaryExists = false;
    await syncDirectory(directory, deps);
  } catch {
    await handle?.close().catch(() => undefined);
    if (temporaryExists) await deps.unlink(temporary).catch(() => undefined);
    throw new AtomicJsonError('atomic_write_failed');
  }
}

function compactTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, '');
}

export async function quarantineJsonFile(
  filePath: string,
  overrides: AtomicJsonDependencies = {},
): Promise<string> {
  const deps = dependencies(overrides);
  const quarantined = `${filePath}.corrupt.${compactTimestamp(deps.now())}.${deps.randomHex()}`;
  try {
    await deps.rename(filePath, quarantined);
    if (deps.platform !== 'win32') await deps.chmod(quarantined, 0o600);
    await syncDirectory(dirname(filePath), deps);
    return quarantined;
  } catch {
    throw new AtomicJsonError('quarantine_failed');
  }
}

async function recoveryArtifacts(
  filePath: string,
  deps: ReturnType<typeof dependencies>,
): Promise<string[]> {
  const directory = dirname(filePath);
  const prefix = `${basename(filePath)}.corrupt.`;
  let entries: string[];
  try {
    entries = await deps.readdir(directory);
  } catch (error) {
    if (isMissing(error)) return [];
    throw new AtomicJsonError('quarantine_failed');
  }
  return entries
    .filter((entry) => entry.startsWith(prefix) && entry.length > prefix.length)
    .map((entry) => join(directory, entry));
}

export async function hasRecoveryArtifact(
  filePath: string,
  overrides: AtomicJsonDependencies = {},
): Promise<boolean> {
  return (await recoveryArtifacts(filePath, dependencies(overrides))).length > 0;
}

export async function clearRecoveryArtifacts(
  filePath: string,
  overrides: AtomicJsonDependencies = {},
): Promise<void> {
  const deps = dependencies(overrides);
  const directory = dirname(filePath);
  const corruptPrefix = `${basename(filePath)}.corrupt.`;
  const recoveredPrefix = `${basename(filePath)}.recovered.`;
  const artifacts = await recoveryArtifacts(filePath, deps);
  try {
    for (const artifact of artifacts) {
      const suffix = basename(artifact).slice(corruptPrefix.length);
      await deps.rename(artifact, join(directory, `${recoveredPrefix}${suffix}`));
    }
    if (artifacts.length > 0) await syncDirectory(directory, deps);
  } catch {
    throw new AtomicJsonError('quarantine_failed');
  }
}
