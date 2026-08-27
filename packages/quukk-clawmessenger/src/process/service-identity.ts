import {
  createHash,
  createHmac,
  randomBytes as cryptoRandomBytes,
} from 'node:crypto';
import {
  chmod as fsChmod,
  link as fsLink,
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
const BRIDGE_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
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

function sameProcessGeneration(left: DaemonIdentity, right: DaemonIdentity): boolean {
  return left.schema_version === right.schema_version
    && left.pid === right.pid
    && left.version === right.version
    && left.instance_id === right.instance_id
    && left.started_at === right.started_at;
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
      open: options.dependencies?.open ?? fsOpen,
      readFile: options.dependencies?.readFile ?? fsReadFile,
      rename: options.dependencies?.rename ?? fsRename,
      link: options.dependencies?.link ?? fsLink,
      unlink: options.dependencies?.unlink ?? fsUnlink,
      randomBytes: options.dependencies?.randomBytes ?? cryptoRandomBytes,
    };
  }

  async read(): Promise<{ identity?: DaemonIdentity; contentDigest?: string }> {
    await this.#recoverClaim();
    const snapshot = await this.#readSnapshot(this.#path);
    if ((await this.#artifacts()).claims.length !== 0) {
      throw new DaemonIdentityError('identity_corrupt');
    }
    return snapshot === undefined ? {} : snapshot;
  }

  async claim(value: StartingDaemonIdentity): Promise<boolean> {
    const parsed = StartingDaemonIdentitySchema.safeParse(value);
    if (!parsed.success) throw new DaemonIdentityError('identity_invalid');
    await this.#ensureDirectory();
    await this.#recoverClaim();
    const artifacts = await this.#artifacts();
    if (artifacts.claims.length !== 0) throw new DaemonIdentityError('identity_corrupt');
    const written = await this.#writeExclusive(this.#path, parsed.data);
    if (!written) return false;
    try {
      for (const artifact of artifacts.stale) await this.#deps.unlink(artifact);
    } catch {
      throw new DaemonIdentityError('identity_write_failed');
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
      false,
    );
    if (claimed === undefined) throw new DaemonIdentityError('identity_conflict');
    let written: boolean;
    try {
      written = await this.#writeExclusive(this.#path, parsedReady.data);
    } catch (error) {
      await this.#restoreClaim(claimed.path, false);
      throw error;
    }
    if (!written) {
      await this.#restoreClaim(claimed.path, true);
      throw new DaemonIdentityError('identity_conflict');
    }
    try {
      await this.#deps.unlink(claimed.path);
    } catch {
      throw new DaemonIdentityError('identity_write_failed');
    }
    return parsedReady.data;
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
    const suffix = basename(claimed.path).slice(`${basename(this.#path)}.claim-`.length);
    const stalePath = join(this.#directory, `${basename(this.#path)}.stale-${suffix}`);
    try {
      await this.#deps.rename(claimed.path, stalePath);
    } catch {
      await this.#restoreClaim(claimed.path, true);
      throw new DaemonIdentityError('identity_write_failed');
    }
    return true;
  }

  async removeIfMatches(expected: DaemonIdentity): Promise<boolean> {
    const parsed = DaemonIdentitySchema.safeParse(expected);
    if (!parsed.success) throw new DaemonIdentityError('identity_invalid');
    const claimed = await this.#takeExact(parsed.data, serializedDigest(parsed.data), false);
    if (claimed === undefined) return false;
    try {
      await this.#deps.unlink(claimed.path);
      return true;
    } catch {
      throw new DaemonIdentityError('identity_write_failed');
    }
  }

  async #ensureDirectory(): Promise<void> {
    try {
      await this.#deps.mkdir(this.#directory, { recursive: true, mode: 0o700 });
      if (this.#deps.platform !== 'win32') await this.#deps.chmod(this.#directory, 0o700);
    } catch {
      throw new DaemonIdentityError('identity_write_failed');
    }
  }

  async #writeExclusive(path: string, value: DaemonIdentity): Promise<boolean> {
    let handle;
    try {
      handle = await this.#deps.open(path, 'wx', 0o600);
    } catch (error) {
      if (errorCode(error) === 'EEXIST') return false;
      throw new DaemonIdentityError('identity_write_failed');
    }
    try {
      await handle.writeFile(serialized(value));
      await handle.sync();
      if (this.#deps.platform !== 'win32') await this.#deps.chmod(path, 0o600);
    } catch {
      throw new DaemonIdentityError('identity_write_failed');
    } finally {
      await handle.close().catch(() => undefined);
    }
    return true;
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
    await this.#recoverClaim();
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

  #claimPath(): string {
    let token: Buffer;
    try {
      token = this.#deps.randomBytes(16);
    } catch {
      throw new DaemonIdentityError('identity_write_failed');
    }
    if (!Buffer.isBuffer(token) || token.byteLength !== 16) {
      throw new DaemonIdentityError('identity_write_failed');
    }
    return `${this.#path}.claim-${process.pid}-${token.toString('hex')}`;
  }

  async #restoreClaim(claimPath: string, preserveOnConflict: boolean): Promise<void> {
    try {
      await this.#deps.link(claimPath, this.#path);
    } catch (error) {
      const code = errorCode(error);
      if (code === 'EEXIST' && preserveOnConflict) return;
      if (code !== 'EEXIST') throw new DaemonIdentityError('identity_write_failed');
    }
    try {
      await this.#deps.unlink(claimPath);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        throw new DaemonIdentityError('identity_write_failed');
      }
    }
  }

  async #recoverClaim(): Promise<void> {
    const [claimPath] = (await this.#artifacts()).claims;
    if (claimPath === undefined) return;
    const claimed = await this.#readSnapshot(claimPath);
    if (claimed === undefined) throw new DaemonIdentityError('identity_corrupt');
    try {
      await this.#deps.link(claimPath, this.#path);
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT') return;
      if (code !== 'EEXIST') throw new DaemonIdentityError('identity_write_failed');
      const current = await this.#readSnapshot(this.#path);
      const exactCopy = current !== undefined
        && current.contentDigest === claimed.contentDigest
        && equalIdentity(current.identity, claimed.identity);
      const completedReadyTransition = current !== undefined
        && claimed.identity.state === 'starting'
        && current.identity.state === 'ready'
        && sameProcessGeneration(claimed.identity, current.identity);
      if (!exactCopy && !completedReadyTransition) {
        throw new DaemonIdentityError('identity_corrupt');
      }
    }
    try {
      await this.#deps.unlink(claimPath);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        throw new DaemonIdentityError('identity_write_failed');
      }
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

export function deriveControlCredential(bridgeSecret: string, instanceId: string): string {
  if (!BRIDGE_SECRET_PATTERN.test(bridgeSecret) || !INSTANCE_ID_PATTERN.test(instanceId)) {
    throw new Error('control_credential_invalid');
  }
  const key = Buffer.from(bridgeSecret, 'base64url');
  if (key.byteLength !== 32 || key.toString('base64url') !== bridgeSecret) {
    throw new Error('control_credential_invalid');
  }
  return createHmac('sha256', key)
    .update(`quukk-local-control-v1\0${instanceId}`, 'utf8')
    .digest('base64url');
}
