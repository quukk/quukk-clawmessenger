import { TextEncoder } from 'node:util';

import { describe, expect, it, vi } from 'vitest';

import { BridgeClient, BridgeClientError } from './client.js';
import { parseSSE, SSEProtocolError } from './sse.js';
import type { BridgeTaskEvent, BridgeTaskPort } from './types.js';

const encoder = new TextEncoder();
const secret = 'bridge-secret-sentinel';
const taskId = 'task_a_b';
const eventTime = '2026-08-26T08:00:00Z';

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(`${JSON.stringify(value)}\n`, {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

function emptyResponse(status = 202): Response {
  return new Response(null, { status, headers: { 'cache-control': 'no-store' } });
}

function sseResponse(body: BodyInit): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/event-stream',
    },
  });
}

function eventFrame(event: BridgeTaskEvent): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

async function* byteChunks(value: string): AsyncIterable<Uint8Array> {
  for (const byte of encoder.encode(value)) yield Uint8Array.of(byte);
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
}

function started(id = 1): BridgeTaskEvent {
  return { id, type: 'started', task_id: taskId, time: eventTime };
}

function completed(id = 2): BridgeTaskEvent {
  return {
    id,
    type: 'completed',
    task_id: taskId,
    time: eventTime,
    session_id: 'session-new',
    output: 'done',
    status: 'resume_invalidated',
  };
}

function clientWith(
  fetchImpl: typeof fetch,
  options: Partial<ConstructorParameters<typeof BridgeClient>[0]> = {},
): BridgeClient {
  return new BridgeClient({
    baseUrl: 'http://127.0.0.1:49152',
    secret,
    fetch: fetchImpl,
    sleep: async () => undefined,
    ...options,
  });
}

describe('parseSSE', () => {
  it('preserves split UTF-8 and accepts LF/CRLF frames plus heartbeats', async () => {
    const data = JSON.stringify({ ...started(), text: '你好' });
    const input = `: heartbeat\r\nid: 1\r\nevent: started\r\ndata: ${data}\r\n\r\n`;

    await expect(collect(parseSSE(byteChunks(input)))).resolves.toEqual([
      { kind: 'heartbeat' },
      { kind: 'event', id: '1', event: 'started', data },
    ]);
  });

  it('rejects duplicate, unknown, retry, unsafe, and incomplete control fields', async () => {
    const invalid = [
      'id: 1\nid: 1\nevent: started\ndata: {}\n\n',
      'id: 1\nevent: started\ndata: {}\nretry: 1\n\n',
      'id: 1\nevent: started\ndata: {}\nunknown: x\n\n',
      `id: ${Number.MAX_SAFE_INTEGER + 1}\nevent: started\ndata: {}\n\n`,
      'id: 1\nevent: started\ndata: {}',
    ];
    for (const value of invalid) {
      await expect(collect(parseSSE(byteChunks(value)))).rejects.toBeInstanceOf(
        SSEProtocolError,
      );
    }
    await expect(
      collect(parseSSE((async function* () { yield Uint8Array.of(0x3a, 0x20, 0xff, 0x0a); })())),
    ).rejects.toBeInstanceOf(SSEProtocolError);
  });

  it('enforces the 1 MiB encoded frame and data limits', async () => {
    const oversized = `id: 1\nevent: started\ndata: ${'x'.repeat((1 << 20) + 1)}\n\n`;
    await expect(collect(parseSSE(byteChunks(oversized)))).rejects.toMatchObject({
      code: 'sse_frame_too_large',
    });
  });

  it('counts both bytes of CRLF against the encoded frame limit', async () => {
    await expect(collect(parseSSE(byteChunks(`: ${'x'.repeat(28)}\r\n`), 32))).resolves.toEqual([
      { kind: 'heartbeat' },
    ]);
    await expect(
      collect(parseSSE(byteChunks(`: ${'x'.repeat(29)}\r\n`), 32)),
    ).rejects.toMatchObject({ code: 'sse_frame_too_large' });
  });

  it('rejects bare CR in fields, separators, chunk boundaries, and EOF', async () => {
    const data = JSON.stringify(started());
    const inputs: AsyncIterable<Uint8Array>[] = [
      byteChunks(`id: 1\revent: started\ndata: ${data}\n\n`),
      byteChunks(`id: 1\nevent: started\rdata: ${data}\n\n`),
      byteChunks(`id: 1\nevent: started\ndata: ${data}\r\r`),
      byteChunks('id: 1\nevent: started\ndata: ab\rcd\n\n'),
      byteChunks('data: ab\rid: 1\nevent: started\n\n'),
      (async function* () {
        yield encoder.encode('id: 1\r');
        yield encoder.encode(`event: started\ndata: ${data}\n\n`);
      })(),
      byteChunks(': heartbeat\r'),
    ];
    for (const input of inputs) {
      await expect(collect(parseSSE(input))).rejects.toBeInstanceOf(SSEProtocolError);
    }
  });
});

describe('BridgeClient trust boundary', () => {
  it('accepts only the exact numeric IPv4 loopback base', () => {
    const invalid = [
      'https://127.0.0.1:1',
      'http://localhost:1',
      'http://127.0.0.2:1',
      'http://127.0.0.1',
      'http://user@127.0.0.1:1',
      'http://127.0.0.1:1/path',
      'http://127.0.0.1:1/?x=1',
      'http://127.0.0.1:1/#x',
    ];
    for (const baseUrl of invalid) {
      expect(() => new BridgeClient({ baseUrl, secret, fetch: vi.fn() })).toThrowError(
        expect.objectContaining({ code: 'invalid_base_url' }),
      );
    }
  });

  it('injects one bearer without putting it in URL or stable errors', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      calls.push({ url: String(input), init });
      return jsonResponse({ error: 'runtime_not_ready' }, 409);
    });
    const client = clientWith(fetchImpl);

    await expect(
      client.startTask({
        runtimeId: `rt_${'a'.repeat(32)}`,
        conversationKey: 'conversation',
        prompt: 'prompt-secret-sentinel',
        workdir: 'C:\\work',
      }),
    ).rejects.toMatchObject({
      code: 'remote_error',
      status: 409,
      remoteCode: 'runtime_not_ready',
      retryable: false,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://127.0.0.1:49152/v1/tasks');
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe(`Bearer ${secret}`);
    expect(new Headers(calls[0]?.init?.headers).get('accept')).toBe('application/json');
    const error = (await client
      .startTask({ runtimeId: 'bad', conversationKey: 'c', prompt: 'p', workdir: 'x' })
      .catch((caught: unknown) => caught)) as BridgeClientError;
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(error.message).not.toContain(secret);
  });

  it('rejects redirects and an injected cross-origin final response without following either', async () => {
    const redirected = new Response(null, {
      status: 302,
      headers: { location: 'https://attacker.invalid/steal' },
    });
    const fetchImpl = vi.fn<typeof fetch>(async () => redirected);
    const client = clientWith(fetchImpl);
    await expect(client.health()).rejects.toMatchObject({ code: 'redirect_rejected' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe('error');

    const crossOrigin = jsonResponse({
      status: 'ok',
      version: '0.1.0-beta.1',
      pid: 1,
      instance_id: `br_${'a'.repeat(32)}`,
      started_at: eventTime,
      probe_status: 'ready',
    });
    Object.defineProperty(crossOrigin, 'url', { value: 'http://127.0.0.1:9/healthz' });
    await expect(clientWith(vi.fn(async () => crossOrigin)).health()).rejects.toMatchObject({
      code: 'response_origin_mismatch',
    });

    let cancelled = 0;
    const invalidFinalURL = jsonResponse({});
    Object.defineProperty(invalidFinalURL, 'url', { value: 'not a URL' });
    Object.defineProperty(invalidFinalURL, 'body', {
      value: new ReadableStream({ cancel: () => { cancelled += 1; } }),
    });
    await expect(clientWith(vi.fn(async () => invalidFinalURL)).health()).rejects.toMatchObject({
      code: 'response_origin_mismatch',
    });
    expect(cancelled).toBe(1);
  });

  it('strictly validates and bounds JSON responses without exposing their bodies', async () => {
    const malformed = clientWith(
      vi.fn(async () =>
        jsonResponse({
          status: 'ok',
          version: '0.1.0-beta.1',
          pid: 1,
          instance_id: `br_${'a'.repeat(32)}`,
          started_at: eventTime,
          probe_status: 'ready',
          secret,
        }),
      ),
    );
    await expect(malformed.health()).rejects.toMatchObject({ code: 'response_invalid' });

    const huge = clientWith(
      vi.fn(async () =>
        new Response('x'.repeat((1 << 20) + 1), {
          status: 200,
          headers: {
            'cache-control': 'no-store',
            'content-type': 'application/json; charset=utf-8',
          },
        }),
      ),
    );
    const error = (await huge.health().catch((caught: unknown) => caught)) as BridgeClientError;
    expect(error).toMatchObject({ code: 'response_too_large' });
    expect(error.message).not.toContain('xxxxx');

    const malformedError = new Response('{', {
      status: 500,
      headers: {
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
      },
    });
    await expect(clientWith(vi.fn(async () => malformedError)).health()).rejects.toMatchObject({
      code: 'response_invalid',
      retryable: false,
      status: 500,
    });
  });

  it('confines every returned events URL to the validated task ID', async () => {
    const attacks = [
      'https://attacker.invalid/events',
      '//attacker.invalid/events',
      `/v1/tasks/${taskId}/events?secret=x`,
      `/v1/tasks/${taskId}/events#x`,
      '/v1/tasks/../healthz/events',
      `/v1/tasks/${taskId}%2fevil/events`,
      `/v1/tasks/other_a/events`,
    ];
    for (const events_url of attacks) {
      const client = clientWith(vi.fn(async () => jsonResponse({ task_id: taskId, events_url }, 201)));
      await expect(
        client.startTask({
          runtimeId: `rt_${'a'.repeat(32)}`,
          conversationKey: 'conversation',
          prompt: 'hello',
          workdir: 'C:\\work',
        }),
      ).rejects.toMatchObject({ code: 'response_invalid' });
    }
  });

  it('supports the required BridgeTaskPort without requiring AbortSignal', async () => {
    const fetchImpl: typeof fetch = vi.fn(async (_input, init) => {
      if (init?.method === 'POST') return jsonResponse({ task_id: taskId, events_url: `/v1/tasks/${taskId}/events` }, 201);
      throw new Error('unexpected');
    });
    const port: BridgeTaskPort = clientWith(fetchImpl);
    await expect(
      port.startTask({
        runtimeId: `rt_${'a'.repeat(32)}`,
        conversationKey: 'conversation',
        prompt: 'hello',
        workdir: 'C:\\work',
      }),
    ).resolves.toEqual({ taskId, eventsUrl: `/v1/tasks/${taskId}/events` });
  });

  it('classifies an injected request deadline as timeout and clears its timer', async () => {
    const cleared: unknown[] = [];
    const client = clientWith(vi.fn(), {
      setTimeout: ((callback: () => void) => {
        callback();
        return 17 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
      clearTimeout: ((timer: unknown) => {
        cleared.push(timer);
      }) as typeof clearTimeout,
    });
    await expect(client.health()).rejects.toMatchObject({
      code: 'request_timeout',
      retryable: true,
    });
    expect(cleared).toEqual([17]);
  });

  it('cancels an unread response rejected before JSON decoding', async () => {
    let cancelled = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('{}'));
        },
        cancel() {
          cancelled += 1;
        },
      }),
      { status: 200, headers: { 'cache-control': 'no-store', 'content-type': 'text/plain' } },
    );
    await expect(clientWith(vi.fn(async () => response)).health()).rejects.toMatchObject({
      code: 'response_invalid',
    });
    expect(cancelled).toBe(1);

    const remoteBody = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled += 1;
      },
    });
    const invalidRemote = new Response(remoteBody, {
      status: 500,
      headers: { 'cache-control': 'no-store', 'content-type': 'text/plain' },
    });
    await expect(clientWith(vi.fn(async () => invalidRemote)).health()).rejects.toMatchObject({
      code: 'response_invalid',
    });
    expect(cancelled).toBe(2);
  });
});

describe('BridgeClient SSE lifecycle', () => {
  it('validates event identity and preserves session/resume terminals', async () => {
    const offsetStarted = { ...started(), time: '2026-08-26T16:00:00+08:00' };
    const body = eventFrame(offsetStarted) + eventFrame(completed());
    const events = await collect(clientWith(vi.fn(async () => sseResponse(body))).events(taskId));
    expect(events).toEqual([offsetStarted, completed()]);
  });

  it('rejects header/body mismatch, task mismatch, duplicates, backwards IDs, and unexplained gaps', async () => {
    const mismatches = [
      `id: 2\nevent: started\ndata: ${JSON.stringify(started(1))}\n\n`,
      `id: 1\nevent: completed\ndata: ${JSON.stringify(started(1))}\n\n`,
      eventFrame({ ...started(), task_id: 'task_c_d' }),
      eventFrame(started()) + eventFrame(started()),
      eventFrame(started(2)) + eventFrame(started(1)),
      eventFrame(started()) + eventFrame(started(3)),
    ];
    for (const body of mismatches) {
      await expect(
        collect(clientWith(vi.fn(async () => sseResponse(body))).events(taskId)),
      ).rejects.toMatchObject({ code: 'sse_protocol_error' });
    }
  });

  it('allows one replay_overflow jump and then requires contiguous retained events', async () => {
    const overflow: BridgeTaskEvent = {
      id: 9,
      type: 'status',
      task_id: taskId,
      time: eventTime,
      status: 'replay_overflow',
    };
    const body = eventFrame(overflow) + eventFrame(completed(10));
    await expect(
      collect(clientWith(vi.fn(async () => sseResponse(body))).events(taskId, 2)),
    ).resolves.toEqual([overflow, completed(10)]);
  });

  it('reconnects clean EOF and network reads with Last-Event-ID and capped backoff', async () => {
    const delays: number[] = [];
    const requests: RequestInit[] = [];
    let call = 0;
    const fetchImpl: typeof fetch = vi.fn(async (_input, init = {}) => {
      requests.push(init);
      call += 1;
      if (call === 1) return sseResponse(eventFrame(started()));
      if (call === 2) {
        return sseResponse(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error('read-sentinel'));
            },
          }),
        );
      }
      return sseResponse(eventFrame(completed()));
    });
    const client = clientWith(fetchImpl, {
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
      reconnectBaseDelayMs: 1_500,
      reconnectMaximumDelayMs: 2_000,
    });
    await expect(collect(client.events(taskId))).resolves.toEqual([started(), completed()]);
    expect(new Headers(requests[1]?.headers).get('last-event-id')).toBe('1');
    expect(new Headers(requests[2]?.headers).get('last-event-id')).toBe('1');
    expect(delays).toEqual([1_500, 2_000]);
  });

  it('keeps the request deadline through a non-200 SSE error body and cancels it', async () => {
    type Timer = { active: boolean; callback: () => void };
    const timers = new Map<number, Timer>();
    let timerID = 0;
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    let bodyRead!: () => void;
    let cancelled = 0;
    const reading = new Promise<void>((resolve) => { bodyRead = resolve; });
    const hanging = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          bodyController = controller;
        },
        pull() {
          bodyRead();
        },
        cancel() {
          cancelled += 1;
        },
      }),
      {
        status: 500,
        headers: {
          'cache-control': 'no-store',
          'content-type': 'application/json; charset=utf-8',
        },
      },
    );
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(hanging)
      .mockResolvedValueOnce(jsonResponse({ error: 'task_not_found' }, 404));
    const client = clientWith(fetchImpl, {
      setTimeout: ((callback: () => void) => {
        timerID += 1;
        timers.set(timerID, { active: true, callback });
        return timerID as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
      clearTimeout: ((id: unknown) => {
        const timer = timers.get(Number(id));
        if (timer !== undefined) timer.active = false;
      }) as typeof clearTimeout,
    });
    const next = client.events(taskId)[Symbol.asyncIterator]().next();
    const outcome = next.then(
      () => ({ kind: 'resolved' as const }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );
    await reading;
    const firstTimer = timers.get(1)!;
    try {
      expect(firstTimer.active).toBe(true);
      firstTimer.callback();
      await expect(outcome).resolves.toMatchObject({
        kind: 'rejected',
        error: { code: 'remote_error', remoteCode: 'task_not_found' },
      });
      expect(cancelled).toBe(1);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      if (cancelled === 0) bodyController.error(new Error('test cleanup'));
      await outcome;
    }
  });

  it('interrupts reconnect backoff when either lifecycle or call scope aborts', async () => {
    const lifecycle = new AbortController();
    const call = new AbortController();
    let sleepSignal: AbortSignal | undefined;
    let entered!: () => void;
    let release!: () => void;
    const sleeping = new Promise<void>((resolve) => { entered = resolve; });
    const client = clientWith(vi.fn(async () => sseResponse('')), {
      lifecycleSignal: lifecycle.signal,
      sleep: async (_milliseconds, signal) => {
        sleepSignal = signal;
        entered();
        await new Promise<void>((resolve) => { release = resolve; });
      },
    });
    const next = client.events(taskId, undefined, { signal: call.signal })[Symbol.asyncIterator]().next();
    await sleeping;
    lifecycle.abort();
    await Promise.resolve();
    try {
      expect(sleepSignal?.aborted).toBe(true);
    } finally {
      release();
    }
    await expect(next).rejects.toMatchObject({ code: 'request_aborted' });
  });

  it('never reconnects after a terminal event', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => sseResponse(eventFrame(completed(1))));
    await collect(clientWith(fetchImpl).events(taskId));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('cancels the response body on iterator return and lifecycle abort', async () => {
    let cancelled = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(eventFrame(started())));
      },
      cancel() {
        cancelled += 1;
      },
    });
    const iterator = clientWith(vi.fn(async () => sseResponse(stream))).events(taskId)[
      Symbol.asyncIterator
    ]();
    await expect(iterator.next()).resolves.toMatchObject({ value: started(), done: false });
    await iterator.return?.();
    expect(cancelled).toBe(1);

    const lifecycle = new AbortController();
    lifecycle.abort();
    const aborted = clientWith(vi.fn(), { lifecycleSignal: lifecycle.signal });
    await expect(aborted.health()).rejects.toMatchObject({ code: 'request_aborted' });
  });

  it('retries an already-terminal cursor until TTL reports task_not_found', async () => {
    const delays: number[] = [];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sseResponse(''))
      .mockResolvedValueOnce(sseResponse(''))
      .mockResolvedValueOnce(jsonResponse({ error: 'task_not_found' }, 404));
    const client = clientWith(fetchImpl, {
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
      reconnectBaseDelayMs: 100,
      reconnectMaximumDelayMs: 200,
    });
    await expect(collect(client.events(taskId, 7))).rejects.toMatchObject({
      code: 'remote_error',
      remoteCode: 'task_not_found',
      retryable: false,
    });
    expect(delays).toEqual([100, 200]);
    for (const call of fetchImpl.mock.calls) {
      expect(new Headers(call[1]?.headers).get('last-event-id')).toBe('7');
    }
  });

  it('uses the injected idle deadline to cancel and reconnect a silent SSE stream', async () => {
    const timers = new Map<number, { callback: () => void; milliseconds: number }>();
    let timerID = 0;
    const setTimer = ((callback: () => void, milliseconds: number) => {
      timerID += 1;
      timers.set(timerID, { callback, milliseconds });
      return timerID as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    const clearTimer = ((id: unknown) => {
      timers.delete(Number(id));
    }) as typeof clearTimeout;
    let call = 0;
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      call += 1;
      return call === 1
        ? sseResponse(new ReadableStream<Uint8Array>({}))
        : sseResponse(eventFrame(completed(1)));
    });
    const client = clientWith(fetchImpl, {
      setTimeout: setTimer,
      clearTimeout: clearTimer,
      sseIdleTimeoutMs: 45_000,
    });
    const result = collect(client.events(taskId));
    for (let turn = 0; turn < 5 && ![...timers.values()].some((timer) => timer.milliseconds === 45_000); turn += 1) {
      await Promise.resolve();
    }
    const idle = [...timers.values()].find((timer) => timer.milliseconds === 45_000);
    expect(idle).toBeDefined();
    idle!.callback();
    await expect(result).resolves.toEqual([completed(1)]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(timers.size).toBe(0);
  });
});

describe('BridgeClient command routes', () => {
  it('uses empty authenticated bodies for cancel and shutdown and validates health', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      calls.push({ url: String(input), init });
      if (String(input).endsWith('/healthz')) {
        return jsonResponse({
          status: 'ok',
          version: '0.1.0-beta.1',
          pid: 1234,
          instance_id: `br_${'a'.repeat(32)}`,
          started_at: '2026-08-26T08:00:00.000000123Z',
          probe_status: 'ready',
        });
      }
      return emptyResponse();
    });
    const client = clientWith(fetchImpl);
    await client.cancelTask(taskId);
    await client.shutdown();
    await expect(client.health()).resolves.toMatchObject({ pid: 1234, status: 'ok' });
    expect(calls[0]?.init?.body).toBeUndefined();
    expect(calls[1]?.init?.body).toBeUndefined();
    expect(calls.every((call) => new Headers(call.init?.headers).get('authorization') === `Bearer ${secret}`)).toBe(true);
  });
});
