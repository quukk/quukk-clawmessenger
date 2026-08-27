// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { expectNoSentinels } from './redaction-assertions.js';

describe('E2E redaction assertions', () => {
  it.each([
    ['Windows', String.raw`D:\Users\quukk\provider-bin\opencode.exe`],
    ['POSIX', '/home/quukk/provider-bin/opencode'],
  ])('detects an exact %s sentinel in original nested string values', (_platform, sentinel) => {
    expect(() => expectNoSentinels({ nested: [{ value: sentinel }] }, [sentinel])).toThrow();
  });

  it('detects sentinels held by Error messages', () => {
    expect(() => expectNoSentinels(new Error('ERROR-SECRET-SENTINEL'), [
      'ERROR-SECRET-SENTINEL',
    ])).toThrow();
  });
});
