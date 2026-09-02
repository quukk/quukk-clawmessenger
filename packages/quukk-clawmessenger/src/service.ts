import { createHmac } from 'node:crypto';
import { chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import {
  BindingService,
  type BindingServiceDependencies,
  type EnableResult,
} from './bindings/service.js';
import {
  RUNTIME_ID_PATTERN,
  StoredConfigSchema,
  TOKEN_REF_PATTERN,
  type ConfigOverrides,
  type RongCloudCredential,
  type RuntimeBinding,
  type RuntimeDiscoveryStatus,
  type StoredConfig,
} from './config/schema.js';
import { localPaths } from './config/paths.js';
import {
  LocalStore,
  authorizeWorkdir,
  type StoreSnapshot,
} from './config/store.js';
import { BridgeClient } from './go/client.js';
import {
  BridgeHealthSchema,
  BridgeRuntimeListSchema,
  type BridgeHealth,
  type BridgeRuntime,
  type BridgeTaskPort,
} from './go/types.js';
import {
  ActivityResponseSchema,
  BindingMutationResponseSchema,
  DiagnosticsResponseSchema,
  EnableResponseSchema,
  LocalRoutes,
  RuntimesResponseSchema,
  SettingsResponseSchema,
  PairingResponseSchema,
  type ActivityResponse,
  type BindingMutationResponse,
  type ControlStatusResponse,
  type DiagnosticsResponse,
  type EnableResponse,
  type LocalApiPort,
  type LocalControlPort,
  type RuntimesResponse,
  type RuntimeView,
  type SafeBindingView,
  type SettingsResponse,
  type PairingResponse,
} from './http/routes.js';
import { BrowserSessionStore, deriveControlCredential } from './http/security.js';
import { LocalHttpServer, type LocalHttpServerOptions } from './http/server.js';
import { LaunchTicketStore } from './http/tickets.js';
import { PairingClient } from './pairing/client.js';
import {
  PairingService,
  type PairingRuntimeSource,
  type PairingServiceSnapshot,
} from './pairing/service.js';
import {
  PAIRING_CANDIDATE_ID_PATTERN,
  PAIRING_MAX_CANDIDATES,
  pairingQrSchemaFor,
} from './pairing/schema.js';
import {
  LocalLogger,
  type ActivityRecord as LoggerActivityRecord,
  type SafeLogEvent,
} from './logging/logger.js';
import {
  BridgeProcessIdentityStore,
  type BridgeProcessIdentity,
} from './process/identity.js';
import {
  DaemonIdentitySchema,
  StartingDaemonIdentitySchema,
  type DaemonIdentity,
  type DaemonIdentityPersistence,
  type ReadyDaemonIdentity,
  type StartingDaemonIdentity,
} from './process/service-identity.js';
import {
  BridgeSupervisor,
} from './process/supervisor.js';
import { RegistrationClient } from './registration/client.js';
import type { WorkerEvent } from './rongcloud/worker-protocol.js';
import {
  RongCloudWorkerSupervisor,
  type RongCloudWorkerSupervisorOptions,
  type SupervisorBinding,
  type SupervisorCredential,
  type WorkerIdentity,
  type WorkerSnapshot,
} from './rongcloud/worker-supervisor.js';
import {
  MessageRouter,
  type AuthorizedCardIntent,
  type AuthorizedControl,
  type AuthorizedDeviceCommand,
  type MessageRouterOptions,
  type RouterBindingPort,
  type RouterControlPort,
  type RouterWorkerPort,
  type SafeCardResult,
  type SafeDeviceResult,
  type SafeDeviceStatus,
} from './router/message-router.js';
import { RouterStateStore, type RouterStateStoreOptions } from './router/session-store.js';

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 20_000;
const MAX_SHUTDOWN_TIMEOUT_MS = 20_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
const MAX_STARTUP_TIMEOUT_MS = 60_000;
const HTTP_CLOSE_TIMEOUT_MS = 2_000;
const ROUTER_DISPOSE_TIMEOUT_MS = 5_000;
const LOGGER_CLOSE_TIMEOUT_MS = 2_000;
const IDENTITY_REMOVE_TIMEOUT_MS = 2_000;
const SAFE_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const QUUKK_ENVIRONMENT_KEYS = [
  'QUUKK_CLAWMESSENGER_SERVER_URL',
  'QUUKK_CLAWMESSENGER_WORKDIR',
  'QUUKK_CLAWMESSENGER_AUTHORIZED_WORK_ROOTS',
  'QUUKK_CLAWMESSENGER_OPENCODE_PATH',
  'QUUKK_CLAWMESSENGER_OPENCLAW_PATH',
  'QUUKK_CLAWMESSENGER_CODEX_PATH',
  'QUUKK_CLAWMESSENGER_HERMES_PATH',
  'QUUKK_CLAWMESSENGER_LOG_LEVEL',
] as const;

export type ServiceStorePort = Pick<
  LocalStore,
  'snapshot' | 'saveConfig' | 'credential' | 'bridgeIdentity' | 'assertExternalMutationAllowed'
>;

export type ServiceRuntimePort = Pick<
  BridgeClient,
  'runtimes' | 'refreshRuntimes' | 'health'
>;

export interface ServiceBridgePort {
  ensureStarted(options?: { signal?: AbortSignal }): Promise<{
    client: ServiceRuntimePort;
    identity: BridgeProcessIdentity;
    recovered: boolean;
  }>;
  stop(options?: { signal?: AbortSignal }): Promise<void>;
}

export type ServiceBindingPort = Pick<
  BindingService,
  'list' | 'enableSelected' | 'enablePairingSelection' | 'disable' | 'reregister'
>;

export type ServicePairingPort = Pick<
  PairingService,
  'start' | 'snapshot' | 'cancel' | 'retryFailed'
>;

export type ServiceWorkerPort = Pick<
  RongCloudWorkerSupervisor,
  'reconcile' | 'stop' | 'restart' | 'snapshots' | 'dispose'
>;

export type ServiceRouterPort = Pick<
  MessageRouter,
  'onWorkerEvent' | 'activateBinding' | 'disposeBinding' | 'dispose'
>;

export type ServiceLoggerPort = Pick<
  LocalLogger,
  | 'debug'
  | 'info'
  | 'warn'
  | 'error'
  | 'setLevel'
  | 'activity'
  | 'diagnostics'
  | 'close'
>;

export interface ServiceHttpPort {
  start(): Promise<{ host: '127.0.0.1'; port: number; origin: string }>;
  close(): Promise<void>;
}

export interface QuukkServiceOptions {
  identity: StartingDaemonIdentity;
  identityStore: DaemonIdentityPersistence;
  store: ServiceStorePort;
  bridge: ServiceBridgePort;
  runtimes: ServiceRuntimePort;
  bindings: ServiceBindingPort;
  pairing: ServicePairingPort;
  workers: ServiceWorkerPort;
  router: ServiceRouterPort;
  logger: ServiceLoggerPort;
  storageRoot: string;
  configOverrides?: ConfigOverrides;
  configEnvironment?: NodeJS.ProcessEnv;
  httpFactory(ports: {
    api: LocalApiPort;
    control: LocalControlPort;
    controlCredential: string;
  }): ServiceHttpPort;
  now?: () => number;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
  mutationGate?: ServiceMutationGate;
}

export type ServiceErrorCode =
  | 'invalid_request'
  | 'operation_unavailable'
  | 'bridge_unavailable'
  | 'runtime_not_found'
  | 'config_recovery_required';

export class ServiceError extends Error {
  constructor(readonly code: ServiceErrorCode) {
    super(code);
    this.name = 'ServiceError';
  }

  toJSON(): { code: ServiceErrorCode } {
    return { code: this.code };
  }
}

type ServiceState = 'new' | 'starting' | 'ready' | 'stopping' | 'stopped';

export interface ServiceMutationGate {
  tail: Promise<void>;
  stopped: boolean;
}

function createServiceMutationGate(): ServiceMutationGate {
  return { tail: Promise.resolve(), stopped: false };
}

function enqueueServiceMutation<T>(
  gate: ServiceMutationGate,
  operation: () => Promise<T>,
): Promise<T> {
  const run = gate.tail.catch(() => undefined).then(async () => {
    if (gate.stopped) throw new ServiceError('operation_unavailable');
    return operation();
  });
  gate.tail = run.then(() => undefined, () => undefined);
  return run;
}

type PublicFailure = {
  code: string;
  category: 'detection' | 'authentication' | 'registration' | 'transport' | 'runtime' | 'policy';
  retryable: boolean;
};

type ProductionBridgeClient = ServiceRuntimePort & BridgeTaskPort;
type ProductionBridgePort = Omit<ServiceBridgePort, 'ensureStarted'> & {
  ensureStarted(options?: { signal?: AbortSignal }): Promise<{
    client: ProductionBridgeClient;
    identity: BridgeProcessIdentity;
    recovered: boolean;
  }>;
};
type ProductionWorkerPort = ServiceWorkerPort & RouterWorkerPort;
type RegistrationPort = Pick<RegistrationClient, 'getAppKey' | 'register' | 'refreshToken'>;
export type ProductionBindingFactoryOptions = Omit<BindingServiceDependencies, 'store'> & {
  store: ServiceStorePort;
};
export type ProductionRouterStatePort = Pick<RouterStateStore, 'initialize'>;
export type ProductionRouterFactoryOptions = Omit<MessageRouterOptions, 'state' | 'logger'> & {
  state: ProductionRouterStatePort;
  logger: ServiceLoggerPort;
};

export interface ProductionServiceFactories {
  openStore(options: { homeDirectory: string }): Promise<ServiceStorePort>;
  openLogger(options: { filePath: string; level: StoredConfig['logLevel'] }): Promise<ServiceLoggerPort>;
  createBridge(options: {
    store: ServiceStorePort;
    homeDirectory: string;
    processEnvironment: NodeJS.ProcessEnv;
  }): ProductionBridgePort;
  createRegistrationClient(): RegistrationPort;
  openBindings(options: ProductionBindingFactoryOptions): Promise<ServiceBindingPort>;
  createRouterState(options: RouterStateStoreOptions): ProductionRouterStatePort;
  createWorkers(options: RongCloudWorkerSupervisorOptions): ProductionWorkerPort;
  createRouter(options: ProductionRouterFactoryOptions): ServiceRouterPort;
  createHttp(options: LocalHttpServerOptions): ServiceHttpPort;
}

export interface ComposeProductionServiceOptions {
  identity: StartingDaemonIdentity;
  identityStore: DaemonIdentityPersistence;
  homeDirectory: string;
  processEnvironment: NodeJS.ProcessEnv;
  configOverrides?: ConfigOverrides;
  configEnvironment?: NodeJS.ProcessEnv;
  staticRoot?: string;
  factories?: ProductionServiceFactories;
  now?: () => number;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}

function cloneOverrides(value: ConfigOverrides | undefined): Readonly<ConfigOverrides> {
  const source = value ?? {};
  const authorizedWorkRoots = source.authorizedWorkRoots?.slice();
  const providerPathOverrides = source.providerPathOverrides === undefined
    ? undefined
    : { ...source.providerPathOverrides };
  if (authorizedWorkRoots !== undefined) Object.freeze(authorizedWorkRoots);
  if (providerPathOverrides !== undefined) Object.freeze(providerPathOverrides);
  const output: ConfigOverrides = {
    ...source,
    ...(authorizedWorkRoots === undefined ? {} : { authorizedWorkRoots }),
    ...(providerPathOverrides === undefined
      ? {}
      : { providerPathOverrides }),
  };
  return Object.freeze(output);
}

export function sanitizeQuukkEnvironment(source: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {};
  for (const key of QUUKK_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (typeof value === 'string') output[key] = value;
  }
  return Object.freeze(output);
}

function copyEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string') output[key] = value;
  }
  return Object.freeze(output);
}

function boundedTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_SHUTDOWN_TIMEOUT_MS) {
    throw new RangeError('invalid_shutdown_timeout');
  }
  return timeout;
}

function boundedStartupTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_STARTUP_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_STARTUP_TIMEOUT_MS) {
    throw new RangeError('invalid_startup_timeout');
  }
  return timeout;
}

function assertAbsolutePath(value: string, code: string): string {
  if (!isAbsolute(value) || value !== value.trim() || value.includes('\0')) throw new RangeError(code);
  return resolve(value);
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);
}

async function assertNoSymlinkTraversal(input: string): Promise<void> {
  const normalized = resolve(input);
  const filesystemRoot = parse(normalized).root;
  let current = filesystemRoot;
  for (const segment of normalized.slice(filesystemRoot.length).split(/[\\/]+/u).filter(Boolean)) {
    current = join(current, segment);
    if ((await lstat(current)).isSymbolicLink()) throw new ServiceError('operation_unavailable');
  }
}

function safeLog(logger: ServiceLoggerPort | undefined, level: 'info' | 'warn' | 'error', event: SafeLogEvent): void {
  try {
    logger?.[level](event);
  } catch {
    // Logging is best-effort and never changes lifecycle behavior.
  }
}

function explicitCode(error: unknown): string | undefined {
  try {
    if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
    const value = (error as { code?: unknown }).code;
    return typeof value === 'string' && SAFE_CODE.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function normalizedServiceError(error: unknown, fallback: ServiceErrorCode): ServiceError {
  if (error instanceof ServiceError) return error;
  const code = explicitCode(error);
  if (code === 'runtime_not_found') return new ServiceError('runtime_not_found');
  if (code === 'config_recovery_required') return new ServiceError('config_recovery_required');
  return new ServiceError(fallback);
}

function publicFailure(errorCode: string): PublicFailure {
  const code = SAFE_CODE.test(errorCode) ? errorCode : 'operation_unavailable';
  if (code === 'runtime_not_found' || code === 'runtime_not_ready'
    || code === 'runtime_identity_changed' || code === 'provider_conflict') {
    return { code, category: 'detection', retryable: false };
  }
  if (code === 'registration_unauthorized') {
    return { code, category: 'authentication', retryable: false };
  }
  if (code === 'registration_transport' || code === 'registration_timeout'
    || code === 'app_key_unavailable' || code === 'token_refresh_failed') {
    return {
      code,
      category: code === 'registration_transport' || code === 'registration_timeout'
        ? 'transport'
        : 'registration',
      retryable: code === 'registration_transport' || code === 'registration_timeout',
    };
  }
  if (code === 'config_recovery_required') {
    return { code, category: 'policy', retryable: false };
  }
  return { code, category: 'registration', retryable: false };
}

function safeBinding(binding: RuntimeBinding): SafeBindingView {
  if (binding.nodeId === undefined) throw new ServiceError('operation_unavailable');
  return {
    runtimeId: binding.runtimeId,
    nodeId: binding.nodeId,
    nodeName: binding.nodeName,
    enabled: binding.enabled,
    registrationState: binding.registrationState,
    ...(binding.lastErrorCode === undefined ? {} : { lastErrorCode: binding.lastErrorCode }),
    updatedAt: binding.updatedAt,
  };
}

function completeEnabledBinding(binding: RuntimeBinding): binding is RuntimeBinding & {
  nodeId: string;
  tokenRef: string;
} {
  return binding.enabled
    && binding.nodeId !== undefined
    && binding.tokenRef !== undefined
    && RUNTIME_ID_PATTERN.test(binding.runtimeId)
    && TOKEN_REF_PATTERN.test(binding.tokenRef);
}

function exactBinding(left: RuntimeBinding, right: RuntimeBinding): boolean {
  return left.runtimeId === right.runtimeId
    && left.runtimePath === right.runtimePath
    && left.provider === right.provider
    && left.enabled === right.enabled
    && left.nodeId === right.nodeId
    && left.nodeName === right.nodeName
    && left.tokenRef === right.tokenRef
    && left.registrationState === right.registrationState
    && left.lastErrorCode === right.lastErrorCode
    && left.updatedAt === right.updatedAt;
}

function parseCatalog(value: unknown): BridgeRuntime[] {
  const parsed = BridgeRuntimeListSchema.safeParse(value);
  if (!parsed.success || parsed.data.some((runtime) => runtime.capabilities.approval_events !== false)) {
    throw new ServiceError('bridge_unavailable');
  }
  return parsed.data;
}

function parsePort(address: string | undefined): number | null {
  if (address === undefined) return null;
  const match = /^127\.0\.0\.1:(\d{1,5})$/.exec(address);
  if (match === null) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

function exactReadyIdentity(
  value: unknown,
  expected: StartingDaemonIdentity,
  address: string,
): ReadyDaemonIdentity {
  const parsed = DaemonIdentitySchema.safeParse(value);
  if (!parsed.success
    || parsed.data.state !== 'ready'
    || parsed.data.schema_version !== expected.schema_version
    || parsed.data.pid !== expected.pid
    || parsed.data.version !== expected.version
    || parsed.data.instance_id !== expected.instance_id
    || parsed.data.started_at !== expected.started_at
    || parsed.data.address !== address) {
    throw new ServiceError('operation_unavailable');
  }
  return parsed.data;
}

function validExecutableName(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  const value = basename(path);
  return value.length >= 1 && value.length <= 255 && !/[\\/\0]/.test(value) ? value : undefined;
}

async function ensureProtectedStorage(root: string, runtimeId: string): Promise<string> {
  if (!RUNTIME_ID_PATTERN.test(runtimeId)) throw new ServiceError('operation_unavailable');
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await assertNoSymlinkTraversal(root);
    const rootMetadata = await lstat(root);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
      throw new ServiceError('operation_unavailable');
    }
    if (process.platform !== 'win32') await chmod(root, 0o700);
    const canonicalRoot = await realpath(root);
    const requested = join(root, runtimeId);
    await mkdir(requested, { recursive: true, mode: 0o700 });
    const metadata = await lstat(requested);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new ServiceError('operation_unavailable');
    }
    if (process.platform !== 'win32') await chmod(requested, 0o700);
    const canonical = await realpath(requested);
    if (!samePath(dirname(canonical), canonicalRoot) || !samePath(canonical, join(canonicalRoot, runtimeId))) {
      throw new ServiceError('operation_unavailable');
    }
    return canonical;
  } catch (error) {
    throw normalizedServiceError(error, 'operation_unavailable');
  }
}

function operationSignal(callSignal: AbortSignal, lifecycleSignal: AbortSignal): AbortSignal {
  return AbortSignal.any([callSignal, lifecycleSignal]);
}

function waitForCaller<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new ServiceError('operation_unavailable'));
  return new Promise<T>((resolvePromise, reject) => {
    const aborted = () => {
      signal.removeEventListener('abort', aborted);
      reject(new ServiceError('operation_unavailable'));
    };
    signal.addEventListener('abort', aborted, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener('abort', aborted);
        resolvePromise(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', aborted);
        reject(error);
      },
    );
  });
}

function supervisorBindings(
  storageRoot: string,
  bindings: readonly RuntimeBinding[],
): SupervisorBinding[] {
  return bindings.flatMap((binding) => completeEnabledBinding(binding)
    ? [{
        runtimeId: binding.runtimeId,
        nodeId: binding.nodeId,
        enabled: true,
        tokenRef: binding.tokenRef,
        storageDir: join(storageRoot, binding.runtimeId),
      }]
    : []);
}

export class QuukkService implements LocalApiPort, LocalControlPort {
  readonly #identity: StartingDaemonIdentity;
  readonly #identityStore: DaemonIdentityPersistence;
  readonly #store: ServiceStorePort;
  readonly #bridge: ServiceBridgePort;
  readonly #runtimesPort: ServiceRuntimePort;
  readonly #bindings: ServiceBindingPort;
  readonly #pairing: ServicePairingPort;
  readonly #workers: ServiceWorkerPort;
  readonly #router: ServiceRouterPort;
  readonly #logger: ServiceLoggerPort;
  readonly #storageRoot: string;
  readonly #configOverrides: Readonly<ConfigOverrides>;
  readonly #configEnvironment: NodeJS.ProcessEnv;
  readonly #httpFactory: QuukkServiceOptions['httpFactory'];
  readonly #now: () => number;
  readonly #startupTimeoutMs: number;
  readonly #shutdownTimeoutMs: number;
  readonly #setTimeout: typeof globalThis.setTimeout;
  readonly #clearTimeout: typeof globalThis.clearTimeout;
  readonly #mutationGate: ServiceMutationGate;
  readonly #lifecycle = new AbortController();
  #state: ServiceState = 'new';
  #startPromise?: Promise<ReadyDaemonIdentity>;
  #stopPromise?: Promise<void>;
  #cleanupPromise?: Promise<void>;
  #http?: ServiceHttpPort;
  #readyIdentity?: ReadyDaemonIdentity;
  #ownedIdentity: DaemonIdentity;
  #markReadyTransition?: Promise<ReadyDaemonIdentity>;
  #pairingStartInFlight?: Promise<PairingResponse>;

  constructor(options: QuukkServiceOptions) {
    const identity = StartingDaemonIdentitySchema.safeParse(options.identity);
    if (!identity.success) throw new RangeError('invalid_service_identity');
    this.#identity = identity.data;
    this.#ownedIdentity = identity.data;
    this.#identityStore = options.identityStore;
    this.#store = options.store;
    this.#bridge = options.bridge;
    this.#runtimesPort = options.runtimes;
    this.#bindings = options.bindings;
    this.#pairing = options.pairing;
    this.#workers = options.workers;
    this.#router = options.router;
    this.#logger = options.logger;
    this.#storageRoot = assertAbsolutePath(options.storageRoot, 'invalid_storage_root');
    this.#configOverrides = cloneOverrides(options.configOverrides);
    this.#configEnvironment = sanitizeQuukkEnvironment(options.configEnvironment);
    this.#httpFactory = options.httpFactory;
    this.#now = options.now ?? Date.now;
    this.#startupTimeoutMs = boundedStartupTimeout(options.startupTimeoutMs);
    this.#shutdownTimeoutMs = boundedTimeout(options.shutdownTimeoutMs);
    this.#setTimeout = options.setTimeout ?? globalThis.setTimeout;
    this.#clearTimeout = options.clearTimeout ?? globalThis.clearTimeout;
    this.#mutationGate = options.mutationGate ?? createServiceMutationGate();
  }

  start(): Promise<ReadyDaemonIdentity> {
    if (this.#startPromise !== undefined) return this.#startPromise;
    if (this.#state !== 'new') {
      this.#startPromise = Promise.reject(new ServiceError('operation_unavailable'));
      return this.#startPromise;
    }
    this.#state = 'starting';
    this.#startPromise = this.#start();
    return this.#startPromise;
  }

  stop(): Promise<void> {
    if (this.#stopPromise !== undefined) return this.#stopPromise;
    this.#beginStopping();
    this.#stopPromise = this.#cleanup();
    return this.#stopPromise;
  }

  shutdownAfterResponse(): void {
    void this.stop().catch(() => undefined);
  }

  async runtimes(signal: AbortSignal): Promise<RuntimesResponse> {
    this.#assertReadable(signal);
    try {
      return this.#projectRuntimes(await this.#runtimesPort.runtimes({
        signal: operationSignal(signal, this.#lifecycle.signal),
      }));
    } catch (error) {
      throw normalizedServiceError(error, 'bridge_unavailable');
    }
  }

  rescan(signal: AbortSignal): Promise<RuntimesResponse> {
    return this.#mutate(signal, async (combined) => {
      try {
        return this.#projectRuntimes(await this.#runtimesPort.refreshRuntimes({ signal: combined }));
      } catch (error) {
        throw normalizedServiceError(error, 'bridge_unavailable');
      }
    });
  }

  enable(runtimeIds: readonly string[], signal: AbortSignal): Promise<EnableResponse> {
    return this.#mutate(signal, async () => {
      const requested = new Set(runtimeIds);
      if (runtimeIds.length < 1
        || runtimeIds.length > 4
        || requested.size !== runtimeIds.length
        || !runtimeIds.every((runtimeId) => RUNTIME_ID_PATTERN.test(runtimeId))) {
        throw new ServiceError('invalid_request');
      }
      let results: readonly EnableResult[];
      try {
        results = await this.#bindings.enableSelected(runtimeIds);
      } catch (error) {
        throw normalizedServiceError(error, 'operation_unavailable');
      }
      this.#assertConvergence();
      const returned = new Set(results.map((result) => result.runtimeId));
      const exactResultSet = results.length === runtimeIds.length
        && returned.size === results.length
        && results.every((result) => requested.has(result.runtimeId));
      const fresh = this.#bindings.list();
      let contractFailure = !exactResultSet;
      let activationFailure = false;
      const publicResults: EnableResponse['results'] = [];
      if (!exactResultSet) {
        try {
          await this.#workers.reconcile(this.#workerBindings(fresh));
        } catch {
          activationFailure = true;
        }
        this.#assertConvergence();
        throw new ServiceError('operation_unavailable');
      }
      for (const result of results) {
        if (!result.ok) {
          publicResults.push({ runtimeId: result.runtimeId, ok: false, error: publicFailure(result.errorCode) });
          continue;
        }
        const current = fresh.find((binding) => binding.runtimeId === result.runtimeId);
        if (current === undefined || !exactBinding(current, result.binding)
          || !completeEnabledBinding(current)) {
          contractFailure = true;
          continue;
        }
        publicResults.push({ runtimeId: result.runtimeId, ok: true, binding: safeBinding(current) });
        try {
          await this.#router.activateBinding({ runtimeId: current.runtimeId, nodeId: current.nodeId });
          this.#assertConvergence();
          await ensureProtectedStorage(this.#storageRoot, current.runtimeId);
        } catch {
          activationFailure = true;
        }
        this.#assertConvergence();
      }
      try {
        await this.#workers.reconcile(this.#workerBindings(fresh));
      } catch {
        activationFailure = true;
      }
      this.#assertConvergence();
      if (contractFailure || activationFailure) throw new ServiceError('operation_unavailable');
      const parsed = EnableResponseSchema.safeParse({ schemaVersion: 1, results: publicResults });
      if (!parsed.success) throw new ServiceError('operation_unavailable');
      return parsed.data;
    });
  }

  disable(runtimeId: string, signal: AbortSignal): Promise<BindingMutationResponse> {
    return this.#mutate(signal, async () => {
      let disabled: RuntimeBinding;
      try {
        disabled = await this.#bindings.disable(runtimeId);
      } catch (error) {
        throw normalizedServiceError(error, 'operation_unavailable');
      }
      this.#assertConvergence();
      const persisted = this.#bindings.list();
      const exactDisabled = persisted.find((binding) => binding.runtimeId === runtimeId);
      if (disabled.runtimeId !== runtimeId
        || exactDisabled === undefined
        || exactDisabled.enabled
        || !exactBinding(exactDisabled, disabled)) {
        throw new ServiceError('operation_unavailable');
      }
      let cleanupFailed = false;
      if (disabled.nodeId !== undefined) {
        const identity = { runtimeId: disabled.runtimeId, nodeId: disabled.nodeId };
        try {
          await this.#router.disposeBinding(identity);
        } catch {
          cleanupFailed = true;
        }
        try {
          await this.#workers.stop(identity);
        } catch {
          cleanupFailed = true;
        }
      }
      let fresh: readonly RuntimeBinding[] = [];
      try {
        fresh = this.#bindings.list();
        await this.#workers.reconcile(this.#workerBindings(fresh));
      } catch {
        cleanupFailed = true;
      }
      this.#assertConvergence();
      if (cleanupFailed) throw new ServiceError('operation_unavailable');
      const current = fresh.find((binding) => binding.runtimeId === runtimeId) ?? disabled;
      const parsed = BindingMutationResponseSchema.safeParse({ schemaVersion: 1, binding: safeBinding(current) });
      if (!parsed.success) throw new ServiceError('operation_unavailable');
      return parsed.data;
    });
  }

  reregister(runtimeId: string, signal: AbortSignal): Promise<BindingMutationResponse> {
    return this.#mutate(signal, async () => {
      let result: EnableResult;
      try {
        result = await this.#bindings.reregister(runtimeId);
      } catch (error) {
        throw normalizedServiceError(error, 'operation_unavailable');
      }
      this.#assertConvergence();
      if (result.runtimeId !== runtimeId) throw new ServiceError('operation_unavailable');
      if (!result.ok) {
        if (result.errorCode === 'runtime_not_found') throw new ServiceError('runtime_not_found');
        throw new ServiceError('operation_unavailable');
      }
      const fresh = this.#bindings.list();
      const current = fresh.find((binding) => binding.runtimeId === runtimeId);
      if (current === undefined || !exactBinding(current, result.binding)
        || !completeEnabledBinding(current)) {
        throw new ServiceError('operation_unavailable');
      }
      try {
        await this.#workers.reconcile(this.#workerBindings(fresh));
      } catch {
        throw new ServiceError('operation_unavailable');
      }
      this.#assertConvergence();
      const parsed = BindingMutationResponseSchema.safeParse({ schemaVersion: 1, binding: safeBinding(current) });
      if (!parsed.success) throw new ServiceError('operation_unavailable');
      return parsed.data;
    });
  }

  pairingStart(signal: AbortSignal): Promise<PairingResponse> {
    this.#assertMutation(signal);
    let shared = this.#pairingStartInFlight;
    if (shared === undefined) {
      shared = this.#mutate(this.#lifecycle.signal, async () => {
        const snapshot = await this.#pairing.start();
        return this.#pairingResponse(snapshot);
      });
      this.#pairingStartInFlight = shared;
      void shared.finally(() => {
        if (this.#pairingStartInFlight === shared) this.#pairingStartInFlight = undefined;
      }).catch(() => undefined);
    }
    return waitForCaller(shared, signal);
  }

  async pairingStatus(signal: AbortSignal): Promise<PairingResponse> {
    this.#assertReadable(signal);
    try {
      return await this.#pairingResponse(this.#pairing.snapshot());
    } catch (error) {
      throw normalizedServiceError(error, 'operation_unavailable');
    }
  }

  pairingCancel(signal: AbortSignal): Promise<PairingResponse> {
    return this.#mutate(signal, async (combined) => {
      const snapshot = await this.#pairing.cancel();
      if (combined.aborted) throw new ServiceError('operation_unavailable');
      return this.#pairingResponse(snapshot);
    });
  }

  pairingRetry(candidateIds: readonly string[], signal: AbortSignal): Promise<PairingResponse> {
    return this.#mutate(signal, async () => {
      if (
        candidateIds.length < 1
        || candidateIds.length > PAIRING_MAX_CANDIDATES
        || new Set(candidateIds).size !== candidateIds.length
        || !candidateIds.every((candidateId) => PAIRING_CANDIDATE_ID_PATTERN.test(candidateId))
      ) {
        throw new ServiceError('invalid_request');
      }
      return this.#pairingResponse(this.#pairing.retryFailed(candidateIds));
    });
  }

  async activity(signal: AbortSignal): Promise<ActivityResponse> {
    this.#assertReadable(signal);
    let activity: readonly LoggerActivityRecord[];
    try {
      activity = this.#logger.activity();
    } catch {
      throw new ServiceError('operation_unavailable');
    }
    const parsed = ActivityResponseSchema.safeParse({
      schemaVersion: 1,
      events: activity.slice(-100),
    });
    if (!parsed.success) throw new ServiceError('operation_unavailable');
    return parsed.data;
  }

  async diagnostics(signal: AbortSignal): Promise<DiagnosticsResponse> {
    this.#assertReadable(signal, true);
    const warnings = new Set<string>();
    let snapshot: StoreSnapshot | undefined;
    try {
      snapshot = await this.#store.snapshot({}, {});
      for (const warning of snapshot.warnings) {
        if (SAFE_CODE.test(warning)) warnings.add(warning);
      }
    } catch {
      warnings.add('config_unavailable');
    }

    let health: BridgeHealth | undefined;
    try {
      health = BridgeHealthSchema.parse(await this.#runtimesPort.health({
        signal: operationSignal(signal, this.#lifecycle.signal),
      }));
    } catch {
      warnings.add('bridge_unavailable');
    }

    let runtimes: BridgeRuntime[] = [];
    try {
      runtimes = parseCatalog(await this.#runtimesPort.runtimes({
        signal: operationSignal(signal, this.#lifecycle.signal),
      }));
    } catch {
      warnings.add('runtime_catalog_unavailable');
    }

    let workerSnapshots: readonly WorkerSnapshot[] = [];
    try {
      workerSnapshots = this.#workers.snapshots();
    } catch {
      warnings.add('worker_status_unavailable');
    }
    let logging = { dropped: 0, retained: 0 };
    try {
      logging = this.#logger.diagnostics();
    } catch {
      warnings.add('logging_unavailable');
    }
    const now = this.#safeNow();
    const startedAt = Date.parse(this.#identity.started_at);
    const value = {
      schemaVersion: 1 as const,
      service: {
        version: this.#identity.version,
        state: this.#state === 'ready' ? 'ready' as const
          : this.#state === 'starting' || this.#state === 'new' ? 'starting' as const
            : 'stopping' as const,
        pid: this.#identity.pid,
        startedAt: this.#identity.started_at,
        listenHost: '127.0.0.1' as const,
        port: parsePort(this.#readyIdentity?.address),
        uptimeMs: Math.max(0, Math.trunc(now - startedAt)),
      },
      bridge: health === undefined
        ? { state: 'unavailable' as const, errorCode: 'bridge_unavailable' }
        : {
            state: 'ready' as const,
            pid: health.pid,
            version: health.version,
            startedAt: health.started_at,
            probeStatus: health.probe_status,
          },
      runtimes: runtimes.map((runtime) => ({
        provider: runtime.provider,
        status: runtime.status,
        ...(runtime.version === undefined ? {} : { version: runtime.version }),
        ...(validExecutableName(runtime.path) === undefined
          ? {}
          : { executableName: validExecutableName(runtime.path) }),
      })),
      workers: workerSnapshots.flatMap((worker) =>
        RUNTIME_ID_PATTERN.test(worker.runtimeId)
          ? [{ runtimeId: worker.runtimeId, state: worker.state, restartCount: worker.restartCount }]
          : []),
      warnings: [...warnings].slice(0, 64),
      logging,
    };
    const parsed = DiagnosticsResponseSchema.safeParse(value);
    if (!parsed.success) throw new ServiceError('operation_unavailable');
    return parsed.data;
  }

  async settings(signal: AbortSignal): Promise<SettingsResponse> {
    this.#assertReadable(signal);
    return this.#settingsSnapshot();
  }

  saveSettings(value: StoredConfig, signal: AbortSignal): Promise<SettingsResponse> {
    return this.#mutate(signal, async () => {
      const parsed = StoredConfigSchema.safeParse(value);
      if (!parsed.success) throw new ServiceError('operation_unavailable');
      try {
        await this.#store.saveConfig(parsed.data);
      } catch (error) {
        throw normalizedServiceError(error, 'operation_unavailable');
      }
      this.#assertConvergence();
      const response = await this.#settingsSnapshot();
      try {
        this.#logger.setLevel(response.effective.logLevel);
      } catch {
        // Logger configuration is best-effort; persisted settings remain authoritative.
      }
      return response;
    });
  }

  async status(signal: AbortSignal): Promise<ControlStatusResponse> {
    if (signal.aborted) throw new ServiceError('operation_unavailable');
    const identity = this.#readyIdentity;
    if (identity === undefined || (this.#state !== 'ready' && this.#state !== 'stopping')) {
      throw new ServiceError('operation_unavailable');
    }
    return {
      schemaVersion: 1,
      identity,
      state: this.#state === 'ready' ? 'ready' : 'stopping',
    };
  }

  async #start(): Promise<ReadyDaemonIdentity> {
    const started = performance.now();
    const cleanupReserve = Math.min(
      this.#shutdownTimeoutMs,
      Math.floor(this.#startupTimeoutMs / 3),
    );
    const acquisitionTimeout = Math.max(1, this.#startupTimeoutMs - cleanupReserve);
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const startup = this.#startOwned();
    void startup.catch(() => undefined);
    try {
      return await Promise.race([
        startup,
        new Promise<never>((_resolve, reject) => {
          timer = this.#setTimeout(() => {
            this.#beginStopping();
            reject(new ServiceError('operation_unavailable'));
          }, acquisitionTimeout);
        }),
      ]);
    } catch (error) {
      this.#beginStopping();
      safeLog(this.#logger, 'error', { event: 'service_start_failed', errorCode: 'operation_unavailable' });
      const remaining = Math.max(0, this.#startupTimeoutMs - (performance.now() - started));
      await this.#waitForCleanup(this.#cleanup(remaining), remaining);
      throw normalizedServiceError(error, 'operation_unavailable');
    } finally {
      if (timer !== undefined) this.#clearTimeout(timer);
    }
  }

  async #startOwned(): Promise<ReadyDaemonIdentity> {
    const running = await this.#bridge.ensureStarted({ signal: this.#lifecycle.signal });
    this.#assertStarting();
    if (running.client !== this.#runtimesPort) throw new ServiceError('operation_unavailable');
    const restored = this.#bindings.list();
    for (const binding of restored) {
      if (!completeEnabledBinding(binding)) continue;
      await ensureProtectedStorage(this.#storageRoot, binding.runtimeId);
      this.#assertStarting();
      await this.#router.activateBinding({ runtimeId: binding.runtimeId, nodeId: binding.nodeId });
      this.#assertStarting();
    }
    await this.#workers.reconcile(this.#workerBindings(restored));
    this.#assertStarting();
    const controlCredential = deriveControlCredential(
      this.#store.bridgeIdentity().secret,
      this.#identity.instance_id,
    );
    const http = this.#httpFactory({ api: this, control: this, controlCredential });
    this.#http = http;
    const address = await http.start();
    if (address.host !== '127.0.0.1') throw new ServiceError('operation_unavailable');
    this.#assertStarting();
    const identityAddress = `127.0.0.1:${address.port}`;
    const markReadyTransition = this.#identityStore.markReady(
      this.#identity,
      identityAddress,
    ).then((ready) => exactReadyIdentity(ready, this.#identity, identityAddress));
    this.#markReadyTransition = markReadyTransition;
    void markReadyTransition.catch(() => undefined);
    const ready = await markReadyTransition;
    this.#ownedIdentity = ready;
    this.#readyIdentity = ready;
    this.#assertStarting();
    this.#state = 'ready';
    safeLog(this.#logger, 'info', { event: 'service_ready', pid: ready.pid, port: address.port, state: 'ready' });
    return ready;
  }

  #beginStopping(): void {
    if (this.#state !== 'stopped') this.#state = 'stopping';
    this.#mutationGate.stopped = true;
    if (!this.#lifecycle.signal.aborted) this.#lifecycle.abort();
  }

  #cleanup(milliseconds = this.#shutdownTimeoutMs): Promise<void> {
    this.#cleanupPromise ??= this.#cleanupOwned(Math.min(this.#shutdownTimeoutMs, milliseconds));
    return this.#cleanupPromise;
  }

  async #cleanupOwned(milliseconds: number): Promise<void> {
    const started = performance.now();
    const total = Math.max(0, milliseconds);
    const identityReserve = Math.min(IDENTITY_REMOVE_TIMEOUT_MS, Math.floor(total / 2));
    const remaining = () => Math.max(0, total - (performance.now() - started));
    const preIdentityRemaining = () => Math.max(0, remaining() - identityReserve);
    await this.#cleanupStep(
      'http_close_failed',
      () => this.#http?.close(),
      Math.min(HTTP_CLOSE_TIMEOUT_MS, preIdentityRemaining()),
    );
    await this.#cleanupStep('mutation_drain_failed', () => this.#mutationGate.tail, preIdentityRemaining());
    await this.#cleanupStep(
      'router_dispose_failed',
      () => this.#router.dispose(),
      Math.min(ROUTER_DISPOSE_TIMEOUT_MS, preIdentityRemaining()),
    );
    await this.#cleanupStep('workers_dispose_failed', () => this.#workers.dispose(), preIdentityRemaining());
    await this.#cleanupStep('bridge_stop_failed', () => this.#bridge.stop(), preIdentityRemaining());
    await this.#cleanupStep(
      'logger_close_failed',
      () => this.#logger.close(),
      Math.min(LOGGER_CLOSE_TIMEOUT_MS, preIdentityRemaining()),
      false,
    );
    const markReadyTransition = this.#markReadyTransition;
    if (markReadyTransition !== undefined && this.#readyIdentity === undefined) {
      const completed = await this.#cleanupStep(
        'identity_transition_failed',
        () => markReadyTransition.then((ready) => {
          this.#ownedIdentity = ready;
          this.#readyIdentity = ready;
        }),
        preIdentityRemaining(),
      );
      if (!completed) {
        void markReadyTransition.then(async (ready) => {
          await this.#identityStore.removeIfMatches(ready).catch(() => undefined);
        }).catch(() => undefined);
      }
    }
    await this.#cleanupStep(
      'identity_remove_failed',
      () => this.#identityStore.removeIfMatches(this.#ownedIdentity).then(() => undefined),
      Math.min(identityReserve, remaining()),
    );
    this.#state = 'stopped';
  }

  async #waitForCleanup(cleanup: Promise<void>, milliseconds: number): Promise<void> {
    if (milliseconds <= 0) return;
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    await Promise.race([
      cleanup.catch(() => undefined),
      new Promise<void>((resolvePromise) => {
        timer = this.#setTimeout(resolvePromise, Math.ceil(milliseconds));
      }),
    ]);
    if (timer !== undefined) this.#clearTimeout(timer);
  }

  async #cleanupStep(
    errorCode: string,
    operation: () => Promise<unknown> | undefined,
    milliseconds: number,
    logFailure = true,
  ): Promise<boolean> {
    let result: Promise<unknown>;
    try {
      result = Promise.resolve(operation());
    } catch {
      if (logFailure) safeLog(this.#logger, 'warn', { event: 'service_cleanup_failed', errorCode });
      return false;
    }
    void result.catch(() => undefined);
    if (milliseconds <= 0) {
      if (logFailure) safeLog(this.#logger, 'warn', { event: 'service_cleanup_failed', errorCode });
      return false;
    }
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const completed = await Promise.race([
      result.then(() => true, () => false),
      new Promise<false>((resolvePromise) => {
        timer = this.#setTimeout(() => resolvePromise(false), Math.ceil(milliseconds));
      }),
    ]);
    if (timer !== undefined) this.#clearTimeout(timer);
    if (!completed && logFailure) safeLog(this.#logger, 'warn', { event: 'service_cleanup_failed', errorCode });
    return completed;
  }

  #workerBindings(bindings: readonly RuntimeBinding[]): SupervisorBinding[] {
    return supervisorBindings(this.#storageRoot, bindings);
  }

  #projectRuntimes(input: unknown): RuntimesResponse {
    const catalog = parseCatalog(input);
    const bindings = this.#bindings.list();
    const workers = this.#workers.snapshots();
    const projected: RuntimeView[] = catalog.map((runtime) => {
      const runtimeId = runtime.id ?? null;
      const binding = runtimeId === null
        ? undefined
        : bindings.find((candidate) => candidate.runtimeId === runtimeId
          && candidate.provider === runtime.provider
          && candidate.nodeId !== undefined);
      const worker = binding?.nodeId === undefined
        ? undefined
        : workers.find((candidate) => candidate.runtimeId === runtimeId
          && candidate.nodeId === binding.nodeId);
      return {
        provider: runtime.provider,
        runtimeId,
        version: runtime.version ?? null,
        path: runtime.path ?? null,
        status: runtime.status,
        capabilities: {
          sessionResume: runtime.capabilities.session_resume,
          cancel: runtime.capabilities.cancel,
          textEvents: runtime.capabilities.text_events,
          toolEvents: runtime.capabilities.tool_events,
          approvalEvents: false,
        },
        binding: binding === undefined ? null : safeBinding(binding),
        worker: worker === undefined
          ? null
          : { state: worker.state, restartCount: worker.restartCount },
      };
    });
    const parsed = RuntimesResponseSchema.safeParse({ schemaVersion: 1, runtimes: projected });
    if (!parsed.success) throw new ServiceError('bridge_unavailable');
    return parsed.data;
  }

  async #settingsSnapshot(): Promise<SettingsResponse> {
    try {
      const stored = await this.#store.snapshot({}, {});
      const effective = await this.#store.snapshot(this.#configOverrides, this.#configEnvironment);
      const parsed = SettingsResponseSchema.safeParse({
        schemaVersion: 1,
        stored: stored.config,
        effective: effective.config,
      });
      if (!parsed.success) throw new ServiceError('operation_unavailable');
      return parsed.data;
    } catch (error) {
      throw normalizedServiceError(error, 'operation_unavailable');
    }
  }

  async #pairingResponse(snapshot: PairingServiceSnapshot): Promise<PairingResponse> {
    const effective = await this.#store.snapshot(this.#configOverrides, this.#configEnvironment);
    let qrContent: string | null = null;
    if (snapshot.state === 'waiting' && snapshot.ticket !== null && snapshot.expiresAt !== null) {
      const qr = pairingQrSchemaFor({ now: this.#now, allowLoopbackHttp: true }).parse({
        type: 'clawmessenger_pairing',
        version: 1,
        server: effective.config.serverUrl,
        ticket: snapshot.ticket,
        expiresAt: Date.parse(snapshot.expiresAt),
      });
      qrContent = JSON.stringify(qr);
    }
    const parsed = PairingResponseSchema.safeParse({
      schemaVersion: 1,
      state: snapshot.state,
      expiresAt: snapshot.expiresAt,
      qrContent,
      candidates: snapshot.candidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        provider: candidate.provider,
        displayName: candidate.displayName,
        version: candidate.version,
        readiness: candidate.readiness,
        statusReason: candidate.statusReason,
        registrationState: candidate.registrationState,
      })),
      results: snapshot.results.map((result) => ({
        candidateId: result.candidateId,
        status: result.status,
        errorCode: result.errorCode,
        nodeId: result.nodeId,
        retryable: result.retryable,
      })),
    });
    if (!parsed.success) throw new ServiceError('operation_unavailable');
    return parsed.data;
  }

  #mutate<T>(signal: AbortSignal, operation: (combined: AbortSignal) => Promise<T>): Promise<T> {
    const run = enqueueServiceMutation(this.#mutationGate, async () => {
      this.#assertMutation(signal);
      const combined = operationSignal(signal, this.#lifecycle.signal);
      const value = await operation(combined);
      this.#assertMutation(signal);
      return value;
    });
    return run.catch((error) => {
      throw normalizedServiceError(error, 'operation_unavailable');
    });
  }

  #assertStarting(): void {
    if (this.#state !== 'starting' || this.#lifecycle.signal.aborted) {
      throw new ServiceError('operation_unavailable');
    }
  }

  #assertMutation(signal: AbortSignal): void {
    if (signal.aborted || this.#lifecycle.signal.aborted || this.#state !== 'ready') {
      throw new ServiceError('operation_unavailable');
    }
  }

  #assertConvergence(): void {
    if (this.#lifecycle.signal.aborted || this.#state !== 'ready') {
      throw new ServiceError('operation_unavailable');
    }
  }

  #assertReadable(signal: AbortSignal, allowStopping = false): void {
    if (signal.aborted) throw new ServiceError('operation_unavailable');
    if (this.#state !== 'ready' && !(allowStopping && this.#state === 'stopping')) {
      throw new ServiceError('operation_unavailable');
    }
  }

  #safeNow(): number {
    try {
      const value = this.#now();
      return Number.isFinite(value) ? value : Date.parse(this.#identity.started_at);
    } catch {
      return Date.parse(this.#identity.started_at);
    }
  }
}

export function createConservativeRouterControl(options: {
  runtimes: ServiceRuntimePort;
  bindings: ServiceBindingPort;
  workers: Pick<ServiceWorkerPort, 'snapshots'>;
}): RouterControlPort {
  return {
    authorize: async (_input: AuthorizedControl) => false,
    status: async (identity: WorkerIdentity): Promise<SafeDeviceStatus> => {
      let runtime: RuntimeDiscoveryStatus = 'not_found';
      try {
        const catalog = parseCatalog(await options.runtimes.runtimes());
        runtime = catalog.find((candidate) => candidate.id === identity.runtimeId)?.status ?? 'not_found';
      } catch {
        runtime = 'probe_failed';
      }
      let binding: RuntimeBinding | undefined;
      try {
        binding = options.bindings.list().find((candidate) =>
          candidate.runtimeId === identity.runtimeId
          && candidate.nodeId === identity.nodeId
          && candidate.enabled);
      } catch {
        binding = undefined;
      }
      let worker: WorkerSnapshot | undefined;
      if (binding !== undefined) {
        try {
          worker = options.workers.snapshots().find((candidate) =>
            candidate.runtimeId === identity.runtimeId && candidate.nodeId === identity.nodeId);
        } catch {
          worker = undefined;
        }
      }
      return {
        enabled: binding !== undefined,
        worker: worker?.state ?? 'stopped',
        runtime,
      };
    },
    device: async (_input: AuthorizedDeviceCommand): Promise<SafeDeviceResult> => ({
      status: 'error', code: 'authorization_denied', message: 'authorization_denied',
    }),
    card: async (_input: AuthorizedCardIntent): Promise<SafeCardResult> => ({
      status: 'error',
      code: 'unsupported_interactive_approval',
      message: 'unsupported_interactive_approval',
    }),
    modelCatalog: async () => ({ defaultModel: null, providers: [] }),
  };
}

function productionRuntimeSource(client: ProductionBridgeClient): PairingRuntimeSource {
  return {
    runtimes: async () => parseCatalog(await client.runtimes()).flatMap((runtime) =>
      runtime.id === undefined || runtime.path === undefined
        ? []
        : [{
            id: runtime.id,
            provider: runtime.provider,
            path: runtime.path,
            status: runtime.status,
            version: runtime.version,
          }]),
  };
}

function productionBindingPort(
  store: ServiceStorePort,
  bindings: ServiceBindingPort,
  overrides: Readonly<ConfigOverrides>,
  environment: NodeJS.ProcessEnv,
): RouterBindingPort {
  return {
    binding: async (identity) => {
      const binding = bindings.list().find((candidate) => candidate.runtimeId === identity.runtimeId
        && candidate.nodeId === identity.nodeId && candidate.enabled);
      return binding?.nodeId === undefined
        ? undefined
        : {
            runtimeId: binding.runtimeId,
            nodeId: binding.nodeId,
            provider: binding.provider,
            enabled: true,
          };
    },
    authorizeDefaultWorkdir: async (identity) => {
      const binding = bindings.list().find((candidate) => candidate.runtimeId === identity.runtimeId
        && candidate.nodeId === identity.nodeId && candidate.enabled);
      if (binding === undefined) throw new ServiceError('operation_unavailable');
      const snapshot = await store.snapshot(overrides, environment);
      if (snapshot.config.defaultWorkdir === null) throw new ServiceError('operation_unavailable');
      return authorizeWorkdir(snapshot.config.defaultWorkdir, snapshot.config.authorizedWorkRoots);
    },
  };
}

function exactCredential(
  store: ServiceStorePort,
  bindings: ServiceBindingPort,
  binding: SupervisorBinding,
): RongCloudCredential {
  const current = bindings.list().find((candidate) => candidate.runtimeId === binding.runtimeId
    && candidate.nodeId === binding.nodeId
    && candidate.tokenRef === binding.tokenRef
    && candidate.enabled);
  const credential = current === undefined ? undefined : store.credential(binding.tokenRef);
  if (current === undefined || credential === undefined
    || credential.runtimeId !== binding.runtimeId
    || credential.provider !== current.provider
    || credential.nodeId !== binding.nodeId) {
    throw new ServiceError('operation_unavailable');
  }
  return credential;
}

function adaptWorkerSupervisor(supervisor: RongCloudWorkerSupervisor): ProductionWorkerPort {
  return {
    reconcile: (bindings) => supervisor.reconcile(bindings),
    stop: (identity) => supervisor.stop(identity),
    restart: (identity) => supervisor.restart(identity),
    snapshots: () => supervisor.snapshots(),
    dispose: () => supervisor.dispose(),
    send: (identity, input) => supervisor.send(identity, input as unknown as Record<string, unknown>),
    receipt: (identity, input) => supervisor.receipt(identity, input as unknown as Record<string, unknown>),
    joinChatroom: (identity, input) => supervisor.joinChatroom(identity, input),
  };
}

const DEFAULT_PRODUCTION_FACTORIES: ProductionServiceFactories = {
  openStore: (options) => LocalStore.open(options),
  openLogger: (options) => LocalLogger.open(options),
  createBridge: ({ store, homeDirectory, processEnvironment }) => new BridgeSupervisor({
    store,
    identityStore: new BridgeProcessIdentityStore({ homeDirectory }),
    dependencies: { environment: processEnvironment },
  }) as ProductionBridgePort,
  createRegistrationClient: () => new RegistrationClient(),
  openBindings: (options) => BindingService.open({ ...options, store: options.store as LocalStore }),
  createRouterState: (options) => new RouterStateStore(options),
  createWorkers: (options) => adaptWorkerSupervisor(new RongCloudWorkerSupervisor(options)),
  createRouter: (options) => new MessageRouter({
    ...options,
    state: options.state as RouterStateStore,
  }),
  createHttp: (options) => new LocalHttpServer(options),
};

async function boundedCompositionCleanup(
  operation: () => Promise<unknown>,
  milliseconds: number,
): Promise<void> {
  const running = Promise.resolve().then(operation);
  void running.catch(() => undefined);
  if (milliseconds <= 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    running.then(() => undefined, () => undefined),
    new Promise<void>((resolvePromise) => {
      timer = setTimeout(resolvePromise, milliseconds);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
}

interface ProductionStartupDeadline {
  signal: AbortSignal;
  operationRemaining(): number;
  totalRemaining(): number;
}

async function productionAcquisition<T>(
  operation: Promise<T>,
  deadline: ProductionStartupDeadline | undefined,
): Promise<T> {
  if (deadline === undefined) return operation;
  void operation.catch(() => undefined);
  if (deadline.signal.aborted || deadline.operationRemaining() <= 0) {
    throw new ServiceError('operation_unavailable');
  }
  let rejectAbort: ((error: ServiceError) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = (): void => rejectAbort?.(new ServiceError('operation_unavailable'));
  deadline.signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    deadline.signal.removeEventListener('abort', onAbort);
  }
}

async function cleanupProductionComposition(options: {
  router?: ServiceRouterPort;
  workers?: ProductionWorkerPort;
  bridge?: ProductionBridgePort;
  logger?: ServiceLoggerPort;
  identityStore: DaemonIdentityPersistence;
  identity: StartingDaemonIdentity;
  milliseconds: number;
}): Promise<void> {
  const started = performance.now();
  const total = Math.max(0, options.milliseconds);
  const identityReserve = Math.min(IDENTITY_REMOVE_TIMEOUT_MS, Math.floor(total / 2));
  const remaining = () => Math.max(0, total - (performance.now() - started));
  const preIdentityRemaining = () => Math.max(0, remaining() - identityReserve);
  if (options.router !== undefined) {
    await boundedCompositionCleanup(
      () => options.router!.dispose(),
      Math.min(ROUTER_DISPOSE_TIMEOUT_MS, preIdentityRemaining()),
    );
  }
  if (options.workers !== undefined) {
    await boundedCompositionCleanup(() => options.workers!.dispose(), preIdentityRemaining());
  }
  if (options.bridge !== undefined) {
    await boundedCompositionCleanup(() => options.bridge!.stop(), preIdentityRemaining());
  }
  if (options.logger !== undefined) {
    await boundedCompositionCleanup(
      () => options.logger!.close(),
      Math.min(LOGGER_CLOSE_TIMEOUT_MS, preIdentityRemaining()),
    );
  }
  await boundedCompositionCleanup(
    () => options.identityStore.removeIfMatches(options.identity),
    Math.min(identityReserve, remaining()),
  );
}

export async function startProductionService(
  options: ComposeProductionServiceOptions,
): Promise<QuukkService> {
  const identity = StartingDaemonIdentitySchema.safeParse(options.identity);
  if (!identity.success) throw new ServiceError('operation_unavailable');
  let startupTimeoutMs: number;
  let shutdownTimeoutMs: number;
  try {
    startupTimeoutMs = boundedStartupTimeout(options.startupTimeoutMs);
    shutdownTimeoutMs = boundedTimeout(options.shutdownTimeoutMs);
  } catch {
    await boundedCompositionCleanup(
      () => options.identityStore.removeIfMatches(identity.data),
      IDENTITY_REMOVE_TIMEOUT_MS,
    );
    throw new ServiceError('operation_unavailable');
  }
  const started = performance.now();
  const cleanupReserve = Math.min(shutdownTimeoutMs, Math.floor(startupTimeoutMs / 3));
  const operationTimeout = Math.max(1, startupTimeoutMs - cleanupReserve);
  const controller = new AbortController();
  const deadline: ProductionStartupDeadline = {
    signal: controller.signal,
    operationRemaining: () => Math.max(0, operationTimeout - (performance.now() - started)),
    totalRemaining: () => Math.max(0, startupTimeoutMs - (performance.now() - started)),
  };
  const timer = setTimeout(() => controller.abort(), operationTimeout);
  let service: QuukkService | undefined;
  try {
    service = await composeProductionServiceWithin(options, deadline);
    await productionAcquisition(service.start(), deadline);
    return service;
  } catch (error) {
    if (service !== undefined) {
      await boundedCompositionCleanup(
        () => service!.stop(),
        deadline.totalRemaining(),
      );
    }
    throw normalizedServiceError(error, 'operation_unavailable');
  } finally {
    clearTimeout(timer);
  }
}

async function composeProductionServiceWithin(
  options: ComposeProductionServiceOptions,
  deadline?: ProductionStartupDeadline,
): Promise<QuukkService> {
  const identity = StartingDaemonIdentitySchema.safeParse(options.identity);
  if (!identity.success) throw new ServiceError('operation_unavailable');
  let logger: ServiceLoggerPort | undefined;
  let bridge: ProductionBridgePort | undefined;
  let workers: ProductionWorkerPort | undefined;
  let router: ServiceRouterPort | undefined;
  const mutationGate = createServiceMutationGate();
  let shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS;
  try {
    const homeDirectory = assertAbsolutePath(options.homeDirectory, 'invalid_home_directory');
    const staticRoot = assertAbsolutePath(
      options.staticRoot ?? fileURLToPath(new URL('./ui', import.meta.url)),
      'invalid_static_root',
    );
    const startupTimeoutMs = boundedStartupTimeout(options.startupTimeoutMs);
    shutdownTimeoutMs = boundedTimeout(options.shutdownTimeoutMs);
    const processEnvironment = copyEnvironment(options.processEnvironment);
    const configEnvironment = sanitizeQuukkEnvironment(options.configEnvironment);
    const configOverrides = cloneOverrides(options.configOverrides);
    const factories = options.factories ?? DEFAULT_PRODUCTION_FACTORIES;
    const paths = localPaths(homeDirectory);
    const store = await productionAcquisition(
      factories.openStore({ homeDirectory }),
      deadline,
    );
    const effective = await productionAcquisition(
      store.snapshot(configOverrides, configEnvironment),
      deadline,
    );
    logger = await productionAcquisition(
      factories.openLogger({ filePath: paths.bridgeLog, level: effective.config.logLevel }),
      deadline,
    );
    bridge = factories.createBridge({ store, homeDirectory, processEnvironment });
    const running = await productionAcquisition(
      bridge.ensureStarted({ signal: deadline?.signal }),
      deadline,
    );
    const client = running.client;
    const registrationClient = factories.createRegistrationClient();
    const bindings = await productionAcquisition(
      factories.openBindings({
        store,
        registrationClient,
        runtimeSource: productionRuntimeSource(client),
        configSnapshot: { overrides: configOverrides, environment: configEnvironment },
      }),
      deadline,
    );
    const bridgeIdentity = store.bridgeIdentity();
    const installAbuseKey = createHmac('sha256', Buffer.from(bridgeIdentity.secret, 'base64url'))
      .update(`quukk-pairing-abuse-v1\0${bridgeIdentity.installId}`, 'utf8')
      .digest('hex');
    const pairing = new PairingService({
      client: new PairingClient({ serverUrl: effective.config.serverUrl }),
      bindings,
      runtimeSource: productionRuntimeSource(client),
      installAbuseKey,
      now: options.now,
    });
    const routerState = factories.createRouterState({ filePath: paths.sessions });
    await productionAcquisition(routerState.initialize(), deadline);
    let routerReference: ServiceRouterPort | undefined;
    workers = factories.createWorkers({
      storageRoot: paths.rongcloudDir,
      processEnv: processEnvironment,
      resolveCredential: async (binding): Promise<SupervisorCredential> => {
        const credential = exactCredential(store, bindings, binding);
        return { appKey: credential.appKey, token: credential.token };
      },
      refreshCredential: (binding): Promise<string> => enqueueServiceMutation(mutationGate, async () => {
        const refreshed = await bindings.reregister(binding.runtimeId);
        if (refreshed.runtimeId !== binding.runtimeId
          || !refreshed.ok
          || refreshed.binding.runtimeId !== binding.runtimeId
          || refreshed.binding.nodeId !== binding.nodeId) {
          throw new ServiceError('operation_unavailable');
        }
        const fresh = bindings.list();
        const current = fresh.find((candidate) => candidate.runtimeId === binding.runtimeId);
        if (current === undefined
          || !completeEnabledBinding(current)
          || !exactBinding(current, refreshed.binding)
          || current.nodeId !== binding.nodeId) {
          throw new ServiceError('operation_unavailable');
        }
        const supervisor = workers;
        if (supervisor === undefined) throw new ServiceError('operation_unavailable');
        await supervisor.reconcile(supervisorBindings(paths.rongcloudDir, fresh));
        return exactCredential(store, bindings, {
          ...binding,
          tokenRef: current.tokenRef,
        }).token;
      }),
      onEvent: (workerIdentity: WorkerIdentity, event: WorkerEvent) => {
        const target = routerReference;
        if (target === undefined) return;
        void target.onWorkerEvent(workerIdentity, event).catch(() => {
          safeLog(logger, 'warn', {
            event: 'worker_event_failed',
            runtimeId: workerIdentity.runtimeId,
            nodeId: workerIdentity.nodeId,
          });
        });
      },
    });
    const control = createConservativeRouterControl({ runtimes: client, bindings, workers });
    router = factories.createRouter({
      task: client,
      worker: workers,
      binding: productionBindingPort(store, bindings, configOverrides, configEnvironment),
      control,
      state: routerState,
      logger,
    });
    routerReference = router;
    const cachedBridge: ServiceBridgePort = {
      ensureStarted: async (startOptions) => {
        const current = await bridge!.ensureStarted(startOptions);
        if (current.client !== client) throw new ServiceError('operation_unavailable');
        return current;
      },
      stop: (stopOptions) => bridge!.stop(stopOptions),
    };
    const remainingStartup = deadline === undefined
      ? startupTimeoutMs
      : Math.floor(deadline.operationRemaining());
    const remainingShutdown = deadline === undefined
      ? shutdownTimeoutMs
      : Math.min(shutdownTimeoutMs, Math.floor(deadline.totalRemaining()));
    if (remainingStartup < 1 || remainingShutdown < 1) {
      throw new ServiceError('operation_unavailable');
    }
    return new QuukkService({
      identity: identity.data,
      identityStore: options.identityStore,
      store,
      bridge: cachedBridge,
      runtimes: client,
      bindings,
      pairing,
      workers,
      router,
      logger,
      storageRoot: paths.rongcloudDir,
      configOverrides,
      configEnvironment,
      mutationGate,
      now: options.now,
      startupTimeoutMs: remainingStartup,
      shutdownTimeoutMs: remainingShutdown,
      httpFactory: ({ api, control: localControl, controlCredential }) => {
        const routes = new LocalRoutes({
          api,
          control: localControl,
          tickets: new LaunchTicketStore({ instanceId: identity.data.instance_id }),
          sessions: new BrowserSessionStore(),
          controlCredential,
          logger: logger!,
        });
        return factories.createHttp({ routes, staticRoot, logger: logger! });
      },
    });
  } catch (error) {
    mutationGate.stopped = true;
    safeLog(logger, 'error', { event: 'service_compose_failed', errorCode: 'operation_unavailable' });
    await cleanupProductionComposition({
      router,
      workers,
      bridge,
      logger,
      identityStore: options.identityStore,
      identity: identity.data,
      milliseconds: Math.min(shutdownTimeoutMs, deadline?.totalRemaining() ?? shutdownTimeoutMs),
    });
    throw normalizedServiceError(error, 'operation_unavailable');
  }
}
