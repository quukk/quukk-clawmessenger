import { spawn as spawnProcess } from 'node:child_process';
import { randomBytes as cryptoRandomBytes } from 'node:crypto';
import { realpath as fsRealpath } from 'node:fs';
import { lstat as fsLstat, open as fsOpen } from 'node:fs/promises';
import {
  request as nodeHttpRequest,
  type ClientRequest,
  type IncomingMessage,
  type RequestOptions,
} from 'node:http';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { z } from 'zod';

import {
  CredentialFileSchema,
  DEFAULT_CONFIG,
  LocalStateSchema,
  PROVIDERS,
  StoredConfigSchema,
  type ConfigOverrides,
  type Provider,
  type RuntimeDiscoveryStatus,
} from './config/schema.js';
import { readJsonFile } from './config/atomic-json.js';
import { localPaths } from './config/paths.js';
import {
  DaemonIdentityStore,
  ReadyDaemonIdentitySchema,
  StartingDaemonIdentitySchema,
  type DaemonIdentity,
  type DaemonIdentityPersistence,
  type ReadyDaemonIdentity,
  type StartingDaemonIdentity,
} from './process/service-identity.js';
import {
  ControlStatusResponseSchema,
  RuntimesResponseSchema,
  type ControlStatusResponse,
  type RuntimesResponse,
} from './http/routes.js';
import { deriveControlCredential } from './http/security.js';
import {
  startProductionService,
  type ComposeProductionServiceOptions,
  type QuukkService,
} from './service.js';
import { VERSION } from './version.js';

const COMMANDS = ['setup', 'start', 'stop', 'status', 'logs', 'doctor', 'rescan'] as const;
type Command = (typeof COMMANDS)[number];

const CONFIG_OPTION_NAMES = [
  'server-url',
  'workdir',
  'authorized-work-root',
  'opencode-path',
  'openclaw-path',
  'codex-path',
  'hermes-path',
  'log-level',
] as const;

const CLI_PARSE_OPTIONS = {
  help: { type: 'boolean' },
  version: { type: 'boolean' },
  json: { type: 'boolean' },
  'no-open': { type: 'boolean' },
  foreground: { type: 'boolean' },
  'daemon-child': { type: 'boolean' },
  'server-url': { type: 'string' },
  workdir: { type: 'string' },
  'authorized-work-root': { type: 'string', multiple: true },
  'opencode-path': { type: 'string' },
  'openclaw-path': { type: 'string' },
  'codex-path': { type: 'string' },
  'hermes-path': { type: 'string' },
  'log-level': { type: 'string' },
  lines: { type: 'string' },
  follow: { type: 'boolean' },
} as const;

const PUBLIC_HELP = `Usage: quukk-clawmessenger <command> [options]

Commands:
  setup    Start the local service and open setup
  start    Start the local service
  stop     Stop the local service
  status   Show local service status
  logs     Read bounded local logs
  doctor   Show redacted diagnostics
  rescan   Rescan local AI runtimes

Global options:
  --help
  --version
  --json

Setup/start options:
  --no-open
  --foreground                 start only
  --server-url <url>
  --workdir <absolute-path>
  --authorized-work-root <absolute-path>
  --opencode-path <absolute-path>
  --openclaw-path <absolute-path>
  --codex-path <absolute-path>
  --hermes-path <absolute-path>
  --log-level <silent|error|warn|info|debug>

Logs options:
  --lines <1..1000>
  --follow`;

type CliErrorCode =
  | 'already_running_with_overrides'
  | 'authentication_mismatch'
  | 'browser_open_failed'
  | 'internal_failure'
  | 'invalid_config'
  | 'not_running'
  | 'operation_timeout'
  | 'operation_unavailable'
  | 'runtime_response_invalid'
  | 'unsafe_identity'
  | 'usage_error';

class CliFailure extends Error {
  constructor(readonly code: CliErrorCode) {
    super(code);
    this.name = 'CliFailure';
  }
}

export type DaemonInspection =
  | { kind: 'not_running' }
  | { kind: 'starting'; identity: StartingDaemonIdentity }
  | { kind: 'ready'; identity: ReadyDaemonIdentity; contentDigest: string }
  | { kind: 'corrupt'; errorCode: 'identity_corrupt' };

export interface StartInput {
  foreground: boolean;
  noOpen: boolean;
  configOverrides: ConfigOverrides;
}

export type StartResult = {
  identity: ReadyDaemonIdentity;
  alreadyRunning: boolean;
};

export type ControlResponse =
  | { command: 'status'; value: ControlStatusResponse }
  | { command: 'launch_ticket'; value: { ticket: string; expiresAt: number } }
  | { command: 'rescan'; value: RuntimesResponse }
  | { command: 'shutdown'; value: { accepted: true } };

export interface StaleInspection {
  identity: DaemonIdentity;
  contentDigest: string;
  pidProbe: 'esrch';
  controlAttempts: number;
}

export type CliDiagnostics =
  | { schemaVersion: 1; state: 'offline'; warnings?: readonly string[] }
  | {
      schemaVersion: 1;
      state: 'starting';
      service: { pid: number; version: string; startedAt: string };
      warnings?: readonly string[];
    }
  | {
      schemaVersion: 1;
      state: 'ready';
      service: {
        pid: number;
        version: string;
        startedAt: string;
        port: number;
        controlState: 'ready' | 'stopping';
      };
      runtimes: readonly { provider: Provider; status: RuntimeDiscoveryStatus }[];
      warnings?: readonly string[];
    }
  | {
      schemaVersion: 1;
      state: 'corrupt';
      errorCode: 'identity_corrupt';
      warnings?: readonly string[];
    };

const DiagnosticWarningsSchema = z
  .array(z.string().regex(/^[a-z0-9_]{1,64}$/))
  .max(64)
  .optional();
const DiagnosticServiceBase = {
  pid: z.number().int().positive().safe(),
  version: z.string().regex(/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/),
  startedAt: z.iso.datetime({ offset: true }),
};
const CliDiagnosticsSchema = z.discriminatedUnion('state', [
  z.object({
    schemaVersion: z.literal(1),
    state: z.literal('offline'),
    warnings: DiagnosticWarningsSchema,
  }),
  z.object({
    schemaVersion: z.literal(1),
    state: z.literal('starting'),
    service: z.strictObject(DiagnosticServiceBase),
    warnings: DiagnosticWarningsSchema,
  }),
  z.object({
    schemaVersion: z.literal(1),
    state: z.literal('ready'),
    service: z.strictObject({
      ...DiagnosticServiceBase,
      port: z.number().int().min(1).max(65_535),
      controlState: z.enum(['ready', 'stopping']),
    }),
    runtimes: z.array(z.strictObject({
      provider: z.enum(PROVIDERS),
      status: z.enum([
        'ready', 'needs_auth', 'found_not_runnable', 'not_found', 'probe_failed',
      ]),
    })).max(PROVIDERS.length),
    warnings: DiagnosticWarningsSchema,
  }),
  z.object({
    schemaVersion: z.literal(1),
    state: z.literal('corrupt'),
    errorCode: z.literal('identity_corrupt'),
    warnings: DiagnosticWarningsSchema,
  }),
]);

function canonicalLaunchTicket(value: string): string | undefined {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return undefined;
  try {
    const decoded = Buffer.from(value, 'base64url');
    const canonical = decoded.toString('base64url');
    return decoded.byteLength === 32 && canonical === value ? canonical : undefined;
  } catch {
    return undefined;
  }
}

const LaunchTicketControlResponseSchema = z.strictObject({
  command: z.literal('launch_ticket'),
  value: z.strictObject({
    ticket: z.string().refine((value) => canonicalLaunchTicket(value) !== undefined),
    expiresAt: z.number().int().positive().safe(),
  }),
});

export interface ForegroundRunOptions {
  daemonChild: boolean;
  onReady(identity: ReadyDaemonIdentity): Promise<void>;
}

export interface CliIO {
  stdout(value: string): void;
  stderr(value: string): void;
}

export interface CliRuntimePort {
  inspect(): Promise<DaemonInspection>;
  start(input: StartInput): Promise<StartResult>;
  runForeground(input: StartInput, options: ForegroundRunOptions): Promise<number>;
  control(
    identity: ReadyDaemonIdentity,
    command: 'status' | 'launch_ticket' | 'rescan' | 'shutdown',
  ): Promise<ControlResponse>;
  recoverStaleForStart(inspection: StaleInspection): Promise<boolean>;
  readLogs(input: { lines: number; follow: boolean }): AsyncIterable<string>;
  doctor(): Promise<CliDiagnostics>;
}

export interface BrowserPort {
  open(url: string): Promise<void>;
}

type BrowserChildProcess = {
  once(event: 'spawn', listener: () => void): BrowserChildProcess;
  once(event: 'error', listener: (error: Error) => void): BrowserChildProcess;
  off(event: 'spawn', listener: () => void): BrowserChildProcess;
  off(event: 'error', listener: (error: Error) => void): BrowserChildProcess;
  unref(): void;
};

export type BrowserSpawn = (
  executable: string,
  argv: readonly string[],
  options: {
    shell: false;
    detached: true;
    stdio: 'ignore';
    windowsHide: true;
    env: NodeJS.ProcessEnv;
  },
) => BrowserChildProcess;

export interface SystemBrowserPortOptions {
  platform?: NodeJS.Platform;
  spawn?: BrowserSpawn;
  environment?: NodeJS.ProcessEnv;
}

const BROWSER_ENV_ALLOWLIST = {
  win32: [
    'SYSTEMROOT', 'WINDIR', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
    'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP', 'PATH', 'PATHEXT', 'SESSIONNAME',
  ],
  darwin: [
    'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TEMP', 'TMP', 'PATH', 'LANG', 'LC_ALL',
    'LC_CTYPE',
  ],
  linux: [
    'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TEMP', 'TMP', 'PATH', 'LANG', 'LC_ALL',
    'LC_CTYPE', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR',
    'XDG_CURRENT_DESKTOP', 'XDG_SESSION_TYPE', 'DESKTOP_SESSION',
    'DBUS_SESSION_BUS_ADDRESS',
  ],
} as const;

function browserFailure(): CliFailure {
  return new CliFailure('browser_open_failed');
}

function browserEnvironment(
  platform: keyof typeof BROWSER_ENV_ALLOWLIST,
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const entries = Object.entries(source);
  const result: NodeJS.ProcessEnv = {};
  for (const name of BROWSER_ENV_ALLOWLIST[platform]) {
    const matches = entries.filter(([key]) => key.toUpperCase() === name);
    if (matches.length !== 1) continue;
    const value = matches[0]![1];
    if (value !== undefined) result[name] = value;
  }
  return result;
}

function validateBrowserUrl(value: string): void {
  if (value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) throw browserFailure();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw browserFailure();
  }
  const port = url.protocol === 'http:' && url.port === '' ? 80 : Number(url.port);
  const rawTicket = /^#ticket=([A-Za-z0-9_-]{43})$/.exec(url.hash)?.[1];
  const ticket = rawTicket === undefined ? undefined : canonicalLaunchTicket(rawTicket);
  if (
    url.protocol !== 'http:'
    || url.hostname !== '127.0.0.1'
    || !Number.isInteger(port)
    || port < 1
    || port > 65_535
    || (url.pathname !== '/' && url.pathname !== '/setup')
    || url.username !== ''
    || url.password !== ''
    || url.search !== ''
    || ticket === undefined
    || value !== `http://127.0.0.1:${port}${url.pathname}#ticket=${ticket}`
  ) throw browserFailure();
}

function defaultBrowserSpawn(
  executable: string,
  argv: readonly string[],
  options: Parameters<BrowserSpawn>[2],
): BrowserChildProcess {
  return spawnProcess(executable, [...argv], options) as BrowserChildProcess;
}

export function createSystemBrowserPort(
  options: SystemBrowserPortOptions = {},
): BrowserPort {
  const platform = options.platform ?? process.platform;
  const spawn = options.spawn ?? defaultBrowserSpawn;
  const environment = options.environment ?? process.env;
  return {
    async open(value): Promise<void> {
      validateBrowserUrl(value);
      if (platform !== 'win32' && platform !== 'darwin' && platform !== 'linux') {
        throw browserFailure();
      }
      const executable = platform === 'win32'
        ? 'explorer.exe'
        : platform === 'darwin'
          ? '/usr/bin/open'
          : 'xdg-open';
      let child: BrowserChildProcess;
      try {
        child = spawn(executable, [value], {
          shell: false,
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          env: browserEnvironment(platform, environment),
        });
      } catch {
        throw browserFailure();
      }
      return await new Promise<void>((resolve, reject) => {
        let settled = false;
        const failed = () => {
          if (settled) return;
          settled = true;
          child.off('spawn', spawned);
          child.off('error', failed);
          reject(browserFailure());
        };
        const spawned = () => {
          if (settled) return;
          settled = true;
          child.off('spawn', spawned);
          child.off('error', failed);
          child.once('error', () => {});
          resolve();
        };
        child.once('error', failed);
        child.once('spawn', spawned);
        try {
          child.unref();
        } catch {
          failed();
        }
      });
    },
  };
}

// Process identity, daemon spawning, stdin framing, and self-execution stay behind this port.
export interface RunCliOptions {
  runtime: CliRuntimePort;
  browser: BrowserPort;
  io: CliIO;
  environment?: NodeJS.ProcessEnv;
  now?: () => number;
}

type ParsedCli = {
  command: Command;
  json: boolean;
  noOpen: boolean;
  foreground: boolean;
  daemonChild: boolean;
  lines: number;
  follow: boolean;
  configOverrides: ConfigOverrides;
};

function isCommand(value: string): value is Command {
  return COMMANDS.includes(value as Command);
}

function countOptions(tokens: readonly { kind: string; name?: string }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    if (token.kind !== 'option' || token.name === undefined) continue;
    counts.set(token.name, (counts.get(token.name) ?? 0) + 1);
  }
  return counts;
}

function parseConfig(values: Record<string, unknown>): ConfigOverrides {
  const providerPathOverrides: Partial<Record<Provider, string>> = {};
  for (const provider of PROVIDERS) {
    const value = values[`${provider}-path`];
    if (typeof value === 'string') providerPathOverrides[provider] = value;
  }
  const candidate = StoredConfigSchema.safeParse({
    ...DEFAULT_CONFIG,
    serverUrl: values['server-url'] ?? DEFAULT_CONFIG.serverUrl,
    defaultWorkdir: values.workdir ?? DEFAULT_CONFIG.defaultWorkdir,
    authorizedWorkRoots: values['authorized-work-root'] ?? DEFAULT_CONFIG.authorizedWorkRoots,
    providerPathOverrides,
    logLevel: values['log-level'] ?? DEFAULT_CONFIG.logLevel,
  });
  if (!candidate.success) throw new CliFailure('invalid_config');

  const overrides: ConfigOverrides = {};
  if (values['server-url'] !== undefined) overrides.serverUrl = candidate.data.serverUrl;
  if (values.workdir !== undefined) overrides.defaultWorkdir = candidate.data.defaultWorkdir;
  if (values['authorized-work-root'] !== undefined) {
    overrides.authorizedWorkRoots = candidate.data.authorizedWorkRoots;
  }
  if (Object.keys(providerPathOverrides).length !== 0) {
    overrides.providerPathOverrides = candidate.data.providerPathOverrides;
  }
  if (values['log-level'] !== undefined) overrides.logLevel = candidate.data.logLevel;
  return overrides;
}

function parseCli(argv: readonly string[]): ParsedCli | 'help' | 'version' {
  const parsed = (() => {
    try {
      return parseArgs({
        args: [...argv],
        allowPositionals: true,
        strict: true,
        tokens: true,
        options: CLI_PARSE_OPTIONS,
      });
    } catch {
      throw new CliFailure('usage_error');
    }
  })();

  const counts = countOptions(parsed.tokens);
  for (const [name, count] of counts) {
    if (count > 1 && name !== 'authorized-work-root') throw new CliFailure('usage_error');
  }
  const enabledOptions = new Set(Object.keys(parsed.values));
  if (parsed.values.help === true) {
    if (
      enabledOptions.size !== 1
      || parsed.positionals.length > 1
      || (parsed.positionals[0] !== undefined && !isCommand(parsed.positionals[0]))
    ) throw new CliFailure('usage_error');
    return 'help';
  }
  if (parsed.values.version === true) {
    if (
      enabledOptions.size !== 1
      || parsed.positionals.length > 1
      || (parsed.positionals[0] !== undefined && !isCommand(parsed.positionals[0]))
    ) {
      throw new CliFailure('usage_error');
    }
    return 'version';
  }
  if (parsed.positionals.length !== 1 || !isCommand(parsed.positionals[0]!)) {
    throw new CliFailure('usage_error');
  }
  const command = parsed.positionals[0]!;
  const configOptions = CONFIG_OPTION_NAMES.filter((name) => parsed.values[name] !== undefined);
  const allowed = new Set<string>(['json']);
  if (command === 'setup' || command === 'start') {
    allowed.add('no-open');
    for (const option of CONFIG_OPTION_NAMES) allowed.add(option);
  }
  if (command === 'start') {
    allowed.add('foreground');
    allowed.add('daemon-child');
  }
  if (command === 'logs') {
    allowed.delete('json');
    allowed.add('lines');
    allowed.add('follow');
  }
  for (const option of enabledOptions) {
    if (!allowed.has(option)) throw new CliFailure('usage_error');
  }
  if (command !== 'setup' && command !== 'start' && configOptions.length !== 0) {
    throw new CliFailure('usage_error');
  }
  const daemonChild = parsed.values['daemon-child'] === true;
  if (
    daemonChild
    && !(
      command === 'start'
      && parsed.values.foreground === true
      && parsed.values['no-open'] === true
      && enabledOptions.size === 3
    )
  ) throw new CliFailure('usage_error');

  let lines = 100;
  if (parsed.values.lines !== undefined) {
    const value = parsed.values.lines;
    if (typeof value !== 'string' || !/^(?:[1-9]\d{0,2}|1000)$/.test(value)) {
      throw new CliFailure('usage_error');
    }
    lines = Number(value);
  }
  return {
    command,
    json: parsed.values.json === true,
    noOpen: parsed.values['no-open'] === true,
    foreground: parsed.values.foreground === true,
    daemonChild,
    lines,
    follow: parsed.values.follow === true,
    configOverrides: parseConfig(parsed.values),
  };
}

function emitStartSuccess(
  parsed: ParsedCli,
  io: CliIO,
  alreadyRunning: boolean,
): void {
  if (parsed.json) {
    io.stdout(JSON.stringify({
      schemaVersion: 1,
      ok: true,
      command: parsed.command,
      state: 'ready',
      alreadyRunning,
    }));
    return;
  }
  io.stdout(
    `quukk-clawmessenger: ${parsed.command} ${alreadyRunning ? 'already_running' : 'ready'}`,
  );
}

function exitCode(code: CliErrorCode): number {
  if (code === 'runtime_response_invalid' || code === 'internal_failure') return 1;
  if (code === 'not_running') return 3;
  if (code === 'authentication_mismatch' || code === 'unsafe_identity') return 4;
  if (
    code === 'browser_open_failed'
    || code === 'operation_timeout'
    || code === 'operation_unavailable'
  ) return 5;
  return 2;
}

type OutputContext = Pick<ParsedCli, 'command' | 'json'>;

function emitFailure(io: CliIO, parsed: OutputContext | undefined, code: CliErrorCode): number {
  if (parsed?.json === true) {
    io.stdout(JSON.stringify({
      schemaVersion: 1,
      ok: false,
      command: parsed.command,
      error: { code },
    }));
  } else {
    io.stderr(`quukk-clawmessenger: ${code}`);
  }
  return exitCode(code);
}

function requestedJsonOutput(argv: readonly string[]): OutputContext | undefined {
  try {
    const parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: false,
      tokens: true,
      options: CLI_PARSE_OPTIONS,
    });
    const counts = countOptions(parsed.tokens);
    if (counts.get('json') !== 1) return undefined;
    const command = parsed.positionals[0];
    if (command === undefined || !isCommand(command) || command === 'logs') return undefined;
    return { command, json: true };
  } catch {
    return undefined;
  }
}

function fixedFailure(error: unknown): CliFailure {
  if (error instanceof CliFailure) return error;
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
  if (code === 'invalid_config') return new CliFailure('invalid_config');
  if (code === 'already_running_with_overrides') {
    return new CliFailure('already_running_with_overrides');
  }
  if (
    code === 'control_unauthorized'
    || code === 'authentication_mismatch'
    || code === 'identity_mismatch'
  ) return new CliFailure('authentication_mismatch');
  if (
    code === 'identity_conflict'
    || code === 'identity_corrupt'
    || code === 'identity_invalid'
    || code === 'process_unverified'
    || code === 'stale_unverified'
    || code === 'unsafe_identity'
  ) return new CliFailure('unsafe_identity');
  if (
    code === 'operation_timeout'
    || code === 'shutdown_timeout'
    || code === 'startup_timeout'
    || code === 'timeout'
  ) {
    return new CliFailure('operation_timeout');
  }
  if (code === 'browser_open_failed') return new CliFailure('browser_open_failed');
  if (
    code === 'bridge_unavailable'
    || code === 'operation_unavailable'
    || code === 'service_unavailable'
    || code === 'unavailable'
  ) return new CliFailure('operation_unavailable');
  return new CliFailure('internal_failure');
}

function checkedStartResult(value: StartResult): StartResult {
  const identity = ReadyDaemonIdentitySchema.safeParse(value.identity);
  if (!identity.success || typeof value.alreadyRunning !== 'boolean') {
    throw new CliFailure('runtime_response_invalid');
  }
  return { identity: identity.data, alreadyRunning: value.alreadyRunning };
}

function checkedInspection(value: DaemonInspection): DaemonInspection {
  if (value?.kind === 'not_running') return { kind: 'not_running' };
  if (value?.kind === 'corrupt' && value.errorCode === 'identity_corrupt') {
    return { kind: 'corrupt', errorCode: 'identity_corrupt' };
  }
  if (value?.kind === 'starting') {
    const identity = StartingDaemonIdentitySchema.safeParse(value.identity);
    if (identity.success) return { kind: 'starting', identity: identity.data };
  }
  if (value?.kind === 'ready' && /^[0-9a-f]{64}$/.test(value.contentDigest)) {
    const identity = ReadyDaemonIdentitySchema.safeParse(value.identity);
    if (identity.success) {
      return { kind: 'ready', identity: identity.data, contentDigest: value.contentDigest };
    }
  }
  throw new CliFailure('runtime_response_invalid');
}

function sameIdentity(left: ReadyDaemonIdentity, right: ReadyDaemonIdentity): boolean {
  return left.schema_version === right.schema_version
    && left.state === right.state
    && left.pid === right.pid
    && left.version === right.version
    && left.instance_id === right.instance_id
    && left.started_at === right.started_at
    && left.address === right.address;
}

function portOf(identity: ReadyDaemonIdentity): number {
  return Number(identity.address.slice('127.0.0.1:'.length));
}

async function inspectForControl(
  command: 'status' | 'rescan' | 'stop',
  runtime: CliRuntimePort,
): Promise<ReadyDaemonIdentity | undefined> {
  const inspection = checkedInspection(await runtime.inspect());
  if (inspection.kind === 'not_running') {
    if (command === 'stop') return undefined;
    throw new CliFailure('not_running');
  }
  if (inspection.kind === 'starting') throw new CliFailure('operation_unavailable');
  if (inspection.kind === 'corrupt') throw new CliFailure('unsafe_identity');
  return inspection.identity;
}

function hasOverrides(value: ConfigOverrides): boolean {
  return Object.keys(value).length !== 0;
}

function fixedForegroundFailure(value: number): CliFailure {
  if (value === 2) return new CliFailure('usage_error');
  if (value === 3) return new CliFailure('not_running');
  if (value === 4) return new CliFailure('unsafe_identity');
  if (value === 5) return new CliFailure('operation_unavailable');
  return new CliFailure('internal_failure');
}

async function openBrowser(
  command: 'setup' | 'start',
  identity: ReadyDaemonIdentity,
  options: RunCliOptions,
): Promise<void> {
  const response = LaunchTicketControlResponseSchema.safeParse(
    await options.runtime.control(identity, 'launch_ticket'),
  );
  const now = options.now?.() ?? Date.now();
  const remaining = response.success ? response.data.value.expiresAt - now : Number.NaN;
  if (
    !response.success
    || !Number.isSafeInteger(now)
    || !Number.isSafeInteger(remaining)
    || remaining <= 0
    || remaining > 30_000
  ) throw new CliFailure('operation_unavailable');
  const pathname = command === 'setup' ? '/setup' : '/';
  const url = `http://${identity.address}${pathname}#ticket=${response.data.value.ticket}`;
  try {
    await options.browser.open(url);
  } catch {
    throw new CliFailure('browser_open_failed');
  }
}

async function startCommand(parsed: ParsedCli, options: RunCliOptions): Promise<number> {
  const input: StartInput = {
    foreground: parsed.foreground,
    noOpen: parsed.noOpen,
    configOverrides: parsed.configOverrides,
  };
  if (parsed.foreground) {
    let readySeen = false;
    let terminalExit: number | undefined;
    const emitTerminalFailure = (failure: CliFailure): number => {
      if (terminalExit !== undefined) return terminalExit;
      terminalExit = exitCode(failure.code);
      emitFailure(options.io, parsed, failure.code);
      return terminalExit;
    };
    const emitTerminalSuccess = (): number => {
      if (terminalExit !== undefined) return terminalExit;
      terminalExit = 0;
      emitStartSuccess(parsed, options.io, false);
      return terminalExit;
    };
    let runtimeExit: number;
    try {
      runtimeExit = await options.runtime.runForeground(input, {
        daemonChild: parsed.daemonChild,
        onReady: async (value) => {
          if (readySeen) {
            emitTerminalFailure(new CliFailure('runtime_response_invalid'));
            return;
          }
          readySeen = true;
          const identity = ReadyDaemonIdentitySchema.safeParse(value);
          if (!identity.success) {
            emitTerminalFailure(new CliFailure('runtime_response_invalid'));
            return;
          }
          if (!parsed.noOpen) {
            try {
              await openBrowser(parsed.command as 'start', identity.data, options);
            } catch (error) {
              emitTerminalFailure(fixedFailure(error));
              return;
            }
          }
          emitTerminalSuccess();
        },
      });
    } catch (error) {
      return emitTerminalFailure(fixedFailure(error));
    }
    if (terminalExit !== undefined) return terminalExit;
    if (!Number.isInteger(runtimeExit) || runtimeExit < 0 || runtimeExit > 255) {
      return emitTerminalFailure(new CliFailure('runtime_response_invalid'));
    }
    if (runtimeExit !== 0) {
      return emitTerminalFailure(fixedForegroundFailure(runtimeExit));
    }
    return emitTerminalFailure(new CliFailure('runtime_response_invalid'));
  }
  const result = checkedStartResult(await options.runtime.start(input));
  if (result.alreadyRunning && hasOverrides(parsed.configOverrides)) {
    throw new CliFailure('already_running_with_overrides');
  }
  if (!parsed.noOpen) {
    await openBrowser(parsed.command as 'setup' | 'start', result.identity, options);
  }
  emitStartSuccess(parsed, options.io, result.alreadyRunning);
  return 0;
}

function emitCommandSuccess(
  parsed: ParsedCli,
  io: CliIO,
  value: Record<string, unknown>,
  humanState: string,
): void {
  if (parsed.json) {
    io.stdout(JSON.stringify({
      schemaVersion: 1,
      ok: true,
      command: parsed.command,
      ...value,
    }));
  } else {
    io.stdout(`quukk-clawmessenger: ${parsed.command} ${humanState}`);
  }
}

async function statusCommand(parsed: ParsedCli, options: RunCliOptions): Promise<number> {
  const inspection = checkedInspection(await options.runtime.inspect());
  if (inspection.kind === 'not_running') throw new CliFailure('not_running');
  if (inspection.kind === 'corrupt') throw new CliFailure('unsafe_identity');
  if (inspection.kind === 'starting') {
    emitCommandSuccess(parsed, options.io, {
      state: 'starting',
      pid: inspection.identity.pid,
    }, 'starting');
    return 0;
  }
  const identity = inspection.identity;
  const response = await options.runtime.control(identity, 'status');
  if (response.command !== 'status') throw new CliFailure('runtime_response_invalid');
  const status = ControlStatusResponseSchema.safeParse(response.value);
  if (!status.success) throw new CliFailure('runtime_response_invalid');
  if (!sameIdentity(identity, status.data.identity)) {
    throw new CliFailure('authentication_mismatch');
  }
  emitCommandSuccess(parsed, options.io, {
    state: status.data.state,
    pid: identity.pid,
    port: portOf(identity),
  }, status.data.state);
  return 0;
}

async function rescanCommand(parsed: ParsedCli, options: RunCliOptions): Promise<number> {
  const identity = await inspectForControl('rescan', options.runtime);
  const response = await options.runtime.control(identity!, 'rescan');
  if (response.command !== 'rescan') throw new CliFailure('runtime_response_invalid');
  const runtimes = RuntimesResponseSchema.safeParse(response.value);
  if (!runtimes.success) throw new CliFailure('runtime_response_invalid');
  emitCommandSuccess(parsed, options.io, {
    runtimes: runtimes.data.runtimes.map((runtime) => ({
      provider: runtime.provider,
      status: runtime.status,
      runtimeId: runtime.runtimeId,
    })),
  }, 'ready');
  return 0;
}

async function stopCommand(parsed: ParsedCli, options: RunCliOptions): Promise<number> {
  const identity = await inspectForControl('stop', options.runtime);
  if (identity === undefined) {
    emitCommandSuccess(parsed, options.io, { state: 'not_running' }, 'not_running');
    return 0;
  }
  const response = await options.runtime.control(identity, 'shutdown');
  if (response.command !== 'shutdown' || response.value.accepted !== true) {
    throw new CliFailure('runtime_response_invalid');
  }
  emitCommandSuccess(parsed, options.io, { state: 'stopped' }, 'stopped');
  return 0;
}

function renderHumanDiagnostics(diagnostics: CliDiagnostics): string {
  const lines = [`quukk-clawmessenger: doctor ${diagnostics.state}`];
  if (diagnostics.state === 'starting') {
    lines.push(
      `service pid=${diagnostics.service.pid} version=${diagnostics.service.version} started_at=${diagnostics.service.startedAt}`,
    );
  } else if (diagnostics.state === 'ready') {
    lines.push(
      `service pid=${diagnostics.service.pid} version=${diagnostics.service.version} started_at=${diagnostics.service.startedAt} port=${diagnostics.service.port} control_state=${diagnostics.service.controlState}`,
    );
    for (const runtime of diagnostics.runtimes) {
      lines.push(`runtime provider=${runtime.provider} status=${runtime.status}`);
    }
  } else if (diagnostics.state === 'corrupt') {
    lines.push(`error code=${diagnostics.errorCode}`);
  }
  for (const warning of diagnostics.warnings ?? []) lines.push(`warning code=${warning}`);
  return lines.join('\n');
}

async function doctorCommand(parsed: ParsedCli, options: RunCliOptions): Promise<number> {
  const diagnostics = CliDiagnosticsSchema.safeParse(await options.runtime.doctor());
  if (!diagnostics.success) throw new CliFailure('runtime_response_invalid');
  if (parsed.json) {
    emitCommandSuccess(parsed, options.io, { diagnostics: diagnostics.data }, diagnostics.data.state);
  } else {
    options.io.stdout(renderHumanDiagnostics(diagnostics.data));
  }
  return 0;
}

async function logsCommand(parsed: ParsedCli, options: RunCliOptions): Promise<number> {
  for await (const line of options.runtime.readLogs({
    lines: parsed.lines,
    follow: parsed.follow,
  })) {
    if (typeof line !== 'string' || Buffer.byteLength(line, 'utf8') > 8_192) {
      throw new CliFailure('runtime_response_invalid');
    }
    options.io.stdout(line);
  }
  return 0;
}

export async function runCli(
  argv: readonly string[],
  options: RunCliOptions,
): Promise<number> {
  let parsedForOutput: OutputContext | undefined = requestedJsonOutput(argv);
  try {
    const parsed = parseCli(argv);
    if (parsed === 'version') {
      options.io.stdout(VERSION);
      return 0;
    }
    if (parsed === 'help') {
      options.io.stdout(PUBLIC_HELP);
      return 0;
    }
    parsedForOutput = parsed;
    if (parsed.command === 'setup' || parsed.command === 'start') {
      return await startCommand(parsed, options);
    }
    if (parsed.command === 'status') return await statusCommand(parsed, options);
    if (parsed.command === 'rescan') return await rescanCommand(parsed, options);
    if (parsed.command === 'stop') return await stopCommand(parsed, options);
    if (parsed.command === 'doctor') return await doctorCommand(parsed, options);
    return await logsCommand(parsed, options);
  } catch (error) {
    const failure = fixedFailure(error);
    return emitFailure(options.io, parsedForOutput, failure.code);
  }
}

type ProductionHttpRequest = (
  options: RequestOptions,
  callback: (response: IncomingMessage) => void,
) => ClientRequest;

type ProductionReadJson = <T>(
  filePath: string,
  schema: z.ZodType<T>,
  maximumBytes: number,
) => Promise<T>;

export interface ProductionCliServicePort {
  status(signal: AbortSignal): Promise<ControlStatusResponse>;
  stop(): Promise<void>;
}

export interface ProductionSignalPort {
  once(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export interface ProductionDaemonChild {
  pid?: number;
  stdin: {
    end(data: string, encoding: 'utf8'): unknown;
    once(event: 'error', listener: (error: Error) => void): unknown;
    off(event: 'error', listener: (error: Error) => void): unknown;
  } | null;
  once(event: 'error', listener: (error: Error) => void): unknown;
  off(event: 'error', listener: (error: Error) => void): unknown;
  unref(): void;
}

export type ProductionDaemonSpawn = (
  executable: string,
  argv: readonly string[],
  options: {
    shell: false;
    detached: true;
    windowsHide: true;
    stdio: ['pipe', 'ignore', 'ignore'];
    env: NodeJS.ProcessEnv;
  },
) => ProductionDaemonChild;

export interface ProductionLogSnapshot {
  fileId: string;
  bytes: Buffer;
}

export interface ProductionCliRuntimeDependencies {
  identityStore?: DaemonIdentityPersistence;
  processId?: number;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
  readStdin?: (maximumBytes: number) => Promise<Buffer>;
  readJson?: ProductionReadJson;
  request?: ProductionHttpRequest;
  startService?: (
    options: ComposeProductionServiceOptions,
  ) => Promise<ProductionCliServicePort>;
  signals?: ProductionSignalPort;
  spawn?: ProductionDaemonSpawn;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<unknown>;
  monotonicNow?: () => number;
  kill?: (pid: number, signal: 0) => unknown;
  readLogSnapshot?: (
    filePath: string,
    maximumBytes: number,
  ) => Promise<ProductionLogSnapshot | undefined>;
}

export interface ProductionCliRuntimeOptions {
  homeDirectory: string;
  processEnvironment: NodeJS.ProcessEnv;
  execPath: string;
  packagedBinPath: string;
  dependencies?: ProductionCliRuntimeDependencies;
}

class ProductionCliFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ProductionCliFailure';
  }
}

const CONTROL_RESPONSE_LIMIT = 1 << 20;
const CREDENTIAL_FILE_LIMIT = 4 << 20;
const METADATA_FILE_LIMIT = 1 << 20;
const CHILD_INPUT_LIMIT = 64 << 10;
const LOG_SNAPSHOT_LIMIT = 8 << 20;
const START_WAIT_MS = 65_000;
const SHUTDOWN_WAIT_MS = 20_000;
const POLL_MS = 100;

const ChildConfigOverridesSchema = z.strictObject({
  serverUrl: z.string().optional(),
  defaultWorkdir: z.string().nullable().optional(),
  authorizedWorkRoots: z.array(z.string()).optional(),
  providerPathOverrides: z.strictObject({
    opencode: z.string().optional(),
    openclaw: z.string().optional(),
    codex: z.string().optional(),
    hermes: z.string().optional(),
  }).optional(),
  logLevel: z.enum(['silent', 'error', 'warn', 'info', 'debug']).optional(),
});
const ChildStartInputSchema = z.strictObject({
  foreground: z.literal(false),
  noOpen: z.boolean(),
  configOverrides: ChildConfigOverridesSchema,
});

const RawLaunchTicketResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ticket: z.string().refine((value) => canonicalLaunchTicket(value) !== undefined),
  expiresAt: z.number().int().positive().safe(),
});
const RawShutdownResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  accepted: z.literal(true),
});

function productionFailure(code: string): ProductionCliFailure {
  return new ProductionCliFailure(code);
}

function normalizedProductionFailure(error: unknown): ProductionCliFailure {
  if (error instanceof ProductionCliFailure) return error;
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
  if (
    code === 'identity_conflict'
    || code === 'identity_corrupt'
    || code === 'identity_invalid'
    || code === 'process_unverified'
    || code === 'stale_unverified'
  ) return productionFailure(code);
  if (code === 'operation_timeout' || code === 'shutdown_timeout') {
    return productionFailure(code);
  }
  if (
    code === 'bridge_unavailable'
    || code === 'operation_unavailable'
    || code === 'service_unavailable'
    || code === 'unavailable'
  ) return productionFailure('operation_unavailable');
  return productionFailure('internal_failure');
}

function normalizedChildOverrides(value: z.infer<typeof ChildConfigOverridesSchema>): ConfigOverrides {
  const stored = StoredConfigSchema.safeParse({ ...DEFAULT_CONFIG, ...value });
  if (!stored.success) throw productionFailure('invalid_config');
  const result: ConfigOverrides = {};
  if (value.serverUrl !== undefined) result.serverUrl = stored.data.serverUrl;
  if (value.defaultWorkdir !== undefined) result.defaultWorkdir = stored.data.defaultWorkdir;
  if (value.authorizedWorkRoots !== undefined) {
    result.authorizedWorkRoots = stored.data.authorizedWorkRoots;
  }
  if (value.providerPathOverrides !== undefined) {
    result.providerPathOverrides = stored.data.providerPathOverrides;
  }
  if (value.logLevel !== undefined) result.logLevel = stored.data.logLevel;
  return result;
}

function parseChildStartInput(bytes: Buffer): StartInput {
  if (
    !Buffer.isBuffer(bytes)
    || bytes.byteLength < 2
    || bytes.byteLength > CHILD_INPUT_LIMIT
    || bytes.at(-1) !== 0x0a
    || bytes.subarray(0, -1).includes(0x0a)
    || bytes.subarray(0, -1).includes(0x0d)
  ) throw productionFailure('invalid_config');
  let value: unknown;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, -1));
    if (text !== text.trim() || !text.startsWith('{') || !text.endsWith('}')) {
      throw productionFailure('invalid_config');
    }
    value = JSON.parse(text) as unknown;
  } catch {
    throw productionFailure('invalid_config');
  }
  const parsed = ChildStartInputSchema.safeParse(value);
  if (!parsed.success) throw productionFailure('invalid_config');
  return {
    foreground: false,
    noOpen: parsed.data.noOpen,
    configOverrides: normalizedChildOverrides(parsed.data.configOverrides),
  };
}

async function defaultReadStdin(maximumBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += bytes.byteLength;
    if (total > maximumBytes) throw productionFailure('invalid_config');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function sameLogFile(
  left: { dev: number | bigint; ino: number | bigint; birthtimeMs: number },
  right: { dev: number | bigint; ino: number | bigint; birthtimeMs: number },
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.birthtimeMs === right.birthtimeMs;
}

async function defaultReadLogSnapshot(
  filePath: string,
  maximumBytes: number,
): Promise<ProductionLogSnapshot | undefined> {
  let before: Awaited<ReturnType<typeof fsLstat>>;
  try {
    before = await fsLstat(filePath);
  } catch (error) {
    if (errorCodeOf(error) === 'ENOENT') return undefined;
    throw productionFailure('operation_unavailable');
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw productionFailure('operation_unavailable');
  }
  let handle: Awaited<ReturnType<typeof fsOpen>>;
  try {
    handle = await fsOpen(filePath, 'r');
  } catch (error) {
    if (errorCodeOf(error) === 'ENOENT') return undefined;
    throw productionFailure('operation_unavailable');
  }
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || !sameLogFile(before, opened)
      || !Number.isSafeInteger(opened.size)
      || opened.size < 0
      || opened.size > maximumBytes
    ) throw productionFailure('operation_unavailable');
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    if (offset !== bytes.byteLength || after.size !== opened.size || !sameLogFile(opened, after)) {
      return undefined;
    }
    return {
      fileId: `${String(opened.dev)}:${String(opened.ino)}:${opened.birthtimeMs}`,
      bytes,
    };
  } catch (error) {
    if (error instanceof ProductionCliFailure) throw error;
    throw productionFailure('operation_unavailable');
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function completeLogLines(bytes: Buffer, offset: number): { lines: string[]; offset: number } {
  const lastLineFeed = bytes.lastIndexOf(0x0a);
  if (lastLineFeed < offset) return { lines: [], offset };
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(offset, lastLineFeed + 1),
    );
  } catch {
    throw productionFailure('operation_unavailable');
  }
  const lines = decoded.split('\n');
  lines.pop();
  if (lines.some((line) => line.includes('\r') || Buffer.byteLength(line, 'utf8') > 8_192)) {
    throw productionFailure('operation_unavailable');
  }
  return { lines, offset: lastLineFeed + 1 };
}

function rawResponseHeaders(response: IncomingMessage, name: string): string[] {
  const expected = name.toLowerCase();
  const values: string[] = [];
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    if (response.rawHeaders[index]?.toLowerCase() === expected) {
      values.push(response.rawHeaders[index + 1] ?? '');
    }
  }
  return values;
}

async function readStrictControlResponse(
  response: IncomingMessage,
  expectedStatus: number,
): Promise<unknown> {
  const rejectResponse = (): never => {
    try {
      response.destroy();
    } catch {
      // The fixed validation failure remains authoritative.
    }
    throw productionFailure('process_unverified');
  };
  const contentTypes = rawResponseHeaders(response, 'content-type');
  const contentLengths = rawResponseHeaders(response, 'content-length');
  if (
    response.statusCode !== expectedStatus
    || contentTypes.length !== 1
    || contentTypes[0] !== 'application/json; charset=utf-8'
    || contentLengths.length !== 1
    || !/^(?:0|[1-9]\d*)$/.test(contentLengths[0]!)
    || rawResponseHeaders(response, 'transfer-encoding').length !== 0
    || rawResponseHeaders(response, 'content-encoding').length !== 0
  ) rejectResponse();
  const declared = Number(contentLengths[0]);
  if (!Number.isSafeInteger(declared) || declared < 1 || declared > CONTROL_RESPONSE_LIMIT) {
    rejectResponse();
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of response) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      total += bytes.byteLength;
      if (total > declared || total > CONTROL_RESPONSE_LIMIT) {
        rejectResponse();
      }
      chunks.push(bytes);
    }
  } catch (error) {
    if (!(error instanceof ProductionCliFailure)) rejectResponse();
    throw error;
  }
  if (
    total !== declared
    || response.complete !== true
    || Object.keys(response.trailers).length !== 0
  ) rejectResponse();
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    return JSON.parse(text) as unknown;
  } catch {
    return rejectResponse();
  }
}

function defaultProductionRequest(
  options: RequestOptions,
  callback: (response: IncomingMessage) => void,
): ClientRequest {
  return nodeHttpRequest(options, callback);
}

function defaultProductionDaemonSpawn(
  executable: string,
  argv: readonly string[],
  options: Parameters<ProductionDaemonSpawn>[2],
): ProductionDaemonChild {
  return spawnProcess(executable, [...argv], options) as unknown as ProductionDaemonChild;
}

function daemonEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    const lower = key.toLowerCase();
    if (
      lower.startsWith('npm_')
      || lower === 'node_options'
      || lower === 'node_tls_reject_unauthorized'
    ) continue;
    if (typeof value === 'string') output[key] = value;
  }
  return output;
}

function errorCodeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function explicitlyUnreachable(error: unknown): boolean {
  return error instanceof ProductionCliFailure && error.code === 'connect_unreachable';
}

function controlTransportFailure(error: unknown): ProductionCliFailure {
  const code = errorCodeOf(error);
  return productionFailure(
    code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH'
      ? 'connect_unreachable'
      : 'process_unverified',
  );
}

function controlRequest(
  request: ProductionHttpRequest,
  identity: ReadyDaemonIdentity,
  credential: string,
  command: 'status' | 'launch_ticket' | 'rescan' | 'shutdown',
  timeoutMs = 5_000,
): Promise<unknown> {
  const body = Buffer.from(JSON.stringify({ command }), 'utf8');
  const port = portOf(identity);
  return new Promise<unknown>((resolvePromise, rejectPromise) => {
    let settled = false;
    let outgoing: ClientRequest | undefined;
    let activeResponse: IncomingMessage | undefined;
    const finish = (error: unknown, value?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error === undefined) resolvePromise(value);
      else rejectPromise(error);
    };
    const timer = setTimeout(() => {
      finish(productionFailure('operation_timeout'));
      try {
        outgoing?.destroy();
        activeResponse?.destroy();
      } catch {
        // The fixed timeout classification is authoritative.
      }
    }, timeoutMs);
    try {
      outgoing = request({
        protocol: 'http:',
        hostname: '127.0.0.1',
        port,
        method: 'POST',
        path: '/internal/control',
        agent: false,
        headers: {
          Host: `127.0.0.1:${port}`,
          Authorization: `Bearer ${credential}`,
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': String(body.byteLength),
          Connection: 'close',
        },
      }, (response) => {
        if (settled) {
          try {
            response.destroy();
          } catch {
            // The already-settled result remains authoritative.
          }
          return;
        }
        activeResponse = response;
        const expectedStatus = command === 'launch_ticket' ? 201 : command === 'shutdown' ? 202 : 200;
        void readStrictControlResponse(response, expectedStatus).then(
          (value) => finish(undefined, value),
          () => finish(productionFailure('process_unverified')),
        );
      });
      outgoing.once('error', (error) => finish(controlTransportFailure(error)));
      outgoing.end(body);
    } catch (error) {
      finish(controlTransportFailure(error));
    }
  });
}

function createStartingIdentity(
  processId: number,
  now: () => number,
  randomBytes: (size: number) => Buffer,
): StartingDaemonIdentity {
  const bytes = randomBytes(16);
  const milliseconds = now();
  const parsed = StartingDaemonIdentitySchema.safeParse({
    schema_version: 1,
    state: 'starting',
    pid: processId,
    version: VERSION,
    instance_id: Buffer.isBuffer(bytes) && bytes.byteLength === 16
      ? `svc_${bytes.toString('hex')}`
      : '',
    started_at: Number.isSafeInteger(milliseconds) && milliseconds >= 0
      ? new Date(milliseconds).toISOString()
      : '',
  });
  if (!parsed.success) throw productionFailure('identity_invalid');
  return parsed.data;
}

export function createProductionCliRuntime(
  options: ProductionCliRuntimeOptions,
): CliRuntimePort {
  if (
    !isAbsolute(options.homeDirectory)
    || !isAbsolute(options.execPath)
    || !isAbsolute(options.packagedBinPath)
  ) throw new RangeError('invalid_production_cli_options');
  const homeDirectory = resolve(options.homeDirectory);
  const paths = localPaths(homeDirectory);
  const processEnvironment = { ...options.processEnvironment };
  const dependencies = options.dependencies ?? {};
  const identityStore = dependencies.identityStore
    ?? new DaemonIdentityStore({ filePath: paths.daemonPid });
  const processId = dependencies.processId ?? process.pid;
  const now = dependencies.now ?? Date.now;
  const randomBytes = dependencies.randomBytes ?? cryptoRandomBytes;
  const readStdin = dependencies.readStdin ?? defaultReadStdin;
  const readJson = dependencies.readJson ?? readJsonFile;
  const request = dependencies.request ?? defaultProductionRequest;
  const spawn = dependencies.spawn ?? defaultProductionDaemonSpawn;
  const sleep = dependencies.sleep
    ?? ((milliseconds: number, signal?: AbortSignal) => new Promise<void>((resolvePromise, rejectPromise) => {
      const aborted = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', aborted);
        rejectPromise(productionFailure('operation_unavailable'));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', aborted);
        resolvePromise();
      }, milliseconds);
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted === true) aborted();
    }));
  const monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
  const kill = dependencies.kill ?? ((pid: number, signal: 0) => process.kill(pid, signal));
  const readLogSnapshot = dependencies.readLogSnapshot ?? defaultReadLogSnapshot;
  const startService = dependencies.startService
    ?? (startProductionService as (value: ComposeProductionServiceOptions) => Promise<QuukkService>);
  const signals = dependencies.signals ?? process;

  type OperationDeadline = {
    startedAt: number;
    durationMs: number;
    failureCode: 'operation_timeout' | 'shutdown_timeout';
  };
  const beginDeadline = (
    durationMs: number,
    failureCode: OperationDeadline['failureCode'],
  ): OperationDeadline => {
    const startedAt = monotonicNow();
    if (!Number.isFinite(startedAt) || startedAt < 0) throw productionFailure(failureCode);
    return { startedAt, durationMs, failureCode };
  };
  const remainingDeadline = (deadline: OperationDeadline): number => {
    const elapsed = monotonicNow() - deadline.startedAt;
    const remaining = deadline.durationMs - elapsed;
    if (!Number.isFinite(elapsed) || elapsed < 0 || !Number.isFinite(remaining) || remaining <= 0) {
      throw productionFailure(deadline.failureCode);
    }
    return remaining;
  };
  const sleepWithinDeadline = async (
    deadline: OperationDeadline,
    milliseconds: number,
  ): Promise<void> => {
    await sleep(Math.min(milliseconds, remainingDeadline(deadline)));
    remainingDeadline(deadline);
  };

  const readStoredIdentity = async (): Promise<{
    identity?: DaemonIdentity;
    contentDigest?: string;
  }> => {
    let snapshot: Awaited<ReturnType<DaemonIdentityPersistence['read']>>;
    try {
      snapshot = await identityStore.read();
    } catch (error) {
      if (
        typeof error === 'object'
        && error !== null
        && 'code' in error
        && String((error as { code?: unknown }).code) === 'identity_corrupt'
      ) throw productionFailure('identity_corrupt');
      throw error;
    }
    if (snapshot.identity === undefined && snapshot.contentDigest === undefined) {
      return {};
    }
    if (!/^[0-9a-f]{64}$/.test(snapshot.contentDigest ?? '')) {
      throw productionFailure('identity_invalid');
    }
    if (snapshot.identity?.state === 'starting') {
      const parsed = StartingDaemonIdentitySchema.safeParse(snapshot.identity);
      if (parsed.success) {
        return { identity: parsed.data, contentDigest: snapshot.contentDigest };
      }
    }
    if (snapshot.identity?.state === 'ready') {
      const parsed = ReadyDaemonIdentitySchema.safeParse(snapshot.identity);
      if (parsed.success) {
        return { identity: parsed.data, contentDigest: snapshot.contentDigest };
      }
    }
    throw productionFailure('identity_invalid');
  };

  const inspect = async (): Promise<DaemonInspection> => {
    let snapshot: Awaited<ReturnType<typeof readStoredIdentity>>;
    try {
      snapshot = await readStoredIdentity();
    } catch (error) {
      if (errorCodeOf(error) === 'identity_corrupt') {
        return { kind: 'corrupt', errorCode: 'identity_corrupt' };
      }
      throw error;
    }
    if (snapshot.identity === undefined) return { kind: 'not_running' };
    if (snapshot.identity.state === 'starting') {
      return { kind: 'starting', identity: snapshot.identity };
    }
    return {
      kind: 'ready',
      identity: snapshot.identity,
      contentDigest: snapshot.contentDigest!,
    };
  };

  const readCredential = async (identity: ReadyDaemonIdentity): Promise<string> => {
    try {
      const rawCredentials = await readJson(
        paths.credentials,
        CredentialFileSchema,
        CREDENTIAL_FILE_LIMIT,
      );
      const credentials = CredentialFileSchema.safeParse(rawCredentials);
      if (!credentials.success) throw productionFailure('process_unverified');
      return deriveControlCredential(credentials.data.bridgeSecret, identity.instance_id);
    } catch {
      throw productionFailure('process_unverified');
    }
  };

  const authenticateStatus = async (
    identity: ReadyDaemonIdentity,
    timeoutMs: number,
    deadline?: OperationDeadline,
  ): Promise<ControlStatusResponse> => {
    const presented = await readCredential(identity);
    const requestTimeout = deadline === undefined
      ? timeoutMs
      : Math.min(timeoutMs, remainingDeadline(deadline));
    const raw = await controlRequest(request, identity, presented, 'status', requestTimeout);
    if (deadline !== undefined) remainingDeadline(deadline);
    const parsed = ControlStatusResponseSchema.safeParse(raw);
    if (!parsed.success || !sameIdentity(identity, parsed.data.identity)) {
      throw productionFailure('process_unverified');
    }
    return parsed.data;
  };

  const recoverExactStale = async (
    identity: ReadyDaemonIdentity,
    contentDigest: string,
    completedUnreachableAttempts = 0,
    deadline = beginDeadline(START_WAIT_MS, 'operation_timeout'),
  ): Promise<boolean> => {
    if (
      !ReadyDaemonIdentitySchema.safeParse(identity).success
      || !/^[0-9a-f]{64}$/.test(contentDigest)
      || !Number.isInteger(completedUnreachableAttempts)
      || completedUnreachableAttempts < 0
      || completedUnreachableAttempts > 3
    ) throw productionFailure('stale_unverified');
    for (let attempt = completedUnreachableAttempts; attempt < 3; attempt += 1) {
      if (attempt === 1) await sleepWithinDeadline(deadline, 100);
      if (attempt === 2) await sleepWithinDeadline(deadline, 250);
      try {
        await authenticateStatus(identity, 1_000, deadline);
        throw productionFailure('stale_unverified');
      } catch (error) {
        if (errorCodeOf(error) === deadline.failureCode) throw error;
        if (!explicitlyUnreachable(error)) throw productionFailure('stale_unverified');
      }
    }
    remainingDeadline(deadline);
    try {
      kill(identity.pid, 0);
      throw productionFailure('stale_unverified');
    } catch (error) {
      if (error instanceof ProductionCliFailure) throw error;
      if (errorCodeOf(error) !== 'ESRCH') throw productionFailure('stale_unverified');
    }
    remainingDeadline(deadline);
    let quarantined = false;
    try {
      quarantined = await identityStore.quarantineStaleIfExact({
        expected: identity,
        contentDigest,
      });
    } catch {
      throw productionFailure('stale_unverified');
    }
    if (!quarantined) throw productionFailure('stale_unverified');
    remainingDeadline(deadline);
    return true;
  };

  const waitForShutdown = async (
    identity: ReadyDaemonIdentity,
    deadline: OperationDeadline,
  ): Promise<void> => {
    while (true) {
      const remaining = remainingDeadline(deadline);
      let oldAuthenticationFailed = false;
      try {
        await authenticateStatus(
          identity,
          Math.min(1_000, remaining),
          deadline,
        );
      } catch {
        oldAuthenticationFailed = true;
      }
      remainingDeadline(deadline);
      let oldIdentityGone = false;
      try {
        const current = await readStoredIdentity();
        oldIdentityGone = current.identity === undefined
          || current.identity.state !== 'ready'
          || !sameIdentity(identity, current.identity);
      } catch {
        oldIdentityGone = false;
      }
      remainingDeadline(deadline);
      if (oldAuthenticationFailed && oldIdentityGone) return;
      await sleepWithinDeadline(deadline, POLL_MS);
    }
  };

  const control: CliRuntimePort['control'] = async (identity, command) => {
    const parsedIdentity = ReadyDaemonIdentitySchema.safeParse(identity);
    if (!parsedIdentity.success) throw productionFailure('process_unverified');
    const shutdownDeadline = command === 'shutdown'
      ? beginDeadline(SHUTDOWN_WAIT_MS, 'shutdown_timeout')
      : undefined;
    let authenticated: ControlStatusResponse;
    try {
      authenticated = await authenticateStatus(
        parsedIdentity.data,
        shutdownDeadline === undefined
          ? 5_000
          : Math.min(5_000, remainingDeadline(shutdownDeadline)),
        shutdownDeadline,
      );
      if (shutdownDeadline !== undefined) remainingDeadline(shutdownDeadline);
    } catch (error) {
      if (
        shutdownDeadline !== undefined
        && (errorCodeOf(error) === 'operation_timeout' || errorCodeOf(error) === 'shutdown_timeout')
      ) {
        throw productionFailure('shutdown_timeout');
      }
      if (errorCodeOf(error) === 'operation_timeout') throw error;
      throw productionFailure('process_unverified');
    }
    if (command === 'status') {
      return { command, value: authenticated };
    }
    let raw: unknown;
    try {
      const credential = await readCredential(parsedIdentity.data);
      const requestTimeout = shutdownDeadline === undefined
        ? 5_000
        : Math.min(5_000, remainingDeadline(shutdownDeadline));
      raw = await controlRequest(
        request,
        parsedIdentity.data,
        credential,
        command,
        requestTimeout,
      );
      if (shutdownDeadline !== undefined) remainingDeadline(shutdownDeadline);
    } catch (error) {
      if (
        shutdownDeadline !== undefined
        && (errorCodeOf(error) === 'operation_timeout' || errorCodeOf(error) === 'shutdown_timeout')
      ) {
        throw productionFailure('shutdown_timeout');
      }
      if (errorCodeOf(error) === 'operation_timeout') throw error;
      throw productionFailure('process_unverified');
    }
    if (command === 'launch_ticket') {
      const parsed = RawLaunchTicketResponseSchema.safeParse(raw);
      if (!parsed.success) throw productionFailure('process_unverified');
      return { command, value: { ticket: parsed.data.ticket, expiresAt: parsed.data.expiresAt } };
    }
    if (command === 'rescan') {
      const parsed = RuntimesResponseSchema.safeParse(raw);
      if (!parsed.success) throw productionFailure('process_unverified');
      return { command, value: parsed.data };
    }
    const parsed = RawShutdownResponseSchema.safeParse(raw);
    if (!parsed.success) throw productionFailure('process_unverified');
    await waitForShutdown(parsedIdentity.data, shutdownDeadline!);
    return { command, value: { accepted: true } };
  };

  const spawnBackground = (input: StartInput): {
    check(): void;
    ownedPid?: number;
  } => {
    if (input.foreground !== false || typeof input.noOpen !== 'boolean') {
      throw productionFailure('invalid_config');
    }
    const rawOverrides = ChildConfigOverridesSchema.safeParse(input.configOverrides);
    if (!rawOverrides.success) throw productionFailure('invalid_config');
    const framedInput: StartInput = {
      foreground: false,
      noOpen: input.noOpen,
      configOverrides: normalizedChildOverrides(rawOverrides.data),
    };
    const frame = `${JSON.stringify(framedInput)}\n`;
    if (Buffer.byteLength(frame, 'utf8') > CHILD_INPUT_LIMIT) {
      throw productionFailure('invalid_config');
    }
    let child: ProductionDaemonChild;
    try {
      child = spawn(options.execPath, [
        options.packagedBinPath,
        'start',
        '--foreground',
        '--no-open',
        '--daemon-child',
      ], {
        shell: false,
        detached: true,
        windowsHide: true,
        stdio: ['pipe', 'ignore', 'ignore'],
        env: daemonEnvironment(processEnvironment),
      });
    } catch {
      throw productionFailure('operation_unavailable');
    }
    let failure: ProductionCliFailure | undefined;
    const failed = (): void => { failure = productionFailure('operation_unavailable'); };
    try {
      child.once('error', failed);
      if (child.stdin === null) throw productionFailure('operation_unavailable');
      child.stdin.once('error', failed);
      child.stdin.end(frame, 'utf8');
      child.unref();
    } catch {
      throw productionFailure('operation_unavailable');
    }
    const ownedPid = Number.isSafeInteger(child.pid) && child.pid! > 0
      ? child.pid
      : undefined;
    return {
      ownedPid,
      check(): void {
        if (failure !== undefined) throw failure;
      },
    };
  };

  const startBackground = async (input: StartInput): Promise<StartResult> => {
    const deadline = beginDeadline(START_WAIT_MS, 'operation_timeout');
    let spawned = false;
    let checkChild = (): void => {};
    let ownedPid: number | undefined;
    let snapshot = await readStoredIdentity();
    while (true) {
      remainingDeadline(deadline);
      checkChild();
      if (snapshot.identity === undefined) {
        if (!spawned) {
          remainingDeadline(deadline);
          const child = spawnBackground(input);
          checkChild = child.check;
          ownedPid = child.ownedPid;
          spawned = true;
        }
      } else if (snapshot.identity.state === 'ready') {
        try {
          await authenticateStatus(
            snapshot.identity,
            1_000,
            deadline,
          );
          return {
            identity: snapshot.identity,
            alreadyRunning: ownedPid === undefined || snapshot.identity.pid !== ownedPid,
          };
        } catch (error) {
          if (!explicitlyUnreachable(error)) {
            if (errorCodeOf(error) === 'operation_timeout') throw error;
            throw productionFailure('process_unverified');
          }
          await recoverExactStale(snapshot.identity, snapshot.contentDigest!, 1, deadline);
          spawned = false;
          checkChild = (): void => {};
          ownedPid = undefined;
          snapshot = {};
          continue;
        }
      }
      await sleep(Math.min(POLL_MS, remainingDeadline(deadline)));
      checkChild();
      remainingDeadline(deadline);
      snapshot = await readStoredIdentity();
      remainingDeadline(deadline);
    }
  };

  const doctorWarnings = async (): Promise<string[]> => {
    const warnings: string[] = [];
    try {
      const config = await readJson(paths.config, StoredConfigSchema, METADATA_FILE_LIMIT);
      if (!StoredConfigSchema.safeParse(config).success) throw productionFailure('invalid_config');
    } catch {
      warnings.push('config_unavailable');
    }
    try {
      const state = await readJson(paths.state, LocalStateSchema, METADATA_FILE_LIMIT);
      if (!LocalStateSchema.safeParse(state).success) throw productionFailure('invalid_config');
    } catch {
      warnings.push('state_unavailable');
    }
    return warnings;
  };

  return {
    inspect,
    start: startBackground,
    async runForeground(input, foreground): Promise<number> {
      const identity = createStartingIdentity(processId, now, randomBytes);
      if (!(await identityStore.claim(identity))) throw productionFailure('identity_conflict');
      let service: ProductionCliServicePort | undefined;
      let serviceStarting = false;
      let interrupted = false;
      let monitoring = false;
      let cleanupPromise: Promise<void> | undefined;
      let resolveStopRequested!: () => void;
      const stopRequested = new Promise<void>((resolvePromise) => {
        resolveStopRequested = resolvePromise;
      });
      const cleanup = (): Promise<void> => {
        cleanupPromise ??= (async () => {
          let failure: ProductionCliFailure | undefined;
          if (service !== undefined) {
            try {
              await service.stop();
            } catch (error) {
              failure = normalizedProductionFailure(error);
            }
          }
          try {
            await identityStore.removeIfMatches(identity);
          } catch (error) {
            failure ??= normalizedProductionFailure(error);
          }
          if (failure !== undefined) throw failure;
        })();
        return cleanupPromise;
      };
      const requestStop = (): void => {
        if (!interrupted) {
          interrupted = true;
          resolveStopRequested();
        }
        if (!serviceStarting) void cleanup().catch(() => undefined);
      };
      signals.once('SIGINT', requestStop);
      signals.once('SIGTERM', requestStop);
      try {
        let effectiveInput = input;
        if (foreground.daemonChild) {
          const childInput = await Promise.race([
            readStdin(CHILD_INPUT_LIMIT).then((bytes) => ({ interrupted: false as const, bytes })),
            stopRequested.then(() => ({ interrupted: true as const })),
          ]);
          if (childInput.interrupted || interrupted) {
            await cleanup();
            return 0;
          }
          effectiveInput = parseChildStartInput(childInput.bytes);
        }
        if (interrupted) {
          await cleanup();
          return 0;
        }
        serviceStarting = true;
        try {
          const serviceEnvironment = daemonEnvironment(processEnvironment);
          service = await startService({
            identity,
            identityStore,
            homeDirectory,
            processEnvironment: serviceEnvironment,
            configEnvironment: serviceEnvironment,
            configOverrides: effectiveInput.configOverrides,
          });
        } finally {
          serviceStarting = false;
        }
        if (interrupted) {
          await cleanup();
          return 0;
        }
        const ready = ControlStatusResponseSchema.safeParse(
          await service.status(new AbortController().signal),
        );
        if (interrupted) {
          await cleanup();
          return 0;
        }
        if (
          !ready.success
          || ready.data.state !== 'ready'
          || ready.data.identity.pid !== identity.pid
          || ready.data.identity.version !== identity.version
          || ready.data.identity.instance_id !== identity.instance_id
          || ready.data.identity.started_at !== identity.started_at
        ) throw productionFailure('process_unverified');
        await foreground.onReady(ready.data.identity);
        if (interrupted) {
          await cleanup();
          return 0;
        }
        monitoring = true;
        void (async () => {
          while (monitoring && !interrupted) {
            try {
              const current = await readStoredIdentity();
              if (
                current.identity === undefined
                || current.identity.state !== 'ready'
                || !sameIdentity(ready.data.identity, current.identity)
              ) {
                requestStop();
                return;
              }
            } catch {
              // A transient/corrupt read is never proof that the owned service stopped.
            }
            if (monitoring && !interrupted) await sleep(POLL_MS);
          }
        })().catch(() => requestStop());
        await stopRequested;
        await cleanup();
        return 0;
      } catch (error) {
        try {
          await cleanup();
        } catch (cleanupError) {
          throw normalizedProductionFailure(cleanupError);
        }
        if (interrupted) return 0;
        throw normalizedProductionFailure(error);
      } finally {
        monitoring = false;
        signals.off('SIGINT', requestStop);
        signals.off('SIGTERM', requestStop);
      }
    },
    control,
    async recoverStaleForStart(stale): Promise<boolean> {
      const identity = ReadyDaemonIdentitySchema.safeParse(stale.identity);
      if (!identity.success || !/^[0-9a-f]{64}$/.test(stale.contentDigest)) {
        throw productionFailure('stale_unverified');
      }
      return recoverExactStale(identity.data, stale.contentDigest);
    },
    async *readLogs(input): AsyncIterable<string> {
      if (
        !Number.isSafeInteger(input.lines)
        || input.lines < 1
        || input.lines > 1_000
        || typeof input.follow !== 'boolean'
      ) throw productionFailure('invalid_config');
      const controller = new AbortController();
      const interrupted = (): void => controller.abort();
      signals.once('SIGINT', interrupted);
      signals.once('SIGTERM', interrupted);
      let previous: ProductionLogSnapshot | undefined;
      let emittedOffset = 0;
      let initial = true;
      try {
        while (!controller.signal.aborted) {
          let snapshot: ProductionLogSnapshot | undefined;
          try {
            snapshot = await readLogSnapshot(paths.bridgeLog, LOG_SNAPSHOT_LIMIT);
          } catch {
            throw productionFailure('operation_unavailable');
          }
          if (controller.signal.aborted) return;
          if (
            snapshot !== undefined
            && (
              typeof snapshot.fileId !== 'string'
              || snapshot.fileId.length < 1
              || snapshot.fileId.length > 256
              || !Buffer.isBuffer(snapshot.bytes)
              || snapshot.bytes.byteLength > LOG_SNAPSHOT_LIMIT
            )
          ) throw productionFailure('operation_unavailable');
          if (snapshot === undefined) {
            previous = undefined;
            emittedOffset = 0;
          } else if (initial) {
            const complete = completeLogLines(snapshot.bytes, 0);
            for (const line of complete.lines.slice(-input.lines)) yield line;
            emittedOffset = complete.offset;
            previous = { fileId: snapshot.fileId, bytes: Buffer.from(snapshot.bytes) };
          } else {
            const appended = previous !== undefined
              && previous.fileId === snapshot.fileId
              && snapshot.bytes.byteLength >= previous.bytes.byteLength
              && snapshot.bytes.subarray(0, previous.bytes.byteLength).equals(previous.bytes);
            const complete = completeLogLines(snapshot.bytes, appended ? emittedOffset : 0);
            for (const line of complete.lines) yield line;
            emittedOffset = complete.offset;
            previous = { fileId: snapshot.fileId, bytes: Buffer.from(snapshot.bytes) };
          }
          initial = false;
          if (!input.follow) return;
          try {
            await sleep(250, controller.signal);
          } catch {
            if (controller.signal.aborted) return;
            throw productionFailure('operation_unavailable');
          }
        }
      } finally {
        controller.abort();
        signals.off('SIGINT', interrupted);
        signals.off('SIGTERM', interrupted);
      }
    },
    async doctor(): Promise<CliDiagnostics> {
      const warnings = await doctorWarnings();
      const withWarnings = warnings.length === 0 ? {} : { warnings };
      const value = await inspect();
      if (value.kind === 'not_running') {
        return { schemaVersion: 1, state: 'offline', ...withWarnings };
      }
      if (value.kind === 'corrupt') {
        return {
          schemaVersion: 1,
          state: 'corrupt',
          errorCode: 'identity_corrupt',
          ...withWarnings,
        };
      }
      if (value.kind === 'starting') {
        return {
          schemaVersion: 1,
          state: 'starting',
          service: {
            pid: value.identity.pid,
            version: value.identity.version,
            startedAt: value.identity.started_at,
          },
          ...withWarnings,
        };
      }
      const status = await control(value.identity, 'status');
      return {
        schemaVersion: 1,
        state: 'ready',
        service: {
          pid: value.identity.pid,
          version: value.identity.version,
          startedAt: value.identity.started_at,
          port: portOf(value.identity),
          controlState: status.command === 'status' ? status.value.state : 'ready',
        },
        runtimes: [],
        ...withWarnings,
      };
    },
  };
}

export interface PackagedCliCandidate {
  invokedBinPath: string;
  packagedBinPath: string;
  argv: readonly string[];
}

export interface PackagedCliEntryDependencies {
  realpathNative(path: string): Promise<string>;
  homeDirectory(): string;
  environment: NodeJS.ProcessEnv;
  execPath: string;
  processId: number;
  signals: ProductionSignalPort;
  platform: NodeJS.Platform;
  runtimeFactory(options: ProductionCliRuntimeOptions): CliRuntimePort;
  browserFactory(options: SystemBrowserPortOptions): BrowserPort;
  cliRunner(argv: readonly string[], options: RunCliOptions): Promise<number>;
  io: CliIO;
  setExitCode(code: number): void;
}

export function packagedCliCandidate(
  processArgv: readonly string[],
  moduleUrl: string,
): PackagedCliCandidate | undefined {
  if (processArgv.length < 2 || processArgv.some((value) => typeof value !== 'string')) {
    return undefined;
  }
  let modulePath: string;
  try {
    modulePath = fileURLToPath(moduleUrl);
  } catch {
    return undefined;
  }
  if (basename(modulePath) !== 'cli.js' || basename(dirname(modulePath)) !== 'dist') {
    return undefined;
  }
  const packageRoot = dirname(dirname(modulePath));
  const packagedBinPath = resolve(packageRoot, 'bin', 'quukk-clawmessenger.js');
  const invokedBinPath = resolve(processArgv[1]!);
  const localShimPath = resolve(dirname(packageRoot), '.bin', 'quukk-clawmessenger');
  if (invokedBinPath !== packagedBinPath && invokedBinPath !== localShimPath) {
    return undefined;
  }
  return {
    invokedBinPath,
    packagedBinPath,
    argv: processArgv.slice(2),
  };
}

function defaultNativeRealpath(path: string): Promise<string> {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    fsRealpath.native(path, (error, resolvedPath) => {
      if (error === null) resolvePromise(resolvedPath);
      else rejectPromise(error);
    });
  });
}

let packagedEntryStarted = false;

export async function runPackagedCliEntry(
  candidate: PackagedCliCandidate,
  dependencies: PackagedCliEntryDependencies,
): Promise<boolean> {
  if (packagedEntryStarted) return false;
  if (
    !isAbsolute(candidate.invokedBinPath)
    || !isAbsolute(candidate.packagedBinPath)
    || !Array.isArray(candidate.argv)
    || candidate.argv.some((value) => typeof value !== 'string')
  ) return false;
  let invokedRealpath: string;
  let packagedRealpath: string;
  try {
    [invokedRealpath, packagedRealpath] = await Promise.all([
      dependencies.realpathNative(candidate.invokedBinPath),
      dependencies.realpathNative(candidate.packagedBinPath),
    ]);
  } catch {
    return false;
  }
  const comparable = (value: string): string => dependencies.platform === 'win32'
    ? resolve(value).toLowerCase()
    : resolve(value);
  if (comparable(invokedRealpath) !== comparable(packagedRealpath) || packagedEntryStarted) {
    return false;
  }
  packagedEntryStarted = true;
  let code = 1;
  try {
    const homeDirectory = dependencies.homeDirectory();
    const runtime = dependencies.runtimeFactory({
      homeDirectory,
      processEnvironment: dependencies.environment,
      execPath: dependencies.execPath,
      packagedBinPath: candidate.packagedBinPath,
      dependencies: {
        processId: dependencies.processId,
        signals: dependencies.signals,
      },
    });
    const browser = dependencies.browserFactory({
      platform: dependencies.platform,
      environment: dependencies.environment,
    });
    code = await dependencies.cliRunner(candidate.argv, {
      runtime,
      browser,
      io: dependencies.io,
      environment: dependencies.environment,
    });
    if (!Number.isInteger(code) || code < 0 || code > 255) code = 1;
  } catch {
    dependencies.io.stderr('quukk-clawmessenger: internal_failure');
    code = 1;
  }
  dependencies.setExitCode(code);
  return true;
}

const automaticCandidate = packagedCliCandidate(process.argv, import.meta.url);
if (automaticCandidate !== undefined) {
  const io: CliIO = {
    stdout: (value) => { process.stdout.write(`${value}\n`); },
    stderr: (value) => { process.stderr.write(`${value}\n`); },
  };
  void runPackagedCliEntry(automaticCandidate, {
    realpathNative: defaultNativeRealpath,
    homeDirectory: homedir,
    environment: process.env,
    execPath: process.execPath,
    processId: process.pid,
    signals: process,
    platform: process.platform,
    runtimeFactory: createProductionCliRuntime,
    browserFactory: createSystemBrowserPort,
    cliRunner: runCli,
    io,
    setExitCode: (code) => { process.exitCode = code; },
  }).catch(() => {
    io.stderr('quukk-clawmessenger: internal_failure');
    process.exitCode = 1;
  });
}
