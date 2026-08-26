/**
 * Adapted from MIT-licensed OpenClaw ClawMessenger discussion contracts at
 * quukk/clawmessenger@a50f2393213f6f1c42da139491d2fe20937e7c7a
 * (`src/discussion/protocol.ts`, `src/discussion/turn-decider.ts`).
 * See THIRD_PARTY_NOTICES.md.
 */

export const DISCUSSION_TURN_TIMEOUT_MS = 60_000;

export type DiscussionV1Action = 'pass_turn' | 'end_discussion' | 'abort' | 'heartbeat';

export interface DiscussionV1Payload {
  group_id: string;
  turn_order: string[];
  current_speaker: string;
  current_speaker_name?: string;
  next_speaker?: string;
  round: number;
  max_rounds: number;
  originator_user: string;
  originator_text: string;
  originator_msg_uid: string;
  started_at: number;
  mention_ordered: boolean;
  last_speaker_response?: string;
}

export interface DiscussionV1Message {
  msg_type: 'discussion_token';
  service: 'openclaw_coord';
  discussion_id: string;
  version: 1;
  action: DiscussionV1Action;
  payload: DiscussionV1Payload;
  timestamp: number;
}

export interface BuildDiscussionV1Input {
  action: DiscussionV1Action;
  discussionId: string;
  payload: DiscussionV1Payload;
  timestamp: number;
}

export type DiscussionV1Advance =
  | { kind: 'pass_turn'; nextSpeaker: string; round: number }
  | { kind: 'end_discussion'; round: number }
  | { kind: 'invalid' };

const topKeys = ['msg_type', 'service', 'discussion_id', 'version', 'action', 'payload', 'timestamp'] as const;
const payloadRequiredKeys = [
  'group_id',
  'turn_order',
  'current_speaker',
  'round',
  'max_rounds',
  'originator_user',
  'originator_text',
  'originator_msg_uid',
  'started_at',
  'mention_ordered',
] as const;
const payloadOptionalKeys = ['current_speaker_name', 'next_speaker', 'last_speaker_response'] as const;
const controlCharacters = /[\p{Cc}\p{Cf}]/u;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function boundedIdentifier(value: unknown, max = 128): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= max
    && value.trim() === value
    && !controlCharacters.test(value);
}

function boundedText(value: unknown, maxBytes: number, allowEmpty = false): value is string {
  return typeof value === 'string'
    && (allowEmpty || value.length > 0)
    && Buffer.byteLength(value, 'utf8') <= maxBytes;
}

function safeInteger(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

function action(value: unknown): value is DiscussionV1Action {
  return value === 'pass_turn' || value === 'end_discussion' || value === 'abort' || value === 'heartbeat';
}

function parsePayload(raw: unknown, tokenAction: DiscussionV1Action): DiscussionV1Payload | null {
  if (!record(raw) || !exactKeys(raw, payloadRequiredKeys, payloadOptionalKeys)) return null;
  if (!boundedIdentifier(raw.group_id)
    || !boundedIdentifier(raw.current_speaker)
    || !boundedIdentifier(raw.originator_user)
    || !boundedIdentifier(raw.originator_msg_uid)
    || !boundedText(raw.originator_text, 100_000)
    || !safeInteger(raw.round, 1, 100)
    || !safeInteger(raw.max_rounds, 1, 100)
    || raw.round > raw.max_rounds
    || !safeInteger(raw.started_at, 1)
    || typeof raw.mention_ordered !== 'boolean') return null;

  if (!Array.isArray(raw.turn_order)
    || raw.turn_order.length < 1
    || raw.turn_order.length > 64
    || !raw.turn_order.every((member) => boundedIdentifier(member))
    || new Set(raw.turn_order).size !== raw.turn_order.length
    || !raw.turn_order.includes(raw.current_speaker)) return null;

  if (raw.current_speaker_name !== undefined && !boundedText(raw.current_speaker_name, 500)) return null;
  if (raw.last_speaker_response !== undefined && !boundedText(raw.last_speaker_response, 100_000, true)) return null;
  if (raw.next_speaker !== undefined
    && (!boundedIdentifier(raw.next_speaker) || !raw.turn_order.includes(raw.next_speaker))) return null;
  if (tokenAction === 'pass_turn' && raw.next_speaker === undefined) return null;
  if ((tokenAction === 'end_discussion' || tokenAction === 'abort') && raw.next_speaker !== undefined) return null;

  return {
    group_id: raw.group_id,
    turn_order: [...raw.turn_order],
    current_speaker: raw.current_speaker,
    ...(raw.current_speaker_name === undefined ? {} : { current_speaker_name: raw.current_speaker_name }),
    ...(raw.next_speaker === undefined ? {} : { next_speaker: raw.next_speaker }),
    round: raw.round,
    max_rounds: raw.max_rounds,
    originator_user: raw.originator_user,
    originator_text: raw.originator_text,
    originator_msg_uid: raw.originator_msg_uid,
    started_at: raw.started_at,
    mention_ordered: raw.mention_ordered,
    ...(raw.last_speaker_response === undefined ? {} : { last_speaker_response: raw.last_speaker_response }),
  };
}

export function parseDiscussionV1(raw: unknown): DiscussionV1Message | null {
  if (!record(raw)
    || !exactKeys(raw, topKeys)
    || raw.msg_type !== 'discussion_token'
    || raw.service !== 'openclaw_coord'
    || raw.version !== 1
    || !boundedIdentifier(raw.discussion_id)
    || !action(raw.action)
    || !safeInteger(raw.timestamp, 0)) return null;
  const payload = parsePayload(raw.payload, raw.action);
  if (!payload) return null;
  return {
    msg_type: 'discussion_token',
    service: 'openclaw_coord',
    discussion_id: raw.discussion_id,
    version: 1,
    action: raw.action,
    payload,
    timestamp: raw.timestamp,
  };
}

export function buildDiscussionV1(input: BuildDiscussionV1Input): DiscussionV1Message {
  const message = parseDiscussionV1({
    msg_type: 'discussion_token',
    service: 'openclaw_coord',
    discussion_id: input.discussionId,
    version: 1,
    action: input.action,
    payload: input.payload,
    timestamp: input.timestamp,
  });
  if (!message) throw new TypeError('invalid discussion v1 message');
  return message;
}

export function discussionV1Key(message: DiscussionV1Message): string {
  return JSON.stringify([
    message.discussion_id,
    message.payload.round,
    message.action,
    message.payload.current_speaker,
    message.payload.next_speaker ?? null,
  ]);
}

function advance(payload: DiscussionV1Payload, speaker: string): DiscussionV1Advance {
  const index = payload.turn_order.indexOf(speaker);
  if (index < 0 || !safeInteger(payload.round, 1) || !safeInteger(payload.max_rounds, 1)) {
    return { kind: 'invalid' };
  }
  if (index < payload.turn_order.length - 1) {
    return { kind: 'pass_turn', nextSpeaker: payload.turn_order[index + 1]!, round: payload.round };
  }
  if (payload.round < payload.max_rounds) {
    return { kind: 'pass_turn', nextSpeaker: payload.turn_order[0]!, round: payload.round + 1 };
  }
  return { kind: 'end_discussion', round: payload.round };
}

export function advanceAfterCompleted(payload: DiscussionV1Payload, completedSpeaker: string): DiscussionV1Advance {
  return advance(payload, completedSpeaker);
}

export function advanceAfterTimeout(payload: DiscussionV1Payload, timedOutSpeaker: string): DiscussionV1Advance {
  return advance(payload, timedOutSpeaker);
}
