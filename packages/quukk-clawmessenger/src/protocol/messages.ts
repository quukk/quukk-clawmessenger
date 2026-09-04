/**
 * Adapted from MIT-licensed Codex ClawMessenger message normalization at
 * quukk/codex-clawmessenger@3f3a2e4d6a8cb143a0088350aed2e1b4d1675473
 * (`src/rongcloud/client.ts`, `src/core/message-handler.ts`, `src/core/types.ts`).
 * See THIRD_PARTY_NOTICES.md.
 */

import { isProxy } from 'node:util/types';

export const MAX_RONGCLOUD_MESSAGE_BYTES = 64 * 1024;

export const EXTERNAL_MESSAGE_TYPES = [
  'create_opencode_session',
  'opencode_session_created',
  'delete_opencode_session',
  'device_status_request',
  'device_status_report',
  'device_control',
  'device_control_result',
  'command_result',
  'chatroom_invite',
  'chatroom_message',
  'card_message',
  'card_update',
  'card_action',
  'discussion_token',
  'discussion_host_turn',
  'discussion_assignment',
  'discussion_cancel',
  'discussion_artifact_ack',
  'discussion_host_decision',
  'discussion_contribution_delta',
  'discussion_contribution_completed',
  'discussion_artifact_update',
  'discussion_node_error',
  'discussion_model_catalog_request',
  'discussion_model_catalog_response',
  'discussion_role_recommendation_request',
  'discussion_role_recommendation_response',
  'discussion_wire_chunk',
] as const;

export type ExternalMessageType = typeof EXTERNAL_MESSAGE_TYPES[number];
export type RongCloudConversationType = 1 | 3 | 4;

export interface NormalizedAttachment {
  kind: 'image' | 'file';
  url: string;
  name?: string;
  mimeType?: string;
  size?: number;
}

export interface NormalizedRongCloudMessage {
  messageUid: string;
  senderId: string;
  targetId: string;
  conversationType: RongCloudConversationType;
  objectName: string;
  text?: string;
  attachments: NormalizedAttachment[];
  rawContent?: Record<string, unknown>;
  sentTime?: number;
  offline?: boolean;
  direction?: number | string;
}

export type MessageFailureCode =
  | 'invalid_message'
  | 'message_too_large'
  | 'missing_message_uid'
  | 'invalid_identifier'
  | 'invalid_conversation_type'
  | 'invalid_content'
  | 'conflicting_alias';

export type NormalizeMessageResult =
  | { ok: true; value: NormalizedRongCloudMessage }
  | { ok: false; code: MessageFailureCode };

export type ProtocolContentResult =
  | { kind: 'text'; text: string }
  | { kind: 'protocol'; msgType: ExternalMessageType; value: Record<string, unknown> }
  | { kind: 'ignored'; code: 'unknown_message_type' | 'server_only_message' | 'system_message' }
  | { kind: 'invalid'; code: 'invalid_content' | 'content_too_large' | 'conflicting_alias' };

export type SlashCommandResult =
  | { kind: 'command'; name: '/new' | '/session' | '/sessions' | '/switch' | '/delete' | '/status' | '/stop'; argument?: string }
  | { kind: 'text'; text: string }
  | { kind: 'invalid'; code: 'invalid_command' };

type AliasResult<T> = { ok: true; value?: T } | { ok: false; code: 'invalid' | 'conflict' };

const externalTypes = new Set<string>(EXTERNAL_MESSAGE_TYPES);
const v2AndCardTypes = new Set<string>([
  'card_message',
  'card_update',
  'card_action',
  'discussion_token',
  'discussion_host_turn',
  'discussion_assignment',
  'discussion_cancel',
  'discussion_artifact_ack',
  'discussion_host_decision',
  'discussion_contribution_delta',
  'discussion_contribution_completed',
  'discussion_artifact_update',
  'discussion_node_error',
  'discussion_model_catalog_request',
  'discussion_model_catalog_response',
  'discussion_role_recommendation_request',
  'discussion_role_recommendation_response',
  'discussion_wire_chunk',
]);
const cardEnvelopeTypes = new Set<string>(['card_message', 'card_update', 'command_result']);
const maxCardEnvelopeBytes = 10 * 1024;
const controlCharacters = /[\p{Cc}\p{Cf}]/u;
const dangerousObjectKeys = new Set(['__proto__', 'prototype', 'constructor']);
const rawContentKeys = new Set([
  'content', 'attachments', 'msg_type', 'service', 'version', 'action', 'payload', 'timestamp',
  'request_id', 'requestId', 'source_im_id', 'sourceImId', 'destination_im_id', 'destinationImId',
  'session_id', 'sessionId', 'chatroom_id', 'chatroomId', 'origin_message_uid', 'originMessageUId',
  'card_id', 'cardId', 'button_id', 'buttonId', 'max_rounds', 'maxRounds', 'openclaw_max_rounds',
  'command', 'type', 'cmd', 'title', 'name', 'status', 'code', 'message', 'data',
  'opencode_session_id', 'protocolVersion', 'discussionId', 'chatroomId', 'stateVersion', 'round',
  'topic', 'goal', 'roles', 'allowedDecisions', 'remainingRounds', 'eventSummary', 'currentArtifact',
  'assignmentId', 'targetId', 'task', 'mode', 'model', 'role', 'speakingOrder', 'roundFocus',
  'priorContributions', 'roundSummaries', 'userInterjections', 'attempt', 'reason', 'updateId',
  'idempotencyKey', 'artifactId', 'artifactVersion', 'decision', 'seq', 'planSummary',
  'memberPositions', 'agreements', 'disagreements', 'openQuestions', 'nextFocus', 'recommendation',
  'artifactType', 'instructions', 'operation', 'baseVersion', 'isFinal', 'category', 'defaultModel',
  'providers', 'messageId', 'sha256', 'chunkIndex', 'chunkCount', 'schema', 'card',
  'max_roles', 'candidates', 'recommendation_prompt', 'config_version', 'node_id', 'display_name',
  'runtime_type', 'capabilities', 'default_model', 'models', 'role_name', 'role_prompt',
  'speaking_order', 'error_code',
]);
const invalidClone = Symbol('invalid-clone');
const oversizedClone = Symbol('oversized-clone');
const MAX_PASSIVE_JSON_ITEMS = 32_768;
const MAX_PASSIVE_JSON_DEPTH = 32;
const deviceControlCommands = new Set([
  'status', 'disable', 'stop', 'enable', 'start', 'delete', 'restart', 'rename_device',
]);

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function own(source: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(source, key);
}

interface PassiveCloneBudget {
  items: number;
  textBytes: number;
  maxBytes: number;
}

type PassiveCloneResult = unknown | typeof invalidClone | typeof oversizedClone;

function accountText(value: string, budget: PassiveCloneBudget): typeof oversizedClone | null {
  if (value.length > budget.maxBytes) return oversizedClone;
  budget.textBytes += Buffer.byteLength(value, 'utf8');
  return budget.textBytes > budget.maxBytes ? oversizedClone : null;
}

function clonePassiveJson(
  value: unknown,
  budget: PassiveCloneBudget,
  ancestors: Set<object>,
  depth = 0,
): PassiveCloneResult {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return accountText(value, budget) ?? value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : invalidClone;
  if (typeof value !== 'object' || value === null || isProxy(value)) return invalidClone;
  if (depth >= MAX_PASSIVE_JSON_DEPTH || ancestors.has(value)) return invalidClone;
  budget.items += 1;
  if (budget.items > MAX_PASSIVE_JSON_ITEMS) return oversizedClone;

  ancestors.add(value);
  if (Array.isArray(value)) {
    if (value.length > MAX_PASSIVE_JSON_ITEMS) {
      ancestors.delete(value);
      return oversizedClone;
    }
    budget.items += value.length;
    if (budget.items > MAX_PASSIVE_JSON_ITEMS) {
      ancestors.delete(value);
      return oversizedClone;
    }
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        ancestors.delete(value);
        return invalidClone;
      }
      const cloned = clonePassiveJson(descriptor.value, budget, ancestors, depth + 1);
      if (cloned === invalidClone || cloned === oversizedClone) {
        ancestors.delete(value);
        return cloned;
      }
      result.push(cloned);
    }
    for (const key of Object.getOwnPropertyNames(value)) {
      if (key === 'length' || /^(?:0|[1-9]\d*)$/.test(key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        ancestors.delete(value);
        return invalidClone;
      }
    }
    ancestors.delete(value);
    return result;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    ancestors.delete(value);
    return invalidClone;
  }
  const result: Record<string, unknown> = {};
  const keys = Object.getOwnPropertyNames(value);
  budget.items += keys.length;
  if (budget.items > MAX_PASSIVE_JSON_ITEMS) {
    ancestors.delete(value);
    return oversizedClone;
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      ancestors.delete(value);
      return invalidClone;
    }
    if (!descriptor.enumerable || dangerousObjectKeys.has(key)) continue;
    const keyBudget = accountText(key, budget);
    if (keyBudget) {
      ancestors.delete(value);
      return keyBudget;
    }
    if (descriptor.value === undefined
      || typeof descriptor.value === 'function'
      || typeof descriptor.value === 'symbol') continue;
    const cloned = clonePassiveJson(descriptor.value, budget, ancestors, depth + 1);
    if (cloned === invalidClone || cloned === oversizedClone) {
      ancestors.delete(value);
      return cloned;
    }
    result[key] = cloned;
  }
  ancestors.delete(value);
  return result;
}

type PassiveSnapshot =
  | { ok: true; value: unknown; bytes: number }
  | { ok: false; code: 'invalid' | 'too_large' };

function passiveSnapshot(value: unknown, maxBytes = MAX_RONGCLOUD_MESSAGE_BYTES): PassiveSnapshot {
  const cloned = clonePassiveJson(value, { items: 0, textBytes: 0, maxBytes }, new Set());
  if (cloned === invalidClone) return { ok: false, code: 'invalid' };
  if (cloned === oversizedClone) return { ok: false, code: 'too_large' };
  const bytes = serializedBytes(cloned);
  if (bytes === null) return { ok: false, code: 'invalid' };
  return bytes > maxBytes ? { ok: false, code: 'too_large' } : { ok: true, value: cloned, bytes };
}

function serializedBytes(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : Buffer.byteLength(serialized, 'utf8');
  } catch {
    return null;
  }
}

function identifier(value: unknown, max = 256): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length >= 1 && normalized.length <= max && !controlCharacters.test(normalized)
    ? normalized
    : null;
}

function alias<T>(
  source: Record<string, unknown>,
  keys: readonly string[],
  parse: (value: unknown) => T | null,
): AliasResult<T> {
  let selected: T | undefined;
  for (const key of keys) {
    if (!own(source, key) || source[key] === undefined || source[key] === null || source[key] === '') continue;
    const parsed = parse(source[key]);
    if (parsed === null) return { ok: false, code: 'invalid' };
    if (selected !== undefined && !sameAliasValue(selected, parsed)) return { ok: false, code: 'conflict' };
    selected = parsed;
  }
  return { ok: true, ...(selected === undefined ? {} : { value: selected }) };
}

function sameAliasValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function conversationType(value: unknown): RongCloudConversationType | null {
  if (value === 1 || value === 3 || value === 4) return value;
  return null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function safePositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

interface DecodedContent {
  text?: string;
  rawContent?: Record<string, unknown>;
}

function decodeContent(input: unknown): DecodedContent | null {
  let value = input;
  let rawContent: Record<string, unknown> | undefined;

  for (let depth = 0; depth <= 2; depth += 1) {
    if (typeof value === 'string') {
      if (Buffer.byteLength(value, 'utf8') > MAX_RONGCLOUD_MESSAGE_BYTES) return null;
      const parsed = parseRecordJson(value);
      if (parsed && depth < 2) {
        value = parsed;
        rawContent = parsed;
        continue;
      }
      return { text: value, ...(rawContent ? { rawContent } : {}) };
    }

    if (!record(value)) return null;
    rawContent = value;
    if (!own(value, 'content')) return { rawContent };
    const nested = value.content;
    if (typeof nested !== 'string') return { rawContent };
    const parsed = parseRecordJson(nested);
    if (parsed && depth < 2) {
      if (typeof rawContent.msg_type === 'string') return { rawContent };
      value = parsed;
      rawContent = parsed;
      continue;
    }
    return { text: nested, rawContent };
  }

  return rawContent ? { rawContent } : null;
}

function parseRecordJson(value: string): Record<string, unknown> | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return record(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeAttachments(rawContent: Record<string, unknown> | undefined): NormalizedAttachment[] {
  if (!rawContent || !Array.isArray(rawContent.attachments)) return [];
  const result: NormalizedAttachment[] = [];
  for (const value of rawContent.attachments.slice(0, 16)) {
    if (!record(value)) continue;
    const kind = value.kind === 'image' || value.type === 'image'
      ? 'image'
      : value.kind === 'file' || value.type === 'file' ? 'file' : null;
    const url = identifier(value.url ?? value.fileUrl ?? value.imageUri, 2_048);
    if (!kind || !url) continue;
    const name = value.name === undefined ? undefined : identifier(value.name, 512) ?? undefined;
    const mimeType = value.mimeType === undefined ? undefined : identifier(value.mimeType, 128) ?? undefined;
    const size = typeof value.size === 'number' && Number.isSafeInteger(value.size) && value.size >= 0
      ? value.size
      : undefined;
    result.push({ kind, url, ...(name ? { name } : {}), ...(mimeType ? { mimeType } : {}), ...(size === undefined ? {} : { size }) });
  }
  return result;
}

function cloneSafeJson(value: unknown, depth = 0): unknown | typeof invalidClone {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : invalidClone;
  if (depth >= 32 || typeof value !== 'object') return invalidClone;
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const item of value) {
      const cloned = cloneSafeJson(item, depth + 1);
      if (cloned === invalidClone) return invalidClone;
      result.push(cloned);
    }
    return result;
  }
  const result: Record<string, unknown> = {};
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    return invalidClone;
  }
  for (const key of keys) {
    if (dangerousObjectKeys.has(key)) continue;
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      return invalidClone;
    }
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) continue;
    const cloned = cloneSafeJson(descriptor.value, depth + 1);
    if (cloned !== invalidClone) result[key] = cloned;
  }
  return result;
}

function rebuildRawContent(
  value: Record<string, unknown>,
  attachments: NormalizedAttachment[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of rawContentKeys) {
    if (!own(value, key) || key === 'attachments') continue;
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      continue;
    }
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) continue;
    const cloned = cloneSafeJson(descriptor.value);
    if (cloned !== invalidClone) result[key] = cloned;
  }
  if (own(value, 'attachments')) {
    result.attachments = attachments.map((attachment) => ({ ...attachment }));
  }
  return result;
}

export function normalizeRongCloudMessage(raw: unknown): NormalizeMessageResult {
  const snapshot = passiveSnapshot(raw);
  if (!snapshot.ok) {
    return { ok: false, code: snapshot.code === 'too_large' ? 'message_too_large' : 'invalid_message' };
  }
  if (!record(snapshot.value)) return { ok: false, code: 'invalid_message' };
  const safeRaw = snapshot.value;

  const globalUid = alias(safeRaw, ['messageUId', 'messageUID', 'messageUid'], identifier);
  const uid = globalUid.ok && globalUid.value === undefined
    ? alias(safeRaw, ['messageId'], identifier)
    : globalUid;
  const sender = alias(safeRaw, ['senderUserId', 'senderId'], identifier);
  const objectName = alias(safeRaw, ['messageType', 'objectName', 'messageName'], (value) => identifier(value, 128));
  if (!uid.ok || !sender.ok || !objectName.ok) {
    const conflict = (!uid.ok && uid.code === 'conflict')
      || (!sender.ok && sender.code === 'conflict')
      || (!objectName.ok && objectName.code === 'conflict');
    return { ok: false, code: conflict ? 'conflicting_alias' : 'invalid_identifier' };
  }
  if (uid.value === undefined) return { ok: false, code: 'missing_message_uid' };
  const targetId = identifier(safeRaw.targetId);
  if (!sender.value || !targetId || !objectName.value) return { ok: false, code: 'invalid_identifier' };
  const normalizedConversationType = conversationType(safeRaw.conversationType);
  if (!normalizedConversationType) return { ok: false, code: 'invalid_conversation_type' };
  const content = decodeContent(safeRaw.content);
  if (!content) return { ok: false, code: 'invalid_content' };
  const attachments = normalizeAttachments(content.rawContent);
  const rawContent = content.rawContent
    ? rebuildRawContent(content.rawContent, attachments)
    : undefined;

  const sentTime = safeRaw.sentTime === undefined ? undefined : finiteNumber(safeRaw.sentTime) ?? undefined;
  const offline = typeof safeRaw.isOffLineMessage === 'boolean'
    ? safeRaw.isOffLineMessage
    : typeof safeRaw.offline === 'boolean' ? safeRaw.offline : undefined;
  const direction = typeof safeRaw.messageDirection === 'number' || typeof safeRaw.messageDirection === 'string'
    ? safeRaw.messageDirection
    : typeof safeRaw.direction === 'number' || typeof safeRaw.direction === 'string' ? safeRaw.direction : undefined;

  return {
    ok: true,
    value: {
      messageUid: uid.value,
      senderId: sender.value,
      targetId,
      conversationType: normalizedConversationType,
      objectName: objectName.value,
      ...(content.text === undefined ? {} : { text: content.text }),
      attachments,
      ...(rawContent ? { rawContent } : {}),
      ...(sentTime === undefined ? {} : { sentTime }),
      ...(offline === undefined ? {} : { offline }),
      ...(direction === undefined ? {} : { direction }),
    },
  };
}

function unwrapProtocolValue(input: unknown): { value?: Record<string, unknown>; text?: string } | null {
  let value = input;
  for (let depth = 0; depth <= 2; depth += 1) {
    if (typeof value === 'string') {
      if (Buffer.byteLength(value, 'utf8') > MAX_RONGCLOUD_MESSAGE_BYTES) return null;
      const parsed = parseRecordJson(value);
      if (!parsed) return { text: value };
      value = parsed;
      continue;
    }
    if (!record(value)) return null;
    if (typeof value.msg_type === 'string') return { value };
    if (!own(value, 'content')) return null;
    value = value.content;
  }
  if (record(value) && typeof value.msg_type === 'string') return { value };
  return null;
}

function canonicalLegacy(value: Record<string, unknown>): Record<string, unknown> | null {
  let source = value;
  if (typeof value.content === 'string') {
    const payload = parseRecordJson(value.content);
    if (payload !== null) {
      for (const key of Object.keys(payload)) {
        if (key !== 'content' && own(value, key) && value[key] !== payload[key]) return null;
      }
      source = { ...payload, ...value };
    }
  }
  const result: Record<string, unknown> = { msg_type: source.msg_type };
  const groups: Array<[string, readonly string[], (raw: unknown) => unknown | null]> = [
    ['request_id', ['request_id', 'requestId'], identifier],
    ['source_im_id', ['source_im_id', 'sourceImId'], identifier],
    ['destination_im_id', ['destination_im_id', 'destinationImId'], identifier],
    ['session_id', ['session_id', 'sessionId'], identifier],
    ['chatroom_id', ['chatroom_id', 'chatroomId'], identifier],
    ['origin_message_uid', ['origin_message_uid', 'originMessageUId'], identifier],
    ['cardId', ['cardId', 'card_id'], identifier],
    ['buttonId', ['buttonId', 'button_id'], identifier],
    ['max_rounds', ['max_rounds', 'maxRounds', 'openclaw_max_rounds'], safePositiveInteger],
  ];
  for (const [output, keys, parse] of groups) {
    const selected = alias(source, keys, parse);
    if (!selected.ok) return null;
    if (selected.value !== undefined) result[output] = selected.value;
  }

  const command = alias(source, ['command', 'action', 'type', 'cmd'], (raw) => identifier(raw, 64));
  if (!command.ok) return null;
  if (command.value !== undefined) result.command = command.value;

  for (const key of ['content', 'title', 'name', 'status', 'message', 'data', 'opencode_session_id', 'timestamp']) {
    if (own(source, key) && source[key] !== undefined) result[key] = source[key];
  }
  return result;
}

function validLegacySemantics(msgType: ExternalMessageType, value: Record<string, unknown>): boolean {
  if (msgType === 'chatroom_invite') return typeof value.chatroom_id === 'string';
  if (msgType === 'chatroom_message') {
    return typeof value.chatroom_id === 'string'
      && typeof value.content === 'string'
      && value.content.length > 0;
  }
  if (msgType === 'device_status_report' || msgType === 'device_control_result') {
    return typeof value.request_id === 'string';
  }
  if (msgType === 'command_result') {
    const cardState = record(value.data) && record(value.data.card_state);
    return cardState || typeof value.request_id === 'string';
  }
  return true;
}

export function parseProtocolContent(input: unknown): ProtocolContentResult {
  const snapshot = passiveSnapshot(input);
  if (!snapshot.ok) {
    return {
      kind: 'invalid',
      code: snapshot.code === 'too_large' ? 'content_too_large' : 'invalid_content',
    };
  }
  const unwrapped = unwrapProtocolValue(snapshot.value);
  if (!unwrapped) return { kind: 'invalid', code: 'invalid_content' };
  if (unwrapped.text !== undefined) return { kind: 'text', text: unwrapped.text };
  const value = unwrapped.value!;
  const msgType = value.msg_type;
  if (msgType === 'discussion_event') return { kind: 'ignored', code: 'server_only_message' };
  if (msgType === 'system_notify') return { kind: 'ignored', code: 'system_message' };
  if (typeof msgType !== 'string' || !externalTypes.has(msgType)) {
    return { kind: 'ignored', code: 'unknown_message_type' };
  }
  const protocolBytes = serializedBytes(value);
  if (protocolBytes === null) return { kind: 'invalid', code: 'invalid_content' };
  if (cardEnvelopeTypes.has(msgType) && protocolBytes > maxCardEnvelopeBytes) {
    return { kind: 'invalid', code: 'content_too_large' };
  }
  if (v2AndCardTypes.has(msgType)) {
    return { kind: 'protocol', msgType: msgType as ExternalMessageType, value };
  }
  const canonical = canonicalLegacy(value);
  if (!canonical) return { kind: 'invalid', code: 'conflicting_alias' };
  if (msgType === 'device_control'
    && (typeof canonical.command !== 'string' || !deviceControlCommands.has(canonical.command))) {
    return { kind: 'invalid', code: 'invalid_content' };
  }
  if (!validLegacySemantics(msgType as ExternalMessageType, canonical)) {
    return { kind: 'invalid', code: 'invalid_content' };
  }
  return { kind: 'protocol', msgType: msgType as ExternalMessageType, value: canonical };
}

export function parseSlashCommand(text: string): SlashCommandResult {
  const trimmed = text.trim();
  const noArgument = ['/new', '/session', '/sessions', '/status', '/stop'] as const;
  for (const name of noArgument) {
    if (trimmed === name) return { kind: 'command', name };
    if (trimmed.startsWith(`${name} `)) return { kind: 'invalid', code: 'invalid_command' };
  }
  for (const name of ['/switch', '/delete'] as const) {
    if (trimmed === name) return { kind: 'invalid', code: 'invalid_command' };
    if (trimmed.startsWith(`${name} `)) {
      const argument = trimmed.slice(name.length + 1);
      if (argument.includes(' ') || !identifier(argument)) return { kind: 'invalid', code: 'invalid_command' };
      return { kind: 'command', name, argument };
    }
  }
  return { kind: 'text', text };
}

export interface LegacyEnvelopeInput {
  msgType: 'opencode_session_created' | 'device_status_report' | 'device_control_result';
  requestId?: string;
  sourceImId?: string;
  destinationImId?: string;
  content: unknown;
  timestamp: number;
}

export function buildLegacyEnvelope(input: LegacyEnvelopeInput): Record<string, unknown> {
  const snapshot = passiveSnapshot(input);
  if (!snapshot.ok) {
    if (snapshot.code === 'too_large') throw new RangeError('legacy content exceeds 64 KiB');
    throw new TypeError('invalid active legacy content');
  }
  if (!record(snapshot.value)) throw new TypeError('invalid legacy envelope');
  const safeInput = snapshot.value;
  const msgType = safeInput.msgType;
  if (msgType !== 'opencode_session_created'
    && msgType !== 'device_status_report'
    && msgType !== 'device_control_result') throw new TypeError('invalid legacy message type');
  const requestId = safeInput.requestId === undefined ? undefined : identifier(safeInput.requestId);
  const sourceImId = safeInput.sourceImId === undefined ? undefined : identifier(safeInput.sourceImId);
  const destinationImId = safeInput.destinationImId === undefined ? undefined : identifier(safeInput.destinationImId);
  if ((safeInput.requestId !== undefined && !requestId)
    || (safeInput.sourceImId !== undefined && !sourceImId)
    || (safeInput.destinationImId !== undefined && !destinationImId)
    || !Number.isSafeInteger(safeInput.timestamp) || (safeInput.timestamp as number) < 0) {
    throw new TypeError('invalid legacy envelope');
  }
  if ((msgType === 'device_status_report' || msgType === 'device_control_result')
    && requestId === undefined) {
    throw new TypeError('legacy response requires request_id');
  }
  if (!own(safeInput, 'content')) throw new TypeError('invalid legacy content');
  const content = typeof safeInput.content === 'string'
    ? safeInput.content
    : JSON.stringify(safeInput.content);
  if (content === undefined) throw new TypeError('invalid legacy content');
  const envelope: Record<string, unknown> = {
    msg_type: msgType,
    ...(requestId ? { request_id: requestId } : {}),
    ...(sourceImId ? { source_im_id: sourceImId } : {}),
    ...(destinationImId ? { destination_im_id: destinationImId } : {}),
    content,
    timestamp: safeInput.timestamp,
  };
  const bytes = serializedBytes(envelope);
  if (bytes === null || bytes > MAX_RONGCLOUD_MESSAGE_BYTES) throw new RangeError('legacy envelope exceeds 64 KiB');
  return envelope;
}
