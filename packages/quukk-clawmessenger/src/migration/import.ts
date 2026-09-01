import { StoredConfigSchema, type StoredConfig } from '../config/schema.js';
import type { LocalStore } from '../config/store.js';
import { LegacyConfigCandidateSchema, type LegacyConfigCandidate } from './discover.js';

type LegacyMigrationErrorCode = 'confirmation_required' | 'invalid_candidate';

export class LegacyMigrationError extends Error {
  readonly code: LegacyMigrationErrorCode;

  constructor(code: LegacyMigrationErrorCode) {
    super(code);
    this.name = 'LegacyMigrationError';
    this.code = code;
  }

  toJSON(): { code: LegacyMigrationErrorCode } {
    return { code: this.code };
  }
}

export async function importLegacyConfig(options: {
  confirmed: boolean;
  candidate: LegacyConfigCandidate;
  store: Pick<LocalStore, 'snapshot' | 'saveConfig'>;
}): Promise<StoredConfig> {
  if (options.confirmed !== true) throw new LegacyMigrationError('confirmation_required');
  const candidate = LegacyConfigCandidateSchema.safeParse(options.candidate);
  if (!candidate.success) throw new LegacyMigrationError('invalid_candidate');

  const current = (await options.store.snapshot({}, {})).config;
  const imported = candidate.data.settings;
  const next = StoredConfigSchema.safeParse({
    ...current,
    ...(imported.serverUrl === undefined ? {} : { serverUrl: imported.serverUrl }),
    ...(imported.defaultWorkdir === undefined
      ? {}
      : { defaultWorkdir: imported.defaultWorkdir }),
    ...(imported.authorizedWorkRoots === undefined
      ? {}
      : { authorizedWorkRoots: imported.authorizedWorkRoots }),
    providerPathOverrides: {
      ...current.providerPathOverrides,
      ...imported.providerPathOverrides,
    },
  });
  if (!next.success) throw new LegacyMigrationError('invalid_candidate');
  await options.store.saveConfig(next.data);
  return (await options.store.snapshot({}, {})).config;
}
