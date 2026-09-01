import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, win32 } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  CredentialFileSchema,
  DEFAULT_CONFIG,
  LocalStateSchema,
  StoredConfigSchema,
  type CredentialFile,
  type Provider,
  type RongCloudCredential,
  type RuntimeBinding,
  type StoredConfig,
} from './schema.js';
import { localPaths } from './paths.js';
import {
  AtomicJsonError,
  atomicWriteJson,
  readJsonFile,
  type AtomicJsonDependencies,
} from './atomic-json.js';
import {
  LocalStore,
  LocalStoreError,
  authorizeWorkdir,
  canonicalizeWorkdirPolicy,
} from './store.js';

const INSTALL_A = '123e4567-e89b-42d3-a456-426614174000';
const INSTALL_B = '123e4567-e89b-42d3-b456-426614174001';
const BRIDGE_SECRET = 'A'.repeat(43);
const TIME_0 = '2026-08-26T00:00:00.000Z';
const TIME_1 = '2026-08-26T00:01:00.000Z';
const runtimeId = (hex: string) => `rt_${hex.repeat(32)}`;
const tokenRef = (hex: string) => `rc_${hex.repeat(32)}`;

const temporaryHomes: string[] = [];

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'quukk-store-'));
  temporaryHomes.push(home);
  return home;
}

afterEach(async () => {
  await Promise.all(
    temporaryHomes.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function binding(
  provider: Provider,
  overrides: Partial<RuntimeBinding> = {},
): RuntimeBinding {
  const marker = ({ opencode: 'a', openclaw: 'b', codex: 'c', hermes: 'd' } as const)[
    provider
  ];
  return {
    runtimeId: runtimeId(marker),
    runtimePath: process.platform === 'win32' ? `C:\\tools\\${provider}.exe` : `/tools/${provider}`,
    provider,
    enabled: false,
    nodeName: `host · ${provider}`,
    registrationState: 'unregistered',
    updatedAt: TIME_0,
    ...overrides,
  };
}

function credential(
  provider: Provider,
  overrides: Partial<RongCloudCredential> = {},
): RongCloudCredential {
  return {
    runtimeId: binding(provider).runtimeId,
    provider,
    nodeId: `${provider}_123`,
    serverUrl: 'https://example.test/im',
    appKey: 'app-key',
    token: 'rongcloud-token',
    createdAt: TIME_0,
    ...overrides,
  };
}

async function writeIdentityFiles(
  home: string,
  bindings: RuntimeBinding[],
  tokens: CredentialFile['tokens'],
): Promise<void> {
  const paths = localPaths(home);
  await mkdir(paths.root, { recursive: true });
  await atomicWriteJson(paths.state, {
    schemaVersion: 1,
    installId: INSTALL_A,
    bindings,
  });
  await atomicWriteJson(paths.credentials, {
    schemaVersion: 1,
    bridgeSecret: BRIDGE_SECRET,
    tokens,
  });
}

async function makeConfig(home: string, overrides: Partial<StoredConfig> = {}) {
  const root = join(home, 'workspace');
  await mkdir(root, { recursive: true });
  return {
    schemaVersion: 1,
    serverUrl: 'https://file.example/im',
    defaultWorkdir: root,
    authorizedWorkRoots: [root],
    providerPathOverrides: {},
    logLevel: 'info',
    ...overrides,
  } satisfies StoredConfig;
}

describe('local schemas, paths, atomic JSON, and store', () => {
  it('keeps every local path under the exact .quukk-clawmessenger matrix', () => {
    const hostHome = process.platform === 'win32' ? 'D:\\Users\\fixture' : '/home/fixture';
    const root = join(hostHome, '.quukk-clawmessenger');

    expect(localPaths(hostHome)).toEqual({
      root,
      config: join(root, 'config.json'),
      credentials: join(root, 'credentials.json'),
      sessions: join(root, 'sessions.json'),
      state: join(root, 'state.json'),
      logsDir: join(root, 'logs'),
      bridgeLog: join(root, 'logs', 'bridge.log'),
      runDir: join(root, 'run'),
      bridgePid: join(root, 'run', 'bridge.pid'),
      daemonPid: join(root, 'run', 'daemon.pid'),
      rongcloudDir: join(root, 'rongcloud'),
    });
  });

  it('rejects unknown keys and future versions instead of silently accepting them', () => {
    expect(DEFAULT_CONFIG).toEqual({
      schemaVersion: 1,
      serverUrl: 'https://newsradar.dreamdt.cn/im',
      defaultWorkdir: null,
      authorizedWorkRoots: [],
      providerPathOverrides: {},
      logLevel: 'info',
    });
    expect(StoredConfigSchema.safeParse({ ...DEFAULT_CONFIG, unexpected: true }).success).toBe(
      false,
    );
    expect(StoredConfigSchema.safeParse({ ...DEFAULT_CONFIG, schemaVersion: 2 }).success).toBe(
      false,
    );
    expect(
      LocalStateSchema.safeParse({ schemaVersion: 2, installId: INSTALL_A, bindings: [] }).success,
    ).toBe(false);
    expect(
      CredentialFileSchema.safeParse({
        schemaVersion: 2,
        bridgeSecret: BRIDGE_SECRET,
        tokens: {},
      }).success,
    ).toBe(false);
  });

  it('resolves each config leaf as CLI over environment over file over defaults', async () => {
    const home = await temporaryHome();
    const paths = localPaths(home);
    const file = await makeConfig(home, {
      providerPathOverrides: {
        opencode: join(home, 'file-opencode'),
        hermes: join(home, 'file-hermes'),
      },
      logLevel: 'warn',
    });
    await mkdir(paths.root, { recursive: true });
    await atomicWriteJson(paths.config, file);
    const store = await LocalStore.open({ homeDirectory: home });
    const envRoot = join(home, 'env-root');
    await mkdir(envRoot);

    const snapshot = await store.snapshot(
      {
        serverUrl: 'https://cli.example/root/',
        providerPathOverrides: { opencode: join(home, 'cli-opencode') },
      },
      {
        QUUKK_CLAWMESSENGER_SERVER_URL: 'https://env.example/root',
        QUUKK_CLAWMESSENGER_AUTHORIZED_WORK_ROOTS: JSON.stringify([envRoot]),
        QUUKK_CLAWMESSENGER_CODEX_PATH: join(home, 'env-codex'),
        QUUKK_CLAWMESSENGER_LOG_LEVEL: 'debug',
      },
    );

    expect(snapshot.config).toEqual({
      ...file,
      serverUrl: 'https://cli.example/root',
      defaultWorkdir: file.defaultWorkdir,
      authorizedWorkRoots: [envRoot],
      providerPathOverrides: {
        opencode: join(home, 'cli-opencode'),
        hermes: join(home, 'file-hermes'),
        codex: join(home, 'env-codex'),
      },
      logLevel: 'debug',
    });
    expect(JSON.parse(await readFile(paths.config, 'utf8'))).toEqual(file);
  });

  it('lets an explicit CLI null clear a persisted default workdir', async () => {
    const home = await temporaryHome();
    const paths = localPaths(home);
    const file = await makeConfig(home);
    await mkdir(paths.root, { recursive: true });
    await atomicWriteJson(paths.config, file);
    const store = await LocalStore.open({ homeDirectory: home });

    expect((await store.snapshot({ defaultWorkdir: null }, {})).config.defaultWorkdir).toBeNull();
  });

  it('fails invalid CLI and environment values without falling through', async () => {
    const home = await temporaryHome();
    const store = await LocalStore.open({ homeDirectory: home });

    await expect(store.snapshot({ serverUrl: ' https://invalid.example' })).rejects.toMatchObject({
      code: 'invalid_config',
    });
    await expect(
      store.snapshot(undefined, { QUUKK_CLAWMESSENGER_LOG_LEVEL: 'verbose' }),
    ).rejects.toMatchObject({ code: 'invalid_config' });
    await expect(
      store.snapshot(undefined, { QUUKK_CLAWMESSENGER_SERVER_URL: 'ftp://invalid.example' }),
    ).rejects.toMatchObject({ code: 'invalid_config' });
  });

  it('permits HTTPS servers and plaintext HTTP only for exact loopback hosts', () => {
    for (const serverUrl of [
      'https://public.example/im',
      'https://public.example/im%3Ftenant%23one',
      'http://localhost:8080/im',
      'http://127.0.0.1:8080/im',
      'http://[::1]:8080/im',
    ]) {
      expect(StoredConfigSchema.safeParse({ ...DEFAULT_CONFIG, serverUrl }).success).toBe(true);
    }
    for (const serverUrl of [
      'http://public.example/im',
      'http://192.168.1.20/im',
      'http://127.0.0.1.evil.example/im',
      'https://user:password@public.example/im',
      'https://public.example/im?token=value',
      'https://public.example/im#fragment',
      'https://public.example/im?',
      'https://public.example/im#',
    ]) {
      expect(StoredConfigSchema.safeParse({ ...DEFAULT_CONFIG, serverUrl }).success).toBe(false);
    }
  });

  it('parses authorized work roots only as a strict JSON string array', async () => {
    const home = await temporaryHome();
    const store = await LocalStore.open({ homeDirectory: home });
    const invalid = ['not-json', '"one-path"', '[1]', '{"root":"/tmp"}'];

    for (const value of invalid) {
      await expect(
        store.snapshot(undefined, { QUUKK_CLAWMESSENGER_AUTHORIZED_WORK_ROOTS: value }),
      ).rejects.toMatchObject({ code: 'invalid_config' });
    }
  });

  it('accepts only bounded absolute untrimmed-free provider overrides', () => {
    const absolute = process.platform === 'win32' ? 'C:\\tools\\codex.exe' : '/tools/codex';
    const invalid = [
      'relative/path',
      ` ${absolute}`,
      `${absolute} `,
      `${absolute}\0tail`,
      `${absolute}${'x'.repeat(4097)}`,
    ];
    expect(
      StoredConfigSchema.safeParse({
        ...DEFAULT_CONFIG,
        providerPathOverrides: { codex: absolute },
      }).success,
    ).toBe(true);
    for (const value of invalid) {
      expect(
        StoredConfigSchema.safeParse({
          ...DEFAULT_CONFIG,
          providerPathOverrides: { codex: value },
        }).success,
      ).toBe(false);
    }
    expect(
      StoredConfigSchema.safeParse({
        ...DEFAULT_CONFIG,
        providerPathOverrides: { unknown: absolute },
      }).success,
    ).toBe(false);
  });

  it('rejects duplicate or excessive authorized roots', () => {
    const absolute = process.platform === 'win32' ? 'C:\\work' : '/work';
    expect(
      StoredConfigSchema.safeParse({
        ...DEFAULT_CONFIG,
        authorizedWorkRoots: [absolute, absolute],
      }).success,
    ).toBe(false);
    expect(
      StoredConfigSchema.safeParse({
        ...DEFAULT_CONFIG,
        authorizedWorkRoots: Array.from({ length: 33 }, (_, index) =>
          process.platform === 'win32' ? `C:\\work-${index}` : `/work-${index}`,
        ),
      }).success,
    ).toBe(false);
  });

  it('accepts only lowercase bounded safe ASCII node ID suffixes for the exact provider', () => {
    const ref = tokenRef('a');
    const makeState = (nodeId: string) => ({
      schemaVersion: 1,
      installId: INSTALL_A,
      bindings: [
        binding('codex', {
          enabled: true,
          nodeId,
          tokenRef: ref,
          registrationState: 'offline',
        }),
      ],
    });
    expect(LocalStateSchema.safeParse(makeState('codex_a-1_b')).success).toBe(true);
    expect(
      LocalStateSchema.safeParse({
        schemaVersion: 1,
        installId: INSTALL_A,
        bindings: [
          binding('openclaw', {
            enabled: true,
            nodeId: `openclaw_${'a'.repeat(128)}`,
            tokenRef: ref,
            registrationState: 'offline',
          }),
        ],
      }).success,
    ).toBe(true);
    for (const nodeId of [
      'openclaw_a-1',
      'codex_Upper',
      'codex_slash/value',
      'codex_percent%20value',
      'codex_control\nvalue',
      `codex_${'a'.repeat(129)}`,
    ]) {
      expect(LocalStateSchema.safeParse(makeState(nodeId)).success).toBe(false);
    }
  });

  it('denies every requested workdir when no root is authorized', async () => {
    const home = await temporaryHome();
    await expect(authorizeWorkdir(home, [])).rejects.toMatchObject({
      code: 'workdir_not_authorized',
    });
  });

  it('uses real paths and relative containment to reject siblings, traversal, and symlink escapes', async () => {
    const home = await temporaryHome();
    const root = join(home, 'root');
    const child = join(root, 'child');
    const sibling = join(home, 'root-sibling');
    const outside = join(home, 'outside');
    await Promise.all([mkdir(child, { recursive: true }), mkdir(sibling), mkdir(outside)]);
    const link = join(root, 'escape');
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(authorizeWorkdir(child, [root])).resolves.toBe(await import('node:fs/promises').then(({ realpath }) => realpath(child)));
    await expect(authorizeWorkdir(sibling, [root])).rejects.toMatchObject({
      code: 'workdir_not_authorized',
    });
    await expect(authorizeWorkdir(join(root, '..', 'outside'), [root])).rejects.toMatchObject({
      code: 'workdir_not_authorized',
    });
    await expect(authorizeWorkdir(link, [root])).rejects.toMatchObject({
      code: 'workdir_not_authorized',
    });
  });

  it('compares canonical Windows paths case-insensitively through the injected path policy', async () => {
    const directoryStat = { isDirectory: () => true } as Awaited<ReturnType<typeof stat>>;
    const result = await authorizeWorkdir('C:\\ROOT\\Child', ['c:\\root'], {
      realpath: async (value) => value.toString(),
      stat: async () => directoryStat,
      platform: 'win32',
      path: win32,
    });
    expect(result).toBe('C:\\ROOT\\Child');
  });

  it('canonicalizes saved roots and requires the default workdir to stay inside them', async () => {
    const home = await temporaryHome();
    const root = join(home, 'root');
    const child = join(root, 'child');
    const outside = join(home, 'outside');
    await Promise.all([mkdir(child, { recursive: true }), mkdir(outside)]);
    const valid = { ...DEFAULT_CONFIG, authorizedWorkRoots: [root], defaultWorkdir: child };

    const canonical = await canonicalizeWorkdirPolicy(valid);
    expect(canonical.authorizedWorkRoots[0]).not.toContain('..');
    await expect(
      canonicalizeWorkdirPolicy({ ...valid, defaultWorkdir: outside }),
    ).rejects.toMatchObject({ code: 'workdir_not_authorized' });
  });

  it('keeps one stable UUID and bridge secret across open and restart', async () => {
    const home = await temporaryHome();
    const first = await LocalStore.open({ homeDirectory: home });
    const firstIdentity = first.bridgeIdentity();
    const second = await LocalStore.open({ homeDirectory: home });

    expect(second.bridgeIdentity()).toEqual(firstIdentity);
    expect(firstIdentity.installId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(firstIdentity.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('serializes concurrent fresh opens so they cannot return divergent identities', async () => {
    const home = await temporaryHome();
    let uuidCalls = 0;
    const options = {
      homeDirectory: home,
      randomUUID: () => (uuidCalls++ === 0 ? INSTALL_A : INSTALL_B),
      randomBytes: (size: number) => Buffer.alloc(size, uuidCalls),
    };

    const [left, right] = await Promise.all([LocalStore.open(options), LocalStore.open(options)]);
    expect(left.bridgeIdentity()).toEqual(right.bridgeIdentity());
    expect(uuidCalls).toBe(1);
  });

  it('accepts exact JSON read limits and rejects one byte of overflow', async () => {
    const home = await temporaryHome();
    const schema = z.object({ value: z.string() }).strict();
    for (const limit of [1 << 20, 4 << 20]) {
      const file = join(home, `bounded-${limit}.json`);
      const prefix = '{"value":"';
      const suffix = '"}';
      await writeFile(file, prefix + 'x'.repeat(limit - prefix.length - suffix.length) + suffix);
      await expect(readJsonFile(file, schema, limit)).resolves.toMatchObject({ value: expect.any(String) });
      await writeFile(
        file,
        prefix + 'x'.repeat(limit - prefix.length - suffix.length + 1) + suffix,
      );
      await expect(readJsonFile(file, schema, limit)).rejects.toMatchObject({
        code: 'file_too_large',
      });
    }
  });

  it('never reads more than max plus one byte when a file grows after stat', async () => {
    const maximum = 32;
    let requestedBytes = 0;
    const schema = z.object({ value: z.string() }).strict();
    await expect(
      readJsonFile('/growing.json', schema, maximum, {
        open: async () => ({
          stat: async () => ({ size: 2 }),
          read: async (buffer: Uint8Array, offset: number, length: number) => {
            requestedBytes = Math.max(requestedBytes, length);
            buffer.fill(0x20, offset, offset + length);
            return { bytesRead: length, buffer };
          },
          sync: async () => undefined,
          close: async () => undefined,
        }),
      }),
    ).rejects.toMatchObject({ code: 'file_too_large' });
    expect(requestedBytes).toBe(maximum + 1);
  });

  it('orders temp write, file sync, close, rename, and directory sync', async () => {
    const events: string[] = [];
    const dependencies: AtomicJsonDependencies = {
      platform: 'linux',
      randomHex: () => '1234abcd',
      mkdir: async (_path, options) => events.push(`mkdir:${options.mode?.toString(8)}`),
      chmod: async (_path, mode) => events.push(`chmod:${mode.toString(8)}`),
      open: async (_path, flags, mode) => {
        if (flags === 'wx') {
          events.push(`open-temp:${mode?.toString(8)}`);
          return {
            writeFile: async () => events.push('write'),
            sync: async () => events.push('file-sync'),
            close: async () => events.push('file-close'),
          };
        }
        events.push('open-directory');
        return {
          writeFile: async () => undefined,
          sync: async () => events.push('directory-sync'),
          close: async () => events.push('directory-close'),
        };
      },
      rename: async () => events.push('rename'),
      unlink: async () => events.push('unlink'),
      sleep: async () => undefined,
    };

    await atomicWriteJson('/safe/state.json', { value: 1 }, dependencies);
    expect(events).toEqual([
      'mkdir:700',
      'chmod:700',
      'open-temp:600',
      'write',
      'file-sync',
      'file-close',
      'rename',
      'open-directory',
      'directory-sync',
      'directory-close',
    ]);
  });

  it('preserves the previous target and cleans only its temp file when rename fails', async () => {
    const home = await temporaryHome();
    const target = join(home, 'state.json');
    await writeFile(target, 'old-value');
    await expect(
      atomicWriteJson(target, { replacement: true }, {
        rename: async () => {
          throw Object.assign(new Error('forced'), { code: 'EIO' });
        },
      }),
    ).rejects.toBeInstanceOf(AtomicJsonError);

    expect(await readFile(target, 'utf8')).toBe('old-value');
    expect((await readdir(home)).filter((name) => name.includes('.tmp.'))).toEqual([]);
  });

  it('never unlinks a Windows destination before its atomic rename', async () => {
    const removed: string[] = [];
    const dependencies: AtomicJsonDependencies = {
      platform: 'win32',
      randomHex: () => '1234abcd',
      mkdir: async () => undefined,
      chmod: async () => undefined,
      open: async () => ({
        writeFile: async () => undefined,
        sync: async () => undefined,
        close: async () => undefined,
      }),
      rename: async () => undefined,
      unlink: async (path) => removed.push(path.toString()),
      sleep: async () => undefined,
    };
    await atomicWriteJson('C:\\safe\\credentials.json', { value: 1 }, dependencies);
    expect(removed).toEqual([]);
  });

  it.each([
    ['EACCES', 3, [10, 20]],
    ['EPERM', 3, [10, 20]],
    ['EIO', 1, []],
  ] as const)(
    'bounds Windows rename handling for %s and cleans only the temporary file',
    async (code, expectedAttempts, expectedDelays) => {
      const target = process.platform === 'win32' ? 'C:\\safe\\state.json' : '/safe/state.json';
      const removed: string[] = [];
      const delays: number[] = [];
      let attempts = 0;
      await expect(
        atomicWriteJson(target, { value: 1 }, {
          platform: 'win32',
          randomHex: () => '1234abcd',
          mkdir: async () => undefined,
          chmod: async () => undefined,
          open: async () => ({
            writeFile: async () => undefined,
            sync: async () => undefined,
            close: async () => undefined,
          }),
          rename: async () => {
            attempts += 1;
            throw Object.assign(new Error('forced'), { code });
          },
          unlink: async (path) => removed.push(path.toString()),
          sleep: async (milliseconds) => delays.push(milliseconds),
        }),
      ).rejects.toBeInstanceOf(AtomicJsonError);

      expect(attempts).toBe(expectedAttempts);
      expect(delays).toEqual(expectedDelays);
      expect(removed).toHaveLength(1);
      expect(removed[0]).toContain('.tmp.1234abcd');
      expect(removed).not.toContain(target);
    },
  );

  it('requests 0700 directories and 0600 files without an ACL subprocess seam', async () => {
    const home = await temporaryHome();
    const target = join(home, 'protected', 'credentials.json');
    await atomicWriteJson(target, { value: 1 });
    if (process.platform !== 'win32') {
      expect((await stat(dirname(target))).mode & 0o777).toBe(0o700);
      expect((await stat(target)).mode & 0o777).toBe(0o600);
    }
    expect(JSON.stringify(await import('./atomic-json.js'))).not.toContain('child_process');
  });

  it('quarantines malformed config, returns read-only defaults, and blocks mutation until save', async () => {
    const home = await temporaryHome();
    const paths = localPaths(home);
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.config, '{not-json');
    const store = await LocalStore.open({ homeDirectory: home });

    expect(await store.snapshot()).toEqual({
      config: DEFAULT_CONFIG,
      bindings: [],
      warnings: ['config_recovery_required'],
    });
    expect((await readdir(paths.root)).some((name) => /^config\.json\.corrupt\./.test(name))).toBe(
      true,
    );
    expect(() => store.assertExternalMutationAllowed()).toThrowError(
      expect.objectContaining({ code: 'config_recovery_required' }),
    );

    const restarted = await LocalStore.open({ homeDirectory: home });
    expect((await restarted.snapshot()).warnings).toEqual(['config_recovery_required']);
    expect(() => restarted.assertExternalMutationAllowed()).toThrowError(
      expect.objectContaining({ code: 'config_recovery_required' }),
    );

    await restarted.saveConfig(DEFAULT_CONFIG);
    expect(() => restarted.assertExternalMutationAllowed()).not.toThrow();
    expect((await restarted.snapshot()).warnings).toEqual([]);
    expect((await readdir(paths.root)).some((name) => /^config\.json\.corrupt\./.test(name))).toBe(
      false,
    );
    await expect(
      LocalStore.open({ homeDirectory: home }).then((next) => next.snapshot()),
    ).resolves.toMatchObject({ warnings: [] });
  });

  it('treats a missing config as a normal default without a warning', async () => {
    const home = await temporaryHome();
    const store = await LocalStore.open({ homeDirectory: home });
    expect(await store.snapshot()).toEqual({ config: DEFAULT_CONFIG, bindings: [], warnings: [] });
  });

  it('fails closed on malformed identity files without replacing identity or deleting the peer file', async () => {
    const home = await temporaryHome();
    const paths = localPaths(home);
    await writeIdentityFiles(home, [], {});
    const credentialBytes = await readFile(paths.credentials, 'utf8');
    await writeFile(paths.state, '{bad-state');

    await expect(LocalStore.open({ homeDirectory: home })).rejects.toMatchObject({
      code: 'local_state_recovery_required',
    });
    expect(await readFile(paths.credentials, 'utf8')).toBe(credentialBytes);
    expect((await readdir(paths.root)).some((name) => /^state\.json\.corrupt\./.test(name))).toBe(
      true,
    );
  });

  it('keeps a quarantined credential recovery gate across restarts without generating a secret', async () => {
    const home = await temporaryHome();
    const paths = localPaths(home);
    await writeIdentityFiles(home, [], {});
    await writeFile(paths.credentials, '{bad-credentials');
    let randomCalls = 0;
    const options = {
      homeDirectory: home,
      randomBytes: (size: number) => {
        randomCalls += 1;
        return Buffer.alloc(size, 7);
      },
      atomicDependencies: { randomHex: () => 'fixed' },
    };

    await expect(LocalStore.open(options)).rejects.toMatchObject({
      code: 'credentials_recovery_required',
    });
    await expect(LocalStore.open(options)).rejects.toMatchObject({
      code: 'credentials_recovery_required',
    });
    expect(randomCalls).toBe(0);
  });

  it('keeps quarantined state recovery across restart when its peer is absent without new identity', async () => {
    const home = await temporaryHome();
    const paths = localPaths(home);
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.state, '{bad-state');
    let uuidCalls = 0;
    let randomCalls = 0;
    const options = {
      homeDirectory: home,
      randomUUID: () => {
        uuidCalls += 1;
        return INSTALL_B;
      },
      randomBytes: (size: number) => {
        randomCalls += 1;
        return Buffer.alloc(size, 9);
      },
      atomicDependencies: { randomHex: () => 'fixed' },
    };

    await expect(LocalStore.open(options)).rejects.toMatchObject({
      code: 'local_state_recovery_required',
    });
    await expect(LocalStore.open(options)).rejects.toMatchObject({
      code: 'local_state_recovery_required',
    });
    expect(uuidCalls).toBe(0);
    expect(randomCalls).toBe(0);
  });

  it('rejects non-canonical 43-character base64url bridge secrets', () => {
    expect(
      CredentialFileSchema.safeParse({
        schemaVersion: 1,
        bridgeSecret: 'B'.repeat(43),
        tokens: {},
      }).success,
    ).toBe(false);
  });

  it('finishes only the valid empty-state half of interrupted first initialization', async () => {
    const home = await temporaryHome();
    const paths = localPaths(home);
    await mkdir(paths.root, { recursive: true });
    await atomicWriteJson(paths.state, { schemaVersion: 1, installId: INSTALL_A, bindings: [] });
    const completed = await LocalStore.open({ homeDirectory: home });
    expect(completed.bridgeIdentity().installId).toBe(INSTALL_A);

    const brokenHome = await temporaryHome();
    const brokenPaths = localPaths(brokenHome);
    await mkdir(brokenPaths.root, { recursive: true });
    await atomicWriteJson(brokenPaths.credentials, {
      schemaVersion: 1,
      bridgeSecret: BRIDGE_SECRET,
      tokens: {},
    });
    await expect(LocalStore.open({ homeDirectory: brokenHome })).rejects.toMatchObject({
      code: 'local_state_recovery_required',
    });

    const boundHome = await temporaryHome();
    const boundPaths = localPaths(boundHome);
    await mkdir(boundPaths.root, { recursive: true });
    await atomicWriteJson(boundPaths.state, {
      schemaVersion: 1,
      installId: INSTALL_A,
      bindings: [binding('codex')],
    });
    await expect(LocalStore.open({ homeDirectory: boundHome })).rejects.toMatchObject({
      code: 'credentials_recovery_required',
    });
  });

  it('rejects binding and credential tokenRef, runtime, provider, and node mismatches', async () => {
    const cases = [
      { tokenKey: tokenRef('a'), cred: undefined },
      { tokenKey: tokenRef('a'), cred: credential('codex', { runtimeId: runtimeId('e') }) },
      { tokenKey: tokenRef('a'), cred: credential('openclaw') },
      { tokenKey: tokenRef('a'), cred: credential('codex', { nodeId: 'codex_other' }) },
    ];
    for (const [index, fixture] of cases.entries()) {
      const home = await temporaryHome();
      const ref = tokenRef('a');
      const row = binding('codex', {
        enabled: true,
        nodeId: 'codex_123',
        tokenRef: ref,
        registrationState: 'offline',
      });
      const tokens = fixture.cred ? { [fixture.tokenKey]: fixture.cred } : {};
      await writeIdentityFiles(home, [row], tokens);
      await expect(LocalStore.open({ homeDirectory: home }), `case ${index}`).rejects.toMatchObject({
        code: 'local_state_recovery_required',
      });
    }
  });

  it('reconciles online and interrupted registering bindings without a network operation', async () => {
    const home = await temporaryHome();
    const onlineRef = tokenRef('a');
    const completeRef = tokenRef('b');
    await writeIdentityFiles(
      home,
      [
        binding('opencode', {
          enabled: true,
          nodeId: 'opencode_123',
          tokenRef: onlineRef,
          registrationState: 'online',
        }),
        binding('codex', {
          enabled: true,
          nodeId: 'codex_123',
          tokenRef: completeRef,
          registrationState: 'registering',
        }),
        binding('hermes', { registrationState: 'registering' }),
      ],
      {
        [onlineRef]: credential('opencode'),
        [completeRef]: credential('codex'),
      },
    );

    const store = await LocalStore.open({ homeDirectory: home, now: () => new Date(TIME_1) });
    const rows = (await store.snapshot()).bindings;
    expect(rows.map(({ provider, enabled, registrationState, lastErrorCode, updatedAt }) => ({
      provider,
      enabled,
      registrationState,
      lastErrorCode,
      updatedAt,
    }))).toEqual([
      { provider: 'opencode', enabled: true, registrationState: 'offline', lastErrorCode: undefined, updatedAt: TIME_1 },
      { provider: 'codex', enabled: true, registrationState: 'offline', lastErrorCode: undefined, updatedAt: TIME_1 },
      { provider: 'hermes', enabled: false, registrationState: 'error', lastErrorCode: 'interrupted_registration', updatedAt: TIME_1 },
    ]);
  });

  it('serializes queued updates without lost bindings and recovers after one failed write', async () => {
    const home = await temporaryHome();
    let failNextStateRename = false;
    const store = await LocalStore.open({
      homeDirectory: home,
      atomicDependencies: {
        rename: async (from, to) => {
          if (failNextStateRename && to.toString().endsWith('state.json')) {
            failNextStateRename = false;
            throw Object.assign(new Error('forced'), { code: 'EIO' });
          }
          await rename(from, to);
        },
      },
    });

    await Promise.all([store.saveBinding(binding('opencode')), store.saveBinding(binding('codex'))]);
    expect((await store.snapshot()).bindings.map((row) => row.provider).sort()).toEqual([
      'codex',
      'opencode',
    ]);
    failNextStateRename = true;
    await expect(store.saveBinding(binding('hermes'))).rejects.toMatchObject({
      code: 'local_persistence_failed',
    });
    await expect(store.saveBinding(binding('openclaw'))).resolves.toBeUndefined();
    expect((await store.snapshot()).bindings.map((row) => row.provider).sort()).toEqual([
      'codex',
      'openclaw',
      'opencode',
    ]);
  });

  it('keeps a usable credential through every credentials-first swap failure window', async () => {
    for (const failureAt of ['new-credential', 'binding-switch', 'old-cleanup'] as const) {
      const home = await temporaryHome();
      let armed = false;
      const credentialWrites = new Set<string>();
      const store = await LocalStore.open({
        homeDirectory: home,
        randomBytes: (() => {
          let byte = 1;
          return (size: number) => Buffer.alloc(size, byte++);
        })(),
        atomicDependencies: {
          rename: async (from, to) => {
            const target = to.toString();
            const isCredential = target.endsWith('credentials.json');
            if (armed && isCredential) credentialWrites.add(from.toString());
            const shouldFail =
              armed &&
              ((failureAt === 'new-credential' && isCredential && credentialWrites.size === 1) ||
                (failureAt === 'binding-switch' && target.endsWith('state.json')) ||
                (failureAt === 'old-cleanup' && isCredential && credentialWrites.size === 2));
            if (shouldFail) {
              armed = false;
              throw Object.assign(new Error('forced'), { code: 'EIO' });
            }
            await rename(from, to);
          },
        },
      });
      const pending = binding('codex', { registrationState: 'registering' });
      await store.saveBinding(pending);
      const first = await store.commitRegistration(
        {
          ...pending,
          enabled: true,
          nodeId: 'codex_123',
          registrationState: 'offline',
        },
        {
          serverUrl: 'https://example.test/im',
          appKey: 'app-key',
          token: 'old-token',
          createdAt: TIME_0,
        },
      );
      armed = true;
      credentialWrites.clear();
      let committedRef: string | undefined;
      const replacement = store.commitRegistration(
        { ...first, tokenRef: undefined, registrationState: 'offline' },
        {
          serverUrl: 'https://example.test/im',
          appKey: 'app-key-new',
          token: 'new-token',
          createdAt: TIME_1,
        },
      );
      if (failureAt === 'old-cleanup') {
        const committed = await replacement;
        committedRef = committed.tokenRef;
        expect(committed.tokenRef).not.toBe(first.tokenRef);
        expect(store.credential(committed.tokenRef!)?.token).toBe('new-token');
        expect(store.credential(first.tokenRef!)?.token).toBe('old-token');
        expect(
          Object.keys(JSON.parse(await readFile(localPaths(home).credentials, 'utf8')).tokens),
        ).toHaveLength(2);
      } else {
        await expect(replacement, failureAt).rejects.toMatchObject({
          code: 'local_persistence_failed',
        });
      }

      const stateBeforeReopen = JSON.parse(
        await readFile(localPaths(home).state, 'utf8'),
      ) as { bindings: RuntimeBinding[] };
      expect(stateBeforeReopen.bindings[0]?.tokenRef).toBe(
        failureAt === 'old-cleanup' ? committedRef : first.tokenRef,
      );

      const reopened = await LocalStore.open({ homeDirectory: home });
      const persisted = (await reopened.snapshot()).bindings[0];
      const expectedRef = failureAt === 'old-cleanup' ? committedRef : first.tokenRef;
      const expectedToken = failureAt === 'old-cleanup' ? 'new-token' : 'old-token';
      expect(persisted?.tokenRef).toBe(expectedRef);
      expect(reopened.credential(expectedRef!)?.token).toBe(expectedToken);
      expect(
        Object.keys(JSON.parse(await readFile(localPaths(home).credentials, 'utf8')).tokens),
      ).toEqual([expectedRef]);
    }
  });

  it('cleans orphan credentials only after both identity files validate', async () => {
    const home = await temporaryHome();
    const paths = localPaths(home);
    const ref = tokenRef('a');
    const orphan = tokenRef('b');
    await writeIdentityFiles(
      home,
      [binding('codex', { enabled: true, nodeId: 'codex_123', tokenRef: ref, registrationState: 'offline' })],
      { [ref]: credential('codex'), [orphan]: credential('hermes') },
    );
    await LocalStore.open({ homeDirectory: home });
    expect(Object.keys(JSON.parse(await readFile(paths.credentials, 'utf8')).tokens)).toEqual([ref]);

    const unsafeHome = await temporaryHome();
    const unsafePaths = localPaths(unsafeHome);
    await writeIdentityFiles(unsafeHome, [], { [orphan]: credential('hermes') });
    const credentialBytes = await readFile(unsafePaths.credentials, 'utf8');
    await writeFile(unsafePaths.state, '{broken');
    await expect(LocalStore.open({ homeDirectory: unsafeHome })).rejects.toBeInstanceOf(
      LocalStoreError,
    );
    expect(await readFile(unsafePaths.credentials, 'utf8')).toBe(credentialBytes);
  });

  it('retains credentials on disable-style saves and removes bindings before credentials', async () => {
    const home = await temporaryHome();
    let failCredentialRename = false;
    const store = await LocalStore.open({
      homeDirectory: home,
      atomicDependencies: {
        rename: async (from, to) => {
          if (failCredentialRename && to.toString().endsWith('credentials.json')) {
            failCredentialRename = false;
            throw Object.assign(new Error('forced'), { code: 'EIO' });
          }
          await rename(from, to);
        },
      },
    });
    const pending = binding('opencode', { registrationState: 'registering' });
    await store.saveBinding(pending);
    const online = await store.commitRegistration(
      { ...pending, enabled: true, nodeId: 'opencode_123', registrationState: 'offline' },
      {
        serverUrl: 'https://example.test/im',
        appKey: 'app-key',
        token: 'retained-token',
        createdAt: TIME_0,
      },
    );
    await store.saveBinding({ ...online, enabled: false, registrationState: 'offline' });
    expect(store.credential(online.tokenRef!)?.token).toBe('retained-token');

    failCredentialRename = true;
    await expect(store.removeBinding(online.runtimeId)).rejects.toMatchObject({
      code: 'local_persistence_failed',
    });
    const reopened = await LocalStore.open({ homeDirectory: home });
    expect((await reopened.snapshot()).bindings).toEqual([]);
    expect(reopened.credential(online.tokenRef!)).toBeUndefined();
  });

  it('keeps bridge secrets and RongCloud tokens out of config, state, snapshots, and store JSON', async () => {
    const home = await temporaryHome();
    const paths = localPaths(home);
    const store = await LocalStore.open({
      homeDirectory: home,
      randomUUID: () => INSTALL_A,
      randomBytes: (size) => Buffer.alloc(size, 7),
    });
    await store.saveConfig(DEFAULT_CONFIG);
    const pending = binding('hermes', { registrationState: 'registering' });
    await store.saveBinding(pending);
    await store.commitRegistration(
      { ...pending, enabled: true, nodeId: 'hermes_123', registrationState: 'offline' },
      {
        serverUrl: 'https://example.test/im',
        appKey: 'SENTINEL_APP_KEY',
        token: 'SENTINEL_TOKEN',
        createdAt: TIME_0,
      },
    );
    const publicText = [
      await readFile(paths.config, 'utf8'),
      await readFile(paths.state, 'utf8'),
      JSON.stringify(await store.snapshot()),
      JSON.stringify(store),
    ].join('\n');
    expect(publicText).not.toContain('SENTINEL_TOKEN');
    expect(publicText).not.toContain('SENTINEL_APP_KEY');
    expect(publicText).not.toContain(store.bridgeIdentity().secret);
  });
});
