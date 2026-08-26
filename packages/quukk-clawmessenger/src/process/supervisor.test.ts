import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import { BridgeClientError } from '../go/client.js';
import type { BridgeHealth, BridgeTaskPort } from '../go/types.js';
import {
  BridgeProcessIdentityStore,
  type BridgeProcessIdentity,
  type BridgeProcessIdentityDependencies,
  type BridgeProcessIdentityPersistence,
} from './identity.js';
import {
  BridgeSupervisor,
  BridgeSupervisorError,
  type BridgeSupervisorDependencies,
  type BridgeSupervisorStore,
  type RunningBridge,
} from './supervisor.js';

const version = '0.1.0-beta.1';
const secret = 'bridge-secret-sentinel';
const installId = 'install-id-sentinel';
const binaryPath = 'D:\\sensitive\\multica.exe';
const startedAt = '2026-08-26T08:00:00.000000123Z';
const instanceId = `br_${'a'.repeat(32)}`;

function identity(overrides: Partial<BridgeProcessIdentity> = {}): BridgeProcessIdentity {
  return {
    schema_version: 1,
    address: '127.0.0.1:49152',
    pid: 4321,
    version,
    instance_id: instanceId,
    started_at: startedAt,
    ...overrides,
  };
}

function health(overrides: Partial<BridgeHealth> = {}): BridgeHealth {
  return {
    status: 'ok',
    version,
    pid: 4321,
    instance_id: instanceId,
    started_at: startedAt,
    probe_status: 'ready',
    ...overrides,
  };
}

class FakeChild extends EventEmitter {
  readonly pid = 4321;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;

  exit(code = 0): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.stdout.end();
    this.stderr.end();
    this.emit('exit', code, null);
  }
}

class MemoryIdentityStore implements BridgeProcessIdentityPersistence {
  value: BridgeProcessIdentity | undefined;
  readonly writes: BridgeProcessIdentity[] = [];
  readonly removals: BridgeProcessIdentity[] = [];
  readError: unknown;

  async read(): Promise<BridgeProcessIdentity | undefined> {
    if (this.readError !== undefined) throw this.readError;
    return this.value === undefined ? undefined : { ...this.value };
  }

  async write(value: BridgeProcessIdentity): Promise<void> {
    this.value = { ...value };
    this.writes.push({ ...value });
  }

  async removeIfMatches(expected: BridgeProcessIdentity): Promise<boolean> {
    this.removals.push({ ...expected });
    if (JSON.stringify(this.value) !== JSON.stringify(expected)) return false;
    this.value = undefined;
    return true;
  }
}

function store(overrides: Partial<BridgeSupervisorStore> = {}): BridgeSupervisorStore {
  return {
    assertExternalMutationAllowed: vi.fn(),
    bridgeIdentity: () => ({ installId, secret }),
    snapshot: async () => ({
      config: { providerPathOverrides: { opencode: 'D:\\agents\\opencode.exe' } },
    }),
    ...overrides,
  };
}

type FakeClient = {
  health: ReturnType<typeof vi.fn<() => Promise<BridgeHealth>>>;
  shutdown: ReturnType<typeof vi.fn<() => Promise<void>>>;
};

function fakeClient(): FakeClient {
  return {
    health: vi.fn(async () => health()),
    shutdown: vi.fn(async () => undefined),
  };
}

function dependencies(
  child: FakeChild,
  client: FakeClient,
  overrides: Partial<BridgeSupervisorDependencies> = {},
): BridgeSupervisorDependencies {
  return {
    version,
    environment: { PATH: 'D:\\safe-path', PROVIDER_TOKEN: 'provider-auth-preserved' },
    resolveBinary: async () => ({
      path: binaryPath,
      packageName: '@quukk/clawmessenger-runtime-win32-x64',
      version,
      sha256: 'b'.repeat(64),
    }),
    spawn: vi.fn(() => child as never),
    clientFactory: vi.fn(() => client as never),
    sleep: async () => undefined,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    waitForCurrentExit: async () => child.exitCode !== null,
    waitForRecoveredExit: async () => false,
    forceTerminate: vi.fn(async () => undefined),
    startupTimeoutMs: 60_000,
    healthRetryDelayMs: 50,
    shutdownGraceMs: 7_000,
    ...overrides,
  };
}

function readinessLine(overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    address: '127.0.0.1:49152',
    pid: 4321,
    version,
    instance_id: instanceId,
    started_at: startedAt,
    ...overrides,
  })}\n`;
}

function startReady(child: FakeChild, value = readinessLine()): void {
  queueMicrotask(() => child.stdout.write(value));
}

describe('BridgeProcessIdentityStore', () => {
  it('uses only bridge.pid with strict bounded atomic JSON and compare-before-delete', async () => {
    const writes: Array<{ path: string; value: unknown }> = [];
    const reads: Array<{ path: string; maximumBytes: number }> = [];
    const unlinks: string[] = [];
    let disk: unknown;
    const dependencies: BridgeProcessIdentityDependencies = {
      read: async (path, maximumBytes) => {
        reads.push({ path, maximumBytes });
        return disk;
      },
      write: async (path, value) => {
        writes.push({ path, value });
        disk = value;
      },
      unlink: async (path) => {
        unlinks.push(path);
        disk = undefined;
      },
    };
    const persistence = new BridgeProcessIdentityStore({
      homeDirectory: 'D:\\fake-home',
      dependencies,
    });

    await persistence.write(identity());
    await expect(persistence.read()).resolves.toEqual(identity());
    await expect(persistence.removeIfMatches(identity({ pid: 9999 }))).resolves.toBe(false);
    await expect(persistence.removeIfMatches(identity())).resolves.toBe(true);

    expect(writes[0]?.path).toBe(
      'D:\\fake-home\\.quukk-clawmessenger\\run\\bridge.pid',
    );
    expect(reads.every((entry) => entry.path.endsWith('bridge.pid'))).toBe(true);
    expect(reads.every((entry) => entry.maximumBytes === 16_384)).toBe(true);
    expect(unlinks).toEqual(['D:\\fake-home\\.quukk-clawmessenger\\run\\bridge.pid']);
    expect(JSON.stringify(writes)).not.toContain('daemon.pid');
  });

  it('fails closed on corrupt identity and never unlinks it', async () => {
    const unlink = vi.fn(async () => undefined);
    const persistence = new BridgeProcessIdentityStore({
      homeDirectory: 'D:\\fake-home',
      dependencies: {
        read: async () => ({ ...identity(), secret }),
        write: async () => undefined,
        unlink,
      },
    });
    await expect(persistence.read()).rejects.toMatchObject({ code: 'identity_corrupt' });
    await expect(persistence.removeIfMatches(identity())).rejects.toMatchObject({
      code: 'identity_corrupt',
    });
    expect(unlink).not.toHaveBeenCalled();
  });

  it('serializes compare-delete with a replacement atomic write', async () => {
    let disk: unknown = identity();
    let readStarted!: () => void;
    let allowRead!: () => void;
    const started = new Promise<void>((resolve) => { readStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { allowRead = resolve; });
    let blockNextRead = true;
    const persistence = new BridgeProcessIdentityStore({
      homeDirectory: 'D:\\fake-home',
      dependencies: {
        read: async () => {
          const captured = disk;
          if (blockNextRead) {
            blockNextRead = false;
            readStarted();
            await blocked;
          }
          return captured;
        },
        write: async (_path, value) => { disk = value; },
        unlink: async () => { disk = undefined; },
      },
    });
    const removing = persistence.removeIfMatches(identity());
    await started;
    const replacement = identity({ pid: 9876, address: '127.0.0.1:49876' });
    let writeFinished = false;
    const writing = persistence.write(replacement).then(() => { writeFinished = true; });
    await Promise.resolve();
    expect(writeFinished).toBe(false);
    allowRead();
    await Promise.all([removing, writing]);
    expect(disk).toEqual(replacement);
  });
});

describe('BridgeSupervisor startup', () => {
  it('exposes the task port required by downstream routing', () => {
    expectTypeOf<RunningBridge['client']>().toMatchTypeOf<BridgeTaskPort>();
  });

  it('spawns exact argv/options, writes bounded secret startup only to stdin, and persists the fence', async () => {
    const child = new FakeChild();
    const input: Buffer[] = [];
    child.stdin.on('data', (chunk) => input.push(Buffer.from(chunk)));
    const client = fakeClient();
    const identityStore = new MemoryIdentityStore();
    const deps = dependencies(child, client);
    startReady(child);

    const running = await new BridgeSupervisor({
      store: store(),
      identityStore,
      dependencies: deps,
    }).ensureStarted();

    expect(running.recovered).toBe(false);
    expect(deps.spawn).toHaveBeenCalledWith(binaryPath, ['daemon', 'bridge'], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: deps.environment,
      windowsHide: true,
    });
    expect(child.stdin.writableEnded).toBe(true);
    expect(JSON.parse(Buffer.concat(input).toString('utf8'))).toEqual({
      secret,
      install_id: installId,
      version,
      provider_path_overrides: { opencode: 'D:\\agents\\opencode.exe' },
    });
    expect(client.health).toHaveBeenCalledTimes(1);
    expect(identityStore.writes).toEqual([identity()]);
    const durable = JSON.stringify(identityStore.writes);
    expect(durable).not.toContain(secret);
    expect(durable).not.toContain(installId);
    expect(durable).not.toContain(binaryPath);
    expect(JSON.stringify((deps.spawn as ReturnType<typeof vi.fn>).mock.calls[0])).not.toContain(
      secret,
    );
  });

  it('rejects oversized startup before binary resolution or spawn', async () => {
    const child = new FakeChild();
    const client = fakeClient();
    const resolveBinary = vi.fn(async () => ({
      path: binaryPath,
      packageName: 'unused',
      version,
      sha256: 'b'.repeat(64),
    }));
    const spawn = vi.fn<BridgeSupervisorDependencies['spawn']>();
    const supervisor = new BridgeSupervisor({
      store: store({
        snapshot: async () => ({
          config: { providerPathOverrides: { opencode: `D:\\${'x'.repeat(70_000)}` } },
        }),
      }),
      identityStore: new MemoryIdentityStore(),
      dependencies: dependencies(child, client, { resolveBinary, spawn }),
    });
    await expect(supervisor.ensureStarted()).rejects.toMatchObject({
      code: 'startup_input_too_large',
    });
    expect(resolveBinary).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects malformed readiness framing, overflow, early EOF, exit, and timeout', async () => {
    const cases: Array<[string, (child: FakeChild) => void, Partial<BridgeSupervisorDependencies>]> = [
      ['CRLF', (child) => startReady(child, readinessLine().replace('\n', '\r\n')), {}],
      ['banner', (child) => startReady(child, `banner${readinessLine()}`), {}],
      ['same-chunk trailing', (child) => startReady(child, `${readinessLine()}x`), {}],
      ['overflow', (child) => startReady(child, `${'x'.repeat(65_536)}\n`), {}],
      ['EOF', (child) => queueMicrotask(() => child.stdout.end('{}')), {}],
      ['exit', (child) => queueMicrotask(() => child.exit(1)), {}],
      [
        'timeout',
        () => undefined,
        {
          setTimeout: ((callback: () => void) => {
            queueMicrotask(callback);
            return 1 as unknown as ReturnType<typeof setTimeout>;
          }) as typeof setTimeout,
          clearTimeout: vi.fn() as never,
        },
      ],
    ];
    for (const [name, arrange, override] of cases) {
      const child = new FakeChild();
      const forceTerminate = vi.fn(async () => undefined);
      arrange(child);
      const supervisor = new BridgeSupervisor({
        store: store(),
        identityStore: new MemoryIdentityStore(),
        dependencies: dependencies(child, fakeClient(), { forceTerminate, ...override }),
      });
      const error = (await supervisor.ensureStarted().catch((caught: unknown) => caught)) as
        | BridgeSupervisorError
        | undefined;
      expect(error, name).toBeInstanceOf(BridgeSupervisorError);
      expect(forceTerminate, name).not.toHaveBeenCalled();
    }
  });

  it('turns asynchronous child and startup-stdin errors into safe startup failures', async () => {
    for (const source of ['child', 'stdin'] as const) {
      const child = new FakeChild();
      const forceTerminate = vi.fn(async () => undefined);
      const spawn = vi.fn<BridgeSupervisorDependencies['spawn']>(() => {
        queueMicrotask(() => {
          if (source === 'child') child.emit('error', new Error('spawn-path-sentinel'));
          else child.stdin.emit('error', new Error('stdin-secret-sentinel'));
        });
        return child as never;
      });
      const supervisor = new BridgeSupervisor({
        store: store(),
        identityStore: new MemoryIdentityStore(),
        dependencies: dependencies(child, fakeClient(), { spawn, forceTerminate }),
      });
      const error = await supervisor.ensureStarted().catch((caught: unknown) => caught);
      expect(error, source).toMatchObject({ code: 'startup_failed' });
      expect(String(error), source).not.toContain('sentinel');
      expect(forceTerminate, source).not.toHaveBeenCalled();
    }
  });

  it('retries delayed health inside the startup deadline then persists exact raw time', async () => {
    const child = new FakeChild();
    const client = fakeClient();
    client.health
      .mockRejectedValueOnce(new BridgeClientError('transport_error', { retryable: true }))
      .mockResolvedValueOnce(health());
    const sleeps: number[] = [];
    const identityStore = new MemoryIdentityStore();
    startReady(child);
    await new BridgeSupervisor({
      store: store(),
      identityStore,
      dependencies: dependencies(child, client, {
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
        },
      }),
    }).ensureStarted();
    expect(sleeps).toEqual([50]);
    expect(identityStore.value?.started_at).toBe(startedAt);
  });

  it('rejects every current-child health fence mismatch without persistence or force', async () => {
    const mismatches: BridgeHealth[] = [
      health({ pid: 9999 }),
      health({ version: '9.9.9' }),
      health({ instance_id: `br_${'b'.repeat(32)}` }),
      health({ started_at: '2026-08-26T08:00:01Z' }),
    ];
    for (const mismatch of mismatches) {
      const child = new FakeChild();
      const client = fakeClient();
      client.health.mockResolvedValue(mismatch);
      const identityStore = new MemoryIdentityStore();
      const forceTerminate = vi.fn(async () => undefined);
      startReady(child);
      await expect(
        new BridgeSupervisor({
          store: store(),
          identityStore,
          dependencies: dependencies(child, client, { forceTerminate }),
        }).ensureStarted(),
      ).rejects.toMatchObject({ code: 'identity_mismatch' });
      expect(identityStore.writes).toHaveLength(0);
      expect(forceTerminate).not.toHaveBeenCalled();
    }
  });
});

describe('BridgeSupervisor recovery and stop', () => {
  it('reuses an exact authenticated recovered identity without resolving or spawning', async () => {
    const child = new FakeChild();
    const client = fakeClient();
    const identityStore = new MemoryIdentityStore();
    identityStore.value = identity();
    const resolveBinary = vi.fn();
    const spawn = vi.fn<BridgeSupervisorDependencies['spawn']>();
    const snapshot = vi.fn(async () => { throw new Error('invalid-fresh-config'); });
    const assertExternalMutationAllowed = vi.fn(() => { throw new Error('recovery-required'); });
    const running = await new BridgeSupervisor({
      store: store({ snapshot, assertExternalMutationAllowed }),
      identityStore,
      dependencies: dependencies(child, client, { resolveBinary, spawn }),
    }).ensureStarted();
    expect(running.recovered).toBe(true);
    expect(resolveBinary).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(snapshot).not.toHaveBeenCalled();
    expect(assertExternalMutationAllowed).not.toHaveBeenCalled();
  });

  it('fails closed on corrupt or mismatched recovered identity with zero spawn and kill calls', async () => {
    const cases: Array<[string, unknown, BridgeHealth]> = [
      ['corrupt', new Error('identity-corrupt-sentinel'), health()],
      ['pid', undefined, health({ pid: 9999 })],
      ['version', undefined, health({ version: '9.9.9' })],
      ['started_at', undefined, health({ started_at: '2026-08-26T08:00:01Z' })],
      ['instance', undefined, health({ instance_id: `br_${'b'.repeat(32)}` })],
    ];
    for (const [name, readError, gotHealth] of cases) {
      const child = new FakeChild();
      const client = fakeClient();
      client.health.mockResolvedValue(gotHealth);
      const identityStore = new MemoryIdentityStore();
      identityStore.value = identity();
      identityStore.readError = readError;
      const spawn = vi.fn<BridgeSupervisorDependencies['spawn']>();
      const forceTerminate = vi.fn(async () => undefined);
      const supervisor = new BridgeSupervisor({
        store: store(),
        identityStore,
        dependencies: dependencies(child, client, { spawn, forceTerminate }),
      });
      await expect(supervisor.ensureStarted(), name).rejects.toBeInstanceOf(
        BridgeSupervisorError,
      );
      expect(spawn, name).not.toHaveBeenCalled();
      expect(forceTerminate, name).not.toHaveBeenCalled();
    }
  });

  it('removes unavailable stale identity without killing its PID and starts a replacement', async () => {
    const child = new FakeChild();
    const client = fakeClient();
    client.health
      .mockRejectedValueOnce(new BridgeClientError('transport_error', { retryable: true }))
      .mockResolvedValueOnce(health());
    const identityStore = new MemoryIdentityStore();
    identityStore.value = identity();
    const forceTerminate = vi.fn(async () => undefined);
    startReady(child);
    const running = await new BridgeSupervisor({
      store: store(),
      identityStore,
      dependencies: dependencies(child, client, { forceTerminate }),
    }).ensureStarted();
    expect(running.recovered).toBe(false);
    expect(forceTerminate).not.toHaveBeenCalled();
    expect(identityStore.writes).toHaveLength(1);
  });

  it('does not spawn when compare-removing a stale identity loses to a replacement', async () => {
    const child = new FakeChild();
    const client = fakeClient();
    client.health.mockRejectedValueOnce(
      new BridgeClientError('transport_error', { retryable: true }),
    );
    const identityStore = new MemoryIdentityStore();
    identityStore.value = identity();
    const replacement = identity({ pid: 9876, address: '127.0.0.1:49876' });
    vi.spyOn(identityStore, 'removeIfMatches').mockImplementation(async () => {
      identityStore.value = replacement;
      return false;
    });
    const spawn = vi.fn<BridgeSupervisorDependencies['spawn']>();
    const supervisor = new BridgeSupervisor({
      store: store(),
      identityStore,
      dependencies: dependencies(child, client, { spawn }),
    });
    await expect(supervisor.ensureStarted()).rejects.toMatchObject({ code: 'process_unverified' });
    expect(spawn).not.toHaveBeenCalled();
    expect(identityStore.value).toEqual(replacement);
  });

  it('revokes a fresh generation if health fails or stdout changes during persistence', async () => {
    for (const mode of ['health', 'write'] as const) {
      const child = new FakeChild();
      const client = fakeClient();
      const identityStore = new MemoryIdentityStore();
      let lifecycle: AbortSignal | undefined;
      if (mode === 'health') {
        client.health.mockRejectedValueOnce(new BridgeClientError('response_invalid'));
      } else {
        vi.spyOn(identityStore, 'write').mockImplementation(async (value) => {
          identityStore.value = { ...value };
          child.stdout.write('unexpected-during-write');
        });
      }
      startReady(child);
      const base = dependencies(child, client);
      const supervisor = new BridgeSupervisor({
        store: store(),
        identityStore,
        dependencies: {
          ...base,
          clientFactory: vi.fn((options) => {
            lifecycle = options.lifecycleSignal;
            return client as never;
          }),
        },
      });
      await expect(supervisor.ensureStarted(), mode).rejects.toBeInstanceOf(BridgeSupervisorError);
      expect(lifecycle?.aborted, mode).toBe(true);
      if (mode === 'write') expect(identityStore.value, mode).toBeUndefined();
    }
  });

  it('gracefully shuts down then force-terminates only a freshly reverified current child', async () => {
    const child = new FakeChild();
    const client = fakeClient();
    const identityStore = new MemoryIdentityStore();
    const forceTerminate = vi.fn(async () => child.exit(1));
    startReady(child);
    const supervisor = new BridgeSupervisor({
      store: store(),
      identityStore,
      dependencies: dependencies(child, client, {
        waitForCurrentExit: async () => false,
        forceTerminate,
      }),
    });
    await supervisor.ensureStarted();
    await supervisor.stop();
    expect(client.shutdown).toHaveBeenCalledTimes(1);
    expect(client.health).toHaveBeenCalledTimes(3);
    expect(forceTerminate).toHaveBeenCalledTimes(1);
    expect(identityStore.value).toBeUndefined();
  });

  it('revokes current-child force authority on every final health mismatch', async () => {
    const mismatches = [
      health({ pid: 9999 }),
      health({ version: '9.9.9' }),
      health({ instance_id: `br_${'b'.repeat(32)}` }),
      health({ started_at: '2026-08-26T08:00:01Z' }),
    ];
    for (const mismatch of mismatches) {
      const child = new FakeChild();
      const client = fakeClient();
      client.health
        .mockResolvedValueOnce(health())
        .mockResolvedValueOnce(health())
        .mockResolvedValueOnce(mismatch);
      const forceTerminate = vi.fn(async () => undefined);
      startReady(child);
      const supervisor = new BridgeSupervisor({
        store: store(),
        identityStore: new MemoryIdentityStore(),
        dependencies: dependencies(child, client, {
          waitForCurrentExit: async () => false,
          forceTerminate,
        }),
      });
      await supervisor.ensureStarted();
      await expect(supervisor.stop()).rejects.toMatchObject({ code: 'process_unverified' });
      expect(forceTerminate).not.toHaveBeenCalled();
    }
  });

  it('never force-terminates a recovered process even when graceful shutdown times out', async () => {
    const child = new FakeChild();
    const client = fakeClient();
    const identityStore = new MemoryIdentityStore();
    identityStore.value = identity();
    const forceTerminate = vi.fn(async () => undefined);
    const supervisor = new BridgeSupervisor({
      store: store(),
      identityStore,
      dependencies: dependencies(child, client, {
        waitForRecoveredExit: async () => false,
        forceTerminate,
      }),
    });
    await supervisor.ensureStarted();
    await expect(supervisor.stop()).rejects.toMatchObject({ code: 'shutdown_timeout' });
    expect(client.shutdown).toHaveBeenCalledTimes(1);
    expect(forceTerminate).not.toHaveBeenCalled();
  });

  it('a crashed old child cannot delete a replacement generation and ensureStarted recovers', async () => {
    const child = new FakeChild();
    const client = fakeClient();
    const identityStore = new MemoryIdentityStore();
    startReady(child);
    const supervisor = new BridgeSupervisor({
      store: store(),
      identityStore,
      dependencies: dependencies(child, client),
    });
    await supervisor.ensureStarted();
    const replacement = identity({ pid: 9876, address: '127.0.0.1:49876' });
    identityStore.value = replacement;
    child.exit(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(identityStore.value).toEqual(replacement);
  });

  it('later stdout triggers authenticated shutdown but never an unverified force kill', async () => {
    const child = new FakeChild();
    const client = fakeClient();
    const forceTerminate = vi.fn(async () => undefined);
    startReady(child);
    await new BridgeSupervisor({
      store: store(),
      identityStore: new MemoryIdentityStore(),
      dependencies: dependencies(child, client, { forceTerminate }),
    }).ensureStarted();
    child.stdout.write('unexpected');
    await Promise.resolve();
    await Promise.resolve();
    expect(client.shutdown).toHaveBeenCalledTimes(1);
    expect(forceTerminate).not.toHaveBeenCalled();
  });
});
