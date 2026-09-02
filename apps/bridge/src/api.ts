import { z } from 'zod';

import type {
  ActivityEntry,
  BindingMutationResult,
  BridgeApi,
  BridgeRuntime,
  BridgeSettings,
  DiagnosticsSnapshot,
  PairingCandidate,
  PairingSnapshot,
} from './types';

const providerSchema = z.enum(['opencode', 'openclaw', 'codex', 'hermes']);
const providerOrder = providerSchema.options;
const runtimeIdSchema = z.string().regex(/^rt_[0-9a-f]{32}$/);
const safeCodeSchema = z.string().regex(/^[a-z0-9_]+$/).max(64);
const capabilitiesSchema = z
  .object({
    sessionResume: z.boolean(),
    cancel: z.boolean(),
    textEvents: z.boolean(),
    toolEvents: z.boolean(),
    approvalEvents: z.literal(false),
  })
  .strict();

const safeBindingSchema = z
  .object({
    runtimeId: runtimeIdSchema,
    nodeId: z.string().min(1).max(137),
    nodeName: z.string().min(1).max(128),
    enabled: z.boolean(),
    registrationState: z.enum([
      'unregistered',
      'registering',
      'online',
      'offline',
      'error',
    ]),
    lastErrorCode: safeCodeSchema.optional(),
    updatedAt: z.string().min(1).max(64),
  })
  .strict();

const workerSchema = z
  .object({
    state: z.enum(['starting', 'online', 'offline', 'backoff', 'stopped']),
    restartCount: z.number().int().nonnegative(),
  })
  .strict();

const runtimeSchema = z
  .object({
    provider: providerSchema,
    runtimeId: runtimeIdSchema.nullable(),
    version: z.string().min(1).max(256).nullable(),
    path: z.string().min(1).max(4096).nullable(),
    status: z.enum([
      'ready',
      'needs_auth',
      'found_not_runnable',
      'not_found',
      'probe_failed',
    ]),
    capabilities: capabilitiesSchema,
    binding: safeBindingSchema.nullable(),
    worker: workerSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.runtimeId === null) {
      if (value.binding !== null) context.addIssue({ code: 'custom', path: ['binding'] });
      if (value.worker !== null) context.addIssue({ code: 'custom', path: ['worker'] });
    } else if (value.binding !== null && value.binding.runtimeId !== value.runtimeId) {
      context.addIssue({ code: 'custom', path: ['binding', 'runtimeId'] });
    }
  })
  .transform(
    (value): BridgeRuntime => ({
      provider: value.provider,
      ...(value.runtimeId === null ? {} : { id: value.runtimeId }),
      ...(value.version === null ? {} : { version: value.version }),
      ...(value.path === null ? {} : { path: value.path }),
      status: value.status,
      capabilities: value.capabilities,
      ...(value.binding === null
        ? {}
        : {
            binding: {
              enabled: value.binding.enabled,
              registrationState: value.binding.registrationState,
              ...(value.binding.lastErrorCode === undefined
                ? {}
                : { lastErrorCode: value.binding.lastErrorCode }),
            },
          }),
      ...(value.worker === null ? {} : { worker: value.worker }),
    }),
  );

const runtimesEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    runtimes: z.array(runtimeSchema).length(providerOrder.length),
  })
  .strict()
  .superRefine((value, context) => {
    value.runtimes.forEach((runtime, index) => {
      if (runtime.provider !== providerOrder[index]) {
        context.addIssue({ code: 'custom', path: ['runtimes', index, 'provider'] });
      }
    });
  });

const apiErrorSchema = z
  .object({
    code: safeCodeSchema,
    category: z.enum([
      'detection',
      'authentication',
      'registration',
      'transport',
      'runtime',
      'policy',
    ]),
    retryable: z.boolean(),
  })
  .strict();

const mutationResultSchema = z
  .discriminatedUnion('ok', [
    z
      .object({ runtimeId: runtimeIdSchema, ok: z.literal(true), binding: safeBindingSchema })
      .strict(),
    z
      .object({ runtimeId: runtimeIdSchema, ok: z.literal(false), error: apiErrorSchema })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (value.ok && value.binding.runtimeId !== value.runtimeId) {
      context.addIssue({ code: 'custom', path: ['binding', 'runtimeId'] });
    }
  });

const mutationEnvelopeSchema = z
  .object({ schemaVersion: z.literal(1), results: z.array(mutationResultSchema).min(1).max(4) })
  .strict();
const singleBindingEnvelopeSchema = z
  .object({ schemaVersion: z.literal(1), binding: safeBindingSchema })
  .strict();

const providerPathOverridesSchema = z
  .object({
    opencode: z.string().min(1).max(4096).optional(),
    openclaw: z.string().min(1).max(4096).optional(),
    codex: z.string().min(1).max(4096).optional(),
    hermes: z.string().min(1).max(4096).optional(),
  })
  .strict();

const storedConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    serverUrl: z.string().min(1).max(4096),
    defaultWorkdir: z.string().min(1).max(4096).nullable(),
    authorizedWorkRoots: z.array(z.string().min(1).max(4096)).max(32),
    providerPathOverrides: providerPathOverridesSchema,
    logLevel: z.enum(['silent', 'error', 'warn', 'info', 'debug']),
  })
  .strict();

function viewSettings(value: z.infer<typeof storedConfigSchema>): BridgeSettings {
  return {
    serverUrl: value.serverUrl,
    defaultWorkdir: value.defaultWorkdir,
    authorizedWorkRoots: value.authorizedWorkRoots,
    providerPathOverrides: value.providerPathOverrides,
    logLevel: value.logLevel,
  };
}

const settingsEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    stored: storedConfigSchema,
    effective: storedConfigSchema,
  })
  .strict()
  .transform((value) => ({
    settings: viewSettings(value.stored),
    effectiveServerUrl: value.effective.serverUrl,
  }));

const activitySchema = z
  .object({
    id: z.number().int().positive().safe(),
    time: z.iso.datetime({ offset: true }),
    level: z.enum(['debug', 'info', 'warn', 'error']),
    event: z.string().min(1).max(128),
    runtimeId: runtimeIdSchema.optional(),
    provider: providerSchema.optional(),
    taskId: z.string().min(1).max(256).optional(),
    eventType: z
      .enum([
        'started',
        'text_delta',
        'tool_started',
        'tool_finished',
        'status',
        'completed',
        'failed',
        'cancelled',
      ])
      .optional(),
    errorCode: safeCodeSchema.optional(),
    count: z.number().int().nonnegative().safe().optional(),
    durationMs: z.number().int().nonnegative().safe().optional(),
  })
  .strict()
  .transform(
    (value): ActivityEntry => ({
      id: value.id,
      time: value.time,
      ...(value.runtimeId === undefined ? {} : { runtimeId: value.runtimeId }),
      kind: value.level,
      summary: value.event,
    }),
  );

const activityEnvelopeSchema = z
  .object({ schemaVersion: z.literal(1), events: z.array(activitySchema).max(100) })
  .strict()
  .superRefine((value, context) => {
    for (let index = 1; index < value.events.length; index += 1) {
      if (value.events[index - 1]!.id >= value.events[index]!.id) {
        context.addIssue({ code: 'custom', path: ['events', index, 'id'] });
      }
    }
  })
  .transform((value) => ({ activity: value.events }));

const diagnosticsSchema = z
  .object({
    schemaVersion: z.literal(1),
    service: z
      .object({
        version: z.string().max(128),
        state: z.enum(['starting', 'ready', 'stopping']),
        pid: z.number().int().nonnegative(),
        startedAt: z.string().max(64),
        listenHost: z.literal('127.0.0.1'),
        port: z.number().int().min(1).max(65_535).nullable(),
        uptimeMs: z.number().int().nonnegative(),
      })
      .strict(),
    bridge: z
      .object({
        state: z.enum(['ready', 'unavailable']),
        pid: z.number().int().positive().optional(),
        version: z.string().max(128).optional(),
        startedAt: z.string().max(64).optional(),
        probeStatus: z.enum(['ready', 'refreshing']).optional(),
        errorCode: safeCodeSchema.optional(),
      })
      .strict(),
    runtimes: z
      .array(
        z
          .object({
            provider: providerSchema,
            status: z.enum([
              'ready',
              'needs_auth',
              'found_not_runnable',
              'not_found',
              'probe_failed',
            ]),
            version: z.string().max(256).optional(),
            executableName: z.string().max(256).optional(),
          })
          .strict(),
      )
      .max(4),
    workers: z
      .array(
        z
          .object({
            runtimeId: runtimeIdSchema,
            state: z.enum(['starting', 'online', 'offline', 'backoff', 'stopped']),
            restartCount: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(4),
    warnings: z.array(z.string().min(1).max(256)).max(64),
    logging: z
      .object({
        dropped: z.number().int().nonnegative(),
        retained: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

const pairingCandidateIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const pairingTextSchema = (maximum: number) =>
  z.string().min(1).max(maximum).refine((value) => value === value.trim());
const pairingVersionSchema = z
  .string()
  .max(24)
  .regex(/^v?(?:0|[1-9]\d{0,4})(?:\.(?:0|[1-9]\d{0,4})){0,3}$/);
const pairingStatusReasonSchema = z.enum([
  'needs_auth',
  'found_not_runnable',
  'not_found',
  'probe_failed',
  'provider_conflict',
]);
const pairingCandidateSchema = z
  .object({
    candidateId: pairingCandidateIdSchema,
    provider: providerSchema,
    displayName: pairingTextSchema(80),
    version: pairingTextSchema(64).nullable(),
    readiness: z.enum(['ready', 'not_ready', 'already_registered']),
    statusReason: pairingTextSchema(80).nullable(),
    registrationState: z.enum(['unregistered', 'registered']),
  })
  .strict()
  .transform(
    (value): PairingCandidate => ({
      candidateId: value.candidateId,
      provider: value.provider,
      version:
        value.version !== null && pairingVersionSchema.safeParse(value.version).success
          ? value.version
          : null,
      readiness: value.readiness,
      statusReason:
        value.statusReason === null
          ? null
          : (pairingStatusReasonSchema.safeParse(value.statusReason).data ?? null),
      registrationState: value.registrationState,
    }),
  );
const pairingResultSchema = z
  .object({
    candidateId: pairingCandidateIdSchema,
    status: z.enum(['pending', 'registering', 'bound', 'already_bound', 'failed']),
    errorCode: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).nullable(),
    nodeId: pairingTextSchema(137).nullable(),
    retryable: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === 'failed' && value.errorCode === null) {
      context.addIssue({ code: 'custom', path: ['errorCode'] });
    }
    if (value.status !== 'failed' && value.errorCode !== null) {
      context.addIssue({ code: 'custom', path: ['errorCode'] });
    }
    if ((value.status === 'bound' || value.status === 'already_bound') && value.nodeId === null) {
      context.addIssue({ code: 'custom', path: ['nodeId'] });
    }
  });
function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (host === 'localhost' || host === '::1') return true;
  const octets = host.split('.');
  return (
    octets.length === 4 &&
    octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255) &&
    octets[0] === '127'
  );
}

function normalizePairingServer(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const protocolAllowed =
    url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url.hostname));
  if (
    !protocolAllowed ||
    value !== value.trim() ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    return undefined;
  }
  return url.toString().replace(/\/+$/, '');
}

const pairingServerSchema = z
  .string()
  .min(1)
  .max(4096)
  .transform((value, context) => {
    const normalized = normalizePairingServer(value);
    if (normalized === undefined) {
      context.addIssue({ code: 'custom' });
      return z.NEVER;
    }
    return normalized;
  });

const pairingQrSchema = z
  .object({
    type: z.literal('clawmessenger_pairing'),
    version: z.literal(1),
    server: pairingServerSchema,
    ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    expiresAt: z.number().int().positive().finite(),
  })
  .strict();

const pairingEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    state: z.enum([
      'idle',
      'waiting',
      'claimed',
      'processing',
      'completed',
      'partial',
      'cancelled',
      'expired',
    ]),
    expiresAt: z.iso.datetime({ offset: true }).nullable(),
    qrContent: z.string().min(1).max(8 << 10).nullable(),
    candidates: z.array(pairingCandidateSchema).max(16),
    results: z.array(pairingResultSchema).max(16),
  })
  .strict()
  .superRefine((value, context) => {
    const candidateIds = new Set<string>();
    value.candidates.forEach((candidate, index) => {
      if (candidateIds.has(candidate.candidateId)) {
        context.addIssue({ code: 'custom', path: ['candidates', index, 'candidateId'] });
      }
      candidateIds.add(candidate.candidateId);
    });
    const resultIds = new Set<string>();
    value.results.forEach((result, index) => {
      if (!candidateIds.has(result.candidateId) || resultIds.has(result.candidateId)) {
        context.addIssue({ code: 'custom', path: ['results', index, 'candidateId'] });
      }
      resultIds.add(result.candidateId);
    });
    if (value.state === 'idle') {
      if (
        value.expiresAt !== null ||
        value.qrContent !== null ||
        value.candidates.length !== 0 ||
        value.results.length !== 0
      ) {
        context.addIssue({ code: 'custom', path: ['state'] });
      }
      return;
    }
    if (value.state === 'waiting') {
      if (value.expiresAt === null || value.qrContent === null || value.candidates.length === 0) {
        context.addIssue({ code: 'custom', path: ['state'] });
        return;
      }
      let qr: unknown;
      try {
        qr = JSON.parse(value.qrContent);
      } catch {
        context.addIssue({ code: 'custom', path: ['qrContent'] });
        return;
      }
      const parsedQr = pairingQrSchema.safeParse(qr);
      if (!parsedQr.success || parsedQr.data.expiresAt !== Date.parse(value.expiresAt)) {
        context.addIssue({ code: 'custom', path: ['qrContent'] });
      }
    } else if (value.qrContent !== null) {
      context.addIssue({ code: 'custom', path: ['qrContent'] });
    }
  })
  .transform(
    (value): PairingSnapshot => ({
      state: value.state,
      expiresAt: value.expiresAt,
      qrContent: value.qrContent,
      candidates: value.candidates,
      results: value.results.map(({ nodeId: _nodeId, ...result }) => result),
    }),
  );

function parsePairingEnvelope(
  data: unknown,
  expectedServerUrl: string | undefined,
  now: () => number,
): PairingSnapshot | undefined {
  const parsed = pairingEnvelopeSchema.safeParse(data);
  if (!parsed.success) return undefined;
  if (parsed.data.state !== 'waiting') return parsed.data;
  const qr = pairingQrSchema.safeParse(JSON.parse(parsed.data.qrContent!));
  if (
    !qr.success ||
    qr.data.server !== expectedServerUrl ||
    qr.data.expiresAt <= now()
  ) {
    return undefined;
  }
  return parsed.data;
}

const base64UrlTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const exchangeSchema = z
  .object({
    schemaVersion: z.literal(1),
    csrfToken: base64UrlTokenSchema,
    expiresInMs: z.literal(28_800_000),
  })
  .strict();

function parseSafely<T>(data: unknown, schema: z.ZodType, fallback: T): T {
  const parsed = schema.safeParse(data);
  return parsed.success ? (parsed.data as T) : fallback;
}

type BrowserPorts = {
  fetch: typeof globalThis.fetch;
  href: string;
  replaceUrl(url: string): void;
};

type BridgeApiOptions = {
  now?: () => number;
};

export class BridgeApiError extends Error {
  constructor(
    readonly code: string,
    message = 'The local bridge request failed.',
  ) {
    super(message);
    this.name = 'BridgeApiError';
  }
}

function browserPorts(): BrowserPorts {
  return {
    fetch: globalThis.fetch.bind(globalThis),
    href: window.location.href,
    replaceUrl: (url) => window.history.replaceState(null, '', url),
  };
}

function scrubTicket(ports: BrowserPorts): string | undefined {
  const url = new URL(ports.href);
  if (url.hash.length === 0) return undefined;

  const match = /^#ticket=([A-Za-z0-9_-]{43})$/.exec(url.hash);
  ports.replaceUrl(url.pathname);
  return match?.[1];
}

function wireSettings(settings: BridgeSettings) {
  return {
    schemaVersion: 1 as const,
    serverUrl: settings.serverUrl,
    defaultWorkdir: settings.defaultWorkdir,
    authorizedWorkRoots: settings.authorizedWorkRoots,
    providerPathOverrides: settings.providerPathOverrides,
    logLevel: settings.logLevel,
  };
}

export function createBridgeApi(
  ports: BrowserPorts = browserPorts(),
  options: BridgeApiOptions = {},
): BridgeApi {
  const ticket = scrubTicket(ports);
  const now = options.now ?? Date.now;
  let csrfToken = '';
  let configuredPairingServer: string | undefined;

  const sessionReady = ticket
    ? ports
        .fetch('/api/session/exchange', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ ticket }),
        })
        .then(async (response) => {
          const data: unknown = await response.json().catch(() => undefined);
          const parsed = exchangeSchema.safeParse(data);
          if (!response.ok || !parsed.success) throw new BridgeApiError('session_exchange_failed');
          csrfToken = parsed.data.csrfToken;
        })
    : Promise.resolve();

  async function request(path: string, init: RequestInit = {}): Promise<unknown> {
    await sessionReady;
    const method = init.method ?? 'GET';
    const mutating = method !== 'GET' && method !== 'HEAD';
    if (mutating && csrfToken.length === 0) throw new BridgeApiError('session_required');
    const response = await ports.fetch(path, {
      ...init,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(mutating ? { 'X-Quukk-CSRF': csrfToken } : {}),
        ...init.headers,
      },
    });
    const data: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const error = z.object({ error: apiErrorSchema }).strict().safeParse(data);
      throw new BridgeApiError(error.success ? error.data.error.code : 'request_failed');
    }
    return data;
  }

  return {
    async getRuntimes() {
      const data = await request('/api/runtimes');
      return parseSafely(
        data,
        runtimesEnvelopeSchema,
        { runtimes: [] as BridgeRuntime[] },
      ).runtimes;
    },
    async rescanRuntimes() {
      const data = await request('/api/runtimes/rescan', { method: 'POST' });
      return parseSafely(
        data,
        runtimesEnvelopeSchema,
        { runtimes: [] as BridgeRuntime[] },
      ).runtimes;
    },
    async enableBindings(runtimeIds) {
      const data = await request('/api/bindings/enable', {
        method: 'POST',
        body: JSON.stringify({ runtimeIds }),
      });
      const invalid = () =>
        runtimeIds.map(
          (runtimeId): BindingMutationResult => ({
            runtimeId,
            ok: false,
            errorCode: 'invalid_response',
          }),
        );
      const parsed = mutationEnvelopeSchema.safeParse(data);
      if (!parsed.success) return invalid();
      const expected = new Set(runtimeIds);
      const received = new Set(parsed.data.results.map((result) => result.runtimeId));
      if (
        expected.size !== runtimeIds.length ||
        received.size !== parsed.data.results.length ||
        parsed.data.results.length !== runtimeIds.length ||
        parsed.data.results.some((result) => !expected.has(result.runtimeId))
      ) {
        return invalid();
      }
      return parsed.data.results.map(
        (result): BindingMutationResult =>
          result.ok
            ? { runtimeId: result.runtimeId, ok: true }
            : { runtimeId: result.runtimeId, ok: false, errorCode: result.error.code },
      );
    },
    async disableBinding(runtimeId) {
      const data = await request(`/api/bindings/${encodeURIComponent(runtimeId)}/disable`, {
        method: 'POST',
      });
      const parsed = singleBindingEnvelopeSchema.safeParse(data);
      if (!parsed.success || parsed.data.binding.runtimeId !== runtimeId) {
        throw new BridgeApiError('invalid_response');
      }
    },
    async reregisterBinding(runtimeId) {
      const data = await request(`/api/bindings/${encodeURIComponent(runtimeId)}/reregister`, {
        method: 'POST',
      });
      const parsed = singleBindingEnvelopeSchema.safeParse(data);
      if (!parsed.success || parsed.data.binding.runtimeId !== runtimeId) {
        throw new BridgeApiError('invalid_response');
      }
      return { runtimeId, ok: true };
    },
    async getActivity() {
      const data = await request('/api/activity');
      return parseSafely(
        data,
        activityEnvelopeSchema,
        { activity: [] as ActivityEntry[] },
      ).activity;
    },
    async getDiagnostics() {
      const data = await request('/api/diagnostics');
      return parseSafely(
        data,
        diagnosticsSchema,
        {
          schemaVersion: 1,
          service: {
            version: '',
            state: 'starting',
            pid: 0,
            startedAt: '',
            listenHost: '127.0.0.1',
            port: null,
            uptimeMs: 0,
          },
          bridge: { state: 'unavailable', errorCode: 'invalid_response' },
          runtimes: [],
          workers: [],
          warnings: ['diagnostics_unavailable'],
          logging: { dropped: 0, retained: 0 },
        } satisfies DiagnosticsSnapshot,
      );
    },
    async getSettings() {
      const data = await request('/api/settings');
      const parsed = settingsEnvelopeSchema.safeParse(data);
      if (!parsed.success) {
        return {
          serverUrl: '',
          defaultWorkdir: null,
          authorizedWorkRoots: [],
          providerPathOverrides: {},
          logLevel: 'info',
        } satisfies BridgeSettings;
      }
      configuredPairingServer = normalizePairingServer(parsed.data.effectiveServerUrl);
      return parsed.data.settings;
    },
    async updateSettings(settings) {
      const data = await request('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ settings: wireSettings(settings) }),
      });
      const parsed = settingsEnvelopeSchema.safeParse(data);
      if (!parsed.success) throw new BridgeApiError('invalid_response');
      configuredPairingServer = normalizePairingServer(parsed.data.effectiveServerUrl);
      if (configuredPairingServer === undefined) throw new BridgeApiError('invalid_response');
      return parsed.data.settings;
    },
    async startPairing(signal) {
      const data = await request('/api/pairing/session', { method: 'POST', signal });
      const parsed = parsePairingEnvelope(data, configuredPairingServer, now);
      if (parsed === undefined) throw new BridgeApiError('invalid_response');
      return parsed;
    },
    async getPairing(signal) {
      const data = await request('/api/pairing/session', { signal });
      const parsed = parsePairingEnvelope(data, configuredPairingServer, now);
      if (parsed === undefined) throw new BridgeApiError('invalid_response');
      return parsed;
    },
    async cancelPairing(signal) {
      const data = await request('/api/pairing/session', { method: 'DELETE', signal });
      const parsed = parsePairingEnvelope(data, configuredPairingServer, now);
      if (parsed === undefined) throw new BridgeApiError('invalid_response');
      return parsed;
    },
    async retryPairing(candidateIds, signal) {
      const data = await request('/api/pairing/session/retry', {
        method: 'POST',
        signal,
        body: JSON.stringify({ candidateIds }),
      });
      const parsed = parsePairingEnvelope(data, configuredPairingServer, now);
      if (parsed === undefined) throw new BridgeApiError('invalid_response');
      return parsed;
    },
  };
}

export function createBridgeApiProvider(factory: () => BridgeApi): () => BridgeApi {
  let api: BridgeApi | undefined;
  return () => (api ??= factory());
}

export const getBrowserBridgeApi = createBridgeApiProvider(() => createBridgeApi());
