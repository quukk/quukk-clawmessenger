// @vitest-environment node

import { createHash } from 'node:crypto';
import {
  chmod as fsChmod,
  link as fsLink,
  lstat as fsLstat,
  mkdir,
  mkdtemp,
  open as fsOpen,
  readFile,
  readdir,
  rename,
  rm,
  stat as fsStat,
  symlink,
  unlink as fsUnlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';

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

const TASK_TEMP_ROOT = join(tmpdir(), 'quukk-task11-service-identity');
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

function ioFailure(code = 'EACCES'): NodeJS.ErrnoException {
  return Object.assign(new Error('injected_identity_io_failure'), { code });
}

function postCreateFailureDependencies(
  phase: 'write' | 'sync' | 'chmod',
): Partial<DaemonIdentityDependencies> {
  let failed = false;
  return {
    platform: 'linux',
    open: async (path, flags, mode) => {
      const value = String(path);
      if (value.endsWith('daemon.pid.recovery')
        || value.includes(`daemon.pid.recovery${sep}`)) {
        const isDirectory = value.endsWith('daemon.pid.recovery');
        return {
          stat: async () => ({
            isDirectory: () => isDirectory,
            isFile: () => !isDirectory,
          }),
          chmod: async () => undefined,
          close: async () => undefined,
        } as unknown as Awaited<ReturnType<typeof fsOpen>>;
      }
      const handle = await fsOpen(path, flags, mode);
      if (String(flags) !== 'wx' || phase === 'chmod') return handle;
      return {
        writeFile: async (data: string) => {
          await handle.writeFile(data);
          if (phase === 'write' && !failed) {
            failed = true;
            throw ioFailure();
          }
        },
        sync: async () => {
          await handle.sync();
          if (phase === 'sync' && !failed) {
            failed = true;
            throw ioFailure();
          }
        },
        stat: (...args: Parameters<typeof handle.stat>) => handle.stat(...args),
        close: () => handle.close(),
      } as unknown as Awaited<ReturnType<typeof fsOpen>>;
    },
    chmod: async (path, mode) => {
      await fsChmod(path, mode);
      if (phase === 'chmod' && !failed) {
        failed = true;
        throw ioFailure();
      }
    },
  };
}

function partialWriteFailureDependencies(): Partial<DaemonIdentityDependencies> {
  let failed = false;
  return {
    open: async (path, flags, mode) => {
      const handle = await fsOpen(path, flags, mode);
      if (String(flags) !== 'wx' || failed) return handle;
      return {
        writeFile: async (data: string) => {
          failed = true;
          await handle.writeFile(data.slice(0, 17));
          throw ioFailure();
        },
        sync: () => handle.sync(),
        stat: (...args: Parameters<typeof handle.stat>) => handle.stat(...args),
        close: () => handle.close(),
      } as unknown as Awaited<ReturnType<typeof fsOpen>>;
    },
  };
}

async function quarantineReadyArtifact(filePath: string): Promise<string> {
  const store = new DaemonIdentityStore({ filePath });
  await store.claim(starting());
  await store.markReady(starting(), ready().address);
  const inspection = await store.read();
  await store.quarantineStaleIfExact({
    expected: ready(),
    contentDigest: inspection.contentDigest!,
  });
  return `${filePath}.stale-${inspection.contentDigest}`;
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

  it('removes its exact starting identity when a post-write artifact scan rejects', async () => {
    const filePath = await identityPath('claim-artifact-failure');
    const preexistingClaim = `${filePath}.claim-${process.pid}-${'6'.repeat(32)}`;
    await writeFile(preexistingClaim, `${JSON.stringify(starting({ pid: 9876 }))}\n`);
    const store = new DaemonIdentityStore({ filePath });

    await expect(store.claim(starting())).rejects.toMatchObject({ code: 'identity_corrupt' });
    await expect(readFile(filePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(preexistingClaim, 'utf8')).resolves.toContain('9876');
  });

  it.each(['write', 'sync', 'chmod'] as const)(
    'removes its exact starting identity after an injected %s failure',
    async (phase) => {
      const filePath = await identityPath(`claim-${phase}-failure`);
      const store = new DaemonIdentityStore({
        filePath,
        dependencies: postCreateFailureDependencies(phase),
      });

      await expect(store.claim(starting()))
        .rejects.toMatchObject({ code: 'identity_write_failed' });
      await expect(readFile(filePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await readdir(dirname(filePath)))
        .filter((name) => name.startsWith('daemon.pid.claim-'))).toEqual([]);
    },
  );

  it('removes its partial starting identity after writeFile writes then rejects', async () => {
    const filePath = await identityPath('claim-partial-write-failure');
    const store = new DaemonIdentityStore({
      filePath,
      dependencies: partialWriteFailureDependencies(),
    });

    await expect(store.claim(starting()))
      .rejects.toMatchObject({ code: 'identity_write_failed' });
    await expect(readFile(filePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(dirname(filePath)))
      .filter((name) => name.startsWith('daemon.pid.claim-'))).toEqual([]);
  });

  it('preserves a replacement that wins cleanup after a partial claim write', async () => {
    const filePath = await identityPath('claim-partial-write-replacement');
    const replacement = starting({ pid: 9877, instance_id: `svc_${'61'.repeat(16)}` });
    const dependencies = partialWriteFailureDependencies();
    const store = new DaemonIdentityStore({
      filePath,
      dependencies: {
        ...dependencies,
        rename: async (source, destination) => {
          await rename(source, destination);
          if (String(source) === filePath) {
            await writeFile(filePath, `${JSON.stringify(replacement)}\n`);
          }
        },
      },
    });

    await expect(store.claim(starting()))
      .rejects.toMatchObject({ code: 'identity_write_failed' });
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual(replacement);
    expect((await readdir(dirname(filePath)))
      .filter((name) => name.startsWith('daemon.pid.claim-'))).toEqual([]);
  });

  it('preserves an unproven file that replaces the partial-write cleanup tombstone', async () => {
    const filePath = await identityPath('claim-partial-write-rogue');
    const rogue = starting({ pid: 9878, instance_id: `svc_${'62'.repeat(16)}` });
    const dependencies = partialWriteFailureDependencies();
    let cleanupPath: string | undefined;
    let recoveryPath: string | undefined;
    const store = new DaemonIdentityStore({
      filePath,
      dependencies: {
        ...dependencies,
        rename: async (source, destination) => {
          await rename(source, destination);
          if (String(source) === filePath) {
            cleanupPath = String(destination);
            await fsUnlink(destination);
            await writeFile(destination, `${JSON.stringify(rogue)}\n`);
          } else if (String(source) === cleanupPath) {
            recoveryPath = String(destination);
          }
        },
      },
    });

    await expect(store.claim(starting()))
      .rejects.toMatchObject({ code: 'identity_write_failed' });
    expect(recoveryPath).toBeDefined();
    expect(JSON.parse(await readFile(recoveryPath!, 'utf8'))).toEqual(rogue);
    await expect(readFile(filePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(dirname(filePath)))
      .filter((name) => name.startsWith('daemon.pid.claim-'))).toEqual([]);
  });

  it('preserves a replacement swapped in after ownership stat and before cleanup', async () => {
    const filePath = await identityPath('claim-partial-write-stat-race');
    const rogue = starting({ pid: 9879, instance_id: `svc_${'63'.repeat(16)}` });
    let cleanupPath: string | undefined;
    let recoveryPath: string | undefined;
    let writeFailed = false;
    let swappedAfterStat = false;
    const store = new DaemonIdentityStore({
      filePath,
      dependencies: {
        open: async (path, flags, mode) => {
          const handle = await fsOpen(path, flags, mode);
          if (String(flags) === 'wx' && !writeFailed) {
            return {
              writeFile: async (data: string) => {
                writeFailed = true;
                await handle.writeFile(data.slice(0, 17));
                throw ioFailure();
              },
              sync: () => handle.sync(),
              stat: (...args: Parameters<typeof handle.stat>) => handle.stat(...args),
              close: () => handle.close(),
            } as unknown as Awaited<ReturnType<typeof fsOpen>>;
          }
          if (String(path) === cleanupPath && String(flags) === 'r') {
            return {
              stat: async (...args: Parameters<typeof handle.stat>) => {
                const result = await handle.stat(...args);
                await handle.close();
                await fsUnlink(path);
                await writeFile(path, `${JSON.stringify(rogue)}\n`);
                swappedAfterStat = true;
                return result;
              },
              close: () => handle.close(),
            } as unknown as Awaited<ReturnType<typeof fsOpen>>;
          }
          return handle;
        },
        rename: async (source, destination) => {
          await rename(source, destination);
          if (String(source) === filePath) cleanupPath = String(destination);
          if (String(source) === cleanupPath) recoveryPath = String(destination);
        },
      },
    });

    await expect(store.claim(starting()))
      .rejects.toMatchObject({ code: 'identity_write_failed' });
    expect(swappedAfterStat).toBe(true);
    expect(recoveryPath).toBeDefined();
    expect(JSON.parse(await readFile(recoveryPath!, 'utf8'))).toEqual(rogue);
    await expect(readFile(filePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses bigint file identity when numeric inode values would collide', async () => {
    const filePath = await identityPath('claim-partial-write-bigint');
    const rogue = starting({ pid: 9880, instance_id: `svc_${'64'.repeat(16)}` });
    const ownInode = 22_236_523_163_565_440n;
    const rogueInode = ownInode + 1n;
    expect(Number(ownInode)).toBe(Number(rogueInode));
    let cleanupPath: string | undefined;
    let recoveryPath: string | undefined;
    let writeFailed = false;
    const statOptions: unknown[] = [];
    let statCalls = 0;
    const store = new DaemonIdentityStore({
      filePath,
      dependencies: {
        open: async (path, flags, mode) => {
          const handle = await fsOpen(path, flags, mode);
          const inode = statCalls++ === 0 ? ownInode : rogueInode;
          const stat = async (options?: { bigint?: boolean }) => {
            statOptions.push(options);
            return options?.bigint
              ? { birthtimeMs: 0n, dev: 0n, ino: inode }
              : { birthtimeMs: 0, dev: 0, ino: Number(inode) };
          };
          if (String(flags) === 'wx' && !writeFailed) {
            return {
              writeFile: async (data: string) => {
                writeFailed = true;
                await handle.writeFile(data.slice(0, 17));
                throw ioFailure();
              },
              sync: () => handle.sync(),
              stat,
              close: () => handle.close(),
            } as unknown as Awaited<ReturnType<typeof fsOpen>>;
          }
          return {
            stat,
            close: () => handle.close(),
          } as unknown as Awaited<ReturnType<typeof fsOpen>>;
        },
        rename: async (source, destination) => {
          await rename(source, destination);
          if (String(source) === filePath) {
            cleanupPath = String(destination);
            await fsUnlink(destination);
            await writeFile(destination, `${JSON.stringify(rogue)}\n`);
          } else if (String(source) === cleanupPath) {
            recoveryPath = String(destination);
          }
        },
      },
    });

    await expect(store.claim(starting()))
      .rejects.toMatchObject({ code: 'identity_write_failed' });
    expect(statOptions).toEqual([{ bigint: true }, { bigint: true }]);
    expect(recoveryPath).toContain('daemon.pid.recovery');
    expect(recoveryPath).toContain('write-unverified-');
    expect(JSON.parse(await readFile(recoveryPath!, 'utf8'))).toEqual(rogue);
  });

  it('bounds recovery garbage by entry count and total bytes across repeated lifecycles', async () => {
    const filePath = await identityPath('recovery-bounds');
    const recoveryDirectory = `${filePath}.recovery`;
    await mkdir(recoveryDirectory, { mode: 0o700 });
    await Promise.all(Array.from({ length: 32 }, (_, index) =>
      writeFile(
        join(recoveryDirectory, `retired-${index.toString(16).padStart(32, '0')}.json`),
        Buffer.alloc(40_000, 0x78),
      )));
    await writeFile(join(recoveryDirectory, 'unmanaged.keep'), 'preserve');
    await mkdir(join(recoveryDirectory, `retired-${'f'.repeat(32)}.json`));
    const outsideRecovery = join(dirname(recoveryDirectory), 'outside-recovery');
    await mkdir(outsideRecovery);
    await writeFile(join(outsideRecovery, 'sentinel'), 'outside');
    const recoverySymlink = join(recoveryDirectory, `retired-${'e'.repeat(32)}.json`);
    await symlink(outsideRecovery, recoverySymlink, process.platform === 'win32' ? 'junction' : 'dir');

    const store = new DaemonIdentityStore({ filePath });
    for (let index = 1; index <= 18; index += 1) {
      const cycleStarting = starting({
        pid: 5000 + index,
        instance_id: `svc_${index.toString(16).padStart(32, '0')}`,
      });
      const cycleReady: ReadyDaemonIdentity = {
        ...cycleStarting,
        state: 'ready',
        address: ready().address,
      };
      await store.claim(cycleStarting);
      await store.markReady(cycleStarting, cycleReady.address);
      await store.removeIfMatches(cycleReady);
    }

    const managed = (await Promise.all((await readdir(recoveryDirectory))
      .filter((name) => /^(?:retired|write-(?:owned|unverified))-[0-9a-f]{32}\.json$/.test(name))
      .map(async (name) => ({ name, metadata: await fsStat(join(recoveryDirectory, name)) }))))
      .filter(({ metadata }) => metadata.isFile());
    const sizes = managed.map(({ metadata }) => metadata.size);
    expect(managed).toHaveLength(32);
    expect(sizes.reduce((total, size) => total + size, 0)).toBeLessThanOrEqual(1_048_576);
    await expect(readFile(join(recoveryDirectory, 'unmanaged.keep'), 'utf8'))
      .resolves.toBe('preserve');
    await expect(fsStat(join(recoveryDirectory, `retired-${'f'.repeat(32)}.json`)))
      .resolves.toMatchObject({ isDirectory: expect.any(Function) });
    expect((await fsLstat(recoverySymlink)).isSymbolicLink()).toBe(true);
    await expect(readFile(join(outsideRecovery, 'sentinel'), 'utf8')).resolves.toBe('outside');
  });

  it('fails safe on recovery pruning errors without permanently blocking a new claim', async () => {
    const filePath = await identityPath('recovery-prune-failure');
    const recoveryDirectory = `${filePath}.recovery`;
    await mkdir(recoveryDirectory, { mode: 0o700 });
    await Promise.all(Array.from({ length: 33 }, (_, index) =>
      writeFile(
        join(recoveryDirectory, `retired-${index.toString(16).padStart(32, '0')}.json`),
        'garbage',
      )));
    const store = new DaemonIdentityStore({
      filePath,
      dependencies: {
        unlink: async (path) => {
          if (String(path).startsWith(`${recoveryDirectory}${sep}`)) throw ioFailure();
          await fsUnlink(path);
        },
      },
    });
    const cycleStarting = starting({ pid: 9882, instance_id: `svc_${'66'.repeat(16)}` });
    const cycleReady: ReadyDaemonIdentity = {
      ...cycleStarting,
      state: 'ready',
      address: ready().address,
    };
    await store.claim(cycleStarting);

    await expect(store.markReady(cycleStarting, cycleReady.address)).resolves.toEqual(cycleReady);
    await expect(store.removeIfMatches(cycleReady))
      .rejects.toMatchObject({ code: 'identity_write_failed' });
    await expect(readFile(filePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(dirname(filePath)))
      .filter((name) => name.startsWith('daemon.pid.claim-'))).toEqual([]);
    const nextStarting = starting({ pid: 9883, instance_id: `svc_${'67'.repeat(16)}` });
    await expect(store.claim(nextStarting)).resolves.toBe(true);
  });

  it('hardens an existing recovery directory and every moved artifact on Unix', async () => {
    const filePath = await identityPath('recovery-permissions');
    const recoveryDirectory = `${filePath}.recovery`;
    await mkdir(recoveryDirectory, { mode: 0o777 });
    const recoveryChmods: Array<{ mode: number; path: string }> = [];
    const store = new DaemonIdentityStore({
      filePath,
      dependencies: {
        platform: 'linux',
        open: async (path, flags, mode) => {
          const value = String(path);
          if (value === recoveryDirectory || value.startsWith(`${recoveryDirectory}${sep}`)) {
            return {
              stat: async () => ({
                isDirectory: () => value === recoveryDirectory,
                isFile: () => value !== recoveryDirectory,
              }),
              chmod: async (nextMode: number) => {
                recoveryChmods.push({ mode: nextMode, path: value });
              },
              close: async () => undefined,
            } as unknown as Awaited<ReturnType<typeof fsOpen>>;
          }
          return fsOpen(path, flags, mode);
        },
      },
    });
    const cycleStarting = starting({ pid: 9881, instance_id: `svc_${'65'.repeat(16)}` });
    const cycleReady: ReadyDaemonIdentity = {
      ...cycleStarting,
      state: 'ready',
      address: ready().address,
    };

    await store.claim(cycleStarting);
    await store.markReady(cycleStarting, cycleReady.address);
    await store.removeIfMatches(cycleReady);

    expect(recoveryChmods.filter((call) => call.path === recoveryDirectory))
      .toEqual([{ path: recoveryDirectory, mode: 0o700 }, { path: recoveryDirectory, mode: 0o700 }]);
    expect(recoveryChmods.filter((call) => call.path !== recoveryDirectory))
      .toHaveLength(2);
    expect(recoveryChmods.filter((call) => call.path !== recoveryDirectory)
      .every((call) => call.mode === 0o600)).toBe(true);
  });

  it('removes only its own failed claim when a replacement wins cleanup', async () => {
    const filePath = await identityPath('claim-cleanup-replacement');
    const preexistingClaim = `${filePath}.claim-${process.pid}-${'7'.repeat(32)}`;
    await writeFile(preexistingClaim, `${JSON.stringify(starting({ pid: 9876 }))}\n`);
    const replacement = starting({ pid: 9877, instance_id: `svc_${'6'.repeat(32)}` });
    let injectedReplacement = false;
    const store = new DaemonIdentityStore({
      filePath,
      dependencies: {
        rename: async (source, destination) => {
          await rename(source, destination);
          if (!injectedReplacement && String(source) === filePath) {
            injectedReplacement = true;
            await writeFile(filePath, `${JSON.stringify(replacement)}\n`);
          }
        },
      },
    });

    await expect(store.claim(starting())).rejects.toMatchObject({ code: 'identity_corrupt' });
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual(replacement);
    expect((await readdir(dirname(filePath)))
      .filter((name) => name.startsWith('daemon.pid.claim-'))).toEqual([
      preexistingClaim.split(/[\\/]/).at(-1),
    ]);
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

  it('returns durable ready and preserves stale evidence when its digest is tampered', async () => {
    const filePath = await identityPath('ready-stale-digest');
    const stalePath = await quarantineReadyArtifact(filePath);
    await writeFile(stalePath, `${JSON.stringify(ready({
      pid: 9876,
      instance_id: `svc_${'8'.repeat(32)}`,
    }))}\n`);
    const nextStarting = starting({ pid: 9877, instance_id: `svc_${'9'.repeat(32)}` });
    const nextReady: ReadyDaemonIdentity = {
      ...nextStarting,
      state: 'ready',
      address: ready().address,
    };
    const store = new DaemonIdentityStore({ filePath });
    await store.claim(nextStarting);
    let upperRollbackAttempted = false;
    const transition = store.markReady(nextStarting, nextReady.address).catch(async (error: unknown) => {
      upperRollbackAttempted = true;
      await store.removeIfMatches(nextStarting);
      throw error;
    });

    await expect(transition).resolves.toEqual(nextReady);
    expect(upperRollbackAttempted).toBe(false);
    await expect(store.read()).resolves.toMatchObject({ identity: nextReady });
    const artifacts = await readdir(dirname(filePath));
    expect(artifacts.filter((name) => name.startsWith('daemon.pid.claim-'))).toEqual([]);
    expect(artifacts.filter((name) => name.startsWith('daemon.pid.stale-'))).toHaveLength(1);
  });

  it('returns durable ready with stale evidence when cleanup retirement fails', async () => {
    const filePath = await identityPath('ready-stale-retirement');
    await quarantineReadyArtifact(filePath);
    const nextStarting = starting({ pid: 9877, instance_id: `svc_${'a1'.repeat(16)}` });
    const nextReady: ReadyDaemonIdentity = {
      ...nextStarting,
      state: 'ready',
      address: ready().address,
    };
    const store = new DaemonIdentityStore({
      filePath,
      dependencies: {
        rename: async (source, destination) => {
          if (String(source).includes('-cleanup-')
            && String(destination).includes('daemon.pid.recovery')) {
            throw ioFailure();
          }
          await rename(source, destination);
        },
      },
    });
    await store.claim(nextStarting);

    await expect(store.markReady(nextStarting, nextReady.address)).resolves.toEqual(nextReady);
    await expect(store.read()).resolves.toMatchObject({ identity: nextReady });
    const artifacts = await readdir(dirname(filePath));
    expect(artifacts.filter((name) => name.startsWith('daemon.pid.claim-'))).toEqual([]);
    expect(artifacts.filter((name) => name.startsWith('daemon.pid.stale-'))).toHaveLength(1);
  });

  it('rolls back its exact ready identity when starting tombstone retirement fails', async () => {
    const filePath = await identityPath('ready-starting-retirement');
    const nextStarting = starting({ pid: 9877, instance_id: `svc_${'a2'.repeat(16)}` });
    const nextReady: ReadyDaemonIdentity = {
      ...nextStarting,
      state: 'ready',
      address: ready().address,
    };
    let failed = false;
    const store = new DaemonIdentityStore({
      filePath,
      dependencies: {
        rename: async (source, destination) => {
          if (!failed
            && String(source).includes('.claim-')
            && String(destination).includes('daemon.pid.recovery')) {
            failed = true;
            throw ioFailure();
          }
          await rename(source, destination);
        },
      },
    });
    await store.claim(nextStarting);

    await expect(store.markReady(nextStarting, nextReady.address))
      .rejects.toMatchObject({ code: 'identity_write_failed' });
    await expect(readFile(filePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const claims = (await readdir(dirname(filePath)))
      .filter((name) => name.startsWith('daemon.pid.claim-'));
    expect(claims).toHaveLength(1);
    expect(JSON.parse(await readFile(join(dirname(filePath), claims[0]!), 'utf8')))
      .toEqual(nextStarting);
  });

  it('returns durable ready when stale cleanup rename fails before mutation', async () => {
    const filePath = await identityPath('ready-stale-rename');
    await quarantineReadyArtifact(filePath);
    const nextStarting = starting({ pid: 9877, instance_id: `svc_${'b1'.repeat(16)}` });
    const nextReady: ReadyDaemonIdentity = {
      ...nextStarting,
      state: 'ready',
      address: ready().address,
    };
    const store = new DaemonIdentityStore({
      filePath,
      dependencies: {
        rename: async (source, destination) => {
          if (String(source).includes('.stale-')) throw ioFailure();
          await rename(source, destination);
        },
      },
    });
    await store.claim(nextStarting);

    await expect(store.markReady(nextStarting, nextReady.address)).resolves.toEqual(nextReady);
    await expect(store.read()).resolves.toMatchObject({ identity: nextReady });
    const artifacts = await readdir(dirname(filePath));
    expect(artifacts.filter((name) => name.startsWith('daemon.pid.claim-'))).toEqual([]);
    expect(artifacts.filter((name) => name.startsWith('daemon.pid.stale-'))).toHaveLength(1);
  });

  it('never succeeds with a cleanup claim when stale restoration fails', async () => {
    const filePath = await identityPath('ready-stale-restore');
    const stalePath = await quarantineReadyArtifact(filePath);
    await writeFile(stalePath, `${JSON.stringify(ready({
      pid: 9876,
      instance_id: `svc_${'c1'.repeat(16)}`,
    }))}\n`);
    const nextStarting = starting({ pid: 9877, instance_id: `svc_${'d1'.repeat(16)}` });
    const nextReady: ReadyDaemonIdentity = {
      ...nextStarting,
      state: 'ready',
      address: ready().address,
    };
    const store = new DaemonIdentityStore({
      filePath,
      dependencies: {
        link: async (existing, destination) => {
          if (String(destination) === stalePath) throw ioFailure();
          await fsLink(existing, destination);
        },
      },
    });
    await store.claim(nextStarting);

    await expect(store.markReady(nextStarting, nextReady.address)).resolves.toEqual(nextReady);
    await expect(store.read()).resolves.toMatchObject({ identity: nextReady });
    const artifacts = await readdir(dirname(filePath));
    expect(artifacts.filter((name) => name.startsWith('daemon.pid.claim-'))).toEqual([]);
    expect(artifacts.filter((name) => name.startsWith('daemon.pid.stale-'))).toHaveLength(1);
  });

  it('rejects when a claim artifact appears during stale cleanup', async () => {
    const filePath = await identityPath('ready-stale-claim-race');
    await quarantineReadyArtifact(filePath);
    const nextStarting = starting({ pid: 9877, instance_id: `svc_${'11'.repeat(16)}` });
    const nextReady: ReadyDaemonIdentity = {
      ...nextStarting,
      state: 'ready',
      address: ready().address,
    };
    const competingClaim = `${filePath}.claim-${process.pid}-${'8'.repeat(32)}`;
    let injectedClaim = false;
    const store = new DaemonIdentityStore({
      filePath,
      dependencies: {
        rename: async (source, destination) => {
          await rename(source, destination);
          if (!injectedClaim && String(source).includes('.stale-')) {
            injectedClaim = true;
            await writeFile(competingClaim, `${JSON.stringify(starting({ pid: 9878 }))}\n`);
          }
        },
      },
    });
    await store.claim(nextStarting);

    await expect(store.markReady(nextStarting, nextReady.address))
      .rejects.toMatchObject({ code: 'identity_conflict' });
    await expect(readFile(filePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(store.read()).rejects.toMatchObject({ code: 'identity_corrupt' });
    expect((await readdir(dirname(filePath)))
      .filter((name) => name.startsWith('daemon.pid.claim-'))).toEqual([
      competingClaim.split(/[\\/]/).at(-1),
    ]);
  });

  it('preserves a canonical replacement that wins ready rollback beside a rogue claim', async () => {
    const filePath = await identityPath('ready-rollback-replacement');
    await quarantineReadyArtifact(filePath);
    const nextStarting = starting({ pid: 9877, instance_id: `svc_${'12'.repeat(16)}` });
    const nextReady: ReadyDaemonIdentity = {
      ...nextStarting,
      state: 'ready',
      address: ready().address,
    };
    const replacement = ready({ pid: 9878, instance_id: `svc_${'13'.repeat(16)}` });
    const competingClaim = `${filePath}.claim-${process.pid}-${'9'.repeat(32)}`;
    let injectedClaim = false;
    let injectedReplacement = false;
    const store = new DaemonIdentityStore({
      filePath,
      dependencies: {
        rename: async (source, destination) => {
          await rename(source, destination);
          if (!injectedClaim && String(source).includes('.stale-')) {
            injectedClaim = true;
            await writeFile(competingClaim, `${JSON.stringify(starting({ pid: 9879 }))}\n`);
          } else if (injectedClaim && !injectedReplacement && String(source) === filePath) {
            injectedReplacement = true;
            await writeFile(filePath, `${JSON.stringify(replacement)}\n`);
          }
        },
      },
    });
    await store.claim(nextStarting);

    await expect(store.markReady(nextStarting, nextReady.address))
      .rejects.toMatchObject({ code: 'identity_conflict' });
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual(replacement);
    expect((await readdir(dirname(filePath)))
      .filter((name) => name.startsWith('daemon.pid.claim-'))).toEqual([
      competingClaim.split(/[\\/]/).at(-1),
    ]);
  });

  it('rejects stale cleanup when canonical ready is replaced and preserves the replacement', async () => {
    const filePath = await identityPath('ready-stale-replacement');
    await quarantineReadyArtifact(filePath);
    const nextStarting = starting({ pid: 9877, instance_id: `svc_${'e1'.repeat(16)}` });
    const replacement = ready({ pid: 9878, instance_id: `svc_${'f1'.repeat(16)}` });
    let injectedReplacement = false;
    const store = new DaemonIdentityStore({
      filePath,
      dependencies: {
        rename: async (source, destination) => {
          await rename(source, destination);
          if (!injectedReplacement && String(source).includes('.stale-')) {
            injectedReplacement = true;
            await writeFile(filePath, `${JSON.stringify(replacement)}\n`);
          }
        },
      },
    });
    await store.claim(nextStarting);

    await expect(store.markReady(nextStarting, ready().address))
      .rejects.toMatchObject({ code: 'identity_conflict' });
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual(replacement);
    const artifacts = await readdir(dirname(filePath));
    expect(artifacts.filter((name) => name.startsWith('daemon.pid.claim-'))).toEqual([]);
    expect(artifacts.filter((name) => name.startsWith('daemon.pid.stale-'))).toHaveLength(1);
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
