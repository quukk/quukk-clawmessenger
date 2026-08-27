import { spawn as nodeSpawn } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HINT = 'Run quukk-clawmessenger setup to finish setup.';
const PACKAGED_BIN = fileURLToPath(new URL('../bin/quukk-clawmessenger.js', import.meta.url));
const SAFE_ENVIRONMENT_KEYS = new Set([
  'APPDATA',
  'COMSPEC',
  'DBUS_SESSION_BUS_ADDRESS',
  'DISPLAY',
  'HOMEDRIVE',
  'HOMEPATH',
  'HOME',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LOCALAPPDATA',
  'PATH',
  'PATHEXT',
  'SESSIONNAME',
  'SHELL',
  'SYSTEMROOT',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'USER',
  'USERPROFILE',
  'WAYLAND_DISPLAY',
  'WINDIR',
  'XDG_CONFIG_HOME',
  'XDG_RUNTIME_DIR',
]);

function hasText(value) {
  return typeof value === 'string' && value.length > 0;
}

function isTruthyEnvironmentValue(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== '' && !['0', 'false', 'no', 'off'].includes(normalized);
}

export function shouldAutoSetup(input) {
  try {
    if (input === null || typeof input !== 'object') return false;
    const env = input.env;
    if (env === null || typeof env !== 'object') return false;
    if (env.npm_lifecycle_event !== 'postinstall') return false;
    if (
      env.npm_config_global !== 'true' &&
      env.npm_config_global !== '1' &&
      env.npm_config_location !== 'global'
    ) {
      return false;
    }
    if (input.stdoutIsTTY !== true && input.stderrIsTTY !== true) return false;
    if (isTruthyEnvironmentValue(env.CI)) return false;
    if (env.QUUKK_CLAWMESSENGER_NO_OPEN === '1') return false;

    if (input.platform === 'win32') {
      return typeof env.SESSIONNAME !== 'string' || env.SESSIONNAME.toLowerCase() !== 'services';
    }
    if (input.platform === 'darwin') return true;
    if (input.platform === 'linux') {
      return hasText(env.DISPLAY) || hasText(env.WAYLAND_DISPLAY);
    }
    return false;
  } catch {
    return false;
  }
}

function minimalEnvironment(environment) {
  const result = {};
  for (const [key, value] of Object.entries(environment)) {
    if (typeof value !== 'string') continue;
    const normalized = key.toUpperCase();
    if (!SAFE_ENVIRONMENT_KEYS.has(normalized)) continue;
    if (
      normalized.startsWith('NPM_') ||
      normalized.includes('AUTH') ||
      normalized === 'NODE_OPTIONS' ||
      normalized.startsWith('NODE_TLS') ||
      normalized.startsWith('QUUKK_')
    ) {
      continue;
    }
    result[key] = value;
  }
  return result;
}

export function runPostinstall(deps = {}) {
  let hinted = false;
  const hint = () => {
    if (hinted) return;
    hinted = true;
    try {
      const writeLine = typeof deps.writeLine === 'function' ? deps.writeLine : console.log;
      writeLine(HINT);
    } catch {
      // npm installation must not fail because the hint stream is unavailable.
    }
  };

  try {
    const env = deps.env ?? process.env;
    const platform = deps.platform ?? process.platform;
    const input = {
      env,
      platform,
      stdoutIsTTY: deps.stdoutIsTTY ?? process.stdout.isTTY === true,
      stderrIsTTY: deps.stderrIsTTY ?? process.stderr.isTTY === true,
    };
    if (!shouldAutoSetup(input)) {
      hint();
      return false;
    }

    const execPath = deps.execPath ?? process.execPath;
    const binPath = deps.binPath ?? PACKAGED_BIN;
    if (!isAbsolute(execPath) || !isAbsolute(binPath)) throw new Error('invalid_spawn_path');
    const spawn = deps.spawn ?? nodeSpawn;
    const child = spawn(execPath, [binPath, 'setup'], {
      shell: false,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: minimalEnvironment(env),
    });
    if (child === null || typeof child !== 'object') throw new Error('invalid_child');
    if (typeof child.once !== 'function' || typeof child.unref !== 'function') {
      throw new Error('invalid_child');
    }
    child.once('error', hint);
    child.unref();
    return true;
  } catch {
    hint();
    return false;
  }
}

function isDirectExecution() {
  try {
    if (typeof process.argv[1] !== 'string') return false;
    const candidate = pathToFileURL(resolve(process.argv[1])).href;
    return process.platform === 'win32'
      ? candidate.toLowerCase() === import.meta.url.toLowerCase()
      : candidate === import.meta.url;
  } catch {
    return false;
  }
}

try {
  if (isDirectExecution()) runPostinstall();
} catch {
  try {
    console.log(HINT);
  } catch {
    // A postinstall script must always leave npm in control of the exit code.
  }
}
