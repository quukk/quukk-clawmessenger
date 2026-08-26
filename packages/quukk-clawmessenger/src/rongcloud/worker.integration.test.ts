// @vitest-environment node

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { parseWorkerEvent } from './worker-protocol.js';

type SdkResult = { code: number; data?: { messageUId?: string } };

type WorkerRuntime = {
  start(): void;
  dispose(): Promise<void>;
};

type WorkerModule = {
  WORKER_INIT_TIMEOUT_MS: number;
  WORKER_REQUEST_TIMEOUT_MS: number;
  isDirectIpcEntry(
    argv?: readonly string[],
    connected?: boolean,
    send?: unknown,
    moduleUrl?: string,
  ): boolean;
  createWorkerRuntime(options: Record<string, unknown>): WorkerRuntime;
  loadWorkerDependencies(loaders?: Record<string, unknown>): Promise<{
    sdk: unknown;
    disposePolyfills(): void;
  }>;
};

type XMLHttpRequestLike = {
  readyState: number;
  status: number;
  responseText: string;
  timeout: number;
  onload?: () => void;
  onerror?: () => void;
  onabort?: () => void;
  ontimeout?: () => void;
  onloadend?: () => void;
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(body?: string | Uint8Array): void;
  abort(): void;
  getAllResponseHeaders(): string;
  getResponseHeader(name: string): string | null;
};

type PolyfillModule = {
  MAX_XHR_RESPONSE_BYTES: number;
  NodeXMLHttpRequest: new () => XMLHttpRequestLike;
  installWorkerPolyfills(): () => void;
};

let workerModule: WorkerModule | undefined;
let polyfillModule: PolyfillModule | undefined;
let messageListenersBeforeImport = 0;
let messageListenersAfterImport = 0;

beforeAll(async () => {
  messageListenersBeforeImport = process.listenerCount('message');
  workerModule = await import('./worker-entry.js')
    .then((module) => module as unknown as WorkerModule)
    .catch(() => undefined);
  messageListenersAfterImport = process.listenerCount('message');
  polyfillModule = await import('./env-polyfill.js')
    .then((module) => module as unknown as PolyfillModule)
    .catch(() => undefined);
});

function workerApi(): WorkerModule {
  expect(workerModule, 'Phase C worker entry implementation is missing').toBeDefined();
  return workerModule!;
}

function polyfillsApi(): PolyfillModule {
  expect(polyfillModule, 'Phase C worker polyfill implementation is missing').toBeDefined();
  return polyfillModule!;
}

async function flush(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

class FakePort {
  readonly sent: unknown[] = [];
  readonly listeners = new Map<string, Set<(value?: unknown) => void>>();

  on(event: 'message' | 'disconnect', listener: (value?: unknown) => void): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  off(event: 'message' | 'disconnect', listener: (value?: unknown) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  send(event: unknown): void {
    this.sent.push(structuredClone(event));
  }

  emit(event: 'message' | 'disconnect', value?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
}

class ManualTimers {
  readonly pending = new Map<number, { callback: () => void; milliseconds: number }>();
  #nextId = 1;

  readonly setTimeout = (callback: () => void, milliseconds: number): number => {
    const id = this.#nextId++;
    this.pending.set(id, { callback, milliseconds });
    return id;
  };

  readonly clearTimeout = (id: number): void => {
    this.pending.delete(id);
  };

  run(milliseconds: number): void {
    for (const [id, timer] of [...this.pending]) {
      if (timer.milliseconds !== milliseconds) continue;
      this.pending.delete(id);
      timer.callback();
    }
  }
}

class FakeSdk {
  readonly Events = {
    CONNECTING: 'CONNECTING',
    CONNECTED: 'CONNECTED',
    DISCONNECT: 'DISCONNECT',
    MESSAGES: 'MESSAGES',
  };
  readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  readonly connectTokens: string[] = [];
  disconnectCalls = 0;
  destroyCalls = 0;
  sendImpl: () => Promise<SdkResult> = async () => ({ code: 0, data: { messageUId: 'sent-1' } });
  connectImpl: (token: string) => Promise<SdkResult> = async () => ({ code: 0 });

  readonly TextMessage = class {
    constructor(readonly content: Record<string, unknown>) {}
  };

  init(): void {}

  registerMessageType(name: string) {
    return class {
      readonly kind = name;
      constructor(readonly content: Record<string, unknown>) {}
    };
  }

  addEventListener(name: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.listeners.set(name, listeners);
  }

  removeEventListener(name: string, listener: (event: unknown) => void): void {
    this.listeners.get(name)?.delete(listener);
  }

  emit(name: string, event: unknown): void {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }

  async connect(token: string): Promise<SdkResult> {
    this.connectTokens.push(token);
    return this.connectImpl(token);
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls += 1;
  }

  async destroy(): Promise<void> {
    this.destroyCalls += 1;
  }

  async sendMessage(): Promise<SdkResult> {
    return this.sendImpl();
  }

  async joinExistChatRoom(): Promise<SdkResult> {
    return { code: 0 };
  }

  async joinChatRoom(): Promise<SdkResult> {
    return { code: 0 };
  }

  async sendReadReceiptResponseV5(): Promise<SdkResult> {
    return { code: 0 };
  }

  async sendReadReceiptResponseV2(): Promise<SdkResult> {
    return { code: 0 };
  }

  async sendReadReceiptResponse(): Promise<SdkResult> {
    return { code: 0 };
  }

  async sendReadReceiptMessage(): Promise<SdkResult> {
    return { code: 0 };
  }
}

const runtimeId = 'rt_0123456789abcdef0123456789abcdef';
const instanceId = 'rcw_0123456789abcdef0123456789abcdef';
const tokenSentinel = 'PHASE_C_TOKEN_SENTINEL_77';

function init(token = tokenSentinel) {
  return {
    type: 'init',
    binding: {
      runtimeId,
      nodeId: 'opencode-node-1',
      appKey: 'app-key',
      storageDir: 'D:\\worker-storage',
    },
    token,
  };
}

function createRuntime(options: Record<string, unknown> = {}) {
  const port = options.port instanceof FakePort ? options.port : new FakePort();
  const sdk = options.sdk instanceof FakeSdk ? options.sdk : new FakeSdk();
  const timers = options.timers instanceof ManualTimers ? options.timers : new ManualTimers();
  const exits: number[] = [];
  const runtime = workerApi().createWorkerRuntime({
    port,
    sdk,
    instanceId,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    exit: (code: number) => exits.push(code),
    ...options,
  });
  runtime.start();
  return { runtime, port, sdk, timers, exits };
}

async function initialize(fixture: ReturnType<typeof createRuntime>, token = tokenSentinel): Promise<void> {
  fixture.port.emit('message', init(token));
  await flush();
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return (server.address() as AddressInfo).port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function xhrRequest(Xhr: new () => XMLHttpRequestLike, url: string): Promise<XMLHttpRequestLike> {
  return new Promise((resolve, reject) => {
    const xhr = new Xhr();
    xhr.onload = () => resolve(xhr);
    xhr.onerror = () => reject(new Error('xhr_error'));
    xhr.open('GET', url);
    xhr.send();
  });
}

describe('worker-only dependency loading', () => {
  it('does not auto-start when imported without a real child IPC channel', () => {
    const { isDirectIpcEntry } = workerApi();
    const entry = resolve('D:\\packaged\\worker-entry.js');
    const entryUrl = pathToFileURL(entry).href;
    expect(isDirectIpcEntry(['node', entry], true, () => undefined, entryUrl)).toBe(true);
    expect(isDirectIpcEntry(['node', entry], false, () => undefined, entryUrl)).toBe(false);
    expect(isDirectIpcEntry([], true, () => undefined, entryUrl)).toBe(false);
    expect(isDirectIpcEntry(new Proxy([], { get: () => { throw new Error('argv trap'); } }), true,
      () => undefined, entryUrl)).toBe(false);
    expect(isDirectIpcEntry()).toBe(false);
    expect(messageListenersAfterImport).toBe(messageListenersBeforeImport);
  });

  it('applies polyfills before loading the RongCloud SDK and exposes cleanup', async () => {
    const order: string[] = [];
    const dispose = () => order.push('dispose');
    const sdk = { marker: 'sdk' };
    const loaded = await workerApi().loadWorkerDependencies({
      loadPolyfills: async () => ({
        installWorkerPolyfills: () => {
          order.push('polyfills');
          return dispose;
        },
      }),
      loadSdk: async () => {
        order.push('sdk');
        return sdk;
      },
    });

    expect(order).toEqual(['polyfills', 'sdk']);
    expect(loaded.sdk).toBe(sdk);
    loaded.disposePolyfills();
    expect(order).toEqual(['polyfills', 'sdk', 'dispose']);
  });
});

describe('worker browser polyfills', () => {
  it('installs child-local browser/indexedDB/socket globals and restores the process exactly', () => {
    const before = new Map(['window', 'document', 'navigator', 'location', 'localStorage', 'sessionStorage',
      'indexedDB', 'IDBKeyRange', 'WebSocket', 'XMLHttpRequest'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]));
    const dispose = polyfillsApi().installWorkerPolyfills();
    try {
      expect(globalThis).toHaveProperty('window');
      expect(globalThis).toHaveProperty('document');
      expect(globalThis).toHaveProperty('indexedDB');
      expect(globalThis).toHaveProperty('IDBKeyRange');
      expect(globalThis).toHaveProperty('XMLHttpRequest');
      expect((globalThis as unknown as { window: Record<string, unknown> }).window).toHaveProperty('Buffer', Buffer);
      const Socket = (globalThis as unknown as { WebSocket: new (url: string) => unknown }).WebSocket;
      expect(() => new Socket('file:///tmp/socket')).toThrow();
      expect(() => new Socket('data:text/plain,no')).toThrow();
    } finally {
      dispose();
    }
    for (const [key, descriptor] of before) {
      expect(Object.getOwnPropertyDescriptor(globalThis, key)).toEqual(descriptor);
    }
  });

  it('implements bounded HTTP-only XMLHttpRequest with normalized headers and abort cleanup', async () => {
    const { NodeXMLHttpRequest: Xhr, MAX_XHR_RESPONSE_BYTES } = polyfillsApi();
    const server = createServer((request, response) => {
      if (request.url === '/ok') {
        response.writeHead(200, { 'X-Test-Header': 'Value' });
        response.end('hello');
      } else if (request.url === '/large') {
        response.writeHead(200);
        response.end(Buffer.alloc(MAX_XHR_RESPONSE_BYTES + 1, 120));
      }
    });
    const port = await listen(server);
    try {
      const ok = await xhrRequest(Xhr, `http://127.0.0.1:${port}/ok`);
      expect(ok.status).toBe(200);
      expect(ok.responseText).toBe('hello');
      expect(ok.getResponseHeader('X-Test-Header')).toBe('Value');
      expect(ok.getAllResponseHeaders()).toContain('x-test-header: Value');

      await expect(xhrRequest(Xhr, `http://127.0.0.1:${port}/large`)).rejects.toThrow('xhr_error');
      const aborted = new Xhr();
      const abortEvent = new Promise<void>((resolve) => { aborted.onabort = resolve; });
      aborted.open('GET', `http://127.0.0.1:${port}/slow`);
      aborted.send();
      aborted.abort();
      await abortEvent;
      expect(aborted.status).toBe(0);
      expect(() => new Xhr().open('GET', 'file:///tmp/secret')).toThrow();
      expect(() => new Xhr().open('GET', 'data:text/plain,secret')).toThrow();
    } finally {
      await close(server);
    }
  });

  it('clears request headers and response state before reusing an XMLHttpRequest', async () => {
    const { NodeXMLHttpRequest: Xhr } = polyfillsApi();
    const receivedBySecond: Array<string | undefined> = [];
    const firstServer = createServer((_request, response) => {
      response.writeHead(200, { 'X-First': 'first-value' });
      response.end('first-body');
    });
    const secondServer = createServer((request, response) => {
      receivedBySecond.push(request.headers.authorization);
      response.writeHead(200, { 'X-Second': 'second-value' });
      response.end('second-body');
    });
    const firstPort = await listen(firstServer);
    const secondPort = await listen(secondServer);
    try {
      const xhr = new Xhr();
      xhr.open('GET', `http://127.0.0.1:${firstPort}/a`);
      xhr.setRequestHeader('Authorization', 'Bearer PHASE_C_HEADER_SENTINEL_44');
      const first = new Promise<void>((resolve, reject) => {
        xhr.onload = resolve;
        xhr.onerror = () => reject(new Error('first_xhr_error'));
      });
      xhr.send();
      await first;
      expect(xhr.responseText).toBe('first-body');
      expect(xhr.getResponseHeader('x-first')).toBe('first-value');

      xhr.open('GET', `http://127.0.0.1:${secondPort}/b`);
      expect(xhr.readyState).toBe(1);
      expect(xhr.status).toBe(0);
      expect(xhr.responseText).toBe('');
      expect(xhr.getAllResponseHeaders()).toBe('');
      const second = new Promise<void>((resolve, reject) => {
        xhr.onload = resolve;
        xhr.onerror = () => reject(new Error('second_xhr_error'));
      });
      xhr.send();
      await second;
      expect(receivedBySecond).toEqual([undefined]);
      expect(xhr.responseText).toBe('second-body');
      expect(xhr.getResponseHeader('x-first')).toBeNull();
      expect(xhr.getResponseHeader('x-second')).toBe('second-value');
    } finally {
      await Promise.all([close(firstServer), close(secondServer)]);
    }
  });

  it('returns redirects without following them and times out with complete transport cleanup', async () => {
    const { NodeXMLHttpRequest: Xhr, installWorkerPolyfills } = polyfillsApi();
    let redirectTargetHits = 0;
    const redirectTarget = createServer((_request, response) => {
      redirectTargetHits += 1;
      response.end('must-not-be-requested');
    });
    const targetPort = await listen(redirectTarget);
    const redirectServer = createServer((_request, response) => {
      response.writeHead(302, { Location: `http://127.0.0.1:${targetPort}/target` });
      response.end('redirect-response');
    });
    const timeoutServer = createServer(() => undefined);
    const redirectPort = await listen(redirectServer);
    const timeoutPort = await listen(timeoutServer);
    const dispose = installWorkerPolyfills();
    try {
      const redirect = await xhrRequest(Xhr, `http://127.0.0.1:${redirectPort}/redirect`);
      expect(redirect.status).toBe(302);
      expect(redirect.responseText).toBe('redirect-response');
      expect(redirectTargetHits).toBe(0);

      const timedOut = new Xhr();
      timedOut.timeout = 20;
      const events: string[] = [];
      const timeout = new Promise<void>((resolve, reject) => {
        timedOut.ontimeout = () => { events.push('timeout'); resolve(); };
        timedOut.onloadend = () => { events.push('loadend'); };
        timedOut.onerror = () => reject(new Error('expected_timeout'));
      });
      timedOut.open('GET', `http://127.0.0.1:${timeoutPort}/slow`);
      timedOut.send();
      await timeout;
      expect(events).toEqual(['timeout', 'loadend']);
      expect(timedOut.status).toBe(0);
    } finally {
      dispose();
      await Promise.all([close(redirectServer), close(redirectTarget), close(timeoutServer)]);
    }
  });
});

describe('injected worker runtime', () => {
  it('rejects actions before init and exits cleanly without emitting an invalid event', async () => {
    const fixture = createRuntime();
    fixture.port.emit('message', { type: 'disconnect', requestId: 'before-init' });
    await flush();
    expect(fixture.exits).toEqual([1]);
    expect(fixture.port.sent).toEqual([]);
    expect(fixture.timers.pending.size).toBe(0);
  });

  it('accepts init once, rejects duplicate init, and never emits a token', async () => {
    const fixture = createRuntime();
    await initialize(fixture);
    expect(fixture.port.sent).toContainEqual({ type: 'ready', runtimeId, instanceId });
    expect(fixture.port.sent).toContainEqual({ type: 'connection', runtimeId, instanceId, state: 'online' });
    fixture.port.emit('message', init('second-token'));
    await flush();
    expect(fixture.exits).toEqual([1]);
    expect(JSON.stringify(fixture.port.sent)).not.toContain(tokenSentinel);
    expect(JSON.stringify(fixture.port.sent)).not.toContain('second-token');
    expect(fixture.port.sent.every((event) => parseWorkerEvent(event).ok)).toBe(true);
  });

  it('performs a correlated token refresh handshake without echoing either token', async () => {
    const sdk = new FakeSdk();
    const results = [{ code: 31004 }, { code: 0 }];
    sdk.connectImpl = async () => results.shift()!;
    const fixture = createRuntime({ sdk });
    fixture.port.emit('message', init('expired-token'));
    await flush();
    const refresh = fixture.port.sent.find((event) =>
      (event as { type?: string }).type === 'refresh_required') as { requestId: string };
    expect(refresh).toMatchObject({ type: 'refresh_required', runtimeId, instanceId });
    fixture.port.emit('message', {
      type: 'refresh_result', requestId: refresh.requestId, ok: true, token: 'fresh-token',
    });
    await flush();
    expect(sdk.connectTokens).toEqual(['expired-token', 'fresh-token']);
    expect(fixture.port.sent).toContainEqual({ type: 'connection', runtimeId, instanceId, state: 'online' });
    expect(JSON.stringify(fixture.port.sent)).not.toMatch(/expired-token|fresh-token/);
  });

  it('correlates send, receipt, chatroom, and disconnect results by request ID', async () => {
    const fixture = createRuntime();
    await initialize(fixture);
    fixture.port.emit('message', {
      type: 'send', requestId: 'send-1', conversationType: 1, targetId: 'target-1',
      messageType: 'text', content: 'hello',
    });
    fixture.port.emit('message', {
      type: 'receipt', requestId: 'receipt-1', messageUid: 'incoming-1', senderId: 'sender-1',
      targetId: 'group-1', conversationType: 3, direction: 2,
    });
    fixture.port.emit('message', {
      type: 'join_chatroom', requestId: 'join-1', roomId: 'room-1', historyCount: 0,
    });
    await flush();
    fixture.port.emit('message', { type: 'disconnect', requestId: 'disconnect-1' });
    await flush();
    expect(fixture.port.sent).toEqual(expect.arrayContaining([
      { type: 'result', runtimeId, instanceId, requestId: 'send-1', ok: true, messageUid: 'sent-1' },
      { type: 'result', runtimeId, instanceId, requestId: 'receipt-1', ok: true },
      { type: 'result', runtimeId, instanceId, requestId: 'join-1', ok: true },
      { type: 'result', runtimeId, instanceId, requestId: 'disconnect-1', ok: true },
    ]));
  });

  it('normalizes valid inbound siblings and drops invalid/raw SDK state independently', async () => {
    const fixture = createRuntime();
    await initialize(fixture);
    fixture.sdk.emit('MESSAGES', {
      messages: [
        { broken: true },
        {
          messageUId: 'incoming-1', senderUserId: 'sender-1', targetId: 'opencode-node-1',
          conversationType: 1, messageType: 'command',
          content: { content: '/status', msg_type: 'device_status_request' },
          rawSdkSecret: tokenSentinel,
        },
      ],
    });
    await flush();
    const messages = fixture.port.sent.filter((event) => (event as { type?: string }).type === 'message');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: 'message', runtimeId, instanceId,
      message: { messageUid: 'incoming-1', senderId: 'sender-1', text: '/status' },
    });
    expect(JSON.stringify(messages)).not.toContain(tokenSentinel);
  });

  it('maps raw SDK exceptions to fixed result errors with no secret', async () => {
    const sdk = new FakeSdk();
    sdk.sendImpl = async () => { throw new Error(`leaked ${tokenSentinel}`); };
    const fixture = createRuntime({ sdk });
    await initialize(fixture);
    fixture.port.emit('message', {
      type: 'send', requestId: 'send-failure', conversationType: 1, targetId: 'target-1',
      messageType: 'text', content: 'hello',
    });
    await flush();
    expect(fixture.port.sent).toContainEqual({
      type: 'result', runtimeId, instanceId, requestId: 'send-failure', ok: false, errorCode: 'send_failed',
    });
    expect(JSON.stringify(fixture.port.sent)).not.toContain(tokenSentinel);
  });

  it('enforces finite init and request timeouts and ignores late completions', async () => {
    const initFixture = createRuntime();
    initFixture.timers.run(workerApi().WORKER_INIT_TIMEOUT_MS);
    await flush();
    expect(initFixture.exits).toEqual([1]);
    expect(initFixture.timers.pending.size).toBe(0);

    const pending = new Promise<SdkResult>(() => undefined);
    const sdk = new FakeSdk();
    sdk.sendImpl = () => pending;
    const requestFixture = createRuntime({ sdk });
    await initialize(requestFixture);
    requestFixture.port.emit('message', {
      type: 'send', requestId: 'timed-out', conversationType: 1, targetId: 'target-1',
      messageType: 'text', content: 'hello',
    });
    await flush();
    requestFixture.timers.run(workerApi().WORKER_REQUEST_TIMEOUT_MS);
    await flush();
    expect(requestFixture.port.sent).toContainEqual({
      type: 'result', runtimeId, instanceId, requestId: 'timed-out', ok: false, errorCode: 'timeout',
    });
  });

  it('times out a hung initial connect, disposes it, and cannot be revived by a late success', async () => {
    let resolveConnect: ((result: SdkResult) => void) | undefined;
    const sdk = new FakeSdk();
    sdk.connectImpl = () => new Promise((resolve) => { resolveConnect = resolve; });
    const fixture = createRuntime({ sdk });
    fixture.port.emit('message', init('hung-connect-token'));
    await flush();
    expect(fixture.port.sent).toContainEqual({ type: 'ready', runtimeId, instanceId });
    expect(fixture.port.sent).not.toContainEqual({
      type: 'connection', runtimeId, instanceId, state: 'online',
    });

    fixture.timers.run(workerApi().WORKER_INIT_TIMEOUT_MS);
    await flush();
    expect(fixture.exits).toEqual([1]);
    expect(fixture.timers.pending.size).toBe(0);
    expect(sdk.disconnectCalls).toBe(1);
    expect(sdk.destroyCalls).toBe(1);
    const eventsAfterTimeout = structuredClone(fixture.port.sent);

    resolveConnect?.({ code: 0 });
    await flush();
    expect(fixture.port.sent).toEqual(eventsAfterTimeout);
    expect(fixture.exits).toEqual([1]);
  });

  it('cleans listeners, client resources, and timers when the parent disconnects', async () => {
    const fixture = createRuntime();
    await initialize(fixture);
    fixture.port.emit('disconnect');
    await flush();
    expect(fixture.sdk.disconnectCalls).toBe(1);
    expect(fixture.sdk.destroyCalls).toBe(1);
    expect(fixture.exits).toEqual([0]);
    expect(fixture.timers.pending.size).toBe(0);
    expect([...fixture.port.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
    expect([...fixture.sdk.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
  });

  it('fences IPC before client cleanup can synchronously report offline', async () => {
    const fixture = createRuntime();
    await initialize(fixture);
    const eventsBeforeClose = structuredClone(fixture.port.sent);

    fixture.port.emit('disconnect');
    expect(fixture.port.sent).toEqual(eventsBeforeClose);
    await flush();

    const firstDispose = fixture.runtime.dispose();
    const secondDispose = fixture.runtime.dispose();
    expect(secondDispose).toBe(firstDispose);
    await firstDispose;
    expect(fixture.port.sent).toEqual(eventsBeforeClose);
    expect(fixture.exits).toEqual([0]);
  });
});
