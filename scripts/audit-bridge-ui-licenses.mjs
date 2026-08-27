import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'vite';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bridgeRoot = join(root, 'apps', 'bridge');
const inventoryPath = join(bridgeRoot, 'bundled-licenses.json');
const noticePath = join(root, 'THIRD_PARTY_NOTICES.md');

function fail(code, details = []) {
  const suffix = details.length === 0 ? '' : `: ${details.join(', ')}`;
  console.error(`${code}${suffix}`);
  process.exitCode = 1;
}

function packageForModule(moduleId) {
  let current = dirname(moduleId.split('?')[0]);
  const driveRoot = parse(current).root;
  while (current !== driveRoot) {
    const manifestPath = join(current, 'package.json');
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (typeof manifest.name === 'string' && typeof manifest.version === 'string') {
        const licenseFile = readdirSync(current)
          .filter((entry) => /^licen[sc]e(?:\.|$)/i.test(entry))
          .sort((left, right) => left.localeCompare(right))[0];
        if (licenseFile === undefined) {
          return { key: `${manifest.name}@${manifest.version}`, error: 'license_file_missing' };
        }
        const licenseBytes = readFileSync(join(current, licenseFile));
        return {
          key: `${manifest.name}@${manifest.version}`,
          value: {
            name: manifest.name,
            version: manifest.version,
            license: manifest.license,
            licenseFile,
            licenseSha256: createHash('sha256').update(licenseBytes).digest('hex'),
            licenseText: licenseBytes.toString('utf8'),
          },
        };
      }
    }
    current = dirname(current);
  }
  return { key: 'unknown', error: 'package_manifest_missing' };
}

const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
const expected = new Map(
  inventory.packages.map((entry) => [`${entry.name}@${entry.version}`, entry]),
);

const result = await build({
  root: bridgeRoot,
  configFile: join(bridgeRoot, 'vite.config.ts'),
  build: { write: false },
  logLevel: 'silent',
});
const outputs = Array.isArray(result) ? result : [result];
const moduleIds = new Set(
  outputs.flatMap((output) =>
    output.output.flatMap((entry) => (entry.type === 'chunk' ? Object.keys(entry.modules) : [])),
  ),
);
const actual = new Map();
const discoveryErrors = [];
for (const moduleId of moduleIds) {
  if (!moduleId.includes('node_modules')) continue;
  const found = packageForModule(moduleId);
  if (found.error !== undefined) {
    discoveryErrors.push(`${found.error}:${found.key}`);
    continue;
  }
  const previous = actual.get(found.key);
  if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(found.value)) {
    discoveryErrors.push(`package_metadata_conflict:${found.key}`);
    continue;
  }
  actual.set(found.key, found.value);
}

if (discoveryErrors.length > 0) fail('ui_license_discovery_failed', discoveryErrors.sort());

const missing = [...actual.keys()].filter((key) => !expected.has(key)).sort();
const stale = [...expected.keys()].filter((key) => !actual.has(key)).sort();
if (missing.length > 0) fail('ui_license_inventory_missing', missing);
if (stale.length > 0) fail('ui_license_inventory_stale', stale);

const mismatches = [];
for (const [key, expectedEntry] of expected) {
  const actualEntry = actual.get(key);
  if (actualEntry === undefined) continue;
  for (const field of ['name', 'version', 'license', 'licenseFile', 'licenseSha256']) {
    if (actualEntry[field] !== expectedEntry[field]) mismatches.push(`${key}:${field}`);
  }
}
if (mismatches.length > 0) fail('ui_license_metadata_mismatch', mismatches.sort());

const notice = readFileSync(noticePath, 'utf8');
const normalizedNotice = notice.replace(/\s+/g, ' ').trim();
const absentNoticeMarkers = [];
for (const [key, entry] of expected) {
  const packageMarker = `\`${entry.name}@${entry.version}\``;
  if (!notice.includes(packageMarker)) absentNoticeMarkers.push(packageMarker);
  if (!notice.includes(entry.licenseSha256)) absentNoticeMarkers.push(entry.licenseSha256);
  const licenseText = actual.get(key)?.licenseText;
  if (
    licenseText !== undefined &&
    !normalizedNotice.includes(licenseText.replace(/\s+/g, ' ').trim())
  ) {
    absentNoticeMarkers.push(`license_text:${key}`);
  }
}
if (absentNoticeMarkers.length > 0) {
  fail('ui_license_notice_incomplete', absentNoticeMarkers.sort());
}

if (process.exitCode === undefined) {
  console.log(`Bridge UI license inventory verified (${actual.size} packages).`);
}
