import { describe, expect, it } from 'vitest';

import { CHANNEL, VERSION, channelForVersion } from './version.js';

describe('release channel', () => {
  it('treats a prerelease version as the beta channel', () => {
    expect(channelForVersion('0.1.0-beta.18')).toBe('beta');
    expect(channelForVersion('0.1.0-rc.1')).toBe('beta');
    expect(channelForVersion('1.2.3-0')).toBe('beta');
  });

  it('treats a plain version as the stable channel', () => {
    expect(channelForVersion('0.1.0')).toBe('stable');
    expect(channelForVersion('1.2.3')).toBe('stable');
  });

  it('derives the running channel from the published version', () => {
    expect(CHANNEL).toBe(channelForVersion(VERSION));
  });
});
