/**
 * Adapted from MIT-licensed Codex ClawMessenger discussion contracts at
 * quukk/codex-clawmessenger@3f3a2e4d6a8cb143a0088350aed2e1b4d1675473
 * (`src/core/discussion-v2.ts`, `src/core/model-catalog.ts`) and checked
 * against quukk/clawmessenger@a50f2393213f6f1c42da139491d2fe20937e7c7a
 * (`src/discussion/v2-protocol.ts`). See THIRD_PARTY_NOTICES.md.
 */

import { createHash } from 'node:crypto';

export const DISCUSSION_V2_LIMITS = {
  maxId: 128,
  maxTopic: 4_000,
  maxGoal: 8_000,
  maxTask: 16_000,
  maxContribution: 100_000,
  maxArtifact: 2_000_000,
  maxTitle: 500,
  maxReason: 2_000,
  maxPlanSummary: 1_000,
  maxPendingAcks: 128,
  maxCancelTombstones: 256,
  maxLogicalTombstones: 1_024,
  logicalTombstoneTtlMs: 10 * 60 * 1_000,
  ackTimeoutMs: 15_000,
  artifactFrameBytes: 9_000,
  artifactPacingMs: 200,
} as const;

export type ArtifactType = 'markdown' | 'html';
export type HostAction = 'assign' | 'synthesize' | 'finish' | 'fail' | 'checkpoint';

export interface RoleSnapshot {
  memberId: string;
  nodeId: string;
  nickname: string;
  portraitUri?: string;
  roleName: string;
  roleInstructions: string;
  capabilities: string[];
  isHost?: boolean;
  model?: string;
  speakingOrder?: number;
}

export interface CurrentArtifact {
  artifactId: string;
  artifactType: ArtifactType;
  title: string;
  version: number;
}

export interface DiscussionV2Envelope {
  protocolVersion: 2;
  discussionId: string;
  chatroomId: string;
  requestId: string;
  stateVersion: number;
  round: number;
  timestamp: number;
}

export interface DiscussionHostTurn extends DiscussionV2Envelope {
  msg_type: 'discussion_host_turn';
  topic: string;
  goal: string;
  roles: Record<string, RoleSnapshot>;
  allowedDecisions: HostAction[];
  remainingRounds: number;
  eventSummary: string;
  currentArtifact: CurrentArtifact | null;
  mode?: 'roundtable';
  phase?: 'round_summary' | 'final_synthesis';
  roundSummaries?: unknown[];
  userInterjections?: unknown[];
}

export interface DiscussionAssignment extends DiscussionV2Envelope {
  msg_type: 'discussion_assignment';
  assignmentId: string;
  targetId: string;
  task: string;
  topic: string;
  goal: string;
  mode?: 'roundtable';
  model?: string | null;
  role?: { roleName: string; roleInstructions: string };
  speakingOrder?: number;
  roundFocus?: string;
  priorContributions?: unknown[];
  roundSummaries?: unknown[];
  userInterjections?: unknown[];
  attempt?: number;
}

export interface DiscussionCancel extends DiscussionV2Envelope {
  msg_type: 'discussion_cancel';
  reason: string;
}

export interface DiscussionArtifactAck extends DiscussionV2Envelope {
  msg_type: 'discussion_artifact_ack';
  updateId: string;
  idempotencyKey: string;
  artifactId: string;
  artifactVersion: number;
}

export type DiscussionV2Command =
  | DiscussionHostTurn
  | DiscussionAssignment
  | DiscussionCancel
  | DiscussionArtifactAck;

export interface ArtifactSubmission {
  artifactType: ArtifactType;
  title: string;
  content: string;
  baseVersion: number;
  final: true;
}

type PublicPlan = { planSummary?: string };

export type HostDecision = (
  | { action: 'assign'; targetNodeId: string; task: string }
  | { action: 'synthesize'; artifactType: ArtifactType; instructions: string }
  | { action: 'finish'; summary: string; artifact: ArtifactSubmission }
  | { action: 'fail'; reason: string }
  | {
    action: 'checkpoint';
    memberPositions: Array<{ memberId: string; position: string }>;
    agreements: string[];
    disagreements: string[];
    openQuestions: string[];
    nextFocus: string;
    recommendation: 'continue' | 'finish';
  }
) & PublicPlan;

export interface ModelCatalog {
  defaultModel: string | null;
  providers: Array<{
    id: string;
    name: string;
    models: Array<{ id: string; name: string }>;
  }>;
}

export interface DiscussionModelCatalogRequest {
  msg_type: 'discussion_model_catalog_request';
  protocolVersion: 2;
  requestId: string;
  timestamp: number;
}

export interface DiscussionModelCatalogResponse extends ModelCatalog {
  msg_type: 'discussion_model_catalog_response';
  protocolVersion: 2;
  requestId: string;
  timestamp: number;
}

type WorkCommand = DiscussionHostTurn | DiscussionAssignment;
type NodeErrorCategory = 'invalid_response' | 'model_error' | 'timeout';

const commandBaseKeys = [
  'msg_type', 'protocolVersion', 'discussionId', 'chatroomId', 'requestId',
  'stateVersion', 'round', 'timestamp',
] as const;
const controlCharacters = /[\u0000-\u001f\u007f]/;

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function bounded(value: unknown, max: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= max && (allowEmpty || value.length > 0);
}

function boundedId(value: unknown): value is string {
  return bounded(value, DISCUSSION_V2_LIMITS.maxId)
    && value.trim() === value
    && !controlCharacters.test(value);
}

function integer(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

function validUtf8(value: string): boolean {
  return Buffer.from(value, 'utf8').toString('utf8') === value;
}

function jsonWithin(value: unknown, maxBytes: number): boolean {
  try {
    const serialized = JSON.stringify(value);
    return serialized !== undefined && Buffer.byteLength(serialized, 'utf8') <= maxBytes;
  } catch {
    return false;
  }
}

function modelRoute(value: unknown): value is string {
  if (!bounded(value, 256) || value.trim() !== value || /\s/.test(value)) return false;
  const parts = value.split('/');
  return parts.length === 2 && parts.every((part) => part.length > 0);
}

function baseValid(value: Record<string, unknown>, kind: DiscussionV2Command['msg_type']): boolean {
  return value.msg_type === kind
    && value.protocolVersion === 2
    && boundedId(value.discussionId)
    && boundedId(value.chatroomId)
    && boundedId(value.requestId)
    && integer(value.stateVersion, 1)
    && integer(value.round, 0)
    && integer(value.timestamp, 1);
}

function boundedArray(value: unknown, maxItems: number): value is unknown[] {
  return Array.isArray(value)
    && value.length <= maxItems
    && jsonWithin(value, DISCUSSION_V2_LIMITS.maxContribution);
}

function validCurrentArtifact(value: unknown): value is CurrentArtifact | null {
  return value === null || (record(value)
    && exactKeys(value, ['artifactId', 'artifactType', 'title', 'version'])
    && boundedId(value.artifactId)
    && (value.artifactType === 'markdown' || value.artifactType === 'html')
    && bounded(value.title, DISCUSSION_V2_LIMITS.maxTitle)
    && integer(value.version, 1));
}

function validRoleSnapshots(value: unknown): value is Record<string, RoleSnapshot> {
  if (!record(value) || Object.keys(value).length > 256) return false;
  return Object.entries(value).every(([targetId, role]) => {
    if (!boundedId(targetId)
      || !record(role)
      || !exactKeys(
        role,
        ['memberId', 'nodeId', 'nickname', 'roleName', 'roleInstructions', 'capabilities'],
        ['portraitUri', 'isHost', 'model', 'speakingOrder'],
      )
      || !boundedId(role.memberId)
      || role.memberId !== targetId
      || !boundedId(role.nodeId)
      || !bounded(role.nickname, DISCUSSION_V2_LIMITS.maxTitle, true)
      || !bounded(role.roleName, DISCUSSION_V2_LIMITS.maxTitle, true)
      || !bounded(role.roleInstructions, DISCUSSION_V2_LIMITS.maxTask, true)
      || !Array.isArray(role.capabilities)
      || role.capabilities.length > 64
      || !role.capabilities.every((capability) => boundedId(capability))) return false;
    return (role.portraitUri === undefined || bounded(role.portraitUri, DISCUSSION_V2_LIMITS.maxTask, true))
      && (role.isHost === undefined || typeof role.isHost === 'boolean')
      && (role.model === undefined || modelRoute(role.model))
      && (role.speakingOrder === undefined || integer(role.speakingOrder, 0));
  });
}

function parseHostTurn(value: Record<string, unknown>): DiscussionHostTurn | null {
  const roundtable = value.mode === 'roundtable';
  const allowed = value.allowedDecisions;
  if (!exactKeys(value, [
    ...commandBaseKeys,
    'topic', 'goal', 'roles', 'allowedDecisions', 'remainingRounds', 'eventSummary', 'currentArtifact',
    ...(roundtable ? ['mode', 'phase', 'roundSummaries', 'userInterjections'] : []),
  ])
    || !baseValid(value, 'discussion_host_turn')
    || !bounded(value.topic, DISCUSSION_V2_LIMITS.maxTopic)
    || !bounded(value.goal, DISCUSSION_V2_LIMITS.maxGoal, true)
    || !validRoleSnapshots(value.roles)
    || !Array.isArray(allowed)
    || allowed.length < 1
    || allowed.length > 4
    || !allowed.every((item) => typeof item === 'string'
      && ['assign', 'synthesize', 'finish', 'fail', 'checkpoint'].includes(item))
    || new Set(allowed).size !== allowed.length
    || !integer(value.remainingRounds, 0)
    || !bounded(value.eventSummary, DISCUSSION_V2_LIMITS.maxContribution, true)
    || !validCurrentArtifact(value.currentArtifact)) return null;

  if (roundtable && (
    !boundedArray(value.roundSummaries, 100)
    || !boundedArray(value.userInterjections, 100)
    || (value.phase === 'round_summary'
      ? !(allowed.length === 1 && allowed[0] === 'checkpoint')
      : value.phase === 'final_synthesis'
        ? !allowed.every((item) => item === 'finish' || item === 'fail')
        : true)
  )) return null;
  return value as unknown as DiscussionHostTurn;
}

function parseAssignment(value: Record<string, unknown>): DiscussionAssignment | null {
  const roundtable = value.mode === 'roundtable';
  if (!exactKeys(value, [
    ...commandBaseKeys,
    'assignmentId', 'targetId', 'task', 'topic', 'goal',
    ...(roundtable ? [
      'mode', 'model', 'role', 'speakingOrder', 'roundFocus',
      'priorContributions', 'roundSummaries', 'userInterjections', 'attempt',
    ] : []),
  ])
    || !baseValid(value, 'discussion_assignment')
    || !boundedId(value.assignmentId)
    || !boundedId(value.targetId)
    || !bounded(value.task, DISCUSSION_V2_LIMITS.maxTask)
    || !bounded(value.topic, DISCUSSION_V2_LIMITS.maxTopic)
    || !bounded(value.goal, DISCUSSION_V2_LIMITS.maxGoal, true)) return null;

  if (roundtable && (
    value.model !== null && value.model !== undefined && !modelRoute(value.model)
    || !record(value.role)
    || !exactKeys(value.role as Record<string, unknown>, ['roleName', 'roleInstructions'])
    || !bounded(value.role.roleName, DISCUSSION_V2_LIMITS.maxTitle)
    || !bounded(value.role.roleInstructions, DISCUSSION_V2_LIMITS.maxTask, true)
    || !integer(value.speakingOrder, 0)
    || !bounded(value.roundFocus, DISCUSSION_V2_LIMITS.maxGoal, true)
    || !boundedArray(value.priorContributions, 100)
    || !boundedArray(value.roundSummaries, 100)
    || !boundedArray(value.userInterjections, 100)
    || !integer(value.attempt, 1)
    || value.attempt > 2
  )) return null;
  return value as unknown as DiscussionAssignment;
}

function parseCancel(value: Record<string, unknown>): DiscussionCancel | null {
  if (!exactKeys(value, [...commandBaseKeys, 'reason'])
    || !baseValid(value, 'discussion_cancel')
    || !bounded(value.reason, DISCUSSION_V2_LIMITS.maxReason, true)) return null;
  return value as unknown as DiscussionCancel;
}

function parseArtifactAck(value: Record<string, unknown>): DiscussionArtifactAck | null {
  if (!exactKeys(value, [...commandBaseKeys, 'updateId', 'idempotencyKey', 'artifactId', 'artifactVersion'])
    || !baseValid(value, 'discussion_artifact_ack')
    || !boundedId(value.updateId)
    || value.idempotencyKey !== value.updateId
    || !boundedId(value.artifactId)
    || !integer(value.artifactVersion, 1)) return null;
  return value as unknown as DiscussionArtifactAck;
}

export function parseDiscussionV2Command(value: unknown): DiscussionV2Command | null {
  if (!record(value)) return null;
  if (value.msg_type === 'discussion_host_turn') return parseHostTurn(value);
  if (value.msg_type === 'discussion_assignment') return parseAssignment(value);
  if (value.msg_type === 'discussion_cancel') return parseCancel(value);
  if (value.msg_type === 'discussion_artifact_ack') return parseArtifactAck(value);
  return null;
}

function validArtifact(value: unknown): value is ArtifactSubmission {
  return record(value)
    && exactKeys(value, ['artifactType', 'title', 'content', 'baseVersion', 'final'])
    && (value.artifactType === 'markdown' || value.artifactType === 'html')
    && bounded(value.title, DISCUSSION_V2_LIMITS.maxTitle)
    && bounded(value.content, DISCUSSION_V2_LIMITS.maxArtifact)
    && Buffer.byteLength(value.content, 'utf8') <= DISCUSSION_V2_LIMITS.maxArtifact
    && validUtf8(value.content)
    && integer(value.baseVersion, 0)
    && value.final === true;
}

function validPublicPlan(value: Record<string, unknown>): boolean {
  return value.planSummary === undefined
    || bounded(value.planSummary, DISCUSSION_V2_LIMITS.maxPlanSummary);
}

export function parseHostDecision(text: string, turn: DiscussionHostTurn): HostDecision {
  let value: unknown;
  try {
    value = JSON.parse(text.trim());
  } catch {
    throw new Error('Host decision must be one JSON object');
  }
  if (!record(value)
    || !validPublicPlan(value)
    || typeof value.action !== 'string'
    || !turn.allowedDecisions.includes(value.action as HostAction)) {
    throw new Error('Invalid or disallowed host decision');
  }
  const optionalPlan = ['planSummary'];
  if (value.action === 'checkpoint') {
    if (turn.phase !== 'round_summary'
      || !exactKeys(value, [
        'action', 'memberPositions', 'agreements', 'disagreements',
        'openQuestions', 'nextFocus', 'recommendation',
      ], optionalPlan)
      || !Array.isArray(value.memberPositions)
      || value.memberPositions.length > 32
      || !value.memberPositions.every((position) => record(position)
        && exactKeys(position, ['memberId', 'position'])
        && boundedId(position.memberId)
        && bounded(position.position, DISCUSSION_V2_LIMITS.maxReason)
        && (!Object.keys(turn.roles).length || Object.prototype.hasOwnProperty.call(turn.roles, position.memberId)))
      || !['agreements', 'disagreements', 'openQuestions'].every((key) => {
        const items = value[key];
        return Array.isArray(items)
          && items.length <= 32
          && items.every((item) => bounded(item, DISCUSSION_V2_LIMITS.maxReason));
      })
      || !bounded(value.nextFocus, DISCUSSION_V2_LIMITS.maxReason, true)
      || (value.recommendation !== 'continue' && value.recommendation !== 'finish')) {
      throw new Error('Invalid checkpoint decision');
    }
  } else if (value.action === 'assign') {
    if (!exactKeys(value, ['action', 'targetNodeId', 'task'], optionalPlan)
      || !boundedId(value.targetNodeId)
      || !bounded(value.task, DISCUSSION_V2_LIMITS.maxTask)) {
      throw new Error('Invalid assignment decision');
    }
    const role = Object.prototype.hasOwnProperty.call(turn.roles, value.targetNodeId)
      ? turn.roles[value.targetNodeId]
      : undefined;
    if (!role?.capabilities.includes('discussion_participant')) {
      throw new Error('Assignment target is outside the participant role snapshot');
    }
  } else if (value.action === 'synthesize') {
    if (!exactKeys(value, ['action', 'artifactType', 'instructions'], optionalPlan)
      || (value.artifactType !== 'markdown' && value.artifactType !== 'html')
      || !bounded(value.instructions, DISCUSSION_V2_LIMITS.maxTask)) {
      throw new Error('Invalid synthesis decision');
    }
  } else if (value.action === 'finish') {
    if (!exactKeys(value, ['action', 'summary', 'artifact'], optionalPlan)
      || !bounded(value.summary, DISCUSSION_V2_LIMITS.maxContribution)
      || !validArtifact(value.artifact)
      || (turn.phase === 'final_synthesis' && value.artifact.artifactType !== 'markdown')) {
      throw new Error('Invalid finish decision');
    }
    const expectedBaseVersion = turn.currentArtifact?.artifactType === value.artifact.artifactType
      ? turn.currentArtifact.version
      : 0;
    if (value.artifact.baseVersion !== expectedBaseVersion) {
      throw new Error('Invalid artifact base version');
    }
  } else if (value.action === 'fail') {
    if (!exactKeys(value, ['action', 'reason'], optionalPlan)
      || !bounded(value.reason, DISCUSSION_V2_LIMITS.maxReason)) {
      throw new Error('Invalid failure decision');
    }
  } else {
    throw new Error('Unknown host decision');
  }
  return value as HostDecision;
}

function validNativeModel(value: unknown): value is string {
  return bounded(value, 256)
    && value.trim() === value
    && !value.includes('/')
    && !controlCharacters.test(value);
}

function validCatalog(value: unknown): value is ModelCatalog {
  if (!record(value)
    || !exactKeys(value, ['defaultModel', 'providers'])
    || (value.defaultModel !== null && !modelRoute(value.defaultModel))
    || !Array.isArray(value.providers)
    || value.providers.length > 64) return false;
  let modelCount = 0;
  for (const provider of value.providers) {
    if (!record(provider)
      || !exactKeys(provider, ['id', 'name', 'models'])
      || !boundedId(provider.id)
      || !bounded(provider.name, DISCUSSION_V2_LIMITS.maxTitle)
      || !Array.isArray(provider.models)
      || provider.models.length > 500) return false;
    modelCount += provider.models.length;
    if (modelCount > 500
      || !provider.models.every((model: unknown) => record(model)
        && exactKeys(model, ['id', 'name'])
        && validNativeModel(model.id)
        && bounded(model.name, DISCUSSION_V2_LIMITS.maxTitle))) return false;
  }
  if (value.defaultModel !== null) {
    const [providerId, modelId] = value.defaultModel.split('/');
    if (!value.providers.some((provider) => provider.id === providerId
      && provider.models.some((model: unknown) => record(model) && model.id === modelId))) return false;
  }
  return true;
}

export function parseDiscussionModelCatalogRequest(value: unknown): DiscussionModelCatalogRequest | null {
  if (!record(value)
    || !exactKeys(value, ['msg_type', 'protocolVersion', 'requestId', 'timestamp'])
    || value.msg_type !== 'discussion_model_catalog_request'
    || value.protocolVersion !== 2
    || !boundedId(value.requestId)
    || !integer(value.timestamp, 1)) return null;
  return value as unknown as DiscussionModelCatalogRequest;
}

export function parseDiscussionModelCatalogResponse(value: unknown): DiscussionModelCatalogResponse | null {
  if (!record(value)
    || !exactKeys(value, [
      'msg_type', 'protocolVersion', 'requestId', 'defaultModel', 'providers', 'timestamp',
    ])
    || value.msg_type !== 'discussion_model_catalog_response'
    || value.protocolVersion !== 2
    || !boundedId(value.requestId)
    || !integer(value.timestamp, 1)
    || !validCatalog({ defaultModel: value.defaultModel, providers: value.providers })) return null;
  return value as unknown as DiscussionModelCatalogResponse;
}

export function buildModelCatalogResponse(
  rawRequest: unknown,
  catalog: ModelCatalog,
  timestamp: number,
): DiscussionModelCatalogResponse {
  const request = parseDiscussionModelCatalogRequest(rawRequest);
  if (!request || !validCatalog(catalog) || !integer(timestamp, 1)) {
    throw new Error('Invalid model catalog response input');
  }
  return {
    msg_type: 'discussion_model_catalog_response',
    protocolVersion: 2,
    requestId: request.requestId,
    defaultModel: catalog.defaultModel,
    providers: catalog.providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      models: provider.models.map((model) => ({ id: model.id, name: model.name })),
    })),
    timestamp,
  };
}

interface OutputEnvelope extends DiscussionV2Envelope {
  msg_type: string;
  idempotencyKey: string;
}

function outputEnvelope(
  command: WorkCommand,
  senderId: string,
  msgType: string,
  timestamp: number,
  suffix = '',
): OutputEnvelope {
  if (!boundedId(senderId) || !integer(timestamp, 1)) throw new Error('Invalid output envelope input');
  const idempotencyKey = createHash('sha256').update(JSON.stringify({
    kind: msgType,
    senderId,
    discussionId: command.discussionId,
    requestId: command.requestId,
    stateVersion: command.stateVersion,
    round: command.round,
    suffix,
  })).digest('hex');
  return {
    msg_type: msgType,
    protocolVersion: 2,
    discussionId: command.discussionId,
    chatroomId: command.chatroomId,
    requestId: command.requestId,
    stateVersion: command.stateVersion,
    round: command.round,
    timestamp,
    idempotencyKey,
  };
}

function publicContribution(content: unknown): string {
  if (!bounded(content, DISCUSSION_V2_LIMITS.maxContribution)
    || !content.trim()
    || !validUtf8(content)) throw new Error('Invalid public contribution');
  return content;
}

export function buildContributionDelta(
  assignment: DiscussionAssignment,
  senderId: string,
  content: string,
  seq: number,
  timestamp: number,
): OutputEnvelope & { assignmentId: string; content: string; seq: number } {
  if (!integer(seq, 0)) throw new Error('Invalid contribution sequence');
  return {
    ...outputEnvelope(assignment, senderId, 'discussion_contribution_delta', timestamp, String(seq)),
    assignmentId: assignment.assignmentId,
    content: publicContribution(content),
    seq,
  };
}

export function buildContributionCompleted(
  assignment: DiscussionAssignment,
  senderId: string,
  content: string,
  timestamp: number,
): OutputEnvelope & { assignmentId: string; content: string } {
  return {
    ...outputEnvelope(assignment, senderId, 'discussion_contribution_completed', timestamp),
    assignmentId: assignment.assignmentId,
    content: publicContribution(content),
  };
}

export interface ArtifactReference {
  artifactId: string;
  artifactVersion: number;
}

export function buildHostDecisionOutput(
  turn: DiscussionHostTurn,
  senderId: string,
  rawDecision: HostDecision,
  timestamp: number,
  reference?: ArtifactReference,
): Record<string, unknown> & OutputEnvelope {
  const decision = parseHostDecision(JSON.stringify(rawDecision), turn);
  const output: Record<string, unknown> & OutputEnvelope = {
    ...outputEnvelope(turn, senderId, 'discussion_host_decision', timestamp),
    decision: decision.action,
  };
  if (decision.action === 'finish') {
    if (!reference
      || !boundedId(reference.artifactId)
      || !integer(reference.artifactVersion, 1)) throw new Error('Finish requires an artifact reference');
    output.artifactId = reference.artifactId;
    output.artifactVersion = reference.artifactVersion;
    return output;
  }
  if (reference !== undefined) throw new Error('Artifact reference is only valid for finish');
  if (decision.planSummary !== undefined) output.planSummary = decision.planSummary;
  if (decision.action === 'assign') {
    output.targetId = decision.targetNodeId;
    output.task = decision.task;
  } else if (decision.action === 'synthesize') {
    output.artifactType = decision.artifactType;
    output.instructions = decision.instructions;
  } else if (decision.action === 'fail') {
    output.reason = decision.reason;
  } else {
    output.memberPositions = decision.memberPositions;
    output.agreements = decision.agreements;
    output.disagreements = decision.disagreements;
    output.openQuestions = decision.openQuestions;
    output.nextFocus = decision.nextFocus;
    output.recommendation = decision.recommendation;
  }
  return output;
}

export interface ArtifactUpdateInput {
  artifactType: ArtifactType;
  title: string;
  operation: 'replace' | 'append';
  content: string;
  baseVersion: number;
  isFinal: boolean;
}

function validArtifactUpdate(value: unknown): value is ArtifactUpdateInput {
  return record(value)
    && exactKeys(value, ['artifactType', 'title', 'operation', 'content', 'baseVersion', 'isFinal'])
    && (value.artifactType === 'markdown' || value.artifactType === 'html')
    && bounded(value.title, DISCUSSION_V2_LIMITS.maxTitle)
    && (value.operation === 'replace' || value.operation === 'append')
    && bounded(value.content, DISCUSSION_V2_LIMITS.maxArtifact)
    && validUtf8(value.content)
    && integer(value.baseVersion, 0)
    && typeof value.isFinal === 'boolean';
}

export function buildArtifactUpdate(
  turn: DiscussionHostTurn,
  senderId: string,
  input: ArtifactUpdateInput,
  timestamp: number,
  suffix = '',
): Record<string, unknown> & OutputEnvelope {
  if (!validArtifactUpdate(input)) throw new Error('Invalid artifact update');
  const output: Record<string, unknown> & OutputEnvelope = {
    ...outputEnvelope(turn, senderId, 'discussion_artifact_update', timestamp, suffix),
    artifactType: input.artifactType,
    title: input.title,
    operation: input.operation,
    content: input.content,
    baseVersion: input.baseVersion,
    isFinal: input.isFinal,
  };
  if (Buffer.byteLength(JSON.stringify(output), 'utf8') > DISCUSSION_V2_LIMITS.artifactFrameBytes) {
    throw new Error('Artifact update exceeds the 9000-byte frame limit');
  }
  return output;
}

const publicErrors: Record<NodeErrorCategory, string> = {
  invalid_response: 'Model returned an invalid public response',
  model_error: 'Model execution failed',
  timeout: 'Artifact acknowledgement timed out',
};

export function buildNodeError(
  command: WorkCommand,
  senderId: string,
  category: NodeErrorCategory,
  timestamp: number,
): Record<string, unknown> & OutputEnvelope {
  if (!Object.prototype.hasOwnProperty.call(publicErrors, category)) throw new Error('Invalid node error category');
  return {
    ...outputEnvelope(command, senderId, 'discussion_node_error', timestamp, category),
    ...(command.msg_type === 'discussion_assignment' ? { assignmentId: command.assignmentId } : {}),
    category,
    message: publicErrors[category],
  };
}

export function discussionV2LogicalKey(senderId: string, command: WorkCommand): string {
  return JSON.stringify([
    senderId,
    command.discussionId,
    command.requestId,
    command.stateVersion,
    command.msg_type,
    command.round,
  ]);
}

interface LogicalEntry {
  active: boolean;
  expiresAt: number;
}

interface ActiveEntry {
  key: string;
  senderId: string;
  discussionId: string;
  stateVersion: number;
  round: number;
}

interface Cancellation {
  senderId: string;
  discussionId: string;
  stateVersion: number;
  round: number;
}

export interface ArtifactAckExpectation {
  senderId: string;
  discussionId: string;
  requestId: string;
  stateVersion: number;
  round: number;
  updateId: string;
  artifactId?: string;
  artifactVersion: number;
}

interface PendingAck extends ArtifactAckExpectation {
  expiresAt: number;
}

export type ClaimResult =
  | { status: 'accepted'; key: string }
  | { status: 'wrong_target' | 'replay' | 'cancelled' | 'capacity' | 'disposed' | 'invalid' };

export type CancelResult =
  | { status: 'accepted'; abortedKeys: string[]; clearDiscussionId: string }
  | { status: 'replay' | 'capacity' | 'disposed' | 'invalid' };

export type RegisterAckResult = { status: 'accepted' | 'duplicate' | 'capacity' | 'disposed' | 'invalid' };
export type AcceptAckResult = { status: 'accepted' | 'unknown' | 'expired' | 'disposed' | 'invalid' };

function cancels(cancellation: Cancellation, stateVersion: number, round: number): boolean {
  return cancellation.stateVersion > stateVersion
    || (cancellation.stateVersion === stateVersion && cancellation.round === round);
}

function cancelKey(cancellation: Cancellation): string {
  return JSON.stringify([
    cancellation.senderId,
    cancellation.discussionId,
    cancellation.stateVersion,
    cancellation.round,
  ]);
}

function ackKey(value: Pick<ArtifactAckExpectation,
  'senderId' | 'discussionId' | 'requestId' | 'stateVersion' | 'round' | 'updateId'>): string {
  return JSON.stringify([
    value.senderId,
    value.discussionId,
    value.requestId,
    value.stateVersion,
    value.round,
    value.updateId,
  ]);
}

function validAckExpectation(value: ArtifactAckExpectation): boolean {
  return boundedId(value.senderId)
    && boundedId(value.discussionId)
    && boundedId(value.requestId)
    && integer(value.stateVersion, 1)
    && integer(value.round, 0)
    && boundedId(value.updateId)
    && (value.artifactId === undefined || boundedId(value.artifactId))
    && integer(value.artifactVersion, 1);
}

export class DiscussionV2Guard {
  private readonly clock: () => number;
  private readonly logical = new Map<string, LogicalEntry>();
  private readonly active = new Map<string, ActiveEntry>();
  private readonly cancellations = new Map<string, Cancellation>();
  private readonly pendingAcks = new Map<string, PendingAck>();
  private final = false;

  constructor(options: { clock?: () => number } = {}) {
    this.clock = options.clock ?? Date.now;
  }

  get disposed(): boolean {
    return this.final;
  }

  get pendingAckCount(): number {
    this.pruneAcks(this.clock());
    return this.pendingAcks.size;
  }

  claim(senderId: string, command: WorkCommand, nodeId: string): ClaimResult {
    if (this.final) return { status: 'disposed' };
    if (!boundedId(senderId) || !boundedId(nodeId)
      || (command.msg_type !== 'discussion_host_turn' && command.msg_type !== 'discussion_assignment')) {
      return { status: 'invalid' };
    }
    if (command.msg_type === 'discussion_assignment' && command.targetId !== nodeId) {
      return { status: 'wrong_target' };
    }
    if (this.isCancelled(senderId, command)) return { status: 'cancelled' };
    const now = this.clock();
    this.pruneLogical(now);
    const key = discussionV2LogicalKey(senderId, command);
    if (this.logical.has(key)) return { status: 'replay' };
    if (this.logical.size >= DISCUSSION_V2_LIMITS.maxLogicalTombstones) return { status: 'capacity' };
    this.logical.set(key, { active: true, expiresAt: Number.POSITIVE_INFINITY });
    this.active.set(key, {
      key,
      senderId,
      discussionId: command.discussionId,
      stateVersion: command.stateVersion,
      round: command.round,
    });
    return { status: 'accepted', key };
  }

  complete(key: string): boolean {
    if (this.final || !this.active.delete(key)) return false;
    const entry = this.logical.get(key);
    if (!entry) return false;
    entry.active = false;
    entry.expiresAt = this.clock() + DISCUSSION_V2_LIMITS.logicalTombstoneTtlMs;
    return true;
  }

  isCurrent(key: string): boolean {
    return !this.final && this.active.has(key);
  }

  cancel(senderId: string, value: unknown): CancelResult {
    if (this.final) return { status: 'disposed' };
    const parsed = parseDiscussionV2Command(value);
    if (!boundedId(senderId) || parsed?.msg_type !== 'discussion_cancel') return { status: 'invalid' };
    const cancellation: Cancellation = {
      senderId,
      discussionId: parsed.discussionId,
      stateVersion: parsed.stateVersion,
      round: parsed.round,
    };
    const key = cancelKey(cancellation);
    if (this.cancellations.has(key)) return { status: 'replay' };
    if (this.cancellations.size >= DISCUSSION_V2_LIMITS.maxCancelTombstones) {
      return { status: 'capacity' };
    }
    this.cancellations.set(key, cancellation);
    const now = this.clock();
    const abortedKeys: string[] = [];
    for (const [activeKey, active] of this.active) {
      if (active.senderId === senderId
        && active.discussionId === parsed.discussionId
        && cancels(cancellation, active.stateVersion, active.round)) {
        this.active.delete(activeKey);
        const logical = this.logical.get(activeKey);
        if (logical) {
          logical.active = false;
          logical.expiresAt = now + DISCUSSION_V2_LIMITS.logicalTombstoneTtlMs;
        }
        abortedKeys.push(activeKey);
      }
    }
    for (const [pendingKey, pending] of this.pendingAcks) {
      if (pending.senderId === senderId
        && pending.discussionId === parsed.discussionId
        && cancels(cancellation, pending.stateVersion, pending.round)) this.pendingAcks.delete(pendingKey);
    }
    return { status: 'accepted', abortedKeys, clearDiscussionId: parsed.discussionId };
  }

  registerArtifactAck(value: ArtifactAckExpectation): RegisterAckResult {
    if (this.final) return { status: 'disposed' };
    if (!validAckExpectation(value)) return { status: 'invalid' };
    const now = this.clock();
    this.pruneAcks(now);
    const key = ackKey(value);
    if (this.pendingAcks.has(key)) return { status: 'duplicate' };
    if (this.pendingAcks.size >= DISCUSSION_V2_LIMITS.maxPendingAcks) return { status: 'capacity' };
    this.pendingAcks.set(key, { ...value, expiresAt: now + DISCUSSION_V2_LIMITS.ackTimeoutMs });
    return { status: 'accepted' };
  }

  acceptArtifactAck(senderId: string, value: unknown): AcceptAckResult {
    if (this.final) return { status: 'disposed' };
    const parsed = parseDiscussionV2Command(value);
    if (!boundedId(senderId) || parsed?.msg_type !== 'discussion_artifact_ack') return { status: 'invalid' };
    const key = ackKey({
      senderId,
      discussionId: parsed.discussionId,
      requestId: parsed.requestId,
      stateVersion: parsed.stateVersion,
      round: parsed.round,
      updateId: parsed.updateId,
    });
    const pending = this.pendingAcks.get(key);
    if (!pending) return { status: 'unknown' };
    if (pending.expiresAt <= this.clock()) {
      this.pendingAcks.delete(key);
      return { status: 'expired' };
    }
    if (pending.artifactVersion !== parsed.artifactVersion
      || (pending.artifactId !== undefined && pending.artifactId !== parsed.artifactId)) {
      return { status: 'unknown' };
    }
    this.pendingAcks.delete(key);
    return { status: 'accepted' };
  }

  dispose(): void {
    if (this.final) return;
    this.final = true;
    this.active.clear();
    this.logical.clear();
    this.cancellations.clear();
    this.pendingAcks.clear();
  }

  private isCancelled(senderId: string, command: WorkCommand): boolean {
    for (const cancellation of this.cancellations.values()) {
      if (cancellation.senderId === senderId
        && cancellation.discussionId === command.discussionId
        && cancels(cancellation, command.stateVersion, command.round)) return true;
    }
    return false;
  }

  private pruneLogical(now: number): void {
    for (const [key, entry] of this.logical) {
      if (!entry.active && entry.expiresAt <= now) this.logical.delete(key);
    }
  }

  private pruneAcks(now: number): void {
    for (const [key, entry] of this.pendingAcks) {
      if (entry.expiresAt <= now) this.pendingAcks.delete(key);
    }
  }
}
