import type { IncomingMessage, ServerResponse } from 'node:http';

import { z } from 'zod';

import {
  PROVIDERS,
  ProviderSchema,
  RUNTIME_ID_PATTERN,
  RegistrationStateSchema,
  StoredConfigSchema,
  type StoredConfig,
} from '../config/schema.js';
import { BridgeEventTypeSchema } from '../go/types.js';
import type { LocalLogger } from '../logging/logger.js';
import {
  BrowserSessionStore,
  constantTimeCredentialEqual,
  securityHeaders,
} from './security.js';
import { LaunchTicketStore } from './tickets.js';

const RESPONSE_LIMIT = 1 << 20;
const PUBLIC_BODY_LIMIT = 64 << 10;
const SMALL_BODY_LIMIT = 1 << 10;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ERROR_CODE_PATTERN = /^[a-z0-9_]{1,64}$/;

const RuntimeStatusSchema = z.enum([
  'ready', 'needs_auth', 'found_not_runnable', 'not_found', 'probe_failed',
]);
const WorkerStateSchema = z.enum(['starting', 'online', 'offline', 'backoff', 'stopped']);
const SafeBindingSchema = z.strictObject({
  runtimeId: z.string().regex(RUNTIME_ID_PATTERN),
  nodeId: z.string().min(1).max(137),
  nodeName: z.string().min(1).max(128),
  enabled: z.boolean(),
  registrationState: RegistrationStateSchema,
  lastErrorCode: z.string().regex(ERROR_CODE_PATTERN).optional(),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type SafeBindingView = z.infer<typeof SafeBindingSchema>;
export const RuntimeViewSchema = z.strictObject({
  provider: ProviderSchema,
  runtimeId: z.string().regex(RUNTIME_ID_PATTERN).nullable(),
  version: z.string().min(1).max(256).nullable(),
  path: z.string().min(1).max(4096).nullable(),
  status: RuntimeStatusSchema,
  capabilities: z.strictObject({
    sessionResume: z.boolean(),
    cancel: z.boolean(),
    textEvents: z.boolean(),
    toolEvents: z.boolean(),
    approvalEvents: z.literal(false),
  }),
  binding: SafeBindingSchema.nullable(),
  worker: z.strictObject({
    state: WorkerStateSchema,
    restartCount: z.number().int().nonnegative().safe(),
  }).nullable(),
});
export type RuntimeView = z.infer<typeof RuntimeViewSchema>;
export const RuntimesResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runtimes: z.array(RuntimeViewSchema).length(PROVIDERS.length),
}).superRefine((value, context) => {
  for (let index = 0; index < PROVIDERS.length; index += 1) {
    if (value.runtimes[index]?.provider !== PROVIDERS[index]) {
      context.addIssue({ code: 'custom', path: ['runtimes', index, 'provider'], message: 'provider_order' });
    }
  }
});
export type RuntimesResponse = z.infer<typeof RuntimesResponseSchema>;

const PublicFailureSchema = z.strictObject({
  code: z.string().regex(ERROR_CODE_PATTERN),
  category: z.enum(['detection', 'authentication', 'registration', 'transport', 'runtime', 'policy']),
  retryable: z.boolean(),
});
const EnableResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    runtimeId: z.string().regex(RUNTIME_ID_PATTERN),
    ok: z.literal(true),
    binding: SafeBindingSchema,
  }),
  z.strictObject({
    runtimeId: z.string().regex(RUNTIME_ID_PATTERN),
    ok: z.literal(false),
    error: PublicFailureSchema,
  }),
]);
export const EnableResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  results: z.array(EnableResultSchema).min(1).max(PROVIDERS.length),
});
export type EnableResponse = z.infer<typeof EnableResponseSchema>;

export const BindingMutationResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  binding: SafeBindingSchema,
});
export type BindingMutationResponse = z.infer<typeof BindingMutationResponseSchema>;

const ActivityRecordSchema = z.strictObject({
  id: z.number().int().positive().safe(),
  time: z.iso.datetime({ offset: true }),
  level: z.enum(['debug', 'info', 'warn', 'error']),
  event: z.string().min(1).max(128),
  runtimeId: z.string().regex(RUNTIME_ID_PATTERN).optional(),
  provider: ProviderSchema.optional(),
  taskId: z.string().min(1).max(256).optional(),
  eventType: BridgeEventTypeSchema.optional(),
  errorCode: z.string().regex(ERROR_CODE_PATTERN).optional(),
  count: z.number().int().nonnegative().safe().optional(),
  durationMs: z.number().int().nonnegative().safe().optional(),
});
export type ActivityRecord = z.infer<typeof ActivityRecordSchema>;
export const ActivityResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  events: z.array(ActivityRecordSchema).max(100),
}).superRefine((value, context) => {
  for (let index = 1; index < value.events.length; index += 1) {
    if (value.events[index - 1]!.id >= value.events[index]!.id) {
      context.addIssue({ code: 'custom', path: ['events', index, 'id'], message: 'activity_order' });
    }
  }
});
export type ActivityResponse = z.infer<typeof ActivityResponseSchema>;

const rfc3339 = z.iso.datetime({ offset: true });
export const DiagnosticsResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  service: z.strictObject({
    version: z.string().min(1).max(128),
    state: z.enum(['starting', 'ready', 'stopping']),
    pid: z.number().int().positive().safe(),
    startedAt: rfc3339,
    listenHost: z.literal('127.0.0.1'),
    port: z.number().int().min(1).max(65_535).nullable(),
    uptimeMs: z.number().int().nonnegative().safe(),
  }),
  bridge: z.strictObject({
    state: z.enum(['ready', 'unavailable']),
    pid: z.number().int().positive().safe().optional(),
    version: z.string().min(1).max(128).optional(),
    startedAt: rfc3339.optional(),
    probeStatus: z.enum(['ready', 'refreshing']).optional(),
    errorCode: z.string().regex(ERROR_CODE_PATTERN).optional(),
  }),
  runtimes: z.array(z.strictObject({
    provider: ProviderSchema,
    status: RuntimeStatusSchema,
    version: z.string().min(1).max(256).optional(),
    executableName: z.string().min(1).max(255).refine((value) => !/[\\/\0]/.test(value)).optional(),
  })).max(PROVIDERS.length),
  workers: z.array(z.strictObject({
    runtimeId: z.string().regex(RUNTIME_ID_PATTERN),
    state: WorkerStateSchema,
    restartCount: z.number().int().nonnegative().safe(),
  })).max(PROVIDERS.length),
  warnings: z.array(z.string().min(1).max(256)).max(64),
  logging: z.strictObject({
    dropped: z.number().int().nonnegative().safe(),
    retained: z.number().int().nonnegative().safe(),
  }),
});
export type DiagnosticsResponse = z.infer<typeof DiagnosticsResponseSchema>;

export const SettingsResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  stored: StoredConfigSchema,
  effective: StoredConfigSchema,
});
export type SettingsResponse = z.infer<typeof SettingsResponseSchema>;

export const ReadyDaemonIdentitySchema = z.strictObject({
  schema_version: z.literal(1),
  state: z.literal('ready'),
  pid: z.number().int().positive().safe(),
  version: z.string().min(1).max(128),
  instance_id: z.string().regex(/^svc_[0-9a-f]{32}$/),
  started_at: z.string().min(20).max(40).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/)
    .refine((value) => Number.isFinite(Date.parse(value))),
  address: z.string().regex(/^127\.0\.0\.1:(?:[1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5])$/),
});
export type ReadyDaemonIdentity = z.infer<typeof ReadyDaemonIdentitySchema>;

export const ControlStatusResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  identity: ReadyDaemonIdentitySchema,
  state: z.enum(['ready', 'stopping']),
});
export type ControlStatusResponse = z.infer<typeof ControlStatusResponseSchema>;

export type HttpLogger = Pick<LocalLogger, 'debug' | 'info' | 'warn' | 'error'>;

export interface LocalApiPort {
  runtimes(signal: AbortSignal): Promise<RuntimesResponse>;
  rescan(signal: AbortSignal): Promise<RuntimesResponse>;
  enable(runtimeIds: readonly string[], signal: AbortSignal): Promise<EnableResponse>;
  disable(runtimeId: string, signal: AbortSignal): Promise<BindingMutationResponse>;
  reregister(runtimeId: string, signal: AbortSignal): Promise<BindingMutationResponse>;
  activity(signal: AbortSignal): Promise<ActivityResponse>;
  diagnostics(signal: AbortSignal): Promise<DiagnosticsResponse>;
  settings(signal: AbortSignal): Promise<SettingsResponse>;
  saveSettings(value: StoredConfig, signal: AbortSignal): Promise<SettingsResponse>;
}

export interface LocalControlPort {
  status(signal: AbortSignal): Promise<ControlStatusResponse>;
  rescan(signal: AbortSignal): Promise<RuntimesResponse>;
  shutdownAfterResponse(): void;
}

export interface LocalRequestContext {
  peer: '127.0.0.1';
  host: string;
  origin: string;
  pathname: string;
  method: string;
}

export interface LocalRoutesOptions {
  api: LocalApiPort;
  control: LocalControlPort;
  tickets: LaunchTicketStore;
  sessions: BrowserSessionStore;
  readyIdentity: () => ReadyDaemonIdentity;
  controlCredential: string;
  logger: HttpLogger;
  now?: () => number;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}

type ErrorDefinition = {
  status: number;
  category: 'detection' | 'authentication' | 'registration' | 'transport' | 'runtime' | 'policy';
  retryable: boolean;
};

const ERROR_DEFINITIONS = {
  invalid_request: { status: 400, category: 'policy', retryable: false },
  invalid_json: { status: 400, category: 'policy', retryable: false },
  session_required: { status: 401, category: 'authentication', retryable: false },
  ticket_invalid: { status: 401, category: 'authentication', retryable: false },
  control_unauthorized: { status: 401, category: 'authentication', retryable: false },
  host_rejected: { status: 403, category: 'policy', retryable: false },
  origin_rejected: { status: 403, category: 'policy', retryable: false },
  csrf_rejected: { status: 403, category: 'policy', retryable: false },
  not_found: { status: 404, category: 'policy', retryable: false },
  runtime_not_found: { status: 404, category: 'detection', retryable: false },
  method_not_allowed: { status: 405, category: 'policy', retryable: false },
  config_recovery_required: { status: 409, category: 'policy', retryable: false },
  identity_conflict: { status: 409, category: 'policy', retryable: false },
  body_too_large: { status: 413, category: 'policy', retryable: false },
  unsupported_media_type: { status: 415, category: 'policy', retryable: false },
  ticket_capacity: { status: 429, category: 'policy', retryable: true },
  internal_error: { status: 500, category: 'runtime', retryable: false },
  bridge_unavailable: { status: 503, category: 'transport', retryable: true },
  ui_unavailable: { status: 503, category: 'transport', retryable: true },
  operation_unavailable: { status: 503, category: 'transport', retryable: true },
  operation_timeout: { status: 504, category: 'transport', retryable: true },
} as const satisfies Record<string, ErrorDefinition>;
export type PublicErrorCode = keyof typeof ERROR_DEFINITIONS;

class HttpFailure extends Error {
  constructor(readonly code: PublicErrorCode) { super(code); }
}

function rawHeaderValues(request: IncomingMessage, name: string): string[] {
  const lower = name.toLowerCase();
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === lower) values.push(request.rawHeaders[index + 1] ?? '');
  }
  return values;
}

function setCommonHeaders(response: ServerResponse): void {
  for (const [name, value] of Object.entries(securityHeaders())) response.setHeader(name, value);
}

function sendJson(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  value: unknown,
  schema: z.ZodType,
  headers: Record<string, string> = {},
): void {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpFailure('internal_error');
  const body = Buffer.from(JSON.stringify(parsed.data), 'utf8');
  if (body.byteLength > RESPONSE_LIMIT) throw new HttpFailure('internal_error');
  setCommonHeaders(response);
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', String(body.byteLength));
  for (const [name, headerValue] of Object.entries(headers)) response.setHeader(name, headerValue);
  response.end(request.method === 'HEAD' ? undefined : body);
}

export function writeHttpError(
  request: IncomingMessage,
  response: ServerResponse,
  code: PublicErrorCode,
  headers: Record<string, string> = {},
): void {
  if (response.headersSent || response.destroyed) return;
  const definition = ERROR_DEFINITIONS[code];
  const value = { error: { code, category: definition.category, retryable: definition.retryable } };
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  setCommonHeaders(response);
  response.statusCode = definition.status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', String(body.byteLength));
  for (const [name, headerValue] of Object.entries(headers)) response.setHeader(name, headerValue);
  response.end(request.method === 'HEAD' ? undefined : body);
}

function knownErrorCode(error: unknown): PublicErrorCode {
  if (error instanceof HttpFailure) return error.code;
  const explicitCode = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
  if (explicitCode !== undefined && Object.hasOwn(ERROR_DEFINITIONS, explicitCode)) {
    return explicitCode as PublicErrorCode;
  }
  return error instanceof RangeError && error.message === 'ticket_capacity'
    ? 'ticket_capacity'
    : 'internal_error';
}

function validateFraming(request: IncomingMessage, maximumBytes: number, json: boolean): number | undefined {
  if (rawHeaderValues(request, 'expect').length !== 0 || rawHeaderValues(request, 'content-encoding').length !== 0) {
    throw new HttpFailure('invalid_request');
  }
  const contentLengths = rawHeaderValues(request, 'content-length');
  const transferEncodings = rawHeaderValues(request, 'transfer-encoding');
  if (
    contentLengths.length > 1
    || transferEncodings.length > 1
    || (contentLengths.length !== 0 && transferEncodings.length !== 0)
  ) throw new HttpFailure('invalid_request');
  const contentTypes = rawHeaderValues(request, 'content-type');
  if (!json && (contentTypes.length !== 0 || transferEncodings.length !== 0)) {
    throw new HttpFailure('invalid_request');
  }
  let declared: number | undefined;
  if (contentLengths.length === 1) {
    const value = contentLengths[0]!;
    if (!/^\d+$/.test(value) || value.includes(',')) throw new HttpFailure('invalid_request');
    declared = Number(value);
    if (!Number.isSafeInteger(declared)) throw new HttpFailure('invalid_request');
    if (!json && declared !== 0) throw new HttpFailure('invalid_request');
    if (declared > maximumBytes) throw new HttpFailure('body_too_large');
  }
  if (transferEncodings.length === 1 && transferEncodings[0]!.toLowerCase() !== 'chunked') {
    throw new HttpFailure('invalid_request');
  }
  if (json) {
    if (
      contentTypes.length !== 1
      || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentTypes[0]!)
    ) throw new HttpFailure('unsupported_media_type');
  }
  return declared;
}

export function assertBodylessRequest(request: IncomingMessage): void {
  validateFraming(request, 0, false);
}

async function readJson(request: IncomingMessage, maximumBytes: number): Promise<unknown> {
  validateFraming(request, maximumBytes, true);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    bytes += buffer.byteLength;
    if (bytes > maximumBytes) throw new HttpFailure('body_too_large');
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpFailure('invalid_json');
  }
}

function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpFailure('invalid_request');
  return parsed.data;
}

const ExchangeInputSchema = z.strictObject({ ticket: z.string().regex(TOKEN_PATTERN) });
const EnableInputSchema = z.strictObject({
  runtimeIds: z.array(z.string().regex(RUNTIME_ID_PATTERN)).min(1).max(PROVIDERS.length),
}).superRefine((value, context) => {
  if (new Set(value.runtimeIds).size !== value.runtimeIds.length) {
    context.addIssue({ code: 'custom', path: ['runtimeIds'], message: 'duplicate_runtime' });
  }
});
const SettingsInputSchema = z.strictObject({ settings: StoredConfigSchema });
const ControlInputSchema = z.discriminatedUnion('command', [
  z.strictObject({ command: z.literal('status') }),
  z.strictObject({ command: z.literal('launch_ticket') }),
  z.strictObject({ command: z.literal('rescan') }),
  z.strictObject({ command: z.literal('shutdown') }),
]);
const ExchangeResponseSchema = z.strictObject({
  schemaVersion: z.literal(1), csrfToken: z.string().regex(TOKEN_PATTERN), expiresInMs: z.literal(28_800_000),
});
const LaunchTicketResponseSchema = z.strictObject({
  schemaVersion: z.literal(1), ticket: z.string().regex(TOKEN_PATTERN), expiresAt: z.number().int().positive().safe(),
});
const ShutdownResponseSchema = z.strictObject({ schemaVersion: z.literal(1), accepted: z.literal(true) });

type BrowserRoute = {
  method: 'GET' | 'POST' | 'PUT';
  allow: string;
  kind: 'exchange' | 'runtimes' | 'rescan' | 'enable' | 'disable' | 'reregister' | 'activity' | 'diagnostics' | 'settings' | 'saveSettings';
  runtimeId?: string;
};

function browserRoute(pathname: string): BrowserRoute | undefined {
  const fixed: Record<string, BrowserRoute> = {
    '/api/session/exchange': { method: 'POST', allow: 'POST', kind: 'exchange' },
    '/api/runtimes': { method: 'GET', allow: 'GET', kind: 'runtimes' },
    '/api/runtimes/rescan': { method: 'POST', allow: 'POST', kind: 'rescan' },
    '/api/bindings/enable': { method: 'POST', allow: 'POST', kind: 'enable' },
    '/api/activity': { method: 'GET', allow: 'GET', kind: 'activity' },
    '/api/diagnostics': { method: 'GET', allow: 'GET', kind: 'diagnostics' },
    '/api/settings': { method: 'GET', allow: 'GET, PUT', kind: 'settings' },
  };
  if (pathname === '/api/settings') return fixed[pathname];
  const exact = fixed[pathname];
  if (exact !== undefined) return exact;
  const match = /^\/api\/bindings\/(rt_[0-9a-f]{32})\/(disable|reregister)$/.exec(pathname);
  if (match === null) return undefined;
  return { method: 'POST', allow: 'POST', kind: match[2] as 'disable' | 'reregister', runtimeId: match[1] };
}

function cookie(request: IncomingMessage): string | undefined {
  const values = rawHeaderValues(request, 'cookie');
  return values.length === 1 ? values[0] : undefined;
}

function requireOrigin(request: IncomingMessage, context: LocalRequestContext): void {
  const values = rawHeaderValues(request, 'origin');
  if (values.length !== 1 || values[0] !== context.origin) throw new HttpFailure('origin_rejected');
}

function rejectInternalBrowserHeaders(request: IncomingMessage): void {
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]!.toLowerCase();
    if (name === 'cookie' || name === 'origin' || name === 'referer' || name.startsWith('sec-fetch-')) {
      throw new HttpFailure('invalid_request');
    }
  }
}

export class LocalRoutes {
  readonly #api: LocalApiPort;
  readonly #control: LocalControlPort;
  readonly #tickets: LaunchTicketStore;
  readonly #sessions: BrowserSessionStore;
  readonly #controlCredential: string;
  readonly #setTimeout: typeof globalThis.setTimeout;
  readonly #clearTimeout: typeof globalThis.clearTimeout;

  constructor(options: LocalRoutesOptions) {
    if (!TOKEN_PATTERN.test(options.controlCredential)) throw new RangeError('invalid_control_credential');
    this.#api = options.api;
    this.#control = options.control;
    this.#tickets = options.tickets;
    this.#sessions = options.sessions;
    this.#controlCredential = options.controlCredential;
    this.#setTimeout = options.setTimeout ?? globalThis.setTimeout;
    this.#clearTimeout = options.clearTimeout ?? globalThis.clearTimeout;
  }

  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    context: LocalRequestContext,
  ): Promise<'handled' | 'static'> {
    try {
      if (context.pathname === '/internal/control') {
        if (context.method !== 'POST') {
          throw Object.assign(new HttpFailure('method_not_allowed'), { allow: 'POST' });
        }
        await this.#internal(request, response);
        return 'handled';
      }
      if (context.pathname.startsWith('/internal')) throw new HttpFailure('not_found');
      const route = browserRoute(context.pathname);
      if (route === undefined) {
        if (context.pathname.startsWith('/api')) throw new HttpFailure('not_found');
        return 'static';
      }
      const expectedMethod = context.pathname === '/api/settings' && context.method === 'PUT'
        ? 'PUT'
        : route.method;
      if (context.method !== expectedMethod) {
        throw Object.assign(new HttpFailure('method_not_allowed'), { allow: route.allow });
      }
      await this.#browser(request, response, context, {
        ...route,
        kind: context.pathname === '/api/settings' && context.method === 'PUT' ? 'saveSettings' : route.kind,
      });
      return 'handled';
    } catch (error) {
      const allow = typeof error === 'object' && error !== null && 'allow' in error
        ? String((error as { allow?: unknown }).allow)
        : undefined;
      writeHttpError(request, response, knownErrorCode(error), allow === undefined ? {} : { Allow: allow });
      return 'handled';
    }
  }

  async #browser(
    request: IncomingMessage,
    response: ServerResponse,
    context: LocalRequestContext,
    route: BrowserRoute,
  ): Promise<void> {
    if (route.kind === 'exchange') {
      requireOrigin(request, context);
      const input = parseInput(ExchangeInputSchema, await readJson(request, SMALL_BODY_LIMIT));
      if (!this.#tickets.consume(input.ticket)) throw new HttpFailure('ticket_invalid');
      const session = this.#sessions.create();
      sendJson(request, response, 200, {
        schemaVersion: 1, csrfToken: session.csrfToken, expiresInMs: session.expiresInMs,
      }, ExchangeResponseSchema, {
        'Set-Cookie': `quukk_session=${session.cookieValue}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`,
      });
      return;
    }

    const mutating = context.method !== 'GET';
    if (mutating) requireOrigin(request, context);
    const authenticated = this.#sessions.authenticate(cookie(request));
    if (authenticated === undefined) throw new HttpFailure('session_required');
    if (mutating) {
      const csrfValues = rawHeaderValues(request, 'x-quukk-csrf');
      const csrf = csrfValues.length === 1 ? csrfValues[0] : undefined;
      if (!this.#sessions.verifyCsrf(authenticated.sessionKey, csrf)) throw new HttpFailure('csrf_rejected');
    }

    if (route.kind === 'enable') {
      const input = parseInput(EnableInputSchema, await readJson(request, PUBLIC_BODY_LIMIT));
      const value = await this.#operation(request, response, 45_000, (signal) => this.#api.enable(input.runtimeIds, signal));
      sendJson(request, response, 200, value, EnableResponseSchema);
      return;
    }
    if (route.kind === 'saveSettings') {
      const input = parseInput(SettingsInputSchema, await readJson(request, PUBLIC_BODY_LIMIT));
      const value = await this.#operation(request, response, 10_000, (signal) => this.#api.saveSettings(input.settings, signal));
      sendJson(request, response, 200, value, SettingsResponseSchema);
      return;
    }

    assertBodylessRequest(request);
    if (route.kind === 'runtimes') {
      const value = await this.#operation(request, response, 12_000, (signal) => this.#api.runtimes(signal));
      sendJson(request, response, 200, value, RuntimesResponseSchema);
    } else if (route.kind === 'rescan') {
      const value = await this.#operation(request, response, 35_000, (signal) => this.#api.rescan(signal));
      sendJson(request, response, 200, value, RuntimesResponseSchema);
    } else if (route.kind === 'disable') {
      const value = await this.#operation(request, response, 10_000, (signal) => this.#api.disable(route.runtimeId!, signal));
      sendJson(request, response, 200, value, BindingMutationResponseSchema);
    } else if (route.kind === 'reregister') {
      const value = await this.#operation(request, response, 45_000, (signal) => this.#api.reregister(route.runtimeId!, signal));
      sendJson(request, response, 200, value, BindingMutationResponseSchema);
    } else if (route.kind === 'activity') {
      const value = await this.#operation(request, response, 12_000, (signal) => this.#api.activity(signal));
      sendJson(request, response, 200, value, ActivityResponseSchema);
    } else if (route.kind === 'diagnostics') {
      const value = await this.#operation(request, response, 10_000, (signal) => this.#api.diagnostics(signal));
      sendJson(request, response, 200, value, DiagnosticsResponseSchema);
    } else if (route.kind === 'settings') {
      const value = await this.#operation(request, response, 10_000, (signal) => this.#api.settings(signal));
      sendJson(request, response, 200, value, SettingsResponseSchema);
    }
  }

  async #internal(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const authorization = rawHeaderValues(request, 'authorization');
    const match = authorization.length === 1 ? /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization[0]!) : null;
    if (match === null || !constantTimeCredentialEqual(this.#controlCredential, match[1]!)) {
      throw new HttpFailure('control_unauthorized');
    }
    rejectInternalBrowserHeaders(request);
    const input = parseInput(ControlInputSchema, await readJson(request, SMALL_BODY_LIMIT));
    if (input.command === 'status') {
      const value = await this.#operation(request, response, 5_000, (signal) => this.#control.status(signal));
      sendJson(request, response, 200, value, ControlStatusResponseSchema);
    } else if (input.command === 'launch_ticket') {
      const issued = this.#tickets.issue();
      sendJson(request, response, 201, { schemaVersion: 1, ...issued }, LaunchTicketResponseSchema);
    } else if (input.command === 'rescan') {
      const value = await this.#operation(request, response, 35_000, (signal) => this.#control.rescan(signal));
      sendJson(request, response, 200, value, RuntimesResponseSchema);
    } else {
      response.once('finish', () => queueMicrotask(() => this.#control.shutdownAfterResponse()));
      sendJson(request, response, 202, { schemaVersion: 1, accepted: true }, ShutdownResponseSchema);
    }
  }

  async #operation<T>(
    request: IncomingMessage,
    response: ServerResponse,
    milliseconds: number,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let timedOut = false;
    const disconnect = () => controller.abort();
    const responseClosed = () => { if (!response.writableEnded) disconnect(); };
    request.once('aborted', disconnect);
    response.once('close', responseClosed);
    let rejectTimeout!: (error: Error) => void;
    const timeoutPromise = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
    const timer = this.#setTimeout(() => {
      timedOut = true;
      controller.abort();
      rejectTimeout(new HttpFailure('operation_timeout'));
    }, milliseconds);
    try {
      return await Promise.race([operation(controller.signal), timeoutPromise]);
    } catch (error) {
      if (timedOut) throw new HttpFailure('operation_timeout');
      throw error;
    } finally {
      this.#clearTimeout(timer);
      request.off('aborted', disconnect);
      response.off('close', responseClosed);
    }
  }
}
