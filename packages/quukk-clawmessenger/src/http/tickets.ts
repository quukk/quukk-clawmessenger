import { createHash, randomBytes as cryptoRandomBytes } from 'node:crypto';

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAXIMUM_OUTSTANDING = 16;
const INSTANCE_ID_PATTERN = /^svc_[0-9a-f]{32}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DOMAIN = 'quukk-launch-ticket-v1\0';

type TicketRecord = {
  issuedAt: number;
  expiresAt: number;
};

export interface LaunchTicketStoreOptions {
  instanceId: string;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
  ttlMs?: number;
  maximumOutstanding?: number;
}

function boundedPositive(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError('invalid_ticket_store_options');
  }
  return value;
}

function canonicalToken(value: string): boolean {
  if (!TOKEN_PATTERN.test(value)) return false;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.byteLength === 32 && decoded.toString('base64url') === value;
}

export class LaunchTicketStore {
  readonly #instanceId: string;
  readonly #now: () => number;
  readonly #randomBytes: (size: number) => Buffer;
  readonly #ttlMs: number;
  readonly #maximumOutstanding: number;
  readonly #tickets = new Map<string, TicketRecord>();

  constructor(options: LaunchTicketStoreOptions) {
    if (!INSTANCE_ID_PATTERN.test(options.instanceId)) {
      throw new RangeError('invalid_ticket_store_options');
    }
    this.#instanceId = options.instanceId;
    this.#now = options.now ?? Date.now;
    this.#randomBytes = options.randomBytes ?? cryptoRandomBytes;
    this.#ttlMs = boundedPositive(options.ttlMs ?? DEFAULT_TTL_MS, DEFAULT_TTL_MS);
    this.#maximumOutstanding = boundedPositive(
      options.maximumOutstanding ?? DEFAULT_MAXIMUM_OUTSTANDING,
      DEFAULT_MAXIMUM_OUTSTANDING,
    );
  }

  issue(): { ticket: string; expiresAt: number } {
    const now = this.#time();
    this.#prune(now);
    if (this.#tickets.size >= this.#maximumOutstanding) {
      throw new RangeError('ticket_capacity');
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const bytes = this.#randomBytes(32);
      if (!Buffer.isBuffer(bytes) || bytes.byteLength !== 32) {
        throw new RangeError('ticket_generation_failed');
      }
      const ticket = bytes.toString('base64url');
      const key = this.#key(ticket);
      if (this.#tickets.has(key)) continue;
      const expiresAt = now + this.#ttlMs;
      if (!Number.isSafeInteger(expiresAt)) throw new RangeError('ticket_generation_failed');
      this.#tickets.set(key, { issuedAt: now, expiresAt });
      return { ticket, expiresAt };
    }
    throw new RangeError('ticket_generation_failed');
  }

  consume(ticket: string): boolean {
    if (!canonicalToken(ticket)) return false;
    const key = this.#key(ticket);
    const record = this.#tickets.get(key);
    if (record === undefined) return false;
    this.#tickets.delete(key);
    return this.#time() < record.expiresAt;
  }

  clear(): void {
    this.#tickets.clear();
  }

  #key(ticket: string): string {
    return createHash('sha256')
      .update(DOMAIN, 'utf8')
      .update(this.#instanceId, 'utf8')
      .update('\0', 'utf8')
      .update(ticket, 'ascii')
      .digest('hex');
  }

  #prune(now: number): void {
    for (const [key, record] of this.#tickets) {
      if (now >= record.expiresAt) this.#tickets.delete(key);
    }
  }

  #time(): number {
    const value = this.#now();
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('invalid_clock');
    return value;
  }
}
