import { randomBytes as cryptoRandomBytes } from 'node:crypto';
import { isAbsolute } from 'node:path';

import {
  PROVIDERS,
  RUNTIME_ID_PATTERN,
  type Provider,
  type RuntimeBinding,
  type TrustedRuntime,
} from '../config/schema.js';
import type {
  EnableResult,
  PairingSelectionInput,
} from '../bindings/service.js';
import { PairingClient, PairingClientError, type CreatePairingSessionInput } from './client.js';
import type {
  PairingCandidate,
  PairingCandidateResult,
  PairingRegistrationAuthorization,
} from './schema.js';

const POLL_DELAY_MS = 500;
const MAX_RANDOM_ATTEMPTS = 32;
const SAFE_VERSION_TOKEN = /^v?(?:0|[1-9]\d{0,5})(?:\.(?:0|[1-9]\d{0,5})){0,3}$/;
const RETRYABLE_REGISTRATION_ERRORS = new Set([
  'registration_timeout',
  'registration_transport',
  'runtime_unavailable',
]);

const providerLabels = {
  opencode: 'OpenCode',
  openclaw: 'OpenClaw',
  codex: 'Codex',
  hermes: 'Hermes',
} as const satisfies Record<Provider, string>;

type PairingClientPort = Pick<PairingClient, 'createSession' | 'pollSelection' | 'cancelSession'>;

export type PairingSessionState =
  | 'idle'
  | 'waiting'
  | 'claimed'
  | 'processing'
  | 'completed'
  | 'partial'
  | 'cancelled'
  | 'expired';

type PairingBindingPort = {
  list(): readonly RuntimeBinding[];
  enablePairingSelection(input: PairingSelectionInput, signal?: AbortSignal): Promise<EnableResult>;
};

export type PairingRuntime = TrustedRuntime & { version?: string | null };

export type PairingRuntimeSource = {
  runtimes(): Promise<readonly PairingRuntime[]>;
};

export type PairingServiceDependencies = {
  client: PairingClientPort;
  bindings: PairingBindingPort;
  runtimeSource: PairingRuntimeSource;
  installAbuseKey: string;
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<unknown>;
};

export type PairingServiceResult = PairingCandidateResult & { retryable: boolean };

export type PairingServiceSnapshot = {
  state: PairingSessionState;
  ticket: string | null;
  expiresAt: string | null;
  candidates: readonly PairingCandidate[];
  results: readonly PairingServiceResult[];
};

type PrivateSession = {
  ticket: string;
  deviceSecret: string;
  expiresAt: string;
};

type ExplicitError = { code?: unknown; retryable?: unknown };

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new PairingClientError('pairing_cancelled', 'transport', false));
      return;
    }
    const complete = () => {
      signal.removeEventListener('abort', cancel);
      resolve();
    };
    const timer = setTimeout(complete, milliseconds);
    const cancel = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      reject(new PairingClientError('pairing_cancelled', 'transport', false));
    };
    signal.addEventListener('abort', cancel, { once: true });
  });
}

function validRuntime(runtime: PairingRuntime): boolean {
  return RUNTIME_ID_PATTERN.test(runtime.id)
    && PROVIDERS.includes(runtime.provider)
    && ['ready', 'needs_auth', 'found_not_runnable', 'not_found', 'probe_failed']
      .includes(runtime.status)
    && runtime.path.length > 0
    && runtime.path.length <= 4096
    && runtime.path === runtime.path.trim()
    && !runtime.path.includes('\0')
    && isAbsolute(runtime.path);
}

function safeVersion(version: string | null | undefined): string | null {
  return typeof version === 'string'
    && version === version.trim()
    && SAFE_VERSION_TOKEN.test(version)
    && !RUNTIME_ID_PATTERN.test(version)
    ? version
    : null;
}

function completeBinding(binding: RuntimeBinding): boolean {
  return binding.nodeId !== undefined && binding.tokenRef !== undefined;
}

function cloneCandidate(candidate: PairingCandidate): PairingCandidate {
  return { ...candidate };
}

function cloneResult(result: PairingServiceResult): PairingServiceResult {
  return { ...result };
}

function explicitFailure(error: unknown): { code: string; retryable: boolean } {
  try {
    if (typeof error !== 'object' || error === null) {
      return { code: 'registration_rejected', retryable: false };
    }
    const { code, retryable } = error as ExplicitError;
    if (typeof code !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(code)) {
      return { code: 'registration_rejected', retryable: false };
    }
    return { code, retryable: retryable === true };
  } catch {
    return { code: 'registration_rejected', retryable: false };
  }
}

function resultFailure(candidateId: string, code: string, retryable: boolean): PairingServiceResult {
  return { candidateId, status: 'failed', errorCode: code, nodeId: null, retryable };
}

export class PairingService {
  readonly #client: PairingClientPort;
  readonly #bindings: PairingBindingPort;
  readonly #runtimeSource: PairingRuntimeSource;
  readonly #installAbuseKey: string;
  readonly #now: () => number;
  readonly #randomBytes: (size: number) => Uint8Array;
  readonly #sleep: (milliseconds: number, signal: AbortSignal) => Promise<unknown>;
  #state: PairingSessionState = 'idle';
  #ticket: string | null = null;
  #expiresAt: string | null = null;
  #candidates: PairingCandidate[] = [];
  #results = new Map<string, PairingServiceResult>();
  #candidateToRuntime = new Map<string, string>();
  #readyCandidates = new Set<string>();
  #selectedCandidates: string[] = [];
  #privateSession: PrivateSession | undefined;
  #controller: AbortController | undefined;
  #expiryTimer: ReturnType<typeof setTimeout> | undefined;
  #cycle: Promise<void> = Promise.resolve();
  #startInFlight: Promise<PairingServiceSnapshot> | undefined;
  #generation = 0;

  constructor(dependencies: PairingServiceDependencies) {
    this.#client = dependencies.client;
    this.#bindings = dependencies.bindings;
    this.#runtimeSource = dependencies.runtimeSource;
    this.#installAbuseKey = dependencies.installAbuseKey;
    this.#now = dependencies.now ?? (() => Date.now());
    this.#randomBytes = dependencies.randomBytes ?? cryptoRandomBytes;
    this.#sleep = dependencies.sleep ?? abortableSleep;
  }

  snapshot(): PairingServiceSnapshot {
    return {
      state: this.#state,
      ticket: this.#ticket,
      expiresAt: this.#expiresAt,
      candidates: this.#candidates.map(cloneCandidate),
      results: this.#selectedCandidates.flatMap((candidateId) => {
        const result = this.#results.get(candidateId);
        return result === undefined ? [] : [cloneResult(result)];
      }),
    };
  }

  start(): Promise<PairingServiceSnapshot> {
    if (this.#startInFlight !== undefined) return this.#startInFlight;
    const start = this.#startFresh();
    this.#startInFlight = start;
    void start.finally(() => {
      if (this.#startInFlight === start) this.#startInFlight = undefined;
    }).catch(() => undefined);
    return start;
  }

  recover(): Promise<PairingServiceSnapshot> {
    return this.start();
  }

  waitForTerminal(): Promise<void> {
    return this.#cycle;
  }

  async cancel(): Promise<PairingServiceSnapshot> {
    const privateSession = this.#privateSession;
    if (privateSession === undefined) {
      if (this.#controller === undefined) return this.snapshot();
      const cancelledStart = this.#startInFlight;
      this.#state = 'cancelled';
      this.#controller.abort();
      this.#generation += 1;
      this.#clearPrivateState();
      if (this.#startInFlight === cancelledStart) this.#startInFlight = undefined;
      await this.#cycle.catch(() => undefined);
      return this.snapshot();
    }
    this.#state = 'cancelled';
    this.#controller?.abort();
    const generation = ++this.#generation;
    try {
      await this.#client.cancelSession(
        privateSession.ticket,
        privateSession.deviceSecret,
        this.#newOpaqueId(),
      );
    } catch (error) {
      if (!(error instanceof PairingClientError && error.code === 'pairing_cancelled')) throw error;
    } finally {
      if (generation === this.#generation) this.#clearPrivateState();
    }
    await this.#cycle.catch(() => undefined);
    return this.snapshot();
  }

  retryFailed(candidateIds: readonly string[]): PairingServiceSnapshot {
    if (this.#state !== 'partial' || this.#privateSession === undefined) return this.snapshot();
    if (this.#expired()) {
      this.#state = 'expired';
      this.#clearPrivateState();
      return this.snapshot();
    }
    const retry = [...new Set(candidateIds)].filter((candidateId) => {
      const result = this.#results.get(candidateId);
      return this.#selectedCandidates.includes(candidateId)
        && result?.status === 'failed'
        && result.retryable;
    });
    if (retry.length === 0) return this.snapshot();
    this.#state = 'processing';
    const generation = this.#generation;
    const controller = this.#controller!;
    this.#cycle = this.#registerCandidates(retry, generation, controller.signal)
      .then(() => this.#finishRegistration(generation))
      .catch((error) => this.#finishCycleError(error, generation));
    return this.snapshot();
  }

  async #startFresh(): Promise<PairingServiceSnapshot> {
    if (this.#privateSession !== undefined) await this.cancel();
    const catalog = await this.#runtimeSource.runtimes();
    const trusted = catalog.filter(validRuntime);
    if (trusted.length === 0) throw new Error('pairing_no_candidates');
    const currentBindings = this.#bindings.list();
    const candidates: PairingCandidate[] = [];
    const candidateToRuntime = new Map<string, string>();
    const readyCandidates = new Set<string>();
    for (const runtime of trusted) {
      const candidateId = this.#newUniqueCandidateId(candidateToRuntime);
      const ownBinding = currentBindings.find((binding) =>
        binding.runtimeId === runtime.id
        && binding.provider === runtime.provider
        && binding.runtimePath === runtime.path
        && completeBinding(binding));
      const conflictingBinding = currentBindings.find((binding) =>
        binding.provider === runtime.provider && binding.runtimeId !== runtime.id);
      let readiness: PairingCandidate['readiness'] = 'ready';
      let statusReason: string | null = null;
      if (ownBinding !== undefined) readiness = 'already_registered';
      else if (runtime.status !== 'ready') {
        readiness = 'not_ready';
        statusReason = runtime.status;
      } else if (conflictingBinding !== undefined) {
        readiness = 'not_ready';
        statusReason = 'provider_conflict';
      }
      const candidate: PairingCandidate = {
        candidateId,
        provider: runtime.provider,
        displayName: providerLabels[runtime.provider],
        version: safeVersion(runtime.version),
        readiness,
        statusReason,
        registrationState: ownBinding === undefined ? 'unregistered' : 'registered',
      };
      candidates.push(candidate);
      candidateToRuntime.set(candidateId, runtime.id);
      if (readiness === 'ready') readyCandidates.add(candidateId);
    }
    const input: CreatePairingSessionInput = {
      installAbuseKey: this.#installAbuseKey,
      idempotencyKey: this.#newOpaqueId(),
      candidates,
    };
    this.#ticket = null;
    this.#expiresAt = null;
    this.#candidates = [];
    this.#selectedCandidates = [];
    this.#results.clear();
    const controller = new AbortController();
    const generation = ++this.#generation;
    this.#controller = controller;
    let session;
    try {
      session = await this.#client.createSession(input, controller.signal);
    } catch (error) {
      if (generation === this.#generation) {
        this.#controller = undefined;
        if (this.#state !== 'cancelled') this.#state = 'idle';
      }
      throw error;
    }
    if (generation !== this.#generation || controller.signal.aborted) {
      throw new PairingClientError('pairing_cancelled', 'transport', false);
    }
    this.#privateSession = {
      ticket: session.ticket,
      deviceSecret: session.deviceSecret,
      expiresAt: session.expiresAt,
    };
    this.#ticket = session.ticket;
    this.#expiresAt = session.expiresAt;
    this.#candidates = candidates.map(cloneCandidate);
    this.#candidateToRuntime = candidateToRuntime;
    this.#readyCandidates = readyCandidates;
    this.#selectedCandidates = [];
    this.#results.clear();
    this.#state = session.status === 'expired' ? 'expired' : 'waiting';
    if (this.#state === 'expired' || this.#expired()) {
      this.#state = 'expired';
      this.#clearPrivateState();
      this.#cycle = Promise.resolve();
      return this.snapshot();
    }
    this.#armExpiry(generation, controller, session.expiresAt);
    this.#cycle = this.#poll(generation, controller.signal)
      .catch((error) => this.#finishCycleError(error, generation));
    return this.snapshot();
  }

  async #poll(generation: number, signal: AbortSignal): Promise<void> {
    while (generation === this.#generation && !signal.aborted) {
      if (this.#expired()) {
        this.#state = 'expired';
        this.#clearPrivateState();
        return;
      }
      const session = this.#privateSession;
      if (session === undefined) return;
      let selection;
      try {
        selection = await this.#client.pollSelection(session.ticket, session.deviceSecret, signal);
      } catch (error) {
        if (generation !== this.#generation || signal.aborted) return;
        if (error instanceof PairingClientError && error.code === 'pairing_expired') {
          this.#state = 'expired';
          this.#clearPrivateState();
          return;
        }
        if (error instanceof PairingClientError && error.retryable) {
          await this.#sleep(POLL_DELAY_MS, signal);
          continue;
        }
        throw error;
      }
      if (generation !== this.#generation || signal.aborted) return;
      if (this.#expired()) {
        this.#state = 'expired';
        this.#clearPrivateState();
        return;
      }
      if (selection.status === 'cancelled' || selection.status === 'expired') {
        this.#state = selection.status;
        this.#clearPrivateState();
        return;
      }
      if (selection.selectedCandidateIds.length === 0) {
        this.#state = selection.status === 'completed' ? 'completed' : selection.status;
        if (this.#state === 'completed') {
          this.#clearPrivateState();
          return;
        }
        await this.#sleep(POLL_DELAY_MS, signal);
        continue;
      }
      this.#selectedCandidates = [...new Set(selection.selectedCandidateIds)];
      this.#state = 'processing';
      await this.#registerCandidates(this.#selectedCandidates, generation, signal);
      this.#finishRegistration(generation);
      return;
    }
  }

  async #registerCandidates(
    candidateIds: readonly string[],
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    await Promise.all(candidateIds.map(async (candidateId) => {
      if (generation !== this.#generation || signal.aborted || this.#expired()) return;
      const runtimeId = this.#candidateToRuntime.get(candidateId);
      if (runtimeId === undefined || !this.#readyCandidates.has(candidateId)) {
        this.#results.set(candidateId, resultFailure(candidateId, 'runtime_unavailable', false));
        return;
      }
      this.#results.set(candidateId, {
        candidateId,
        status: 'registering',
        errorCode: null,
        nodeId: null,
        retryable: false,
      });
      const session = this.#privateSession;
      if (session === undefined) return;
      const authorization: PairingRegistrationAuthorization = {
        ticket: session.ticket,
        deviceSecret: session.deviceSecret,
        candidateId,
        idempotencyKey: this.#newOpaqueId(),
      };
      try {
        const enabled = await this.#bindings.enablePairingSelection(
          { runtimeId, authorization },
          signal,
        );
        if (generation !== this.#generation || signal.aborted) return;
        if (enabled.ok) {
          this.#results.set(candidateId, {
            candidateId,
            status: 'bound',
            errorCode: null,
            nodeId: enabled.binding.nodeId ?? null,
            retryable: false,
          });
        } else {
          this.#results.set(candidateId, resultFailure(
            candidateId,
            enabled.errorCode,
            RETRYABLE_REGISTRATION_ERRORS.has(enabled.errorCode),
          ));
        }
      } catch (error) {
        if (generation !== this.#generation || signal.aborted) return;
        const failure = explicitFailure(error);
        this.#results.set(candidateId, resultFailure(candidateId, failure.code, failure.retryable));
      }
    }));
  }

  #finishRegistration(generation: number): void {
    if (generation !== this.#generation) return;
    if (this.#expired()) {
      this.#state = 'expired';
      this.#clearPrivateState();
      return;
    }
    const selectedResults = this.#selectedCandidates.map((candidateId) =>
      this.#results.get(candidateId));
    this.#state = selectedResults.every((result) =>
      result?.status === 'bound' || result?.status === 'already_bound')
      ? 'completed'
      : 'partial';
    if (this.#state === 'completed') this.#clearPrivateState();
  }

  #finishCycleError(error: unknown, generation: number): void {
    if (generation !== this.#generation) return;
    if (this.#state === 'cancelled' || this.#state === 'expired') return;
    if (error instanceof PairingClientError && error.code === 'pairing_expired') {
      this.#state = 'expired';
    } else {
      this.#state = 'cancelled';
    }
    this.#clearPrivateState();
  }

  #expired(): boolean {
    const expiresAt = this.#privateSession?.expiresAt ?? this.#expiresAt;
    return expiresAt !== null && this.#now() >= Date.parse(expiresAt);
  }

  #clearPrivateState(): void {
    if (this.#expiryTimer !== undefined) clearTimeout(this.#expiryTimer);
    this.#expiryTimer = undefined;
    this.#privateSession = undefined;
    this.#candidateToRuntime.clear();
    this.#readyCandidates.clear();
    this.#controller = undefined;
  }

  #armExpiry(generation: number, controller: AbortController, expiresAt: string): void {
    const delay = Math.max(0, Date.parse(expiresAt) - this.#now());
    const timer = setTimeout(() => {
      if (generation !== this.#generation || this.#privateSession === undefined) return;
      this.#state = 'expired';
      this.#generation += 1;
      controller.abort();
      this.#clearPrivateState();
    }, delay);
    timer.unref?.();
    this.#expiryTimer = timer;
  }

  #newUniqueCandidateId(existing: ReadonlyMap<string, string>): string {
    for (let attempt = 0; attempt < MAX_RANDOM_ATTEMPTS; attempt += 1) {
      const candidateId = this.#newOpaqueId();
      if (!existing.has(candidateId)) return candidateId;
    }
    throw new Error('pairing_candidate_id_collision');
  }

  #newOpaqueId(): string {
    const bytes = this.#randomBytes(16);
    if (bytes.byteLength !== 16) throw new Error('pairing_random_invalid');
    return Buffer.from(bytes).toString('base64url');
  }
}
