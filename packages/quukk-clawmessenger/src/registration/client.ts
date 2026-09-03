import { createHash, createHmac } from 'node:crypto';
import { networkInterfaces as osNetworkInterfaces } from 'node:os';

import { z } from 'zod';

import {
  PROVIDERS,
  RUNTIME_ID_PATTERN,
  isValidNodeId,
  normalizeServerUrl,
  type Provider,
  type RegistrationErrorCode,
} from '../config/schema.js';
import {
  PAIRING_CANDIDATE_ID_PATTERN,
  PAIRING_CREDENTIAL_PATTERN,
  PAIRING_IDEMPOTENCY_KEY_PATTERN,
  type PairingRegistrationAuthorization,
} from '../pairing/schema.js';
import { CLAWMESSENGER_NODE_CAPABILITIES } from './capabilities.js';

const RESPONSE_LIMIT = 65_536;
const DEFAULT_TIMEOUT_MS = 10_000;
const TRANSIENT_STATUSES = new Set([408, 425, 500, 502, 503, 504]);

export type RegistrationInput = {
  serverUrl: string;
  installId: string;
  runtimeId: string;
  bridgeSecret: string;
  provider: Provider;
  nodeName: string;
  existingNodeId?: string;
  existingNodeToken?: string;
  authorization?: PairingRegistrationAuthorization;
};

export type RefreshInput = {
  serverUrl: string;
  runtimeId: string;
  bridgeSecret: string;
  provider: Provider;
  nodeId: string;
  nodeName: string;
  existingNodeToken?: string;
};

export type RegistrationResult = {
  nodeId: string;
  nodeName: string;
  token: string;
};

type RegistrationErrorCategory =
  | 'authentication'
  | 'validation'
  | 'transport'
  | 'registration';

export class RegistrationError extends Error {
  readonly code: RegistrationErrorCode;
  readonly category: RegistrationErrorCategory;
  readonly retryable: boolean;

  constructor(code: RegistrationErrorCode, category: RegistrationErrorCategory, retryable: boolean) {
    super(code);
    this.name = 'RegistrationError';
    this.code = code;
    this.category = category;
    this.retryable = retryable;
  }

  toJSON(): {
    code: RegistrationErrorCode;
    category: RegistrationErrorCategory;
    retryable: boolean;
  } {
    return { code: this.code, category: this.category, retryable: this.retryable };
  }
}

export type RegistrationClientDependencies = {
  fetch?: typeof globalThis.fetch;
  networkInterfaces?: typeof osNetworkInterfaces;
  sleep?: (milliseconds: number) => Promise<unknown>;
  random?: () => number;
  timeoutMs?: number;
};

type Operation = 'app-key' | 'register' | 'refresh';

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

const envelopeSchema = z.object({ code: z.number(), data: z.unknown().optional() });
const appKeyDataSchema = z.object({ appKey: z.string() });
const registrationDataSchema = z.object({
  node_id: z.string(),
  node_type: z.string(),
  token: z.string(),
  capabilities: z.array(z.string()),
  name: z.string().optional(),
});

function invalidServerUrl(): RegistrationError {
  return new RegistrationError('invalid_server_url', 'validation', false);
}

function normalizeUrl(value: string): string {
  try {
    return normalizeServerUrl(value);
  } catch {
    throw invalidServerUrl();
  }
}

function permanentError(operation: Operation): RegistrationError {
  if (operation === 'app-key') {
    return new RegistrationError('app_key_unavailable', 'registration', false);
  }
  if (operation === 'refresh') {
    return new RegistrationError('token_refresh_failed', 'registration', false);
  }
  return new RegistrationError('registration_rejected', 'registration', false);
}

function invalidResponse(operation: Operation): RegistrationError {
  return operation === 'app-key'
    ? permanentError(operation)
    : new RegistrationError('registration_response_invalid', 'validation', false);
}

function validateCommonInput(
  provider: Provider,
  runtimeId: string,
  bridgeSecret: string,
  nodeName: string,
): Buffer {
  if (
    !PROVIDERS.includes(provider) ||
    !RUNTIME_ID_PATTERN.test(runtimeId) ||
    nodeName.length === 0 ||
    nodeName.length > 128 ||
    nodeName !== nodeName.trim() ||
    !/^[A-Za-z0-9_-]{43}$/.test(bridgeSecret)
  ) {
    throw new RegistrationError('registration_rejected', 'validation', false);
  }
  const secret = Buffer.from(bridgeSecret, 'base64url');
  if (secret.byteLength !== 32 || secret.toString('base64url') !== bridgeSecret) {
    throw new RegistrationError('registration_rejected', 'validation', false);
  }
  return secret;
}

function validateCredentialToken(token: string | undefined): void {
  if (
    token !== undefined &&
    (token.length === 0 || token.length > 16_384 || token !== token.trim())
  ) {
    throw new RegistrationError('registration_rejected', 'validation', false);
  }
}

function validatePairingAuthorization(
  authorization: PairingRegistrationAuthorization,
): void {
  if (
    !PAIRING_CREDENTIAL_PATTERN.test(authorization.ticket)
    || !PAIRING_CREDENTIAL_PATTERN.test(authorization.deviceSecret)
    || !PAIRING_CANDIDATE_ID_PATTERN.test(authorization.candidateId)
    || !PAIRING_IDEMPOTENCY_KEY_PATTERN.test(authorization.idempotencyKey)
  ) {
    throw new RegistrationError('registration_rejected', 'validation', false);
  }
}

function enrollmentToken(
  secret: Buffer,
  normalizedServerUrl: string,
  runtimeId: string,
): string {
  const context = `quukk/server-enrollment/v1\0${normalizedServerUrl}\0${runtimeId}`;
  return `qce_v1_${createHmac('sha256', secret).update(context, 'utf8').digest('base64url')}`;
}

function normalizeMac(value: string): string | undefined {
  if (!/^(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$/.test(value)) return undefined;
  const normalized = value.replaceAll('-', ':').toUpperCase();
  if (normalized === '00:00:00:00:00:00') return undefined;
  if ((Number.parseInt(normalized.slice(0, 2), 16) & 1) === 1) return undefined;
  return normalized;
}

function stableMac(
  installId: string,
  readInterfaces: typeof osNetworkInterfaces,
): string {
  const candidates = new Set<string>();
  try {
    for (const entries of Object.values(readInterfaces())) {
      for (const entry of entries ?? []) {
        if (entry.internal) continue;
        const normalized = normalizeMac(entry.mac);
        if (normalized !== undefined) candidates.add(normalized);
      }
    }
  } catch {
    // A deterministic installation-derived address is the fail-closed local fallback.
  }
  const sorted = [...candidates].sort((left, right) => {
    const leftLocal = Number.parseInt(left.slice(0, 2), 16) & 2;
    const rightLocal = Number.parseInt(right.slice(0, 2), 16) & 2;
    return leftLocal - rightLocal || left.localeCompare(right);
  });
  if (sorted[0] !== undefined) return sorted[0];
  const bytes = createHash('sha256').update(installId, 'utf8').digest().subarray(0, 6);
  bytes[0] = (bytes[0]! & 0xfe) | 0x02;
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(':');
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

function registrationResult(
  value: unknown,
  operation: 'register' | 'refresh',
  provider: Provider,
  submittedNodeName: string,
  expectedNodeId?: string,
): RegistrationResult {
  const envelope = envelopeSchema.safeParse(value);
  if (!envelope.success) throw invalidResponse(operation);
  if (envelope.data.code !== 200) throw permanentError(operation);
  const data = registrationDataSchema.safeParse(envelope.data.data);
  if (!data.success) throw invalidResponse(operation);
  if (
    data.data.node_type !== provider ||
    !isValidNodeId(provider, data.data.node_id) ||
    (expectedNodeId !== undefined && data.data.node_id !== expectedNodeId)
  ) {
    throw new RegistrationError('registration_node_mismatch', 'validation', false);
  }
  if (
    data.data.token.length === 0 ||
    data.data.token.length > 16_384 ||
    data.data.token !== data.data.token.trim() ||
    (data.data.name !== undefined &&
      (data.data.name.length === 0 ||
        data.data.name.length > 128 ||
        data.data.name !== data.data.name.trim()))
  ) {
    throw invalidResponse(operation);
  }
  if (
    data.data.capabilities.length !== CLAWMESSENGER_NODE_CAPABILITIES.length ||
    data.data.capabilities.some(
      (capability, index) => capability !== CLAWMESSENGER_NODE_CAPABILITIES[index],
    )
  ) {
    throw new RegistrationError('registration_capabilities_mismatch', 'validation', false);
  }
  return { nodeId: data.data.node_id, nodeName: submittedNodeName, token: data.data.token };
}

export class RegistrationClient {
  readonly #fetch: typeof globalThis.fetch;
  readonly #networkInterfaces: typeof osNetworkInterfaces;
  readonly #sleep: (milliseconds: number) => Promise<unknown>;
  readonly #random: () => number;
  readonly #timeoutMs: number;

  constructor(dependencies: RegistrationClientDependencies = {}) {
    this.#fetch = dependencies.fetch ?? globalThis.fetch;
    this.#networkInterfaces = dependencies.networkInterfaces ?? osNetworkInterfaces;
    this.#sleep =
      dependencies.sleep ??
      ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    this.#random = dependencies.random ?? Math.random;
    this.#timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async #request(
    operation: Operation,
    url: string,
    init: RequestInit,
    callerSignal?: AbortSignal,
  ): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (callerSignal?.aborted) {
        throw new RegistrationError('registration_cancelled', 'transport', false);
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
        if (response.status !== 200) {
          await response.body?.cancel().catch(() => undefined);
          if (response.status === 401 || response.status === 403) {
            throw new RegistrationError('registration_unauthorized', 'authentication', false);
          }
          if (TRANSIENT_STATUSES.has(response.status)) {
            failure = new AttemptFailure('transport');
          } else if (response.status === 429) {
            throw new RegistrationError('registration_transport', 'transport', true);
          } else {
            throw permanentError(operation);
          }
        } else {
          try {
            return await boundedJson(response);
          } catch (error) {
            if (callerSignal?.aborted) {
              throw new RegistrationError('registration_cancelled', 'transport', false);
            }
            if (timedOut) failure = new AttemptFailure('timeout');
            else if (error instanceof BodyFailure && error.kind === 'invalid') {
              throw invalidResponse(operation);
            } else if (error instanceof BodyFailure) {
              failure = new AttemptFailure('transport');
            } else throw error;
          }
        }
      } catch (error) {
        if (error instanceof RegistrationError) throw error;
        if (error instanceof AttemptFailure) failure = error;
        else if (callerSignal?.aborted) {
          throw new RegistrationError('registration_cancelled', 'transport', false);
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
        throw new RegistrationError('registration_timeout', 'transport', true);
      }
      throw new RegistrationError('registration_transport', 'transport', true);
    }
    throw new RegistrationError('registration_transport', 'transport', true);
  }

  async getAppKey(serverUrl: string, signal?: AbortSignal): Promise<string> {
    const server = normalizeUrl(serverUrl);
    const response = await this.#request(
      'app-key',
      `${server}/api/config/rongcloud`,
      { method: 'GET', headers: { Accept: 'application/json' } },
      signal,
    );
    const envelope = envelopeSchema.safeParse(response);
    if (!envelope.success || envelope.data.code !== 200) throw permanentError('app-key');
    const data = appKeyDataSchema.safeParse(envelope.data.data);
    if (
      !data.success ||
      data.data.appKey.length === 0 ||
      data.data.appKey.length > 256 ||
      data.data.appKey !== data.data.appKey.trim()
    ) {
      throw permanentError('app-key');
    }
    return data.data.appKey;
  }

  async register(input: RegistrationInput, signal?: AbortSignal): Promise<RegistrationResult> {
    const server = normalizeUrl(input.serverUrl);
    const secret = validateCommonInput(
      input.provider,
      input.runtimeId,
      input.bridgeSecret,
      input.nodeName,
    );
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.installId)) {
      throw new RegistrationError('registration_rejected', 'validation', false);
    }
    if (input.existingNodeId !== undefined && !isValidNodeId(input.provider, input.existingNodeId)) {
      throw new RegistrationError('registration_node_mismatch', 'validation', false);
    }
    validateCredentialToken(input.existingNodeToken);
    if (input.authorization !== undefined) {
      validatePairingAuthorization(input.authorization);
      if (input.existingNodeId !== undefined || input.existingNodeToken !== undefined) {
        throw new RegistrationError('registration_rejected', 'validation', false);
      }
    }
    const requestBody: Record<string, unknown> = input.authorization === undefined
      ? {
          name: input.nodeName,
          mac_address: stableMac(input.installId, this.#networkInterfaces),
          node_type: input.provider,
          ai_type: input.provider,
          capabilities: [...CLAWMESSENGER_NODE_CAPABILITIES],
        }
      : {
          provider: input.provider,
          name: input.nodeName,
          mac_address: stableMac(input.installId, this.#networkInterfaces),
          capabilities: [...CLAWMESSENGER_NODE_CAPABILITIES],
        };
    if (input.existingNodeId !== undefined) requestBody.node_id = input.existingNodeId;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    let url = `${server}/api/ai/register`;
    if (input.authorization !== undefined) {
      headers.Authorization = `Pairing ${input.authorization.deviceSecret}`;
      headers['Idempotency-Key'] = input.authorization.idempotencyKey;
      url = `${server}/api/ai/pairing/sessions/${encodeURIComponent(input.authorization.ticket)}`
        + `/candidates/${encodeURIComponent(input.authorization.candidateId)}/register`;
    } else {
      headers['X-Node-Enrollment-Token'] = enrollmentToken(secret, server, input.runtimeId);
    }
    if (input.authorization === undefined && input.existingNodeToken !== undefined) {
      headers.Authorization = `Bearer ${input.existingNodeToken}`;
    }
    const response = await this.#request(
      'register',
      url,
      { method: 'POST', headers, body: JSON.stringify(requestBody) },
      signal,
    );
    return registrationResult(
      response,
      'register',
      input.provider,
      input.nodeName,
      input.existingNodeId,
    );
  }

  async refreshToken(input: RefreshInput, signal?: AbortSignal): Promise<RegistrationResult> {
    const server = normalizeUrl(input.serverUrl);
    const secret = validateCommonInput(
      input.provider,
      input.runtimeId,
      input.bridgeSecret,
      input.nodeName,
    );
    if (!isValidNodeId(input.provider, input.nodeId)) {
      throw new RegistrationError('registration_node_mismatch', 'validation', false);
    }
    validateCredentialToken(input.existingNodeToken);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Node-Enrollment-Token': enrollmentToken(secret, server, input.runtimeId),
    };
    if (input.existingNodeToken !== undefined) {
      headers.Authorization = `Bearer ${input.existingNodeToken}`;
    }
    const response = await this.#request(
      'refresh',
      `${server}/api/claw/refresh-token/${encodeURIComponent(input.nodeId)}`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: input.nodeName,
          capabilities: [...CLAWMESSENGER_NODE_CAPABILITIES],
        }),
      },
      signal,
    );
    return registrationResult(response, 'refresh', input.provider, input.nodeName, input.nodeId);
  }
}
