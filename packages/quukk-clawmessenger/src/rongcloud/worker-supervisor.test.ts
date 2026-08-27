// @vitest-environment node

import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, parse, relative, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { parseWorkerCommand } from './worker-protocol.js';

type WorkerIdentity = { runtimeId: string; nodeId: string };

type SupervisorBinding = WorkerIdentity & {
  enabled: boolean;
  tokenRef: string;
  storageDir: string;
};

type WorkerSnapshot = WorkerIdentity & {
  state: string;
  instanceId: string | null;
  restartCount: number;
};

type Supervisor = {
  reconcile(bindings: readonly SupervisorBinding[]): Promise<void>;
  send(identity: WorkerIdentity, input: Record<string, unknown>): Promise<string | undefined>;
  receipt(identity: WorkerIdentity, input: Record<string, unknown>): Promise<void>;
  joinChatroom(identity: WorkerIdentity, input: { roomId: string; historyCount: number }): Promise<void>;
  stop(identity: WorkerIdentity): Promise<void>;
  restart(identity: WorkerIdentity): Promise<void>;
  snapshots(): readonly WorkerSnapshot[];
  dispose(): Promise<void>;
};

type SupervisorModule = {
  RongCloudWorkerSupervisor: new (options: Record<string, unknown>) => Supervisor;
  buildMinimalWorkerEnv(source: NodeJS.ProcessEnv, platform?: NodeJS.Platform): NodeJS.ProcessEnv;
  workerBindingKey(identity: WorkerIdentity): string;
};

let supervisorModule: SupervisorModule | undefined;
const configuredTaskTemp = resolve(tmpdir());
let unitStorageRoot = '';

beforeAll(async () => {
  unitStorageRoot = await mkdtemp(join(configuredTaskTemp, 'quukk-task9-supervisor-unit-'));
  supervisorModule = await import('./worker-supervisor.js')
    .then((module) => module as unknown as SupervisorModule)
    .catch(() => undefined);
});

afterAll(async () => {
  if (unitStorageRoot) await rm(unitStorageRoot, { recursive: true, force: true });
});

function supervisorApi(): SupervisorModule {
  expect(supervisorModule, 'Phase D worker supervisor implementation is missing').toBeDefined();
  return supervisorModule!;
}

async function flush(): Promise<void> {
  for (let index = 0; index < 16; index += 1) await Promise.resolve();
}

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

type ChildEvent = 'message' | 'exit' | 'error' | 'disconnect';
type ChildListener = (...values: unknown[]) => void;

class FakeChild {
  readonly sent: unknown[] = [];
  readonly listeners = new Map<ChildEvent, Set<ChildListener>>();
  readonly messageListenerHistory: ChildListener[] = [];
  connected = true;
  alive = true;
  killCalls = 0;
  disconnectCalls = 0;
  exitOnSigterm = true;
  exitOnSigkill = true;
  exitOnShutdown = true;
  readonly shutdownErrorListenerCounts: number[] = [];
  readonly killSignals: Array<string | number> = [];

  constructor(readonly pid: number, readonly recordSend: (message: unknown) => void) {}

  on(event: ChildEvent, listener: ChildListener): this {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    if (event === 'message') this.messageListenerHistory.push(listener);
    return this;
  }

  off(event: ChildEvent, listener: ChildListener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  send(message: unknown): boolean {
    if (!this.connected) throw new Error('child_disconnected');
    const detached = structuredClone(message);
    this.sent.push(detached);
    this.recordSend(detached);
    if ((detached as { type?: string }).type === 'shutdown') {
      this.shutdownErrorListenerCounts.push(this.listeners.get('error')?.size ?? 0);
      if (this.exitOnShutdown) this.reap(0, null);
    }
    return true;
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    this.killCalls += 1;
    this.killSignals.push(signal);
    if (!this.alive) return false;
    if ((signal === 'SIGTERM' && !this.exitOnSigterm)
      || (signal === 'SIGKILL' && !this.exitOnSigkill)) return true;
    this.reap(0, signal);
    return true;
  }

  disconnect(): void {
    this.disconnectCalls += 1;
    if (!this.connected) return;
    this.connected = false;
    this.emit('disconnect');
  }

  emitMessage(message: unknown): void {
    this.emit('message', message);
  }

  crash(code = 1): void {
    if (!this.alive) return;
    this.reap(code, null);
  }

  reap(code = 0, signal: string | number | null = 'SIGTERM'): void {
    if (!this.alive) return;
    this.alive = false;
    this.connected = false;
    this.emit('exit', code, signal);
  }

  dropIpc(): void {
    if (!this.alive || !this.connected) return;
    this.connected = false;
    this.emit('disconnect');
  }

  emitStaleMessage(listenerIndex: number, message: unknown): void {
    this.messageListenerHistory[listenerIndex]?.(message);
  }

  emitFault(event: 'error' | 'disconnect'): void {
    this.emit(event, event === 'error' ? new Error('fake_child_error') : undefined);
  }

  #emit(event: ChildEvent, ...values: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...values);
  }

  private emit(event: ChildEvent, ...values: unknown[]): void {
    this.#emit(event, ...values);
  }
}

type SpawnCall = {
  modulePath: string;
  args: readonly string[];
  options: Record<string, unknown>;
  child: FakeChild;
};

class SpawnHarness {
  readonly calls: SpawnCall[] = [];
  readonly order: string[] = [];
  #nextPid = 4_000;

  readonly spawn = (
    modulePath: string,
    args: readonly string[],
    options: Record<string, unknown>,
  ): FakeChild => {
    const pid = this.#nextPid++;
    this.order.push(`spawn:${pid}`);
    const child = new FakeChild(pid, (message) => {
      const type = (message as { type?: string }).type ?? 'unknown';
      this.order.push(`send:${pid}:${type}`);
    });
    this.calls.push({ modulePath, args: [...args], options, child });
    return child;
  };
}

class ManualTimers {
  now = 0;
  readonly scheduled: number[] = [];
  readonly #timers = new Map<number, { due: number; callback: () => void }>();
  #nextId = 1;

  readonly setTimeout = (callback: () => void, milliseconds: number): number => {
    const id = this.#nextId++;
    this.scheduled.push(milliseconds);
    this.#timers.set(id, { due: this.now + milliseconds, callback });
    return id;
  };

  readonly clearTimeout = (id: number): void => {
    this.#timers.delete(id);
  };

  pendingDelays(): number[] {
    return [...this.#timers.values()].map((timer) => timer.due - this.now).sort((a, b) => a - b);
  }

  advance(milliseconds: number): void {
    const target = this.now + milliseconds;
    while (true) {
      const next = [...this.#timers]
        .filter(([, timer]) => timer.due <= target)
        .sort((left, right) => left[1].due - right[1].due || left[0] - right[0])[0];
      if (!next) break;
      const [id, timer] = next;
      this.#timers.delete(id);
      this.now = timer.due;
      timer.callback();
    }
    this.now = target;
  }
}

const workerEntryPath = 'D:\\pkg\\dist\\rongcloud\\worker-entry.js';
const requestTimeoutMs = 50;
const restartBaseMs = 10;
const restartMaxMs = 40;
const stableWindowMs = 100;

const hostileParentEnv: NodeJS.ProcessEnv = {
  SystemRoot: 'C:\\Windows',
  WINDIR: 'C:\\Windows',
  ComSpec: 'C:\\Windows\\System32\\cmd.exe',
  TEMP: 'D:\\A-DM\\dm-im\\.task-tmp',
  TMP: 'D:\\A-DM\\dm-im\\.task-tmp',
  PATH: 'C:\\must-not-be-required',
  NODE_OPTIONS: '--require PHASE_D_NODE_OPTIONS_SENTINEL',
  NODE_TLS_REJECT_UNAUTHORIZED: '0',
  CLAW_TOKEN: 'PHASE_D_CLAW_SENTINEL',
  QUUKK_SECRET: 'PHASE_D_QUUKK_SENTINEL',
  RONGCLOUD_TOKEN: 'PHASE_D_RONGCLOUD_SENTINEL',
  OPENAI_API_KEY: 'PHASE_D_OPENAI_SENTINEL',
  ANTHROPIC_API_KEY: 'PHASE_D_ANTHROPIC_SENTINEL',
  USERPROFILE: 'C:\\Users\\must-not-leak',
};

function hex(index: number): string {
  return index.toString(16).padStart(32, '0');
}

function binding(index: number, overrides: Partial<SupervisorBinding> = {}): SupervisorBinding {
  const runtimeId = `rt_${hex(index + 1)}`;
  return {
    runtimeId,
    nodeId: `node-${index + 1}`,
    enabled: true,
    tokenRef: `rc_${hex(index + 101)}`,
    storageDir: join(unitStorageRoot, runtimeId),
    ...overrides,
  };
}

function identity(value: SupervisorBinding): WorkerIdentity {
  return { runtimeId: value.runtimeId, nodeId: value.nodeId };
}

function credential(value: SupervisorBinding): { appKey: string; token: string; serverUrl: string } {
  return {
    appKey: `PHASE_D_APP_KEY_SENTINEL_${value.nodeId}`,
    token: `PHASE_D_TOKEN_SENTINEL_${value.nodeId}`,
    serverUrl: `https://PHASE_D_SERVER_SENTINEL_${value.nodeId}.invalid`,
  };
}

type SinkRecord = { identity: WorkerIdentity; event: Record<string, unknown> };

function createFixture(overrides: Record<string, unknown> = {}) {
  const api = supervisorApi();
  const spawn = new SpawnHarness();
  const timers = new ManualTimers();
  const events: SinkRecord[] = [];
  const resolved: SupervisorBinding[] = [];
  const refreshed: SupervisorBinding[] = [];
  const supervisor = new api.RongCloudWorkerSupervisor({
    workerEntryPath,
    spawnChild: spawn.spawn,
    processEnv: hostileParentEnv,
    platform: 'win32',
    storageRoot: unitStorageRoot,
    resolveCredential: async (value: SupervisorBinding) => {
      resolved.push(structuredClone(value));
      return credential(value);
    },
    refreshCredential: async (value: SupervisorBinding) => {
      refreshed.push(structuredClone(value));
      return `PHASE_D_REFRESH_TOKEN_SENTINEL_${value.nodeId}`;
    },
    onEvent: (workerIdentity: WorkerIdentity, event: Record<string, unknown>) => {
      events.push({ identity: structuredClone(workerIdentity), event: structuredClone(event) });
    },
    now: () => timers.now,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    requestTimeoutMs,
    restartBaseMs,
    restartMaxMs,
    stableWindowMs,
    maxPendingRequests: 2,
    maxBufferedCommands: 2,
    ...overrides,
  });
  return { api, supervisor, spawn, timers, events, resolved, refreshed };
}

function initFor(child: FakeChild): {
  binding: { runtimeId: string; nodeId: string; storageDir: string };
  token: string;
} {
  const command = child.sent.find((value) => (value as { type?: string }).type === 'init');
  expect(command).toBeDefined();
  const parsed = parseWorkerCommand(command);
  expect(parsed.ok).toBe(true);
  return command as {
    binding: { runtimeId: string; nodeId: string; storageDir: string };
    token: string;
  };
}

function workerInstance(child: FakeChild): string {
  return `rcw_${child.pid.toString(16).padStart(32, '0')}`;
}

async function activate(child: FakeChild): Promise<string> {
  const init = initFor(child);
  const instanceId = workerInstance(child);
  child.emitMessage({ type: 'ready', runtimeId: init.binding.runtimeId, instanceId });
  child.emitMessage({
    type: 'connection', runtimeId: init.binding.runtimeId, instanceId, state: 'online',
  });
  await flush();
  return instanceId;
}

function workerCommands(child: FakeChild): Array<Record<string, unknown>> {
  return child.sent.filter((value) => (value as { type?: string }).type !== 'init')
    .map((value) => value as Record<string, unknown>);
}

function messageEvent(runtimeId: string, instanceId: string, uid: string) {
  return {
    type: 'message', runtimeId, instanceId,
    message: {
      messageUid: uid,
      senderId: 'sender-1',
      targetId: 'target-1',
      conversationType: 1,
      objectName: 'RC:TxtMsg',
      text: 'hello',
      attachments: [],
    },
  };
}

function track<T>(promise: Promise<T>) {
  let settled = false;
  const outcome = promise.then(
    (value) => { settled = true; return { ok: true as const, value }; },
    (error: unknown) => { settled = true; return { ok: false as const, error }; },
  );
  return { outcome, settled: () => settled };
}

describe('RongCloud worker supervisor', () => {
  it('uses collision-free runtime and node identity keys and permits distinct nodes for one runtime', async () => {
    const { workerBindingKey } = supervisorApi();
    expect(workerBindingKey({ runtimeId: 'ab', nodeId: 'c' }))
      .not.toBe(workerBindingKey({ runtimeId: 'a', nodeId: 'bc' }));
    expect(workerBindingKey({ runtimeId: 'ab', nodeId: 'c' }))
      .toBe(workerBindingKey({ runtimeId: 'ab', nodeId: 'c' }));

    const fixture = createFixture();
    const sharedRuntime = `rt_${hex(90)}`;
    const sharedStorageDir = join(unitStorageRoot, sharedRuntime);
    await fixture.supervisor.reconcile([
      binding(0, { runtimeId: sharedRuntime, nodeId: 'node-a', storageDir: sharedStorageDir }),
      binding(1, { runtimeId: sharedRuntime, nodeId: 'node-b', storageDir: sharedStorageDir }),
    ]);
    expect(fixture.spawn.calls).toHaveLength(2);
    expect(new Set(fixture.spawn.calls.map((call) => call.child.pid)).size).toBe(2);
  });

  it('confines every binding to one canonical direct child of the trusted storage root', async () => {
    const testRoot = await mkdtemp(join(configuredTaskTemp, 'quukk-task9-supervisor-storage-'));
    const storageRoot = join(testRoot, 'workers');
    const outside = join(testRoot, 'outside');
    await Promise.all([mkdir(storageRoot), mkdir(outside)]);
    const fixtures: ReturnType<typeof createFixture>[] = [];
    try {
      const valid = binding(40);
      const expectedStorageDir = join(storageRoot, valid.runtimeId);
      valid.storageDir = process.platform === 'win32'
        ? expectedStorageDir.toUpperCase()
        : expectedStorageDir;
      const validFixture = createFixture({ storageRoot });
      fixtures.push(validFixture);
      await validFixture.supervisor.reconcile([valid]);
      const initializedStorageDir = initFor(validFixture.spawn.calls[0]!.child).binding.storageDir;
      const canonicalStorageRoot = await realpath(storageRoot);
      expect(process.platform === 'win32' ? initializedStorageDir.toLowerCase() : initializedStorageDir)
        .toBe(process.platform === 'win32'
          ? resolve(canonicalStorageRoot, valid.runtimeId).toLowerCase()
          : resolve(canonicalStorageRoot, valid.runtimeId));

      const invalidBindings = [
        binding(41, { storageDir: storageRoot }),
        binding(42, { storageDir: join(testRoot, 'sibling', `rt_${hex(43)}`) }),
        binding(43, { storageDir: join(storageRoot, `rt_${hex(44)}`, '..') }),
        binding(44, { runtimeId: '../escape', storageDir: join(storageRoot, 'escape') }),
      ];
      for (const invalid of invalidBindings) {
        const fixture = createFixture({ storageRoot });
        fixtures.push(fixture);
        await expect(fixture.supervisor.reconcile([invalid])).rejects.toMatchObject({ code: 'invalid_request' });
        expect(fixture.spawn.calls).toHaveLength(0);
      }

      const linked = binding(45);
      linked.storageDir = join(storageRoot, linked.runtimeId);
      await symlink(outside, linked.storageDir, process.platform === 'win32' ? 'junction' : 'dir');
      const linkFixture = createFixture({ storageRoot });
      fixtures.push(linkFixture);
      await expect(linkFixture.supervisor.reconcile([linked])).rejects.toMatchObject({ code: 'invalid_request' });
      expect(linkFixture.spawn.calls).toHaveLength(0);

      const filesystemRoot = parse(configuredTaskTemp).root;
      expect(() => createFixture({ storageRoot: filesystemRoot })).toThrowError(
        expect.objectContaining({ code: 'invalid_request' }),
      );
    } finally {
      await Promise.allSettled(fixtures.map(({ supervisor }) => supervisor.dispose()));
      await rm(testRoot, { recursive: true, force: true });
    }
  });

  it('canonicalizes a trusted short-path alias while still checking the actual path for reparses', async () => {
    const aliasRoot = await mkdtemp(join(configuredTaskTemp, 'quukk-task9-supervisor-alias-'));
    const expandedRoot = `${aliasRoot}-expanded`;
    await mkdir(expandedRoot);
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const canonicalExpandedRoot = actualFs.realpathSync.native(expandedRoot);
    const mockedRealpath = Object.assign(
      (path: Parameters<typeof actualFs.realpathSync>[0]) => actualFs.realpathSync(path),
      {
        native: (path: Parameters<typeof actualFs.realpathSync.native>[0]) => {
          const requested = resolve(String(path));
          const aliasChild = relative(aliasRoot, requested);
          if (aliasChild === '') return canonicalExpandedRoot;
          if (!aliasChild.startsWith('..') && !isAbsolute(aliasChild)) {
            return join(canonicalExpandedRoot, aliasChild);
          }
          const canonicalChild = relative(canonicalExpandedRoot, requested);
          if (!canonicalChild.startsWith('..') && !isAbsolute(canonicalChild)) return requested;
          return actualFs.realpathSync.native(path);
        },
      },
    );
    vi.resetModules();
    vi.doMock('node:fs', () => ({ ...actualFs, realpathSync: mockedRealpath }));
    try {
      const isolated = await import('./worker-supervisor.js');
      const spawn = new SpawnHarness();
      const supervisor = new isolated.RongCloudWorkerSupervisor({
        storageRoot: aliasRoot,
        workerEntryPath,
        spawnChild: (modulePath, args, options) => spawn.spawn(
          modulePath,
          args,
          options as unknown as Record<string, unknown>,
        ),
        resolveCredential: async () => ({ appKey: 'unused', token: 'unused' }),
        refreshCredential: async () => 'unused',
      });
      const value = binding(46, { storageDir: join(aliasRoot, `rt_${hex(47)}`) });
      await supervisor.reconcile([value]);
      expect(spawn.calls).toHaveLength(1);
      expect(initFor(spawn.calls[0]!.child).binding.storageDir)
        .toBe(resolve(canonicalExpandedRoot, value.runtimeId));
      const sibling = binding(47, { storageDir: join(configuredTaskTemp, `rt_${hex(48)}`) });
      await expect(supervisor.reconcile([sibling])).rejects.toMatchObject({ code: 'invalid_request' });
      await expect(supervisor.dispose()).resolves.toBeUndefined();
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
      await Promise.all([
        rm(aliasRoot, { recursive: true, force: true }),
        rm(expandedRoot, { recursive: true, force: true }),
      ]);
    }
  });

  it('spawns four complete bindings as four children with minimal env and credentials only in post-spawn IPC', async () => {
    const fixture = createFixture();
    const bindings = [binding(0), binding(1), binding(2), binding(3)];
    const expectedEnv = {
      SystemRoot: hostileParentEnv.SystemRoot,
      WINDIR: hostileParentEnv.WINDIR,
      ComSpec: hostileParentEnv.ComSpec,
      TEMP: hostileParentEnv.TEMP,
      TMP: hostileParentEnv.TMP,
    };
    expect(fixture.api.buildMinimalWorkerEnv(hostileParentEnv, 'win32')).toEqual(expectedEnv);
    expect(fixture.api.buildMinimalWorkerEnv({
      PATH: '/usr/bin', LANG: 'en_US.UTF-8', LC_ALL: 'C', LC_CTYPE: 'C.UTF-8',
      TMPDIR: '/tmp/task', TEMP: '/tmp/task', TMP: '/tmp/task', TZ: 'UTC',
      HOME: '/home/must-not-leak', NODE_TLS_REJECT_UNAUTHORIZED: '0',
      OPENAI_API_KEY: 'PHASE_D_POSIX_SECRET_SENTINEL',
    }, 'linux')).toEqual({
      PATH: '/usr/bin', LANG: 'en_US.UTF-8', LC_ALL: 'C', LC_CTYPE: 'C.UTF-8',
      TMPDIR: '/tmp/task', TEMP: '/tmp/task', TMP: '/tmp/task', TZ: 'UTC',
    });

    await fixture.supervisor.reconcile(bindings);
    expect(fixture.spawn.calls).toHaveLength(4);
    expect(new Set(fixture.spawn.calls.map((call) => call.child.pid)).size).toBe(4);
    expect(fixture.resolved).toHaveLength(4);

    for (const [index, call] of fixture.spawn.calls.entries()) {
      expect(call.modulePath).toBe(workerEntryPath);
      expect(call.args).toEqual([]);
      expect(call.options).toMatchObject({
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        execArgv: [],
        env: expectedEnv,
      });
      const init = initFor(call.child);
      expect(init).toMatchObject({
        binding: {
          runtimeId: bindings[index]!.runtimeId,
          nodeId: bindings[index]!.nodeId,
        },
        token: credential(bindings[index]!).token,
      });
      expect(fixture.spawn.order.indexOf(`spawn:${call.child.pid}`))
        .toBeLessThan(fixture.spawn.order.indexOf(`send:${call.child.pid}:init`));
    }

    const spawnMaterial = JSON.stringify(fixture.spawn.calls.map(({ modulePath, args, options }) => ({
      modulePath, args, options,
    })));
    for (const value of bindings.flatMap((item) => [
      item.runtimeId, item.nodeId, item.storageDir, item.tokenRef,
      credential(item).appKey, credential(item).token, credential(item).serverUrl,
    ])) expect(spawnMaterial).not.toContain(value);
  });

  it('bounds one never-resolving credential lookup before spawn and leaves a healthy sibling usable', async () => {
    const pending = deferred<{ appKey: string; token: string }>();
    const credentialTimeoutMs = 7;
    const values = [binding(0), binding(1)];
    let blockedCalls = 0;
    const fixture = createFixture({
      credentialTimeoutMs,
      resolveCredential: (value: SupervisorBinding) => {
        if (value.nodeId === values[0]!.nodeId) {
          blockedCalls += 1;
          return pending.promise;
        }
        return Promise.resolve(credential(value));
      },
    });
    const reconciled = track(fixture.supervisor.reconcile(values));
    await flush();
    expect(fixture.spawn.calls).toHaveLength(1);
    expect(initFor(fixture.spawn.calls[0]!.child).binding.nodeId).toBe(values[1]!.nodeId);
    await activate(fixture.spawn.calls[0]!.child);

    fixture.timers.advance(credentialTimeoutMs);
    await flush();
    expect(await reconciled.outcome).toMatchObject({ ok: false, error: { code: 'timeout' } });
    expect(fixture.supervisor.snapshots()).toContainEqual(expect.objectContaining({
      runtimeId: values[0]!.runtimeId, state: 'backoff',
    }));
    expect(fixture.spawn.calls[0]!.child.alive).toBe(true);

    await expect(fixture.supervisor.reconcile(values)).rejects.toMatchObject({ code: 'timeout' });
    expect(blockedCalls).toBe(1);
    expect(fixture.spawn.calls).toHaveLength(1);

    pending.resolve(credential(values[0]!));
    await flush();
    expect(fixture.spawn.calls).toHaveLength(1);

    await fixture.supervisor.reconcile(values);
    expect(blockedCalls).toBe(2);
    expect(fixture.spawn.calls).toHaveLength(2);
    expect(initFor(fixture.spawn.calls[1]!.child).binding.nodeId).toBe(values[0]!.nodeId);
  });

  it('fences an old credential lookup before spawning after a token reference change', async () => {
    const oldCredential = deferred<{ appKey: string; token: string }>();
    const value = binding(0);
    const changed = { ...value, tokenRef: `rc_${hex(998)}` };
    let lookups = 0;
    const fixture = createFixture({
      resolveCredential: (current: SupervisorBinding) => {
        lookups += 1;
        return lookups === 1
          ? oldCredential.promise
          : Promise.resolve({ appKey: 'new-app-key', token: `new-token-${current.tokenRef}` });
      },
    });
    const original = track(fixture.supervisor.reconcile([value]));
    await flush();
    const replacement = track(fixture.supervisor.reconcile([changed]));
    await flush();
    expect(fixture.spawn.calls).toHaveLength(0);

    oldCredential.resolve({ appKey: 'old-app-key', token: 'old-token' });
    expect((await original.outcome).ok).toBe(true);
    expect((await replacement.outcome).ok).toBe(true);
    expect(lookups).toBe(2);
    expect(fixture.spawn.calls).toHaveLength(1);
    expect(initFor(fixture.spawn.calls[0]!.child).token).toBe(`new-token-${changed.tokenRef}`);
  });

  it('never combines an earlier restart credential with a later token-reference binding', async () => {
    const value = binding(0);
    const second = { ...value, tokenRef: `rc_${hex(997)}` };
    const latest = { ...value, tokenRef: `rc_${hex(998)}` };
    const secondCredential = deferred<{ appKey: string; token: string }>();
    let lookups = 0;
    const fixture = createFixture({
      resolveCredential: (current: SupervisorBinding) => {
        lookups += 1;
        if (current.tokenRef === second.tokenRef) return secondCredential.promise;
        return Promise.resolve({ appKey: `app-${current.tokenRef}`, token: `token-${current.tokenRef}` });
      },
    });
    await fixture.supervisor.reconcile([value]);
    const replacing = track(fixture.supervisor.reconcile([second]));
    await flush();
    expect(lookups).toBe(2);
    expect(fixture.spawn.calls).toHaveLength(1);

    const latestReconcile = track(fixture.supervisor.reconcile([latest]));
    secondCredential.resolve({ appKey: 'stale-app', token: 'stale-token' });
    expect((await replacing.outcome).ok).toBe(true);
    expect((await latestReconcile.outcome).ok).toBe(true);
    expect(lookups).toBe(3);
    expect(fixture.spawn.calls).toHaveLength(2);
    expect(initFor(fixture.spawn.calls[1]!.child)).toMatchObject({
      binding: { runtimeId: value.runtimeId, nodeId: value.nodeId },
      token: `token-${latest.tokenRef}`,
    });
  });

  it('retains one pending credential lookup across disable and re-add', async () => {
    const credentialTimeoutMs = 7;
    const value = binding(0);
    let lookups = 0;
    const fixture = createFixture({
      credentialTimeoutMs,
      resolveCredential: () => {
        lookups += 1;
        return new Promise(() => undefined);
      },
    });
    const original = track(fixture.supervisor.reconcile([value]));
    await flush();
    await fixture.supervisor.reconcile([]);
    const readded = track(fixture.supervisor.reconcile([value]));
    await flush();
    expect(lookups).toBe(1);
    expect(fixture.spawn.calls).toHaveLength(0);

    fixture.timers.advance(credentialTimeoutMs);
    await flush();
    expect(await original.outcome).toMatchObject({ ok: false, error: { code: 'timeout' } });
    expect(await readded.outcome).toMatchObject({ ok: false, error: { code: 'timeout' } });
    expect(lookups).toBe(1);
  });

  it('queues same-binding re-add behind a generation-invalidated restart lookup', async () => {
    const value = binding(0);
    const changed = { ...value, tokenRef: `rc_${hex(996)}` };
    const staleCredential = deferred<{ appKey: string; token: string }>();
    let lookups = 0;
    const fixture = createFixture({
      resolveCredential: () => {
        lookups += 1;
        if (lookups === 2) return staleCredential.promise;
        return Promise.resolve({ appKey: `app-${lookups}`, token: `token-${lookups}` });
      },
    });
    await fixture.supervisor.reconcile([value]);
    const staleRestart = track(fixture.supervisor.reconcile([changed]));
    await flush();
    expect(lookups).toBe(2);
    expect(fixture.spawn.calls).toHaveLength(1);

    await fixture.supervisor.reconcile([]);
    const readded = track(fixture.supervisor.reconcile([changed]));
    staleCredential.resolve({ appKey: 'stale-app', token: 'stale-token' });
    expect((await staleRestart.outcome).ok).toBe(true);
    expect((await readded.outcome).ok).toBe(true);
    expect(lookups).toBe(3);
    expect(fixture.spawn.calls).toHaveLength(2);
    expect(initFor(fixture.spawn.calls[1]!.child).token).toBe('token-3');
  });

  it('settles a pending credential deadline when the supervisor is disposed', async () => {
    const value = binding(0);
    const fixture = createFixture({
      credentialTimeoutMs: 7,
      resolveCredential: () => new Promise(() => undefined),
    });
    const reconciled = track(fixture.supervisor.reconcile([value]));
    await flush();
    expect(fixture.timers.pendingDelays()).toEqual([7]);

    await fixture.supervisor.dispose();
    await flush();
    expect(fixture.timers.pendingDelays()).toEqual([]);
    expect(await reconciled.outcome).toMatchObject({
      ok: false,
      error: { code: 'worker_exited' },
    });
    expect(fixture.spawn.calls).toHaveLength(0);
  });

  it('buffers until one matching ready-then-online sequence and only then routes commands and events', async () => {
    const fixture = createFixture();
    const value = binding(0);
    await fixture.supervisor.reconcile([value]);
    const child = fixture.spawn.calls[0]!.child;
    const pending = fixture.supervisor.send(identity(value), {
      conversationType: 1, targetId: 'target-1', messageType: 'text', content: 'hello',
    });
    await flush();
    expect(workerCommands(child)).toEqual([]);

    const instanceId = workerInstance(child);
    child.emitMessage({ type: 'connection', runtimeId: value.runtimeId, instanceId, state: 'online' });
    child.emitMessage(messageEvent(value.runtimeId, instanceId, 'before-ready'));
    await flush();
    expect(workerCommands(child)).toEqual([]);
    expect(fixture.events.filter(({ event }) => event.type === 'message')).toEqual([]);

    child.emitMessage({ type: 'ready', runtimeId: value.runtimeId, instanceId });
    child.emitMessage({
      type: 'connection', runtimeId: value.runtimeId, instanceId: workerInstance(new FakeChild(9_999, () => undefined)),
      state: 'online',
    });
    await flush();
    expect(workerCommands(child)).toEqual([]);
    child.emitMessage({ type: 'connection', runtimeId: value.runtimeId, instanceId, state: 'online' });
    await flush();
    const command = workerCommands(child)[0]!;
    expect(command).toMatchObject({ type: 'send', content: 'hello' });

    child.emitMessage(messageEvent(value.runtimeId, instanceId, 'after-online'));
    child.emitMessage({
      type: 'result', runtimeId: value.runtimeId, instanceId,
      requestId: command.requestId, ok: true, messageUid: 'sent-1',
    });
    await expect(pending).resolves.toBe('sent-1');
    expect(fixture.events.filter(({ event }) => event.type === 'message')).toHaveLength(1);
    expect(fixture.supervisor.snapshots()).toContainEqual(expect.objectContaining({
      runtimeId: value.runtimeId, nodeId: value.nodeId, state: 'online', instanceId,
    }));

    const controlled = track(fixture.supervisor.send(identity(value), {
      type: 'disconnect', requestId: 'caller-controlled-id',
      conversationType: 1, targetId: 'target-1', messageType: 'text', content: 'controlled',
    }));
    await flush();
    const protectedCommand = workerCommands(child).at(-1)!;
    expect(protectedCommand).toMatchObject({ type: 'send', content: 'controlled' });
    expect(protectedCommand.requestId).not.toBe('caller-controlled-id');
    child.emitMessage({
      type: 'result', runtimeId: value.runtimeId, instanceId,
      requestId: protectedCommand.requestId, ok: true,
    });
    expect((await controlled.outcome).ok).toBe(true);
  });

  it('bounds silent ready and online phases per generation without touching a healthy sibling', async () => {
    const readyTimeoutMs = 11;
    const onlineTimeoutMs = 13;
    const fixture = createFixture({ readyTimeoutMs, onlineTimeoutMs });
    const silent = binding(0);
    const sibling = binding(1);
    await fixture.supervisor.reconcile([silent, sibling]);
    const silentChild = fixture.spawn.calls[0]!.child;
    const siblingChild = fixture.spawn.calls[1]!.child;
    await activate(siblingChild);

    fixture.timers.advance(readyTimeoutMs);
    await flush();
    expect(silentChild.alive).toBe(false);
    expect(siblingChild.alive).toBe(true);
    expect(fixture.supervisor.snapshots()).toContainEqual(expect.objectContaining({
      runtimeId: silent.runtimeId, state: 'backoff', restartCount: 1,
    }));

    fixture.timers.advance(restartBaseMs);
    await flush();
    const readyOnlyChild = fixture.spawn.calls[2]!.child;
    const readyOnlyInstance = workerInstance(readyOnlyChild);
    readyOnlyChild.emitMessage({ type: 'ready', runtimeId: silent.runtimeId, instanceId: readyOnlyInstance });
    fixture.timers.advance(onlineTimeoutMs);
    await flush();
    expect(readyOnlyChild.alive).toBe(false);
    expect(siblingChild.alive).toBe(true);
    expect(fixture.spawn.calls).toHaveLength(3);
  });

  it('rearms one generation online deadline during auto-reconnect and drains only after recovery', async () => {
    const onlineTimeoutMs = 13;
    const fixture = createFixture({ onlineTimeoutMs });
    const values = [binding(0), binding(1)];
    await fixture.supervisor.reconcile(values);
    const first = fixture.spawn.calls[0]!.child;
    const sibling = fixture.spawn.calls[1]!.child;
    const firstInstance = await activate(first);
    await activate(sibling);
    first.exitOnShutdown = true;

    first.emitMessage({
      type: 'connection', runtimeId: values[0]!.runtimeId, instanceId: firstInstance, state: 'offline',
    });
    first.emitMessage({
      type: 'connection', runtimeId: values[0]!.runtimeId, instanceId: firstInstance, state: 'connecting',
    });
    await flush();
    expect(fixture.timers.pendingDelays()).toContain(onlineTimeoutMs);
    const pending = fixture.supervisor.send(identity(values[0]!), {
      conversationType: 1, targetId: 'target', messageType: 'text', content: 'after-reconnect',
    });
    await flush();
    expect(workerCommands(first)).toEqual([]);

    first.emitMessage({
      type: 'connection', runtimeId: values[0]!.runtimeId, instanceId: firstInstance, state: 'online',
    });
    first.emitMessage({
      type: 'connection', runtimeId: values[0]!.runtimeId, instanceId: firstInstance, state: 'online',
    });
    await flush();
    const command = workerCommands(first)[0]!;
    expect(command).toMatchObject({ type: 'send', content: 'after-reconnect' });
    expect(fixture.events.filter(({ identity: eventIdentity, event }) =>
      eventIdentity.runtimeId === values[0]!.runtimeId && event.type === 'connection'
      && event.state === 'online')).toHaveLength(2);
    first.emitMessage({
      type: 'result', runtimeId: values[0]!.runtimeId, instanceId: firstInstance,
      requestId: command.requestId, ok: true, messageUid: 'reconnected-uid',
    });
    await expect(pending).resolves.toBe('reconnected-uid');

    first.emitMessage({
      type: 'connection', runtimeId: values[0]!.runtimeId, instanceId: firstInstance, state: 'offline',
    });
    fixture.timers.advance(onlineTimeoutMs);
    await flush();
    expect(first.alive).toBe(false);
    expect(sibling.alive).toBe(true);
    expect(fixture.supervisor.snapshots()).toContainEqual(expect.objectContaining({
      runtimeId: values[0]!.runtimeId, state: 'backoff',
    }));
  });

  it('fences wrong identities, duplicate ready, malformed IPC, and stale-generation handlers to one worker', async () => {
    const fixture = createFixture();
    const first = binding(0);
    const second = binding(1);
    await fixture.supervisor.reconcile([first, second]);
    const oldChild = fixture.spawn.calls[0]!.child;
    const sibling = fixture.spawn.calls[1]!.child;
    const oldInstance = await activate(oldChild);
    await activate(sibling);

    oldChild.emitMessage(messageEvent(`rt_${hex(999)}`, oldInstance, 'wrong-runtime'));
    oldChild.emitMessage(messageEvent(first.runtimeId, workerInstance(sibling), 'wrong-instance'));
    await flush();
    expect(fixture.events.filter(({ event }) => event.type === 'message')).toEqual([]);
    expect(oldChild.killCalls).toBe(0);

    oldChild.emitMessage({ type: 'ready', runtimeId: first.runtimeId, instanceId: oldInstance });
    await flush();
    expect(oldChild.killCalls).toBe(0);
    expect(oldChild.sent).toContainEqual({ type: 'shutdown' });
    expect(sibling.killCalls).toBe(0);
    expect(fixture.timers.pendingDelays()).toContain(restartBaseMs);
    fixture.timers.advance(restartBaseMs);
    await flush();
    const replacement = fixture.spawn.calls[2]!.child;
    const replacementInstance = await activate(replacement);

    oldChild.emitStaleMessage(0, messageEvent(first.runtimeId, oldInstance, 'stale'));
    await flush();
    expect(fixture.events.filter(({ event }) => event.type === 'message')).toEqual([]);
    replacement.emitMessage(messageEvent(first.runtimeId, replacementInstance, 'current'));
    await flush();
    expect(fixture.events.filter(({ event }) => event.type === 'message')).toHaveLength(1);

    replacement.emitMessage({ type: 'not-a-worker-event', secret: 'PHASE_D_MALFORMED_SENTINEL' });
    await flush();
    expect(replacement.killCalls).toBe(0);
    expect(replacement.sent).toContainEqual({ type: 'shutdown' });
    expect(sibling.connected).toBe(true);

    fixture.timers.advance(restartBaseMs * 2);
    await flush();
    const disconnectedButLive = fixture.spawn.calls.at(-1)!.child;
    await activate(disconnectedButLive);
    disconnectedButLive.dropIpc();
    await flush();
    expect(disconnectedButLive.killCalls).toBe(1);
    expect(disconnectedButLive.alive).toBe(false);
  });

  it('handles each refresh request once and returns refreshed credentials only in correlated IPC', async () => {
    const fixture = createFixture();
    const value = binding(0);
    await fixture.supervisor.reconcile([value]);
    const child = fixture.spawn.calls[0]!.child;
    const instanceId = await activate(child);
    const request = {
      type: 'refresh_required', runtimeId: value.runtimeId, instanceId, requestId: 'refresh-1',
    };
    child.emitMessage(request);
    child.emitMessage(structuredClone(request));
    await flush();
    expect(fixture.refreshed).toHaveLength(1);
    expect(workerCommands(child).filter(({ type }) => type === 'refresh_result')).toEqual([{
      type: 'refresh_result', requestId: 'refresh-1', ok: true,
      token: `PHASE_D_REFRESH_TOKEN_SENTINEL_${value.nodeId}`,
    }]);

    for (let index = 0; index < 256; index += 1) child.emitMessage({
      type: 'refresh_required', runtimeId: value.runtimeId, instanceId,
      requestId: `refresh-flood-${index}`,
    });
    child.emitStaleMessage(0, request);
    await flush();
    expect(fixture.refreshed).toHaveLength(1);
    expect(child.killCalls).toBe(0);
    expect(child.sent).toContainEqual({ type: 'shutdown' });
    expect(workerCommands(child).filter(({ type }) => type === 'refresh_result')).toHaveLength(1);

    fixture.timers.advance(restartBaseMs);
    await flush();
    const replacement = fixture.spawn.calls.at(-1)!.child;
    const replacementInstance = await activate(replacement);
    replacement.emitMessage({
      type: 'refresh_required', runtimeId: value.runtimeId,
      instanceId: replacementInstance, requestId: 'refresh-1',
    });
    await flush();
    expect(fixture.refreshed).toHaveLength(2);
    expect(workerCommands(replacement).filter(({ type }) => type === 'refresh_result')).toHaveLength(1);

    const diagnosticMaterial = JSON.stringify({
      snapshots: fixture.supervisor.snapshots(),
      events: fixture.events,
      spawn: fixture.spawn.calls.map(({ modulePath, args, options }) => ({ modulePath, args, options })),
    });
    for (const secret of [
      credential(value).token,
      credential(value).appKey,
      credential(value).serverUrl,
      `PHASE_D_REFRESH_TOKEN_SENTINEL_${value.nodeId}`,
    ]) expect(diagnosticMaterial).not.toContain(secret);
  });

  it('bounds in-flight requests, correlates every operation, times out safely, and ignores late results', async () => {
    const fixture = createFixture();
    const value = binding(0);
    await fixture.supervisor.reconcile([value]);
    const child = fixture.spawn.calls[0]!.child;
    const instanceId = await activate(child);
    const sent = track(fixture.supervisor.send(identity(value), {
      conversationType: 1, targetId: 'target-1', messageType: 'text', content: 'one',
    }));
    const receipt = track(fixture.supervisor.receipt(identity(value), {
      messageUid: 'incoming-1', senderId: 'sender-1', targetId: 'group-1',
      conversationType: 3, direction: 2,
    }));
    await expect(fixture.supervisor.joinChatroom(identity(value), {
      roomId: 'room-overflow', historyCount: 0,
    })).rejects.toMatchObject({ code: 'queue_full' });
    await flush();
    const commands = workerCommands(child);
    expect(commands.map(({ type }) => type)).toEqual(['send', 'receipt']);

    child.emitMessage({
      type: 'result', runtimeId: value.runtimeId, instanceId,
      requestId: commands[1]!.requestId, ok: true,
    });
    expect((await receipt.outcome).ok).toBe(true);
    const joined = track(fixture.supervisor.joinChatroom(identity(value), {
      roomId: 'room-1', historyCount: 0,
    }));
    await flush();
    const joinCommand = workerCommands(child).find(({ type }) => type === 'join_chatroom')!;
    child.emitMessage({
      type: 'result', runtimeId: value.runtimeId, instanceId,
      requestId: joinCommand.requestId, ok: true,
    });
    expect((await joined.outcome).ok).toBe(true);

    fixture.timers.advance(requestTimeoutMs);
    await flush();
    const timedOut = await sent.outcome;
    expect(timedOut).toMatchObject({ ok: false, error: { code: 'timeout' } });
    expect(JSON.stringify(timedOut)).not.toMatch(/PHASE_D_.*SENTINEL/);
    child.emitMessage({
      type: 'result', runtimeId: value.runtimeId, instanceId,
      requestId: commands[0]!.requestId, ok: true, messageUid: 'too-late',
    });
    await flush();
    expect(await sent.outcome).toEqual(timedOut);
  });

  it('bounds pre-online buffers, preserves order, and removes buffered requests that time out', async () => {
    const fixture = createFixture();
    const value = binding(0);
    await fixture.supervisor.reconcile([value]);
    const child = fixture.spawn.calls[0]!.child;
    const first = track(fixture.supervisor.send(identity(value), {
      conversationType: 1, targetId: 'target-1', messageType: 'text', content: 'first',
    }));
    const second = track(fixture.supervisor.joinChatroom(identity(value), {
      roomId: 'room-1', historyCount: 0,
    }));
    await expect(fixture.supervisor.receipt(identity(value), {
      messageUid: 'overflow', senderId: 'sender', targetId: 'target', conversationType: 1, direction: 2,
    })).rejects.toMatchObject({ code: 'queue_full' });
    const instanceId = await activate(child);
    const commands = workerCommands(child);
    expect(commands.map(({ type }) => type)).toEqual(['send', 'join_chatroom']);
    for (const command of commands) child.emitMessage({
      type: 'result', runtimeId: value.runtimeId, instanceId,
      requestId: command.requestId, ok: true,
    });
    expect((await first.outcome).ok).toBe(true);
    expect((await second.outcome).ok).toBe(true);

    await fixture.supervisor.restart(identity(value));
    const replacement = fixture.spawn.calls.at(-1)!.child;
    const buffered = track(fixture.supervisor.receipt(identity(value), {
      messageUid: 'will-time-out', senderId: 'sender', targetId: 'target', conversationType: 1, direction: 2,
    }));
    fixture.timers.advance(requestTimeoutMs);
    await flush();
    expect(await buffered.outcome).toMatchObject({ ok: false, error: { code: 'timeout' } });
    await activate(replacement);
    expect(workerCommands(replacement)).toEqual([]);
  });

  it('rejects only a crashed worker pending work and leaves siblings and unrelated Go-task state untouched', async () => {
    const fixture = createFixture();
    const bindings = [binding(0), binding(1), binding(2), binding(3)];
    const goTask = { state: 'running', cancelCalls: 0 };
    await fixture.supervisor.reconcile(bindings);
    const children = fixture.spawn.calls.map(({ child }) => child);
    const instances = await Promise.all(children.map(activate));
    const first = track(fixture.supervisor.send(identity(bindings[0]!), {
      conversationType: 1, targetId: 'target-1', messageType: 'text', content: 'first',
    }));
    const second = track(fixture.supervisor.send(identity(bindings[1]!), {
      conversationType: 1, targetId: 'target-2', messageType: 'text', content: 'second',
    }));
    await flush();
    children[0]!.crash();
    await flush();
    expect(await first.outcome).toMatchObject({ ok: false, error: { code: 'worker_exited' } });
    expect(second.settled()).toBe(false);
    expect(children.slice(1).every((child) => child.connected && child.killCalls === 0)).toBe(true);
    expect(goTask).toEqual({ state: 'running', cancelCalls: 0 });

    const secondCommand = workerCommands(children[1]!)[0]!;
    children[1]!.emitMessage({
      type: 'result', runtimeId: bindings[1]!.runtimeId, instanceId: instances[1],
      requestId: secondCommand.requestId, ok: true, messageUid: 'second-ok',
    });
    expect(await second.outcome).toEqual({ ok: true, value: 'second-ok' });
    fixture.timers.advance(restartBaseMs);
    await flush();
    expect(fixture.spawn.calls).toHaveLength(5);
    expect(fixture.spawn.calls.slice(1, 4).every(({ child }) => child.killCalls === 0)).toBe(true);
  });

  it('uses bounded exponential restart backoff and resets it after a stable online window', async () => {
    const fixture = createFixture();
    const value = binding(0);
    await fixture.supervisor.reconcile([value]);
    const expectedDelays = [10, 20, 40, 40];
    for (const delay of expectedDelays) {
      fixture.spawn.calls.at(-1)!.child.crash();
      await flush();
      expect(fixture.timers.pendingDelays()).toEqual([delay]);
      fixture.timers.advance(delay);
      await flush();
    }
    expect(fixture.spawn.calls).toHaveLength(5);
    await activate(fixture.spawn.calls.at(-1)!.child);
    fixture.timers.advance(stableWindowMs);
    await flush();
    expect(fixture.supervisor.snapshots()[0]).toMatchObject({ restartCount: 0, state: 'online' });

    fixture.spawn.calls.at(-1)!.child.crash();
    await flush();
    expect(fixture.timers.pendingDelays()).toEqual([restartBaseMs]);
    expect(fixture.supervisor.snapshots()[0]).toMatchObject({ restartCount: 1, state: 'backoff' });

    let requestSchedules = 0;
    const timerFailure = createFixture({
      setTimeout: () => {
        requestSchedules += 1;
        if (requestSchedules <= 2) return 80_000 + requestSchedules;
        throw new Error('PHASE_D_TIMER_FAILURE_SENTINEL');
      },
    });
    const timerBinding = binding(8);
    await timerFailure.supervisor.reconcile([timerBinding]);
    const rejected = await track(timerFailure.supervisor.send(identity(timerBinding), {
      conversationType: 1, targetId: 'target', messageType: 'text', content: 'buffered',
    })).outcome;
    expect(rejected).toMatchObject({ ok: false, error: { code: 'timer_failed' } });
    expect(JSON.stringify(rejected)).not.toContain('PHASE_D_TIMER_FAILURE_SENTINEL');
    expect(() => timerFailure.spawn.calls[0]!.child.crash()).not.toThrow();
    expect(timerFailure.supervisor.snapshots()[0]).toMatchObject({ state: 'backoff' });

    let lifecycleSchedules = 0;
    const lifecycleTimerFailure = createFixture({
      setTimeout: () => {
        lifecycleSchedules += 1;
        if (lifecycleSchedules <= 2) return 90_000 + lifecycleSchedules;
        throw new Error('PHASE_D_TIMER_FAILURE_SENTINEL');
      },
    });
    await lifecycleTimerFailure.supervisor.reconcile([timerBinding]);
    const lifecycleChild = lifecycleTimerFailure.spawn.calls[0]!.child;
    await expect(activate(lifecycleChild)).resolves.toBe(workerInstance(lifecycleChild));
    expect(lifecycleChild.alive).toBe(false);
    expect(lifecycleTimerFailure.supervisor.snapshots()[0]).toMatchObject({
      state: 'backoff', restartCount: 1,
    });
  });

  it('cancels a scheduled restart when its binding is disabled', async () => {
    const fixture = createFixture();
    const value = binding(0);
    await fixture.supervisor.reconcile([value]);
    fixture.spawn.calls[0]!.child.crash();
    await flush();
    expect(fixture.timers.pendingDelays()).toEqual([restartBaseMs]);

    await fixture.supervisor.reconcile([{ ...value, enabled: false }]);
    expect(fixture.timers.pendingDelays()).toEqual([]);
    fixture.timers.advance(restartMaxMs * 10);
    await flush();
    expect(fixture.spawn.calls).toHaveLength(1);
    expect(fixture.supervisor.snapshots()).toEqual([]);
  });

  it('offers bounded graceful shutdown before IPC disconnect and contains it to the target worker', async () => {
    const shutdownGraceMs = 9;
    const fixture = createFixture({ shutdownGraceMs, terminateGraceMs: 10, killGraceMs: 20 });
    const values = [binding(0), binding(1), binding(2)];
    await fixture.supervisor.reconcile(values);
    const [preInit, onlineHung, sibling] = fixture.spawn.calls.map(({ child }) => child);
    preInit!.exitOnShutdown = true;
    onlineHung!.exitOnShutdown = false;
    await activate(onlineHung!);
    await activate(sibling!);

    await expect(fixture.supervisor.stop(identity(values[0]!))).resolves.toBeUndefined();
    expect(preInit!.sent).toContainEqual({ type: 'shutdown' });
    expect(preInit!.shutdownErrorListenerCounts).toEqual([1]);
    expect(preInit!.disconnectCalls).toBe(0);
    expect(preInit!.killSignals).toEqual([]);
    expect(preInit!.listeners.get('error')?.size ?? 0).toBe(0);

    const stopped = track(fixture.supervisor.stop(identity(values[1]!)));
    await flush();
    expect(onlineHung!.sent).toContainEqual({ type: 'shutdown' });
    expect(onlineHung!.shutdownErrorListenerCounts).toEqual([1]);
    expect(onlineHung!.disconnectCalls).toBe(0);
    expect(onlineHung!.killSignals).toEqual([]);
    expect(stopped.settled()).toBe(false);
    expect(sibling!.alive).toBe(true);

    fixture.timers.advance(shutdownGraceMs - 1);
    await flush();
    expect(onlineHung!.disconnectCalls).toBe(0);
    expect(onlineHung!.killSignals).toEqual([]);
    fixture.timers.advance(1);
    await flush();
    expect(await stopped.outcome).toEqual({ ok: true, value: undefined });
    expect(onlineHung!.disconnectCalls).toBe(1);
    expect(onlineHung!.killSignals).toEqual(['SIGTERM']);
    expect(onlineHung!.listeners.get('error')?.size ?? 0).toBe(0);
    expect(sibling!.alive).toBe(true);
  });

  it('waits for delayed process exit before stop and global disposal settle', async () => {
    const fixture = createFixture({ shutdownGraceMs: 5, terminateGraceMs: 10, killGraceMs: 20 });
    const bindings = [binding(0), binding(1)];
    await fixture.supervisor.reconcile(bindings);
    const [stoppedChild, disposedChild] = fixture.spawn.calls.map(({ child }) => child);
    stoppedChild!.exitOnSigterm = false;
    disposedChild!.exitOnSigterm = false;
    stoppedChild!.exitOnShutdown = false;
    disposedChild!.exitOnShutdown = false;

    const stopped = track(fixture.supervisor.stop(identity(bindings[0]!)));
    await flush();
    expect(stopped.settled()).toBe(false);
    fixture.timers.advance(5);
    await flush();
    expect(stoppedChild!.killSignals).toEqual(['SIGTERM']);
    stoppedChild!.reap();
    await flush();
    expect(await stopped.outcome).toEqual({ ok: true, value: undefined });
    expect(fixture.supervisor.snapshots()).toContainEqual(expect.objectContaining({
      runtimeId: bindings[0]!.runtimeId, state: 'stopped',
    }));

    const disposed = track(fixture.supervisor.dispose());
    await flush();
    expect(disposed.settled()).toBe(false);
    fixture.timers.advance(5);
    await flush();
    expect(disposedChild!.killSignals).toEqual(['SIGTERM']);
    disposedChild!.reap();
    await flush();
    expect(await disposed.outcome).toEqual({ ok: true, value: undefined });
    expect(fixture.timers.pendingDelays()).toEqual([]);
  });

  it('coalesces concurrent explicit restarts into one replacement', async () => {
    const fixture = createFixture();
    const value = binding(0);
    await fixture.supervisor.reconcile([value]);
    await activate(fixture.spawn.calls[0]!.child);

    const first = fixture.supervisor.restart(identity(value));
    const second = fixture.supervisor.restart(identity(value));
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(fixture.spawn.calls).toHaveLength(2);
    expect(fixture.spawn.calls.flatMap(({ child }) => child.sent)
      .filter((command) => (command as { type?: string }).type === 'shutdown')).toHaveLength(1);
  });

  it('never starts a replacement before delayed exit on restart or credential change', async () => {
    const fixture = createFixture({ shutdownGraceMs: 5, terminateGraceMs: 10, killGraceMs: 20 });
    const value = binding(0);
    await fixture.supervisor.reconcile([value]);
    const original = fixture.spawn.calls[0]!.child;
    original.exitOnSigterm = false;
    original.exitOnShutdown = false;

    const changed = { ...value, tokenRef: `rc_${hex(999)}` };
    const reconciled = track(fixture.supervisor.reconcile([changed]));
    await flush();
    expect(reconciled.settled()).toBe(false);
    expect(fixture.spawn.calls).toHaveLength(1);
    expect(original.alive).toBe(true);
    original.reap();
    await flush();
    expect(await reconciled.outcome).toEqual({ ok: true, value: undefined });
    expect(fixture.spawn.calls).toHaveLength(2);
    const credentialReplacement = fixture.spawn.calls[1]!.child;
    expect(original.alive).toBe(false);
    expect(credentialReplacement.alive).toBe(true);

    credentialReplacement.exitOnSigterm = false;
    credentialReplacement.exitOnShutdown = false;
    const restarted = track(fixture.supervisor.restart(identity(changed)));
    await flush();
    expect(restarted.settled()).toBe(false);
    expect(fixture.spawn.calls).toHaveLength(2);
    credentialReplacement.reap();
    await flush();
    expect(await restarted.outcome).toEqual({ ok: true, value: undefined });
    expect(fixture.spawn.calls).toHaveLength(3);
    expect(fixture.spawn.calls.filter(({ child }) => child.alive)).toHaveLength(1);
  });

  it('fails explicit restart safely without replacement when KILL is not reaped', async () => {
    const fixture = createFixture({ shutdownGraceMs: 5, terminateGraceMs: 10, killGraceMs: 20 });
    const value = binding(0);
    await fixture.supervisor.reconcile([value]);
    const child = fixture.spawn.calls[0]!.child;
    child.exitOnSigterm = false;
    child.exitOnSigkill = false;
    child.exitOnShutdown = false;
    const restarted = track(fixture.supervisor.restart(identity(value)));
    await flush();
    expect(restarted.settled()).toBe(false);
    expect(fixture.spawn.calls).toHaveLength(1);
    fixture.timers.advance(5);
    await flush();
    fixture.timers.advance(10);
    await flush();
    fixture.timers.advance(20);
    await flush();
    expect(await restarted.outcome).toMatchObject({ ok: false, error: { code: 'worker_exited' } });
    expect(fixture.spawn.calls).toHaveLength(1);
    expect(fixture.supervisor.snapshots()[0]).toMatchObject({ state: 'backoff' });
    expect(fixture.timers.pendingDelays()).toEqual([]);
    child.reap();
    fixture.timers.advance(restartMaxMs * 10);
    await flush();
    expect(fixture.spawn.calls).toHaveLength(1);
  });

  it('fails credential-change reconcile safely without replacement when KILL is not reaped', async () => {
    const fixture = createFixture({ shutdownGraceMs: 5, terminateGraceMs: 10, killGraceMs: 20 });
    const value = binding(0);
    await fixture.supervisor.reconcile([value]);
    const child = fixture.spawn.calls[0]!.child;
    child.exitOnSigterm = false;
    child.exitOnSigkill = false;
    child.exitOnShutdown = false;
    const changed = track(fixture.supervisor.reconcile([{
      ...value, tokenRef: `rc_${hex(997)}`,
    }]));
    await flush();
    expect(changed.settled()).toBe(false);
    expect(fixture.spawn.calls).toHaveLength(1);
    fixture.timers.advance(5);
    await flush();
    fixture.timers.advance(10);
    await flush();
    fixture.timers.advance(20);
    await flush();
    expect(await changed.outcome).toMatchObject({ ok: false, error: { code: 'worker_exited' } });
    expect(fixture.spawn.calls).toHaveLength(1);
    expect(fixture.supervisor.snapshots()[0]).toMatchObject({ state: 'backoff' });
    expect(fixture.timers.pendingDelays()).toEqual([]);
    child.reap();
    fixture.timers.advance(restartMaxMs * 10);
    await flush();
    expect(fixture.spawn.calls).toHaveLength(1);
  });

  it('escalates TERM to KILL with finite deadlines and contains timer failures safely', async () => {
    const fixture = createFixture({ shutdownGraceMs: 5, terminateGraceMs: 10, killGraceMs: 20 });
    const value = binding(0);
    await fixture.supervisor.reconcile([value]);
    const child = fixture.spawn.calls[0]!.child;
    child.exitOnSigterm = false;
    child.exitOnSigkill = false;
    child.exitOnShutdown = false;
    const stopped = track(fixture.supervisor.stop(identity(value)));
    await flush();
    expect(stopped.settled()).toBe(false);
    fixture.timers.advance(5);
    await flush();
    expect(child.killSignals).toEqual(['SIGTERM']);
    expect(fixture.timers.pendingDelays()).toEqual([10]);

    fixture.timers.advance(10);
    await flush();
    expect(stopped.settled()).toBe(false);
    expect(child.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(fixture.timers.pendingDelays()).toEqual([20]);
    fixture.timers.advance(20);
    await flush();
    expect(await stopped.outcome).toMatchObject({ ok: false, error: { code: 'worker_exited' } });
    expect(fixture.supervisor.snapshots()[0]).toMatchObject({ state: 'stopped' });
    expect(fixture.timers.pendingDelays()).toEqual([]);
    await expect(fixture.supervisor.restart(identity(value))).rejects.toMatchObject({ code: 'worker_exited' });
    child.reap();
    await fixture.supervisor.restart(identity(value));
    expect(fixture.spawn.calls).toHaveLength(2);

    let timerSchedules = 0;
    const timerFailure = createFixture({
      shutdownGraceMs: 5,
      terminateGraceMs: 10,
      killGraceMs: 20,
      setTimeout: () => {
        timerSchedules += 1;
        if (timerSchedules <= 2) return 99_999 + timerSchedules;
        throw new Error('PHASE_E_REAP_TIMER_SENTINEL');
      },
    });
    const timerBinding = binding(8);
    await timerFailure.supervisor.reconcile([timerBinding]);
    const timerChild = timerFailure.spawn.calls[0]!.child;
    timerChild.exitOnSigterm = false;
    timerChild.exitOnSigkill = false;
    timerChild.exitOnShutdown = false;
    const timerOutcome = await track(timerFailure.supervisor.stop(identity(timerBinding))).outcome;
    expect(timerOutcome).toMatchObject({ ok: false, error: { code: 'worker_exited' } });
    expect(timerChild.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(timerFailure.supervisor.snapshots()[0]).toMatchObject({ state: 'stopped' });
    expect(JSON.stringify(timerOutcome)).not.toContain('PHASE_E_REAP_TIMER_SENTINEL');
    timerChild.reap();
  });

  it('bounds disposal of an unreaped child and never resurrects it after a late exit', async () => {
    const fixture = createFixture({ shutdownGraceMs: 5, terminateGraceMs: 10, killGraceMs: 20 });
    const value = binding(0);
    await fixture.supervisor.reconcile([value]);
    const child = fixture.spawn.calls[0]!.child;
    child.exitOnSigterm = false;
    child.exitOnSigkill = false;
    child.exitOnShutdown = false;
    const disposed = track(fixture.supervisor.dispose());
    await flush();
    expect(disposed.settled()).toBe(false);
    fixture.timers.advance(5);
    await flush();
    fixture.timers.advance(10);
    await flush();
    fixture.timers.advance(20);
    await flush();
    expect(await disposed.outcome).toMatchObject({ ok: false, error: { code: 'worker_exited' } });
    expect(fixture.supervisor.snapshots()).toEqual([]);
    expect(fixture.timers.pendingDelays()).toEqual([]);
    expect(child.listeners.get('exit')?.size).toBe(1);
    child.reap();
    expect(child.listeners.get('exit')?.size ?? 0).toBe(0);
    fixture.timers.advance(restartMaxMs * 10);
    await flush();
    expect(fixture.spawn.calls).toHaveLength(1);
    expect(fixture.timers.pendingDelays()).toEqual([]);
  });

  it('retains binding ownership across unreaped removal and permits re-add only after late exit', async () => {
    const fixture = createFixture({ shutdownGraceMs: 5, terminateGraceMs: 10, killGraceMs: 20 });
    const value = binding(0);
    await fixture.supervisor.reconcile([value]);
    const child = fixture.spawn.calls[0]!.child;
    child.exitOnSigterm = false;
    child.exitOnSigkill = false;
    child.exitOnShutdown = false;
    const removed = track(fixture.supervisor.reconcile([]));
    await flush();
    expect(removed.settled()).toBe(false);
    fixture.timers.advance(5);
    await flush();
    fixture.timers.advance(10);
    await flush();
    fixture.timers.advance(20);
    await flush();
    expect(await removed.outcome).toMatchObject({ ok: false, error: { code: 'worker_exited' } });
    expect(fixture.spawn.calls).toHaveLength(1);
    expect(fixture.supervisor.snapshots()).toEqual([expect.objectContaining({
      runtimeId: value.runtimeId,
      nodeId: value.nodeId,
      state: 'stopped',
    })]);

    await expect(fixture.supervisor.reconcile([value])).rejects.toMatchObject({ code: 'worker_exited' });
    expect(fixture.spawn.calls).toHaveLength(1);
    expect(child.alive).toBe(true);
    child.reap();
    await flush();
    expect(fixture.spawn.calls).toHaveLength(1);

    await fixture.supervisor.reconcile([value]);
    expect(fixture.spawn.calls).toHaveLength(2);
    expect(fixture.spawn.calls[1]!.child.alive).toBe(true);
  });

  it('honors a concurrent re-add after the removing child exits without losing key ownership', async () => {
    const fixture = createFixture({ terminateGraceMs: 10, killGraceMs: 20 });
    const value = binding(0);
    await fixture.supervisor.reconcile([value]);
    const child = fixture.spawn.calls[0]!.child;
    child.exitOnSigterm = false;
    child.exitOnShutdown = false;

    const removed = track(fixture.supervisor.reconcile([]));
    await flush();
    const readded = track(fixture.supervisor.reconcile([value]));
    await flush();
    expect(removed.settled()).toBe(false);
    expect(readded.settled()).toBe(false);
    expect(fixture.spawn.calls).toHaveLength(1);
    expect(fixture.supervisor.snapshots()).toHaveLength(1);

    child.reap();
    await flush();
    expect(await removed.outcome).toEqual({ ok: true, value: undefined });
    expect(await readded.outcome).toEqual({ ok: true, value: undefined });
    expect(fixture.spawn.calls).toHaveLength(2);
    expect(fixture.spawn.calls[1]!.child.alive).toBe(true);
  });

  it('does not wait a reap grace period or double-kill when exit already occurred', async () => {
    const fixture = createFixture({ terminateGraceMs: 11, killGraceMs: 21 });
    const value = binding(0);
    await fixture.supervisor.reconcile([value]);
    const child = fixture.spawn.calls[0]!.child;
    child.crash();
    child.emitFault('error');
    child.emitFault('disconnect');
    await flush();
    expect(child.killCalls).toBeLessThanOrEqual(1);
    expect(fixture.timers.pendingDelays()).toEqual([restartBaseMs]);
    expect(fixture.timers.scheduled).toEqual([15_000, 20_000, restartBaseMs]);
    expect(fixture.supervisor.snapshots()[0]).toMatchObject({ state: 'backoff', restartCount: 1 });
  });

  it('supports isolated stop/restart and global disposal without touching unrelated state', async () => {
    const fixture = createFixture();
    const bindings = [binding(0), binding(1), binding(2), binding(3)];
    const goTask = { state: 'running', cancelCalls: 0 };
    await fixture.supervisor.reconcile(bindings);
    await Promise.all(fixture.spawn.calls.map(({ child }) => activate(child)));

    await fixture.supervisor.stop(identity(bindings[0]!));
    expect(fixture.spawn.calls[0]!.child.connected).toBe(false);
    expect(fixture.spawn.calls[0]!.child.alive).toBe(false);
    expect(fixture.spawn.calls.slice(1, 4).filter(({ child }) => child.connected)).toHaveLength(3);
    expect(goTask).toEqual({ state: 'running', cancelCalls: 0 });

    const previousSecond = fixture.spawn.calls[1]!.child;
    await fixture.supervisor.restart(identity(bindings[1]!));
    expect(previousSecond.connected).toBe(false);
    expect(fixture.spawn.calls).toHaveLength(5);
    await activate(fixture.spawn.calls[4]!.child);
    const pending = track(fixture.supervisor.send(identity(bindings[2]!), {
      conversationType: 1, targetId: 'target', messageType: 'text', content: 'pending',
    }));
    await flush();

    await fixture.supervisor.dispose();
    expect(await pending.outcome).toMatchObject({ ok: false, error: { code: 'worker_exited' } });
    expect(fixture.spawn.calls.every(({ child }) => !child.connected)).toBe(true);
    expect(fixture.spawn.calls.every(({ child }) => !child.alive)).toBe(true);
    expect(fixture.timers.pendingDelays()).toEqual([]);
    expect(goTask).toEqual({ state: 'running', cancelCalls: 0 });
    await expect(fixture.supervisor.send(identity(bindings[3]!), {
      conversationType: 1, targetId: 'target', messageType: 'text', content: 'after-dispose',
    })).rejects.toMatchObject({ code: 'worker_exited' });
  });

  it('returns detached non-secret snapshots with only the documented diagnostic fields', async () => {
    const fixture = createFixture();
    const value = binding(0);
    await fixture.supervisor.reconcile([value]);
    const instanceId = await activate(fixture.spawn.calls[0]!.child);
    const snapshots = fixture.supervisor.snapshots();
    expect(snapshots).toEqual([{
      runtimeId: value.runtimeId,
      nodeId: value.nodeId,
      state: 'online',
      instanceId,
      restartCount: 0,
    }]);
    expect(Object.keys(snapshots[0]!).sort()).toEqual([
      'instanceId', 'nodeId', 'restartCount', 'runtimeId', 'state',
    ]);
    const serialized = JSON.stringify(snapshots);
    for (const secret of [
      value.tokenRef, value.storageDir, credential(value).appKey,
      credential(value).token, credential(value).serverUrl,
    ]) expect(serialized).not.toContain(secret);

    (snapshots[0] as WorkerSnapshot).runtimeId = 'mutated';
    (snapshots[0] as WorkerSnapshot).state = 'mutated';
    expect(fixture.supervisor.snapshots()[0]).toMatchObject({
      runtimeId: value.runtimeId, state: 'online', instanceId,
    });
  });
});
