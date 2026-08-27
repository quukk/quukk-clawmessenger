export const PROVIDERS = ['opencode', 'openclaw', 'codex', 'hermes'] as const;

export type Provider = (typeof PROVIDERS)[number];

export type RuntimeStatus =
  | 'ready'
  | 'needs_auth'
  | 'found_not_runnable'
  | 'not_found'
  | 'probe_failed';

export type RegistrationState =
  | 'unregistered'
  | 'registering'
  | 'online'
  | 'offline'
  | 'error';

export type RuntimeCapabilities = {
  sessionResume: boolean;
  cancel: boolean;
  textEvents: boolean;
  toolEvents: boolean;
  approvalEvents: boolean;
};

export type RuntimeBindingSummary = {
  enabled: boolean;
  registrationState: RegistrationState;
  lastErrorCode?: string;
};

export type BridgeRuntime = {
  id?: string;
  provider: Provider;
  version?: string;
  path?: string;
  status: RuntimeStatus;
  capabilities: RuntimeCapabilities;
  binding?: RuntimeBindingSummary;
};

export type BindingMutationResult =
  | { runtimeId: string; ok: true }
  | { runtimeId: string; ok: false; errorCode: string };

export type BridgeSettings = {
  serverUrl: string;
  defaultWorkdir: string | null;
  authorizedWorkRoots: string[];
  providerPathOverrides: Partial<Record<Provider, string>>;
  logLevel: 'silent' | 'error' | 'warn' | 'info' | 'debug';
};

export type ActivityEntry = {
  id: string;
  time: string;
  runtimeId?: string;
  kind: string;
  summary: string;
};

export type DiagnosticsSnapshot = {
  status: string;
  generatedAt: string;
  version?: string;
  runtimeCount?: number;
  [key: string]: unknown;
};

export interface BridgeApi {
  getRuntimes(): Promise<readonly BridgeRuntime[]>;
  rescanRuntimes(): Promise<readonly BridgeRuntime[]>;
  enableBindings(runtimeIds: readonly string[]): Promise<readonly BindingMutationResult[]>;
  disableBinding(runtimeId: string): Promise<void>;
  reregisterBinding(runtimeId: string): Promise<BindingMutationResult>;
  getActivity(): Promise<readonly ActivityEntry[]>;
  getDiagnostics(): Promise<DiagnosticsSnapshot>;
  getSettings(): Promise<BridgeSettings>;
  updateSettings(settings: BridgeSettings): Promise<BridgeSettings>;
}

export type RegistrationProgress = {
  state: 'idle' | 'registering' | 'connected' | 'failed';
  errorCode?: string;
};
