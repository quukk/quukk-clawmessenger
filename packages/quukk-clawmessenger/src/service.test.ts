import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EnableResult } from './bindings/service.js';
import {
  DEFAULT_CONFIG,
  PROVIDERS,
  type ConfigOverrides,
  type RongCloudCredential,
  type RuntimeBinding,
  type StoredConfig,
} from './config/schema.js';
import type { StoreSnapshot } from './config/store.js';
import type { BridgeHealth, BridgeRuntime } from './go/types.js';
import type {
  ActivityRecord,
  SafeLogEvent,
} from './logging/logger.js';
import type {
  DaemonIdentityPersistence,
  ReadyDaemonIdentity,
  StartingDaemonIdentity,
} from './process/service-identity.js';
import type {
  SupervisorBinding,
  WorkerIdentity,
  WorkerSnapshot,
} from './rongcloud/worker-supervisor.js';
import {
  QuukkService,
  ServiceError,
  createConservativeRouterControl,
  startProductionService,
  type ProductionServiceFactories,
  type ServiceBindingPort,
  type ServiceBridgePort,
  type ServiceHttpPort,
  type ServiceLoggerPort,
  type ServiceRouterPort,
  type ServiceRuntimePort,
  type ServiceStorePort,
  type ServiceWorkerPort,
} from './service.js';

const TASK_TEMP_ROOT = join(tmpdir(), 'quukk-task11-service');
const SECRET = Buffer.alloc(32, 7).toString('base64url');
const STARTING: StartingDaemonIdentity = {
  schema_version: 1,
  state: 'starting',
  pid: 4242,
  version: '0.1.0-beta.1',
  instance_id: 'svc_0123456789abcdef0123456789abcdef',
  started_at: '2026-08-27T08:00:00.000Z',
};
const READY: ReadyDaemonIdentity = {
  ...STARTING,
  state: 'ready',
  address: '127.0.0.1:43111',
};
const IDS = {
  opencode: `rt_${'1'.repeat(32)}`,
  openclaw: `rt_${'2'.repeat(32)}`,
  codex: `rt_${'3'.repeat(32)}`,
  hermes: `rt_${'4'.repeat(32)}`,
} as const;

const tempDirectories = new Set<string>();

async function temporaryDirectory(): Promise<string> {
  await mkdir(TASK_TEMP_ROOT, { recursive: true });
  const directory = await mkdtemp(join(TASK_TEMP_ROOT, 'quukk-task11-service-'));
  tempDirectories.add(directory);
  return directory;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of tempDirectories) {
    const canonical = resolve(directory);
    if (!canonical.startsWith(resolve(TASK_TEMP_ROOT) + sep)) {
      throw new Error('unsafe_test_cleanup_target');
    }
    await rm(canonical, { recursive: true, force: true });
  }
  tempDirectories.clear();
});

function capabilities(approvalEvents = false): BridgeRuntime['capabilities'] {
  return {
    session_resume: true,
    cancel: true,
    text_events: true,
    tool_events: true,
    approval_events: approvalEvents,
  };
}

function runtimeCatalog(root: string): BridgeRuntime[] {
  return PROVIDERS.map((provider) => ({
    id: IDS[provider],
    provider,
    version: `${provider}-1.0.0`,
    path: join(root, 'bin', `${provider}.exe`),
    status: 'ready' as const,
    capabilities: capabilities(),
  }));
}

function completeBinding(
  provider: keyof typeof IDS,
  root: string,
  overrides: Partial<RuntimeBinding> = {},
): RuntimeBinding {
  return {
    runtimeId: IDS[provider],
    runtimePath: join(root, 'bin', `${provider}.exe`),
    provider,
    enabled: true,
    nodeId: `${provider}_node`,
    nodeName: `${provider} node`,
    tokenRef: `rc_${provider === 'opencode' ? 'a' : provider === 'openclaw' ? 'b' : provider === 'codex' ? 'c' : 'd'}`.padEnd(35, provider === 'opencode' ? 'a' : 'd'),
    registrationState: 'offline',
    updatedAt: '2026-08-27T08:00:00.000Z',
    ...overrides,
  };
}

function cloneConfig(value: StoredConfig): StoredConfig {
  return structuredClone(value);
}

class FakeLogger implements ServiceLoggerPort {
  readonly records: Array<{ level: string; event: SafeLogEvent }> = [];
  readonly levels: string[] = [];
  readonly activityRecords: ActivityRecord[] = [];
  closeCalls = 0;
  closeHook: () => Promise<void> = async () => undefined;

  debug(event: SafeLogEvent): void { this.records.push({ level: 'debug', event }); }
  info(event: SafeLogEvent): void { this.records.push({ level: 'info', event }); }
  warn(event: SafeLogEvent): void { this.records.push({ level: 'warn', event }); }
  error(event: SafeLogEvent): void { this.records.push({ level: 'error', event }); }
  setLevel(level: StoredConfig['logLevel']): void { this.levels.push(level); }
  activity(): readonly ActivityRecord[] { return this.activityRecords.slice(); }
  diagnostics(): { dropped: number; retained: number } {
    return { dropped: 3, retained: this.activityRecords.length };
  }
  close(): Promise<void> {
    this.closeCalls += 1;
    return this.closeHook();
  }
}

class FakeStore implements ServiceStorePort {
  config = cloneConfig(DEFAULT_CONFIG);
  bindings: RuntimeBinding[] = [];
  warnings: string[] = [];
  readonly snapshots: Array<{ overrides: ConfigOverrides; environment: NodeJS.ProcessEnv }> = [];
  snapshotHook: () => void = () => undefined;
  saveCalls: StoredConfig[] = [];
  credentials = new Map<string, RongCloudCredential>();

  async snapshot(
    overrides: ConfigOverrides = {},
    environment: NodeJS.ProcessEnv = {},
  ): Promise<StoreSnapshot> {
    this.snapshotHook();
    this.snapshots.push({ overrides: structuredClone(overrides), environment: { ...environment } });
    const config = cloneConfig(this.config);
    if (overrides.serverUrl !== undefined) config.serverUrl = overrides.serverUrl;
    if (overrides.defaultWorkdir !== undefined) config.defaultWorkdir = overrides.defaultWorkdir;
    if (overrides.authorizedWorkRoots !== undefined) {
      config.authorizedWorkRoots = [...overrides.authorizedWorkRoots];
    }
    if (overrides.providerPathOverrides !== undefined) {
      config.providerPathOverrides = {
        ...config.providerPathOverrides,
        ...overrides.providerPathOverrides,
      };
    }
    if (overrides.logLevel !== undefined) config.logLevel = overrides.logLevel;
    if (environment.QUUKK_CLAWMESSENGER_LOG_LEVEL !== undefined) {
      config.logLevel = environment.QUUKK_CLAWMESSENGER_LOG_LEVEL as StoredConfig['logLevel'];
    }
    return {
      config,
      bindings: this.bindings.map((binding) => ({ ...binding })),
      warnings: [...this.warnings],
    };
  }

  async saveConfig(config: StoredConfig): Promise<void> {
    this.saveCalls.push(cloneConfig(config));
    this.config = cloneConfig(config);
  }

  bridgeIdentity(): { installId: string; secret: string } {
    return { installId: '00000000-0000-4000-8000-000000000001', secret: SECRET };
  }

  credential(ref: string): RongCloudCredential | undefined {
    const value = this.credentials.get(ref);
    return value === undefined ? undefined : { ...value };
  }
  assertExternalMutationAllowed(): void {}
}

class FakeRuntime implements ServiceRuntimePort {
  catalog: BridgeRuntime[];
  readonly trace: string[];
  healthValue: BridgeHealth = {
    status: 'ok',
    version: '0.1.0-beta.1',
    pid: 5151,
    instance_id: 'br_0123456789abcdef0123456789abcdef',
    started_at: '2026-08-27T07:59:59.000Z',
    probe_status: 'ready',
  };

  constructor(catalog: BridgeRuntime[], trace: string[]) {
    this.catalog = catalog;
    this.trace = trace;
  }

  async runtimes(): Promise<BridgeRuntime[]> {
    this.trace.push('runtime.list');
    return structuredClone(this.catalog);
  }

  async refreshRuntimes(): Promise<BridgeRuntime[]> {
    this.trace.push('runtime.refresh');
    return structuredClone(this.catalog);
  }

  async health(): Promise<BridgeHealth> {
    this.trace.push('runtime.health');
    return structuredClone(this.healthValue);
  }
}

class FakeBindings implements ServiceBindingPort {
  values: RuntimeBinding[] = [];
  enableHook?: (runtimeIds: readonly string[]) => Promise<readonly EnableResult[]>;
  reregisterHook?: (runtimeId: string) => Promise<EnableResult>;
  disableHook?: (runtimeId: string) => Promise<RuntimeBinding>;
  readonly trace: string[];

  constructor(trace: string[]) { this.trace = trace; }

  list(): readonly RuntimeBinding[] {
    this.trace.push('bindings.list');
    return this.values.map((binding) => ({ ...binding }));
  }

  async enableSelected(runtimeIds: readonly string[]): Promise<readonly EnableResult[]> {
    this.trace.push(`bindings.enable:${runtimeIds.join(',')}`);
    if (this.enableHook) return this.enableHook(runtimeIds);
    return [];
  }

  async disable(runtimeId: string): Promise<RuntimeBinding> {
    this.trace.push(`bindings.disable:${runtimeId}`);
    if (this.disableHook) return this.disableHook(runtimeId);
    const binding = this.values.find((candidate) => candidate.runtimeId === runtimeId);
    if (!binding) throw Object.assign(new Error('unsafe'), { code: 'runtime_not_found' });
    const disabled = { ...binding, enabled: false, registrationState: 'offline' as const };
    this.values = this.values.map((candidate) => candidate.runtimeId === runtimeId ? disabled : candidate);
    return disabled;
  }

  async reregister(runtimeId: string): Promise<EnableResult> {
    this.trace.push(`bindings.reregister:${runtimeId}`);
    if (this.reregisterHook) return this.reregisterHook(runtimeId);
    const binding = this.values.find((candidate) => candidate.runtimeId === runtimeId);
    return binding
      ? { runtimeId, ok: true, binding: { ...binding } }
      : { runtimeId, ok: false, errorCode: 'runtime_not_found' };
  }
}

class FakeWorkers implements ServiceWorkerPort {
  readonly trace: string[];
  values: WorkerSnapshot[] = [];
  reconciliations: SupervisorBinding[][] = [];
  reconcileHook: (bindings: readonly SupervisorBinding[]) => Promise<void> = async () => undefined;
  stopHook: (identity: WorkerIdentity) => Promise<void> = async () => undefined;
  disposeHook: () => Promise<void> = async () => undefined;
  disposeCalls = 0;

  constructor(trace: string[]) { this.trace = trace; }

  async reconcile(bindings: readonly SupervisorBinding[]): Promise<void> {
    this.trace.push('workers.reconcile');
    this.reconciliations.push(bindings.map((binding) => ({ ...binding })));
    await this.reconcileHook(bindings);
  }

  async stop(identity: WorkerIdentity): Promise<void> {
    this.trace.push(`workers.stop:${identity.runtimeId}:${identity.nodeId}`);
    await this.stopHook(identity);
  }

  async restart(): Promise<void> {}
  snapshots(): readonly WorkerSnapshot[] { return this.values.map((value) => ({ ...value })); }
  async dispose(): Promise<void> {
    this.trace.push('workers.dispose');
    this.disposeCalls += 1;
    await this.disposeHook();
  }
}

class FakeRouter implements ServiceRouterPort {
  readonly trace: string[];
  activateHook: (identity: WorkerIdentity) => Promise<void> = async () => undefined;
  disposeBindingHook: (identity: WorkerIdentity) => Promise<void> = async () => undefined;
  disposeHook: () => Promise<void> = async () => undefined;
  disposeCalls = 0;

  constructor(trace: string[]) { this.trace = trace; }
  async onWorkerEvent(identity: WorkerIdentity): Promise<void> {
    this.trace.push(`router.event:${identity.runtimeId}:${identity.nodeId}`);
  }
  async activateBinding(identity: WorkerIdentity): Promise<void> {
    this.trace.push(`router.activate:${identity.runtimeId}:${identity.nodeId}`);
    await this.activateHook(identity);
  }
  async disposeBinding(identity: WorkerIdentity): Promise<void> {
    this.trace.push(`router.disposeBinding:${identity.runtimeId}:${identity.nodeId}`);
    await this.disposeBindingHook(identity);
  }
  async dispose(): Promise<void> {
    this.trace.push('router.dispose');
    this.disposeCalls += 1;
    await this.disposeHook();
  }
}

class FakeIdentityStore implements DaemonIdentityPersistence {
  readonly trace: string[];
  markReadyHook: (expected: StartingDaemonIdentity, address: string) => Promise<ReadyDaemonIdentity>;
  removeHook: (expected: StartingDaemonIdentity | ReadyDaemonIdentity) => Promise<void> = async () => undefined;
  removed: Array<StartingDaemonIdentity | ReadyDaemonIdentity> = [];

  constructor(trace: string[]) {
    this.trace = trace;
    this.markReadyHook = async (expected, address) => ({ ...expected, state: 'ready', address });
  }
  async read(): Promise<{ identity?: StartingDaemonIdentity | ReadyDaemonIdentity; contentDigest?: string }> {
    return {};
  }
  async claim(): Promise<boolean> { return true; }
  async markReady(expected: StartingDaemonIdentity, address: string): Promise<ReadyDaemonIdentity> {
    this.trace.push(`identity.ready:${address}`);
    return this.markReadyHook(expected, address);
  }
  async quarantineStaleIfExact(): Promise<boolean> { return true; }
  async removeIfMatches(expected: StartingDaemonIdentity | ReadyDaemonIdentity): Promise<boolean> {
    this.trace.push(`identity.remove:${expected.state}`);
    this.removed.push(expected);
    await this.removeHook(expected);
    return true;
  }
}

class FakeHttp implements ServiceHttpPort {
  readonly trace: string[];
  startHook: () => Promise<{ host: '127.0.0.1'; port: number; origin: string }> = async () => ({
    host: '127.0.0.1', port: 43111, origin: 'http://127.0.0.1:43111',
  });
  closeHook: () => Promise<void> = async () => undefined;
  closeCalls = 0;

  constructor(trace: string[]) { this.trace = trace; }
  async start(): Promise<{ host: '127.0.0.1'; port: number; origin: string }> {
    this.trace.push('http.start');
    return this.startHook();
  }
  async close(): Promise<void> {
    this.trace.push('http.close');
    this.closeCalls += 1;
    await this.closeHook();
  }
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture(input: {
  bindings?: RuntimeBinding[];
  storageRoot?: string;
  configOverrides?: ConfigOverrides;
  configEnvironment?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
} = {}) {
  const root = await temporaryDirectory();
  const storageRoot = input.storageRoot ?? join(root, 'rongcloud');
  const trace: string[] = [];
  const store = new FakeStore();
  const runtime = new FakeRuntime(runtimeCatalog(root), trace);
  const bindings = new FakeBindings(trace);
  bindings.values = input.bindings?.map((binding) => ({ ...binding })) ?? [];
  store.bindings = bindings.values;
  const workers = new FakeWorkers(trace);
  const router = new FakeRouter(trace);
  const logger = new FakeLogger();
  const identityStore = new FakeIdentityStore(trace);
  const http = new FakeHttp(trace);
  const bridge: ServiceBridgePort = {
    ensureStarted: async () => {
      trace.push('bridge.start');
      return {
        client: runtime,
        identity: {
          schema_version: 1,
          address: '127.0.0.1:45123',
          pid: 5151,
          version: '0.1.0-beta.1',
          instance_id: 'br_0123456789abcdef0123456789abcdef',
          started_at: '2026-08-27T07:59:59.000Z',
        },
        recovered: false,
      };
    },
    stop: async () => { trace.push('bridge.stop'); },
  };
  let capturedControlCredential: string | undefined;
  const service = new QuukkService({
    identity: STARTING,
    identityStore,
    store,
    bridge,
    runtimes: runtime,
    bindings,
    workers,
    router,
    logger,
    storageRoot,
    configOverrides: input.configOverrides,
    configEnvironment: input.configEnvironment,
    startupTimeoutMs: input.startupTimeoutMs,
    shutdownTimeoutMs: input.shutdownTimeoutMs,
    httpFactory: ({ controlCredential }) => {
      capturedControlCredential = controlCredential;
      return http;
    },
  });
  return {
    root, storageRoot, trace, store, runtime, bindings, workers, router, logger,
    identityStore, http, bridge, service,
    get controlCredential() { return capturedControlCredential; },
  };
}

async function start(f: Fixture): Promise<void> {
  await f.service.start();
  expect(f.controlCredential).toMatch(/^[A-Za-z0-9_-]{43}$/);
}

async function mainImportGraph(): Promise<{ visited: string[]; violations: string[] }> {
  const candidates = [
    'src/service.ts',
    'src/router/message-router.ts',
    'src/http/routes.ts',
    'src/http/server.ts',
    'src/cli.ts',
  ].map((filePath) => resolve(filePath));
  const queue: string[] = [];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      queue.push(candidate);
    } catch {
      // CLI is supplied by the sibling Task 11 branch and becomes covered after integration.
    }
  }
  const visited = new Set<string>();
  const violations: string[] = [];
  while (queue.length > 0) {
    const filePath = queue.shift()!;
    if (visited.has(filePath)) continue;
    visited.add(filePath);
    const source = await readFile(filePath, 'utf8');
    const specifiers = [...source.matchAll(
      /(?:\b(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s*)?|\bimport\s*\()['"]([^'"]+)['"]/g,
    )].map((match) => match[1]!);
    for (const specifier of specifiers) {
      if (specifier === '@rongcloud/imlib-next'
        || /(?:^|\/)env-polyfill(?:\.js)?$/.test(specifier)
        || /(?:^|\/)worker-entry(?:\.js)?$/.test(specifier)) {
        violations.push(`${basename(filePath)}:${specifier}`);
      }
      if (!specifier.startsWith('.')) continue;
      const base = resolve(dirname(filePath), specifier);
      const localCandidates = [
        base,
        base.replace(/\.js$/, '.ts'),
        base.replace(/\.js$/, '.tsx'),
        join(base, 'index.ts'),
      ];
      for (const local of localCandidates) {
        try {
          await access(local);
          queue.push(local);
          break;
        } catch {
          // Non-code or absent optional import.
        }
      }
    }
  }
  return { visited: [...visited], violations };
}

describe('QuukkService lifecycle', () => {
  it('keeps service, router, HTTP, and CLI main imports away from RongCloud SDK/polyfills', async () => {
    const graph = await mainImportGraph();
    expect(graph.violations).toEqual([]);
    expect(graph.visited.map((filePath) => basename(filePath))).not.toContain('worker-entry.ts');
    expect(graph.visited.map((filePath) => basename(filePath))).not.toContain('env-polyfill.ts');
  });

  it('rejects startup timeout values above the fixed sixty-second ceiling', async () => {
    await expect(fixture({ startupTimeoutMs: 60_001 })).rejects.toThrow('invalid_startup_timeout');
  });

  it('bounds a hung startup stage and still performs exact cleanup', async () => {
    const f = await fixture({ startupTimeoutMs: 30 });
    f.bridge.ensureStarted = async () => new Promise(() => undefined);

    const outcome = await Promise.race([
      f.service.start().then(
        () => 'resolved',
        (error: unknown) => error,
      ),
      new Promise<'not_bounded'>((resolvePromise) => {
        setTimeout(() => resolvePromise('not_bounded'), 300);
      }),
    ]);

    expect(outcome).toMatchObject({ code: 'operation_unavailable' });
    await vi.waitFor(() => expect(f.trace).toEqual(expect.arrayContaining([
      'router.dispose', 'workers.dispose', 'bridge.stop', 'identity.remove:starting',
    ])));
  });

  it('keeps startup failure and hung rollback inside one total deadline', async () => {
    const f = await fixture({ startupTimeoutMs: 80, shutdownTimeoutMs: 20_000 });
    f.bridge.ensureStarted = async () => new Promise(() => undefined);
    f.router.disposeHook = async () => new Promise(() => undefined);

    const outcome = await Promise.race([
      f.service.start().then(
        () => 'resolved',
        (error: unknown) => error,
      ),
      new Promise<'not_bounded'>((resolvePromise) => {
        setTimeout(() => resolvePromise('not_bounded'), 300);
      }),
    ]);

    expect(outcome).toMatchObject({ code: 'operation_unavailable' });
    expect(f.identityStore.removed).toEqual([STARTING]);
  });

  it('performs no constructor I/O and copies only the QUUKK config environment', async () => {
    const root = await temporaryDirectory();
    const absentStorage = join(root, 'absent', 'rongcloud');
    const environment = {
      QUUKK_CLAWMESSENGER_LOG_LEVEL: 'debug',
      QUUKK_CLAWMESSENGER_SERVER_URL: 'https://example.test/im',
      AWS_SECRET_ACCESS_KEY: 'must-not-be-copied',
    };
    const overrides: ConfigOverrides = { providerPathOverrides: { codex: join(root, 'codex.exe') } };
    const f = await fixture({ storageRoot: absentStorage, configEnvironment: environment, configOverrides: overrides });
    expect(f.trace).toEqual([]);
    await expect(stat(absentStorage)).rejects.toMatchObject({ code: 'ENOENT' });

    environment.QUUKK_CLAWMESSENGER_LOG_LEVEL = 'error';
    overrides.providerPathOverrides!.codex = join(root, 'changed.exe');
    await start(f);
    await f.service.settings(new AbortController().signal);

    expect(f.store.snapshots.map((value) => value.environment)).toEqual([
      {},
      {
        QUUKK_CLAWMESSENGER_LOG_LEVEL: 'debug',
        QUUKK_CLAWMESSENGER_SERVER_URL: 'https://example.test/im',
      },
    ]);
    expect(f.store.snapshots[1]!.overrides.providerPathOverrides?.codex).toBe(join(root, 'codex.exe'));
    await f.service.stop();
  });

  it('starts once, activates restored bindings only after protected storage exists, and returns one ready identity', async () => {
    const root = await temporaryDirectory();
    const binding = completeBinding('opencode', root);
    const f = await fixture({ bindings: [binding] });
    f.runtime.catalog = runtimeCatalog(root);
    f.router.activateHook = async (identity) => {
      const details = await stat(join(f.storageRoot, identity.runtimeId));
      expect(details.isDirectory()).toBe(true);
    };

    const first = f.service.start();
    const second = f.service.start();
    expect(second).toBe(first);
    await expect(first).resolves.toEqual(READY);
    expect(f.trace).toEqual([
      'bridge.start',
      'bindings.list',
      `router.activate:${binding.runtimeId}:${binding.nodeId}`,
      'workers.reconcile',
      'http.start',
      'identity.ready:127.0.0.1:43111',
    ]);
    expect(f.workers.reconciliations[0]).toEqual([{
      runtimeId: binding.runtimeId,
      nodeId: binding.nodeId,
      enabled: true,
      tokenRef: binding.tokenRef,
      storageDir: join(f.storageRoot, binding.runtimeId),
    }]);
    await f.service.stop();
  });

  it('rejects a different runtime client and rolls every owned component back in reverse order', async () => {
    const f = await fixture();
    const other = new FakeRuntime(runtimeCatalog(f.root), f.trace);
    f.bridge.ensureStarted = async () => ({
      client: other,
      identity: {
        schema_version: 1,
        address: '127.0.0.1:45123',
        pid: 5151,
        version: '0.1.0-beta.1',
        instance_id: 'br_0123456789abcdef0123456789abcdef',
        started_at: '2026-08-27T07:59:59.000Z',
      },
      recovered: false,
    });
    await expect(f.service.start()).rejects.toMatchObject({ code: 'operation_unavailable' });
    expect(f.trace.slice(-4)).toEqual([
      'router.dispose', 'workers.dispose', 'bridge.stop', 'identity.remove:starting',
    ]);
    expect(f.logger.closeCalls).toBe(1);
  });

  it.each(['bridge', 'activate', 'reconcile', 'http', 'identity'] as const)(
    'rolls back safely when the %s acquisition fails',
    async (stage) => {
      const root = await temporaryDirectory();
      const binding = completeBinding('opencode', root);
      const f = await fixture({ bindings: stage === 'activate' || stage === 'reconcile' ? [binding] : [] });
      if (stage === 'bridge') {
        f.bridge.ensureStarted = async () => { throw new Error('unsafe bridge details'); };
      } else if (stage === 'activate') {
        f.router.activateHook = async () => { throw new Error('unsafe router details'); };
      } else if (stage === 'reconcile') {
        f.workers.reconcileHook = async () => { throw new Error('unsafe worker details'); };
      } else if (stage === 'http') {
        f.http.startHook = async () => { throw new Error('unsafe http details'); };
      } else {
        f.identityStore.markReadyHook = async () => { throw new Error('unsafe identity details'); };
      }

      await expect(f.service.start()).rejects.toMatchObject({ code: 'operation_unavailable' });
      expect(f.router.disposeCalls).toBe(1);
      expect(f.workers.disposeCalls).toBe(1);
      expect(f.http.closeCalls).toBe(stage === 'http' || stage === 'identity' ? 1 : 0);
      expect(f.logger.closeCalls).toBe(1);
      expect(f.identityStore.removed).toEqual([STARTING]);
      expect(JSON.stringify(f.logger.records)).not.toContain('unsafe');
    },
  );

  it('rolls back when restored binding storage cannot be acquired', async () => {
    const root = await temporaryDirectory();
    const storageFile = join(root, 'not-a-directory');
    await writeFile(storageFile, 'occupied', { encoding: 'utf8' });
    const binding = completeBinding('opencode', root);
    const f = await fixture({ bindings: [binding], storageRoot: storageFile });

    await expect(f.service.start()).rejects.toMatchObject({ code: 'operation_unavailable' });
    expect(f.router.disposeCalls).toBe(1);
    expect(f.workers.disposeCalls).toBe(1);
    expect(f.identityStore.removed).toEqual([STARTING]);
  });

  it('never adopts or removes a ready identity that is not the exact claimed transition', async () => {
    const f = await fixture();
    f.identityStore.markReadyHook = async (expected, address) => ({
      ...expected,
      state: 'ready',
      address,
      instance_id: `svc_${'f'.repeat(32)}`,
    });

    await expect(f.service.start()).rejects.toMatchObject({ code: 'operation_unavailable' });
    expect(f.identityStore.removed).toEqual([STARTING]);
    expect(f.identityStore.removed).not.toContainEqual(expect.objectContaining({
      instance_id: `svc_${'f'.repeat(32)}`,
    }));
  });

  it('shares one stop across concurrent calls and waits for an in-flight markReady before exact removal', async () => {
    const f = await fixture();
    let resolveReady!: (value: ReadyDaemonIdentity) => void;
    f.identityStore.markReadyHook = () => new Promise((resolvePromise) => { resolveReady = resolvePromise; });
    const starting = f.service.start();
    await vi.waitFor(() => expect(f.trace).toContain('identity.ready:127.0.0.1:43111'));

    const firstStop = f.service.stop();
    const secondStop = f.service.stop();
    expect(secondStop).toBe(firstStop);
    resolveReady(READY);
    await firstStop;
    await expect(starting).rejects.toMatchObject({ code: 'operation_unavailable' });
    expect(f.identityStore.removed).toEqual([READY]);
    expect(f.trace.indexOf('http.close')).toBeLessThan(f.trace.indexOf('router.dispose'));
    expect(f.trace.indexOf('router.dispose')).toBeLessThan(f.trace.indexOf('workers.dispose'));
    expect(f.trace.indexOf('workers.dispose')).toBeLessThan(f.trace.indexOf('bridge.stop'));
    expect(f.logger.closeCalls).toBe(1);
  });

  it('keeps shutdown bounded and continues best-effort cleanup after hung components', async () => {
    const f = await fixture({ shutdownTimeoutMs: 80 });
    await start(f);
    f.http.closeHook = () => new Promise(() => undefined);
    f.router.disposeHook = () => new Promise(() => undefined);
    f.logger.closeHook = () => new Promise(() => undefined);
    const before = Date.now();
    await f.service.stop();
    expect(Date.now() - before).toBeLessThan(600);
    expect(f.trace).toContain('workers.dispose');
    expect(f.trace).toContain('bridge.stop');
    expect(f.identityStore.removed).toEqual([READY]);
  });

  it('reserves shutdown time to await the final exact identity removal', async () => {
    const f = await fixture({ shutdownTimeoutMs: 80 });
    await start(f);
    f.http.closeHook = () => new Promise(() => undefined);
    let removalCompleted = false;
    f.identityStore.removeHook = async () => {
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 20));
      removalCompleted = true;
    };

    await f.service.stop();
    expect(removalCompleted).toBe(true);
    expect(f.identityStore.removed).toEqual([READY]);
  });

  it('turns repeated response-flushed shutdown requests into one asynchronous stop', async () => {
    const f = await fixture();
    await start(f);
    f.service.shutdownAfterResponse();
    f.service.shutdownAfterResponse();
    await vi.waitFor(() => expect(f.identityStore.removed).toEqual([READY]));
    expect(f.http.closeCalls).toBe(1);
    expect(f.router.disposeCalls).toBe(1);
  });
});

describe('QuukkService mutations', () => {
  it('rejects structurally invalid enable requests before any binding, router, or worker side effect', async () => {
    const f = await fixture();
    await start(f);
    f.trace.length = 0;
    const invalidRequests: readonly (readonly string[])[] = [
      [],
      [IDS.opencode, IDS.openclaw, IDS.codex, IDS.hermes, `rt_${'5'.repeat(32)}`],
      [IDS.opencode, IDS.opencode],
      ['../not-a-runtime'],
    ];

    const outcomes = await Promise.all(invalidRequests.map(async (runtimeIds) => {
      try {
        await f.service.enable(runtimeIds, new AbortController().signal);
        return 'resolved';
      } catch (error) {
        return error instanceof ServiceError ? error.code : 'unexpected_error';
      }
    }));

    expect(outcomes).toEqual(invalidRequests.map(() => 'invalid_request'));
    expect(f.trace).toEqual([]);
    await f.service.stop();
  });

  it('rejects an enable result that is not an exact one-for-one request projection', async () => {
    const f = await fixture();
    await start(f);
    f.trace.length = 0;
    f.bindings.enableHook = async () => [
      { runtimeId: IDS.opencode, ok: false, errorCode: 'runtime_not_ready' },
    ];

    await expect(f.service.enable(
      [IDS.opencode, IDS.hermes],
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'operation_unavailable' });
    expect(f.trace).toEqual([
      `bindings.enable:${IDS.opencode},${IDS.hermes}`,
      'bindings.list',
      'workers.reconcile',
    ]);
    await f.service.stop();
  });

  it('rejects an ok enable result unless the exact fresh binding is complete and enabled', async () => {
    const f = await fixture();
    await start(f);
    f.trace.length = 0;
    const incomplete = completeBinding('opencode', f.root, { enabled: false });
    f.bindings.enableHook = async () => {
      f.bindings.values = [incomplete];
      return [{ runtimeId: incomplete.runtimeId, ok: true, binding: incomplete }];
    };

    await expect(f.service.enable([incomplete.runtimeId], new AbortController().signal))
      .rejects.toMatchObject({ code: 'operation_unavailable' });
    expect(f.trace).toEqual([
      `bindings.enable:${incomplete.runtimeId}`,
      'bindings.list',
      'workers.reconcile',
    ]);
    await f.service.stop();
  });

  it('finishes enable convergence after a caller aborts following durable persistence', async () => {
    const f = await fixture();
    await start(f);
    f.trace.length = 0;
    const controller = new AbortController();
    const binding = completeBinding('opencode', f.root);
    f.bindings.enableHook = async () => {
      f.bindings.values = [binding];
      controller.abort();
      return [{ runtimeId: binding.runtimeId, ok: true, binding }];
    };

    await expect(f.service.enable([binding.runtimeId], controller.signal))
      .rejects.toMatchObject({ code: 'operation_unavailable' });
    expect(f.trace).toEqual([
      `bindings.enable:${binding.runtimeId}`,
      'bindings.list',
      `router.activate:${binding.runtimeId}:${binding.nodeId}`,
      'workers.reconcile',
    ]);
    await f.service.stop();
  });

  it('keeps partial enable durable, activates only exact fresh successes, and reconciles once', async () => {
    const f = await fixture();
    await start(f);
    f.trace.length = 0;
    const success = completeBinding('opencode', f.root);
    const failedId = IDS.hermes;
    f.bindings.enableHook = async () => {
      f.bindings.values = [success];
      return [
        { runtimeId: success.runtimeId, ok: true, binding: success },
        { runtimeId: failedId, ok: false, errorCode: 'registration_transport' },
      ];
    };

    const response = await f.service.enable([success.runtimeId, failedId], new AbortController().signal);
    expect(response.results).toEqual([
      {
        runtimeId: success.runtimeId,
        ok: true,
        binding: {
          runtimeId: success.runtimeId,
          nodeId: success.nodeId,
          nodeName: success.nodeName,
          enabled: true,
          registrationState: 'offline',
          updatedAt: success.updatedAt,
        },
      },
      {
        runtimeId: failedId,
        ok: false,
        error: { code: 'registration_transport', category: 'transport', retryable: true },
      },
    ]);
    expect(JSON.stringify(response)).not.toContain('tokenRef');
    expect(f.trace).toEqual([
      `bindings.enable:${success.runtimeId},${failedId}`,
      'bindings.list',
      `router.activate:${success.runtimeId}:${success.nodeId}`,
      'workers.reconcile',
    ]);
    expect(f.workers.reconciliations.at(-1)?.map((value) => value.runtimeId)).toEqual([success.runtimeId]);
    await f.service.stop();
  });

  it('continues disable cleanup in exact order and reports one fixed failure after durable disable', async () => {
    const binding = completeBinding('codex', await temporaryDirectory());
    const f = await fixture({ bindings: [binding] });
    await start(f);
    f.trace.length = 0;
    f.router.disposeBindingHook = async () => { throw new Error('unsafe router failure'); };
    f.workers.stopHook = async () => { throw new Error('unsafe worker failure'); };

    await expect(f.service.disable(binding.runtimeId, new AbortController().signal))
      .rejects.toMatchObject({ code: 'operation_unavailable' });
    expect(f.trace).toEqual([
      `bindings.disable:${binding.runtimeId}`,
      'bindings.list',
      `router.disposeBinding:${binding.runtimeId}:${binding.nodeId}`,
      `workers.stop:${binding.runtimeId}:${binding.nodeId}`,
      'bindings.list',
      'workers.reconcile',
    ]);
    expect(f.bindings.values[0]?.enabled).toBe(false);
    expect(JSON.stringify(f.logger.records)).not.toContain('unsafe');
    await f.service.stop();
  });

  it('finishes disable cleanup and reconcile after caller abort follows durable persistence', async () => {
    const binding = completeBinding('codex', await temporaryDirectory());
    const f = await fixture({ bindings: [binding] });
    await start(f);
    f.trace.length = 0;
    const controller = new AbortController();
    f.bindings.disableHook = async () => {
      const disabled = { ...binding, enabled: false, registrationState: 'offline' as const };
      f.bindings.values = [disabled];
      controller.abort();
      return disabled;
    };

    await expect(f.service.disable(binding.runtimeId, controller.signal))
      .rejects.toMatchObject({ code: 'operation_unavailable' });
    expect(f.trace).toEqual([
      `bindings.disable:${binding.runtimeId}`,
      'bindings.list',
      `router.disposeBinding:${binding.runtimeId}:${binding.nodeId}`,
      `workers.stop:${binding.runtimeId}:${binding.nodeId}`,
      'bindings.list',
      'workers.reconcile',
    ]);
    await f.service.stop();
  });

  it('rejects a disable result for any identity other than the exact requested runtime', async () => {
    const binding = completeBinding('codex', await temporaryDirectory());
    const f = await fixture({ bindings: [binding] });
    await start(f);
    f.trace.length = 0;
    f.bindings.disableHook = async () => completeBinding('hermes', f.root);

    await expect(f.service.disable(binding.runtimeId, new AbortController().signal))
      .rejects.toMatchObject({ code: 'operation_unavailable' });
    expect(f.trace).toEqual([`bindings.disable:${binding.runtimeId}`, 'bindings.list']);
    await f.service.stop();
  });

  it('does not reconcile a failed reregister and reconciles exactly once after success', async () => {
    const binding = completeBinding('openclaw', await temporaryDirectory());
    const f = await fixture({ bindings: [binding] });
    await start(f);
    f.trace.length = 0;
    f.bindings.reregisterHook = async (runtimeId) => ({ runtimeId, ok: false, errorCode: 'token_refresh_failed' });
    await expect(f.service.reregister(binding.runtimeId, new AbortController().signal))
      .rejects.toMatchObject({ code: 'operation_unavailable' });
    expect(f.trace).toEqual([`bindings.reregister:${binding.runtimeId}`]);

    f.trace.length = 0;
    const refreshed = { ...binding, tokenRef: `rc_${'e'.repeat(32)}` };
    f.bindings.reregisterHook = async (runtimeId) => {
      f.bindings.values = [refreshed];
      return { runtimeId, ok: true, binding: refreshed };
    };
    await expect(f.service.reregister(binding.runtimeId, new AbortController().signal)).resolves.toMatchObject({
      schemaVersion: 1,
      binding: { runtimeId: binding.runtimeId, nodeId: binding.nodeId },
    });
    expect(f.trace).toEqual([
      `bindings.reregister:${binding.runtimeId}`,
      'bindings.list',
      'workers.reconcile',
    ]);
    await f.service.stop();
  });

  it('finishes reregister reconcile after caller abort follows durable persistence', async () => {
    const binding = completeBinding('openclaw', await temporaryDirectory());
    const f = await fixture({ bindings: [binding] });
    await start(f);
    f.trace.length = 0;
    const controller = new AbortController();
    const refreshed = { ...binding, tokenRef: `rc_${'e'.repeat(32)}` };
    f.bindings.reregisterHook = async (runtimeId) => {
      f.bindings.values = [refreshed];
      controller.abort();
      return { runtimeId, ok: true, binding: refreshed };
    };

    await expect(f.service.reregister(binding.runtimeId, controller.signal))
      .rejects.toMatchObject({ code: 'operation_unavailable' });
    expect(f.trace).toEqual([
      `bindings.reregister:${binding.runtimeId}`,
      'bindings.list',
      'workers.reconcile',
    ]);
    await f.service.stop();
  });

  it('rejects a reregister result labelled for another runtime without reconciling', async () => {
    const binding = completeBinding('openclaw', await temporaryDirectory());
    const f = await fixture({ bindings: [binding] });
    await start(f);
    f.trace.length = 0;
    f.bindings.reregisterHook = async () => ({
      runtimeId: IDS.hermes,
      ok: true,
      binding,
    });

    await expect(f.service.reregister(binding.runtimeId, new AbortController().signal))
      .rejects.toMatchObject({ code: 'operation_unavailable' });
    expect(f.trace).toEqual([`bindings.reregister:${binding.runtimeId}`]);
    await f.service.stop();
  });

  it('globally serializes mutations and fences a queued mutation when stop begins', async () => {
    const f = await fixture();
    await start(f);
    f.trace.length = 0;
    let releaseEnable!: () => void;
    f.bindings.enableHook = () => new Promise((resolvePromise) => {
      releaseEnable = () => resolvePromise([{ runtimeId: IDS.opencode, ok: false, errorCode: 'runtime_not_ready' }]);
    });
    const enable = f.service.enable([IDS.opencode], new AbortController().signal);
    await vi.waitFor(() => expect(f.trace).toEqual([`bindings.enable:${IDS.opencode}`]));
    const disable = f.service.disable(IDS.opencode, new AbortController().signal);
    expect(f.trace).not.toContain(`bindings.disable:${IDS.opencode}`);
    const stopping = f.service.stop();
    releaseEnable();
    await expect(enable).rejects.toMatchObject({ code: 'operation_unavailable' });
    await expect(disable).rejects.toMatchObject({ code: 'operation_unavailable' });
    await stopping;
    expect(f.trace).not.toContain(`bindings.disable:${IDS.opencode}`);
  });
});

describe('QuukkService projections and settings', () => {
  it('uses fixed provider order and exact runtime/binding/worker joins', async () => {
    const root = await temporaryDirectory();
    const opencode = completeBinding('opencode', root);
    const f = await fixture({ bindings: [opencode] });
    f.workers.values = [{
      runtimeId: opencode.runtimeId,
      nodeId: opencode.nodeId!,
      state: 'online',
      instanceId: 'rw_0123456789abcdef0123456789abcdef',
      restartCount: 2,
    }];
    await start(f);
    f.runtime.catalog = [
      ...runtimeCatalog(root).slice(0, 1),
      { ...runtimeCatalog(root)[1]!, id: undefined },
      ...runtimeCatalog(root).slice(2),
    ];
    f.bindings.values.push(completeBinding('openclaw', root));
    const response = await f.service.runtimes(new AbortController().signal);
    expect(response.runtimes.map((runtime) => runtime.provider)).toEqual(PROVIDERS);
    expect(response.runtimes[0]?.binding?.runtimeId).toBe(opencode.runtimeId);
    expect(response.runtimes[0]?.worker).toEqual({ state: 'online', restartCount: 2 });
    expect(response.runtimes[1]).toMatchObject({ runtimeId: null, binding: null, worker: null });
    await f.service.stop();
  });

  it('fails closed if a runtime advertises interactive approvals', async () => {
    const f = await fixture();
    await start(f);
    f.runtime.catalog[0] = { ...f.runtime.catalog[0]!, capabilities: capabilities(true) };
    await expect(f.service.runtimes(new AbortController().signal))
      .rejects.toMatchObject({ code: 'bridge_unavailable' });
    await f.service.stop();
  });

  it('returns newest 100 ascending activity rows and diagnostics with basenames only', async () => {
    const f = await fixture();
    const executablePath = join(await temporaryDirectory(), 'secret', 'opencode.exe');
    f.logger.activityRecords.push(...Array.from({ length: 120 }, (_, index) => ({
      id: index + 1,
      time: '2026-08-27T08:00:00.000Z',
      level: 'info' as const,
      event: 'task_started',
      runtimeId: IDS.opencode,
      taskId: 'task_1_1',
    })));
    f.store.warnings = ['config_recovery_required', 'D:\\secret\\unsafe'];
    f.runtime.catalog[0] = { ...f.runtime.catalog[0]!, path: executablePath };
    await start(f);

    const activity = await f.service.activity(new AbortController().signal);
    expect(activity.events).toHaveLength(100);
    expect(activity.events[0]?.id).toBe(21);
    expect(activity.events.at(-1)?.id).toBe(120);
    const diagnostics = await f.service.diagnostics(new AbortController().signal);
    const serialized = JSON.stringify(diagnostics);
    expect(diagnostics.runtimes[0]?.executableName).toBe(basename(executablePath));
    expect(diagnostics.warnings).toEqual(['config_recovery_required']);
    expect(serialized).not.toContain(dirname(executablePath));
    expect(serialized).not.toContain('nodeId');
    expect(serialized).not.toContain('tokenRef');
    expect(diagnostics.logging).toEqual({ dropped: 3, retained: 120 });
    await f.service.stop();
  });

  it('reads stored and effective settings separately and applies a fresh saved log level', async () => {
    const root = await temporaryDirectory();
    const environment = {
      QUUKK_CLAWMESSENGER_LOG_LEVEL: 'debug',
      QUUKK_CLAWMESSENGER_WORKDIR: root,
      HOME: 'must-not-be-copied',
    };
    const f = await fixture({
      configOverrides: { serverUrl: 'https://override.example/im' },
      configEnvironment: environment,
    });
    await start(f);
    const initial = await f.service.settings(new AbortController().signal);
    expect(initial.stored).toEqual(DEFAULT_CONFIG);
    expect(initial.effective).toMatchObject({
      serverUrl: 'https://override.example/im',
      logLevel: 'debug',
    });
    expect(f.store.snapshots.at(-1)?.environment).not.toHaveProperty('HOME');

    const saved = { ...cloneConfig(DEFAULT_CONFIG), logLevel: 'warn' as const };
    const response = await f.service.saveSettings(saved, new AbortController().signal);
    expect(f.store.saveCalls).toEqual([saved]);
    expect(response.stored.logLevel).toBe('warn');
    expect(response.effective.logLevel).toBe('debug');
    expect(f.logger.levels.at(-1)).toBe('debug');
    await f.service.stop();
  });
});

describe('conservative production router control', () => {
  it('denies every remote mutation, exposes no model catalog, and projects exact local status only', async () => {
    const root = await temporaryDirectory();
    const trace: string[] = [];
    const runtime = new FakeRuntime(runtimeCatalog(root), trace);
    const bindings = new FakeBindings(trace);
    const binding = completeBinding('hermes', root);
    bindings.values = [binding];
    const workers = new FakeWorkers(trace);
    workers.values = [{
      runtimeId: binding.runtimeId,
      nodeId: binding.nodeId!,
      state: 'online',
      instanceId: 'rw_0123456789abcdef0123456789abcdef',
      restartCount: 0,
    }];
    const control = createConservativeRouterControl({ runtimes: runtime, bindings, workers });
    const identity = { runtimeId: binding.runtimeId, nodeId: binding.nodeId! };
    await expect(control.authorize({
      identity,
      conversationKey: 'safe',
      senderId: 'sender',
      scope: 'device.mutate',
    })).resolves.toBe(false);
    await expect(control.device({ identity, senderId: 'sender', command: 'disable' })).resolves.toEqual({
      status: 'error', code: 'authorization_denied', message: 'authorization_denied',
    });
    await expect(control.card({
      kind: 'custom', identity, senderId: 'sender', conversationKey: 'safe',
      action: 'anything', payload: {},
    } as never)).resolves.toEqual({
      status: 'error',
      code: 'unsupported_interactive_approval',
      message: 'unsupported_interactive_approval',
    });
    await expect(control.modelCatalog(identity)).resolves.toEqual({ defaultModel: null, providers: [] });
    await expect(control.status(identity)).resolves.toEqual({
      enabled: true, worker: 'online', runtime: 'ready',
    });
    await expect(control.status({ ...identity, nodeId: 'hermes_other' })).resolves.toEqual({
      enabled: false, worker: 'stopped', runtime: 'ready',
    });
    workers.snapshots = () => { throw new Error('unsafe worker snapshot'); };
    await expect(control.status(identity)).resolves.toEqual({
      enabled: true, worker: 'stopped', runtime: 'ready',
    });
    expect(trace).not.toContain(expect.stringContaining('bindings.disable'));
  });
});

describe('startProductionService', () => {
  it('removes the exact claimed identity when production options fail before acquisition', async () => {
    const root = await temporaryDirectory();
    const trace: string[] = [];
    const identityStore = new FakeIdentityStore(trace);

    await expect(startProductionService({
      identity: STARTING,
      identityStore,
      homeDirectory: root,
      processEnvironment: {},
      startupTimeoutMs: 60_001,
    })).rejects.toMatchObject({ code: 'operation_unavailable' });
    expect(identityStore.removed).toEqual([STARTING]);
  });

  it('keeps production composition, service start, rollback, and identity removal under one deadline', async () => {
    const root = await temporaryDirectory();
    const trace: string[] = [];
    const identityStore = new FakeIdentityStore(trace);
    const factories: ProductionServiceFactories = {
      openStore: async () => {
        trace.push('store.open');
        return new Promise(() => undefined);
      },
      openLogger: async () => { throw new Error('must_not_run'); },
      createBridge: () => { throw new Error('must_not_run'); },
      createRegistrationClient: () => { throw new Error('must_not_run'); },
      openBindings: async () => { throw new Error('must_not_run'); },
      createRouterState: () => { throw new Error('must_not_run'); },
      createWorkers: () => { throw new Error('must_not_run'); },
      createRouter: () => { throw new Error('must_not_run'); },
      createHttp: () => { throw new Error('must_not_run'); },
    };

    const outcome = await Promise.race([
      startProductionService({
        identity: STARTING,
        identityStore,
        homeDirectory: root,
        processEnvironment: {},
        startupTimeoutMs: 80,
        shutdownTimeoutMs: 80,
        factories,
      }).then(
        () => 'resolved',
        (error: unknown) => error,
      ),
      new Promise<'not_bounded'>((resolvePromise) => {
        setTimeout(() => resolvePromise('not_bounded'), 300);
      }),
    ]);

    expect(outcome).toMatchObject({ code: 'operation_unavailable' });
    expect(trace).toEqual(['store.open', 'identity.remove:starting']);
    expect(identityStore.removed).toEqual([STARTING]);
  });

  it('uses the fixed acquisition order, late-binds worker events, and needs no external process or network', async () => {
    const root = await temporaryDirectory();
    const trace: string[] = [];
    const store = new FakeStore();
    store.snapshotHook = () => { trace.push('store.snapshot'); };
    const logger = new FakeLogger();
    const runtime = new FakeRuntime(runtimeCatalog(root), trace);
    const bindings = new FakeBindings(trace);
    const workers = new FakeWorkers(trace) as FakeWorkers & {
      send: () => Promise<undefined>;
      receipt: () => Promise<void>;
      joinChatroom: () => Promise<void>;
    };
    workers.send = async () => undefined;
    workers.receipt = async () => undefined;
    workers.joinChatroom = async () => undefined;
    const router = new FakeRouter(trace);
    let workerEvent: ((identity: WorkerIdentity, event: never) => void) | undefined;
    let refreshCredential: ((binding: SupervisorBinding) => Promise<string>) | undefined;
    const http = new FakeHttp(trace);
    const identityStore = new FakeIdentityStore(trace);
    let bridgeStarts = 0;

    const factories: ProductionServiceFactories = {
      openStore: async () => { trace.push('store.open'); return store; },
      openLogger: async () => { trace.push('logger.open'); return logger; },
      createBridge: () => ({
        ensureStarted: async () => {
          bridgeStarts += 1;
          trace.push('bridge.start');
          return {
            client: runtime as never,
            identity: {
              schema_version: 1,
              address: '127.0.0.1:45123',
              pid: 5151,
              version: '0.1.0-beta.1',
              instance_id: 'br_0123456789abcdef0123456789abcdef',
              started_at: '2026-08-27T07:59:59.000Z',
            },
            recovered: false,
          };
        },
        stop: async () => { trace.push('bridge.stop'); },
      }),
      createRegistrationClient: () => {
        trace.push('registration.create');
        return {
          getAppKey: async () => 'app-key',
          register: async () => { throw new Error('unused'); },
          refreshToken: async () => { throw new Error('unused'); },
        };
      },
      openBindings: async () => { trace.push('bindings.open'); return bindings; },
      createRouterState: () => ({
        initialize: async () => { trace.push('routerState.initialize'); },
      }),
      createWorkers: (options) => {
        trace.push('workers.create');
        workerEvent = options.onEvent as typeof workerEvent;
        refreshCredential = options.refreshCredential;
        options.onEvent?.({ runtimeId: IDS.opencode, nodeId: 'too_early' }, {} as never);
        return workers;
      },
      createRouter: () => { trace.push('router.create'); return router; },
      createHttp: () => http,
    };

    const service = await startProductionService({
      identity: STARTING,
      identityStore,
      homeDirectory: root,
      processEnvironment: {},
      configOverrides: { serverUrl: 'https://override.example/im' },
      configEnvironment: {
        QUUKK_CLAWMESSENGER_LOG_LEVEL: 'debug',
        HOME: 'must-not-enter-config',
      },
      factories,
      staticRoot: join(root, 'ui'),
    });
    workerEvent?.({ runtimeId: IDS.opencode, nodeId: 'opencode_node' }, {} as never);
    await vi.waitFor(() => expect(trace).toContain(
      `router.event:${IDS.opencode}:opencode_node`,
    ));
    expect(trace).not.toContain(`router.event:${IDS.opencode}:too_early`);
    await service.start();
    expect(bridgeStarts).toBe(2);
    expect(trace).toEqual(expect.arrayContaining([
      'store.open', 'store.snapshot', 'logger.open', 'bridge.start', 'registration.create', 'bindings.open',
      'routerState.initialize', 'workers.create', 'router.create', 'workers.reconcile',
      'http.start', 'identity.ready:127.0.0.1:43111',
    ]));
    const ordered = [
      'store.open', 'store.snapshot', 'logger.open', 'bridge.start', 'registration.create', 'bindings.open',
      'routerState.initialize', 'workers.create', 'router.create', 'workers.reconcile',
      'http.start', 'identity.ready:127.0.0.1:43111',
    ];
    for (let index = 1; index < ordered.length; index += 1) {
      expect(trace.indexOf(ordered[index - 1]!)).toBeLessThan(trace.indexOf(ordered[index]!));
    }
    expect(store.snapshots[0]).toEqual({
      overrides: { serverUrl: 'https://override.example/im' },
      environment: { QUUKK_CLAWMESSENGER_LOG_LEVEL: 'debug' },
    });

    const binding = completeBinding('opencode', root);
    const refreshed = { ...binding, tokenRef: `rc_${'e'.repeat(32)}` };
    bindings.values = [refreshed];
    store.credentials.set(refreshed.tokenRef!, {
      runtimeId: refreshed.runtimeId,
      provider: refreshed.provider,
      nodeId: refreshed.nodeId!,
      serverUrl: 'https://example.test/im',
      appKey: 'app-key',
      token: 'secret-token',
      createdAt: refreshed.updatedAt,
    });
    bindings.reregisterHook = async () => ({
      runtimeId: IDS.hermes,
      ok: true,
      binding: refreshed,
    });
    expect(refreshCredential).toBeTypeOf('function');
    const supervisorBinding = {
      runtimeId: binding.runtimeId,
      nodeId: binding.nodeId!,
      enabled: true,
      tokenRef: binding.tokenRef!,
      storageDir: join(root, 'rongcloud', binding.runtimeId),
    };
    await expect(refreshCredential!(supervisorBinding))
      .rejects.toMatchObject({ code: 'operation_unavailable' });
    expect(trace.filter((entry) => entry === 'workers.reconcile')).toHaveLength(1);

    bindings.reregisterHook = async () => ({
      runtimeId: binding.runtimeId,
      ok: true,
      binding: refreshed,
    });
    await expect(refreshCredential!(supervisorBinding)).resolves.toBe('secret-token');
    expect(trace.filter((entry) => entry === 'workers.reconcile')).toHaveLength(2);

    let releaseRefresh!: () => void;
    bindings.reregisterHook = () => new Promise((resolvePromise) => {
      releaseRefresh = () => resolvePromise({
        runtimeId: binding.runtimeId,
        ok: true,
        binding: refreshed,
      });
    });
    const reregisterCount = trace.filter((entry) =>
      entry === `bindings.reregister:${binding.runtimeId}`).length;
    const serializedRefresh = refreshCredential!(supervisorBinding);
    await vi.waitFor(() => expect(trace.filter((entry) =>
      entry === `bindings.reregister:${binding.runtimeId}`)).toHaveLength(reregisterCount + 1));
    const disabling = service.disable(binding.runtimeId, new AbortController().signal);
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    expect(trace).not.toContain(`bindings.disable:${binding.runtimeId}`);
    releaseRefresh();
    await expect(serializedRefresh).resolves.toBe('secret-token');
    await expect(disabling).resolves.toMatchObject({
      binding: { runtimeId: binding.runtimeId, enabled: false },
    });
    expect(workers.reconciliations.at(-1)).toEqual([]);
    await service.stop();
  });

  it.each([
    'store', 'snapshot', 'logger', 'bridge', 'bridge_start', 'registration',
    'bindings', 'state', 'state_initialize', 'workers', 'router',
  ] as const)(
    'rolls back every completed acquisition when production %s composition fails',
    async (failureStage) => {
      const root = await temporaryDirectory();
      const trace: string[] = [];
      const store = new FakeStore();
      const logger = new FakeLogger();
      logger.closeHook = async () => { trace.push('logger.close'); };
      const runtime = new FakeRuntime(runtimeCatalog(root), trace);
      const bindings = new FakeBindings(trace);
      const workers = new FakeWorkers(trace) as FakeWorkers & {
        send: () => Promise<undefined>;
        receipt: () => Promise<void>;
        joinChatroom: () => Promise<void>;
      };
      workers.send = async () => undefined;
      workers.receipt = async () => undefined;
      workers.joinChatroom = async () => undefined;
      const router = new FakeRouter(trace);
      const identityStore = new FakeIdentityStore(trace);
      const fail = (stage: typeof failureStage) => {
        if (stage === failureStage) throw new Error(`unsafe ${stage}`);
      };
      store.snapshotHook = () => { trace.push('store.snapshot'); fail('snapshot'); };
      const factories: ProductionServiceFactories = {
        openStore: async () => { trace.push('store.open'); fail('store'); return store; },
        openLogger: async () => { trace.push('logger.open'); fail('logger'); return logger; },
        createBridge: () => {
          trace.push('bridge.create');
          fail('bridge');
          return {
            ensureStarted: async () => {
              trace.push('bridge.start');
              fail('bridge_start');
              return {
                client: runtime as never,
                identity: {
                  schema_version: 1 as const,
                  address: '127.0.0.1:45123', pid: 5151, version: '0.1.0-beta.1',
                  instance_id: 'br_0123456789abcdef0123456789abcdef',
                  started_at: '2026-08-27T07:59:59.000Z',
                },
                recovered: false,
              };
            },
            stop: async () => { trace.push('bridge.stop'); },
          };
        },
        createRegistrationClient: () => {
          trace.push('registration.create');
          fail('registration');
          return {
            getAppKey: async () => 'app-key',
            register: async () => { throw new Error('unused'); },
            refreshToken: async () => { throw new Error('unused'); },
          };
        },
        openBindings: async () => {
          trace.push('bindings.open'); fail('bindings'); return bindings;
        },
        createRouterState: () => {
          trace.push('state.create'); fail('state');
          return {
            initialize: async () => { trace.push('state.initialize'); fail('state_initialize'); },
          };
        },
        createWorkers: () => {
          trace.push('workers.create'); fail('workers'); return workers;
        },
        createRouter: () => {
          trace.push('router.create'); fail('router'); return router;
        },
        createHttp: () => new FakeHttp(trace),
      };

      await expect(startProductionService({
        identity: STARTING,
        identityStore,
        homeDirectory: root,
        processEnvironment: {},
        factories,
      })).rejects.toMatchObject({ code: 'operation_unavailable' });
      expect(identityStore.removed).toEqual([STARTING]);
      if (['bridge_start', 'registration', 'bindings', 'state', 'state_initialize', 'workers', 'router']
        .includes(failureStage)) {
        expect(trace).toContain('bridge.stop');
        expect(trace).toContain('logger.close');
      }
      expect(JSON.stringify(logger.records)).not.toContain('unsafe');
    },
  );
});

describe('ServiceError', () => {
  it('serializes only a fixed public code', () => {
    expect(new ServiceError('operation_unavailable').toJSON()).toEqual({ code: 'operation_unavailable' });
  });
});
