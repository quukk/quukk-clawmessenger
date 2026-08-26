import { hostname as osHostname } from 'node:os';
import { isAbsolute } from 'node:path';

import {
  PROVIDERS,
  RUNTIME_ID_PATTERN,
  type Provider,
  type RuntimeBinding,
  type TrustedRuntime,
} from '../config/schema.js';
import { LocalStore, LocalStoreError } from '../config/store.js';
import {
  RegistrationClient,
  RegistrationError,
  type RegistrationInput,
  type RefreshInput,
} from '../registration/client.js';

export type EnableResult =
  | { runtimeId: string; ok: true; binding: RuntimeBinding }
  | { runtimeId: string; ok: false; errorCode: string };

export type TrustedRuntimeSource = {
  runtimes(): Promise<readonly TrustedRuntime[]>;
};

type RegistrationPort = Pick<RegistrationClient, 'getAppKey' | 'register' | 'refreshToken'>;

export type BindingServiceDependencies = {
  store: LocalStore;
  registrationClient: RegistrationPort;
  runtimeSource: TrustedRuntimeSource;
  now?: () => Date;
  hostname?: () => string;
};

type EnablePlan = {
  runtimeId: string;
  runtime?: TrustedRuntime;
  immediate?: EnableResult;
};

const providerLabels = {
  opencode: 'OpenCode',
  openclaw: 'OpenClaw',
  codex: 'Codex',
  hermes: 'Hermes',
} as const satisfies Record<Provider, string>;

function cloneBinding(binding: RuntimeBinding): RuntimeBinding {
  return { ...binding };
}

function failure(runtimeId: string, errorCode: string): EnableResult {
  return { runtimeId, ok: false, errorCode };
}

function stableErrorCode(error: unknown): string {
  if (error instanceof RegistrationError || error instanceof LocalStoreError) return error.code;
  return 'local_persistence_failed';
}

function trustedRuntimeError(runtime: TrustedRuntime | undefined): string | undefined {
  if (runtime === undefined) return 'runtime_not_found';
  if (runtime.status !== 'ready') return 'runtime_not_ready';
  if (
    !RUNTIME_ID_PATTERN.test(runtime.id) ||
    !PROVIDERS.includes(runtime.provider) ||
    runtime.path.length === 0 ||
    runtime.path.length > 4096 ||
    runtime.path !== runtime.path.trim() ||
    runtime.path.includes('\0') ||
    !isAbsolute(runtime.path)
  ) {
    return 'runtime_identity_changed';
  }
  return undefined;
}

export class BindingService {
  readonly #store: LocalStore;
  readonly #registrationClient: RegistrationPort;
  readonly #runtimeSource: TrustedRuntimeSource;
  readonly #now: () => Date;
  readonly #hostname: () => string;
  readonly #bindings = new Map<string, RuntimeBinding>();
  readonly #tails = new Map<string, Promise<void>>();
  readonly #sharedEnables = new Map<string, Promise<EnableResult>>();
  readonly #providerClaims = new Map<Provider, string>();

  constructor(dependencies: BindingServiceDependencies, initialBindings: readonly RuntimeBinding[] = []) {
    this.#store = dependencies.store;
    this.#registrationClient = dependencies.registrationClient;
    this.#runtimeSource = dependencies.runtimeSource;
    this.#now = dependencies.now ?? (() => new Date());
    this.#hostname = dependencies.hostname ?? osHostname;
    for (const binding of initialBindings) this.#bindings.set(binding.runtimeId, cloneBinding(binding));
  }

  static async open(dependencies: BindingServiceDependencies): Promise<BindingService> {
    const snapshot = await dependencies.store.snapshot();
    return new BindingService(dependencies, snapshot.bindings);
  }

  list(): readonly RuntimeBinding[] {
    return [...this.#bindings.values()].map(cloneBinding);
  }

  #replace(binding: RuntimeBinding): void {
    this.#bindings.set(binding.runtimeId, cloneBinding(binding));
  }

  #nodeName(provider: Provider): string {
    let host = 'localhost';
    try {
      host = this.#hostname().trim() || host;
    } catch {
      // Stable local fallback; no external lookup is needed for a display name.
    }
    const suffix = ` · ${providerLabels[provider]}`;
    return `${host.slice(0, 128 - suffix.length).trim()}${suffix}`;
  }

  #completeCredential(binding: RuntimeBinding) {
    if (binding.nodeId === undefined || binding.tokenRef === undefined) return undefined;
    const credential = this.#store.credential(binding.tokenRef);
    if (
      credential === undefined ||
      credential.runtimeId !== binding.runtimeId ||
      credential.provider !== binding.provider ||
      credential.nodeId !== binding.nodeId
    ) {
      return undefined;
    }
    return credential;
  }

  #enqueue<T>(runtimeId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(runtimeId) ?? Promise.resolve();
    const started = previous.then(operation, operation);
    const tail = started.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(runtimeId, tail);
    void tail.then(() => {
      if (this.#tails.get(runtimeId) === tail) this.#tails.delete(runtimeId);
    });
    return started;
  }

  #shareEnable(runtimeId: string, operation: () => Promise<EnableResult>): Promise<EnableResult> {
    const current = this.#sharedEnables.get(runtimeId);
    if (current !== undefined) return current;
    const started = this.#enqueue(runtimeId, operation);
    this.#sharedEnables.set(runtimeId, started);
    void started.then(
      () => {
        if (this.#sharedEnables.get(runtimeId) === started) this.#sharedEnables.delete(runtimeId);
      },
      () => {
        if (this.#sharedEnables.get(runtimeId) === started) this.#sharedEnables.delete(runtimeId);
      },
    );
    return started;
  }

  #enqueueExclusive<T>(runtimeId: string, operation: () => Promise<T>): Promise<T> {
    this.#sharedEnables.delete(runtimeId);
    return this.#enqueue(runtimeId, operation);
  }

  async enableSelected(runtimeIds: readonly string[]): Promise<readonly EnableResult[]> {
    const distinct = [...new Set(runtimeIds)];
    try {
      this.#store.assertExternalMutationAllowed();
    } catch (error) {
      const code = stableErrorCode(error);
      return distinct.map((runtimeId) => failure(runtimeId, code));
    }

    const preparation = Promise.all([this.#runtimeSource.runtimes(), this.#store.snapshot()])
      .then(([catalog, { config }]) => {
        const byId = new Map(catalog.map((runtime) => [runtime.id, runtime]));
        const plans = new Map<string, EnablePlan>();
        for (const runtimeId of distinct) {
          const runtime = byId.get(runtimeId);
          const runtimeError = trustedRuntimeError(runtime);
          if (runtimeError !== undefined) {
            plans.set(runtimeId, { runtimeId, immediate: failure(runtimeId, runtimeError) });
            continue;
          }
          plans.set(runtimeId, { runtimeId, runtime });
        }
        return { config, plans };
      })
      .catch(() => undefined);

    let appKeyPromise: Promise<string> | undefined;
    return Promise.all(
      distinct.map((runtimeId) =>
        this.#shareEnable(runtimeId, async () => {
          const prepared = await preparation;
          if (prepared === undefined) return failure(runtimeId, 'runtime_not_found');
          const plan = prepared.plans.get(runtimeId)!;
          if (plan.immediate !== undefined) return plan.immediate;
          return this.#enableRuntime(
            plan.runtime!,
            prepared.config.serverUrl,
            () =>
              (appKeyPromise ??= this.#registrationClient.getAppKey(prepared.config.serverUrl)),
          );
        }),
      ),
    );
  }

  async #enableRuntime(
    runtime: TrustedRuntime,
    serverUrl: string,
    appKey: () => Promise<string>,
  ): Promise<EnableResult> {
    const existing = this.#bindings.get(runtime.id);
    if (
      existing !== undefined &&
      (existing.provider !== runtime.provider || existing.runtimePath !== runtime.path)
    ) {
      return failure(runtime.id, 'runtime_identity_changed');
    }
    const providerOwner = [...this.#bindings.values()].find(
      (binding) => binding.provider === runtime.provider && binding.runtimeId !== runtime.id,
    );
    if (providerOwner !== undefined) return failure(runtime.id, 'provider_conflict');
    const claimant = this.#providerClaims.get(runtime.provider);
    if (claimant !== undefined && claimant !== runtime.id) {
      return failure(runtime.id, 'provider_conflict');
    }
    this.#providerClaims.set(runtime.provider, runtime.id);
    try {
      const credential = existing === undefined ? undefined : this.#completeCredential(existing);
      if (existing !== undefined && credential?.serverUrl === serverUrl) {
        if (existing.enabled) {
          return { runtimeId: runtime.id, ok: true, binding: cloneBinding(existing) };
        }
        const enabled: RuntimeBinding = {
          ...existing,
          enabled: true,
          registrationState: 'offline',
          lastErrorCode: undefined,
          updatedAt: this.#now().toISOString(),
        };
        try {
          await this.#store.saveBinding(enabled);
          this.#replace(enabled);
          return { runtimeId: runtime.id, ok: true, binding: cloneBinding(enabled) };
        } catch (error) {
          return failure(runtime.id, stableErrorCode(error));
        }
      }
      return await this.#register(
        runtime,
        existing,
        credential?.serverUrl === serverUrl,
        serverUrl,
        appKey,
      );
    } finally {
      if (this.#providerClaims.get(runtime.provider) === runtime.id) {
        this.#providerClaims.delete(runtime.provider);
      }
    }
  }

  async #register(
    runtime: TrustedRuntime,
    previous: RuntimeBinding | undefined,
    sameServerIdentity: boolean,
    serverUrl: string,
    appKey: () => Promise<string>,
  ): Promise<EnableResult> {
    const pending: RuntimeBinding = {
      runtimeId: runtime.id,
      runtimePath: runtime.path,
      provider: runtime.provider,
      enabled: previous?.enabled ?? false,
      nodeName: previous?.nodeName ?? this.#nodeName(runtime.provider),
      registrationState: 'registering',
      updatedAt: this.#now().toISOString(),
      ...(previous?.nodeId === undefined ? {} : { nodeId: previous.nodeId }),
      ...(previous?.tokenRef === undefined ? {} : { tokenRef: previous.tokenRef }),
    };
    try {
      await this.#store.saveBinding(pending);
      this.#replace(pending);
      const applicationKey = await appKey();
      const identity = this.#store.bridgeIdentity();
      const input: RegistrationInput = {
        serverUrl,
        installId: identity.installId,
        runtimeId: runtime.id,
        bridgeSecret: identity.secret,
        provider: runtime.provider,
        nodeName: pending.nodeName,
        ...(sameServerIdentity && previous?.nodeId !== undefined
          ? { existingNodeId: previous.nodeId }
          : {}),
      };
      const registered = await this.#registrationClient.register(input);
      const committed = await this.#store.commitRegistration(
        {
          ...pending,
          enabled: true,
          nodeId: registered.nodeId,
          nodeName: pending.nodeName,
          registrationState: 'offline',
          lastErrorCode: undefined,
          updatedAt: this.#now().toISOString(),
        },
        {
          serverUrl,
          appKey: applicationKey,
          token: registered.token,
          createdAt: this.#now().toISOString(),
        },
      );
      this.#replace(committed);
      return { runtimeId: runtime.id, ok: true, binding: cloneBinding(committed) };
    } catch (error) {
      const errorCode = stableErrorCode(error);
      const usablePrevious = previous !== undefined && this.#completeCredential(previous) !== undefined;
      const failed: RuntimeBinding = usablePrevious
        ? { ...previous, lastErrorCode: errorCode, updatedAt: this.#now().toISOString() }
        : {
            ...pending,
            enabled: false,
            registrationState: 'error',
            lastErrorCode: errorCode,
            updatedAt: this.#now().toISOString(),
          };
      try {
        await this.#store.saveBinding(failed);
        this.#replace(failed);
      } catch {
        return failure(runtime.id, 'local_persistence_failed');
      }
      return failure(runtime.id, errorCode);
    }
  }

  async disable(runtimeId: string): Promise<RuntimeBinding> {
    return this.#enqueueExclusive(runtimeId, async () => {
      const existing = this.#bindings.get(runtimeId);
      if (existing === undefined) throw new LocalStoreError('runtime_not_found');
      const complete = this.#completeCredential(existing) !== undefined;
      const registrationState = complete
        ? ('offline' as const)
        : existing.nodeId === undefined && existing.tokenRef === undefined
          ? ('unregistered' as const)
          : ('error' as const);
      const disabled: RuntimeBinding = {
        ...existing,
        enabled: false,
        registrationState,
        updatedAt: this.#now().toISOString(),
      };
      await this.#store.saveBinding(disabled);
      this.#replace(disabled);
      return cloneBinding(disabled);
    });
  }

  async reregister(runtimeId: string): Promise<EnableResult> {
    try {
      this.#store.assertExternalMutationAllowed();
    } catch (error) {
      return failure(runtimeId, stableErrorCode(error));
    }
    return this.#enqueueExclusive(runtimeId, async () => {
      const previous = this.#bindings.get(runtimeId);
      if (previous === undefined) return failure(runtimeId, 'runtime_not_found');
      const credential = this.#completeCredential(previous);
      if (previous.nodeId === undefined || credential === undefined) {
        return failure(runtimeId, 'runtime_identity_changed');
      }
      let catalog: readonly TrustedRuntime[];
      let config: Awaited<ReturnType<LocalStore['snapshot']>>['config'];
      try {
        ({ config } = await this.#store.snapshot());
      } catch {
        return failure(runtimeId, 'runtime_identity_changed');
      }
      if (credential.serverUrl !== config.serverUrl) {
        return failure(runtimeId, 'runtime_identity_changed');
      }
      try {
        catalog = await this.#runtimeSource.runtimes();
      } catch {
        return failure(runtimeId, 'runtime_identity_changed');
      }
      const runtime = catalog.find((candidate) => candidate.id === runtimeId);
      if (runtime === undefined) return failure(runtimeId, 'runtime_identity_changed');
      const runtimeError = trustedRuntimeError(runtime);
      if (runtimeError !== undefined) return failure(runtimeId, runtimeError);
      if (runtime.provider !== previous.provider || runtime.path !== previous.runtimePath) {
        return failure(runtimeId, 'runtime_identity_changed');
      }
      const pending: RuntimeBinding = {
        ...previous,
        registrationState: 'registering',
        updatedAt: this.#now().toISOString(),
      };
      try {
        await this.#store.saveBinding(pending);
        this.#replace(pending);
        const applicationKey = await this.#registrationClient.getAppKey(config.serverUrl);
        const identity = this.#store.bridgeIdentity();
        const input: RefreshInput = {
          serverUrl: config.serverUrl,
          runtimeId,
          bridgeSecret: identity.secret,
          provider: previous.provider,
          nodeId: previous.nodeId,
          nodeName: previous.nodeName,
        };
        const refreshed = await this.#registrationClient.refreshToken(input);
        const committed = await this.#store.commitRegistration(
          {
            ...previous,
            registrationState: 'offline',
            lastErrorCode: undefined,
            updatedAt: this.#now().toISOString(),
          },
          {
            serverUrl: config.serverUrl,
            appKey: applicationKey,
            token: refreshed.token,
            createdAt: this.#now().toISOString(),
          },
        );
        this.#replace(committed);
        return { runtimeId, ok: true, binding: cloneBinding(committed) };
      } catch (error) {
        const errorCode = stableErrorCode(error);
        const restored = {
          ...previous,
          lastErrorCode: errorCode,
          updatedAt: this.#now().toISOString(),
        };
        try {
          await this.#store.saveBinding(restored);
          this.#replace(restored);
        } catch {
          return failure(runtimeId, 'local_persistence_failed');
        }
        return failure(runtimeId, errorCode);
      }
    });
  }

  async unregister(runtimeId: string): Promise<void> {
    await this.#enqueueExclusive(runtimeId, async () => {
      if (!this.#bindings.has(runtimeId)) return;
      await this.#store.removeBinding(runtimeId);
      this.#bindings.delete(runtimeId);
    });
  }
}
