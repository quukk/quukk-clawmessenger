// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { DiscussionV3Router } from './discussion-v3-router.js';
import { RouterStateStore } from './session-store.js';
import { interactiveSessionKey } from './conversation.js';
import type { BridgeTaskEvent, BridgeTaskStartInput } from '../go/types.js';
import { parseDiscussionV3, type DiscussionV3Assignment, type DiscussionV3Cancel, type DiscussionV3Message } from '../protocol/discussion-v3.js';
const runtimeId = `rt_${'a'.repeat(32)}`;
const identity = { runtimeId, nodeId: 'physical-node-1' };
const now = 1788854400000;
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
function assignment(requestId = 'request-a', discussionId = 'discussion-a'): DiscussionV3Assignment {
  return {
    protocolVersion: 3, msg_type: 'discussion_assignment', discussionId, chatroomId: `room-${discussionId}`, requestId, stateVersion: 4, round: 1, roundRevision: 0, timestamp: now,
    assignmentId: `assignment-${requestId}`, targetId: 'member-1', task: 'Review', topic: 'API', goal: 'Choose', mode: 'roundtable', model: null, role: { roleName: 'Reviewer', roleInstructions: 'Evaluate' }, speakingOrder: 0, roundFocus: 'Migration', priorContributions: [], roundSummaries: [], userInterjections: [], attempt: 1
  };
}
function cancel(work = assignment()): DiscussionV3Cancel {
  const { discussionId, chatroomId, stateVersion, round, roundRevision } = work;
  return { protocolVersion: 3, msg_type: 'discussion_cancel', discussionId, chatroomId, stateVersion, round, roundRevision, timestamp: now, requestId: `cancel-${work.requestId}`, targetRequestId: work.requestId, targetMemberId: 'member-1', reason: 'Interjection' };
}
class FakeRuntime {
  processedEvents = 0;
  instanceId = `br_${'a'.repeat(32)}`;
  starts: BridgeTaskStartInput[] = [];
  queues = new Map<string, {
    events: BridgeTaskEvent[];
    wake?: () => void;
  }>();
  fenced = new Set<string>();
  releaseFence?: () => void;
  holdFence = false;
  loseResponse = false;
  async health() { return { instance_id: this.instanceId }; }
  async startTask(input: BridgeTaskStartInput) {
    if (!input.requestId)
      throw new Error('caller identity required');
    if (this.fenced.has(input.requestId))
      throw new Error('fenced');
    if (!this.queues.has(input.requestId)) {
      this.starts.push(input);
      this.queues.set(input.requestId, { events: [] });
    }
    if (this.loseResponse)
      throw new Error('response lost');
    return { taskId: input.requestId, eventsUrl: `/v1/tasks/${input.requestId}/events` };
  }
  async cancelTask() { }
  async fenceTask(id: string) {
    if (this.holdFence)
      await new Promise<void>(resolve => { this.releaseFence = resolve; });
    this.fenced.add(id);
    if (!this.queues.has(id))
      return { result: 'not_started' as const };
    this.emit(id, { type: 'cancelled' });
    return { result: 'cancelled' as const };
  }
  emit(id: string, event: Record<string, unknown>) {
    const queue = this.queues.get(id)!;
    queue.events.push({ id: queue.events.length + 1, task_id: id, time: '2026-09-08T08:00:00Z', ...event } as BridgeTaskEvent);
    queue.wake?.();
  }
  async *events(id: string): AsyncIterable<BridgeTaskEvent> {
    const queue = this.queues.get(id)!;
    let index = 0;
    while (true) {
      if (index === queue.events.length)
        await new Promise<void>(resolve => { queue.wake = resolve; });
      const event = queue.events[index++]!;
      yield event;
      this.processedEvents += 1;
      if (['completed', 'failed', 'cancelled'].includes(event.type))
        return;
    }
  }
}
async function setup(runtime = new FakeRuntime(), filePath?: string) {
  if (!filePath) {
    const dir = await mkdtemp(join(tmpdir(), 'discussion-v3-'));
    dirs.push(dir);
    filePath = join(dir, 'sessions.json');
  }
  const state = new RouterStateStore({ filePath, now: () => now });
  await state.initialize();
  const sent: DiscussionV3Message[] = [];
  const availability = { ready: true };
  const router = new DiscussionV3Router({ identity, memberId: 'member-1', state, task: runtime, send: async (payload) => { sent.push(payload); }, workdir: async () => 'D:/work', available: async () => availability.ready, now: () => now });
  return { router, state, sent, runtime, filePath, availability };
}
async function until(predicate: () => boolean) {
  for (let n = 0; n < 200 && !predicate(); n++)
    await new Promise(resolve => setTimeout(resolve, 2)); expect(predicate()).toBe(true);
}
it('acknowledges failed when terminal proof persistence fails and retries safely', async () => {
  const h = await setup(); h.runtime.loseResponse = true;
  await h.router.handle('system', assignment());
  const update = h.state.updateInteractive.bind(h.state);
  let fail = true;
  h.state.updateInteractive = async (key, changes, sessionId) => {
    if (fail && changes.status === 'terminal') { fail = false; throw new Error('injected disk failure'); }
    return update(key, changes, sessionId);
  };
  await h.router.handle('system', cancel());
  expect(h.sent.at(-1)).toMatchObject({ msg_type: 'discussion_cancel_ack', result: 'failed' });
  expect((await h.state.interactiveRequests(identity))[0]).toMatchObject({ status: 'unconfirmed', cancelResult: 'failed' });
  await h.router.handle('system', { ...assignment('replacement'), roundRevision: 1 });
  expect(h.runtime.starts).toHaveLength(1);
  const restarted = await setup(h.runtime, h.filePath);
  await restarted.router.handle('system', cancel());
  expect(restarted.sent.at(-1)).toMatchObject({ result: 'cancelled' });
  expect((await restarted.state.interactiveRequests(identity))[0]).toMatchObject({ status: 'terminal', cancelResult: 'cancelled' });
});
it('never reports cancelled when terminal session proof conflicts with another owner', async () => {
  const h = await setup(); h.runtime.loseResponse = true;
  await h.router.handle('system', assignment());
  await h.state.applyEventSession({ conversation: { ...identity, conversationType: 1, targetId: 'human', senderId: 'human' }, authoritativeSessionId: 'other-owned-session' });
  Object.assign(h.runtime, { fenceTask: async () => ({ result: 'cancelled', session_id: 'other-owned-session' }) });
  await h.router.handle('system', cancel());
  expect(h.sent.at(-1)).toMatchObject({ result: 'failed' });
  await h.router.handle('system', cancel());
  expect(h.sent.at(-1)).toMatchObject({ result: 'failed' });
  expect((await h.state.interactiveRequests(identity))[0]).toMatchObject({ status: 'unconfirmed', cancelResult: 'failed' });
  await h.router.handle('system', { ...assignment('replacement'), roundRevision: 1 });
  expect(h.runtime.starts).toHaveLength(1);
});
it('preserves every whitespace delta through an interrupted partial contribution', async () => {
  const h = await setup(); const running = h.router.handle('system', assignment());
  await until(() => h.runtime.starts.length === 1);
  const chunks = ['Hello', ' ', 'world', '\n', 'Next', '  '];
  for (const text of chunks) h.runtime.emit(h.runtime.starts[0]!.requestId!, { type: 'text_delta', text });
  await until(() => h.runtime.processedEvents === chunks.length);
  await h.router.handle('system', cancel()); await running;
  const deltas = h.sent.filter(event => event.msg_type === 'discussion_contribution_delta');
  expect(deltas.map(event => event.content)).toEqual(chunks);
  expect(deltas.every(event => parseDiscussionV3(event) !== null)).toBe(true);
  expect(h.sent.some(event => event.msg_type === 'discussion_contribution_completed')).toBe(false);
});
it('replays a proven terminal response while runtime is unavailable', async () => {
  const h = await setup();
  const work = assignment();
  const running = h.router.handle('system', work);
  await until(() => h.runtime.starts.length === 1);
  h.runtime.emit(h.runtime.starts[0]!.requestId!, { type: 'completed', output: 'Done' });
  await running;
  h.availability.ready = false;
  await h.router.handle('system', work);
  expect(h.sent.at(-1)).toEqual(h.sent[0]);
  expect(h.runtime.starts).toHaveLength(1);
});
it('keeps response identities bounded and forwards selected model', async () => {
  const h = await setup();
  const work = { ...assignment('r'.repeat(128)), assignmentId: 'a', model: 'openai/gpt-5.5' };
  const running = h.router.handle('system', work);
  await until(() => h.runtime.starts.length === 1);
  expect(h.runtime.starts[0]!.model).toBe(work.model);
  h.runtime.emit(h.runtime.starts[0]!.requestId!, { type: 'completed', output: 'Done' });
  await running;
  expect(h.sent.at(-1)).toMatchObject({ msg_type: 'discussion_contribution_completed' });
  expect((h.sent.at(-1) as {
    idempotencyKey: string;
  }).idempotencyKey.length).toBeLessThanOrEqual(128);
});
it('isolates discussions and never acknowledges signal delivery before terminal proof', async () => {
  const h = await setup();
  h.runtime.holdFence = true;
  const a = h.router.handle('system', assignment());
  const b = h.router.handle('system', assignment('request-b', 'discussion-b'));
  await until(() => h.runtime.starts.length === 2);
  const stopping = h.router.handle('system', cancel());
  await until(() => !!h.runtime.releaseFence);
  expect(h.sent.some(p => p.msg_type === 'discussion_cancel_ack')).toBe(false);
  const bId = h.runtime.starts.find(s => s.conversationKey.includes('discussion-b'))!.requestId!;
  h.runtime.emit(bId, { type: 'completed', output: 'B finished', session_id: 'session-b' });
  await b;
  h.runtime.releaseFence!();
  await stopping;
  await a;
  expect(h.sent).toEqual(expect.arrayContaining([expect.objectContaining({ msg_type: 'discussion_cancel_ack', result: 'cancelled' }), expect.objectContaining({ msg_type: 'discussion_contribution_completed', requestId: 'request-b', content: 'B finished' })]));
  await h.router.handle('system', cancel());
  expect(h.sent.filter(p => p.msg_type === 'discussion_cancel_ack').map(p => p.result)).toEqual(['cancelled', 'cancelled']);
});
it('persists cancellation before assignment and rejects restart replay', async () => {
  const h = await setup();
  await h.router.handle('system', cancel());
  const restarted = await setup(h.runtime, h.filePath);
  await restarted.router.handle('system', assignment());
  expect(h.runtime.starts).toHaveLength(0);
  expect(h.sent[0]).toMatchObject({ result: 'not_started' });
});
it('recovers caller identity after POST succeeds but response is lost', async () => {
  const h = await setup();
  h.runtime.loseResponse = true;
  await h.router.handle('system', assignment());
  const restarted = await setup(h.runtime, h.filePath);
  await restarted.router.handle('system', cancel());
  expect(h.runtime.starts).toHaveLength(1);
  expect(h.runtime.fenced.has(h.runtime.starts[0]!.requestId!)).toBe(true);
  expect(restarted.sent.at(-1)).toMatchObject({ result: 'cancelled' });
});
it('fails closed after Go instance changes and blocks a replacement in that session', async () => {
  const h = await setup();
  h.runtime.loseResponse = true;
  await h.router.handle('system', assignment());
  h.runtime.instanceId = `br_${'b'.repeat(32)}`;
  const restarted = await setup(h.runtime, h.filePath);
  await restarted.router.handle('system', cancel());
  await restarted.router.handle('system', assignment('replacement'));
  expect(h.runtime.starts).toHaveLength(1);
  expect(restarted.sent).toEqual(expect.arrayContaining([expect.objectContaining({ msg_type: 'discussion_cancel_ack', result: 'failed' })]));
});
it('rejects unauthorized sender and mismatched member cancel', async () => {
  const h = await setup();
  await h.router.handle('attacker', cancel());
  await h.router.handle('system', { ...cancel(), targetMemberId: 'other' });
  expect(h.sent).toHaveLength(0);
  expect(h.runtime.fenced.size).toBe(0);
});
it('uses collision-free interactive namespaces without splitting group sender sessions', () => {
  expect(interactiveSessionKey('r', 'n', 'discussion', 'a')).toBe('["r","n","discussion","a"]');
  expect(new Set(['discussion', 'recommendation', 'private', 'group'].map(kind => interactiveSessionKey('r', 'n', kind, 'a'))).size).toBe(4);
});
it('restores the interrupted session from terminal fence proof before admitting replacement', async () => {
  const h = await setup();
  h.runtime.loseResponse = true;
  await h.router.handle('system', assignment());
  const first = h.runtime.starts[0]!.requestId!;
  Object.assign(h.runtime, { fenceTask: async (id: string) => { expect(id).toBe(first); return { result: 'cancelled', session_id: 'preserved-session' }; } });
  const restarted = await setup(h.runtime, h.filePath);
  await restarted.router.handle('system', cancel());
  h.runtime.loseResponse = false;
  const replacement = restarted.router.handle('system', { ...assignment('replacement'), roundRevision: 1, stateVersion: 5 });
  await until(() => h.runtime.starts.length === 2);
  expect(h.runtime.starts[1]?.resumeSessionId).toBe('preserved-session');
  h.runtime.emit(h.runtime.starts[1]!.requestId!, { type: 'completed', output: 'continued' });
  await replacement;
});
it('rejects a stale new request after a newer round revision has completed', async () => {
  const h = await setup();
  const current = h.router.handle('system', { ...assignment(), roundRevision: 2, stateVersion: 6 });
  await until(() => h.runtime.starts.length === 1);
  h.runtime.emit(h.runtime.starts[0]!.requestId!, { type: 'completed', output: 'current' });
  await current;
  h.runtime.loseResponse = true;
  await h.router.handle('system', assignment('late-request'));
  expect(h.runtime.starts).toHaveLength(1);
});
it('fences owned requests on binding disposal without stopping another binding', async () => {
  const h = await setup();
  const run = h.router.handle('system', assignment());
  await until(() => h.runtime.starts.length === 1);
  await h.router.dispose();
  await run;
  expect(h.runtime.fenced.has(h.runtime.starts[0]!.requestId!)).toBe(true);
  await h.router.handle('system', assignment('after-dispose', 'other-discussion'));
  expect(h.runtime.starts).toHaveLength(1);
});
