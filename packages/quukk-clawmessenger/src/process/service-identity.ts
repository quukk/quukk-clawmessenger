import {
  createHash,
  randomBytes as cryptoRandomBytes,
} from 'node:crypto';
import {
  constants as fsConstants,
} from 'node:fs';
import {
  chmod as fsChmod,
  link as fsLink,
  lstat as fsLstat,
  mkdir as fsMkdir,
  open as fsOpen,
  opendir as fsOpenDirectory,
  readFile as fsReadFile,
  rename as fsRename,
  unlink as fsUnlink,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';

import { z } from 'zod';

const IDENTITY_LIMIT = 16_384;
const DIRECTORY_ENTRY_LIMIT = 256;
const INSTANCE_ID_PATTERN = /^svc_[0-9a-f]{32}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const STALE_ARTIFACT_PATTERN = /^([0-9a-f]{64})(?:-cleanup-[0-9a-f]{32})?$/;
const RECOVERY_ARTIFACT_PATTERN = /^(?:retired|write-(?:owned|unverified))-[0-9a-f]{32}\.json$/;
const RECOVERY_ENTRY_LIMIT = 32;
const RECOVERY_BYTE_LIMIT = 1_048_576n;
const ADDRESS_PATTERN = /^127\.0\.0\.1:(?:[1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5])$/;
const STARTED_AT_SCHEMA = z
  .string()
  .min(20)
  .max(40)
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/)
  .refine((value) => Number.isFinite(Date.parse(value)));

const COMMON_IDENTITY = {
  schema_version: z.literal(1),
  pid: z.number().int().positive().safe(),
  version: z.string().min(1).max(128),
  instance_id: z.string().regex(INSTANCE_ID_PATTERN),
  started_at: STARTED_AT_SCHEMA,
};

export const StartingDaemonIdentitySchema = z.strictObject({
  ...COMMON_IDENTITY,
  state: z.literal('starting'),
});

export const ReadyDaemonIdentitySchema = z.strictObject({
  ...COMMON_IDENTITY,
  state: z.literal('ready'),
  address: z.string().regex(ADDRESS_PATTERN),
});

export const DaemonIdentitySchema = z.discriminatedUnion('state', [
  StartingDaemonIdentitySchema,
  ReadyDaemonIdentitySchema,
]);

export type StartingDaemonIdentity = z.infer<typeof StartingDaemonIdentitySchema>;
export type ReadyDaemonIdentity = z.infer<typeof ReadyDaemonIdentitySchema>;
export type DaemonIdentity = z.infer<typeof DaemonIdentitySchema>;

export type DaemonIdentityErrorCode =
  | 'identity_conflict'
  | 'identity_corrupt'
  | 'identity_invalid'
  | 'identity_write_failed';

export class DaemonIdentityError extends Error {
  readonly code: DaemonIdentityErrorCode;

  constructor(code: DaemonIdentityErrorCode) {
    super(code);
    this.name = 'DaemonIdentityError';
    this.code = code;
  }

  toJSON(): { code: DaemonIdentityErrorCode } {
    return { code: this.code };
  }
}

export interface DaemonIdentityPersistence {
  read(): Promise<{ identity?: DaemonIdentity; contentDigest?: string }>;
  claim(value: StartingDaemonIdentity): Promise<boolean>;
  markReady(expected: StartingDaemonIdentity, address: string): Promise<ReadyDaemonIdentity>;
  quarantineStaleIfExact(input: {
    expected: DaemonIdentity;
    contentDigest: string;
  }): Promise<boolean>;
  removeIfMatches(expected: DaemonIdentity): Promise<boolean>;
}

export interface DaemonIdentityDependencies {
  platform: NodeJS.Platform;
  mkdir: typeof fsMkdir;
  chmod: typeof fsChmod;
  lstat: typeof fsLstat;
  open: typeof fsOpen;
  readFile: typeof fsReadFile;
  rename: typeof fsRename;
  link: typeof fsLink;
  unlink: typeof fsUnlink;
  randomBytes: (size: number) => Buffer;
}

type IdentitySnapshot = {
  identity: DaemonIdentity;
  contentDigest: string;
};

type IdentityClaim = IdentitySnapshot & {
  path: string;
};

type IdentityArtifacts = {
  claims: string[];
  stale: string[];
};

type ExclusiveWriteResult = 'created_failed' | 'exists' | 'written';

type FileIdentity = {
  birthtimeMs: bigint;
  dev: bigint;
  ino: bigint;
};

type RecoveryKind = 'retired' | 'write-owned' | 'write-unverified';

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function equalIdentity(left: DaemonIdentity, right: DaemonIdentity): boolean {
  return left.schema_version === right.schema_version
    && left.state === right.state
    && left.pid === right.pid
    && left.version === right.version
    && left.instance_id === right.instance_id
    && left.started_at === right.started_at
    && (left.state !== 'ready'
      || (right.state === 'ready' && left.address === right.address));
}

function serialized(value: DaemonIdentity): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function serializedDigest(value: DaemonIdentity): string {
  return createHash('sha256').update(serialized(value), 'utf8').digest('hex');
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.birthtimeMs === right.birthtimeMs;
}

export class DaemonIdentityStore implements DaemonIdentityPersistence {
  readonly #path: string;
  readonly #directory: string;
  readonly #deps: DaemonIdentityDependencies;

  constructor(options: {
    filePath: string;
    dependencies?: Partial<DaemonIdentityDependencies>;
  }) {
    if (!isAbsolute(options.filePath) || basename(options.filePath) !== 'daemon.pid') {
      throw new DaemonIdentityError('identity_invalid');
    }
    this.#path = options.filePath;
    this.#directory = dirname(options.filePath);
    this.#deps = {
      platform: options.dependencies?.platform ?? process.platform,
      mkdir: options.dependencies?.mkdir ?? fsMkdir,
      chmod: options.dependencies?.chmod ?? fsChmod,
      lstat: options.dependencies?.lstat ?? fsLstat,
      open: options.dependencies?.open ?? fsOpen,
      readFile: options.dependencies?.readFile ?? fsReadFile,
      rename: options.dependencies?.rename ?? fsRename,
      link: options.dependencies?.link ?? fsLink,
      unlink: options.dependencies?.unlink ?? fsUnlink,
      randomBytes: options.dependencies?.randomBytes ?? cryptoRandomBytes,
    };
  }

  async read(): Promise<{ identity?: DaemonIdentity; contentDigest?: string }> {
    const snapshot = await this.#readSnapshot(this.#path);
    if ((await this.#artifacts()).claims.length !== 0) {
      throw new DaemonIdentityError('identity_corrupt');
    }
    return snapshot === undefined ? {} : snapshot;
  }

  async claim(value: StartingDaemonIdentity): Promise<boolean> {
    const parsed = StartingDaemonIdentitySchema.safeParse(value);
    if (!parsed.success) throw new DaemonIdentityError('identity_invalid');
    const result = await this.#writeExclusive(this.#path, parsed.data);
    if (result === 'exists') return false;
    if (result === 'created_failed') {
      throw new DaemonIdentityError('identity_write_failed');
    }
    try {
      if ((await this.#artifacts()).claims.length !== 0) {
        throw new DaemonIdentityError('identity_corrupt');
      }
    } catch (error) {
      await this.#removeExactWithoutArtifactScan(parsed.data);
      throw error;
    }
    return true;
  }

  async markReady(
    expected: StartingDaemonIdentity,
    address: string,
  ): Promise<ReadyDaemonIdentity> {
    const parsedExpected = StartingDaemonIdentitySchema.safeParse(expected);
    const parsedReady = ReadyDaemonIdentitySchema.safeParse({
      ...expected,
      state: 'ready',
      address,
    });
    if (!parsedExpected.success || !parsedReady.success) {
      throw new DaemonIdentityError('identity_invalid');
    }
    const claimed = await this.#takeExact(
      parsedExpected.data,
      serializedDigest(parsedExpected.data),
      true,
    );
    if (claimed === undefined) throw new DaemonIdentityError('identity_conflict');
    let writeResult: ExclusiveWriteResult;
    try {
      writeResult = await this.#writeExclusive(this.#path, parsedReady.data);
    } catch (error) {
      await this.#restoreClaim(claimed.path, true);
      throw error;
    }
    if (writeResult === 'created_failed') {
      try {
        await this.#restoreClaim(claimed.path, true);
      } catch {
        throw new DaemonIdentityError('identity_write_failed');
      }
      throw new DaemonIdentityError('identity_write_failed');
    }
    if (writeResult === 'exists') {
      await this.#restoreClaim(claimed.path, true);
      throw new DaemonIdentityError('identity_conflict');
    }
    let failure: unknown;
    try {
      await this.#moveToRecovery(claimed.path, 'retired');
      await this.#cleanupStaleAfterReady(parsedReady.data);
      if (!(await this.#isDurableReady(parsedReady.data))) {
        throw new DaemonIdentityError('identity_conflict');
      }
      return parsedReady.data;
    } catch (error) {
      failure = error instanceof DaemonIdentityError
        ? error
        : new DaemonIdentityError('identity_write_failed');
    }
    if (await this.#isDurableReady(parsedReady.data)) return parsedReady.data;
    try {
      await this.#removeExactWithoutArtifactScan(parsedReady.data);
    } catch (rollbackError) {
      if (await this.#isDurableReady(parsedReady.data)) return parsedReady.data;
      throw rollbackError;
    }
    throw failure;
  }

  async quarantineStaleIfExact(input: {
    expected: DaemonIdentity;
    contentDigest: string;
  }): Promise<boolean> {
    const parsed = DaemonIdentitySchema.safeParse(input.expected);
    if (!parsed.success || !DIGEST_PATTERN.test(input.contentDigest)) {
      throw new DaemonIdentityError('identity_invalid');
    }
    if ((await this.#artifacts()).stale.length !== 0) {
      throw new DaemonIdentityError('identity_corrupt');
    }
    const claimed = await this.#takeExact(parsed.data, input.contentDigest, true);
    if (claimed === undefined) return false;
    const stalePath = join(
      this.#directory,
      `${basename(this.#path)}.stale-${input.contentDigest}`,
    );
    try {
      await this.#deps.link(claimed.path, stalePath);
    } catch (error) {
      await this.#restoreClaim(claimed.path, true);
      if (errorCode(error) === 'EEXIST') return false;
      throw new DaemonIdentityError('identity_write_failed');
    }
    try {
      await this.#moveToRecovery(claimed.path, 'retired');
    } catch {
      throw new DaemonIdentityError('identity_write_failed');
    }
    return true;
  }

  async removeIfMatches(expected: DaemonIdentity): Promise<boolean> {
    const parsed = DaemonIdentitySchema.safeParse(expected);
    if (!parsed.success) throw new DaemonIdentityError('identity_invalid');
    const claimed = await this.#takeExact(parsed.data, serializedDigest(parsed.data), true);
    if (claimed === undefined) return false;
    try {
      await this.#moveToRecovery(claimed.path, 'retired');
      return true;
    } catch {
      throw new DaemonIdentityError('identity_write_failed');
    }
  }

  async #writeExclusive(path: string, value: DaemonIdentity): Promise<ExclusiveWriteResult> {
    const cleanupPath = this.#claimPath();
    let handle;
    try {
      handle = await this.#deps.open(path, 'wx', 0o600);
    } catch (error) {
      if (errorCode(error) === 'EEXIST') return 'exists';
      throw new DaemonIdentityError('identity_write_failed');
    }
    let createdIdentity: FileIdentity | undefined;
    try {
      createdIdentity = await handle.stat({ bigint: true });
      await handle.writeFile(serialized(value));
      await handle.sync();
      if (this.#deps.platform !== 'win32') await this.#deps.chmod(path, 0o600);
    } catch {
      if (createdIdentity === undefined) {
        throw new DaemonIdentityError('identity_write_failed');
      }
      await this.#discardCreatedPath(path, cleanupPath, createdIdentity);
      return 'created_failed';
    } finally {
      await handle.close().catch(() => undefined);
    }
    return 'written';
  }

  async #discardCreatedPath(
    path: string,
    cleanupPath: string,
    createdIdentity: FileIdentity,
  ): Promise<void> {
    try {
      await this.#deps.rename(path, cleanupPath);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return;
      throw new DaemonIdentityError('identity_write_failed');
    }
    let handle;
    let cleanupIdentity: FileIdentity;
    try {
      handle = await this.#deps.open(cleanupPath, 'r');
      cleanupIdentity = await handle.stat({ bigint: true });
    } catch {
      throw new DaemonIdentityError('identity_write_failed');
    } finally {
      await handle?.close().catch(() => undefined);
    }
    await this.#moveToRecovery(
      cleanupPath,
      sameFileIdentity(createdIdentity, cleanupIdentity)
        ? 'write-owned'
        : 'write-unverified',
    );
  }

  async #readSnapshot(path: string): Promise<IdentitySnapshot | undefined> {
    let handle;
    try {
      handle = await this.#deps.open(path, 'r');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined;
      throw new DaemonIdentityError('identity_corrupt');
    }
    try {
      const stat = await handle.stat();
      if (stat.size < 1 || stat.size > IDENTITY_LIMIT) {
        throw new DaemonIdentityError('identity_corrupt');
      }
      const bytes = Buffer.alloc(IDENTITY_LIMIT + 1);
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
      if (bytesRead < 1 || bytesRead > IDENTITY_LIMIT) {
        throw new DaemonIdentityError('identity_corrupt');
      }
      const raw = bytes.subarray(0, bytesRead);
      let value: unknown;
      try {
        value = JSON.parse(raw.toString('utf8')) as unknown;
      } catch {
        throw new DaemonIdentityError('identity_corrupt');
      }
      const parsed = DaemonIdentitySchema.safeParse(value);
      if (!parsed.success) throw new DaemonIdentityError('identity_corrupt');
      return {
        identity: parsed.data,
        contentDigest: createHash('sha256').update(raw).digest('hex'),
      };
    } catch (error) {
      if (error instanceof DaemonIdentityError) throw error;
      throw new DaemonIdentityError('identity_corrupt');
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async #takeExact(
    expected: DaemonIdentity,
    contentDigest: string | undefined,
    preserveOnRestoreConflict: boolean,
  ): Promise<IdentityClaim | undefined> {
    if ((await this.#artifacts()).claims.length !== 0) {
      throw new DaemonIdentityError('identity_corrupt');
    }
    return this.#takeExactWithoutArtifactScan(
      expected,
      contentDigest,
      preserveOnRestoreConflict,
    );
  }

  async #takeExactWithoutArtifactScan(
    expected: DaemonIdentity,
    contentDigest: string | undefined,
    preserveOnRestoreConflict: boolean,
  ): Promise<IdentityClaim | undefined> {
    const claimPath = this.#claimPath();
    try {
      await this.#deps.rename(this.#path, claimPath);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined;
      throw new DaemonIdentityError('identity_write_failed');
    }
    let snapshot: IdentitySnapshot | undefined;
    try {
      snapshot = await this.#readSnapshot(claimPath);
    } catch (error) {
      await this.#restoreClaim(claimPath, preserveOnRestoreConflict);
      throw error;
    }
    if (snapshot === undefined) throw new DaemonIdentityError('identity_write_failed');
    if (!equalIdentity(snapshot.identity, expected)
      || (contentDigest !== undefined && snapshot.contentDigest !== contentDigest)) {
      await this.#restoreClaim(claimPath, preserveOnRestoreConflict);
      return undefined;
    }
    return { ...snapshot, path: claimPath };
  }

  async #removeExactWithoutArtifactScan(expected: DaemonIdentity): Promise<boolean> {
    const claimed = await this.#takeExactWithoutArtifactScan(
      expected,
      serializedDigest(expected),
      true,
    );
    if (claimed === undefined) return false;
    try {
      await this.#moveToRecovery(claimed.path, 'retired');
      return true;
    } catch {
      throw new DaemonIdentityError('identity_write_failed');
    }
  }

  #claimPath(): string {
    return `${this.#path}.claim-${process.pid}-${this.#randomToken()}`;
  }

  #staleCleanupPath(digest: string): string {
    return `${this.#path}.stale-${digest}-cleanup-${this.#randomToken()}`;
  }

  #recoveryPath(kind: RecoveryKind): string {
    return join(
      this.#recoveryDirectory(),
      `${kind}-${this.#randomToken()}.json`,
    );
  }

  #recoveryDirectory(): string {
    return `${this.#path}.recovery`;
  }

  #randomToken(): string {
    let token: Buffer;
    try {
      token = this.#deps.randomBytes(16);
    } catch {
      throw new DaemonIdentityError('identity_write_failed');
    }
    if (!Buffer.isBuffer(token) || token.byteLength !== 16) {
      throw new DaemonIdentityError('identity_write_failed');
    }
    return token.toString('hex');
  }

  async #restoreClaim(claimPath: string, preserveOnConflict: boolean): Promise<void> {
    await this.#restoreArtifact(claimPath, this.#path, preserveOnConflict);
  }

  async #restoreArtifact(
    claimPath: string,
    destination: string,
    preserveOnConflict: boolean,
  ): Promise<void> {
    try {
      await this.#deps.link(claimPath, destination);
    } catch (error) {
      const code = errorCode(error);
      if (code === 'EEXIST' && preserveOnConflict) return;
      if (code !== 'EEXIST') throw new DaemonIdentityError('identity_write_failed');
    }
    try {
      await this.#moveToRecovery(claimPath, 'retired');
    } catch {
      throw new DaemonIdentityError('identity_write_failed');
    }
  }

  async #moveToRecovery(path: string, kind: RecoveryKind): Promise<void> {
    const recoveryDirectory = await this.#ensureRecoveryDirectory();
    const recoveryPath = this.#recoveryPath(kind);
    try {
      await this.#deps.rename(path, recoveryPath);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        throw new DaemonIdentityError('identity_write_failed');
      }
    }
    await this.#secureRecoveryArtifact(recoveryPath);
    await this.#pruneRecovery(recoveryDirectory);
  }

  async #ensureRecoveryDirectory(): Promise<string> {
    const recoveryDirectory = this.#recoveryDirectory();
    try {
      await this.#deps.mkdir(recoveryDirectory, { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') {
        throw new DaemonIdentityError('identity_write_failed');
      }
    }
    let metadata;
    try {
      metadata = await this.#deps.lstat(recoveryDirectory);
    } catch {
      throw new DaemonIdentityError('identity_write_failed');
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new DaemonIdentityError('identity_write_failed');
    }
    if (this.#deps.platform === 'win32') return recoveryDirectory;
    let handle;
    try {
      handle = await this.#deps.open(
        recoveryDirectory,
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
      );
      const opened = await handle.stat();
      if (!opened.isDirectory()) throw new DaemonIdentityError('identity_write_failed');
      await handle.chmod(0o700);
    } catch (error) {
      if (error instanceof DaemonIdentityError) throw error;
      throw new DaemonIdentityError('identity_write_failed');
    } finally {
      await handle?.close().catch(() => undefined);
    }
    return recoveryDirectory;
  }

  async #secureRecoveryArtifact(path: string): Promise<void> {
    let metadata;
    try {
      metadata = await this.#deps.lstat(path);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return;
      throw new DaemonIdentityError('identity_write_failed');
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new DaemonIdentityError('identity_write_failed');
    }
    if (this.#deps.platform === 'win32') return;
    let handle;
    try {
      handle = await this.#deps.open(
        path,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
      const opened = await handle.stat();
      if (!opened.isFile()) throw new DaemonIdentityError('identity_write_failed');
      await handle.chmod(0o600);
    } catch (error) {
      if (error instanceof DaemonIdentityError) throw error;
      throw new DaemonIdentityError('identity_write_failed');
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async #pruneRecovery(recoveryDirectory: string): Promise<void> {
    const candidates: Array<{
      mtimeNs: bigint;
      name: string;
      path: string;
      size: bigint;
    }> = [];
    let directory;
    try {
      directory = await fsOpenDirectory(recoveryDirectory);
      for await (const entry of directory) {
        if (!RECOVERY_ARTIFACT_PATTERN.test(entry.name)) continue;
        const path = join(recoveryDirectory, entry.name);
        let metadata;
        try {
          metadata = await this.#deps.lstat(path, { bigint: true });
        } catch (error) {
          if (errorCode(error) === 'ENOENT') continue;
          throw error;
        }
        if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
        candidates.push({
          mtimeNs: metadata.mtimeNs,
          name: entry.name,
          path,
          size: metadata.size,
        });
      }
    } catch (error) {
      if (error instanceof DaemonIdentityError) throw error;
      throw new DaemonIdentityError('identity_write_failed');
    } finally {
      await directory?.close().catch(() => undefined);
    }
    candidates.sort((left, right) => {
      if (left.mtimeNs < right.mtimeNs) return -1;
      if (left.mtimeNs > right.mtimeNs) return 1;
      return left.name.localeCompare(right.name);
    });
    let entries = candidates.length;
    let bytes = candidates.reduce((total, candidate) => total + candidate.size, 0n);
    for (const candidate of candidates) {
      if (entries <= RECOVERY_ENTRY_LIMIT && bytes <= RECOVERY_BYTE_LIMIT) break;
      try {
        const current = await this.#deps.lstat(candidate.path);
        if (current.isFile() && !current.isSymbolicLink()) {
          await this.#deps.unlink(candidate.path);
        }
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') {
          throw new DaemonIdentityError('identity_write_failed');
        }
      }
      entries -= 1;
      bytes -= candidate.size;
    }
  }

  async #cleanupStaleAfterReady(expected: ReadyDaemonIdentity): Promise<void> {
    const artifacts = await this.#artifacts();
    if (artifacts.claims.length !== 0) throw new DaemonIdentityError('identity_conflict');
    const stalePath = artifacts.stale[0];
    if (stalePath === undefined) return;
    const suffix = basename(stalePath).slice(`${basename(this.#path)}.stale-`.length);
    const artifact = STALE_ARTIFACT_PATTERN.exec(suffix);
    const digest = artifact?.[1];
    if (digest === undefined) throw new DaemonIdentityError('identity_corrupt');
    const cleanupPath = this.#staleCleanupPath(digest);
    try {
      await this.#deps.rename(stalePath, cleanupPath);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return;
      throw new DaemonIdentityError('identity_write_failed');
    }
    const stale = await this.#readSnapshot(cleanupPath);
    const current = await this.#readSnapshot(this.#path);
    const ownsReady = current !== undefined
      && current.contentDigest === serializedDigest(expected)
      && equalIdentity(current.identity, expected);
    const ownsStale = stale !== undefined && stale.contentDigest === digest;
    if (!ownsReady || !ownsStale) {
      throw new DaemonIdentityError(ownsReady ? 'identity_corrupt' : 'identity_conflict');
    }
    try {
      await this.#moveToRecovery(cleanupPath, 'retired');
    } catch {
      throw new DaemonIdentityError('identity_write_failed');
    }
  }

  async #isDurableReady(expected: ReadyDaemonIdentity): Promise<boolean> {
    try {
      const snapshot = await this.read();
      return snapshot.identity !== undefined
        && snapshot.contentDigest === serializedDigest(expected)
        && equalIdentity(snapshot.identity, expected);
    } catch {
      return false;
    }
  }

  async #artifacts(): Promise<IdentityArtifacts> {
    const claims: string[] = [];
    const stale: string[] = [];
    const claimPrefix = `${basename(this.#path)}.claim-`;
    const stalePrefix = `${basename(this.#path)}.stale-`;
    let directory;
    try {
      directory = await fsOpenDirectory(this.#directory);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return { claims, stale };
      throw new DaemonIdentityError('identity_corrupt');
    }
    let entries = 0;
    try {
      for await (const entry of directory) {
        entries += 1;
        if (entries > DIRECTORY_ENTRY_LIMIT) throw new DaemonIdentityError('identity_corrupt');
        if (entry.name.startsWith(claimPrefix)) claims.push(join(this.#directory, entry.name));
        if (entry.name.startsWith(stalePrefix)) stale.push(join(this.#directory, entry.name));
        if (claims.length > 1 || stale.length > 1) {
          throw new DaemonIdentityError('identity_corrupt');
        }
      }
    } catch (error) {
      if (error instanceof DaemonIdentityError) throw error;
      throw new DaemonIdentityError('identity_corrupt');
    } finally {
      await directory.close().catch(() => undefined);
    }
    return { claims, stale };
  }
}
