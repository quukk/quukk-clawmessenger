import { z } from 'zod';

import { normalizeServerUrl } from '../config/schema.js';
import {
  PAIRING_CREDENTIAL_PATTERN,
  PAIRING_IDEMPOTENCY_KEY_PATTERN,
  pairingCandidateSchema,
  pairingSelectionSchema,
  pairingSessionSchema,
  type PairingCandidate,
  type PairingSelection,
  type PairingSession,
} from './schema.js';

const RESPONSE_LIMIT = 65_536;
const DEFAULT_TIMEOUT_MS = 10_000;
const TRANSIENT_STATUSES = new Set([408, 425, 500, 502, 503, 504]);

export const PAIRING_CLIENT_ERROR_CODES = [
  'pairing_cancelled',
  'pairing_conflict',
  'pairing_expired',
  'pairing_rate_limited',
  'pairing_rejected',
  'pairing_response_invalid',
  'pairing_timeout',
  'pairing_transport',
  'pairing_unauthorized',
] as const;

export type PairingClientErrorCode = (typeof PAIRING_CLIENT_ERROR_CODES)[number];
export type PairingClientErrorCategory =
  | 'authentication'
  | 'validation'
  | 'transport'
  | 'pairing';

export class PairingClientError extends Error {
  readonly code: PairingClientErrorCode;
  readonly category: PairingClientErrorCategory;
  readonly retryable: boolean;

  constructor(
    code: PairingClientErrorCode,
    category: PairingClientErrorCategory,
    retryable: boolean,
  ) {
    super(code);
    this.name = 'PairingClientError';
    this.code = code;
    this.category = category;
    this.retryable = retryable;
  }

  toJSON(): {
    code: PairingClientErrorCode;
    category: PairingClientErrorCategory;
    retryable: boolean;
  } {
    return { code: this.code, category: this.category, retryable: this.retryable };
  }
}

export type CreatePairingSessionInput = {
  installAbuseKey: string;
  idempotencyKey: string;
  candidates: PairingCandidate[];
};

export type PairingClientDependencies = {
  serverUrl: string;
  fetch?: typeof globalThis.fetch;
  sleep?: (milliseconds: number) => Promise<unknown>;
  random?: () => number;
  timeoutMs?: number;
};

class AttemptFailure {
  readonly kind: 'transport' | 'timeout';

  constructor(kind: 'transport' | 'timeout') {
    this.kind = kind;
  }
}

class BodyFailure {
  readonly kind: 'invalid' | 'transport';

  constructor(kind: 'invalid' | 'transport') {
    this.kind = kind;
  }
}

const createEnvelopeSchema = z.strictObject({ code: z.literal(201), data: pairingSessionSchema });
const selectionEnvelopeSchema = z.strictObject({
  code: z.literal(200),
  data: pairingSelectionSchema,
});

function rejected(): PairingClientError {
  return new PairingClientError('pairing_rejected', 'validation', false);
}

function invalidResponse(): PairingClientError {
  return new PairingClientError('pairing_response_invalid', 'validation', false);
}

function statusError(status: number): PairingClientError {
  if (status === 401 || status === 403) {
    return new PairingClientError('pairing_unauthorized', 'authentication', false);
  }
  if (status === 409) return new PairingClientError('pairing_conflict', 'pairing', false);
  if (status === 410) return new PairingClientError('pairing_expired', 'pairing', false);
  if (status === 429) return new PairingClientError('pairing_rate_limited', 'transport', true);
  return new PairingClientError('pairing_rejected', 'pairing', false);
}

function validCredential(value: string): boolean {
  return PAIRING_CREDENTIAL_PATTERN.test(value);
}

function validateDeviceCredentials(ticket: string, deviceSecret: string): void {
  if (!validCredential(ticket) || !validCredential(deviceSecret)) throw rejected();
}

function validateIdempotencyKey(value: string): void {
  if (!PAIRING_IDEMPOTENCY_KEY_PATTERN.test(value)) throw rejected();
}

async function boundedJson(response: Response): Promise<unknown> {
  if (response.body === null) throw new BodyFailure('invalid');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > RESPONSE_LIMIT) {
        await reader.cancel().catch(() => undefined);
        throw new BodyFailure('invalid');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof BodyFailure) throw error;
    throw new BodyFailure('transport');
  }
  try {
    return JSON.parse(Buffer.concat(chunks, length).toString('utf8')) as unknown;
  } catch {
    throw new BodyFailure('invalid');
  }
}

export class PairingClient {
  readonly #serverUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #sleep: (milliseconds: number) => Promise<unknown>;
  readonly #random: () => number;
  readonly #timeoutMs: number;

  constructor(dependencies: PairingClientDependencies) {
    try {
      this.#serverUrl = normalizeServerUrl(dependencies.serverUrl);
    } catch {
      throw rejected();
    }
    this.#fetch = dependencies.fetch ?? globalThis.fetch;
    this.#sleep =
      dependencies.sleep ??
      ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    this.#random = dependencies.random ?? Math.random;
    this.#timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs <= 0 || this.#timeoutMs > 60_000) {
      throw rejected();
    }
  }

  async #request(
    url: string,
    init: RequestInit,
    expectedStatus: 200 | 201,
    callerSignal?: AbortSignal,
  ): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (callerSignal?.aborted) {
        throw new PairingClientError('pairing_cancelled', 'transport', false);
      }
      const controller = new AbortController();
      let timedOut = false;
      const cancel = () => controller.abort();
      callerSignal?.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.#timeoutMs);
      let failure: AttemptFailure | undefined;
      try {
        const response = await this.#fetch(url, {
          ...init,
          redirect: 'manual',
          signal: controller.signal,
        });
        if (response.status !== expectedStatus) {
          await response.body?.cancel().catch(() => undefined);
          if (TRANSIENT_STATUSES.has(response.status)) {
            failure = new AttemptFailure('transport');
          } else {
            throw statusError(response.status);
          }
        } else {
          try {
            return await boundedJson(response);
          } catch (error) {
            if (callerSignal?.aborted) {
              throw new PairingClientError('pairing_cancelled', 'transport', false);
            }
            if (timedOut) failure = new AttemptFailure('timeout');
            else if (error instanceof BodyFailure && error.kind === 'invalid') {
              throw invalidResponse();
            } else if (error instanceof BodyFailure) {
              failure = new AttemptFailure('transport');
            } else {
              throw error;
            }
          }
        }
      } catch (error) {
        if (error instanceof PairingClientError) throw error;
        if (error instanceof AttemptFailure) failure = error;
        else if (callerSignal?.aborted) {
          throw new PairingClientError('pairing_cancelled', 'transport', false);
        } else {
          failure = new AttemptFailure(timedOut ? 'timeout' : 'transport');
        }
      } finally {
        clearTimeout(timer);
        callerSignal?.removeEventListener('abort', cancel);
      }
      if (attempt === 0) {
        const random = Math.min(Math.max(this.#random(), 0), 0.999_999_999);
        await this.#sleep(250 + Math.floor(random * 251));
        continue;
      }
      if (failure?.kind === 'timeout') {
        throw new PairingClientError('pairing_timeout', 'transport', true);
      }
      throw new PairingClientError('pairing_transport', 'transport', true);
    }
    throw new PairingClientError('pairing_transport', 'transport', true);
  }

  async createSession(
    input: CreatePairingSessionInput,
    signal?: AbortSignal,
  ): Promise<PairingSession> {
    if (!/^[0-9a-f]{64}$/.test(input.installAbuseKey)) throw rejected();
    validateIdempotencyKey(input.idempotencyKey);
    const candidates = z
      .array(pairingCandidateSchema)
      .min(1)
      .max(16)
      .superRefine((values, context) => {
        if (new Set(values.map((candidate) => candidate.candidateId)).size !== values.length) {
          context.addIssue({ code: 'custom', message: 'duplicate_candidate_id' });
        }
      })
      .safeParse(input.candidates);
    if (!candidates.success) throw rejected();
    const response = await this.#request(
      `${this.#serverUrl}/api/ai/pairing/sessions`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Install-Abuse-Key': input.installAbuseKey,
          'Idempotency-Key': input.idempotencyKey,
        },
        body: JSON.stringify({ candidates: candidates.data }),
      },
      201,
      signal,
    );
    const envelope = createEnvelopeSchema.safeParse(response);
    if (!envelope.success) throw invalidResponse();
    return envelope.data.data;
  }

  async pollSelection(
    ticket: string,
    deviceSecret: string,
    signal?: AbortSignal,
  ): Promise<PairingSelection> {
    validateDeviceCredentials(ticket, deviceSecret);
    const response = await this.#request(
      `${this.#serverUrl}/api/ai/pairing/sessions/${ticket}/selection`,
      {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Pairing ${deviceSecret}` },
      },
      200,
      signal,
    );
    const envelope = selectionEnvelopeSchema.safeParse(response);
    if (!envelope.success) throw invalidResponse();
    return envelope.data.data;
  }

  async cancelSession(
    ticket: string,
    deviceSecret: string,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<PairingSelection> {
    validateDeviceCredentials(ticket, deviceSecret);
    validateIdempotencyKey(idempotencyKey);
    const response = await this.#request(
      `${this.#serverUrl}/api/ai/pairing/sessions/${ticket}`,
      {
        method: 'DELETE',
        headers: {
          Accept: 'application/json',
          Authorization: `Pairing ${deviceSecret}`,
          'Idempotency-Key': idempotencyKey,
        },
      },
      200,
      signal,
    );
    const envelope = selectionEnvelopeSchema.safeParse(response);
    if (!envelope.success) throw invalidResponse();
    return envelope.data.data;
  }
}

export type { PairingRegistrationAuthorization } from './schema.js';
