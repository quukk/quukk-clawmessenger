// @vitest-environment node

import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import type { ActivityResponse, DiagnosticsResponse, EnableResponse } from '../../src/http/routes.js';
import type { NormalizedRongCloudMessage } from '../../src/protocol/messages.js';
import { FakeRegistrationServer } from './fake-registration.js';
import {
  createE2EHarness,
  E2E_RUNTIME_IDS,
  FakeBridgeRuntime,
  removeE2EHome,
  temporaryE2EHome,
  type E2EHarness,
} from './fake-runtime.js';

function message(uid: string, text: string): NormalizedRongCloudMessage {
  return {
    messageUid: uid,
    senderId: 'restart-sender',
    targetId: 'restart-group',
    conversationType: 3,
    objectName: 'RC:TxtMsg',
    text,
    attachments: [],
  };
}

function expectOrdered(trace: readonly string[], before: string, after: string): void {
  expect(trace.indexOf(before), `${before} missing`).toBeGreaterThanOrEqual(0);
  expect(trace.indexOf(after), `${after} missing`).toBeGreaterThan(trace.indexOf(before));
}

describe('Quukk restart E2E', () => {
  it('persists provider sessions, restores workers, redacts diagnostics, and stops in dependency order', async () => {
    const homeDirectory = await temporaryE2EHome();
    const trace: string[] = [];
    const runtime = new FakeBridgeRuntime(homeDirectory, trace);
    runtime.setAllReady();
    const registration = new FakeRegistrationServer();
    let first: E2EHarness | undefined;
    let second: E2EHarness | undefined;
    try {
      first = await createE2EHarness({ homeDirectory, runtime, registration, trace });
      const enabled = await first.api.post<EnableResponse>('/api/bindings/enable', {
        runtimeIds: [E2E_RUNTIME_IDS.opencode, E2E_RUNTIME_IDS.openclaw],
      });
      expect(enabled.results.every(({ ok }) => ok)).toBe(true);
      first.workers.emitMessage(E2E_RUNTIME_IDS.opencode, message('before-opencode', 'PROMPT-SENTINEL-OPENCODE'));
      first.workers.emitMessage(E2E_RUNTIME_IDS.openclaw, message('before-openclaw', 'PROMPT-SENTINEL-OPENCLAW'));
      await vi.waitFor(() => expect(runtime.taskStarts()).toHaveLength(2));
      await vi.waitFor(() => expect(first!.workers.outbound().filter(({ input }) =>
        input.messageType === 'text' && String(input.content).startsWith('reply:'))).toHaveLength(2));
      const initialSessions = new Map(runtime.taskStarts().map(({ runtimeId, sessionId }) => [runtimeId, sessionId]));

      const shutdown = await first.shutdownViaControl();
      expect(shutdown).toMatchObject({ status: 202 });
      expectOrdered(trace, 'workers.dispose', 'bridge.stop.begin');
      expectOrdered(trace, 'bridge.stop.begin', 'bridge.shutdown.flushed');
      expectOrdered(trace, 'bridge.shutdown.flushed', 'bridge.http.close');
      expectOrdered(trace, 'bridge.http.close', 'bridge.stop.end');
      await first.close();
      first = undefined;

      second = await createE2EHarness({ homeDirectory, runtime, registration, trace });
      expect(new Set(second.workers.bindings().map(({ runtimeId }) => runtimeId))).toEqual(new Set([
        E2E_RUNTIME_IDS.opencode,
        E2E_RUNTIME_IDS.openclaw,
      ]));
      expect(registration.registrations()).toHaveLength(2);

      second.workers.emitMessage(E2E_RUNTIME_IDS.opencode, message('after-opencode', 'PROMPT-SENTINEL-OPENCODE'));
      second.workers.emitMessage(E2E_RUNTIME_IDS.openclaw, message('after-openclaw', 'PROMPT-SENTINEL-OPENCLAW'));
      await vi.waitFor(() => expect(runtime.taskStarts()).toHaveLength(4));
      await vi.waitFor(() => expect(second!.workers.outbound().filter(({ input }) =>
        input.messageType === 'text' && String(input.content).startsWith('reply:'))).toHaveLength(2));
      for (const start of runtime.taskStarts().slice(2)) {
        expect(start.resumeSessionId).toBe(initialSessions.get(start.runtimeId));
        expect(start.sessionId).toBe(initialSessions.get(start.runtimeId));
      }

      const diagnostics = await second.api.get<DiagnosticsResponse>('/api/diagnostics');
      const activity = await second.api.get<ActivityResponse>('/api/activity');
      const publicMaterial = JSON.stringify([
        diagnostics,
        activity,
        second.workers.snapshots(),
        second.workers.outbound(),
      ]);
      const identity = second.store.bridgeIdentity();
      const sentinels = [
        identity.secret,
        identity.installId,
        registration.appKey,
        ...registration.tokens(),
        ...registration.proofs(),
        ...registration.macs(),
        'PROMPT-SENTINEL-OPENCODE',
        'PROMPT-SENTINEL-OPENCLAW',
        ...(['opencode', 'openclaw', 'codex', 'hermes'] as const).map((provider) => runtime.runtimePath(provider)),
      ];
      for (const sentinel of sentinels) expect(publicMaterial).not.toContain(sentinel);
      expect(registration.rawSecretSeen()).toBe(false);

      const logPath = second.logPath;
      await second.shutdownViaControl();
      const logs = await readFile(logPath, 'utf8');
      for (const sentinel of sentinels) expect(logs).not.toContain(sentinel);
      expect(runtime.shutdownRequests()).toBe(2);
      second = undefined;
    } finally {
      await second?.close();
      await first?.close();
      await runtime.close().catch(() => undefined);
      await registration.close().catch(() => undefined);
      await removeE2EHome(homeDirectory);
    }
  });
});
