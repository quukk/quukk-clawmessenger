import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ensureRuntimeExecutable, runPostinstall, shouldAutoSetup } from './postinstall.mjs';

const WINDOWS_DESKTOP = {
  platform: 'win32',
  stdoutIsTTY: true,
  stderrIsTTY: false,
  env: {
    npm_lifecycle_event: 'postinstall',
    npm_config_global: 'true',
    SESSIONNAME: 'Console',
  },
};

describe('shouldAutoSetup', () => {
  it('allows only global interactive desktop postinstall sessions', () => {
    expect(shouldAutoSetup(WINDOWS_DESKTOP)).toBe(true);
    expect(
      shouldAutoSetup({
        ...WINDOWS_DESKTOP,
        env: { ...WINDOWS_DESKTOP.env, npm_config_global: '1' },
      }),
    ).toBe(true);
    expect(
      shouldAutoSetup({
        ...WINDOWS_DESKTOP,
        env: {
          ...WINDOWS_DESKTOP.env,
          npm_config_global: undefined,
          npm_config_location: 'global',
        },
      }),
    ).toBe(true);
    expect(
      shouldAutoSetup({
        platform: 'darwin',
        stdoutIsTTY: false,
        stderrIsTTY: true,
        env: { ...WINDOWS_DESKTOP.env, SESSIONNAME: undefined },
      }),
    ).toBe(true);
    expect(
      shouldAutoSetup({
        platform: 'linux',
        stdoutIsTTY: true,
        stderrIsTTY: false,
        env: { ...WINDOWS_DESKTOP.env, SESSIONNAME: undefined, DISPLAY: ':0' },
      }),
    ).toBe(true);
    expect(
      shouldAutoSetup({
        platform: 'linux',
        stdoutIsTTY: true,
        stderrIsTTY: false,
        env: { ...WINDOWS_DESKTOP.env, SESSIONNAME: undefined, WAYLAND_DISPLAY: 'wayland-0' },
      }),
    ).toBe(true);
  });

  it('rejects local, CI, opted-out, non-TTY, wrong lifecycle, service, and headless installs', () => {
    const cases = [
      { ...WINDOWS_DESKTOP, env: { ...WINDOWS_DESKTOP.env, npm_config_global: undefined } },
      { ...WINDOWS_DESKTOP, env: { ...WINDOWS_DESKTOP.env, CI: '1' } },
      {
        ...WINDOWS_DESKTOP,
        env: { ...WINDOWS_DESKTOP.env, QUUKK_CLAWMESSENGER_NO_OPEN: '1' },
      },
      { ...WINDOWS_DESKTOP, stdoutIsTTY: false, stderrIsTTY: false },
      {
        ...WINDOWS_DESKTOP,
        env: { ...WINDOWS_DESKTOP.env, npm_lifecycle_event: 'prepare' },
      },
      { ...WINDOWS_DESKTOP, env: { ...WINDOWS_DESKTOP.env, SESSIONNAME: 'Services' } },
      {
        platform: 'linux',
        stdoutIsTTY: true,
        stderrIsTTY: false,
        env: { ...WINDOWS_DESKTOP.env, SESSIONNAME: undefined },
      },
      { ...WINDOWS_DESKTOP, platform: 'freebsd' },
    ];

    for (const input of cases) expect(shouldAutoSetup(input)).toBe(false);
  });

  it('treats explicit false-like CI values as non-CI', () => {
    for (const value of ['', '0', 'false', 'no', 'off']) {
      expect(
        shouldAutoSetup({
          ...WINDOWS_DESKTOP,
          env: { ...WINDOWS_DESKTOP.env, CI: value },
        }),
      ).toBe(true);
    }
  });

  it('keeps install gates exact while trimming only desktop and display markers', () => {
    expect(
      shouldAutoSetup({
        ...WINDOWS_DESKTOP,
        env: {
          ...WINDOWS_DESKTOP.env,
          npm_lifecycle_event: ' postinstall ',
          npm_config_global: ' true ',
          SESSIONNAME: ' Console ',
        },
      }),
    ).toBe(false);
    expect(
      shouldAutoSetup({
        ...WINDOWS_DESKTOP,
        env: {
          ...WINDOWS_DESKTOP.env,
          npm_config_global: undefined,
          npm_config_location: ' global ',
        },
      }),
    ).toBe(false);
    expect(
      shouldAutoSetup({
        ...WINDOWS_DESKTOP,
        env: { ...WINDOWS_DESKTOP.env, QUUKK_CLAWMESSENGER_NO_OPEN: ' 1 ' },
      }),
    ).toBe(true);
    expect(
      shouldAutoSetup({
        ...WINDOWS_DESKTOP,
        env: { ...WINDOWS_DESKTOP.env, SESSIONNAME: ' sErViCeS ' },
      }),
    ).toBe(false);
    expect(
      shouldAutoSetup({
        platform: 'linux',
        stdoutIsTTY: true,
        stderrIsTTY: false,
        env: {
          ...WINDOWS_DESKTOP.env,
          SESSIONNAME: undefined,
          DISPLAY: ' \t ',
          WAYLAND_DISPLAY: '\n ',
        },
      }),
    ).toBe(false);
  });
});

describe('runPostinstall', () => {
  it('spawns only Node plus the absolute packaged bin and setup with a minimal environment', () => {
    const onError = vi.fn();
    const unref = vi.fn();
    const child = {
      once: vi.fn((event: string, listener: () => void) => {
        if (event === 'error') onError.mockImplementation(listener);
        return child;
      }),
      unref,
    };
    const spawn = vi.fn(() => child);
    const writeLine = vi.fn();
    const binPath = fileURLToPath(new URL('../bin/quukk-clawmessenger.js', import.meta.url));
    const execPath = process.execPath;
    const env = {
      ...WINDOWS_DESKTOP.env,
      SystemRoot: 'C:\\Windows',
      PATH: 'C:\\Windows\\System32',
      PATHEXT: '.EXE;.CMD',
      TEMP: 'D:\\temp',
      TMP: 'D:\\temp',
      USERPROFILE: 'D:\\Users\\tester',
      APPDATA: 'D:\\Users\\tester\\AppData\\Roaming',
      LOCALAPPDATA: 'D:\\Users\\tester\\AppData\\Local',
      npm_config_auth: 'NPM_AUTH_SENTINEL',
      npm_token: 'NPM_TOKEN_SENTINEL',
      NODE_OPTIONS: '--require NODE_OPTIONS_SENTINEL',
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
      QUUKK_SECRET: 'QUUKK_SECRET_SENTINEL',
      AUTHORIZATION: 'AUTHORIZATION_SENTINEL',
    };

    expect(
      runPostinstall({
        env,
        platform: 'win32',
        stdoutIsTTY: true,
        stderrIsTTY: false,
        execPath,
        binPath,
        spawn,
        writeLine,
      }),
    ).toBe(true);

    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledWith(execPath, [binPath, 'setup'], {
      shell: false,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        SystemRoot: 'C:\\Windows',
        PATH: 'C:\\Windows\\System32',
        PATHEXT: '.EXE;.CMD',
        TEMP: 'D:\\temp',
        TMP: 'D:\\temp',
        USERPROFILE: 'D:\\Users\\tester',
        APPDATA: 'D:\\Users\\tester\\AppData\\Roaming',
        LOCALAPPDATA: 'D:\\Users\\tester\\AppData\\Local',
        SESSIONNAME: 'Console',
      },
    });
    expect(child.once).toHaveBeenCalledWith('error', expect.any(Function));
    expect(unref).toHaveBeenCalledOnce();
    expect(writeLine).not.toHaveBeenCalled();
  });

  it('prints one setup hint and does not spawn when a gate is false', () => {
    const spawn = vi.fn();
    const writeLine = vi.fn();

    expect(
      runPostinstall({
        ...WINDOWS_DESKTOP,
        env: { ...WINDOWS_DESKTOP.env, npm_config_global: undefined },
        spawn,
        writeLine,
      }),
    ).toBe(false);

    expect(spawn).not.toHaveBeenCalled();
    expect(writeLine).toHaveBeenCalledOnce();
    expect(writeLine.mock.calls[0]?.[0]).toContain('quukk-clawmessenger setup');
  });

  it('never spawns and prints exactly one hint for padded service or headless markers', () => {
    const inputs = [
      {
        ...WINDOWS_DESKTOP,
        env: { ...WINDOWS_DESKTOP.env, SESSIONNAME: ' SeRvIcEs ' },
      },
      {
        platform: 'linux',
        stdoutIsTTY: true,
        stderrIsTTY: false,
        env: {
          ...WINDOWS_DESKTOP.env,
          SESSIONNAME: undefined,
          DISPLAY: '   ',
          WAYLAND_DISPLAY: '\t',
        },
      },
    ];

    for (const input of inputs) {
      const spawn = vi.fn();
      const writeLine = vi.fn();
      expect(runPostinstall({ ...input, spawn, writeLine })).toBe(false);
      expect(spawn).not.toHaveBeenCalled();
      expect(writeLine).toHaveBeenCalledOnce();
      expect(writeLine.mock.calls[0]?.[0]).toContain('quukk-clawmessenger setup');
    }
  });

  it('contains synchronous spawn errors and asynchronous child errors', () => {
    const syncHint = vi.fn();
    expect(() =>
      runPostinstall({
        ...WINDOWS_DESKTOP,
        spawn: () => {
          throw new Error('SPAWN_THROW_SENTINEL');
        },
        writeLine: syncHint,
      }),
    ).not.toThrow();
    expect(syncHint).toHaveBeenCalledOnce();

    let errorListener: (() => void) | undefined;
    const asyncHint = vi.fn();
    runPostinstall({
      ...WINDOWS_DESKTOP,
      spawn: () => ({
        once: (_event: string, listener: () => void) => {
          errorListener = listener;
        },
        unref: () => undefined,
      }),
      writeLine: asyncHint,
    });
    expect(() => errorListener?.()).not.toThrow();
    expect(asyncHint).toHaveBeenCalledOnce();
  });

  it('has no top-level side effect when imported by a test or another module', () => {
    const scriptPath = fileURLToPath(new URL('./postinstall.mjs', import.meta.url));
    const source = `await import(${JSON.stringify(pathToFileURL(scriptPath).href)}); process.stdout.write('IMPORTED\\n');`;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
      encoding: 'utf8',
      env: {
        ...process.env,
        npm_lifecycle_event: 'postinstall',
        npm_config_global: 'true',
        DISPLAY: ':0',
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('IMPORTED\n');
    expect(result.stderr).toBe('');
  });
});

describe('ensureRuntimeExecutable', () => {
  const runtimeRoot = '/opt/quukk/node_modules/@quukk/clawmessenger-runtime-linux-x64';
  const manifest = JSON.stringify({
    binary: 'clawmessenger-runtime',
    version: '0.1.0-beta.24',
  });

  const makeDeps = (overrides: Record<string, unknown> = {}) => ({
    platform: 'linux',
    arch: 'x64',
    packageRoot: runtimeRoot,
    readFile: vi.fn().mockResolvedValue(manifest),
    access: vi.fn().mockRejectedValue(new Error('EACCES: permission denied')),
    chmod: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  });

  it('restores the executable bit when the runtime binary lacks it', async () => {
    const deps = makeDeps();
    const repaired = await ensureRuntimeExecutable(deps);

    expect(repaired).toBe(true);
    expect(deps.access).toHaveBeenCalledTimes(1);
    expect(deps.chmod).toHaveBeenCalledTimes(1);
    expect(deps.chmod).toHaveBeenCalledWith(join(runtimeRoot, 'clawmessenger-runtime'), 0o755);
  });

  it('leaves an already executable binary untouched', async () => {
    const deps = makeDeps({ access: vi.fn().mockResolvedValue(undefined) });
    const repaired = await ensureRuntimeExecutable(deps);

    expect(repaired).toBe(false);
    expect(deps.chmod).not.toHaveBeenCalled();
  });

  it('uses the binary name recorded in the runtime manifest', async () => {
    const deps = makeDeps({
      readFile: vi.fn().mockResolvedValue(JSON.stringify({ binary: 'clawmessenger-runtime-v2' })),
    });
    const repaired = await ensureRuntimeExecutable(deps);

    expect(repaired).toBe(true);
    expect(deps.chmod).toHaveBeenCalledWith(join(runtimeRoot, 'clawmessenger-runtime-v2'), 0o755);
  });

  it('does nothing on win32 where executables do not need a chmod repair', async () => {
    const deps = makeDeps({ platform: 'win32' });
    const repaired = await ensureRuntimeExecutable(deps);

    expect(repaired).toBe(false);
    expect(deps.readFile).not.toHaveBeenCalled();
    expect(deps.access).not.toHaveBeenCalled();
    expect(deps.chmod).not.toHaveBeenCalled();
  });

  it('stays silent when the platform runtime package is not installed', async () => {
    const deps = makeDeps({ readFile: vi.fn().mockRejectedValue(new Error('ENOENT')) });
    const repaired = await ensureRuntimeExecutable(deps);

    expect(repaired).toBe(false);
    expect(deps.access).not.toHaveBeenCalled();
    expect(deps.chmod).not.toHaveBeenCalled();
  });

  it('never fails the install when the permission repair itself errors', async () => {
    const deps = makeDeps({ chmod: vi.fn().mockRejectedValue(new Error('EPERM')) });
    const repaired = await ensureRuntimeExecutable(deps);

    expect(repaired).toBe(false);
  });
});

describe('package install contract', () => {
  it('ships only the production lifecycle and publish-audit scripts', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { files?: string[]; scripts?: Record<string, string> };

    expect(packageJson.scripts?.postinstall).toBe('node scripts/postinstall.mjs');
    expect(packageJson.files).toContain('scripts/postinstall.mjs');
    expect(packageJson.files).not.toContain('scripts/postinstall.test.ts');
    expect(packageJson.files?.filter((file) => file.startsWith('scripts/'))).toEqual([
      'scripts/audit-tarball.mjs',
      'scripts/postinstall.mjs',
    ]);
  });
});
