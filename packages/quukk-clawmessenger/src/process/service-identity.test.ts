// @vitest-environment node

import { createHash } from 'node:crypto';
import {
  chmod as fsChmod,
  link as fsLink,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { localPaths } from '../config/paths.js';
import {
  DaemonIdentitySchema,
  DaemonIdentityStore,
  deriveControlCredential,
  type DaemonIdentityDependencies,
  type ReadyDaemonIdentity,
  type StartingDaemonIdentity,
} from './service-identity.js';

const TASK_TEMP_ROOT = 'D:\\A-DM\\dm-im\\.task-tmp';
const VERSION = '0.1.0-beta.1';
const STARTED_AT = '2026-08-27T08:00:00.000000123Z';
const INSTANCE_ID = `svc_${'a'.repeat(32)}`;
const BRIDGE_SECRET = 'ERERERERERERERERERERERERERERERERERERERERERE';
const temporaryDirectories: string[] = [];

function starting(overrides: Partial<StartingDaemonIdentity> = {}): StartingDaemonIdentity {
  return {
    schema_version: 1,
    state: 'starting',
    pid: 4321,
    version: VERSION,
    instance_id: INSTANCE_ID,
    started_at: STARTED_AT,
    ...overrides,
  };
}

function ready(overrides: Partial<ReadyDaemonIdentity> = {}): ReadyDaemonIdentity {
  return {
    ...starting(),
    state: 'ready',
    address: '127.0.0.1:49152',
    ...overrides,
  };
}

async function identityPath(label: string): Promise<string> {
  await mkdir(TASK_TEMP_ROOT, { recursive: true });
  const home = await mkdtemp(join(TASK_TEMP_ROOT, `quukk-task11-${label}-`));
  temporaryDirectories.push(home);
  return localPaths(home).daemonPid;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe('DaemonIdentityStore', () => {
  it('accepts only strict starting/ready identities and derives the fixed control credential', () => {
    expect(DaemonIdentitySchema.safeParse(starting()).success).toBe(true);
    expect(DaemonIdentitySchema.safeParse(ready()).success).toBe(true);
    expect(DaemonIdentitySchema.safeParse({ ...starting(), address: '127.0.0.1:1' }).success).toBe(false);
    expect(DaemonIdentitySchema.safeParse({ ...ready(), address: '0.0.0.0:49152' }).success).toBe(false);
    expect(DaemonIdentitySchema.safeParse({ ...ready(), instance_id: `svc_${'A'.repeat(32)}` }).success)
      .toBe(false);

    const credential = deriveControlCredential(BRIDGE_SECRET, INSTANCE_ID);
    expect(credential).toBe('OXegnlCZKbx8PcFKvEPN__tdRzRTc3TtAad1rbqtuzE');
    expect(credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(credential).not.toContain(BRIDGE_SECRET);
    expect(deriveControlCredential(BRIDGE_SECRET, `svc_${'b'.repeat(32)}`)).not.toBe(credential);
    expect(() => deriveControlCredential('not-a-bridge-secret', INSTANCE_ID))
      .toThrow('control_credential_invalid');
  });

  it('claims daemon.pid exclusively, returns the raw digest, and enforces Unix modes', async () => {
    const filePath = await identityPath('claim');
    const chmodCalls: Array<{ path: string; mode: number }> = [];
    const dependencies: Partial<DaemonIdentityDependencies> = {
      platform: 'linux' as const,
      chmod: async (path, mode) => {
        chmodCalls.push({
          path: String(path),
          mode: typeof mode === 'string' ? Number.parseInt(mode, 8) : mode,
        });
        await fsChmod(path, mode);
      },
    };
    const first = new DaemonIdentityStore({ filePath, dependencies });
    const second = new DaemonIdentityStore({ filePath, dependencies });

    const results = await Promise.all([first.claim(starting()), second.claim(starting())]);
    expect([...results].sort()).toEqual([false, true]);
    const snapshot = await first.read();
    expect(snapshot.identity).toEqual(starting());
    const raw = await readFile(filePath);
    expect(snapshot.contentDigest).toBe(createHash('sha256').update(raw).digest('hex'));
    expect(chmodCalls).toContainEqual({ path: dirname(filePath), mode: 0o700 });
    expect(chmodCalls).toContainEqual({ path: filePath, mode: 0o600 });
  });

  it('marks ready only from the exact starting identity', async () => {
    const filePath = await identityPath('ready');
    const store = new DaemonIdentityStore({ filePath });
    await expect(store.claim(starting())).resolves.toBe(true);

    await expect(store.markReady(starting({ pid: 9999 }), '127.0.0.1:49152'))
      .rejects.toMatchObject({ code: 'identity_conflict' });
    await expect(store.read()).resolves.toMatchObject({ identity: starting() });
    await expect(store.markReady(starting(), '127.0.0.1:49152')).resolves.toEqual(ready());
    await expect(store.read()).resolves.toMatchObject({ identity: ready() });
  });

  it('rejects a semantically equal starting identity whose raw content changed', async () => {
    const filePath = await identityPath('ready-content-cas');
    const store = new DaemonIdentityStore({ filePath });
    await store.claim(starting());
    const rewritten = `${JSON.stringify(starting())}\n`;
    await writeFile(filePath, rewritten);

    await expect(store.markReady(starting(), ready().address))
      .rejects.toMatchObject({ code: 'identity_conflict' });
    await expect(readFile(filePath, 'utf8')).resolves.toBe(rewritten);
  });

  it('recovers one interrupted claim and removes only an exact identity', async () => {
    const filePath = await identityPath('remove');
    const store = new DaemonIdentityStore({ filePath });
    await store.claim(starting());
    const orphan = `${filePath}.claim-${process.pid}-${'b'.repeat(32)}`;
    await rename(filePath, orphan);

    await expect(store.read()).resolves.toMatchObject({ identity: starting() });
    await expect(store.removeIfMatches(starting({ pid: 9999 }))).resolves.toBe(false);
    await expect(store.read()).resolves.toMatchObject({ identity: starting() });
    await expect(store.removeIfMatches(starting())).resolves.toBe(true);
    await expect(store.read()).resolves.toEqual({});
  });

  it('does not remove a semantically equal identity whose raw content changed', async () => {
    const filePath = await identityPath('remove-content-cas');
    const store = new DaemonIdentityStore({ filePath });
    await store.claim(starting());
    const rewritten = `${JSON.stringify(starting())}\n`;
    await writeFile(filePath, rewritten);

    await expect(store.removeIfMatches(starting())).resolves.toBe(false);
    await expect(readFile(filePath, 'utf8')).resolves.toBe(rewritten);
  });

  it('quarantines stale metadata only for an exact identity and raw digest', async () => {
    const filePath = await identityPath('quarantine');
    const store = new DaemonIdentityStore({ filePath });
    await store.claim(starting());
    await store.markReady(starting(), ready().address);
    const inspection = await store.read();

    await expect(store.quarantineStaleIfExact({
      expected: ready(),
      contentDigest: '0'.repeat(64),
    })).resolves.toBe(false);
    await expect(store.read()).resolves.toMatchObject({ identity: ready() });
    await expect(store.quarantineStaleIfExact({
      expected: ready(),
      contentDigest: inspection.contentDigest!,
    })).resolves.toBe(true);
    await expect(store.read()).resolves.toEqual({});
    expect((await readdir(dirname(filePath))).filter((name) => name.startsWith('daemon.pid.stale-')))
      .toHaveLength(1);

    const replacement = starting({ pid: 9876, instance_id: `svc_${'c'.repeat(32)}` });
    await expect(store.claim(replacement)).resolves.toBe(true);
    await expect(store.read()).resolves.toMatchObject({ identity: replacement });
    expect((await readdir(dirname(filePath))).filter((name) => name.startsWith('daemon.pid.stale-')))
      .toEqual([]);
  });

  it('fails closed when daemon.pid changes after a stale quarantine claim', async () => {
    const filePath = await identityPath('cas-change');
    const original = new DaemonIdentityStore({ filePath });
    await original.claim(starting());
    const inspection = await original.read();
    const replacement = starting({ pid: 9876, instance_id: `svc_${'d'.repeat(32)}` });
    const store = new DaemonIdentityStore({
      filePath,
      dependencies: {
        rename: async (source, destination) => {
          await rename(source, destination);
          if (String(source) === filePath && String(destination).includes('.claim-')) {
            await writeFile(destination, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
          }
        },
      },
    });

    await expect(store.quarantineStaleIfExact({
      expected: starting(),
      contentDigest: inspection.contentDigest!,
    })).resolves.toBe(false);
    await expect(store.read()).resolves.toMatchObject({ identity: replacement });
  });

  it('preserves a quarantine claim when a replacement wins the restore race', async () => {
    const filePath = await identityPath('restore-conflict');
    const original = new DaemonIdentityStore({ filePath });
    await original.claim(starting());
    const inspection = await original.read();
    const claimedReplacement = starting({ pid: 9876, instance_id: `svc_${'e'.repeat(32)}` });
    const canonicalReplacement = starting({ pid: 9877, instance_id: `svc_${'f'.repeat(32)}` });
    let injectCanonical = true;
    const store = new DaemonIdentityStore({
      filePath,
      dependencies: {
        rename: async (source, destination) => {
          await rename(source, destination);
          if (String(source) === filePath && String(destination).includes('.claim-')) {
            await writeFile(destination, `${JSON.stringify(claimedReplacement)}\n`);
          }
        },
        link: async (existing, destination) => {
          if (injectCanonical) {
            injectCanonical = false;
            await writeFile(destination, `${JSON.stringify(canonicalReplacement)}\n`);
          }
          await fsLink(existing, destination);
        },
      },
    });

    await expect(store.quarantineStaleIfExact({
      expected: starting(),
      contentDigest: inspection.contentDigest!,
    })).resolves.toBe(false);
    expect((await readdir(dirname(filePath))).filter((name) => name.startsWith('daemon.pid.claim-')))
      .toHaveLength(1);
    await expect(store.read()).rejects.toMatchObject({ code: 'identity_corrupt' });
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual(canonicalReplacement);
    expect((await readdir(dirname(filePath))).filter((name) => name.startsWith('daemon.pid.claim-')))
      .toHaveLength(1);
  });

  it('fails closed on invalid, corrupt, or oversized identity content', async () => {
    const filePath = await identityPath('corrupt');
    const store = new DaemonIdentityStore({ filePath });
    await expect(store.claim(starting({ pid: 0 }) as StartingDaemonIdentity))
      .rejects.toMatchObject({ code: 'identity_invalid' });
    await mkdir(dirname(filePath), { recursive: true });
    const corrupt = `${JSON.stringify({ ...starting(), secret: 'must-stay-preserved' })}\n`;
    await writeFile(filePath, corrupt);
    await expect(store.read()).rejects.toMatchObject({ code: 'identity_corrupt' });
    await expect(readFile(filePath, 'utf8')).resolves.toBe(corrupt);

    await writeFile(filePath, Buffer.alloc(16_385, 0x78));
    await expect(store.read()).rejects.toMatchObject({ code: 'identity_corrupt' });
    expect(() => new DaemonIdentityStore({ filePath: localPaths(dirname(filePath)).bridgePid }))
      .toThrow('identity_invalid');
  });

  it('bounds directory scans and rejects multiple interrupted claims', async () => {
    const multiplePath = await identityPath('multiple-claims');
    await mkdir(dirname(multiplePath), { recursive: true });
    await Promise.all([
      writeFile(`${multiplePath}.claim-1-${'a'.repeat(32)}`, `${JSON.stringify(starting())}\n`),
      writeFile(`${multiplePath}.claim-2-${'b'.repeat(32)}`, `${JSON.stringify(starting({ pid: 2 }))}\n`),
    ]);
    await expect(new DaemonIdentityStore({ filePath: multiplePath }).read())
      .rejects.toMatchObject({ code: 'identity_corrupt' });

    const overflowPath = await identityPath('scan-overflow');
    await mkdir(dirname(overflowPath), { recursive: true });
    await Promise.all(Array.from({ length: 257 }, (_, index) =>
      writeFile(join(dirname(overflowPath), `unrelated-${String(index).padStart(3, '0')}`), 'x')));
    await expect(new DaemonIdentityStore({ filePath: overflowPath }).read())
      .rejects.toMatchObject({ code: 'identity_corrupt' });
  });
});
