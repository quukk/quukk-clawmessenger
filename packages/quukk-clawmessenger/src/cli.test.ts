import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createSystemBrowserPort,
  runCli,
  type CliRuntimePort,
} from './cli.js';
import { VERSION } from './version.js';

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
    const ticket = 'T'.repeat(43);
    test.runtime.control.mockResolvedValue({
      command: 'launch_ticket',
      value: { ticket, expiresAt: Date.now() + 30_000 },
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
    { ticket: 'x'.repeat(42), expiresAt: Date.now() + 30_000 },
    { ticket: 'x'.repeat(43), expiresAt: Date.now() - 1 },
  ])('rejects malformed or expired launch-ticket responses without opening a browser', async (value) => {
    const test = harness();
    test.runtime.control.mockResolvedValue({ command: 'launch_ticket', value });

    const exitCode = await runCli(['setup'], test.options);

    expect(exitCode).toBe(5);
    expect(test.stderr).toEqual(['quukk-clawmessenger: operation_unavailable']);
    expect(test.browser.open).not.toHaveBeenCalled();
  });

  it('rejects non-exact launch-ticket response objects without exposing extra fields', async () => {
    const test = harness();
    const secretSentinel = 'SECRET-LAUNCH-RESPONSE';
    test.runtime.control.mockResolvedValue({
      command: 'launch_ticket',
      value: {
        ticket: 'x'.repeat(43),
        expiresAt: Date.now() + 30_000,
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
    const ticket = 'B'.repeat(43);
    const secretSentinel = 'SECRET-SENTINEL-FROM-BROWSER';
    test.runtime.control.mockResolvedValue({
      command: 'launch_ticket',
      value: { ticket, expiresAt: Date.now() + 30_000 },
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
    const ticket = 'F'.repeat(43);
    test.runtime.control.mockImplementation(async () => {
      calls.push('ticket');
      return { command: 'launch_ticket', value: { ticket, expiresAt: Date.now() + 30_000 } };
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
    { inspection: { kind: 'starting' as const, identity: STARTING_IDENTITY }, expectedExit: 5, code: 'operation_unavailable' },
    { inspection: { kind: 'corrupt' as const, errorCode: 'identity_corrupt' as const }, expectedExit: 4, code: 'unsafe_identity' },
  ])('classifies $inspection.kind identity without using process APIs', async ({ inspection, expectedExit, code }) => {
    const test = harness();
    test.runtime.inspect.mockResolvedValue(inspection);

    const exitCode = await runCli(['status'], test.options);

    expect(exitCode).toBe(expectedExit);
    expect(test.stderr).toEqual([`quukk-clawmessenger: ${code}`]);
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
    { runtimeCode: 'operation_timeout', expectedExit: 5, outputCode: 'operation_timeout' },
    { runtimeCode: 'bridge_unavailable', expectedExit: 5, outputCode: 'operation_unavailable' },
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
    if (runtimeCode !== outputCode) {
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
  const url = `http://127.0.0.1:43210/setup#ticket=${'Z'.repeat(43)}`;
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

  it.each([
    `https://127.0.0.1:43210/#ticket=${'x'.repeat(43)}`,
    `http://localhost:43210/#ticket=${'x'.repeat(43)}`,
    `http://127.0.0.2:43210/#ticket=${'x'.repeat(43)}`,
    `http://127.0.0.1/#ticket=${'x'.repeat(43)}`,
    `http://127.0.0.1:0/#ticket=${'x'.repeat(43)}`,
    `http://127.0.0.1:43210/setup/#ticket=${'x'.repeat(43)}`,
    `http://127.0.0.1:43210/other#ticket=${'x'.repeat(43)}`,
    `http://127.0.0.1:43210/?query=1#ticket=${'x'.repeat(43)}`,
    `http://user@127.0.0.1:43210/#ticket=${'x'.repeat(43)}`,
    'http://127.0.0.1:43210/',
    `http://127.0.0.1:43210/#ticket=${'x'.repeat(42)}`,
    `http://127.0.0.1:43210/#ticket=${'x'.repeat(43)}&extra=1`,
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
