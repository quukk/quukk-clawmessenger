// @vitest-environment node
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { buildDiscussionV3Prompt, parseDiscussionV3Checkpoint } from './discussion-v3-prompt.js';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/discussion-v3-messages.json', import.meta.url), 'utf8'));
it('includes every current opinion and completed speech in the checkpoint input', () => {
  const prompt = buildDiscussionV3Prompt({ ...fixture.valid.hostTurn, userInterjections: [{ content: 'Keep offline mode' }, { content: 'Protect history' }], priorContributions: [{ memberId: 'm', content: 'Use an append-only log', round: 1 }] });
  for (const text of ['Keep offline mode', 'Protect history', 'Use an append-only log', 'summaryMarkdown', 'user decides'])
    expect(prompt).toContain(text);
});
it('parses complete structured checkpoints and rejects blank or oversized documents', () => {
  const { protocolVersion, discussionId, chatroomId, requestId, stateVersion, round, roundRevision, timestamp, msg_type, idempotencyKey, decision, ...checkpoint } = fixture.valid.checkpoint;
  expect(parseDiscussionV3Checkpoint(JSON.stringify({ action: 'checkpoint', ...checkpoint }), fixture.valid.hostTurn)).toMatchObject({ summaryMarkdown: checkpoint.summaryMarkdown });
  for (const summaryMarkdown of ['  ', 'x'.repeat(100001)])
    expect(parseDiscussionV3Checkpoint(JSON.stringify({ action: 'checkpoint', ...checkpoint, summaryMarkdown }), fixture.valid.hostTurn)).toBeNull();
});
