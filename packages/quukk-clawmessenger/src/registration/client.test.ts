import type { NetworkInterfaceInfo } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CLAWMESSENGER_NODE_CAPABILITIES } from './capabilities.js';
import {
  RegistrationClient,
  RegistrationError,
  type RefreshInput,
  type RegistrationInput,
} from './client.js';
import type { PairingRegistrationAuthorization } from '../pairing/schema.js';

const INSTALL_A = '123e4567-e89b-42d3-a456-426614174000';
const INSTALL_B = '123e4567-e89b-42d3-b456-426614174001';
const BRIDGE_SECRET = 'A'.repeat(43);
const RUNTIME_A = `rt_${'a'.repeat(32)}`;
const RUNTIME_B = `rt_${'b'.repeat(32)}`;
const CAPABILITIES = [
  'discussion_host',
  'discussion_participant',
  'artifact_markdown',
  'artifact_html',
  'discussion_roundtable',
  'discussion_model_routing',
  'discussion_role_recommendation',
] as const;

type FetchCall = { url: string; init: RequestInit };
type FetchStep = Response | Error | ((url: string, init: RequestInit) => Promise<Response>);

function fakeFetch(...steps: FetchStep[]) {
  const calls: FetchCall[] = [];
  const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = input instanceof Request ? input.url : input.toString();
    calls.push({ url, init });
    const step = steps.shift();
    if (step === undefined) throw new Error('unexpected fetch');
    if (step instanceof Error) throw step;
    return typeof step === 'function' ? step(url, init) : step;
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

function headers(call: FetchCall): Record<string, string> {
  return Object.fromEntries(new Headers(call.init.headers).entries());
}

function body(call: FetchCall): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function cancellableResponse(status: number, onCancel: () => void): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      cancel() {
        onCancel();
      },
    }),
    { status },
  );
}

function interruptedJsonResponse(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"code":'));
        controller.error(new TypeError('interrupted response stream'));
      },
    }),
    { status: 200 },
  );
}

function successEnvelope(provider: string, nodeId = `${provider}_123`, overrides: Record<string, unknown> = {}) {
  return {
    code: 200,
    message: 'server fields outside data are allowed',
    data: {
      node_id: nodeId,
      node_type: provider,
      name: 'server nickname',
      token: 'rongcloud-token',
      capabilities: [...CAPABILITIES],
      app_key: 'ignored-refresh-echo',
      unknown_data_field: true,
      ...overrides,
    },
    unknown_envelope_field: true,
  };
}

function registrationInput(overrides: Partial<RegistrationInput> = {}): RegistrationInput {
  return {
    serverUrl: 'https://example.test/im/',
    installId: INSTALL_A,
    runtimeId: RUNTIME_A,
    bridgeSecret: BRIDGE_SECRET,
    provider: 'codex',
    nodeName: 'fixture-host · Codex',
    ...overrides,
  };
}

function pairingAuthorization(
  overrides: Partial<PairingRegistrationAuthorization> = {},
): PairingRegistrationAuthorization {
  return {
    ticket: 'T'.repeat(43),
    deviceSecret: 'S'.repeat(43),
    candidateId: 'candidate_codex',
    idempotencyKey: 'pairing-candidate-attempt-1',
    ...overrides,
  };
}

function refreshInput(overrides: Partial<RefreshInput> = {}): RefreshInput {
  return {
    serverUrl: 'https://example.test/im/',
    runtimeId: RUNTIME_A,
    bridgeSecret: BRIDGE_SECRET,
    provider: 'codex',
    nodeId: 'codex_123',
    nodeName: 'fixture-host · Codex',
    ...overrides,
  };
}

function interfaces(entries: Partial<NetworkInterfaceInfo>[]): ReturnType<typeof import('node:os').networkInterfaces> {
  return {
    Ethernet: entries.map(
      (entry) =>
        ({
          address: '192.0.2.1',
          netmask: '255.255.255.0',
          family: 'IPv4' as const,
          mac: '00:00:00:00:00:00',
          internal: false,
          cidr: '192.0.2.1/24',
          ...entry,
        }) as NetworkInterfaceInfo,
    ),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('RegistrationClient', () => {
  it('publishes the one literal ordered seven-capability protocol tuple', () => {
    expect(CLAWMESSENGER_NODE_CAPABILITIES).toEqual(CAPABILITIES);
  });

  it.each(['opencode', 'openclaw', 'codex', 'hermes'] as const)(
    'sends exact %s node identity fields and accepts only its prefix',
    async (provider) => {
      const transport = fakeFetch(jsonResponse(successEnvelope(provider)));
      const client = new RegistrationClient({
        fetch: transport.fetch,
        networkInterfaces: () => interfaces([{ mac: '00-11-22-33-44-55' }]),
      });

      const result = await client.register(
        registrationInput({
          provider,
          runtimeId: `rt_${({ opencode: 'a', openclaw: 'b', codex: 'c', hermes: 'd' } as const)[provider].repeat(32)}`,
        }),
      );

      expect(body(transport.calls[0]!)).toEqual({
        name: 'fixture-host · Codex',
        mac_address: '00:11:22:33:44:55',
        node_type: provider,
        ai_type: provider,
        capabilities: [...CAPABILITIES],
      });
      expect(result.nodeId).toBe(`${provider}_123`);
    },
  );

  it('omits node_id for new identity and includes an existing ID unchanged', async () => {
    const transport = fakeFetch(
      jsonResponse(successEnvelope('codex', 'codex_new')),
      jsonResponse(successEnvelope('codex', 'codex_existing')),
    );
    const client = new RegistrationClient({ fetch: transport.fetch, networkInterfaces: () => ({}) });

    await client.register(registrationInput());
    await client.register(registrationInput({ existingNodeId: 'codex_existing' }));

    expect(body(transport.calls[0]!)).not.toHaveProperty('node_id');
    expect(body(transport.calls[1]!)).toHaveProperty('node_id', 'codex_existing');
  });

  it('preserves the submitted node name and the /im base path while allowing unknown response fields', async () => {
    const transport = fakeFetch(jsonResponse(successEnvelope('codex')));
    const client = new RegistrationClient({ fetch: transport.fetch, networkInterfaces: () => ({}) });

    const result = await client.register(registrationInput());

    expect(transport.calls[0]?.url).toBe('https://example.test/im/api/ai/register');
    expect(transport.calls[0]?.init.method).toBe('POST');
    expect(transport.calls[0]?.init.redirect).toBe('manual');
    expect(headers(transport.calls[0]!)).toMatchObject({
      accept: 'application/json',
      'content-type': 'application/json',
    });
    expect(result).toEqual({
      nodeId: 'codex_123',
      nodeName: 'fixture-host · Codex',
      token: 'rongcloud-token',
    });
  });

  it('uses only pairing authorization for credential-bearing selected candidate registration', async () => {
    const transport = fakeFetch(jsonResponse(successEnvelope('codex')));
    const client = new RegistrationClient({ fetch: transport.fetch, networkInterfaces: () => ({}) });
    const authorization = pairingAuthorization();

    await client.register(registrationInput({ authorization }));

    expect(transport.calls[0]?.url).toBe(
      `https://example.test/im/api/ai/pairing/sessions/${authorization.ticket}`
      + `/candidates/${authorization.candidateId}/register`,
    );
    expect(headers(transport.calls[0]!)).toMatchObject({
      authorization: `Pairing ${authorization.deviceSecret}`,
      'idempotency-key': authorization.idempotencyKey,
    });
    expect(headers(transport.calls[0]!)).not.toHaveProperty('x-node-enrollment-token');
    expect(body(transport.calls[0]!)).toEqual({
      provider: 'codex',
      name: 'fixture-host · Codex',
      mac_address: '32:01:59:EB:E3:21',
      capabilities: [...CAPABILITIES],
    });
    expect(JSON.stringify(body(transport.calls[0]!))).not.toContain(authorization.ticket);
    expect(JSON.stringify(body(transport.calls[0]!))).not.toContain(authorization.deviceSecret);
  });

  it('rejects malformed pairing registration context before transport', async () => {
    const transport = fakeFetch(jsonResponse(successEnvelope('codex')));
    const client = new RegistrationClient({ fetch: transport.fetch, networkInterfaces: () => ({}) });

    await expect(client.register(registrationInput({
      authorization: pairingAuthorization({ deviceSecret: 'short' }),
    }))).rejects.toMatchObject({ code: 'registration_rejected', retryable: false });
    expect(transport.calls).toEqual([]);
  });

  it('normalizes, filters, deduplicates, and globally prefers hardware MAC addresses', async () => {
    const transport = fakeFetch(jsonResponse(successEnvelope('codex')));
    const client = new RegistrationClient({
      fetch: transport.fetch,
      networkInterfaces: () =>
        interfaces([
          { mac: '02-aa-bb-cc-dd-ee' },
          { mac: '01:01:01:01:01:01' },
          { mac: '00:00:00:00:00:00' },
          { mac: '00-AA-BB-CC-DD-FF' },
          { mac: '00:aa:bb:cc:dd:ff' },
          { mac: '00:11:22:33:44:55', internal: true },
        ]),
    });

    await client.register(registrationInput());
    expect(body(transport.calls[0]!).mac_address).toBe('00:AA:BB:CC:DD:FF');
  });

  it('derives stable locally administered unicast MACs from the install ID', async () => {
    const transport = fakeFetch(
      jsonResponse(successEnvelope('codex')),
      jsonResponse(successEnvelope('codex')),
      jsonResponse(successEnvelope('codex')),
    );
    const client = new RegistrationClient({ fetch: transport.fetch, networkInterfaces: () => ({}) });

    await client.register(registrationInput({ installId: INSTALL_A }));
    await client.register(registrationInput({ installId: INSTALL_A }));
    await client.register(registrationInput({ installId: INSTALL_B }));

    expect(transport.calls.map((call) => body(call).mac_address)).toEqual([
      '32:01:59:EB:E3:21',
      '32:01:59:EB:E3:21',
      '02:32:BE:34:33:8D',
    ]);
  });

  it('uses the decoded 32-byte secret for deterministic runtime-and-server-scoped enrollment headers', async () => {
    const transport = fakeFetch(
      jsonResponse(successEnvelope('codex')),
      jsonResponse(successEnvelope('codex')),
      jsonResponse(successEnvelope('codex')),
    );
    const client = new RegistrationClient({ fetch: transport.fetch, networkInterfaces: () => ({}) });

    await client.register(registrationInput());
    await client.register(registrationInput({ serverUrl: 'https://example.test/other', runtimeId: RUNTIME_A }));
    await client.register(registrationInput({ runtimeId: RUNTIME_B }));

    expect(transport.calls.map((call) => headers(call)['x-node-enrollment-token'])).toEqual([
      'qce_v1_MX_0f7vTy4WeQ0Uuh5DsnK2JnMiSF4ZhLbfaaQywSIo',
      'qce_v1_OxqyU6bfW5NP_X9tfMOSKGXHB3A-pJ1_1ybDeqd90xo',
      'qce_v1_E_4rKe9v7zODifR09RPH33BSJrscGaGvZZHaAmjIfDU',
    ]);
    const serializedRequests = JSON.stringify(transport.calls.map((call) => ({
      url: call.url,
      headers: headers(call),
      body: body(call),
    })));
    expect(serializedRequests).not.toContain(BRIDGE_SECRET);
  });

  it('sends an optional old credential only as an exact redacted Bearer claim', async () => {
    const transport = fakeFetch(jsonResponse(successEnvelope('codex', 'codex_existing')));
    const client = new RegistrationClient({ fetch: transport.fetch, networkInterfaces: () => ({}) });

    await client.register(
      registrationInput({
        existingNodeId: 'codex_existing',
        existingNodeToken: 'SENTINEL_OLD_TOKEN',
      }),
    );

    expect(headers(transport.calls[0]!).authorization).toBe('Bearer SENTINEL_OLD_TOKEN');
    expect(JSON.stringify(body(transport.calls[0]!))).not.toContain('SENTINEL_OLD_TOKEN');
    expect(transport.calls[0]?.url).not.toContain('SENTINEL_OLD_TOKEN');
  });

  it('gets only the public AppKey route and rejects every fallback shape', async () => {
    const transport = fakeFetch(
      jsonResponse({ code: 200, data: { appKey: 'public-app-key', dataCenter: 'ignored' }, extra: true }),
      jsonResponse({ code: 200, data: { dataCenter: 'missing' } }),
    );
    const client = new RegistrationClient({ fetch: transport.fetch });

    await expect(client.getAppKey('https://example.test/im/')).resolves.toBe('public-app-key');
    expect(transport.calls[0]).toMatchObject({
      url: 'https://example.test/im/api/config/rongcloud',
      init: { method: 'GET' },
    });
    expect(headers(transport.calls[0]!)).toEqual({ accept: 'application/json' });
    await expect(client.getAppKey('https://example.test/im/')).rejects.toMatchObject({
      code: 'app_key_unavailable',
      category: 'registration',
      retryable: false,
    });
  });

  it('validates permanent AppKey failures without retrying', async () => {
    for (const response of [
      jsonResponse({ code: 400, data: { appKey: 'ignored' } }),
      jsonResponse({ code: 200, data: { appKey: ' untrimmed ' } }),
      jsonResponse({ code: 200, data: { appKey: 'x'.repeat(257) } }),
      new Response('{malformed', { status: 200 }),
      jsonResponse({ code: 400 }, 400),
    ]) {
      const transport = fakeFetch(response);
      const client = new RegistrationClient({ fetch: transport.fetch });
      await expect(client.getAppKey('https://example.test/im')).rejects.toMatchObject({
        code: 'app_key_unavailable',
        retryable: false,
      });
      expect(transport.calls).toHaveLength(1);
    }
  });

  it.each([
    ['business code', { code: 409, data: successEnvelope('codex').data }, 'registration_rejected'],
    ['malformed JSON', '{malformed', 'registration_response_invalid'],
    ['wrong node type', successEnvelope('openclaw', 'openclaw_123'), 'registration_node_mismatch'],
    ['unsafe node suffix', successEnvelope('codex', 'codex_bad/value'), 'registration_node_mismatch'],
    ['empty token', successEnvelope('codex', 'codex_123', { token: '' }), 'registration_response_invalid'],
    ['oversized token', successEnvelope('codex', 'codex_123', { token: 'x'.repeat(16385) }), 'registration_response_invalid'],
    ['invalid name', successEnvelope('codex', 'codex_123', { name: ' untrimmed ' }), 'registration_response_invalid'],
    ['reordered capabilities', successEnvelope('codex', 'codex_123', { capabilities: [...CAPABILITIES].reverse() }), 'registration_capabilities_mismatch'],
  ] as const)('rejects %s registration responses with stable code %s', async (_name, payload, code) => {
    const response = typeof payload === 'string' ? new Response(payload, { status: 200 }) : jsonResponse(payload);
    const transport = fakeFetch(response);
    const client = new RegistrationClient({ fetch: transport.fetch, networkInterfaces: () => ({}) });

    await expect(client.register(registrationInput())).rejects.toMatchObject({ code, retryable: false });
    expect(transport.calls).toHaveLength(1);
  });

  it('requires exact returned node equality when reusing an existing identity', async () => {
    const transport = fakeFetch(jsonResponse(successEnvelope('codex', 'codex_other')));
    const client = new RegistrationClient({ fetch: transport.fetch, networkInterfaces: () => ({}) });
    await expect(
      client.register(registrationInput({ existingNodeId: 'codex_existing' })),
    ).rejects.toMatchObject({
      code: 'registration_node_mismatch',
      category: 'validation',
      retryable: false,
    });
  });

  it('uses the encoded refresh route, exact body, exact node echo, and ignores app_key echo', async () => {
    const transport = fakeFetch(jsonResponse(successEnvelope('codex', 'codex_a-b')));
    const client = new RegistrationClient({ fetch: transport.fetch });

    const result = await client.refreshToken(refreshInput({ nodeId: 'codex_a-b' }));

    expect(transport.calls[0]?.url).toBe('https://example.test/im/api/claw/refresh-token/codex_a-b');
    expect(body(transport.calls[0]!)).toEqual({
      name: 'fixture-host · Codex',
      capabilities: [...CAPABILITIES],
    });
    expect(result).toEqual({
      nodeId: 'codex_a-b',
      nodeName: 'fixture-host · Codex',
      token: 'rongcloud-token',
    });
    expect(JSON.stringify(result)).not.toContain('ignored-refresh-echo');
  });

  it('rejects refresh node changes and maps permanent refresh failures separately', async () => {
    const mismatch = fakeFetch(jsonResponse(successEnvelope('codex', 'codex_other')));
    await expect(
      new RegistrationClient({ fetch: mismatch.fetch }).refreshToken(refreshInput()),
    ).rejects.toMatchObject({ code: 'registration_node_mismatch' });

    for (const response of [jsonResponse({ code: 409 }, 409), jsonResponse({ code: 409 })]) {
      const transport = fakeFetch(response);
      await expect(
        new RegistrationClient({ fetch: transport.fetch }).refreshToken(refreshInput()),
      ).rejects.toMatchObject({
        code: 'token_refresh_failed',
        category: 'registration',
        retryable: false,
      });
      expect(transport.calls).toHaveLength(1);
    }
  });

  it('accepts a valid body at exactly 65,536 bytes and rejects one byte more', async () => {
    const json = JSON.stringify(successEnvelope('codex'));
    const exact = `${json}${' '.repeat(65_536 - Buffer.byteLength(json))}`;
    const overflow = `${exact} `;
    const transport = fakeFetch(
      new Response(exact, { status: 200 }),
      new Response(overflow, { status: 200 }),
    );
    const client = new RegistrationClient({ fetch: transport.fetch, networkInterfaces: () => ({}) });

    await expect(client.register(registrationInput())).resolves.toMatchObject({ nodeId: 'codex_123' });
    await expect(client.register(registrationInput())).rejects.toMatchObject({
      code: 'registration_response_invalid',
      retryable: false,
    });
  });

  it.each([408, 425, 500, 502, 503, 504])(
    'retries transient HTTP %s exactly once with a stable semantic request',
    async (status) => {
      const transport = fakeFetch(
        jsonResponse({ code: status }, status),
        jsonResponse(successEnvelope('codex')),
      );
      const delays: number[] = [];
      const client = new RegistrationClient({
        fetch: transport.fetch,
        networkInterfaces: () => ({}),
        random: () => 0.5,
        sleep: async (milliseconds) => {
          delays.push(milliseconds);
        },
      });

      await client.register(registrationInput());
      expect(transport.calls).toHaveLength(2);
      expect(body(transport.calls[1]!)).toEqual(body(transport.calls[0]!));
      expect(headers(transport.calls[1]!)['x-node-enrollment-token']).toBe(
        headers(transport.calls[0]!)['x-node-enrollment-token'],
      );
      expect(delays).toEqual([375]);
    },
  );

  it.each([
    [302, 'registration_rejected'],
    [400, 'registration_rejected'],
    [401, 'registration_unauthorized'],
    [429, 'registration_transport'],
  ] as const)('cancels an unread infinite HTTP %s body before returning %s', async (status, code) => {
    let cancellations = 0;
    const transport = fakeFetch(cancellableResponse(status, () => cancellations += 1));
    const client = new RegistrationClient({ fetch: transport.fetch, networkInterfaces: () => ({}) });

    await expect(client.register(registrationInput())).rejects.toMatchObject({ code });
    expect(cancellations).toBe(1);
    expect(transport.calls).toHaveLength(1);
  });

  it('cancels a transient unread body before retrying the same semantic request', async () => {
    let cancellations = 0;
    const delays: number[] = [];
    const transport = fakeFetch(
      cancellableResponse(503, () => cancellations += 1),
      jsonResponse(successEnvelope('codex')),
    );
    const client = new RegistrationClient({
      fetch: transport.fetch,
      networkInterfaces: () => ({}),
      random: () => 0.5,
      sleep: async (milliseconds) => delays.push(milliseconds),
    });

    await expect(client.register(registrationInput())).resolves.toMatchObject({ nodeId: 'codex_123' });
    expect(cancellations).toBe(1);
    expect(delays).toEqual([375]);
    expect(body(transport.calls[1]!)).toEqual(body(transport.calls[0]!));
    expect(headers(transport.calls[1]!)['x-node-enrollment-token']).toBe(
      headers(transport.calls[0]!)['x-node-enrollment-token'],
    );
  });

  it('retries an interrupted 200 stream once and clears both attempt timers', async () => {
    vi.useFakeTimers();
    const delays: number[] = [];
    const transport = fakeFetch(interruptedJsonResponse(), jsonResponse(successEnvelope('codex')));
    const client = new RegistrationClient({
      fetch: transport.fetch,
      networkInterfaces: () => ({}),
      random: () => 0.5,
      sleep: async (milliseconds) => delays.push(milliseconds),
    });

    await expect(client.register(registrationInput())).resolves.toMatchObject({ nodeId: 'codex_123' });
    expect(transport.calls).toHaveLength(2);
    expect(delays).toEqual([375]);
    expect(body(transport.calls[1]!)).toEqual(body(transport.calls[0]!));
    expect(transport.calls.every((call) => call.init.redirect === 'manual')).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries one network failure but returns a retryable transport error after exhaustion', async () => {
    const recovered = fakeFetch(new TypeError('network down'), jsonResponse(successEnvelope('codex')));
    await expect(
      new RegistrationClient({
        fetch: recovered.fetch,
        networkInterfaces: () => ({}),
        sleep: async () => undefined,
      }).register(registrationInput()),
    ).resolves.toMatchObject({ nodeId: 'codex_123' });
    expect(recovered.calls).toHaveLength(2);

    const exhausted = fakeFetch(new TypeError('first'), new TypeError('second'));
    await expect(
      new RegistrationClient({
        fetch: exhausted.fetch,
        networkInterfaces: () => ({}),
        sleep: async () => undefined,
      }).register(registrationInput()),
    ).rejects.toMatchObject({
      code: 'registration_transport',
      category: 'transport',
      retryable: true,
    });
  });

  it('does not automatically retry 429 without Retry-After but keeps the class retryable', async () => {
    const transport = fakeFetch(jsonResponse({ code: 429 }, 429));
    await expect(
      new RegistrationClient({ fetch: transport.fetch, networkInterfaces: () => ({}) }).register(
        registrationInput(),
      ),
    ).rejects.toMatchObject({
      code: 'registration_transport',
      category: 'transport',
      retryable: true,
    });
    expect(transport.calls).toHaveLength(1);
  });

  it.each([401, 403])('maps HTTP %s to non-retryable authentication failure', async (status) => {
    const transport = fakeFetch(jsonResponse({ code: status }, status));
    await expect(
      new RegistrationClient({ fetch: transport.fetch, networkInterfaces: () => ({}) }).register(
        registrationInput(),
      ),
    ).rejects.toMatchObject({
      code: 'registration_unauthorized',
      category: 'authentication',
      retryable: false,
    });
    expect(transport.calls).toHaveLength(1);
  });

  it.each([400, 404, 409, 422])('does not retry permanent registration HTTP %s', async (status) => {
    const transport = fakeFetch(jsonResponse({ code: status }, status));
    await expect(
      new RegistrationClient({ fetch: transport.fetch, networkInterfaces: () => ({}) }).register(
        registrationInput(),
      ),
    ).rejects.toMatchObject({ code: 'registration_rejected', retryable: false });
    expect(transport.calls).toHaveLength(1);
  });

  it('distinguishes caller cancellation from an exhausted per-attempt timeout', async () => {
    const abortingFetch = async (_input: string | URL | Request, init: RequestInit = {}) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const cancelledClient = new RegistrationClient({
      fetch: abortingFetch as typeof globalThis.fetch,
      networkInterfaces: () => ({}),
      timeoutMs: 1000,
      sleep: async () => undefined,
    });
    const controller = new AbortController();
    const cancelled = cancelledClient.register(registrationInput(), controller.signal);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({
      code: 'registration_cancelled',
      category: 'transport',
      retryable: false,
    });

    vi.useFakeTimers();
    const timedClient = new RegistrationClient({
      fetch: abortingFetch as typeof globalThis.fetch,
      networkInterfaces: () => ({}),
      timeoutMs: 10,
      sleep: async () => undefined,
    });
    const timed = timedClient.register(registrationInput());
    const timedAssertion = expect(timed).rejects.toMatchObject({
      code: 'registration_timeout',
      category: 'transport',
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(25);
    await timedAssertion;
  });

  it('returns only stable redacted RegistrationError output', async () => {
    const response = jsonResponse({
      code: 409,
      message: 'SENTINEL_RESPONSE_BODY',
      data: { token: 'SENTINEL_RESPONSE_TOKEN', appKey: 'SENTINEL_RESPONSE_APP_KEY' },
    });
    const transport = fakeFetch(response);
    const client = new RegistrationClient({ fetch: transport.fetch, networkInterfaces: () => ({}) });
    let caught: unknown;
    try {
      await client.register(
        registrationInput({
          nodeName: 'SENTINEL_NODE_NAME',
          existingNodeToken: 'SENTINEL_OLD_TOKEN',
        }),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RegistrationError);
    expect(caught).toMatchObject({
      code: 'registration_rejected',
      category: 'registration',
      retryable: false,
    });
    const output = `${String(caught)}\n${JSON.stringify(caught)}\n${(caught as Error).stack}`;
    for (const sentinel of [
      'SENTINEL_RESPONSE_BODY',
      'SENTINEL_RESPONSE_TOKEN',
      'SENTINEL_RESPONSE_APP_KEY',
      'SENTINEL_NODE_NAME',
      'SENTINEL_OLD_TOKEN',
      BRIDGE_SECRET,
      INSTALL_A,
    ]) {
      expect(output).not.toContain(sentinel);
    }
    expect(JSON.parse(JSON.stringify(caught))).toEqual({
      code: 'registration_rejected',
      category: 'registration',
      retryable: false,
    });
  });

  it('rejects invalid server URLs before any request with the stable validation error', async () => {
    const transport = fakeFetch(jsonResponse(successEnvelope('codex')));
    const client = new RegistrationClient({ fetch: transport.fetch, networkInterfaces: () => ({}) });
    await expect(
      client.register(registrationInput({ serverUrl: 'http://public.example/im' })),
    ).rejects.toMatchObject({
      code: 'invalid_server_url',
      category: 'validation',
      retryable: false,
    });
    expect(transport.calls).toHaveLength(0);
  });

  it.each(['https://example.test/im?', 'https://example.test/im#'])(
    'rejects a literal bare URL delimiter before fetch: %s',
    async (serverUrl) => {
      const transport = fakeFetch(jsonResponse(successEnvelope('codex')));
      const client = new RegistrationClient({
        fetch: transport.fetch,
        networkInterfaces: () => ({}),
      });

      await expect(client.register(registrationInput({ serverUrl }))).rejects.toMatchObject({
        code: 'invalid_server_url',
        category: 'validation',
        retryable: false,
      });
      expect(transport.calls).toHaveLength(0);
    },
  );

  it('allows encoded delimiters inside the preserved server base path', async () => {
    const transport = fakeFetch(jsonResponse(successEnvelope('codex')));
    const client = new RegistrationClient({ fetch: transport.fetch, networkInterfaces: () => ({}) });

    await client.register(
      registrationInput({ serverUrl: 'https://example.test/im%3Ftenant%23one/' }),
    );

    expect(transport.calls[0]?.url).toBe(
      'https://example.test/im%3Ftenant%23one/api/ai/register',
    );
  });

  it('rejects a non-canonical bridge secret before any request', async () => {
    const transport = fakeFetch(jsonResponse(successEnvelope('codex')));
    const client = new RegistrationClient({ fetch: transport.fetch, networkInterfaces: () => ({}) });
    await expect(
      client.register(registrationInput({ bridgeSecret: 'B'.repeat(43) })),
    ).rejects.toMatchObject({
      code: 'registration_rejected',
      category: 'validation',
      retryable: false,
    });
    expect(transport.calls).toHaveLength(0);
  });
});
