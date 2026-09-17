import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AUTOSTART_ID,
  autostartEntryContent,
  autostartEntryPath,
  installAutostart,
  isAutostartInstalled,
  removeAutostart,
} from './autostart.js';

const EXEC = 'C:\\nodejs\\node.exe';
const SCRIPT = 'C:\\nodejs\\node_modules\\quukk-clawmessenger\\bin\\quukk-clawmessenger.js';

const temporaryHomes: string[] = [];

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'quukk-autostart-'));
  temporaryHomes.push(home);
  return home;
}

afterEach(async () => {
  await Promise.all(
    temporaryHomes.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function options(home: string, platform: NodeJS.Platform = 'win32') {
  return {
    platform,
    homeDirectory: home,
    appDataDirectory: win32.join(home, 'AppData', 'Roaming'),
    configHome: posix.join(home, '.config'),
    execPath: EXEC,
    scriptPath: SCRIPT,
  };
}

describe('autostart', () => {
  it('resolves the per-user entry path per platform', () => {
    const home = 'C:\\Users\\alice';
    expect(autostartEntryPath(options(home, 'win32'))).toContain(win32.join('Startup', `${AUTOSTART_ID}.cmd`));
    expect(autostartEntryPath(options('/home/alice', 'darwin'))).toBe(
      '/home/alice/Library/LaunchAgents/com.quukk-clawmessenger-bridge.plist',
    );
    expect(autostartEntryPath(options('/home/alice', 'linux'))).toBe(
      '/home/alice/.config/autostart/quukk-clawmessenger-bridge.desktop',
    );
  });

  it('runs the CLI with start --no-open and quotes both paths', () => {
    const content = autostartEntryContent(options('C:\\Users\\alice', 'win32'));
    expect(content).toContain(`"${EXEC}" "${SCRIPT}" start --no-open`);
    expect(content).toContain('ping -n 16 127.0.0.1 >nul');
  });

  it('installs, reports, is idempotent, and removes the entry', async () => {
    const home = await temporaryHome();
    const entry = options(home, 'win32');

    expect(await isAutostartInstalled(entry)).toBe(false);
    const path = await installAutostart(entry);
    expect(await isAutostartInstalled(entry)).toBe(true);

    const first = await readFile(path, 'utf8');
    const firstStat = await stat(path);
    await installAutostart(entry);
    const second = await readFile(path, 'utf8');
    expect(second).toBe(first);
    expect((await stat(path)).mtimeMs).toBe(firstStat.mtimeMs);

    expect(await removeAutostart(entry)).toBe(true);
    expect(await isAutostartInstalled(entry)).toBe(false);
    expect(await removeAutostart(entry)).toBe(false);
  });

  it('writes a RunAtLoad LaunchAgent on macOS', async () => {
    const home = await temporaryHome();
    const path = await installAutostart(options(home, 'darwin'));
    const content = await readFile(path, 'utf8');
    expect(content).toContain('<key>RunAtLoad</key>');
    expect(content).toContain(`<string>${EXEC}</string>`);
    expect(content).toContain('<string>start</string>');
    expect(content).toContain('<string>--no-open</string>');
  });

  it('writes an XDG desktop entry on Linux', async () => {
    const home = await temporaryHome();
    const path = await installAutostart(options(home, 'linux'));
    const content = await readFile(path, 'utf8');
    expect(content).toContain('[Desktop Entry]');
    expect(content).toContain('start --no-open');
  });
});
