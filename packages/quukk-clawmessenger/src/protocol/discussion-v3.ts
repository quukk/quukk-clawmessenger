/** Strict interactive-round contracts. Parsing does not advertise runtime readiness. */
import { DISCUSSION_V2_LIMITS as L } from './discussion-v2.js';
import type { DiscussionAssignment, DiscussionHostTurn } from './discussion-v2.js';

export const INTERACTIVE_ROUNDS_CAPABILITY = 'discussion_interactive_rounds';
export interface DiscussionV3Identity {
  protocolVersion: 3; discussionId: string; chatroomId: string; requestId: string;
  stateVersion: number; round: number; roundRevision: number; timestamp: number;
}
export type CancelResult = 'cancelled' | 'already_terminal' | 'not_started' | 'failed';
export type DiscussionV3HostTurn = Omit<DiscussionHostTurn,
  keyof DiscussionV3Identity | 'remainingRounds' | 'mode' | 'phase' | 'allowedDecisions'
  | 'roundSummaries' | 'userInterjections' | 'hostPrompt' | 'configVersion' | 'priorContributions'
> & DiscussionV3Identity & {
  mode: 'roundtable'; phase: 'round_summary'; allowedDecisions: ['checkpoint'];
  roundSummaries: unknown[]; userInterjections: unknown[];
  priorContributions?: Array<{ memberId: string; content: string; round: number }>;
} & ({ hostPrompt: string; configVersion: number } | { hostPrompt?: never; configVersion?: never });
export type DiscussionV3Assignment = Omit<DiscussionAssignment,
  keyof DiscussionV3Identity | 'mode' | 'model' | 'role' | 'speakingOrder' | 'roundFocus'
  | 'priorContributions' | 'roundSummaries' | 'userInterjections' | 'attempt'
> & DiscussionV3Identity & {
  mode: 'roundtable'; model: string | null;
  role: { roleName: string; roleInstructions: string }; speakingOrder: number;
  roundFocus: string; priorContributions: unknown[]; roundSummaries: unknown[];
  userInterjections: unknown[]; attempt: 1 | 2;
};
export type DiscussionV3Cancel = DiscussionV3Identity & { msg_type: 'discussion_cancel'; targetRequestId: string; targetMemberId: string; reason: string };
export type DiscussionV3CancelAck = DiscussionV3Identity & { msg_type: 'discussion_cancel_ack'; targetRequestId: string; targetMemberId: string; result: CancelResult };
export interface Checkpoint {
  memberPositions: Array<{ memberId: string; position: string }>;
  agreements: string[]; disagreements: string[]; openQuestions: string[];
  nextFocus: string; recommendation: 'continue' | 'finish'; summaryMarkdown: string;
}
export type DiscussionV3Checkpoint = DiscussionV3Identity & Checkpoint & { msg_type: 'discussion_host_decision'; decision: 'checkpoint'; idempotencyKey: string; planSummary?: string };
export type DiscussionV3Contribution = DiscussionV3Identity & { assignmentId: string; content: string; idempotencyKey: string } & ({ msg_type: 'discussion_contribution_delta'; seq: number } | { msg_type: 'discussion_contribution_completed' });
export type DiscussionV3NodeError = DiscussionV3Identity & { msg_type: 'discussion_node_error'; assignmentId?: string; category: 'invalid_response' | 'model_error' | 'timeout'; message: string; idempotencyKey: string };
export interface DiscussionV3EventDataMap {
  request_interrupted: { targetRequestId: string; targetMemberId: string; reason: 'user_interjection'; partialPreserved: true };
  interjection_applied: { messageUid: string; targetRequestId: string | null; replacementRequestId: string };
  interruption_failed: { targetRequestId: string; targetMemberId: string; reason: 'cancel_failed' | 'cancel_unconfirmed'; retryable: true };
  discussion_started: { roundPolicy: 'user_confirmed' };
  discussion_completed: { reason: 'user_finished' };
  discussion_cancelled: { reason: 'user_cancelled' | 'stopped' };
  discussion_failed: { reason: 'summary_failed' | 'cancel_failed' | 'cancel_unconfirmed' | 'dispatch_failed'; retryable: boolean };
  discussion_progress: Record<string, never>;
  round_started: { round: number; roundFocus: string };
  round_summary_started: { round: number };
  round_summary_completed: { round: number; revision: number; sourceRequestId: string; documentId: string; title: string; content: string };
  contribution_delta: { round: number; content: string };
  contribution_completed: { round: number; content: string };
  user_interjection: { messageUid: string; memberId: string; content: string; createdAt: string; consumedFromRound: number };
  member_retry_scheduled: { round: number; memberId: string; attempt: 2; category: string };
  member_skipped: { round: number; memberId: string } & ({ category: string; reason?: never } | { reason: string; category?: never });
}
export type DiscussionV3Event = {
  [Kind in keyof DiscussionV3EventDataMap]: DiscussionV3Identity & {
    msg_type: 'discussion_event'; seq: number; eventType: Kind;
    actorId: string | null; targetId: string | null; data: DiscussionV3EventDataMap[Kind];
  }
}[keyof DiscussionV3EventDataMap];
export type DiscussionV3Message = DiscussionV3HostTurn | DiscussionV3Assignment | DiscussionV3Cancel | DiscussionV3CancelAck | DiscussionV3Checkpoint | DiscussionV3Contribution | DiscussionV3NodeError | DiscussionV3Event;

type Validator = (value: unknown) => boolean;
type Fields = Record<string, Validator>;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const text = (max: number, empty = false): Validator => v => typeof v === 'string' && v.length <= max && (empty || v.length > 0) && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v);
const nonblank = (max: number): Validator => v => text(max)(v) && !!(v as string).trim();
const id: Validator = v => text(L.maxId)(v) && (v as string).trim() === v && !/[\p{Cc}\p{Cf}]/u.test(v as string);
const integer = (min: number): Validator => v => typeof v === 'number' && Number.isSafeInteger(v) && v >= min;
const choice = (...values: unknown[]): Validator => v => values.includes(v);
const nullable = (f: Validator): Validator => v => v === null || f(v);
function validNestedUnicode(value: unknown): boolean {
  if (typeof value === 'string') return text(Number.MAX_SAFE_INTEGER, true)(value);
  if (Array.isArray(value)) return value.every(validNestedUnicode);
  if (object(value)) return Object.entries(value).every(([key, item]) => validNestedUnicode(key) && validNestedUnicode(item));
  return true;
}
const array = (f: Validator, max = 100): Validator => v => Array.isArray(v) && v.length <= max && v.every(f) && validNestedUnicode(v) && new TextEncoder().encode(JSON.stringify(v)).length <= L.maxContribution;
const shape = (fields: Fields, optional: Fields = {}): Validator => v => object(v) && Object.keys(fields).every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => Object.hasOwn(fields, k) || Object.hasOwn(optional, k)) && Object.entries(fields).every(([k, f]) => f(v[k])) && Object.entries(optional).every(([k, f]) => !Object.hasOwn(v, k) || f(v[k]));
const model: Validator = v => text(256)(v) && (v as string).trim() === v && !/\s/.test(v as string) && (v as string).split('/').length === 2 && (v as string).split('/').every(Boolean);
const history = array(() => true);
const prior = array(shape({ memberId: id, content: text(L.maxContribution), round: integer(0) }));
const role = shape({ memberId: id, nodeId: id, nickname: text(L.maxTitle, true), roleName: text(L.maxTitle, true), roleInstructions: text(L.maxTask, true), capabilities: array(id, 64) }, { portraitUri: text(L.maxTask, true), isHost: choice(true, false), model, speakingOrder: integer(0) });
const roles: Validator = v => object(v) && Object.keys(v).length <= 256 && Object.entries(v).every(([k, r]) => id(k) && role(r) && (r as Record<string, unknown>).memberId === k);
const artifact = nullable(shape({ artifactId: id, artifactType: choice('markdown', 'html'), title: text(L.maxTitle), version: integer(1) }));
const base: Fields = { msg_type: text(64), protocolVersion: choice(3), discussionId: id, chatroomId: id, requestId: id, stateVersion: integer(1), round: integer(0), roundRevision: integer(0), timestamp: integer(1) };
const positions = array(shape({ memberId: id, position: text(2000) }), 32);
const checkpoint: Fields = { memberPositions: positions, agreements: array(text(2000), 32), disagreements: array(text(2000), 32), openQuestions: array(text(2000), 32), nextFocus: text(2000, true), recommendation: choice('continue', 'finish'), summaryMarkdown: nonblank(L.maxContribution) };
const eventData: Record<string, Validator> = {
  request_interrupted: shape({ targetRequestId: id, targetMemberId: id, reason: choice('user_interjection'), partialPreserved: choice(true) }),
  interjection_applied: shape({ messageUid: id, targetRequestId: nullable(id), replacementRequestId: id }),
  interruption_failed: shape({ targetRequestId: id, targetMemberId: id, reason: choice('cancel_failed','cancel_unconfirmed'), retryable: choice(true) }),
  discussion_started: shape({ roundPolicy: choice('user_confirmed') }),
  discussion_completed: shape({ reason: choice('user_finished') }),
  discussion_cancelled: shape({ reason: choice('user_cancelled','stopped') }),
  discussion_failed: shape({ reason: choice('summary_failed','cancel_failed','cancel_unconfirmed','dispatch_failed'), retryable: choice(true,false) }),
  discussion_progress: shape({}),
  round_started: shape({ round: integer(0), roundFocus: text(L.maxGoal, true) }),
  round_summary_started: shape({ round: integer(0) }),
  round_summary_completed: shape({ round: integer(0), revision: integer(0), sourceRequestId: id, documentId: id, title: text(L.maxTitle), content: nonblank(L.maxContribution) }),
  contribution_delta: shape({ round: integer(0), content: text(L.maxContribution) }),
  contribution_completed: shape({ round: integer(0), content: text(L.maxContribution) }),
  user_interjection: shape({ messageUid: id, memberId: id, content: nonblank(L.maxContribution), createdAt: text(128), consumedFromRound: integer(0) }),
  member_retry_scheduled: shape({ round: integer(0), memberId: id, attempt: choice(2), category: text(L.maxReason) }),
  member_skipped: v => shape({ round: integer(0), memberId: id, category: text(L.maxReason) })(v) || shape({ round: integer(0), memberId: id, reason: text(L.maxReason) })(v),
};

export function parseDiscussionV3(value: unknown): DiscussionV3Message | null {
  try {
    if (!object(value)) return null;
    const v = value;
    let valid = false;
    switch (v.msg_type) {
      case 'discussion_host_turn':
        valid = shape({ ...base, topic: text(L.maxTopic), goal: text(L.maxGoal, true), roles, allowedDecisions: array(choice('checkpoint'), 1), eventSummary: text(L.maxContribution, true), currentArtifact: artifact, mode: choice('roundtable'), phase: choice('round_summary'), roundSummaries: history, userInterjections: history }, { hostPrompt: nonblank(L.maxHostPrompt), configVersion: integer(1), priorContributions: prior })(v)
          && (v.allowedDecisions as unknown[]).length === 1 && Object.hasOwn(v, 'hostPrompt') === Object.hasOwn(v, 'configVersion');
        break;
      case 'discussion_assignment':
        valid = shape({ ...base, assignmentId: id, targetId: id, task: text(L.maxTask), topic: text(L.maxTopic), goal: text(L.maxGoal, true), mode: choice('roundtable'), model: nullable(model), role: shape({ roleName: text(L.maxTitle), roleInstructions: text(L.maxTask, true) }), speakingOrder: integer(0), roundFocus: text(L.maxGoal, true), priorContributions: history, roundSummaries: history, userInterjections: history, attempt: choice(1, 2) })(v);
        break;
      case 'discussion_cancel':
      case 'discussion_cancel_ack':
        valid = shape({ ...base, targetRequestId: id, targetMemberId: id, ...(v.msg_type === 'discussion_cancel' ? { reason: text(L.maxReason, true) } : { result: choice('cancelled', 'already_terminal', 'not_started', 'failed') }) })(v) && v.targetRequestId !== v.requestId;
        break;
      case 'discussion_contribution_delta':
      case 'discussion_contribution_completed':
        valid = shape({ ...base, assignmentId: id, content: nonblank(L.maxContribution), idempotencyKey: id, ...(v.msg_type === 'discussion_contribution_delta' ? { seq: integer(0) } : {}) })(v);
        break;
      case 'discussion_node_error':
        valid = shape({ ...base, category: choice('invalid_response', 'model_error', 'timeout'), message: text(L.maxReason), idempotencyKey: id }, { assignmentId: id })(v);
        break;
      case 'discussion_host_decision':
        valid = shape({ ...base, decision: choice('checkpoint'), ...checkpoint, idempotencyKey: id }, { planSummary: text(L.maxPlanSummary) })(v)
          && new Set((v.memberPositions as Array<{memberId: string}>).map(p => p.memberId)).size === (v.memberPositions as unknown[]).length;
        break;
      case 'discussion_event': {
        valid = shape({ ...base, seq: integer(1), eventType: text(64), actorId: nullable(id), targetId: nullable(id), data: object })(v);
        if (!valid || typeof v.eventType !== 'string' || !Object.hasOwn(eventData, v.eventType) || !eventData[v.eventType]!(v.data)) return null;
        const data = v.data as Record<string, unknown>;
        valid = (!Object.hasOwn(data, 'round') || data.round === v.round)
          && (v.eventType !== 'request_interrupted' || data.targetRequestId === v.requestId)
          && (v.eventType !== 'interjection_applied' || data.replacementRequestId === v.requestId)
          && (v.eventType !== 'round_summary_completed' || (data.revision === v.roundRevision && data.sourceRequestId === v.requestId));
        break;
      }
    }
    return valid ? value as unknown as DiscussionV3Message : null;
  } catch { return null; }
}

/** Correlates the command identity separately from its target task identity. */
export function matchesDiscussionV3CancelAck(command: DiscussionV3Cancel, raw: unknown): boolean {
  const ack = parseDiscussionV3(raw);
  return ack?.msg_type === 'discussion_cancel_ack' && ['discussionId', 'chatroomId', 'requestId', 'stateVersion', 'round', 'roundRevision', 'targetRequestId', 'targetMemberId'].every(k => (ack as unknown as Record<string, unknown>)[k] === (command as unknown as Record<string, unknown>)[k]);
}
