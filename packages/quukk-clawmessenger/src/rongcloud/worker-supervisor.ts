import { fork, type ForkOptions } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseWorkerCommand,
  parseWorkerEvent,
  type WorkerCommand,
  type WorkerErrorCode,
  type WorkerEvent,
} from './worker-protocol.js';

export const SUPERVISOR_REQUEST_TIMEOUT_MS = 30_000;
export const SUPERVISOR_MAX_PENDING_REQUESTS = 128;
export const SUPERVISOR_MAX_BUFFERED_COMMANDS = 32;
export const SUPERVISOR_RESTART_BASE_MS = 250;
export const SUPERVISOR_RESTART_MAX_MS = 30_000;
export const SUPERVISOR_STABLE_WINDOW_MS = 60_000;

export interface WorkerIdentity {
  runtimeId: string;
  nodeId: string;
}

export interface SupervisorBinding extends WorkerIdentity {
  enabled: boolean;
  tokenRef: string;
  storageDir: string;
}

export interface SupervisorCredential {
  appKey: string;
  token: string;
}

export type SupervisorState = 'starting' | 'online' | 'offline' | 'backoff' | 'stopped';

export interface WorkerSnapshot extends WorkerIdentity {
  state: SupervisorState;
  instanceId: string | null;
  restartCount: number;
}

export interface WorkerChild {
  readonly pid?: number;
  readonly connected?: boolean;
  send(message: unknown): boolean | void;
  kill(signal?: NodeJS.Signals | number): boolean;
  disconnect?(): void;
  on(event: 'message' | 'exit' | 'error' | 'disconnect', listener: (...values: unknown[]) => void): unknown;
  off?(event: 'message' | 'exit' | 'error' | 'disconnect', listener: (...values: unknown[]) => void): unknown;
  removeListener?(
    event: 'message' | 'exit' | 'error' | 'disconnect',
    listener: (...values: unknown[]) => void,
  ): unknown;
}

export interface WorkerSpawnOptions {
  shell: false;
  windowsHide: true;
  stdio: ['ignore', 'ignore', 'ignore', 'ipc'];
  execArgv: [];
  env: NodeJS.ProcessEnv;
  serialization: 'json';
}

export interface RongCloudWorkerSupervisorOptions {
  workerEntryPath?: string;
  spawnChild?: (
    modulePath: string,
    args: readonly string[],
    options: WorkerSpawnOptions,
  ) => WorkerChild;
  processEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  resolveCredential(binding: SupervisorBinding): Promise<SupervisorCredential>;
  refreshCredential(binding: SupervisorBinding): Promise<string>;
  onEvent?: (identity: WorkerIdentity, event: WorkerEvent) => void;
  now?: () => number;
  setTimeout?: (callback: () => void, milliseconds: number) => unknown;
  clearTimeout?: (timer: unknown) => void;
  requestTimeoutMs?: number;
  restartBaseMs?: number;
  restartMaxMs?: number;
  stableWindowMs?: number;
  maxPendingRequests?: number;
  maxBufferedCommands?: number;
}

export class RongCloudSupervisorError extends Error {
  readonly code: WorkerErrorCode;

  constructor(code: WorkerErrorCode) {
    super(code);
    this.name = 'RongCloudSupervisorError';
    this.code = code;
  }

  toJSON(): { name: string; code: WorkerErrorCode } {
    return { name: this.name, code: this.code };
  }
}

type RequestCommand = Exclude<WorkerCommand, { type: 'init' | 'refresh_result' }>;

interface PendingRequest {
  command: RequestCommand;
  timer: unknown;
  buffered: boolean;
  resolve(value: string | undefined): void;
  reject(error: RongCloudSupervisorError): void;
}

interface WorkerListeners {
  message: (...values: unknown[]) => void;
  exit: (...values: unknown[]) => void;
  error: (...values: unknown[]) => void;
  disconnect: (...values: unknown[]) => void;
}

interface WorkerRecord {
  readonly key: string;
  binding: SupervisorBinding;
  desired: boolean;
  generation: number;
  failedGeneration?: number;
  child?: WorkerChild;
  listeners?: WorkerListeners;
  state: SupervisorState;
  instanceId: string | null;
  readySeen: boolean;
  routable: boolean;
  onlineAt?: number;
  restartCount: number;
  restartTimer?: unknown;
  stableTimer?: unknown;
  pending: Map<string, PendingRequest>;
  buffer: PendingRequest[];
  refreshRequestId?: string;
}

type TimerSchedule = { ok: true; timer: unknown } | { ok: false };

const defaultWorkerEntryPath = fileURLToPath(new URL('./worker-entry.js', import.meta.url));
const windowsEnvKeys = ['SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP'] as const;
const posixEnvKeys = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TEMP', 'TMP', 'TZ'] as const;

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, maximum)
    : fallback;
}

function copyBinding(binding: SupervisorBinding): SupervisorBinding {
  return {
    runtimeId: binding.runtimeId,
    nodeId: binding.nodeId,
    enabled: binding.enabled,
    tokenRef: binding.tokenRef,
    storageDir: binding.storageDir,
  };
}

function failure(code: WorkerErrorCode): RongCloudSupervisorError {
  return new RongCloudSupervisorError(code);
}

function removeListener(
  child: WorkerChild,
  event: 'message' | 'exit' | 'error' | 'disconnect',
  listener: (...values: unknown[]) => void,
): void {
  try {
    if (child.off) child.off(event, listener);
    else child.removeListener?.(event, listener);
  } catch {
    // A broken child cannot prevent parent-side cleanup.
  }
}

function productionSpawn(
  modulePath: string,
  args: readonly string[],
  options: WorkerSpawnOptions,
): WorkerChild {
  return fork(modulePath, [...args], options as ForkOptions) as unknown as WorkerChild;
}

export function workerBindingKey(identity: WorkerIdentity): string {
  const runtimeId = String(identity.runtimeId);
  const nodeId = String(identity.nodeId);
  return `${runtimeId.length}:${runtimeId}${nodeId.length}:${nodeId}`;
}

export function buildMinimalWorkerEnv(
  source: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  if (platform === 'win32') {
    const entries = Object.entries(source);
    for (const canonical of windowsEnvKeys) {
      const found = entries.find(([key, value]) => key.toLowerCase() === canonical.toLowerCase()
        && typeof value === 'string');
      if (found?.[1] !== undefined) result[canonical] = found[1];
    }
    return result;
  }
  for (const key of posixEnvKeys) {
    const value = source[key];
    if (typeof value === 'string') result[key] = value;
  }
  return result;
}

export class RongCloudWorkerSupervisor {
  readonly #workerEntryPath: string;
  readonly #spawnChild: NonNullable<RongCloudWorkerSupervisorOptions['spawnChild']>;
  readonly #workerEnv: NodeJS.ProcessEnv;
  readonly #resolveCredential: RongCloudWorkerSupervisorOptions['resolveCredential'];
  readonly #refreshCredential: RongCloudWorkerSupervisorOptions['refreshCredential'];
  readonly #onEvent?: RongCloudWorkerSupervisorOptions['onEvent'];
  readonly #now: () => number;
  readonly #setTimeout: (callback: () => void, milliseconds: number) => unknown;
  readonly #clearTimeout: (timer: unknown) => void;
  readonly #requestTimeoutMs: number;
  readonly #restartBaseMs: number;
  readonly #restartMaxMs: number;
  readonly #stableWindowMs: number;
  readonly #maxPendingRequests: number;
  readonly #maxBufferedCommands: number;
  readonly #records = new Map<string, WorkerRecord>();
  #requestSequence = 0;
  #disposed = false;

  constructor(options: RongCloudWorkerSupervisorOptions) {
    this.#workerEntryPath = options.workerEntryPath ?? defaultWorkerEntryPath;
    if (!isAbsolute(this.#workerEntryPath)) throw failure('invalid_request');
    this.#spawnChild = options.spawnChild ?? productionSpawn;
    this.#workerEnv = buildMinimalWorkerEnv(options.processEnv ?? process.env, options.platform);
    this.#resolveCredential = options.resolveCredential;
    this.#refreshCredential = options.refreshCredential;
    this.#onEvent = options.onEvent;
    this.#now = options.now ?? Date.now;
    this.#setTimeout = options.setTimeout ?? ((callback, milliseconds) => setTimeout(callback, milliseconds));
    const clearTimer = options.clearTimeout
      ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    this.#clearTimeout = (timer) => {
      try {
        clearTimer(timer);
      } catch {
        // Timer cleanup is best-effort and must not expose injected errors.
      }
    };
    this.#requestTimeoutMs = boundedInteger(
      options.requestTimeoutMs,
      SUPERVISOR_REQUEST_TIMEOUT_MS,
      5 * 60_000,
    );
    this.#restartBaseMs = boundedInteger(options.restartBaseMs, SUPERVISOR_RESTART_BASE_MS, 60_000);
    this.#restartMaxMs = Math.max(
      this.#restartBaseMs,
      boundedInteger(options.restartMaxMs, SUPERVISOR_RESTART_MAX_MS, 5 * 60_000),
    );
    this.#stableWindowMs = boundedInteger(
      options.stableWindowMs,
      SUPERVISOR_STABLE_WINDOW_MS,
      10 * 60_000,
    );
    this.#maxPendingRequests = boundedInteger(
      options.maxPendingRequests,
      SUPERVISOR_MAX_PENDING_REQUESTS,
      4_096,
    );
    this.#maxBufferedCommands = Math.min(
      this.#maxPendingRequests,
      boundedInteger(options.maxBufferedCommands, SUPERVISOR_MAX_BUFFERED_COMMANDS, 1_024),
    );
  }

  async reconcile(bindings: readonly SupervisorBinding[]): Promise<void> {
    if (this.#disposed) throw failure('worker_exited');
    const desired = new Map<string, SupervisorBinding>();
    for (const source of bindings) {
      if (!source.enabled) continue;
      const binding = copyBinding(source);
      const key = workerBindingKey(binding);
      desired.set(key, binding);
    }

    for (const [key, record] of [...this.#records]) {
      if (!desired.has(key)) this.#removeRecord(record);
    }

    const starts: Promise<void>[] = [];
    for (const [key, binding] of desired) {
      const existing = this.#records.get(key);
      if (!existing) {
        const record: WorkerRecord = {
          key,
          binding,
          desired: true,
          generation: 0,
          state: 'starting',
          instanceId: null,
          readySeen: false,
          routable: false,
          restartCount: 0,
          pending: new Map(),
          buffer: [],
        };
        this.#records.set(key, record);
        starts.push(this.#spawn(record));
        continue;
      }

      const credentialsChanged = existing.binding.tokenRef !== binding.tokenRef
        || existing.binding.storageDir !== binding.storageDir;
      existing.binding = binding;
      existing.desired = true;
      if (credentialsChanged || existing.state === 'stopped') {
        starts.push(this.#restartRecord(existing));
      } else if (!existing.child && existing.restartTimer === undefined) {
        starts.push(this.#spawn(existing));
      }
    }
    await Promise.all(starts);
  }

  send(identity: WorkerIdentity, input: Record<string, unknown>): Promise<string | undefined> {
    return this.#request(identity, {
      ...input,
      type: 'send',
      requestId: this.#nextRequestId(),
    });
  }

  receipt(identity: WorkerIdentity, input: Record<string, unknown>): Promise<void> {
    return this.#request(identity, {
      ...input,
      type: 'receipt',
      requestId: this.#nextRequestId(),
    }).then(() => undefined);
  }

  joinChatroom(
    identity: WorkerIdentity,
    input: { roomId: string; historyCount: number },
  ): Promise<void> {
    return this.#request(identity, {
      type: 'join_chatroom',
      requestId: this.#nextRequestId(),
      roomId: input.roomId,
      historyCount: input.historyCount,
    }).then(() => undefined);
  }

  async stop(identity: WorkerIdentity): Promise<void> {
    const record = this.#record(identity);
    if (!record) return;
    record.desired = false;
    this.#cancelLifecycleTimers(record);
    this.#rejectPending(record, 'worker_exited');
    this.#terminate(record);
    record.state = 'stopped';
    record.instanceId = null;
    record.readySeen = false;
    record.routable = false;
  }

  async restart(identity: WorkerIdentity): Promise<void> {
    if (this.#disposed) throw failure('worker_exited');
    const record = this.#record(identity);
    if (!record) throw failure('not_initialized');
    record.desired = true;
    await this.#restartRecord(record);
  }

  snapshots(): readonly WorkerSnapshot[] {
    return [...this.#records.values()]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((record) => ({
        runtimeId: record.binding.runtimeId,
        nodeId: record.binding.nodeId,
        state: record.state,
        instanceId: record.instanceId,
        restartCount: record.restartCount,
      }));
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const record of this.#records.values()) {
      record.desired = false;
      this.#cancelLifecycleTimers(record);
      this.#rejectPending(record, 'worker_exited');
      this.#terminate(record);
    }
    this.#records.clear();
  }

  #record(identity: WorkerIdentity): WorkerRecord | undefined {
    return this.#records.get(workerBindingKey(identity));
  }

  async #restartRecord(record: WorkerRecord): Promise<void> {
    this.#cancelLifecycleTimers(record);
    this.#rejectPending(record, 'worker_exited');
    this.#terminate(record);
    record.restartCount = 0;
    record.failedGeneration = undefined;
    record.state = 'starting';
    record.instanceId = null;
    record.readySeen = false;
    record.routable = false;
    await this.#spawn(record);
  }

  async #spawn(record: WorkerRecord): Promise<void> {
    if (this.#disposed || !record.desired || this.#records.get(record.key) !== record) return;
    const generation = ++record.generation;
    record.failedGeneration = undefined;
    record.state = 'starting';
    record.instanceId = null;
    record.readySeen = false;
    record.routable = false;
    record.refreshRequestId = undefined;
    let child: WorkerChild;
    try {
      child = this.#spawnChild(this.#workerEntryPath, [], {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        execArgv: [],
        env: { ...this.#workerEnv },
        serialization: 'json',
      });
    } catch {
      this.#failRecord(record, generation);
      return;
    }
    record.child = child;
    this.#attach(record, child, generation);

    let credential: SupervisorCredential;
    try {
      credential = await this.#resolveCredential(copyBinding(record.binding));
    } catch {
      this.#failRecord(record, generation);
      return;
    }
    if (!this.#isCurrent(record, child, generation)) return;
    const command = parseWorkerCommand({
      type: 'init',
      binding: {
        runtimeId: record.binding.runtimeId,
        nodeId: record.binding.nodeId,
        appKey: credential.appKey,
        storageDir: record.binding.storageDir,
      },
      token: credential.token,
    });
    if (!command.ok) {
      this.#failRecord(record, generation);
      return;
    }
    try {
      child.send(command.value);
    } catch {
      this.#failRecord(record, generation);
    }
  }

  #attach(record: WorkerRecord, child: WorkerChild, generation: number): void {
    const listeners: WorkerListeners = {
      message: (value) => this.#receive(record, child, generation, value),
      exit: () => this.#failRecord(record, generation),
      error: () => this.#failRecord(record, generation),
      disconnect: () => this.#failRecord(record, generation),
    };
    record.listeners = listeners;
    child.on('message', listeners.message);
    child.on('exit', listeners.exit);
    child.on('error', listeners.error);
    child.on('disconnect', listeners.disconnect);
  }

  #receive(record: WorkerRecord, child: WorkerChild, generation: number, input: unknown): void {
    if (!this.#isCurrent(record, child, generation)) return;
    const parsed = parseWorkerEvent(input);
    if (!parsed.ok) {
      this.#failRecord(record, generation);
      return;
    }
    const event = parsed.value;
    if (event.runtimeId !== record.binding.runtimeId) return;

    if (event.type === 'ready') {
      if (record.readySeen) {
        this.#failRecord(record, generation);
        return;
      }
      record.readySeen = true;
      record.instanceId = event.instanceId;
      this.#emit(record, event);
      return;
    }
    if (!record.readySeen || event.instanceId !== record.instanceId) return;

    switch (event.type) {
      case 'connection':
        this.#connection(record, child, generation, event);
        break;
      case 'message':
        if (record.routable) this.#emit(record, event);
        break;
      case 'result':
        this.#result(record, event);
        break;
      case 'refresh_required':
        this.#refresh(record, child, generation, event);
        break;
    }
  }

  #connection(
    record: WorkerRecord,
    child: WorkerChild,
    generation: number,
    event: Extract<WorkerEvent, { type: 'connection' }>,
  ): void {
    if (event.state === 'online') {
      record.state = 'online';
      record.routable = true;
      record.onlineAt = this.#now();
      if (record.stableTimer !== undefined) this.#clearTimeout(record.stableTimer);
      const scheduled = this.#schedule(() => {
        if (!this.#isCurrent(record, child, generation) || !record.routable
          || record.onlineAt === undefined || this.#now() - record.onlineAt < this.#stableWindowMs) return;
        record.stableTimer = undefined;
        record.restartCount = 0;
      }, this.#stableWindowMs);
      if (!scheduled.ok) {
        record.stableTimer = undefined;
        this.#failRecord(record, generation);
        return;
      }
      record.stableTimer = scheduled.timer;
      this.#flush(record, child, generation);
    } else {
      record.routable = false;
      record.onlineAt = undefined;
      record.state = event.state === 'connecting' ? 'starting' : 'offline';
      if (record.stableTimer !== undefined) this.#clearTimeout(record.stableTimer);
      record.stableTimer = undefined;
    }
    this.#emit(record, event);
  }

  #result(record: WorkerRecord, event: Extract<WorkerEvent, { type: 'result' }>): void {
    const pending = record.pending.get(event.requestId);
    if (!pending) return;
    record.pending.delete(event.requestId);
    this.#removeBuffered(record, pending);
    this.#clearTimeout(pending.timer);
    if (event.ok) pending.resolve(event.messageUid);
    else pending.reject(failure(event.errorCode ?? 'internal_error'));
  }

  #refresh(
    record: WorkerRecord,
    child: WorkerChild,
    generation: number,
    event: Extract<WorkerEvent, { type: 'refresh_required' }>,
  ): void {
    if (record.refreshRequestId !== undefined) {
      if (record.refreshRequestId !== event.requestId) this.#failRecord(record, generation);
      return;
    }
    record.refreshRequestId = event.requestId;
    let refresh: Promise<string>;
    try {
      refresh = this.#refreshCredential(copyBinding(record.binding));
    } catch {
      const command = parseWorkerCommand({
        type: 'refresh_result', requestId: event.requestId, ok: false,
      });
      this.#sendRefreshResult(record, child, generation, event.requestId, command);
      return;
    }
    void refresh.then(
      (token) => {
        if (!this.#isCurrent(record, child, generation)
          || event.instanceId !== record.instanceId) return;
        const command = parseWorkerCommand({
          type: 'refresh_result', requestId: event.requestId, ok: true, token,
        });
        this.#sendRefreshResult(record, child, generation, event.requestId, command);
      },
      () => {
        if (!this.#isCurrent(record, child, generation)
          || event.instanceId !== record.instanceId) return;
        const command = parseWorkerCommand({
          type: 'refresh_result', requestId: event.requestId, ok: false,
        });
        this.#sendRefreshResult(record, child, generation, event.requestId, command);
      },
    );
  }

  #sendRefreshResult(
    record: WorkerRecord,
    child: WorkerChild,
    generation: number,
    requestId: string,
    parsed: ReturnType<typeof parseWorkerCommand>,
  ): void {
    let command: WorkerCommand;
    if (parsed.ok && parsed.value.type === 'refresh_result') {
      command = parsed.value;
    } else {
      const fallback = parseWorkerCommand({ type: 'refresh_result', requestId, ok: false });
      if (!fallback.ok) {
        this.#failRecord(record, generation);
        return;
      }
      command = fallback.value;
    }
    try {
      child.send(command);
    } catch {
      this.#failRecord(record, generation);
    }
  }

  #emit(record: WorkerRecord, event: WorkerEvent): void {
    try {
      this.#onEvent?.(
        { runtimeId: record.binding.runtimeId, nodeId: record.binding.nodeId },
        event,
      );
    } catch {
      // Event consumers are isolated from worker lifecycle state.
    }
  }

  #request(identity: WorkerIdentity, input: unknown): Promise<string | undefined> {
    if (this.#disposed) return Promise.reject(failure('worker_exited'));
    const record = this.#record(identity);
    if (!record || !record.desired || record.state === 'stopped') {
      return Promise.reject(failure('not_connected'));
    }
    if (record.pending.size >= this.#maxPendingRequests) {
      return Promise.reject(failure('queue_full'));
    }
    const parsed = parseWorkerCommand(input);
    if (!parsed.ok || parsed.value.type === 'init' || parsed.value.type === 'refresh_result') {
      return Promise.reject(failure('invalid_request'));
    }
    const command = parsed.value;
    if (!record.routable && record.buffer.length >= this.#maxBufferedCommands) {
      return Promise.reject(failure('queue_full'));
    }

    return new Promise((resolve, reject) => {
      const requestId = command.requestId;
      const pending: PendingRequest = {
        command,
        buffered: !record.routable,
        timer: undefined,
        resolve,
        reject,
      };
      const scheduled = this.#schedule(() => {
        if (record.pending.get(requestId) !== pending) return;
        record.pending.delete(requestId);
        this.#removeBuffered(record, pending);
        pending.reject(failure('timeout'));
      }, this.#requestTimeoutMs);
      if (!scheduled.ok) {
        pending.reject(failure('timer_failed'));
        return;
      }
      pending.timer = scheduled.timer;
      record.pending.set(requestId, pending);
      if (record.routable && record.child) {
        this.#sendPending(record, record.child, record.generation, pending);
      } else {
        record.buffer.push(pending);
      }
    });
  }

  #flush(record: WorkerRecord, child: WorkerChild, generation: number): void {
    const buffered = record.buffer.splice(0);
    for (const pending of buffered) {
      if (record.pending.get(pending.command.requestId) !== pending) continue;
      pending.buffered = false;
      this.#sendPending(record, child, generation, pending);
    }
  }

  #sendPending(
    record: WorkerRecord,
    child: WorkerChild,
    generation: number,
    pending: PendingRequest,
  ): void {
    if (!this.#isCurrent(record, child, generation) || !record.routable) {
      if (!pending.buffered) {
        pending.buffered = true;
        if (!record.buffer.includes(pending)) record.buffer.push(pending);
      }
      return;
    }
    try {
      child.send(pending.command);
    } catch {
      this.#failRecord(record, generation);
    }
  }

  #removeBuffered(record: WorkerRecord, pending: PendingRequest): void {
    const index = record.buffer.indexOf(pending);
    if (index >= 0) record.buffer.splice(index, 1);
    pending.buffered = false;
  }

  #rejectPending(record: WorkerRecord, code: WorkerErrorCode): void {
    for (const pending of record.pending.values()) {
      this.#clearTimeout(pending.timer);
      pending.reject(failure(code));
    }
    record.pending.clear();
    record.buffer.length = 0;
  }

  #failRecord(record: WorkerRecord, generation: number): void {
    if (this.#disposed || this.#records.get(record.key) !== record || !record.desired
      || record.generation !== generation || record.failedGeneration === generation) return;
    record.failedGeneration = generation;
    if (record.stableTimer !== undefined) this.#clearTimeout(record.stableTimer);
    record.stableTimer = undefined;
    this.#rejectPending(record, 'worker_exited');
    this.#terminate(record);
    record.instanceId = null;
    record.readySeen = false;
    record.routable = false;
    record.state = 'backoff';
    record.restartCount += 1;
    const exponent = Math.min(record.restartCount - 1, 30);
    const delay = Math.min(this.#restartMaxMs, this.#restartBaseMs * (2 ** exponent));
    const scheduled = this.#schedule(() => {
      record.restartTimer = undefined;
      if (this.#disposed || !record.desired || this.#records.get(record.key) !== record) return;
      void this.#spawn(record).catch(() => this.#failRecord(record, record.generation));
    }, delay);
    record.restartTimer = scheduled.ok ? scheduled.timer : undefined;
  }

  #terminate(record: WorkerRecord): void {
    const child = record.child;
    if (!child) return;
    this.#detach(record, child);
    record.child = undefined;
    if (child.connected !== false) {
      try {
        child.disconnect?.();
      } catch {
        // Continue to the bounded process termination attempt.
      }
    }
    try {
      child.kill('SIGTERM');
    } catch {
      // The child may already have exited.
    }
  }

  #detach(record: WorkerRecord, child: WorkerChild): void {
    const listeners = record.listeners;
    if (!listeners) return;
    removeListener(child, 'message', listeners.message);
    removeListener(child, 'exit', listeners.exit);
    removeListener(child, 'error', listeners.error);
    removeListener(child, 'disconnect', listeners.disconnect);
    record.listeners = undefined;
  }

  #cancelLifecycleTimers(record: WorkerRecord): void {
    if (record.restartTimer !== undefined) this.#clearTimeout(record.restartTimer);
    if (record.stableTimer !== undefined) this.#clearTimeout(record.stableTimer);
    record.restartTimer = undefined;
    record.stableTimer = undefined;
  }

  #removeRecord(record: WorkerRecord): void {
    record.desired = false;
    this.#cancelLifecycleTimers(record);
    this.#rejectPending(record, 'worker_exited');
    this.#terminate(record);
    this.#records.delete(record.key);
  }

  #isCurrent(record: WorkerRecord, child: WorkerChild, generation: number): boolean {
    return !this.#disposed && record.desired && this.#records.get(record.key) === record
      && record.child === child && record.generation === generation
      && record.failedGeneration !== generation;
  }

  #schedule(callback: () => void, milliseconds: number): TimerSchedule {
    try {
      return { ok: true, timer: this.#setTimeout(callback, milliseconds) };
    } catch {
      return { ok: false };
    }
  }

  #nextRequestId(): string {
    this.#requestSequence = this.#requestSequence >= Number.MAX_SAFE_INTEGER
      ? 1
      : this.#requestSequence + 1;
    return `request_${this.#requestSequence}`;
  }
}
