import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { RouterStateStore, type InteractiveRequest } from './session-store.js';
import { interactiveSessionKey } from './conversation.js';
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
const runtimeId = `rt_${'a'.repeat(32)}`;
function record(requestId = 'a'): InteractiveRequest {
  return {
    runtimeId, nodeId: 'n', senderId: 'system', memberId: 'n', discussionId: 'd', chatroomId: 'room', requestId,
    key: JSON.stringify([runtimeId, 'n', 'system', 'd', requestId]), sessionKey: interactiveSessionKey(runtimeId, 'n', 'discussion', 'd'),
    taskId: 'task_100_a', instanceId: `br_${'a'.repeat(32)}`, stateVersion: 2, round: 1, roundRevision: 0, expiresAt: 2000, fingerprint: 'a'.repeat(64), status: 'reserved'
  };
}
async function setup() { const dir = await mkdtemp(join(tmpdir(), 'interactive-state-')); dirs.push(dir); const filePath = join(dir, 'sessions.json'); const clock = { now: 1000 }; const state = new RouterStateStore({ filePath, now: () => clock.now }); await state.initialize(); return { state, filePath, clock }; }
it('retains watermark after expired terminal records are pruned', async () => {
  const h = await setup();
  const a = record();
  await h.state.reserveInteractive(a);
  await h.state.updateInteractive(a.key, { status: 'terminal' });
  h.clock.now = 3000;
  expect(await h.state.reserveInteractive({ ...a, expiresAt: 5000 })).toBeUndefined();
  expect(await h.state.reserveInteractive({ ...record('b'), roundRevision: 1, expiresAt: 5000 })).toBeDefined();
});
it('does not prune unresolved session fences on expiry', async () => {
  const h = await setup();
  const a = record();
  await h.state.reserveInteractive(a);
  h.clock.now = 3000;
  expect(await h.state.reserveInteractive({ ...record('b'), roundRevision: 1, expiresAt: 5000 })).toBeUndefined();
});
it('rejects a runtime session already owned by another discussion', async () => {
  const h = await setup();
  const a = record();
  await h.state.reserveInteractive(a);
  await h.state.updateInteractive(a.key, { status: 'terminal' }, 'session-one');
  const b = { ...record('b'), discussionId: 'other', sessionKey: interactiveSessionKey(runtimeId, 'n', 'discussion', 'other'), key: JSON.stringify([runtimeId, 'n', 'system', 'other', 'b']), taskId: 'task_100_b' };
  await h.state.reserveInteractive(b);
  await expect(h.state.updateInteractive(b.key, { status: 'terminal' }, 'session-one')).rejects.toMatchObject({ code: 'session_conflict' });
});
it('rejects ordinary adoption of an interactive-owned runtime session', async () => {
  const h = await setup(); const a = record();
  await h.state.reserveInteractive(a); await h.state.updateInteractive(a.key, { status: 'terminal' }, 'owned');
  await expect(h.state.applyEventSession({ conversation: { runtimeId, nodeId: 'n', conversationType: 1, senderId: 'human', targetId: 'human' }, authoritativeSessionId: 'owned' })).rejects.toMatchObject({ code: 'session_conflict' });
});
it('rejects persisted ordinary-interactive and interactive-interactive session collisions', async () => {
  const h = await setup(); const a = record();
  await h.state.reserveInteractive(a); await h.state.updateInteractive(a.key, { status: 'terminal' }, 'owned');
  await h.state.applyEventSession({ conversation: { runtimeId, nodeId: 'n', conversationType: 1, senderId: 'human', targetId: 'human' }, authoritativeSessionId: 'ordinary' });
  const state = JSON.parse(await readFile(h.filePath, 'utf8'));
  for (const collision of [
    { ...state, interactiveSessions: { [a.sessionKey]: 'ordinary' } },
    { ...state, interactiveSessions: { ...state.interactiveSessions, [interactiveSessionKey(runtimeId, 'other', 'discussion', 'other')]: 'owned' } },
  ]) {
    await writeFile(h.filePath, JSON.stringify(collision));
    await expect(new RouterStateStore({ filePath: h.filePath }).initialize()).rejects.toMatchObject({ code: 'router_state_invalid' });
  }
});
it('retains trusted room classification across restart and terminal request expiry', async () => {
  const h = await setup();
  await h.state.rememberInteractiveRoom({ runtimeId, nodeId: 'n' }, 'room', 'd');
  const a = record();
  await h.state.reserveInteractive(a);
  await h.state.updateInteractive(a.key, { status: 'terminal' });
  h.clock.now = 3000;
  await h.state.reserveInteractive({ ...record('b'), roundRevision: 1, expiresAt: 5000 });
  const restored = new RouterStateStore({ filePath: h.filePath, now: () => 90000000 });
  await restored.initialize();
  expect(await restored.isInteractiveRoom({ runtimeId, nodeId: 'n' }, 'room')).toBe(true);
  expect(await restored.isInteractiveRoom({ runtimeId, nodeId: 'other' }, 'room')).toBe(false);
});
it('rejects persisted request identities inconsistent with ownership keys', async () => {
  const h = await setup();
  const a = record();
  await h.state.reserveInteractive(a);
  const json = JSON.parse(await readFile(h.filePath, 'utf8'));
  json.interactiveRequests[0].nodeId = 'other';
  await writeFile(h.filePath, JSON.stringify(json));
  await expect(new RouterStateStore({ filePath: h.filePath }).initialize()).rejects.toMatchObject({ code: 'router_state_invalid' });
});
it('preserves schema-one private history through new namespace persistence', async () => {
  const h = await setup();
  const identity = { runtimeId, nodeId: 'n', senderId: 'human', targetId: 'human', conversationType: 1 as const };
  await h.state.applyEventSession({ conversation: identity, authoritativeSessionId: 'old-history' });
  const json = JSON.parse(await readFile(h.filePath, 'utf8'));
  const sessions = json.sessions;
  await writeFile(h.filePath, JSON.stringify({ schemaVersion: 1, sessions, dedup: [] }));
  const restored = new RouterStateStore({ filePath: h.filePath, now: () => 1000 });
  await restored.initialize();
  await restored.reserveInteractive(record());
  expect(await restored.currentSession(identity)).toBe('old-history');
  expect(JSON.parse(await readFile(h.filePath, 'utf8')).sessions).toEqual(sessions);
});
