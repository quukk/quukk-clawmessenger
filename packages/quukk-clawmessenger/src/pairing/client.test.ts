// @vitest-environment node

import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { PairingClient, PairingClientError } from './client.js';
import type { PairingCandidate } from './schema.js';

const SERVER = 'https://configured.example/base';
const TICKET = 't'.repeat(43);
const DEVICE_SECRET = 's'.repeat(43);
const ABUSE_KEY = 'a'.repeat(64);
const IDEMPOTENCY_KEY = 'pairing-create-session-0001';
const EXPIRES_AT = '2099-09-02T12:05:00.000Z';
const terminalErrorVectors = (JSON.parse(
  readFileSync(new URL('../protocol/fixtures/pairing-v1.json', import.meta.url), 'utf8'),
) as {
  valid: {
    deviceTerminalErrors: Array<{
      name: string;
      httpStatus: number;
      body: { code: number; error: string };
      expectedPackageCode: string;
    }>;
  };
}).valid.deviceTerminalErrors;
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

function sessionV2Envelope(): unknown {
  return {
    code: 201,
    data: {
      ticket: TICKET,
      deviceSecret: DEVICE_SECRET,
      pairingCode: 'ABCDEF23',
      expiresAt: new Date(Date.now() + 599_000).toISOString(),
      status: 'waiting',
      candidates: [],
    },
  };
}

describe('PairingClient', () => {
  it('creates a v2 session through the exact endpoint and headers', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(201, sessionV2Envelope()));
    const client = new PairingClient({ serverUrl: SERVER, fetch: fetchSpy });
    const session = await client.createSessionV2({
      installAbuseKey: ABUSE_KEY,
      idempotencyKey: IDEMPOTENCY_KEY,
      candidates: [],
    });
    expect(session.pairingCode).toBe('ABCDEF23');
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(`${SERVER}/api/ai/pairing/v2/sessions`);
    expect(JSON.parse(String(init?.body))).toEqual({ candidates: [] });
    const headers = new Headers(init?.headers);
    expect(headers.get('x-install-abuse-key')).toBe(ABUSE_KEY);
    expect(headers.get('idempotency-key')).toBe(IDEMPOTENCY_KEY);
  });

  it('preserves the server pairing-unavailable error', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(503, {
      code: 503,
      error: 'pairing_unavailable',
    }));
    const client = new PairingClient({ serverUrl: SERVER, fetch: fetchSpy });
    await expect(client.createSessionV2({
      installAbuseKey: ABUSE_KEY,
      idempotencyKey: IDEMPOTENCY_KEY,
      candidates: [],
    })).rejects.toMatchObject({ code: 'pairing_unavailable', retryable: true });
  });
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

  it('polls a strict retry request and treats an empty queue as no work', async () => {
    const fetchSpy = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(200, {
        code: 200,
        data: { requestId: 'retry-request-0001', candidateIds: ['cand-opencode'] },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new PairingClient({ serverUrl: SERVER, fetch: fetchSpy });

    await expect(client.pollRetry(TICKET, DEVICE_SECRET)).resolves.toEqual({
      requestId: 'retry-request-0001',
      candidateIds: ['cand-opencode'],
    });
    await expect(client.pollRetry(TICKET, DEVICE_SECRET)).resolves.toBeNull();

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(`${SERVER}/api/ai/pairing/sessions/${TICKET}/retry`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual' });
    expect(new Headers(init?.headers).get('authorization')).toBe(`Pairing ${DEVICE_SECRET}`);
  });

  it('acknowledges retry through the device channel without putting credentials in the URL', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(200, {
      code: 200,
      data: { requestId: 'retry-request-0001', candidateIds: ['cand-opencode'] },
    }));
    const client = new PairingClient({ serverUrl: SERVER, fetch: fetchSpy });

    await expect(client.ackRetry(
      TICKET,
      DEVICE_SECRET,
      'retry-request-0001',
      'retry-ack-key-0001',
    )).resolves.toMatchObject({ requestId: 'retry-request-0001' });

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(`${SERVER}/api/ai/pairing/sessions/${TICKET}/retry/retry-request-0001/ack`);
    expect(url).not.toContain(DEVICE_SECRET);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', body: '{}' });
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe(`Pairing ${DEVICE_SECRET}`);
    expect(headers.get('idempotency-key')).toBe('retry-ack-key-0001');
  });

  it('rejects unsafe retry delivery fields, duplicates, and invalid request IDs', async () => {
    const unsafe = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(200, {
        code: 200,
        data: {
          requestId: 'retry-request-0001',
          candidateIds: ['cand-opencode'],
          runtimePath: 'C:\\private',
        },
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        code: 200,
        data: {
          requestId: 'retry-request-0001',
          candidateIds: ['cand-opencode', 'cand-opencode'],
        },
      }));
    const client = new PairingClient({ serverUrl: SERVER, fetch: unsafe });

    await expect(client.pollRetry(TICKET, DEVICE_SECRET)).rejects.toMatchObject({
      code: 'pairing_response_invalid',
    });
    await expect(client.pollRetry(TICKET, DEVICE_SECRET)).rejects.toMatchObject({
      code: 'pairing_response_invalid',
    });
    await expect(client.ackRetry(TICKET, DEVICE_SECRET, 'short', 'retry-ack-key-0001'))
      .rejects.toMatchObject({ code: 'pairing_rejected' });
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
    [429, 'pairing_rate_limited', true],
  ] as const)('normalizes HTTP %i without parsing the body', async (status, code, retryable) => {
    const fetchSpy = vi.fn(async () => new Response('PRIVATE_BODY', { status }));
    const client = new PairingClient({ serverUrl: SERVER, fetch: fetchSpy });

    await expect(client.pollSelection(TICKET, DEVICE_SECRET)).rejects.toMatchObject({
      code,
      retryable,
    });
  });

  it.each(terminalErrorVectors)(
    'strictly distinguishes canonical remote $name terminal errors',
    async ({ httpStatus, body, expectedPackageCode }) => {
    const fetchSpy = vi.fn(async () => jsonResponse(httpStatus, body));
    const client = new PairingClient({ serverUrl: SERVER, fetch: fetchSpy });

    await expect(client.pollRetry(TICKET, DEVICE_SECRET)).rejects.toMatchObject({
      code: expectedPackageCode,
      retryable: false,
    });
    },
  );

  it('rejects malformed terminal error DTOs without retaining sensitive fields', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(410, {
      code: 410,
      error: 'session_cancelled',
      deviceSecret: 'private-device-secret',
    }));
    const client = new PairingClient({ serverUrl: SERVER, fetch: fetchSpy });

    const error = await client.pollRetry(TICKET, DEVICE_SECRET).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'pairing_response_invalid', retryable: false });
    expect(JSON.stringify(error)).not.toContain('private-device-secret');
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

  it('rejects an expired success response using the current clock', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-02T12:00:00.000Z'));
    try {
      const fetchSpy = vi.fn(async () =>
        jsonResponse(201, {
          code: 201,
          data: {
            ...(sessionEnvelope() as { data: Record<string, unknown> }).data,
            expiresAt: '2026-09-02T11:59:59.999Z',
          },
        }),
      );

      await expect(
        new PairingClient({ serverUrl: SERVER, fetch: fetchSpy }).createSession({
          installAbuseKey: ABUSE_KEY,
          idempotencyKey: IDEMPOTENCY_KEY,
          candidates: [candidate],
        }),
      ).rejects.toMatchObject({ code: 'pairing_response_invalid' });
    } finally {
      vi.useRealTimers();
    }
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
