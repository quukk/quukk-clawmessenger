import { z } from 'zod';
import { passiveSnapshot } from './messages.js';
import { DiscussionWireReassembler, encodeDiscussionWire } from './discussion-wire.js';

const identifier = z.string().min(1).max(256).refine((value) => value.trim() === value && !/[\p{Cc}\p{Cf}]/u.test(value));
const conversation = { conversation_type: z.union([z.literal(1), z.literal(3), z.literal(4)]), conversation_id: identifier };
const stream = { protocol_version: z.literal(1), stream_id: identifier, node_id: identifier };
const eventSchema = z.strictObject({
  msg_type: z.literal('chat_stream'), ...stream, ...conversation,
  request_message_id: identifier, requester_id: identifier,
  seq: z.number().int().nonnegative().safe(),
  status: z.enum(['processing', 'streaming', 'completed', 'cancelled', 'failed']),
  text: z.string().refine((value) => Buffer.byteLength(value, 'utf8') <= 1024 * 1024),
  error_code: identifier.optional(),
});
const stopSchema = z.strictObject({ msg_type: z.literal('chat_stop'), ...stream, ...conversation, request_id: identifier, request_message_id: identifier });
const resultSchema = z.strictObject({
  msg_type: z.literal('chat_stop_result'), ...stream, request_id: identifier,
  status: z.enum(['accepted', 'rejected']), code: z.enum(['stop_requested', 'no_active_task', 'forbidden', 'cancel_failed']),
}).refine((value) => (value.status === 'accepted') === (value.code === 'stop_requested'));
export type ChatStreamEvent = z.infer<typeof eventSchema>;
export type ChatStreamStatus = ChatStreamEvent['status'];
export type ChatStopRequest = z.infer<typeof stopSchema>;
export type ChatStopResult = z.infer<typeof resultSchema>;

function parse<T>(schema: z.ZodType<T>, value: unknown): T | null {
  // JSON can encode a single UTF-8 control byte as six ASCII bytes.
  const snapshot = passiveSnapshot(value, 6 * 1024 * 1024 + 16 * 1024);
  if (!snapshot.ok) return null;
  const parsed = schema.safeParse(snapshot.value);
  return parsed.success ? parsed.data : null;
}
export function parseChatStreamEvent(value: unknown): ChatStreamEvent | null { return parse(eventSchema, value); }
export function parseChatStopRequest(value: unknown): ChatStopRequest | null { return parse(stopSchema, value); }
export function parseChatStopResult(value: unknown): ChatStopResult | null { return parse(resultSchema, value); }

export function encodeChatStreamEvent(event: ChatStreamEvent): Array<{ messageType: 'chat_stream' | 'chat_stream_chunk'; content: Record<string, unknown> }> {
  const valid = parseChatStreamEvent(event);
  if (!valid) throw new TypeError('invalid_chat_stream');
  return encodeDiscussionWire(valid).map((serialized) => {
    const content = JSON.parse(serialized) as Record<string, unknown>;
    const messageType = content.msg_type === 'discussion_wire_chunk' ? 'chat_stream_chunk' : 'chat_stream';
    return { messageType, content: { ...content, msg_type: messageType } };
  });
}

/** Validate a single transport frame using the shared wire boundary. */
export function validChatStreamFrame(value: Record<string, unknown>): boolean {
  if (value.msg_type !== 'chat_stream_chunk' || Buffer.byteLength(JSON.stringify(value)) > 9000) return false;
  const wire = new DiscussionWireReassembler();
  const result = wire.accept('frame-validator', { ...value, msg_type: 'discussion_wire_chunk' });
  wire.dispose();
  return result.status === 'incomplete' || (result.status === 'complete' && parseChatStreamEvent(result.payload) !== null);
}
