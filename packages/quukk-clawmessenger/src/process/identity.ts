import { randomUUID } from 'node:crypto';
import {
  link as fsLink,
  opendir as fsOpenDirectory,
  rename as fsRename,
  unlink as fsUnlink,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { z } from 'zod';

import { atomicWriteJson, readJsonFileIfExists } from '../config/atomic-json.js';
import { localPaths } from '../config/paths.js';

const IDENTITY_LIMIT = 16_384;
const DIRECTORY_ENTRY_LIMIT = 256;
const CLAIM_ID_PATTERN = /^[0-9a-f]{32}$/;

export const BridgeProcessIdentitySchema = z.strictObject({
  schema_version: z.literal(1),
  address: z.string().regex(/^127\.0\.0\.1:(?:[1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5])$/),
  pid: z.number().int().positive().safe(),
  version: z.string().min(1).max(128),
  instance_id: z.string().regex(/^br_[0-9a-f]{32}$/),
  started_at: z
    .string()
    .min(20)
    .max(40)
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/)
    .refine((value) => Number.isFinite(Date.parse(value))),
});
export type BridgeProcessIdentity = z.infer<typeof BridgeProcessIdentitySchema>;

export type BridgeProcessIdentityErrorCode =
  | 'identity_corrupt'
  | 'identity_invalid'
  | 'identity_write_failed';

export class BridgeProcessIdentityError extends Error {
  readonly code: BridgeProcessIdentityErrorCode;

  constructor(code: BridgeProcessIdentityErrorCode) {
    super(code);
    this.name = 'BridgeProcessIdentityError';
    this.code = code;
  }

  toJSON(): { code: BridgeProcessIdentityErrorCode } {
    return { code: this.code };
  }
}

export type BridgeProcessIdentityDependencies = {
  read(path: string, maximumBytes: number): Promise<unknown | undefined>;
  write(path: string, value: unknown): Promise<void>;
  rename(source: string, destination: string): Promise<unknown>;
  scan(directory: string): AsyncIterable<string>;
  link(existing: string, destination: string): Promise<unknown>;
  unlink(path: string): Promise<unknown>;
  claimId(): string;
};

export interface BridgeProcessIdentityPersistence {
  read(): Promise<BridgeProcessIdentity | undefined>;
  write(value: BridgeProcessIdentity): Promise<void>;
  removeIfMatches(expected: BridgeProcessIdentity): Promise<boolean>;
}

export type BridgeProcessIdentityStoreOptions = {
  homeDirectory?: string;
  dependencies?: Partial<BridgeProcessIdentityDependencies>;
};

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function equalIdentity(left: BridgeProcessIdentity, right: BridgeProcessIdentity): boolean {
  return (
    left.schema_version === right.schema_version &&
    left.address === right.address &&
    left.pid === right.pid &&
    left.version === right.version &&
    left.instance_id === right.instance_id &&
    left.started_at === right.started_at
  );
}

async function* scanDirectory(directory: string): AsyncIterable<string> {
  let handle;
  try {
    handle = await fsOpenDirectory(directory);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
  for await (const entry of handle) yield entry.name;
}

export class BridgeProcessIdentityStore implements BridgeProcessIdentityPersistence {
  readonly #path: string;
  readonly #deps: BridgeProcessIdentityDependencies;

  constructor(options: BridgeProcessIdentityStoreOptions = {}) {
    this.#path = localPaths(options.homeDirectory).bridgePid;
    this.#deps = {
      read:
        options.dependencies?.read ??
        ((path, maximumBytes) => readJsonFileIfExists(path, z.unknown(), maximumBytes)),
      write: options.dependencies?.write ?? atomicWriteJson,
      rename: options.dependencies?.rename ?? fsRename,
      scan: options.dependencies?.scan ?? scanDirectory,
      link: options.dependencies?.link ?? fsLink,
      unlink: options.dependencies?.unlink ?? fsUnlink,
      claimId:
        options.dependencies?.claimId ??
        (() => randomUUID().replaceAll('-', '')),
    };
  }

  async read(): Promise<BridgeProcessIdentity | undefined> {
    await this.#recoverClaim();
    const current = await this.#read(this.#path);
    if ((await this.#claims()).length !== 0) {
      throw new BridgeProcessIdentityError('identity_corrupt');
    }
    return current;
  }

  async #read(path: string): Promise<BridgeProcessIdentity | undefined> {
    let value: unknown | undefined;
    try {
      value = await this.#deps.read(path, IDENTITY_LIMIT);
    } catch {
      throw new BridgeProcessIdentityError('identity_corrupt');
    }
    if (value === undefined) return undefined;
    const parsed = BridgeProcessIdentitySchema.safeParse(value);
    if (!parsed.success) throw new BridgeProcessIdentityError('identity_corrupt');
    return parsed.data;
  }

  async write(value: BridgeProcessIdentity): Promise<void> {
    const parsed = BridgeProcessIdentitySchema.safeParse(value);
    if (!parsed.success) throw new BridgeProcessIdentityError('identity_invalid');
    try {
      await this.#deps.write(this.#path, parsed.data);
    } catch {
      throw new BridgeProcessIdentityError('identity_write_failed');
    }
  }

  async removeIfMatches(expected: BridgeProcessIdentity): Promise<boolean> {
    const parsed = BridgeProcessIdentitySchema.safeParse(expected);
    if (!parsed.success) throw new BridgeProcessIdentityError('identity_invalid');
    const claimId = this.#deps.claimId();
    if (!CLAIM_ID_PATTERN.test(claimId)) {
      throw new BridgeProcessIdentityError('identity_write_failed');
    }
    const tombstone = `${this.#path}.claim-${process.pid}-${claimId}`;
    try {
      await this.#deps.rename(this.#path, tombstone);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false;
      throw new BridgeProcessIdentityError('identity_write_failed');
    }

    let current: BridgeProcessIdentity | undefined;
    try {
      current = await this.#read(tombstone);
    } catch (error) {
      await this.#restore(tombstone);
      throw error;
    }
    if (current === undefined) {
      throw new BridgeProcessIdentityError('identity_write_failed');
    }
    if (!equalIdentity(current, parsed.data)) {
      await this.#restore(tombstone);
      return false;
    }
    try {
      await this.#deps.unlink(tombstone);
      return true;
    } catch {
      throw new BridgeProcessIdentityError('identity_write_failed');
    }
  }

  async #restore(tombstone: string): Promise<void> {
    try {
      await this.#deps.link(tombstone, this.#path);
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') {
        throw new BridgeProcessIdentityError('identity_write_failed');
      }
    }
    try {
      await this.#deps.unlink(tombstone);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        throw new BridgeProcessIdentityError('identity_write_failed');
      }
    }
  }

  async #claims(): Promise<string[]> {
    const directory = dirname(this.#path);
    const prefix = `${basename(this.#path)}.claim-`;
    const claims: string[] = [];
    let entries = 0;
    try {
      for await (const name of this.#deps.scan(directory)) {
        entries += 1;
        if (entries > DIRECTORY_ENTRY_LIMIT) {
          throw new BridgeProcessIdentityError('identity_corrupt');
        }
        if (basename(name) !== name || !name.startsWith(prefix)) continue;
        claims.push(join(directory, name));
        if (claims.length > 1) {
          throw new BridgeProcessIdentityError('identity_corrupt');
        }
      }
    } catch (error) {
      if (error instanceof BridgeProcessIdentityError) throw error;
      throw new BridgeProcessIdentityError('identity_corrupt');
    }
    return claims;
  }

  async #recoverClaim(): Promise<void> {
    const [tombstone] = await this.#claims();
    if (tombstone === undefined) return;
    const claimed = await this.#read(tombstone);
    if (claimed === undefined) return;
    try {
      await this.#deps.link(tombstone, this.#path);
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT') return;
      if (code !== 'EEXIST') {
        throw new BridgeProcessIdentityError('identity_write_failed');
      }
    }
    try {
      await this.#deps.unlink(tombstone);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        throw new BridgeProcessIdentityError('identity_write_failed');
      }
    }
  }
}
