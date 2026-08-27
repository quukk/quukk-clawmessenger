import { describe, expect, it } from 'vitest';

import { LaunchTicketStore } from './tickets.js';

const INSTANCE_A = `svc_${'a'.repeat(32)}`;

function deterministicRandom() {
  let value = 0;
  return (size: number): Buffer => Buffer.alloc(size, ++value);
}

describe('LaunchTicketStore', () => {
  it('issues canonical 32-byte tickets and consumes each ticket only once', () => {
    const store = new LaunchTicketStore({
      instanceId: INSTANCE_A,
      now: () => 1_000,
      randomBytes: deterministicRandom(),
    });

    const issued = store.issue();

    expect(issued).toEqual({
      ticket: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE',
      expiresAt: 31_000,
    });
    expect(store.consume(issued.ticket)).toBe(true);
    expect(store.consume(issued.ticket)).toBe(false);
  });

  it('accepts a ticket before 30 seconds and deletes it at the exact expiry boundary', () => {
    let now = 0;
    const valid = new LaunchTicketStore({
      instanceId: INSTANCE_A,
      now: () => now,
      randomBytes: deterministicRandom(),
    });
    const validTicket = valid.issue().ticket;
    now = 29_999;
    expect(valid.consume(validTicket)).toBe(true);

    now = 0;
    const expired = new LaunchTicketStore({
      instanceId: INSTANCE_A,
      now: () => now,
      randomBytes: deterministicRandom(),
    });
    const expiredTicket = expired.issue().ticket;
    now = 30_000;
    expect(expired.consume(expiredTicket)).toBe(false);
    now = 1;
    expect(expired.consume(expiredTicket)).toBe(false);
  });

  it('fails closed at capacity without evicting an outstanding ticket', () => {
    const store = new LaunchTicketStore({
      instanceId: INSTANCE_A,
      now: () => 0,
      randomBytes: deterministicRandom(),
      maximumOutstanding: 2,
    });
    const first = store.issue().ticket;
    const second = store.issue().ticket;

    expect(() => store.issue()).toThrow('ticket_capacity');
    expect(store.consume(first)).toBe(true);
    expect(store.consume(second)).toBe(true);
  });

  it('clear invalidates every outstanding ticket and never serializes raw tickets', () => {
    const store = new LaunchTicketStore({
      instanceId: INSTANCE_A,
      now: () => 0,
      randomBytes: deterministicRandom(),
    });
    const ticket = store.issue().ticket;

    expect(JSON.stringify(store)).not.toContain(ticket);
    store.clear();
    expect(store.consume(ticket)).toBe(false);
  });

  it('rejects invalid identities and unsafe test bounds', () => {
    for (const options of [
      { instanceId: 'svc_invalid' },
      { instanceId: INSTANCE_A, ttlMs: 0 },
      { instanceId: INSTANCE_A, ttlMs: 30_001 },
      { instanceId: INSTANCE_A, maximumOutstanding: 0 },
      { instanceId: INSTANCE_A, maximumOutstanding: 17 },
    ]) {
      expect(() => new LaunchTicketStore(options)).toThrow();
    }
  });
});
