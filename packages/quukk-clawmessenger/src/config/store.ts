import { randomBytes as cryptoRandomBytes, randomUUID as cryptoRandomUUID } from 'node:crypto';
import { realpath as fsRealpath, stat as fsStat } from 'node:fs/promises';
import * as nodePath from 'node:path';

import {
  CredentialFileSchema,
  DEFAULT_CONFIG,
  LocalStateSchema,
  RongCloudCredentialSchema,
  RuntimeBindingSchema,
  StoredConfigSchema,
  type ConfigOverrides,
  type CredentialFile,
  type LocalErrorCode,
  type LocalState,
  type Provider,
  type RongCloudCredential,
  type RuntimeBinding,
  type StoredConfig,
} from './schema.js';
import {
  atomicWriteJson,
  clearRecoveryArtifacts,
  hasRecoveryArtifact,
  quarantineJsonFile,
  readJsonFileIfExists,
  type AtomicJsonDependencies,
} from './atomic-json.js';
import { localPaths, type LocalPaths } from './paths.js';

const CONFIG_MAX_BYTES = 1 << 20;
const STATE_MAX_BYTES = 1 << 20;
const CREDENTIAL_MAX_BYTES = 4 << 20;

export class LocalStoreError extends Error {
  readonly code: LocalErrorCode;

  constructor(code: LocalErrorCode) {
    super(code);
    this.name = 'LocalStoreError';
    this.code = code;
  }

  toJSON(): { code: LocalErrorCode } {
    return { code: this.code };
  }
}

export type BridgeIdentity = {
  installId: string;
  secret: string;
};

export type StoreSnapshot = {
  config: StoredConfig;
  bindings: readonly RuntimeBinding[];
  warnings: readonly string[];
};

export type LocalStoreOptions = {
  homeDirectory?: string;
  now?: () => Date;
  randomUUID?: () => string;
  randomBytes?: (size: number) => Buffer;
  atomicDependencies?: AtomicJsonDependencies;
};

export type WorkdirDependencies = {
  realpath?: (path: string) => Promise<string>;
  stat?: (path: string) => Promise<{ isDirectory(): boolean }>;
  platform?: NodeJS.Platform;
  path?: Pick<typeof nodePath, 'isAbsolute' | 'relative' | 'sep'>;
};

const openQueues = new Map<string, Promise<void>>();

async function serializeOpen<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = openQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => gate);
  openQueues.set(key, queued);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (openQueues.get(key) === queued) openQueues.delete(key);
  }
}

function persistenceError(): LocalStoreError {
  return new LocalStoreError('local_persistence_failed');
}

function parseConfig(value: unknown): StoredConfig {
  const parsed = StoredConfigSchema.safeParse(value);
  if (!parsed.success) throw new LocalStoreError('invalid_config');
  return parsed.data;
}

function parseEnvironmentRoots(value: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new LocalStoreError('invalid_config');
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
    throw new LocalStoreError('invalid_config');
  }
  return parsed;
}

const environmentProviderPaths = {
  opencode: 'QUUKK_CLAWMESSENGER_OPENCODE_PATH',
  openclaw: 'QUUKK_CLAWMESSENGER_OPENCLAW_PATH',
  codex: 'QUUKK_CLAWMESSENGER_CODEX_PATH',
  hermes: 'QUUKK_CLAWMESSENGER_HERMES_PATH',
} as const satisfies Record<Provider, string>;

function effectiveConfig(
  file: StoredConfig,
  overrides: ConfigOverrides = {},
  environment: NodeJS.ProcessEnv = process.env,
): StoredConfig {
  const envProviderOverrides: Partial<Record<Provider, string>> = {};
  for (const provider of Object.keys(environmentProviderPaths) as Provider[]) {
    const value = environment[environmentProviderPaths[provider]];
    if (value !== undefined) envProviderOverrides[provider] = value;
  }
  const environmentRoots = environment.QUUKK_CLAWMESSENGER_AUTHORIZED_WORK_ROOTS;
  return parseConfig({
    schemaVersion: 1,
    serverUrl:
      overrides.serverUrl ?? environment.QUUKK_CLAWMESSENGER_SERVER_URL ?? file.serverUrl,
    defaultWorkdir:
      overrides.defaultWorkdir === null
        ? null
        : (overrides.defaultWorkdir ??
          environment.QUUKK_CLAWMESSENGER_WORKDIR ??
          file.defaultWorkdir),
    authorizedWorkRoots:
      overrides.authorizedWorkRoots ??
      (environmentRoots === undefined ? file.authorizedWorkRoots : parseEnvironmentRoots(environmentRoots)),
    providerPathOverrides: {
      ...file.providerPathOverrides,
      ...envProviderOverrides,
      ...overrides.providerPathOverrides,
    },
    logLevel:
      overrides.logLevel ?? environment.QUUKK_CLAWMESSENGER_LOG_LEVEL ?? file.logLevel,
  });
}

function workdirDependencies(overrides: WorkdirDependencies = {}) {
  return {
    realpath: overrides.realpath ?? fsRealpath,
    stat: overrides.stat ?? fsStat,
    platform: overrides.platform ?? process.platform,
    path: overrides.path ?? nodePath,
  };
}

function workdirError(): LocalStoreError {
  return new LocalStoreError('workdir_not_authorized');
}

async function canonicalDirectory(path: string, overrides: WorkdirDependencies): Promise<string> {
  const deps = workdirDependencies(overrides);
  if (path.includes('\0') || path !== path.trim() || !deps.path.isAbsolute(path)) throw workdirError();
  let canonical: string;
  let info: { isDirectory(): boolean };
  try {
    canonical = await deps.realpath(path);
    info = await deps.stat(canonical);
  } catch {
    throw workdirError();
  }
  if (!info.isDirectory()) throw workdirError();
  return canonical;
}

function isContained(
  requested: string,
  root: string,
  overrides: WorkdirDependencies,
): boolean {
  const deps = workdirDependencies(overrides);
  const requestedForComparison = deps.platform === 'win32' ? requested.toLowerCase() : requested;
  const rootForComparison = deps.platform === 'win32' ? root.toLowerCase() : root;
  const relative = deps.path.relative(rootForComparison, requestedForComparison);
  return (
    relative === '' ||
    (!deps.path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${deps.path.sep}`))
  );
}

export async function authorizeWorkdir(
  requestedPath: string,
  authorizedRoots: readonly string[],
  overrides: WorkdirDependencies = {},
): Promise<string> {
  if (authorizedRoots.length === 0) throw workdirError();
  const requested = await canonicalDirectory(requestedPath, overrides);
  for (const rootPath of authorizedRoots) {
    const root = await canonicalDirectory(rootPath, overrides);
    if (isContained(requested, root, overrides)) return requested;
  }
  throw workdirError();
}

export async function canonicalizeWorkdirPolicy(
  config: StoredConfig,
  overrides: WorkdirDependencies = {},
): Promise<StoredConfig> {
  const parsed = parseConfig(config);
  const roots = await Promise.all(
    parsed.authorizedWorkRoots.map((path) => canonicalDirectory(path, overrides)),
  );
  if (new Set(roots.map((path) => (workdirDependencies(overrides).platform === 'win32' ? path.toLowerCase() : path))).size !== roots.length) {
    throw new LocalStoreError('invalid_config');
  }
  const defaultWorkdir =
    parsed.defaultWorkdir === null
      ? null
      : await authorizeWorkdir(parsed.defaultWorkdir, roots, overrides);
  return parseConfig({ ...parsed, authorizedWorkRoots: roots, defaultWorkdir });
}

function cloneBinding(value: RuntimeBinding): RuntimeBinding {
  return { ...value };
}

function cloneCredential(value: RongCloudCredential): RongCloudCredential {
  return { ...value };
}

function validateCrossFile(state: LocalState, credentials: CredentialFile): void {
  for (const binding of state.bindings) {
    if (binding.tokenRef === undefined) continue;
    const token = credentials.tokens[binding.tokenRef];
    if (
      token === undefined ||
      token.runtimeId !== binding.runtimeId ||
      token.provider !== binding.provider ||
      token.nodeId !== binding.nodeId
    ) {
      throw new LocalStoreError('local_state_recovery_required');
    }
  }
}

function referencedTokenRefs(state: LocalState): Set<string> {
  return new Set(
    state.bindings.flatMap((binding) => (binding.tokenRef === undefined ? [] : [binding.tokenRef])),
  );
}

export class LocalStore {
  readonly #paths: LocalPaths;
  readonly #now: () => Date;
  readonly #randomBytes: (size: number) => Buffer;
  readonly #atomicDependencies: AtomicJsonDependencies;
  #config: StoredConfig;
  #state: LocalState;
  #credentials: CredentialFile;
  #warnings: string[];
  #queue: Promise<void> = Promise.resolve();

  private constructor(
    paths: LocalPaths,
    config: StoredConfig,
    state: LocalState,
    credentials: CredentialFile,
    warnings: string[],
    options: LocalStoreOptions,
  ) {
    this.#paths = paths;
    this.#config = config;
    this.#state = state;
    this.#credentials = credentials;
    this.#warnings = warnings;
    this.#now = options.now ?? (() => new Date());
    this.#randomBytes = options.randomBytes ?? cryptoRandomBytes;
    this.#atomicDependencies = {
      ...options.atomicDependencies,
      now: options.atomicDependencies?.now ?? this.#now,
      randomHex:
        options.atomicDependencies?.randomHex ?? (() => this.#randomBytes(4).toString('hex')),
    };
  }

  static async open(options: LocalStoreOptions = {}): Promise<LocalStore> {
    const paths = localPaths(options.homeDirectory);
    return serializeOpen(paths.root, async () => {
      const now = options.now ?? (() => new Date());
      const randomBytes = options.randomBytes ?? cryptoRandomBytes;
      const atomicDependencies: AtomicJsonDependencies = {
        ...options.atomicDependencies,
        now: options.atomicDependencies?.now ?? now,
        randomHex: options.atomicDependencies?.randomHex ?? (() => randomBytes(4).toString('hex')),
      };
      let config = DEFAULT_CONFIG;
      const warnings: string[] = [];
      let configRecoveryRequired = false;
      try {
        configRecoveryRequired = await hasRecoveryArtifact(paths.config, atomicDependencies);
      } catch {
        configRecoveryRequired = true;
      }
      try {
        config =
          (await readJsonFileIfExists(
            paths.config,
            StoredConfigSchema,
            CONFIG_MAX_BYTES,
            atomicDependencies,
          )) ?? DEFAULT_CONFIG;
      } catch {
        await quarantineJsonFile(paths.config, atomicDependencies).catch(() => undefined);
        configRecoveryRequired = true;
      }
      if (configRecoveryRequired) warnings.push('config_recovery_required');

      try {
        if (await hasRecoveryArtifact(paths.state, atomicDependencies)) {
          throw new LocalStoreError('local_state_recovery_required');
        }
      } catch (error) {
        if (error instanceof LocalStoreError) throw error;
        throw new LocalStoreError('local_state_recovery_required');
      }
      try {
        if (await hasRecoveryArtifact(paths.credentials, atomicDependencies)) {
          throw new LocalStoreError('credentials_recovery_required');
        }
      } catch (error) {
        if (error instanceof LocalStoreError) throw error;
        throw new LocalStoreError('credentials_recovery_required');
      }

      let state: LocalState | undefined;
      let credentials: CredentialFile | undefined;
      try {
        state = await readJsonFileIfExists(
          paths.state,
          LocalStateSchema,
          STATE_MAX_BYTES,
          atomicDependencies,
        );
      } catch {
        await quarantineJsonFile(paths.state, atomicDependencies).catch(() => undefined);
        throw new LocalStoreError('local_state_recovery_required');
      }
      try {
        credentials = await readJsonFileIfExists(
          paths.credentials,
          CredentialFileSchema,
          CREDENTIAL_MAX_BYTES,
          atomicDependencies,
        );
      } catch {
        await quarantineJsonFile(paths.credentials, atomicDependencies).catch(() => undefined);
        throw new LocalStoreError('credentials_recovery_required');
      }

      if (state === undefined && credentials !== undefined) {
        throw new LocalStoreError('local_state_recovery_required');
      }
      if (state !== undefined && credentials === undefined && state.bindings.length > 0) {
        throw new LocalStoreError('credentials_recovery_required');
      }
      if (state === undefined) {
        state = LocalStateSchema.parse({
          schemaVersion: 1,
          installId: (options.randomUUID ?? cryptoRandomUUID)().toLowerCase(),
          bindings: [],
        });
        credentials = CredentialFileSchema.parse({
          schemaVersion: 1,
          bridgeSecret: randomBytes(32).toString('base64url'),
          tokens: {},
        });
        try {
          await atomicWriteJson(paths.state, state, atomicDependencies);
          await atomicWriteJson(paths.credentials, credentials, atomicDependencies);
        } catch {
          throw persistenceError();
        }
      } else if (credentials === undefined) {
        credentials = CredentialFileSchema.parse({
          schemaVersion: 1,
          bridgeSecret: randomBytes(32).toString('base64url'),
          tokens: {},
        });
        try {
          await atomicWriteJson(paths.credentials, credentials, atomicDependencies);
        } catch {
          throw persistenceError();
        }
      }

      validateCrossFile(state, credentials);
      const reconciledBindings = state.bindings.map((binding) => {
        const complete =
          binding.nodeId !== undefined &&
          binding.tokenRef !== undefined &&
          credentials!.tokens[binding.tokenRef] !== undefined;
        if (binding.registrationState === 'online') {
          return { ...binding, registrationState: 'offline' as const, updatedAt: now().toISOString() };
        }
        if (binding.registrationState === 'registering') {
          return complete
            ? { ...binding, registrationState: 'offline' as const, updatedAt: now().toISOString() }
            : {
                ...binding,
                enabled: false,
                registrationState: 'error' as const,
                lastErrorCode: 'interrupted_registration',
                updatedAt: now().toISOString(),
              };
        }
        return binding;
      });
      if (reconciledBindings.some((binding, index) => binding !== state!.bindings[index])) {
        state = LocalStateSchema.parse({ ...state, bindings: reconciledBindings });
        try {
          await atomicWriteJson(paths.state, state, atomicDependencies);
        } catch {
          throw persistenceError();
        }
      }

      const referenced = referencedTokenRefs(state);
      const tokenEntries = Object.entries(credentials.tokens).filter(([ref]) => referenced.has(ref));
      if (tokenEntries.length !== Object.keys(credentials.tokens).length) {
        credentials = CredentialFileSchema.parse({ ...credentials, tokens: Object.fromEntries(tokenEntries) });
        try {
          await atomicWriteJson(paths.credentials, credentials, atomicDependencies);
        } catch {
          throw persistenceError();
        }
      }
      return new LocalStore(paths, config, state, credentials, warnings, options);
    });
  }

  async #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.catch(() => undefined).then(operation);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async snapshot(
    cliOverrides: ConfigOverrides = {},
    environment: NodeJS.ProcessEnv = process.env,
  ): Promise<StoreSnapshot> {
    await this.#queue;
    return {
      config: effectiveConfig(this.#config, cliOverrides, environment),
      bindings: this.#state.bindings.map(cloneBinding),
      warnings: [...this.#warnings],
    };
  }

  bridgeIdentity(): BridgeIdentity {
    return { installId: this.#state.installId, secret: this.#credentials.bridgeSecret };
  }

  credential(ref: string): RongCloudCredential | undefined {
    const value = this.#credentials.tokens[ref];
    return value === undefined ? undefined : cloneCredential(value);
  }

  assertExternalMutationAllowed(): void {
    if (this.#warnings.includes('config_recovery_required')) {
      throw new LocalStoreError('config_recovery_required');
    }
  }

  async saveConfig(config: StoredConfig): Promise<void> {
    await this.#serialized(async () => {
      let canonical: StoredConfig;
      try {
        canonical = await canonicalizeWorkdirPolicy(config);
      } catch (error) {
        if (error instanceof LocalStoreError) throw error;
        throw new LocalStoreError('invalid_config');
      }
      try {
        await atomicWriteJson(this.#paths.config, canonical, this.#atomicDependencies);
        await clearRecoveryArtifacts(this.#paths.config, this.#atomicDependencies);
      } catch {
        throw persistenceError();
      }
      this.#config = canonical;
      this.#warnings = this.#warnings.filter((warning) => warning !== 'config_recovery_required');
    });
  }

  async saveBinding(binding: RuntimeBinding): Promise<void> {
    this.assertExternalMutationAllowed();
    await this.#serialized(async () => {
      const parsed = RuntimeBindingSchema.safeParse(binding);
      if (!parsed.success) throw new LocalStoreError('local_state_recovery_required');
      const existingIndex = this.#state.bindings.findIndex(
        (candidate) => candidate.runtimeId === parsed.data.runtimeId,
      );
      const bindings = this.#state.bindings.map(cloneBinding);
      if (existingIndex === -1) bindings.push(parsed.data);
      else bindings[existingIndex] = parsed.data;
      const next = LocalStateSchema.safeParse({ ...this.#state, bindings });
      if (!next.success) throw new LocalStoreError('local_state_recovery_required');
      validateCrossFile(next.data, this.#credentials);
      try {
        await atomicWriteJson(this.#paths.state, next.data, this.#atomicDependencies);
      } catch {
        throw persistenceError();
      }
      this.#state = next.data;
    });
  }

  async commitRegistration(
    binding: RuntimeBinding,
    credential: Omit<RongCloudCredential, 'runtimeId' | 'provider' | 'nodeId'>,
  ): Promise<RuntimeBinding> {
    this.assertExternalMutationAllowed();
    return this.#serialized(async () => {
      let ref: string;
      do {
        ref = `rc_${this.#randomBytes(16).toString('hex')}`;
      } while (this.#credentials.tokens[ref] !== undefined);
      const nextBinding = RuntimeBindingSchema.safeParse({ ...binding, tokenRef: ref });
      const nextCredential = RongCloudCredentialSchema.safeParse({
        ...credential,
        runtimeId: binding.runtimeId,
        provider: binding.provider,
        nodeId: binding.nodeId,
      });
      if (!nextBinding.success || !nextCredential.success || binding.nodeId === undefined) {
        throw new LocalStoreError('local_state_recovery_required');
      }
      const oldBinding = this.#state.bindings.find(
        (candidate) => candidate.runtimeId === binding.runtimeId,
      );
      if (oldBinding !== undefined && oldBinding.provider !== binding.provider) {
        throw new LocalStoreError('local_state_recovery_required');
      }
      const credentialsWithNew = CredentialFileSchema.parse({
        ...this.#credentials,
        tokens: { ...this.#credentials.tokens, [ref]: nextCredential.data },
      });
      const bindings = this.#state.bindings.filter(
        (candidate) => candidate.runtimeId !== binding.runtimeId,
      );
      bindings.push(nextBinding.data);
      const stateWithNew = LocalStateSchema.safeParse({ ...this.#state, bindings });
      if (!stateWithNew.success) throw new LocalStoreError('local_state_recovery_required');
      validateCrossFile(stateWithNew.data, credentialsWithNew);
      try {
        await atomicWriteJson(
          this.#paths.credentials,
          credentialsWithNew,
          this.#atomicDependencies,
        );
        await atomicWriteJson(this.#paths.state, stateWithNew.data, this.#atomicDependencies);
      } catch {
        throw persistenceError();
      }
      this.#credentials = credentialsWithNew;
      this.#state = stateWithNew.data;

      const oldRef = oldBinding?.tokenRef;
      if (oldRef !== undefined && oldRef !== ref && !referencedTokenRefs(this.#state).has(oldRef)) {
        const { [oldRef]: _removed, ...remaining } = this.#credentials.tokens;
        const cleaned = CredentialFileSchema.parse({ ...this.#credentials, tokens: remaining });
        try {
          await atomicWriteJson(this.#paths.credentials, cleaned, this.#atomicDependencies);
          this.#credentials = cleaned;
        } catch {
          // The new credential and binding are already durable; a later valid open removes this orphan.
        }
      }
      return cloneBinding(nextBinding.data);
    });
  }

  async removeBinding(runtimeId: string): Promise<void> {
    this.assertExternalMutationAllowed();
    await this.#serialized(async () => {
      const binding = this.#state.bindings.find((candidate) => candidate.runtimeId === runtimeId);
      if (binding === undefined) return;
      const state = LocalStateSchema.parse({
        ...this.#state,
        bindings: this.#state.bindings.filter((candidate) => candidate.runtimeId !== runtimeId),
      });
      try {
        await atomicWriteJson(this.#paths.state, state, this.#atomicDependencies);
      } catch {
        throw persistenceError();
      }
      this.#state = state;
      if (binding.tokenRef === undefined || referencedTokenRefs(state).has(binding.tokenRef)) return;
      const { [binding.tokenRef]: _removed, ...remaining } = this.#credentials.tokens;
      const credentials = CredentialFileSchema.parse({ ...this.#credentials, tokens: remaining });
      try {
        await atomicWriteJson(this.#paths.credentials, credentials, this.#atomicDependencies);
      } catch {
        throw persistenceError();
      }
      this.#credentials = credentials;
    });
  }
}
