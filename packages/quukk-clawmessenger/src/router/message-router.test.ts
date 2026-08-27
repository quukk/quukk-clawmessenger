import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BridgeTaskEvent, BridgeTaskPort } from '../go/types.js';
import { encodeDiscussionWire } from '../protocol/discussion-wire.js';
import type { NormalizedRongCloudMessage } from '../protocol/messages.js';
import type { WorkerEvent } from '../rongcloud/worker-protocol.js';
import type { WorkerIdentity } from '../rongcloud/worker-supervisor.js';
import {
  bindingKey,
  conversationKey,
  replyTargetId,
  type ConversationIdentity,
} from './conversation.js';
import { DEDUP_TTL_MS, dedupKey } from './dedup.js';
import {
  MessageRouter,
  type AuthorizedCardIntent,
  type AuthorizedControl,
  type MessageRouterOptions,
  type RouterBindingPort,
  type RouterControlPort,
  type RouterLogger,
  type RouterReceipt,
  type SafeCardResult,
  type RouterWorkerPort,
  type RouterWorkerSend,
} from './message-router.js';
import { RouterStateError, RouterStateStore } from './session-store.js';

const TASK_TEMP_ROOT = 'D:\\A-DM\\dm-im\\.task-tmp';
const RUNTIME_A = `rt_${'a'.repeat(32)}`;
const RUNTIME_B = `rt_${'b'.repeat(32)}`;
const temporaryDirectories: string[] = [];

const IDENTITY_A: WorkerIdentity = { runtimeId: RUNTIME_A, nodeId: 'codex_node-a' };
const INSTANCE_A = `rcw_${'1'.repeat(32)}`;

function message(
  uid: string,
  text = 'hello',
  overrides: Partial<NormalizedRongCloudMessage> = {},
): NormalizedRongCloudMessage {
  return {
    messageUid: uid,
    senderId: 'sender',
    targetId: 'group',
    conversationType: 3,
    objectName: 'RC:TxtMsg',
    text,
    attachments: [],
    ...overrides,
  };
}

function inbound(
  identity: WorkerIdentity,
  value: NormalizedRongCloudMessage,
): WorkerEvent {
  return {
    type: 'message',
    runtimeId: identity.runtimeId,
    instanceId: INSTANCE_A,
    message: value,
  };
}

function protocolMessage(
  uid: string,
  rawContent: Record<string, unknown>,
  overrides: Partial<NormalizedRongCloudMessage> = {},
): NormalizedRongCloudMessage {
  return message(uid, '', { text: undefined, rawContent, objectName: 'RC:CmdMsg', ...overrides });
}

function bridgeEvent(
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

function discussionV1(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    msg_type: 'discussion_token',
    service: 'openclaw_coord',
    discussion_id: 'discussion-v1',
    version: 1,
    action: 'pass_turn',
    payload: {
      group_id: 'group',
      turn_order: [IDENTITY_A.nodeId, 'codex_node-next'],
      current_speaker: IDENTITY_A.nodeId,
      next_speaker: 'codex_node-next',
      round: 1,
      max_rounds: 2,
      originator_user: 'sender',
      originator_text: 'Give a public answer',
      originator_msg_uid: 'origin-v1',
      started_at: 1,
      mention_ordered: true,
    },
    timestamp: 1,
    ...overrides,
  };
}

function discussionAssignment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    msg_type: 'discussion_assignment',
    protocolVersion: 2,
    discussionId: 'discussion-v2',
    chatroomId: 'group',
    requestId: 'request-v2',
    stateVersion: 1,
    round: 1,
    timestamp: 1,
    assignmentId: 'assignment-v2',
    targetId: IDENTITY_A.nodeId,
    task: 'Provide a public contribution',
    topic: 'Topic',
    goal: 'Goal',
    ...overrides,
  };
}

function discussionHostTurn(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    msg_type: 'discussion_host_turn',
    protocolVersion: 2,
    discussionId: 'discussion-host',
    chatroomId: 'group',
    requestId: 'request-host',
    stateVersion: 1,
    round: 1,
    timestamp: 1,
    topic: 'Topic',
    goal: 'Goal',
    roles: {
      [IDENTITY_A.nodeId]: {
        memberId: IDENTITY_A.nodeId,
        nodeId: IDENTITY_A.nodeId,
        nickname: 'Host',
        roleName: 'host',
        roleInstructions: 'Coordinate',
        capabilities: ['discussion_participant'],
        isHost: true,
      },
    },
    allowedDecisions: ['fail'],
    remainingRounds: 1,
    eventSummary: '',
    currentArtifact: null,
    ...overrides,
  };
}

function discussionCancel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    msg_type: 'discussion_cancel',
    protocolVersion: 2,
    discussionId: 'discussion-v2',
    chatroomId: 'group',
    requestId: 'cancel-v2',
    stateVersion: 1,
    round: 1,
    timestamp: 2,
    reason: 'cancelled by host',
    ...overrides,
  };
}

class RecordingStateStore extends RouterStateStore {
  readonly order: string[];
  failAdmit = false;
  releaseCalls = 0;

  constructor(options: ConstructorParameters<typeof RouterStateStore>[0], order: string[]) {
    super(options);
    this.order = order;
  }

  override claimMessage(runtimeId: string, messageUid: string, claimId: string) {
    this.order.push('claim');
    return super.claimMessage(runtimeId, messageUid, claimId);
  }

  override currentSession(identity: ConversationIdentity) {
    this.order.push('current-session');
    return super.currentSession(identity);
  }

  override admitMessage(key: string, claimId: string) {
    this.order.push('admit');
    if (this.failAdmit) return Promise.reject(new RouterStateError('router_state_invalid'));
    return super.admitMessage(key, claimId);
  }

  override releaseMessage(key: string, claimId: string) {
    this.releaseCalls += 1;
    return super.releaseMessage(key, claimId);
  }
}

interface RouterHarness {
  router: MessageRouter;
  state: RecordingStateStore;
  order: string[];
  starts: Parameters<BridgeTaskPort['startTask']>[0][];
  sent: Array<{ identity: WorkerIdentity; input: RouterWorkerSend }>;
  receipts: Array<{ identity: WorkerIdentity; input: RouterReceipt }>;
  cancellations: string[];
  joined: Array<{ identity: WorkerIdentity; roomId: string; historyCount: number }>;
  authorized: AuthorizedControl[];
  deviceCalls: Array<{ command: string; name?: string }>;
  binding: RouterBindingPort;
  control: RouterControlPort;
  worker: RouterWorkerPort;
  task: BridgeTaskPort;
  setEvents(factory: (taskId: string, index: number) => AsyncIterable<BridgeTaskEvent>): void;
  setStart(start: BridgeTaskPort['startTask']): void;
}

async function routerHarness(
  overrides: Partial<Pick<MessageRouterOptions, 'sleep' | 'timers'>> = {},
): Promise<RouterHarness> {
  const filePath = await temporaryStatePath();
  const order: string[] = [];
  const state = new RecordingStateStore({ filePath, now: () => 100 }, order);
  await state.initialize();
  const starts: Parameters<BridgeTaskPort['startTask']>[0][] = [];
  const sent: Array<{ identity: WorkerIdentity; input: RouterWorkerSend }> = [];
  const receipts: Array<{ identity: WorkerIdentity; input: RouterReceipt }> = [];
  const cancellations: string[] = [];
  const joined: Array<{ identity: WorkerIdentity; roomId: string; historyCount: number }> = [];
  const authorized: AuthorizedControl[] = [];
  const deviceCalls: Array<{ command: string; name?: string }> = [];
  let eventFactory: (taskId: string, index: number) => AsyncIterable<BridgeTaskEvent> =
    (taskId: string): AsyncIterable<BridgeTaskEvent> => (async function* () {
    yield bridgeEvent(taskId, 'completed');
  })();
  let startImplementation: BridgeTaskPort['startTask'] = async (input) => {
    const index = starts.length;
    starts.push(input);
    return { taskId: `task_${index + 1}_1`, eventsUrl: `/v1/tasks/task_${index + 1}_1/events` };
  };
  const task: BridgeTaskPort = {
    startTask: (input) => {
      order.push('start-task');
      return startImplementation(input);
    },
    events: (taskId) => {
      order.push('events');
      return eventFactory(taskId, starts.length - 1);
    },
    cancelTask: async (taskId) => {
      cancellations.push(taskId);
    },
  };
  const worker: RouterWorkerPort = {
    send: async (identity, input) => {
      sent.push({ identity: { ...identity }, input: structuredClone(input) });
      if (input.messageType === 'text' && input.content === '[processing]') order.push('processing');
      return 'outbound-uid';
    },
    receipt: async (identity, input) => {
      order.push('receipt');
      receipts.push({ identity: { ...identity }, input: { ...input } });
    },
    joinChatroom: async (identity, input) => {
      joined.push({ identity: { ...identity }, ...input });
    },
  };
  const binding: RouterBindingPort = {
    binding: async (identity) => ({ ...identity, provider: 'codex', enabled: true }),
    authorizeDefaultWorkdir: async () => {
      order.push('authorize-workdir');
      return 'D:\\authorized\\project';
    },
  };
  const control: RouterControlPort = {
    authorize: async (input) => {
      authorized.push(structuredClone(input));
      return false;
    },
    status: async () => ({ enabled: true, worker: 'online', runtime: 'ready' }),
    device: async (input) => {
      deviceCalls.push({ command: input.command, ...(input.name === undefined ? {} : { name: input.name }) });
      return { status: 'success', code: 'ok', message: 'ok' };
    },
    card: async () => ({ status: 'error', code: 'unsupported_action', message: 'unsupported_action' }),
    modelCatalog: async () => ({ defaultModel: null, providers: [] }),
  };
  const logger: RouterLogger = {
    debug: ({ event }) => {
      if (event === 'validated') order.push('validate');
      if (event === 'lane_reserved') order.push('reserve-lane');
    },
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  const options: MessageRouterOptions = {
    task,
    worker,
    binding,
    control,
    state,
    logger,
    clock: () => 100,
    randomBytes: () => Buffer.alloc(16, 1),
    ...overrides,
  };
  const router = new MessageRouter(options);
  return {
    router,
    state,
    order,
    starts,
    sent,
    receipts,
    cancellations,
    joined,
    authorized,
    deviceCalls,
    binding,
    control,
    worker,
    task,
    setEvents(factory) { eventFactory = factory; },
    setStart(start) { startImplementation = start; },
  };
}

async function temporaryStatePath(): Promise<string> {
  await mkdir(TASK_TEMP_ROOT, { recursive: true });
  const directory = await mkdtemp(join(TASK_TEMP_ROOT, 'quukk-task10-state-'));
  temporaryDirectories.push(directory);
  return join(directory, 'sessions.json');
}

function conversation(
  runtimeId = RUNTIME_A,
  overrides: Partial<ConversationIdentity> = {},
): ConversationIdentity {
  return {
    runtimeId,
    nodeId: runtimeId === RUNTIME_A ? 'codex_node:a|b' : 'openclaw_node:b|a',
    conversationType: 3,
    targetId: 'group:#:one',
    senderId: 'sender|:one',
    ...overrides,
  };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('conversation identity', () => {
  it('uses exact JSON tuples so punctuation cannot collide', () => {
    expect(bindingKey({ runtimeId: 'a:b', nodeId: 'c' })).not.toBe(
      bindingKey({ runtimeId: 'a', nodeId: 'b:c' }),
    );
    expect(conversationKey(conversation(RUNTIME_A))).toBe(
      JSON.stringify([RUNTIME_A, 'codex_node:a|b', 3, 'group:#:one', 'sender|:one']),
    );
    expect(conversationKey(conversation(RUNTIME_A, { targetId: 'a:b', senderId: 'c' }))).not.toBe(
      conversationKey(conversation(RUNTIME_A, { targetId: 'a', senderId: 'b:c' })),
    );
  });

  it('replies to the sender only for private conversations', () => {
    expect(replyTargetId(conversation(RUNTIME_A, { conversationType: 1 }))).toBe('sender|:one');
    expect(replyTargetId(conversation(RUNTIME_A, { conversationType: 3 }))).toBe('group:#:one');
    expect(replyTargetId(conversation(RUNTIME_A, { conversationType: 4 }))).toBe('group:#:one');
  });
});

describe('RouterStateStore sessions', () => {
  it('requires initialize and treats a missing file as an empty state', async () => {
    expect(() => new RouterStateStore({ filePath: 'sessions.json' })).toThrowError(
      expect.objectContaining({ code: 'router_state_invalid' }),
    );
    const filePath = await temporaryStatePath();
    const store = new RouterStateStore({ filePath, now: () => 10 });
    await expect(store.currentSession(conversation())).rejects.toMatchObject({
      code: 'router_state_invalid',
    });

    await store.initialize();
    expect(await store.currentSession(conversation())).toBeUndefined();
    expect(await store.knownSessions(conversation())).toEqual([]);
  });

  it('fails closed when a session reader receives an invalid conversation identity', async () => {
    const filePath = await temporaryStatePath();
    const store = new RouterStateStore({ filePath, now: () => 10 });
    await store.initialize();
    const invalid = { ...conversation(), senderId: '' };

    await expect(store.currentSession(invalid)).rejects.toMatchObject({ code: 'router_state_invalid' });
    await expect(store.knownSessions(invalid)).rejects.toMatchObject({ code: 'router_state_invalid' });
  });

  it('atomically persists and reopens authoritative session history', async () => {
    const filePath = await temporaryStatePath();
    let now = 10;
    const first = new RouterStateStore({ filePath, now: () => now });
    await first.initialize();
    await first.applyEventSession({
      conversation: conversation(),
      authoritativeSessionId: 'session:a|b',
    });
    now = 20;
    await first.applyEventSession({
      conversation: conversation(),
      authoritativeSessionId: 'session:b|a',
    });

    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
      schemaVersion: number;
      sessions: Array<{ currentSessionId?: string; knownSessions: Array<{ sessionId: string }> }>;
      dedup: unknown[];
    };
    expect(persisted).toMatchObject({ schemaVersion: 1, dedup: [] });
    expect(persisted.sessions[0]?.currentSessionId).toBe('session:b|a');
    expect(persisted.sessions[0]?.knownSessions.map(({ sessionId }) => sessionId)).toEqual([
      'session:a|b',
      'session:b|a',
    ]);

    const reopened = new RouterStateStore({ filePath, now: () => now });
    await reopened.initialize();
    expect(await reopened.currentSession(conversation())).toBe('session:b|a');
    expect(await reopened.knownSessions(conversation())).toEqual(['session:a|b', 'session:b|a']);
  });

  it('fails closed for invalid and oversized state instead of replacing it', async () => {
    const invalidPath = await temporaryStatePath();
    await writeFile(invalidPath, '{"schemaVersion":1,"sessions":', 'utf8');
    const invalid = new RouterStateStore({ filePath: invalidPath });
    await expect(invalid.initialize()).rejects.toMatchObject({ code: 'router_state_invalid' });
    expect(await readFile(invalidPath, 'utf8')).toBe('{"schemaVersion":1,"sessions":');

    const oversizedPath = await temporaryStatePath();
    await writeFile(oversizedPath, 'x'.repeat(8 * 1024 * 1024 + 1), 'utf8');
    const oversized = new RouterStateStore({ filePath: oversizedPath });
    await expect(oversized.initialize()).rejects.toMatchObject({ code: 'router_state_invalid' });
  });

  it('keeps provider session ownership within one runtime and conversation', async () => {
    const filePath = await temporaryStatePath();
    const store = new RouterStateStore({ filePath, now: () => 10 });
    await store.initialize();
    const first = conversation(RUNTIME_A);
    const second = conversation(RUNTIME_A, { senderId: 'other' });
    await store.applyEventSession({ conversation: first, authoritativeSessionId: 'shared-session' });

    await expect(
      store.applyEventSession({ conversation: second, authoritativeSessionId: 'shared-session' }),
    ).rejects.toMatchObject({ code: 'session_conflict' });
    expect(await store.currentSession(second)).toBeUndefined();

    const otherRuntime = conversation(RUNTIME_B, { senderId: 'other' });
    await store.applyEventSession({
      conversation: otherRuntime,
      authoritativeSessionId: 'shared-session',
    });
    expect(await store.currentSession(otherRuntime)).toBe('shared-session');
  });

  it('limits known sessions to 32 while retaining the current session', async () => {
    const filePath = await temporaryStatePath();
    let now = 0;
    const store = new RouterStateStore({ filePath, now: () => ++now });
    await store.initialize();
    for (let index = 0; index < 33; index += 1) {
      await store.applyEventSession({
        conversation: conversation(),
        authoritativeSessionId: `session-${index}`,
      });
    }
    const known = await store.knownSessions(conversation());
    expect(known).toHaveLength(32);
    expect(known).not.toContain('session-0');
    expect(known.at(-1)).toBe('session-32');
    expect(await store.currentSession(conversation())).toBe('session-32');
  });

  it('switches, deletes, and lists only sessions owned by the current conversation', async () => {
    const filePath = await temporaryStatePath();
    let now = 1;
    const store = new RouterStateStore({ filePath, now: () => now++ });
    await store.initialize();
    const first = conversation();
    const second = conversation(RUNTIME_A, { senderId: 'other' });
    await store.applyEventSession({ conversation: first, authoritativeSessionId: 'one' });
    await store.applyEventSession({ conversation: first, authoritativeSessionId: 'two' });
    await store.applyEventSession({ conversation: second, authoritativeSessionId: 'other' });

    expect(await store.switchKnown(first, 'other')).toBe(false);
    expect(await store.deleteKnown(first, 'other')).toBe(false);
    expect(await store.switchKnown(first, 'one')).toBe(true);
    expect(await store.currentSession(first)).toBe('one');
    expect(await store.deleteKnown(first, 'one')).toBe(true);
    expect(await store.currentSession(first)).toBeUndefined();
    expect(await store.knownSessions(first)).toEqual(['two']);
    expect(await store.knownSessions(second)).toEqual(['other']);
  });

  it('applies resume_invalidated CAS clear before an authoritative replacement', async () => {
    const filePath = await temporaryStatePath();
    let now = 1;
    const store = new RouterStateStore({ filePath, now: () => now++ });
    await store.initialize();
    await store.applyEventSession({ conversation: conversation(), authoritativeSessionId: 'old' });
    await store.applyEventSession({
      conversation: conversation(),
      submittedResumeSessionId: 'old',
      status: 'resume_invalidated',
      authoritativeSessionId: 'fresh',
    });
    expect(await store.knownSessions(conversation())).toEqual(['fresh']);
    expect(await store.currentSession(conversation())).toBe('fresh');

    await store.applyEventSession({
      conversation: conversation(),
      submittedResumeSessionId: 'old',
      status: 'resume_invalidated',
    });
    expect(await store.currentSession(conversation())).toBe('fresh');
  });

  it('rejects session entry capacity violations from persisted state', async () => {
    const filePath = await temporaryStatePath();
    const sessions = Array.from({ length: 513 }, (_, index) => {
      const identity = conversation(RUNTIME_A, { senderId: `sender-${index}` });
      return {
        conversationKey: conversationKey(identity),
        bindingKey: bindingKey(identity),
        ...identity,
        knownSessions: [],
        updatedAt: index,
      };
    });
    await writeFile(filePath, JSON.stringify({ schemaVersion: 1, sessions, dedup: [] }), 'utf8');
    const store = new RouterStateStore({ filePath });
    await expect(store.initialize()).rejects.toMatchObject({ code: 'router_state_invalid' });
  });

  it('enforces the 2048 process session capacity independently of runtime quotas', async () => {
    const filePath = await temporaryStatePath();
    const runtimes = Array.from({ length: 5 }, (_, index) =>
      `rt_${index.toString(16).repeat(32)}`);
    const sessions = Array.from({ length: 2_048 }, (_, index) => {
      const identity = conversation(runtimes[index % 4]!, { senderId: `sender-${index}` });
      return {
        conversationKey: conversationKey(identity),
        bindingKey: bindingKey(identity),
        ...identity,
        knownSessions: [],
        updatedAt: index,
      };
    });
    await writeFile(filePath, JSON.stringify({ schemaVersion: 1, sessions, dedup: [] }), 'utf8');
    const store = new RouterStateStore({ filePath, now: () => 10 });
    await store.initialize();

    await expect(store.applyEventSession({
      conversation: conversation(runtimes[4]!, { senderId: 'overflow' }),
      authoritativeSessionId: 'overflow-session',
    })).rejects.toMatchObject({ code: 'router_state_invalid' });
  });

  it('exposes only stable state errors', () => {
    expect(new RouterStateError('router_state_invalid').toJSON()).toEqual({
      code: 'router_state_invalid',
    });
  });
});

describe('RouterStateStore dedup admission', () => {
  it('uses a JSON tuple key and isolates identical UIDs by runtime', async () => {
    expect(dedupKey('a:b', 'c')).not.toBe(dedupKey('a', 'b:c'));
    expect(dedupKey(RUNTIME_A, 'uid:#|:')).toBe(JSON.stringify([RUNTIME_A, 'uid:#|:']));
    const filePath = await temporaryStatePath();
    const store = new RouterStateStore({ filePath, now: () => 10 });
    await store.initialize();

    expect(await store.claimMessage(RUNTIME_A, 'same-uid', '1'.repeat(32))).toMatchObject({
      status: 'claimed',
      key: dedupKey(RUNTIME_A, 'same-uid'),
    });
    expect(await store.claimMessage(RUNTIME_A, 'same-uid', '2'.repeat(32))).toEqual({
      status: 'duplicate',
      key: dedupKey(RUNTIME_A, 'same-uid'),
    });
    expect(await store.claimMessage(RUNTIME_B, 'same-uid', '3'.repeat(32))).toMatchObject({
      status: 'claimed',
      key: dedupKey(RUNTIME_B, 'same-uid'),
    });
  });

  it('serializes concurrent claims so exactly one wins', async () => {
    const filePath = await temporaryStatePath();
    const store = new RouterStateStore({ filePath, now: () => 10 });
    await store.initialize();
    const claims = await Promise.all([
      store.claimMessage(RUNTIME_A, 'uid', '1'.repeat(32)),
      store.claimMessage(RUNTIME_A, 'uid', '2'.repeat(32)),
      store.claimMessage(RUNTIME_A, 'uid', '3'.repeat(32)),
    ]);
    expect(claims.filter((result) => result.status === 'claimed')).toHaveLength(1);
    expect(claims.filter((result) => result.status === 'duplicate')).toHaveLength(2);
  });

  it('requires the exact claim token to admit or release and never releases admitted work', async () => {
    const filePath = await temporaryStatePath();
    const store = new RouterStateStore({ filePath, now: () => 10 });
    await store.initialize();
    const claimId = '1'.repeat(32);
    const claim = await store.claimMessage(RUNTIME_A, 'uid', claimId);
    expect(claim.status).toBe('claimed');
    const key = dedupKey(RUNTIME_A, 'uid');
    expect(await store.admitMessage(key, '2'.repeat(32))).toBe(false);
    expect(await store.releaseMessage(key, '2'.repeat(32))).toBe(false);
    expect(await store.admitMessage(key, claimId)).toBe(true);
    expect(await store.releaseMessage(key, claimId)).toBe(false);
    expect(await store.admitMessage(key, claimId)).toBe(true);

    const released = await store.claimMessage(RUNTIME_A, 'release-me', '3'.repeat(32));
    expect(released.status).toBe('claimed');
    expect(await store.releaseMessage(dedupKey(RUNTIME_A, 'release-me'), '3'.repeat(32))).toBe(true);
    expect(await store.claimMessage(RUNTIME_A, 'release-me', '4'.repeat(32))).toMatchObject({
      status: 'claimed',
    });
  });

  it('persists claimed and admitted records across reopen', async () => {
    const filePath = await temporaryStatePath();
    const first = new RouterStateStore({ filePath, now: () => 10 });
    await first.initialize();
    await first.claimMessage(RUNTIME_A, 'claimed', '1'.repeat(32));
    await first.claimMessage(RUNTIME_A, 'admitted', '2'.repeat(32));
    await first.admitMessage(dedupKey(RUNTIME_A, 'admitted'), '2'.repeat(32));

    const reopened = new RouterStateStore({ filePath, now: () => 11 });
    await reopened.initialize();
    expect(await reopened.claimMessage(RUNTIME_A, 'claimed', '3'.repeat(32))).toMatchObject({
      status: 'duplicate',
    });
    expect(await reopened.claimMessage(RUNTIME_A, 'admitted', '4'.repeat(32))).toMatchObject({
      status: 'duplicate',
    });
  });

  it('prunes both claim states only after the 24 hour TTL', async () => {
    const filePath = await temporaryStatePath();
    let now = 10;
    const store = new RouterStateStore({ filePath, now: () => now });
    await store.initialize();
    await store.claimMessage(RUNTIME_A, 'claimed', '1'.repeat(32));
    await store.claimMessage(RUNTIME_A, 'admitted', '2'.repeat(32));
    await store.admitMessage(dedupKey(RUNTIME_A, 'admitted'), '2'.repeat(32));
    now += DEDUP_TTL_MS;
    expect(await store.claimMessage(RUNTIME_A, 'claimed', '3'.repeat(32))).toMatchObject({
      status: 'claimed',
    });
    expect(await store.claimMessage(RUNTIME_A, 'admitted', '4'.repeat(32))).toMatchObject({
      status: 'claimed',
    });
  });

  it('atomically prunes expired dedup records during initialize', async () => {
    const filePath = await temporaryStatePath();
    await writeFile(filePath, JSON.stringify({
      schemaVersion: 1,
      sessions: [],
      dedup: [{
        key: dedupKey(RUNTIME_A, 'expired-on-open'),
        runtimeId: RUNTIME_A,
        messageUid: 'expired-on-open',
        claimId: '1'.repeat(32),
        state: 'claimed',
        claimedAt: 1,
      }],
    }), 'utf8');
    const store = new RouterStateStore({ filePath, now: () => DEDUP_TTL_MS + 1 });

    await store.initialize();

    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as { dedup: unknown[] };
    expect(persisted.dedup).toEqual([]);
    await expect(store.claimMessage(
      RUNTIME_A,
      'expired-on-open',
      '2'.repeat(32),
    )).resolves.toMatchObject({ status: 'claimed' });
  });

  it('fails closed at the per-runtime capacity without evicting live claims', async () => {
    const filePath = await temporaryStatePath();
    const dedup = Array.from({ length: 2_048 }, (_, index) => ({
      key: dedupKey(RUNTIME_A, `uid-${index}`),
      runtimeId: RUNTIME_A,
      messageUid: `uid-${index}`,
      claimId: index.toString(16).padStart(32, '0'),
      state: 'claimed',
      claimedAt: 10,
    }));
    await writeFile(filePath, JSON.stringify({ schemaVersion: 1, sessions: [], dedup }), 'utf8');
    const store = new RouterStateStore({ filePath, now: () => 10 });
    await store.initialize();
    await expect(
      store.claimMessage(RUNTIME_A, 'overflow', 'f'.repeat(32)),
    ).rejects.toMatchObject({ code: 'dedup_capacity' });
    expect(await store.claimMessage(RUNTIME_B, 'independent', 'e'.repeat(32))).toMatchObject({
      status: 'claimed',
    });
  });

  it('enforces the 8192 process dedup capacity independently of runtime quotas', async () => {
    const filePath = await temporaryStatePath();
    const runtimes = Array.from({ length: 5 }, (_, index) =>
      `rt_${index.toString(16).repeat(32)}`);
    const dedup = Array.from({ length: 8_192 }, (_, index) => {
      const runtimeId = runtimes[index % 4]!;
      return {
        key: dedupKey(runtimeId, `uid-${index}`),
        runtimeId,
        messageUid: `uid-${index}`,
        claimId: index.toString(16).padStart(32, '0'),
        state: 'claimed',
        claimedAt: 10,
      };
    });
    await writeFile(filePath, JSON.stringify({ schemaVersion: 1, sessions: [], dedup }), 'utf8');
    const store = new RouterStateStore({ filePath, now: () => 10 });
    await store.initialize();

    await expect(store.claimMessage(
      runtimes[4]!,
      'overflow',
      'f'.repeat(32),
    )).rejects.toMatchObject({ code: 'dedup_capacity' });
  });

  it('serializes session and dedup mutations in one document without lost updates', async () => {
    const filePath = await temporaryStatePath();
    const store = new RouterStateStore({ filePath, now: () => 10 });
    await store.initialize();
    await Promise.all([
      store.applyEventSession({ conversation: conversation(), authoritativeSessionId: 'session' }),
      store.claimMessage(RUNTIME_A, 'uid', '1'.repeat(32)),
    ]);

    const reopened = new RouterStateStore({ filePath, now: () => 11 });
    await reopened.initialize();
    expect(await reopened.currentSession(conversation())).toBe('session');
    expect(await reopened.claimMessage(RUNTIME_A, 'uid', '2'.repeat(32))).toMatchObject({
      status: 'duplicate',
    });
  });
});

describe('MessageRouter plain task admission', () => {
  it('orders validation, lane reservation, claim, start, admission, feedback, and events', async () => {
    const fixture = await routerHarness();
    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, message('uid-order')));
    expect(fixture.order.filter((item) => [
      'validate',
      'reserve-lane',
      'claim',
      'current-session',
      'authorize-workdir',
      'start-task',
      'admit',
      'receipt',
      'processing',
      'events',
    ].includes(item))).toEqual([
      'validate',
      'reserve-lane',
      'claim',
      'current-session',
      'authorize-workdir',
      'start-task',
      'admit',
      'receipt',
      'processing',
      'events',
    ]);
    expect(fixture.starts).toEqual([{
      runtimeId: RUNTIME_A,
      conversationKey: JSON.stringify([RUNTIME_A, IDENTITY_A.nodeId, 3, 'group', 'sender']),
      prompt: 'hello',
      workdir: 'D:\\authorized\\project',
    }]);
    expect(fixture.receipts[0]).toEqual({
      identity: IDENTITY_A,
      input: {
        messageUid: 'uid-order',
        senderId: 'sender',
        targetId: 'group',
        conversationType: 3,
        direction: 'RECEIVE',
      },
    });
  });

  it('releases the exact claim when start rejects and sends no accepted feedback', async () => {
    const fixture = await routerHarness();
    fixture.setStart(async () => {
      throw new Error('sensitive start failure');
    });
    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, message('uid-start-fail')));
    expect(fixture.state.releaseCalls).toBe(1);
    expect(fixture.receipts).toEqual([]);
    expect(fixture.sent.some(({ input }) =>
      input.messageType === 'text' && input.content === '[processing]')).toBe(false);
    expect(fixture.sent.at(-1)?.input).toMatchObject({
      messageType: 'text',
      content: '[task_start_failed]',
    });
    expect(JSON.stringify(fixture.sent)).not.toContain('sensitive start failure');
  });

  it('cancels an accepted task when admit persistence fails without releasing or acknowledging', async () => {
    const fixture = await routerHarness();
    fixture.state.failAdmit = true;
    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, message('uid-admit-fail')));
    expect(fixture.cancellations).toEqual(['task_1_1']);
    expect(fixture.state.releaseCalls).toBe(0);
    expect(fixture.receipts).toEqual([]);
    expect(fixture.sent.some(({ input }) =>
      input.messageType === 'text' && input.content === '[processing]')).toBe(false);
  });

  it('continues the accepted task when receipt and processing delivery fail', async () => {
    let eventConsumed = false;
    const filePath = await temporaryStatePath();
    const state = new RouterStateStore({ filePath, now: () => 100 });
    await state.initialize();
    const sends: RouterWorkerSend[] = [];
    const router = new MessageRouter({
      task: {
        startTask: async () => ({ taskId: 'task_1_1', eventsUrl: '/events' }),
        events: (taskId) => (async function* () {
          eventConsumed = true;
          yield bridgeEvent(taskId, 'completed', { output: 'done' });
        })(),
        cancelTask: async () => undefined,
      },
      worker: {
        send: async (_identity, input) => {
          sends.push(input);
          if (input.messageType === 'text' && input.content === '[processing]') {
            throw Object.assign(new Error('offline'), { code: 'protocol_error' });
          }
          return 'uid';
        },
        receipt: async () => { throw new Error('receipt failed'); },
        joinChatroom: async () => undefined,
      },
      binding: {
        binding: async (identity) => ({ ...identity, provider: 'codex', enabled: true }),
        authorizeDefaultWorkdir: async () => 'D:\\authorized\\project',
      },
      control: {
        authorize: async () => false,
        status: async () => ({ enabled: true, worker: 'online', runtime: 'ready' }),
        device: async () => ({ status: 'error', code: 'unsupported_action', message: 'unsupported_action' }),
        card: async () => ({ status: 'error', code: 'unsupported_action', message: 'unsupported_action' }),
        modelCatalog: async () => ({ defaultModel: null, providers: [] }),
      },
      state,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      randomBytes: () => Buffer.alloc(16, 2),
    });
    await router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, message('uid-feedback-fail')));
    expect(eventConsumed).toBe(true);
    expect(sends.some((input) => input.messageType === 'text' && input.content === 'done')).toBe(true);
  });

  it('re-authorizes workdir for every task and uses terminal session for the next lane item', async () => {
    const fixture = await routerHarness();
    fixture.setEvents((taskId, index) => (async function* () {
      yield bridgeEvent(taskId, 'completed', {
        session_id: index === 0 ? 'session-one' : 'session-two',
      });
    })());
    await Promise.all([
      fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, message('uid-one'))),
      fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, message('uid-two'))),
    ]);
    expect(fixture.starts).toHaveLength(2);
    expect(fixture.starts[0]?.resumeSessionId).toBeUndefined();
    expect(fixture.starts[1]?.resumeSessionId).toBe('session-one');
    expect(fixture.order.filter((item) => item === 'authorize-workdir')).toHaveLength(2);
  });

  it('global dispose marks a pre-start lane final and releases its exact claim', async () => {
    const fixture = await routerHarness();
    let entered!: () => void;
    let authorize!: (workdir: string) => void;
    const authorizationEntered = new Promise<void>((resolve) => { entered = resolve; });
    fixture.binding.authorizeDefaultWorkdir = async () => {
      entered();
      return new Promise<string>((resolve) => { authorize = resolve; });
    };

    const routing = fixture.router.onWorkerEvent(
      IDENTITY_A,
      inbound(IDENTITY_A, message('dispose-pre-start')),
    );
    await authorizationEntered;
    await fixture.router.dispose();
    authorize('D:\\authorized\\project');
    await routing;

    expect(fixture.starts).toEqual([]);
    expect(fixture.state.releaseCalls).toBe(1);
  });

  it('global dispose tracks a direct stop that is still claiming and suppresses all late feedback', async () => {
    const fixture = await routerHarness();
    const originalClaim = fixture.state.claimMessage.bind(fixture.state);
    let claimEntered!: () => void;
    let releaseClaim!: () => void;
    const claimWasEntered = new Promise<void>((resolve) => { claimEntered = resolve; });
    const claimGate = new Promise<void>((resolve) => { releaseClaim = resolve; });
    fixture.state.claimMessage = async (runtimeId, messageUid, claimId) => {
      if (messageUid === 'dispose-pending-stop') {
        claimEntered();
        await claimGate;
      }
      return originalClaim(runtimeId, messageUid, claimId);
    };

    const routing = fixture.router.onWorkerEvent(
      IDENTITY_A,
      inbound(IDENTITY_A, message('dispose-pending-stop', '/stop')),
    );
    await claimWasEntered;
    await fixture.router.dispose();
    releaseClaim();
    await routing;

    expect(fixture.sent).toEqual([]);
    expect(fixture.receipts).toEqual([]);
    expect(fixture.state.releaseCalls).toBe(1);
  });

  it('does not finish binding disposal until an already-started send completes', async () => {
    const fixture = await routerHarness();
    const originalSend = fixture.worker.send.bind(fixture.worker);
    const order: string[] = [];
    let sendEntered!: () => void;
    let releaseSend!: () => void;
    const sendWasEntered = new Promise<void>((resolve) => { sendEntered = resolve; });
    const sendGate = new Promise<void>((resolve) => { releaseSend = resolve; });
    fixture.worker.send = async (identity, input) => {
      order.push('send-started');
      sendEntered();
      await sendGate;
      const result = await originalSend(identity, input);
      order.push('send-finished');
      return result;
    };

    const routing = fixture.router.onWorkerEvent(
      IDENTITY_A,
      inbound(IDENTITY_A, message('', 'invalid')),
    );
    await sendWasEntered;
    let disposalSettled = false;
    const disposal = fixture.router.disposeBinding(IDENTITY_A).then(() => {
      disposalSettled = true;
      order.push('dispose-finished');
    });
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    const settledBeforeSend = disposalSettled;
    releaseSend();
    await Promise.all([routing, disposal]);

    expect(settledBeforeSend).toBe(false);
    expect(order).toEqual(['send-started', 'send-finished', 'dispose-finished']);
    expect(fixture.sent).toHaveLength(1);
    expect(fixture.receipts).toEqual([]);
  });

  it('does not finish global disposal until an already-started receipt completes', async () => {
    const fixture = await routerHarness();
    const originalReceipt = fixture.worker.receipt.bind(fixture.worker);
    const order: string[] = [];
    let receiptEntered!: () => void;
    let releaseReceipt!: () => void;
    const receiptWasEntered = new Promise<void>((resolve) => { receiptEntered = resolve; });
    const receiptGate = new Promise<void>((resolve) => { releaseReceipt = resolve; });
    fixture.worker.receipt = async (identity, input) => {
      order.push('receipt-started');
      receiptEntered();
      await receiptGate;
      await originalReceipt(identity, input);
      order.push('receipt-finished');
    };

    const routing = fixture.router.onWorkerEvent(
      IDENTITY_A,
      inbound(IDENTITY_A, message('dispose-pending-receipt')),
    );
    await receiptWasEntered;
    let disposalSettled = false;
    const disposal = fixture.router.dispose().then(() => {
      disposalSettled = true;
      order.push('dispose-finished');
    });
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    const settledBeforeReceipt = disposalSettled;
    releaseReceipt();
    await Promise.all([routing, disposal]);

    expect(settledBeforeReceipt).toBe(false);
    expect(order).toEqual(['receipt-started', 'receipt-finished', 'dispose-finished']);
    expect(fixture.receipts).toHaveLength(1);
    expect(fixture.sent).toEqual([]);
  });

  it('shares one global disposal promise while task cancellation is still pending', async () => {
    const fixture = await routerHarness();
    let nextEntered!: () => void;
    let resolveNext!: (value: IteratorResult<BridgeTaskEvent>) => void;
    const nextWasEntered = new Promise<void>((resolve) => { nextEntered = resolve; });
    fixture.setEvents(() => ({
      [Symbol.asyncIterator]() {
        return {
          next: () => {
            nextEntered();
            return new Promise<IteratorResult<BridgeTaskEvent>>((resolve) => { resolveNext = resolve; });
          },
          return: async () => {
            resolveNext({ done: true, value: undefined });
            return { done: true as const, value: undefined };
          },
        };
      },
    }));
    let cancelEntered!: () => void;
    let releaseCancel!: () => void;
    const cancelWasEntered = new Promise<void>((resolve) => { cancelEntered = resolve; });
    const cancelGate = new Promise<void>((resolve) => { releaseCancel = resolve; });
    fixture.task.cancelTask = async (taskId) => {
      fixture.cancellations.push(taskId);
      cancelEntered();
      await cancelGate;
    };

    const routing = fixture.router.onWorkerEvent(
      IDENTITY_A,
      inbound(IDENTITY_A, message('dispose-shared-attempt')),
    );
    await nextWasEntered;
    const first = fixture.router.dispose();
    const second = fixture.router.dispose();
    await cancelWasEntered;
    let secondSettled = false;
    void second.then(() => { secondSettled = true; });
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    const settledBeforeCancel = secondSettled;
    releaseCancel();
    await Promise.all([routing, first, second]);

    expect(second).toBe(first);
    expect(settledBeforeCancel).toBe(false);
    expect(fixture.cancellations).toEqual(['task_1_1']);
  });

  it('cancels a plain task id that arrives after binding disposal without admitting or emitting', async () => {
    const fixture = await routerHarness();
    let startEntered!: () => void;
    let resolveStart!: (value: { taskId: string; eventsUrl: string }) => void;
    const pendingStart = new Promise<void>((resolve) => { startEntered = resolve; });
    fixture.setStart(async (input) => {
      fixture.starts.push(input);
      startEntered();
      return new Promise((resolve) => { resolveStart = resolve; });
    });

    const routing = fixture.router.onWorkerEvent(
      IDENTITY_A,
      inbound(IDENTITY_A, message('dispose-late-plain')),
    );
    await pendingStart;
    await fixture.router.disposeBinding(IDENTITY_A);
    resolveStart({ taskId: 'task-late-plain', eventsUrl: '/events' });
    await routing;

    expect(fixture.cancellations).toEqual(['task-late-plain']);
    expect(fixture.receipts).toEqual([]);
    expect(fixture.sent).toEqual([]);
    expect(fixture.state.releaseCalls).toBe(0);
    await expect(fixture.state.claimMessage(
      IDENTITY_A.runtimeId,
      'dispose-late-plain',
      '03'.repeat(16),
    )).resolves.toMatchObject({ status: 'duplicate' });
  });

  it('accepts only HTTPS attachment metadata and never fetches or accepts a remote path', async () => {
    const fixture = await routerHarness();
    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, message('uid-media', 'caption', {
      attachments: [{
        kind: 'image',
        url: 'https://cdn.example/image.png',
        name: 'image.png',
        mimeType: 'image/png',
        size: 42,
      }],
      rawContent: { workdir: 'D:\\attacker', path: 'file:///secret' },
    })));
    expect(fixture.starts[0]?.prompt).toContain('https://cdn.example/image.png');
    expect(fixture.starts[0]?.prompt).not.toContain('D:\\attacker');
    expect(fixture.starts[0]?.workdir).toBe('D:\\authorized\\project');

    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, message('uid-bad-media', 'caption', {
      attachments: [{ kind: 'file', url: 'file:///secret' }],
    })));
    expect(fixture.starts).toHaveLength(1);
  });

  it('bounds each conversation lane at eight waiting items before creating claims', async () => {
    const fixture = await routerHarness();
    let releaseFirst!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    fixture.setEvents((taskId, index) => (async function* () {
      if (index === 0) await blocked;
      yield bridgeEvent(taskId, 'completed');
    })());
    const first = fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, message('lane-0')));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const queued = Array.from({ length: 9 }, (_, index) =>
      fixture.router.onWorkerEvent(
        IDENTITY_A,
        inbound(IDENTITY_A, message(`lane-${index + 1}`)),
      ),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fixture.order.filter((item) => item === 'claim')).toHaveLength(1);
    expect(fixture.sent.some(({ input }) =>
      input.messageType === 'text' && input.content === '[conversation_busy]')).toBe(true);
    releaseFirst();
    await Promise.all([first, ...queued]);
    expect(fixture.starts).toHaveLength(9);
  });
});

describe('MessageRouter session, legacy, device, and chatroom dispatch', () => {
  it('handles all slash session commands locally and keeps unknown slash text as a task', async () => {
    const fixture = await routerHarness();
    const identity = conversationFromForTest(IDENTITY_A);
    await fixture.state.applyEventSession({ conversation: identity, authoritativeSessionId: 'session-one' });
    await fixture.state.applyEventSession({ conversation: identity, authoritativeSessionId: 'session-two' });

    for (const [index, command] of [
      '/session',
      '/sessions',
      '/switch session-one',
      '/delete session-two',
      '/new',
      '/status',
    ].entries()) {
      await fixture.router.onWorkerEvent(
        IDENTITY_A,
        inbound(IDENTITY_A, message(`slash-${index}`, command)),
      );
    }
    expect(fixture.starts).toEqual([]);
    expect(await fixture.state.currentSession(identity)).toBeUndefined();
    expect(await fixture.state.knownSessions(identity)).toEqual(['session-one']);
    expect(fixture.receipts).toHaveLength(6);
    expect(JSON.stringify(fixture.sent)).toContain('session-one');
    expect(JSON.stringify(fixture.sent)).not.toContain('session-two","session-one');

    await fixture.router.onWorkerEvent(
      IDENTITY_A,
      inbound(IDENTITY_A, message('slash-unknown', '/not-a-router-command')),
    );
    expect(fixture.starts[0]?.prompt).toBe('/not-a-router-command');
  });

  it('never switches to or reveals a session from another conversation', async () => {
    const fixture = await routerHarness();
    const current = conversationFromForTest(IDENTITY_A);
    const other = { ...current, senderId: 'other-sender' };
    await fixture.state.applyEventSession({ conversation: current, authoritativeSessionId: 'mine' });
    await fixture.state.applyEventSession({ conversation: other, authoritativeSessionId: 'secret-other' });

    await fixture.router.onWorkerEvent(
      IDENTITY_A,
      inbound(IDENTITY_A, message('switch-other', '/switch secret-other')),
    );
    expect(await fixture.state.currentSession(current)).toBe('mine');
    expect(JSON.stringify(fixture.sent)).not.toContain('secret-other');
    expect(JSON.stringify(fixture.sent)).toContain('session_not_found');
  });

  it('returns only authoritative legacy sessions and deletes only locally owned mappings', async () => {
    const fixture = await routerHarness();
    const current = conversationFromForTest(IDENTITY_A);
    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(
      'legacy-create-none',
      { msg_type: 'create_opencode_session', request_id: 'request-1' },
    )));
    expect(JSON.stringify(fixture.sent)).toContain('session_pending_first_prompt');

    await fixture.state.applyEventSession({ conversation: current, authoritativeSessionId: 'owned' });
    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(
      'legacy-create-current',
      { msg_type: 'create_opencode_session', request_id: 'request-2' },
    )));
    expect(JSON.stringify(fixture.sent)).toContain('owned');

    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(
      'legacy-delete-unknown',
      { msg_type: 'delete_opencode_session', request_id: 'request-3', session_id: 'not-owned' },
    )));
    expect(await fixture.state.currentSession(current)).toBe('owned');
    expect(JSON.stringify(fixture.sent)).toContain('session_not_found');

    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(
      'legacy-delete-owned',
      { msg_type: 'delete_opencode_session', request_id: 'request-4', session_id: 'owned' },
    )));
    expect(await fixture.state.currentSession(current)).toBeUndefined();
  });

  it('validates device source/destination, authorization, aliases, and rename bounds', async () => {
    const fixture = await routerHarness();
    fixture.control.authorize = async (input) => {
      fixture.authorized.push(structuredClone(input));
      return true;
    };
    for (const [index, command] of [
      'status', 'disable', 'stop', 'enable', 'start', 'delete', 'restart',
    ].entries()) {
      await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(
        `device-${index}`,
        {
          msg_type: 'device_control',
          request_id: `request-${index}`,
          source_im_id: 'sender',
          destination_im_id: IDENTITY_A.nodeId,
          command,
        },
      )));
    }
    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(
      'device-rename',
      {
        msg_type: 'device_control',
        request_id: 'request-rename',
        source_im_id: 'sender',
        destination_im_id: IDENTITY_A.nodeId,
        command: 'rename_device',
        name: '  New Device  ',
      },
    )));
    expect(fixture.deviceCalls).toEqual([
      { command: 'status' },
      { command: 'disable' },
      { command: 'stop' },
      { command: 'enable' },
      { command: 'start' },
      { command: 'delete' },
      { command: 'restart' },
      { command: 'rename_device', name: 'New Device' },
    ]);
    expect(fixture.authorized[0]?.scope).toBe('device.read');
    expect(fixture.authorized.slice(1).every(({ scope }) => scope === 'device.mutate')).toBe(true);

    const callCount = fixture.deviceCalls.length;
    for (const [uid, rawContent] of [
      ['wrong-source', {
        msg_type: 'device_control', request_id: 'x', source_im_id: 'attacker',
        destination_im_id: IDENTITY_A.nodeId, command: 'restart',
      }],
      ['wrong-destination', {
        msg_type: 'device_control', request_id: 'y', source_im_id: 'sender',
        destination_im_id: 'codex_other', command: 'restart',
      }],
      ['bad-rename', {
        msg_type: 'device_control', request_id: 'z', source_im_id: 'sender',
        destination_im_id: IDENTITY_A.nodeId, command: 'rename_device', name: '\u0000bad',
      }],
    ] as Array<[string, Record<string, unknown>]>) {
      await fixture.router.onWorkerEvent(
        IDENTITY_A,
        inbound(IDENTITY_A, protocolMessage(uid, rawContent)),
      );
    }
    expect(fixture.deviceCalls).toHaveLength(callCount);
  });

  it('defaults device mutations to deny without invoking the side-effect port', async () => {
    const fixture = await routerHarness();
    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(
      'device-denied',
      {
        msg_type: 'device_control', request_id: 'request', source_im_id: 'sender',
        destination_im_id: IDENTITY_A.nodeId, command: 'restart',
      },
    )));
    expect(fixture.deviceCalls).toEqual([]);
    expect(JSON.stringify(fixture.sent)).toContain('authorization_denied');
  });

  it('never releases a device mutation after the control port accepted its side effect', async () => {
    const fixture = await routerHarness();
    fixture.control.authorize = async () => true;
    fixture.control.device = async () => {
      const result = {};
      Object.defineProperty(result, 'status', {
        get: () => { throw new Error('malformed accepted result'); },
      });
      return result as never;
    };

    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(
      'device-accepted-malformed',
      {
        msg_type: 'device_control', request_id: 'request', source_im_id: 'sender',
        destination_im_id: IDENTITY_A.nodeId, command: 'restart',
      },
    )));

    expect(fixture.state.releaseCalls).toBe(0);
    await expect(fixture.state.claimMessage(
      IDENTITY_A.runtimeId,
      'device-accepted-malformed',
      '02'.repeat(16),
    )).resolves.toMatchObject({ status: 'duplicate' });
  });

  it('joins exact chatrooms and deduplicates chatroom messages by valid origin UID', async () => {
    const fixture = await routerHarness();
    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(
      'invite',
      { msg_type: 'chatroom_invite', chatroom_id: 'room-one' },
      { conversationType: 4, targetId: 'room-one' },
    )));
    expect(fixture.joined[0]).toEqual({ identity: IDENTITY_A, roomId: 'room-one', historyCount: 0 });

    for (const uid of ['physical-one', 'physical-two']) {
      await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(
        uid,
        {
          msg_type: 'chatroom_message',
          chatroom_id: 'room-one',
          origin_message_uid: 'origin-one',
          content: 'room prompt',
        },
        { conversationType: 4, targetId: 'room-one' },
      )));
    }
    expect(fixture.starts).toHaveLength(1);
    expect(fixture.starts[0]).toMatchObject({
      runtimeId: RUNTIME_A,
      conversationKey: JSON.stringify([RUNTIME_A, IDENTITY_A.nodeId, 4, 'room-one', 'sender']),
      prompt: 'room prompt',
    });
    expect(fixture.joined).toHaveLength(2);
  });

  it('ignores response-only and display-only protocol messages without claims or receipts', async () => {
    const fixture = await routerHarness();
    for (const [index, msgType] of [
      'opencode_session_created',
      'device_status_report',
      'device_control_result',
      'command_result',
      'card_message',
      'card_update',
      'discussion_host_decision',
      'discussion_contribution_delta',
      'discussion_contribution_completed',
      'discussion_artifact_update',
      'discussion_node_error',
      'discussion_model_catalog_response',
    ].entries()) {
      await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(
        `ignored-${index}`,
        responseOnlyPayload(msgType),
      )));
    }
    expect(fixture.starts).toEqual([]);
    expect(fixture.receipts).toEqual([]);
    expect(fixture.order.filter((item) => item === 'claim')).toEqual([]);
  });
});

describe('MessageRouter task events and reconnect behavior', () => {
  it('filters mismatched and non-monotonic events and applies resume CAS atomically', async () => {
    const fixture = await routerHarness();
    const current = conversationFromForTest(IDENTITY_A);
    await fixture.state.applyEventSession({ conversation: current, authoritativeSessionId: 'old-session' });
    fixture.setEvents((taskId) => (async function* () {
      yield bridgeEvent('task_9_9', 'text_delta', { id: 1, text: 'secret-other-task' });
      yield bridgeEvent(taskId, 'started', { id: 1 });
      yield bridgeEvent(taskId, 'status', {
        id: 2,
        status: 'resume_invalidated',
        session_id: 'fresh-session',
      });
      yield bridgeEvent(taskId, 'text_delta', { id: 3, text: 'accepted' });
      yield bridgeEvent(taskId, 'text_delta', { id: 3, text: 'duplicate' });
      yield bridgeEvent(taskId, 'tool_started', { id: 4, tool: 'secret-tool' });
      yield bridgeEvent(taskId, 'tool_finished', { id: 5, output: 'secret-output' });
      yield bridgeEvent(taskId, 'completed', { id: 6, output: 'accepted' });
    })());
    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, message('events-filter')));
    expect(await fixture.state.currentSession(current)).toBe('fresh-session');
    const output = fixture.sent
      .filter(({ input }) => input.messageType === 'text' && input.content !== '[processing]')
      .map(({ input }) => input.content)
      .join('');
    expect(output).toBe('accepted');
    expect(output).not.toContain('secret');
    expect(fixture.starts).toHaveLength(1);
  });

  it('coalesces deltas at 250 ms, flushes early at 16 KiB, and chunks at 32 KiB', async () => {
    vi.useFakeTimers();
    const fixture = await routerHarness();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let deltaHandled!: () => void;
    const deltaWasHandled = new Promise<void>((resolve) => { deltaHandled = resolve; });
    fixture.setEvents((taskId) => (async function* () {
      yield bridgeEvent(taskId, 'text_delta', { id: 1, text: 'small' });
      deltaHandled();
      await blocked;
      yield bridgeEvent(taskId, 'completed', { id: 2, output: `small${'x'.repeat(70 * 1024)}` });
    })());
    const routing = fixture.router.onWorkerEvent(
      IDENTITY_A,
      inbound(IDENTITY_A, message('coalesced')),
    );
    await deltaWasHandled;
    await vi.advanceTimersByTimeAsync(249);
    expect(fixture.sent.some(({ input }) => input.messageType === 'text' && input.content === 'small')).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.sent.some(({ input }) => input.messageType === 'text' && input.content === 'small')).toBe(true);
    release();
    await vi.runAllTimersAsync();
    await routing;
    const outputMessages = fixture.sent.filter(({ input }) =>
      input.messageType === 'text' && input.content !== '[processing]' && input.content !== 'small');
    expect(outputMessages.every(({ input }) => Buffer.byteLength(input.content as string, 'utf8') <= 32 * 1024)).toBe(true);
    expect(outputMessages.map(({ input }) => input.content).join('')).toBe('x'.repeat(70 * 1024));

    const early = await routerHarness();
    let releaseEarly!: () => void;
    const earlyBlocked = new Promise<void>((resolve) => { releaseEarly = resolve; });
    let earlyHandled!: () => void;
    const earlyWasHandled = new Promise<void>((resolve) => { earlyHandled = resolve; });
    early.setEvents((taskId) => (async function* () {
      yield bridgeEvent(taskId, 'text_delta', { id: 1, text: 'y'.repeat(16 * 1024) });
      earlyHandled();
      await earlyBlocked;
      yield bridgeEvent(taskId, 'completed', { id: 2 });
    })());
    const earlyRouting = early.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, message('early')));
    await earlyWasHandled;
    expect(early.sent.some(({ input }) =>
      input.messageType === 'text' && input.content === 'y'.repeat(16 * 1024))).toBe(true);
    releaseEarly();
    await vi.runAllTimersAsync();
    await earlyRouting;
  });

  it('keeps fragmented card markers out of text, validates cards, and never executes COMMANDS', async () => {
    const fixture = await routerHarness();
    const card = {
      schema: '1.0.0',
      id: 'card-one',
      header: { title: 'Safe card' },
      sections: [],
    };
    fixture.setEvents((taskId) => (async function* () {
      yield bridgeEvent(taskId, 'text_delta', { id: 1, text: 'prefix [CAR' });
      yield bridgeEvent(taskId, 'text_delta', {
        id: 2,
        text: `D][${JSON.stringify(card)}] [COMMANDS][[{"type":"command","name":"/delete victim"}]]`,
      });
      yield bridgeEvent(taskId, 'completed', { id: 3 });
    })());
    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, message('card-marker')));
    const text = fixture.sent
      .filter(({ input }) => input.messageType === 'text' && input.content !== '[processing]')
      .map(({ input }) => input.content)
      .join('');
    expect(text).toBe('prefix  ');
    expect(text).not.toContain('[CAR');
    expect(text).not.toContain('/delete');
    expect(fixture.sent.some(({ input }) => input.messageType === 'card_message'
      && input.content.msg_type === 'card_message')).toBe(true);
    expect(await fixture.state.knownSessions(conversationFromForTest(IDENTITY_A))).toEqual([]);

    const invalid = await routerHarness();
    invalid.setEvents((taskId) => (async function* () {
      yield bridgeEvent(taskId, 'completed', { output: '[CARD][{"secret":"raw"}]' });
    })());
    await invalid.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, message('invalid-card')));
    const invalidText = JSON.stringify(invalid.sent);
    expect(invalidText).toContain('[invalid card marker]');
    expect(invalidText).not.toContain('"secret":"raw"');
  });

  it('caps cumulative output at 1 MiB and emits the truncation marker once', async () => {
    const fixture = await routerHarness();
    fixture.setEvents((taskId) => (async function* () {
      yield bridgeEvent(taskId, 'completed', { output: 'z'.repeat(1024 * 1024 + 100) });
    })());
    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, message('truncated')));
    const output = fixture.sent
      .filter(({ input }) => input.messageType === 'text' && input.content !== '[processing]')
      .map(({ input }) => input.content)
      .join('');
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(1024 * 1024 + 20);
    expect(output.match(/\[output_truncated\]/g)).toHaveLength(1);
  });

  it('buffers only transient task output and drains it when that binding returns online', async () => {
    const fixture = await routerHarness();
    const originalSend = fixture.worker.send.bind(fixture.worker);
    let online = false;
    fixture.worker.send = async (identity, input) => {
      if (input.messageType === 'text' && input.content === 'deferred' && !online) {
        throw Object.assign(new Error('offline details'), { code: 'not_connected' });
      }
      return originalSend(identity, input);
    };
    fixture.setEvents((taskId) => (async function* () {
      yield bridgeEvent(taskId, 'completed', { output: 'deferred' });
    })());
    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, message('buffered')));
    expect(fixture.sent.some(({ input }) => input.messageType === 'text' && input.content === 'deferred')).toBe(false);

    online = true;
    await fixture.router.onWorkerEvent(IDENTITY_A, {
      type: 'connection',
      runtimeId: RUNTIME_A,
      instanceId: INSTANCE_A,
      state: 'online',
    });
    expect(fixture.sent.filter(({ input }) => input.messageType === 'text' && input.content === 'deferred')).toHaveLength(1);

    const fatal = await routerHarness();
    let fatalOnline = false;
    const fatalSend = fatal.worker.send.bind(fatal.worker);
    fatal.worker.send = async (identity, input) => {
      if (input.messageType === 'text' && input.content === 'drop-me' && !fatalOnline) {
        throw Object.assign(new Error('bad protocol'), { code: 'protocol_error' });
      }
      return fatalSend(identity, input);
    };
    fatal.setEvents((taskId) => (async function* () {
      yield bridgeEvent(taskId, 'completed', { output: 'drop-me' });
    })());
    await fatal.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, message('fatal-output')));
    fatalOnline = true;
    await fatal.router.onWorkerEvent(IDENTITY_A, {
      type: 'connection', runtimeId: RUNTIME_A, instanceId: INSTANCE_A, state: 'online',
    });
    expect(fatal.sent.some(({ input }) => input.messageType === 'text' && input.content === 'drop-me')).toBe(false);
  });

  it('bounds reconnect output to 32 entries and drops the oldest terminal first', async () => {
    const fixture = await routerHarness();
    let online = false;
    const originalSend = fixture.worker.send.bind(fixture.worker);
    fixture.worker.send = async (identity, input) => {
      if (input.messageType === 'text' && input.content.startsWith('buffer-') && !online) {
        throw Object.assign(new Error('offline'), { code: 'disconnected' });
      }
      return originalSend(identity, input);
    };
    fixture.setEvents((taskId, index) => (async function* () {
      yield bridgeEvent(taskId, 'completed', { output: `buffer-${index}` });
    })());
    for (let index = 0; index < 33; index += 1) {
      await fixture.router.onWorkerEvent(
        IDENTITY_A,
        inbound(IDENTITY_A, message(`buffer-uid-${index}`)),
      );
    }

    online = true;
    await fixture.router.onWorkerEvent(IDENTITY_A, {
      type: 'connection', runtimeId: RUNTIME_A, instanceId: INSTANCE_A, state: 'online',
    });

    const drained = fixture.sent
      .filter(({ input }) => input.messageType === 'text' && input.content.startsWith('buffer-'))
      .map(({ input }) => input.content);
    expect(drained).toHaveLength(32);
    expect(drained).not.toContain('buffer-0');
    expect(drained.at(-1)).toBe('buffer-32');
  });

  it('bounds reconnect output to one MiB of serialized messages', async () => {
    const fixture = await routerHarness();
    let online = false;
    const largeA = `A${'a'.repeat(600 * 1024)}`;
    const largeB = `B${'b'.repeat(600 * 1024)}`;
    const originalSend = fixture.worker.send.bind(fixture.worker);
    fixture.worker.send = async (identity, input) => {
      if (input.messageType === 'text'
        && input.content !== '[processing]'
        && !online) {
        throw Object.assign(new Error('offline'), { code: 'timeout' });
      }
      return originalSend(identity, input);
    };
    fixture.setEvents((taskId, index) => (async function* () {
      yield bridgeEvent(taskId, 'completed', { output: index === 0 ? largeA : largeB });
    })());
    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, message('bytes-a')));
    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, message('bytes-b')));

    online = true;
    await fixture.router.onWorkerEvent(IDENTITY_A, {
      type: 'connection', runtimeId: RUNTIME_A, instanceId: INSTANCE_A, state: 'online',
    });
    const drained = fixture.sent
      .filter(({ input }) => input.messageType === 'text' && input.content !== '[processing]')
      .map(({ input }) => input.content)
      .join('');
    expect(drained).toBe(largeB);
    expect(Buffer.byteLength(drained, 'utf8')).toBeLessThanOrEqual(1024 * 1024);
  });

  it('stops a queue_full drain without spinning and retries only on a later online event', async () => {
    const fixture = await routerHarness();
    let stage: 'offline' | 'full' | 'online' = 'offline';
    let drainAttempts = 0;
    const originalSend = fixture.worker.send.bind(fixture.worker);
    fixture.worker.send = async (identity, input) => {
      if (input.messageType === 'text' && input.content === 'queue-deferred') {
        if (stage === 'offline') throw Object.assign(new Error('offline'), { code: 'worker_exited' });
        if (stage === 'full') {
          drainAttempts += 1;
          throw Object.assign(new Error('full'), { code: 'queue_full' });
        }
      }
      return originalSend(identity, input);
    };
    fixture.setEvents((taskId) => (async function* () {
      yield bridgeEvent(taskId, 'completed', { output: 'queue-deferred' });
    })());
    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, message('queue-buffer')));

    stage = 'full';
    await fixture.router.onWorkerEvent(IDENTITY_A, {
      type: 'connection', runtimeId: RUNTIME_A, instanceId: INSTANCE_A, state: 'online',
    });
    expect(drainAttempts).toBe(1);
    expect(fixture.sent.some(({ input }) =>
      input.messageType === 'text' && input.content === 'queue-deferred')).toBe(false);

    stage = 'online';
    await fixture.router.onWorkerEvent(IDENTITY_A, {
      type: 'connection', runtimeId: RUNTIME_A, instanceId: INSTANCE_A, state: 'online',
    });
    expect(fixture.sent.filter(({ input }) =>
      input.messageType === 'text' && input.content === 'queue-deferred')).toHaveLength(1);
  });

  it('shares one serial drain across concurrent online notifications', async () => {
    const fixture = await routerHarness();
    let online = false;
    let drainEntered!: () => void;
    let releaseDrain!: () => void;
    const drainWasEntered = new Promise<void>((resolve) => { drainEntered = resolve; });
    const drainGate = new Promise<void>((resolve) => { releaseDrain = resolve; });
    let drainAttempts = 0;
    const originalSend = fixture.worker.send.bind(fixture.worker);
    fixture.worker.send = async (identity, input) => {
      if (input.messageType === 'text' && input.content === 'shared-drain') {
        if (!online) throw Object.assign(new Error('offline'), { code: 'worker_exited' });
        drainAttempts += 1;
        drainEntered();
        await drainGate;
      }
      return originalSend(identity, input);
    };
    fixture.setEvents((taskId) => (async function* () {
      yield bridgeEvent(taskId, 'completed', { output: 'shared-drain' });
    })());
    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, message('shared-drain-buffer')));

    online = true;
    const first = fixture.router.onWorkerEvent(IDENTITY_A, {
      type: 'connection', runtimeId: RUNTIME_A, instanceId: INSTANCE_A, state: 'online',
    });
    await drainWasEntered;
    const second = fixture.router.onWorkerEvent(IDENTITY_A, {
      type: 'connection', runtimeId: RUNTIME_A, instanceId: INSTANCE_A, state: 'online',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(drainAttempts).toBe(1);
    releaseDrain();
    await Promise.all([first, second]);
    expect(fixture.sent.filter(({ input }) =>
      input.messageType === 'text' && input.content === 'shared-drain')).toHaveLength(1);
  });

  it('does not let an older drain delete output buffered while that drain is pending', async () => {
    const fixture = await routerHarness();
    let stage: 'buffer-old' | 'drain-old' | 'buffer-new' | 'online' = 'buffer-old';
    let drainEntered!: () => void;
    let releaseDrain!: () => void;
    const drainWasEntered = new Promise<void>((resolve) => { drainEntered = resolve; });
    const drainGate = new Promise<void>((resolve) => { releaseDrain = resolve; });
    const originalSend = fixture.worker.send.bind(fixture.worker);
    fixture.worker.send = async (identity, input) => {
      if (input.messageType === 'text' && input.content === 'old-output') {
        if (stage === 'buffer-old') throw Object.assign(new Error('offline'), { code: 'worker_exited' });
        if (stage === 'drain-old') {
          drainEntered();
          await drainGate;
        }
      }
      if (input.messageType === 'text' && input.content === 'new-output' && stage === 'buffer-new') {
        throw Object.assign(new Error('offline'), { code: 'worker_exited' });
      }
      return originalSend(identity, input);
    };
    fixture.setEvents((taskId, index) => (async function* () {
      yield bridgeEvent(taskId, 'completed', { output: index === 0 ? 'old-output' : 'new-output' });
    })());
    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, message('old-buffer')));

    stage = 'drain-old';
    const draining = fixture.router.onWorkerEvent(IDENTITY_A, {
      type: 'connection', runtimeId: RUNTIME_A, instanceId: INSTANCE_A, state: 'online',
    });
    await drainWasEntered;
    stage = 'buffer-new';
    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, message(
      'new-buffer',
      'hello',
      { senderId: 'sender-two' },
    )));
    releaseDrain();
    await draining;

    stage = 'online';
    await fixture.router.onWorkerEvent(IDENTITY_A, {
      type: 'connection', runtimeId: RUNTIME_A, instanceId: INSTANCE_A, state: 'online',
    });
    expect(fixture.sent.filter(({ input }) => input.messageType === 'text'
      && (input.content === 'old-output' || input.content === 'new-output'))
      .map(({ input }) => input.content)).toEqual(['old-output', 'new-output']);
  });

  it('advances delivered text when a coarse replay drains so A followed by AB emits only A then B', async () => {
    vi.useFakeTimers();
    const fixture = await routerHarness();
    let online = false;
    let releaseTerminal!: () => void;
    let deltaObserved!: () => void;
    const terminalGate = new Promise<void>((resolve) => { releaseTerminal = resolve; });
    const deltaWasObserved = new Promise<void>((resolve) => { deltaObserved = resolve; });
    const originalSend = fixture.worker.send.bind(fixture.worker);
    fixture.worker.send = async (identity, input) => {
      if (input.messageType === 'text' && input.content === 'A' && !online) {
        throw Object.assign(new Error('offline'), { code: 'worker_exited' });
      }
      return originalSend(identity, input);
    };
    fixture.setEvents((taskId) => (async function* () {
      yield bridgeEvent(taskId, 'text_delta', { text: 'A' });
      deltaObserved();
      await terminalGate;
      yield bridgeEvent(taskId, 'completed', { id: 2, output: 'AB' });
    })());

    const routing = fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, message('drain-prefix')));
    await deltaWasObserved;
    await vi.advanceTimersByTimeAsync(250);
    online = true;
    await fixture.router.onWorkerEvent(IDENTITY_A, {
      type: 'connection', runtimeId: RUNTIME_A, instanceId: INSTANCE_A, state: 'online',
    });
    releaseTerminal();
    await routing;

    expect(fixture.sent.filter(({ input }) => input.messageType === 'text'
      && input.content !== '[processing]').map(({ input }) => input.content)).toEqual(['A', 'B']);
  });

  it('makes terminal output wait for an in-flight coarse drain before slicing its delivered prefix', async () => {
    vi.useFakeTimers();
    const fixture = await routerHarness();
    let online = false;
    let releaseTerminal!: () => void;
    let releaseDrain!: () => void;
    let deltaObserved!: () => void;
    let drainEntered!: () => void;
    const terminalGate = new Promise<void>((resolve) => { releaseTerminal = resolve; });
    const drainGate = new Promise<void>((resolve) => { releaseDrain = resolve; });
    const deltaWasObserved = new Promise<void>((resolve) => { deltaObserved = resolve; });
    const drainWasEntered = new Promise<void>((resolve) => { drainEntered = resolve; });
    const originalSend = fixture.worker.send.bind(fixture.worker);
    fixture.worker.send = async (identity, input) => {
      if (input.messageType === 'text' && input.content === 'A') {
        if (!online) throw Object.assign(new Error('offline'), { code: 'worker_exited' });
        drainEntered();
        await drainGate;
      }
      return originalSend(identity, input);
    };
    fixture.setEvents((taskId) => (async function* () {
      yield bridgeEvent(taskId, 'text_delta', { text: 'A' });
      deltaObserved();
      await terminalGate;
      yield bridgeEvent(taskId, 'completed', { id: 2, output: 'AB' });
    })());

    const routing = fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, message('drain-prefix-race')));
    await deltaWasObserved;
    await vi.advanceTimersByTimeAsync(250);
    online = true;
    const draining = fixture.router.onWorkerEvent(IDENTITY_A, {
      type: 'connection', runtimeId: RUNTIME_A, instanceId: INSTANCE_A, state: 'online',
    });
    await drainWasEntered;
    releaseTerminal();
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
    expect(fixture.sent.filter(({ input }) => input.messageType === 'text'
      && input.content !== '[processing]')).toEqual([]);
    releaseDrain();
    await Promise.all([draining, routing]);

    expect(fixture.sent.filter(({ input }) => input.messageType === 'text'
      && input.content !== '[processing]').map(({ input }) => input.content)).toEqual(['A', 'B']);
  });

  it('watchdog cancels once, closes the reader, flushes timeout, and never releases admitted dedup', async () => {
    vi.useFakeTimers();
    const fixture = await routerHarness();
    let resolveNext!: (value: IteratorResult<BridgeTaskEvent>) => void;
    let markNext!: () => void;
    const nextWasCalled = new Promise<void>((resolve) => { markNext = resolve; });
    let returned = 0;
    const iterator: AsyncIterator<BridgeTaskEvent> = {
      next: () => {
        markNext();
        return new Promise((resolve) => { resolveNext = resolve; });
      },
      return: async () => {
        returned += 1;
        resolveNext({ done: true, value: undefined });
        return { done: true, value: undefined };
      },
    };
    fixture.setEvents(() => ({ [Symbol.asyncIterator]: () => iterator }));
    const routing = fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, message('watchdog')));
    await nextWasCalled;
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1_000 + 60_000);
    await vi.runAllTimersAsync();
    await routing;
    expect(fixture.cancellations).toEqual(['task_1_1']);
    expect(returned).toBe(1);
    expect(fixture.state.releaseCalls).toBe(0);
    expect(fixture.sent.some(({ input }) =>
      input.messageType === 'text' && input.content === '[task_timeout]')).toBe(true);
  });

  it('binding teardown cancels and closes the exact active event reader', async () => {
    const fixture = await routerHarness();
    let entered!: () => void;
    let resolveNext: ((value: IteratorResult<BridgeTaskEvent>) => void) | undefined;
    const nextEntered = new Promise<void>((resolve) => { entered = resolve; });
    let returned = 0;
    fixture.setEvents(() => ({
      [Symbol.asyncIterator]() {
        return {
          next: () => {
            entered();
            return new Promise<IteratorResult<BridgeTaskEvent>>((resolve) => {
              resolveNext = resolve;
            });
          },
          return: async () => {
            returned += 1;
            resolveNext?.({ done: true, value: undefined });
            return { done: true as const, value: undefined };
          },
        };
      },
    }));

    const routing = fixture.router.onWorkerEvent(
      IDENTITY_A,
      inbound(IDENTITY_A, message('dispose-active-reader')),
    );
    await nextEntered;
    await fixture.router.disposeBinding(IDENTITY_A);
    const observedReturned = returned;
    resolveNext?.({ done: true, value: undefined });
    await routing;

    expect(fixture.cancellations).toEqual(['task_1_1']);
    expect(observedReturned).toBe(1);
  });

  it('/stop bypasses a blocked lane and cancels only the exact active conversation', async () => {
    const fixture = await routerHarness();
    let cancelled!: () => void;
    const cancelSignal = new Promise<void>((resolve) => { cancelled = resolve; });
    fixture.task.cancelTask = async (taskId) => {
      fixture.cancellations.push(taskId);
      cancelled();
    };
    fixture.setEvents((taskId) => (async function* () {
      await cancelSignal;
      yield bridgeEvent(taskId, 'cancelled');
    })());
    const active = fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, message('active')));
    await vi.waitFor(() => expect(fixture.starts).toHaveLength(1));
    const stop = fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, message('stop', '/stop')));
    await Promise.all([active, stop]);
    expect(fixture.cancellations).toEqual(['task_1_1']);
    expect(fixture.starts).toHaveLength(1);
    expect(fixture.sent.some(({ input }) =>
      input.messageType === 'text' && input.content === '[stop_requested]')).toBe(true);
  });
});

describe('MessageRouter discussion v1/v2 and wire dispatch', () => {
  it.each([
    ['v1', discussionV1(), 'dispose-late-v1'],
    ['v2', discussionAssignment(), 'dispose-late-v2'],
  ] as const)('cancels a late %s task after binding disposal without admitting or emitting', async (
    _version,
    payload,
    uid,
  ) => {
    const fixture = await routerHarness();
    let startEntered!: () => void;
    let resolveStart!: (value: { taskId: string; eventsUrl: string }) => void;
    const pendingStart = new Promise<void>((resolve) => { startEntered = resolve; });
    fixture.setStart(async (input) => {
      fixture.starts.push(input);
      startEntered();
      return new Promise((resolve) => { resolveStart = resolve; });
    });

    const routing = fixture.router.onWorkerEvent(
      IDENTITY_A,
      inbound(IDENTITY_A, protocolMessage(uid, payload)),
    );
    await pendingStart;
    await fixture.router.disposeBinding(IDENTITY_A);
    resolveStart({ taskId: `task-${uid}`, eventsUrl: '/events' });
    await routing;

    expect(fixture.cancellations).toEqual([`task-${uid}`]);
    expect(fixture.receipts).toEqual([]);
    expect(fixture.sent).toEqual([]);
    expect(fixture.state.releaseCalls).toBe(0);
    await expect(fixture.state.claimMessage(
      IDENTITY_A.runtimeId,
      uid,
      '04'.repeat(16),
    )).resolves.toMatchObject({ status: 'duplicate' });
  });

  it.each([
    ['v1', discussionV1({ discussion_id: 'retry-v1' }), 'direct-retry-v1'],
    ['v2', discussionAssignment({ discussionId: 'retry-v2' }), 'direct-retry-v2'],
  ] as const)('rolls back the exact direct %s logical owner when start rejects so the same UID can retry', async (
    _version,
    payload,
    uid,
  ) => {
    const fixture = await routerHarness();
    let attempts = 0;
    fixture.setStart(async (input) => {
      fixture.starts.push(input);
      attempts += 1;
      if (attempts === 1) throw new Error('first start rejected');
      return { taskId: 'task-retry-success', eventsUrl: '/events' };
    });
    fixture.setEvents((taskId) => (async function* () {
      yield bridgeEvent(taskId, 'completed', { output: 'retry succeeded' });
    })());

    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(uid, payload)));
    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(uid, payload)));

    expect(fixture.starts).toHaveLength(2);
    expect(fixture.state.releaseCalls).toBe(1);
    expect(fixture.receipts).toHaveLength(1);
    expect(JSON.stringify(fixture.sent)).toContain('retry succeeded');
  });

  it('runs one owned v1 turn, advances the token, and tombstones logical replays', async () => {
    const fixture = await routerHarness();
    fixture.setEvents((taskId) => (async function* () {
      yield bridgeEvent(taskId, 'completed', { output: 'public v1 answer' });
    })());
    const value = discussionV1();
    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(
      IDENTITY_A,
      protocolMessage('v1-first', value),
    ));
    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(
      IDENTITY_A,
      protocolMessage('v1-replay', value),
    ));

    expect(fixture.starts).toHaveLength(1);
    expect(fixture.starts[0]?.prompt).toContain('Give a public answer');
    const token = fixture.sent.find(({ input }) => input.messageType === 'command'
      && input.content.msg_type === 'discussion_token')?.input.content;
    expect(token).toMatchObject({
      action: 'pass_turn',
      payload: {
        current_speaker: 'codex_node-next',
        next_speaker: 'codex_node-next',
        last_speaker_response: 'public v1 answer',
      },
    });
    expect(fixture.receipts).toHaveLength(2);
  });

  it('retains v1 terminal output across a transient worker reconnect', async () => {
    const fixture = await routerHarness();
    let online = false;
    const originalSend = fixture.worker.send.bind(fixture.worker);
    fixture.worker.send = async (identity, input) => {
      if (input.messageType === 'command'
        && input.content.msg_type === 'discussion_token'
        && !online) {
        throw Object.assign(new Error('worker stopped'), { code: 'worker_exited' });
      }
      return originalSend(identity, input);
    };
    fixture.setEvents((taskId) => (async function* () {
      yield bridgeEvent(taskId, 'completed', { output: 'durable v1 answer' });
    })());

    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(
      IDENTITY_A,
      protocolMessage('v1-buffered', discussionV1({ discussion_id: 'v1-buffered' })),
    ));
    online = true;
    await fixture.router.onWorkerEvent(IDENTITY_A, {
      type: 'connection', runtimeId: RUNTIME_A, instanceId: INSTANCE_A, state: 'online',
    });

    const tokens = fixture.sent.filter(({ input }) => input.messageType === 'command'
      && input.content.msg_type === 'discussion_token');
    expect(tokens).toHaveLength(1);
    expect(JSON.stringify(tokens[0]?.input.content)).toContain('durable v1 answer');
  });

  it('times out a v1 owner at 60 seconds, cancels once, closes the reader, and advances safely', async () => {
    vi.useFakeTimers();
    const fixture = await routerHarness();
    let resolveNext!: (value: IteratorResult<BridgeTaskEvent>) => void;
    let nextCalled!: () => void;
    const nextPending = new Promise<void>((resolve) => { nextCalled = resolve; });
    let returned = 0;
    const iterator: AsyncIterator<BridgeTaskEvent> = {
      next: () => {
        nextCalled();
        return new Promise((resolve) => { resolveNext = resolve; });
      },
      return: async () => {
        returned += 1;
        resolveNext({ done: true, value: undefined });
        return { done: true, value: undefined };
      },
    };
    fixture.setEvents(() => ({ [Symbol.asyncIterator]: () => iterator }));
    const routing = fixture.router.onWorkerEvent(
      IDENTITY_A,
      inbound(IDENTITY_A, protocolMessage('v1-timeout', discussionV1())),
    );
    await nextPending;
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.runAllTimersAsync();
    await routing;

    expect(fixture.cancellations).toEqual(['task_1_1']);
    expect(returned).toBe(1);
    expect(fixture.sent.some(({ input }) => input.messageType === 'command'
      && input.content.msg_type === 'discussion_token')).toBe(true);
  });

  it('reassembles out-of-order wire chunks once and retains replay tombstones across reconnect', async () => {
    const fixture = await routerHarness();
    fixture.setEvents((taskId) => (async function* () {
      yield bridgeEvent(taskId, 'completed', { output: 'wire contribution' });
    })());
    const frames = encodeDiscussionWire(discussionAssignment({ task: 'T'.repeat(12_000) })).reverse();
    expect(frames.length).toBeGreaterThan(1);
    for (let index = 0; index < frames.length; index += 1) {
      await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(
        `wire-${index}`,
        JSON.parse(frames[index]!) as Record<string, unknown>,
      )));
      if (index < frames.length - 1) expect(fixture.starts).toHaveLength(0);
      if (index === 0) {
        await fixture.router.onWorkerEvent(IDENTITY_A, {
          type: 'connection', runtimeId: RUNTIME_A, instanceId: INSTANCE_A, state: 'offline',
        });
        await fixture.router.onWorkerEvent(IDENTITY_A, {
          type: 'connection', runtimeId: RUNTIME_A, instanceId: INSTANCE_A, state: 'online',
        });
      }
    }
    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(
      'wire-replay',
      JSON.parse(frames[0]!) as Record<string, unknown>,
    )));

    expect(fixture.starts).toHaveLength(1);
    expect(fixture.sent.some(({ input }) => input.messageType === 'command_result'
      && input.content.msg_type === 'discussion_contribution_completed')).toBe(true);
  });

  it('honors a cancel tombstone before a direct v2 assignment without starting provider work', async () => {
    const fixture = await routerHarness();
    const assignment = discussionAssignment({ discussionId: 'cancel-before-direct' });
    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(
      'cancel-before-direct-cancel',
      discussionCancel({ discussionId: 'cancel-before-direct' }),
    )));
    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(
      'cancel-before-direct-assignment',
      assignment,
    )));

    expect(fixture.starts).toEqual([]);
    expect(fixture.cancellations).toEqual([]);
    expect(fixture.receipts).toHaveLength(2);
  });

  it('shares one v2 replay reservation between a completed wire command and a direct duplicate', async () => {
    const fixture = await routerHarness();
    fixture.setEvents((taskId) => (async function* () {
      yield bridgeEvent(taskId, 'completed', { output: 'one public contribution' });
    })());
    const assignment = discussionAssignment({
      discussionId: 'wire-first-direct-replay',
      task: 'T'.repeat(12_000),
    });
    const frames = encodeDiscussionWire(assignment);
    expect(frames.length).toBeGreaterThan(1);
    for (let index = 0; index < frames.length; index += 1) {
      await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(
        `wire-first-${index}`,
        JSON.parse(frames[index]!) as Record<string, unknown>,
      )));
    }
    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(
      'wire-first-direct-duplicate',
      assignment,
    )));

    expect(fixture.starts).toHaveLength(1);
    expect(fixture.cancellations).toEqual([]);
  });

  it('releases only a failed wire v2 reservation so the same logical direct command can retry', async () => {
    const fixture = await routerHarness();
    let attempts = 0;
    fixture.setStart(async (input) => {
      fixture.starts.push(input);
      attempts += 1;
      if (attempts === 1) throw new Error('wire start rejected');
      return { taskId: 'task-wire-retry-success', eventsUrl: '/events' };
    });
    fixture.setEvents((taskId) => (async function* () {
      yield bridgeEvent(taskId, 'completed', { output: 'wire reservation retry succeeded' });
    })());
    const assignment = discussionAssignment({
      discussionId: 'wire-start-failure-retry',
      task: 'T'.repeat(12_000),
    });
    const frames = encodeDiscussionWire(assignment);
    expect(frames.length).toBeGreaterThan(1);
    for (let index = 0; index < frames.length; index += 1) {
      await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(
        `wire-start-failure-${index}`,
        JSON.parse(frames[index]!) as Record<string, unknown>,
      )));
    }
    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(
      'direct-after-wire-start-failure',
      assignment,
    )));

    expect(fixture.starts).toHaveLength(2);
    expect(fixture.cancellations).toEqual([]);
    expect(JSON.stringify(fixture.sent)).toContain('wire reservation retry succeeded');
  });

  it('does not tombstone a wrong-target assignment and emits bounded delta/final output for the exact node', async () => {
    const fixture = await routerHarness();
    fixture.setEvents((taskId) => (async function* () {
      yield bridgeEvent(taskId, 'text_delta', { id: 1, text: 'public delta' });
      yield bridgeEvent(taskId, 'completed', { id: 2, output: 'public delta final' });
    })());
    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(
      'wrong-target',
      discussionAssignment({ targetId: 'codex_node-other' }),
    )));
    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(
      'right-target',
      discussionAssignment(),
    )));
    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(
      'logical-replay',
      discussionAssignment(),
    )));

    expect(fixture.starts).toHaveLength(1);
    const payloads = fixture.sent
      .filter(({ input }) => input.messageType === 'command_result')
      .map(({ input }) => input.content);
    expect(payloads).toEqual(expect.arrayContaining([
      expect.objectContaining({ msg_type: 'discussion_contribution_delta', seq: 0, content: 'public delta' }),
      expect.objectContaining({ msg_type: 'discussion_contribution_completed', content: 'public delta final' }),
    ]));
  });

  it('serializes a timer delta before the v2 terminal frame on one output tail', async () => {
    const callbacks = new Map<number, { callback: () => void; milliseconds: number }>();
    let timerId = 0;
    const fixture = await routerHarness({
      timers: {
        setTimeout(callback, milliseconds) {
          timerId += 1;
          callbacks.set(timerId, { callback, milliseconds });
          return timerId;
        },
        clearTimeout(timer) { callbacks.delete(timer as number); },
      },
    });
    let releaseTerminal!: () => void;
    let releaseDelta!: () => void;
    let deltaEntered!: () => void;
    const terminalGate = new Promise<void>((resolve) => { releaseTerminal = resolve; });
    const deltaGate = new Promise<void>((resolve) => { releaseDelta = resolve; });
    const deltaWasEntered = new Promise<void>((resolve) => { deltaEntered = resolve; });
    let terminalSent = false;
    const originalSend = fixture.worker.send.bind(fixture.worker);
    fixture.worker.send = async (identity, input) => {
      if (input.messageType === 'command_result'
        && input.content.msg_type === 'discussion_contribution_delta') {
        deltaEntered();
        await deltaGate;
      }
      if (input.messageType === 'command_result'
        && input.content.msg_type === 'discussion_contribution_completed') terminalSent = true;
      return originalSend(identity, input);
    };
    fixture.setEvents((taskId) => (async function* () {
      yield bridgeEvent(taskId, 'text_delta', { text: 'A' });
      await terminalGate;
      yield bridgeEvent(taskId, 'completed', { id: 2, output: 'AB' });
    })());

    const routing = fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(
      'v2-output-tail',
      discussionAssignment({ discussionId: 'output-tail' }),
    )));
    await vi.waitFor(() => expect([...callbacks.values()].some(({ milliseconds }) => milliseconds === 250)).toBe(true));
    const deltaTimer = [...callbacks.values()].find(({ milliseconds }) => milliseconds === 250)!;
    deltaTimer.callback();
    await deltaWasEntered;
    releaseTerminal();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(terminalSent).toBe(false);
    releaseDelta();
    await routing;

    expect(fixture.sent.filter(({ input }) => input.messageType === 'command_result')
      .map(({ input }) => typeof input.content === 'string' ? undefined : input.content.msg_type)).toEqual([
      'discussion_contribution_delta',
      'discussion_contribution_completed',
    ]);
  });

  it('does not append a node-error frame after a v2 terminal frame has been attempted', async () => {
    const fixture = await routerHarness();
    const attempted: string[] = [];
    const originalSend = fixture.worker.send.bind(fixture.worker);
    fixture.worker.send = async (identity, input) => {
      if (input.messageType === 'command_result' && typeof input.content.msg_type === 'string') {
        attempted.push(input.content.msg_type);
        if (input.content.msg_type === 'discussion_contribution_completed') {
          throw Object.assign(new Error('terminal failed'), { code: 'protocol_error' });
        }
      }
      return originalSend(identity, input);
    };
    fixture.setEvents((taskId) => (async function* () {
      yield bridgeEvent(taskId, 'completed', { output: 'terminal output' });
    })());

    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(
      'v2-one-terminal',
      discussionAssignment({ discussionId: 'one-terminal' }),
    )));

    expect(attempted).toEqual(['discussion_contribution_completed']);
  });

  it('requires the exact node host role and converts invalid host output to a fixed node error', async () => {
    const fixture = await routerHarness();
    fixture.setEvents((taskId) => (async function* () {
      yield bridgeEvent(taskId, 'completed', { output: 'not-json and must not leak' });
    })());
    const nonHostRoles = {
      [IDENTITY_A.nodeId]: {
        memberId: IDENTITY_A.nodeId,
        nodeId: IDENTITY_A.nodeId,
        nickname: 'Not host',
        roleName: 'member',
        roleInstructions: '',
        capabilities: ['discussion_participant'],
        isHost: false,
      },
    };
    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(
      'host-denied',
      discussionHostTurn({ roles: nonHostRoles }),
    )));
    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(
      'host-valid',
      discussionHostTurn(),
    )));

    expect(fixture.starts).toHaveLength(1);
    const serialized = JSON.stringify(fixture.sent);
    expect(serialized).toContain('discussion_node_error');
    expect(serialized).toContain('invalid_response');
    expect(serialized).not.toContain('not-json and must not leak');
  });

  it('cancels only guard-selected v2 work without waiting behind its conversation lane', async () => {
    const fixture = await routerHarness();
    let cancelled!: () => void;
    const cancelSignal = new Promise<void>((resolve) => { cancelled = resolve; });
    fixture.task.cancelTask = async (taskId) => {
      fixture.cancellations.push(taskId);
      cancelled();
    };
    fixture.setEvents((taskId) => (async function* () {
      await cancelSignal;
      yield bridgeEvent(taskId, 'cancelled');
    })());
    const active = fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(
      'assignment-active',
      discussionAssignment(),
    )));
    await vi.waitFor(() => expect(fixture.starts).toHaveLength(1));
    const cancel = fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(
      'assignment-cancel',
      discussionCancel(),
    )));
    await Promise.all([active, cancel]);

    expect(fixture.cancellations).toEqual(['task_1_1']);
    expect(fixture.starts).toHaveLength(1);
  });

  it('performs one complete v2 cancel cleanup before releasing the lane and never replays buffered output', async () => {
    const callbacks = new Map<number, { milliseconds: number; cleared: boolean }>();
    let timerId = 0;
    const fixture = await routerHarness({
      timers: {
        setTimeout(_callback, milliseconds) {
          timerId += 1;
          callbacks.set(timerId, { milliseconds, cleared: false });
          return timerId;
        },
        clearTimeout(timer) {
          const entry = callbacks.get(timer as number);
          if (entry) entry.cleared = true;
        },
      },
    });
    let resolveNext!: (value: IteratorResult<BridgeTaskEvent>) => void;
    let secondNext!: () => void;
    let releaseReturn!: () => void;
    const secondNextPending = new Promise<void>((resolve) => { secondNext = resolve; });
    const returnGate = new Promise<void>((resolve) => { releaseReturn = resolve; });
    let nextCalls = 0;
    let returned = 0;
    const iterator: AsyncIterator<BridgeTaskEvent> = {
      next: async () => {
        nextCalls += 1;
        if (nextCalls === 1) {
          return {
            done: false,
            value: bridgeEvent('task_1_1', 'text_delta', { text: 'X'.repeat(16 * 1024) }),
          };
        }
        secondNext();
        return new Promise((resolve) => { resolveNext = resolve; });
      },
      return: async () => {
        returned += 1;
        resolveNext({ done: true, value: undefined });
        await returnGate;
        return { done: true, value: undefined };
      },
    };
    fixture.setEvents((taskId, index) => index === 0
      ? { [Symbol.asyncIterator]: () => iterator }
      : (async function* () { yield bridgeEvent(taskId, 'completed'); })());
    let online = false;
    const originalSend = fixture.worker.send.bind(fixture.worker);
    fixture.worker.send = async (identity, input) => {
      if (input.messageType === 'command_result'
        && input.content.msg_type === 'discussion_contribution_delta'
        && !online) throw Object.assign(new Error('offline'), { code: 'worker_exited' });
      return originalSend(identity, input);
    };

    const active = fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(
      'cancel-cleanup-active',
      discussionAssignment({ discussionId: 'cancel-cleanup' }),
    )));
    await secondNextPending;
    const cancel = fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(
      'cancel-cleanup-command',
      discussionCancel({ discussionId: 'cancel-cleanup' }),
    )));
    await vi.waitFor(() => expect(fixture.cancellations).toEqual(['task_1_1']));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const returnedBeforeRelease = returned;
    const watchdogClearedBeforeRelease = [...callbacks.values()]
      .find(({ milliseconds }) => milliseconds > 60_000)?.cleared;

    const nextRoute = fixture.router.onWorkerEvent(
      IDENTITY_A,
      inbound(IDENTITY_A, message('after-v2-cancel')),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fixture.starts).toHaveLength(1);
    resolveNext({ done: true, value: undefined });
    releaseReturn();
    await Promise.all([active, cancel, nextRoute]);
    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(
      'cancel-cleanup-replay',
      discussionAssignment({ discussionId: 'cancel-cleanup' }),
    )));
    online = true;
    await fixture.router.onWorkerEvent(IDENTITY_A, {
      type: 'connection', runtimeId: RUNTIME_A, instanceId: INSTANCE_A, state: 'online',
    });

    expect(returnedBeforeRelease).toBe(1);
    expect(watchdogClearedBeforeRelease).toBe(false);
    expect(returned).toBe(1);
    expect(fixture.cancellations).toEqual(['task_1_1']);
    expect(fixture.starts).toHaveLength(2);
    expect(fixture.sent.some(({ input }) => input.messageType === 'command_result'
      && input.content.msg_type === 'discussion_contribution_delta')).toBe(false);
  });

  it('serves the bounded model catalog locally without starting a task', async () => {
    const fixture = await routerHarness();
    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(
      'catalog',
      {
        msg_type: 'discussion_model_catalog_request',
        protocolVersion: 2,
        requestId: 'catalog-request',
        timestamp: 1,
      },
    )));
    expect(fixture.starts).toHaveLength(0);
    expect(fixture.sent.some(({ input }) => input.messageType === 'command_result'
      && input.content.msg_type === 'discussion_model_catalog_response'
      && input.content.requestId === 'catalog-request')).toBe(true);
  });

  it('routes a reassembled payload larger than the generic 64 KiB protocol limit through the exact v2 parser', async () => {
    const fixture = await routerHarness();
    fixture.setEvents((taskId) => (async function* () {
      yield bridgeEvent(taskId, 'completed', { output: '{"action":"fail","reason":"safe failure"}' });
    })());
    const frames = encodeDiscussionWire(discussionHostTurn({ eventSummary: 'E'.repeat(70_000) }));
    expect(frames.length).toBeGreaterThan(1);
    for (let index = frames.length - 1; index >= 0; index -= 1) {
      await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(
        `large-wire-${index}`,
        JSON.parse(frames[index]!) as Record<string, unknown>,
      )));
    }
    expect(fixture.starts).toHaveLength(1);
    expect(fixture.sent.some(({ input }) => input.messageType === 'command_result'
      && input.content.msg_type === 'discussion_host_decision'
      && input.content.decision === 'fail')).toBe(true);
  });

  it('uses the command carrier for every encoded outbound wire chunk', async () => {
    const fixture = await routerHarness();
    fixture.setEvents((taskId) => (async function* () {
      yield bridgeEvent(taskId, 'completed', { output: 'C'.repeat(20_000) });
    })());
    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(
      'large-contribution',
      discussionAssignment(),
    )));
    const chunks = fixture.sent.filter(({ input }) => input.content !== undefined
      && typeof input.content === 'object'
      && input.messageType !== 'text'
      && input.content.msg_type === 'discussion_wire_chunk');
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(({ input }) => input.messageType === 'command')).toBe(true);
  });

  it('slices finish artifacts under 9000 bytes, waits for exact ACKs, paces pieces, then sends a reference-only decision', async () => {
    const pacing: number[] = [];
    const fixture = await routerHarness({ sleep: async (milliseconds) => { pacing.push(milliseconds); } });
    const artifactContent = '文'.repeat(6_000);
    fixture.setEvents((taskId) => (async function* () {
      yield bridgeEvent(taskId, 'completed', {
        output: JSON.stringify({
          action: 'finish',
          summary: 'done',
          artifact: {
            artifactType: 'markdown',
            title: 'Result',
            content: artifactContent,
            baseVersion: 0,
            final: true,
          },
        }),
      });
    })());
    const turn = discussionHostTurn({ allowedDecisions: ['finish'] });
    const routing = fixture.router.onWorkerEvent(
      IDENTITY_A,
      inbound(IDENTITY_A, protocolMessage('artifact-host', turn)),
    );
    const updates = () => fixture.sent.filter(({ input }) => input.messageType === 'command_result'
      && input.content.msg_type === 'discussion_artifact_update');
    let index = 0;
    while (true) {
      await vi.waitFor(() => expect(updates().length).toBeGreaterThan(index));
      const update = updates()[index]!.input.content as Record<string, unknown>;
      expect(Buffer.byteLength(JSON.stringify(update), 'utf8')).toBeLessThanOrEqual(9_000);
      expect(update.operation).toBe(index === 0 ? 'replace' : 'append');
      if (index === 0) {
        await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(
          'artifact-wrong-ack',
          {
            msg_type: 'discussion_artifact_ack',
            protocolVersion: 2,
            discussionId: 'discussion-host',
            chatroomId: 'group',
            requestId: 'request-host',
            stateVersion: 1,
            round: 1,
            timestamp: 2,
            updateId: 'wrong-update',
            idempotencyKey: 'wrong-update',
            artifactId: 'artifact-one',
            artifactVersion: 1,
          },
        )));
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(updates()).toHaveLength(1);
      }
      const nextVersion = (update.baseVersion as number) + 1;
      await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(
        `artifact-ack-${index}`,
        {
          msg_type: 'discussion_artifact_ack',
          protocolVersion: 2,
          discussionId: 'discussion-host',
          chatroomId: 'group',
          requestId: 'request-host',
          stateVersion: 1,
          round: 1,
          timestamp: index + 3,
          updateId: update.idempotencyKey,
          idempotencyKey: update.idempotencyKey,
          artifactId: 'artifact-one',
          artifactVersion: nextVersion,
        },
      )));
      index += 1;
      if (update.isFinal === true) break;
    }
    await routing;

    expect(updates().length).toBeGreaterThan(1);
    expect(pacing).toEqual(Array.from({ length: updates().length - 1 }, () => 200));
    const decision = fixture.sent.find(({ input }) => input.messageType === 'command_result'
      && input.content.msg_type === 'discussion_host_decision')?.input.content;
    expect(decision).toMatchObject({
      decision: 'finish', artifactId: 'artifact-one', artifactVersion: updates().length,
    });
    expect(JSON.stringify(decision)).not.toContain(artifactContent.slice(0, 100));
  });

  it('times out an unacknowledged artifact after 15 seconds and never sends a finish decision', async () => {
    vi.useFakeTimers();
    const fixture = await routerHarness({ sleep: async () => undefined });
    let artifactSent!: () => void;
    const artifactWasSent = new Promise<void>((resolve) => { artifactSent = resolve; });
    const send = fixture.worker.send.bind(fixture.worker);
    fixture.worker.send = async (identity, input) => {
      const result = await send(identity, input);
      if (input.messageType === 'command_result'
        && input.content.msg_type === 'discussion_artifact_update') artifactSent();
      return result;
    };
    fixture.setEvents((taskId) => (async function* () {
      yield bridgeEvent(taskId, 'completed', {
        output: JSON.stringify({
          action: 'finish',
          summary: 'done',
          artifact: {
            artifactType: 'markdown', title: 'Result', content: 'waiting', baseVersion: 0, final: true,
          },
        }),
      });
    })());
    const routing = fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(
      'artifact-timeout',
      discussionHostTurn({ allowedDecisions: ['finish'] }),
    )));
    await artifactWasSent;
    await vi.advanceTimersByTimeAsync(15_000);
    await routing;

    expect(fixture.sent.some(({ input }) => input.messageType === 'command_result'
      && input.content.msg_type === 'discussion_node_error'
      && input.content.category === 'timeout')).toBe(true);
    expect(fixture.sent.some(({ input }) => input.messageType === 'command_result'
      && input.content.msg_type === 'discussion_host_decision')).toBe(false);
  });

  it('admits passive or mismatched v1 tokens without starting model work', async () => {
    const fixture = await routerHarness();
    const passivePayload = {
      ...(discussionV1().payload as Record<string, unknown>),
      next_speaker: undefined,
    };
    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(
      'v1-passive',
      discussionV1({ action: 'end_discussion', payload: passivePayload }),
    )));
    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(
      'v1-wrong-group',
      discussionV1({
        payload: { ...(discussionV1().payload as Record<string, unknown>), group_id: 'other-group' },
      }),
    )));
    expect(fixture.starts).toHaveLength(0);
    expect(fixture.receipts).toHaveLength(2);
  });
});

describe('MessageRouter CardKit action dispatch', () => {
  const action = (
    cardAction: Record<string, unknown>,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    msg_type: 'card_action',
    cardId: 'card-one',
    buttonId: 'button-one',
    request_id: 'card-request',
    action: cardAction,
    timestamp: 1,
    ...overrides,
  });

  it('suppresses a card result that resolves after binding disposal while retaining its accepted claim', async () => {
    const fixture = await routerHarness();
    fixture.control.authorize = async (input) => {
      fixture.authorized.push(structuredClone(input));
      return true;
    };
    let cardEntered!: () => void;
    let resolveCard!: (result: SafeCardResult) => void;
    const cardWasEntered = new Promise<void>((resolve) => { cardEntered = resolve; });
    fixture.control.card = async () => {
      cardEntered();
      return new Promise<SafeCardResult>((resolve) => { resolveCard = resolve; });
    };

    const routing = fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(
      'card-dispose-pending',
      action({ type: 'answer', questionId: 'question-one', value: ['A'] }),
    )));
    await cardWasEntered;
    await fixture.router.disposeBinding(IDENTITY_A);
    resolveCard({ status: 'success', code: 'ok', message: 'accepted' });
    await routing;

    expect(fixture.sent).toEqual([]);
    expect(fixture.receipts).toEqual([]);
    await expect(fixture.state.claimMessage(
      IDENTITY_A.runtimeId,
      'card-dispose-pending',
      '05'.repeat(16),
    )).resolves.toMatchObject({ status: 'duplicate' });
  });

  it('returns the deterministic 501 result for permission actions without invoking control', async () => {
    const fixture = await routerHarness();
    let cardCalls = 0;
    fixture.control.card = async () => {
      cardCalls += 1;
      return { status: 'success', code: 'ok', message: 'ok' };
    };
    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(
      'card-permission',
      action({ type: 'permission', permissionId: 'permission-one', reply: 'once' }),
    )));
    const result = fixture.sent.find(({ input }) => input.messageType === 'command_result')?.input.content;
    expect(result).toMatchObject({
      msg_type: 'command_result', request_id: 'card-request', status: 'error', code: 501,
      message: 'unsupported_interactive_approval',
    });
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(10 * 1024);
    expect(cardCalls).toBe(0);
    expect(fixture.starts).toHaveLength(0);
    expect(fixture.receipts).toHaveLength(1);
  });

  it('reuses owned session semantics for command and session intents', async () => {
    const fixture = await routerHarness();
    const conversation = conversationFromForTest(IDENTITY_A);
    await fixture.state.applyEventSession({ conversation, authoritativeSessionId: 'session-one' });
    await fixture.state.applyEventSession({ conversation, authoritativeSessionId: 'session-two' });
    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(
      'card-switch',
      action({ type: 'session', op: 'switch', sessionId: 'session-one' }),
    )));
    expect(await fixture.state.currentSession(conversation)).toBe('session-one');
    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(
      'card-new',
      action({ type: 'command', name: '/new' }, { request_id: 'card-new-request' }),
    )));
    expect(await fixture.state.currentSession(conversation)).toBeUndefined();
    expect(fixture.starts).toHaveLength(0);
    expect(fixture.sent.some(({ input }) => input.messageType === 'text'
      && input.content === '[session_switched]')).toBe(true);
    expect(fixture.sent.some(({ input }) => input.messageType === 'text'
      && input.content === '[new_session]')).toBe(true);
  });

  it('admits none and navigate as UI-local no-ops with no task, control, or outbound response', async () => {
    const fixture = await routerHarness();
    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(
      'card-none',
      action({ type: 'none' }),
    )));
    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(
      'card-navigate',
      action({ type: 'navigate', target: 'session.next' }),
    )));
    expect(fixture.starts).toHaveLength(0);
    expect(fixture.authorized).toHaveLength(0);
    expect(fixture.deviceCalls).toHaveLength(0);
    expect(fixture.sent).toHaveLength(0);
    expect(fixture.receipts).toHaveLength(2);
  });

  it('authorizes sanitized answer/custom intents and emits only validated bounded card results', async () => {
    const fixture = await routerHarness();
    const calls: AuthorizedCardIntent[] = [];
    fixture.control.authorize = async (input) => {
      fixture.authorized.push(structuredClone(input));
      return input.scope === 'card.answer' || input.scope === 'card.custom';
    };
    fixture.control.card = async (input) => {
      calls.push(structuredClone(input));
      return {
        status: 'success',
        code: 'ok',
        message: 'accepted',
        card: {
          schema: '1.0.0',
          id: input.cardId,
          header: { title: 'Updated' },
          sections: [],
        },
      };
    };
    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(
      'card-answer',
      action({ type: 'answer', questionId: 'question-one', value: ['A'] }),
    )));
    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(
      'card-custom',
      action({ type: 'custom', kind: 'inspect', payload: { public: true } }),
    )));

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      kind: 'answer', questionId: 'question-one', value: ['A'], identity: IDENTITY_A,
      senderId: 'sender', conversationKey: conversationKey(conversationFromForTest(IDENTITY_A)),
    });
    expect(calls[1]).toMatchObject({ kind: 'custom', customKind: 'inspect', payload: { public: true } });
    expect(fixture.sent.filter(({ input }) => input.messageType === 'card_update')).toHaveLength(2);
    const results = fixture.sent.filter(({ input }) => input.messageType === 'command_result');
    expect(results).toHaveLength(2);
    expect(results.every(({ input }) =>
      Buffer.byteLength(JSON.stringify(input.content), 'utf8') <= 10 * 1024)).toBe(true);
  });

  it('never releases a card side effect after the control port accepted it', async () => {
    const fixture = await routerHarness();
    fixture.control.authorize = async () => true;
    fixture.control.card = async () => {
      const result = {};
      Object.defineProperty(result, 'status', {
        get: () => { throw new Error('malformed accepted result'); },
      });
      return result as never;
    };

    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(
      'card-accepted-malformed',
      action({ type: 'custom', kind: 'inspect', payload: { public: true } }),
    )));

    expect(fixture.state.releaseCalls).toBe(0);
    await expect(fixture.state.claimMessage(
      IDENTITY_A.runtimeId,
      'card-accepted-malformed',
      '02'.repeat(16),
    )).resolves.toMatchObject({ status: 'duplicate' });
  });

  it('builds a bounded card update before freezing the final command result', async () => {
    const fixture = await routerHarness();
    fixture.control.authorize = async () => true;
    fixture.control.card = async () => ({
      status: 'success',
      code: 'ok',
      message: 'accepted',
      card: {
        schema: '1.0.0',
        id: 'card-one',
        header: { title: 'Updated' },
        sections: [],
        reasoning: 'R'.repeat(8_900),
      },
    });

    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(
      'card-update-builder-failure',
      action({ type: 'custom', kind: 'inspect', payload: { public: true } }),
    )));

    const result = fixture.sent.find(({ input }) => input.messageType === 'command_result')?.input.content;
    expect(result).toMatchObject({
      status: 'error', code: 'unsupported_action', message: 'unsupported_action',
    });
    expect(fixture.sent.some(({ input }) => input.messageType === 'card_update')).toBe(false);
  });

  it('defaults custom actions to deny and never reflects invalid raw action content', async () => {
    const fixture = await routerHarness();
    let cardCalls = 0;
    fixture.control.card = async () => {
      cardCalls += 1;
      return { status: 'success', code: 'ok', message: 'ok' };
    };
    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(
      'card-denied',
      action({ type: 'custom', kind: 'inspect', payload: { public: true } }),
    )));
    await fixture.router.onWorkerEvent(IDENTITY_A, inbound(IDENTITY_A, protocolMessage(
      'card-invalid',
      action({ secret: 'must-not-leak' }),
    )));
    const serialized = JSON.stringify(fixture.sent);
    expect(serialized).toContain('unsupported_action');
    expect(serialized).toContain('invalid_action');
    expect(serialized).not.toContain('must-not-leak');
    expect(cardCalls).toBe(0);
    expect(fixture.starts).toHaveLength(0);
  });
});

function conversationFromForTest(identity: WorkerIdentity): ConversationIdentity {
  return {
    ...identity,
    conversationType: 3,
    targetId: 'group',
    senderId: 'sender',
  };
}

function responseOnlyPayload(msgType: string): Record<string, unknown> {
  if (msgType === 'device_status_report' || msgType === 'device_control_result') {
    return { msg_type: msgType, request_id: 'request' };
  }
  if (msgType === 'command_result') {
    return { msg_type: msgType, request_id: 'request' };
  }
  return { msg_type: msgType };
}
