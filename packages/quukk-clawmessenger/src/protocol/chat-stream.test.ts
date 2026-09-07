// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { encodeChatStreamEvent, parseChatStreamEvent, parseChatStopRequest, parseChatStopResult } from './chat-stream.js';
import { DiscussionWireReassembler } from './discussion-wire.js';
import { parseWorkerCommand } from '../rongcloud/worker-protocol.js';
import { normalizeRongCloudMessage, parseProtocolContent } from './messages.js';

const event = { msg_type: 'chat_stream', protocol_version: 1, stream_id: 's1', request_message_id: 'm1', requester_id: 'u1', node_id: 'codex_1', conversation_type: 1, conversation_id: 'u1', seq: 1, status: 'streaming', text: '你好' } as const;
const stop = { msg_type: 'chat_stop', protocol_version: 1, request_id: 'r1', stream_id: 's1', request_message_id: 'm1', node_id: 'codex_1', conversation_type: 1, conversation_id: 'u1' } as const;
describe('chat stream contract', () => {
  it('validates strict passive envelopes and bounded identifiers', () => {
    expect(parseChatStreamEvent(event)?.text).toBe('你好');
    for (const change of [{ seq: -1 }, { seq: 1.5 }, { seq: Number.MAX_SAFE_INTEGER + 1 }, { status: 'other' }, { protocol_version: 2 }, { stream_id: '' }, { stream_id: ' s1' }, { stream_id: 's\u200b1' }, { stream_id: 'x'.repeat(257) }, { task_id: 'attack' }, { text: '中'.repeat(350000) }]) expect(parseChatStreamEvent({ ...event, ...change })).toBeNull();
    let invoked = false;
    expect(parseChatStreamEvent({ ...event, get text() { invoked = true; return ''; } })).toBeNull();
    expect(invoked).toBe(false);
    expect(parseChatStopRequest(stop)).toEqual(stop);
    expect(parseChatStopRequest({ ...stop, task_id: 'attack' })).toBeNull();
    expect(parseChatStopResult({ msg_type: 'chat_stop_result', protocol_version: 1, request_id: 'r1', stream_id: 's1', node_id: 'codex_1', status: 'accepted', code: 'stop_requested' })).not.toBeNull();
  });
  it('encodes and validates actual worker frames and reassembles Unicode losslessly', () => {
    const full = { ...event, text: '你好🌍'.repeat(3000) };
    const frames = encodeChatStreamEvent(full);
    const reassembler = new DiscussionWireReassembler();
    expect(frames.length).toBeGreaterThan(1);
    let result;
    for (const frame of frames) {
      expect(Buffer.byteLength(JSON.stringify(frame.content))).toBeLessThanOrEqual(9000);
      expect(parseWorkerCommand({ type: 'send', requestId: 'r1', conversationType: 1, targetId: 'u1', ...frame }).ok).toBe(true);
      result = reassembler.accept('codex_1', { ...frame.content, msg_type: 'discussion_wire_chunk' });
    }
    expect(result).toMatchObject({ status: 'complete', payload: full });
    const small = encodeChatStreamEvent(event)[0]!;
    expect(small.messageType).toBe('chat_stream');
    expect(parseWorkerCommand({ type: 'send', requestId: 'r1', conversationType: 1, targetId: 'u1', ...small }).ok).toBe(true);
    expect(parseWorkerCommand({ type: 'send', requestId: 'r1', conversationType: 1, targetId: 'u1', ...small, content: { ...event, status: 'bad' } }).ok).toBe(false);
    expect(parseWorkerCommand({ type: 'send', requestId: 'r1', conversationType: 1, targetId: 'u1', messageType: 'chat_stream_chunk', content: { ...frames[0]!.content, chunkIndex: -1 } }).ok).toBe(false);
  });
  it('preserves stop fields through actual inbound normalization', () => {
    const normalized = normalizeRongCloudMessage({ messageUId: 'm2', senderUserId: 'u1', targetId: 'codex_1', conversationType: 1, messageType: 'chat_stop', content: stop });
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    const parsed = parseProtocolContent(normalized.value.rawContent);
    expect(parsed).toMatchObject({ kind: 'protocol', msgType: 'chat_stop', value: stop });
  });
});
