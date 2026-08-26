// @vitest-environment node

import { beforeAll, describe, expect, it } from 'vitest';

type SdkResult = {
  code: number;
  data?: { messageUId?: string; messageId?: string | number };
  message?: string;
};

type SendInput = {
  conversationType: 1 | 3 | 4;
  targetId: string;
  messageType: 'text' | 'command' | 'command_result' | 'card_message' | 'card_update' | 'card_action' | 'chatroom_invite';
  content: string | Record<string, unknown>;
};

type NormalizedMessage = {
  messageUid: string;
  senderId: string;
  targetId: string;
  conversationType: 1 | 3 | 4;
  objectName: string;
  text?: string;
  attachments: unknown[];
  rawContent?: Record<string, unknown>;
  sentTime?: number;
  offline?: boolean;
  direction?: number | string;
};

type ClientLike = {
  init(input: { appKey: string; token: string }): void;
  connect(): Promise<void>;
  send(input: SendInput, options?: { signal?: AbortSignal }): Promise<string | undefined>;
  sendReceipt(message: NormalizedMessage | undefined, options?: { signal?: AbortSignal }): Promise<void>;
  joinChatroom(roomId: string, historyCount: number): Promise<void>;
  disconnect(): Promise<void>;
  dispose(): Promise<void>;
};

type ClientApi = {
  RongCloudClient: new (options: Record<string, unknown>) => ClientLike;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

class ManualClock {
  now = 0;
  readonly waits: Array<{
    milliseconds: number;
    signal?: AbortSignal;
    resolve(): void;
    reject(error: unknown): void;
  }> = [];

  readonly clock = (): number => this.now;

  readonly sleep = (milliseconds: number, signal?: AbortSignal): Promise<void> => {
    const pending = deferred<void>();
    const wait = { milliseconds, signal, resolve: () => pending.resolve(), reject: pending.reject };
    this.waits.push(wait);
    if (signal?.aborted) pending.reject(new Error('sleep aborted'));
    else signal?.addEventListener('abort', () => pending.reject(new Error('sleep aborted')), { once: true });
    return pending.promise;
  };
}

class FakeSdk {
  readonly Events = {
    CONNECTING: 'CONNECTING',
    CONNECTED: 'CONNECTED',
    DISCONNECT: 'DISCONNECT',
    MESSAGES: 'MESSAGES',
  };

  readonly callLog: string[] = [];
  readonly registrations: Array<[string, boolean, boolean]> = [];
  readonly connectTokens: string[] = [];
  readonly sendCalls: Array<{
    conversation: { conversationType: number; targetId: string };
    message: unknown;
    options: unknown;
  }> = [];
  readonly joinExistingCalls: Array<[string, { count: number }]> = [];
  readonly joinLegacyCalls: Array<[string, { count: number }]> = [];
  readonly receiptV5Calls: Array<[{ conversationType: number; targetId: string }, string[]]> = [];
  readonly receiptV2Calls: Array<[string, Record<string, string[]>]> = [];
  readonly receiptV1GroupCalls: Array<[string, string[]]> = [];
  readonly receiptV1PrivateCalls: Array<[string, string, number]> = [];
  readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  disconnectCalls = 0;
  destroyCalls = 0;
  sendSequence = 0;

  connectImpl: (token: string) => Promise<SdkResult> = async () => ({ code: 0 });
  sendImpl: () => Promise<SdkResult> = async () => ({
    code: 0,
    data: { messageUId: `sent-${++this.sendSequence}` },
  });
  joinExistingImpl: () => Promise<SdkResult> = async () => ({ code: 0 });
  joinLegacyImpl: () => Promise<SdkResult> = async () => ({ code: 0 });
  receiptV5Impl: () => Promise<SdkResult> = async () => ({ code: 0 });
  receiptV2Impl: () => Promise<SdkResult> = async () => ({ code: 0 });
  receiptV1GroupImpl: () => Promise<SdkResult> = async () => ({ code: 0 });
  receiptV1PrivateImpl: () => Promise<SdkResult> = async () => ({ code: 0 });

  readonly TextMessage = class {
    readonly kind = 'text';
    constructor(readonly content: Record<string, unknown>) {}
  };

  init(options: { appkey: string }): void {
    this.callLog.push(`init:${options.appkey}`);
  }

  registerMessageType(name: string, isPersisted: boolean, isCounted: boolean) {
    this.callLog.push(`register:${name}:${isPersisted}:${isCounted}`);
    this.registrations.push([name, isPersisted, isCounted]);
    return class {
      readonly kind = name;
      constructor(readonly content: Record<string, unknown>) {}
    };
  }

  addEventListener(name: string, listener: (event: unknown) => void): void {
    this.callLog.push(`listen:${name}`);
    const listeners = this.listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.listeners.set(name, listeners);
  }

  removeEventListener(name: string, listener: (event: unknown) => void): void {
    this.callLog.push(`unlisten:${name}`);
    this.listeners.get(name)?.delete(listener);
  }

  emit(name: string, event?: unknown): void {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }

  async connect(token: string): Promise<SdkResult> {
    this.callLog.push('connect');
    this.connectTokens.push(token);
    return this.connectImpl(token);
  }

  async disconnect(): Promise<void> {
    this.callLog.push('disconnect');
    this.disconnectCalls += 1;
  }

  async destroy(): Promise<void> {
    this.callLog.push('destroy');
    this.destroyCalls += 1;
  }

  async sendMessage(
    conversation: { conversationType: number; targetId: string },
    message: unknown,
    options: unknown,
  ): Promise<SdkResult> {
    this.sendCalls.push({ conversation, message, options });
    return this.sendImpl();
  }

  async joinExistChatRoom(roomId: string, options: { count: number }): Promise<SdkResult> {
    this.joinExistingCalls.push([roomId, options]);
    return this.joinExistingImpl();
  }

  async joinChatRoom(roomId: string, options: { count: number }): Promise<SdkResult> {
    this.joinLegacyCalls.push([roomId, options]);
    return this.joinLegacyImpl();
  }

  async sendReadReceiptResponseV5(
    conversation: { conversationType: number; targetId: string },
    messageUIds: string[],
  ): Promise<SdkResult> {
    this.receiptV5Calls.push([conversation, messageUIds]);
    return this.receiptV5Impl();
  }

  async sendReadReceiptResponseV2(
    targetId: string,
    messages: Record<string, string[]>,
  ): Promise<SdkResult> {
    this.receiptV2Calls.push([targetId, messages]);
    return this.receiptV2Impl();
  }

  async sendReadReceiptResponse(targetId: string, messageUIds: string[]): Promise<SdkResult> {
    this.receiptV1GroupCalls.push([targetId, messageUIds]);
    return this.receiptV1GroupImpl();
  }

  async sendReadReceiptMessage(
    targetId: string,
    messageUId: string,
    timestamp: number,
  ): Promise<SdkResult> {
    this.receiptV1PrivateCalls.push([targetId, messageUId, timestamp]);
    return this.receiptV1PrivateImpl();
  }
}

let clientModule: ClientApi | undefined;

beforeAll(async () => {
  clientModule = await import('./client.js')
    .then((module) => module as unknown as ClientApi)
    .catch(() => undefined);
});

function createClient(options: Record<string, unknown> = {}) {
  expect(clientModule, 'Phase B RongCloud client implementation is missing').toBeDefined();
  const sdk = options.sdk instanceof FakeSdk ? options.sdk : new FakeSdk();
  const connections: string[] = [];
  const messages: NormalizedMessage[] = [];
  const client = new clientModule!.RongCloudClient({
    sdk,
    nodeId: 'opencode-node-1',
    onConnection: (state: string) => connections.push(state),
    onMessage: (message: NormalizedMessage) => messages.push(message),
    ...options,
  });
  return { client, sdk, connections, messages };
}

async function initialize(client: ClientLike, token = 'rongcloud-token'): Promise<void> {
  client.init({ appKey: 'app-key', token });
  await client.connect();
}

const message = (overrides: Partial<NormalizedMessage> = {}): NormalizedMessage => ({
  messageUid: 'incoming-1',
  senderId: 'sender-1',
  targetId: 'opencode-node-1',
  conversationType: 3,
  objectName: 'command',
  text: '/status',
  attachments: [],
  sentTime: 1_700_000_000_000,
  direction: 2,
  ...overrides,
});

const send = (index: number, overrides: Partial<SendInput> = {}): SendInput => ({
  conversationType: 1,
  targetId: `target-${index}`,
  messageType: 'text',
  content: `message-${index}`,
  ...overrides,
});

describe('RongCloudClient lifecycle', () => {
  it('initializes before exact ordered registration, subscribes four events, and initializes once', async () => {
    const { client, sdk } = createClient();
    client.init({ appKey: 'app-key', token: 'token-1' });

    expect(sdk.callLog).toEqual([
      'init:app-key',
      'register:command:false:false',
      'register:command_result:false:false',
      'register:card_message:true:true',
      'register:card_update:true:true',
      'register:card_action:false:false',
      'register:chatroom_invite:true:false',
      'listen:CONNECTING',
      'listen:CONNECTED',
      'listen:DISCONNECT',
      'listen:MESSAGES',
    ]);
    await client.connect();
    expect(sdk.callLog.at(-1)).toBe('connect');
    expect(() => client.init({ appKey: 'other', token: 'other' })).toThrowError(
      expect.objectContaining({ code: 'already_initialized' }),
    );
  });

  it('rejects connect before init and shares one concurrent connect attempt', async () => {
    const { client, sdk } = createClient();
    await expect(client.connect()).rejects.toMatchObject({ code: 'not_initialized' });

    client.init({ appKey: 'app-key', token: 'token-1' });
    const pending = deferred<SdkResult>();
    sdk.connectImpl = () => pending.promise;
    const first = client.connect();
    const second = client.connect();
    expect(second).toBe(first);
    await flush();
    expect(sdk.connectTokens).toEqual(['token-1']);
    pending.resolve({ code: 0 });
    await expect(first).resolves.toBeUndefined();
  });

  it('refreshes one authentication failure once and never refreshes arbitrary failures', async () => {
    const refreshes: string[] = [];
    const sdk = new FakeSdk();
    const results = [{ code: 31004 }, { code: 200 }];
    sdk.connectImpl = async () => results.shift()!;
    const { client } = createClient({
      sdk,
      refreshToken: async () => {
        refreshes.push('refresh');
        return 'fresh-token';
      },
    });
    client.init({ appKey: 'app-key', token: 'expired-token' });
    await client.connect();
    expect(sdk.connectTokens).toEqual(['expired-token', 'fresh-token']);
    expect(refreshes).toEqual(['refresh']);

    const arbitrarySdk = new FakeSdk();
    arbitrarySdk.connectImpl = async () => ({ code: 500, message: 'expired-token' });
    const other = createClient({ sdk: arbitrarySdk, refreshToken: async () => {
      refreshes.push('must-not-refresh');
      return 'other-token';
    } }).client;
    other.init({ appKey: 'app-key', token: 'secret-token' });
    await expect(other.connect()).rejects.toMatchObject({ code: 'connect_failed' });
    expect(refreshes).toEqual(['refresh']);
  });

  it('accepts only SDK success codes 0 and 200', async () => {
    for (const code of [0, 200]) {
      const sdk = new FakeSdk();
      sdk.connectImpl = async () => ({ code });
      const { client } = createClient({ sdk });
      client.init({ appKey: 'app-key', token: 'token' });
      await expect(client.connect()).resolves.toBeUndefined();
    }
    const sdk = new FakeSdk();
    sdk.connectImpl = async () => ({ code: 1 });
    const { client } = createClient({ sdk });
    client.init({ appKey: 'app-key', token: 'token' });
    await expect(client.connect()).rejects.toMatchObject({ code: 'connect_failed' });
  });

  it('lets disconnect win a connect race and ignores stale CONNECTED events', async () => {
    const pending = deferred<SdkResult>();
    const sdk = new FakeSdk();
    sdk.connectImpl = () => pending.promise;
    const { client, connections } = createClient({ sdk });
    client.init({ appKey: 'app-key', token: 'token' });
    const connecting = client.connect();
    await flush();
    sdk.emit('CONNECTING');
    await client.disconnect();
    pending.resolve({ code: 0 });
    await expect(connecting).rejects.toMatchObject({ code: 'disconnected' });
    sdk.emit('CONNECTED');
    expect(connections).toEqual(['connecting', 'offline']);
    await expect(client.send(send(1))).rejects.toMatchObject({ code: 'not_connected' });
  });

  it('maps only fixed connection states from SDK events', async () => {
    const { client, sdk, connections } = createClient();
    await initialize(client);
    sdk.emit('CONNECTING');
    sdk.emit('CONNECTED');
    sdk.emit('DISCONNECT', 31004);
    expect(connections).toEqual(['online', 'connecting', 'online', 'auth_error']);
  });

  it('disposes idempotently, removes listeners, destroys once, and settles pending work', async () => {
    const clock = new ManualClock();
    const { client, sdk } = createClient({ clock: clock.clock, sleep: clock.sleep });
    await initialize(client);
    const firstFive = Array.from({ length: 5 }, (_, index) => client.send(send(index)));
    await Promise.all(firstFive);
    const queued = client.send(send(6));
    await flush();
    const firstDispose = client.dispose();
    const secondDispose = client.dispose();
    expect(secondDispose).toBe(firstDispose);
    await expect(queued).rejects.toMatchObject({ code: 'disconnected' });
    await firstDispose;
    expect(sdk.disconnectCalls).toBe(1);
    expect(sdk.destroyCalls).toBe(1);
    expect([...sdk.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
    expect(clock.waits.every((wait) => wait.signal?.aborted)).toBe(true);
  });
});

describe('RongCloudClient sends and queue', () => {
  it('uses the text constructor and all six registered constructors with numeric conversations', async () => {
    const { client, sdk } = createClient();
    await initialize(client);
    const cases: Array<[SendInput['messageType'], 1 | 3 | 4]> = [
      ['text', 1],
      ['command', 1],
      ['command_result', 3],
      ['card_message', 3],
      ['card_update', 1],
      ['card_action', 4],
      ['chatroom_invite', 4],
    ];
    for (const [messageType, conversationType] of cases) {
      await client.send(send(sdk.sendCalls.length, {
        messageType,
        conversationType,
        content: messageType === 'text' ? 'hello' : { msg_type: messageType },
      }));
    }
    expect(sdk.sendCalls.map(({ conversation, message }) => ({
      conversationType: conversation.conversationType,
      kind: (message as { kind: string }).kind,
    }))).toEqual(cases.map(([kind, conversationType]) => ({ kind, conversationType })));
  });

  it('requires non-empty globally unique messageUId for card messages and updates', async () => {
    const { client, sdk } = createClient();
    await initialize(client);
    sdk.sendImpl = async () => ({ code: 0, data: { messageId: 1 } });
    await expect(client.send(send(1, {
      messageType: 'card_message', content: { msg_type: 'card_message' },
    }))).rejects.toMatchObject({ code: 'missing_message_uid' });

    sdk.sendImpl = async () => ({ code: 0, data: { messageUId: 'same-uid' } });
    await expect(client.send(send(2, {
      messageType: 'card_message', content: { msg_type: 'card_message' },
    }))).resolves.toBe('same-uid');
    await expect(client.send(send(3, {
      messageType: 'card_update', content: { msg_type: 'card_update' },
    }))).rejects.toMatchObject({ code: 'duplicate_message_uid' });
  });

  it('allows exactly five shared send/receipt attempts in each rolling 1000ms window', async () => {
    const clock = new ManualClock();
    const { client, sdk } = createClient({ clock: clock.clock, sleep: clock.sleep });
    await initialize(client);
    const attempts = [
      client.send(send(0)),
      client.send(send(1)),
      client.send(send(2)),
      client.send(send(3)),
      client.sendReceipt(message()),
      client.send(send(5)),
    ];
    await flush();
    expect(sdk.sendCalls.length + sdk.receiptV5Calls.length).toBe(5);
    expect(clock.waits.map((wait) => wait.milliseconds)).toEqual([1_000]);

    clock.now = 999;
    clock.waits[0]!.resolve();
    await flush();
    expect(sdk.sendCalls.length + sdk.receiptV5Calls.length).toBe(5);
    expect(clock.waits.map((wait) => wait.milliseconds)).toEqual([1_000, 1]);

    clock.now = 1_000;
    clock.waits[1]!.resolve();
    await Promise.all(attempts);
    expect(sdk.sendCalls.length + sdk.receiptV5Calls.length).toBe(6);
  });

  it('settles a head whose timer rejects and continues draining', async () => {
    let now = 0;
    let sleeps = 0;
    const { client, sdk } = createClient({
      clock: () => now,
      sleep: async () => {
        sleeps += 1;
        if (sleeps === 1) throw new Error('timer exploded');
        now = 1_000;
      },
    });
    await initialize(client);
    await Promise.all(Array.from({ length: 5 }, (_, index) => client.send(send(index))));
    const rejected = client.send(send(6));
    const continued = client.send(send(7));
    await expect(rejected).rejects.toMatchObject({ code: 'timer_failed' });
    await expect(continued).resolves.toBeDefined();
    expect(sdk.sendCalls).toHaveLength(6);
  });

  it('removes an aborted unstarted operation immediately', async () => {
    const clock = new ManualClock();
    const { client, sdk } = createClient({ clock: clock.clock, sleep: clock.sleep });
    await initialize(client);
    await Promise.all(Array.from({ length: 5 }, (_, index) => client.send(send(index))));
    const controller = new AbortController();
    const queued = client.send(send(6), { signal: controller.signal });
    await flush();
    controller.abort();
    await expect(queued).rejects.toMatchObject({ code: 'cancelled' });
    expect(sdk.sendCalls).toHaveLength(5);
    expect(clock.waits[0]!.signal?.aborted).toBe(true);
  });

  it('fences queued and in-flight results when disconnected', async () => {
    const clock = new ManualClock();
    const queuedFixture = createClient({ clock: clock.clock, sleep: clock.sleep });
    await initialize(queuedFixture.client);
    await Promise.all(Array.from({ length: 5 }, (_, index) => queuedFixture.client.send(send(index))));
    const queued = queuedFixture.client.send(send(6));
    await flush();
    await queuedFixture.client.disconnect();
    await expect(queued).rejects.toMatchObject({ code: 'disconnected' });
    expect(queuedFixture.sdk.sendCalls).toHaveLength(5);

    const sdk = new FakeSdk();
    const pending = deferred<SdkResult>();
    sdk.sendImpl = () => pending.promise;
    const { client } = createClient({ sdk });
    await initialize(client);
    const inFlight = client.send(send(1));
    await flush();
    await client.disconnect();
    pending.resolve({ code: 0, data: { messageUId: 'late-uid' } });
    await expect(inFlight).rejects.toMatchObject({ code: 'disconnected' });
  });
});

describe('RongCloudClient receives and compatibility operations', () => {
  it('normalizes each inbound message independently and never forwards raw SDK objects', async () => {
    const delivered: NormalizedMessage[] = [];
    const { client, sdk } = createClient({ onMessage: (value: NormalizedMessage) => delivered.push(value) });
    await initialize(client);
    const raw = {
      messageUId: 'valid-1',
      senderUserId: 'sender-1',
      targetId: 'opencode-node-1',
      conversationType: 1,
      messageType: 'command',
      content: { content: '/status', msg_type: 'device_status_request' },
      providerSecret: 'must-not-forward',
    };
    sdk.emit('MESSAGES', { messages: [null, { ...raw, messageUId: undefined }, raw] });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      messageUid: 'valid-1', senderId: 'sender-1', text: '/status', rawContent: { msg_type: 'device_status_request' },
    });
    expect(delivered[0]).not.toBe(raw);
    expect(delivered[0]).not.toHaveProperty('providerSecret');
  });

  it('skips receipts for missing, local, self-sent, and sent-cache messages', async () => {
    const { client, sdk } = createClient();
    await initialize(client);
    await client.send(send(1));
    await client.sendReceipt(undefined);
    await client.sendReceipt(message({ messageUid: '' }));
    await client.sendReceipt(message({ direction: 1 }));
    await client.sendReceipt(message({ senderId: 'opencode-node-1' }));
    await client.sendReceipt(message({ messageUid: 'sent-1' }));
    expect(sdk.receiptV5Calls).toHaveLength(0);
  });

  it('falls back V5 to V2 to V1 for group and V5 to V1 for private', async () => {
    const { client, sdk } = createClient();
    await initialize(client);
    sdk.receiptV5Impl = async () => ({ code: 500 });
    sdk.receiptV2Impl = async () => { throw new Error('unsupported'); };
    sdk.receiptV1GroupImpl = async () => ({ code: 200 });
    await client.sendReceipt(message());
    expect(sdk.receiptV5Calls).toEqual([[{ conversationType: 3, targetId: 'opencode-node-1' }, ['incoming-1']]]);
    expect(sdk.receiptV2Calls).toEqual([['opencode-node-1', { 'sender-1': ['incoming-1'] }]]);
    expect(sdk.receiptV1GroupCalls).toEqual([['opencode-node-1', ['incoming-1']]]);

    sdk.receiptV5Impl = async () => { throw new Error('unsupported'); };
    sdk.receiptV1PrivateImpl = async () => ({ code: 0 });
    await client.sendReceipt(message({ conversationType: 1, messageUid: 'private-1' }));
    expect(sdk.receiptV1PrivateCalls).toEqual([
      ['opencode-node-1', 'private-1', 1_700_000_000_000],
    ]);
  });

  it('stops receipt fallback on success code 0 or 200 and exposes fixed failure only', async () => {
    for (const code of [0, 200]) {
      const sdk = new FakeSdk();
      sdk.receiptV5Impl = async () => ({ code });
      const { client } = createClient({ sdk });
      await initialize(client);
      await client.sendReceipt(message());
      expect(sdk.receiptV2Calls).toHaveLength(0);
    }
    const sdk = new FakeSdk();
    sdk.receiptV5Impl = async () => ({ code: 500 });
    sdk.receiptV2Impl = async () => ({ code: 500 });
    sdk.receiptV1GroupImpl = async () => ({ code: 500, message: 'secret-token' });
    const { client } = createClient({ sdk });
    await initialize(client, 'secret-token');
    await expect(client.sendReceipt(message())).rejects.toMatchObject({ code: 'receipt_failed' });
  });

  it('prefers joinExistChatRoom and falls back only for code 23410', async () => {
    const { client, sdk } = createClient();
    await initialize(client);
    sdk.joinExistingImpl = async () => ({ code: 23410 });
    sdk.joinLegacyImpl = async () => ({ code: 200 });
    await client.joinChatroom('room-1', 50);
    expect(sdk.joinExistingCalls).toEqual([['room-1', { count: 50 }]]);
    expect(sdk.joinLegacyCalls).toEqual([['room-1', { count: 50 }]]);

    const otherSdk = new FakeSdk();
    otherSdk.joinExistingImpl = async () => ({ code: 500 });
    const other = createClient({ sdk: otherSdk }).client;
    await initialize(other);
    await expect(other.joinChatroom('room-2', 0)).rejects.toMatchObject({ code: 'chatroom_failed' });
    expect(otherSdk.joinLegacyCalls).toHaveLength(0);
    await expect(other.joinChatroom('room-2', 51)).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('clears joined-chatroom and sent-message state on disconnect', async () => {
    const { client, sdk } = createClient();
    await initialize(client);
    await client.joinChatroom('room-1', 0);
    await client.joinChatroom('room-1', 0);
    expect(sdk.joinExistingCalls).toHaveLength(1);
    await client.send(send(1));
    await client.disconnect();
    await client.connect();
    await client.joinChatroom('room-1', 0);
    await client.sendReceipt(message({ messageUid: 'sent-1' }));
    expect(sdk.joinExistingCalls).toHaveLength(2);
    expect(sdk.receiptV5Calls).toHaveLength(1);
  });

  it('never exposes a token or raw SDK exception in errors or JSON', async () => {
    const token = 'TOKEN_SENTINEL_client_42';
    const sdk = new FakeSdk();
    sdk.connectImpl = async () => { throw new Error(`SDK leaked ${token}`); };
    const { client } = createClient({ sdk });
    client.init({ appKey: 'app-key', token });
    let failure: unknown;
    try {
      await client.connect();
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ name: 'RongCloudClientError', code: 'connect_failed' });
    expect(String(failure)).not.toContain(token);
    expect(JSON.stringify(failure)).not.toContain(token);
  });
});
