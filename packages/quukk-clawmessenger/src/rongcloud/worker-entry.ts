import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  RongCloudClient,
  RongCloudClientError,
  type RongCloudSdkFacade,
} from './client.js';
import {
  parseWorkerCommand,
  parseWorkerEvent,
  WorkerErrorCodeSchema,
  type WorkerCommand,
  type WorkerErrorCode,
  type WorkerEvent,
} from './worker-protocol.js';

export const WORKER_INIT_TIMEOUT_MS = 15_000;
export const WORKER_REQUEST_TIMEOUT_MS = 30_000;
export const WORKER_CLEANUP_TIMEOUT_MS = 3_000;

interface WorkerPort {
  on(event: 'message' | 'disconnect', listener: (value?: unknown) => void): void;
  off(event: 'message' | 'disconnect', listener: (value?: unknown) => void): void;
  send(event: unknown): void;
}

interface RuntimeTimers {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(timer: unknown): void;
}

interface WorkerRuntimeOptions extends Partial<RuntimeTimers> {
  port: WorkerPort;
  sdk?: RongCloudSdkFacade;
  loadDependencies?: (storageDir: string) => Promise<LoadedWorkerDependencies>;
  instanceId?: string;
  exit?: (code: number) => void;
}

interface PendingRefresh {
  timer: unknown;
  resolve(token: string | undefined): void;
}

interface PendingRequest {
  timer: unknown;
  controller: AbortController;
}

export interface WorkerRuntime {
  start(): void;
  dispose(): Promise<void>;
}

type PolyfillModule = {
  installWorkerPolyfills(storageDir: string): () => void;
};

interface LoadedWorkerDependencies {
  sdk: unknown;
  disposePolyfills(): void;
}

interface WorkerDependencyLoaders {
  loadPolyfills?: () => Promise<PolyfillModule>;
  loadSdk?: () => Promise<unknown>;
}

export async function loadWorkerDependencies(
  storageDir: string,
  loaders: WorkerDependencyLoaders = {},
): Promise<LoadedWorkerDependencies> {
  const polyfillModule = await (loaders.loadPolyfills?.() ?? import('./env-polyfill.js'));
  const disposePolyfills = polyfillModule.installWorkerPolyfills(storageDir);
  try {
    const sdk = await (loaders.loadSdk?.() ?? import('@rongcloud/imlib-next'));
    return { sdk, disposePolyfills };
  } catch (error) {
    disposePolyfills();
    throw error;
  }
}

class Runtime implements WorkerRuntime {
  readonly #port: WorkerPort;
  #sdk?: RongCloudSdkFacade;
  readonly #loadDependencies: (storageDir: string) => Promise<LoadedWorkerDependencies>;
  readonly #instanceId: string;
  readonly #setTimeout: RuntimeTimers['setTimeout'];
  readonly #clearTimeout: RuntimeTimers['clearTimeout'];
  readonly #exit: (code: number) => void;
  readonly #pendingRefresh = new Map<string, PendingRefresh>();
  readonly #pendingRequests = new Map<string, PendingRequest>();
  readonly #onPortMessage = (value?: unknown): void => { void this.#receive(value); };
  readonly #onPortDisconnect = (): void => { void this.#close(0, true); };
  #runtimeId?: string;
  #client?: RongCloudClient;
  #initTimer?: unknown;
  #refreshSequence = 0;
  #started = false;
  #initializing = false;
  #active = false;
  #closingStarted = false;
  #closeGeneration = 0;
  #disposePolyfills?: () => void;
  #closing?: Promise<void>;

  constructor(options: WorkerRuntimeOptions) {
    this.#port = options.port;
    this.#sdk = options.sdk;
    this.#loadDependencies = options.loadDependencies ?? loadWorkerDependencies;
    this.#instanceId = options.instanceId ?? `rcw_${randomBytes(16).toString('hex')}`;
    this.#setTimeout = options.setTimeout ?? ((callback, milliseconds) => setTimeout(callback, milliseconds));
    const clearTimer = options.clearTimeout
      ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    this.#clearTimeout = (timer) => {
      try { clearTimer(timer); } catch { /* Cleanup deadlines remain fixed. */ }
    };
    this.#exit = options.exit ?? (() => undefined);
  }

  start(): void {
    if (this.#started || this.#closingStarted) return;
    this.#started = true;
    this.#port.on('message', this.#onPortMessage);
    this.#port.on('disconnect', this.#onPortDisconnect);
    this.#initTimer = this.#setTimeout(() => {
      void this.#close(1, true);
    }, WORKER_INIT_TIMEOUT_MS);
  }

  dispose(): Promise<void> {
    return this.#close(undefined, false);
  }

  async #receive(input: unknown): Promise<void> {
    if (this.#closingStarted) return;
    const parsed = parseWorkerCommand(input);
    if (!parsed.ok) {
      await this.#close(1, true);
      return;
    }
    const command = parsed.value;
    if (command.type === 'refresh_result') {
      if (!this.#resolveRefresh(command)) await this.#close(1, true);
      return;
    }
    if (command.type === 'init') {
      if (this.#initializing || this.#active || this.#client) {
        await this.#close(1, true);
        return;
      }
      await this.#initialize(command);
      return;
    }
    if (!this.#active || !this.#client) {
      await this.#close(1, true);
      return;
    }
    this.#runRequest(command);
  }

  async #initialize(command: Extract<WorkerCommand, { type: 'init' }>): Promise<void> {
    this.#initializing = true;
    this.#runtimeId = command.binding.runtimeId;
    let sdk = this.#sdk;
    if (!sdk) {
      let loaded: LoadedWorkerDependencies;
      try {
        loaded = await this.#loadDependencies(command.binding.storageDir);
      } catch {
        if (!this.#closingStarted) await this.#close(1, true);
        return;
      }
      if (this.#closingStarted) {
        try { loaded.disposePolyfills(); } catch { /* Cleanup remains fixed and local. */ }
        return;
      }
      sdk = loaded.sdk as RongCloudSdkFacade;
      this.#sdk = sdk;
      this.#disposePolyfills = loaded.disposePolyfills;
    }
    const client = new RongCloudClient({
      sdk,
      nodeId: command.binding.nodeId,
      refreshToken: () => this.#requestRefresh(),
      onConnection: (state) => {
        if (!this.#closingStarted) this.#emit({ type: 'connection', ...this.#identity(), state });
      },
      onMessage: (message) => {
        if (!this.#closingStarted) this.#emit({ type: 'message', ...this.#identity(), message });
      },
    });
    this.#client = client;
    try {
      client.init({ appKey: command.binding.appKey, token: command.token });
      this.#emit({ type: 'ready', ...this.#identity() });
      await client.connect();
      if (this.#closingStarted) return;
      this.#initializing = false;
      this.#active = true;
      this.#clearInitTimer();
    } catch (error) {
      if (!this.#closingStarted) {
        const code = fixedErrorCode(error, 'connect_failed');
        this.#emit({
          type: 'connection',
          ...this.#identity(),
          state: code === 'authentication_failed' ? 'auth_error' : 'offline',
        });
        await this.#close(1, true);
      }
    }
  }

  #requestRefresh(): Promise<string | undefined> {
    if (this.#closingStarted || !this.#runtimeId) return Promise.resolve(undefined);
    const requestId = `refresh_${++this.#refreshSequence}_${randomBytes(8).toString('hex')}`;
    return new Promise((resolve) => {
      const timer = this.#setTimeout(() => {
        const pending = this.#pendingRefresh.get(requestId);
        if (!pending) return;
        this.#pendingRefresh.delete(requestId);
        pending.resolve(undefined);
      }, WORKER_REQUEST_TIMEOUT_MS);
      this.#pendingRefresh.set(requestId, { timer, resolve });
      this.#emit({ type: 'refresh_required', ...this.#identity(), requestId });
    });
  }

  #resolveRefresh(command: Extract<WorkerCommand, { type: 'refresh_result' }>): boolean {
    const pending = this.#pendingRefresh.get(command.requestId);
    if (!pending) return false;
    this.#pendingRefresh.delete(command.requestId);
    this.#clearTimeout(pending.timer);
    pending.resolve(command.ok ? command.token : undefined);
    return true;
  }

  #runRequest(command: Exclude<WorkerCommand, { type: 'init' | 'refresh_result' }>): void {
    if (this.#pendingRequests.has(command.requestId)) {
      this.#emitFailure(command.requestId, 'invalid_request');
      return;
    }
    const controller = new AbortController();
    const timer = this.#setTimeout(() => {
      const pending = this.#pendingRequests.get(command.requestId);
      if (!pending) return;
      this.#pendingRequests.delete(command.requestId);
      pending.controller.abort();
      this.#emitFailure(command.requestId, 'timeout');
    }, WORKER_REQUEST_TIMEOUT_MS);
    this.#pendingRequests.set(command.requestId, { timer, controller });

    let operation: Promise<string | undefined>;
    try {
      operation = this.#operation(command, controller.signal);
    } catch (error) {
      operation = Promise.reject(error);
    }
    void operation.then(
      (messageUid) => this.#finishRequest(command.requestId, { ok: true, messageUid }),
      (error: unknown) => this.#finishRequest(command.requestId, {
        ok: false,
        errorCode: fixedErrorCode(error, fallbackCode(command.type)),
      }),
    );
  }

  async #operation(
    command: Exclude<WorkerCommand, { type: 'init' | 'refresh_result' }>,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const client = this.#client!;
    switch (command.type) {
      case 'send':
        return client.send({
          conversationType: command.conversationType,
          targetId: command.targetId,
          messageType: command.messageType,
          content: command.content,
        }, { signal });
      case 'receipt':
        await client.sendReceipt({
          messageUid: command.messageUid,
          senderId: command.senderId,
          targetId: command.targetId,
          conversationType: command.conversationType,
          objectName: 'receipt',
          attachments: [],
          direction: command.direction,
        }, { signal });
        return undefined;
      case 'join_chatroom':
        await client.joinChatroom(command.roomId, command.historyCount);
        return undefined;
      case 'disconnect':
        await client.disconnect();
        return undefined;
    }
  }

  #finishRequest(
    requestId: string,
    result: { ok: true; messageUid?: string } | { ok: false; errorCode: WorkerErrorCode },
  ): void {
    const pending = this.#pendingRequests.get(requestId);
    if (!pending) return;
    this.#pendingRequests.delete(requestId);
    this.#clearTimeout(pending.timer);
    if (result.ok) {
      this.#emit({ type: 'result', ...this.#identity(), requestId, ok: true, ...(
        result.messageUid === undefined ? {} : { messageUid: result.messageUid }
      ) });
    } else {
      this.#emitFailure(requestId, result.errorCode);
    }
  }

  #emitFailure(requestId: string, errorCode: WorkerErrorCode): void {
    this.#emit({ type: 'result', ...this.#identity(), requestId, ok: false, errorCode });
  }

  #emit(event: WorkerEvent): void {
    if (this.#closingStarted) return;
    const parsed = parseWorkerEvent(event);
    if (!parsed.ok) {
      void this.#close(1, true);
      return;
    }
    try {
      this.#port.send(parsed.value);
    } catch {
      void this.#close(1, true);
    }
  }

  #identity(): { runtimeId: string; instanceId: string } {
    return { runtimeId: this.#runtimeId!, instanceId: this.#instanceId };
  }

  #close(exitCode: number | undefined, callExit: boolean): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closingStarted = true;
    const closeGeneration = ++this.#closeGeneration;
    const closing = Promise.resolve().then(async () => {
      this.#active = false;
      this.#initializing = false;
      this.#clearInitTimer();
      if (this.#started) {
        this.#port.off('message', this.#onPortMessage);
        this.#port.off('disconnect', this.#onPortDisconnect);
        this.#started = false;
      }
      for (const [requestId, pending] of this.#pendingRefresh) {
        this.#clearTimeout(pending.timer);
        this.#pendingRefresh.delete(requestId);
        pending.resolve(undefined);
      }
      for (const [requestId, pending] of this.#pendingRequests) {
        this.#clearTimeout(pending.timer);
        pending.controller.abort();
        this.#pendingRequests.delete(requestId);
      }
      const client = this.#client;
      this.#client = undefined;
      this.#runtimeId = undefined;
      await this.#boundedCleanup(async () => {
        try {
          await client?.dispose();
        } catch {
          // Cleanup errors are never forwarded across IPC.
        }
      });
      const disposePolyfills = this.#disposePolyfills;
      this.#disposePolyfills = undefined;
      try { disposePolyfills?.(); } catch { /* Cleanup remains fixed and local. */ }
      this.#sdk = undefined;
      if (callExit && exitCode !== undefined && closeGeneration === this.#closeGeneration) {
        try { this.#exit(exitCode); } catch { /* The process boundary remains closed. */ }
      }
    });
    this.#closing = closing;
    return closing;
  }

  #boundedCleanup(cleanup: () => Promise<void>): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      let timer: unknown;
      let timerInstalled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (timerInstalled) this.#clearTimeout(timer);
        resolve();
      };
      let cleanupAttempt: Promise<void>;
      try {
        cleanupAttempt = cleanup();
      } catch {
        finish();
        return;
      }
      void cleanupAttempt.then(finish, finish);
      if (settled) return;
      try {
        timer = this.#setTimeout(finish, WORKER_CLEANUP_TIMEOUT_MS);
        timerInstalled = true;
        if (settled) this.#clearTimeout(timer);
      } catch {
        finish();
      }
    });
  }

  #clearInitTimer(): void {
    if (this.#initTimer !== undefined) this.#clearTimeout(this.#initTimer);
    this.#initTimer = undefined;
  }
}

function fixedErrorCode(error: unknown, fallback: WorkerErrorCode): WorkerErrorCode {
  if (!(error instanceof RongCloudClientError)) return fallback;
  const parsed = WorkerErrorCodeSchema.safeParse(error.code);
  return parsed.success ? parsed.data : fallback;
}

function fallbackCode(command: Exclude<WorkerCommand, { type: 'init' | 'refresh_result' }>['type']): WorkerErrorCode {
  switch (command) {
    case 'send': return 'send_failed';
    case 'receipt': return 'receipt_failed';
    case 'join_chatroom': return 'chatroom_failed';
    case 'disconnect': return 'disconnected';
  }
}

export function createWorkerRuntime(options: WorkerRuntimeOptions): WorkerRuntime {
  return new Runtime(options);
}

function processPort(): WorkerPort {
  return {
    on(event, listener) {
      if (event === 'message') process.on('message', listener);
      else process.on('disconnect', listener);
    },
    off(event, listener) {
      if (event === 'message') process.off('message', listener);
      else process.off('disconnect', listener);
    },
    send(event) {
      if (process.connected && process.send) process.send(event);
    },
  };
}

async function startChild(): Promise<void> {
  try {
    const runtime = createWorkerRuntime({
      port: processPort(),
      loadDependencies: loadWorkerDependencies,
      exit: (code) => {
        process.exitCode = code;
        if (process.connected) process.disconnect?.();
      },
    });
    runtime.start();
  } catch {
    process.exitCode = 1;
    if (process.connected) process.disconnect?.();
  }
}

export function isDirectIpcEntry(
  argv: readonly string[] = process.argv,
  connected = process.connected,
  send: unknown = process.send,
  moduleUrl = import.meta.url,
): boolean {
  if (typeof send !== 'function' || connected !== true) return false;
  try {
    const entry = argv[1];
    return typeof entry === 'string' && entry.length > 0
      && pathToFileURL(resolve(entry)).href === moduleUrl;
  } catch {
    return false;
  }
}

if (isDirectIpcEntry()) void startChild();
