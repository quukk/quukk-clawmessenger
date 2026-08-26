// @vitest-environment node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  MAX_CHUNKS,
  MAX_MESSAGE_BYTES,
  MAX_DISCUSSION_CHUNKS,
  MAX_DISCUSSION_MESSAGE_BYTES,
  RAW_CHUNK_BYTES,
  RAW_DISCUSSION_CHUNK_BYTES,
  WIRE_BYTE_LIMIT,
  WIRE_FRAME_BYTE_LIMIT,
  DiscussionWireReassembler,
  encodeDiscussionWire,
} from './discussion-wire.js';

interface WireFixture {
  serialized: string;
  payload: Record<string, unknown>;
  frames: string[];
}

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/discussion-wire-cross-runtime.json', import.meta.url), 'utf8'),
) as WireFixture;

function payloadAtBytes(bytes: number): Record<string, unknown> {
  const payload = { content: 'x'.repeat(bytes - 14) };
  expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBe(bytes);
  return payload;
}

function parseFrames(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  return encodeDiscussionWire(payload).map((frame) => JSON.parse(frame) as Record<string, unknown>);
}

function mutateChunk(frame: Record<string, unknown>): Record<string, unknown> {
  const bytes = Buffer.from(frame.data as string, 'base64');
  bytes[0] = bytes[0]! ^ 1;
  return { ...frame, data: bytes.toString('base64') };
}

describe('discussion wire encoder', () => {
  it('exports the locked provider contract constant names', () => {
    expect(WIRE_BYTE_LIMIT).toBe(9_000);
    expect(RAW_CHUNK_BYTES).toBe(5_700);
    expect(MAX_MESSAGE_BYTES).toBe(8 * 1024 * 1024);
    expect(MAX_CHUNKS).toBe(2_048);
  });

  it('passes through a complete 9000-byte JSON frame and chunks 9001 bytes', () => {
    const exact = payloadAtBytes(WIRE_FRAME_BYTE_LIMIT);
    expect(encodeDiscussionWire(exact)).toEqual([JSON.stringify(exact)]);

    const chunked = encodeDiscussionWire(payloadAtBytes(WIRE_FRAME_BYTE_LIMIT + 1));
    expect(chunked.length).toBeGreaterThan(1);
    for (const frame of chunked) {
      expect(Buffer.byteLength(frame, 'utf8')).toBeLessThanOrEqual(WIRE_FRAME_BYTE_LIMIT);
      expect(Buffer.from((JSON.parse(frame) as { data: string }).data, 'base64').length)
        .toBeLessThanOrEqual(RAW_DISCUSSION_CHUNK_BYTES);
    }
  });

  it('accepts exactly 8 MiB and rejects one byte more', () => {
    const frames = encodeDiscussionWire(payloadAtBytes(MAX_DISCUSSION_MESSAGE_BYTES));
    expect(frames.length).toBeLessThanOrEqual(MAX_DISCUSSION_CHUNKS);
    expect(() => encodeDiscussionWire(payloadAtBytes(MAX_DISCUSSION_MESSAGE_BYTES + 1)))
      .toThrow(/8 MiB/);
  });

  it('derives deterministic lowercase SHA-256 identities', () => {
    const payload = { discussionId: 'discussion-1', content: '界'.repeat(4_000) };
    const serialized = JSON.stringify(payload);
    const expectedHash = createHash('sha256').update(Buffer.from(serialized, 'utf8')).digest('hex');
    const frames = parseFrames(payload);

    expect(frames[0]).toMatchObject({
      msg_type: 'discussion_wire_chunk',
      protocolVersion: 2,
      messageId: `wire_${expectedHash}`,
      sha256: expectedHash,
      chunkIndex: 0,
      chunkCount: frames.length,
      discussionId: 'discussion-1',
    });
  });
});

describe('discussion wire reassembler', () => {
  it('reassembles the MIT cross-runtime fixture byte-for-byte out of order', () => {
    const wire = new DiscussionWireReassembler();
    const results = [...fixture.frames].reverse().map((frame) => wire.accept('python-node', JSON.parse(frame)));

    expect(results[0]).toEqual({ status: 'incomplete' });
    expect(results[1]).toEqual({
      status: 'complete',
      payload: fixture.payload,
      serialized: fixture.serialized,
    });
  });

  it('isolates senders and rejects completed replays', () => {
    const frames = parseFrames({ discussionId: 'discussion-2', content: 'x'.repeat(10_000) });
    const wire = new DiscussionWireReassembler();

    expect(wire.accept('sender-a', frames[0])).toEqual({ status: 'incomplete' });
    expect(wire.accept('sender-b', frames[1])).toEqual({ status: 'incomplete' });
    expect(wire.accept('sender-a', frames[1])).toMatchObject({ status: 'complete' });
    expect(wire.accept('sender-b', frames[0])).toMatchObject({ status: 'complete' });
    expect(wire.accept('sender-a', frames[0])).toEqual({ status: 'replay' });
  });

  it('accepts exact duplicate chunks but invalidates conflicting duplicates', () => {
    const frames = parseFrames({ discussionId: 'discussion-3', content: 'x'.repeat(10_000) });
    const wire = new DiscussionWireReassembler();

    expect(wire.accept('sender', frames[0])).toEqual({ status: 'incomplete' });
    expect(wire.accept('sender', frames[0])).toEqual({ status: 'incomplete' });
    expect(wire.accept('sender', mutateChunk(frames[0]!))).toEqual({ status: 'invalid' });
    expect(wire.inflightCount).toBe(0);
    expect(wire.inflightBytes).toBe(0);
  });

  it('rejects hash mismatches, malformed UTF-8, non-record JSON, and unknown keys', () => {
    const frames = parseFrames({ discussionId: 'discussion-4', content: 'x'.repeat(10_000) });
    const hashMismatch = new DiscussionWireReassembler();
    expect(hashMismatch.accept('sender', frames[0])).toEqual({ status: 'incomplete' });
    expect(hashMismatch.accept('sender', mutateChunk(frames[1]!))).toEqual({ status: 'invalid' });

    for (const raw of [Buffer.from([0xff]), Buffer.from('[]'), Buffer.from('null')]) {
      const sha256 = createHash('sha256').update(raw).digest('hex');
      const frame = {
        msg_type: 'discussion_wire_chunk',
        protocolVersion: 2,
        messageId: `wire_${sha256}`,
        sha256,
        chunkIndex: 0,
        chunkCount: 1,
        data: raw.toString('base64'),
      };
      expect(new DiscussionWireReassembler().accept('sender', frame)).toEqual({ status: 'invalid' });
    }
    expect(new DiscussionWireReassembler().accept('sender', { ...frames[0], extra: true }))
      .toEqual({ status: 'invalid' });
  });

  it.each(['', 'YQ', '____', 'YQ==='])('rejects non-canonical Base64 %j', (data) => {
    const [frame] = parseFrames({ content: 'x'.repeat(10_000) });
    expect(new DiscussionWireReassembler().accept('sender', { ...frame, data }))
      .toEqual({ status: 'invalid' });
  });

  it('expires partials, clears a cancelled discussion, and fails closed at capacity', () => {
    let now = 0;
    const first = parseFrames({ discussionId: 'discussion-5', content: 'a'.repeat(10_000) });
    const second = parseFrames({ discussionId: 'discussion-6', content: 'b'.repeat(10_000) });
    const expiring = new DiscussionWireReassembler({ clock: () => now, ttlMs: 10 });
    expect(expiring.accept('sender', first[0])).toEqual({ status: 'incomplete' });
    now = 11;
    expect(expiring.accept('sender', first[1])).toEqual({ status: 'incomplete' });
    expiring.clearDiscussion('sender', 'discussion-5');
    expect(expiring.inflightCount).toBe(0);

    const capacity = new DiscussionWireReassembler({ maxInflightMessages: 1 });
    expect(capacity.accept('sender', first[0])).toEqual({ status: 'incomplete' });
    expect(capacity.accept('sender', second[0])).toEqual({ status: 'invalid' });

    const completedCapacity = new DiscussionWireReassembler({ maxCompleted: 0 });
    expect(completedCapacity.accept('sender', first[0])).toEqual({ status: 'incomplete' });
    expect(completedCapacity.accept('sender', first[1])).toEqual({ status: 'invalid' });
  });

  it('cannot raise hard limits through constructor options', () => {
    const oversizedCount = {
      msg_type: 'discussion_wire_chunk',
      protocolVersion: 2,
      messageId: `wire_${'a'.repeat(64)}`,
      sha256: 'a'.repeat(64),
      chunkIndex: 0,
      chunkCount: MAX_DISCUSSION_CHUNKS + 1,
      data: 'YQ==',
    };
    const wire = new DiscussionWireReassembler({ maxChunks: MAX_DISCUSSION_CHUNKS + 1 });
    expect(wire.accept('sender', oversizedCount)).toEqual({ status: 'invalid' });
  });

  it('passes non-wire payloads through unchanged', () => {
    const payload = { msg_type: 'discussion_cancel', discussionId: 'discussion-7' };
    expect(new DiscussionWireReassembler().accept('sender', payload))
      .toEqual({ status: 'passthrough', payload });
  });

  it('clears cancelled partials only for the scoped sender and discussion', () => {
    const frames = parseFrames({ discussionId: 'discussion-scope', content: 'x'.repeat(10_000) });
    const wire = new DiscussionWireReassembler();
    expect(wire.accept('sender-a', frames[0])).toEqual({ status: 'incomplete' });
    expect(wire.accept('sender-b', frames[0])).toEqual({ status: 'incomplete' });
    wire.clearDiscussion('sender-a', 'discussion-scope');
    expect(wire.inflightCount).toBe(1);
    expect(wire.accept('sender-b', frames[1])).toMatchObject({ status: 'complete' });
    expect(wire.accept('sender-a', frames[1])).toEqual({ status: 'incomplete' });
  });

  it('fails closed for cyclic or throwing-accessor wire objects', () => {
    const [base] = parseFrames({ content: 'x'.repeat(10_000) });
    const cyclic = { ...base } as Record<string, unknown> & { self?: unknown };
    cyclic.self = cyclic;
    expect(() => new DiscussionWireReassembler().accept('sender', cyclic)).not.toThrow();
    expect(new DiscussionWireReassembler().accept('sender', cyclic)).toEqual({ status: 'invalid' });

    const throwing = { ...base };
    Object.defineProperty(throwing, 'data', {
      enumerable: true,
      get: () => { throw new Error('provider getter must not escape'); },
    });
    expect(() => new DiscussionWireReassembler().accept('sender', throwing)).not.toThrow();
    expect(new DiscussionWireReassembler().accept('sender', throwing)).toEqual({ status: 'invalid' });
  });

  it('validates the actual serialized inbound frame bytes when raw evidence is available', () => {
    const raw = Buffer.from(JSON.stringify({ accepted: true }), 'utf8');
    const sha256 = createHash('sha256').update(raw).digest('hex');
    const serialized = JSON.stringify({
      msg_type: 'discussion_wire_chunk',
      protocolVersion: 2,
      messageId: `wire_${sha256}`,
      sha256,
      chunkIndex: 0,
      chunkCount: 1,
      data: raw.toString('base64'),
    });
    expect(new DiscussionWireReassembler().acceptSerialized('sender', serialized))
      .toMatchObject({ status: 'complete', payload: { accepted: true } });
    const padded = `${' '.repeat(WIRE_BYTE_LIMIT + 1 - Buffer.byteLength(serialized, 'utf8'))}${serialized}`;
    expect(Buffer.byteLength(padded, 'utf8')).toBe(WIRE_BYTE_LIMIT + 1);
    expect(new DiscussionWireReassembler().acceptSerialized('sender', padded)).toEqual({ status: 'invalid' });
  });

  it('uses dispose only for final teardown and keeps tombstones across partial resets', () => {
    const frames = parseFrames({ discussionId: 'discussion-dispose', content: 'x'.repeat(10_000) });
    const wire = new DiscussionWireReassembler();
    expect(wire.accept('sender', frames[0])).toEqual({ status: 'incomplete' });
    expect(wire.accept('sender', frames[1])).toMatchObject({ status: 'complete' });
    wire.clearPartials();
    expect(wire.accept('sender', frames[0])).toEqual({ status: 'replay' });
    wire.dispose();
    expect(wire.inflightCount).toBe(0);
    expect(wire.inflightBytes).toBe(0);
    expect(wire.accept('sender', frames[0])).toEqual({ status: 'invalid' });
  });
});
