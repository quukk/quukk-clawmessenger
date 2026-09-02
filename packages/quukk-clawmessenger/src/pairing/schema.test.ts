// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  pairingCandidateSchema,
  pairingProgressSchema,
  pairingQrContent,
  pairingQrSchema,
  pairingQrSchemaFor,
  pairingSelectionSchema,
  pairingSessionSchemaFor,
  pairingSessionSchema,
} from './schema.js';

const TICKET = 't'.repeat(43);
const DEVICE_SECRET = 's'.repeat(43);

const candidate = {
  candidateId: 'cand-opencode',
  provider: 'opencode',
  displayName: 'OpenCode',
  version: '1.2.3',
  readiness: 'ready',
  statusReason: null,
  registrationState: 'unregistered',
} as const;

const validSession = {
  ticket: TICKET,
  deviceSecret: DEVICE_SECRET,
  expiresAt: '2099-09-02T12:05:00.000Z',
  status: 'waiting',
  candidates: [candidate],
} as const;

describe('pairing schemas', () => {
  it('accepts the bounded package/server contract', () => {
    expect(pairingCandidateSchema.parse(candidate)).toEqual(candidate);
    expect(pairingSessionSchema.parse(validSession)).toEqual(validSession);
    expect(
      pairingSelectionSchema.parse({
        status: 'claimed',
        selectedCandidateIds: ['cand-opencode'],
        candidates: [candidate],
        expiresAt: validSession.expiresAt,
      }),
    ).toMatchObject({ status: 'claimed', selectedCandidateIds: ['cand-opencode'] });
    expect(
      pairingProgressSchema.parse({
        status: 'processing',
        selectedCandidateIds: ['cand-opencode'],
        candidates: [candidate],
        expiresAt: validSession.expiresAt,
        results: [
          {
            candidateId: 'cand-opencode',
            status: 'registering',
            errorCode: null,
            nodeId: null,
          },
        ],
      }),
    ).toMatchObject({ status: 'processing' });
  });

  it('rejects a QR/session response containing a local path', () => {
    const unsafeCandidate = Object.assign({}, candidate, { path: 'C:\\secret' });
    const unsafeSession = Object.assign({}, validSession, { candidates: [unsafeCandidate] });
    expect(() => pairingSessionSchema.parse(unsafeSession)).toThrow();
  });

  it('rejects extra fields, unknown enums, duplicate IDs, and values over protocol bounds', () => {
    expect(() => pairingCandidateSchema.parse({ ...candidate, provider: 'unknown' })).toThrow();
    expect(() => pairingCandidateSchema.parse({ ...candidate, displayName: 'x'.repeat(81) })).toThrow();
    expect(() => pairingCandidateSchema.parse({ ...candidate, runtimeId: 'rt_private' })).toThrow();
    expect(() => pairingSessionSchema.parse({ ...validSession, ticket: 'short' })).toThrow();
    expect(() =>
      pairingSessionSchema.parse({ ...validSession, candidates: [candidate, candidate] }),
    ).toThrow();
    expect(() =>
      pairingSelectionSchema.parse({
        status: 'claimed',
        selectedCandidateIds: ['cand-opencode', 'cand-opencode'],
        candidates: [candidate],
        expiresAt: validSession.expiresAt,
      }),
    ).toThrow();
  });

  it('rejects expired session and QR timestamps using an injected clock', () => {
    const now = Date.parse('2026-09-02T12:00:00.000Z');
    const expiredAt = '2026-09-02T11:59:59.999Z';

    expect(() =>
      pairingSessionSchemaFor({ now: () => now }).parse({
        ...validSession,
        expiresAt: expiredAt,
      }),
    ).toThrow('pairing_expired');
    expect(() =>
      pairingQrSchemaFor({ now: () => now }).parse({
        type: 'clawmessenger_pairing',
        version: 1,
        server: 'https://configured.example',
        ticket: TICKET,
        expiresAt: Date.parse(expiredAt),
      }),
    ).toThrow('pairing_expired');
  });
});

describe('pairingQrContent', () => {
  it('serializes exactly the five public QR fields', () => {
    const content = pairingQrContent(validSession, 'https://configured.example/base');
    const parsed = pairingQrSchema.parse(JSON.parse(content));

    expect(parsed).toEqual({
      type: 'clawmessenger_pairing',
      version: 1,
      server: 'https://configured.example/base',
      ticket: TICKET,
      expiresAt: Date.parse(validSession.expiresAt),
    });
    expect(content).not.toContain(DEVICE_SECRET);
    expect(content).not.toMatch(/candidate|path|runtime/i);
  });

  it('requires HTTPS except for explicitly enabled loopback HTTP', () => {
    expect(() => pairingQrContent(validSession, 'http://example.com')).toThrow('pairing_server_invalid');
    expect(() => pairingQrContent(validSession, 'http://127.0.0.1:5000')).toThrow(
      'pairing_server_invalid',
    );
    const loopback = JSON.parse(
      pairingQrContent(validSession, 'http://localhost:5000', {
        allowLoopbackHttp: true,
      }),
    );
    expect(() => pairingQrSchema.parse(loopback)).toThrow('pairing_server_invalid');
    expect(pairingQrSchemaFor({ allowLoopbackHttp: true }).parse(loopback).server).toBe(
      'http://localhost:5000',
    );
    expect(() =>
      pairingQrContent(validSession, 'http://example.com', { allowLoopbackHttp: true }),
    ).toThrow('pairing_server_invalid');
  });

  it('refuses to emit an expired session using the same injected clock', () => {
    const now = Date.parse('2026-09-02T12:00:00.000Z');

    expect(() =>
      pairingQrContent(
        { ...validSession, expiresAt: '2026-09-02T12:00:00.000Z' },
        'https://configured.example',
        { now: () => now },
      ),
    ).toThrow('pairing_expired');
  });
});
