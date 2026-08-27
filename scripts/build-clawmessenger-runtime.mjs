#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(SCRIPT_DIRECTORY, '..');
const FULL_GIT_OID = /^[0-9a-f]{40}$/;
const GO_VERSION = /^go1\.[1-9]\d*(?:\.(?:0|[1-9]\d*))?(?:(?:beta|rc)[1-9]\d*)?$/;
const PACKAGE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const USAGE =
  'usage: node scripts/build-clawmessenger-runtime.mjs --platform <win32|darwin|linux> --arch <x64|arm64>';

const TARGETS = new Map(
  [
    ['win32', 'x64', 'windows', 'amd64', 'multica.exe'],
    ['win32', 'arm64', 'windows', 'arm64', 'multica.exe'],
    ['darwin', 'x64', 'darwin', 'amd64', 'multica'],
    ['darwin', 'arm64', 'darwin', 'arm64', 'multica'],
    ['linux', 'x64', 'linux', 'amd64', 'multica'],
    ['linux', 'arm64', 'linux', 'arm64', 'multica'],
  ].map(([platform, arch, goos, goarch, binary]) => {
    const directory = `quukk-clawmessenger-runtime-${platform}-${arch}`;
    return [
      `${platform}/${arch}`,
      Object.freeze({
        platform,
        arch,
        goos,
        goarch,
        binary,
        directory,
        packageName: `@quukk/clawmessenger-runtime-${platform}-${arch}`,
      }),
    ];
  }),
);

/** @typedef {(file: string, args: readonly string[], options: {cwd: string, env: NodeJS.ProcessEnv, shell: false}) => Promise<{stdout: string, stderr: string}>} RuntimeCommandExecutor */

/**
 * @param {string} platform
 * @param {string} arch
 */
export function runtimeTarget(platform, arch) {
  const target = TARGETS.get(`${platform}/${arch}`);
  if (!target) throw new Error(`unsupported runtime target: ${platform}/${arch}`);
  return target;
}

/** @param {string[]} argv */
export function parseBuildArguments(argv) {
  if (argv.length !== 4) throw new Error(USAGE);
  /** @type {Record<string, string>} */
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if ((flag !== '--platform' && flag !== '--arch') || !value || parsed[flag]) {
      throw new Error(USAGE);
    }
    parsed[flag] = value;
  }
  if (!parsed['--platform'] || !parsed['--arch']) throw new Error(USAGE);
  runtimeTarget(parsed['--platform'], parsed['--arch']);
  return { platform: parsed['--platform'], arch: parsed['--arch'] };
}

/** @param {string} value */
export function isRecognizedGoVersion(value) {
  return GO_VERSION.test(value);
}

/** @param {string} value */
export function isSafePackageVersion(value) {
  return PACKAGE_VERSION.test(value);
}

/** @type {RuntimeCommandExecutor} */
async function executeCommand(file, args, options) {
  return await new Promise((resolvePromise, reject) => {
    execFile(
      file,
      [...args],
      {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: 1 << 20,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePromise({ stdout, stderr });
      },
    );
  });
}

/** @param {string} parent @param {string} child */
function isContained(parent, child) {
  const path = relative(parent, child);
  return path !== '' && !path.startsWith('..') && !isAbsolute(path);
}

/** @param {string} repoRoot @param {ReturnType<typeof runtimeTarget>} target */
async function packageDirectory(repoRoot, target) {
  const root = await realpath(resolve(repoRoot));
  const packagesPath = join(root, 'packages');
  const packagesInfo = await lstat(packagesPath);
  const packages = await realpath(packagesPath);
  if (
    packagesInfo.isSymbolicLink() ||
    !packagesInfo.isDirectory() ||
    !isContained(root, packages)
  ) {
    throw new Error('repository packages directory may not be a symlink or path escape');
  }
  const requested = join(packages, target.directory);
  const info = await lstat(requested);
  const actual = await realpath(requested);
  if (info.isSymbolicLink() || !info.isDirectory() || !isContained(packages, actual)) {
    throw new Error('runtime output is outside repository package directory');
  }
  return { root, packageDirectory: actual };
}

/** @param {string} path @param {string} packageDirectory */
async function requireSafeOutputPath(path, packageDirectory) {
  try {
    const info = await lstat(path);
    const actual = await realpath(path);
    if (info.isSymbolicLink() || !info.isFile() || !isContained(packageDirectory, actual)) {
      throw new Error('runtime output path may not be a symlink or path escape');
    }
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return;
    throw error;
  }
}

/** @param {string} path */
async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

/** @param {string} output */
function parseGoVersion(output) {
  const match = /^go version (\S+) \S+\/\S+\s*$/.exec(output);
  if (!match || !isRecognizedGoVersion(match[1])) {
    throw new Error('unrecognized Go version');
  }
  return match[1];
}

/** @param {string} value */
function normalizeBuildDate(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.valueOf())) throw new Error('invalid source commit date');
  return date.toISOString().replace('.000Z', 'Z');
}

/** @param {string} path */
async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * @param {{
 *   repoRoot?: string,
 *   platform: string,
 *   arch: string,
 *   env?: NodeJS.ProcessEnv,
 *   execute?: RuntimeCommandExecutor,
 * }} options
 */
export async function buildRuntime(options) {
  const target = runtimeTarget(options.platform, options.arch);
  const location = await packageDirectory(options.repoRoot ?? DEFAULT_REPO_ROOT, target);
  const entryPackage = await readJson(
    join(location.root, 'packages', 'quukk-clawmessenger', 'package.json'),
  );
  const runtimePackage = await readJson(join(location.packageDirectory, 'package.json'));
  if (
    typeof entryPackage.version !== 'string' ||
    !isSafePackageVersion(entryPackage.version) ||
    runtimePackage.version !== entryPackage.version ||
    runtimePackage.name !== target.packageName
  ) {
    throw new Error('runtime package version or name does not match entry package');
  }

  const binaryPath = join(location.packageDirectory, target.binary);
  const manifestPath = join(location.packageDirectory, 'manifest.json');
  await requireSafeOutputPath(binaryPath, location.packageDirectory);
  await requireSafeOutputPath(manifestPath, location.packageDirectory);

  const execute = options.execute ?? executeCommand;
  const env = { ...(options.env ?? process.env) };
  const commandOptions = { cwd: location.root, env, shell: /** @type {const} */ (false) };
  const goResult = await execute('go', ['version'], commandOptions);
  const goVersion = parseGoVersion(goResult.stdout);
  const commitResult = await execute('git', ['rev-parse', 'HEAD'], commandOptions);
  const sourceCommit = commitResult.stdout.trim();
  if (!FULL_GIT_OID.test(sourceCommit)) throw new Error('source commit is not a full Git object ID');
  const dateResult = await execute(
    'git',
    ['show', '-s', '--format=%cI', sourceCommit],
    commandOptions,
  );
  const buildDate = normalizeBuildDate(dateResult.stdout.trim());

  const ldflags = [
    '-s',
    '-w',
    '-X',
    `main.version=${entryPackage.version}`,
    '-X',
    `main.commit=${sourceCommit}`,
    '-X',
    `main.date=${buildDate}`,
  ].join(' ');
  await execute(
    'go',
    [
      'build',
      '-trimpath',
      '-buildvcs=false',
      '-ldflags',
      ldflags,
      '-o',
      binaryPath,
      './cmd/multica',
    ],
    {
      cwd: join(location.root, 'server'),
      env: {
        ...env,
        CGO_ENABLED: '0',
        GOENV: 'off',
        GOFLAGS: '',
        GOOS: target.goos,
        GOARCH: target.goarch,
        ...(target.goarch === 'amd64' ? { GOAMD64: 'v1' } : { GOARM64: 'v8.0' }),
      },
      shell: false,
    },
  );
  await chmod(binaryPath, 0o755);

  const manifest = {
    version: entryPackage.version,
    goVersion,
    sourceCommit,
    sha256: await sha256File(binaryPath),
    binary: target.binary,
  };
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  return { packageDirectory: location.packageDirectory, binaryPath, manifest };
}

async function main() {
  const target = parseBuildArguments(process.argv.slice(2));
  const result = await buildRuntime(target);
  console.log(
    `built ${result.manifest.binary} ${result.manifest.version} (${result.manifest.sha256})`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`[runtime-build] ${error instanceof Error ? error.message : 'build failed'}`);
    process.exitCode = 1;
  });
}
