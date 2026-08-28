import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, parse, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PACK_REPORT_MAX_BYTES = 4 * 1024 * 1024;
const PACK_FILE_MAX_BYTES = 128 * 1024 * 1024;
const PACK_TOTAL_MAX_BYTES = 512 * 1024 * 1024;
const PACK_FILE_MAX_COUNT = 4096;

const LEGAL_FILES = ['LICENSE', 'NOTICE', 'MODIFICATIONS.md', 'THIRD_PARTY_NOTICES.md'];
const PLATFORM_LEGAL_FILES = ['LICENSE', 'NOTICE', 'MODIFICATIONS.md', 'GO_THIRD_PARTY_NOTICES.md'];
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const GO_RELEASE = /^go1\.[1-9]\d*(?:\.(?:0|[1-9]\d*))?(?:(?:beta|rc)[1-9]\d*)?$/;
const ENTRY_DEPENDENCIES = Object.freeze({
  '@rongcloud/engine': '5.36.6',
  '@rongcloud/imlib-next': '5.36.6',
  'fake-indexeddb': '6.2.5',
  jsdom: '29.0.1',
  ws: '8.20.0',
  zod: '4.3.6',
});
const ENTRY_DEV_DEPENDENCIES = Object.freeze({
  '@multica/tsconfig': 'workspace:*',
  '@types/jsdom': '21.1.7',
  '@types/node': 'catalog:',
  '@types/ws': '8.18.1',
  typescript: 'catalog:',
  vitest: 'catalog:',
});
const ENTRY_PACKAGE_FIELDS = Object.freeze([
  'bin',
  'bugs',
  'dependencies',
  'description',
  'devDependencies',
  'engines',
  'files',
  'homepage',
  'license',
  'name',
  'optionalDependencies',
  'publishConfig',
  'repository',
  'scripts',
  'type',
  'version',
]);
const ENTRY_PACKAGE_FILES = Object.freeze([
  'bin',
  'dist',
  'scripts/audit-tarball.mjs',
  'scripts/postinstall.mjs',
  'LICENSE',
  'NOTICE',
  'MODIFICATIONS.md',
  'THIRD_PARTY_NOTICES.md',
  'README.md',
]);
const ENTRY_PACKAGE_SCRIPTS = Object.freeze({
  build: 'tsc -p tsconfig.json',
  typecheck: 'tsc --noEmit',
  'typecheck:e2e': 'tsc -p test/e2e/tsconfig.json',
  test: 'vitest run',
  prepublishOnly: 'node scripts/audit-tarball.mjs',
  postinstall: 'node scripts/postinstall.mjs',
});
const RUNTIME_PACKAGE_NAMES = Object.freeze([
  '@quukk/clawmessenger-runtime-win32-x64',
  '@quukk/clawmessenger-runtime-win32-arm64',
  '@quukk/clawmessenger-runtime-darwin-x64',
  '@quukk/clawmessenger-runtime-darwin-arm64',
  '@quukk/clawmessenger-runtime-linux-x64',
  '@quukk/clawmessenger-runtime-linux-arm64',
]);
const ENTRY_EXACT_FILES = new Set([
  'package.json',
  'README.md',
  ...LEGAL_FILES,
  'bin/quukk-clawmessenger.js',
  'scripts/audit-tarball.mjs',
  'scripts/postinstall.mjs',
  'dist/cli.js',
  'dist/index.js',
  'dist/rongcloud/worker-entry.js',
  'dist/ui/index.html',
]);
const ENTRY_MODULES = [
  'bindings/service',
  'cardkit/action-router',
  'cardkit/builders',
  'cardkit/parse-marker',
  'cardkit/schema',
  'cardkit/templates',
  'cardkit/validate',
  'cli',
  'config/atomic-json',
  'config/paths',
  'config/schema',
  'config/store',
  'go/binary',
  'go/client',
  'go/sse',
  'go/types',
  'http/routes',
  'http/security',
  'http/server',
  'http/tickets',
  'index',
  'logging/logger',
  'migration/discover',
  'migration/import',
  'process/identity',
  'process/service-identity',
  'process/supervisor',
  'protocol/discussion-v1',
  'protocol/discussion-v2',
  'protocol/discussion-wire',
  'protocol/messages',
  'registration/capabilities',
  'registration/client',
  'rongcloud/client',
  'rongcloud/env-polyfill',
  'rongcloud/worker-entry',
  'rongcloud/worker-protocol',
  'rongcloud/worker-supervisor',
  'router/conversation',
  'router/dedup',
  'router/message-router',
  'router/session-store',
  'service',
  'version',
];
for (const module of ENTRY_MODULES) {
  ENTRY_EXACT_FILES.add(`dist/${module}.js`);
  ENTRY_EXACT_FILES.add(`dist/${module}.d.ts`);
}

export class TarballAuditError extends Error {
  constructor(code) {
    super(code);
    this.name = 'TarballAuditError';
    this.code = code;
  }

  toJSON() {
    return { code: this.code };
  }
}

function fail(code) {
  throw new TarballAuditError(code);
}

function packPath(value) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 4096
    || value.includes('\\')
    || value.includes('\0')
    || posix.isAbsolute(value)
    || posix.normalize(value) !== value
    || value.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) fail('invalid_pack_path');
  return value;
}

async function safePackageFile(packageDirectory, path) {
  const target = join(packageDirectory, ...path.split('/'));
  const child = relative(packageDirectory, target);
  if (child === '' || isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`)) {
    fail('invalid_pack_path');
  }
  let current = packageDirectory;
  const root = await lstat(packageDirectory).catch(() => fail('pack_file_unavailable'));
  if (root.isSymbolicLink()) fail('symlink_rejected');
  if (!root.isDirectory()) fail('pack_file_unavailable');
  const parts = path.split('/');
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]);
    const info = await lstat(current).catch(() => fail('pack_file_unavailable'));
    if (info.isSymbolicLink()) fail('symlink_rejected');
    if (index < parts.length - 1 && !info.isDirectory()) fail('pack_file_unavailable');
    if (index === parts.length - 1 && !info.isFile()) fail('pack_file_unavailable');
  }
  return target;
}

function entryAllowed(path) {
  if (ENTRY_EXACT_FILES.has(path)) return true;
  return /^dist\/ui\/assets\/[A-Za-z0-9._-]+\.(?:js|css|svg|png|webp|ico|woff2?)$/.test(path);
}

function platformIdentity(name) {
  if (typeof name !== 'string') return undefined;
  const match = /^@quukk\/clawmessenger-runtime-(win32|darwin|linux)-(x64|arm64)$/.exec(name);
  return match === null ? undefined : { platform: match[1], architecture: match[2] };
}

function exactStringArray(value, expected) {
  return (
    Array.isArray(value)
    && value.length === expected.length
    && value.every((item, index) => item === expected[index])
  );
}

function exactStringRecord(value, expected) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expectedKeys = Object.keys(expected).sort();
  return exactStringArray(keys, expectedKeys)
    && expectedKeys.every((key) => value[key] === expected[key]);
}

function exactScalarRecord(value, expected) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expectedKeys = Object.keys(expected).sort();
  return exactStringArray(keys, expectedKeys)
    && expectedKeys.every((key) => Object.is(value[key], expected[key]));
}

function withoutRemoteUrls(value) {
  return value.replace(/\bhttps?:\/\/[^\s"'`<>]+/gi, '');
}

function comparablePathText(value) {
  return withoutRemoteUrls(value).replace(/\\\\/g, '\\').replace(/\\/g, '/');
}

function hasPathBoundary(value, start, length) {
  const before = start === 0 ? '' : value[start - 1];
  const after = value[start + length] ?? '';
  return (
    (before === '' || !/[A-Za-z0-9._/-]/.test(before))
    && (after === '' || !/[A-Za-z0-9._-]/.test(after))
  );
}

function containsCheckoutRoot(value, roots) {
  const comparable = comparablePathText(value);
  for (const root of roots) {
    const normalized = root.replace(/\\/g, '/');
    const caseInsensitive = /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//');
    const haystack = caseInsensitive ? comparable.toLowerCase() : comparable;
    const needle = caseInsensitive ? normalized.toLowerCase() : normalized;
    let start = haystack.indexOf(needle);
    while (start !== -1) {
      if (hasPathBoundary(haystack, start, needle.length)) return true;
      start = haystack.indexOf(needle, start + 1);
    }
  }
  return false;
}

function contentIsSensitive(bytes, checkoutRoots) {
  const value = bytes.toString('latin1');
  return (
    /(?:["']?(?:token|appkey|appsecret|bridgesecret|password|enrollmentproof)["']?\s*[:=]\s*["'][^"'\r\n]{8,}["'])/i.test(value)
    || /(?:^|\s)_authToken\s*=\s*\S+/im.test(value)
    || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)
    || /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/.test(value)
    || /\b[A-Za-z]:[\\/]Users[\\/][^\s"']+/i.test(value)
    || /(?:\/home\/(?!linuxbrew\/|me\/|user\/|username\/)|\/Users\/(?!me\/|user\/|username\/))[A-Za-z0-9._-]+\//.test(value)
    || /sourceMappingURL\s*=/.test(value)
    || containsCheckoutRoot(bytes.toString('utf8'), checkoutRoots)
  );
}

function checkoutRoots(options, packageDirectory) {
  const provided = options.knownCheckoutRoots;
  if (
    provided !== undefined
    && (
      !Array.isArray(provided)
      || provided.length > 64
      || provided.some((path) => (
        typeof path !== 'string'
        || path.length < 1
        || path.length > 4096
        || path.includes('\0')
        || !isAbsolute(path)
      ))
    )
  ) fail('invalid_arguments');
  const candidates = [
    process.cwd(),
    packageDirectory,
    fileURLToPath(new URL('..', import.meta.url)),
    fileURLToPath(new URL('../../..', import.meta.url)),
  ];
  const ancestors = [];
  for (const candidate of candidates) {
    let current = resolve(candidate);
    const root = parse(current).root;
    while (relative(root, current).split(sep).filter(Boolean).length >= 2) {
      ancestors.push(current);
      current = resolve(current, '..');
    }
  }
  return [...new Set([...ancestors, ...(provided ?? []).map((path) => resolve(path))])];
}

function reportRecords(value) {
  if (!Array.isArray(value) || value.length !== 1) fail('invalid_pack_report');
  const record = value[0];
  if (
    record === null
    || typeof record !== 'object'
    || typeof record.name !== 'string'
    || typeof record.version !== 'string'
    || !SEMVER.test(record.version)
    || typeof record.filename !== 'string'
    || record.filename.includes('/')
    || record.filename.includes('\\')
    || !record.filename.endsWith('.tgz')
    || !Array.isArray(record.files)
    || record.files.length < 1
    || record.files.length > PACK_FILE_MAX_COUNT
  ) fail('invalid_pack_report');
  return [record];
}

async function jsonManifest(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    fail('manifest_invalid');
  }
}

async function auditReport(value, packageDirectory, knownCheckoutRoots) {
  const records = reportRecords(value);
  let auditedFiles = 0;
  for (const record of records) {
    const names = new Set();
    let totalBytes = 0;
    const listed = [];
    for (const file of record.files) {
      if (
        file === null
        || typeof file !== 'object'
        || !Number.isSafeInteger(file.size)
        || file.size < 0
        || file.size > PACK_FILE_MAX_BYTES
      ) fail('invalid_pack_report');
      const path = packPath(file.path);
      const portable = path.toLowerCase();
      if (names.has(portable)) fail('duplicate_pack_path');
      names.add(portable);
      totalBytes += file.size;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > PACK_TOTAL_MAX_BYTES) {
        fail('invalid_pack_report');
      }
      listed.push({ path, size: file.size });
    }

    const platform = platformIdentity(record.name);
    const entry = record.name === 'quukk-clawmessenger';
    if (!entry && platform === undefined) fail('unexpected_package');
    const platformBinary = platform?.platform === 'win32' ? 'multica.exe' : 'multica';
    const required = entry
      ? [...ENTRY_EXACT_FILES]
      : ['package.json', platformBinary, 'manifest.json', ...PLATFORM_LEGAL_FILES, 'SOURCE.md'];
    if (required.some((path) => !names.has(path.toLowerCase()))) fail('required_file_missing');
    if (entry) {
      if (![...names].some((path) => /^dist\/ui\/assets\/.+\.js$/.test(path))) {
        fail('required_file_missing');
      }
      if (![...names].some((path) => /^dist\/ui\/assets\/.+\.css$/.test(path))) {
        fail('required_file_missing');
      }
    }

    let platformBinaryBytes;
    let platformGoNotices;
    for (const file of listed) {
      if (file.path.endsWith('.map')) fail('source_map_rejected');
      const allowed = entry
        ? entryAllowed(file.path)
        : new Set([
            'package.json', platformBinary, 'manifest.json', ...PLATFORM_LEGAL_FILES, 'SOURCE.md',
          ]).has(file.path);
      if (!allowed) fail('unexpected_file');
      const target = await safePackageFile(packageDirectory, file.path);
      const actual = await stat(target).catch(() => fail('pack_file_unavailable'));
      if (!actual.isFile() || actual.size !== file.size) fail('pack_report_mismatch');
      const bytes = await readFile(target);
      if (contentIsSensitive(bytes, knownCheckoutRoots)) fail('sensitive_content');
      if (!entry && file.path === platformBinary) platformBinaryBytes = bytes;
      if (!entry && file.path === 'GO_THIRD_PARTY_NOTICES.md') {
        platformGoNotices = bytes.toString('utf8');
      }
      auditedFiles += 1;
    }

    const packageJson = await jsonManifest(join(packageDirectory, 'package.json'));
    if (
      packageJson === null
      || typeof packageJson !== 'object'
      || packageJson.name !== record.name
      || packageJson.version !== record.version
    ) fail('manifest_invalid');
    if (entry) {
      const expectedOptionalDependencies = Object.fromEntries(
        RUNTIME_PACKAGE_NAMES.map((name) => [name, record.version]),
      );
      if (
        !exactStringArray(Object.keys(packageJson).sort(), [...ENTRY_PACKAGE_FIELDS].sort())
        || packageJson.description !== 'Connect local AI agents to ClawMessenger, built on Multica'
        || packageJson.type !== 'module'
        || packageJson.license !== 'SEE LICENSE IN LICENSE'
        || !exactStringRecord(packageJson.repository, {
          type: 'git',
          url: 'git+https://github.com/quukk/quukk-clawmessenger.git',
          directory: 'packages/quukk-clawmessenger',
        })
        || !exactStringRecord(packageJson.bugs, {
          url: 'https://github.com/quukk/quukk-clawmessenger/issues',
        })
        || packageJson.homepage !== 'https://github.com/quukk/quukk-clawmessenger/tree/main/packages/quukk-clawmessenger#readme'
        || !exactStringRecord(packageJson.engines, { node: '>=22.13.0' })
        || !exactStringRecord(packageJson.bin, {
          'quukk-clawmessenger': 'bin/quukk-clawmessenger.js',
        })
        || !exactStringArray(packageJson.files, ENTRY_PACKAGE_FILES)
        || !exactStringRecord(packageJson.scripts, ENTRY_PACKAGE_SCRIPTS)
        || !exactScalarRecord(packageJson.publishConfig, {
          access: 'public',
          provenance: true,
          tag: 'beta',
        })
        || !exactStringRecord(packageJson.dependencies, ENTRY_DEPENDENCIES)
        || !exactStringRecord(packageJson.devDependencies, ENTRY_DEV_DEPENDENCIES)
        || !exactStringRecord(
          packageJson.optionalDependencies,
          expectedOptionalDependencies,
        )
      ) {
        fail('manifest_invalid');
      }
    } else {
      const packageFiles = [
        platformBinary,
        'manifest.json',
        ...PLATFORM_LEGAL_FILES,
        'SOURCE.md',
      ];
      if (
        !exactStringArray(packageJson.os, [platform.platform])
        || !exactStringArray(packageJson.cpu, [platform.architecture])
        || !exactStringArray(packageJson.files, packageFiles)
        || Object.hasOwn(packageJson, 'scripts')
        || Object.hasOwn(packageJson, 'private')
      ) fail('manifest_invalid');
      const manifest = await jsonManifest(join(packageDirectory, 'manifest.json'));
      const manifestKeys = manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest)
        ? Object.keys(manifest).sort()
        : [];
      if (
        manifest === null
        || typeof manifest !== 'object'
        || Array.isArray(manifest)
        || !exactStringArray(
          manifestKeys,
          ['binary', 'goVersion', 'modules', 'sha256', 'sourceCommit', 'version'],
        )
        || manifest.version !== record.version
        || manifest.binary !== platformBinary
        || !GO_RELEASE.test(manifest.goVersion)
        || !/^[0-9a-f]{40}$/.test(manifest.sourceCommit)
        || !Array.isArray(manifest.modules)
        || manifest.modules.length === 0
        || manifest.modules.length > 256
        || manifest.modules.some((module) => typeof module !== 'string' || !/^[^\s@]+@v[^\s@]+$/.test(module))
        || manifest.modules.some((module, index) => index > 0 && module <= manifest.modules[index - 1])
        || typeof platformGoNotices !== 'string'
        || !platformGoNotices.includes(`Go standard library/runtime \`${manifest.goVersion}\``)
        || manifest.modules.some((module) => !platformGoNotices.includes(`\`${module}\``))
        || !/^[0-9a-f]{64}$/.test(manifest.sha256)
        || platformBinaryBytes === undefined
        || createHash('sha256').update(platformBinaryBytes).digest('hex') !== manifest.sha256
      ) fail('manifest_invalid');
    }
  }
  return { packageCount: records.length, fileCount: auditedFiles };
}

async function readPackJson(packJsonPath) {
  const info = await lstat(packJsonPath).catch(() => fail('pack_report_unavailable'));
  if (info.isSymbolicLink()) fail('symlink_rejected');
  if (!info.isFile() || info.size < 1 || info.size > PACK_REPORT_MAX_BYTES) {
    fail('invalid_pack_report');
  }
  try {
    return JSON.parse(await readFile(packJsonPath, 'utf8'));
  } catch {
    fail('invalid_pack_report');
  }
}

export async function auditTarball(options) {
  if (options === null || typeof options !== 'object') fail('invalid_arguments');
  const packJsonValue = options.packJsonPath;
  const packageDirectoryValue = options.packageDirectory;
  if (
    typeof packJsonValue !== 'string'
    || packJsonValue.length < 1
    || packJsonValue.length > 4096
    || packJsonValue.includes('\0')
    || typeof packageDirectoryValue !== 'string'
    || packageDirectoryValue.length < 1
    || packageDirectoryValue.length > 4096
    || packageDirectoryValue.includes('\0')
  ) fail('invalid_arguments');
  const packJsonPath = resolve(packJsonValue);
  const packageDirectory = resolve(packageDirectoryValue);
  return auditReport(
    await readPackJson(packJsonPath),
    packageDirectory,
    checkoutRoots(options, packageDirectory),
  );
}

function npmEnvironment() {
  const keys = process.platform === 'win32'
    ? ['APPDATA', 'COMSPEC', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'PATH', 'PATHEXT', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'WINDIR']
    : ['HOME', 'LANG', 'LC_ALL', 'PATH', 'SHELL', 'TEMP', 'TMP', 'TMPDIR'];
  const environment = {};
  for (const key of keys) {
    if (typeof process.env[key] === 'string') environment[key] = process.env[key];
  }
  if (
    typeof process.env.npm_config_cache === 'string'
    && isAbsolute(process.env.npm_config_cache)
  ) environment.npm_config_cache = process.env.npm_config_cache;
  environment.npm_config_audit = 'false';
  environment.npm_config_fund = 'false';
  environment.npm_config_ignore_scripts = 'true';
  environment.npm_config_offline = 'true';
  return environment;
}

function defaultPackReport(packageDirectory) {
  const result = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['pack', '--dry-run', '--json', '--ignore-scripts', '.'],
    {
      cwd: packageDirectory,
      encoding: 'utf8',
      env: npmEnvironment(),
      maxBuffer: PACK_REPORT_MAX_BYTES,
      shell: process.platform === 'win32',
      windowsHide: true,
    },
  );
  if (result.status !== 0 || typeof result.stdout !== 'string') fail('pack_failed');
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail('invalid_pack_report');
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

async function runCli(args) {
  if (args.length > 2) fail('invalid_arguments');
  if (args.length === 0) {
    const packageDirectory = fileURLToPath(new URL('..', import.meta.url));
    return auditReport(
      defaultPackReport(packageDirectory),
      packageDirectory,
      checkoutRoots({}, packageDirectory),
    );
  }
  const first = resolve(args[0]);
  const firstInfo = await lstat(first).catch(() => fail('invalid_arguments'));
  if (firstInfo.isSymbolicLink()) fail('symlink_rejected');
  if (firstInfo.isDirectory()) {
    if (args.length !== 1) fail('invalid_arguments');
    return auditTarball({ packJsonPath: join(first, 'npm-pack.json'), packageDirectory: first });
  }
  if (!firstInfo.isFile()) fail('invalid_arguments');
  return auditTarball({
    packJsonPath: first,
    packageDirectory: args[1] === undefined ? resolve(first, '..') : resolve(args[1]),
  });
}

if (isDirectExecution()) {
  runCli(process.argv.slice(2)).then((result) => {
    process.stdout.write(`quukk-clawmessenger audit: ok ${result.fileCount}\n`);
  }).catch((error) => {
    const code = error instanceof TarballAuditError ? error.code : 'audit_failed';
    process.stderr.write(`quukk-clawmessenger audit: ${code}\n`);
    process.exitCode = 1;
  });
}
