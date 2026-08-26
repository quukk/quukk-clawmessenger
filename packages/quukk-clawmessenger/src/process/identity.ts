import { randomUUID } from 'node:crypto';
import { link as fsLink, rename as fsRename, unlink as fsUnlink } from 'node:fs/promises';

import { z } from 'zod';

import { atomicWriteJson, readJsonFileIfExists } from '../config/atomic-json.js';
import { localPaths } from '../config/paths.js';

const IDENTITY_LIMIT = 16_384;

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
  link(existing: string, destination: string): Promise<unknown>;
  unlink(path: string): Promise<unknown>;
  tombstonePath(path: string): string;
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
      link: options.dependencies?.link ?? fsLink,
      unlink: options.dependencies?.unlink ?? fsUnlink,
      tombstonePath:
        options.dependencies?.tombstonePath ??
        ((path) => `${path}.claim-${process.pid}-${randomUUID()}`),
    };
  }

  async read(): Promise<BridgeProcessIdentity | undefined> {
    return this.#read(this.#path);
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
    const tombstone = this.#deps.tombstonePath(this.#path);
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
}
