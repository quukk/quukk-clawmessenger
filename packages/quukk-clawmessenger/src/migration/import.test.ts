import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { localPaths } from '../config/paths.js';
import { LocalStore } from '../config/store.js';
import {
  discoverLegacyConfigs,
  legacyConfigPaths,
  type LegacyConfigCandidate,
} from './discover.js';
import { importLegacyConfig } from './import.js';

const temporaryHomes: string[] = [];

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'quukk-migration-'));
  temporaryHomes.push(home);
  return home;
}

afterEach(async () => {
  await Promise.all(
    temporaryHomes.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function candidate(
  path: string,
  workdir: string,
  overrides: Partial<LegacyConfigCandidate['settings']> = {},
): LegacyConfigCandidate {
  return {
    source: 'opencode-clawmessenger',
    path,
    status: 'importable',
    settings: {
      serverUrl: 'https://bridge.example.test/im',
      defaultWorkdir: workdir,
      authorizedWorkRoots: [workdir],
      providerPathOverrides: {},
      ...overrides,
    },
  };
}

describe('legacy OpenCode ClawMessenger migration', () => {
  it('derives only the four fixed paths from an explicit home directory', () => {
    const home = process.platform === 'win32' ? 'Q:\\migration-home' : '/migration-home';

    expect(legacyConfigPaths(home)).toEqual({
      settings: join(home, '.config', 'opencode', 'clawmessenger.json'),
      registration: join(home, '.claw-bridge', 'opencode', 'opencode-config.json'),
      previousRegistration: join(home, '.claw-bridge', 'opencode', 'config.json'),
      sharedLegacyRegistration: join(home, '.claw-bridge', 'config.json'),
    });
    expect(() => legacyConfigPaths('relative-home')).toThrowError('invalid_home');
  });

  it('projects safe settings and never returns legacy credentials, node identity, or logs', async () => {
    const home = await temporaryHome();
    const paths = legacyConfigPaths(home);
    const workdir = join(home, 'workspace');
    const opencode = join(home, 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode');
    await mkdir(workdir, { recursive: true });
    await mkdir(dirname(opencode), { recursive: true });
    await writeFile(opencode, 'fixture');
    await writeJson(paths.settings, {
      appKey: 'legacy-app-key-never-return',
      appSecret: 'legacy-app-secret-never-return',
      token: 'legacy-token-never-return',
      accountId: 'legacy-node-never-return',
      nodeName: 'legacy-name',
      serverUrl: 'https://bridge.example.test/im/',
      opencodeUrl: 'http://127.0.0.1:4096',
      opencodeDir: workdir,
      opencodePassword: 'legacy-password-never-return',
      apiBaseUrl: 'https://bridge.example.test/api',
      chatTimeout: 600,
      autoApprove: false,
      botName: 'opencode',
      showProcess: 'none',
      hooks: { onSessionCreated: 'safe-but-not-imported' },
      providerPathOverrides: { opencode },
    });
    for (const path of [paths.registration, paths.previousRegistration, paths.sharedLegacyRegistration]) {
      await writeJson(path, {
        nodeId: 'opencode_node-never-return',
        token: 'registration-token-never-return',
        macAddress: '00:11:22:33:44:55',
      });
    }

    const result = await discoverLegacyConfigs(home);

    expect(result).toEqual([
      {
        source: 'opencode-clawmessenger',
        path: paths.settings,
        status: 'importable',
        settings: {
          serverUrl: 'https://bridge.example.test/im',
          defaultWorkdir: workdir,
          authorizedWorkRoots: [workdir],
          providerPathOverrides: { opencode },
        },
      },
      {
        source: 'opencode-registration',
        path: paths.registration,
        status: 'credentials_excluded',
      },
      {
        source: 'opencode-registration-previous',
        path: paths.previousRegistration,
        status: 'credentials_excluded',
      },
      {
        source: 'shared-registration-legacy',
        path: paths.sharedLegacyRegistration,
        status: 'credentials_excluded',
      },
    ]);
    const serialized = JSON.stringify(result);
    for (const forbidden of [
      'legacy-app-key-never-return',
      'legacy-app-secret-never-return',
      'legacy-token-never-return',
      'legacy-node-never-return',
      'legacy-password-never-return',
      'registration-token-never-return',
      'opencode_node-never-return',
      '00:11:22:33:44:55',
    ]) expect(serialized).not.toContain(forbidden);
  });

  it('preserves an explicit null legacy workdir instead of treating it as absent', async () => {
    const home = await temporaryHome();
    const paths = legacyConfigPaths(home);
    await writeJson(paths.settings, {
      defaultWorkdir: null,
      authorizedWorkRoots: [],
    });

    await expect(discoverLegacyConfigs(home)).resolves.toEqual([{
      source: 'opencode-clawmessenger',
      path: paths.settings,
      status: 'importable',
      settings: {
        defaultWorkdir: null,
        authorizedWorkRoots: [],
        providerPathOverrides: {},
      },
    }]);
  });

  it('marks unknown, malformed, oversized, and symlinked settings as invalid without leaking input', async () => {
    const home = await temporaryHome();
    const paths = legacyConfigPaths(home);
    await mkdir(dirname(paths.settings), { recursive: true });

    for (const content of [
      '{not-json',
      JSON.stringify({ serverUrl: 'https://safe.example/im', unexpected: 'never-return-this' }),
      JSON.stringify({ serverUrl: 'http://public.example/im' }),
      JSON.stringify({ serverUrl: `https://example.test/${'x'.repeat(70 * 1024)}` }),
    ]) {
      await writeFile(paths.settings, content);
      const result = await discoverLegacyConfigs(home);
      expect(result).toEqual([{
        source: 'opencode-clawmessenger',
        path: paths.settings,
        status: 'invalid',
      }]);
      expect(JSON.stringify(result)).not.toContain('never-return-this');
    }

    const target = join(home, 'unrelated-config');
    await writeJson(
      join(target, 'clawmessenger.json'),
      { serverUrl: 'https://must-not-read.example/im' },
    );
    await rm(dirname(paths.settings), { recursive: true, force: true });
    await symlink(target, dirname(paths.settings), process.platform === 'win32' ? 'junction' : 'dir');
    expect(await lstat(dirname(paths.settings)).then((value) => value.isSymbolicLink())).toBe(true);
    await expect(discoverLegacyConfigs(home)).resolves.toEqual([{
      source: 'opencode-clawmessenger',
      path: paths.settings,
      status: 'invalid',
    }]);
  });

  it('rejects a symlinked home root instead of reading legacy files outside it', async () => {
    const container = await temporaryHome();
    const outside = await temporaryHome();
    const linkedHome = join(container, 'linked-home');
    await writeJson(
      legacyConfigPaths(outside).settings,
      { serverUrl: 'https://must-not-read.example/im' },
    );
    await symlink(outside, linkedHome, process.platform === 'win32' ? 'junction' : 'dir');
    const paths = legacyConfigPaths(linkedHome);

    await expect(discoverLegacyConfigs(linkedHome)).resolves.toEqual([
      { source: 'opencode-clawmessenger', path: paths.settings, status: 'invalid' },
      { source: 'opencode-registration', path: paths.registration, status: 'invalid' },
      {
        source: 'opencode-registration-previous',
        path: paths.previousRegistration,
        status: 'invalid',
      },
      {
        source: 'shared-registration-legacy',
        path: paths.sharedLegacyRegistration,
        status: 'invalid',
      },
    ]);
  });

  it('writes a validated safe projection only after literal confirmation and leaves legacy bytes intact', async () => {
    const home = await temporaryHome();
    const paths = legacyConfigPaths(home);
    const workdir = join(home, 'workspace');
    await mkdir(workdir, { recursive: true });
    const legacyBytes = '{"serverUrl":"https://bridge.example.test/im","token":"do-not-copy","opencodeDir":'
      + `${JSON.stringify(workdir)}}\n`;
    await mkdir(dirname(paths.settings), { recursive: true });
    await writeFile(paths.settings, legacyBytes);
    const discovered = await discoverLegacyConfigs(home);
    const importable = discovered[0];
    if (importable?.status !== 'importable') throw new Error('fixture_not_importable');
    const store = await LocalStore.open({ homeDirectory: home });
    expect(await lstat(localPaths(home).config).then(() => true, () => false)).toBe(false);

    await expect(importLegacyConfig({ confirmed: false, candidate: importable, store }))
      .rejects.toMatchObject({ code: 'confirmation_required' });
    expect(await lstat(localPaths(home).config).then(() => true, () => false)).toBe(false);

    const imported = await importLegacyConfig({ confirmed: true, candidate: importable, store });
    const canonicalWorkdir = await realpath(workdir);

    expect(imported).toMatchObject({
      serverUrl: 'https://bridge.example.test/im',
      defaultWorkdir: canonicalWorkdir,
      authorizedWorkRoots: [canonicalWorkdir],
      providerPathOverrides: {},
    });
    expect(await store.snapshot({}, {})).toMatchObject({ config: imported, bindings: [] });
    expect(await readFile(paths.settings, 'utf8')).toBe(legacyBytes);
    expect(await readFile(localPaths(home).config, 'utf8')).not.toContain('do-not-copy');
  });

  it('rejects caller-injected identity fields before writing', async () => {
    const home = await temporaryHome();
    const workdir = join(home, 'workspace');
    await mkdir(workdir, { recursive: true });
    const store = await LocalStore.open({ homeDirectory: home });
    const unsafe = candidate(join(home, 'legacy.json'), workdir) as unknown as {
      confirmed: boolean;
      candidate: LegacyConfigCandidate & { token: string; nodeId: string };
      store: LocalStore;
    }['candidate'];
    Object.assign(unsafe, { token: 'must-not-write', nodeId: 'opencode_node' });

    await expect(importLegacyConfig({ confirmed: true, candidate: unsafe, store }))
      .rejects.toMatchObject({ code: 'invalid_candidate' });
    expect(await lstat(localPaths(home).config).then(() => true, () => false)).toBe(false);
  });

  it('leaves no config or partial temp when validation or atomic replacement fails', async () => {
    for (const failWrite of [false, true]) {
      const home = await temporaryHome();
      const workdir = join(home, failWrite ? 'workspace' : 'missing-workspace');
      if (failWrite) await mkdir(workdir, { recursive: true });
      const legacyPath = join(home, '.config', 'opencode', 'clawmessenger.json');
      const legacyBytes = '{"legacy":"untouched"}\n';
      await mkdir(dirname(legacyPath), { recursive: true });
      await writeFile(legacyPath, legacyBytes);
      const configPath = localPaths(home).config;
      let rejectConfigRename = false;
      const store = await LocalStore.open({
        homeDirectory: home,
        atomicDependencies: {
          rename: async (from, to) => {
            if (rejectConfigRename && to === configPath) throw Object.assign(new Error('forced'), { code: 'EIO' });
            await rename(from, to);
          },
        },
      });
      rejectConfigRename = failWrite;

      await expect(importLegacyConfig({
        confirmed: true,
        candidate: candidate(legacyPath, workdir),
        store,
      })).rejects.toMatchObject({
        code: failWrite ? 'local_persistence_failed' : 'workdir_not_authorized',
      });

      expect(await readFile(legacyPath, 'utf8')).toBe(legacyBytes);
      expect(await lstat(configPath).then(() => true, () => false)).toBe(false);
      const entries = await lstat(localPaths(home).root).then(async () => {
        const { readdir } = await import('node:fs/promises');
        return readdir(localPaths(home).root);
      });
      expect(entries.filter((name) => name.startsWith('config.json.tmp.'))).toEqual([]);
    }
  });
});
