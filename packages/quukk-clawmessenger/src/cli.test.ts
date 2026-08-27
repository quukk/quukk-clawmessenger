import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  createProductionCliRuntime,
  createSystemBrowserPort,
  packagedCliCandidate,
  runPackagedCliEntry,
  runCli,
  type CliRuntimePort,
} from './cli.js';
import { localPaths } from './config/paths.js';
import { DEFAULT_CONFIG } from './config/schema.js';
import { deriveControlCredential } from './http/security.js';
import { VERSION } from './version.js';

const NOW = 2_000_000_000_000;
const CANONICAL_TICKET = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const READY_IDENTITY = {
  schema_version: 1 as const,
  state: 'ready' as const,
  pid: 321,
  version: VERSION,
  instance_id: `svc_${'a'.repeat(32)}`,
  started_at: '2026-08-27T12:00:00.000Z',
  address: '127.0.0.1:43210',
};

const STARTING_IDENTITY = {
  schema_version: 1 as const,
  state: 'starting' as const,
  pid: 321,
  version: VERSION,
  instance_id: `svc_${'a'.repeat(32)}`,
  started_at: '2026-08-27T12:00:00.000Z',
};

function runtimeResponse(pathSentinel = resolve('runtime-path')) {
  const capabilities = {
    sessionResume: true,
    cancel: true,
    textEvents: true,
    toolEvents: true,
    approvalEvents: false as const,
  };
  return {
    schemaVersion: 1 as const,
    runtimes: [
      {
        provider: 'opencode' as const,
        runtimeId: `rt_${'1'.repeat(32)}`,
        version: '1.0.0',
        path: pathSentinel,
        status: 'ready' as const,
        capabilities,
        binding: null,
        worker: null,
      },
      ...(['openclaw', 'codex', 'hermes'] as const).map((provider) => ({
        provider,
        runtimeId: null,
        version: null,
        path: null,
        status: 'not_found' as const,
        capabilities,
        binding: null,
        worker: null,
      })),
    ],
  };
}

function harness() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const runtime = {
    inspect: vi.fn<CliRuntimePort['inspect']>(async () => ({ kind: 'not_running' as const })),
    start: vi.fn<CliRuntimePort['start']>(async () => ({ identity: READY_IDENTITY, alreadyRunning: false })),
    runForeground: vi.fn<CliRuntimePort['runForeground']>(async (_input, foreground) => {
      await foreground.onReady(READY_IDENTITY);
      return 0;
    }),
    control: vi.fn<CliRuntimePort['control']>(async () => { throw new Error('unexpected_control'); }),
    recoverStaleForStart: vi.fn<CliRuntimePort['recoverStaleForStart']>(async () => false),
    readLogs: vi.fn<CliRuntimePort['readLogs']>(() => (async function* () {})()),
    doctor: vi.fn<CliRuntimePort['doctor']>(async () => ({ schemaVersion: 1 as const, state: 'offline' as const })),
  };
  const browser = { open: vi.fn(async () => {}) };
  return {
    runtime,
    browser,
    stdout,
    stderr,
    options: {
      runtime,
      browser,
      io: {
        stdout: (value: string) => stdout.push(value),
        stderr: (value: string) => stderr.push(value),
      },
      environment: {},
      now: () => NOW,
    },
  };
}

function expectNoRuntimeCalls(runtime: ReturnType<typeof harness>['runtime']): void {
  for (const call of Object.values(runtime)) expect(call).not.toHaveBeenCalled();
}

describe('runCli', () => {
  it('prints the exact package version without touching runtime or browser ports', async () => {
    const runtime = new Proxy({}, {
      get: () => vi.fn(() => { throw new Error('runtime_must_not_run'); }),
    });
    const browser = { open: vi.fn(() => Promise.reject(new Error('browser_must_not_run'))) };
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCli(['--version'], {
      runtime: runtime as never,
      browser,
      io: {
        stdout: (value) => stdout.push(value),
        stderr: (value) => stderr.push(value),
      },
      environment: {},
    });

    expect(exitCode).toBe(0);
    expect(stdout).toEqual([VERSION]);
    expect(stderr).toEqual([]);
    expect(browser.open).not.toHaveBeenCalled();
  });

  it('treats version as a global flag even when placed with a valid command', async () => {
    const test = harness();

    const exitCode = await runCli(['start', '--version'], test.options);

    expect(exitCode).toBe(0);
    expect(test.stdout).toEqual([VERSION]);
    expect(test.stderr).toEqual([]);
    expectNoRuntimeCalls(test.runtime);
    expect(test.browser.open).not.toHaveBeenCalled();
  });

  it('prints public help without exposing the hidden daemon child marker', async () => {
    const test = harness();

    const exitCode = await runCli(['--help'], test.options);

    expect(exitCode).toBe(0);
    expect(test.stdout).toHaveLength(1);
    expect(test.stdout[0]).toContain('setup');
    expect(test.stdout[0]).toContain('rescan');
    expect(test.stdout[0]).not.toContain('daemon-child');
    expect(test.stderr).toEqual([]);
    expectNoRuntimeCalls(test.runtime);
    expect(test.browser.open).not.toHaveBeenCalled();
  });

  it.each([
    { argv: [] },
    { argv: ['unknown'] },
    { argv: ['status', 'extra'] },
    { argv: ['status', '--unknown'] },
    { argv: ['start', '--no-open', '--no-open'] },
    { argv: ['start', '--server-url', 'https://one.example', '--server-url', 'https://two.example'] },
    { argv: ['logs', '--json'] },
    { argv: ['status', '--no-open'] },
    { argv: ['setup', '--foreground'] },
    { argv: ['stop', '--server-url', 'https://example.test'] },
    { argv: ['start', '--lines', '1'] },
    { argv: ['--json'] },
    { argv: ['start', '--daemon-child'] },
    { argv: ['start', '--foreground', '--daemon-child'] },
    { argv: ['--version', '--json'] },
    { argv: ['start', '--port', '8080'] },
    { argv: ['start', '--host', '127.0.0.1'] },
    { argv: ['start', '--ticket', 'ticket-sentinel'] },
    { argv: ['start', '--secret', 'secret-sentinel'] },
    { argv: ['start', '--token', 'sentinel-token'] },
    { argv: ['start', '--browser', 'browser-sentinel'] },
    { argv: ['start', '--shell', 'shell-sentinel'] },
    { argv: ['start', '--home', resolve('forbidden-home')] },
    { argv: ['status', '--json', '--json'] },
    { argv: ['logs', '--follow', '--follow'] },
    { argv: ['logs', '--lines', '1', '--lines', '2'] },
  ])('rejects an unsupported argv matrix without calling a port: $argv', async ({ argv }) => {
    const test = harness();

    const exitCode = await runCli(argv, test.options);

    expect(exitCode).toBe(2);
    expect(test.stdout).toEqual([]);
    expect(test.stderr).toEqual(['quukk-clawmessenger: usage_error']);
    expectNoRuntimeCalls(test.runtime);
    expect(test.browser.open).not.toHaveBeenCalled();
  });

  it('passes only validated setup overrides and allows repeated authorized roots', async () => {
    const test = harness();
    const workdir = resolve('test-workdir');
    const rootOne = resolve('authorized-one');
    const rootTwo = resolve('authorized-two');
    const opencode = resolve('bin', 'opencode');
    const openclaw = resolve('bin', 'openclaw');
    const codex = resolve('bin', 'codex');
    const hermes = resolve('bin', 'hermes');

    const exitCode = await runCli([
      'setup', '--no-open',
      '--server-url', 'https://example.test/im/',
      '--workdir', workdir,
      '--authorized-work-root', rootOne,
      '--authorized-work-root', rootTwo,
      '--opencode-path', opencode,
      '--openclaw-path', openclaw,
      '--codex-path', codex,
      '--hermes-path', hermes,
      '--log-level', 'warn',
    ], test.options);

    expect(exitCode).toBe(0);
    expect(test.runtime.start).toHaveBeenCalledWith({
      foreground: false,
      noOpen: true,
      configOverrides: {
        serverUrl: 'https://example.test/im',
        defaultWorkdir: workdir,
        authorizedWorkRoots: [rootOne, rootTwo],
        providerPathOverrides: { opencode, openclaw, codex, hermes },
        logLevel: 'warn',
      },
    });
    expect(test.runtime.control).not.toHaveBeenCalled();
    expect(test.browser.open).not.toHaveBeenCalled();
    expect(test.stderr).toEqual([]);
  });

  it('rejects malformed config values before starting the runtime', async () => {
    const test = harness();

    const exitCode = await runCli([
      'setup', '--server-url', 'https://user:password@example.test/im',
    ], test.options);

    expect(exitCode).toBe(2);
    expect(test.stderr).toEqual(['quukk-clawmessenger: invalid_config']);
    expectNoRuntimeCalls(test.runtime);
    expect(test.browser.open).not.toHaveBeenCalled();
  });

  it('accepts the hidden child marker only with the exact foreground no-open start shape', async () => {
    const test = harness();

    const exitCode = await runCli([
      'start', '--foreground', '--no-open', '--daemon-child',
    ], test.options);

    expect(exitCode).toBe(0);
    expect(test.runtime.runForeground).toHaveBeenCalledWith(
      { foreground: true, noOpen: true, configOverrides: {} },
      expect.objectContaining({ daemonChild: true, onReady: expect.any(Function) }),
    );
    expect(test.runtime.start).not.toHaveBeenCalled();
    expect(test.runtime.control).not.toHaveBeenCalled();
    expect(test.browser.open).not.toHaveBeenCalled();
  });

  it.each([
    { command: 'setup', path: '/setup' },
    { command: 'start', path: '/' },
  ] as const)('opens a one-use ticket only after $command has a ready identity', async ({ command, path }) => {
    const test = harness();
    const ticket = `${'T'.repeat(42)}A`;
    test.runtime.control.mockResolvedValue({
      command: 'launch_ticket',
      value: { ticket, expiresAt: NOW + 30_000 },
    });

    const exitCode = await runCli([command], test.options);

    expect(exitCode).toBe(0);
    expect(test.runtime.start).toHaveBeenCalledOnce();
    expect(test.runtime.control).toHaveBeenCalledWith(READY_IDENTITY, 'launch_ticket');
    expect(test.browser.open).toHaveBeenCalledWith(
      `http://127.0.0.1:43210${path}#ticket=${ticket}`,
    );
    expect(`${test.stdout.join(' ')} ${test.stderr.join(' ')}`).not.toContain(ticket);
    expect(`${test.stdout.join(' ')} ${test.stderr.join(' ')}`).not.toContain('http://');
  });

  it('never requests a ticket or opens a browser for no-open start', async () => {
    const test = harness();

    const exitCode = await runCli(['start', '--no-open'], test.options);

    expect(exitCode).toBe(0);
    expect(test.runtime.start).toHaveBeenCalledWith({
      foreground: false,
      noOpen: true,
      configOverrides: {},
    });
    expect(test.runtime.control).not.toHaveBeenCalled();
    expect(test.browser.open).not.toHaveBeenCalled();
  });

  it('rejects overrides when the service was already running and never signs a ticket', async () => {
    const test = harness();
    test.runtime.start.mockResolvedValue({ identity: READY_IDENTITY, alreadyRunning: true });

    const exitCode = await runCli([
      'start', '--workdir', resolve('different-workdir'),
    ], test.options);

    expect(exitCode).toBe(2);
    expect(test.stderr).toEqual(['quukk-clawmessenger: already_running_with_overrides']);
    expect(test.runtime.control).not.toHaveBeenCalled();
    expect(test.browser.open).not.toHaveBeenCalled();
  });

  it.each([
    { ticket: 'x'.repeat(42), expiresAt: NOW + 30_000 },
    { ticket: CANONICAL_TICKET, expiresAt: NOW - 1 },
  ])('rejects malformed or expired launch-ticket responses without opening a browser', async (value) => {
    const test = harness();
    test.runtime.control.mockResolvedValue({ command: 'launch_ticket', value });

    const exitCode = await runCli(['setup'], test.options);

    expect(exitCode).toBe(5);
    expect(test.stderr).toEqual(['quukk-clawmessenger: operation_unavailable']);
    expect(test.browser.open).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'non-canonical base64url',
      value: { ticket: 'x'.repeat(43), expiresAt: NOW + 1 },
    },
    {
      name: 'already expired',
      value: { ticket: CANONICAL_TICKET, expiresAt: NOW },
    },
    {
      name: 'beyond the ticket-store TTL',
      value: { ticket: CANONICAL_TICKET, expiresAt: NOW + 30_001 },
    },
  ])('rejects a $name launch ticket', async ({ value }) => {
    const test = harness();
    test.runtime.control.mockResolvedValue({ command: 'launch_ticket', value });

    const exitCode = await runCli(['setup'], test.options);

    expect(exitCode).toBe(5);
    expect(test.stderr).toEqual(['quukk-clawmessenger: operation_unavailable']);
    expect(test.browser.open).not.toHaveBeenCalled();
  });

  it('accepts a canonical 32-byte ticket at the exact TTL boundary', async () => {
    const test = harness();
    test.runtime.control.mockResolvedValue({
      command: 'launch_ticket',
      value: { ticket: CANONICAL_TICKET, expiresAt: NOW + 30_000 },
    });

    const exitCode = await runCli(['setup'], test.options);

    expect(exitCode).toBe(0);
    expect(test.browser.open).toHaveBeenCalledWith(
      `http://127.0.0.1:43210/setup#ticket=${CANONICAL_TICKET}`,
    );
  });

  it('accepts an epoch-zero clock when the ticket has exactly 30 seconds remaining', async () => {
    const test = harness();
    test.runtime.control.mockResolvedValue({
      command: 'launch_ticket',
      value: { ticket: CANONICAL_TICKET, expiresAt: 30_000 },
    });

    const exitCode = await runCli(['setup'], { ...test.options, now: () => 0 });

    expect(exitCode).toBe(0);
    expect(test.stderr).toEqual([]);
    expect(test.browser.open).toHaveBeenCalledWith(
      `http://127.0.0.1:43210/setup#ticket=${CANONICAL_TICKET}`,
    );
  });

  it('rejects non-exact launch-ticket response objects without exposing extra fields', async () => {
    const test = harness();
    const secretSentinel = 'SECRET-LAUNCH-RESPONSE';
    test.runtime.control.mockResolvedValue({
      command: 'launch_ticket',
      value: {
        ticket: CANONICAL_TICKET,
        expiresAt: NOW + 30_000,
        [secretSentinel]: secretSentinel,
      },
    } as never);

    const exitCode = await runCli(['setup'], test.options);

    expect(exitCode).toBe(5);
    expect(test.stderr).toEqual(['quukk-clawmessenger: operation_unavailable']);
    expect(test.browser.open).not.toHaveBeenCalled();
    expect(`${test.stdout.join(' ')} ${test.stderr.join(' ')}`).not.toContain(secretSentinel);
  });

  it('maps browser failure to exit 5 without echoing its URL or error', async () => {
    const test = harness();
    const ticket = `${'B'.repeat(42)}A`;
    const secretSentinel = 'SECRET-SENTINEL-FROM-BROWSER';
    test.runtime.control.mockResolvedValue({
      command: 'launch_ticket',
      value: { ticket, expiresAt: NOW + 30_000 },
    });
    test.browser.open.mockRejectedValue(new Error(
      `failed ${secretSentinel} http://127.0.0.1:43210/#ticket=${ticket}`,
    ));

    const exitCode = await runCli(['start'], test.options);

    expect(exitCode).toBe(5);
    expect(test.runtime.start).toHaveBeenCalledOnce();
    expect(test.stderr).toEqual(['quukk-clawmessenger: browser_open_failed']);
    expect(`${test.stdout.join(' ')} ${test.stderr.join(' ')}`).not.toContain(secretSentinel);
    expect(`${test.stdout.join(' ')} ${test.stderr.join(' ')}`).not.toContain(ticket);
  });

  it('waits for foreground readiness before opening and keeps the service running after opener failure', async () => {
    const test = harness();
    const calls: string[] = [];
    const ticket = `${'F'.repeat(42)}A`;
    test.runtime.control.mockImplementation(async () => {
      calls.push('ticket');
      return { command: 'launch_ticket', value: { ticket, expiresAt: NOW + 30_000 } };
    });
    test.browser.open.mockImplementation(async () => {
      calls.push('browser');
      throw new Error('unsafe-browser-detail');
    });
    test.runtime.runForeground.mockImplementation(async (_input, foreground) => {
      calls.push('service-ready');
      await foreground.onReady(READY_IDENTITY);
      calls.push('service-kept-running');
      return 0;
    });

    const exitCode = await runCli(['start', '--foreground'], test.options);

    expect(exitCode).toBe(5);
    expect(calls).toEqual(['service-ready', 'ticket', 'browser', 'service-kept-running']);
    expect(test.stderr).toEqual(['quukk-clawmessenger: browser_open_failed']);
  });

  it('emits one JSON ready object from onReady while a no-open foreground run stays alive', async () => {
    const test = harness();
    let reportReady!: () => void;
    const ready = new Promise<void>((resolveReady) => { reportReady = resolveReady; });
    let finishRun!: (exitCode: number) => void;
    const keptRunning = new Promise<number>((resolveRun) => { finishRun = resolveRun; });
    test.runtime.runForeground.mockImplementation(async (_input, foreground) => {
      await foreground.onReady(READY_IDENTITY);
      reportReady();
      return await keptRunning;
    });

    let settled = false;
    const running = runCli(['start', '--foreground', '--no-open', '--json'], test.options);
    void running.then(() => { settled = true; });
    await ready;

    expect(settled).toBe(false);
    finishRun(0);
    expect(test.stdout).toEqual([JSON.stringify({
      schemaVersion: 1,
      ok: true,
      command: 'start',
      state: 'ready',
      alreadyRunning: false,
    })]);
    expect(test.stderr).toEqual([]);
    expect(await running).toBe(0);
    expect(test.stdout).toHaveLength(1);
  });

  it.each([
    1, 2, 3, 4, 5, 9,
  ])('latches the first ready JSON result despite later foreground exit %s', async (runtimeExit) => {
    const test = harness();
    test.runtime.runForeground.mockImplementation(async (_input, foreground) => {
      await foreground.onReady(READY_IDENTITY);
      return runtimeExit;
    });

    const exitCode = await runCli(
      ['start', '--foreground', '--no-open', '--json'],
      test.options,
    );

    expect(exitCode).toBe(0);
    expect(test.stderr).toEqual([]);
    expect(test.stdout).toEqual([JSON.stringify({
      schemaVersion: 1,
      ok: true,
      command: 'start',
      state: 'ready',
      alreadyRunning: false,
    })]);
  });

  it.each([
    { runtimeExit: 4, expectedExit: 4, errorCode: 'unsafe_identity' },
    { runtimeExit: 5, expectedExit: 5, errorCode: 'operation_unavailable' },
    { runtimeExit: 9, expectedExit: 1, errorCode: 'internal_failure' },
  ])('maps foreground exit $runtimeExit even when readiness was never reached', async ({
    runtimeExit,
    expectedExit,
    errorCode,
  }) => {
    const test = harness();
    test.runtime.runForeground.mockResolvedValue(runtimeExit);

    const exitCode = await runCli(
      ['start', '--foreground', '--no-open', '--json'],
      test.options,
    );

    expect(exitCode).toBe(expectedExit);
    expect(test.stderr).toEqual([]);
    expect(test.stdout).toEqual([JSON.stringify({
      schemaVersion: 1,
      ok: false,
      command: 'start',
      error: { code: errorCode },
    })]);
  });

  it.each([
    {
      argv: ['start', '--foreground', '--no-open'],
      expected: 'quukk-clawmessenger: start ready',
    },
    {
      argv: ['start', '--foreground', '--no-open', '--json'],
      expected: JSON.stringify({
        schemaVersion: 1,
        ok: true,
        command: 'start',
        state: 'ready',
        alreadyRunning: false,
      }),
    },
  ])('latches the first ready result when the foreground runtime later throws for $argv', async ({
    argv,
    expected,
  }) => {
    const test = harness();
    test.runtime.runForeground.mockImplementation(async (_input, foreground) => {
      await foreground.onReady(READY_IDENTITY);
      throw Object.assign(new Error('SECRET-FOREGROUND-DETAIL'), {
        code: 'process_unverified',
      });
    });

    const exitCode = await runCli(argv, test.options);

    expect(exitCode).toBe(0);
    expect(test.stderr).toEqual([]);
    expect(test.stdout).toEqual([expected]);
    expect(test.stdout[0]).not.toContain('SECRET-FOREGROUND-DETAIL');
  });

  it.each([
    {
      argv: ['start', '--foreground'],
      expectedStdout: [] as string[],
      expectedStderr: ['quukk-clawmessenger: browser_open_failed'],
    },
    {
      argv: ['start', '--foreground', '--json'],
      expectedStdout: [JSON.stringify({
        schemaVersion: 1,
        ok: false,
        command: 'start',
        error: { code: 'browser_open_failed' },
      })],
      expectedStderr: [] as string[],
    },
  ])('keeps the first browser failure when the foreground runtime later throws for $argv', async ({
    argv,
    expectedStdout,
    expectedStderr,
  }) => {
    const test = harness();
    test.runtime.control.mockResolvedValue({
      command: 'launch_ticket',
      value: { ticket: CANONICAL_TICKET, expiresAt: NOW + 30_000 },
    });
    test.browser.open.mockRejectedValue(new Error('SECRET-BROWSER-LATCH'));
    test.runtime.runForeground.mockImplementation(async (_input, foreground) => {
      await foreground.onReady(READY_IDENTITY);
      throw Object.assign(new Error('SECRET-PROCESS-LATCH'), {
        code: 'process_unverified',
      });
    });

    const exitCode = await runCli(argv, test.options);

    expect(exitCode).toBe(5);
    expect(test.stdout).toEqual(expectedStdout);
    expect(test.stderr).toEqual(expectedStderr);
    expect([...test.stdout, ...test.stderr]).toHaveLength(1);
    expect(`${test.stdout.join(' ')} ${test.stderr.join(' ')}`).not.toContain('SECRET-');
  });

  it.each([
    {
      argv: ['start', '--foreground'],
      expectedStdout: [] as string[],
      expectedStderr: ['quukk-clawmessenger: browser_open_failed'],
    },
    {
      argv: ['start', '--foreground', '--json'],
      expectedStdout: [JSON.stringify({
        schemaVersion: 1,
        ok: false,
        command: 'start',
        error: { code: 'browser_open_failed' },
      })],
      expectedStderr: [] as string[],
    },
  ])('locks the first onReady failure when readiness is reported twice for $argv', async ({
    argv,
    expectedStdout,
    expectedStderr,
  }) => {
    const test = harness();
    test.runtime.control.mockResolvedValue({
      command: 'launch_ticket',
      value: { ticket: CANONICAL_TICKET, expiresAt: NOW + 30_000 },
    });
    test.browser.open.mockRejectedValue(new Error('SECRET-FIRST-READY-FAILURE'));
    test.runtime.runForeground.mockImplementation(async (_input, foreground) => {
      await foreground.onReady(READY_IDENTITY);
      await foreground.onReady(READY_IDENTITY);
      return 0;
    });

    const exitCode = await runCli(argv, test.options);

    expect(exitCode).toBe(5);
    expect(test.stdout).toEqual(expectedStdout);
    expect(test.stderr).toEqual(expectedStderr);
    expect([...test.stdout, ...test.stderr]).toHaveLength(1);
    expect(`${test.stdout.join(' ')} ${test.stderr.join(' ')}`).not.toContain('SECRET-');
  });

  it('emits exactly once when a foreground runtime reports ready concurrently', async () => {
    const test = harness();
    test.runtime.control.mockResolvedValue({
      command: 'launch_ticket',
      value: { ticket: CANONICAL_TICKET, expiresAt: NOW + 30_000 },
    });
    test.runtime.runForeground.mockImplementation(async (_input, foreground) => {
      const first = foreground.onReady(READY_IDENTITY);
      await foreground.onReady(READY_IDENTITY);
      await first;
      return 0;
    });

    const exitCode = await runCli(['start', '--foreground', '--json'], test.options);

    expect(exitCode).toBe(1);
    expect(test.stderr).toEqual([]);
    expect(test.stdout).toEqual([JSON.stringify({
      schemaVersion: 1,
      ok: false,
      command: 'start',
      error: { code: 'runtime_response_invalid' },
    })]);
  });

  it('ignores a late ready callback after the foreground run has already completed', async () => {
    const test = harness();
    let lateReady!: (identity: typeof READY_IDENTITY) => Promise<void>;
    test.runtime.runForeground.mockImplementation(async (_input, foreground) => {
      lateReady = foreground.onReady;
      return 0;
    });

    const exitCode = await runCli(
      ['start', '--foreground', '--no-open', '--json'],
      test.options,
    );
    await lateReady(READY_IDENTITY);

    expect(exitCode).toBe(1);
    expect(test.stderr).toEqual([]);
    expect(test.stdout).toEqual([JSON.stringify({
      schemaVersion: 1,
      ok: false,
      command: 'start',
      error: { code: 'runtime_response_invalid' },
    })]);
  });

  it('rejects a foreground run that exits without ever reporting ready', async () => {
    const test = harness();
    test.runtime.runForeground.mockResolvedValue(0);

    const exitCode = await runCli(['start', '--foreground', '--no-open'], test.options);

    expect(exitCode).toBe(1);
    expect(test.stderr).toEqual(['quukk-clawmessenger: runtime_response_invalid']);
    expect(test.runtime.control).not.toHaveBeenCalled();
    expect(test.browser.open).not.toHaveBeenCalled();
  });

  it('keeps a foreground service running while preserving fixed control failure classification', async () => {
    const test = harness();
    const calls: string[] = [];
    test.runtime.control.mockRejectedValue(Object.assign(new Error('SECRET-CONTROL-DETAIL'), {
      code: 'operation_timeout',
    }));
    test.runtime.runForeground.mockImplementation(async (_input, foreground) => {
      await foreground.onReady(READY_IDENTITY);
      calls.push('service-kept-running');
      return 0;
    });

    const exitCode = await runCli(['start', '--foreground'], test.options);

    expect(exitCode).toBe(5);
    expect(calls).toEqual(['service-kept-running']);
    expect(test.stderr).toEqual(['quukk-clawmessenger: operation_timeout']);
    expect(`${test.stdout.join(' ')} ${test.stderr.join(' ')}`).not.toContain('SECRET-CONTROL-DETAIL');
  });

  it('writes exactly one strict safe JSON object for supported JSON output', async () => {
    const test = harness();

    const exitCode = await runCli(['setup', '--no-open', '--json'], test.options);

    expect(exitCode).toBe(0);
    expect(test.stderr).toEqual([]);
    expect(test.stdout).toHaveLength(1);
    expect(JSON.parse(test.stdout[0]!)).toEqual({
      schemaVersion: 1,
      ok: true,
      command: 'setup',
      state: 'ready',
      alreadyRunning: false,
    });
  });

  it.each([
    { command: 'status', expectedExit: 3 },
    { command: 'rescan', expectedExit: 3 },
    { command: 'stop', expectedExit: 0 },
  ] as const)('classifies missing identity for $command without calling control', async ({ command, expectedExit }) => {
    const test = harness();

    const exitCode = await runCli([command], test.options);

    expect(exitCode).toBe(expectedExit);
    expect(test.runtime.inspect).toHaveBeenCalledOnce();
    expect(test.runtime.control).not.toHaveBeenCalled();
    expect(test.browser.open).not.toHaveBeenCalled();
    expect(`${test.stdout.join(' ')} ${test.stderr.join(' ')}`).not.toContain('undefined');
  });

  it.each([
    {
      argv: ['status'],
      expected: 'quukk-clawmessenger: status starting',
    },
    {
      argv: ['status', '--json'],
      expected: JSON.stringify({
        schemaVersion: 1,
        ok: true,
        command: 'status',
        state: 'starting',
        pid: 321,
      }),
    },
  ])('projects a starting status safely for $argv', async ({ argv, expected }) => {
    const test = harness();
    test.runtime.inspect.mockResolvedValue({ kind: 'starting', identity: STARTING_IDENTITY });

    const exitCode = await runCli(argv, test.options);

    expect(exitCode).toBe(0);
    expect(test.stdout).toEqual([expected]);
    expect(test.stderr).toEqual([]);
    expect(test.runtime.control).not.toHaveBeenCalled();
  });

  it('classifies a corrupt identity without using process APIs', async () => {
    const test = harness();
    test.runtime.inspect.mockResolvedValue({
      kind: 'corrupt', errorCode: 'identity_corrupt',
    });

    const exitCode = await runCli(['status'], test.options);

    expect(exitCode).toBe(4);
    expect(test.stderr).toEqual(['quukk-clawmessenger: unsafe_identity']);
    expect(test.runtime.control).not.toHaveBeenCalled();
  });

  it('authenticates ready status and emits only a strict safe projection', async () => {
    const test = harness();
    test.runtime.inspect.mockResolvedValue({
      kind: 'ready', identity: READY_IDENTITY, contentDigest: 'd'.repeat(64),
    });
    test.runtime.control.mockResolvedValue({
      command: 'status',
      value: { schemaVersion: 1, identity: READY_IDENTITY, state: 'ready' },
    });

    const exitCode = await runCli(['status', '--json'], test.options);

    expect(exitCode).toBe(0);
    expect(test.runtime.control).toHaveBeenCalledWith(READY_IDENTITY, 'status');
    expect(test.stderr).toEqual([]);
    expect(test.stdout).toHaveLength(1);
    expect(JSON.parse(test.stdout[0]!)).toEqual({
      schemaVersion: 1,
      ok: true,
      command: 'status',
      state: 'ready',
      pid: 321,
      port: 43210,
    });
  });

  it('rejects a control status identity mismatch as unsafe', async () => {
    const test = harness();
    const secretSentinel = 'SECRET-FROM-MISMATCH';
    test.runtime.inspect.mockResolvedValue({
      kind: 'ready', identity: READY_IDENTITY, contentDigest: 'd'.repeat(64),
    });
    test.runtime.control.mockResolvedValue({
      command: 'status',
      value: {
        schemaVersion: 1,
        identity: { ...READY_IDENTITY, version: secretSentinel },
        state: 'ready',
      },
    });

    const exitCode = await runCli(['status'], test.options);

    expect(exitCode).toBe(4);
    expect(test.stderr).toEqual(['quukk-clawmessenger: authentication_mismatch']);
    expect(`${test.stdout.join(' ')} ${test.stderr.join(' ')}`).not.toContain(secretSentinel);
  });

  it('rescans only through authenticated control and omits runtime paths and versions', async () => {
    const test = harness();
    const secretSentinel = `SECRET-RUNTIME-PATH-${resolve('private')}`;
    test.runtime.inspect.mockResolvedValue({
      kind: 'ready', identity: READY_IDENTITY, contentDigest: 'd'.repeat(64),
    });
    test.runtime.control.mockResolvedValue({
      command: 'rescan', value: runtimeResponse(secretSentinel) as never,
    });

    const exitCode = await runCli(['rescan', '--json'], test.options);

    expect(exitCode).toBe(0);
    expect(test.runtime.control).toHaveBeenCalledWith(READY_IDENTITY, 'rescan');
    expect(test.stdout).toHaveLength(1);
    expect(JSON.parse(test.stdout[0]!)).toEqual({
      schemaVersion: 1,
      ok: true,
      command: 'rescan',
      runtimes: [
        { provider: 'opencode', status: 'ready', runtimeId: `rt_${'1'.repeat(32)}` },
        { provider: 'openclaw', status: 'not_found', runtimeId: null },
        { provider: 'codex', status: 'not_found', runtimeId: null },
        { provider: 'hermes', status: 'not_found', runtimeId: null },
      ],
    });
    expect(test.stdout[0]).not.toContain(secretSentinel);
    expect(test.stdout[0]).not.toContain('1.0.0');
  });

  it('stops only through authenticated shutdown and treats the high-level response as complete', async () => {
    const test = harness();
    test.runtime.inspect.mockResolvedValue({
      kind: 'ready', identity: READY_IDENTITY, contentDigest: 'd'.repeat(64),
    });
    test.runtime.control.mockResolvedValue({ command: 'shutdown', value: { accepted: true } });

    const exitCode = await runCli(['stop', '--json'], test.options);

    expect(exitCode).toBe(0);
    expect(test.runtime.control).toHaveBeenCalledWith(READY_IDENTITY, 'shutdown');
    expect(test.stdout).toEqual([JSON.stringify({
      schemaVersion: 1, ok: true, command: 'stop', state: 'stopped',
    })]);
  });

  it.each([
    { runtimeCode: 'control_unauthorized', expectedExit: 4, outputCode: 'authentication_mismatch' },
    { runtimeCode: 'identity_corrupt', expectedExit: 4, outputCode: 'unsafe_identity' },
    { runtimeCode: 'identity_invalid', expectedExit: 4, outputCode: 'unsafe_identity' },
    { runtimeCode: 'process_unverified', expectedExit: 4, outputCode: 'unsafe_identity' },
    { runtimeCode: 'unsafe_identity', expectedExit: 4, outputCode: 'unsafe_identity' },
    { runtimeCode: 'operation_timeout', expectedExit: 5, outputCode: 'operation_timeout' },
    { runtimeCode: 'timeout', expectedExit: 5, outputCode: 'operation_timeout' },
    { runtimeCode: 'shutdown_timeout', expectedExit: 5, outputCode: 'operation_timeout' },
    { runtimeCode: 'bridge_unavailable', expectedExit: 5, outputCode: 'operation_unavailable' },
    { runtimeCode: 'service_unavailable', expectedExit: 5, outputCode: 'operation_unavailable' },
    { runtimeCode: 'unavailable', expectedExit: 5, outputCode: 'operation_unavailable' },
    { runtimeCode: 'unrecognized-secret-code', expectedExit: 1, outputCode: 'internal_failure' },
  ])('maps runtime $runtimeCode to a fixed safe error', async ({ runtimeCode, expectedExit, outputCode }) => {
    const test = harness();
    const secretSentinel = 'SECRET-ERROR-MESSAGE';
    test.runtime.inspect.mockResolvedValue({
      kind: 'ready', identity: READY_IDENTITY, contentDigest: 'd'.repeat(64),
    });
    test.runtime.control.mockRejectedValue(Object.assign(new Error(secretSentinel), { code: runtimeCode }));

    const exitCode = await runCli(['status'], test.options);

    expect(exitCode).toBe(expectedExit);
    expect(test.stderr).toEqual([`quukk-clawmessenger: ${outputCode}`]);
    expect(`${test.stdout.join(' ')} ${test.stderr.join(' ')}`).not.toContain(secretSentinel);
    if (!outputCode.includes(runtimeCode)) {
      expect(`${test.stdout.join(' ')} ${test.stderr.join(' ')}`).not.toContain(runtimeCode);
    }
  });

  it('writes one JSON error object for a supported JSON command', async () => {
    const test = harness();

    const exitCode = await runCli(['status', '--json'], test.options);

    expect(exitCode).toBe(3);
    expect(test.stderr).toEqual([]);
    expect(test.stdout).toEqual([JSON.stringify({
      schemaVersion: 1,
      ok: false,
      command: 'status',
      error: { code: 'not_running' },
    })]);
  });

  it.each([
    {
      argv: ['status', '--json', '--unknown'],
      command: 'status',
      code: 'usage_error',
    },
    {
      argv: ['setup', '--json', '--server-url', 'https://user:secret@example.test'],
      command: 'setup',
      code: 'invalid_config',
    },
    {
      argv: ['setup', '--json', '--workdir', 'status'],
      command: 'setup',
      code: 'invalid_config',
    },
  ])('keeps parse-time $code in one safe JSON object', async ({ argv, command, code }) => {
    const test = harness();

    const exitCode = await runCli(argv, test.options);

    expect(exitCode).toBe(2);
    expect(test.stderr).toEqual([]);
    expect(test.stdout).toEqual([JSON.stringify({
      schemaVersion: 1,
      ok: false,
      command,
      error: { code },
    })]);
    expect(test.stdout[0]).not.toContain('secret');
    expectNoRuntimeCalls(test.runtime);
  });

  it('prints a validated safe doctor union without spreading extra keys', async () => {
    const test = harness();
    const secretSentinel = 'SECRET-DOCTOR-EXTRA';
    test.runtime.doctor.mockResolvedValue({
      schemaVersion: 1,
      state: 'ready',
      service: {
        pid: 321,
        version: VERSION,
        startedAt: '2026-08-27T12:00:00.000Z',
        port: 43210,
        controlState: 'ready',
      },
      runtimes: [
        { provider: 'opencode', status: 'ready' },
        { provider: 'openclaw', status: 'not_found' },
      ],
      warnings: ['bridge_refreshing'],
      [secretSentinel]: secretSentinel,
    } as never);

    const exitCode = await runCli(['doctor', '--json'], test.options);

    expect(exitCode).toBe(0);
    expect(test.stdout).toHaveLength(1);
    expect(JSON.parse(test.stdout[0]!)).toEqual({
      schemaVersion: 1,
      ok: true,
      command: 'doctor',
      diagnostics: {
        schemaVersion: 1,
        state: 'ready',
        service: {
          pid: 321,
          version: VERSION,
          startedAt: '2026-08-27T12:00:00.000Z',
          port: 43210,
          controlState: 'ready',
        },
        runtimes: [
          { provider: 'opencode', status: 'ready' },
          { provider: 'openclaw', status: 'not_found' },
        ],
        warnings: ['bridge_refreshing'],
      },
    });
    expect(test.stdout[0]).not.toContain(secretSentinel);
  });

  it('prints the same useful redacted doctor projection for human output', async () => {
    const test = harness();
    const secretSentinel = 'SECRET-DOCTOR-HUMAN-EXTRA';
    test.runtime.doctor.mockResolvedValue({
      schemaVersion: 1,
      state: 'ready',
      service: {
        pid: 321,
        version: VERSION,
        startedAt: '2026-08-27T12:00:00.000Z',
        port: 43210,
        controlState: 'ready',
      },
      runtimes: [
        { provider: 'opencode', status: 'ready' },
        { provider: 'openclaw', status: 'not_found' },
      ],
      warnings: ['bridge_refreshing'],
      [secretSentinel]: secretSentinel,
    } as never);

    const exitCode = await runCli(['doctor'], test.options);

    expect(exitCode).toBe(0);
    expect(test.stderr).toEqual([]);
    expect(test.stdout).toEqual([[
      'quukk-clawmessenger: doctor ready',
      `service pid=321 version=${VERSION} started_at=2026-08-27T12:00:00.000Z port=43210 control_state=ready`,
      'runtime provider=opencode status=ready',
      'runtime provider=openclaw status=not_found',
      'warning code=bridge_refreshing',
    ].join('\n')]);
    expect(test.stdout[0]).not.toContain(secretSentinel);
    expect(test.stdout[0]).not.toMatch(/path|nodeId|tokenRef|secret/i);
  });

  it('rejects unsafe doctor fields without echoing them', async () => {
    const test = harness();
    const secretSentinel = 'SECRET DOCTOR WARNING';
    test.runtime.doctor.mockResolvedValue({
      schemaVersion: 1, state: 'offline', warnings: [secretSentinel],
    } as never);

    const exitCode = await runCli(['doctor'], test.options);

    expect(exitCode).toBe(1);
    expect(test.stderr).toEqual(['quukk-clawmessenger: runtime_response_invalid']);
    expect(`${test.stdout.join(' ')} ${test.stderr.join(' ')}`).not.toContain(secretSentinel);
  });

  it('streams the default bounded log tail and forwards explicit lines/follow', async () => {
    const test = harness();
    test.runtime.readLogs.mockImplementation(({ lines, follow }) => (async function* () {
      yield JSON.stringify({ event: 'one', lines, follow });
      yield JSON.stringify({ event: 'two' });
    })());

    const firstExit = await runCli(['logs'], test.options);
    const secondExit = await runCli(['logs', '--lines', '1000', '--follow'], test.options);

    expect(firstExit).toBe(0);
    expect(secondExit).toBe(0);
    expect(test.runtime.readLogs).toHaveBeenNthCalledWith(1, { lines: 100, follow: false });
    expect(test.runtime.readLogs).toHaveBeenNthCalledWith(2, { lines: 1000, follow: true });
    expect(test.stdout).toHaveLength(4);
  });

  it.each(['0', '1001', '01', '+1', '1.0'])('rejects invalid log bound %s before reading logs', async (lines) => {
    const test = harness();

    const exitCode = await runCli(['logs', '--lines', lines], test.options);

    expect(exitCode).toBe(2);
    expect(test.runtime.readLogs).not.toHaveBeenCalled();
  });

  it('rejects an oversized log record at the CLI boundary', async () => {
    const test = harness();
    test.runtime.readLogs.mockImplementation(() => (async function* () {
      yield 'x'.repeat(8_193);
    })());

    const exitCode = await runCli(['logs'], test.options);

    expect(exitCode).toBe(1);
    expect(test.stderr).toEqual(['quukk-clawmessenger: runtime_response_invalid']);
    expect(test.stdout).toEqual([]);
  });
});

describe('createSystemBrowserPort', () => {
  const url = `http://127.0.0.1:43210/setup#ticket=${'Z'.repeat(42)}A`;
  const environment = {
    SYSTEMROOT: 'C:\\Windows',
    WINDIR: 'C:\\Windows',
    USERPROFILE: 'C:\\Users\\safe',
    TEMP: 'D:\\Temp',
    TMP: 'D:\\Tmp',
    TMPDIR: '/tmp/safe',
    PATH: '/usr/local/bin:/usr/bin',
    PATHEXT: '.EXE;.CMD',
    SESSIONNAME: 'Console',
    HOME: '/home/safe',
    USER: 'safe-user',
    LOGNAME: 'safe-user',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'C.UTF-8',
    DISPLAY: ':0',
    WAYLAND_DISPLAY: 'wayland-0',
    XDG_RUNTIME_DIR: '/run/user/1000',
    XDG_CURRENT_DESKTOP: 'GNOME',
    XDG_SESSION_TYPE: 'wayland',
    DESKTOP_SESSION: 'gnome',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    BROWSER: 'malicious-browser --with-shell',
    npm_config_token: 'NPM-SECRET-SENTINEL',
    NODE_OPTIONS: '--require malicious.js',
    node_tls_reject_unauthorized: '0',
    QUUKK_CLAWMESSENGER_SECRET: 'QUUKK-SECRET-SENTINEL',
    API_KEY: 'API-KEY-SENTINEL',
    PASSWORD: 'PASSWORD-SENTINEL',
  };

  it.each([
    {
      platform: 'win32' as const,
      executable: 'explorer.exe',
      expectedEnv: {
        SYSTEMROOT: 'C:\\Windows', WINDIR: 'C:\\Windows', USERPROFILE: 'C:\\Users\\safe',
        TEMP: 'D:\\Temp', TMP: 'D:\\Tmp', PATH: '/usr/local/bin:/usr/bin',
        PATHEXT: '.EXE;.CMD', SESSIONNAME: 'Console',
      },
    },
    {
      platform: 'darwin' as const,
      executable: '/usr/bin/open',
      expectedEnv: {
        HOME: '/home/safe', USER: 'safe-user', LOGNAME: 'safe-user',
        TMPDIR: '/tmp/safe', TEMP: 'D:\\Temp', TMP: 'D:\\Tmp',
        PATH: '/usr/local/bin:/usr/bin', LANG: 'en_US.UTF-8', LC_ALL: 'C.UTF-8',
      },
    },
    {
      platform: 'linux' as const,
      executable: 'xdg-open',
      expectedEnv: {
        HOME: '/home/safe', USER: 'safe-user', LOGNAME: 'safe-user',
        TMPDIR: '/tmp/safe', TEMP: 'D:\\Temp', TMP: 'D:\\Tmp',
        PATH: '/usr/local/bin:/usr/bin', LANG: 'en_US.UTF-8', LC_ALL: 'C.UTF-8',
        DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0', XDG_RUNTIME_DIR: '/run/user/1000',
        XDG_CURRENT_DESKTOP: 'GNOME', XDG_SESSION_TYPE: 'wayland', DESKTOP_SESSION: 'gnome',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      },
    },
  ])('uses the fixed $platform opener, URL-only argv, and minimal environment', async ({
    platform, executable, expectedEnv,
  }) => {
    const child = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> };
    child.unref = vi.fn();
    const spawn = vi.fn(() => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });
    const browser = createSystemBrowserPort({
      platform,
      environment,
      spawn: spawn as never,
    });

    await browser.open(url);

    expect(spawn).toHaveBeenCalledWith(executable, [url], {
      shell: false,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: expectedEnv,
    });
    expect(child.unref).toHaveBeenCalledOnce();
    const serialized = JSON.stringify(spawn.mock.calls);
    expect(serialized).not.toContain('NPM-SECRET-SENTINEL');
    expect(serialized).not.toContain('QUUKK-SECRET-SENTINEL');
    expect(serialized).not.toContain('API-KEY-SENTINEL');
    expect(serialized).not.toContain('PASSWORD-SENTINEL');
  });

  it('accepts an explicit identity port 80 after URL default-port normalization', async () => {
    const port80Url = `http://127.0.0.1:80/#ticket=${CANONICAL_TICKET}`;
    const child = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> };
    child.unref = vi.fn();
    const spawn = vi.fn(() => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });
    const browser = createSystemBrowserPort({
      platform: 'linux',
      environment: {},
      spawn: spawn as never,
    });

    await browser.open(port80Url);

    expect(spawn).toHaveBeenCalledWith('xdg-open', [port80Url], expect.objectContaining({
      shell: false,
    }));
  });

  it.each([
    `https://127.0.0.1:43210/#ticket=${CANONICAL_TICKET}`,
    `http://localhost:43210/#ticket=${CANONICAL_TICKET}`,
    `http://127.0.0.2:43210/#ticket=${CANONICAL_TICKET}`,
    `http://127.0.0.1/#ticket=${CANONICAL_TICKET}`,
    `http://127.0.0.1:0/#ticket=${CANONICAL_TICKET}`,
    `http://127.0.0.1:43210/setup/#ticket=${CANONICAL_TICKET}`,
    `http://127.0.0.1:43210/other#ticket=${CANONICAL_TICKET}`,
    `http://127.0.0.1:43210/?query=1#ticket=${CANONICAL_TICKET}`,
    `http://user@127.0.0.1:43210/#ticket=${CANONICAL_TICKET}`,
    'http://127.0.0.1:43210/',
    `http://127.0.0.1:43210/#ticket=${'x'.repeat(42)}`,
    `http://127.0.0.1:43210/#ticket=${CANONICAL_TICKET}&extra=1`,
    `http://127.0.0.1:43210/#ticket=${'x'.repeat(43)}`,
  ])('rejects an unsafe browser URL before spawn: %s', async (unsafeUrl) => {
    const spawn = vi.fn();
    const browser = createSystemBrowserPort({ platform: 'linux', environment: {}, spawn: spawn as never });

    await expect(browser.open(unsafeUrl)).rejects.toMatchObject({
      code: 'browser_open_failed',
      message: 'browser_open_failed',
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(['sync', 'async'] as const)('normalizes %s spawn failure without echoing details', async (kind) => {
    const secretSentinel = `SECRET-SPAWN-${kind}`;
    const child = new EventEmitter() as EventEmitter & { unref(): void };
    child.unref = vi.fn();
    const spawn = vi.fn(() => {
      if (kind === 'sync') throw new Error(`${secretSentinel} ${url}`);
      queueMicrotask(() => child.emit('error', new Error(`${secretSentinel} ${url}`)));
      return child;
    });
    const browser = createSystemBrowserPort({ platform: 'linux', environment: {}, spawn: spawn as never });

    const error = await browser.open(url).catch((value: unknown) => value);

    expect(error).toMatchObject({ code: 'browser_open_failed', message: 'browser_open_failed' });
    expect(JSON.stringify(error)).not.toContain(secretSentinel);
    expect(JSON.stringify(error)).not.toContain(url);
  });
});

describe('createProductionCliRuntime', () => {
  const HOME = resolve('production-cli-home');
  const EXECUTABLE = resolve('runtime', 'node.exe');
  const PACKAGED_BIN = resolve('package', 'bin', 'quukk-clawmessenger.js');
  const BRIDGE_SECRET = CANONICAL_TICKET;

  function identityStore(snapshot: unknown = {}) {
    return {
      read: vi.fn(async () => snapshot),
      claim: vi.fn(async () => true),
      markReady: vi.fn(),
      quarantineStaleIfExact: vi.fn(async () => true),
      removeIfMatches: vi.fn(async () => true),
    };
  }

  function productionOptions(
    store: ReturnType<typeof identityStore>,
    dependencies: Record<string, unknown> = {},
  ) {
    return {
      homeDirectory: HOME,
      processEnvironment: {},
      execPath: EXECUTABLE,
      packagedBinPath: PACKAGED_BIN,
      dependencies: {
        identityStore: store,
        processId: READY_IDENTITY.pid,
        now: () => Date.parse(READY_IDENTITY.started_at),
        randomBytes: () => Buffer.alloc(16, 0xaa),
        ...dependencies,
      },
    };
  }

  type FakeControlResponse = {
    statusCode: number;
    body: Buffer;
    rawHeaders?: string[];
    complete?: boolean;
    trailers?: Record<string, string>;
  };

  function controlFrame(
    value: unknown,
    statusCode = 200,
    overrides: Partial<FakeControlResponse> = {},
  ): FakeControlResponse {
    const body = Buffer.from(JSON.stringify(value), 'utf8');
    return {
      statusCode,
      body,
      rawHeaders: [
        'Content-Type', 'application/json; charset=utf-8',
        'Content-Length', String(body.byteLength),
        'Connection', 'close',
      ],
      complete: true,
      trailers: {},
      ...overrides,
    };
  }

  function requestSequence(frames: readonly FakeControlResponse[]) {
    const bodies: string[] = [];
    let index = 0;
    const request = vi.fn((_options: unknown, callback: (response: unknown) => void) => {
      const outgoing = new EventEmitter() as EventEmitter & {
        end(body: Buffer): void;
        destroy(error?: Error): void;
      };
      outgoing.end = vi.fn((body: Buffer) => {
        bodies.push(Buffer.from(body).toString('utf8'));
        const frame = frames[index++];
        if (frame === undefined) throw new Error('unexpected_control_request');
        const response = Readable.from([frame.body]) as Readable & {
          statusCode: number;
          rawHeaders: string[];
          complete: boolean;
          trailers: Record<string, string>;
        };
        response.statusCode = frame.statusCode;
        response.rawHeaders = frame.rawHeaders ?? [];
        response.complete = frame.complete ?? false;
        response.trailers = frame.trailers ?? {};
        queueMicrotask(() => callback(response));
      });
      outgoing.destroy = vi.fn();
      return outgoing;
    });
    return { request, bodies };
  }

  function failingRequest(code: string, bodies: string[] = []) {
    return vi.fn((_options: unknown, _callback: (response: unknown) => void) => {
      const outgoing = new EventEmitter() as EventEmitter & {
        end(body: Buffer): void;
        destroy(error?: Error): void;
      };
      outgoing.end = vi.fn((body: Buffer) => {
        bodies.push(Buffer.from(body).toString('utf8'));
        queueMicrotask(() => outgoing.emit('error', Object.assign(new Error(code), { code })));
      });
      outgoing.destroy = vi.fn();
      return outgoing;
    });
  }

  function daemonChild() {
    const child = new EventEmitter() as EventEmitter & {
      stdin: { end: ReturnType<typeof vi.fn> };
      unref: ReturnType<typeof vi.fn>;
    };
    child.stdin = { end: vi.fn() };
    child.unref = vi.fn();
    return child;
  }

  it.each([
    [{}, { kind: 'not_running' }],
    [{ identity: STARTING_IDENTITY, contentDigest: '1'.repeat(64) }, {
      kind: 'starting', identity: STARTING_IDENTITY,
    }],
    [{ identity: READY_IDENTITY, contentDigest: '2'.repeat(64) }, {
      kind: 'ready', identity: READY_IDENTITY, contentDigest: '2'.repeat(64),
    }],
  ])('projects identity-store inspection without any other production operation', async (snapshot, expected) => {
    const store = identityStore(snapshot);
    const forbidden = vi.fn(() => { throw new Error('forbidden_production_operation'); });
    const runtime = createProductionCliRuntime(productionOptions(store, {
      readStdin: forbidden,
      startService: forbidden,
      spawn: forbidden,
      request: forbidden,
      readJson: forbidden,
      kill: forbidden,
    }) as never);

    await expect(runtime.inspect()).resolves.toEqual(expected);

    expect(store.read).toHaveBeenCalledOnce();
    expect(forbidden).not.toHaveBeenCalled();
  });

  it('claims before stdin/service I/O and leaves a losing foreground contender inert', async () => {
    const events: string[] = [];
    const store = identityStore();
    store.claim.mockImplementation(async () => {
      events.push('claim');
      return false;
    });
    const readStdin = vi.fn(async () => {
      events.push('stdin');
      return Buffer.from('{}\n');
    });
    const startService = vi.fn(async () => {
      events.push('service');
      throw new Error('service_must_not_start');
    });
    const runtime = createProductionCliRuntime(productionOptions(store, {
      readStdin,
      startService,
    }) as never);

    await expect(runtime.runForeground(
      { foreground: true, noOpen: true, configOverrides: {} },
      { daemonChild: true, onReady: vi.fn() },
    )).rejects.toMatchObject({ code: 'identity_conflict' });

    expect(events).toEqual(['claim']);
    expect(readStdin).not.toHaveBeenCalled();
    expect(startService).not.toHaveBeenCalled();
    expect(store.removeIfMatches).not.toHaveBeenCalled();
  });

  it('accepts one strict child StartInput frame, reports ready once, and shares signal shutdown', async () => {
    const events: string[] = [];
    const store = identityStore();
    store.claim.mockImplementation(async () => {
      events.push('claim');
      return true;
    });
    const childInput = {
      foreground: false,
      noOpen: false,
      configOverrides: { logLevel: 'warn' as const },
    };
    const readStdin = vi.fn(async () => {
      events.push('stdin');
      return Buffer.from(`${JSON.stringify(childInput)}\n`, 'utf8');
    });
    const signals = new EventEmitter();
    const stop = vi.fn(async () => { events.push('stop'); });
    const status = vi.fn(async () => ({
      schemaVersion: 1 as const,
      identity: READY_IDENTITY,
      state: 'ready' as const,
    }));
    const startService = vi.fn(async () => {
      events.push('service');
      return { status, stop };
    });
    const onReady = vi.fn(async () => {
      events.push('ready');
      signals.emit('SIGTERM');
    });
    const runtime = createProductionCliRuntime(productionOptions(store, {
      readStdin,
      startService,
      signals,
    }) as never);

    await expect(runtime.runForeground(
      { foreground: true, noOpen: true, configOverrides: {} },
      { daemonChild: true, onReady },
    )).resolves.toBe(0);

    expect(events).toEqual(['claim', 'stdin', 'service', 'ready', 'stop']);
    expect(readStdin).toHaveBeenCalledWith(64 << 10);
    expect(startService).toHaveBeenCalledWith(expect.objectContaining({
      identity: expect.objectContaining({
        schema_version: 1,
        state: 'starting',
        pid: READY_IDENTITY.pid,
        version: VERSION,
        instance_id: `svc_${'aa'.repeat(16)}`,
        started_at: READY_IDENTITY.started_at,
      }),
      identityStore: store,
      homeDirectory: HOME,
      processEnvironment: {},
      configEnvironment: {},
      configOverrides: { logLevel: 'warn' },
    }));
    expect(status).toHaveBeenCalledOnce();
    expect(onReady).toHaveBeenCalledOnce();
    expect(onReady).toHaveBeenCalledWith(READY_IDENTITY);
    expect(stop).toHaveBeenCalledOnce();
    expect(store.removeIfMatches).not.toHaveBeenCalled();
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  });

  it('observes control shutdown identity removal through the same one-shot service stop path', async () => {
    const store = identityStore({ identity: READY_IDENTITY, contentDigest: '2'.repeat(64) });
    const signals = new EventEmitter();
    const stop = vi.fn(async () => undefined);
    const startService = vi.fn(async () => ({
      status: vi.fn(async () => ({
        schemaVersion: 1 as const, identity: READY_IDENTITY, state: 'ready' as const,
      })),
      stop,
    }));
    const runtime = createProductionCliRuntime(productionOptions(store, {
      startService,
      signals,
      sleep: vi.fn(async () => undefined),
    }) as never);
    const onReady = vi.fn(async () => {
      store.read.mockResolvedValue({});
      setImmediate(() => signals.emit('SIGTERM'));
    });

    await expect(runtime.runForeground(
      { foreground: true, noOpen: true, configOverrides: {} },
      { daemonChild: false, onReady },
    )).resolves.toBe(0);

    expect(store.read).toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
    expect(onReady).toHaveBeenCalledOnce();
  });

  it.each([
    ['missing LF', Buffer.from('{}', 'utf8')],
    ['multiple LF', Buffer.from('{}\n\n', 'utf8')],
    ['fatal UTF-8', Buffer.from([0xc3, 0x28, 0x0a])],
    ['oversized', Buffer.alloc((64 << 10) + 1, 0x20)],
    ['foreground true', Buffer.from(`${JSON.stringify({
      foreground: true, noOpen: true, configOverrides: {},
    })}\n`, 'utf8')],
    ['unknown top-level key', Buffer.from(`${JSON.stringify({
      foreground: false, noOpen: true, configOverrides: {}, extra: 'SECRET-EXTRA-SENTINEL',
    })}\n`, 'utf8')],
    ['secret key', Buffer.from(`${JSON.stringify({
      foreground: false, noOpen: true, configOverrides: {}, secret: 'SECRET-STDIN-SENTINEL',
    })}\n`, 'utf8')],
    ['unknown config key', Buffer.from(`${JSON.stringify({
      foreground: false, noOpen: true, configOverrides: { token: 'TOKEN-STDIN-SENTINEL' },
    })}\n`, 'utf8')],
  ])('rejects %s child stdin and removes only the exact winning claim', async (_label, frame) => {
    const events: string[] = [];
    const store = identityStore();
    store.claim.mockImplementation(async () => {
      events.push('claim');
      return true;
    });
    const readStdin = vi.fn(async () => {
      events.push('stdin');
      return frame;
    });
    const startService = vi.fn(async () => {
      events.push('service');
      throw new Error('service_must_not_start');
    });
    const runtime = createProductionCliRuntime(productionOptions(store, {
      readStdin,
      startService,
    }) as never);

    const error = await runtime.runForeground(
      { foreground: true, noOpen: true, configOverrides: {} },
      { daemonChild: true, onReady: vi.fn() },
    ).catch((value: unknown) => value);

    expect(error).toMatchObject({ code: 'invalid_config', message: 'invalid_config' });
    expect(events).toEqual(['claim', 'stdin']);
    expect(startService).not.toHaveBeenCalled();
    expect(store.removeIfMatches).toHaveBeenCalledOnce();
    expect(store.removeIfMatches).toHaveBeenCalledWith(expect.objectContaining({
      state: 'starting', instance_id: `svc_${'aa'.repeat(16)}`,
    }));
    expect(JSON.stringify(error)).not.toMatch(/SECRET|TOKEN/);
  });

  it('normalizes foreground service acquisition failure and removes the exact claim', async () => {
    const store = identityStore();
    const startService = vi.fn(async () => { throw new Error('SECRET-SERVICE-FAILURE'); });
    const runtime = createProductionCliRuntime(productionOptions(store, { startService }) as never);

    const error = await runtime.runForeground(
      { foreground: true, noOpen: true, configOverrides: { logLevel: 'error' } },
      { daemonChild: false, onReady: vi.fn() },
    ).catch((value: unknown) => value);

    expect(error).toMatchObject({ code: 'operation_unavailable', message: 'operation_unavailable' });
    expect(JSON.stringify(error)).not.toContain('SECRET-SERVICE-FAILURE');
    expect(store.removeIfMatches).toHaveBeenCalledOnce();
  });

  it('spawns the exact packaged child only from not-running and sends config through one stdin frame', async () => {
    const store = identityStore();
    store.read
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ identity: STARTING_IDENTITY, contentDigest: '1'.repeat(64) })
      .mockResolvedValueOnce({ identity: READY_IDENTITY, contentDigest: '2'.repeat(64) });
    const child = daemonChild();
    const spawn = vi.fn(() => child);
    const transport = requestSequence([
      controlFrame({ schemaVersion: 1, identity: READY_IDENTITY, state: 'ready' }),
    ]);
    const environment = {
      PATH: 'D:\\safe-bin',
      OPENCODE_API_KEY: 'PROVIDER-AUTH-SENTINEL',
      QUUKK_EXISTING_SETTING: 'keep-me',
      npm_config_token: 'NPM-SECRET-SENTINEL',
      NpM_Package_Config: 'NPM-MIXED-SENTINEL',
      node_options: '--require NODE-OPTIONS-SENTINEL',
      Node_Tls_Reject_Unauthorized: '0',
    };
    const runtime = createProductionCliRuntime({
      ...productionOptions(store, {
        spawn,
        sleep: vi.fn(async () => undefined),
        readJson: vi.fn(async () => ({
          schemaVersion: 1 as const, bridgeSecret: BRIDGE_SECRET, tokens: {},
        })),
        request: transport.request,
      }),
      processEnvironment: environment,
    } as never);
    const input = {
      foreground: false,
      noOpen: false,
      configOverrides: { serverUrl: 'https://example.test/im', logLevel: 'debug' as const },
    };

    await expect(runtime.start(input)).resolves.toEqual({
      identity: READY_IDENTITY, alreadyRunning: false,
    });

    expect(spawn).toHaveBeenCalledWith(EXECUTABLE, [
      PACKAGED_BIN, 'start', '--foreground', '--no-open', '--daemon-child',
    ], {
      shell: false,
      detached: true,
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'ignore'],
      env: {
        PATH: 'D:\\safe-bin',
        OPENCODE_API_KEY: 'PROVIDER-AUTH-SENTINEL',
        QUUKK_EXISTING_SETTING: 'keep-me',
      },
    });
    expect(child.stdin.end).toHaveBeenCalledOnce();
    expect(child.stdin.end).toHaveBeenCalledWith(`${JSON.stringify(input)}\n`, 'utf8');
    expect(child.unref).toHaveBeenCalledOnce();
    expect(store.claim).not.toHaveBeenCalled();
    expect(transport.bodies).toEqual(['{"command":"status"}']);
    const spawnSerialization = JSON.stringify(spawn.mock.calls);
    expect(spawnSerialization).not.toMatch(/NPM-SECRET|NPM-MIXED|NODE-OPTIONS|Node_Tls/i);
    expect(spawnSerialization).not.toContain('https://example.test/im');
  });

  it('authenticates an existing ready winner without spawning or trusting PID alone', async () => {
    const store = identityStore({ identity: READY_IDENTITY, contentDigest: '2'.repeat(64) });
    const transport = requestSequence([
      controlFrame({ schemaVersion: 1, identity: READY_IDENTITY, state: 'ready' }),
    ]);
    const spawn = vi.fn();
    const runtime = createProductionCliRuntime(productionOptions(store, {
      spawn,
      readJson: vi.fn(async () => ({
        schemaVersion: 1 as const, bridgeSecret: BRIDGE_SECRET, tokens: {},
      })),
      request: transport.request,
    }) as never);

    await expect(runtime.start({
      foreground: false, noOpen: true, configOverrides: {},
    })).resolves.toEqual({ identity: READY_IDENTITY, alreadyRunning: true });
    expect(spawn).not.toHaveBeenCalled();
    expect(store.quarantineStaleIfExact).not.toHaveBeenCalled();
  });

  it('requires three one-second unreachable probes and ESRCH before exact stale quarantine', async () => {
    const store = identityStore({ identity: READY_IDENTITY, contentDigest: '2'.repeat(64) });
    const bodies: string[] = [];
    const request = failingRequest('ECONNREFUSED', bodies);
    const sleep = vi.fn(async () => undefined);
    const kill = vi.fn(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
    const readJson = vi.fn(async () => ({
      schemaVersion: 1 as const, bridgeSecret: BRIDGE_SECRET, tokens: {},
    }));
    const runtime = createProductionCliRuntime(productionOptions(store, {
      request,
      sleep,
      kill,
      readJson,
    }) as never);

    await expect(runtime.recoverStaleForStart({
      identity: READY_IDENTITY,
      contentDigest: '2'.repeat(64),
      pidProbe: 'esrch',
      controlAttempts: 3,
    })).resolves.toBe(true);

    expect(bodies).toEqual(Array(3).fill('{"command":"status"}'));
    expect(readJson).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[100], [250]]);
    expect(kill).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledWith(READY_IDENTITY.pid, 0);
    expect(store.quarantineStaleIfExact).toHaveBeenCalledOnce();
    expect(store.quarantineStaleIfExact).toHaveBeenCalledWith({
      expected: READY_IDENTITY, contentDigest: '2'.repeat(64),
    });
  });

  it.each([
    ['live PID', undefined],
    ['EPERM PID', 'EPERM'],
  ])('never quarantines stale identity after %s', async (_label, killCode) => {
    const store = identityStore();
    const kill = vi.fn(() => {
      if (killCode !== undefined) throw Object.assign(new Error(killCode), { code: killCode });
      return true;
    });
    const runtime = createProductionCliRuntime(productionOptions(store, {
      request: failingRequest('ECONNREFUSED'),
      sleep: vi.fn(async () => undefined),
      kill,
      readJson: vi.fn(async () => ({
        schemaVersion: 1 as const, bridgeSecret: BRIDGE_SECRET, tokens: {},
      })),
    }) as never);

    await expect(runtime.recoverStaleForStart({
      identity: READY_IDENTITY,
      contentDigest: '2'.repeat(64),
      pidProbe: 'esrch',
      controlAttempts: 3,
    })).rejects.toMatchObject({ code: 'stale_unverified' });
    expect(store.quarantineStaleIfExact).not.toHaveBeenCalled();
  });

  it('uses a fresh bounded credential read and an exact loopback status request', async () => {
    const store = identityStore({ identity: READY_IDENTITY, contentDigest: '2'.repeat(64) });
    const credentials = { schemaVersion: 1 as const, bridgeSecret: BRIDGE_SECRET, tokens: {} };
    const readJson = vi.fn(async () => credentials);
    const responseBody = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      identity: READY_IDENTITY,
      state: 'ready',
    }), 'utf8');
    let requestBody: Buffer | undefined;
    const request = vi.fn((_requestOptions: unknown, callback: (response: unknown) => void) => {
      const outgoing = new EventEmitter() as EventEmitter & {
        end(body: Buffer): void;
        destroy(error?: Error): void;
      };
      outgoing.end = vi.fn((body: Buffer) => {
        requestBody = Buffer.from(body);
        const response = Readable.from([responseBody]) as Readable & {
          statusCode: number;
          rawHeaders: string[];
          complete: boolean;
          trailers: Record<string, string>;
        };
        response.statusCode = 200;
        response.rawHeaders = [
          'Content-Type', 'application/json; charset=utf-8',
          'Content-Length', String(responseBody.byteLength),
          'Connection', 'close',
        ];
        response.complete = true;
        response.trailers = {};
        queueMicrotask(() => callback(response));
      });
      outgoing.destroy = vi.fn();
      return outgoing;
    });
    const runtime = createProductionCliRuntime(productionOptions(store, {
      readJson,
      request,
    }) as never);

    await expect(runtime.control(READY_IDENTITY, 'status')).resolves.toEqual({
      command: 'status',
      value: { schemaVersion: 1, identity: READY_IDENTITY, state: 'ready' },
    });

    expect(readJson).toHaveBeenCalledWith(
      localPaths(HOME).credentials,
      expect.anything(),
      4 << 20,
    );
    expect(request).toHaveBeenCalledWith({
      protocol: 'http:',
      hostname: '127.0.0.1',
      port: 43210,
      method: 'POST',
      path: '/internal/control',
      agent: false,
      headers: {
        Host: '127.0.0.1:43210',
        Authorization: `Bearer ${deriveControlCredential(BRIDGE_SECRET, READY_IDENTITY.instance_id)}`,
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': String(Buffer.byteLength('{"command":"status"}', 'utf8')),
        Connection: 'close',
      },
    }, expect.any(Function));
    expect(requestBody?.toString('utf8')).toBe('{"command":"status"}');
    expect(JSON.stringify(request.mock.calls)).not.toContain(BRIDGE_SECRET);
  });

  it('authenticates status before every non-status command and reuses no unverified response', async () => {
    const store = identityStore({ identity: READY_IDENTITY, contentDigest: '2'.repeat(64) });
    const readJson = vi.fn(async () => ({
      schemaVersion: 1 as const, bridgeSecret: BRIDGE_SECRET, tokens: {},
    }));
    const statusValue = { schemaVersion: 1, identity: READY_IDENTITY, state: 'ready' };
    const runtimesValue = runtimeResponse();
    const transport = requestSequence([
      controlFrame(statusValue),
      controlFrame(runtimesValue),
    ]);
    const runtime = createProductionCliRuntime(productionOptions(store, {
      readJson,
      request: transport.request,
    }) as never);

    await expect(runtime.control(READY_IDENTITY, 'rescan')).resolves.toEqual({
      command: 'rescan', value: runtimesValue,
    });

    expect(readJson).toHaveBeenCalledOnce();
    expect(transport.bodies).toEqual(['{"command":"status"}', '{"command":"rescan"}']);
    expect(transport.request).toHaveBeenCalledTimes(2);
  });

  it('does not send a non-status command when authenticated status mismatches', async () => {
    const store = identityStore();
    const replacement = {
      ...READY_IDENTITY,
      pid: READY_IDENTITY.pid + 1,
      instance_id: `svc_${'b'.repeat(32)}`,
    };
    const transport = requestSequence([
      controlFrame({ schemaVersion: 1, identity: replacement, state: 'ready' }),
    ]);
    const runtime = createProductionCliRuntime(productionOptions(store, {
      readJson: vi.fn(async () => ({
        schemaVersion: 1 as const, bridgeSecret: BRIDGE_SECRET, tokens: {},
      })),
      request: transport.request,
    }) as never);

    await expect(runtime.control(READY_IDENTITY, 'shutdown')).rejects.toMatchObject({
      code: 'process_unverified', message: 'process_unverified',
    });
    expect(transport.bodies).toEqual(['{"command":"status"}']);
  });

  it('waits after shutdown for both old authentication failure and exact old identity disappearance', async () => {
    const replacement = {
      ...READY_IDENTITY,
      pid: READY_IDENTITY.pid + 1,
      instance_id: `svc_${'c'.repeat(32)}`,
    };
    const store = identityStore();
    store.read
      .mockResolvedValueOnce({ identity: READY_IDENTITY, contentDigest: '2'.repeat(64) })
      .mockResolvedValueOnce({ identity: replacement, contentDigest: '3'.repeat(64) });
    const frames = [
      controlFrame({ schemaVersion: 1, identity: READY_IDENTITY, state: 'ready' }),
      controlFrame({ schemaVersion: 1, accepted: true }, 202),
      controlFrame({ schemaVersion: 1, identity: READY_IDENTITY, state: 'stopping' }),
    ];
    const successful = requestSequence(frames);
    let requestCount = 0;
    const refused = failingRequest('ECONNREFUSED', successful.bodies);
    const request = vi.fn((options: unknown, callback: (response: unknown) => void) => {
      requestCount += 1;
      return requestCount <= frames.length
        ? successful.request(options, callback)
        : refused(options, callback);
    });
    let clock = 0;
    const sleep = vi.fn(async (milliseconds: number) => { clock += milliseconds; });
    const runtime = createProductionCliRuntime(productionOptions(store, {
      request,
      sleep,
      monotonicNow: () => clock,
      readJson: vi.fn(async () => ({
        schemaVersion: 1 as const, bridgeSecret: BRIDGE_SECRET, tokens: {},
      })),
    }) as never);

    await expect(runtime.control(READY_IDENTITY, 'shutdown')).resolves.toEqual({
      command: 'shutdown', value: { accepted: true },
    });

    expect(successful.bodies).toEqual([
      '{"command":"status"}',
      '{"command":"shutdown"}',
      '{"command":"status"}',
      '{"command":"status"}',
    ]);
    expect(store.read).toHaveBeenCalledTimes(2);
    expect(store.removeIfMatches).not.toHaveBeenCalled();
    expect(store.quarantineStaleIfExact).not.toHaveBeenCalled();
  });

  it.each([
    ['HTTP status', controlFrame({ error: { code: 'control_unauthorized' } }, 401)],
    ['redirect', controlFrame({}, 302)],
    ['duplicate content length', (() => {
      const frame = controlFrame({ schemaVersion: 1, identity: READY_IDENTITY, state: 'ready' });
      return { ...frame, rawHeaders: [...frame.rawHeaders!, 'Content-Length', String(frame.body.byteLength)] };
    })()],
    ['transfer encoding', (() => {
      const frame = controlFrame({ schemaVersion: 1, identity: READY_IDENTITY, state: 'ready' });
      return { ...frame, rawHeaders: [...frame.rawHeaders!, 'Transfer-Encoding', 'chunked'] };
    })()],
    ['wrong content type', (() => {
      const frame = controlFrame({ schemaVersion: 1, identity: READY_IDENTITY, state: 'ready' });
      return { ...frame, rawHeaders: ['Content-Type', 'application/json', 'Content-Length', String(frame.body.byteLength)] };
    })()],
    ['short framing', (() => {
      const frame = controlFrame({ schemaVersion: 1, identity: READY_IDENTITY, state: 'ready' });
      return { ...frame, rawHeaders: ['Content-Type', 'application/json; charset=utf-8', 'Content-Length', String(frame.body.byteLength + 1)] };
    })()],
    ['incomplete response', controlFrame(
      { schemaVersion: 1, identity: READY_IDENTITY, state: 'ready' },
      200,
      { complete: false },
    )],
    ['trailers', controlFrame(
      { schemaVersion: 1, identity: READY_IDENTITY, state: 'ready' },
      200,
      { trailers: { sentinel: 'unsafe' } },
    )],
    ['schema extras', controlFrame({
      schemaVersion: 1, identity: READY_IDENTITY, state: 'ready', secret: 'SECRET-RESPONSE-SENTINEL',
    })],
    ['identity mismatch', controlFrame({
      schemaVersion: 1,
      identity: { ...READY_IDENTITY, instance_id: `svc_${'b'.repeat(32)}` },
      state: 'ready',
    })],
    ['fatal UTF-8', {
      statusCode: 200,
      body: Buffer.from([0xc3, 0x28]),
      rawHeaders: ['Content-Type', 'application/json; charset=utf-8', 'Content-Length', '2'],
      complete: true,
      trailers: {},
    }],
  ])('fails closed on strict control %s', async (_label, frame) => {
    const store = identityStore();
    const transport = requestSequence([frame]);
    const runtime = createProductionCliRuntime(productionOptions(store, {
      readJson: vi.fn(async () => ({
        schemaVersion: 1 as const, bridgeSecret: BRIDGE_SECRET, tokens: {},
      })),
      request: transport.request,
    }) as never);

    const error = await runtime.control(READY_IDENTITY, 'status').catch((value: unknown) => value);

    expect(error).toMatchObject({ code: 'process_unverified', message: 'process_unverified' });
    expect(JSON.stringify(error)).not.toMatch(/SECRET|unsafe/);
  });

  it('tails only complete bounded log lines and follows append, rotation, and truncation', async () => {
    const store = identityStore();
    const signals = new EventEmitter();
    const snapshots = [
      { fileId: 'file-a', bytes: Buffer.from('old-one\nold-two\npartial', 'utf8') },
      { fileId: 'file-a', bytes: Buffer.from('old-one\nold-two\npartial-new\n', 'utf8') },
      { fileId: 'file-b', bytes: Buffer.from('rotated\n', 'utf8') },
      { fileId: 'file-b', bytes: Buffer.from('truncated\n', 'utf8') },
    ];
    let snapshotIndex = 0;
    const readLogSnapshot = vi.fn(async () => {
      const value = snapshots[snapshotIndex++];
      if (value !== undefined) return value;
      signals.emit('SIGINT');
      return snapshots.at(-1);
    });
    const runtime = createProductionCliRuntime(productionOptions(store, {
      readLogSnapshot,
      signals,
      sleep: vi.fn(async () => undefined),
    }) as never);
    const lines: string[] = [];

    for await (const line of runtime.readLogs({ lines: 1, follow: true })) lines.push(line);

    expect(lines).toEqual(['old-two', 'partial-new', 'rotated', 'truncated']);
    expect(readLogSnapshot).toHaveBeenCalledTimes(5);
    for (const call of readLogSnapshot.mock.calls) {
      expect(call).toEqual([localPaths(HOME).bridgeLog, 8 << 20]);
    }
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  });

  it('treats a missing fixed bridge log as an empty bounded tail', async () => {
    const store = identityStore();
    const readLogSnapshot = vi.fn(async () => undefined);
    const runtime = createProductionCliRuntime(productionOptions(store, { readLogSnapshot }) as never);
    const lines: string[] = [];

    for await (const line of runtime.readLogs({ lines: 100, follow: false })) lines.push(line);

    expect(lines).toEqual([]);
    expect(readLogSnapshot).toHaveBeenCalledWith(localPaths(HOME).bridgeLog, 8 << 20);
  });

  it('doctor reads only bounded strict metadata, identity, credentials, and authenticated status', async () => {
    const store = identityStore({ identity: READY_IDENTITY, contentDigest: '2'.repeat(64) });
    const paths = localPaths(HOME);
    const installSentinel = '00000000-0000-4000-8000-000000000000';
    const readJson = vi.fn(async (filePath: string) => {
      if (filePath === paths.config) return DEFAULT_CONFIG;
      if (filePath === paths.state) {
        return { schemaVersion: 1 as const, installId: installSentinel, bindings: [] };
      }
      if (filePath === paths.credentials) {
        return { schemaVersion: 1 as const, bridgeSecret: BRIDGE_SECRET, tokens: {} };
      }
      throw new Error('unexpected_metadata_path');
    });
    const transport = requestSequence([
      controlFrame({ schemaVersion: 1, identity: READY_IDENTITY, state: 'ready' }),
    ]);
    const forbiddenLogRead = vi.fn(async () => {
      throw new Error('doctor_must_not_read_log');
    });
    const runtime = createProductionCliRuntime(productionOptions(store, {
      readJson,
      request: transport.request,
      readLogSnapshot: forbiddenLogRead,
    }) as never);

    const diagnostics = await runtime.doctor();

    expect(diagnostics).toEqual({
      schemaVersion: 1,
      state: 'ready',
      service: {
        pid: READY_IDENTITY.pid,
        version: VERSION,
        startedAt: READY_IDENTITY.started_at,
        port: 43210,
        controlState: 'ready',
      },
      runtimes: [],
    });
    expect(readJson).toHaveBeenCalledWith(paths.config, expect.anything(), 1 << 20);
    expect(readJson).toHaveBeenCalledWith(paths.state, expect.anything(), 1 << 20);
    expect(readJson).toHaveBeenCalledWith(paths.credentials, expect.anything(), 4 << 20);
    expect(transport.bodies).toEqual(['{"command":"status"}']);
    expect(forbiddenLogRead).not.toHaveBeenCalled();
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain(HOME);
    expect(serialized).not.toContain(installSentinel);
    expect(serialized).not.toContain(BRIDGE_SECRET);
    expect(serialized).not.toMatch(/tokenRef|nodeId|path/i);
  });

  it('uses a pure packaged-path guard before any self-execution I/O', () => {
    const packageRoot = resolve('selfexec', 'node_modules', 'quukk-clawmessenger');
    const moduleUrl = pathToFileURL(resolve(packageRoot, 'dist', 'cli.js')).href;

    expect(packagedCliCandidate([
      EXECUTABLE, resolve('ordinary-importer.js'), 'status',
    ], moduleUrl)).toBeUndefined();
    expect(packagedCliCandidate([
      EXECUTABLE, resolve(packageRoot, 'bin', 'quukk-clawmessenger.js'), 'status', '--json',
    ], moduleUrl)).toEqual({
      invokedBinPath: resolve(packageRoot, 'bin', 'quukk-clawmessenger.js'),
      packagedBinPath: resolve(packageRoot, 'bin', 'quukk-clawmessenger.js'),
      argv: ['status', '--json'],
    });
    expect(packagedCliCandidate([
      EXECUTABLE,
      resolve(packageRoot, '..', '.bin', 'quukk-clawmessenger'),
      'doctor',
    ], moduleUrl)).toEqual(expect.objectContaining({ argv: ['doctor'] }));
    expect(packagedCliCandidate([
      EXECUTABLE, resolve(packageRoot, 'bin', 'quukk-clawmessenger.js'),
    ], pathToFileURL(resolve(packageRoot, 'src', 'cli.ts')).href)).toBeUndefined();
  });

  it('runs once only after native realpaths match and passes explicit production defaults', async () => {
    const packageRoot = resolve('selfexec-entry', 'node_modules', 'quukk-clawmessenger');
    const packagedBinPath = resolve(packageRoot, 'bin', 'quukk-clawmessenger.js');
    const invokedBinPath = resolve(packageRoot, '..', '.bin', 'quukk-clawmessenger');
    const candidate = {
      invokedBinPath,
      packagedBinPath,
      argv: ['status', '--json'],
    };
    const realpathNative = vi.fn(async (path: string) => {
      if (path === invokedBinPath || path === packagedBinPath) return packagedBinPath;
      throw new Error('unexpected_realpath');
    });
    const runtime = harness().runtime;
    const runtimeFactory = vi.fn(() => runtime);
    const browser = { open: vi.fn(async () => undefined) };
    const browserFactory = vi.fn(() => browser);
    const cliRunner = vi.fn(async () => 4);
    const setExitCode = vi.fn();
    const homeDirectory = vi.fn(() => HOME);
    const signals = new EventEmitter();
    const environment = { OPENCODE_API_KEY: 'PROVIDER-SELFEXEC-SENTINEL' };
    const io = { stdout: vi.fn(), stderr: vi.fn() };
    const dependencies = {
      realpathNative,
      homeDirectory,
      environment,
      execPath: EXECUTABLE,
      processId: READY_IDENTITY.pid,
      signals,
      platform: 'win32' as const,
      runtimeFactory,
      browserFactory,
      cliRunner,
      io,
      setExitCode,
    };

    await expect(runPackagedCliEntry(candidate, dependencies as never)).resolves.toBe(true);
    await expect(runPackagedCliEntry(candidate, dependencies as never)).resolves.toBe(false);

    expect(realpathNative).toHaveBeenCalledTimes(2);
    expect(homeDirectory).toHaveBeenCalledOnce();
    expect(runtimeFactory).toHaveBeenCalledWith({
      homeDirectory: HOME,
      processEnvironment: environment,
      execPath: EXECUTABLE,
      packagedBinPath,
      dependencies: { processId: READY_IDENTITY.pid, signals },
    });
    expect(browserFactory).toHaveBeenCalledWith({
      platform: 'win32', environment,
    });
    expect(cliRunner).toHaveBeenCalledWith(candidate.argv, {
      runtime, browser, io, environment,
    });
    expect(setExitCode).toHaveBeenCalledOnce();
    expect(setExitCode).toHaveBeenCalledWith(4);
  });
});
