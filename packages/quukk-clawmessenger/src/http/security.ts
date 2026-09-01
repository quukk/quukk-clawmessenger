import {
  createHash,
  createHmac,
  randomBytes as cryptoRandomBytes,
  timingSafeEqual,
} from 'node:crypto';

const DEFAULT_IDLE_TTL_MS = 30 * 60_000;
const DEFAULT_ABSOLUTE_TTL_MS = 8 * 60 * 60_000;
const DEFAULT_MAXIMUM_SESSIONS = 16;
const COOKIE_LIMIT = 4_096;
const INSTANCE_ID_PATTERN = /^svc_[0-9a-f]{32}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SESSION_COOKIE = 'quukk_session';

type SessionRecord = {
  csrfDigest: Buffer;
  createdAt: number;
  lastSeen: number;
  authVersion: number;
  previousLastSeen?: number;
};

export interface BrowserSessionStoreOptions {
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
  idleTtlMs?: number;
  absoluteTtlMs?: number;
  maximumSessions?: number;
}

function boundedPositive(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError('invalid_session_store_options');
  }
  return value;
}

function canonicalToken(value: string): boolean {
  if (!TOKEN_PATTERN.test(value)) return false;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.byteLength === 32 && decoded.toString('base64url') === value;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'ascii').digest();
}

function digestKey(value: string): string {
  return digest(value).toString('hex');
}

function generatedToken(randomBytes: (size: number) => Buffer): string {
  const bytes = randomBytes(32);
  if (!Buffer.isBuffer(bytes) || bytes.byteLength !== 32) {
    throw new RangeError('credential_generation_failed');
  }
  return bytes.toString('base64url');
}

function cookieToken(cookieHeader: string | undefined): string | undefined {
  if (
    cookieHeader === undefined
    || Buffer.byteLength(cookieHeader, 'utf8') > COOKIE_LIMIT
    || /[^\x20-\x7e]/.test(cookieHeader)
  ) {
    return undefined;
  }
  const found: string[] = [];
  for (const part of cookieHeader.split(';')) {
    const value = part.trim();
    const separator = value.indexOf('=');
    if (separator < 1 || value.slice(0, separator) !== SESSION_COOKIE) continue;
    found.push(value.slice(separator + 1));
  }
  if (found.length !== 1 || !canonicalToken(found[0]!)) return undefined;
  return found[0];
}

export class BrowserSessionStore {
  readonly #now: () => number;
  readonly #randomBytes: (size: number) => Buffer;
  readonly #idleTtlMs: number;
  readonly #absoluteTtlMs: number;
  readonly #maximumSessions: number;
  readonly #sessions = new Map<string, SessionRecord>();

  constructor(options: BrowserSessionStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#randomBytes = options.randomBytes ?? cryptoRandomBytes;
    this.#idleTtlMs = boundedPositive(
      options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS,
      DEFAULT_IDLE_TTL_MS,
    );
    this.#absoluteTtlMs = boundedPositive(
      options.absoluteTtlMs ?? DEFAULT_ABSOLUTE_TTL_MS,
      DEFAULT_ABSOLUTE_TTL_MS,
    );
    if (this.#absoluteTtlMs < this.#idleTtlMs) {
      throw new RangeError('invalid_session_store_options');
    }
    this.#maximumSessions = boundedPositive(
      options.maximumSessions ?? DEFAULT_MAXIMUM_SESSIONS,
      DEFAULT_MAXIMUM_SESSIONS,
    );
  }

  create(): { cookieValue: string; csrfToken: string; expiresInMs: number } {
    const now = this.#time();
    this.#prune(now);
    if (this.#sessions.size >= this.#maximumSessions) this.#evictLeastRecentlyUsed();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const cookieValue = generatedToken(this.#randomBytes);
      const key = digestKey(cookieValue);
      if (this.#sessions.has(key)) continue;
      const csrfToken = generatedToken(this.#randomBytes);
      this.#sessions.set(key, {
        csrfDigest: digest(csrfToken),
        createdAt: now,
        lastSeen: now,
        authVersion: 0,
      });
      return { cookieValue, csrfToken, expiresInMs: this.#absoluteTtlMs };
    }
    throw new RangeError('credential_generation_failed');
  }

  authenticate(cookieHeader: string | undefined): { sessionKey: string } | undefined {
    const token = cookieToken(cookieHeader);
    if (token === undefined) return undefined;
    const key = digestKey(token);
    const record = this.#sessions.get(key);
    if (record === undefined) return undefined;
    const now = this.#time();
    if (this.#expired(record, now)) {
      this.#sessions.delete(key);
      return undefined;
    }
    record.previousLastSeen = record.lastSeen;
    record.lastSeen = now;
    record.authVersion += 1;
    return { sessionKey: `${key}.${record.authVersion}` };
  }

  verifyCsrf(sessionKey: string, value: string | undefined): boolean {
    const match = /^([0-9a-f]{64})\.([1-9]\d*)$/.exec(sessionKey);
    if (match === null) return false;
    const key = match[1]!;
    const version = Number(match[2]);
    const record = this.#sessions.get(key);
    if (record === undefined || record.authVersion !== version) return false;
    const accepted =
      value !== undefined
      && canonicalToken(value)
      && timingSafeEqual(record.csrfDigest, digest(value));
    if (!accepted && record.previousLastSeen !== undefined) {
      record.lastSeen = record.previousLastSeen;
    }
    delete record.previousLastSeen;
    return accepted;
  }

  clear(): void {
    this.#sessions.clear();
  }

  #expired(record: SessionRecord, now: number): boolean {
    return now - record.lastSeen >= this.#idleTtlMs || now - record.createdAt >= this.#absoluteTtlMs;
  }

  #prune(now: number): void {
    for (const [key, record] of this.#sessions) {
      if (this.#expired(record, now)) this.#sessions.delete(key);
    }
  }

  #evictLeastRecentlyUsed(): void {
    let oldestKey: string | undefined;
    let oldest: SessionRecord | undefined;
    for (const [key, record] of this.#sessions) {
      if (
        oldest === undefined
        || record.lastSeen < oldest.lastSeen
        || (record.lastSeen === oldest.lastSeen && record.createdAt < oldest.createdAt)
      ) {
        oldestKey = key;
        oldest = record;
      }
    }
    if (oldestKey !== undefined) this.#sessions.delete(oldestKey);
  }

  #time(): number {
    const value = this.#now();
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('invalid_clock');
    return value;
  }
}

export function deriveControlCredential(bridgeSecret: string, instanceId: string): string {
  if (!canonicalToken(bridgeSecret) || !INSTANCE_ID_PATTERN.test(instanceId)) {
    throw new RangeError('invalid_control_credential_input');
  }
  return createHmac('sha256', Buffer.from(bridgeSecret, 'base64url'))
    .update(`quukk-local-control-v1\0${instanceId}`, 'utf8')
    .digest('base64url');
}

export function constantTimeCredentialEqual(expected: string, presented: string): boolean {
  if (!canonicalToken(expected) || !canonicalToken(presented)) return false;
  return timingSafeEqual(digest(expected), digest(presented));
}

const COMMON_SECURITY_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; frame-src 'none'; worker-src 'none'; form-action 'self'",
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
});

export function securityHeaders(): Readonly<Record<string, string>> {
  return COMMON_SECURITY_HEADERS;
}
