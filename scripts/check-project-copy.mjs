#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

function parseRoot(argv) {
  if (argv.length === 0) return resolve(import.meta.dirname, '..');
  if (argv.length === 2 && argv[0] === '--root' && argv[1]?.trim()) return resolve(argv[1]);
  throw new Error('invalid_arguments');
}

function trackedAndUntrackedFiles(root) {
  const output = execFileSync(
    'git',
    ['-C', root, 'ls-files', '-co', '--exclude-standard', '-z'],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  return output.split('\0').filter(Boolean);
}

function countOccurrences(content, needle) {
  let count = 0;
  let offset = 0;
  while ((offset = content.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

try {
  const root = parseRoot(process.argv.slice(2));
  const forbiddenVendorWording = '\u878d\u4e91';
  const violations = [];

  for (const file of trackedAndUntrackedFiles(root)) {
    const absolute = join(root, ...file.split('/'));
    if (!lstatSync(absolute).isFile()) continue;
    const count = countOccurrences(readFileSync(absolute, 'utf8'), forbiddenVendorWording);
    if (count > 0) {
      violations.push({
        file: relative(root, absolute).split(sep).join('/'),
        count,
      });
    }
  }

  if (violations.length > 0) {
    console.error('quukk project copy: forbidden_vendor_wording');
    for (const violation of violations) console.error(`  ${violation.file} (${violation.count})`);
    process.exitCode = 1;
  } else {
    console.log('Project copy policy clean.');
  }
} catch {
  console.error('quukk project copy: scan_failed');
  process.exitCode = 1;
}
