import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, rename, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ENTRY_PACKAGE = 'quukk-clawmessenger';
const RUNTIME_PACKAGES = new Set([
  '@quukk/clawmessenger-runtime-win32-x64',
  '@quukk/clawmessenger-runtime-win32-arm64',
  '@quukk/clawmessenger-runtime-darwin-x64',
  '@quukk/clawmessenger-runtime-darwin-arm64',
  '@quukk/clawmessenger-runtime-linux-x64',
  '@quukk/clawmessenger-runtime-linux-arm64',
]);
const EXPECTED_PACKAGES = new Set([...RUNTIME_PACKAGES, ENTRY_PACKAGE]);
const RELEASE_MODES = new Set(['preflight', 'runtimes', 'complete']);
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SHA1 = /^[0-9a-f]{40}$/;
const SHA512_INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/;
const PUBLIC_REGISTRY = 'https://registry.npmjs.org';
const SAFE_ERROR_CODES = new Set([
  'entry_release_incomplete',
  'entry_without_complete_runtime_set',
  'invalid_arguments',
  'invalid_release_manifest',
  'invalid_release_set',
  'invalid_release_version',
  'registry_content_mismatch',
  'registry_lookup_failed',
  'registry_metadata_invalid',
  'release_archive_invalid',
  'release_plan_write_failed',
  'runtime_release_incomplete',
]);

export function compareDistribution(local, remote) {
  if (
    local === null ||
    typeof local !== 'object' ||
    remote === null ||
    typeof remote !== 'object' ||
    typeof local.shasum !== 'string' ||
    typeof local.integrity !== 'string' ||
    typeof remote.shasum !== 'string' ||
    typeof remote.integrity !== 'string' ||
    !SHA1.test(local.shasum) ||
    !SHA1.test(remote.shasum) ||
    !SHA512_INTEGRITY.test(local.integrity) ||
    !SHA512_INTEGRITY.test(remote.integrity)
  ) {
    throw new Error('registry_metadata_invalid');
  }
  if (local.shasum !== remote.shasum || local.integrity !== remote.integrity) {
    throw new Error('registry_content_mismatch');
  }
  return 'matching';
}

export function classifyReleaseSet(packages, mode = 'preflight') {
  if (!Array.isArray(packages) || !RELEASE_MODES.has(mode)) {
    throw new Error('invalid_release_set');
  }
  const entry = packages.filter((item) => item?.role === 'entry');
  const runtimes = packages.filter((item) => item?.role === 'runtime');
  const names = new Set(packages.map((item) => item?.name));
  if (
    packages.length !== 7 ||
    entry.length !== 1 ||
    runtimes.length !== 6 ||
    names.size !== 7 ||
    [...EXPECTED_PACKAGES].some((name) => !names.has(name)) ||
    packages.some((item) => !['missing', 'matching'].includes(item?.state))
  ) {
    throw new Error('invalid_release_set');
  }
  if (entry[0].state === 'matching' && runtimes.some((item) => item.state !== 'matching')) {
    throw new Error('entry_without_complete_runtime_set');
  }
  if (
    (mode === 'runtimes' || mode === 'complete') &&
    runtimes.some((item) => item.state !== 'matching')
  ) {
    throw new Error('runtime_release_incomplete');
  }
  if (mode === 'complete' && entry[0].state !== 'matching') {
    throw new Error('entry_release_incomplete');
  }
  return packages.map((item) => ({
    ...item,
    action: item.state === 'matching' ? 'skip' : 'publish',
  }));
}

export function queryNpmDistribution(name, version, execute = spawnSync) {
  const result = execute(
    'npm',
    [
      'view',
      `${name}@${version}`,
      'dist',
      '--json',
      `--registry=${PUBLIC_REGISTRY}`,
    ],
    {
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: 30_000,
    },
  );
  if (result?.error !== undefined) throw new Error('registry_lookup_failed');
  if (result?.status !== 0) {
    const stderr = typeof result?.stderr === 'string' ? result.stderr : '';
    if (/(?:^|\s)E404(?:\s|$)|404 Not Found/i.test(stderr)) {
      return { state: 'missing' };
    }
    throw new Error('registry_lookup_failed');
  }

  let value;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error('registry_metadata_invalid');
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof value.shasum !== 'string' ||
    typeof value.integrity !== 'string' ||
    !SHA1.test(value.shasum) ||
    !SHA512_INTEGRITY.test(value.integrity)
  ) {
    throw new Error('registry_metadata_invalid');
  }
  return {
    state: 'found',
    shasum: value.shasum,
    integrity: value.integrity,
  };
}

async function hashArchive(path) {
  let bytes;
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error('not_file');
    bytes = await readFile(path);
  } catch {
    throw new Error('release_archive_invalid');
  }
  return {
    shasum: createHash('sha1').update(bytes).digest('hex'),
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
  };
}

async function readReleaseInputs(manifestPath, versionPath) {
  let manifestText;
  let version;
  try {
    manifestText = await readFile(manifestPath, 'utf8');
    version = (await readFile(versionPath, 'utf8')).trim();
  } catch {
    throw new Error('invalid_release_manifest');
  }
  if (!SEMVER.test(version)) throw new Error('invalid_release_version');

  const rows = manifestText
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => line.split('\t'));
  if (
    rows.length !== 7 ||
    rows.some((fields) => fields.length !== 2 || fields.some((field) => field.length === 0))
  ) {
    throw new Error('invalid_release_manifest');
  }
  const packages = rows.map(([name, archive]) => ({
    name,
    archive,
    role: name === ENTRY_PACKAGE ? 'entry' : RUNTIME_PACKAGES.has(name) ? 'runtime' : 'invalid',
  }));
  const names = new Set(packages.map((item) => item.name));
  if (
    names.size !== 7 ||
    [...EXPECTED_PACKAGES].some((name) => !names.has(name)) ||
    packages.some((item) => item.role === 'invalid')
  ) {
    throw new Error('invalid_release_set');
  }
  return { packages, version };
}

export async function createReleasePlan({
  manifestPath,
  versionPath,
  outputPath,
  mode = 'preflight',
  queryDistribution = queryNpmDistribution,
}) {
  if (
    typeof manifestPath !== 'string' ||
    typeof versionPath !== 'string' ||
    typeof outputPath !== 'string' ||
    !RELEASE_MODES.has(mode)
  ) {
    throw new Error('invalid_arguments');
  }
  const { packages, version } = await readReleaseInputs(manifestPath, versionPath);
  const observed = [];
  for (const item of packages) {
    const local = await hashArchive(item.archive);
    const remote = queryDistribution(item.name, version);
    const state = remote?.state === 'missing' ? 'missing' : compareDistribution(local, remote);
    observed.push({ ...item, state });
  }
  const plan = classifyReleaseSet(observed, mode);
  const contents = `${plan
    .map((item) => `${item.name}\t${item.archive}\t${item.role}\t${item.action}`)
    .join('\n')}\n`;
  const temporaryPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(temporaryPath, contents, { encoding: 'utf8', flag: 'wx' });
    await rename(temporaryPath, outputPath);
  } catch {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw new Error('release_plan_write_failed');
  }
  return plan;
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      !['--manifest', '--version-file', '--output', '--mode'].includes(key) ||
      typeof value !== 'string' ||
      value.length === 0 ||
      values.has(key)
    ) {
      throw new Error('invalid_arguments');
    }
    values.set(key, value);
  }
  if (
    values.size !== 4 ||
    !RELEASE_MODES.has(values.get('--mode'))
  ) {
    throw new Error('invalid_arguments');
  }
  return {
    manifestPath: values.get('--manifest'),
    versionPath: values.get('--version-file'),
    outputPath: values.get('--output'),
    mode: values.get('--mode'),
  };
}

function isDirectExecution() {
  try {
    return (
      typeof process.argv[1] === 'string' &&
      pathToFileURL(resolve(process.argv[1])).href === import.meta.url
    );
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  try {
    await createReleasePlan(parseArguments(process.argv.slice(2)));
  } catch (error) {
    const code = error instanceof Error && SAFE_ERROR_CODES.has(error.message)
      ? error.message
      : 'release_plan_failed';
    console.error(`::error::${code}`);
    process.exitCode = 1;
  }
}
