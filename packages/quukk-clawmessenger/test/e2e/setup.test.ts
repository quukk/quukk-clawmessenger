// @vitest-environment node

import { access } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import type { EnableResponse, RuntimesResponse } from '../../src/http/routes.js';
import {
  createE2EHarness,
  E2E_RUNTIME_IDS,
  type E2EHarness,
} from './fake-runtime.js';
import { FakeRegistrationServer } from './fake-registration.js';
import { expectNoSentinels } from './redaction-assertions.js';

function sensitiveSentinels(harness: E2EHarness): string[] {
  const identity = harness.store.bridgeIdentity();
  return [
    identity.secret,
    identity.installId,
    harness.registration.appKey,
    ...harness.registration.tokens(),
    ...harness.registration.proofs(),
    ...harness.registration.macs(),
    ...(['opencode', 'openclaw', 'codex', 'hermes'] as const)
      .map((provider) => harness.runtime.runtimePath(provider)),
  ];
}

function expectRedacted(material: unknown, harness: E2EHarness): void {
  expectNoSentinels(material, sensitiveSentinels(harness));
}

describe('Quukk setup E2E', () => {
  it('shows four safe provider views and registers only one or all selected runtimes', async () => {
    const harness = await createE2EHarness();
    try {
      const detected = await harness.api.get<RuntimesResponse>('/api/runtimes');
      expect(detected.runtimes.map(({ provider, status }) => ({ provider, status }))).toEqual([
        { provider: 'opencode', status: 'ready' },
        { provider: 'openclaw', status: 'ready' },
        { provider: 'codex', status: 'found_not_runnable' },
        { provider: 'hermes', status: 'not_found' },
      ]);
      expect(detected.runtimes.every((runtime) =>
        !Object.hasOwn(runtime, 'token') && !Object.hasOwn(runtime, 'tokenRef'))).toBe(true);
      expect(detected.runtimes.map(({ provider, path }) => ({ provider, path }))).toEqual(
        (['opencode', 'openclaw', 'codex', 'hermes'] as const).map((provider) => ({
          provider,
          path: harness.runtime.runtimePath(provider),
        })),
      );

      const one = await harness.api.post<EnableResponse>('/api/bindings/enable', {
        runtimeIds: [E2E_RUNTIME_IDS.opencode],
      });
      expect(one.results).toEqual([
        expect.objectContaining({ runtimeId: E2E_RUNTIME_IDS.opencode, ok: true }),
      ]);
      expect(harness.registration.registrations()).toHaveLength(1);
      expect(harness.workers.bindings().map(({ runtimeId }) => runtimeId)).toEqual([
        E2E_RUNTIME_IDS.opencode,
      ]);

      harness.runtime.setAllReady();
      await harness.api.post('/api/runtimes/rescan');
      const all = await harness.api.post<EnableResponse>('/api/bindings/enable', {
        runtimeIds: Object.values(E2E_RUNTIME_IDS),
      });
      expect(all.results).toHaveLength(4);
      expect(all.results.every(({ ok }) => ok)).toBe(true);
      expect(new Set(harness.registration.registrations().map(({ provider }) => provider))).toEqual(
        new Set(['opencode', 'openclaw', 'codex', 'hermes']),
      );

      const snapshot = await harness.store.snapshot({}, {});
      const enabled = snapshot.bindings.filter(({ enabled }) => enabled);
      expect(new Set(enabled.map(({ nodeId }) => nodeId)).size).toBe(4);
      expect(new Set(enabled.map(({ tokenRef }) => tokenRef)).size).toBe(4);
      expect(new Set(harness.workers.bindings().map(({ runtimeId, nodeId }) =>
        `${runtimeId}:${nodeId}`)).size).toBe(4);
      expect(new Set(harness.workers.credentialDigests()).size).toBe(4);

      // Runtime executable paths are intentionally shown by the trusted setup UI.
      expectRedacted([one, all, harness.workers.snapshots()], harness);
      expect(harness.registration.rawSecretSeen()).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it('isolates one registration failure while the other selected providers start', async () => {
    const harness = await createE2EHarness({ allReady: true });
    try {
      harness.registration.fail('openclaw');
      const result = await harness.api.post<EnableResponse>('/api/bindings/enable', {
        runtimeIds: Object.values(E2E_RUNTIME_IDS),
      });
      expect(result.results).toEqual(expect.arrayContaining([
        expect.objectContaining({ runtimeId: E2E_RUNTIME_IDS.openclaw, ok: false }),
      ]));
      const failed = result.results.find(({ runtimeId, ok }) =>
        runtimeId === E2E_RUNTIME_IDS.openclaw && !ok);
      if (failed === undefined || failed.ok) throw new Error('openclaw_failure_missing');
      expect(failed.error).toEqual({
        code: 'registration_rejected', category: 'registration', retryable: false,
      });
      expect(result.results.filter(({ ok }) => ok)).toHaveLength(3);
      expect(new Set(harness.workers.bindings().map(({ runtimeId }) => runtimeId))).toEqual(new Set([
        E2E_RUNTIME_IDS.opencode,
        E2E_RUNTIME_IDS.codex,
        E2E_RUNTIME_IDS.hermes,
      ]));
      expectRedacted([result, harness.workers.snapshots()], harness);
      expect(harness.registration.rawSecretSeen()).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it('uses a derived enrollment proof and fails closed on proof ownership or response identity conflicts', async () => {
    const harness = await createE2EHarness();
    try {
      const serverUrl = await harness.registration.start();
      const identity = harness.store.bridgeIdentity();
      const client = harness.registration.client();
      const common = {
        serverUrl,
        installId: identity.installId,
        bridgeSecret: identity.secret,
        nodeName: 'Quukk E2E node',
      };
      await client.register({
        ...common,
        runtimeId: E2E_RUNTIME_IDS.opencode,
        provider: 'opencode',
      });
      const proofConflict = await client.register({
        ...common,
        runtimeId: E2E_RUNTIME_IDS.opencode,
        provider: 'openclaw',
      }).then(() => undefined, (error: unknown) => error);
      expect(proofConflict).toMatchObject({ code: 'registration_unauthorized', retryable: false });

      harness.registration.mismatchNext('hermes');
      const identityConflict = await client.register({
        ...common,
        runtimeId: E2E_RUNTIME_IDS.hermes,
        provider: 'hermes',
      }).then(() => undefined, (error: unknown) => error);
      expect(identityConflict).toMatchObject({ code: 'registration_node_mismatch', retryable: false });
      expect(harness.registration.rawSecretSeen()).toBe(false);
      expect(new Set(harness.registration.proofs()).size).toBe(2);
      expect(harness.registration.proofs().every((proof) => !proof.includes(identity.secret))).toBe(true);
      expectRedacted([proofConflict, identityConflict], harness);
    } finally {
      await harness.close();
    }
  });

  it('detects a raw bridge secret in the registration query string', async () => {
    const registration = new FakeRegistrationServer();
    try {
      const serverUrl = await registration.start();
      const secret = 'QUERY-RAW-BRIDGE-SECRET-SENTINEL';
      registration.forbidRawSecret(secret);
      const response = await fetch(`${serverUrl}/api/ai/register?leak=${encodeURIComponent(secret)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Node-Enrollment-Token': `qce_v1_${'A'.repeat(43)}`,
        },
        body: JSON.stringify({ node_type: 'opencode' }),
      });
      expect(response.status).toBe(200);
      expect(registration.rawSecretSeen()).toBe(true);
    } finally {
      await registration.close();
    }
  });

  it('closes registration and removes its owned temporary home when setup fails', async () => {
    let acquired: { homeDirectory: string; registration: FakeRegistrationServer } | undefined;
    await expect(createE2EHarness({
      afterRegistrationStarted(context) {
        acquired = context;
        throw new Error('injected_setup_failure');
      },
    })).rejects.toThrow('injected_setup_failure');

    expect(acquired).toBeDefined();
    expect(acquired!.registration.isRunning()).toBe(false);
    await expect(access(acquired!.homeDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
