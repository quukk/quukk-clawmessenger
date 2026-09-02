import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CONFIG } from '../config/schema.js';
import {
  LocalRoutes,
  type ActivityResponse,
  type BindingMutationResponse,
  type ControlStatusResponse,
  type DiagnosticsResponse,
  type EnableResponse,
  type LocalApiPort,
  type LocalControlPort,
  type ReadyDaemonIdentity,
  type RuntimesResponse,
  type SettingsResponse,
} from './routes.js';
import { BrowserSessionStore, securityHeaders } from './security.js';
import { LaunchTicketStore } from './tickets.js';

const INSTANCE_ID = `svc_${'a'.repeat(32)}`;
const CONTROL_CREDENTIAL = Buffer.alloc(32, 9).toString('base64url');
const RUNTIME_ID = `rt_${'b'.repeat(32)}`;
const TIME = '2026-08-27T10:00:00.000Z';

const identity: ReadyDaemonIdentity = {
  schema_version: 1,
  state: 'ready',
  pid: 4242,
  version: '0.1.0-beta.1',
  instance_id: INSTANCE_ID,
  started_at: TIME,
  address: '127.0.0.1:43210',
};

const runtimes: RuntimesResponse = {
  schemaVersion: 1,
  runtimes: ['opencode', 'openclaw', 'codex', 'hermes'].map((provider, index) => ({
    provider: provider as 'opencode' | 'openclaw' | 'codex' | 'hermes',
    runtimeId: index === 0 ? RUNTIME_ID : null,
    version: index === 0 ? '1.2.3' : null,
    path: index === 0 ? (process.platform === 'win32' ? 'D:\\tools\\opencode.exe' : '/tools/opencode') : null,
    status: index === 0 ? 'ready' : 'not_found',
    capabilities: {
      sessionResume: index === 0,
      cancel: index === 0,
      textEvents: index === 0,
      toolEvents: index === 0,
      approvalEvents: false as const,
    },
    binding: index === 0 ? {
      runtimeId: RUNTIME_ID,
      nodeId: 'opencode_node',
      nodeName: 'Local OpenCode',
      enabled: true,
      registrationState: 'online' as const,
      updatedAt: TIME,
    } : null,
    worker: index === 0 ? { state: 'online' as const, restartCount: 0 } : null,
  })),
};

const binding = runtimes.runtimes[0]!.binding!;
const enableResponse: EnableResponse = {
  schemaVersion: 1,
  results: [{ runtimeId: RUNTIME_ID, ok: true, binding }],
};
const bindingResponse: BindingMutationResponse = { schemaVersion: 1, binding };
const activity: ActivityResponse = {
  schemaVersion: 1,
  events: [{ id: 1, time: TIME, level: 'info', event: 'worker_online', runtimeId: RUNTIME_ID }],
};
const diagnostics: DiagnosticsResponse = {
  schemaVersion: 1,
  service: {
    version: '0.1.0-beta.1', state: 'ready', pid: 4242, startedAt: TIME,
    listenHost: '127.0.0.1', port: 43210, uptimeMs: 10,
  },
  bridge: { state: 'ready', pid: 4243, version: '0.1.0', startedAt: TIME, probeStatus: 'ready' },
  runtimes: [{ provider: 'opencode', status: 'ready', version: '1.2.3', executableName: 'opencode.exe' }],
  workers: [{ runtimeId: RUNTIME_ID, state: 'online', restartCount: 0 }],
  warnings: [],
  logging: { dropped: 0, retained: 1 },
};
const settings: SettingsResponse = {
  schemaVersion: 1,
  stored: DEFAULT_CONFIG,
  effective: DEFAULT_CONFIG,
};
const status: ControlStatusResponse = { schemaVersion: 1, identity, state: 'ready' };
const pairingWaiting = {
  schemaVersion: 1 as const,
  state: 'waiting' as const,
  expiresAt: '2099-09-02T10:05:00.000Z',
  qrContent: JSON.stringify({
    type: 'clawmessenger_pairing',
    version: 1,
    server: 'https://configured.example',
    ticket: 'p'.repeat(43),
    expiresAt: Date.parse('2099-09-02T10:05:00.000Z'),
  }),
  candidates: [{
    candidateId: 'cand-a',
    provider: 'opencode' as const,
    displayName: 'OpenCode',
    version: '1.2.3',
    readiness: 'ready' as const,
    statusReason: null,
    registrationState: 'unregistered' as const,
  }],
  results: [],
};
const pairingCancelled = { ...pairingWaiting, state: 'cancelled' as const, qrContent: null };

class FakeApi implements LocalApiPort {
  readonly calls: string[] = [];
  async runtimes(): Promise<RuntimesResponse> { this.calls.push('runtimes'); return runtimes; }
  async rescan(): Promise<RuntimesResponse> { this.calls.push('rescan'); return runtimes; }
  async enable(runtimeIds: readonly string[]): Promise<EnableResponse> {
    this.calls.push(`enable:${runtimeIds.join(',')}`); return enableResponse;
  }
  async disable(runtimeId: string): Promise<BindingMutationResponse> {
    this.calls.push(`disable:${runtimeId}`); return bindingResponse;
  }
  async reregister(runtimeId: string): Promise<BindingMutationResponse> {
    this.calls.push(`reregister:${runtimeId}`); return bindingResponse;
  }
  async activity(): Promise<ActivityResponse> { this.calls.push('activity'); return activity; }
  async diagnostics(): Promise<DiagnosticsResponse> { this.calls.push('diagnostics'); return diagnostics; }
  async settings(): Promise<SettingsResponse> { this.calls.push('settings'); return settings; }
  async saveSettings(): Promise<SettingsResponse> { this.calls.push('saveSettings'); return settings; }
  async pairingStart(): Promise<typeof pairingWaiting> {
    this.calls.push('pairingStart'); return pairingWaiting;
  }
  async pairingStatus(): Promise<typeof pairingWaiting> {
    this.calls.push('pairingStatus'); return pairingWaiting;
  }
  async pairingCancel(): Promise<typeof pairingCancelled> {
    this.calls.push('pairingCancel'); return pairingCancelled;
  }
  async pairingRetry(candidateIds: readonly string[]): Promise<typeof pairingWaiting> {
    this.calls.push(`pairingRetry:${candidateIds.join(',')}`); return pairingWaiting;
  }
}

class FakeControl implements LocalControlPort {
  readonly calls: string[] = [];
  async status(): Promise<ControlStatusResponse> { this.calls.push('status'); return status; }
  async rescan(): Promise<RuntimesResponse> { this.calls.push('rescan'); return runtimes; }
  shutdownAfterResponse(): void { this.calls.push('shutdown'); }
}

type Response = { status: number; headers: IncomingHttpHeaders; body: string; json: unknown };
type Harness = {
  origin: string;
  api: FakeApi;
  control: FakeControl;
  tickets: LaunchTicketStore;
  sessions: BrowserSessionStore;
  send(input: { method?: string; path?: string; headers?: Record<string, string>; body?: string }): Promise<Response>;
  close(): Promise<void>;
};

const harnesses: Harness[] = [];

async function harness(overrides: {
  sessions?: BrowserSessionStore;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
} = {}): Promise<Harness> {
  const api = new FakeApi();
  const control = new FakeControl();
  const tickets = new LaunchTicketStore({ instanceId: INSTANCE_ID });
  const sessions = overrides.sessions ?? new BrowserSessionStore();
  let origin = '';
  const routes = new LocalRoutes({
    api, control, tickets, sessions,
    controlCredential: CONTROL_CREDENTIAL,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    setTimeout: overrides.setTimeout,
    clearTimeout: overrides.clearTimeout,
  });
  const server = createServer(async (incoming, outgoing) => {
    const rawPath = incoming.url?.split('?', 1)[0] ?? '/';
    const result = await routes.handle(incoming, outgoing, {
      peer: '127.0.0.1', host: origin.slice('http://'.length), origin,
      pathname: rawPath, method: incoming.method ?? 'GET',
    });
    if (result === 'static') {
      outgoing.writeHead(404, { ...securityHeaders(), 'Content-Type': 'application/json; charset=utf-8' });
      outgoing.end(JSON.stringify({ error: { code: 'not_found', category: 'policy', retryable: false } }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;
  const result: Harness = {
    origin, api, control, tickets, sessions,
    send: (input) => new Promise<Response>((resolve, reject) => {
      const body = input.body ?? '';
      const outgoing = request({
        hostname: '127.0.0.1', port, method: input.method ?? 'GET', path: input.path ?? '/',
        headers: input.headers,
      }, (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown;
          try { json = JSON.parse(text); } catch { json = undefined; }
          resolve({ status: incoming.statusCode!, headers: incoming.headers, body: text, json });
        });
      });
      outgoing.on('error', reject);
      if (body === '') outgoing.end();
      else outgoing.end(body);
    }),
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
  harnesses.push(result);
  return result;
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((item) => item.close()));
});

function cookieHeader(response: Response): string {
  return response.headers['set-cookie']![0]!.split(';', 1)[0]!;
}

async function browserSession(value: Harness): Promise<{ cookie: string; csrf: string }> {
  const { ticket } = value.tickets.issue();
  const response = await value.send({
    method: 'POST', path: '/api/session/exchange',
    headers: { Origin: value.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket }),
  });
  return { cookie: cookieHeader(response), csrf: (response.json as { csrfToken: string }).csrfToken };
}

describe('LocalRoutes browser boundary', () => {
  it('exchanges a launch ticket once and emits the exact hardened session response', async () => {
    const value = await harness();
    const { ticket } = value.tickets.issue();
    const response = await value.send({
      method: 'POST', path: '/api/session/exchange',
      headers: { Origin: value.origin, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ ticket }),
    });
    expect(response.status).toBe(200);
    expect(response.json).toEqual({ schemaVersion: 1, csrfToken: expect.stringMatching(/^[\w-]{43}$/), expiresInMs: 28_800_000 });
    expect(response.headers['set-cookie']).toEqual([
      expect.stringMatching(/^quukk_session=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=28800$/),
    ]);
    expect(response.headers['content-security-policy']).toBe(securityHeaders()['Content-Security-Policy']);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();

    const reused = await value.send({
      method: 'POST', path: '/api/session/exchange',
      headers: { Origin: value.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket }),
    });
    expect(reused.status).toBe(401);
    expect(reused.json).toEqual({ error: { code: 'ticket_invalid', category: 'authentication', retryable: false } });
  });

  it('requires a session for GET and exact Origin plus CSRF for mutations', async () => {
    const value = await harness();
    expect((await value.send({ path: '/api/runtimes' })).json).toEqual({
      error: { code: 'session_required', category: 'authentication', retryable: false },
    });
    const session = await browserSession(value);
    const get = await value.send({ path: '/api/runtimes', headers: { Cookie: session.cookie } });
    expect(get.status).toBe(200);
    expect(get.json).toEqual(runtimes);

    for (const headers of [
      { Cookie: session.cookie, Origin: 'null', 'X-Quukk-CSRF': session.csrf },
      { Cookie: session.cookie, Origin: value.origin, 'X-Quukk-CSRF': 'x'.repeat(43) },
    ]) {
      const denied = await value.send({ method: 'POST', path: '/api/runtimes/rescan', headers });
      expect(denied.status).toBe(403);
    }
    expect(value.api.calls).toEqual(['runtimes']);
  });

  it('treats PUT settings as a mutation and performs no save without Origin and CSRF', async () => {
    const value = await harness();
    const session = await browserSession(value);
    const body = JSON.stringify({ settings: DEFAULT_CONFIG });
    const contentType = { 'Content-Type': 'application/json' };
    const missingOrigin = await value.send({
      method: 'PUT', path: '/api/settings',
      headers: { ...contentType, Cookie: session.cookie, 'X-Quukk-CSRF': session.csrf },
      body,
    });
    expect(missingOrigin.status).toBe(403);
    expect(missingOrigin.json).toEqual({
      error: { code: 'origin_rejected', category: 'policy', retryable: false },
    });
    const missingCsrf = await value.send({
      method: 'PUT', path: '/api/settings',
      headers: { ...contentType, Cookie: session.cookie, Origin: value.origin },
      body,
    });
    expect(missingCsrf.status).toBe(403);
    expect(missingCsrf.json).toEqual({
      error: { code: 'csrf_rejected', category: 'policy', retryable: false },
    });
    expect(value.api.calls).toEqual([]);
  });

  it('dispatches strict enable, binding, activity, diagnostics and settings envelopes', async () => {
    const value = await harness();
    const session = await browserSession(value);
    const mutationHeaders = {
      Cookie: session.cookie, Origin: value.origin, 'X-Quukk-CSRF': session.csrf,
    };
    const enable = await value.send({
      method: 'POST', path: '/api/bindings/enable',
      headers: { ...mutationHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ runtimeIds: [RUNTIME_ID] }),
    });
    expect(enable.status).toBe(200);
    expect(enable.json).toEqual(enableResponse);
    expect((await value.send({ method: 'POST', path: `/api/bindings/${RUNTIME_ID}/disable`, headers: mutationHeaders })).json).toEqual(bindingResponse);
    expect((await value.send({ method: 'POST', path: `/api/bindings/${RUNTIME_ID}/reregister`, headers: mutationHeaders })).json).toEqual(bindingResponse);
    expect((await value.send({ path: '/api/activity', headers: { Cookie: session.cookie } })).json).toEqual(activity);
    expect((await value.send({ path: '/api/diagnostics', headers: { Cookie: session.cookie } })).json).toEqual(diagnostics);
    expect((await value.send({ path: '/api/settings', headers: { Cookie: session.cookie } })).json).toEqual(settings);
    expect((await value.send({
      method: 'PUT', path: '/api/settings', headers: { ...mutationHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: DEFAULT_CONFIG }),
    })).json).toEqual(settings);
    expect(value.api.calls).toEqual([
      `enable:${RUNTIME_ID}`, `disable:${RUNTIME_ID}`, `reregister:${RUNTIME_ID}`,
      'activity', 'diagnostics', 'settings', 'saveSettings',
    ]);
  });

  it('returns only local UI pairing fields with hardened headers for the full lifecycle', async () => {
    const value = await harness();
    const session = await browserSession(value);
    const mutationHeaders = {
      Cookie: session.cookie, Origin: value.origin, 'X-Quukk-CSRF': session.csrf,
    };
    const started = await value.send({
      method: 'POST', path: '/api/pairing/session', headers: mutationHeaders,
    });
    expect(started.status).toBe(200);
    expect(started.json).toEqual(pairingWaiting);
    expect(started.headers['content-security-policy']).toBe(securityHeaders()['Content-Security-Policy']);
    expect(started.headers['cache-control']).toBe('no-store');
    expect(started.headers['access-control-allow-origin']).toBeUndefined();
    expect(JSON.stringify(started.json)).not.toMatch(
      /deviceSecret|candidateToRuntime|runtimePath|runtimeId|tokenRef|authorization|internalBody/,
    );

    const inspected = await value.send({
      path: '/api/pairing/session', headers: { Cookie: session.cookie },
    });
    expect(inspected.status).toBe(200);
    expect(inspected.json).toEqual(pairingWaiting);

    const cancelled = await value.send({
      method: 'DELETE', path: '/api/pairing/session', headers: mutationHeaders,
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.json).toEqual(pairingCancelled);

    const retried = await value.send({
      method: 'POST', path: '/api/pairing/session/retry',
      headers: { ...mutationHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidateIds: ['cand-a'] }),
    });
    expect(retried.status).toBe(200);
    expect(retried.json).toEqual(pairingWaiting);
    expect(value.api.calls).toEqual([
      'pairingStart', 'pairingStatus', 'pairingCancel', 'pairingRetry:cand-a',
    ]);
  });

  it('rejects unsafe pairing methods, authentication, framing, and retry bodies before effects', async () => {
    const value = await harness();
    const session = await browserSession(value);
    const mutationHeaders = {
      Cookie: session.cookie, Origin: value.origin, 'X-Quukk-CSRF': session.csrf,
    };
    const wrongStartMethod = await value.send({
      method: 'PUT', path: '/api/pairing/session', headers: mutationHeaders,
    });
    expect(wrongStartMethod.status).toBe(405);
    expect(wrongStartMethod.headers.allow).toBe('GET, POST, DELETE');
    const wrongRetryMethod = await value.send({
      method: 'GET', path: '/api/pairing/session/retry', headers: { Cookie: session.cookie },
    });
    expect(wrongRetryMethod.status).toBe(405);
    expect(wrongRetryMethod.headers.allow).toBe('POST');

    expect((await value.send({ method: 'POST', path: '/api/pairing/session' })).status).toBe(403);
    expect((await value.send({
      method: 'POST', path: '/api/pairing/session',
      headers: { Cookie: session.cookie, Origin: value.origin },
    })).status).toBe(403);
    expect((await value.send({
      method: 'POST', path: '/api/pairing/session',
      headers: { ...mutationHeaders, 'Content-Type': 'application/json' }, body: '{}',
    })).status).toBe(400);

    const retry = (body: string) => value.send({
      method: 'POST', path: '/api/pairing/session/retry',
      headers: { ...mutationHeaders, 'Content-Type': 'application/json' }, body,
    });
    for (const body of [
      'not-json',
      JSON.stringify({ candidateIds: [] }),
      JSON.stringify({ candidateIds: ['cand-a', 'cand-a'] }),
      JSON.stringify({ candidateIds: Array.from({ length: 17 }, (_, index) => `cand-${index}`) }),
      JSON.stringify({ candidateIds: ['cand-a'], extra: true }),
      JSON.stringify({ candidateIds: ['candidate with spaces'] }),
    ]) {
      expect((await retry(body)).status).toBe(400);
    }
    expect((await value.send({
      method: 'POST', path: '/api/pairing/session/retry', headers: mutationHeaders,
      body: JSON.stringify({ candidateIds: ['cand-a'] }),
    })).status).toBe(415);
    expect(value.api.calls).toEqual([]);
  });

  it('aborts a timed-out pairing start and returns only the fixed timeout error', async () => {
    let aborted = false;
    const value = await harness({
      setTimeout: ((callback: (...args: unknown[]) => void) => {
        queueMicrotask(callback);
        return 1 as never;
      }) as unknown as typeof globalThis.setTimeout,
      clearTimeout: (() => undefined) as typeof globalThis.clearTimeout,
    });
    const session = await browserSession(value);
    value.api.pairingStart = ((signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('SECRET_PAIRING_START_FAILURE'));
      }, { once: true });
    })) as never;
    const response = await value.send({
      method: 'POST', path: '/api/pairing/session',
      headers: { Cookie: session.cookie, Origin: value.origin, 'X-Quukk-CSRF': session.csrf },
    });
    expect(response.status).toBe(504);
    expect(response.json).toEqual({
      error: { code: 'operation_timeout', category: 'transport', retryable: true },
    });
    expect(response.body).not.toContain('SECRET_PAIRING_START_FAILURE');
    expect(aborted).toBe(true);
  });

  it('accepts the maximum bounded set of sixteen unique candidate IDs', async () => {
    const value = await harness();
    const session = await browserSession(value);
    const candidateIds = Array.from({ length: 16 }, (_, index) =>
      `${index.toString(16).padStart(2, '0')}${'a'.repeat(62)}`);
    const response = await value.send({
      method: 'POST', path: '/api/pairing/session/retry',
      headers: {
        Cookie: session.cookie,
        Origin: value.origin,
        'X-Quukk-CSRF': session.csrf,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ candidateIds }),
    });
    expect(response.status).toBe(200);
    expect(value.api.calls).toEqual([`pairingRetry:${candidateIds.join(',')}`]);
  });

  it('rejects unknown input, empty-route bodies, raw aliases, and wrong methods before effects', async () => {
    const value = await harness();
    const session = await browserSession(value);
    const headers = { Cookie: session.cookie, Origin: value.origin, 'X-Quukk-CSRF': session.csrf };
    const invalid = await value.send({
      method: 'POST', path: '/api/bindings/enable',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ runtimeIds: [RUNTIME_ID, RUNTIME_ID], extra: true }),
    });
    expect(invalid.status).toBe(400);
    expect(invalid.json).toEqual({ error: { code: 'invalid_request', category: 'policy', retryable: false } });
    expect((await value.send({ method: 'POST', path: '/api/runtimes/rescan', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(400);
    expect((await value.send({ method: 'POST', path: `/api/bindings/rt_${'%62'.repeat(32)}/disable`, headers })).status).toBe(404);
    const wrongMethod = await value.send({ method: 'POST', path: '/api/runtimes', headers });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.allow).toBe('GET');
    expect(value.api.calls).toEqual([]);
  });

  it('bounds request bodies and rejects unsafe response additions without leaking them', async () => {
    const value = await harness();
    const session = await browserSession(value);
    const headers = { Cookie: session.cookie, Origin: value.origin, 'X-Quukk-CSRF': session.csrf, 'Content-Type': 'application/json' };
    const large = await value.send({ method: 'POST', path: '/api/bindings/enable', headers, body: `{"runtimeIds":["${'x'.repeat(70_000)}"]}` });
    expect(large.status).toBe(413);
    const secret = 'SECRET_TOKEN_SENTINEL';
    value.api.runtimes = vi.fn(async () => ({ ...runtimes, tokenRef: secret })) as never;
    const response = await value.send({ path: '/api/runtimes', headers: { Cookie: session.cookie } });
    expect(response.status).toBe(500);
    expect(response.body).not.toContain(secret);
  });

  it('accepts 256-character runtime versions in runtimes and diagnostics responses', async () => {
    const value = await harness();
    const session = await browserSession(value);
    const version = 'v'.repeat(256);
    value.api.runtimes = vi.fn(async () => ({
      ...runtimes,
      runtimes: runtimes.runtimes.map((runtime, index) => index === 0
        ? { ...runtime, version }
        : runtime),
    })) as never;
    value.api.diagnostics = vi.fn(async () => ({
      ...diagnostics,
      runtimes: diagnostics.runtimes.map((runtime) => ({ ...runtime, version })),
    })) as never;
    const headers = { Cookie: session.cookie };
    const runtimeResponse = await value.send({ path: '/api/runtimes', headers });
    expect(runtimeResponse.status).toBe(200);
    expect((runtimeResponse.json as RuntimesResponse).runtimes[0]!.version).toBe(version);
    const diagnosticsResponse = await value.send({ path: '/api/diagnostics', headers });
    expect(diagnosticsResponse.status).toBe(200);
    expect((diagnosticsResponse.json as DiagnosticsResponse).runtimes[0]!.version).toBe(version);
  });

  it('consumes a valid ticket before session creation and maps route timeouts safely', async () => {
    class FailingSessionStore extends BrowserSessionStore {
      override create(): { cookieValue: string; csrfToken: string; expiresInMs: number } {
        throw new Error('SECRET_SESSION_FAILURE');
      }
    }
    const failing = await harness({ sessions: new FailingSessionStore() });
    const { ticket } = failing.tickets.issue();
    const exchange = () => failing.send({
      method: 'POST', path: '/api/session/exchange',
      headers: { Origin: failing.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket }),
    });
    expect((await exchange()).status).toBe(500);
    expect((await exchange()).json).toEqual({
      error: { code: 'ticket_invalid', category: 'authentication', retryable: false },
    });

    let aborted = false;
    const timeoutHarness = await harness({
      setTimeout: ((callback: (...args: unknown[]) => void) => {
        queueMicrotask(callback);
        return 1 as never;
      }) as unknown as typeof globalThis.setTimeout,
      clearTimeout: (() => undefined) as typeof globalThis.clearTimeout,
    });
    const session = await browserSession(timeoutHarness);
    timeoutHarness.api.runtimes = ((signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('aborted'));
      }, { once: true });
    })) as never;
    const timedOut = await timeoutHarness.send({
      path: '/api/runtimes', headers: { Cookie: session.cookie },
    });
    expect(timedOut.status).toBe(504);
    expect(timedOut.json).toEqual({
      error: { code: 'operation_timeout', category: 'transport', retryable: true },
    });
    expect(aborted).toBe(true);
  });
});

describe('LocalRoutes internal control boundary', () => {
  const auth = { Authorization: `Bearer ${CONTROL_CREDENTIAL}`, 'Content-Type': 'application/json' };

  it('authenticates before parsing and rejects every browser-only header', async () => {
    const value = await harness();
    const unauthorized = await value.send({
      method: 'POST', path: '/internal/control',
      headers: { Authorization: `Bearer ${'x'.repeat(43)}`, 'Content-Type': 'text/plain' },
      body: 'not-json',
    });
    expect(unauthorized.status).toBe(401);
    expect(value.control.calls).toEqual([]);
    const forbiddenHeaders: Record<string, string>[] = [
      { Origin: value.origin }, { Referer: value.origin }, { Cookie: 'x=y' }, { 'Sec-Fetch-Site': 'same-origin' },
    ];
    for (const forbidden of forbiddenHeaders) {
      const denied = await value.send({ method: 'POST', path: '/internal/control', headers: { ...auth, ...forbidden }, body: '{"command":"status"}' });
      expect(denied.status).toBe(400);
    }
    expect(value.control.calls).toEqual([]);
  });

  it('provides only the four fixed commands and defers shutdown until the response finishes', async () => {
    const value = await harness();
    const send = (command: string) => value.send({ method: 'POST', path: '/internal/control', headers: auth, body: JSON.stringify({ command }) });
    const statusResponse = await send('status');
    expect(statusResponse.status).toBe(200);
    expect(statusResponse.json).toEqual(status);
    const ticket = await send('launch_ticket');
    expect(ticket.status).toBe(201);
    expect(ticket.json).toEqual({ schemaVersion: 1, ticket: expect.stringMatching(/^[\w-]{43}$/), expiresAt: expect.any(Number) });
    expect((await send('rescan')).json).toEqual(runtimes);
    const shutdown = await send('shutdown');
    expect(shutdown.status).toBe(202);
    expect(shutdown.json).toEqual({ schemaVersion: 1, accepted: true });
    await new Promise((resolve) => setImmediate(resolve));
    expect(value.control.calls).toEqual(['status', 'rescan', 'shutdown']);

    const invalid = await send('health');
    expect(invalid.status).toBe(400);
    expect(value.control.calls).toEqual(['status', 'rescan', 'shutdown']);
  });

  it('rejects wrong content type, oversized internal JSON, and extra command keys', async () => {
    const value = await harness();
    expect((await value.send({ method: 'POST', path: '/internal/control', headers: { ...auth, 'Content-Type': 'text/plain' }, body: '{}' })).status).toBe(415);
    expect((await value.send({ method: 'POST', path: '/internal/control', headers: auth, body: `{"command":"status","padding":"${'x'.repeat(1024)}"}` })).status).toBe(413);
    expect((await value.send({ method: 'POST', path: '/internal/control', headers: auth, body: '{"command":"status","extra":true}' })).status).toBe(400);
    expect(value.control.calls).toEqual([]);
  });
});
