import { lstat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

import { z } from 'zod';

import { readJsonFile } from '../config/atomic-json.js';
import { ServerUrlSchema } from '../config/schema.js';

const LEGACY_CONFIG_MAX_BYTES = 64 * 1024;

const absolutePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value === value.trim() && !value.includes('\0') && isAbsolute(value));

const providerPathOverridesSchema = z.strictObject({
  opencode: absolutePathSchema.optional(),
  openclaw: absolutePathSchema.optional(),
  codex: absolutePathSchema.optional(),
  hermes: absolutePathSchema.optional(),
});

export const LegacyImportSettingsSchema = z.strictObject({
  serverUrl: ServerUrlSchema.optional(),
  defaultWorkdir: absolutePathSchema.nullable().optional(),
  authorizedWorkRoots: z.array(absolutePathSchema).max(32).optional(),
  providerPathOverrides: providerPathOverridesSchema,
}).superRefine((value, context) => {
  if (
    value.authorizedWorkRoots !== undefined
    && new Set(value.authorizedWorkRoots).size !== value.authorizedWorkRoots.length
  ) context.addIssue({ code: 'custom', path: ['authorizedWorkRoots'], message: 'duplicate_path' });
});

export type LegacyImportSettings = z.infer<typeof LegacyImportSettingsSchema>;

const boundedOptionalString = (maximum: number) => z.string().max(maximum).optional();

const LegacyOpenCodeConfigSchema = z.strictObject({
  appKey: boundedOptionalString(256),
  appSecret: boundedOptionalString(16_384),
  token: boundedOptionalString(16_384),
  accountId: boundedOptionalString(256),
  nodeName: boundedOptionalString(256),
  serverUrl: ServerUrlSchema.optional(),
  opencodeUrl: boundedOptionalString(4096),
  opencodeDir: absolutePathSchema.optional(),
  opencodePassword: boundedOptionalString(16_384),
  apiBaseUrl: boundedOptionalString(4096),
  chatTimeout: z.number().finite().positive().max(86_400).optional(),
  autoApprove: z.boolean().optional(),
  botName: boundedOptionalString(256),
  showProcess: z.enum(['none', 'tools', 'thinking', 'full']).optional(),
  hooks: z.strictObject({
    onSessionCreated: boundedOptionalString(4096),
    onSessionIdle: boundedOptionalString(4096),
  }).optional(),
  defaultWorkdir: absolutePathSchema.nullable().optional(),
  authorizedWorkRoots: z.array(absolutePathSchema).max(32).optional(),
  opencodePath: absolutePathSchema.optional(),
  providerPathOverrides: providerPathOverridesSchema.optional(),
}).superRefine((value, context) => {
  if (
    value.defaultWorkdir !== undefined
    && value.opencodeDir !== undefined
    && value.defaultWorkdir !== value.opencodeDir
  ) context.addIssue({ code: 'custom', path: ['defaultWorkdir'], message: 'conflicting_workdir' });
  if (
    value.opencodePath !== undefined
    && value.providerPathOverrides?.opencode !== undefined
    && value.opencodePath !== value.providerPathOverrides.opencode
  ) context.addIssue({ code: 'custom', path: ['opencodePath'], message: 'conflicting_provider_path' });
  if (
    value.authorizedWorkRoots !== undefined
    && new Set(value.authorizedWorkRoots).size !== value.authorizedWorkRoots.length
  ) context.addIssue({ code: 'custom', path: ['authorizedWorkRoots'], message: 'duplicate_path' });
}).transform((value): LegacyImportSettings => {
  const defaultWorkdir = value.defaultWorkdir !== undefined
    ? value.defaultWorkdir
    : value.opencodeDir;
  const authorizedWorkRoots = value.authorizedWorkRoots
    ?? (defaultWorkdir === undefined || defaultWorkdir === null ? undefined : [defaultWorkdir]);
  const providerPathOverrides = {
    ...value.providerPathOverrides,
    ...(value.opencodePath === undefined ? {} : { opencode: value.opencodePath }),
  };
  return LegacyImportSettingsSchema.parse({
    ...(value.serverUrl === undefined ? {} : { serverUrl: value.serverUrl }),
    ...(defaultWorkdir === undefined ? {} : { defaultWorkdir }),
    ...(authorizedWorkRoots === undefined ? {} : { authorizedWorkRoots }),
    providerPathOverrides,
  });
});

export const LegacyConfigCandidateSchema = z.strictObject({
  source: z.literal('opencode-clawmessenger'),
  path: absolutePathSchema,
  status: z.literal('importable'),
  settings: LegacyImportSettingsSchema,
});

export type LegacyConfigCandidate = z.infer<typeof LegacyConfigCandidateSchema>;

export type LegacyConfigDiscovery = LegacyConfigCandidate | {
  source:
    | 'opencode-clawmessenger'
    | 'opencode-registration'
    | 'opencode-registration-previous'
    | 'shared-registration-legacy';
  path: string;
  status: 'credentials_excluded' | 'invalid';
};

export type LegacyConfigPaths = {
  settings: string;
  registration: string;
  previousRegistration: string;
  sharedLegacyRegistration: string;
};

export function legacyConfigPaths(homeDirectory: string): LegacyConfigPaths {
  if (
    typeof homeDirectory !== 'string'
    || homeDirectory.length === 0
    || homeDirectory.length > 4096
    || homeDirectory !== homeDirectory.trim()
    || homeDirectory.includes('\0')
    || !isAbsolute(homeDirectory)
  ) throw new Error('invalid_home');
  return {
    settings: join(homeDirectory, '.config', 'opencode', 'clawmessenger.json'),
    registration: join(homeDirectory, '.claw-bridge', 'opencode', 'opencode-config.json'),
    previousRegistration: join(homeDirectory, '.claw-bridge', 'opencode', 'config.json'),
    sharedLegacyRegistration: join(homeDirectory, '.claw-bridge', 'config.json'),
  };
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

async function fileKind(
  homeDirectory: string,
  path: string,
): Promise<'missing' | 'regular' | 'invalid'> {
  try {
    const root = await lstat(homeDirectory);
    if (root.isSymbolicLink() || !root.isDirectory()) return 'invalid';
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? 'missing' : 'invalid';
  }
  const child = relative(homeDirectory, path);
  if (child === '' || isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`)) {
    return 'invalid';
  }
  let current = homeDirectory;
  const parts = child.split(sep);
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]!);
    try {
      const value = await lstat(current);
      if (value.isSymbolicLink()) return 'invalid';
      if (index < parts.length - 1 && !value.isDirectory()) return 'invalid';
      if (index === parts.length - 1) return value.isFile() ? 'regular' : 'invalid';
    } catch (error) {
      return errorCode(error) === 'ENOENT' ? 'missing' : 'invalid';
    }
  }
  return 'invalid';
}

export async function discoverLegacyConfigs(homeDirectory: string): Promise<LegacyConfigDiscovery[]> {
  const paths = legacyConfigPaths(homeDirectory);
  const result: LegacyConfigDiscovery[] = [];
  const settingsKind = await fileKind(homeDirectory, paths.settings);
  if (settingsKind === 'invalid') {
    result.push({ source: 'opencode-clawmessenger', path: paths.settings, status: 'invalid' });
  } else if (settingsKind === 'regular') {
    try {
      const settings = await readJsonFile(
        paths.settings,
        LegacyOpenCodeConfigSchema,
        LEGACY_CONFIG_MAX_BYTES,
      );
      result.push(LegacyConfigCandidateSchema.parse({
        source: 'opencode-clawmessenger',
        path: paths.settings,
        status: 'importable',
        settings,
      }));
    } catch {
      result.push({ source: 'opencode-clawmessenger', path: paths.settings, status: 'invalid' });
    }
  }

  const credentialSources = [
    ['opencode-registration', paths.registration],
    ['opencode-registration-previous', paths.previousRegistration],
    ['shared-registration-legacy', paths.sharedLegacyRegistration],
  ] as const;
  for (const [source, path] of credentialSources) {
    const kind = await fileKind(homeDirectory, path);
    if (kind === 'missing') continue;
    result.push({ source, path, status: kind === 'regular' ? 'credentials_excluded' : 'invalid' });
  }
  return result;
}
