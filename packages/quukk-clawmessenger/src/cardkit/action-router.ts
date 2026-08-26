/**
 * Fresh provider-neutral router derived from the MIT CardAction wire schema in
 * quukk/clawmessenger@a50f2393213f6f1c42da139491d2fe20937e7c7a
 * (`src/cardkit/schema.ts`). No upstream action-router implementation was
 * copied. See THIRD_PARTY_NOTICES.md.
 */

import { parseSlashCommand } from '../protocol/messages.js';
import type { CardModel } from './schema.js';
import { permissionUnsupportedCard } from './templates.js';
import { sanitizeCustomPayload } from './validate.js';

interface IntentMetadata {
  cardId: string;
  buttonId?: string;
  requestId?: string;
}

export type ActionIntent = ({ ok: true } & IntentMetadata & (
  | { kind: 'command'; name: '/new' | '/session' | '/sessions' | '/switch' | '/delete' | '/status' | '/stop'; argument?: string }
  | { kind: 'session'; op: 'switch' | 'delete'; sessionId: string }
  | { kind: 'answer'; questionId: string; value: string[] }
  | { kind: 'navigate'; target: string }
  | { kind: 'custom'; customKind: string; payload: Record<string, unknown> }
  | { kind: 'none' }
));

export type ActionError = ({ ok: false } & Partial<IntentMetadata> & {
  code: 'invalid_action' | 'unsupported_action' | 'unsupported_command' | 'unsupported_interactive_approval';
  status?: 400 | 501;
});

export type CardActionRoute = ActionIntent | ActionError;

export interface UnsupportedApprovalResult {
  msg_type: 'command_result';
  request_id?: string;
  status: 'error';
  code: 501;
  message: 'unsupported_interactive_approval';
  data: {
    card_state: {
      card_id: string;
      status: 'error';
      result: 'unsupported_interactive_approval';
      completed_action: 'permission';
      completed_at: number;
      card: CardModel;
    };
  };
  timestamp: number;
}

const dangerousKeys = new Set(['__proto__', 'prototype', 'constructor']);

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function identifier(value: unknown, max = 128): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= max
    && value.trim() === value
    && !/[\p{Cc}\p{Cf}]/u.test(value);
}

function text(value: unknown, max = 1_000): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= max
    && !/[\p{Cc}\p{Cf}]/u.test(value);
}

function metadata(value: Record<string, unknown>): IntentMetadata | null {
  if (!identifier(value.cardId)
    || (value.buttonId !== undefined && !identifier(value.buttonId))
    || (value.request_id !== undefined && !identifier(value.request_id))) return null;
  return {
    cardId: value.cardId,
    ...(value.buttonId === undefined ? {} : { buttonId: value.buttonId }),
    ...(value.request_id === undefined ? {} : { requestId: value.request_id }),
  };
}

function safePayloadShape(value: unknown, budget: { keys: number }, depth = 0): boolean {
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= 4_096 && !/[\p{Cc}\p{Cf}]/u.test(value);
  if (depth > 8) return false;
  if (Array.isArray(value)) {
    if (value.length > 64) return false;
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
        || !safePayloadShape(descriptor.value, budget, depth + 1)) return false;
    }
    return true;
  }
  if (!record(value)) return false;
  for (const key of Object.keys(value)) {
    if (dangerousKeys.has(key)) return false;
    budget.keys += 1;
    if (budget.keys > 64 || !identifier(key, 256)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      || !safePayloadShape(descriptor.value, budget, depth + 1)) return false;
  }
  return true;
}

function invalidAction(meta?: IntentMetadata): ActionError {
  return { ok: false, code: 'invalid_action', status: 400, ...meta };
}

export function routeCardAction(value: unknown): CardActionRoute {
  try {
    if (!record(value)
      || !exactKeys(value, ['msg_type', 'cardId', 'action'], ['buttonId', 'request_id', 'timestamp'])
      || value.msg_type !== 'card_action'
      || (value.timestamp !== undefined
        && (typeof value.timestamp !== 'number' || !Number.isSafeInteger(value.timestamp) || value.timestamp < 0))) {
      return invalidAction();
    }
    const meta = metadata(value);
    if (!meta || !record(value.action) || typeof value.action.type !== 'string') return invalidAction(meta ?? undefined);
    const cardAction = value.action;
    if (cardAction.type === 'permission') {
      if (!exactKeys(cardAction, ['type', 'permissionId', 'reply'])
        || !identifier(cardAction.permissionId)
        || (cardAction.reply !== 'once' && cardAction.reply !== 'always' && cardAction.reply !== 'reject')) {
        return invalidAction(meta);
      }
      return {
        ok: false,
        code: 'unsupported_interactive_approval',
        status: 501,
        ...meta,
      };
    }
    if (cardAction.type === 'answer') {
      if (!exactKeys(cardAction, ['type', 'questionId', 'value'])
        || !identifier(cardAction.questionId)
        || !Array.isArray(cardAction.value)
        || cardAction.value.length > 50
        || !cardAction.value.every((item) => text(item))) return invalidAction(meta);
      return { ok: true, kind: 'answer', ...meta, questionId: cardAction.questionId, value: [...cardAction.value] };
    }
    if (cardAction.type === 'command') {
      if (!exactKeys(cardAction, ['type', 'name']) || typeof cardAction.name !== 'string') return invalidAction(meta);
      const parsed = parseSlashCommand(cardAction.name);
      if (parsed.kind !== 'command') return { ok: false, code: 'unsupported_command', status: 400, ...meta };
      return {
        ok: true,
        kind: 'command',
        ...meta,
        name: parsed.name,
        ...(parsed.argument === undefined ? {} : { argument: parsed.argument }),
      };
    }
    if (cardAction.type === 'session') {
      if (!exactKeys(cardAction, ['type', 'op', 'sessionId'])
        || (cardAction.op !== 'switch' && cardAction.op !== 'delete')
        || !identifier(cardAction.sessionId)) return invalidAction(meta);
      return { ok: true, kind: 'session', ...meta, op: cardAction.op, sessionId: cardAction.sessionId };
    }
    if (cardAction.type === 'navigate') {
      if (!exactKeys(cardAction, ['type', 'target']) || !identifier(cardAction.target, 256)) return invalidAction(meta);
      return { ok: true, kind: 'navigate', ...meta, target: cardAction.target };
    }
    if (cardAction.type === 'custom') {
      if (!exactKeys(cardAction, ['type', 'kind', 'payload'])
        || !identifier(cardAction.kind)
        || !safePayloadShape(cardAction.payload, { keys: 0 })) return invalidAction(meta);
      const payload = sanitizeCustomPayload(cardAction.payload);
      if (!payload) return invalidAction(meta);
      return { ok: true, kind: 'custom', ...meta, customKind: cardAction.kind, payload };
    }
    if (cardAction.type === 'none') {
      return exactKeys(cardAction, ['type'])
        ? { ok: true, kind: 'none', ...meta }
        : invalidAction(meta);
    }
    return { ok: false, code: 'unsupported_action', status: 400, ...meta };
  } catch {
    return invalidAction();
  }
}

export function buildUnsupportedApprovalResult(value: unknown, timestamp: number): UnsupportedApprovalResult {
  const routed = routeCardAction(value);
  if (routed.ok || routed.code !== 'unsupported_interactive_approval'
    || !routed.cardId || !Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new TypeError('Invalid unsupported approval result input');
  }
  const card = permissionUnsupportedCard(routed.cardId, {
    permissionId: 'unsupported',
    permission: 'unsupported',
    title: 'Interactive permission replies are not available in this runtime.',
    patterns: [],
  });
  const result: UnsupportedApprovalResult = {
    msg_type: 'command_result',
    ...(routed.requestId === undefined ? {} : { request_id: routed.requestId }),
    status: 'error',
    code: 501,
    message: 'unsupported_interactive_approval',
    data: {
      card_state: {
        card_id: routed.cardId,
        status: 'error',
        result: 'unsupported_interactive_approval',
        completed_action: 'permission',
        completed_at: timestamp,
        card,
      },
    },
    timestamp,
  };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 10 * 1024) {
    throw new RangeError('command_result exceeds 10 KiB');
  }
  return result;
}
