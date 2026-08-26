import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { BridgeClient, BridgeClientError } from '../go/client.js';
import { resolveBridgeBinary, type ResolvedBridgeBinary } from '../go/binary.js';
import {
  BridgeHealthSchema,
  BridgeReadinessSchema,
  type BridgeHealth,
  type BridgeProvider,
} from '../go/types.js';
import { VERSION } from '../version.js';
import {
  type BridgeProcessIdentity,
  type BridgeProcessIdentityPersistence,
} from './identity.js';

const STARTUP_INPUT_LIMIT = 65_536;
const READINESS_LIMIT = 65_536;
const STDERR_LIMIT = 65_536;

export type BridgeSupervisorErrorCode =
  | 'startup_input_too_large'
  | 'startup_timeout'
  | 'startup_failed'
  | 'readiness_invalid'
  | 'identity_corrupt'
  | 'identity_mismatch'
  | 'process_unverified'
  | 'shutdown_failed'
  | 'shutdown_timeout';

export class BridgeSupervisorError extends Error {
  readonly code: BridgeSupervisorErrorCode;

  constructor(code: BridgeSupervisorErrorCode) {
    super(code);
    this.name = 'BridgeSupervisorError';
    this.code = code;
  }

  toJSON(): { code: BridgeSupervisorErrorCode } {
    return { code: this.code };
  }
}

export type BridgeSupervisorStore = {
  assertExternalMutationAllowed(): void;
  bridgeIdentity(): { installId: string; secret: string };
  snapshot(): Promise<{
    config: { providerPathOverrides: Partial<Record<BridgeProvider, string>> };
  }>;
};

export type BridgeSupervisorClient = BridgeClient;

type SpawnOptions = {
  shell: false;
  stdio: ['pipe', 'pipe', 'pipe'];
  env: NodeJS.ProcessEnv;
  windowsHide: true;
};

export type BridgeSupervisorDependencies = {
  version: string;
  environment: NodeJS.ProcessEnv;
  resolveBinary(signal?: AbortSignal): Promise<ResolvedBridgeBinary>;
  spawn(command: string, args: string[], options: SpawnOptions): ChildProcessWithoutNullStreams;
  clientFactory(options: {
    baseUrl: string;
    secret: string;
    lifecycleSignal: AbortSignal;
  }): BridgeSupervisorClient;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
  waitForCurrentExit(
    child: ChildProcessWithoutNullStreams,
    milliseconds: number,
    signal?: AbortSignal,
  ): Promise<boolean>;
  waitForRecoveredExit(
    client: BridgeSupervisorClient,
    expected: BridgeProcessIdentity,
    milliseconds: number,
    signal?: AbortSignal,
  ): Promise<boolean>;
  forceTerminate(child: ChildProcessWithoutNullStreams): Promise<void>;
  startupTimeoutMs: number;
  healthRetryDelayMs: number;
  shutdownGraceMs: number;
};

export type BridgeSupervisorOptions = {
  store: BridgeSupervisorStore;
  identityStore: BridgeProcessIdentityPersistence;
  dependencies?: Partial<BridgeSupervisorDependencies>;
};

export type RunningBridge = {
  client: BridgeSupervisorClient;
  identity: BridgeProcessIdentity;
  recovered: boolean;
};

type ManagedBridge = RunningBridge & {
  child?: ChildProcessWithoutNullStreams;
  generation: AbortController;
};

type Deadline = {
  signal: AbortSignal;
  timedOut(): boolean;
  dispose(): void;
};

function matchesHealth(identity: BridgeProcessIdentity, health: BridgeHealth): boolean {
  return (
    health.status === 'ok' &&
    identity.pid === health.pid &&
    identity.version === health.version &&
    identity.instance_id === health.instance_id &&
    identity.started_at === health.started_at
  );
}

function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new BridgeSupervisorError('startup_timeout'));
      return;
    }
    const aborted = () => {
      clearTimeout(timer);
      reject(new BridgeSupervisorError('startup_timeout'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', aborted);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

function waitForCurrentExit(
  child: ChildProcessWithoutNullStreams,
  milliseconds: number,
): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', exited);
      resolve(false);
    }, milliseconds);
    const exited = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', exited);
  });
}

function defaults(overrides: Partial<BridgeSupervisorDependencies>): BridgeSupervisorDependencies {
  const sleep = overrides.sleep ?? abortableSleep;
  const deps: BridgeSupervisorDependencies = {
    version: overrides.version ?? VERSION,
    environment: overrides.environment ?? process.env,
    resolveBinary: overrides.resolveBinary ?? (() => resolveBridgeBinary()),
    spawn:
      overrides.spawn ??
      ((command, args, options) => nodeSpawn(command, args, options)),
    clientFactory:
      overrides.clientFactory ??
      ((options) => new BridgeClient(options)),
    sleep,
    setTimeout: overrides.setTimeout ?? globalThis.setTimeout,
    clearTimeout: overrides.clearTimeout ?? globalThis.clearTimeout,
    waitForCurrentExit: overrides.waitForCurrentExit ?? waitForCurrentExit,
    waitForRecoveredExit:
      overrides.waitForRecoveredExit ??
      (async (client, expected, milliseconds, signal) => {
        const attempts = Math.max(1, Math.ceil(milliseconds / 100));
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          await sleep(100, signal);
          try {
            const got = BridgeHealthSchema.parse(await client.health({ signal }));
            if (!matchesHealth(expected, got)) return false;
          } catch {
            return true;
          }
        }
        return false;
      }),
    forceTerminate:
      overrides.forceTerminate ??
      (async (child) => {
        if (!child.kill('SIGKILL')) throw new BridgeSupervisorError('shutdown_failed');
      }),
    startupTimeoutMs: overrides.startupTimeoutMs ?? 60_000,
    healthRetryDelayMs: overrides.healthRetryDelayMs ?? 50,
    shutdownGraceMs: overrides.shutdownGraceMs ?? 7_000,
  };
  return deps;
}

export class BridgeSupervisor {
  readonly #store: BridgeSupervisorStore;
  readonly #identityStore: BridgeProcessIdentityPersistence;
  readonly #deps: BridgeSupervisorDependencies;
  #queue: Promise<void> = Promise.resolve();
  #running?: ManagedBridge;

  constructor(options: BridgeSupervisorOptions) {
    this.#store = options.store;
    this.#identityStore = options.identityStore;
    this.#deps = defaults(options.dependencies ?? {});
  }

  ensureStarted(options: { signal?: AbortSignal } = {}): Promise<RunningBridge> {
    return this.#serialized(async () => {
      if (this.#running !== undefined) return this.#public(this.#running);
      const localIdentity = this.#store.bridgeIdentity();
      let existing: BridgeProcessIdentity | undefined;
      try {
        existing = await this.#identityStore.read();
      } catch {
        throw new BridgeSupervisorError('identity_corrupt');
      }
      if (existing !== undefined) {
        const generation = new AbortController();
        const client = this.#deps.clientFactory({
          baseUrl: `http://${existing.address}`,
          secret: localIdentity.secret,
          lifecycleSignal: generation.signal,
        });
        try {
          const got = BridgeHealthSchema.parse(await client.health({ signal: options.signal }));
          if (!matchesHealth(existing, got) || existing.version !== this.#deps.version) {
            generation.abort();
            throw new BridgeSupervisorError('process_unverified');
          }
          this.#running = { client, identity: existing, recovered: true, generation };
          return this.#public(this.#running);
        } catch (error) {
          generation.abort();
          if (error instanceof BridgeSupervisorError) throw error;
          if (!(error instanceof BridgeClientError) || !error.retryable) {
            throw new BridgeSupervisorError('process_unverified');
          }
          const removed = await this.#identityStore.removeIfMatches(existing).catch(() => {
            throw new BridgeSupervisorError('identity_corrupt');
          });
          if (!removed) throw new BridgeSupervisorError('process_unverified');
        }
      }
      this.#store.assertExternalMutationAllowed();
      const snapshot = await this.#store.snapshot();
      const startup = Buffer.from(
        `${JSON.stringify({
          secret: localIdentity.secret,
          install_id: localIdentity.installId,
          version: this.#deps.version,
          provider_path_overrides: snapshot.config.providerPathOverrides,
        })}\n`,
      );
      if (startup.byteLength > STARTUP_INPUT_LIMIT) {
        throw new BridgeSupervisorError('startup_input_too_large');
      }
      return this.#startFresh(startup, localIdentity.secret, options.signal);
    });
  }

  stop(options: { signal?: AbortSignal } = {}): Promise<void> {
    return this.#serialized(async () => {
      const running = this.#running;
      if (running === undefined) return;
      let firstHealth: BridgeHealth;
      try {
        firstHealth = BridgeHealthSchema.parse(await running.client.health({ signal: options.signal }));
      } catch {
        throw new BridgeSupervisorError('process_unverified');
      }
      if (!matchesHealth(running.identity, firstHealth)) {
        throw new BridgeSupervisorError('process_unverified');
      }
      try {
        await running.client.shutdown({ signal: options.signal });
      } catch {
        throw new BridgeSupervisorError('shutdown_failed');
      }

      if (running.recovered || running.child === undefined) {
        const stopped = await this.#deps.waitForRecoveredExit(
          running.client,
          running.identity,
          this.#deps.shutdownGraceMs,
          options.signal,
        );
        if (!stopped) throw new BridgeSupervisorError('shutdown_timeout');
      } else {
        const stopped = await this.#deps.waitForCurrentExit(
          running.child,
          this.#deps.shutdownGraceMs,
          options.signal,
        );
        if (!stopped) {
          let finalHealth: BridgeHealth;
          try {
            finalHealth = BridgeHealthSchema.parse(
              await running.client.health({ signal: options.signal }),
            );
          } catch {
            throw new BridgeSupervisorError('process_unverified');
          }
          if (!matchesHealth(running.identity, finalHealth) || this.#running !== running) {
            throw new BridgeSupervisorError('process_unverified');
          }
          try {
            await this.#deps.forceTerminate(running.child);
          } catch {
            throw new BridgeSupervisorError('shutdown_failed');
          }
        }
      }
      running.generation.abort();
      if (this.#running === running) this.#running = undefined;
      await this.#identityStore.removeIfMatches(running.identity).catch(() => undefined);
    });
  }

  async #startFresh(
    startup: Buffer,
    secret: string,
    callSignal?: AbortSignal,
  ): Promise<RunningBridge> {
    const deadline = this.#deadline(callSignal);
    let child: ChildProcessWithoutNullStreams | undefined;
    let durableIdentity: BridgeProcessIdentity | undefined;
    let managedClient: BridgeSupervisorClient | undefined;
    let generation: AbortController | undefined;
    let verified = false;
    let protocolViolation = false;
    let childExited = false;
    try {
      const binary = await this.#abortable(this.#deps.resolveBinary(deadline.signal), deadline);
      this.#checkDeadline(deadline);
      child = this.#deps.spawn(binary.path, ['daemon', 'bridge'], {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: this.#deps.environment,
        windowsHide: true,
      });
      if (!Number.isSafeInteger(child.pid) || child.pid === undefined || child.pid <= 0) {
        throw new BridgeSupervisorError('startup_failed');
      }
      let stderrBytes = 0;
      child.stderr.on('data', (chunk: Buffer | string) => {
        stderrBytes = Math.min(STDERR_LIMIT, stderrBytes + Buffer.byteLength(chunk));
      });
      child.once('exit', () => {
        childExited = true;
        const expected = durableIdentity;
        const running = this.#running;
        if (running !== undefined && running.child === child) {
          running.generation.abort();
          this.#running = undefined;
        }
        if (expected !== undefined) {
          void this.#serialized(async () => {
            await this.#identityStore.removeIfMatches(expected).catch(() => undefined);
          });
        }
      });
      const readinessPromise = this.#readReadiness(child, deadline, () => {
        protocolViolation = true;
        if (verified && managedClient !== undefined) {
          void managedClient.shutdown().finally(() => {
            const running = this.#running;
            if (running !== undefined && running.child === child) running.generation.abort();
          });
        }
      });
      child.stdin.end(startup);
      const readiness = await readinessPromise;
      if (readiness.pid !== child.pid || readiness.version !== this.#deps.version) {
        throw new BridgeSupervisorError('identity_mismatch');
      }
      generation = new AbortController();
      managedClient = this.#deps.clientFactory({
        baseUrl: `http://${readiness.address}`,
        secret,
        lifecycleSignal: generation.signal,
      });
      let gotHealth: BridgeHealth;
      while (true) {
        this.#checkDeadline(deadline);
        try {
          gotHealth = BridgeHealthSchema.parse(
            await managedClient.health({ signal: deadline.signal }),
          );
          break;
        } catch (error) {
          if (!(error instanceof BridgeClientError) || !error.retryable) {
            throw new BridgeSupervisorError('startup_failed');
          }
          await this.#abortable(
            this.#deps.sleep(this.#deps.healthRetryDelayMs, deadline.signal),
            deadline,
          );
        }
      }
      const processIdentity: BridgeProcessIdentity = {
        schema_version: 1,
        address: readiness.address,
        pid: readiness.pid,
        version: readiness.version,
        instance_id: readiness.instance_id,
        started_at: readiness.started_at,
      };
      if (!matchesHealth(processIdentity, gotHealth) || protocolViolation || childExited) {
        generation.abort();
        throw new BridgeSupervisorError('identity_mismatch');
      }
      await this.#identityStore.write(processIdentity).catch(() => {
        throw new BridgeSupervisorError('startup_failed');
      });
      durableIdentity = processIdentity;
      if (protocolViolation || childExited) {
        await this.#identityStore.removeIfMatches(processIdentity).catch(() => undefined);
        throw new BridgeSupervisorError('identity_mismatch');
      }
      verified = true;
      this.#running = {
        child,
        client: managedClient,
        identity: processIdentity,
        recovered: false,
        generation,
      };
      return this.#public(this.#running);
    } catch (error) {
      generation?.abort();
      if (durableIdentity !== undefined) {
        await this.#identityStore.removeIfMatches(durableIdentity).catch(() => undefined);
      }
      if (deadline.timedOut()) throw new BridgeSupervisorError('startup_timeout');
      if (error instanceof BridgeSupervisorError) throw error;
      throw new BridgeSupervisorError('startup_failed');
    } finally {
      deadline.dispose();
    }
  }

  #readReadiness(
    child: ChildProcessWithoutNullStreams,
    deadline: Deadline,
    laterOutput: () => void,
  ): Promise<ReturnType<typeof BridgeReadinessSchema.parse>> {
    return new Promise((resolve, reject) => {
      let bytes = Buffer.alloc(0);
      let ready = false;
      const fail = (code: BridgeSupervisorErrorCode) => {
        cleanup();
        reject(new BridgeSupervisorError(code));
      };
      const onData = (chunk: Buffer | string) => {
        const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (ready) {
          if (next.byteLength > 0) laterOutput();
          return;
        }
        bytes = Buffer.concat([bytes, next]);
        if (bytes.byteLength > READINESS_LIMIT) {
          fail('readiness_invalid');
          return;
        }
        const newline = bytes.indexOf(0x0a);
        if (newline === -1) return;
        if (newline !== bytes.byteLength - 1 || newline === 0 || bytes[newline - 1] === 0x0d) {
          fail('readiness_invalid');
          return;
        }
        let value: unknown;
        try {
          value = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, newline)),
          ) as unknown;
        } catch {
          fail('readiness_invalid');
          return;
        }
        const parsed = BridgeReadinessSchema.safeParse(value);
        if (!parsed.success) {
          fail('readiness_invalid');
          return;
        }
        ready = true;
        child.stdout.removeListener('end', onEnd);
        child.removeListener('exit', onExit);
        deadline.signal.removeEventListener('abort', onAbort);
        resolve(parsed.data);
      };
      const onEnd = () => fail('readiness_invalid');
      const onError = () => {
        if (ready) laterOutput();
        else fail('readiness_invalid');
      };
      const onProcessError = () => {
        if (ready) laterOutput();
        else fail('startup_failed');
      };
      const onExit = () => fail('startup_failed');
      const onAbort = () =>
        fail(deadline.timedOut() ? 'startup_timeout' : 'startup_failed');
      const cleanup = () => {
        child.stdout.removeListener('data', onData);
        child.stdout.removeListener('end', onEnd);
        child.stdout.removeListener('error', onError);
        child.stdin.removeListener('error', onProcessError);
        child.removeListener('error', onProcessError);
        child.removeListener('exit', onExit);
        deadline.signal.removeEventListener('abort', onAbort);
      };
      child.stdout.on('data', onData);
      child.stdout.once('end', onEnd);
      child.stdout.on('error', onError);
      child.stdin.on('error', onProcessError);
      child.on('error', onProcessError);
      child.once('exit', onExit);
      deadline.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  #deadline(callSignal?: AbortSignal): Deadline {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    if (callSignal?.aborted) controller.abort();
    else callSignal?.addEventListener('abort', abort, { once: true });
    const timer = this.#deps.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#deps.startupTimeoutMs);
    return {
      signal: controller.signal,
      timedOut: () => timedOut,
      dispose: () => {
        this.#deps.clearTimeout(timer);
        callSignal?.removeEventListener('abort', abort);
      },
    };
  }

  #checkDeadline(deadline: Deadline): void {
    if (deadline.signal.aborted) {
      throw new BridgeSupervisorError(deadline.timedOut() ? 'startup_timeout' : 'startup_failed');
    }
  }

  #abortable<T>(operation: Promise<T>, deadline: Deadline): Promise<T> {
    const abortedError = () =>
      new BridgeSupervisorError(deadline.timedOut() ? 'startup_timeout' : 'startup_failed');
    if (deadline.signal.aborted) return Promise.reject(abortedError());
    return new Promise((resolve, reject) => {
      const aborted = () => reject(abortedError());
      deadline.signal.addEventListener('abort', aborted, { once: true });
      operation.then(
        (value) => {
          deadline.signal.removeEventListener('abort', aborted);
          resolve(value);
        },
        (error: unknown) => {
          deadline.signal.removeEventListener('abort', aborted);
          reject(error);
        },
      );
    });
  }

  #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.catch(() => undefined).then(operation);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #public(running: ManagedBridge): RunningBridge {
    return { client: running.client, identity: { ...running.identity }, recovered: running.recovered };
  }
}
