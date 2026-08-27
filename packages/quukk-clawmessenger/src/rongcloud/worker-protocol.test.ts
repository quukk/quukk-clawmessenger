// @vitest-environment node

import { resolve } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

type ParseResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; code: string };

type ProtocolApi = {
  parseWorkerCommand(input: unknown): ParseResult;
  parseWorkerEvent(input: unknown): ParseResult;
  serializeWorkerEvent(input: unknown): string | undefined;
};

let protocol: ProtocolApi | undefined;

beforeAll(async () => {
  protocol = await import('./worker-protocol.js')
    .then((module) => module as unknown as ProtocolApi)
    .catch(() => undefined);
});

function api(): ProtocolApi {
  expect(protocol, 'Phase A worker protocol implementation is missing').toBeDefined();
  return protocol!;
}

const runtimeId = 'rt_0123456789abcdef0123456789abcdef';
const nodeId = 'opencode-node-1';
const instanceId = 'rcw_0123456789abcdef0123456789abcdef';
const requestId = 'request-1';
const tokenSentinel = 'TASK9_TOKEN_SENTINEL_9f32';

const init = {
  type: 'init',
  binding: {
    runtimeId,
    nodeId,
    appKey: 'app-key-1',
    storageDir: resolve('worker-storage'),
  },
  token: 'rongcloud-token-1',
};

const normalizedMessage = {
  messageUid: 'message-1',
  senderId: 'sender-1',
  targetId: nodeId,
  conversationType: 1,
  objectName: 'command',
  text: '/status',
  attachments: [],
  rawContent: { msg_type: 'device_status_request' },
  sentTime: 1_700_000_000_000,
  offline: false,
  direction: 2,
};

function expectRejected(result: ParseResult): void {
  expect(result.ok).toBe(false);
}

describe('parent-to-child IPC', () => {
  it('accepts and detaches a single bounded init handshake', () => {
    const input = structuredClone(init);
    const result = api().parseWorkerCommand(input);

    expect(result).toEqual({ ok: true, value: init });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected init to parse');
    expect(result.value).not.toBe(input);
    expect(result.value.binding).not.toBe(input.binding);
    input.binding.runtimeId = 'rt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    input.token = 'changed';
    expect(result.value).toEqual(init);
  });

  it('accepts only the exact outbound message constructors and numeric conversations', () => {
    const messageTypes = [
      'text',
      'command',
      'command_result',
      'card_message',
      'card_update',
      'card_action',
      'chatroom_invite',
    ];
    for (const conversationType of [1, 3, 4]) {
      for (const messageType of messageTypes) {
        const content = messageType === 'text' ? 'hello' : { msg_type: messageType, content: 'hello' };
        expect(api().parseWorkerCommand({
          type: 'send',
          requestId,
          conversationType,
          targetId: 'target-1',
          messageType,
          content,
        })).toMatchObject({ ok: true, value: { conversationType, messageType, content } });
      }
    }

    for (const messageType of ['RC:TxtMsg', 'discussion_token', 'unknown']) {
      expectRejected(api().parseWorkerCommand({
        type: 'send',
        requestId,
        conversationType: 1,
        targetId: 'target-1',
        messageType,
        content: {},
      }));
    }
    for (const conversationType of [0, 2, 5, '1']) {
      expectRejected(api().parseWorkerCommand({
        type: 'send',
        requestId,
        conversationType,
        targetId: 'target-1',
        messageType: 'text',
        content: 'hello',
      }));
    }
  });

  it('accepts normalized receipts, bounded chatroom joins, disconnects, and strict shutdown', () => {
    expect(api().parseWorkerCommand({
      type: 'receipt',
      requestId,
      messageUid: 'message-1',
      senderId: 'sender-1',
      targetId: 'group-1',
      conversationType: 3,
      direction: 2,
    })).toMatchObject({ ok: true });
    for (const historyCount of [-1, 0, 50]) {
      expect(api().parseWorkerCommand({
        type: 'join_chatroom',
        requestId,
        roomId: 'room-1',
        historyCount,
      })).toMatchObject({ ok: true, value: { historyCount } });
    }
    for (const historyCount of [-2, 51, 1.5, Number.NaN]) {
      expectRejected(api().parseWorkerCommand({
        type: 'join_chatroom',
        requestId,
        roomId: 'room-1',
        historyCount,
      }));
    }
    expect(api().parseWorkerCommand({ type: 'disconnect', requestId })).toEqual({
      ok: true,
      value: { type: 'disconnect', requestId },
    });
    expect(api().parseWorkerCommand({ type: 'shutdown' })).toEqual({
      ok: true,
      value: { type: 'shutdown' },
    });
    expectRejected(api().parseWorkerCommand({ type: 'shutdown', requestId }));
  });

  it('requires a token only on successful refresh results', () => {
    expect(api().parseWorkerCommand({
      type: 'refresh_result',
      requestId,
      ok: true,
      token: 'new-token',
    })).toMatchObject({ ok: true });
    expect(api().parseWorkerCommand({
      type: 'refresh_result',
      requestId,
      ok: false,
    })).toMatchObject({ ok: true });
    expectRejected(api().parseWorkerCommand({ type: 'refresh_result', requestId, ok: true }));
    expectRejected(api().parseWorkerCommand({
      type: 'refresh_result',
      requestId,
      ok: false,
      token: 'must-not-be-carried',
    }));
  });

  it('allows token carriage only in init and successful refresh_result', () => {
    expect(api().parseWorkerCommand({ ...init, token: tokenSentinel })).toMatchObject({ ok: true });
    expect(api().parseWorkerCommand({
      type: 'refresh_result',
      requestId,
      ok: true,
      token: tokenSentinel,
    })).toMatchObject({ ok: true });

    const tokenFreeCommands = [
      { type: 'refresh_result', requestId, ok: false },
      {
        type: 'send', requestId, conversationType: 1, targetId: 'target-1', messageType: 'text', content: 'x',
      },
      {
        type: 'receipt', requestId, messageUid: 'message-1', senderId: 'sender-1', targetId: 'target-1',
        conversationType: 1, direction: 2,
      },
      { type: 'join_chatroom', requestId, roomId: 'room-1', historyCount: 0 },
      { type: 'disconnect', requestId },
    ];
    for (const command of tokenFreeCommands) {
      expectRejected(api().parseWorkerCommand({ ...command, token: tokenSentinel }));
    }
  });

  it('enforces the 64 KiB host limit and the 10 KiB structured CardKit limit', () => {
    expect(api().parseWorkerCommand({
      type: 'send',
      requestId,
      conversationType: 1,
      targetId: 'target-1',
      messageType: 'text',
      content: 'x'.repeat(12 * 1024),
    })).toMatchObject({ ok: true });
    expectRejected(api().parseWorkerCommand({
      type: 'send',
      requestId,
      conversationType: 1,
      targetId: 'target-1',
      messageType: 'card_message',
      content: { msg_type: 'card_message', card: { body: 'x'.repeat(10 * 1024) } },
    }));
    expectRejected(api().parseWorkerCommand({
      type: 'send',
      requestId,
      conversationType: 1,
      targetId: 'target-1',
      messageType: 'text',
      content: 'x'.repeat(65 * 1024),
    }));
  });

  it('applies the 10 KiB wire cap only to CardKit and discussion wire content', () => {
    const body = 'x'.repeat(12 * 1024);
    for (const messageType of ['command', 'command_result', 'chatroom_invite']) {
      expect(api().parseWorkerCommand({
        type: 'send',
        requestId,
        conversationType: 1,
        targetId: 'target-1',
        messageType,
        content: { msg_type: messageType, content: body },
      })).toMatchObject({ ok: true });
    }
    for (const messageType of ['card_message', 'card_update', 'card_action']) {
      expectRejected(api().parseWorkerCommand({
        type: 'send',
        requestId,
        conversationType: 1,
        targetId: 'target-1',
        messageType,
        content: { msg_type: messageType, content: body },
      }));
    }
    expectRejected(api().parseWorkerCommand({
      type: 'send',
      requestId,
      conversationType: 1,
      targetId: 'target-1',
      messageType: 'command',
      content: { msg_type: 'discussion_wire_chunk', content: body },
    }));
  });
});

describe('child-to-parent IPC', () => {
  it('accepts every fixed event shape and detaches normalized messages', () => {
    const message = structuredClone(normalizedMessage);
    const events = [
      { type: 'ready', runtimeId, instanceId },
      { type: 'connection', runtimeId, instanceId, state: 'connecting' },
      { type: 'connection', runtimeId, instanceId, state: 'online' },
      { type: 'connection', runtimeId, instanceId, state: 'offline' },
      { type: 'connection', runtimeId, instanceId, state: 'auth_error' },
      { type: 'message', runtimeId, instanceId, message },
      { type: 'result', runtimeId, instanceId, requestId, ok: true, messageUid: 'message-2' },
      { type: 'result', runtimeId, instanceId, requestId, ok: false, errorCode: 'send_failed' },
      { type: 'refresh_required', runtimeId, instanceId, requestId },
    ];
    for (const event of events) expect(api().parseWorkerEvent(event)).toMatchObject({ ok: true });

    const result = api().parseWorkerEvent(events[5]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected message event to parse');
    expect(result.value).not.toBe(events[5]);
    expect(result.value.message).not.toBe(message);
    message.rawContent.msg_type = 'changed';
    expect(result.value).toMatchObject({ message: normalizedMessage });
  });

  it('requires opaque instance IDs and fixed connection/error enums', () => {
    for (const badInstanceId of ['rcw_1234', 'RCW_0123456789abcdef0123456789abcdef', instanceId + '0']) {
      expectRejected(api().parseWorkerEvent({ type: 'ready', runtimeId, instanceId: badInstanceId }));
    }
    expectRejected(api().parseWorkerEvent({
      type: 'connection', runtimeId, instanceId, state: 'connected',
    }));
    expectRejected(api().parseWorkerEvent({
      type: 'result', runtimeId, instanceId, requestId, ok: false, errorCode: tokenSentinel,
    }));
    expectRejected(api().parseWorkerEvent({
      type: 'result', runtimeId, instanceId, requestId, ok: false, error: new Error(tokenSentinel),
    }));
  });

  it('never serializes tokens, app keys, or raw error messages in child events', () => {
    const failure = {
      type: 'result', runtimeId, instanceId, requestId, ok: false, errorCode: 'internal_error',
    };
    const serialized = api().serializeWorkerEvent(failure);
    expect(serialized).toBe(JSON.stringify(failure));
    expect(serialized).not.toContain(tokenSentinel);

    for (const secretField of ['token', 'appKey', 'error', 'messageText']) {
      expect(api().serializeWorkerEvent({ ...failure, [secretField]: tokenSentinel })).toBeUndefined();
    }
  });
});

describe('hostile IPC values', () => {
  it('rejects accessors without invoking them', () => {
    let reads = 0;
    const active = structuredClone(init) as Record<string, unknown>;
    Object.defineProperty(active, 'token', {
      enumerable: true,
      get: () => {
        reads += 1;
        return tokenSentinel;
      },
    });

    expectRejected(api().parseWorkerCommand(active));
    expect(reads).toBe(0);
  });

  it('rejects proxies and cycles without throwing', () => {
    let proxyReads = 0;
    const proxied = new Proxy(structuredClone(init), {
      ownKeys: () => {
        proxyReads += 1;
        throw new Error('must not inspect proxy');
      },
    });
    const cyclic = { type: 'disconnect', requestId, nested: {} } as Record<string, unknown>;
    cyclic.nested = cyclic;

    expect(() => api().parseWorkerCommand(proxied)).not.toThrow();
    expectRejected(api().parseWorkerCommand(proxied));
    expect(proxyReads).toBe(0);
    expect(() => api().parseWorkerCommand(cyclic)).not.toThrow();
    expectRejected(api().parseWorkerCommand(cyclic));
  });

  it('rejects dangerous keys at every depth', () => {
    const topLevel = JSON.parse(`{"type":"disconnect","requestId":"${requestId}","__proto__":{}}`);
    const nested = JSON.parse(JSON.stringify({
      type: 'send',
      requestId,
      conversationType: 1,
      targetId: 'target-1',
      messageType: 'command',
      content: { constructor: { prototype: { polluted: true } } },
    }));

    expectRejected(api().parseWorkerCommand(topLevel));
    expectRejected(api().parseWorkerCommand(nested));
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('rejects non-finite numbers and structurally oversized arrays', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expectRejected(api().parseWorkerCommand({
        type: 'send',
        requestId,
        conversationType: 1,
        targetId: 'target-1',
        messageType: 'command',
        content: { value },
      }));
    }
    expectRejected(api().parseWorkerCommand({
      type: 'send',
      requestId,
      conversationType: 1,
      targetId: 'target-1',
      messageType: 'command',
      content: { values: Array.from({ length: 65_537 }, () => null) },
    }));
  });

  it('rejects unknown discriminators, duplicate aliases, and unknown fields', () => {
    expectRejected(api().parseWorkerCommand({ type: 'execute', requestId }));
    expectRejected(api().parseWorkerEvent({ type: 'log', runtimeId, instanceId, message: tokenSentinel }));
    expectRejected(api().parseWorkerEvent({
      type: 'message',
      runtimeId,
      instanceId,
      message: { ...normalizedMessage, messageUId: normalizedMessage.messageUid },
    }));
    expectRejected(api().parseWorkerCommand({
      type: 'disconnect', requestId, request_id: requestId,
    }));
    expectRejected(api().parseWorkerCommand({ ...init, binding: { ...init.binding, provider: 'opencode' } }));
  });

  it('trims bounded IDs, rejects controls, and bounds credentials', () => {
    expect(api().parseWorkerCommand({ type: 'disconnect', requestId: '  request-1  ' }))
      .toEqual({ ok: true, value: { type: 'disconnect', requestId } });
    expectRejected(api().parseWorkerCommand({ type: 'disconnect', requestId: 'bad\u0000id' }));
    expectRejected(api().parseWorkerCommand({ type: 'disconnect', requestId: 'x'.repeat(257) }));
    expectRejected(api().parseWorkerCommand({ ...init, token: '' }));
    expectRejected(api().parseWorkerCommand({ ...init, token: 'x'.repeat(16_385) }));
    expectRejected(api().parseWorkerCommand({
      ...init,
      binding: { ...init.binding, appKey: 'x'.repeat(257) },
    }));
  });
});
