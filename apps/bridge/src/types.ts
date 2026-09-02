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

export type WorkerState = 'starting' | 'online' | 'offline' | 'backoff' | 'stopped';

export type RuntimeWorkerSummary = {
  state: WorkerState;
  restartCount: number;
};

export type BridgeRuntime = {
  id?: string;
  provider: Provider;
  version?: string;
  path?: string;
  status: RuntimeStatus;
  capabilities: RuntimeCapabilities;
  binding?: RuntimeBindingSummary;
  worker?: RuntimeWorkerSummary;
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

export type PairingState =
  | 'idle'
  | 'waiting'
  | 'claimed'
  | 'processing'
  | 'completed'
  | 'partial'
  | 'cancelled'
  | 'expired';

export type PairingStatusReason =
  | 'needs_auth'
  | 'found_not_runnable'
  | 'not_found'
  | 'probe_failed'
  | 'provider_conflict';

export type PairingCandidate = {
  candidateId: string;
  provider: Provider;
  version: string | null;
  readiness: 'ready' | 'not_ready' | 'already_registered';
  statusReason: PairingStatusReason | null;
  registrationState: 'unregistered' | 'registered';
};

export type PairingCandidateResult = {
  candidateId: string;
  status: 'pending' | 'registering' | 'bound' | 'already_bound' | 'failed';
  errorCode: string | null;
  retryable: boolean;
};

export type PairingSnapshot = {
  state: PairingState;
  expiresAt: string | null;
  qrContent: string | null;
  candidates: readonly PairingCandidate[];
  results: readonly PairingCandidateResult[];
};

export type ActivityEntry = {
  id: number;
  time: string;
  runtimeId?: string;
  kind: string;
  summary: string;
};

export type DiagnosticsSnapshot = {
  schemaVersion: 1;
  service: {
    version: string;
    state: 'starting' | 'ready' | 'stopping';
    pid: number;
    startedAt: string;
    listenHost: '127.0.0.1';
    port: number | null;
    uptimeMs: number;
  };
  bridge: {
    state: 'ready' | 'unavailable';
    pid?: number;
    version?: string;
    startedAt?: string;
    probeStatus?: 'ready' | 'refreshing';
    errorCode?: string;
  };
  runtimes: Array<{
    provider: Provider;
    status: RuntimeStatus;
    version?: string;
    executableName?: string;
  }>;
  workers: Array<{
    runtimeId: string;
    state: WorkerState;
    restartCount: number;
  }>;
  warnings: string[];
  logging: { dropped: number; retained: number };
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
  startPairing(signal?: AbortSignal): Promise<PairingSnapshot>;
  getPairing(signal?: AbortSignal): Promise<PairingSnapshot>;
  cancelPairing(signal?: AbortSignal): Promise<PairingSnapshot>;
  retryPairing(candidateIds: readonly string[], signal?: AbortSignal): Promise<PairingSnapshot>;
}

export type RegistrationProgress = {
  state: 'idle' | 'registering' | 'connected' | 'failed';
  errorCode?: string;
};
