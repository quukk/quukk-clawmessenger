import { isProxy } from 'node:util/types';

import {
  normalizeRongCloudMessage,
  type NormalizedRongCloudMessage,
  type RongCloudConversationType,
} from '../protocol/messages.js';
import type { ConnectionState, WorkerErrorCode } from './worker-protocol.js';

type MessageConstructor = new (content: Record<string, unknown>) => unknown;

export interface RongCloudSdkResult {
  code: number;
  data?: { messageUId?: string; messageId?: string | number };
  message?: string;
}

export interface RongCloudSdkFacade {
  Events?: Partial<Record<'CONNECTING' | 'CONNECTED' | 'SUSPEND' | 'DISCONNECT' | 'MESSAGES', string>>;
  TextMessage?: MessageConstructor;
  init(options: { appkey: string }): void;
  connect(token: string): Promise<RongCloudSdkResult>;
  disconnect(): void | Promise<void>;
  destroy?(): void | Promise<void>;
  registerMessageType(
    name: string,
    isPersisted: boolean,
    isCounted: boolean,
  ): MessageConstructor;
  addEventListener(name: string, listener: (event: unknown) => void): void;
  removeEventListener?(name: string, listener: (event: unknown) => void): void;
  sendMessage(
    conversation: { conversationType: number; targetId: string },
    message: unknown,
    options: { needReceipt: true },
  ): Promise<RongCloudSdkResult>;
  joinExistChatRoom?(roomId: string, options: { count: number }): Promise<RongCloudSdkResult>;
  joinChatRoom?(roomId: string, options: { count: number }): Promise<RongCloudSdkResult>;
  sendReadReceiptResponseV5?(
    conversation: { conversationType: number; targetId: string },
    messageUIds: string[],
  ): Promise<RongCloudSdkResult>;
  sendReadReceiptResponseV2?(
    targetId: string,
    messages: Record<string, string[]>,
  ): Promise<RongCloudSdkResult>;
  sendReadReceiptResponse?(targetId: string, messageUIds: string[]): Promise<RongCloudSdkResult>;
  sendReadReceiptMessage?(
    targetId: string,
    messageUId: string,
    timestamp: number,
  ): Promise<RongCloudSdkResult>;
}

export interface RongCloudClientOptions {
  sdk: RongCloudSdkFacade;
  nodeId: string;
  clock?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  refreshToken?: () => Promise<string | undefined>;
  onConnection?: (state: ConnectionState) => void;
  onTerminalDisconnect?: (state: 'offline' | 'auth_error') => void;
  onMessage?: (message: NormalizedRongCloudMessage) => void | Promise<void>;
}

export interface RongCloudClientInit {
  appKey: string;
  token: string;
}

export interface RongCloudSendInput {
  conversationType: RongCloudConversationType;
  targetId: string;
  messageType: 'text' | 'command' | 'command_result' | 'card_message' | 'card_update' | 'card_action' | 'chatroom_invite';
  content: string | Record<string, unknown>;
}

export interface RongCloudOperationOptions {
  signal?: AbortSignal;
}

type ClientErrorCode = WorkerErrorCode | 'disposed';

export class RongCloudClientError extends Error {
  readonly code: ClientErrorCode;

  constructor(code: ClientErrorCode) {
    super(code);
    this.name = 'RongCloudClientError';
    this.code = code;
  }

  toJSON(): { name: string; code: ClientErrorCode } {
    return { name: this.name, code: this.code };
  }
}

function failure(code: ClientErrorCode): RongCloudClientError {
  return new RongCloudClientError(code);
}

function isClientError(value: unknown): value is RongCloudClientError {
  return value instanceof RongCloudClientError;
}

function isSuccess(value: unknown): value is RongCloudSdkResult {
  return resultCode(value) === 0 || resultCode(value) === 200;
}

function resultCode(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value === null || typeof value !== 'object' || isProxy(value)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, 'code');
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
      && typeof descriptor.value === 'number' && Number.isFinite(descriptor.value)
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function dataField(value: unknown, key: 'messageUId' | 'messageId'): unknown {
  if (value === null || typeof value !== 'object' || isProxy(value)) return undefined;
  try {
    const dataDescriptor = Object.getOwnPropertyDescriptor(value, 'data');
    const data = dataDescriptor && Object.prototype.hasOwnProperty.call(dataDescriptor, 'value')
      ? dataDescriptor.value
      : undefined;
    if (data === null || typeof data !== 'object' || isProxy(data)) return undefined;
    const field = Object.getOwnPropertyDescriptor(data, key);
    return field && Object.prototype.hasOwnProperty.call(field, 'value') ? field.value : undefined;
  } catch {
    return undefined;
  }
}

function boundedMessageUid(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length >= 1 && normalized.length <= 256 && !/[\p{Cc}\p{Cf}]/u.test(normalized)
    ? normalized
    : undefined;
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(failure('cancelled'));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

interface QueueEntry<T> {
  task: () => Promise<T>;
  signal?: AbortSignal;
  started: boolean;
  settled: boolean;
  waitController?: AbortController;
  resolve(value: T): void;
  reject(error: unknown): void;
  cancel(code: ClientErrorCode): void;
  abort?: () => void;
}

class SlidingWindowQueue {
  readonly #clock: () => number;
  readonly #sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly #queue: QueueEntry<unknown>[] = [];
  readonly #active = new Set<QueueEntry<unknown>>();
  readonly #attempts: number[] = [];
  #draining = false;

  constructor(options: Pick<RongCloudClientOptions, 'clock' | 'sleep'>) {
    this.#clock = options.clock ?? Date.now;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  enqueue<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(failure('cancelled'));
    return new Promise<T>((resolve, reject) => {
      const entry = {
        task,
        signal,
        started: false,
        settled: false,
        resolve,
        reject,
        cancel: (code: ClientErrorCode) => {
          if (entry.settled) return;
          entry.settled = true;
          const index = this.#queue.indexOf(entry as QueueEntry<unknown>);
          if (index >= 0) this.#queue.splice(index, 1);
          entry.waitController?.abort();
          this.#removeAbort(entry);
          reject(failure(code));
        },
      } as QueueEntry<T>;
      if (signal) {
        entry.abort = () => entry.cancel('cancelled');
        signal.addEventListener('abort', entry.abort, { once: true });
      }
      this.#queue.push(entry as QueueEntry<unknown>);
      void this.#drain();
    });
  }

  cancelAll(code: ClientErrorCode): void {
    for (const entry of [...this.#queue, ...this.#active]) entry.cancel(code);
  }

  async #drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (this.#queue.length > 0) {
        const entry = this.#queue[0]!;
        if (entry.settled) {
          this.#queue.shift();
          continue;
        }
        const wait = this.#waitMilliseconds();
        if (wait > 0) {
          const controller = new AbortController();
          entry.waitController = controller;
          try {
            await this.#sleep(wait, controller.signal);
          } catch {
            if (!entry.settled) entry.cancel('timer_failed');
          } finally {
            if (entry.waitController === controller) entry.waitController = undefined;
          }
          continue;
        }

        this.#queue.shift();
        entry.started = true;
        this.#active.add(entry);
        this.#attempts.push(this.#clock());
        let task: Promise<unknown>;
        try {
          task = entry.task();
        } catch (error) {
          if (!entry.settled) {
            entry.settled = true;
            entry.reject(error);
          }
          this.#active.delete(entry);
          this.#removeAbort(entry);
          continue;
        }
        void task.then(
          (value) => {
            if (!entry.settled) {
              entry.settled = true;
              entry.resolve(value);
            }
          },
          (error: unknown) => {
            if (!entry.settled) {
              entry.settled = true;
              entry.reject(error);
            }
          },
        ).finally(() => {
          this.#active.delete(entry);
          this.#removeAbort(entry);
        });
      }
    } finally {
      this.#draining = false;
      if (this.#queue.length > 0) void this.#drain();
    }
  }

  #waitMilliseconds(): number {
    const now = this.#clock();
    while (this.#attempts.length > 0 && now - this.#attempts[0]! >= 1_000) this.#attempts.shift();
    return this.#attempts.length < 5
      ? 0
      : Math.max(1, 1_000 - (now - this.#attempts[0]!));
  }

  #removeAbort<T>(entry: QueueEntry<T>): void {
    if (entry.signal && entry.abort) entry.signal.removeEventListener('abort', entry.abort);
  }
}

const registrations = [
  ['command', false, false],
  ['command_result', false, false],
  ['card_message', true, true],
  ['card_update', true, true],
  ['card_action', false, false],
  ['chatroom_invite', true, false],
] as const;

const authenticationCodes = new Set([1002, 31004, 31020, 31029]);
const sentUidLimit = 2_048;
const inboundMessageLimit = 1_024;

export class RongCloudClient {
  readonly #sdk: RongCloudSdkFacade;
  readonly #nodeId: string;
  readonly #refreshToken?: () => Promise<string | undefined>;
  readonly #onConnection?: (state: ConnectionState) => void;
  readonly #onTerminalDisconnect?: (state: 'offline' | 'auth_error') => void;
  readonly #onMessage?: (message: NormalizedRongCloudMessage) => void | Promise<void>;
  readonly #queue: SlidingWindowQueue;
  readonly #constructors = new Map<string, MessageConstructor>();
  readonly #listeners = new Map<string, (event: unknown) => void>();
  readonly #joinedChatrooms = new Set<string>();
  readonly #sentUids = new Set<string>();
  #token?: string;
  #initialized = false;
  #connected = false;
  #desiredConnected = false;
  #connectedEventAllowed = false;
  #disposed = false;
  #generation = 0;
  #connectAttempt?: Promise<void>;
  #disconnectAttempt?: Promise<void>;
  #disposeAttempt?: Promise<void>;

  constructor(options: RongCloudClientOptions) {
    this.#sdk = options.sdk;
    this.#nodeId = options.nodeId;
    this.#refreshToken = options.refreshToken;
    this.#onConnection = options.onConnection;
    this.#onTerminalDisconnect = options.onTerminalDisconnect;
    this.#onMessage = options.onMessage;
    this.#queue = new SlidingWindowQueue(options);
  }

  init(input: RongCloudClientInit): void {
    if (this.#disposed) throw failure('disposed');
    if (this.#initialized) throw failure('already_initialized');
    if (!input.appKey || !input.token) throw failure('invalid_request');
    try {
      this.#sdk.init({ appkey: input.appKey });
      for (const [name, isPersisted, isCounted] of registrations) {
        this.#constructors.set(name, this.#sdk.registerMessageType(name, isPersisted, isCounted));
      }
      this.#listen(this.#sdk.Events?.CONNECTING ?? 'CONNECTING', () => {
        if (!this.#desiredConnected) return;
        this.#suspendConnection(false);
        this.#emitConnection('connecting');
      });
      this.#listen(this.#sdk.Events?.CONNECTED ?? 'CONNECTED', () => {
        if (this.#connectedEventAllowed) this.#markOnline();
      });
      this.#listen(this.#sdk.Events?.SUSPEND ?? 'SUSPEND', () => {
        if (this.#desiredConnected) this.#suspendConnection(true);
      });
      this.#listen(this.#sdk.Events?.DISCONNECT ?? 'DISCONNECT', (event) => {
        if (!this.#desiredConnected && !this.#connected) return;
        const state = authenticationCodes.has(resultCode(event) ?? Number.NaN)
          ? 'auth_error'
          : 'offline';
        this.#invalidateConnection(state);
        this.#emitTerminalDisconnect(state);
      });
      this.#listen(this.#sdk.Events?.MESSAGES ?? 'MESSAGES', (event) => this.#receive(event));
    } catch {
      this.#constructors.clear();
      this.#removeListeners();
      throw failure('internal_error');
    }
    this.#token = input.token;
    this.#initialized = true;
  }

  connect(): Promise<void> {
    if (this.#disposed) return Promise.reject(failure('disposed'));
    if (!this.#initialized || this.#token === undefined) return Promise.reject(failure('not_initialized'));
    if (this.#desiredConnected) {
      if (this.#connected) return Promise.resolve();
      if (this.#connectAttempt) return this.#connectAttempt;
    }

    const priorConnect = this.#connectAttempt;
    const priorDisconnect = this.#disconnectAttempt;
    this.#desiredConnected = true;
    this.#connectedEventAllowed = false;
    const generation = ++this.#generation;
    const attempt = this.#runConnect(generation, priorConnect, priorDisconnect);
    this.#connectAttempt = attempt;
    void attempt.then(
      () => { if (this.#connectAttempt === attempt) this.#connectAttempt = undefined; },
      () => { if (this.#connectAttempt === attempt) this.#connectAttempt = undefined; },
    );
    return attempt;
  }

  async #runConnect(
    generation: number,
    priorConnect?: Promise<void>,
    priorDisconnect?: Promise<void>,
  ): Promise<void> {
    await Promise.allSettled([priorConnect, priorDisconnect].filter(
      (attempt): attempt is Promise<void> => attempt !== undefined,
    ));
    this.#assertCurrent(generation);
    let result: RongCloudSdkResult;
    try {
      result = await this.#sdk.connect(this.#token!);
    } catch (error) {
      if (!this.#isCurrent(generation)) throw failure('disconnected');
      const code = resultCode(error);
      if (code === undefined || !authenticationCodes.has(code)) {
        this.#desiredConnected = false;
        throw failure('connect_failed');
      }
      result = { code };
    }
    await this.#assertConnectedAttempt(generation);

    const firstCode = resultCode(result);
    if (!isSuccess(result) && firstCode !== undefined && authenticationCodes.has(firstCode) && this.#refreshToken) {
      let refreshed: string | undefined;
      try {
        refreshed = await this.#refreshToken();
      } catch {
        refreshed = undefined;
      }
      this.#assertCurrent(generation);
      if (typeof refreshed === 'string' && refreshed.length > 0 && refreshed.length <= 16_384) {
        this.#token = refreshed;
        try {
          result = await this.#sdk.connect(refreshed);
        } catch {
          this.#assertCurrent(generation);
          this.#desiredConnected = false;
          throw failure('authentication_failed');
        }
        await this.#assertConnectedAttempt(generation);
      }
    }

    if (!isSuccess(result)) {
      this.#desiredConnected = false;
      throw failure(authenticationCodes.has(resultCode(result) ?? Number.NaN)
        ? 'authentication_failed'
        : 'connect_failed');
    }
    this.#assertCurrent(generation);
    this.#connectedEventAllowed = true;
    this.#markOnline();
  }

  disconnect(): Promise<void> {
    const wasActive = this.#desiredConnected || this.#connected || this.#connectAttempt !== undefined;
    if (this.#disconnectAttempt && !wasActive) return this.#disconnectAttempt;
    this.#desiredConnected = false;
    this.#connected = false;
    this.#connectedEventAllowed = false;
    this.#generation += 1;
    this.#queue.cancelAll('disconnected');
    this.#joinedChatrooms.clear();
    this.#sentUids.clear();
    if (wasActive) this.#emitConnection('offline');
    const attempt = (async () => {
      if (!this.#initialized) return;
      try {
        await this.#sdk.disconnect();
      } catch {
        throw failure('disconnected');
      }
    })();
    this.#disconnectAttempt = attempt;
    void attempt.then(
      () => { if (this.#disconnectAttempt === attempt) this.#disconnectAttempt = undefined; },
      () => { if (this.#disconnectAttempt === attempt) this.#disconnectAttempt = undefined; },
    );
    return attempt;
  }

  dispose(): Promise<void> {
    if (this.#disposeAttempt) return this.#disposeAttempt;
    this.#disposed = true;
    const attempt = (async () => {
      let disposeError: RongCloudClientError | undefined;
      try {
        await this.disconnect();
      } catch {
        disposeError = failure('disconnected');
      }
      this.#removeListeners();
      try {
        await this.#sdk.destroy?.();
      } catch {
        disposeError ??= failure('internal_error');
      }
      this.#constructors.clear();
      this.#joinedChatrooms.clear();
      this.#sentUids.clear();
      this.#token = undefined;
      if (disposeError) throw disposeError;
    })();
    this.#disposeAttempt = attempt;
    return attempt;
  }

  send(input: RongCloudSendInput, options: RongCloudOperationOptions = {}): Promise<string | undefined> {
    if (!this.#connected) return Promise.reject(failure('not_connected'));
    if (options.signal?.aborted) return Promise.reject(failure('cancelled'));
    let message: unknown;
    try {
      if (input.messageType === 'text') {
        if (typeof input.content !== 'string' || !this.#sdk.TextMessage) {
          return Promise.reject(failure('invalid_request'));
        }
        message = new this.#sdk.TextMessage({ content: input.content });
      } else {
        if (input.content === null || typeof input.content !== 'object' || Array.isArray(input.content)) {
          return Promise.reject(failure('invalid_request'));
        }
        const Constructor = this.#constructors.get(input.messageType);
        if (!Constructor) return Promise.reject(failure('invalid_request'));
        message = new Constructor(input.content);
      }
    } catch {
      return Promise.reject(failure('invalid_request'));
    }

    const generation = this.#generation;
    return this.#queue.enqueue(async () => {
      this.#assertOperation(generation, options.signal);
      let result: RongCloudSdkResult;
      try {
        result = await this.#sdk.sendMessage(
          { conversationType: input.conversationType, targetId: input.targetId },
          message,
          { needReceipt: true },
        );
      } catch {
        this.#assertOperation(generation, options.signal);
        throw failure('send_failed');
      }
      this.#assertOperation(generation, options.signal);
      if (!isSuccess(result)) throw failure('send_failed');

      const uid = boundedMessageUid(dataField(result, 'messageUId'));
      const cardRequiresUid = input.messageType === 'card_message' || input.messageType === 'card_update';
      if (cardRequiresUid && uid === undefined) throw failure('missing_message_uid');
      if (uid !== undefined) {
        if (cardRequiresUid && this.#sentUids.has(uid)) throw failure('duplicate_message_uid');
        this.#rememberUid(uid);
        return uid;
      }
      const fallbackId = dataField(result, 'messageId');
      return typeof fallbackId === 'string' || typeof fallbackId === 'number'
        ? String(fallbackId)
        : undefined;
    }, options.signal).catch((error: unknown) => {
      if (isClientError(error)) throw error;
      throw failure('send_failed');
    });
  }

  async sendReceipt(
    message: NormalizedRongCloudMessage | undefined,
    options: RongCloudOperationOptions = {},
  ): Promise<void> {
    if (!this.#needsReceipt(message)) return;
    if (!this.#connected) throw failure('not_connected');
    const generation = this.#generation;
    const uid = message.messageUid.trim();
    const attempts: Array<() => Promise<RongCloudSdkResult>> = [];
    if (this.#sdk.sendReadReceiptResponseV5) {
      attempts.push(() => this.#sdk.sendReadReceiptResponseV5!(
        { conversationType: message.conversationType, targetId: message.targetId },
        [uid],
      ));
    }
    if (message.conversationType === 3) {
      if (this.#sdk.sendReadReceiptResponseV2) {
        attempts.push(() => this.#sdk.sendReadReceiptResponseV2!(
          message.targetId,
          { [message.senderId]: [uid] },
        ));
      }
      if (this.#sdk.sendReadReceiptResponse) {
        attempts.push(() => this.#sdk.sendReadReceiptResponse!(message.targetId, [uid]));
      }
    } else if (message.conversationType === 1 && this.#sdk.sendReadReceiptMessage) {
      attempts.push(() => this.#sdk.sendReadReceiptMessage!(
        message.targetId,
        uid,
        message.sentTime ?? 0,
      ));
    }

    for (const attempt of attempts) {
      try {
        const result = await this.#queue.enqueue(async () => {
          this.#assertOperation(generation, options.signal);
          const response = await attempt();
          this.#assertOperation(generation, options.signal);
          return response;
        }, options.signal);
        if (isSuccess(result)) return;
      } catch (error) {
        if (isClientError(error)) throw error;
        this.#assertOperation(generation, options.signal);
      }
    }
    throw failure('receipt_failed');
  }

  async joinChatroom(roomId: string, historyCount: number): Promise<void> {
    if (!this.#connected) throw failure('not_connected');
    if (!roomId.trim() || roomId.length > 256 || !Number.isInteger(historyCount)
      || historyCount < -1 || historyCount > 50) throw failure('invalid_request');
    const normalizedRoomId = roomId.trim();
    if (this.#joinedChatrooms.has(normalizedRoomId)) return;
    const generation = this.#generation;
    let result: RongCloudSdkResult;
    try {
      if (!this.#sdk.joinExistChatRoom) throw failure('chatroom_failed');
      result = await this.#sdk.joinExistChatRoom(normalizedRoomId, { count: historyCount });
    } catch (error) {
      this.#assertOperation(generation);
      if (resultCode(error) !== 23410) throw failure('chatroom_failed');
      result = { code: 23410 };
    }
    this.#assertOperation(generation);
    if (resultCode(result) === 23410) {
      if (!this.#sdk.joinChatRoom) throw failure('chatroom_failed');
      try {
        result = await this.#sdk.joinChatRoom(normalizedRoomId, { count: historyCount });
      } catch {
        this.#assertOperation(generation);
        throw failure('chatroom_failed');
      }
      this.#assertOperation(generation);
    }
    if (!isSuccess(result)) throw failure('chatroom_failed');
    this.#joinedChatrooms.add(normalizedRoomId);
  }

  #listen(name: string, listener: (event: unknown) => void): void {
    this.#listeners.set(name, listener);
    this.#sdk.addEventListener(name, listener);
  }

  #removeListeners(): void {
    if (this.#sdk.removeEventListener) {
      for (const [name, listener] of this.#listeners) this.#sdk.removeEventListener(name, listener);
    }
    this.#listeners.clear();
  }

  #receive(event: unknown): void {
    if (!this.#connected || !this.#desiredConnected || this.#disposed
      || event === null || typeof event !== 'object' || isProxy(event)) return;
    let messages: unknown;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(event, 'messages');
      messages = descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
        ? descriptor.value
        : undefined;
    } catch {
      return;
    }
    if (isProxy(messages) || !Array.isArray(messages)) return;
    let length: number | undefined;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(messages, 'length');
      const value = descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
        ? descriptor.value
        : undefined;
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) length = value;
    } catch {
      return;
    }
    if (length === undefined || length > inboundMessageLimit) return;
    const snapshot: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      try {
        const descriptor = Object.getOwnPropertyDescriptor(messages, String(index));
        if (descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
          snapshot.push(descriptor.value);
        }
      } catch {
        // One hostile index cannot block safe sibling descriptors.
      }
    }
    for (const raw of snapshot) {
      let normalized: ReturnType<typeof normalizeRongCloudMessage>;
      try {
        normalized = normalizeRongCloudMessage(raw);
      } catch {
        continue;
      }
      if (!normalized.ok || !this.#onMessage) continue;
      try {
        void Promise.resolve(this.#onMessage(normalized.value)).catch(() => undefined);
      } catch {
        // A rejected consumer must not block sibling deliveries.
      }
    }
  }

  #needsReceipt(message: NormalizedRongCloudMessage | undefined): message is NormalizedRongCloudMessage {
    if (!message || !message.messageUid.trim()) return false;
    if (message.direction === 1 || message.direction === 'SEND') return false;
    if (message.senderId === this.#nodeId || this.#sentUids.has(message.messageUid.trim())) return false;
    return true;
  }

  #rememberUid(uid: string): void {
    this.#sentUids.delete(uid);
    this.#sentUids.add(uid);
    while (this.#sentUids.size > sentUidLimit) {
      const oldest = this.#sentUids.values().next().value;
      if (oldest === undefined) break;
      this.#sentUids.delete(oldest);
    }
  }

  #isCurrent(generation: number): boolean {
    return this.#desiredConnected && generation === this.#generation && !this.#disposed;
  }

  #assertCurrent(generation: number): void {
    if (!this.#isCurrent(generation)) throw failure('disconnected');
  }

  async #assertConnectedAttempt(generation: number): Promise<void> {
    if (this.#isCurrent(generation)) return;
    try {
      await this.#sdk.disconnect();
    } catch {
      // A stale physical connection remains logically fenced even if cleanup fails.
    }
    throw failure('disconnected');
  }

  #assertOperation(generation: number, signal?: AbortSignal): void {
    if (signal?.aborted) throw failure('cancelled');
    if (!this.#connected || generation !== this.#generation || this.#disposed) {
      throw failure('disconnected');
    }
  }

  #invalidateConnection(state: 'offline' | 'auth_error'): void {
    this.#desiredConnected = false;
    this.#connected = false;
    this.#connectedEventAllowed = false;
    this.#generation += 1;
    this.#queue.cancelAll('disconnected');
    this.#joinedChatrooms.clear();
    this.#sentUids.clear();
    this.#emitConnection(state);
  }

  #suspendConnection(emitOffline: boolean): void {
    if (!this.#connected) return;
    this.#connected = false;
    this.#generation += 1;
    this.#queue.cancelAll('disconnected');
    this.#joinedChatrooms.clear();
    this.#sentUids.clear();
    if (emitOffline) this.#emitConnection('offline');
  }

  #markOnline(): void {
    if (!this.#desiredConnected || this.#disposed || this.#connected) return;
    this.#connected = true;
    this.#emitConnection('online');
  }

  #emitTerminalDisconnect(state: 'offline' | 'auth_error'): void {
    try {
      this.#onTerminalDisconnect?.(state);
    } catch {
      // Terminal observers cannot alter the SDK lifecycle.
    }
  }

  #emitConnection(state: ConnectionState): void {
    try {
      this.#onConnection?.(state);
    } catch {
      // Connection observers are isolated from the SDK lifecycle.
    }
  }
}
