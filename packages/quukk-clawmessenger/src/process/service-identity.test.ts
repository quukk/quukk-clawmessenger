// @vitest-environment node

import { createHash } from 'node:crypto';
import {
  chmod as fsChmod,
  link as fsLink,
  mkdir,
  mkdtemp,
  open as fsOpen,
  readFile,
  readdir,
  rename,
  rm,
  unlink as fsUnlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { localPaths } from '../config/paths.js';
import * as serviceIdentityModule from './service-identity.js';
import {
  DaemonIdentitySchema,
  DaemonIdentityStore,
  type DaemonIdentityDependencies,
  type ReadyDaemonIdentity,
  type StartingDaemonIdentity,
} from './service-identity.js';

const TASK_TEMP_ROOT = 'D:\\A-DM\\dm-im\\.task-tmp';
const VERSION = '0.1.0-beta.1';
const STARTED_AT = '2026-08-27T08:00:00.000000123Z';
const INSTANCE_ID = `svc_${'a'.repeat(32)}`;
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
  const filePath = localPaths(home).daemonPid;
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  return filePath;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe('DaemonIdentityStore', () => {
  it('accepts only strict starting/ready identities', () => {
    expect(DaemonIdentitySchema.safeParse(starting()).success).toBe(true);
    expect(DaemonIdentitySchema.safeParse(ready()).success).toBe(true);
    expect(DaemonIdentitySchema.safeParse({ ...starting(), address: '127.0.0.1:1' }).success).toBe(false);
    expect(DaemonIdentitySchema.safeParse({ ...ready(), address: '0.0.0.0:49152' }).success).toBe(false);
    expect(DaemonIdentitySchema.safeParse({ ...ready(), instance_id: `svc_${'A'.repeat(32)}` }).success)
      .toBe(false);
  });

  it('does not export HTTP control credential derivation from the lifecycle module', () => {
    expect(serviceIdentityModule).not.toHaveProperty('deriveControlCredential');
  });

  it('claims daemon.pid exclusively, returns the raw digest, and enforces Unix modes', async () => {
    const filePath = await identityPath('claim');
    const lifecycleCalls: string[] = [];
    const chmodCalls: Array<{ path: string; mode: number }> = [];
    const dependencies: Partial<DaemonIdentityDependencies> = {
      platform: 'linux' as const,
      open: async (path, flags, mode) => {
        lifecycleCalls.push(`open:${String(flags)}`);
        return fsOpen(path, flags, mode);
      },
      mkdir: (async (...args: Parameters<typeof mkdir>) => {
        lifecycleCalls.push('mkdir');
        return mkdir(...args);
      }) as DaemonIdentityDependencies['mkdir'],
      chmod: async (path, mode) => {
        lifecycleCalls.push(`chmod:${String(path)}`);
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
    expect(lifecycleCalls[0]).toBe('open:wx');
    const snapshot = await first.read();
    expect(snapshot.identity).toEqual(starting());
    const raw = await readFile(filePath);
    expect(snapshot.contentDigest).toBe(createHash('sha256').update(raw).digest('hex'));
    expect(chmodCalls).toContainEqual({ path: filePath, mode: 0o600 });
  });

  it('gives an exclusive-claim loser no metadata write side effects', async () => {
    const filePath = await identityPath('claim-loser');
    await new DaemonIdentityStore({ filePath }).claim(starting());
    const lifecycleCalls: string[] = [];
    const loser = new DaemonIdentityStore({
      filePath,
      dependencies: {
        open: async (path, flags, mode) => {
          lifecycleCalls.push(`open:${String(flags)}`);
          return fsOpen(path, flags, mode);
        },
        mkdir: (async (...args: Parameters<typeof mkdir>) => {
          lifecycleCalls.push('mkdir');
          return mkdir(...args);
        }) as DaemonIdentityDependencies['mkdir'],
        chmod: async (path, mode) => {
          lifecycleCalls.push('chmod');
          await fsChmod(path, mode);
        },
        rename: async (source, destination) => {
          lifecycleCalls.push('rename');
          await rename(source, destination);
        },
        link: async (existingPath, newPath) => {
          lifecycleCalls.push('link');
          await fsLink(existingPath, newPath);
        },
        unlink: async (path) => {
          lifecycleCalls.push('unlink');
          await fsUnlink(path);
        },
      },
    });

    await expect(loser.claim(starting())).resolves.toBe(false);
    expect(lifecycleCalls).toEqual(['open:wx']);
    await expect(new DaemonIdentityStore({ filePath }).read())
      .resolves.toMatchObject({ identity: starting() });
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

  it('preserves the markReady tombstone when a replacement wins the restore race', async () => {
    const filePath = await identityPath('ready-restore-conflict');
    await new DaemonIdentityStore({ filePath }).claim(starting());
    const claimedReplacement = starting({ pid: 9876, instance_id: `svc_${'1'.repeat(32)}` });
    const canonicalReplacement = starting({ pid: 9877, instance_id: `svc_${'2'.repeat(32)}` });
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

    await expect(store.markReady(starting(), ready().address))
      .rejects.toMatchObject({ code: 'identity_conflict' });
    expect((await readdir(dirname(filePath))).filter((name) => name.startsWith('daemon.pid.claim-')))
      .toHaveLength(1);
    await expect(store.read()).rejects.toMatchObject({ code: 'identity_corrupt' });
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual(canonicalReplacement);
  });

  it('fails closed on an interrupted claim without recovering or cleaning it', async () => {
    const filePath = await identityPath('read-only');
    const creator = new DaemonIdentityStore({ filePath });
    await creator.claim(starting());
    const orphan = `${filePath}.claim-${process.pid}-${'b'.repeat(32)}`;
    await rename(filePath, orphan);
    const mutationCalls: string[] = [];
    const store = new DaemonIdentityStore({
      filePath,
      dependencies: {
        mkdir: (async (...args: Parameters<typeof mkdir>) => {
          mutationCalls.push('mkdir');
          return mkdir(...args);
        }) as DaemonIdentityDependencies['mkdir'],
        chmod: async (path, mode) => {
          mutationCalls.push('chmod');
          await fsChmod(path, mode);
        },
        rename: async (source, destination) => {
          mutationCalls.push('rename');
          await rename(source, destination);
        },
        link: async (existingPath, newPath) => {
          mutationCalls.push('link');
          await fsLink(existingPath, newPath);
        },
        unlink: async (path) => {
          mutationCalls.push('unlink');
          await fsUnlink(path);
        },
      },
    });

    await expect(store.read()).rejects.toMatchObject({ code: 'identity_corrupt' });
    expect(mutationCalls).toEqual([]);
    await expect(readFile(orphan, 'utf8')).resolves.toContain(INSTANCE_ID);
    await expect(readFile(filePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes only an exact identity', async () => {
    const filePath = await identityPath('remove');
    const store = new DaemonIdentityStore({ filePath });
    await store.claim(starting());

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

  it('preserves the remove tombstone when a replacement wins the restore race', async () => {
    const filePath = await identityPath('remove-restore-conflict');
    await new DaemonIdentityStore({ filePath }).claim(starting());
    const claimedReplacement = starting({ pid: 9876, instance_id: `svc_${'3'.repeat(32)}` });
    const canonicalReplacement = starting({ pid: 9877, instance_id: `svc_${'4'.repeat(32)}` });
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

    await expect(store.removeIfMatches(starting())).resolves.toBe(false);
    expect((await readdir(dirname(filePath))).filter((name) => name.startsWith('daemon.pid.claim-')))
      .toHaveLength(1);
    await expect(store.read()).rejects.toMatchObject({ code: 'identity_corrupt' });
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual(canonicalReplacement);
  });

  it('keeps exact quarantined metadata through a starting crash and cleans it only after ready', async () => {
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
    const staleName = (await readdir(dirname(filePath)))
      .find((name) => name.startsWith('daemon.pid.stale-'));
    expect(staleName).toBe(`daemon.pid.stale-${inspection.contentDigest}`);

    const replacement = starting({ pid: 9876, instance_id: `svc_${'c'.repeat(32)}` });
    const replacementStore = new DaemonIdentityStore({ filePath });
    await expect(replacementStore.claim(replacement)).resolves.toBe(true);
    await expect(replacementStore.read()).resolves.toMatchObject({ identity: replacement });
    expect((await readdir(dirname(filePath))).filter((name) => name.startsWith('daemon.pid.stale-')))
      .toHaveLength(1);
    const replacementReady: ReadyDaemonIdentity = {
      ...replacement,
      state: 'ready',
      address: ready().address,
    };
    await expect(new DaemonIdentityStore({ filePath }).markReady(replacement, replacementReady.address))
      .resolves.toEqual(replacementReady);
    expect((await readdir(dirname(filePath))).filter((name) => name.startsWith('daemon.pid.stale-')))
      .toEqual([]);
  });

  it('does not overwrite a quarantine artifact that appears after the initial scan', async () => {
    const filePath = await identityPath('quarantine-destination-race');
    const creator = new DaemonIdentityStore({ filePath });
    await creator.claim(starting());
    const inspection = await creator.read();
    const stalePath = `${filePath}.stale-${inspection.contentDigest}`;
    const competingArtifact = ready({
      pid: 9876,
      instance_id: `svc_${'5'.repeat(32)}`,
    });
    let injectArtifact = true;
    const injectCompetingArtifact = async (destination: unknown): Promise<void> => {
      if (String(destination) !== stalePath || !injectArtifact) return;
      injectArtifact = false;
      await writeFile(stalePath, `${JSON.stringify(competingArtifact)}\n`);
    };
    const store = new DaemonIdentityStore({
      filePath,
      dependencies: {
        rename: async (source, destination) => {
          await injectCompetingArtifact(destination);
          await rename(source, destination);
        },
        link: async (existing, destination) => {
          await injectCompetingArtifact(destination);
          await fsLink(existing, destination);
        },
      },
    });

    await expect(store.quarantineStaleIfExact({
      expected: starting(),
      contentDigest: inspection.contentDigest!,
    })).resolves.toBe(false);
    expect(JSON.parse(await readFile(stalePath, 'utf8'))).toEqual(competingArtifact);
    await expect(store.read()).resolves.toMatchObject({ identity: starting() });
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
