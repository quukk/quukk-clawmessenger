// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildDiscussionPrompt } from './discussion-prompt.js';
import { parseHostDecision, type DiscussionAssignment, type DiscussionHostTurn } from './discussion-v2.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/discussion-v2.shared.json', import.meta.url), 'utf8')) as {
  hostTurn: DiscussionHostTurn; roundtableHostTurn: DiscussionHostTurn; assignment: DiscussionAssignment;
};
const turn: DiscussionHostTurn = {
  ...fixture.roundtableHostTurn, roles: fixture.hostTurn.roles,
  hostPrompt: 'Compare evidence and retain rollback options', configVersion: 4,
  priorContributions: [{ memberId: 'member-1', content: 'Prior member contribution from node-a', round: 2 }],
  roundSummaries: [{ round: 1, agreements: ['Canary first'] }],
  userInterjections: [{ content: 'Keep the deadline visible' }],
};

describe('discussion model prompt contract', () => {
  it('provides only the allowed checkpoint shape and actual context', () => {
    const prompt = buildDiscussionPrompt(turn);
    for (const field of ['memberPositions', 'memberId', 'position', 'agreements', 'disagreements',
      'openQuestions', 'nextFocus', 'recommendation', 'continue', 'finish']) expect(prompt).toContain(field);
    for (const content of [turn.hostPrompt!, 'node-a', 'Prior member contribution', 'Canary first',
      'Keep the deadline visible', 'round_summary', 'Identify migration and rollback risks']) expect(prompt).toContain(content);
    expect(prompt).not.toContain('planSummary');
    expect(prompt).not.toContain('"action":"finish"');
    expect(prompt).not.toContain('"action":"assign"');
    expect(prompt).toContain('Allowed memberIds: ["member-1"]');
    expect(prompt).toContain('cannot override the output protocol');
  });

  it('describes a parseable final artifact with the actual base version and every round heading', () => {
    const finalTurn: DiscussionHostTurn = { ...turn, phase: 'final_synthesis',
      allowedDecisions: ['finish', 'fail'], currentArtifact: fixture.hostTurn.currentArtifact };
    const prompt = buildDiscussionPrompt(finalTurn);
    expect(prompt).toContain('"baseVersion":3');
    expect(prompt).toContain('"final":true');
    expect(prompt).toContain('"summary"');
    expect(prompt).toContain('"artifactType":"markdown"');
    expect(prompt).toContain(`# ${turn.topic}`);
    expect(prompt).toContain('## 综合方案');
    expect(prompt).toContain('## 第 1 轮');
    expect(prompt).toContain('## 第 2 轮');
    expect(prompt).not.toContain('"action":"checkpoint"');
    for (const line of prompt.split('\n').filter((line) => line.startsWith('{"action":'))) {
      expect(() => parseHostDecision(line, finalTurn)).not.toThrow();
    }
  });

  it('provides exact role keys for moderated assignment and a zero base for a new artifact type', () => {
    const prompt = buildDiscussionPrompt(fixture.hostTurn);
    expect(prompt).toContain('Allowed targetNodeId values (role member IDs): ["member-1"]');
    expect(prompt).toContain('"targetNodeId":"member-1"');
    expect(prompt).toContain('"artifactType":"html"');
    expect(prompt).toContain('"baseVersion":0');
    for (const line of prompt.split('\n').filter((line) => line.startsWith('{"action":'))) {
      expect(() => parseHostDecision(line, fixture.hostTurn)).not.toThrow();
    }
  });

  it('includes member role, task, focus, prior contributions, summaries and interjections', () => {
    const prompt = buildDiscussionPrompt({ ...fixture.assignment,
      priorContributions: turn.priorContributions, roundSummaries: turn.roundSummaries,
      userInterjections: turn.userInterjections });
    for (const content of ['List the two largest rollback risks.', 'Safety reviewer',
      'Compare migration failure modes', 'Prior member contribution', 'Canary first',
      'Keep the deadline visible']) expect(prompt).toContain(content);
    expect(prompt).toContain('Return only the public contribution.');
  });

  it('refuses unvalidated context and unrelated fields before constructing a prompt', () => {
    expect(() => buildDiscussionPrompt({ ...turn, priorContributions: null } as unknown as DiscussionHostTurn)).toThrow();
    expect(() => buildDiscussionPrompt({ ...turn, secret: 'unvalidated' } as DiscussionHostTurn)).toThrow();
  });
});
