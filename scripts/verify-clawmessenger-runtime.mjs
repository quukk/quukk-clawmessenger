#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  isRecognizedGoVersion,
  isSafePackageVersion,
  runtimeTarget,
} from './build-clawmessenger-runtime.mjs';

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(SCRIPT_DIRECTORY, '..');
const FULL_GIT_OID = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const JSON_LIMIT = 64 << 10;
const SOURCE_REPOSITORY = 'https://github.com/multica-ai/multica';
const SOURCE_ENTRYPOINT = 'server/cmd/multica';
const LEGAL_FILES = ['LICENSE', 'NOTICE', 'MODIFICATIONS.md'];
const PLATFORM_PACKAGE = /^quukk-clawmessenger-runtime-(win32|darwin|linux)-(x64|arm64)$/;

/** @param {string} left @param {string} right */
function samePath(left, right) {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/** @param {string} parent @param {string} child */
function isContained(parent, child) {
  const path = relative(parent, child);
  return path !== '' && !path.startsWith('..') && !isAbsolute(path);
}

/** @param {unknown} value */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} value @param {string[]} expected */
function isExactStringArray(value, expected) {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

/** @param {string} path @param {string} label */
async function readBoundedJson(path, label) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > JSON_LIMIT) {
    throw new Error(`invalid ${label}`);
  }
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (!isRecord(value)) throw new Error('not an object');
    return value;
  } catch {
    throw new Error(`invalid ${label}`);
  }
}

/** @param {string} path */
async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** @param {string[]} actual @param {string[]} expected */
function requireExactEntries(actual, expected) {
  const expectedSet = new Set(expected);
  const unexpected = actual.find((entry) => !expectedSet.has(entry));
  if (unexpected) throw new Error(`unexpected package entry: ${unexpected}`);
  const actualSet = new Set(actual);
  const missing = expected.find((entry) => !actualSet.has(entry));
  if (missing || actual.length !== expected.length) {
    throw new Error(`missing or duplicate package entry: ${missing ?? 'unknown'}`);
  }
}

/**
 * @param {string} requestedPackage
 * @param {{repoRoot?: string}} [options]
 */
export async function verifyRuntimePackage(requestedPackage, options = {}) {
  const root = await realpath(resolve(options.repoRoot ?? DEFAULT_REPO_ROOT));
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
  const requested = resolve(requestedPackage);
  const match = PLATFORM_PACKAGE.exec(basename(requested));
  if (!match) throw new Error('path is outside supported runtime package');
  const target = runtimeTarget(match[1], match[2]);
  const expectedPackage = join(packages, target.directory);
  if (!samePath(requested, expectedPackage)) {
    throw new Error('path is outside supported runtime package');
  }

  const packageInfo = await lstat(requested);
  if (packageInfo.isSymbolicLink()) throw new Error('runtime package may not be a symlink');
  const packageDirectory = await realpath(requested);
  if (
    !packageInfo.isDirectory() ||
    !isContained(packages, packageDirectory) ||
    !samePath(packageDirectory, expectedPackage)
  ) {
    throw new Error('runtime package is outside repository packages directory');
  }

  const expectedFiles = [
    'package.json',
    target.binary,
    'manifest.json',
    ...LEGAL_FILES,
    'SOURCE.md',
  ];
  const entries = await readdir(packageDirectory);
  requireExactEntries(entries, expectedFiles);
  for (const entry of expectedFiles) {
    const path = join(packageDirectory, entry);
    const info = await lstat(path);
    const actual = await realpath(path);
    if (info.isSymbolicLink() || !info.isFile() || !isContained(packageDirectory, actual)) {
      throw new Error(`package entry may not be a symlink or path escape: ${entry}`);
    }
  }

  const entryPackage = await readBoundedJson(
    join(packages, 'quukk-clawmessenger', 'package.json'),
    'entry package metadata',
  );
  const packageJson = await readBoundedJson(
    join(packageDirectory, 'package.json'),
    'runtime package metadata',
  );
  const packagedFiles = [
    target.binary,
    'manifest.json',
    ...LEGAL_FILES,
    'SOURCE.md',
  ];
  if (
    typeof entryPackage.version !== 'string' ||
    !isSafePackageVersion(entryPackage.version) ||
    packageJson.version !== entryPackage.version
  ) {
    throw new Error('runtime package version does not match a safe entry package version');
  }
  if (
    packageJson.name !== target.packageName ||
    packageJson.license !== 'SEE LICENSE IN LICENSE' ||
    !isExactStringArray(packageJson.os, [target.platform]) ||
    !isExactStringArray(packageJson.cpu, [target.arch]) ||
    !isExactStringArray(packageJson.files, packagedFiles) ||
    packageJson.scripts !== undefined ||
    packageJson.private === true
  ) {
    throw new Error('runtime package metadata does not match its target');
  }

  const manifest = await readBoundedJson(
    join(packageDirectory, 'manifest.json'),
    'runtime manifest',
  );
  const manifestFields = ['binary', 'goVersion', 'sha256', 'sourceCommit', 'version'];
  if (
    Object.keys(manifest).sort().join('\0') !== manifestFields.sort().join('\0')
  ) {
    throw new Error('runtime manifest fields are not exact');
  }
  if (manifest.version !== packageJson.version) {
    throw new Error('runtime manifest version does not match package');
  }
  if (manifest.binary !== target.binary) {
    throw new Error('runtime manifest binary filename does not match package');
  }
  if (typeof manifest.goVersion !== 'string' || !isRecognizedGoVersion(manifest.goVersion)) {
    throw new Error('runtime manifest has an unrecognized Go version');
  }
  if (typeof manifest.sourceCommit !== 'string' || !FULL_GIT_OID.test(manifest.sourceCommit)) {
    throw new Error('runtime manifest source commit is not a full Git object ID');
  }
  if (typeof manifest.sha256 !== 'string' || !SHA256.test(manifest.sha256)) {
    throw new Error('runtime manifest SHA-256 is invalid');
  }

  for (const legalFile of LEGAL_FILES) {
    const rootBytes = await readFile(join(root, legalFile));
    const packageBytes = await readFile(join(packageDirectory, legalFile));
    if (!rootBytes.equals(packageBytes)) {
      throw new Error(`packaged legal file differs from repository root: ${legalFile}`);
    }
  }
  const source = await readFile(join(packageDirectory, 'SOURCE.md'), 'utf8');
  if (!source.includes(SOURCE_REPOSITORY) || !source.includes(SOURCE_ENTRYPOINT)) {
    throw new Error('runtime package source attribution is incomplete');
  }

  const digest = await sha256File(join(packageDirectory, target.binary));
  if (digest !== manifest.sha256) throw new Error('runtime binary SHA-256 mismatch');

  return {
    packageName: target.packageName,
    platform: target.platform,
    arch: target.arch,
    version: packageJson.version,
    binary: target.binary,
    sha256: digest,
    sourceCommit: manifest.sourceCommit,
    goVersion: manifest.goVersion,
  };
}

async function main() {
  if (process.argv.length !== 3) {
    throw new Error('usage: node scripts/verify-clawmessenger-runtime.mjs <runtime-package-directory>');
  }
  const result = await verifyRuntimePackage(process.argv[2]);
  console.log(
    `verified ${result.packageName}@${result.version} (${result.sha256})`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`[runtime-verify] ${error instanceof Error ? error.message : 'verification failed'}`);
    process.exitCode = 1;
  });
}
