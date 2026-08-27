import { spawn as spawnProcess } from 'node:child_process';
import { parseArgs } from 'node:util';

import { z } from 'zod';

import {
  DEFAULT_CONFIG,
  PROVIDERS,
  StoredConfigSchema,
  type ConfigOverrides,
  type Provider,
  type RuntimeDiscoveryStatus,
} from './config/schema.js';
import {
  ReadyDaemonIdentitySchema,
  StartingDaemonIdentitySchema,
  type DaemonIdentity,
  type ReadyDaemonIdentity,
  type StartingDaemonIdentity,
} from './process/service-identity.js';
import {
  ControlStatusResponseSchema,
  RuntimesResponseSchema,
  type ControlStatusResponse,
  type RuntimesResponse,
} from './http/routes.js';
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
const LaunchTicketControlResponseSchema = z.strictObject({
  command: z.literal('launch_ticket'),
  value: z.strictObject({
    ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
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
  const port = Number(url.port);
  const ticket = /^#ticket=([A-Za-z0-9_-]{43})$/.exec(url.hash)?.[1];
  if (
    url.protocol !== 'http:'
    || url.hostname !== '127.0.0.1'
    || url.port === ''
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
        options: {
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
        },
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
  if (argv.filter((value) => value === '--json').length !== 1) return undefined;
  const commands = argv.filter(isCommand);
  if (commands.length !== 1 || commands[0] === 'logs') return undefined;
  return { command: commands[0]!, json: true };
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
    || code === 'stale_unverified'
    || code === 'unsafe_identity'
  ) return new CliFailure('unsafe_identity');
  if (code === 'operation_timeout' || code === 'startup_timeout') {
    return new CliFailure('operation_timeout');
  }
  if (code === 'browser_open_failed') return new CliFailure('browser_open_failed');
  if (
    code === 'bridge_unavailable'
    || code === 'operation_unavailable'
    || code === 'service_unavailable'
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

async function openBrowser(
  command: 'setup' | 'start',
  identity: ReadyDaemonIdentity,
  options: RunCliOptions,
): Promise<void> {
  const response = LaunchTicketControlResponseSchema.safeParse(
    await options.runtime.control(identity, 'launch_ticket'),
  );
  if (
    !response.success
    || response.data.value.expiresAt <= Date.now()
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
    let readyFailure: CliFailure | undefined;
    let readySeen = false;
    const exitCode = await options.runtime.runForeground(input, {
      daemonChild: parsed.daemonChild,
      onReady: async (value) => {
        if (readySeen) {
          readyFailure = new CliFailure('runtime_response_invalid');
          return;
        }
        readySeen = true;
        const identity = ReadyDaemonIdentitySchema.safeParse(value);
        if (!identity.success) {
          readyFailure = new CliFailure('runtime_response_invalid');
          return;
        }
        if (parsed.noOpen) return;
        try {
          await openBrowser(parsed.command as 'start', identity.data, options);
        } catch (error) {
          readyFailure = fixedFailure(error);
        }
      },
    });
    if (readyFailure !== undefined) throw readyFailure;
    if (!readySeen) throw new CliFailure('runtime_response_invalid');
    if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) {
      throw new CliFailure('runtime_response_invalid');
    }
    if (exitCode === 0) emitStartSuccess(parsed, options.io, false);
    return exitCode;
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
  const identity = await inspectForControl('status', options.runtime);
  const response = await options.runtime.control(identity!, 'status');
  if (response.command !== 'status') throw new CliFailure('runtime_response_invalid');
  const status = ControlStatusResponseSchema.safeParse(response.value);
  if (!status.success) throw new CliFailure('runtime_response_invalid');
  if (!sameIdentity(identity!, status.data.identity)) {
    throw new CliFailure('authentication_mismatch');
  }
  emitCommandSuccess(parsed, options.io, {
    state: status.data.state,
    pid: identity!.pid,
    port: portOf(identity!),
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

async function doctorCommand(parsed: ParsedCli, options: RunCliOptions): Promise<number> {
  const diagnostics = CliDiagnosticsSchema.safeParse(await options.runtime.doctor());
  if (!diagnostics.success) throw new CliFailure('runtime_response_invalid');
  emitCommandSuccess(parsed, options.io, { diagnostics: diagnostics.data }, diagnostics.data.state);
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
