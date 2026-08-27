// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';

import { BridgeApiError, createBridgeApi, createBridgeApiProvider } from './api';
import type { BridgeApi } from './types';

const runtimeId = `rt_${'1'.repeat(32)}`;

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('local bridge API client', () => {
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
