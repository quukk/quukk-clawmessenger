/**
 * Adapted from MIT-licensed discussion wire implementations at
 * quukk/codex-clawmessenger@3f3a2e4d6a8cb143a0088350aed2e1b4d1675473
 * (`src/core/discussion-wire.ts`) and
 * quukk/clawmessenger@a50f2393213f6f1c42da139491d2fe20937e7c7a
 * (`src/discussion/wire.ts`). See THIRD_PARTY_NOTICES.md.
 */

import { createHash } from 'node:crypto';

export const WIRE_BYTE_LIMIT = 9_000;
export const RAW_CHUNK_BYTES = 5_700;
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
export const MAX_CHUNKS = 2_048;

export const WIRE_FRAME_BYTE_LIMIT = WIRE_BYTE_LIMIT;
export const RAW_DISCUSSION_CHUNK_BYTES = RAW_CHUNK_BYTES;
export const MAX_DISCUSSION_MESSAGE_BYTES = MAX_MESSAGE_BYTES;
export const MAX_DISCUSSION_CHUNKS = MAX_CHUNKS;

export type DiscussionWireResult =
  | { status: 'passthrough'; payload: unknown }
  | { status: 'incomplete' | 'invalid' | 'replay' }
  | { status: 'complete'; payload: Record<string, unknown>; serialized: string };

export interface DiscussionWireOptions {
  clock?: () => number;
  ttlMs?: number;
  maxMessageBytes?: number;
  maxChunks?: number;
  maxInflightMessages?: number;
  maxInflightBytes?: number;
  maxCompleted?: number;
}

interface PartialMessage {
  senderId: string;
  sha256: string;
  chunkCount: number;
  discussionId?: string;
  expiresAt: number;
  chunks: Map<number, Buffer>;
  receivedBytes: number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1_000;
const MAX_INFLIGHT_MESSAGES = 64;
const MAX_INFLIGHT_BYTES = 16 * 1024 * 1024;
const MAX_COMPLETED = 1_024;
const controlCharacters = /[\p{Cc}\p{Cf}]/u;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedId(value: unknown, max = 128): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= max
    && value.trim() === value
    && !controlCharacters.test(value);
}

function positiveInteger(value: number | undefined, fallback: number, hardMax: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError('invalid positive wire limit');
  return Math.min(value, hardMax);
}

function capacity(value: number | undefined, fallback: number, hardMax: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('invalid wire capacity');
  return Math.min(value, hardMax);
}

function canonicalBase64(value: string): Buffer | null {
  if (value.length < 4
    || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64') === value ? decoded : null;
}

function digest(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function encodeDiscussionWire(payload: Record<string, unknown>): string[] {
  const serialized = JSON.stringify(payload);
  const whole = Buffer.from(serialized, 'utf8');
  if (whole.length <= WIRE_FRAME_BYTE_LIMIT) return [serialized];
  if (whole.length > MAX_DISCUSSION_MESSAGE_BYTES) {
    throw new RangeError('discussion wire payload exceeds 8 MiB');
  }
  const sha256 = digest(whole);
  const messageId = `wire_${sha256}`;
  const chunkCount = Math.ceil(whole.length / RAW_DISCUSSION_CHUNK_BYTES);
  if (chunkCount > MAX_DISCUSSION_CHUNKS) throw new RangeError('discussion wire payload has too many chunks');
  const discussionId = boundedId(payload.discussionId) ? payload.discussionId : undefined;

  return Array.from({ length: chunkCount }, (_, chunkIndex) => {
    const frame = JSON.stringify({
      msg_type: 'discussion_wire_chunk',
      protocolVersion: 2,
      messageId,
      sha256,
      chunkIndex,
      chunkCount,
      ...(discussionId === undefined ? {} : { discussionId }),
      data: whole.subarray(
        chunkIndex * RAW_DISCUSSION_CHUNK_BYTES,
        (chunkIndex + 1) * RAW_DISCUSSION_CHUNK_BYTES,
      ).toString('base64'),
    });
    if (Buffer.byteLength(frame, 'utf8') > WIRE_FRAME_BYTE_LIMIT) {
      throw new RangeError('discussion wire frame exceeds provider limit');
    }
    return frame;
  });
}

export class DiscussionWireReassembler {
  readonly #clock: () => number;
  readonly #ttlMs: number;
  readonly #maxMessageBytes: number;
  readonly #maxChunks: number;
  readonly #maxInflightMessages: number;
  readonly #maxInflightBytes: number;
  readonly #maxCompleted: number;
  readonly #partials = new Map<string, PartialMessage>();
  readonly #completed = new Map<string, number>();
  #storedBytes = 0;
  #disposed = false;

  constructor(options: DiscussionWireOptions = {}) {
    this.#clock = options.clock ?? Date.now;
    this.#ttlMs = positiveInteger(options.ttlMs, DEFAULT_TTL_MS, DEFAULT_TTL_MS);
    this.#maxMessageBytes = positiveInteger(
      options.maxMessageBytes,
      MAX_DISCUSSION_MESSAGE_BYTES,
      MAX_DISCUSSION_MESSAGE_BYTES,
    );
    this.#maxChunks = positiveInteger(options.maxChunks, MAX_DISCUSSION_CHUNKS, MAX_DISCUSSION_CHUNKS);
    this.#maxInflightMessages = capacity(options.maxInflightMessages, MAX_INFLIGHT_MESSAGES, MAX_INFLIGHT_MESSAGES);
    this.#maxInflightBytes = capacity(options.maxInflightBytes, MAX_INFLIGHT_BYTES, MAX_INFLIGHT_BYTES);
    this.#maxCompleted = capacity(options.maxCompleted, MAX_COMPLETED, MAX_COMPLETED);
  }

  get inflightCount(): number {
    return this.#partials.size;
  }

  get inflightBytes(): number {
    return this.#storedBytes;
  }

  clearDiscussion(senderId: string, discussionId: string): void {
    for (const [key, partial] of this.#partials) {
      if (partial.senderId === senderId && partial.discussionId === discussionId) this.#remove(key);
    }
  }

  clearPartials(): void {
    this.#partials.clear();
    this.#storedBytes = 0;
  }

  /** Final teardown only; transient reconnects must retain completed tombstones. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.clearPartials();
    this.#completed.clear();
  }

  accept(senderId: string, value: unknown): DiscussionWireResult {
    let wireFrame: boolean;
    try {
      wireFrame = record(value) && value.msg_type === 'discussion_wire_chunk';
    } catch {
      return { status: 'invalid' };
    }
    if (!wireFrame) {
      return { status: 'passthrough', payload: value };
    }
    if (this.#disposed) return { status: 'invalid' };
    let serialized: string;
    let snapshot: unknown;
    try {
      serialized = JSON.stringify(value);
      snapshot = JSON.parse(serialized);
    } catch {
      return { status: 'invalid' };
    }
    if (!record(snapshot)) return { status: 'invalid' };
    return this.#acceptFrame(senderId, snapshot, Buffer.byteLength(serialized, 'utf8'));
  }

  /** Preferred Task 9 boundary when the provider's original frame string is available. */
  acceptSerialized(senderId: string, serializedFrame: string): DiscussionWireResult {
    if (typeof serializedFrame !== 'string'
      || Buffer.byteLength(serializedFrame, 'utf8') > WIRE_FRAME_BYTE_LIMIT) return { status: 'invalid' };
    let value: unknown;
    try {
      value = JSON.parse(serializedFrame);
    } catch {
      return { status: 'invalid' };
    }
    if (!record(value) || value.msg_type !== 'discussion_wire_chunk') {
      return { status: 'passthrough', payload: value };
    }
    if (this.#disposed) return { status: 'invalid' };
    return this.#acceptFrame(senderId, value, Buffer.byteLength(serializedFrame, 'utf8'));
  }

  #acceptFrame(
    senderId: string,
    value: Record<string, unknown>,
    serializedFrameBytes: number,
  ): DiscussionWireResult {
    const now = this.#clock();
    this.#cleanup(now);
    if (!this.#validFrame(senderId, value, serializedFrameBytes)) return { status: 'invalid' };

    const raw = canonicalBase64(value.data as string);
    if (!raw || raw.length < 1 || raw.length > RAW_DISCUSSION_CHUNK_BYTES) return { status: 'invalid' };
    const key = JSON.stringify([senderId, value.messageId]);
    if (this.#completed.has(key)) return { status: 'replay' };

    let partial = this.#partials.get(key);
    if (!partial) {
      if (this.#partials.size >= this.#maxInflightMessages
        || this.#storedBytes + raw.length > this.#maxInflightBytes) return { status: 'invalid' };
      partial = {
        senderId,
        sha256: value.sha256 as string,
        chunkCount: value.chunkCount as number,
        ...(value.discussionId === undefined ? {} : { discussionId: value.discussionId as string }),
        expiresAt: now + this.#ttlMs,
        chunks: new Map(),
        receivedBytes: 0,
      };
      this.#partials.set(key, partial);
    } else if (partial.sha256 !== value.sha256
      || partial.chunkCount !== value.chunkCount
      || partial.discussionId !== value.discussionId) {
      this.#remove(key);
      return { status: 'invalid' };
    }

    const index = value.chunkIndex as number;
    const previous = partial.chunks.get(index);
    if (previous) {
      if (previous.equals(raw)) return { status: 'incomplete' };
      this.#remove(key);
      return { status: 'invalid' };
    }
    if (partial.receivedBytes + raw.length > this.#maxMessageBytes
      || this.#storedBytes + raw.length > this.#maxInflightBytes) {
      this.#remove(key);
      return { status: 'invalid' };
    }
    partial.chunks.set(index, raw);
    partial.receivedBytes += raw.length;
    this.#storedBytes += raw.length;
    partial.expiresAt = now + this.#ttlMs;
    if (partial.chunks.size < partial.chunkCount) return { status: 'incomplete' };

    const ordered: Buffer[] = [];
    for (let chunkIndex = 0; chunkIndex < partial.chunkCount; chunkIndex += 1) {
      const chunk = partial.chunks.get(chunkIndex);
      if (!chunk) return { status: 'incomplete' };
      ordered.push(chunk);
    }
    const whole = Buffer.concat(ordered, partial.receivedBytes);
    this.#remove(key);
    if (whole.length > this.#maxMessageBytes || digest(whole) !== partial.sha256) return { status: 'invalid' };
    const serialized = whole.toString('utf8');
    if (!Buffer.from(serialized, 'utf8').equals(whole)) return { status: 'invalid' };
    let payload: unknown;
    try {
      payload = JSON.parse(serialized);
    } catch {
      return { status: 'invalid' };
    }
    if (!record(payload) || this.#completed.size >= this.#maxCompleted) return { status: 'invalid' };
    this.#completed.set(key, now + this.#ttlMs);
    return { status: 'complete', payload, serialized };
  }

  #validFrame(senderId: string, value: Record<string, unknown>, serializedFrameBytes: number): boolean {
    const required = ['msg_type', 'protocolVersion', 'messageId', 'sha256', 'chunkIndex', 'chunkCount', 'data'];
    const allowed = new Set([...required, 'discussionId']);
    return boundedId(senderId)
      && required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
      && Object.keys(value).every((key) => allowed.has(key))
      && value.protocolVersion === 2
      && typeof value.sha256 === 'string'
      && /^[0-9a-f]{64}$/.test(value.sha256)
      && value.messageId === `wire_${value.sha256}`
      && typeof value.chunkIndex === 'number'
      && Number.isSafeInteger(value.chunkIndex)
      && typeof value.chunkCount === 'number'
      && Number.isSafeInteger(value.chunkCount)
      && value.chunkCount >= 1
      && value.chunkCount <= this.#maxChunks
      && value.chunkIndex >= 0
      && value.chunkIndex < value.chunkCount
      && typeof value.data === 'string'
      && (value.discussionId === undefined || boundedId(value.discussionId))
      && Number.isSafeInteger(serializedFrameBytes)
      && serializedFrameBytes >= 1
      && serializedFrameBytes <= WIRE_FRAME_BYTE_LIMIT;
  }

  #remove(key: string): void {
    const partial = this.#partials.get(key);
    if (!partial) return;
    this.#storedBytes -= partial.receivedBytes;
    this.#partials.delete(key);
  }

  #cleanup(now: number): void {
    for (const [key, partial] of this.#partials) {
      if (partial.expiresAt <= now) this.#remove(key);
    }
    for (const [key, expiresAt] of this.#completed) {
      if (expiresAt <= now) this.#completed.delete(key);
    }
  }
}
