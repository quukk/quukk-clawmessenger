import { isProxy } from 'node:util/types';

import { z } from 'zod';

import type { NormalizedRongCloudMessage } from '../protocol/messages.js';

export const MAX_WORKER_IPC_BYTES = 64 * 1024;
export const MAX_STRUCTURED_MESSAGE_BYTES = 10 * 1024;

const MAX_IPC_ITEMS = 32_768;
const MAX_IPC_DEPTH = 32;
const controlCharacters = /[\p{Cc}\p{Cf}]/u;
const dangerousKeys = new Set(['__proto__', 'prototype', 'constructor']);
const invalidClone = Symbol('invalid-clone');
const oversizedClone = Symbol('oversized-clone');

export const OUTBOUND_MESSAGE_TYPES = [
  'text',
  'command',
  'command_result',
  'card_message',
  'card_update',
  'card_action',
  'chatroom_invite',
] as const;

export const WORKER_ERROR_CODES = [
  'invalid_request',
  'not_initialized',
  'already_initialized',
  'not_connected',
  'authentication_failed',
  'connect_failed',
  'send_failed',
  'receipt_failed',
  'chatroom_failed',
  'cancelled',
  'disconnected',
  'timeout',
  'queue_full',
  'worker_exited',
  'protocol_error',
  'missing_message_uid',
  'duplicate_message_uid',
  'timer_failed',
  'internal_error',
] as const;

interface CloneBudget {
  items: number;
  textBytes: number;
}

type CloneResult = unknown | typeof invalidClone | typeof oversizedClone;

function accountString(value: string, budget: CloneBudget): typeof oversizedClone | null {
  budget.textBytes += Buffer.byteLength(value, 'utf8');
  return budget.textBytes > MAX_WORKER_IPC_BYTES ? oversizedClone : null;
}

function ownDataDescriptor(value: object, key: PropertyKey): PropertyDescriptor | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
      ? descriptor
      : undefined;
  } catch {
    return undefined;
  }
}

function passiveClone(
  value: unknown,
  budget: CloneBudget,
  ancestors: Set<object>,
  depth = 0,
): CloneResult {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return accountString(value, budget) ?? value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : invalidClone;
  if (typeof value !== 'object' || isProxy(value) || depth >= MAX_IPC_DEPTH || ancestors.has(value)) {
    return invalidClone;
  }

  let names: string[];
  let symbols: symbol[];
  try {
    names = Object.getOwnPropertyNames(value);
    symbols = Object.getOwnPropertySymbols(value);
  } catch {
    return invalidClone;
  }
  if (symbols.length > 0 || names.some((key) => dangerousKeys.has(key))) return invalidClone;

  budget.items += names.length + 1;
  if (budget.items > MAX_IPC_ITEMS) return oversizedClone;
  ancestors.add(value);

  if (Array.isArray(value)) {
    const lengthDescriptor = ownDataDescriptor(value, 'length');
    const length = lengthDescriptor?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_IPC_ITEMS) {
      ancestors.delete(value);
      return oversizedClone;
    }
    if (names.length !== length + 1) {
      ancestors.delete(value);
      return invalidClone;
    }
    budget.items += length;
    if (budget.items > MAX_IPC_ITEMS) {
      ancestors.delete(value);
      return oversizedClone;
    }
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = ownDataDescriptor(value, String(index));
      if (!descriptor?.enumerable) {
        ancestors.delete(value);
        return invalidClone;
      }
      const cloned = passiveClone(descriptor.value, budget, ancestors, depth + 1);
      if (cloned === invalidClone || cloned === oversizedClone) {
        ancestors.delete(value);
        return cloned;
      }
      result.push(cloned);
    }
    ancestors.delete(value);
    return result;
  }

  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    ancestors.delete(value);
    return invalidClone;
  }
  if (prototype !== Object.prototype && prototype !== null) {
    ancestors.delete(value);
    return invalidClone;
  }

  const result: Record<string, unknown> = {};
  for (const key of names) {
    const keyBudget = accountString(key, budget);
    const descriptor = ownDataDescriptor(value, key);
    if (keyBudget || !descriptor?.enumerable) {
      ancestors.delete(value);
      return keyBudget ?? invalidClone;
    }
    const cloned = passiveClone(descriptor.value, budget, ancestors, depth + 1);
    if (cloned === invalidClone || cloned === oversizedClone) {
      ancestors.delete(value);
      return cloned;
    }
    result[key] = cloned;
  }
  ancestors.delete(value);
  return result;
}

type SnapshotResult =
  | { ok: true; value: unknown }
  | { ok: false; code: 'invalid_ipc' | 'ipc_too_large' };

function snapshot(input: unknown): SnapshotResult {
  const cloned = passiveClone(input, { items: 0, textBytes: 0 }, new Set());
  if (cloned === invalidClone) return { ok: false, code: 'invalid_ipc' };
  if (cloned === oversizedClone) return { ok: false, code: 'ipc_too_large' };
  try {
    const serialized = JSON.stringify(cloned);
    if (serialized === undefined) return { ok: false, code: 'invalid_ipc' };
    if (Buffer.byteLength(serialized, 'utf8') > MAX_WORKER_IPC_BYTES) {
      return { ok: false, code: 'ipc_too_large' };
    }
  } catch {
    return { ok: false, code: 'invalid_ipc' };
  }
  return { ok: true, value: cloned };
}

function identifier(max = 256) {
  return z.string()
    .transform((value) => value.trim())
    .pipe(z.string().min(1).max(max).refine((value) => !controlCharacters.test(value)));
}

const boundedString = (max: number) => z.string().min(1).max(max);
const jsonObject = z.record(z.string(), z.unknown());
const requestIdSchema = identifier();
const runtimeIdSchema = identifier();
const nodeIdSchema = identifier();
const instanceIdSchema = identifier(36).pipe(z.string().regex(/^rcw_[0-9a-f]{32}$/));
const conversationTypeSchema = z.union([z.literal(1), z.literal(3), z.literal(4)]);
const directionSchema = z.union([z.number().finite(), identifier(64)]);

const bindingSchema = z.strictObject({
  runtimeId: runtimeIdSchema,
  nodeId: nodeIdSchema,
  appKey: boundedString(256),
  storageDir: boundedString(4_096).refine(
    (value) => value === value.trim() && !controlCharacters.test(value),
  ),
});

const initSchema = z.strictObject({
  type: z.literal('init'),
  binding: bindingSchema,
  token: boundedString(16_384),
});

const refreshSuccessSchema = z.strictObject({
  type: z.literal('refresh_result'),
  requestId: requestIdSchema,
  ok: z.literal(true),
  token: boundedString(16_384),
});

const refreshFailureSchema = z.strictObject({
  type: z.literal('refresh_result'),
  requestId: requestIdSchema,
  ok: z.literal(false),
});

const textSendSchema = z.strictObject({
  type: z.literal('send'),
  requestId: requestIdSchema,
  conversationType: conversationTypeSchema,
  targetId: identifier(),
  messageType: z.literal('text'),
  content: z.string().refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_WORKER_IPC_BYTES),
});

const structuredMessageTypeSchema = z.enum([
  'command',
  'command_result',
  'card_message',
  'card_update',
  'card_action',
  'chatroom_invite',
]);

const structuredSendSchema = z.strictObject({
  type: z.literal('send'),
  requestId: requestIdSchema,
  conversationType: conversationTypeSchema,
  targetId: identifier(),
  messageType: structuredMessageTypeSchema,
  content: jsonObject,
}).superRefine((value, context) => {
  const msgType = value.content.msg_type;
  const usesWireLimit = value.messageType === 'card_message'
    || value.messageType === 'card_update'
    || value.messageType === 'card_action'
    || (typeof msgType === 'string' && msgType.startsWith('discussion_'));
  if (!usesWireLimit) return;
  const bytes = Buffer.byteLength(JSON.stringify(value.content), 'utf8');
  if (bytes > MAX_STRUCTURED_MESSAGE_BYTES) {
    context.addIssue({ code: 'custom', path: ['content'], message: 'structured_content_too_large' });
  }
});

const receiptSchema = z.strictObject({
  type: z.literal('receipt'),
  requestId: requestIdSchema,
  messageUid: identifier(),
  senderId: identifier(),
  targetId: identifier(),
  conversationType: conversationTypeSchema,
  direction: directionSchema,
});

const joinChatroomSchema = z.strictObject({
  type: z.literal('join_chatroom'),
  requestId: requestIdSchema,
  roomId: identifier(),
  historyCount: z.number().int().min(-1).max(50),
});

const disconnectSchema = z.strictObject({
  type: z.literal('disconnect'),
  requestId: requestIdSchema,
});

export const WorkerCommandSchema = z.union([
  initSchema,
  refreshSuccessSchema,
  refreshFailureSchema,
  textSendSchema,
  structuredSendSchema,
  receiptSchema,
  joinChatroomSchema,
  disconnectSchema,
]);

export type WorkerCommand = z.infer<typeof WorkerCommandSchema>;
export type WorkerInit = z.infer<typeof initSchema>;
export type WorkerSend = z.infer<typeof textSendSchema> | z.infer<typeof structuredSendSchema>;

const attachmentSchema = z.strictObject({
  kind: z.enum(['image', 'file']),
  url: identifier(2_048),
  name: identifier(512).optional(),
  mimeType: identifier(128).optional(),
  size: z.number().int().nonnegative().safe().optional(),
});

const normalizedMessageSchema: z.ZodType<NormalizedRongCloudMessage> = z.strictObject({
  messageUid: identifier(),
  senderId: identifier(),
  targetId: identifier(),
  conversationType: conversationTypeSchema,
  objectName: identifier(128),
  text: z.string().optional(),
  attachments: z.array(attachmentSchema).max(16),
  rawContent: jsonObject.optional(),
  sentTime: z.number().finite().optional(),
  offline: z.boolean().optional(),
  direction: directionSchema.optional(),
});

export const WorkerErrorCodeSchema = z.enum(WORKER_ERROR_CODES);

const eventBase = {
  runtimeId: runtimeIdSchema,
  instanceId: instanceIdSchema,
};

const readySchema = z.strictObject({ type: z.literal('ready'), ...eventBase });
const connectionSchema = z.strictObject({
  type: z.literal('connection'),
  ...eventBase,
  state: z.enum(['connecting', 'online', 'offline', 'auth_error']),
});
const messageSchema = z.strictObject({
  type: z.literal('message'),
  ...eventBase,
  message: normalizedMessageSchema,
});
const resultSuccessSchema = z.strictObject({
  type: z.literal('result'),
  ...eventBase,
  requestId: requestIdSchema,
  ok: z.literal(true),
  messageUid: identifier().optional(),
});
const resultFailureSchema = z.strictObject({
  type: z.literal('result'),
  ...eventBase,
  requestId: requestIdSchema,
  ok: z.literal(false),
  errorCode: WorkerErrorCodeSchema.optional(),
});
const refreshRequiredSchema = z.strictObject({
  type: z.literal('refresh_required'),
  ...eventBase,
  requestId: requestIdSchema,
});

export const WorkerEventSchema = z.union([
  readySchema,
  connectionSchema,
  messageSchema,
  resultSuccessSchema,
  resultFailureSchema,
  refreshRequiredSchema,
]);

export type WorkerEvent = z.infer<typeof WorkerEventSchema>;
export type WorkerErrorCode = z.infer<typeof WorkerErrorCodeSchema>;
export type ConnectionState = z.infer<typeof connectionSchema>['state'];

export type IpcParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: 'invalid_ipc' | 'ipc_too_large' };

function parse<T>(schema: z.ZodType<T>, input: unknown): IpcParseResult<T> {
  const safe = snapshot(input);
  if (!safe.ok) return safe;
  try {
    const parsed = schema.safeParse(safe.value);
    return parsed.success
      ? { ok: true, value: parsed.data }
      : { ok: false, code: 'invalid_ipc' };
  } catch {
    return { ok: false, code: 'invalid_ipc' };
  }
}

export function parseWorkerCommand(input: unknown): IpcParseResult<WorkerCommand> {
  return parse(WorkerCommandSchema, input);
}

export function parseWorkerEvent(input: unknown): IpcParseResult<WorkerEvent> {
  return parse(WorkerEventSchema, input);
}

export function serializeWorkerEvent(input: unknown): string | undefined {
  const parsed = parseWorkerEvent(input);
  return parsed.ok ? JSON.stringify(parsed.value) : undefined;
}
