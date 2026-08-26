import { isAbsolute } from 'node:path';

import { z } from 'zod';

export const PROVIDERS = ['opencode', 'openclaw', 'codex', 'hermes'] as const;
export const ProviderSchema = z.enum(PROVIDERS);
export type Provider = z.infer<typeof ProviderSchema>;

export const LOG_LEVELS = ['silent', 'error', 'warn', 'info', 'debug'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type RuntimeDiscoveryStatus =
  | 'ready'
  | 'needs_auth'
  | 'found_not_runnable'
  | 'not_found'
  | 'probe_failed';

export type TrustedRuntime = {
  id: string;
  provider: Provider;
  path: string;
  status: RuntimeDiscoveryStatus;
};

const localErrorCodes = [
  'invalid_config',
  'config_recovery_required',
  'local_state_recovery_required',
  'credentials_recovery_required',
  'local_persistence_failed',
  'runtime_not_found',
  'runtime_not_ready',
  'runtime_identity_changed',
  'provider_conflict',
  'workdir_not_authorized',
  'interrupted_registration',
] as const;

export type LocalErrorCode = (typeof localErrorCodes)[number];

export const REGISTRATION_ERROR_CODES = [
  'invalid_server_url',
  'app_key_unavailable',
  'registration_cancelled',
  'registration_unauthorized',
  'registration_rejected',
  'registration_transport',
  'registration_timeout',
  'registration_response_invalid',
  'registration_node_mismatch',
  'registration_capabilities_mismatch',
  'token_refresh_failed',
] as const;

export type RegistrationErrorCode = (typeof REGISTRATION_ERROR_CODES)[number];

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (host === 'localhost' || host === '::1') return true;
  const octets = host.split('.');
  return (
    octets.length === 4 &&
    octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255) &&
    Number(octets[0]) === 127
  );
}

export const ServerUrlSchema = z
  .string()
  .min(1)
  .max(4096)
  .superRefine((value, context) => {
    if (value !== value.trim() || value.includes('?') || value.includes('#')) {
      context.addIssue({ code: 'custom', message: 'invalid_server_url' });
      return;
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      context.addIssue({ code: 'custom', message: 'invalid_server_url' });
      return;
    }
    const secure = url.protocol === 'https:';
    const localPlaintext = url.protocol === 'http:' && isLoopbackHostname(url.hostname);
    if (
      (!secure && !localPlaintext) ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      context.addIssue({ code: 'custom', message: 'invalid_server_url' });
    }
  })
  .transform((value) => new URL(value).toString().replace(/\/+$/, ''));

export function normalizeServerUrl(value: string): string {
  return ServerUrlSchema.parse(value);
}

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

export const StoredConfigSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    serverUrl: ServerUrlSchema,
    defaultWorkdir: absolutePathSchema.nullable(),
    authorizedWorkRoots: z.array(absolutePathSchema).max(32),
    providerPathOverrides: providerPathOverridesSchema,
    logLevel: z.enum(LOG_LEVELS),
  })
  .superRefine((value, context) => {
    if (new Set(value.authorizedWorkRoots).size !== value.authorizedWorkRoots.length) {
      context.addIssue({ code: 'custom', path: ['authorizedWorkRoots'], message: 'duplicate_path' });
    }
  });

export type StoredConfig = z.infer<typeof StoredConfigSchema>;

export const DEFAULT_CONFIG: StoredConfig = {
  schemaVersion: 1,
  serverUrl: 'https://newsradar.dreamdt.cn/im',
  defaultWorkdir: null,
  authorizedWorkRoots: [],
  providerPathOverrides: {},
  logLevel: 'info',
};

export type ConfigOverrides = Partial<
  Pick<
    StoredConfig,
    | 'serverUrl'
    | 'defaultWorkdir'
    | 'authorizedWorkRoots'
    | 'providerPathOverrides'
    | 'logLevel'
  >
>;

export const RUNTIME_ID_PATTERN = /^rt_[0-9a-f]{32}$/;
export const TOKEN_REF_PATTERN = /^rc_[0-9a-f]{32}$/;
const NODE_SUFFIX_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/;

export function isValidNodeId(provider: Provider, nodeId: string): boolean {
  return nodeId.startsWith(`${provider}_`) && NODE_SUFFIX_PATTERN.test(nodeId.slice(provider.length + 1));
}

export const RegistrationStateSchema = z.enum([
  'unregistered',
  'registering',
  'online',
  'offline',
  'error',
]);
export type RegistrationState = z.infer<typeof RegistrationStateSchema>;

export const RuntimeBindingSchema = z
  .strictObject({
    runtimeId: z.string().regex(RUNTIME_ID_PATTERN),
    runtimePath: absolutePathSchema,
    provider: ProviderSchema,
    enabled: z.boolean(),
    nodeId: z.string().max(137).optional(),
    nodeName: z.string().min(1).max(128).refine((value) => value === value.trim()),
    tokenRef: z.string().regex(TOKEN_REF_PATTERN).optional(),
    registrationState: RegistrationStateSchema,
    lastErrorCode: z.string().regex(/^[a-z0-9_]+$/).max(64).optional(),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .superRefine((value, context) => {
    if (value.nodeId !== undefined && !isValidNodeId(value.provider, value.nodeId)) {
      context.addIssue({ code: 'custom', path: ['nodeId'], message: 'invalid_node_id' });
    }
    const complete = value.nodeId !== undefined && value.tokenRef !== undefined;
    if (value.enabled && !complete) {
      context.addIssue({ code: 'custom', message: 'enabled_binding_incomplete' });
    }
    if ((value.registrationState === 'online' || value.registrationState === 'offline') && !complete) {
      context.addIssue({ code: 'custom', message: 'connected_binding_incomplete' });
    }
    if (
      value.registrationState === 'unregistered' &&
      (value.nodeId !== undefined || value.tokenRef !== undefined)
    ) {
      context.addIssue({ code: 'custom', message: 'unregistered_binding_has_identity' });
    }
  });

export type RuntimeBinding = z.infer<typeof RuntimeBindingSchema>;

export const LocalStateSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    installId: z.uuidv4().refine((value) => value === value.toLowerCase()),
    bindings: z.array(RuntimeBindingSchema).max(PROVIDERS.length),
  })
  .superRefine((value, context) => {
    if (new Set(value.bindings.map((binding) => binding.runtimeId)).size !== value.bindings.length) {
      context.addIssue({ code: 'custom', path: ['bindings'], message: 'duplicate_runtime' });
    }
    if (new Set(value.bindings.map((binding) => binding.provider)).size !== value.bindings.length) {
      context.addIssue({ code: 'custom', path: ['bindings'], message: 'duplicate_provider' });
    }
  });

export type LocalState = z.infer<typeof LocalStateSchema>;

export const RongCloudCredentialSchema = z
  .strictObject({
    runtimeId: z.string().regex(RUNTIME_ID_PATTERN),
    provider: ProviderSchema,
    nodeId: z.string().max(137),
    serverUrl: ServerUrlSchema,
    appKey: z.string().min(1).max(256).refine((value) => value === value.trim()),
    token: z.string().min(1).max(16384).refine((value) => value === value.trim()),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .superRefine((value, context) => {
    if (!isValidNodeId(value.provider, value.nodeId)) {
      context.addIssue({ code: 'custom', path: ['nodeId'], message: 'invalid_node_id' });
    }
  });

export type RongCloudCredential = z.infer<typeof RongCloudCredentialSchema>;

const bridgeSecretSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/)
  .refine((value) => {
    const decoded = Buffer.from(value, 'base64url');
    return decoded.byteLength === 32 && decoded.toString('base64url') === value;
  });

export const CredentialFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  bridgeSecret: bridgeSecretSchema,
  tokens: z.record(z.string().regex(TOKEN_REF_PATTERN), RongCloudCredentialSchema),
});

export type CredentialFile = z.infer<typeof CredentialFileSchema>;
