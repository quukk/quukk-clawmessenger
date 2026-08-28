import { execFile } from 'node:child_process';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(SCRIPT_DIRECTORY, '..');
const LEGAL_FILENAME = /^(?:LICENSE|LICENCE|COPYING|NOTICE|PATENTS|COPYRIGHT)(?:[._-].*)?$/i;
const GO_VERSION = /^go1\.[1-9]\d*(?:\.(?:0|[1-9]\d*))?(?:(?:beta|rc)[1-9]\d*)?$/;
const MODULE = /^[^\s@]+@v[^\s@]+$/;
const MAX_OUTPUT = 4 * 1024 * 1024;

/**
 * @typedef {(file: string, args: readonly string[], options: {
 *   cwd: string,
 *   env: NodeJS.ProcessEnv,
 *   shell: false,
 * }) => Promise<{stdout: string, stderr: string}>} NoticeCommandExecutor
 */

/** @type {NoticeCommandExecutor} */
async function executeCommand(file, args, options) {
  return await new Promise((resolvePromise, reject) => {
    execFile(file, [...args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      encoding: 'utf8',
      maxBuffer: MAX_OUTPUT,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${file} ${args.join(' ')} failed`));
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

/** @param {string} value */
function normalizeText(value) {
  return value.replace(/\r\n?/g, '\n').trimEnd();
}

/** @param {string} name @param {string} content */
function legalBlock(name, content) {
  return `#### ${name}\n\n\`\`\`text\n${normalizeText(content)}\n\`\`\``;
}

/** @param {string} path @param {string} label */
async function regularFile(path, label) {
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink()) throw new Error(`${label} is unavailable`);
  return await readFile(path, 'utf8');
}

/** @param {string} goSum */
function checksums(goSum) {
  const result = new Map();
  for (const line of goSum.split(/\r?\n/)) {
    const match = /^(\S+)\s+(v\S+)\s+(h1:\S+)$/.exec(line);
    if (match && !match[2].endsWith('/go.mod')) {
      result.set(`${match[1]}@${match[2]}`, match[3]);
    }
  }
  return result;
}

/** @param {string} notice */
function noticeInventory(notice) {
  const section = /^## Included modules\n\n([\s\S]*?)\n\n## /m.exec(notice);
  if (!section) throw new Error('Go third-party notice module inventory is invalid');
  const entries = section[1].split('\n').map((line) => {
    const match = /^- `([^`]+)` — `(h1:[^`\s]+)`$/.exec(line);
    if (!match || !MODULE.test(match[1])) {
      throw new Error('Go third-party notice module inventory is invalid');
    }
    return { module: match[1], checksum: match[2] };
  });
  if (
    entries.length === 0
    || entries.length > 256
    || new Set(entries.map((entry) => entry.module)).size !== entries.length
  ) throw new Error('Go third-party notice module inventory is invalid');
  return entries;
}

/** @param {string} output @param {string} module */
function downloadedModule(output, module) {
  let value;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error(`Go module metadata is invalid: ${module}`);
  }
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || value.Error !== undefined
    || typeof value.Path !== 'string'
    || typeof value.Version !== 'string'
    || typeof value.Sum !== 'string'
    || typeof value.Dir !== 'string'
    || !isAbsolute(value.Dir)
    || `${value.Path}@${value.Version}` !== module
  ) {
    throw new Error(`Go module metadata is invalid: ${module}`);
  }
  return value;
}

/**
 * Verifies a runtime package notice against server/go.sum, the active Go
 * toolchain, and each linked module's checksum-verified source directory.
 *
 * @param {string} requestedPackage
 * @param {{repoRoot?: string, execute?: NoticeCommandExecutor, env?: NodeJS.ProcessEnv}} [options]
 */
export async function verifyGoThirdPartyNotices(requestedPackage, options = {}) {
  const root = await realpath(resolve(options.repoRoot ?? DEFAULT_REPO_ROOT));
  const packageDirectory = await realpath(resolve(requestedPackage));
  const serverDirectory = join(root, 'server');
  const manifestText = await regularFile(join(packageDirectory, 'manifest.json'), 'runtime manifest');
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    throw new Error('runtime manifest is invalid');
  }
  if (
    manifest === null
    || typeof manifest !== 'object'
    || Array.isArray(manifest)
    || typeof manifest.goVersion !== 'string'
    || !GO_VERSION.test(manifest.goVersion)
    || !Array.isArray(manifest.modules)
    || manifest.modules.length === 0
    || manifest.modules.length > 256
    || manifest.modules.some((module) => typeof module !== 'string' || !MODULE.test(module))
    || new Set(manifest.modules).size !== manifest.modules.length
  ) throw new Error('runtime manifest is invalid');

  const rootNotice = await regularFile(
    join(root, 'GO_THIRD_PARTY_NOTICES.md'),
    'repository Go third-party notice',
  );
  const packageNotice = await regularFile(
    join(packageDirectory, 'GO_THIRD_PARTY_NOTICES.md'),
    'packaged Go third-party notice',
  );
  if (rootNotice !== packageNotice) throw new Error('packaged Go third-party notice differs from repository root');
  const notice = normalizeText(packageNotice);
  const goSum = checksums(await regularFile(join(serverDirectory, 'go.sum'), 'server/go.sum'));
  const inventory = noticeInventory(notice);
  const inventoryModules = new Set(inventory.map((entry) => entry.module));
  if (manifest.modules.some((module) => !inventoryModules.has(module))) {
    throw new Error('runtime module is absent from the Go third-party notice inventory');
  }
  const execute = options.execute ?? executeCommand;
  const commandOptions = {
    cwd: serverDirectory,
    env: options.env ?? process.env,
    shell: /** @type {const} */ (false),
  };

  const version = normalizeText((await execute('go', ['env', 'GOVERSION'], commandOptions)).stdout);
  if (version !== manifest.goVersion) throw new Error('notice Go version differs from the active toolchain');
  const goRootOutput = normalizeText((await execute('go', ['env', 'GOROOT'], commandOptions)).stdout);
  if (!isAbsolute(goRootOutput)) throw new Error('active Go root is invalid');
  const goRoot = await realpath(goRootOutput);
  for (const name of ['LICENSE', 'PATENTS']) {
    const content = await regularFile(join(goRoot, name), `Go ${name}`);
    if (!notice.includes(legalBlock(name, content))) {
      throw new Error(`Go ${name} text is missing from third-party notices`);
    }
  }

  let legalFileCount = 2;
  for (const entry of inventory) {
    const { module } = entry;
    const checksum = goSum.get(module);
    if (!checksum || checksum !== entry.checksum) {
      throw new Error(`notice checksum differs from server/go.sum: ${module}`);
    }
    const metadata = downloadedModule(
      (await execute('go', ['mod', 'download', '-json', module], commandOptions)).stdout,
      module,
    );
    if (metadata.Sum !== checksum) throw new Error(`downloaded module checksum differs from server/go.sum: ${module}`);
    const moduleDirectory = await realpath(metadata.Dir);
    const legalFiles = (await readdir(moduleDirectory))
      .filter((name) => LEGAL_FILENAME.test(name))
      .sort();
    if (legalFiles.length === 0) throw new Error(`module has no top-level legal files: ${module}`);
    for (const name of legalFiles) {
      const content = await regularFile(join(moduleDirectory, name), 'module legal file');
      if (!notice.includes(legalBlock(name, content))) {
        throw new Error(`module legal text is missing from third-party notices: ${module}/${name}`);
      }
      legalFileCount += 1;
    }
  }

  return { goVersion: manifest.goVersion, moduleCount: inventory.length, legalFileCount };
}

async function main() {
  if (process.argv.length !== 3) {
    throw new Error('usage: node scripts/verify-go-third-party-notices.mjs <runtime-package-directory>');
  }
  const result = await verifyGoThirdPartyNotices(process.argv[2]);
  console.log(
    `verified Go third-party notices (${result.goVersion}, ${result.moduleCount} modules, ${result.legalFileCount} legal files)`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`[go-notices] ${error instanceof Error ? error.message : 'verification failed'}`);
    process.exitCode = 1;
  });
}
