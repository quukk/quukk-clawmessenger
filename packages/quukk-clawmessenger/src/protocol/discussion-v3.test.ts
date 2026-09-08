import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/discussion-v3-messages.json', import.meta.url), 'utf8'));
import { parseDiscussionV3, matchesDiscussionV3CancelAck } from './discussion-v3.js';
import { createHash } from 'node:crypto';
it('accepts nonempty whitespace deltas while completed contributions remain nonblank',()=>{
  for (const content of [' ', '\n', '\t  ']) {
    expect(parseDiscussionV3({...fixture.valid.delta,content})).not.toBeNull();
    expect(parseDiscussionV3({...fixture.valid.completed,content})).toBeNull();
  }
  expect(parseDiscussionV3({...fixture.valid.delta,content:''})).toBeNull();
});
const runtimeFixture = JSON.parse(readFileSync(new URL('./fixtures/discussion-wire-cross-runtime.json', import.meta.url), 'utf8'));
for (const bucket of ['valid','invalid'] as const) {
  for (const event of runtimeFixture.v3EventContracts[bucket]) {
    it(`validates public v3 ${event.eventType} (${bucket})`,()=>{
      const message = {...fixture.valid.event,...event};
      if(event.requestId !== undefined) message.requestId=event.requestId;
      expect(parseDiscussionV3(message)!==null).toBe(bucket==='valid');
    });
  }
}
for (const [name, message] of Object.entries(fixture.valid)) {
  it(`accepts shared ${name}`, () => expect(parseDiscussionV3(message)).toEqual(message));
}
for (const item of fixture.invalid) {
  it(`rejects shared ${item.name}`, () => expect(parseDiscussionV3(item.message)).toBeNull());
}
for (const [message, valid] of [...Object.values(fixture.valid).map(message => [message, true]), ...fixture.invalid.map((c: {message: unknown}) => [c.message, false])] as Array<[Record<string, unknown>, boolean]>) {
  it(`validates framed ${message.msg_type} (${valid})`, () => {
    const raw = Buffer.from(JSON.stringify(message));
    const sha256 = createHash('sha256').update(raw).digest('hex');
    const count = Math.ceil(raw.length / 120);
    const codec = new DiscussionWireReassembler();
    let result;
    for (let index = count - 1; index >= 0; index--) result = codec.accept('node-1', {
      msg_type: 'discussion_wire_chunk', protocolVersion: 3, messageId: `wire_${sha256}`, sha256,
      chunkIndex: index, chunkCount: count, data: raw.subarray(index * 120, (index + 1) * 120).toString('base64'),
    });
    if (message.protocolVersion !== 3) expect(result?.status).toBe('invalid');
    else {
      expect(result?.status).toBe('complete');
      if (result?.status === 'complete') expect(parseDiscussionV3(result.payload) !== null).toBe(valid);
    }
  });
}
it('correlates ACK command and target request identities separately', () => {
  expect(matchesDiscussionV3CancelAck(fixture.valid.cancel, fixture.valid.cancelAck)).toBe(true);
  for (const key of ['requestId', 'targetRequestId', 'targetMemberId', 'discussionId', 'chatroomId']) {
    expect(matchesDiscussionV3CancelAck(fixture.valid.cancel, { ...fixture.valid.cancelAck, [key]: 'other' })).toBe(false);
  }
});
it('rejects explicit null inner version in a v2 frame', () => {
  const codec = new DiscussionWireReassembler();
  const frames = encodeDiscussionWire({ protocolVersion: null, content: 'x'.repeat(20000) });
  let result;
  for (const frame of frames) result = codec.accept('node-1', { ...JSON.parse(frame), protocolVersion: 2 });
  expect(result?.status).toBe('invalid');
});
import { DiscussionWireReassembler, encodeDiscussionWire } from './discussion-wire.js';

it('preserves v3 on every frame and reassembles out of order', () => {
  const payload = { protocolVersion: 3, content: 'x'.repeat(20000) };
  const frames = encodeDiscussionWire(payload).map(frame => JSON.parse(frame));
  expect(frames.every(frame => frame.protocolVersion === 3)).toBe(true);
  const codec = new DiscussionWireReassembler();
  let result;
  for (const frame of frames.reverse()) result = codec.accept('node-1', frame);
  expect(result).toMatchObject({ status: 'complete', payload });
});

it('rejects mixed versions and explicit inner/outer mismatch', () => {
  const frames = encodeDiscussionWire({ protocolVersion: 3, content: 'x'.repeat(20000) }).map(frame => JSON.parse(frame));
  const codec = new DiscussionWireReassembler();
  expect(codec.accept('node-1', { ...frames[0], protocolVersion: 3 }).status).toBe('incomplete');
  expect(codec.accept('node-1', { ...frames[1], protocolVersion: 2 }).status).toBe('invalid');
  const mismatch = new DiscussionWireReassembler();
  let result;
  for (const frame of frames) result = mismatch.accept('node-1', { ...frame, protocolVersion: 2 });
  expect(result?.status).toBe('invalid');
});
