import { describe, expect, it } from 'vitest';

import {
  KNOWN_PROVIDERS,
  MAX_BINDINGS,
  PROVIDERS,
  PROVIDER_ID_PATTERN,
  ProviderSchema,
} from './schema.js';

describe('provider schema guard', () => {
  it('keeps every known provider id well-formed', () => {
    // KNOWN_PROVIDERS is a hand-maintained display order list; a typo here would
    // silently break runtime discovery and config parsing, so guard the format.
    for (const provider of KNOWN_PROVIDERS) {
      expect(PROVIDER_ID_PATTERN.test(provider), `provider id: ${provider}`).toBe(true);
      expect(ProviderSchema.safeParse(provider).success, `provider id: ${provider}`).toBe(true);
    }
  });

  it('keeps known providers unique', () => {
    expect(new Set(KNOWN_PROVIDERS).size).toBe(KNOWN_PROVIDERS.length);
  });

  it('keeps the legacy PROVIDERS alias aligned with KNOWN_PROVIDERS', () => {
    expect(PROVIDERS).toBe(KNOWN_PROVIDERS);
  });

  it('supports provider ids beyond the known list (data-driven expansion)', () => {
    // Data-driven provider expansion (docs/provider-expansion-plan.md §3.2):
    // ids coming from the Go runtime catalog are format-validated, not
    // enumerated, so new providers need no TS change.
    expect(ProviderSchema.safeParse('claude').success).toBe(true);
    expect(ProviderSchema.safeParse('qwenpaw').success).toBe(true);
  });

  it('rejects malformed provider ids', () => {
    for (const invalid of ['', 'Opencode', 'opencode cli', '-opencode', '1opencode', 'a'.repeat(65)]) {
      expect(ProviderSchema.safeParse(invalid).success, `provider id: ${invalid}`).toBe(false);
    }
  });

  it('bounds MAX_BINDINGS to a sane range', () => {
    expect(MAX_BINDINGS).toBeGreaterThanOrEqual(KNOWN_PROVIDERS.length);
    expect(MAX_BINDINGS).toBeLessThanOrEqual(64);
  });
});
