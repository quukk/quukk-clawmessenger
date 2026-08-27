import { describe, expect, it } from 'vitest';

import {
  BrowserSessionStore,
  constantTimeCredentialEqual,
  deriveControlCredential,
  securityHeaders,
} from './security.js';

const INSTANCE_A = `svc_${'a'.repeat(32)}`;
const BRIDGE_SECRET = 'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE';

function deterministicRandom() {
  let value = 0;
  return (size: number): Buffer => Buffer.alloc(size, ++value);
}

function cookie(value: string): string {
  return `other=kept; quukk_session=${value}; theme=dark`;
}

describe('BrowserSessionStore', () => {
  it('creates canonical in-memory session and CSRF credentials', () => {
    const store = new BrowserSessionStore({ now: () => 1_000, randomBytes: deterministicRandom() });

    const created = store.create();
    const authenticated = store.authenticate(cookie(created.cookieValue));

    expect(created).toEqual({
      cookieValue: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE',
      csrfToken: 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI',
      expiresInMs: 28_800_000,
    });
    expect(authenticated).toBeDefined();
    expect(store.verifyCsrf(authenticated!.sessionKey, created.csrfToken)).toBe(true);
    expect(store.verifyCsrf(authenticated!.sessionKey, `${created.csrfToken.slice(0, -1)}A`)).toBe(false);
    expect(JSON.stringify(store)).not.toContain(created.cookieValue);
    expect(JSON.stringify(store)).not.toContain(created.csrfToken);
  });

  it('rejects oversized, duplicate, malformed, unknown, and expired session cookies', () => {
    let now = 0;
    const store = new BrowserSessionStore({
      now: () => now,
      randomBytes: deterministicRandom(),
      idleTtlMs: 100,
      absoluteTtlMs: 1_000,
    });
    const created = store.create();

    expect(store.authenticate(`quukk_session=${created.cookieValue}; quukk_session=${created.cookieValue}`)).toBeUndefined();
    expect(store.authenticate(`quukk_session=${'x'.repeat(44)}`)).toBeUndefined();
    expect(store.authenticate(`quukk_session=${created.cookieValue}%00`)).toBeUndefined();
    expect(store.authenticate(`padding=${'x'.repeat(4_097)}`)).toBeUndefined();
    expect(store.authenticate(undefined)).toBeUndefined();
    now = 100;
    expect(store.authenticate(cookie(created.cookieValue))).toBeUndefined();
  });

  it('enforces the absolute lifetime even when successful reads refresh idle time', () => {
    let now = 0;
    const store = new BrowserSessionStore({
      now: () => now,
      randomBytes: deterministicRandom(),
      idleTtlMs: 100,
      absoluteTtlMs: 250,
    });
    const created = store.create();

    now = 90;
    expect(store.authenticate(cookie(created.cookieValue))).toBeDefined();
    now = 180;
    expect(store.authenticate(cookie(created.cookieValue))).toBeDefined();
    now = 249;
    expect(store.authenticate(cookie(created.cookieValue))).toBeDefined();
    now = 250;
    expect(store.authenticate(cookie(created.cookieValue))).toBeUndefined();
  });

  it('does not extend idle lifetime when CSRF verification fails', () => {
    let now = 0;
    const store = new BrowserSessionStore({
      now: () => now,
      randomBytes: deterministicRandom(),
      idleTtlMs: 100,
      absoluteTtlMs: 1_000,
    });
    const created = store.create();

    now = 90;
    const attempted = store.authenticate(cookie(created.cookieValue));
    expect(attempted).toBeDefined();
    expect(store.verifyCsrf(attempted!.sessionKey, 'wrong')).toBe(false);
    now = 101;
    expect(store.authenticate(cookie(created.cookieValue))).toBeUndefined();
  });

  it('prunes expired sessions then evicts only the least recently used live session', () => {
    let now = 0;
    const store = new BrowserSessionStore({
      now: () => now,
      randomBytes: deterministicRandom(),
      idleTtlMs: 1_000,
      absoluteTtlMs: 2_000,
      maximumSessions: 2,
    });
    const first = store.create();
    now = 1;
    const second = store.create();
    now = 2;
    expect(store.authenticate(cookie(first.cookieValue))).toBeDefined();
    now = 3;
    const third = store.create();

    expect(store.authenticate(cookie(first.cookieValue))).toBeDefined();
    expect(store.authenticate(cookie(second.cookieValue))).toBeUndefined();
    expect(store.authenticate(cookie(third.cookieValue))).toBeDefined();
  });

  it('clear invalidates every browser session', () => {
    const store = new BrowserSessionStore({ now: () => 0, randomBytes: deterministicRandom() });
    const created = store.create();
    store.clear();
    expect(store.authenticate(cookie(created.cookieValue))).toBeUndefined();
  });
});

describe('internal control security', () => {
  it('derives the exact domain-separated control credential', () => {
    expect(deriveControlCredential(BRIDGE_SECRET, INSTANCE_A)).toBe(
      'niGybCANqDk2v-9e1Jm49NGYDOaKCFPNRe-gFdZFxhg',
    );
  });

  it('compares only canonical bounded credentials and never accepts a prefix', () => {
    const expected = deriveControlCredential(BRIDGE_SECRET, INSTANCE_A);
    expect(constantTimeCredentialEqual(expected, expected)).toBe(true);
    expect(constantTimeCredentialEqual(expected, expected.slice(0, -1))).toBe(false);
    expect(constantTimeCredentialEqual(expected, `${expected.slice(0, -1)}A`)).toBe(false);
    expect(constantTimeCredentialEqual(expected, 'x'.repeat(1_000))).toBe(false);
  });

  it('returns the fixed common security header allowlist without CORS', () => {
    const headers = securityHeaders();
    expect(headers).toEqual({
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; frame-src 'none'; worker-src 'none'; form-action 'self'",
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    });
    expect(Object.keys(headers).some((name) => name.toLowerCase().startsWith('access-control-'))).toBe(false);
  });
});
