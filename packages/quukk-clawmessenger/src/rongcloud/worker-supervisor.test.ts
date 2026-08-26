// @vitest-environment node

import { beforeAll, describe, expect, it } from 'vitest';

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

beforeAll(async () => {
  supervisorModule = await import('./worker-supervisor.js')
    .then((module) => module as unknown as SupervisorModule)
    .catch(() => undefined);
});

function supervisorApi(): SupervisorModule {
  expect(supervisorModule, 'Phase D worker supervisor implementation is missing').toBeDefined();
  return supervisorModule!;
}

async function flush(): Promise<void> {
  for (let index = 0; index < 16; index += 1) await Promise.resolve();
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
    return true;
  }

  kill(signal = 'SIGTERM'): boolean {
    this.killCalls += 1;
    if (!this.alive) return false;
    this.alive = false;
    this.connected = false;
    this.emit('exit', 0, signal);
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
    this.alive = false;
    this.connected = false;
    this.emit('exit', code, null);
  }

  dropIpc(): void {
    if (!this.alive || !this.connected) return;
    this.connected = false;
    this.emit('disconnect');
  }

  emitStaleMessage(listenerIndex: number, message: unknown): void {
    this.messageListenerHistory[listenerIndex]?.(message);
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
  return {
    runtimeId: `rt_${hex(index + 1)}`,
    nodeId: `node-${index + 1}`,
    enabled: true,
    tokenRef: `rc_${hex(index + 101)}`,
    storageDir: `D:\\worker-storage\\${index + 1}`,
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
  binding: { runtimeId: string; nodeId: string };
  token: string;
} {
  const command = child.sent.find((value) => (value as { type?: string }).type === 'init');
  expect(command).toBeDefined();
  const parsed = parseWorkerCommand(command);
  expect(parsed.ok).toBe(true);
  return command as {
    binding: { runtimeId: string; nodeId: string };
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
    await fixture.supervisor.reconcile([
      binding(0, { runtimeId: sharedRuntime, nodeId: 'node-a' }),
      binding(1, { runtimeId: sharedRuntime, nodeId: 'node-b' }),
    ]);
    expect(fixture.spawn.calls).toHaveLength(2);
    expect(new Set(fixture.spawn.calls.map((call) => call.child.pid)).size).toBe(2);
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
    expect(oldChild.killCalls).toBe(1);
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
    expect(replacement.killCalls).toBe(1);
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
    expect(child.killCalls).toBe(1);
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

    const timerFailure = createFixture({
      setTimeout: () => { throw new Error('PHASE_D_TIMER_FAILURE_SENTINEL'); },
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

    const lifecycleTimerFailure = createFixture({
      setTimeout: () => { throw new Error('PHASE_D_TIMER_FAILURE_SENTINEL'); },
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
