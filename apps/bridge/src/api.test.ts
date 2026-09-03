// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';

import { BridgeApiError, createBridgeApi, createBridgeApiProvider } from './api';
import type { BridgeApi } from './types';

const runtimeId = `rt_${'1'.repeat(32)}`;
const pairingResponse = {
  schemaVersion: 2 as const,
  state: 'waiting' as const,
  expiresAt: '2099-09-02T10:05:00.000Z',
  pairingCode: 'ABCDEF23',
  qrContent: JSON.stringify({
    type: 'clawmessenger_pairing',
    version: 1,
    server: 'https://configured.example',
    ticket: 'p'.repeat(43),
    expiresAt: Date.parse('2099-09-02T10:05:00.000Z'),
  }),
  candidates: [
    {
      candidateId: 'cand-a',
      provider: 'opencode' as const,
      displayName: 'OpenCode',
      version: '1.2.3',
      readiness: 'ready' as const,
      statusReason: null,
      registrationState: 'unregistered' as const,
    },
  ],
  results: [],
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function settingsResponse(effectiveServerUrl: string) {
  const stored = {
    schemaVersion: 1 as const,
    serverUrl: 'https://stored.example/im',
    defaultWorkdir: null,
    authorizedWorkRoots: ['C:\\work'],
    providerPathOverrides: {},
    logLevel: 'info' as const,
  };
  return {
    schemaVersion: 1 as const,
    stored,
    effective: { ...stored, serverUrl: effectiveServerUrl },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('local bridge API client', () => {
  it('uses the exact pairing routes and strictly parses every response', async () => {
    const ticket = 't'.repeat(43);
    const csrfToken = 'c'.repeat(43);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        response({ schemaVersion: 1, csrfToken, expiresInMs: 28_800_000 }),
      )
      .mockResolvedValueOnce(response(settingsResponse('https://configured.example')))
      .mockResolvedValueOnce(response(pairingResponse))
      .mockResolvedValueOnce(response({
        ...pairingResponse, state: 'claimed', pairingCode: null, qrContent: null,
      }))
      .mockResolvedValueOnce(response({
        ...pairingResponse, state: 'cancelled', pairingCode: null, qrContent: null,
      }))
      .mockResolvedValueOnce(response({
        ...pairingResponse, state: 'processing', pairingCode: null, qrContent: null,
      }));
    const api = createBridgeApi({
      fetch,
      href: `http://127.0.0.1:48321/#ticket=${ticket}`,
      replaceUrl: vi.fn(),
    });

    await api.getSettings();
    await expect(api.startPairing()).resolves.toMatchObject({ state: 'waiting' });
    await expect(api.getPairing()).resolves.toMatchObject({ state: 'claimed' });
    await expect(api.cancelPairing()).resolves.toMatchObject({ state: 'cancelled' });
    await expect(api.retryPairing(['cand-a'])).resolves.toMatchObject({ state: 'processing' });

    expect(fetch).toHaveBeenNthCalledWith(
      3,
      '/api/pairing/session',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      4,
      '/api/pairing/session',
      expect.objectContaining({ credentials: 'same-origin' }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      5,
      '/api/pairing/session',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      6,
      '/api/pairing/session/retry',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ candidateIds: ['cand-a'] }),
      }),
    );
  });

  it('rejects extra sensitive pairing fields and inconsistent candidate results', async () => {
    const invalidResponses = [
      { ...pairingResponse, deviceSecret: 's'.repeat(43) },
      {
        ...pairingResponse,
        qrContent: JSON.stringify({
          ...JSON.parse(pairingResponse.qrContent),
          deviceSecret: 's'.repeat(43),
        }),
      },
      {
        ...pairingResponse,
        qrContent: JSON.stringify({
          ...JSON.parse(pairingResponse.qrContent),
          server: 'https://user:password@configured.example?token=secret',
        }),
      },
      { ...pairingResponse, candidates: [pairingResponse.candidates[0], pairingResponse.candidates[0]] },
      {
        ...pairingResponse,
        results: [
          {
            candidateId: 'cand-unknown',
            status: 'failed',
            errorCode: 'runtime_unavailable',
            nodeId: null,
            retryable: true,
          },
        ],
      },
    ];

    for (const body of invalidResponses) {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(response(settingsResponse('https://configured.example')))
        .mockResolvedValueOnce(response(body));
      const api = createBridgeApi({
        fetch,
        href: 'http://127.0.0.1:48321/',
        replaceUrl: vi.fn(),
      });
      await api.getSettings();
      await expect(api.getPairing()).rejects.toMatchObject({ code: 'invalid_response' });
    }
  });

  it('accepts only the normalized configured pairing server base', async () => {
    const cases = [
      { server: 'https://configured.example/im', accepted: true },
      { server: 'https://attacker.example/im', accepted: false },
      { server: 'https://configured.example/attacker', accepted: false },
      { server: 'https://configured.example:444/im', accepted: false },
    ];

    for (const testCase of cases) {
      const qrContent = JSON.stringify({
        ...JSON.parse(pairingResponse.qrContent),
        server: testCase.server,
      });
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(response(settingsResponse('https://configured.example/im/')))
        .mockResolvedValueOnce(response({ ...pairingResponse, qrContent }));
      const api = createBridgeApi(
        {
          fetch,
          href: 'http://127.0.0.1:48321/',
          replaceUrl: vi.fn(),
        },
        { now: () => Date.parse('2026-09-02T10:00:00.000Z') },
      );

      await api.getSettings();
      const result = api.getPairing();
      if (testCase.accepted) {
        await expect(result).resolves.toMatchObject({ state: 'waiting' });
      } else {
        await expect(result).rejects.toMatchObject({ code: 'invalid_response' });
      }
    }
  });

  it('rejects a waiting snapshot whose QR has reached its deadline', async () => {
    const expiry = '2026-09-02T10:05:00.000Z';
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response(settingsResponse('https://configured.example/im')))
      .mockResolvedValueOnce(
        response({
          ...pairingResponse,
          expiresAt: expiry,
          qrContent: JSON.stringify({
            ...JSON.parse(pairingResponse.qrContent),
            expiresAt: Date.parse(expiry),
          }),
        }),
      );
    const api = createBridgeApi(
      {
        fetch,
        href: 'http://127.0.0.1:48321/',
        replaceUrl: vi.fn(),
      },
      { now: () => Date.parse(expiry) },
    );

    await api.getSettings();
    await expect(api.getPairing()).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('projects pairing candidates without free-form local display data', async () => {
    const candidates = [
      {
        ...pairingResponse.candidates[0],
        displayName: 'API key: abc123',
        version: 'token=secret',
        statusReason: 'C:\\private\\runtime-id.txt',
      },
      {
        ...pairingResponse.candidates[0],
        candidateId: 'cand-b',
        provider: 'codex' as const,
        displayName: 'rt_deadbeef',
        version: '1.2.3',
        statusReason: 'needs_auth',
        readiness: 'not_ready' as const,
      },
    ];
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response(settingsResponse('https://configured.example/im')))
      .mockResolvedValueOnce(
        response({
          ...pairingResponse,
          qrContent: JSON.stringify({
            ...JSON.parse(pairingResponse.qrContent),
            server: 'https://configured.example/im',
          }),
          candidates,
        }),
      );
    const api = createBridgeApi(
      {
        fetch,
        href: 'http://127.0.0.1:48321/',
        replaceUrl: vi.fn(),
      },
      { now: () => Date.parse('2026-09-02T10:00:00.000Z') },
    );

    await api.getSettings();
    const snapshot = await api.getPairing();
    expect(snapshot.candidates).toEqual([
      {
        candidateId: 'cand-a',
        provider: 'opencode',
        version: null,
        readiness: 'ready',
        statusReason: null,
        registrationState: 'unregistered',
      },
      {
        candidateId: 'cand-b',
        provider: 'codex',
        version: '1.2.3',
        readiness: 'not_ready',
        statusReason: 'needs_auth',
        registrationState: 'unregistered',
      },
    ]);
    expect(JSON.stringify(snapshot)).not.toMatch(/API key|abc123|token=secret|runtime-id|rt_deadbeef/u);
  });

  it('creates one browser API instance when React probes a render twice', () => {
    const api = {} as BridgeApi;
    const factory = vi.fn(() => api);
    const provideApi = createBridgeApiProvider(factory);

    expect(provideApi()).toBe(api);
    expect(provideApi()).toBe(api);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('scrubs the one-use ticket before exchange and sends CSRF on mutations', async () => {
    const ticket = 't'.repeat(43);
    const csrfToken = 'c'.repeat(43);
    const replaceUrl = vi.fn();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        response({ schemaVersion: 1, csrfToken, expiresInMs: 28_800_000 }),
      )
      .mockResolvedValueOnce(response({ schemaVersion: 1, results: [] }));
    const api = createBridgeApi({
      fetch,
      href: `http://127.0.0.1:48321/setup?view=ignored#ticket=${ticket}`,
      replaceUrl,
    });

    expect(replaceUrl).toHaveBeenCalledWith('/setup');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(replaceUrl.mock.invocationCallOrder[0]).toBeLessThan(fetch.mock.invocationCallOrder[0]!);
    await api.enableBindings([runtimeId]);

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      '/api/session/exchange',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ ticket }),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      '/api/bindings/enable',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ runtimeIds: [runtimeId] }),
        headers: expect.objectContaining({ 'X-Quukk-CSRF': csrfToken }),
      }),
    );
  });

  it('parses the exact local-service runtime, settings, activity, and diagnostics DTOs', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        response({
          schemaVersion: 1,
          runtimes: [
            {
              provider: 'opencode',
              runtimeId,
              version: '1.2.3',
              path: 'C:\\tools\\opencode.exe',
              status: 'ready',
              capabilities: {
                sessionResume: true,
                cancel: true,
                textEvents: true,
                toolEvents: true,
                approvalEvents: false,
              },
              binding: {
                runtimeId,
                nodeId: 'opencode_node',
                nodeName: 'OpenCode',
                enabled: true,
                registrationState: 'online',
                updatedAt: '2026-08-27T00:00:00.000Z',
              },
              worker: { state: 'online', restartCount: 0 },
            },
            ...(['openclaw', 'codex', 'hermes'] as const).map((provider) => ({
              provider,
              runtimeId: null,
              version: null,
              path: null,
              status: 'not_found',
              capabilities: {
                sessionResume: false,
                cancel: false,
                textEvents: false,
                toolEvents: false,
                approvalEvents: false,
              },
              binding: null,
              worker: null,
            })),
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({
          schemaVersion: 1,
          stored: {
            schemaVersion: 1,
            serverUrl: 'https://example.test/im',
            defaultWorkdir: null,
            authorizedWorkRoots: ['C:\\work'],
            providerPathOverrides: {},
            logLevel: 'info',
          },
          effective: {
            schemaVersion: 1,
            serverUrl: 'https://override.example/im',
            defaultWorkdir: null,
            authorizedWorkRoots: ['C:\\work'],
            providerPathOverrides: {},
            logLevel: 'debug',
          },
        }),
      )
      .mockResolvedValueOnce(
        response({
          schemaVersion: 1,
          events: [
            {
              id: 7,
              time: '2026-08-27T00:00:00.000Z',
              level: 'info',
              event: 'binding_online',
              runtimeId,
              provider: 'opencode',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({
          schemaVersion: 1,
          service: {
            version: '0.1.0-beta.1',
            state: 'ready',
            pid: 123,
            startedAt: '2026-08-27T00:00:00.000Z',
            listenHost: '127.0.0.1',
            port: 48321,
            uptimeMs: 10,
          },
          bridge: { state: 'ready' },
          runtimes: [],
          workers: [],
          warnings: ['config recovery required'],
          logging: { dropped: 0, retained: 1 },
        }),
      );
    const api = createBridgeApi({
      fetch,
      href: 'http://127.0.0.1:48321/',
      replaceUrl: vi.fn(),
    });

    const runtimes = await api.getRuntimes();
    expect(runtimes).toHaveLength(4);
    expect(runtimes[0]).toMatchObject({
      id: runtimeId,
      provider: 'opencode',
      binding: { enabled: true, registrationState: 'online' },
      worker: { state: 'online', restartCount: 0 },
    });
    await expect(api.getSettings()).resolves.toMatchObject({
      serverUrl: 'https://example.test/im',
      logLevel: 'info',
    });
    await expect(api.getActivity()).resolves.toEqual([
      expect.objectContaining({ id: 7, kind: 'info', summary: 'binding_online' }),
    ]);
    await expect(api.getDiagnostics()).resolves.toMatchObject({
      schemaVersion: 1,
      service: { state: 'ready', port: 48321 },
      warnings: ['config recovery required'],
    });
  });

  it('accepts producer-bounded natural-language activity records', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
      response({
        schemaVersion: 1,
        events: [
          {
            id: 1,
            time: '2026-08-27T08:00:00+08:00',
            level: 'info',
            event: 'registration completed safely',
            taskId: 't'.repeat(256),
            count: Number.MAX_SAFE_INTEGER,
            durationMs: Number.MAX_SAFE_INTEGER,
          },
          {
            id: Number.MAX_SAFE_INTEGER,
            time: '2026-08-27T08:01:00+08:00',
            level: 'warn',
            event: 'worker connection restored',
          },
        ],
      }),
    );
    const api = createBridgeApi({
      fetch,
      href: 'http://127.0.0.1:48321/',
      replaceUrl: vi.fn(),
    });

    await expect(api.getActivity()).resolves.toEqual([
      expect.objectContaining({ id: 1, summary: 'registration completed safely' }),
      expect.objectContaining({
        id: Number.MAX_SAFE_INTEGER,
        summary: 'worker connection restored',
      }),
    ]);
  });

  it('rejects activity records outside the exact producer invariants', async () => {
    const valid = {
      id: 1,
      time: '2026-08-27T08:00:00+08:00',
      level: 'info',
      event: 'binding_online',
    };
    const payloads = [
      [{ ...valid, id: 0 }],
      [{ ...valid, time: '2026-08-27 08:00:00' }],
      [{ ...valid, count: Number.MAX_SAFE_INTEGER + 1 }],
      [{ ...valid, durationMs: Number.MAX_SAFE_INTEGER + 1 }],
      [{ ...valid, id: 2 }, valid],
    ];
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => response({ schemaVersion: 1, events: payloads.shift() }));
    const api = createBridgeApi({
      fetch,
      href: 'http://127.0.0.1:48321/',
      replaceUrl: vi.fn(),
    });

    for (let index = 0; index < 5; index += 1) {
      await expect(api.getActivity()).resolves.toEqual([]);
    }
  });

  it('fails closed when runtime and nested identities disagree', async () => {
    const otherRuntimeId = `rt_${'2'.repeat(32)}`;
    const capabilities = {
      sessionResume: true,
      cancel: true,
      textEvents: true,
      toolEvents: true,
      approvalEvents: false,
    };
    const binding = {
      runtimeId,
      nodeId: 'opencode_node',
      nodeName: 'OpenCode',
      enabled: true,
      registrationState: 'online',
      updatedAt: '2026-08-27T00:00:00.000Z',
    };
    const missing = (provider: 'openclaw' | 'codex' | 'hermes') => ({
      provider,
      runtimeId: null,
      version: null,
      path: null,
      status: 'not_found',
      capabilities,
      binding: null,
      worker: null,
    });
    const payloads = [
      {
        provider: 'opencode',
        runtimeId,
        version: '1.0.0',
        path: 'C:\\tools\\opencode.exe',
        status: 'ready',
        capabilities,
        binding: { ...binding, runtimeId: otherRuntimeId },
        worker: { state: 'online', restartCount: 0 },
      },
      {
        provider: 'opencode',
        runtimeId: null,
        version: null,
        path: null,
        status: 'not_found',
        capabilities,
        binding,
        worker: null,
      },
      {
        provider: 'opencode',
        runtimeId: null,
        version: null,
        path: null,
        status: 'not_found',
        capabilities,
        binding: null,
        worker: { state: 'online', restartCount: 0 },
      },
    ];
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () =>
      response({
        schemaVersion: 1,
        runtimes: [payloads.shift(), missing('openclaw'), missing('codex'), missing('hermes')],
      }),
    );
    const api = createBridgeApi({
      fetch,
      href: 'http://127.0.0.1:48321/',
      replaceUrl: vi.fn(),
    });

    for (let index = 0; index < 3; index += 1) {
      await expect(api.getRuntimes()).resolves.toEqual([]);
    }
  });

  it('maps an uncorrelated enable result set to per-request invalid_response failures', async () => {
    const otherRuntimeId = `rt_${'2'.repeat(32)}`;
    const failure = (id: string) => ({
      runtimeId: id,
      ok: false as const,
      error: { code: 'registration_transport', category: 'transport', retryable: true },
    });
    const mismatchedSuccess = {
      runtimeId,
      ok: true as const,
      binding: {
        runtimeId: otherRuntimeId,
        nodeId: 'openclaw_node',
        nodeName: 'OpenClaw',
        enabled: true,
        registrationState: 'online',
        updatedAt: '2026-08-27T00:00:00.000Z',
      },
    };

    async function enable(
      requested: readonly string[],
      results: readonly unknown[],
    ): Promise<unknown> {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(
          response({
            schemaVersion: 1,
            csrfToken: 'c'.repeat(43),
            expiresInMs: 28_800_000,
          }),
        )
        .mockResolvedValueOnce(response({ schemaVersion: 1, results }));
      const api = createBridgeApi({
        fetch,
        href: `http://127.0.0.1:48321/#ticket=${'t'.repeat(43)}`,
        replaceUrl: vi.fn(),
      });
      return api.enableBindings(requested);
    }

    const cases = [
      { requested: [runtimeId], results: [mismatchedSuccess] },
      { requested: [runtimeId, otherRuntimeId], results: [failure(runtimeId)] },
      {
        requested: [runtimeId, otherRuntimeId],
        results: [failure(runtimeId), failure(runtimeId)],
      },
      { requested: [runtimeId], results: [failure(runtimeId), failure(otherRuntimeId)] },
    ];
    for (const testCase of cases) {
      await expect(enable(testCase.requested, testCase.results)).resolves.toEqual(
        testCase.requested.map((id) => ({
          runtimeId: id,
          ok: false,
          errorCode: 'invalid_response',
        })),
      );
    }
  });

  it('rejects malformed or mismatched reregister success responses', async () => {
    const otherRuntimeId = `rt_${'2'.repeat(32)}`;
    const responses = [
      {
        schemaVersion: 1,
        binding: {
          runtimeId,
          nodeId: 'opencode_node',
          enabled: true,
          registrationState: 'online',
          updatedAt: '2026-08-27T00:00:00.000Z',
        },
      },
      {
        schemaVersion: 1,
        binding: {
          runtimeId: otherRuntimeId,
          nodeId: 'openclaw_node',
          nodeName: 'OpenClaw',
          enabled: true,
          registrationState: 'online',
          updatedAt: '2026-08-27T00:00:00.000Z',
        },
      },
    ];

    for (const body of responses) {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(
          response({
            schemaVersion: 1,
            csrfToken: 'c'.repeat(43),
            expiresInMs: 28_800_000,
          }),
        )
        .mockResolvedValueOnce(response(body));
      const api = createBridgeApi({
        fetch,
        href: `http://127.0.0.1:48321/#ticket=${'t'.repeat(43)}`,
        replaceUrl: vi.fn(),
      });

      await expect(api.reregisterBinding(runtimeId)).rejects.toMatchObject({
        code: 'invalid_response',
      });
    }
  });

  it('reads the structured error envelope without exposing server details', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
      response(
        {
          error: {
            code: 'bridge_unavailable',
            category: 'transport',
            retryable: true,
          },
        },
        503,
      ),
    );
    const api = createBridgeApi({
      fetch,
      href: 'http://127.0.0.1:48321/',
      replaceUrl: vi.fn(),
    });

    await expect(api.getDiagnostics()).rejects.toMatchObject({ code: 'bridge_unavailable' });
  });

  it('sends empty mutations without a body and wraps the exact StoredConfig write shape', async () => {
    const ticket = 't'.repeat(43);
    const csrfToken = 'c'.repeat(43);
    const settings = {
      serverUrl: 'https://example.test/im',
      defaultWorkdir: null,
      authorizedWorkRoots: ['C:\\work'],
      providerPathOverrides: {},
      logLevel: 'info' as const,
    };
    const stored = { schemaVersion: 1, ...settings };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        response({ schemaVersion: 1, csrfToken, expiresInMs: 28_800_000 }),
      )
      .mockResolvedValueOnce(response({ schemaVersion: 1, runtimes: [] }))
      .mockResolvedValueOnce(
        response({ schemaVersion: 1, stored, effective: stored }),
      );
    const api = createBridgeApi({
      fetch,
      href: `http://127.0.0.1:48321/#ticket=${ticket}`,
      replaceUrl: vi.fn(),
    });

    await api.rescanRuntimes();
    await api.updateSettings(settings);

    const rescanInit = fetch.mock.calls[1]?.[1];
    expect(rescanInit?.body).toBeUndefined();
    expect(new Headers(rescanInit?.headers).has('Content-Type')).toBe(false);
    expect(new Headers(rescanInit?.headers).get('X-Quukk-CSRF')).toBe(csrfToken);
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      '/api/settings',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ settings: stored }),
      }),
    );
  });

  it('never exchanges a query ticket or a malformed fragment ticket', async () => {
    const queryFetch = vi.fn<typeof globalThis.fetch>();
    const queryReplaceUrl = vi.fn();
    const queryApi = createBridgeApi({
      fetch: queryFetch,
      href: `http://127.0.0.1:48321/setup?ticket=${'q'.repeat(43)}`,
      replaceUrl: queryReplaceUrl,
    });

    await expect(queryApi.enableBindings([])).rejects.toMatchObject({
      code: 'session_required',
    });
    expect(queryFetch).not.toHaveBeenCalled();
    expect(queryReplaceUrl).not.toHaveBeenCalled();

    const fragmentFetch = vi.fn<typeof globalThis.fetch>();
    const fragmentReplaceUrl = vi.fn();
    const fragmentApi = createBridgeApi({
      fetch: fragmentFetch,
      href: 'http://127.0.0.1:48321/setup#ticket=too-short',
      replaceUrl: fragmentReplaceUrl,
    });

    expect(fragmentReplaceUrl).toHaveBeenCalledWith('/setup');
    await expect(fragmentApi.enableBindings([])).rejects.toMatchObject({
      code: 'session_required',
    });
    expect(fragmentFetch).not.toHaveBeenCalled();
  });

  it('allows read-only diagnostics with an existing cookie but rejects mutation without CSRF', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
      response({
        schemaVersion: 1,
        service: {
          version: '0.1.0-beta.1',
          state: 'ready',
          pid: 123,
          startedAt: '2026-08-27T00:00:00Z',
          listenHost: '127.0.0.1',
          port: 48321,
          uptimeMs: 1_000,
        },
        bridge: { state: 'ready' },
        runtimes: [],
        workers: [],
        warnings: [],
        logging: { dropped: 0, retained: 0 },
      }),
    );
    const api = createBridgeApi({
      fetch,
      href: 'http://127.0.0.1:48321/',
      replaceUrl: vi.fn(),
    });

    await expect(api.getDiagnostics()).resolves.toMatchObject({
      service: { state: 'ready' },
    });
    await expect(api.disableBinding('rt_1')).rejects.toEqual(
      expect.objectContaining<Partial<BridgeApiError>>({ code: 'session_required' }),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
