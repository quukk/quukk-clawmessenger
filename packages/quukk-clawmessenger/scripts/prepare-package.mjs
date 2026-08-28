import { randomUUID } from 'node:crypto';
import {
  lstat,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LEGAL_FILES = Object.freeze([
  'LICENSE',
  'NOTICE',
  'MODIFICATIONS.md',
  'THIRD_PARTY_NOTICES.md',
]);

export const PLATFORM_LEGAL_FILES = Object.freeze([
  'LICENSE',
  'NOTICE',
  'MODIFICATIONS.md',
  'GO_THIRD_PARTY_NOTICES.md',
]);

export const PLATFORM_PACKAGE_DIRECTORIES = Object.freeze([
  'quukk-clawmessenger-runtime-win32-x64',
  'quukk-clawmessenger-runtime-win32-arm64',
  'quukk-clawmessenger-runtime-darwin-x64',
  'quukk-clawmessenger-runtime-darwin-arm64',
  'quukk-clawmessenger-runtime-linux-x64',
  'quukk-clawmessenger-runtime-linux-arm64',
]);

export class PackagePreparationError extends Error {
  constructor(code) {
    super(code);
    this.name = 'PackagePreparationError';
    this.code = code;
  }

  toJSON() {
    return { code: this.code };
  }
}

function fail(code) {
  throw new PackagePreparationError(code);
}

async function inspectContained(root, target, expected, allowMissing = false) {
  const child = relative(root, target);
  if (
    child === ''
    || isAbsolute(child)
    || child === '..'
    || child.startsWith(`..${sep}`)
  ) fail('path_outside_repository');
  let current = root;
  const rootInfo = await lstat(root).catch(() => fail('path_invalid'));
  if (rootInfo.isSymbolicLink()) fail('symlink_rejected');
  if (!rootInfo.isDirectory()) fail('path_invalid');
  const parts = child.split(sep);
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (allowMissing && index === parts.length - 1 && error?.code === 'ENOENT') return;
      fail('path_invalid');
    }
    if (info.isSymbolicLink()) fail('symlink_rejected');
    if (index < parts.length - 1 && !info.isDirectory()) fail('path_invalid');
    if (index === parts.length - 1) {
      if (expected === 'file' && !info.isFile()) fail('path_invalid');
      if (expected === 'directory' && !info.isDirectory()) fail('path_invalid');
    }
  }
}

async function writeExact(target, bytes) {
  const temporary = `${target}.tmp.${randomUUID()}`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
  } catch {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    fail('legal_copy_failed');
  }
}

export async function preparePackage(options = {}) {
  const defaultRoot = fileURLToPath(new URL('../../..', import.meta.url));
  const repositoryRoot = resolve(options.repositoryRoot ?? defaultRoot);
  if (!isAbsolute(repositoryRoot)) fail('path_invalid');
  await inspectContained(dirnameOf(repositoryRoot), repositoryRoot, 'directory');
  const packagesDirectory = join(repositoryRoot, 'packages');
  const entry = join(packagesDirectory, 'quukk-clawmessenger');
  await inspectContained(repositoryRoot, packagesDirectory, 'directory');
  await inspectContained(repositoryRoot, entry, 'directory');

  const entries = await readdir(packagesDirectory, { withFileTypes: true }).catch(() => fail('path_invalid'));
  const presentPlatforms = entries
    .filter((entryValue) => entryValue.name.startsWith('quukk-clawmessenger-runtime-'))
    .map((entryValue) => entryValue.name)
    .sort();
  if (
    presentPlatforms.length !== 0
    && (
      presentPlatforms.length !== PLATFORM_PACKAGE_DIRECTORIES.length
      || presentPlatforms.some((name, index) => name !== [...PLATFORM_PACKAGE_DIRECTORIES].sort()[index])
    )
  ) fail('platform_package_set_incomplete');

  const targets = [{ directory: entry, legalFiles: LEGAL_FILES }];
  if (presentPlatforms.length !== 0) {
    for (const name of PLATFORM_PACKAGE_DIRECTORIES) {
      const target = join(packagesDirectory, name);
      await inspectContained(repositoryRoot, target, 'directory');
      targets.push({ directory: target, legalFiles: PLATFORM_LEGAL_FILES });
    }
  }
  const legalBytes = new Map();
  for (const name of new Set([...LEGAL_FILES, ...PLATFORM_LEGAL_FILES])) {
    const source = join(repositoryRoot, name);
    await inspectContained(repositoryRoot, source, 'file');
    legalBytes.set(name, await readFile(source));
  }
  for (const target of targets) {
    for (const name of target.legalFiles) {
      await inspectContained(repositoryRoot, join(target.directory, name), 'file', true);
    }
  }
  for (const target of targets) {
    for (const name of target.legalFiles) {
      const destination = join(target.directory, name);
      const bytes = legalBytes.get(name);
      const current = await readFile(destination).catch(() => undefined);
      if (current !== undefined && current.equals(bytes)) continue;
      await writeExact(destination, bytes);
    }
  }
  return {
    targetCount: targets.length,
    fileCount: targets.reduce((count, target) => count + target.legalFiles.length, 0),
  };
}

function dirnameOf(path) {
  const parent = resolve(path, '..');
  if (parent === path) fail('path_invalid');
  return parent;
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

if (isDirectExecution()) {
  preparePackage().then((result) => {
    process.stdout.write(`quukk-clawmessenger prepare: ok ${result.fileCount}\n`);
  }).catch((error) => {
    const code = error instanceof PackagePreparationError ? error.code : 'prepare_failed';
    process.stderr.write(`quukk-clawmessenger prepare: ${code}\n`);
    process.exitCode = 1;
  });
}
