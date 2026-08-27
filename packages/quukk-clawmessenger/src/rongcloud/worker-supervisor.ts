import { fork, type ForkOptions } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
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
export const SUPERVISOR_TERMINATE_GRACE_MS = 2_000;
export const SUPERVISOR_KILL_GRACE_MS = 1_000;
export const SUPERVISOR_READY_TIMEOUT_MS = 20_000;
export const SUPERVISOR_ONLINE_TIMEOUT_MS = 20_000;
export const SUPERVISOR_CREDENTIAL_TIMEOUT_MS = 15_000;
export const SUPERVISOR_SHUTDOWN_GRACE_MS = 4_000;

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
  readonly exitCode?: number | null;
  readonly signalCode?: NodeJS.Signals | null;
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
  storageRoot: string;
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
  terminateGraceMs?: number;
  killGraceMs?: number;
  readyTimeoutMs?: number;
  onlineTimeoutMs?: number;
  credentialTimeoutMs?: number;
  shutdownGraceMs?: number;
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

type RequestCommand = Exclude<WorkerCommand, { type: 'init' | 'refresh_result' | 'shutdown' }>;

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

interface ChildLifecycle {
  readonly child: WorkerChild;
  readonly generation: number;
  readonly exitPromise: Promise<void>;
  readonly resolveExit: () => void;
  readonly onExit: (...values: unknown[]) => void;
  exited: boolean;
  abandoned: boolean;
  termination?: Promise<boolean>;
  terminationError?: (...values: unknown[]) => void;
}

interface CredentialLookup {
  readonly generation: number;
  promise: Promise<SupervisorCredential>;
  settled: boolean;
  blockedCode?: WorkerErrorCode;
  cancel(): void;
}

interface WorkerRecord {
  readonly key: string;
  binding: SupervisorBinding;
  desired: boolean;
  generation: number;
  failedGeneration?: number;
  child?: WorkerChild;
  lifecycle?: ChildLifecycle;
  listeners?: WorkerListeners;
  state: SupervisorState;
  instanceId: string | null;
  readySeen: boolean;
  routable: boolean;
  onlineAt?: number;
  restartCount: number;
  restartTimer?: unknown;
  stableTimer?: unknown;
  readyTimer?: unknown;
  onlineTimer?: unknown;
  pending: Map<string, PendingRequest>;
  buffer: PendingRequest[];
  refreshRequestId?: string;
  restartAttempt?: Promise<void>;
  spawnAttempt?: Promise<void>;
  spawnGeneration?: number;
  credentialLookup?: CredentialLookup;
  reapBlocked: boolean;
  removeWhenReaped: boolean;
}

type TimerSchedule = { ok: true; timer: unknown } | { ok: false };

const defaultWorkerEntryPath = fileURLToPath(new URL('./worker-entry.js', import.meta.url));
const windowsEnvKeys = ['SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP'] as const;
const posixEnvKeys = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TEMP', 'TMP', 'TZ'] as const;
const runtimeStorageSegment = /^rt_[0-9a-f]{32}$/u;

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

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function assertNoReparseTraversal(input: string): void {
  const root = parse(input).root;
  let current = root;
  for (const segment of input.slice(root.length).split(/[\\/]+/u).filter(Boolean)) {
    current = join(current, segment);
    if (lstatSync(current).isSymbolicLink()) throw failure('invalid_request');
  }
}

function canonicalStorageRoot(input: string): string {
  if (typeof input !== 'string' || !isAbsolute(input) || input.includes('\0')) {
    throw failure('invalid_request');
  }
  const normalized = resolve(input);
  if (samePath(normalized, parse(normalized).root)) throw failure('invalid_request');
  try {
    mkdirSync(normalized, { recursive: true, mode: 0o700 });
    assertNoReparseTraversal(normalized);
    const stat = lstatSync(normalized);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('invalid_request');
    // Windows v1 relies on the protected user-profile root's inherited DACL.
    if (process.platform !== 'win32') chmodSync(normalized, 0o700);
    const canonical = realpathSync.native(normalized);
    if (samePath(canonical, parse(canonical).root)) throw failure('invalid_request');
    if (!samePath(realpathSync.native(normalized), canonical)) throw failure('invalid_request');
    return canonical;
  } catch (error) {
    if (error instanceof RongCloudSupervisorError) throw error;
    throw failure('invalid_request');
  }
}

function confinedStorageDir(
  storageRoot: string,
  configuredStorageRoot: string,
  binding: SupervisorBinding,
): string {
  if (!runtimeStorageSegment.test(binding.runtimeId)
    || typeof binding.storageDir !== 'string'
    || !isAbsolute(binding.storageDir)
    || binding.storageDir.includes('\0')
    || binding.storageDir.split(/[\\/]+/u).includes('..')) {
    throw failure('invalid_request');
  }
  const expected = join(storageRoot, binding.runtimeId);
  const configuredExpected = join(configuredStorageRoot, binding.runtimeId);
  const requested = resolve(binding.storageDir);
  const canonicalChild = samePath(requested, expected) && samePath(dirname(requested), storageRoot);
  const configuredChild = samePath(requested, configuredExpected)
    && samePath(dirname(requested), configuredStorageRoot);
  if (!canonicalChild && !configuredChild) {
    throw failure('invalid_request');
  }
  try {
    mkdirSync(expected, { recursive: true, mode: 0o700 });
    const stat = lstatSync(expected);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('invalid_request');
    if (process.platform !== 'win32') chmodSync(expected, 0o700);
    const canonical = realpathSync.native(expected);
    if (!samePath(canonical, expected) || !samePath(dirname(canonical), storageRoot)) {
      throw failure('invalid_request');
    }
    return canonical;
  } catch (error) {
    if (error instanceof RongCloudSupervisorError) throw error;
    throw failure('invalid_request');
  }
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
  readonly #storageRoot: string;
  readonly #configuredStorageRoot: string;
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
  readonly #terminateGraceMs: number;
  readonly #killGraceMs: number;
  readonly #readyTimeoutMs: number;
  readonly #onlineTimeoutMs: number;
  readonly #credentialTimeoutMs: number;
  readonly #shutdownGraceMs: number;
  readonly #maxPendingRequests: number;
  readonly #maxBufferedCommands: number;
  readonly #records = new Map<string, WorkerRecord>();
  #requestSequence = 0;
  #disposed = false;
  #disposeAttempt?: Promise<void>;

  constructor(options: RongCloudWorkerSupervisorOptions) {
    this.#storageRoot = canonicalStorageRoot(options.storageRoot);
    this.#configuredStorageRoot = resolve(options.storageRoot);
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
    this.#terminateGraceMs = boundedInteger(
      options.terminateGraceMs,
      SUPERVISOR_TERMINATE_GRACE_MS,
      30_000,
    );
    this.#killGraceMs = boundedInteger(options.killGraceMs, SUPERVISOR_KILL_GRACE_MS, 30_000);
    this.#readyTimeoutMs = boundedInteger(
      options.readyTimeoutMs,
      SUPERVISOR_READY_TIMEOUT_MS,
      5 * 60_000,
    );
    this.#onlineTimeoutMs = boundedInteger(
      options.onlineTimeoutMs,
      SUPERVISOR_ONLINE_TIMEOUT_MS,
      5 * 60_000,
    );
    this.#credentialTimeoutMs = boundedInteger(
      options.credentialTimeoutMs,
      SUPERVISOR_CREDENTIAL_TIMEOUT_MS,
      5 * 60_000,
    );
    this.#shutdownGraceMs = boundedInteger(
      options.shutdownGraceMs,
      SUPERVISOR_SHUTDOWN_GRACE_MS,
      30_000,
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
      binding.storageDir = confinedStorageDir(this.#storageRoot, this.#configuredStorageRoot, binding);
      const key = workerBindingKey(binding);
      desired.set(key, binding);
    }

    const removals: Promise<void>[] = [];
    for (const [key, record] of [...this.#records]) {
      if (!desired.has(key)) removals.push(this.#removeRecord(record));
    }
    await Promise.all(removals);

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
          reapBlocked: false,
          removeWhenReaped: false,
        };
        this.#records.set(key, record);
        starts.push(this.#spawn(record));
        continue;
      }

      const credentialsChanged = existing.binding.tokenRef !== binding.tokenRef
        || existing.binding.storageDir !== binding.storageDir;
      existing.binding = binding;
      existing.desired = true;
      existing.removeWhenReaped = false;
      if (credentialsChanged) existing.generation += 1;
      if (existing.reapBlocked) {
        starts.push(Promise.reject(failure('worker_exited')));
        continue;
      }
      const termination = existing.lifecycle?.termination;
      if (termination) {
        starts.push(termination.then(async (reaped) => {
          if (!reaped) throw failure('worker_exited');
          if (this.#disposed || !existing.desired || this.#records.get(key) !== existing) return;
          await this.#spawn(existing);
        }));
        continue;
      }
      if (credentialsChanged || existing.state === 'stopped') {
        starts.push(this.#restartRecord(existing, true));
      } else if (!existing.child && !existing.lifecycle && !existing.reapBlocked
        && existing.restartTimer === undefined && !existing.restartAttempt) {
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
    record.generation += 1;
    record.removeWhenReaped = false;
    this.#cancelLifecycleTimers(record);
    this.#rejectPending(record, 'worker_exited');
    const reaped = await this.#terminate(record);
    record.state = 'stopped';
    record.instanceId = null;
    record.readySeen = false;
    record.routable = false;
    if (!reaped) throw failure('worker_exited');
  }

  async restart(identity: WorkerIdentity): Promise<void> {
    if (this.#disposed) throw failure('worker_exited');
    const record = this.#record(identity);
    if (!record) throw failure('not_initialized');
    const queueAfterCurrent = record.state === 'stopped';
    record.desired = true;
    await this.#restartRecord(record, queueAfterCurrent);
  }

  snapshots(): readonly WorkerSnapshot[] {
    return [...this.#records.values()]
      .filter((record) => !record.removeWhenReaped || (record.reapBlocked && !this.#disposed))
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((record) => ({
        runtimeId: record.binding.runtimeId,
        nodeId: record.binding.nodeId,
        state: record.state,
        instanceId: record.instanceId,
        restartCount: record.restartCount,
      }));
  }

  dispose(): Promise<void> {
    if (this.#disposeAttempt) return this.#disposeAttempt;
    this.#disposed = true;
    const records = [...this.#records.values()];
    const attempt = Promise.all(records.map(async (record) => {
      record.desired = false;
      record.generation += 1;
      record.credentialLookup?.cancel();
      record.removeWhenReaped = true;
      this.#cancelLifecycleTimers(record);
      this.#rejectPending(record, 'worker_exited');
      record.state = 'stopped';
      record.instanceId = null;
      record.readySeen = false;
      record.routable = false;
      const reaped = await this.#terminate(record);
      if (reaped && this.#records.get(record.key) === record) this.#records.delete(record.key);
      return reaped;
    })).then((results) => {
      if (results.some((reaped) => !reaped)) throw failure('worker_exited');
    });
    this.#disposeAttempt = attempt;
    return attempt;
  }

  #record(identity: WorkerIdentity): WorkerRecord | undefined {
    return this.#records.get(workerBindingKey(identity));
  }

  #restartRecord(record: WorkerRecord, queueAfterCurrent = false): Promise<void> {
    if (record.restartAttempt) {
      if (!queueAfterCurrent) return record.restartAttempt;
      const current = record.restartAttempt;
      return current.then(
        () => this.#restartRecord(record),
        () => this.#restartRecord(record),
      );
    }
    const attempt = this.#performRestart(record);
    record.restartAttempt = attempt;
    const clear = (): void => {
      if (record.restartAttempt === attempt) record.restartAttempt = undefined;
    };
    void attempt.then(clear, clear);
    return attempt;
  }

  async #performRestart(record: WorkerRecord): Promise<void> {
    const generation = ++record.generation;
    this.#cancelLifecycleTimers(record);
    this.#rejectPending(record, 'worker_exited');
    record.state = 'backoff';
    record.instanceId = null;
    record.readySeen = false;
    record.routable = false;
    const reaped = await this.#terminate(record);
    if (!reaped) throw failure('worker_exited');
    if (!this.#ownsGeneration(record, generation)) return;
    this.#cancelLifecycleTimers(record);
    record.restartCount = 0;
    record.failedGeneration = undefined;
    record.state = 'starting';
    record.instanceId = null;
    record.readySeen = false;
    record.routable = false;
    await this.#spawn(record);
  }

  #spawn(record: WorkerRecord): Promise<void> {
    if (this.#disposed || !record.desired || this.#records.get(record.key) !== record
      || record.child || record.lifecycle || record.reapBlocked) return Promise.resolve();
    if (record.spawnAttempt) {
      if (record.spawnGeneration === record.generation) return record.spawnAttempt;
      return record.spawnAttempt.then(
        () => this.#spawn(record),
        () => this.#spawn(record),
      );
    }
    const generation = ++record.generation;
    const attempt = this.#performSpawn(record, generation);
    record.spawnAttempt = attempt;
    record.spawnGeneration = generation;
    const clear = (): void => {
      if (record.spawnAttempt === attempt) {
        record.spawnAttempt = undefined;
        record.spawnGeneration = undefined;
        this.#deleteDormantRecord(record);
      }
    };
    void attempt.then(clear, clear);
    return attempt;
  }

  async #performSpawn(record: WorkerRecord, generation: number): Promise<void> {
    if (!this.#ownsGeneration(record, generation)) return;
    const binding = copyBinding(record.binding);
    record.failedGeneration = undefined;
    record.state = 'starting';
    record.instanceId = null;
    record.readySeen = false;
    record.routable = false;
    record.refreshRequestId = undefined;
    let credential: SupervisorCredential;
    try {
      credential = await this.#boundedCredential(record, generation, binding);
    } catch (error) {
      if (this.#ownsGeneration(record, generation)) record.state = 'backoff';
      if (error instanceof RongCloudSupervisorError) throw error;
      throw failure('connect_failed');
    }
    if (!this.#ownsGeneration(record, generation)) return;
    const command = parseWorkerCommand({
      type: 'init',
      binding: {
        runtimeId: binding.runtimeId,
        nodeId: binding.nodeId,
        appKey: credential.appKey,
        storageDir: binding.storageDir,
      },
      token: credential.token,
    });
    if (!command.ok) {
      record.state = 'backoff';
      throw failure('authentication_failed');
    }
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
    this.#trackChild(record, child, generation);
    this.#attach(record, child, generation);
    if (!this.#armWatchdog(record, child, generation, 'ready')) return;
    try {
      child.send(command.value);
    } catch {
      this.#failRecord(record, generation);
    }
  }

  #boundedCredential(
    record: WorkerRecord,
    generation: number,
    binding: SupervisorBinding,
  ): Promise<SupervisorCredential> {
    const existing = record.credentialLookup;
    if (existing && !existing.settled) {
      return existing.blockedCode === undefined
        ? existing.promise
        : Promise.reject(failure(existing.blockedCode));
    }

    let raw: Promise<SupervisorCredential>;
    try {
      raw = Promise.resolve(this.#resolveCredential(copyBinding(binding)));
    } catch {
      raw = Promise.reject(failure('connect_failed'));
    }
    const lookup: CredentialLookup = {
      generation,
      promise: Promise.resolve({ appKey: '', token: '' }),
      settled: false,
      cancel: () => undefined,
    };
    record.credentialLookup = lookup;
    lookup.promise = new Promise((resolveCredential, rejectCredential) => {
      let finished = false;
      let timer: unknown;
      let timerInstalled = false;
      const finish = (
        result: { ok: true; value: SupervisorCredential } | { ok: false; error: RongCloudSupervisorError },
      ): void => {
        if (finished) return;
        finished = true;
        if (timerInstalled) this.#clearTimeout(timer);
        if (result.ok) resolveCredential(result.value);
        else rejectCredential(result.error);
      };
      lookup.cancel = () => {
        lookup.blockedCode = 'worker_exited';
        finish({ ok: false, error: failure('worker_exited') });
      };
      const scheduled = this.#schedule(() => {
        lookup.blockedCode = 'timeout';
        finish({ ok: false, error: failure('timeout') });
      }, this.#credentialTimeoutMs);
      if (!scheduled.ok) {
        lookup.blockedCode = 'timer_failed';
        finish({ ok: false, error: failure('timer_failed') });
      } else {
        timer = scheduled.timer;
        timerInstalled = true;
        if (finished) this.#clearTimeout(timer);
      }
      void raw.then(
        (value) => {
          lookup.settled = true;
          if (record.credentialLookup === lookup) record.credentialLookup = undefined;
          this.#deleteDormantRecord(record);
          if (lookup.blockedCode === undefined) finish({ ok: true, value });
        },
        () => {
          lookup.settled = true;
          if (record.credentialLookup === lookup) record.credentialLookup = undefined;
          this.#deleteDormantRecord(record);
          if (lookup.blockedCode === undefined) {
            finish({ ok: false, error: failure('connect_failed') });
          }
        },
      );
    });
    return lookup.promise;
  }

  #trackChild(record: WorkerRecord, child: WorkerChild, generation: number): ChildLifecycle {
    let resolveExit = (): void => undefined;
    const exitPromise = new Promise<void>((resolve) => { resolveExit = resolve; });
    let lifecycle: ChildLifecycle;
    const onExit = (): void => this.#markExited(record, lifecycle);
    lifecycle = {
      child,
      generation,
      exitPromise,
      resolveExit,
      onExit,
      exited: false,
      abandoned: false,
    };
    record.lifecycle = lifecycle;
    child.on('exit', onExit);
    if (this.#childHasExited(child)) this.#markExited(record, lifecycle);
    return lifecycle;
  }

  #markExited(record: WorkerRecord, lifecycle: ChildLifecycle): void {
    if (lifecycle.exited) return;
    lifecycle.exited = true;
    lifecycle.resolveExit();
    if (lifecycle.abandoned) {
      this.#releaseLifecycle(record, lifecycle);
      if (record.removeWhenReaped && !record.desired && this.#records.get(record.key) === record) {
        this.#records.delete(record.key);
      }
    }
  }

  #releaseLifecycle(record: WorkerRecord, lifecycle: ChildLifecycle): void {
    removeListener(lifecycle.child, 'exit', lifecycle.onExit);
    if (lifecycle.terminationError) {
      removeListener(lifecycle.child, 'error', lifecycle.terminationError);
      lifecycle.terminationError = undefined;
    }
    if (record.lifecycle === lifecycle) {
      record.lifecycle = undefined;
      record.reapBlocked = false;
    }
  }

  #childHasExited(child: WorkerChild): boolean {
    return (child.exitCode !== undefined && child.exitCode !== null)
      || (child.signalCode !== undefined && child.signalCode !== null);
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
      if (record.readyTimer !== undefined) this.#clearTimeout(record.readyTimer);
      record.readyTimer = undefined;
      if (!this.#armWatchdog(record, child, generation, 'online')) return;
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
      if (record.routable && record.state === 'online') return;
      if (record.onlineTimer !== undefined) this.#clearTimeout(record.onlineTimer);
      record.onlineTimer = undefined;
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
      if (record.onlineTimer === undefined
        && !this.#armWatchdog(record, child, generation, 'online')) return;
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
    if (!parsed.ok || parsed.value.type === 'init' || parsed.value.type === 'refresh_result'
      || parsed.value.type === 'shutdown') {
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
    this.#cancelStartupTimers(record);
    if (record.stableTimer !== undefined) this.#clearTimeout(record.stableTimer);
    record.stableTimer = undefined;
    this.#rejectPending(record, 'worker_exited');
    record.instanceId = null;
    record.readySeen = false;
    record.routable = false;
    record.state = 'backoff';
    record.restartCount += 1;
    void this.#terminate(record).then((reaped) => {
      if (!reaped || this.#disposed || !record.desired || this.#records.get(record.key) !== record
        || record.generation !== generation || record.failedGeneration !== generation) return;
      const exponent = Math.min(record.restartCount - 1, 30);
      const delay = Math.min(this.#restartMaxMs, this.#restartBaseMs * (2 ** exponent));
      const scheduled = this.#schedule(() => {
        record.restartTimer = undefined;
        if (this.#disposed || !record.desired || this.#records.get(record.key) !== record
          || record.reapBlocked) return;
        void this.#spawn(record).catch(() => undefined);
      }, delay);
      record.restartTimer = scheduled.ok ? scheduled.timer : undefined;
    }, () => undefined);
  }

  #terminate(record: WorkerRecord): Promise<boolean> {
    const lifecycle = record.lifecycle;
    const child = record.child ?? lifecycle?.child;
    if (!child) return Promise.resolve(!record.reapBlocked);
    const tracked = lifecycle?.child === child
      ? lifecycle
      : this.#trackChild(record, child, record.generation);
    if (tracked.termination) return tracked.termination;
    this.#retainTerminationError(tracked);
    this.#detach(record, child);
    if (record.child === child) record.child = undefined;
    const termination = this.#terminateLifecycle(record, tracked);
    tracked.termination = termination;
    return termination;
  }

  #retainTerminationError(lifecycle: ChildLifecycle): void {
    if (lifecycle.terminationError) return;
    const sink = (): void => undefined;
    try {
      lifecycle.child.on('error', sink);
      lifecycle.terminationError = sink;
    } catch {
      // The operational listener remains until this registration attempt finishes.
    }
  }

  async #terminateLifecycle(record: WorkerRecord, lifecycle: ChildLifecycle): Promise<boolean> {
    const child = lifecycle.child;
    if (this.#childHasExited(child)) this.#markExited(record, lifecycle);
    if (lifecycle.exited) {
      this.#releaseLifecycle(record, lifecycle);
      return true;
    }
    let shutdownSent = false;
    if (child.connected !== false) {
      try {
        const shutdown = parseWorkerCommand({ type: 'shutdown' });
        if (shutdown.ok) {
          child.send(shutdown.value);
          shutdownSent = true;
        }
      } catch {
        // Continue to the fixed process-termination sequence.
      }
    }
    if (shutdownSent
      && (lifecycle.exited || await this.#waitForExit(lifecycle, this.#shutdownGraceMs))) {
      this.#releaseLifecycle(record, lifecycle);
      return true;
    }
    if (child.connected !== false) {
      try {
        child.disconnect?.();
      } catch {
        // Continue to process termination.
      }
    }
    this.#kill(child, 'SIGTERM');
    if (lifecycle.exited || await this.#waitForExit(lifecycle, this.#terminateGraceMs)) {
      this.#releaseLifecycle(record, lifecycle);
      return true;
    }
    this.#kill(child, 'SIGKILL');
    if (lifecycle.exited || await this.#waitForExit(lifecycle, this.#killGraceMs)) {
      this.#releaseLifecycle(record, lifecycle);
      return true;
    }
    record.reapBlocked = true;
    lifecycle.abandoned = true;
    return false;
  }

  #kill(child: WorkerChild, signal: NodeJS.Signals): void {
    try {
      child.kill(signal);
    } catch {
      // Reaping deadlines still provide a finite result.
    }
  }

  #waitForExit(lifecycle: ChildLifecycle, milliseconds: number): Promise<boolean> {
    if (lifecycle.exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      let timer: unknown;
      let hasTimer = false;
      const finish = (exited: boolean): void => {
        if (settled) return;
        settled = true;
        if (hasTimer) this.#clearTimeout(timer);
        resolve(exited);
      };
      void lifecycle.exitPromise.then(() => finish(true));
      const scheduled = this.#schedule(() => finish(false), milliseconds);
      if (!scheduled.ok) {
        finish(false);
        return;
      }
      timer = scheduled.timer;
      hasTimer = true;
      if (settled) this.#clearTimeout(timer);
    });
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
    this.#cancelStartupTimers(record);
    record.restartTimer = undefined;
    record.stableTimer = undefined;
  }

  #cancelStartupTimers(record: WorkerRecord): void {
    if (record.readyTimer !== undefined) this.#clearTimeout(record.readyTimer);
    if (record.onlineTimer !== undefined) this.#clearTimeout(record.onlineTimer);
    record.readyTimer = undefined;
    record.onlineTimer = undefined;
  }

  #armWatchdog(
    record: WorkerRecord,
    child: WorkerChild,
    generation: number,
    phase: 'ready' | 'online',
  ): boolean {
    const scheduled = this.#schedule(() => {
      if (!this.#isCurrent(record, child, generation)) return;
      if (phase === 'ready') record.readyTimer = undefined;
      else record.onlineTimer = undefined;
      this.#failRecord(record, generation);
    }, phase === 'ready' ? this.#readyTimeoutMs : this.#onlineTimeoutMs);
    if (!scheduled.ok) {
      this.#failRecord(record, generation);
      return false;
    }
    if (phase === 'ready') record.readyTimer = scheduled.timer;
    else record.onlineTimer = scheduled.timer;
    return true;
  }

  async #removeRecord(record: WorkerRecord): Promise<void> {
    record.desired = false;
    record.generation += 1;
    record.removeWhenReaped = true;
    this.#cancelLifecycleTimers(record);
    this.#rejectPending(record, 'worker_exited');
    record.state = 'stopped';
    record.instanceId = null;
    record.readySeen = false;
    record.routable = false;
    const reaped = await this.#terminate(record);
    if (
      reaped &&
      record.removeWhenReaped &&
      !record.desired &&
      !record.spawnAttempt &&
      !record.credentialLookup &&
      this.#records.get(record.key) === record
    ) {
      this.#records.delete(record.key);
    }
    if (!reaped) throw failure('worker_exited');
  }

  #deleteDormantRecord(record: WorkerRecord): void {
    if (record.removeWhenReaped && !record.desired && !record.child && !record.lifecycle
      && !record.spawnAttempt && !record.credentialLookup
      && this.#records.get(record.key) === record) this.#records.delete(record.key);
  }

  #ownsGeneration(record: WorkerRecord, generation: number): boolean {
    return !this.#disposed && record.desired && this.#records.get(record.key) === record
      && record.generation === generation && record.failedGeneration !== generation;
  }

  #isCurrent(record: WorkerRecord, child: WorkerChild, generation: number): boolean {
    return this.#ownsGeneration(record, generation) && record.child === child;
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
