import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { BindingService } from './service.js';
import { localPaths } from '../config/paths.js';
import { DEFAULT_CONFIG } from '../config/schema.js';
import { LocalStore } from '../config/store.js';
import type {
  Provider,
  RuntimeBinding,
  TrustedRuntime,
} from '../config/schema.js';
import {
  RegistrationError,
  type RefreshInput,
  type RegistrationInput,
  type RegistrationResult,
} from '../registration/client.js';

const TIME_0 = '2026-08-27T00:00:00.000Z';
const TIME_1 = '2026-08-27T00:01:00.000Z';
const marker = { opencode: 'a', openclaw: 'b', codex: 'c', hermes: 'd' } as const;
const label = { opencode: 'OpenCode', openclaw: 'OpenClaw', codex: 'Codex', hermes: 'Hermes' } as const;

const temporaryHomes: string[] = [];

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'quukk-bindings-'));
  temporaryHomes.push(home);
  return home;
}

afterEach(async () => {
  await Promise.all(
    temporaryHomes.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function runtime(provider: Provider, overrides: Partial<TrustedRuntime> = {}): TrustedRuntime {
  return {
    id: `rt_${marker[provider].repeat(32)}`,
    provider,
    path: process.platform === 'win32' ? `C:\\tools\\${provider}.exe` : `/tools/${provider}`,
    status: 'ready',
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeRegistrationClient {
  readonly appKeyCalls: string[] = [];
  readonly registerCalls: RegistrationInput[] = [];
  readonly refreshCalls: RefreshInput[] = [];
  getAppKeyImplementation: (serverUrl: string) => Promise<string> = async () => 'public-app-key';
  registerImplementation: (input: RegistrationInput) => Promise<RegistrationResult> = async (
    input,
  ) => ({
    nodeId: `${input.provider}_registered`,
    nodeName: input.nodeName,
    token: `${input.provider}-token`,
  });
  refreshImplementation: (input: RefreshInput) => Promise<RegistrationResult> = async (input) => ({
    nodeId: input.nodeId,
    nodeName: input.nodeName,
    token: `${input.provider}-refreshed-token`,
  });

  async getAppKey(serverUrl: string): Promise<string> {
    this.appKeyCalls.push(serverUrl);
    return this.getAppKeyImplementation(serverUrl);
  }

  async register(input: RegistrationInput): Promise<RegistrationResult> {
    this.registerCalls.push({ ...input });
    return this.registerImplementation(input);
  }

  async refreshToken(input: RefreshInput): Promise<RegistrationResult> {
    this.refreshCalls.push({ ...input });
    return this.refreshImplementation(input);
  }
}

class FakeRuntimeSource {
  calls = 0;
  constructor(public snapshot: readonly TrustedRuntime[]) {}

  async runtimes(): Promise<readonly TrustedRuntime[]> {
    this.calls += 1;
    return this.snapshot.map((entry) => ({ ...entry }));
  }
}

async function harness(
  runtimes: readonly TrustedRuntime[] = [runtime('codex')],
  options: { home?: string; hostname?: string; registration?: FakeRegistrationClient } = {},
) {
  const home = options.home ?? (await temporaryHome());
  const store = await LocalStore.open({ homeDirectory: home, now: () => new Date(TIME_1) });
  const registration = options.registration ?? new FakeRegistrationClient();
  const source = new FakeRuntimeSource(runtimes);
  const service = await BindingService.open({
    store,
    registrationClient: registration,
    runtimeSource: source,
    now: () => new Date(TIME_1),
    hostname: () => options.hostname ?? 'fixture-host',
  });
  return { home, store, registration, source, service };
}

async function seedBinding(
  store: LocalStore,
  selected: TrustedRuntime,
  options: { enabled?: boolean; serverUrl?: string; nodeId?: string } = {},
): Promise<RuntimeBinding> {
  const nodeId = options.nodeId ?? `${selected.provider}_existing`;
  const pending: RuntimeBinding = {
    runtimeId: selected.id,
    runtimePath: selected.path,
    provider: selected.provider,
    enabled: false,
    nodeName: `seed-host · ${label[selected.provider]}`,
    registrationState: 'registering',
    updatedAt: TIME_0,
  };
  await store.saveBinding(pending);
  const registered = await store.commitRegistration(
    {
      ...pending,
      enabled: options.enabled ?? true,
      nodeId,
      registrationState: 'offline',
    },
    {
      serverUrl: options.serverUrl ?? 'https://newsradar.dreamdt.cn/im',
      appKey: 'old-app-key',
      token: 'old-rongcloud-token',
      createdAt: TIME_0,
    },
  );
  if (options.enabled === false) {
    const disabled = { ...registered, enabled: false };
    await store.saveBinding(disabled);
    return disabled;
  }
  return registered;
}

describe('BindingService', () => {
  it('opens, lists, and restarts without any registration network call', async () => {
    const first = await harness([runtime('codex')]);
    expect(first.service.list()).toEqual([]);
    expect(first.registration.appKeyCalls).toEqual([]);
    expect(first.registration.registerCalls).toEqual([]);
    expect(first.registration.refreshCalls).toEqual([]);

    await seedBinding(first.store, runtime('codex'));
    const secondRegistration = new FakeRegistrationClient();
    const second = await harness([runtime('codex')], {
      home: first.home,
      registration: secondRegistration,
    });
    expect(second.service.list()).toHaveLength(1);
    expect(secondRegistration.appKeyCalls).toEqual([]);
    expect(secondRegistration.registerCalls).toEqual([]);
    expect(secondRegistration.refreshCalls).toEqual([]);
  });

  it('receives only runtime IDs and resolves provider, path, and status from one fresh snapshot', async () => {
    const selected = runtime('codex');
    const fixture = await harness([selected]);

    const [result] = await fixture.service.enableSelected([selected.id]);

    expect(result).toMatchObject({ ok: true, runtimeId: selected.id });
    expect(result?.ok && result.binding).toMatchObject({
      runtimeId: selected.id,
      runtimePath: selected.path,
      provider: 'codex',
    });
    expect(fixture.source.calls).toBe(1);
    expect(fixture.registration.registerCalls[0]).toMatchObject({
      runtimeId: selected.id,
      provider: 'codex',
    });
  });

  it.each(['needs_auth', 'found_not_runnable', 'not_found', 'probe_failed'] as const)(
    'rejects %s runtimes without fetching AppKey or registering',
    async (status) => {
      const selected = runtime('codex', { status });
      const fixture = await harness([selected]);
      await expect(fixture.service.enableSelected([selected.id])).resolves.toEqual([
        { runtimeId: selected.id, ok: false, errorCode: 'runtime_not_ready' },
      ]);
      expect(fixture.registration.appKeyCalls).toEqual([]);
      expect(fixture.registration.registerCalls).toEqual([]);
    },
  );

  it('validates every requested row before the first external call', async () => {
    const ready = runtime('codex');
    const missingId = `rt_${'e'.repeat(32)}`;
    const fixture = await harness([ready]);

    const results = await fixture.service.enableSelected([missingId, ready.id]);

    expect(results[0]).toEqual({ runtimeId: missingId, ok: false, errorCode: 'runtime_not_found' });
    expect(results[1]).toMatchObject({ runtimeId: ready.id, ok: true });
    expect(fixture.source.calls).toBe(1);
    expect(fixture.registration.registerCalls).toHaveLength(1);
  });

  it('collapses duplicate runtime IDs while preserving first-occurrence order', async () => {
    const codex = runtime('codex');
    const hermes = runtime('hermes');
    const fixture = await harness([codex, hermes]);
    const results = await fixture.service.enableSelected([hermes.id, codex.id, hermes.id]);
    expect(results.map((result) => result.runtimeId)).toEqual([hermes.id, codex.id]);
  });

  it('never silently replaces an existing provider with a second runtime ID', async () => {
    const existing = runtime('codex');
    const other = runtime('codex', {
      id: `rt_${'e'.repeat(32)}`,
      path: process.platform === 'win32' ? 'C:\\tools\\codex-alt.exe' : '/tools/codex-alt',
    });
    const fixture = await harness([existing, other]);
    await fixture.service.enableSelected([existing.id]);

    await expect(fixture.service.enableSelected([other.id])).resolves.toEqual([
      { runtimeId: other.id, ok: false, errorCode: 'provider_conflict' },
    ]);
    expect(fixture.registration.registerCalls).toHaveLength(1);
  });

  it('claims a provider synchronously across concurrent different-runtime enables', async () => {
    const first = runtime('codex');
    const second = runtime('codex', {
      id: `rt_${'e'.repeat(32)}`,
      path: process.platform === 'win32' ? 'C:\\tools\\codex-alt.exe' : '/tools/codex-alt',
    });
    const fixture = await harness([first, second]);

    const rows = (
      await Promise.all([
        fixture.service.enableSelected([first.id]),
        fixture.service.enableSelected([second.id]),
      ])
    ).flat();

    expect(rows.filter((row) => row.ok)).toHaveLength(1);
    expect(rows.filter((row) => !row.ok)).toEqual([
      expect.objectContaining({ ok: false, errorCode: 'provider_conflict' }),
    ]);
    expect(fixture.registration.appKeyCalls).toHaveLength(1);
    expect(fixture.registration.registerCalls).toHaveLength(1);
    expect(fixture.service.list()).toHaveLength(1);
    expect((await fixture.store.snapshot()).bindings).toHaveLength(1);
  });

  it('replans mutable binding identity after an earlier queued unregister', async () => {
    const oldRuntime = runtime('codex', {
      path: process.platform === 'win32' ? 'C:\\tools\\codex-old.exe' : '/tools/codex-old',
    });
    const trustedRuntime = runtime('codex', {
      path: process.platform === 'win32' ? 'C:\\tools\\codex-new.exe' : '/tools/codex-new',
    });
    const fixture = await harness([oldRuntime]);
    await fixture.store.saveBinding({
      runtimeId: oldRuntime.id,
      runtimePath: oldRuntime.path,
      provider: oldRuntime.provider,
      enabled: false,
      nodeName: 'old-host · Codex',
      registrationState: 'unregistered',
      updatedAt: TIME_0,
    });
    const reopened = await harness([trustedRuntime], { home: fixture.home });

    const unregistering = reopened.service.unregister(oldRuntime.id);
    const enabling = reopened.service.enableSelected([trustedRuntime.id]);
    await unregistering;
    const rows = await enabling;

    expect(rows).toMatchObject([{ runtimeId: trustedRuntime.id, ok: true }]);
    expect(reopened.registration.appKeyCalls).toHaveLength(1);
    expect(reopened.registration.registerCalls).toHaveLength(1);
    expect(reopened.service.list()).toEqual([
      expect.objectContaining({
        runtimeId: trustedRuntime.id,
        runtimePath: trustedRuntime.path,
        enabled: true,
      }),
    ]);
  });

  it('persists one stable default node name and reuses it after hostname changes', async () => {
    const selected = runtime('codex');
    const first = await harness([selected], { hostname: 'first-host' });
    await first.service.enableSelected([selected.id]);
    expect(first.registration.registerCalls[0]?.nodeName).toBe('first-host · Codex');

    const secondRegistration = new FakeRegistrationClient();
    const second = await harness([selected], {
      home: first.home,
      hostname: 'second-host',
      registration: secondRegistration,
    });
    await second.service.reregister(selected.id);
    expect(secondRegistration.refreshCalls[0]?.nodeName).toBe('first-host · Codex');
  });

  it('does not fetch AppKey or register before explicit enableSelected', async () => {
    const fixture = await harness([runtime('opencode'), runtime('openclaw')]);
    fixture.service.list();
    expect(fixture.registration.appKeyCalls).toEqual([]);
    expect(fixture.registration.registerCalls).toEqual([]);
  });

  it('returns an already-enabled complete binding idempotently without network', async () => {
    const selected = runtime('codex');
    const fixture = await harness([selected]);
    const seeded = await seedBinding(fixture.store, selected);
    const reopened = await harness([selected], { home: fixture.home });

    const result = await reopened.service.enableSelected([selected.id]);
    expect(result).toEqual([{ runtimeId: selected.id, ok: true, binding: seeded }]);
    expect(reopened.registration.appKeyCalls).toEqual([]);
    expect(reopened.registration.registerCalls).toEqual([]);
  });

  it('re-enables a disabled same-server credential offline without network', async () => {
    const selected = runtime('codex');
    const fixture = await harness([selected]);
    const disabled = await seedBinding(fixture.store, selected, { enabled: false });
    const reopened = await harness([selected], { home: fixture.home });

    const [result] = await reopened.service.enableSelected([selected.id]);
    expect(result?.ok && result.binding).toMatchObject({
      runtimeId: disabled.runtimeId,
      enabled: true,
      registrationState: 'offline',
      nodeId: disabled.nodeId,
      tokenRef: disabled.tokenRef,
    });
    expect(reopened.registration.registerCalls).toEqual([]);
  });

  it('uses exact AppKey/register flow and never claims IDs with unknown or changed server provenance', async () => {
    const selected = runtime('codex');
    const sameServer = await harness([selected]);
    await sameServer.store.saveBinding({
      runtimeId: selected.id,
      runtimePath: selected.path,
      provider: 'codex',
      enabled: false,
      nodeId: 'codex_incomplete',
      nodeName: 'saved · Codex',
      registrationState: 'error',
      lastErrorCode: 'registration_transport',
      updatedAt: TIME_0,
    });
    const reopenedSame = await harness([selected], { home: sameServer.home });
    await reopenedSame.service.enableSelected([selected.id]);
    expect(reopenedSame.registration.appKeyCalls).toEqual(['https://newsradar.dreamdt.cn/im']);
    expect(reopenedSame.registration.registerCalls[0]).not.toHaveProperty('existingNodeId');
    expect(reopenedSame.registration.registerCalls[0]).not.toHaveProperty('existingNodeToken');

    const changed = await harness([selected]);
    await seedBinding(changed.store, selected, { serverUrl: 'https://old.example/im' });
    await changed.store.saveConfig({
      schemaVersion: 1,
      serverUrl: 'https://new.example/im',
      defaultWorkdir: null,
      authorizedWorkRoots: [],
      providerPathOverrides: {},
      logLevel: 'info',
    });
    const reopenedChanged = await harness([selected], { home: changed.home });
    await reopenedChanged.service.enableSelected([selected.id]);
    expect(reopenedChanged.registration.registerCalls[0]).not.toHaveProperty('existingNodeId');
    expect(reopenedChanged.registration.registerCalls[0]).not.toHaveProperty('existingNodeToken');
  });

  it('registers four providers with exact identities and distinct credential references', async () => {
    const runtimes = (['opencode', 'openclaw', 'codex', 'hermes'] as const).map((provider) =>
      runtime(provider),
    );
    const fixture = await harness(runtimes);
    const results = await fixture.service.enableSelected(runtimes.map((entry) => entry.id));

    expect(results.every((result) => result.ok)).toBe(true);
    expect(fixture.registration.registerCalls.map((call) => call.provider).sort()).toEqual([
      'codex',
      'hermes',
      'openclaw',
      'opencode',
    ]);
    const refs = results.flatMap((result) => (result.ok ? [result.binding.tokenRef] : []));
    expect(new Set(refs).size).toBe(4);
  });

  it('keeps Hermes rejection independent from successful providers', async () => {
    const runtimes = [runtime('opencode'), runtime('hermes')];
    const registration = new FakeRegistrationClient();
    registration.registerImplementation = async (input) => {
      if (input.provider === 'hermes') {
        throw new RegistrationError('registration_rejected', 'registration', false);
      }
      return { nodeId: 'opencode_ok', nodeName: input.nodeName, token: 'opencode-token' };
    };
    const fixture = await harness(runtimes, { registration });
    const results = await fixture.service.enableSelected(runtimes.map((entry) => entry.id));

    expect(results[0]).toMatchObject({ ok: true, runtimeId: runtimes[0]!.id });
    expect(results[1]).toEqual({
      ok: false,
      runtimeId: runtimes[1]!.id,
      errorCode: 'registration_rejected',
    });
    expect(fixture.service.list()).toEqual([
      expect.objectContaining({ provider: 'opencode', enabled: true }),
      expect.objectContaining({
        provider: 'hermes',
        enabled: false,
        registrationState: 'error',
        lastErrorCode: 'registration_rejected',
      }),
    ]);
  });

  it('persists each partial success before a different provider finishes', async () => {
    const opencode = runtime('opencode');
    const hermes = runtime('hermes');
    const pendingHermes = deferred<RegistrationResult>();
    const registration = new FakeRegistrationClient();
    registration.registerImplementation = async (input) =>
      input.provider === 'hermes'
        ? pendingHermes.promise
        : { nodeId: 'opencode_ok', nodeName: input.nodeName, token: 'opencode-token' };
    const fixture = await harness([opencode, hermes], { registration });
    const enabling = fixture.service.enableSelected([opencode.id, hermes.id]);

    await vi.waitFor(async () => {
      expect((await fixture.store.snapshot()).bindings).toContainEqual(
        expect.objectContaining({ provider: 'opencode', enabled: true, registrationState: 'offline' }),
      );
    });
    pendingHermes.reject(new RegistrationError('registration_rejected', 'registration', false));
    await expect(enabling).resolves.toEqual([
      expect.objectContaining({ ok: true, runtimeId: opencode.id }),
      { ok: false, runtimeId: hermes.id, errorCode: 'registration_rejected' },
    ]);
  });

  it('persists a new failure as disabled error state without inline credentials', async () => {
    const selected = runtime('hermes');
    const registration = new FakeRegistrationClient();
    registration.registerImplementation = async () => {
      throw new RegistrationError('registration_transport', 'transport', true);
    };
    const fixture = await harness([selected], { registration });
    const results = await fixture.service.enableSelected([selected.id]);

    expect(results).toEqual([
      { runtimeId: selected.id, ok: false, errorCode: 'registration_transport' },
    ]);
    const serialized = JSON.stringify(await fixture.store.snapshot());
    expect(serialized).toContain('registration_transport');
    expect(serialized).not.toContain('token');
    expect(serialized).not.toContain('public-app-key');
  });

  it('restores an existing usable credential when a controlled replacement fails', async () => {
    const selected = runtime('codex');
    const fixture = await harness([selected]);
    const old = await seedBinding(fixture.store, selected, { serverUrl: 'https://old.example/im' });
    await fixture.store.saveConfig({
      schemaVersion: 1,
      serverUrl: 'https://new.example/im',
      defaultWorkdir: null,
      authorizedWorkRoots: [],
      providerPathOverrides: {},
      logLevel: 'info',
    });
    const registration = new FakeRegistrationClient();
    registration.registerImplementation = async () => {
      throw new RegistrationError('registration_rejected', 'registration', false);
    };
    const reopened = await harness([selected], { home: fixture.home, registration });
    await reopened.service.enableSelected([selected.id]);

    const current = reopened.service.list()[0]!;
    expect(current.tokenRef).toBe(old.tokenRef);
    expect(reopened.store.credential(old.tokenRef!)?.token).toBe('old-rongcloud-token');
  });

  it('shares one in-flight enable for concurrent calls to the same runtime', async () => {
    const selected = runtime('codex');
    const pending = deferred<RegistrationResult>();
    const registration = new FakeRegistrationClient();
    registration.registerImplementation = async () => pending.promise;
    const fixture = await harness([selected], { registration });

    const first = fixture.service.enableSelected([selected.id]);
    const second = fixture.service.enableSelected([selected.id]);
    await vi.waitFor(() => expect(registration.registerCalls).toHaveLength(1));
    pending.resolve({ nodeId: 'codex_shared', nodeName: 'fixture-host · Codex', token: 'shared-token' });
    const [left, right] = await Promise.all([first, second]);
    expect(left).toEqual(right);
    expect(registration.registerCalls).toHaveLength(1);
  });

  it('runs a later unregister after deferred enable and removes its new credential', async () => {
    const selected = runtime('codex');
    const pending = deferred<RegistrationResult>();
    const registration = new FakeRegistrationClient();
    registration.registerImplementation = async () => pending.promise;
    const fixture = await harness([selected], { registration });

    const enabling = fixture.service.enableSelected([selected.id]);
    await vi.waitFor(() => expect(registration.registerCalls).toHaveLength(1));
    const unregistering = fixture.service.unregister(selected.id);
    pending.resolve({
      nodeId: 'codex_ordered',
      nodeName: 'fixture-host · Codex',
      token: 'ordered-token',
    });
    const [enabled] = await enabling;
    await unregistering;

    expect(enabled?.ok).toBe(true);
    expect(fixture.service.list()).toEqual([]);
    expect(
      enabled?.ok ? fixture.store.credential(enabled.binding.tokenRef!) : undefined,
    ).toBeUndefined();
    expect(registration.registerCalls).toHaveLength(1);
    expect(registration.refreshCalls).toEqual([]);
  });

  it('runs a later disable after deferred enable so call order leaves the binding disabled', async () => {
    const selected = runtime('codex');
    const pending = deferred<RegistrationResult>();
    const registration = new FakeRegistrationClient();
    registration.registerImplementation = async () => pending.promise;
    const fixture = await harness([selected], { registration });

    const enabling = fixture.service.enableSelected([selected.id]);
    await vi.waitFor(() => expect(registration.registerCalls).toHaveLength(1));
    const disabling = fixture.service.disable(selected.id);
    pending.resolve({
      nodeId: 'codex_ordered',
      nodeName: 'fixture-host · Codex',
      token: 'ordered-token',
    });
    await enabling;
    const disabled = await disabling;

    expect(disabled).toMatchObject({ enabled: false, registrationState: 'offline' });
    expect(fixture.service.list()[0]).toMatchObject({
      enabled: false,
      registrationState: 'offline',
      tokenRef: disabled.tokenRef,
    });
    expect(fixture.store.credential(disabled.tokenRef!)?.token).toBe('ordered-token');
    expect(registration.registerCalls).toHaveLength(1);
    expect(registration.refreshCalls).toEqual([]);
  });

  it('runs a later unregister after deferred refresh and removes old and refreshed credentials', async () => {
    const selected = runtime('codex');
    const fixture = await harness([selected]);
    const old = await seedBinding(fixture.store, selected);
    const pending = deferred<RegistrationResult>();
    const registration = new FakeRegistrationClient();
    registration.refreshImplementation = async () => pending.promise;
    const reopened = await harness([selected], { home: fixture.home, registration });

    const refreshing = reopened.service.reregister(selected.id);
    await vi.waitFor(() => expect(registration.refreshCalls).toHaveLength(1));
    const unregistering = reopened.service.unregister(selected.id);
    pending.resolve({
      nodeId: old.nodeId!,
      nodeName: old.nodeName,
      token: 'refreshed-ordered-token',
    });
    const refreshed = await refreshing;
    await unregistering;

    expect(refreshed.ok).toBe(true);
    expect(reopened.service.list()).toEqual([]);
    expect(reopened.store.credential(old.tokenRef!)).toBeUndefined();
    expect(
      refreshed.ok ? reopened.store.credential(refreshed.binding.tokenRef!) : undefined,
    ).toBeUndefined();
    expect(registration.registerCalls).toEqual([]);
    expect(registration.refreshCalls).toHaveLength(1);
  });

  it('lets different providers finish independently while serialized disk writes stay consistent', async () => {
    const codex = runtime('codex');
    const hermes = runtime('hermes');
    const pendingCodex = deferred<RegistrationResult>();
    const registration = new FakeRegistrationClient();
    registration.registerImplementation = async (input) =>
      input.provider === 'codex'
        ? pendingCodex.promise
        : { nodeId: 'hermes_fast', nodeName: input.nodeName, token: 'hermes-token' };
    const fixture = await harness([codex, hermes], { registration });
    const enabling = fixture.service.enableSelected([codex.id, hermes.id]);

    await vi.waitFor(async () => {
      expect((await fixture.store.snapshot()).bindings).toContainEqual(
        expect.objectContaining({ provider: 'hermes', enabled: true }),
      );
    });
    pendingCodex.resolve({ nodeId: 'codex_slow', nodeName: 'fixture-host · Codex', token: 'codex-token' });
    await enabling;
    const reopened = await LocalStore.open({ homeDirectory: fixture.home });
    expect((await reopened.snapshot()).bindings).toHaveLength(2);
  });

  it('persists every successful registration offline and never online', async () => {
    const selected = runtime('codex');
    const fixture = await harness([selected]);
    const [result] = await fixture.service.enableSelected([selected.id]);
    expect(result?.ok && result.binding.registrationState).toBe('offline');
  });

  it('demotes persisted online state on restart and does not register', async () => {
    const selected = runtime('codex');
    const first = await harness([selected]);
    const seeded = await seedBinding(first.store, selected);
    await first.store.saveBinding({ ...seeded, registrationState: 'online' });
    const registration = new FakeRegistrationClient();
    const restarted = await harness([selected], { home: first.home, registration });
    expect(restarted.service.list()[0]?.registrationState).toBe('offline');
    expect(registration.registerCalls).toEqual([]);
  });

  it('does not remap a persisted binding to a changed runtime ID or path', async () => {
    const selected = runtime('codex');
    const first = await harness([selected]);
    await seedBinding(first.store, selected);
    const changed = runtime('codex', {
      id: `rt_${'e'.repeat(32)}`,
      path: process.platform === 'win32' ? 'C:\\tools\\codex-new.exe' : '/tools/codex-new',
    });
    const restarted = await harness([changed], { home: first.home });

    await expect(restarted.service.reregister(selected.id)).resolves.toEqual({
      runtimeId: selected.id,
      ok: false,
      errorCode: 'runtime_identity_changed',
    });
    expect(restarted.registration.refreshCalls).toEqual([]);
  });

  it('disables locally while retaining node ID, token reference, and credential', async () => {
    const selected = runtime('codex');
    const fixture = await harness([selected]);
    const seeded = await seedBinding(fixture.store, selected);
    const reopened = await harness([selected], { home: fixture.home });

    const disabled = await reopened.service.disable(selected.id);
    expect(disabled).toMatchObject({
      enabled: false,
      registrationState: 'offline',
      nodeId: seeded.nodeId,
      tokenRef: seeded.tokenRef,
    });
    expect(reopened.store.credential(seeded.tokenRef!)?.token).toBe('old-rongcloud-token');
    expect(reopened.registration.registerCalls).toEqual([]);
    expect(reopened.registration.refreshCalls).toEqual([]);
  });

  it('reregisters only the chosen binding through refresh and credentials-first swap', async () => {
    const codex = runtime('codex');
    const hermes = runtime('hermes');
    const fixture = await harness([codex, hermes]);
    const old = await seedBinding(fixture.store, codex);
    await seedBinding(fixture.store, hermes);
    const reopened = await harness([codex, hermes], { home: fixture.home });

    const result = await reopened.service.reregister(codex.id);
    expect(result).toMatchObject({ ok: true, runtimeId: codex.id });
    expect(reopened.registration.registerCalls).toEqual([]);
    expect(reopened.registration.refreshCalls).toHaveLength(1);
    expect(reopened.registration.refreshCalls[0]).toMatchObject({
      runtimeId: codex.id,
      nodeId: old.nodeId,
      provider: 'codex',
    });
    expect(reopened.registration.refreshCalls[0]).not.toHaveProperty('existingNodeToken');
    const current = result.ok ? result.binding : undefined;
    expect(current?.tokenRef).not.toBe(old.tokenRef);
    expect(current?.registrationState).toBe('offline');
    expect(reopened.store.credential(old.tokenRef!)).toBeUndefined();
    expect(reopened.store.credential(current!.tokenRef!)?.token).toBe('codex-refreshed-token');
  });

  it('rejects cross-server reregister without network and preserves the old credential', async () => {
    const selected = runtime('codex');
    const fixture = await harness([selected]);
    const old = await seedBinding(fixture.store, selected, {
      serverUrl: 'https://old.example/im',
    });
    await fixture.store.saveConfig({
      schemaVersion: 1,
      serverUrl: 'https://new.example/im',
      defaultWorkdir: null,
      authorizedWorkRoots: [],
      providerPathOverrides: {},
      logLevel: 'info',
    });
    const reopened = await harness([selected], { home: fixture.home });

    await expect(reopened.service.reregister(selected.id)).resolves.toEqual({
      runtimeId: selected.id,
      ok: false,
      errorCode: 'runtime_identity_changed',
    });
    expect(reopened.registration.appKeyCalls).toEqual([]);
    expect(reopened.registration.registerCalls).toEqual([]);
    expect(reopened.registration.refreshCalls).toEqual([]);
    expect(reopened.source.calls).toBe(0);
    expect(reopened.service.list()[0]?.tokenRef).toBe(old.tokenRef);
    expect(reopened.store.credential(old.tokenRef!)?.token).toBe('old-rongcloud-token');
  });

  it('retains the old token reference and credential after failed reregister', async () => {
    const selected = runtime('codex');
    const fixture = await harness([selected]);
    const old = await seedBinding(fixture.store, selected);
    const registration = new FakeRegistrationClient();
    registration.refreshImplementation = async () => {
      throw new RegistrationError('token_refresh_failed', 'registration', false);
    };
    const reopened = await harness([selected], { home: fixture.home, registration });

    await expect(reopened.service.reregister(selected.id)).resolves.toEqual({
      runtimeId: selected.id,
      ok: false,
      errorCode: 'token_refresh_failed',
    });
    expect(reopened.service.list()[0]?.tokenRef).toBe(old.tokenRef);
    expect(reopened.store.credential(old.tokenRef!)?.token).toBe('old-rongcloud-token');
  });

  it('unregisters local state idempotently without any remote-delete request', async () => {
    const selected = runtime('codex');
    const fixture = await harness([selected]);
    const seeded = await seedBinding(fixture.store, selected);
    const reopened = await harness([selected], { home: fixture.home });

    await reopened.service.unregister(selected.id);
    await reopened.service.unregister(selected.id);
    expect(reopened.service.list()).toEqual([]);
    expect(reopened.store.credential(seeded.tokenRef!)).toBeUndefined();
    expect(reopened.registration.registerCalls).toEqual([]);
    expect(reopened.registration.refreshCalls).toEqual([]);
  });

  it('keeps raw responses, credentials, install identity, and runtime paths out of failure results', async () => {
    const selected = runtime('hermes', {
      path: process.platform === 'win32' ? 'C:\\SENTINEL_PROVIDER_PATH\\hermes.exe' : '/SENTINEL_PROVIDER_PATH/hermes',
    });
    const registration = new FakeRegistrationClient();
    registration.registerImplementation = async () => {
      throw new RegistrationError('registration_rejected', 'registration', false);
    };
    const fixture = await harness([selected], { registration });
    const result = await fixture.service.enableSelected([selected.id]);
    const output = JSON.stringify(result);
    expect(output).toBe(
      JSON.stringify([{ runtimeId: selected.id, ok: false, errorCode: 'registration_rejected' }]),
    );
    for (const sentinel of [
      'SENTINEL_PROVIDER_PATH',
      fixture.store.bridgeIdentity().installId,
      fixture.store.bridgeIdentity().secret,
      'public-app-key',
      'old-rongcloud-token',
    ]) {
      expect(output).not.toContain(sentinel);
    }
  });

  it('blocks runtime discovery and registration across config-recovery restart until explicit save', async () => {
    const home = await temporaryHome();
    const paths = localPaths(home);
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.config, '{malformed');
    await harness([runtime('codex')], { home });
    const fixture = await harness([runtime('codex')], { home });

    await expect(fixture.service.enableSelected([runtime('codex').id])).resolves.toEqual([
      {
        runtimeId: runtime('codex').id,
        ok: false,
        errorCode: 'config_recovery_required',
      },
    ]);
    expect(fixture.source.calls).toBe(0);
    expect(fixture.registration.appKeyCalls).toEqual([]);

    await fixture.store.saveConfig(DEFAULT_CONFIG);
    await expect(fixture.service.enableSelected([runtime('codex').id])).resolves.toMatchObject([
      { runtimeId: runtime('codex').id, ok: true },
    ]);
    expect(fixture.source.calls).toBe(1);
    expect(fixture.registration.appKeyCalls).toEqual([DEFAULT_CONFIG.serverUrl]);
  });
});
