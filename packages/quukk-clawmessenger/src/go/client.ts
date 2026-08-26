import {
  BridgeHealthSchema,
  BridgeHTTPErrorEnvelopeSchema,
  BridgeRuntimeListSchema,
  BridgeTaskEventSchema,
  BridgeTaskIdSchema,
  BridgeTaskStartInputSchema,
  BridgeTaskStartResponseSchema,
  isTerminalBridgeTaskEvent,
  type BridgeHealth,
  type BridgeRuntime,
  type BridgeTaskEvent,
  type BridgeTaskPort,
  type BridgeTaskStartInput,
} from './types.js';
import { parseSSE, SSEProtocolError } from './sse.js';

const JSON_LIMIT = 1 << 20;
const REQUEST_TIMEOUT = 10_000;
const REFRESH_TIMEOUT = 30_000;
const SSE_IDLE_TIMEOUT = 45_000;
const RECONNECT_BASE_DELAY = 100;
const RECONNECT_MAXIMUM_DELAY = 2_000;

export type BridgeClientErrorCode =
  | 'invalid_base_url'
  | 'invalid_request'
  | 'request_aborted'
  | 'request_timeout'
  | 'transport_error'
  | 'response_too_large'
  | 'response_invalid'
  | 'response_origin_mismatch'
  | 'redirect_rejected'
  | 'remote_error'
  | 'sse_protocol_error';

export class BridgeClientError extends Error {
  readonly code: BridgeClientErrorCode;
  readonly status?: number;
  readonly remoteCode?: string;
  readonly retryable: boolean;

  constructor(
    code: BridgeClientErrorCode,
    options: { status?: number; remoteCode?: string; retryable?: boolean } = {},
  ) {
    super(code);
    this.name = 'BridgeClientError';
    this.code = code;
    this.status = options.status;
    this.remoteCode = options.remoteCode;
    this.retryable = options.retryable ?? false;
  }

  toJSON(): { code: BridgeClientErrorCode; status?: number; remoteCode?: string; retryable: boolean } {
    return {
      code: this.code,
      ...(this.status === undefined ? {} : { status: this.status }),
      ...(this.remoteCode === undefined ? {} : { remoteCode: this.remoteCode }),
      retryable: this.retryable,
    };
  }
}

export type BridgeRequestOptions = { signal?: AbortSignal };

export type BridgeClientOptions = {
  baseUrl: string;
  secret: string;
  fetch?: typeof fetch;
  lifecycleSignal?: AbortSignal;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
  requestTimeoutMs?: number;
  refreshTimeoutMs?: number;
  sseIdleTimeoutMs?: number;
  reconnectBaseDelayMs?: number;
  reconnectMaximumDelayMs?: number;
};

type RequestContext = {
  signal: AbortSignal;
  timedOut(): boolean;
  clearDeadline(): void;
  resetDeadline(milliseconds: number): void;
  dispose(): void;
};

function validateBaseUrl(value: string): string {
  const match = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/.exec(value);
  const port = match === null ? 0 : Number(match[1]);
  if (match === null || port > 65_535) throw new BridgeClientError('invalid_base_url');
  return value;
}

function retryableRemote(code: string): boolean {
  return code === 'internal_error';
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new BridgeClientError('request_aborted'));
      return;
    }
    const aborted = () => {
      clearTimeout(timer);
      reject(new BridgeClientError('request_aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', aborted);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

export class BridgeClient implements BridgeTaskPort {
  readonly #baseUrl: string;
  readonly #origin: string;
  readonly #secret: string;
  readonly #fetch: typeof fetch;
  readonly #lifecycleSignal?: AbortSignal;
  readonly #sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly #setTimeout: typeof globalThis.setTimeout;
  readonly #clearTimeout: typeof globalThis.clearTimeout;
  readonly #requestTimeoutMs: number;
  readonly #refreshTimeoutMs: number;
  readonly #sseIdleTimeoutMs: number;
  readonly #reconnectBaseDelayMs: number;
  readonly #reconnectMaximumDelayMs: number;

  constructor(options: BridgeClientOptions) {
    this.#baseUrl = validateBaseUrl(options.baseUrl);
    this.#origin = this.#baseUrl;
    if (options.secret.length === 0 || options.secret.length > 4096) {
      throw new BridgeClientError('invalid_request');
    }
    this.#secret = options.secret;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#lifecycleSignal = options.lifecycleSignal;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#setTimeout = options.setTimeout ?? globalThis.setTimeout;
    this.#clearTimeout = options.clearTimeout ?? globalThis.clearTimeout;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT;
    this.#refreshTimeoutMs = options.refreshTimeoutMs ?? REFRESH_TIMEOUT;
    this.#sseIdleTimeoutMs = options.sseIdleTimeoutMs ?? SSE_IDLE_TIMEOUT;
    this.#reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? RECONNECT_BASE_DELAY;
    this.#reconnectMaximumDelayMs =
      options.reconnectMaximumDelayMs ?? RECONNECT_MAXIMUM_DELAY;
    for (const value of [
      this.#requestTimeoutMs,
      this.#refreshTimeoutMs,
      this.#sseIdleTimeoutMs,
      this.#reconnectBaseDelayMs,
      this.#reconnectMaximumDelayMs,
    ]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new BridgeClientError('invalid_request');
    }
    if (this.#reconnectBaseDelayMs > this.#reconnectMaximumDelayMs) {
      throw new BridgeClientError('invalid_request');
    }
  }

  async runtimes(options: BridgeRequestOptions = {}): Promise<BridgeRuntime[]> {
    return this.#jsonRequest('/v1/runtimes', { method: 'GET' }, BridgeRuntimeListSchema, 200, options);
  }

  async refreshRuntimes(options: BridgeRequestOptions = {}): Promise<BridgeRuntime[]> {
    return this.#jsonRequest(
      '/v1/runtimes/refresh',
      { method: 'POST' },
      BridgeRuntimeListSchema,
      200,
      options,
      this.#refreshTimeoutMs,
    );
  }

  async startTask(
    input: BridgeTaskStartInput,
    options: BridgeRequestOptions = {},
  ): Promise<{ taskId: string; eventsUrl: string }> {
    const parsed = BridgeTaskStartInputSchema.safeParse(input);
    if (!parsed.success) throw new BridgeClientError('invalid_request');
    const wire = {
      runtime_id: parsed.data.runtimeId,
      conversation_key: parsed.data.conversationKey,
      prompt: parsed.data.prompt,
      workdir: parsed.data.workdir,
      ...(parsed.data.resumeSessionId === undefined
        ? {}
        : { resume_session_id: parsed.data.resumeSessionId }),
    };
    const body = JSON.stringify(wire);
    if (Buffer.byteLength(body) > JSON_LIMIT) throw new BridgeClientError('invalid_request');
    const response = await this.#jsonRequest(
      '/v1/tasks',
      { method: 'POST', body, headers: { 'content-type': 'application/json' } },
      BridgeTaskStartResponseSchema,
      201,
      options,
    );
    const expected = `/v1/tasks/${response.task_id}/events`;
    if (response.events_url !== expected) throw new BridgeClientError('response_invalid');
    return { taskId: response.task_id, eventsUrl: response.events_url };
  }

  async cancelTask(taskID: string, options: BridgeRequestOptions = {}): Promise<void> {
    const parsed = BridgeTaskIdSchema.safeParse(taskID);
    if (!parsed.success) throw new BridgeClientError('invalid_request');
    await this.#emptyRequest(`/v1/tasks/${parsed.data}/cancel`, options);
  }

  async health(options: BridgeRequestOptions = {}): Promise<BridgeHealth> {
    return this.#jsonRequest('/healthz', { method: 'GET' }, BridgeHealthSchema, 200, options);
  }

  async shutdown(options: BridgeRequestOptions = {}): Promise<void> {
    await this.#emptyRequest('/shutdown', options);
  }

  async *events(
    taskID: string,
    afterEventID?: number,
    options: BridgeRequestOptions = {},
  ): AsyncIterable<BridgeTaskEvent> {
    const parsedTaskID = BridgeTaskIdSchema.safeParse(taskID);
    if (
      !parsedTaskID.success ||
      (afterEventID !== undefined &&
        (!Number.isSafeInteger(afterEventID) || afterEventID < 0))
    ) {
      throw new BridgeClientError('invalid_request');
    }
    let cursor = afterEventID ?? 0;
    let sendCursor = afterEventID !== undefined;
    let failures = 0;

    while (true) {
      this.#throwIfAborted(options.signal);
      let context: RequestContext | undefined;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let complete = false;
      try {
        context = this.#requestContext(options.signal, this.#requestTimeoutMs);
        const headers = new Headers({
          accept: 'text/event-stream',
          authorization: `Bearer ${this.#secret}`,
        });
        if (sendCursor) headers.set('last-event-id', String(cursor));
        const response = await this.#fetchResponse(
          `/v1/tasks/${parsedTaskID.data}/events`,
          { method: 'GET', headers },
          context,
        );
        context.clearDeadline();
        if (response.status !== 200) {
          throw await this.#responseError(response, context);
        }
        await this.#validateOrCancel(response, 'text/event-stream');
        if (response.body === null) throw new BridgeClientError('response_invalid');
        reader = response.body.getReader();
        const abortReader = () => void reader?.cancel().catch(() => undefined);
        context.signal.addEventListener('abort', abortReader, { once: true });
        context.resetDeadline(this.#sseIdleTimeoutMs);
        let done = false;
        const bytes = (async function* () {
          try {
            while (true) {
              const next = await reader!.read();
              if (next.done) {
                done = true;
                return;
              }
              yield next.value;
            }
          } finally {
            if (!done) await reader!.cancel().catch(() => undefined);
          }
        })();
        for await (const message of parseSSE(bytes)) {
          context.resetDeadline(this.#sseIdleTimeoutMs);
          if (message.kind === 'heartbeat') {
            failures = 0;
            continue;
          }
          let json: unknown;
          try {
            json = JSON.parse(message.data) as unknown;
          } catch {
            throw new BridgeClientError('sse_protocol_error');
          }
          const parsed = BridgeTaskEventSchema.safeParse(json);
          if (
            !parsed.success ||
            String(parsed.data.id) !== message.id ||
            parsed.data.type !== message.event ||
            parsed.data.task_id !== parsedTaskID.data
          ) {
            throw new BridgeClientError('sse_protocol_error');
          }
          const overflow =
            parsed.data.type === 'status' && parsed.data.status === 'replay_overflow';
          if (parsed.data.id !== cursor + 1 && !(overflow && parsed.data.id > cursor)) {
            throw new BridgeClientError('sse_protocol_error');
          }
          cursor = parsed.data.id;
          sendCursor = true;
          failures = 0;
          yield parsed.data;
          if (isTerminalBridgeTaskEvent(parsed.data)) {
            complete = true;
            return;
          }
        }
        context.signal.removeEventListener('abort', abortReader);
      } catch (error) {
        const normalized = this.#normalizeError(error, context);
        if (!normalized.retryable || normalized.code === 'request_aborted') throw normalized;
      } finally {
        await reader?.cancel().catch(() => undefined);
        context?.dispose();
      }
      if (complete) return;
      const delay = Math.min(
        this.#reconnectBaseDelayMs * 2 ** Math.min(failures, 30),
        this.#reconnectMaximumDelayMs,
      );
      failures += 1;
      await this.#sleep(delay, this.#combinedSignal(options.signal));
      this.#throwIfAborted(options.signal);
      sendCursor = true;
    }
  }

  async #emptyRequest(path: string, options: BridgeRequestOptions): Promise<void> {
    const context = this.#requestContext(options.signal, this.#requestTimeoutMs);
    try {
      const response = await this.#fetchResponse(path, { method: 'POST' }, context);
      if (response.status !== 202) throw await this.#responseError(response, context);
      await this.#validateOrCancel(response);
      const bytes = await this.#readBounded(response, 0, context);
      if (bytes.byteLength !== 0) throw new BridgeClientError('response_invalid');
    } catch (error) {
      throw this.#normalizeError(error, context);
    } finally {
      context.dispose();
    }
  }

  async #jsonRequest<T>(
    path: string,
    init: RequestInit,
    schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
    expectedStatus: number,
    options: BridgeRequestOptions,
    timeout = this.#requestTimeoutMs,
  ): Promise<T> {
    const context = this.#requestContext(options.signal, timeout);
    try {
      const headers = new Headers(init.headers);
      headers.set('accept', 'application/json');
      const response = await this.#fetchResponse(path, { ...init, headers }, context);
      if (response.status !== expectedStatus) throw await this.#responseError(response, context);
      await this.#validateOrCancel(response, 'application/json; charset=utf-8');
      const bytes = await this.#readBounded(response, JSON_LIMIT, context);
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
      } catch {
        throw new BridgeClientError('response_invalid');
      }
      const parsed = schema.safeParse(value);
      if (!parsed.success) throw new BridgeClientError('response_invalid');
      return parsed.data;
    } catch (error) {
      throw this.#normalizeError(error, context);
    } finally {
      context.dispose();
    }
  }

  async #fetchResponse(
    path: string,
    init: RequestInit,
    context: RequestContext,
  ): Promise<Response> {
    if (context.signal.aborted) {
      throw context.timedOut()
        ? new BridgeClientError('request_timeout', { retryable: true })
        : new BridgeClientError('request_aborted');
    }
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${this.#secret}`);
    try {
      const response = await this.#fetch(`${this.#baseUrl}${path}`, {
        ...init,
        headers,
        signal: context.signal,
        redirect: 'error',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        throw new BridgeClientError('redirect_rejected', { status: response.status });
      }
      if (response.url !== '') {
        let origin: string;
        try {
          origin = new URL(response.url).origin;
        } catch {
          await response.body?.cancel().catch(() => undefined);
          throw new BridgeClientError('response_origin_mismatch');
        }
        if (origin !== this.#origin) {
          await response.body?.cancel().catch(() => undefined);
          throw new BridgeClientError('response_origin_mismatch');
        }
      }
      return response;
    } catch (error) {
      throw this.#normalizeError(error, context);
    }
  }

  #validateResponse(response: Response, contentType?: string): void {
    if (response.headers.get('cache-control') !== 'no-store') {
      throw new BridgeClientError('response_invalid');
    }
    if (contentType !== undefined && response.headers.get('content-type') !== contentType) {
      throw new BridgeClientError('response_invalid');
    }
  }

  async #validateOrCancel(response: Response, contentType?: string): Promise<void> {
    try {
      this.#validateResponse(response, contentType);
    } catch (error) {
      await response.body?.cancel().catch(() => undefined);
      throw error;
    }
  }

  async #responseError(response: Response, context: RequestContext): Promise<BridgeClientError> {
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      return new BridgeClientError('redirect_rejected', { status: response.status });
    }
    try {
      await this.#validateOrCancel(response, 'application/json; charset=utf-8');
      const bytes = await this.#readBounded(response, JSON_LIMIT, context);
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
      } catch {
        return new BridgeClientError('response_invalid', { status: response.status });
      }
      const parsed = BridgeHTTPErrorEnvelopeSchema.safeParse(value);
      if (!parsed.success) return new BridgeClientError('response_invalid', { status: response.status });
      return new BridgeClientError('remote_error', {
        status: response.status,
        remoteCode: parsed.data.error,
        retryable: retryableRemote(parsed.data.error),
      });
    } catch (error) {
      return this.#normalizeError(error, context);
    }
  }

  async #readBounded(
    response: Response,
    maximumBytes: number,
    context: RequestContext,
  ): Promise<Uint8Array> {
    const declared = response.headers.get('content-length');
    if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maximumBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new BridgeClientError('response_too_large');
    }
    if (response.body === null) return new Uint8Array();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > maximumBytes) throw new BridgeClientError('response_too_large');
        chunks.push(next.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw this.#normalizeError(error, context);
    }
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  }

  #requestContext(callSignal: AbortSignal | undefined, timeout: number): RequestContext {
    const controller = new AbortController();
    let timedOut = false;
    const signals = [this.#lifecycleSignal, callSignal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    const abort = () => controller.abort();
    for (const signal of signals) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', abort, { once: true });
    }
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    let deadlineCleared = true;
    const clearDeadline = () => {
      if (deadlineCleared) return;
      deadlineCleared = true;
      if (timer !== undefined) this.#clearTimeout(timer);
    };
    const resetDeadline = (milliseconds: number) => {
      clearDeadline();
      deadlineCleared = false;
      timer = this.#setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, milliseconds);
    };
    resetDeadline(timeout);
    return {
      signal: controller.signal,
      timedOut: () => timedOut,
      clearDeadline,
      resetDeadline,
      dispose: () => {
        clearDeadline();
        for (const signal of signals) signal.removeEventListener('abort', abort);
      },
    };
  }

  #throwIfAborted(callSignal?: AbortSignal): void {
    if (this.#lifecycleSignal?.aborted || callSignal?.aborted) {
      throw new BridgeClientError('request_aborted');
    }
  }

  #combinedSignal(callSignal?: AbortSignal): AbortSignal | undefined {
    const signals = [this.#lifecycleSignal, callSignal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    if (signals.length === 0) return undefined;
    if (signals.length === 1) return signals[0];
    return AbortSignal.any(signals);
  }

  #normalizeError(error: unknown, context?: RequestContext): BridgeClientError {
    if (context?.timedOut()) return new BridgeClientError('request_timeout', { retryable: true });
    if (error instanceof BridgeClientError) return error;
    if (error instanceof SSEProtocolError) {
      return new BridgeClientError('sse_protocol_error');
    }
    if (context?.signal.aborted || this.#lifecycleSignal?.aborted) {
      return new BridgeClientError('request_aborted');
    }
    return new BridgeClientError('transport_error', { retryable: true });
  }
}
