import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BridgeTaskEvent, BridgeTaskPort } from '../go/types.js';
import type { NormalizedRongCloudMessage } from '../protocol/messages.js';
import type { WorkerEvent } from '../rongcloud/worker-protocol.js';
import type { WorkerIdentity } from '../rongcloud/worker-supervisor.js';
import type { ConversationIdentity } from './conversation.js';
import {
  MessageRouter,
  type MessageRouterOptions,
  type RouterControlPort,
  type RouterLogger,
  type RouterReceipt,
  type RouterWorkerPort,
  type RouterWorkerSend,
} from './message-router.js';
import { RouterStateStore } from './session-store.js';

const TEMP_ROOT = 'D:\\A-DM\\dm-im\\.task-tmp';
const RUNTIME_A = `rt_${'a'.repeat(32)}`;
const RUNTIME_B = `rt_${'b'.repeat(32)}`;
const A: WorkerIdentity = { runtimeId: RUNTIME_A, nodeId: 'codex_node-a' };
const B: WorkerIdentity = { runtimeId: RUNTIME_B, nodeId: 'openclaw_node-b' };
const directories: string[] = [];

function message(uid: string, text = 'hello'): NormalizedRongCloudMessage {
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

function protocol(uid: string, rawContent: Record<string, unknown>): NormalizedRongCloudMessage {
  return { ...message(uid, ''), text: undefined, objectName: 'RC:CmdMsg', rawContent };
}

function inbound(identity: WorkerIdentity, value: NormalizedRongCloudMessage): WorkerEvent {
  return {
    type: 'message',
    runtimeId: identity.runtimeId,
    instanceId: `rcw_${(identity === A ? '1' : '2').repeat(32)}`,
    message: value,
  };
}

function event(
  taskId: string,
  type: BridgeTaskEvent['type'],
  overrides: Record<string, unknown> = {},
): BridgeTaskEvent {
  return {
    id: 1,
    task_id: taskId,
    type,
    time: '2026-08-27T00:00:00Z',
    ...overrides,
  } as BridgeTaskEvent;
}

function conversation(identity: WorkerIdentity): ConversationIdentity {
  return {
    ...identity,
    conversationType: 3,
    targetId: 'same-group',
    senderId: 'same-sender',
  };
}

function assignment(identity: WorkerIdentity): Record<string, unknown> {
  return {
    msg_type: 'discussion_assignment',
    protocolVersion: 2,
    discussionId: 'shared-discussion',
    chatroomId: 'same-group',
    requestId: 'shared-request',
    stateVersion: 1,
    round: 1,
    timestamp: 1,
    assignmentId: 'shared-assignment',
    targetId: identity.nodeId,
    task: 'Contribute publicly',
    topic: 'Shared topic',
    goal: 'Shared goal',
  };
}

interface IntegrationHarness {
  router: MessageRouter;
  state: RouterStateStore;
  filePath: string;
  starts: Array<Parameters<BridgeTaskPort['startTask']>[0] & { taskId: string }>;
  sent: Array<{ identity: WorkerIdentity; input: RouterWorkerSend }>;
  receipts: Array<{ identity: WorkerIdentity; input: RouterReceipt }>;
  cancellations: string[];
  joined: Array<{ identity: WorkerIdentity; roomId: string }>;
  worker: RouterWorkerPort;
  task: BridgeTaskPort;
  setEvents(factory: (taskId: string, input: Parameters<BridgeTaskPort['startTask']>[0]) => AsyncIterable<BridgeTaskEvent>): void;
}

async function harness(): Promise<IntegrationHarness> {
  await mkdir(TEMP_ROOT, { recursive: true });
  const directory = await mkdtemp(join(TEMP_ROOT, 'quukk-task10-integration-'));
  directories.push(directory);
  const filePath = join(directory, 'sessions.json');
  const state = new RouterStateStore({ filePath, now: () => 100 });
  await state.initialize();
  const starts: IntegrationHarness['starts'] = [];
  const sent: IntegrationHarness['sent'] = [];
  const receipts: IntegrationHarness['receipts'] = [];
  const cancellations: string[] = [];
  const joined: IntegrationHarness['joined'] = [];
  let events = (taskId: string, input: Parameters<BridgeTaskPort['startTask']>[0]) =>
    (async function* (): AsyncIterable<BridgeTaskEvent> {
      yield event(taskId, 'completed', {
        output: input.runtimeId === RUNTIME_A ? 'output-a' : 'output-b',
        session_id: input.runtimeId === RUNTIME_A ? 'session-a' : 'session-b',
      });
    })();
  const taskInputs = new Map<string, Parameters<BridgeTaskPort['startTask']>[0]>();
  const task: BridgeTaskPort = {
    startTask: async (input) => {
      const taskId = `task_${starts.length + 1}_1`;
      starts.push({ ...input, taskId });
      taskInputs.set(taskId, input);
      return { taskId, eventsUrl: `/v1/tasks/${taskId}/events` };
    },
    events: (taskId) => events(taskId, taskInputs.get(taskId)!),
    cancelTask: async (taskId) => { cancellations.push(taskId); },
  };
  const worker: RouterWorkerPort = {
    send: async (identity, input) => {
      sent.push({ identity: { ...identity }, input: structuredClone(input) });
      return 'outbound';
    },
    receipt: async (identity, input) => {
      receipts.push({ identity: { ...identity }, input: { ...input } });
    },
    joinChatroom: async (identity, input) => {
      joined.push({ identity: { ...identity }, roomId: input.roomId });
    },
  };
  const control: RouterControlPort = {
    authorize: async () => true,
    status: async () => ({ enabled: true, worker: 'online', runtime: 'ready' }),
    device: async () => ({ status: 'success', code: 'ok', message: 'ok' }),
    card: async () => ({ status: 'success', code: 'ok', message: 'ok' }),
    modelCatalog: async () => ({ defaultModel: null, providers: [] }),
  };
  const logger: RouterLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  const options: MessageRouterOptions = {
    task,
    worker,
    binding: {
      binding: async (identity) => ({
        ...identity,
        provider: identity.runtimeId === RUNTIME_A ? 'codex' : 'openclaw',
        enabled: true,
      }),
      authorizeDefaultWorkdir: async (identity) =>
        identity.runtimeId === RUNTIME_A ? 'D:\\work-a' : 'D:\\work-b',
    },
    control,
    state,
    logger,
    clock: () => 100,
    randomBytes: () => Buffer.alloc(16, 7),
  };
  return {
    router: new MessageRouter(options),
    state,
    filePath,
    starts,
    sent,
    receipts,
    cancellations,
    joined,
    worker,
    task,
    setEvents(factory) { events = factory; },
  };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe('MessageRouter multi-binding integration', () => {
  it('isolates identical UIDs, task/session/output routes, and persisted reopen state', async () => {
    const fixture = await harness();
    await Promise.all([
      fixture.router.onWorkerEvent(A, inbound(A, message('same-uid'))),
      fixture.router.onWorkerEvent(B, inbound(B, message('same-uid'))),
    ]);

    expect(fixture.starts).toHaveLength(2);
    expect(new Set(fixture.starts.map(({ runtimeId }) => runtimeId))).toEqual(new Set([RUNTIME_A, RUNTIME_B]));
    expect(new Set(fixture.starts.map(({ conversationKey: key }) => key)).size).toBe(2);
    expect(fixture.receipts.map(({ identity }) => identity.runtimeId).sort()).toEqual([RUNTIME_A, RUNTIME_B].sort());
    expect(fixture.sent.some(({ identity, input }) => identity.runtimeId === RUNTIME_A
      && input.messageType === 'text' && input.content === 'output-a')).toBe(true);
    expect(fixture.sent.some(({ identity, input }) => identity.runtimeId === RUNTIME_B
      && input.messageType === 'text' && input.content === 'output-b')).toBe(true);
    expect(await fixture.state.currentSession(conversation(A))).toBe('session-a');
    expect(await fixture.state.currentSession(conversation(B))).toBe('session-b');

    const reopened = new RouterStateStore({ filePath: fixture.filePath, now: () => 101 });
    await reopened.initialize();
    expect(await reopened.currentSession(conversation(A))).toBe('session-a');
    expect(await reopened.currentSession(conversation(B))).toBe('session-b');
    expect((await reopened.claimMessage(RUNTIME_A, 'same-uid', 'a'.repeat(32))).status).toBe('duplicate');
    expect((await reopened.claimMessage(RUNTIME_B, 'same-uid', 'b'.repeat(32))).status).toBe('duplicate');
  });

  it('keeps transient discussion output scoped to the crashed binding and drains only that binding online', async () => {
    const fixture = await harness();
    fixture.setEvents((taskId, input) => (async function* () {
      yield event(taskId, 'completed', {
        output: input.runtimeId === RUNTIME_A ? 'contribution-a' : 'contribution-b',
      });
    })());
    let onlineA = false;
    const send = fixture.worker.send.bind(fixture.worker);
    fixture.worker.send = async (identity, input) => {
      if (identity.runtimeId === RUNTIME_A
        && input.messageType === 'command_result'
        && input.content.msg_type === 'discussion_contribution_completed'
        && !onlineA) throw Object.assign(new Error('worker crashed'), { code: 'worker_exited' });
      return send(identity, input);
    };
    await Promise.all([
      fixture.router.onWorkerEvent(A, inbound(A, protocol('shared-discussion-uid', assignment(A)))),
      fixture.router.onWorkerEvent(B, inbound(B, protocol('shared-discussion-uid', assignment(B)))),
    ]);
    expect(fixture.starts).toHaveLength(2);
    expect(fixture.sent.some(({ identity, input }) => identity.runtimeId === RUNTIME_B
      && input.messageType === 'command_result'
      && input.content.msg_type === 'discussion_contribution_completed')).toBe(true);
    expect(fixture.sent.some(({ identity, input }) => identity.runtimeId === RUNTIME_A
      && input.messageType === 'command_result'
      && input.content.msg_type === 'discussion_contribution_completed')).toBe(false);

    onlineA = true;
    await fixture.router.onWorkerEvent(A, {
      type: 'connection', runtimeId: RUNTIME_A, instanceId: `rcw_${'1'.repeat(32)}`, state: 'online',
    });
    expect(fixture.sent.filter(({ identity, input }) => identity.runtimeId === RUNTIME_A
      && input.messageType === 'command_result'
      && input.content.msg_type === 'discussion_contribution_completed')).toHaveLength(1);
  });

  it('cancels only the exact active conversation while the other binding survives reconnect', async () => {
    const fixture = await harness();
    let cancelA!: () => void;
    let finishB!: () => void;
    const cancelledA = new Promise<void>((resolve) => { cancelA = resolve; });
    const completedB = new Promise<void>((resolve) => { finishB = resolve; });
    fixture.task.cancelTask = async (taskId) => {
      fixture.cancellations.push(taskId);
      if (taskId === 'task_1_1') cancelA();
    };
    fixture.setEvents((taskId, input) => (async function* () {
      if (input.runtimeId === RUNTIME_A) {
        await cancelledA;
        yield event(taskId, 'cancelled');
      } else {
        await completedB;
        yield event(taskId, 'completed', { output: 'b-survived' });
      }
    })());
    const activeA = fixture.router.onWorkerEvent(A, inbound(A, message('active-a')));
    const activeB = fixture.router.onWorkerEvent(B, inbound(B, message('active-b')));
    await vi.waitFor(() => expect(fixture.starts).toHaveLength(2));
    await fixture.router.onWorkerEvent(A, {
      type: 'connection', runtimeId: RUNTIME_A, instanceId: `rcw_${'1'.repeat(32)}`, state: 'offline',
    });
    const stopA = fixture.router.onWorkerEvent(A, inbound(A, message('stop-a', '/stop')));
    await Promise.all([activeA, stopA]);
    expect(fixture.cancellations).toEqual(['task_1_1']);
    expect(fixture.sent.some(({ identity, input }) => identity.runtimeId === RUNTIME_B
      && input.messageType === 'text' && input.content === '[cancelled]')).toBe(false);
    finishB();
    await activeB;
    expect(fixture.sent.some(({ identity, input }) => identity.runtimeId === RUNTIME_B
      && input.messageType === 'text' && input.content === 'b-survived')).toBe(true);
  });

  it('keeps device, CardKit, chatroom, and authentication failure effects on their inbound bindings', async () => {
    const fixture = await harness();
    await Promise.all([A, B].map((identity) => fixture.router.onWorkerEvent(identity, inbound(identity, protocol(
      'same-device-uid',
      {
        msg_type: 'device_status_request',
        request_id: 'status',
        source_im_id: 'same-sender',
        destination_im_id: identity.nodeId,
      },
    )))));
    await Promise.all([A, B].map((identity) => fixture.router.onWorkerEvent(identity, inbound(identity, protocol(
      'same-card-uid',
      { msg_type: 'card_action', cardId: 'card', action: { type: 'none' }, timestamp: 1 },
    )))));
    await Promise.all([A, B].map((identity) => fixture.router.onWorkerEvent(identity, inbound(identity, protocol(
      'same-room-uid',
      { msg_type: 'chatroom_invite', chatroom_id: 'room-shared' },
    )))));
    expect(fixture.joined.map(({ identity }) => identity.runtimeId).sort()).toEqual([RUNTIME_A, RUNTIME_B].sort());
    expect(fixture.receipts.filter(({ input }) => input.messageUid === 'same-card-uid')).toHaveLength(2);

    fixture.setEvents((taskId, input) => (async function* () {
      if (input.runtimeId === RUNTIME_A) {
        yield event(taskId, 'failed', {
          error: { category: 'authentication', message: 'raw auth detail' },
        });
      } else {
        yield event(taskId, 'completed', { output: 'healthy-b' });
      }
    })());
    await Promise.all([
      fixture.router.onWorkerEvent(A, inbound(A, message('auth-a'))),
      fixture.router.onWorkerEvent(B, inbound(B, message('auth-b'))),
    ]);
    expect(fixture.sent.some(({ identity, input }) => identity.runtimeId === RUNTIME_A
      && input.messageType === 'text' && input.content === '[runtime_needs_auth]')).toBe(true);
    expect(fixture.sent.some(({ identity, input }) => identity.runtimeId === RUNTIME_B
      && input.messageType === 'text' && input.content === 'healthy-b')).toBe(true);
    expect(JSON.stringify(fixture.sent)).not.toContain('raw auth detail');
  });
});
