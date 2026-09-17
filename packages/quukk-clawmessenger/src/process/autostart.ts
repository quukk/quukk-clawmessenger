import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, posix, win32 } from 'node:path';

export const AUTOSTART_ID = 'quukk-clawmessenger-bridge';
const START_ARGS = ['start', '--no-open'] as const;

export interface AutostartOptions {
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  /** Windows %APPDATA%. */
  appDataDirectory?: string;
  /** Linux XDG_CONFIG_HOME. */
  configHome?: string;
  /** Absolute path to the node executable that runs the CLI. */
  execPath: string;
  /** Absolute path to the CLI entry script (process.argv[1]). */
  scriptPath: string;
  /** Extra delay before starting, in seconds (Windows only). */
  delaySeconds?: number;
}

function platformOf(options: AutostartOptions): NodeJS.Platform {
  return options.platform ?? process.platform;
}

function homeOf(options: AutostartOptions): string {
  return options.homeDirectory ?? homedir();
}

function appDataOf(options: AutostartOptions): string {
  return options.appDataDirectory ?? process.env.APPDATA ?? win32.join(homeOf(options), 'AppData', 'Roaming');
}

function configHomeOf(options: AutostartOptions): string {
  return options.configHome ?? process.env.XDG_CONFIG_HOME ?? posix.join(homeOf(options), '.config');
}

/** Absolute path of the per-user autostart entry for the current platform. */
export function autostartEntryPath(options: AutostartOptions): string {
  const platform = platformOf(options);
  if (platform === 'win32') {
    return win32.join(
      appDataOf(options),
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      'Startup',
      `${AUTOSTART_ID}.cmd`,
    );
  }
  if (platform === 'darwin') {
    return posix.join(homeOf(options), 'Library', 'LaunchAgents', `com.${AUTOSTART_ID}.plist`);
  }
  return posix.join(configHomeOf(options), 'autostart', `${AUTOSTART_ID}.desktop`);
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}

function delayOf(options: AutostartOptions): number {
  const value = options.delaySeconds ?? 15;
  return Number.isInteger(value) && value >= 0 && value <= 300 ? value : 15;
}

/** Deterministic entry content; identical content is never rewritten. */
export function autostartEntryContent(options: AutostartOptions): string {
  const platform = platformOf(options);
  const command = [options.execPath, options.scriptPath, ...START_ARGS];
  if (platform === 'win32') {
    const delay = delayOf(options);
    const lines = [
      '@echo off',
      'rem Auto-start the Quukk ClawMessenger bridge at user logon.',
      `ping -n ${delay + 1} 127.0.0.1 >nul`,
      `${quote(options.execPath)} ${quote(options.scriptPath)} ${START_ARGS.join(' ')}`,
      '',
    ];
    return lines.join('\r\n');
  }
  if (platform === 'darwin') {
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      '  <key>Label</key>',
      `  <string>com.${AUTOSTART_ID}</string>`,
      '  <key>RunAtLoad</key>',
      '  <true/>',
      '  <key>ProgramArguments</key>',
      '  <array>',
      ...command.map((part) => `    <string>${part.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</string>`),
      '  </array>',
      '</dict>',
      '</plist>',
      '',
    ].join('\n');
  }
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Quukk ClawMessenger Bridge',
    'Comment=Auto-start the Quukk ClawMessenger bridge at logon',
    `Exec=${command.map((part) => (/[\s"]/.test(part) ? quote(part) : part)).join(' ')}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

/** Install (or refresh) the autostart entry. Returns the entry path. */
export async function installAutostart(options: AutostartOptions): Promise<string> {
  const path = autostartEntryPath(options);
  const content = autostartEntryContent(options);
  const existing = await readFile(path, 'utf8').catch(() => undefined);
  if (existing === content) return path;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { encoding: 'utf8', mode: 0o600 });
  return path;
}

/** Remove the autostart entry; returns true when a file was removed. */
export async function removeAutostart(options: AutostartOptions): Promise<boolean> {
  const path = autostartEntryPath(options);
  try {
    await rm(path, { force: false });
    return true;
  } catch {
    return false;
  }
}

export async function isAutostartInstalled(options: AutostartOptions): Promise<boolean> {
  const path = autostartEntryPath(options);
  const existing = await readFile(path, 'utf8').catch(() => undefined);
  return existing !== undefined;
}
