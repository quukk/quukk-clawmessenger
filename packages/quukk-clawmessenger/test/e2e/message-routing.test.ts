// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

import type { EnableResponse } from '../../src/http/routes.js';
import type { NormalizedRongCloudMessage } from '../../src/protocol/messages.js';
import {
  createE2EHarness,
  E2E_RUNTIME_IDS,
  type E2EHarness,
} from './fake-runtime.js';

function message(uid: string, text: string): NormalizedRongCloudMessage {
  return {
    messageUid: uid,
    senderId: 'same-sender',
    targetId: 'same-group',
    conversationType: 3,
    objectName: 'RC:TxtMsg',
    text,
    attachments: [],
  };
}

function permission(uid: string): NormalizedRongCloudMessage {
  return {
    ...message(uid, ''),
    text: undefined,
    objectName: 'RC:CmdMsg',
    rawContent: {
      msg_type: 'card_action',
      cardId: 'approval-card',
      buttonId: 'approval-button',
      request_id: 'approval-request',
      action: { type: 'permission', permissionId: 'permission-one', reply: 'once' },
      timestamp: 1,
    },
  };
}

async function enablePair(harness: Awaited<ReturnType<typeof createE2EHarness>>): Promise<void> {
  const result = await harness.api.post<EnableResponse>('/api/bindings/enable', {
    runtimeIds: [E2E_RUNTIME_IDS.opencode, E2E_RUNTIME_IDS.openclaw],
  });
  expect(result.results.every(({ ok }) => ok)).toBe(true);
}

function expectSafeMaterial(harness: E2EHarness, material: unknown, prompts: readonly string[]): void {
  const identity = harness.store.bridgeIdentity();
  const serialized = JSON.stringify(material);
  const sentinels = [
    identity.secret,
    identity.installId,
    harness.registration.appKey,
    ...harness.registration.tokens(),
    ...harness.registration.proofs(),
    ...harness.registration.macs(),
    ...prompts,
    ...(['opencode', 'openclaw', 'codex', 'hermes'] as const)
      .map((provider) => harness.runtime.runtimePath(provider)),
  ];
  for (const sentinel of sentinels) expect(serialized).not.toContain(sentinel);
}

describe('Quukk message-routing E2E', () => {
  it('isolates the same conversation and message UID by provider and deduplicates within each binding', async () => {
    const harness = await createE2EHarness();
    try {
      await enablePair(harness);
      harness.workers.emitMessage(E2E_RUNTIME_IDS.opencode, message('same-message-uid', 'PROMPT-SECRET-ONE'));
      harness.workers.emitMessage(E2E_RUNTIME_IDS.openclaw, message('same-message-uid', 'PROMPT-SECRET-TWO'));

      await vi.waitFor(() => expect(harness.runtime.taskStarts()).toHaveLength(2));
      await vi.waitFor(() => expect(harness.workers.outbound().filter(({ input }) =>
        input.messageType === 'text' && String(input.content).startsWith('reply:'))).toHaveLength(2));

      const starts = harness.runtime.taskStarts();
      expect(new Set(starts.map(({ conversationKey }) => conversationKey)).size).toBe(2);
      expect(new Set(starts.map(({ sessionId }) => sessionId)).size).toBe(2);
      expect(harness.workers.outbound()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          identity: expect.objectContaining({ runtimeId: E2E_RUNTIME_IDS.opencode }),
          input: expect.objectContaining({ messageType: 'text', content: 'reply:opencode' }),
        }),
        expect.objectContaining({
          identity: expect.objectContaining({ runtimeId: E2E_RUNTIME_IDS.openclaw }),
          input: expect.objectContaining({ messageType: 'text', content: 'reply:openclaw' }),
        }),
      ]));

      harness.workers.emitMessage(E2E_RUNTIME_IDS.opencode, message('same-message-uid', 'PROMPT-DUPLICATE'));
      await vi.waitFor(() => expect(harness.runtime.taskStarts()).toHaveLength(2));
      expect(harness.runtime.taskStarts()).toHaveLength(2);
      expectSafeMaterial(harness, [
        harness.runtime.taskStarts(),
        harness.workers.snapshots(),
        harness.workers.outbound(),
      ], ['PROMPT-SECRET-ONE', 'PROMPT-SECRET-TWO', 'PROMPT-DUPLICATE']);
      expect(harness.registration.rawSecretSeen()).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it('keeps crash, reconnect, cancel, SSE resume, and CardKit 501 effects on their binding', async () => {
    const harness = await createE2EHarness();
    try {
      await enablePair(harness);
      const held = harness.runtime.holdNext('opencode');
      harness.runtime.disconnectNextEventStream('openclaw');
      harness.workers.emitMessage(E2E_RUNTIME_IDS.opencode, message('crash-active', 'PROMPT-CRASH-SENTINEL'));
      harness.workers.emitMessage(E2E_RUNTIME_IDS.openclaw, message('reconnect-active', 'PROMPT-RECONNECT-SENTINEL'));

      await vi.waitFor(() => expect(harness.runtime.taskStarts()).toHaveLength(2));
      harness.workers.crash(E2E_RUNTIME_IDS.opencode);
      held.release();
      await vi.waitFor(() => expect(harness.runtime.reconnectRequests()).toBeGreaterThan(0));
      await vi.waitFor(() => expect(harness.workers.outbound().some(({ identity, input }) =>
        identity.runtimeId === E2E_RUNTIME_IDS.openclaw
        && input.messageType === 'text'
        && input.content === 'reply:openclaw')).toBe(true));
      expect(harness.workers.outbound().some(({ identity, input }) =>
        identity.runtimeId === E2E_RUNTIME_IDS.opencode
        && input.messageType === 'text'
        && input.content === 'reply:opencode')).toBe(false);

      harness.workers.reconnect(E2E_RUNTIME_IDS.opencode);
      await vi.waitFor(() => expect(harness.workers.outbound().some(({ identity, input }) =>
        identity.runtimeId === E2E_RUNTIME_IDS.opencode
        && input.messageType === 'text'
        && input.content === 'reply:opencode')).toBe(true));

      const cancelGate = harness.runtime.holdNext('openclaw');
      harness.workers.emitMessage(E2E_RUNTIME_IDS.openclaw, message('cancel-active', 'PROMPT-CANCEL-SENTINEL'));
      await vi.waitFor(() => expect(harness.runtime.taskStarts()).toHaveLength(3));
      harness.workers.emitMessage(E2E_RUNTIME_IDS.openclaw, message('cancel-command', '/stop'));
      await vi.waitFor(() => expect(harness.runtime.cancelRequests()).toBe(1));
      cancelGate.release();
      await vi.waitFor(() => expect(harness.workers.outbound().some(({ identity, input }) =>
        identity.runtimeId === E2E_RUNTIME_IDS.openclaw
        && input.messageType === 'text'
        && input.content === '[cancelled]')).toBe(true));

      harness.workers.emitMessage(E2E_RUNTIME_IDS.opencode, permission('permission-action'));
      await vi.waitFor(() => expect(harness.workers.outbound().some(({ identity, input }) =>
        identity.runtimeId === E2E_RUNTIME_IDS.opencode
        && input.messageType === 'command_result'
        && input.content.code === 501
        && input.content.message === 'unsupported_interactive_approval')).toBe(true));
      await vi.waitFor(() => expect(harness.workers.receipts().some(({ identity, input }) =>
        identity.runtimeId === E2E_RUNTIME_IDS.opencode
        && input.messageUid === 'permission-action')).toBe(true));
      expectSafeMaterial(harness, [
        harness.runtime.taskStarts(),
        harness.workers.snapshots(),
        harness.workers.outbound(),
        harness.workers.receipts(),
      ], ['PROMPT-CRASH-SENTINEL', 'PROMPT-RECONNECT-SENTINEL', 'PROMPT-CANCEL-SENTINEL']);
      expect(harness.registration.rawSecretSeen()).toBe(false);
    } finally {
      await harness.close();
    }
  });
});
