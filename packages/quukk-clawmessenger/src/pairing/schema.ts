import { z } from 'zod';

import { ProviderSchema } from '../config/schema.js';

export const PAIRING_SESSION_STATES = [
  'waiting',
  'claimed',
  'processing',
  'completed',
  'partial',
  'cancelled',
  'expired',
] as const;
export const PAIRING_READINESS_STATES = [
  'ready',
  'not_ready',
  'already_registered',
] as const;
export const PAIRING_REGISTRATION_STATES = ['unregistered', 'registered'] as const;
export const PAIRING_RESULT_STATES = [
  'pending',
  'registering',
  'bound',
  'already_bound',
  'failed',
] as const;

export const PAIRING_MAX_CANDIDATES = 16;
export const PAIRING_CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const PAIRING_CANDIDATE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const PAIRING_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;

const boundedTrimmedString = (maximum: number) =>
  z.string().min(1).max(maximum).refine((value) => value === value.trim());

const nullableBoundedTrimmedString = (maximum: number) =>
  boundedTrimmedString(maximum).nullable();

const credentialSchema = z.string().regex(PAIRING_CREDENTIAL_PATTERN);
const candidateIdSchema = z.string().regex(PAIRING_CANDIDATE_ID_PATTERN);
const retryRequestIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);

type PairingClockOptions = { now?: () => number };

function clock(options: PairingClockOptions): () => number {
  return options.now ?? (() => Date.now());
}

function expiresAtSchema(now: () => number) {
  return z.iso.datetime({ offset: true }).superRefine((value, context) => {
    if (Date.parse(value) <= now()) {
      context.addIssue({ code: 'custom', message: 'pairing_expired' });
    }
  });
}

export const pairingCandidateSchema = z.strictObject({
  candidateId: candidateIdSchema,
  provider: ProviderSchema,
  displayName: boundedTrimmedString(80),
  version: nullableBoundedTrimmedString(64),
  readiness: z.enum(PAIRING_READINESS_STATES),
  statusReason: nullableBoundedTrimmedString(80),
  registrationState: z.enum(PAIRING_REGISTRATION_STATES),
});

function candidatesSchemaFor(minimum: number) {
  return z
    .array(pairingCandidateSchema)
    .min(minimum)
    .max(PAIRING_MAX_CANDIDATES)
    .superRefine((candidates, context) => {
    const seen = new Set<string>();
    for (const [index, candidate] of candidates.entries()) {
      if (seen.has(candidate.candidateId)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'candidateId'],
          message: 'duplicate_candidate_id',
        });
      }
      seen.add(candidate.candidateId);
    }
  });
}

const candidatesSchema = candidatesSchemaFor(1);
const candidatesV2Schema = candidatesSchemaFor(0);

export function pairingSessionV2SchemaFor(options: PairingClockOptions = {}) {
  const now = clock(options);
  return z.strictObject({
    ticket: credentialSchema,
    deviceSecret: credentialSchema,
    pairingCode: z.string().regex(/^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{8}$/),
    expiresAt: z.iso.datetime({ offset: true }).superRefine((value, context) => {
      const remaining = Date.parse(value) - now();
      if (remaining <= 0 || remaining > 600_000) {
        context.addIssue({ code: 'custom', message: 'pairing_response_invalid' });
      }
    }),
    status: z.literal('waiting'),
    candidates: candidatesV2Schema,
  });
}

export const pairingSessionV2Schema = pairingSessionV2SchemaFor();

const selectedCandidateIdsSchema = z
  .array(candidateIdSchema)
  .max(PAIRING_MAX_CANDIDATES)
  .superRefine((candidateIds, context) => {
    if (new Set(candidateIds).size !== candidateIds.length) {
      context.addIssue({ code: 'custom', message: 'duplicate_candidate_id' });
    }
  });

export const pairingRetryRequestSchema = z.strictObject({
  requestId: retryRequestIdSchema,
  candidateIds: selectedCandidateIdsSchema.min(1),
});

export function pairingSessionSchemaFor(options: PairingClockOptions = {}) {
  return z.strictObject({
    ticket: credentialSchema,
    deviceSecret: credentialSchema,
    expiresAt: expiresAtSchema(clock(options)),
    status: z.enum(PAIRING_SESSION_STATES),
    candidates: candidatesSchema,
  });
}

export const pairingSessionSchema = pairingSessionSchemaFor();

function pairingSelectionSchemaFor(options: PairingClockOptions = {}) {
  return z
    .strictObject({
      status: z.enum(PAIRING_SESSION_STATES),
      selectedCandidateIds: selectedCandidateIdsSchema,
      candidates: candidatesSchema,
      expiresAt: expiresAtSchema(clock(options)),
    })
    .superRefine((selection, context) => {
      const candidates = new Set(selection.candidates.map((candidate) => candidate.candidateId));
      for (const [index, candidateId] of selection.selectedCandidateIds.entries()) {
        if (!candidates.has(candidateId)) {
          context.addIssue({
            code: 'custom',
            path: ['selectedCandidateIds', index],
            message: 'unknown_candidate_id',
          });
        }
      }
    });
}

export const pairingSelectionSchema = pairingSelectionSchemaFor();

export const pairingCandidateResultSchema = z
  .strictObject({
    candidateId: candidateIdSchema,
    status: z.enum(PAIRING_RESULT_STATES),
    errorCode: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).nullable(),
    nodeId: z.string().min(1).max(137).refine((value) => value === value.trim()).nullable(),
  })
  .superRefine((result, context) => {
    if (result.status === 'failed' && result.errorCode === null) {
      context.addIssue({ code: 'custom', path: ['errorCode'], message: 'missing_error_code' });
    }
    if (result.status !== 'failed' && result.errorCode !== null) {
      context.addIssue({ code: 'custom', path: ['errorCode'], message: 'unexpected_error_code' });
    }
    if ((result.status === 'bound' || result.status === 'already_bound') && result.nodeId === null) {
      context.addIssue({ code: 'custom', path: ['nodeId'], message: 'missing_node_id' });
    }
  });

function pairingProgressSchemaFor(options: PairingClockOptions = {}) {
  return pairingSelectionSchemaFor(options)
    .safeExtend({
      results: z.array(pairingCandidateResultSchema).max(PAIRING_MAX_CANDIDATES),
    })
    .superRefine((progress, context) => {
      const selected = new Set(progress.selectedCandidateIds);
      const seen = new Set<string>();
      for (const [index, result] of progress.results.entries()) {
        if (!selected.has(result.candidateId)) {
          context.addIssue({
            code: 'custom',
            path: ['results', index, 'candidateId'],
            message: 'unselected_candidate_result',
          });
        }
        if (seen.has(result.candidateId)) {
          context.addIssue({
            code: 'custom',
            path: ['results', index, 'candidateId'],
            message: 'duplicate_candidate_result',
          });
        }
        seen.add(result.candidateId);
      }
      const hasExactCoverage =
        progress.results.length === progress.selectedCandidateIds.length &&
        progress.selectedCandidateIds.every((candidateId) => seen.has(candidateId));
      if (
        (progress.status === 'waiting' || progress.status === 'claimed') &&
        progress.results.length !== 0
      ) {
        context.addIssue({ code: 'custom', path: ['results'], message: 'unexpected_results' });
      }
      if (
        progress.status === 'completed' &&
        (!hasExactCoverage ||
          progress.results.some(
            (result) => result.status !== 'bound' && result.status !== 'already_bound',
          ))
      ) {
        context.addIssue({ code: 'custom', path: ['results'], message: 'invalid_completed_results' });
      }
      if (progress.status === 'partial') {
        const allTerminal = progress.results.every(
          (result) =>
            result.status === 'bound' ||
            result.status === 'already_bound' ||
            result.status === 'failed',
        );
        if (
          !hasExactCoverage ||
          !allTerminal ||
          !progress.results.some((result) => result.status === 'failed')
        ) {
          context.addIssue({ code: 'custom', path: ['results'], message: 'invalid_partial_results' });
        }
      }
    });
}

export const pairingProgressSchema = pairingProgressSchemaFor();

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (host === 'localhost' || host === '::1') return true;
  const octets = host.split('.');
  return (
    octets.length === 4 &&
    octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255) &&
    octets[0] === '127'
  );
}

function pairingServerUrl(value: string, allowLoopbackHttp: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('pairing_server_invalid');
  }
  const allowedProtocol =
    parsed.protocol === 'https:' ||
    (allowLoopbackHttp && parsed.protocol === 'http:' && isLoopback(parsed.hostname));
  if (
    !allowedProtocol ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    value !== value.trim()
  ) {
    throw new Error('pairing_server_invalid');
  }
  return parsed.toString().replace(/\/+$/, '');
}

function qrServerSchema(allowLoopbackHttp: boolean) {
  return z
    .string()
    .min(1)
    .max(4096)
    .transform((value, context) => {
      try {
        return pairingServerUrl(value, allowLoopbackHttp);
      } catch {
        context.addIssue({ code: 'custom', message: 'pairing_server_invalid' });
        return z.NEVER;
      }
    });
}

export function pairingQrSchemaFor(
  options: PairingClockOptions & { allowLoopbackHttp?: boolean } = {},
) {
  const now = clock(options);
  return z.strictObject({
    type: z.literal('clawmessenger_pairing'),
    version: z.literal(1),
    server: qrServerSchema(options.allowLoopbackHttp === true),
    ticket: credentialSchema,
    expiresAt: z
      .number()
      .int()
      .positive()
      .finite()
      .superRefine((value, context) => {
        if (value <= now()) {
          context.addIssue({ code: 'custom', message: 'pairing_expired' });
        }
      }),
  });
}

export const pairingQrSchema = pairingQrSchemaFor();

export type PairingCandidate = z.infer<typeof pairingCandidateSchema>;
export type PairingSession = z.infer<typeof pairingSessionSchema>;
export type PairingSessionV2 = z.infer<typeof pairingSessionV2Schema>;
export type PairingSelection = z.infer<typeof pairingSelectionSchema>;
export type PairingProgress = z.infer<typeof pairingProgressSchema>;
export type PairingCandidateResult = z.infer<typeof pairingCandidateResultSchema>;
export type PairingRetryRequest = z.infer<typeof pairingRetryRequestSchema>;
export type PairingQr = z.infer<typeof pairingQrSchema>;

export type PairingRegistrationAuthorization = {
  ticket: string;
  deviceSecret: string;
  candidateId: string;
  idempotencyKey: string;
};

export function pairingQrContent(
  session: PairingSession | PairingSessionV2,
  serverUrl: string,
  options: PairingClockOptions & { allowLoopbackHttp?: boolean } = {},
): string {
  const parsedSession = 'pairingCode' in session
    ? pairingSessionV2SchemaFor(options).parse(session)
    : pairingSessionSchemaFor(options).parse(session);
  const qr = pairingQrSchemaFor(options).parse({
    type: 'clawmessenger_pairing',
    version: 1,
    server: pairingServerUrl(serverUrl, options.allowLoopbackHttp === true),
    ticket: parsedSession.ticket,
    expiresAt: Date.parse(parsedSession.expiresAt),
  });
  return JSON.stringify(qr);
}
