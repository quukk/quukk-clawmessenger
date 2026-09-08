import type { DiscussionV3HostTurn, DiscussionV3Assignment } from '../../src/protocol/discussion-v3.js';

declare const host: DiscussionV3HostTurn;
declare const assignment: DiscussionV3Assignment;

// Downstream runtimes can consume every field required by the strict parser.
const phase: 'round_summary' = host.phase;
const decisions: ['checkpoint'] = host.allowedDecisions;
const hostMode: 'roundtable' = host.mode;
const summaries: unknown[] = host.roundSummaries;
const assignmentMode: 'roundtable' = assignment.mode;
const model: string | null = assignment.model;
const role: { roleName: string; roleInstructions: string } = assignment.role;
const order: number = assignment.speakingOrder;
const focus: string = assignment.roundFocus;
const prior: unknown[] = assignment.priorContributions;
const assignmentSummaries: unknown[] = assignment.roundSummaries;
const attempt: 1 | 2 = assignment.attempt;

// @ts-expect-error v3 does not run the legacy final-synthesis phase.
const legacyPhase: DiscussionV3HostTurn['phase'] = 'final_synthesis';
// @ts-expect-error v3 host decisions are checkpoint-only.
const legacyDecision: DiscussionV3HostTurn['allowedDecisions'] = ['finish'];
// @ts-expect-error a third automatic attempt is outside the parser contract.
const thirdAttempt: DiscussionV3Assignment['attempt'] = 3;

void [phase, decisions, hostMode, summaries, assignmentMode, model, role, order,
  focus, prior, assignmentSummaries, attempt, legacyPhase, legacyDecision, thirdAttempt];
