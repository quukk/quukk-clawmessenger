// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeBinding, TrustedRuntime } from '../config/schema.js';
import type { EnableResult } from '../bindings/service.js';
import { PairingClientError, type CreatePairingSessionInput } from './client.js';
import { PairingService } from './service.js';
import type { PairingRegistrationAuthorization, PairingSelection, PairingSession } from './schema.js';

const NOW = Date.parse('2026-09-02T00:00:00.000Z');
const EXPIRES_AT = '2026-09-02T00:05:00.000Z';
const INSTALL_ABUSE_KEY = 'a'.repeat(64);
const providerMarker = { opencode: 'a', openclaw: 'b', codex: 'c', hermes: 'd' } as const;

function runtime(
  provider: keyof typeof providerMarker,
  overrides: Partial<TrustedRuntime & { version?: string | null }> = {},
): TrustedRuntime & { version?: string | null } {
  return {
    id: `rt_${providerMarker[provider].repeat(32)}`,
    provider,
    path: process.platform === 'win32' ? `C:\\tools\\${provider}.exe` : `/tools/${provider}`,
    status: 'ready',
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

function binding(selected: TrustedRuntime): RuntimeBinding {
  return {
    runtimeId: selected.id,
    runtimePath: selected.path,
    provider: selected.provider,
    enabled: true,
    nodeId: `${selected.provider}_paired`,
    nodeName: `fixture · ${selected.provider}`,
    tokenRef: `rc_${providerMarker[selected.provider].repeat(32)}`,
    registrationState: 'offline',
    updatedAt: '2026-09-02T00:00:01.000Z',
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushAsyncWork(): Promise<void> {
  for (let step = 0; step < 12; step += 1) await Promise.resolve();
}

class FakeRuntimeSource {
  constructor(public snapshot: readonly TrustedRuntime[]) {}

  async runtimes(): Promise<readonly TrustedRuntime[]> {
    return this.snapshot.map((entry) => ({ ...entry }));
  }
}

class FakeBindings {
  readonly calls: Array<{
    runtimeId: string;
    authorization: PairingRegistrationAuthorization;
  }> = [];
  currentBindings: RuntimeBinding[] = [];
  outcomes = new Map<string, EnableResult[]>();

  list(): readonly RuntimeBinding[] {
    return this.currentBindings.map((entry) => ({ ...entry }));
  }

  async enablePairingSelection(input: {
    runtimeId: string;
    authorization: PairingRegistrationAuthorization;
  }): Promise<EnableResult> {
    this.calls.push({ ...input, authorization: { ...input.authorization } });
    const queued = this.outcomes.get(input.runtimeId);
    const outcome = queued?.shift();
    if (outcome !== undefined) return outcome;
    const selected = runtime(
      (Object.entries(providerMarker).find(([, marker]) => input.runtimeId.endsWith(marker.repeat(32)))?.[0]
        ?? 'codex') as keyof typeof providerMarker,
      { id: input.runtimeId },
    );
    return { runtimeId: input.runtimeId, ok: true, binding: binding(selected) };
  }
}

class FakePairingClient {
  readonly createCalls: CreatePairingSessionInput[] = [];
  readonly pollCalls: Array<{ ticket: string; deviceSecret: string; signal?: AbortSignal }> = [];
  readonly cancelCalls: Array<{
    ticket: string;
    deviceSecret: string;
    idempotencyKey: string;
  }> = [];
  readonly selections: Array<ReturnType<typeof deferred<PairingSelection>>> = [];
  readonly createSignals: Array<AbortSignal | undefined> = [];
  readonly retryPolls: Array<ReturnType<typeof deferred<{
    requestId: string;
    candidateIds: string[];
  } | null>>> = [];
  readonly retryPollCalls: Array<{ ticket: string; deviceSecret: string; signal?: AbortSignal }> = [];
  readonly retryAckCalls: Array<{
    ticket: string;
    deviceSecret: string;
    requestId: string;
    idempotencyKey: string;
  }> = [];
  readonly retryAckFailures: PairingClientError[] = [];
  retryAckImplementation: ((
    ticket: string,
    deviceSecret: string,
    requestId: string,
    idempotencyKey: string,
    signal?: AbortSignal,
  ) => Promise<{ requestId: string; candidateIds: string[] }>) | undefined;
  createImplementation: ((
    input: CreatePairingSessionInput,
    signal?: AbortSignal,
  ) => Promise<PairingSession>) | undefined;

  async createSession(
    input: CreatePairingSessionInput,
    signal?: AbortSignal,
  ): Promise<PairingSession> {
    this.createCalls.push({ ...input, candidates: input.candidates.map((candidate) => ({ ...candidate })) });
    this.createSignals.push(signal);
    if (this.createImplementation !== undefined) return this.createImplementation(input, signal);
    const marker = String.fromCharCode(84 + this.createCalls.length - 1);
    return {
      ticket: marker.repeat(43),
      deviceSecret: marker.toLowerCase().repeat(43),
      expiresAt: EXPIRES_AT,
      status: 'waiting',
      candidates: input.candidates.map((candidate) => ({ ...candidate })),
    };
  }

  pollSelection(
    ticket: string,
    deviceSecret: string,
    signal?: AbortSignal,
  ): Promise<PairingSelection> {
    this.pollCalls.push({ ticket, deviceSecret, signal });
    const selection = deferred<PairingSelection>();
    this.selections.push(selection);
    signal?.addEventListener('abort', () => {
      selection.reject(new PairingClientError('pairing_cancelled', 'transport', false));
    }, { once: true });
    return selection.promise;
  }

  async cancelSession(
    ticket: string,
    deviceSecret: string,
    idempotencyKey: string,
  ): Promise<PairingSelection> {
    this.cancelCalls.push({ ticket, deviceSecret, idempotencyKey });
    const candidates = this.createCalls.at(-1)?.candidates ?? [];
    return { status: 'cancelled', selectedCandidateIds: [], candidates, expiresAt: EXPIRES_AT };
  }

  pollRetry(
    ticket: string,
    deviceSecret: string,
    signal?: AbortSignal,
  ): Promise<{ requestId: string; candidateIds: string[] } | null> {
    this.retryPollCalls.push({ ticket, deviceSecret, signal });
    const pending = deferred<{ requestId: string; candidateIds: string[] } | null>();
    this.retryPolls.push(pending);
    signal?.addEventListener('abort', () => {
      pending.reject(new PairingClientError('pairing_cancelled', 'transport', false));
    }, { once: true });
    return pending.promise;
  }

  async ackRetry(
    ticket: string,
    deviceSecret: string,
    requestId: string,
    idempotencyKey: string,
  ): Promise<{ requestId: string; candidateIds: string[] }> {
    this.retryAckCalls.push({ ticket, deviceSecret, requestId, idempotencyKey });
    if (this.retryAckImplementation !== undefined) {
      return this.retryAckImplementation(ticket, deviceSecret, requestId, idempotencyKey);
    }
    const failure = this.retryAckFailures.shift();
    if (failure !== undefined) throw failure;
    return { requestId, candidateIds: [] };
  }
}

function selected(
  client: FakePairingClient,
  candidateIds: string[],
  overrides: Partial<PairingSelection> = {},
): PairingSelection {
  return {
    status: 'processing',
    selectedCandidateIds: candidateIds,
    candidates: client.createCalls.at(-1)!.candidates.map((candidate) => ({ ...candidate })),
    expiresAt: EXPIRES_AT,
    ...overrides,
  };
}

function harness(
  runtimes: readonly TrustedRuntime[] = [runtime('opencode'), runtime('codex')],
  options: {
    client?: FakePairingClient;
    bindings?: FakeBindings;
    randomStart?: number;
    now?: () => number;
    sleep?: (milliseconds: number, signal: AbortSignal) => Promise<unknown>;
  } = {},
) {
  const client = options.client ?? new FakePairingClient();
  const bindings = options.bindings ?? new FakeBindings();
  const source = new FakeRuntimeSource(runtimes);
  let randomValue = options.randomStart ?? 1;
  const randomBytes = vi.fn((size: number) => Buffer.alloc(size, randomValue++));
  const service = new PairingService({
    client,
    bindings,
    runtimeSource: source,
    installAbuseKey: INSTALL_ABUSE_KEY,
    now: options.now ?? (() => NOW),
    randomBytes,
    sleep: options.sleep ?? (async (_milliseconds: number, signal: AbortSignal) => {
      if (signal.aborted) throw new PairingClientError('pairing_cancelled', 'transport', false);
    }),
  });
  return { service, client, bindings, source, randomBytes };
}

describe('PairingService', () => {
  it('creates sanitized candidates with random 128-bit session-scoped IDs and no default selection', async () => {
    const notReady = runtime('hermes', { status: 'needs_auth' });
    const conflicting = runtime('codex');
    const fixture = harness([runtime('opencode', { version: '1.2.3' }), notReady, conflicting]);
    fixture.bindings.currentBindings = [binding(runtime('codex', {
      id: `rt_${'e'.repeat(32)}`,
      path: process.platform === 'win32' ? 'C:\\tools\\codex-other.exe' : '/tools/codex-other',
    }))];

    const snapshot = await fixture.service.start();
    const request = fixture.client.createCalls[0]!;

    expect(fixture.randomBytes.mock.calls.every(([size]) => size === 16)).toBe(true);
    expect(new Set(request.candidates.map((candidate) => candidate.candidateId)).size).toBe(3);
    expect(request.candidates.every((candidate) => candidate.candidateId.length === 22)).toBe(true);
    expect(request.candidates).toEqual([
      expect.objectContaining({
        provider: 'opencode',
        version: '1.2.3',
        readiness: 'ready',
        registrationState: 'unregistered',
      }),
      expect.objectContaining({ provider: 'hermes', readiness: 'not_ready', statusReason: 'needs_auth' }),
      expect.objectContaining({ provider: 'codex', readiness: 'not_ready', statusReason: 'provider_conflict' }),
    ]);
    expect(snapshot.results).toEqual([]);
    expect(fixture.bindings.calls).toEqual([]);
    expect(JSON.stringify(request.candidates)).not.toMatch(/runtimeId|runtimePath|\\tools\\|\/tools\//);
    await fixture.service.cancel();
  });

  it.each([
    ['Windows path', 'C:\\Users\\alice\\.codex\\auth.json'],
    ['Unix path', '/home/alice/.codex/auth.json'],
    ['runtime identifier', `rt_${'f'.repeat(32)}`],
    ['sensitive marker', 'v1.2.3-token-secret'],
    ['build metadata payload', 'v1.2.3+tokenABC'],
    ['prerelease payload', 'v1.2.3-password123'],
  ])('omits an unsafe detected version containing a %s', async (_name, version) => {
    const fixture = harness([runtime('codex', { version })]);

    const snapshot = await fixture.service.start();

    expect(snapshot.candidates[0]!.version).toBeNull();
    expect(JSON.stringify(fixture.client.createCalls[0]!.candidates)).not.toContain(version);
    await fixture.service.cancel();
  });

  it('registers exactly the selected ready runtimes', async () => {
    const opencode = runtime('opencode');
    const codex = runtime('codex');
    const fixture = harness([opencode, codex]);

    await fixture.service.start();
    const opencodeCandidate = fixture.client.createCalls[0]!.candidates.find(
      (candidate) => candidate.provider === 'opencode',
    )!;
    fixture.client.selections[0]!.resolve(selected(fixture.client, [opencodeCandidate.candidateId]));
    await fixture.service.waitForTerminal();

    expect(fixture.bindings.calls).toHaveLength(1);
    expect(fixture.bindings.calls[0]).toMatchObject({
      runtimeId: opencode.id,
      authorization: {
        ticket: 'T'.repeat(43),
        deviceSecret: 't'.repeat(43),
        candidateId: opencodeCandidate.candidateId,
      },
    });
    expect(fixture.bindings.calls).not.toContainEqual(expect.objectContaining({ runtimeId: codex.id }));
    expect(fixture.service.snapshot()).toMatchObject({
      state: 'completed',
      results: [{ candidateId: opencodeCandidate.candidateId, status: 'bound', retryable: false }],
    });
  });

  it('keeps polling without a default selection and registers only after confirmation', async () => {
    const fixture = harness([runtime('codex')]);
    await fixture.service.start();
    fixture.client.selections[0]!.resolve(selected(fixture.client, [], { status: 'waiting' }));

    await vi.waitFor(() => expect(fixture.client.selections).toHaveLength(2));
    expect(fixture.bindings.calls).toEqual([]);
    const candidateId = fixture.client.createCalls[0]!.candidates[0]!.candidateId;
    fixture.client.selections[1]!.resolve(selected(fixture.client, [candidateId]));
    await fixture.service.waitForTerminal();

    expect(fixture.bindings.calls).toHaveLength(1);
    expect(fixture.bindings.calls[0]!.authorization.candidateId).toBe(candidateId);
  });

  it('cancels the previous active session before generating a replacement', async () => {
    const fixture = harness([runtime('codex')]);
    const first = await fixture.service.start();

    const second = await fixture.service.start();

    expect(fixture.client.createCalls).toHaveLength(2);
    expect(fixture.client.cancelCalls).toEqual([
      expect.objectContaining({ ticket: first.ticket, deviceSecret: 't'.repeat(43) }),
    ]);
    expect(second.ticket).not.toBe(first.ticket);
    await fixture.service.cancel();
  });

  it('cancels an in-flight creation generation and fences its late response', async () => {
    const pending = deferred<PairingSession>();
    const client = new FakePairingClient();
    client.createImplementation = async () => pending.promise;
    const fixture = harness([runtime('codex')], { client });

    const starting = fixture.service.start();
    await vi.waitFor(() => expect(client.createSignals).toHaveLength(1));
    const creationSignal = client.createSignals[0]!;
    const cancelled = await fixture.service.cancel();

    expect(creationSignal.aborted).toBe(true);
    expect(cancelled.state).toBe('cancelled');
    const request = client.createCalls[0]!;
    pending.resolve({
      ticket: 'T'.repeat(43),
      deviceSecret: 't'.repeat(43),
      expiresAt: EXPIRES_AT,
      status: 'waiting',
      candidates: request.candidates,
    });
    await expect(starting).rejects.toMatchObject({ code: 'pairing_cancelled' });
    expect(client.pollCalls).toEqual([]);
    expect(fixture.service.snapshot()).toMatchObject({
      state: 'cancelled',
      ticket: null,
      candidates: [],
      results: [],
    });
  });

  it('starts a replacement before an abort-ignoring cancelled creation settles', async () => {
    const firstCreation = deferred<PairingSession>();
    const secondCreation = deferred<PairingSession>();
    const client = new FakePairingClient();
    client.createImplementation = async () => (
      client.createCalls.length === 1 ? firstCreation.promise : secondCreation.promise
    );
    const fixture = harness([runtime('codex')], { client });

    const cancelledStart = fixture.service.start();
    await vi.waitFor(() => expect(client.createCalls).toHaveLength(1));
    await fixture.service.cancel();

    const replacementStart = fixture.service.start();
    expect(replacementStart).not.toBe(cancelledStart);
    await vi.waitFor(() => expect(client.createCalls).toHaveLength(2));
    const replacementRequest = client.createCalls[1]!;
    secondCreation.resolve({
      ticket: 'U'.repeat(43),
      deviceSecret: 'u'.repeat(43),
      expiresAt: EXPIRES_AT,
      status: 'waiting',
      candidates: replacementRequest.candidates,
    });

    await expect(replacementStart).resolves.toMatchObject({
      state: 'waiting',
      ticket: 'U'.repeat(43),
    });
    expect(client.pollCalls).toEqual([
      expect.objectContaining({ ticket: 'U'.repeat(43), deviceSecret: 'u'.repeat(43) }),
    ]);

    const cancelledRequest = client.createCalls[0]!;
    firstCreation.resolve({
      ticket: 'T'.repeat(43),
      deviceSecret: 't'.repeat(43),
      expiresAt: EXPIRES_AT,
      status: 'waiting',
      candidates: cancelledRequest.candidates,
    });
    await expect(cancelledStart).rejects.toMatchObject({ code: 'pairing_cancelled' });
    expect(fixture.service.snapshot()).toMatchObject({
      state: 'waiting',
      ticket: 'U'.repeat(43),
    });
    expect(client.pollCalls).toEqual([
      expect.objectContaining({ ticket: 'U'.repeat(43), deviceSecret: 'u'.repeat(43) }),
    ]);

    await fixture.service.cancel();
  });

  it('deduplicates selected candidate IDs before assigning one stable registration attempt', async () => {
    const fixture = harness([runtime('codex')]);
    await fixture.service.start();
    const candidateId = fixture.client.createCalls[0]!.candidates[0]!.candidateId;

    fixture.client.selections[0]!.resolve(selected(fixture.client, [candidateId, candidateId]));
    await fixture.service.waitForTerminal();

    expect(fixture.bindings.calls).toHaveLength(1);
    expect(fixture.bindings.calls[0]!.authorization).toMatchObject({
      candidateId,
      idempotencyKey: expect.any(String),
    });
    expect(fixture.service.snapshot()).toMatchObject({
      state: 'completed',
      results: [{ candidateId, status: 'bound' }],
    });
  });

  it('rejects unknown selected candidate IDs locally without leaking or registering them', async () => {
    const codex = runtime('codex');
    const fixture = harness([codex]);
    await fixture.service.start();
    const candidateId = fixture.client.createCalls[0]!.candidates[0]!.candidateId;
    const unknownCandidateId = 'unknown-candidate';

    fixture.client.selections[0]!.resolve(selected(
      fixture.client,
      [candidateId, unknownCandidateId],
    ));
    await fixture.service.waitForTerminal();

    expect(fixture.bindings.calls).toHaveLength(1);
    expect(fixture.bindings.calls[0]).toMatchObject({ runtimeId: codex.id });
    expect(fixture.service.snapshot()).toMatchObject({
      state: 'partial',
      results: [
        expect.objectContaining({ candidateId, status: 'bound' }),
        {
          candidateId: unknownCandidateId,
          status: 'failed',
          errorCode: 'runtime_unavailable',
          nodeId: null,
          retryable: false,
        },
      ],
    });
    const serialized = JSON.stringify(fixture.service.snapshot());
    expect(serialized).not.toContain(codex.id);
    expect(serialized).not.toContain(codex.path);
    expect(serialized).not.toContain('t'.repeat(43));
  });

  it('invalidates in-memory session credentials on restart and creates a fresh session', async () => {
    const client = new FakePairingClient();
    const first = harness([runtime('codex')], { client, randomStart: 10 });
    const initial = await first.service.start();
    const restarted = harness([runtime('codex')], { client, randomStart: 20 });

    await restarted.service.recover();
    const recovered = restarted.service.snapshot();

    expect(client.createCalls).toHaveLength(2);
    expect(recovered.state).toBe('waiting');
    expect(recovered.ticket).not.toBe(initial.ticket);
    expect(client.createCalls[1]!.candidates[0]!.candidateId)
      .not.toBe(client.createCalls[0]!.candidates[0]!.candidateId);
    await first.service.cancel();
    await restarted.service.cancel();
  });

  it('keeps partial results and retries only retryable failed selected candidates', async () => {
    const opencode = runtime('opencode');
    const codex = runtime('codex');
    const hermes = runtime('hermes');
    const fixture = harness([opencode, codex, hermes]);
    fixture.bindings.outcomes.set(opencode.id, [
      { runtimeId: opencode.id, ok: true, binding: binding(opencode) },
    ]);
    fixture.bindings.outcomes.set(codex.id, [
      { runtimeId: codex.id, ok: false, errorCode: 'registration_transport' },
      { runtimeId: codex.id, ok: true, binding: binding(codex) },
    ]);
    fixture.bindings.outcomes.set(hermes.id, [
      { runtimeId: hermes.id, ok: false, errorCode: 'registration_rejected' },
    ]);

    await fixture.service.start();
    const candidates = fixture.client.createCalls[0]!.candidates;
    const byProvider = new Map(candidates.map((candidate) => [candidate.provider, candidate]));
    fixture.client.selections[0]!.resolve(selected(fixture.client, [
      byProvider.get('opencode')!.candidateId,
      byProvider.get('codex')!.candidateId,
      byProvider.get('hermes')!.candidateId,
    ]));
    await fixture.service.waitForTerminal();

    expect(fixture.service.snapshot().state).toBe('partial');
    await fixture.service.retryFailed([
      byProvider.get('codex')!.candidateId,
      byProvider.get('hermes')!.candidateId,
      'unselected-candidate',
      byProvider.get('codex')!.candidateId,
    ]);
    await fixture.service.waitForTerminal();

    expect(fixture.bindings.calls.filter((call) => call.runtimeId === codex.id)).toHaveLength(2);
    expect(fixture.bindings.calls.filter((call) => call.runtimeId === hermes.id)).toHaveLength(1);
    expect(fixture.bindings.calls.filter((call) => call.runtimeId === opencode.id)).toHaveLength(1);
    expect(fixture.bindings.calls[3]!.authorization.idempotencyKey)
      .not.toBe(fixture.bindings.calls[1]!.authorization.idempotencyKey);
    expect(fixture.service.snapshot()).toMatchObject({
      state: 'partial',
      results: expect.arrayContaining([
        expect.objectContaining({ candidateId: byProvider.get('codex')!.candidateId, status: 'bound' }),
        expect.objectContaining({
          candidateId: byProvider.get('hermes')!.candidateId,
          status: 'failed',
          errorCode: 'registration_rejected',
          retryable: false,
        }),
      ]),
    });
  });

  it('stays alive after partial, consumes a server retry request once, and acknowledges it', async () => {
    const codex = runtime('codex');
    const fixture = harness([codex]);
    fixture.bindings.outcomes.set(codex.id, [
      { runtimeId: codex.id, ok: false, errorCode: 'registration_transport' },
      { runtimeId: codex.id, ok: false, errorCode: 'registration_transport' },
      { runtimeId: codex.id, ok: true, binding: binding(codex) },
    ]);
    await fixture.service.start();
    const candidateId = fixture.client.createCalls[0]!.candidates[0]!.candidateId;
    fixture.client.selections[0]!.resolve(selected(fixture.client, [candidateId]));
    await fixture.service.waitForTerminal();
    await vi.waitFor(() => expect(fixture.client.retryPolls).toHaveLength(1));

    fixture.client.retryPolls[0]!.resolve({
      requestId: 'retry-request-0001',
      candidateIds: [candidateId],
    });
    await vi.waitFor(() => expect(fixture.client.retryAckCalls).toHaveLength(1));
    expect(fixture.service.snapshot().state).toBe('partial');
    await vi.waitFor(() => expect(fixture.client.retryPolls).toHaveLength(2));

    fixture.client.retryPolls[1]!.resolve({
      requestId: 'retry-request-0001',
      candidateIds: [candidateId],
    });
    await vi.waitFor(() => expect(fixture.client.retryAckCalls).toHaveLength(2));
    expect(fixture.bindings.calls).toHaveLength(2);
    await vi.waitFor(() => expect(fixture.client.retryPolls).toHaveLength(3));

    fixture.client.retryPolls[2]!.resolve({
      requestId: 'retry-request-0002',
      candidateIds: [candidateId],
    });
    await vi.waitFor(() => expect(fixture.client.retryAckCalls).toHaveLength(3));
    expect(fixture.bindings.calls).toHaveLength(3);
    expect(fixture.service.snapshot().state).toBe('completed');
    expect(new Set(fixture.client.retryAckCalls.map((call) => call.idempotencyKey)).size).toBe(2);
  });

  it('retries a transient ACK after registration completes without registering twice', async () => {
    const codex = runtime('codex');
    const sleep = vi.fn(async () => undefined);
    const fixture = harness([codex], { sleep });
    fixture.bindings.outcomes.set(codex.id, [
      { runtimeId: codex.id, ok: false, errorCode: 'registration_transport' },
      { runtimeId: codex.id, ok: true, binding: binding(codex) },
    ]);
    fixture.client.retryAckFailures.push(
      new PairingClientError('pairing_transport', 'transport', true),
    );
    await fixture.service.start();
    const candidateId = fixture.client.createCalls[0]!.candidates[0]!.candidateId;
    fixture.client.selections[0]!.resolve(selected(fixture.client, [candidateId]));
    await fixture.service.waitForTerminal();
    await vi.waitFor(() => expect(fixture.client.retryPolls).toHaveLength(1));

    fixture.client.retryPolls[0]!.resolve({
      requestId: 'retry-request-ack-0001',
      candidateIds: [candidateId],
    });

    await vi.waitFor(() => expect(fixture.client.retryAckCalls).toHaveLength(2));
    expect(fixture.service.snapshot().state).toBe('completed');
    expect(fixture.bindings.calls).toHaveLength(2);
    expect(fixture.client.retryAckCalls[1]).toEqual(fixture.client.retryAckCalls[0]);
    expect(sleep).toHaveBeenCalledWith(5_000, expect.any(AbortSignal));
  });

  it('stops a permanently retryable completed ACK at exact expiry without leaking timers', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const codex = runtime('codex');
    const client = new FakePairingClient();
    const ackSleeps: AbortSignal[] = [];
    client.retryAckImplementation = async () => {
      throw new PairingClientError('pairing_transport', 'transport', true);
    };
    const fixture = harness([codex], {
      client,
      now: () => Date.now(),
      sleep: async (_milliseconds, signal) => new Promise<void>((_resolve, reject) => {
        ackSleeps.push(signal);
        signal.addEventListener('abort', () => {
          reject(new PairingClientError('pairing_cancelled', 'transport', false));
        }, { once: true });
      }),
    });
    fixture.bindings.outcomes.set(codex.id, [
      { runtimeId: codex.id, ok: false, errorCode: 'registration_transport' },
      { runtimeId: codex.id, ok: true, binding: binding(codex) },
    ]);
    await fixture.service.start();
    const candidateId = fixture.client.createCalls[0]!.candidates[0]!.candidateId;
    fixture.client.selections[0]!.resolve(selected(fixture.client, [candidateId]));
    await fixture.service.waitForTerminal();
    expect(fixture.client.retryPolls).toHaveLength(1);
    fixture.client.retryPolls[0]!.resolve({
      requestId: 'retry-request-expiry-0001',
      candidateIds: [candidateId],
    });
    await flushAsyncWork();
    expect(fixture.client.retryAckCalls).toHaveLength(1);
    expect(ackSleeps).toHaveLength(1);
    await fixture.service.waitForTerminal();

    await vi.advanceTimersByTimeAsync(Date.parse(EXPIRES_AT) - NOW);
    await flushAsyncWork();
    expect(vi.getTimerCount()).toBe(0);

    expect(fixture.service.snapshot().state).toBe('completed');
    expect(ackSleeps[0]!.aborted).toBe(true);
    expect(fixture.client.retryAckCalls).toHaveLength(1);
    expect(fixture.bindings.calls).toHaveLength(2);
    expect(new Set(fixture.client.retryAckCalls.map((call) => call.idempotencyKey)).size).toBe(1);
  });

  it('locally cancels a completed ACK lifecycle without reverting completed registration', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const codex = runtime('codex');
    const client = new FakePairingClient();
    const ackSleeps: AbortSignal[] = [];
    client.retryAckImplementation = async () => {
      throw new PairingClientError('pairing_transport', 'transport', true);
    };
    const fixture = harness([codex], {
      client,
      now: () => Date.now(),
      sleep: async (_milliseconds, signal) => new Promise<void>((_resolve, reject) => {
        ackSleeps.push(signal);
        signal.addEventListener('abort', () => {
          reject(new PairingClientError('pairing_cancelled', 'transport', false));
        }, { once: true });
      }),
    });
    fixture.bindings.outcomes.set(codex.id, [
      { runtimeId: codex.id, ok: false, errorCode: 'registration_transport' },
      { runtimeId: codex.id, ok: true, binding: binding(codex) },
    ]);
    await fixture.service.start();
    const candidateId = fixture.client.createCalls[0]!.candidates[0]!.candidateId;
    fixture.client.selections[0]!.resolve(selected(fixture.client, [candidateId]));
    await fixture.service.waitForTerminal();
    expect(fixture.client.retryPolls).toHaveLength(1);
    fixture.client.retryPolls[0]!.resolve({
      requestId: 'retry-request-cancel-0001',
      candidateIds: [candidateId],
    });
    await flushAsyncWork();
    expect(fixture.client.retryAckCalls).toHaveLength(1);
    expect(ackSleeps).toHaveLength(1);

    await fixture.service.cancel();

    expect(fixture.service.snapshot().state).toBe('completed');
    expect(ackSleeps[0]!.aborted).toBe(true);
    expect(fixture.client.retryAckCalls).toHaveLength(1);
    expect(fixture.client.cancelCalls).toHaveLength(0);
    expect(fixture.bindings.calls).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('paces empty retry polls and exponentially backs off retryable poll failures', async () => {
    const codex = runtime('codex');
    const sleep = vi.fn(async () => undefined);
    const fixture = harness([codex], { sleep });
    fixture.bindings.outcomes.set(codex.id, [
      { runtimeId: codex.id, ok: false, errorCode: 'registration_transport' },
    ]);
    await fixture.service.start();
    const candidateId = fixture.client.createCalls[0]!.candidates[0]!.candidateId;
    fixture.client.selections[0]!.resolve(selected(fixture.client, [candidateId]));
    await fixture.service.waitForTerminal();
    await vi.waitFor(() => expect(fixture.client.retryPolls).toHaveLength(1));

    fixture.client.retryPolls[0]!.resolve(null);
    await vi.waitFor(() => expect(fixture.client.retryPolls).toHaveLength(2));
    expect(sleep).toHaveBeenCalledWith(2_500, expect.any(AbortSignal));

    fixture.client.retryPolls[1]!.reject(
      new PairingClientError('pairing_rate_limited', 'transport', true),
    );
    await vi.waitFor(() => expect(fixture.client.retryPolls).toHaveLength(3));
    expect(sleep).toHaveBeenCalledWith(5_000, expect.any(AbortSignal));

    fixture.client.retryPolls[2]!.reject(
      new PairingClientError('pairing_rate_limited', 'transport', true),
    );
    await vi.waitFor(() => expect(fixture.client.retryPolls).toHaveLength(4));
    expect(sleep).toHaveBeenCalledWith(10_000, expect.any(AbortSignal));
    await fixture.service.cancel();
  });

  it.each([
    ['pairing_cancelled', 'cancelled'],
    ['pairing_expired', 'expired'],
  ] as const)('maps remote %s retry termination to %s state', async (code, state) => {
    const codex = runtime('codex');
    const fixture = harness([codex]);
    fixture.bindings.outcomes.set(codex.id, [
      { runtimeId: codex.id, ok: false, errorCode: 'registration_transport' },
    ]);
    await fixture.service.start();
    const candidateId = fixture.client.createCalls[0]!.candidates[0]!.candidateId;
    fixture.client.selections[0]!.resolve(selected(fixture.client, [candidateId]));
    await fixture.service.waitForTerminal();
    await vi.waitFor(() => expect(fixture.client.retryPolls).toHaveLength(1));

    fixture.client.retryPolls[0]!.reject(new PairingClientError(code, 'pairing', false));

    await vi.waitFor(() => expect(fixture.service.snapshot().state).toBe(state));
  });

  it('acknowledges unknown and non-retryable candidates without registering them', async () => {
    const codex = runtime('codex');
    const fixture = harness([codex]);
    fixture.bindings.outcomes.set(codex.id, [
      { runtimeId: codex.id, ok: false, errorCode: 'registration_rejected' },
    ]);
    await fixture.service.start();
    const candidateId = fixture.client.createCalls[0]!.candidates[0]!.candidateId;
    fixture.client.selections[0]!.resolve(selected(fixture.client, [candidateId]));
    await fixture.service.waitForTerminal();
    await vi.waitFor(() => expect(fixture.client.retryPolls).toHaveLength(1));

    fixture.client.retryPolls[0]!.resolve({
      requestId: 'retry-request-invalid-0001',
      candidateIds: [candidateId, 'unknown-candidate'],
    });
    await vi.waitFor(() => expect(fixture.client.retryAckCalls).toHaveLength(1));

    expect(fixture.bindings.calls).toHaveLength(1);
    expect(fixture.service.snapshot().state).toBe('partial');
    await fixture.service.cancel();
    expect(fixture.client.retryPollCalls.at(-1)!.signal?.aborted).toBe(true);
  });

  it('records a disappeared selected runtime as runtime_unavailable without registration transport', async () => {
    const codex = runtime('codex');
    const fixture = harness([codex]);
    fixture.bindings.outcomes.set(codex.id, [
      { runtimeId: codex.id, ok: false, errorCode: 'runtime_unavailable' },
      { runtimeId: codex.id, ok: true, binding: binding(codex) },
    ]);
    await fixture.service.start();
    const candidateId = fixture.client.createCalls[0]!.candidates[0]!.candidateId;

    fixture.client.selections[0]!.resolve(selected(fixture.client, [candidateId]));
    await fixture.service.waitForTerminal();

    expect(fixture.service.snapshot()).toMatchObject({
      state: 'partial',
      results: [{ candidateId, status: 'failed', errorCode: 'runtime_unavailable', retryable: true }],
    });

    await fixture.service.retryFailed([candidateId]);
    await fixture.service.waitForTerminal();
    expect(fixture.bindings.calls).toHaveLength(2);
    expect(fixture.service.snapshot()).toMatchObject({
      state: 'completed',
      results: [{ candidateId, status: 'bound', retryable: false }],
    });
  });

  it('aborts polling and prevents registration after cancellation', async () => {
    const fixture = harness([runtime('codex')]);
    await fixture.service.start();
    const pollSignal = fixture.client.pollCalls[0]!.signal!;

    await fixture.service.cancel();
    await fixture.service.waitForTerminal();

    expect(pollSignal.aborted).toBe(true);
    expect(fixture.client.cancelCalls).toHaveLength(1);
    expect(fixture.bindings.calls).toEqual([]);
    expect(fixture.service.snapshot().state).toBe('cancelled');
  });

  it('expires locally before registering a late selection', async () => {
    let now = NOW;
    const client = new FakePairingClient();
    const bindings = new FakeBindings();
    const source = new FakeRuntimeSource([runtime('codex')]);
    const service = new PairingService({
      client,
      bindings,
      runtimeSource: source,
      installAbuseKey: INSTALL_ABUSE_KEY,
      now: () => now,
      randomBytes: (size: number) => Buffer.alloc(size, 7),
      sleep: async () => undefined,
    });
    await service.start();
    const candidateId = client.createCalls[0]!.candidates[0]!.candidateId;
    now = Date.parse(EXPIRES_AT);

    client.selections[0]!.resolve(selected(client, [candidateId]));
    await service.waitForTerminal();

    expect(bindings.calls).toEqual([]);
    expect(service.snapshot().state).toBe('expired');
  });

  it('aborts an unanswered poll when the session deadline elapses', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const client = new FakePairingClient();
    const bindings = new FakeBindings();
    const service = new PairingService({
      client,
      bindings,
      runtimeSource: new FakeRuntimeSource([runtime('codex')]),
      installAbuseKey: INSTALL_ABUSE_KEY,
      randomBytes: (size: number) => Buffer.alloc(size, 8),
    });
    await service.start();
    const pollSignal = client.pollCalls[0]!.signal!;

    await vi.advanceTimersByTimeAsync(Date.parse(EXPIRES_AT) - NOW);
    await service.waitForTerminal();

    expect(pollSignal.aborted).toBe(true);
    expect(bindings.calls).toEqual([]);
    expect(service.snapshot().state).toBe('expired');
  });
});
