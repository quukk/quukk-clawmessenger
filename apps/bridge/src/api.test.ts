// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';

import { BridgeApiError, createBridgeApi, createBridgeApiProvider } from './api';
import type { BridgeApi } from './types';

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
    const replaceUrl = vi.fn();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response({ csrf_token: 'c'.repeat(32) }))
      .mockResolvedValueOnce(response({ results: [] }));
    const api = createBridgeApi({
      fetch,
      href: 'http://127.0.0.1:48321/?ticket=one-use-secret&view=setup#local',
      replaceUrl,
    });

    expect(replaceUrl).toHaveBeenCalledWith('/?view=setup#local');
    await api.enableBindings([]);

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      '/api/session/exchange',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ ticket: 'one-use-secret' }),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      '/api/bindings/enable',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'X-CSRF-Token': 'c'.repeat(32) }),
      }),
    );
  });

  it('allows read-only diagnostics with an existing cookie but rejects mutation without CSRF', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
      response({ status: 'ok', generated_at: '2026-08-27T00:00:00Z' }),
    );
    const api = createBridgeApi({
      fetch,
      href: 'http://127.0.0.1:48321/',
      replaceUrl: vi.fn(),
    });

    await expect(api.getDiagnostics()).resolves.toMatchObject({ status: 'ok' });
    await expect(api.disableBinding('rt_1')).rejects.toEqual(
      expect.objectContaining<Partial<BridgeApiError>>({ code: 'session_required' }),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
