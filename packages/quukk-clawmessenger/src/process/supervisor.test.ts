import { EventEmitter } from 'node:events';
import { basename, dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';

import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import packageJson from '../../package.json' with { type: 'json' };

import { localPaths } from '../config/paths.js';
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
const fakeHome = 'D:\\fake-home';
const identityPath = localPaths(fakeHome).bridgePid;

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
  readonly terminationSignals: Array<number | NodeJS.Signals> = [];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill(signal: number | NodeJS.Signals = 'SIGTERM'): boolean {
    this.terminationSignals.push(signal);
    return true;
  }

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

function fileSystemError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function cloneJson(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

class FakeIdentityFileSystem {
  readonly files = new Map<string, unknown>();
  readonly reads: Array<{ path: string; maximumBytes: number }> = [];
  readonly writes: Array<{ path: string; value: unknown }> = [];
  readonly renames: Array<{ source: string; destination: string }> = [];
  readonly links: Array<{ existing: string; destination: string }> = [];
  readonly unlinks: string[] = [];
  afterRead?: (path: string) => Promise<void>;
  afterRename?: (source: string, destination: string) => Promise<void>;
  linkErrorCode?: string;
  renameErrorCode?: string;
  scanErrorCode?: string;
  unlinkErrorCode?: string;
  renameOverwritesDestination = false;
  #claimSequence = 0;

  dependencies(_label: string) {
    const fileSystem = this;
    return {
      claimId: (): string => {
        this.#claimSequence += 1;
        return this.#claimSequence.toString(16).padStart(32, '0');
      },
      read: async (path: string, maximumBytes: number): Promise<unknown | undefined> => {
        this.reads.push({ path, maximumBytes });
        const captured = cloneJson(this.files.get(path));
        await this.afterRead?.(path);
        return captured;
      },
      write: async (path: string, value: unknown): Promise<void> => {
        this.writes.push({ path, value: cloneJson(value) });
        this.files.set(path, cloneJson(value));
      },
      rename: async (source: string, destination: string): Promise<void> => {
        if (this.renameErrorCode !== undefined) throw fileSystemError(this.renameErrorCode);
        const value = this.files.get(source);
        if (value === undefined) throw fileSystemError('ENOENT');
        if (this.files.has(destination) && !this.renameOverwritesDestination) {
          throw fileSystemError('EEXIST');
        }
        this.renames.push({ source, destination });
        this.files.delete(source);
        this.files.set(destination, value);
        await this.afterRename?.(source, destination);
      },
      scan: async function* (directory: string): AsyncIterable<string> {
        if (fileSystem.scanErrorCode !== undefined) {
          throw fileSystemError(fileSystem.scanErrorCode);
        }
        for (const path of [...fileSystem.files.keys()].sort()) {
          if (dirname(path) === directory) yield basename(path);
        }
      },
      link: async (existing: string, destination: string): Promise<void> => {
        this.links.push({ existing, destination });
        if (this.linkErrorCode !== undefined) throw fileSystemError(this.linkErrorCode);
        const value = this.files.get(existing);
        if (value === undefined) throw fileSystemError('ENOENT');
        if (this.files.has(destination)) throw fileSystemError('EEXIST');
        this.files.set(destination, value);
      },
      unlink: async (path: string): Promise<void> => {
        this.unlinks.push(path);
        if (this.unlinkErrorCode !== undefined) throw fileSystemError(this.unlinkErrorCode);
        if (!this.files.delete(path)) throw fileSystemError('ENOENT');
      },
    };
  }
}

function identityClaims(fileSystem: FakeIdentityFileSystem): string[] {
  return [...fileSystem.files.keys()].filter((path) =>
    path.startsWith(`${identityPath}.claim-`),
  );
}

function pauseFirstIdentityClaim(fileSystem: FakeIdentityFileSystem): {
  claimed: Promise<void>;
  release: () => void;
} {
  let signalClaimed!: () => void;
  let release!: () => void;
  let paused = false;
  const claimed = new Promise<void>((resolve) => { signalClaimed = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const pause = async (path: string): Promise<void> => {
    if (paused || path !== identityPath) return;
    paused = true;
    signalClaimed();
    await blocked;
  };
  fileSystem.afterRead = pause;
  fileSystem.afterRename = async (source) => pause(source);
  return { claimed, release };
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
  health: ReturnType<
    typeof vi.fn<(options?: { signal?: AbortSignal }) => Promise<BridgeHealth>>
  >;
  shutdown: ReturnType<typeof vi.fn<(options?: { signal?: AbortSignal }) => Promise<void>>>;
};

function fakeClient(): FakeClient {
  return {
    health: vi.fn<(options?: { signal?: AbortSignal }) => Promise<BridgeHealth>>(
      async () => health(),
    ),
    shutdown: vi.fn<(options?: { signal?: AbortSignal }) => Promise<void>>(
      async () => undefined,
    ),
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
    const fileSystem = new FakeIdentityFileSystem();
    const dependencies: BridgeProcessIdentityDependencies = fileSystem.dependencies('basic');
    const persistence = new BridgeProcessIdentityStore({
      homeDirectory: 'D:\\fake-home',
      dependencies,
    });

    await persistence.write(identity());
    await expect(persistence.read()).resolves.toEqual(identity());
    await expect(persistence.removeIfMatches(identity({ pid: 9999 }))).resolves.toBe(false);
    await expect(persistence.removeIfMatches(identity())).resolves.toBe(true);

    expect(fileSystem.writes[0]?.path).toBe(identityPath);
    expect(fileSystem.reads.every((entry) => entry.maximumBytes === 16_384)).toBe(true);
    expect(fileSystem.files.has(identityPath)).toBe(false);
    expect(fileSystem.unlinks).not.toContain(identityPath);
    expect(JSON.stringify(fileSystem.writes)).not.toContain('daemon.pid');
  });

  it('fails closed on corrupt identity and preserves it', async () => {
    const fileSystem = new FakeIdentityFileSystem();
    const corrupt = { ...identity(), secret };
    fileSystem.files.set(identityPath, corrupt);
    const persistence = new BridgeProcessIdentityStore({
      homeDirectory: 'D:\\fake-home',
      dependencies: fileSystem.dependencies('corrupt'),
    });
    await expect(persistence.read()).rejects.toMatchObject({ code: 'identity_corrupt' });
    await expect(persistence.removeIfMatches(identity())).rejects.toMatchObject({
      code: 'identity_corrupt',
    });
    expect(fileSystem.files.get(identityPath)).toEqual(corrupt);
  });

  it('preserves a newer cross-process write when removal claims first', async () => {
    const fileSystem = new FakeIdentityFileSystem();
    fileSystem.files.set(identityPath, identity());
    const remover = new BridgeProcessIdentityStore({
      homeDirectory: 'D:\\fake-home',
      dependencies: fileSystem.dependencies('remover'),
    });
    const writer = new BridgeProcessIdentityStore({
      homeDirectory: 'D:\\fake-home',
      dependencies: fileSystem.dependencies('writer'),
    });
    const gate = pauseFirstIdentityClaim(fileSystem);
    const removing = remover.removeIfMatches(identity());
    await gate.claimed;
    const replacement = identity({ pid: 9876, address: '127.0.0.1:49876' });
    await writer.write(replacement);
    gate.release();

    await expect(removing).resolves.toBe(true);
    await expect(writer.read()).resolves.toEqual(replacement);
  });

  it('allows exactly one of two stores to remove the same claimed generation', async () => {
    const fileSystem = new FakeIdentityFileSystem();
    fileSystem.files.set(identityPath, identity());
    const first = new BridgeProcessIdentityStore({
      homeDirectory: 'D:\\fake-home',
      dependencies: fileSystem.dependencies('first'),
    });
    const second = new BridgeProcessIdentityStore({
      homeDirectory: 'D:\\fake-home',
      dependencies: fileSystem.dependencies('second'),
    });
    const gate = pauseFirstIdentityClaim(fileSystem);
    const firstRemoval = first.removeIfMatches(identity());
    await gate.claimed;
    const secondRemoval = second.removeIfMatches(identity());
    gate.release();

    await expect(Promise.all([firstRemoval, secondRemoval])).resolves.toEqual([true, false]);
    expect(fileSystem.files.has(identityPath)).toBe(false);
    expect(identityClaims(fileSystem)).toEqual([]);
  });

  it('preserves generation B across two POSIX removers, a writer, and a reader', async () => {
    const fileSystem = new FakeIdentityFileSystem();
    fileSystem.renameOverwritesDestination = true;
    fileSystem.files.set(identityPath, identity());
    const first = new BridgeProcessIdentityStore({
      homeDirectory: 'D:\\fake-home',
      dependencies: fileSystem.dependencies('first'),
    });
    const second = new BridgeProcessIdentityStore({
      homeDirectory: 'D:\\fake-home',
      dependencies: fileSystem.dependencies('second'),
    });
    const writer = new BridgeProcessIdentityStore({
      homeDirectory: 'D:\\fake-home',
      dependencies: fileSystem.dependencies('writer'),
    });
    const reader = new BridgeProcessIdentityStore({
      homeDirectory: 'D:\\fake-home',
      dependencies: fileSystem.dependencies('reader'),
    });
    let firstRead!: () => void;
    let releaseFirst!: () => void;
    let secondRename!: () => void;
    let releaseSecond!: () => void;
    const firstReadReached = new Promise<void>((resolve) => { firstRead = resolve; });
    const firstReadBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondRenameReached = new Promise<void>((resolve) => { secondRename = resolve; });
    const secondRenameBlocked = new Promise<void>((resolve) => { releaseSecond = resolve; });
    let claimReadPaused = false;
    let renameCount = 0;
    fileSystem.afterRead = async (path) => {
      if (claimReadPaused || !path.startsWith(`${identityPath}.claim`)) return;
      claimReadPaused = true;
      firstRead();
      await firstReadBlocked;
    };
    fileSystem.afterRename = async () => {
      renameCount += 1;
      if (renameCount !== 2) return;
      secondRename();
      await secondRenameBlocked;
    };

    const firstRemoval = first.removeIfMatches(identity());
    await firstReadReached;
    const replacement = identity({ pid: 9876, address: '127.0.0.1:49876' });
    await writer.write(replacement);
    const secondRemoval = second.removeIfMatches(identity());
    await secondRenameReached;
    releaseFirst();
    await expect(firstRemoval).resolves.toBe(true);
    const readResult = await reader.read();
    releaseSecond();
    await expect(secondRemoval).rejects.toMatchObject({ code: 'identity_write_failed' });

    expect(readResult).toEqual(replacement);
    await expect(reader.read()).resolves.toEqual(replacement);
    expect(fileSystem.files.get(identityPath)).toEqual(replacement);
    expect(identityClaims(fileSystem)).toEqual([]);
  });

  it('preserves the winner when a write precedes a claim or races mismatch restoration', async () => {
    const replacement = identity({ pid: 9876, address: '127.0.0.1:49876' });
    const newest = identity({ pid: 9877, address: '127.0.0.1:49877' });

    const writeFirst = new FakeIdentityFileSystem();
    writeFirst.files.set(identityPath, identity());
    const writeFirstRemover = new BridgeProcessIdentityStore({
      homeDirectory: 'D:\\fake-home',
      dependencies: writeFirst.dependencies('remover'),
    });
    const writeFirstWriter = new BridgeProcessIdentityStore({
      homeDirectory: 'D:\\fake-home',
      dependencies: writeFirst.dependencies('writer'),
    });
    await writeFirstWriter.write(replacement);
    await expect(writeFirstRemover.removeIfMatches(identity())).resolves.toBe(false);
    await expect(writeFirstWriter.read()).resolves.toEqual(replacement);

    const restoreRace = new FakeIdentityFileSystem();
    restoreRace.files.set(identityPath, replacement);
    const restoreRemover = new BridgeProcessIdentityStore({
      homeDirectory: 'D:\\fake-home',
      dependencies: restoreRace.dependencies('remover'),
    });
    const restoreWriter = new BridgeProcessIdentityStore({
      homeDirectory: 'D:\\fake-home',
      dependencies: restoreRace.dependencies('writer'),
    });
    const gate = pauseFirstIdentityClaim(restoreRace);
    const removing = restoreRemover.removeIfMatches(identity());
    await gate.claimed;
    await restoreWriter.write(newest);
    gate.release();
    await expect(removing).resolves.toBe(false);
    expect(restoreRace.links).toHaveLength(1);
    const claimPrefix = `${identityPath}.claim-${process.pid}-`;
    expect(restoreRace.links[0]?.existing?.startsWith(claimPrefix)).toBe(true);
    expect(restoreRace.links[0]?.existing?.slice(claimPrefix.length)).toMatch(/^[0-9a-f]{32}$/);
    expect(restoreRace.links[0]?.destination).toBe(identityPath);
    await expect(restoreWriter.read()).resolves.toEqual(newest);
  });

  it('recovers one exact-prefix orphan and ignores unrelated names', async () => {
    const fileSystem = new FakeIdentityFileSystem();
    const orphan = `${identityPath}.claim-4321-${'a'.repeat(32)}`;
    const lookalike = `${identityPath}.claimed-4321-${'b'.repeat(32)}`;
    fileSystem.files.set(orphan, identity());
    fileSystem.files.set(lookalike, { unrelated: true });
    const persistence = new BridgeProcessIdentityStore({
      homeDirectory: 'D:\\fake-home',
      dependencies: fileSystem.dependencies('stale-claim'),
    });

    await expect(persistence.read()).resolves.toEqual(identity());
    expect(fileSystem.files.get(identityPath)).toEqual(identity());
    expect(fileSystem.files.has(orphan)).toBe(false);
    expect(fileSystem.files.get(lookalike)).toEqual({ unrelated: true });
    await expect(persistence.removeIfMatches(identity())).resolves.toBe(true);
  });

  it('fails closed on multiple claims, scan overflow, and scan failure', async () => {
    const multiple = new FakeIdentityFileSystem();
    multiple.files.set(`${identityPath}.claim-1-${'a'.repeat(32)}`, identity());
    multiple.files.set(`${identityPath}.claim-2-${'b'.repeat(32)}`, identity({ pid: 2 }));
    const multipleStore = new BridgeProcessIdentityStore({
      homeDirectory: 'D:\\fake-home',
      dependencies: multiple.dependencies('multiple'),
    });
    await expect(multipleStore.read()).rejects.toMatchObject({ code: 'identity_corrupt' });
    expect(multiple.files.has(identityPath)).toBe(false);
    expect(identityClaims(multiple)).toHaveLength(2);

    const overflow = new FakeIdentityFileSystem();
    for (let index = 0; index < 257; index += 1) {
      overflow.files.set(
        join(dirname(identityPath), `unrelated-${String(index).padStart(3, '0')}`),
        {},
      );
    }
    const overflowStore = new BridgeProcessIdentityStore({
      homeDirectory: 'D:\\fake-home',
      dependencies: overflow.dependencies('overflow'),
    });
    await expect(overflowStore.read()).rejects.toMatchObject({ code: 'identity_corrupt' });

    const failed = new FakeIdentityFileSystem();
    failed.scanErrorCode = 'EACCES';
    const failedStore = new BridgeProcessIdentityStore({
      homeDirectory: 'D:\\fake-home',
      dependencies: failed.dependencies('failed'),
    });
    await expect(failedStore.read()).rejects.toMatchObject({ code: 'identity_corrupt' });
  });

  it.each(['EACCES', 'EPERM'])(
    'keeps a failed restore visible as a fail-closed claim after %s',
    async (failureCode) => {
      const fileSystem = new FakeIdentityFileSystem();
      const replacement = identity({ pid: 9876, address: '127.0.0.1:49876' });
      fileSystem.files.set(identityPath, replacement);
      fileSystem.linkErrorCode = failureCode;
      const persistence = new BridgeProcessIdentityStore({
        homeDirectory: 'D:\\fake-home',
        dependencies: fileSystem.dependencies('restore-failure'),
      });

      await expect(persistence.removeIfMatches(identity())).rejects.toMatchObject({
        code: 'identity_write_failed',
      });
      expect(fileSystem.files.has(identityPath)).toBe(false);
      expect(identityClaims(fileSystem)).toHaveLength(1);
      expect(fileSystem.files.get(identityClaims(fileSystem)[0]!)).toEqual(replacement);

      const child = new FakeChild();
      const resolveBinary = vi.fn<BridgeSupervisorDependencies['resolveBinary']>();
      const spawn = vi.fn<BridgeSupervisorDependencies['spawn']>();
      const supervisor = new BridgeSupervisor({
        store: store(),
        identityStore: persistence,
        dependencies: dependencies(child, fakeClient(), { resolveBinary, spawn }),
      });
      await expect(supervisor.ensureStarted()).rejects.toMatchObject({
        code: 'identity_corrupt',
      });
      expect(resolveBinary).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it('fails closed without deleting the canonical identity when rename fails', async () => {
    const fileSystem = new FakeIdentityFileSystem();
    fileSystem.files.set(identityPath, identity());
    fileSystem.renameErrorCode = 'EACCES';
    const persistence = new BridgeProcessIdentityStore({
      homeDirectory: 'D:\\fake-home',
      dependencies: fileSystem.dependencies('rename-failure'),
    });

    await expect(persistence.removeIfMatches(identity())).rejects.toMatchObject({
      code: 'identity_write_failed',
    });
    expect(fileSystem.files.get(identityPath)).toEqual(identity());
    expect(identityClaims(fileSystem)).toEqual([]);
  });

  it('keeps an unlink failure recoverable and fail closed', async () => {
    const fileSystem = new FakeIdentityFileSystem();
    fileSystem.files.set(identityPath, identity());
    fileSystem.unlinkErrorCode = 'EACCES';
    const persistence = new BridgeProcessIdentityStore({
      homeDirectory: 'D:\\fake-home',
      dependencies: fileSystem.dependencies('unlink-failure'),
    });

    await expect(persistence.removeIfMatches(identity())).rejects.toMatchObject({
      code: 'identity_write_failed',
    });
    expect(fileSystem.files.has(identityPath)).toBe(false);
    expect(identityClaims(fileSystem)).toHaveLength(1);
    await expect(persistence.read()).rejects.toMatchObject({ code: 'identity_write_failed' });
    expect(fileSystem.files.get(identityPath)).toEqual(identity());
  });
});

describe('BridgeSupervisor startup', () => {
  it('exposes the task port required by downstream routing', () => {
    expectTypeOf<RunningBridge['client']>().toMatchTypeOf<BridgeTaskPort>();
  });

  it('uses the pinned runtime dependency version for the Go startup handshake', async () => {
    const runtimeVersion = packageJson.optionalDependencies[
      '@quukk/clawmessenger-runtime-win32-x64'
    ];
    const child = new FakeChild();
    const client = fakeClient();
    client.health.mockResolvedValue(health({ version: runtimeVersion }));
    const input: Buffer[] = [];
    child.stdin.on('data', (chunk) => input.push(Buffer.from(chunk)));
    const configured = dependencies(child, client, {
      resolveBinary: async () => ({
        path: binaryPath,
        packageName: '@quukk/clawmessenger-runtime-win32-x64',
        version: runtimeVersion,
        sha256: 'b'.repeat(64),
      }),
    });
    const { version: _entryVersionDefault, ...usesPackageDefault } = configured;
    startReady(child, readinessLine({ version: runtimeVersion }));

    await new BridgeSupervisor({
      store: store(),
      identityStore: new MemoryIdentityStore(),
      dependencies: usesPackageDefault,
    }).ensureStarted();

    const startup = JSON.parse(Buffer.concat(input).toString('utf8')) as { version: string };
    expect(packageJson.version).not.toBe(runtimeVersion);
    expect(startup.version).toBe(runtimeVersion);
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
    expect(client.shutdown).not.toHaveBeenCalled();
    expect(child.terminationSignals).toEqual([]);
    expect(deps.forceTerminate).not.toHaveBeenCalled();
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
    const cases: Array<
      [string, (child: FakeChild) => void, Partial<BridgeSupervisorDependencies>, boolean]
    > = [
      ['CRLF', (child) => startReady(child, readinessLine().replace('\n', '\r\n')), {}, true],
      ['banner', (child) => startReady(child, `banner${readinessLine()}`), {}, true],
      ['same-chunk trailing', (child) => startReady(child, `${readinessLine()}x`), {}, true],
      ['overflow', (child) => startReady(child, `${'x'.repeat(65_536)}\n`), {}, true],
      ['EOF', (child) => queueMicrotask(() => child.stdout.end('{}')), {}, true],
      ['exit', (child) => queueMicrotask(() => child.exit(1)), {}, false],
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
        false,
      ],
    ];
    for (const [name, arrange, override, mustReap] of cases) {
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
      expect(child.terminationSignals, name).toEqual(mustReap ? ['SIGTERM'] : []);
      expect(forceTerminate, name).toHaveBeenCalledTimes(mustReap ? 1 : 0);
      if (mustReap) expect(forceTerminate, name).toHaveBeenCalledWith(child);
    }
  });

  it('reaps the exact spawned child when readiness fails', async () => {
    const child = new FakeChild();
    const forcedChildren: FakeChild[] = [];
    startReady(child, '{}\r\n');
    const supervisor = new BridgeSupervisor({
      store: store(),
      identityStore: new MemoryIdentityStore(),
      dependencies: dependencies(child, fakeClient(), {
        waitForCurrentExit: async () => false,
        forceTerminate: async (forcedChild) => {
          forcedChildren.push(forcedChild as unknown as FakeChild);
          child.exit(1);
        },
      }),
    });

    await expect(supervisor.ensureStarted()).rejects.toMatchObject({ code: 'readiness_invalid' });
    expect(child.terminationSignals).toEqual(['SIGTERM']);
    expect(forcedChildren).toEqual([child]);
    expect(child.exitCode).toBe(1);
  });

  it('reaps the exact spawned child when the caller aborts during readiness', async () => {
    const child = new FakeChild();
    const controller = new AbortController();
    const forceTerminate = vi.fn(async () => child.exit(1));
    const spawn = vi.fn<BridgeSupervisorDependencies['spawn']>(() => {
      queueMicrotask(() => controller.abort());
      return child as never;
    });
    const supervisor = new BridgeSupervisor({
      store: store(),
      identityStore: new MemoryIdentityStore(),
      dependencies: dependencies(child, fakeClient(), {
        spawn,
        waitForCurrentExit: async () => false,
        forceTerminate,
      }),
    });

    await expect(supervisor.ensureStarted({ signal: controller.signal })).rejects.toMatchObject({
      code: 'startup_failed',
    });
    expect(child.terminationSignals).toEqual(['SIGTERM']);
    expect(forceTerminate).toHaveBeenCalledWith(child);
  });

  it('uses a fresh cleanup signal when the caller aborts during health', async () => {
    const child = new FakeChild();
    const client = fakeClient();
    const controller = new AbortController();
    let cleanupSignal: AbortSignal | undefined;
    client.health.mockImplementationOnce(({ signal } = {}) =>
      new Promise<BridgeHealth>((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => reject(new BridgeClientError('request_aborted')),
          { once: true },
        );
        queueMicrotask(() => controller.abort());
      }),
    );
    client.shutdown.mockImplementation(async ({ signal } = {}) => {
      cleanupSignal = signal;
      child.exit(0);
    });
    const forceTerminate = vi.fn(async () => undefined);
    startReady(child);
    const supervisor = new BridgeSupervisor({
      store: store(),
      identityStore: new MemoryIdentityStore(),
      dependencies: dependencies(child, client, { forceTerminate }),
    });

    await expect(supervisor.ensureStarted({ signal: controller.signal })).rejects.toMatchObject({
      code: 'startup_failed',
    });
    expect(cleanupSignal).toBeDefined();
    expect(cleanupSignal).not.toBe(controller.signal);
    expect(cleanupSignal?.aborted).toBe(false);
    expect(forceTerminate).not.toHaveBeenCalled();
  });

  it('reaps the exact spawned child when the startup deadline expires during readiness', async () => {
    const child = new FakeChild();
    let expireStartup!: () => void;
    const forceTerminate = vi.fn(async () => child.exit(1));
    const setTimeout = vi.fn((callback: () => void, milliseconds?: number) => {
      if (milliseconds === 25) expireStartup = callback;
      return { milliseconds } as unknown as ReturnType<typeof globalThis.setTimeout>;
    }) as unknown as typeof globalThis.setTimeout;
    const spawn = vi.fn<BridgeSupervisorDependencies['spawn']>(() => {
      queueMicrotask(() => expireStartup());
      return child as never;
    });
    const supervisor = new BridgeSupervisor({
      store: store(),
      identityStore: new MemoryIdentityStore(),
      dependencies: dependencies(child, fakeClient(), {
        spawn,
        setTimeout,
        clearTimeout: vi.fn() as never,
        startupTimeoutMs: 25,
        waitForCurrentExit: async () => false,
        forceTerminate,
      }),
    });

    await expect(supervisor.ensureStarted()).rejects.toMatchObject({ code: 'startup_timeout' });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(child.terminationSignals).toEqual(['SIGTERM']);
    expect(forceTerminate).toHaveBeenCalledWith(child);
  });

  it('bounds a hung authenticated shutdown then force-terminates only its spawned child', async () => {
    const child = new FakeChild();
    const client = fakeClient();
    client.health.mockRejectedValueOnce(new BridgeClientError('response_invalid'));
    client.shutdown.mockImplementation(() => new Promise<void>(() => undefined));
    const cleanupTimers: Array<() => void> = [];
    const setTimeout = vi.fn((callback: () => void, milliseconds?: number) => {
      if (milliseconds === 10) cleanupTimers.push(callback);
      return { milliseconds } as unknown as ReturnType<typeof globalThis.setTimeout>;
    }) as unknown as typeof globalThis.setTimeout;
    const forceTerminate = vi.fn(async (forcedChild) => {
      expect(forcedChild).toBe(child);
      child.exit(1);
    });
    startReady(child);
    const supervisor = new BridgeSupervisor({
      store: store(),
      identityStore: new MemoryIdentityStore(),
      dependencies: dependencies(child, client, {
        setTimeout,
        clearTimeout: vi.fn() as never,
        shutdownGraceMs: 10,
        waitForCurrentExit: async () => false,
        forceTerminate,
      }),
    });

    const starting = supervisor.ensureStarted();
    await vi.waitFor(() => expect(client.shutdown).toHaveBeenCalledTimes(1));
    expect(cleanupTimers).toHaveLength(1);
    cleanupTimers[0]!();
    await expect(starting).rejects.toMatchObject({ code: 'startup_failed' });
    expect(child.terminationSignals).toEqual([]);
    expect(forceTerminate).toHaveBeenCalledTimes(1);
  });

  it('does not force-terminate when authenticated startup cleanup exits gracefully', async () => {
    const child = new FakeChild();
    const client = fakeClient();
    client.health.mockRejectedValueOnce(new BridgeClientError('response_invalid'));
    let lifecycle: AbortSignal | undefined;
    client.shutdown.mockImplementation(async ({ signal } = {}) => {
      expect(lifecycle?.aborted).toBe(false);
      expect(signal?.aborted).toBe(false);
      child.exit(0);
    });
    const forceTerminate = vi.fn(async () => undefined);
    startReady(child);
    const base = dependencies(child, client, {
      waitForCurrentExit: async () => true,
      forceTerminate,
    });
    const supervisor = new BridgeSupervisor({
      store: store(),
      identityStore: new MemoryIdentityStore(),
      dependencies: {
        ...base,
        clientFactory: vi.fn((options) => {
          lifecycle = options.lifecycleSignal;
          return client as never;
        }),
      },
    });

    await expect(supervisor.ensureStarted()).rejects.toMatchObject({ code: 'startup_failed' });
    expect(client.shutdown).toHaveBeenCalledTimes(1);
    expect(lifecycle?.aborted).toBe(true);
    expect(child.terminationSignals).toEqual([]);
    expect(forceTerminate).not.toHaveBeenCalled();
  });

  it('rejects an oversized single readiness chunk before concatenating it', async () => {
    const child = new FakeChild();
    const hugeChunk = Buffer.alloc(8 * 1024 * 1024, 0x78);
    const concat = vi.spyOn(Buffer, 'concat');
    const spawn = vi.fn<BridgeSupervisorDependencies['spawn']>(() => {
      queueMicrotask(() => child.stdout.emit('data', hugeChunk));
      return child as never;
    });
    try {
      const supervisor = new BridgeSupervisor({
        store: store(),
        identityStore: new MemoryIdentityStore(),
        dependencies: dependencies(child, fakeClient(), { spawn }),
      });
      await expect(supervisor.ensureStarted()).rejects.toMatchObject({
        code: 'readiness_invalid',
      });
      expect(
        concat.mock.calls.some(([chunks]) =>
          chunks.some((chunk) => chunk === hugeChunk),
        ),
      ).toBe(false);
    } finally {
      concat.mockRestore();
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
      expect(child.terminationSignals, source).toEqual(['SIGTERM']);
      expect(forceTerminate, source).toHaveBeenCalledWith(child);
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

  it('rejects every current-child health fence mismatch without persistence and reaps it', async () => {
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
      let lifecycle: AbortSignal | undefined;
      client.shutdown.mockImplementation(async () => {
        expect(lifecycle?.aborted).toBe(false);
      });
      const identityStore = new MemoryIdentityStore();
      const forceTerminate = vi.fn(async () => undefined);
      startReady(child);
      const base = dependencies(child, client, { forceTerminate });
      await expect(
        new BridgeSupervisor({
          store: store(),
          identityStore,
          dependencies: {
            ...base,
            clientFactory: vi.fn((options) => {
              lifecycle = options.lifecycleSignal;
              return client as never;
            }),
          },
        }).ensureStarted(),
      ).rejects.toMatchObject({ code: 'identity_mismatch' });
      expect(identityStore.writes).toHaveLength(0);
      expect(client.shutdown).toHaveBeenCalledTimes(1);
      expect(lifecycle?.aborted).toBe(true);
      expect(child.terminationSignals).toEqual([]);
      expect(forceTerminate).toHaveBeenCalledWith(child);
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

  it('consumes a rejecting late-output shutdown and still revokes the generation', async () => {
    const child = new FakeChild();
    const client = fakeClient();
    client.shutdown.mockRejectedValue(new Error('late-shutdown-sentinel'));
    let lifecycle: AbortSignal | undefined;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    const base = dependencies(child, client);
    startReady(child);
    process.on('unhandledRejection', onUnhandled);
    try {
      await new BridgeSupervisor({
        store: store(),
        identityStore: new MemoryIdentityStore(),
        dependencies: {
          ...base,
          clientFactory: vi.fn((options) => {
            lifecycle = options.lifecycleSignal;
            return client as never;
          }),
        },
      }).ensureStarted();
      child.stdout.write('unexpected');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(lifecycle?.aborted).toBe(true);
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });
});
