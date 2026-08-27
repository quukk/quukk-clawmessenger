import { parseWithFallback } from '@multica/core/api/schema';
import { z } from 'zod';

import type {
  ActivityEntry,
  BindingMutationResult,
  BridgeApi,
  BridgeRuntime,
  BridgeSettings,
  DiagnosticsSnapshot,
} from './types';

const capabilitiesSchema = z
  .object({
    session_resume: z.boolean(),
    cancel: z.boolean(),
    text_events: z.boolean(),
    tool_events: z.boolean(),
    approval_events: z.boolean(),
  })
  .strict()
  .transform((value) => ({
    sessionResume: value.session_resume,
    cancel: value.cancel,
    textEvents: value.text_events,
    toolEvents: value.tool_events,
    approvalEvents: value.approval_events,
  }));

const bindingSchema = z
  .object({
    enabled: z.boolean(),
    registration_state: z.enum([
      'unregistered',
      'registering',
      'online',
      'offline',
      'error',
    ]),
    last_error_code: z.string().max(64).optional(),
  })
  .strict()
  .transform((value) => ({
    enabled: value.enabled,
    registrationState: value.registration_state,
    ...(value.last_error_code === undefined ? {} : { lastErrorCode: value.last_error_code }),
  }));

const runtimeSchema = z
  .object({
    id: z.string().max(128).optional(),
    provider: z.enum(['opencode', 'openclaw', 'codex', 'hermes']),
    version: z.string().max(256).optional(),
    path: z.string().max(4096).optional(),
    status: z.enum([
      'ready',
      'needs_auth',
      'found_not_runnable',
      'not_found',
      'probe_failed',
    ]),
    capabilities: capabilitiesSchema,
    binding: bindingSchema.optional(),
  })
  .strict();

const runtimesEnvelopeSchema = z.object({ runtimes: z.array(runtimeSchema).max(4) }).strict();

const mutationResultSchema = z
  .object({
    runtime_id: z.string().max(128),
    ok: z.boolean(),
    error_code: z.string().max(64).optional(),
  })
  .strict()
  .transform((value): BindingMutationResult =>
    value.ok
      ? { runtimeId: value.runtime_id, ok: true }
      : {
          runtimeId: value.runtime_id,
          ok: false,
          errorCode: value.error_code ?? 'invalid_response',
        },
  );

const mutationEnvelopeSchema = z.object({ results: z.array(mutationResultSchema).max(4) }).strict();
const singleMutationEnvelopeSchema = z.object({ result: mutationResultSchema }).strict();

const settingsSchema = z
  .object({
    server_url: z.string().max(4096),
    default_workdir: z.string().max(4096).nullable(),
    authorized_work_roots: z.array(z.string().max(4096)).max(32),
    provider_path_overrides: z
      .object({
        opencode: z.string().max(4096).optional(),
        openclaw: z.string().max(4096).optional(),
        codex: z.string().max(4096).optional(),
        hermes: z.string().max(4096).optional(),
      })
      .strict(),
    log_level: z.enum(['silent', 'error', 'warn', 'info', 'debug']),
  })
  .strict()
  .transform(
    (value): BridgeSettings => ({
      serverUrl: value.server_url,
      defaultWorkdir: value.default_workdir,
      authorizedWorkRoots: value.authorized_work_roots,
      providerPathOverrides: value.provider_path_overrides,
      logLevel: value.log_level,
    }),
  );

const settingsEnvelopeSchema = z.object({ settings: settingsSchema }).strict();

const activitySchema = z
  .object({
    id: z.string().max(128),
    time: z.string().max(64),
    runtime_id: z.string().max(128).optional(),
    kind: z.string().max(64),
    summary: z.string().max(512),
  })
  .strict()
  .transform(
    (value): ActivityEntry => ({
      id: value.id,
      time: value.time,
      ...(value.runtime_id === undefined ? {} : { runtimeId: value.runtime_id }),
      kind: value.kind,
      summary: value.summary,
    }),
  );

const activityEnvelopeSchema = z.object({ activity: z.array(activitySchema).max(200) }).strict();

const diagnosticsSchema = z
  .object({
    status: z.string().max(64),
    generated_at: z.string().max(64),
    version: z.string().max(128).optional(),
    runtime_count: z.number().int().nonnegative().max(4).optional(),
  })
  .loose()
  .transform(
    (value): DiagnosticsSnapshot => ({
      ...value,
      generatedAt: value.generated_at,
      generated_at: undefined,
      ...(value.runtime_count === undefined ? {} : { runtimeCount: value.runtime_count }),
      runtime_count: undefined,
    }),
  );

const exchangeSchema = z.object({ csrf_token: z.string().min(32).max(256) }).strict();

type BrowserPorts = {
  fetch: typeof globalThis.fetch;
  href: string;
  replaceUrl(url: string): void;
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
  const ticket = url.searchParams.get('ticket') ?? undefined;
  if (ticket === undefined) return undefined;
  url.searchParams.delete('ticket');
  ports.replaceUrl(`${url.pathname}${url.search}${url.hash}`);
  return ticket;
}

function wireSettings(settings: BridgeSettings) {
  return {
    server_url: settings.serverUrl,
    default_workdir: settings.defaultWorkdir,
    authorized_work_roots: settings.authorizedWorkRoots,
    provider_path_overrides: settings.providerPathOverrides,
    log_level: settings.logLevel,
  };
}

export function createBridgeApi(ports: BrowserPorts = browserPorts()): BridgeApi {
  const ticket = scrubTicket(ports);
  let csrfToken = '';

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
          csrfToken = parsed.data.csrf_token;
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
        ...(mutating ? { 'X-CSRF-Token': csrfToken } : {}),
        ...init.headers,
      },
    });
    const data: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const code = z
        .object({ error: z.string().max(64) })
        .safeParse(data);
      throw new BridgeApiError(code.success ? code.data.error : 'request_failed');
    }
    return data;
  }

  return {
    async getRuntimes() {
      const data = await request('/api/runtimes');
      return parseWithFallback(data, runtimesEnvelopeSchema, { runtimes: [] as BridgeRuntime[] }, {
        endpoint: 'bridge.runtimes',
      }).runtimes;
    },
    async rescanRuntimes() {
      const data = await request('/api/runtimes/rescan', { method: 'POST', body: '{}' });
      return parseWithFallback(data, runtimesEnvelopeSchema, { runtimes: [] as BridgeRuntime[] }, {
        endpoint: 'bridge.runtimes.rescan',
      }).runtimes;
    },
    async enableBindings(runtimeIds) {
      const data = await request('/api/bindings/enable', {
        method: 'POST',
        body: JSON.stringify({ runtime_ids: runtimeIds }),
      });
      return parseWithFallback(
        data,
        mutationEnvelopeSchema,
        {
          results: runtimeIds.map(
            (runtimeId): BindingMutationResult => ({
              runtimeId,
              ok: false,
              errorCode: 'invalid_response',
            }),
          ),
        },
        { endpoint: 'bridge.bindings.enable' },
      ).results;
    },
    async disableBinding(runtimeId) {
      await request(`/api/bindings/${encodeURIComponent(runtimeId)}/disable`, {
        method: 'POST',
        body: '{}',
      });
    },
    async reregisterBinding(runtimeId) {
      const data = await request(`/api/bindings/${encodeURIComponent(runtimeId)}/reregister`, {
        method: 'POST',
        body: '{}',
      });
      return parseWithFallback(
        data,
        singleMutationEnvelopeSchema,
        {
          result: {
            runtimeId,
            ok: false,
            errorCode: 'invalid_response',
          } as BindingMutationResult,
        },
        { endpoint: 'bridge.bindings.reregister' },
      ).result;
    },
    async getActivity() {
      const data = await request('/api/activity');
      return parseWithFallback(data, activityEnvelopeSchema, { activity: [] as ActivityEntry[] }, {
        endpoint: 'bridge.activity',
      }).activity;
    },
    async getDiagnostics() {
      const data = await request('/api/diagnostics');
      return parseWithFallback(
        data,
        diagnosticsSchema,
        { status: 'unavailable', generatedAt: '' } satisfies DiagnosticsSnapshot,
        { endpoint: 'bridge.diagnostics' },
      );
    },
    async getSettings() {
      const data = await request('/api/settings');
      return parseWithFallback(
        data,
        settingsEnvelopeSchema,
        {
          settings: {
            serverUrl: '',
            defaultWorkdir: null,
            authorizedWorkRoots: [],
            providerPathOverrides: {},
            logLevel: 'info',
          } satisfies BridgeSettings,
        },
        { endpoint: 'bridge.settings' },
      ).settings;
    },
    async updateSettings(settings) {
      const data = await request('/api/settings', {
        method: 'PUT',
        body: JSON.stringify(wireSettings(settings)),
      });
      return parseWithFallback(data, settingsEnvelopeSchema, { settings }, {
        endpoint: 'bridge.settings.update',
      }).settings;
    },
  };
}

export function createBridgeApiProvider(factory: () => BridgeApi): () => BridgeApi {
  let api: BridgeApi | undefined;
  return () => (api ??= factory());
}

export const getBrowserBridgeApi = createBridgeApiProvider(() => createBridgeApi());
