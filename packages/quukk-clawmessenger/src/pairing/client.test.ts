// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

import { PairingClient, PairingClientError } from './client.js';
import type { PairingCandidate } from './schema.js';

const SERVER = 'https://configured.example/base';
const TICKET = 't'.repeat(43);
const DEVICE_SECRET = 's'.repeat(43);
const ABUSE_KEY = 'a'.repeat(64);
const IDEMPOTENCY_KEY = 'pairing-create-session-0001';
const EXPIRES_AT = '2026-09-02T12:05:00.000Z';
const candidate: PairingCandidate = {
  candidateId: 'cand-opencode',
  provider: 'opencode',
  displayName: 'OpenCode',
  version: '1.2.3',
  readiness: 'ready',
  statusReason: null,
  registrationState: 'unregistered',
};

function jsonResponse(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sessionEnvelope(): unknown {
  return {
    code: 201,
    data: {
      ticket: TICKET,
      deviceSecret: DEVICE_SECRET,
      expiresAt: EXPIRES_AT,
      status: 'waiting',
      candidates: [candidate],
    },
  };
}

describe('PairingClient', () => {
  it('creates a session through a fixed route with bounded sanitized input headers', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(201, sessionEnvelope()));
    const client = new PairingClient({ serverUrl: SERVER, fetch: fetchSpy });

    const session = await client.createSession({
      installAbuseKey: ABUSE_KEY,
      idempotencyKey: IDEMPOTENCY_KEY,
      candidates: [candidate],
    });

    expect(session.ticket).toBe(TICKET);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(`${SERVER}/api/ai/pairing/sessions`);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual' });
    const headers = new Headers(init?.headers);
    expect(headers.get('x-install-abuse-key')).toBe(ABUSE_KEY);
    expect(headers.get('idempotency-key')).toBe(IDEMPOTENCY_KEY);
    expect(headers.get('authorization')).toBeNull();
    expect(JSON.parse(String(init?.body))).toEqual({ candidates: [candidate] });
  });

  it('puts the private secret only in Authorization and never a query string', async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse(200, {
        code: 200,
        data: {
          status: 'claimed',
          selectedCandidateIds: ['cand-opencode'],
          candidates: [candidate],
          expiresAt: EXPIRES_AT,
        },
      }),
    );
    const client = new PairingClient({ serverUrl: SERVER, fetch: fetchSpy });

    await expect(client.pollSelection(TICKET, DEVICE_SECRET)).resolves.toMatchObject({
      selectedCandidateIds: ['cand-opencode'],
    });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(`${SERVER}/api/ai/pairing/sessions/${TICKET}/selection`);
    expect(url).not.toContain(DEVICE_SECRET);
    expect(url).not.toContain('?');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Pairing ${DEVICE_SECRET}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual' });
  });

  it('cancels with device authorization and idempotency in headers only', async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse(200, {
        code: 200,
        data: {
          status: 'cancelled',
          selectedCandidateIds: [],
          candidates: [candidate],
          expiresAt: EXPIRES_AT,
        },
      }),
    );
    const client = new PairingClient({ serverUrl: SERVER, fetch: fetchSpy });

    await expect(
      client.cancelSession(TICKET, DEVICE_SECRET, 'pairing-cancel-session-0001'),
    ).resolves.toMatchObject({ status: 'cancelled' });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(`${SERVER}/api/ai/pairing/sessions/${TICKET}`);
    expect(init).toMatchObject({ method: 'DELETE', redirect: 'manual' });
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe(`Pairing ${DEVICE_SECRET}`);
    expect(headers.get('idempotency-key')).toBe('pairing-cancel-session-0001');
    expect(init?.body).toBeUndefined();
  });

  it('never puts pairing credentials in a URL or loggable error', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error(`upstream leaked ${TICKET} ${DEVICE_SECRET}`);
    });
    const client = new PairingClient({
      serverUrl: SERVER,
      fetch: fetchSpy,
      sleep: async () => undefined,
    });

    const error = await client.pollSelection(TICKET, DEVICE_SECRET).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'pairing_transport', retryable: true });
    expect(error).toBeInstanceOf(PairingClientError);
    expect(String(error)).not.toMatch(new RegExp(`${TICKET}|${DEVICE_SECRET}`));
    expect(JSON.stringify(error)).not.toMatch(new RegExp(`${TICKET}|${DEVICE_SECRET}`));
    expect(fetchSpy.mock.calls[0]![0]).not.toContain(DEVICE_SECRET);
    expect(JSON.stringify(fetchSpy.mock.calls[0]![1])).not.toContain(`?ticket=${TICKET}`);
  });

  it('uses bounded retries, manual redirects, and stable status errors without response bodies', async () => {
    const fetchSpy = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('PRIVATE_BODY', { status: 503 }))
      .mockResolvedValueOnce(new Response('PRIVATE_BODY', { status: 503 }));
    const sleep = vi.fn(async () => undefined);
    const client = new PairingClient({ serverUrl: SERVER, fetch: fetchSpy, sleep, random: () => 0 });

    const error = await client.pollSelection(TICKET, DEVICE_SECRET).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'pairing_transport', retryable: true });
    expect(String(error)).not.toContain('PRIVATE_BODY');
    expect(JSON.stringify(error)).not.toContain('PRIVATE_BODY');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(250);
    expect(fetchSpy.mock.calls.every(([, init]) => init?.redirect === 'manual')).toBe(true);
  });

  it.each([
    [401, 'pairing_unauthorized', false],
    [409, 'pairing_conflict', false],
    [410, 'pairing_expired', false],
    [429, 'pairing_rate_limited', true],
  ] as const)('normalizes HTTP %i without parsing the body', async (status, code, retryable) => {
    const fetchSpy = vi.fn(async () => new Response('PRIVATE_BODY', { status }));
    const client = new PairingClient({ serverUrl: SERVER, fetch: fetchSpy });

    await expect(client.pollSelection(TICKET, DEVICE_SECRET)).rejects.toMatchObject({
      code,
      retryable,
    });
  });

  it('rejects oversized and structurally invalid success responses', async () => {
    const oversized = vi.fn(async () => jsonResponse(200, { code: 200, data: 'x'.repeat(70_000) }));
    const invalid = vi.fn(async () =>
      jsonResponse(200, {
        code: 200,
        data: {
          status: 'claimed',
          selectedCandidateIds: [],
          candidates: [{ ...candidate, runtimePath: 'C:\\private' }],
          expiresAt: EXPIRES_AT,
        },
      }),
    );

    await expect(
      new PairingClient({ serverUrl: SERVER, fetch: oversized }).pollSelection(TICKET, DEVICE_SECRET),
    ).rejects.toMatchObject({ code: 'pairing_response_invalid' });
    await expect(
      new PairingClient({ serverUrl: SERVER, fetch: invalid }).pollSelection(TICKET, DEVICE_SECRET),
    ).rejects.toMatchObject({ code: 'pairing_response_invalid' });
  });

  it('times out, retries once, and supports caller cancellation', async () => {
    vi.useFakeTimers();
    try {
      const never = vi.fn(
        async (_url: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          }),
      );
      const client = new PairingClient({
        serverUrl: SERVER,
        fetch: never,
        sleep: async () => undefined,
        timeoutMs: 100,
      });
      const pending = client.pollSelection(TICKET, DEVICE_SECRET);
      const rejection = expect(pending).rejects.toMatchObject({ code: 'pairing_timeout' });
      await vi.advanceTimersByTimeAsync(250);
      await rejection;
      expect(never).toHaveBeenCalledTimes(2);

      const controller = new AbortController();
      controller.abort();
      await expect(client.pollSelection(TICKET, DEVICE_SECRET, controller.signal)).rejects.toMatchObject({
        code: 'pairing_cancelled',
        retryable: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('validates credentials and idempotency before transport', async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    const client = new PairingClient({ serverUrl: SERVER, fetch: fetchSpy });

    await expect(client.pollSelection('short', DEVICE_SECRET)).rejects.toMatchObject({
      code: 'pairing_rejected',
    });
    await expect(client.pollSelection(TICKET, 'short')).rejects.toMatchObject({
      code: 'pairing_rejected',
    });
    await expect(client.cancelSession(TICKET, DEVICE_SECRET, 'short')).rejects.toMatchObject({
      code: 'pairing_rejected',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
