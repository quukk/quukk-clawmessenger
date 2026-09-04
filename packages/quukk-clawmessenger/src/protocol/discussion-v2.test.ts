// @vitest-environment node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  DISCUSSION_V2_LIMITS,
  DiscussionV2Guard,
  buildArtifactUpdate,
  buildContributionCompleted,
  buildContributionDelta,
  buildHostDecisionOutput,
  buildModelCatalogResponse,
  buildNodeError,
  discussionV2LogicalKey,
  parseDiscussionModelCatalogRequest,
  parseDiscussionModelCatalogResponse,
  parseRoleRecommendationRequest,
  parseRoleRecommendationResponse,
  parseDiscussionV2Command,
  parseHostDecision,
  type DiscussionArtifactAck,
  type DiscussionAssignment,
  type DiscussionHostTurn,
} from './discussion-v2.js';

interface V2Fixture {
  hostTurn: DiscussionHostTurn;
  roundtableHostTurn: DiscussionHostTurn;
  assignment: DiscussionAssignment;
  cancel: Record<string, unknown>;
  artifactAck: DiscussionArtifactAck;
  modelCatalogRequest: Record<string, unknown>;
  modelCatalogResponse: Record<string, unknown>;
}

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/discussion-v2.shared.json', import.meta.url), 'utf8'),
) as V2Fixture;

const clone = <T>(value: T): T => structuredClone(value);

const roleRecommendationRequest = {
  msg_type: 'discussion_role_recommendation_request',
  request_id: 'request-demo-001',
  topic: 'Fixture migration decision',
  goal: 'Choose a safe rollout plan',
  max_roles: 2,
  candidates: [
    {
      node_id: 'node-role-a',
      display_name: 'Role A',
      runtime_type: 'codex',
      capabilities: ['discussion_model_routing', 'discussion_participant', 'discussion_roundtable'],
      default_model: 'openai/gpt-5',
      models: ['openai/gpt-5'],
      status: 'online',
    },
    {
      node_id: 'node-role-b',
      display_name: 'Role B',
      runtime_type: 'opencode',
      capabilities: ['discussion_model_routing', 'discussion_participant', 'discussion_roundtable'],
      default_model: null,
      models: [],
      status: 'online',
    },
  ],
  recommendation_prompt: 'private instruction',
  config_version: 1,
};

describe('discussion v2 strict inputs', () => {
  it('parses all four exact command fixtures', () => {
    expect(parseDiscussionV2Command(fixture.hostTurn)).toEqual(fixture.hostTurn);
    expect(parseDiscussionV2Command(fixture.roundtableHostTurn)).toEqual(fixture.roundtableHostTurn);
    expect(parseDiscussionV2Command(fixture.assignment)).toEqual(fixture.assignment);
    expect(parseDiscussionV2Command(fixture.cancel)).toEqual(fixture.cancel);
    expect(parseDiscussionV2Command(fixture.artifactAck)).toEqual(fixture.artifactAck);
  });

  it('rejects unknown commands, snake aliases, extra keys, coercion and unsafe integers', () => {
    expect(parseDiscussionV2Command({ ...fixture.assignment, msg_type: 'discussion_event' })).toBeNull();
    expect(parseDiscussionV2Command({ ...fixture.assignment, request_id: fixture.assignment.requestId })).toBeNull();
    expect(parseDiscussionV2Command({ ...fixture.assignment, extra: true })).toBeNull();
    expect(parseDiscussionV2Command({ ...fixture.assignment, protocolVersion: '2' })).toBeNull();
    expect(parseDiscussionV2Command({ ...fixture.assignment, stateVersion: Number.MAX_SAFE_INTEGER + 1 })).toBeNull();
    expect(parseDiscussionV2Command({ ...fixture.assignment, requestId: 'request\u200bhidden' })).toBeNull();
  });

  it('enforces identifiers, text limits and exact roundtable option sets', () => {
    expect(parseDiscussionV2Command({ ...fixture.assignment, targetId: 'x'.repeat(129) })).toBeNull();
    expect(parseDiscussionV2Command({ ...fixture.assignment, task: 'x'.repeat(16_001) })).toBeNull();
    expect(parseDiscussionV2Command({ ...fixture.hostTurn, topic: 'x'.repeat(4_001) })).toBeNull();
    expect(parseDiscussionV2Command({ ...fixture.hostTurn, goal: 'x'.repeat(8_001) })).toBeNull();
    expect(parseDiscussionV2Command({ ...fixture.cancel, reason: 'x'.repeat(2_001) })).toBeNull();

    const incompleteRoundtable = clone(fixture.assignment) as unknown as Record<string, unknown>;
    delete incompleteRoundtable.roundFocus;
    expect(parseDiscussionV2Command(incompleteRoundtable)).toBeNull();
    expect(parseDiscussionV2Command({ ...fixture.assignment, model: 'openai /model-a' })).toBeNull();
    expect(parseDiscussionV2Command({ ...fixture.assignment, attempt: 3 })).toBeNull();
  });

  it('requires exact roles, phase decisions and acknowledgement identity', () => {
    const roles = clone(fixture.hostTurn.roles);
    roles['member-1']!.memberId = 'somebody-else';
    expect(parseDiscussionV2Command({ ...fixture.hostTurn, roles })).toBeNull();
    expect(parseDiscussionV2Command({
      ...fixture.roundtableHostTurn,
      allowedDecisions: ['finish'],
    })).toBeNull();
    expect(parseDiscussionV2Command({
      ...fixture.artifactAck,
      idempotencyKey: 'different-update',
    })).toBeNull();
  });
});

describe('discussion role recommendation protocol', () => {
  it('parses exact candidate assignments and normalizes wire field names', () => {
    expect(parseRoleRecommendationRequest(roleRecommendationRequest)).toMatchObject({
      msgType: 'discussion_role_recommendation_request',
      requestId: 'request-demo-001',
      topic: 'Fixture migration decision',
      candidates: [
        { nodeId: 'node-role-a', runtimeType: 'codex', status: 'online' },
        { nodeId: 'node-role-b', runtimeType: 'opencode', status: 'online' },
      ],
    });
  });

  it('accepts offline candidates so the host can assign them for wake-up', () => {
    const offlineRequest = clone(roleRecommendationRequest);
    offlineRequest.candidates[1]!.status = 'offline';

    expect(parseRoleRecommendationRequest(offlineRequest)?.candidates[1]).toMatchObject({
      nodeId: 'node-role-b',
      status: 'offline',
      defaultModel: null,
      models: [],
    });
  });

  it('rejects extra keys, duplicate candidates, unknown statuses and invalid bounds', () => {
    expect(parseRoleRecommendationRequest({ ...roleRecommendationRequest, extra: true })).toBeNull();
    expect(parseRoleRecommendationRequest({
      ...roleRecommendationRequest,
      candidates: [roleRecommendationRequest.candidates[0], roleRecommendationRequest.candidates[0]],
    })).toBeNull();
    expect(parseRoleRecommendationRequest({
      ...roleRecommendationRequest,
      candidates: [{ ...roleRecommendationRequest.candidates[0], status: 'sleeping' }],
    })).toBeNull();
    expect(parseRoleRecommendationRequest({
      ...roleRecommendationRequest,
      candidates: Array.from({ length: 9 }, (_, index) => ({
        ...roleRecommendationRequest.candidates[0], node_id: `node-${index}`,
      })),
    })).toBeNull();
    expect(parseRoleRecommendationRequest({
      ...roleRecommendationRequest,
      candidates: [{ ...roleRecommendationRequest.candidates[0], models: ['invalid model'] }],
    })).toBeNull();
    expect(parseRoleRecommendationRequest({ ...roleRecommendationRequest, topic: 'x'.repeat(4_001) })).toBeNull();
  });

  it('validates strict response assignments against the request candidates', () => {
    const request = parseRoleRecommendationRequest(roleRecommendationRequest)!;
    expect(parseRoleRecommendationResponse({
      roles: [
        {
          role_name: '架构师', role_prompt: '评估边界', node_id: 'node-role-a',
          model: 'openai/gpt-5', speaking_order: 0,
        },
        {
          role_name: '交付负责人', role_prompt: '评估发布', node_id: 'node-role-b',
          model: null, speaking_order: 1,
        },
      ],
    }, request)).toHaveLength(2);
    expect(parseRoleRecommendationResponse({
      roles: [{
        role_name: '未知', role_prompt: '无效', node_id: 'unknown', model: null, speaking_order: 0,
      }],
    }, request)).toBeNull();
  });
});

describe('discussion v2 host decisions', () => {
  it('accepts each allowed exact branch and optional public plan summary', () => {
    expect(parseHostDecision(JSON.stringify({
      action: 'assign',
      targetNodeId: 'member-1',
      task: 'Review rollback risk',
      planSummary: 'Ask the safety reviewer first.',
    }), fixture.hostTurn)).toMatchObject({ action: 'assign', targetNodeId: 'member-1' });
    expect(parseHostDecision(JSON.stringify({
      action: 'synthesize', artifactType: 'html', instructions: 'Create a comparison table',
    }), fixture.hostTurn)).toMatchObject({ action: 'synthesize', artifactType: 'html' });
    expect(parseHostDecision(JSON.stringify({ action: 'fail', reason: 'No safe option remains' }), fixture.hostTurn))
      .toEqual({ action: 'fail', reason: 'No safe option remains' });
    expect(parseHostDecision(JSON.stringify({
      action: 'checkpoint',
      memberPositions: [{ memberId: 'member-1', position: 'Keep a rollback window' }],
      agreements: ['Stage the migration'],
      disagreements: [],
      openQuestions: ['How long is the rollback window?'],
      nextFocus: 'Set rollback criteria',
      recommendation: 'continue',
    }), fixture.roundtableHostTurn)).toMatchObject({ action: 'checkpoint', recommendation: 'continue' });
  });

  it('enforces branch keys, allowed decisions and participant capabilities', () => {
    expect(() => parseHostDecision(JSON.stringify({
      action: 'assign', targetNodeId: 'member-1', task: 'Review', reason: 'foreign branch field',
    }), fixture.hostTurn)).toThrow(/assignment/);
    expect(() => parseHostDecision(JSON.stringify({ action: 'checkpoint' }), fixture.hostTurn))
      .toThrow(/disallowed/);
    expect(() => parseHostDecision(JSON.stringify({
      action: 'assign', targetNodeId: 'host-1', task: 'Review',
    }), fixture.hostTurn)).toThrow(/participant/);
    expect(() => parseHostDecision('{not json}', fixture.hostTurn)).toThrow(/JSON/);
  });

  it('enforces artifact type, base version, character and UTF-8 byte ceilings', () => {
    const finish = (content: string, baseVersion = 3, artifactType: 'markdown' | 'html' = 'markdown') => JSON.stringify({
      action: 'finish',
      summary: 'Migration plan ready',
      artifact: { artifactType, title: 'Plan', content, baseVersion, final: true },
    });
    expect(parseHostDecision(finish('Safe plan'), fixture.hostTurn)).toMatchObject({ action: 'finish' });
    expect(() => parseHostDecision(finish('Safe plan', 2), fixture.hostTurn)).toThrow(/base version/);
    expect(() => parseHostDecision(finish('界'.repeat(700_000)), fixture.hostTurn)).toThrow(/finish/);
    expect(() => parseHostDecision(finish('x'.repeat(2_000_001)), fixture.hostTurn)).toThrow(/finish/);

    const finalTurn: DiscussionHostTurn = {
      ...fixture.roundtableHostTurn,
      phase: 'final_synthesis',
      allowedDecisions: ['finish'],
    };
    expect(() => parseHostDecision(finish('Safe plan', 0, 'html'), finalTurn))
      .toThrow(/finish/);
  });
});

describe('discussion v2 output builders', () => {
  it('builds deterministic provider-neutral contribution messages', () => {
    const delta = buildContributionDelta(fixture.assignment, 'owner-1', 'First public point', 0, 1000);
    const completed = buildContributionCompleted(fixture.assignment, 'owner-1', 'First public point', 1001);
    expect(delta).toMatchObject({
      msg_type: 'discussion_contribution_delta', protocolVersion: 2,
      assignmentId: 'assignment-1', content: 'First public point', seq: 0, timestamp: 1000,
    });
    expect(completed).toMatchObject({
      msg_type: 'discussion_contribution_completed', assignmentId: 'assignment-1',
      content: 'First public point', timestamp: 1001,
    });
    expect(delta.idempotencyKey).toBe(createHash('sha256').update(JSON.stringify({
      kind: 'discussion_contribution_delta', senderId: 'owner-1', discussionId: 'discussion-42',
      requestId: 'assignment-request-1', stateVersion: 7, round: 2, suffix: '0',
    })).digest('hex'));
  });

  it('emits reference-only finish after artifact publication', () => {
    const finish = parseHostDecision(JSON.stringify({
      action: 'finish', summary: 'Private builder input is not repeated',
      artifact: { artifactType: 'markdown', title: 'Plan', content: 'Full artifact', baseVersion: 3, final: true },
    }), fixture.hostTurn);
    const output = buildHostDecisionOutput(
      fixture.hostTurn, 'owner-1', finish, 1002, { artifactId: 'artifact-7', artifactVersion: 4 },
    );
    expect(output).toMatchObject({
      msg_type: 'discussion_host_decision', decision: 'finish',
      artifactId: 'artifact-7', artifactVersion: 4,
    });
    expect(output).not.toHaveProperty('summary');
    expect(output).not.toHaveProperty('artifact');
    expect(JSON.stringify(output)).not.toContain('Full artifact');
  });

  it('builds strict non-finish decisions and bounded artifact updates', () => {
    const assign = parseHostDecision(JSON.stringify({
      action: 'assign', targetNodeId: 'member-1', task: 'Review rollback', planSummary: 'Delegate review',
    }), fixture.hostTurn);
    expect(buildHostDecisionOutput(fixture.hostTurn, 'owner-1', assign, 1003)).toMatchObject({
      decision: 'assign', targetId: 'member-1', task: 'Review rollback', planSummary: 'Delegate review',
    });

    const update = buildArtifactUpdate(fixture.hostTurn, 'owner-1', {
      artifactType: 'markdown', title: 'Plan', operation: 'append', content: 'Next section',
      baseVersion: 3, isFinal: true,
    }, 1004, '1');
    expect(update).toMatchObject({
      msg_type: 'discussion_artifact_update', operation: 'append', content: 'Next section',
      baseVersion: 3, isFinal: true,
    });
    expect(Buffer.byteLength(JSON.stringify(update), 'utf8')).toBeLessThanOrEqual(9_000);
    expect(() => buildArtifactUpdate(fixture.hostTurn, 'owner-1', {
      artifactType: 'markdown', title: 'Plan', operation: 'replace', content: '界'.repeat(3_000),
      baseVersion: 3, isFinal: false,
    }, 1004)).toThrow(/9000/);
  });

  it('emits only fixed privacy-safe node errors', () => {
    const error = buildNodeError(fixture.assignment, 'owner-1', 'model_error', 1005);
    expect(error).toMatchObject({
      msg_type: 'discussion_node_error', assignmentId: 'assignment-1', category: 'model_error',
      message: 'Model execution failed',
    });
    expect(JSON.stringify(error)).not.toMatch(/stack|prompt|token|path|sdk/i);
  });
});

describe('discussion v2 replay and cancellation guard', () => {
  it('uses the full sender-scoped logical tuple and checks wrong target first', () => {
    const guard = new DiscussionV2Guard({ clock: () => 1_000 });
    expect(discussionV2LogicalKey('owner-1', fixture.assignment)).toBe(JSON.stringify([
      'owner-1', 'discussion-42', 'assignment-request-1', 7, 'discussion_assignment', 2,
    ]));
    expect(guard.claim('owner-1', fixture.assignment, 'some-other-node')).toEqual({ status: 'wrong_target' });
    expect(guard.claim('owner-1', fixture.assignment, 'node-member')).toMatchObject({ status: 'accepted' });
    expect(guard.claim('owner-1', fixture.assignment, 'node-member')).toEqual({ status: 'replay' });
  });

  it('retains completed replay tombstones for ten minutes and then prunes them', () => {
    let now = 1_000;
    const guard = new DiscussionV2Guard({ clock: () => now });
    const claim = guard.claim('owner-1', fixture.hostTurn, 'node-host');
    expect(claim.status).toBe('accepted');
    if (claim.status !== 'accepted') throw new Error('expected accepted claim');
    expect(guard.complete(claim.key)).toBe(true);
    now += DISCUSSION_V2_LIMITS.logicalTombstoneTtlMs - 1;
    expect(guard.claim('owner-1', fixture.hostTurn, 'node-host')).toEqual({ status: 'replay' });
    now += 1;
    expect(guard.claim('owner-1', fixture.hostTurn, 'node-host')).toMatchObject({ status: 'accepted' });
  });

  it('fails closed at 1024 live logical entries', () => {
    const guard = new DiscussionV2Guard({ clock: () => 1_000 });
    for (let index = 0; index < DISCUSSION_V2_LIMITS.maxLogicalTombstones; index += 1) {
      const command = { ...fixture.hostTurn, requestId: `request-${index}` };
      expect(guard.claim('owner-1', command, 'node-host').status).toBe('accepted');
    }
    expect(guard.claim('owner-1', { ...fixture.hostTurn, requestId: 'overflow' }, 'node-host'))
      .toEqual({ status: 'capacity' });
  });

  it('scopes cancellation by sender, discussion, version and round and reports wire cleanup', () => {
    const guard = new DiscussionV2Guard({ clock: () => 1_000 });
    const active = guard.claim('owner-1', fixture.assignment, 'node-member');
    expect(active.status).toBe('accepted');

    expect(guard.cancel('someone-else', fixture.cancel)).toMatchObject({ status: 'accepted', abortedKeys: [] });
    expect(active.status === 'accepted' && guard.isCurrent(active.key)).toBe(true);

    expect(guard.cancel('owner-1', { ...fixture.cancel, stateVersion: 7, round: 3 })).toMatchObject({
      status: 'accepted', abortedKeys: [], clearSenderId: 'owner-1', clearDiscussionId: 'discussion-42',
    });
    expect(active.status === 'accepted' && guard.isCurrent(active.key)).toBe(true);

    const cancellation = guard.cancel('owner-1', { ...fixture.cancel, stateVersion: 7, round: 2 });
    expect(cancellation).toMatchObject({ status: 'accepted', clearDiscussionId: 'discussion-42' });
    expect(cancellation).toMatchObject({ status: 'accepted', clearSenderId: 'owner-1' });
    expect(cancellation.status === 'accepted' && cancellation.abortedKeys).toContain(
      active.status === 'accepted' ? active.key : '',
    );
    expect(active.status === 'accepted' && guard.isCurrent(active.key)).toBe(false);
    expect(guard.claim('owner-1', fixture.assignment, 'node-member')).toEqual({ status: 'cancelled' });
    expect(guard.claim('another-owner', fixture.assignment, 'node-member').status).toBe('accepted');
  });

  it('uses the cancel-only FIFO exception at 257 without evicting logical replay tombstones', () => {
    const guard = new DiscussionV2Guard({ clock: () => 1_000 });
    const logical = { ...fixture.hostTurn, discussionId: 'logical-only', requestId: 'logical-request' };
    const logicalClaim = guard.claim('owner-1', logical, 'node-host');
    expect(logicalClaim.status).toBe('accepted');
    if (logicalClaim.status !== 'accepted') throw new Error('expected logical claim');
    expect(guard.complete(logicalClaim.key)).toBe(true);

    for (let index = 0; index < DISCUSSION_V2_LIMITS.maxCancelTombstones; index += 1) {
      expect(guard.cancel('owner-1', {
        ...fixture.cancel, discussionId: `discussion-${index}`,
      }).status).toBe('accepted');
    }
    expect(guard.cancel('owner-1', { ...fixture.cancel, discussionId: 'overflow' }))
      .toMatchObject({ status: 'accepted', clearDiscussionId: 'overflow' });
    expect(guard.claim('owner-1', {
      ...fixture.assignment, discussionId: 'discussion-0', requestId: 'oldest-assignment',
    }, 'node-member')).toMatchObject({ status: 'accepted' });
    expect(guard.claim('owner-1', {
      ...fixture.assignment, discussionId: 'overflow', requestId: 'newest-assignment',
    }, 'node-member')).toEqual({ status: 'cancelled' });
    expect(guard.claim('owner-1', logical, 'node-host')).toEqual({ status: 'replay' });
  });
});

describe('discussion v2 acknowledgement and disposal guard', () => {
  const expectation = {
    senderId: 'owner-1', discussionId: 'discussion-42', requestId: 'host-request-1',
    stateVersion: 7, round: 2, updateId: 'update-1', artifactId: 'artifact-7', artifactVersion: 4,
  };

  it('accepts only the full ACK identity once and keeps unrelated waits', () => {
    const guard = new DiscussionV2Guard({ clock: () => 1_000 });
    expect(guard.registerArtifactAck(expectation)).toEqual({ status: 'accepted' });
    expect(guard.acceptArtifactAck('somebody-else', fixture.artifactAck)).toEqual({ status: 'unknown' });
    expect(guard.pendingAckCount).toBe(1);
    expect(guard.acceptArtifactAck('owner-1', { ...fixture.artifactAck, artifactVersion: 5 }))
      .toEqual({ status: 'unknown' });
    expect(guard.pendingAckCount).toBe(1);
    expect(guard.acceptArtifactAck('owner-1', fixture.artifactAck)).toEqual({ status: 'accepted' });
    expect(guard.acceptArtifactAck('owner-1', fixture.artifactAck)).toEqual({ status: 'unknown' });
  });

  it('expires after 15 seconds and fails closed at 128 pending ACKs', () => {
    let now = 1_000;
    const expiring = new DiscussionV2Guard({ clock: () => now });
    expect(expiring.registerArtifactAck(expectation).status).toBe('accepted');
    now += DISCUSSION_V2_LIMITS.ackTimeoutMs;
    expect(expiring.acceptArtifactAck('owner-1', fixture.artifactAck)).toEqual({ status: 'expired' });

    const full = new DiscussionV2Guard({ clock: () => 1_000 });
    for (let index = 0; index < DISCUSSION_V2_LIMITS.maxPendingAcks; index += 1) {
      expect(full.registerArtifactAck({ ...expectation, updateId: `update-${index}` }).status).toBe('accepted');
    }
    expect(full.registerArtifactAck({ ...expectation, updateId: 'overflow' })).toEqual({ status: 'capacity' });
  });

  it('dispose clears state and permanently suppresses late work', () => {
    const guard = new DiscussionV2Guard({ clock: () => 1_000 });
    const claim = guard.claim('owner-1', fixture.hostTurn, 'node-host');
    expect(guard.registerArtifactAck(expectation).status).toBe('accepted');
    guard.dispose();
    expect(claim.status === 'accepted' && guard.isCurrent(claim.key)).toBe(false);
    expect(guard.pendingAckCount).toBe(0);
    expect(guard.claim('owner-1', fixture.hostTurn, 'node-host')).toEqual({ status: 'disposed' });
    expect(guard.registerArtifactAck(expectation)).toEqual({ status: 'disposed' });
  });
});

describe('discussion v2 model catalog', () => {
  it('parses exact request/response fixtures and builds the existing external wire', () => {
    expect(parseDiscussionModelCatalogRequest(fixture.modelCatalogRequest)).toEqual(fixture.modelCatalogRequest);
    expect(parseDiscussionModelCatalogResponse(fixture.modelCatalogResponse)).toEqual(fixture.modelCatalogResponse);
    expect(buildModelCatalogResponse(fixture.modelCatalogRequest, {
      defaultModel: 'openai/model-a',
      providers: [{ id: 'openai', name: 'OpenAI', models: [{ id: 'model-a', name: 'Model A' }] }],
    }, 1723950000600)).toEqual(fixture.modelCatalogResponse);
  });

  it('rejects aliases, unknown keys and malformed catalog routes', () => {
    expect(parseDiscussionModelCatalogRequest({ ...fixture.modelCatalogRequest, request_id: 'alias' })).toBeNull();
    expect(parseDiscussionModelCatalogResponse({ ...fixture.modelCatalogResponse, extra: true })).toBeNull();
    expect(parseDiscussionModelCatalogResponse({ ...fixture.modelCatalogResponse, defaultModel: 'model-a' }))
      .toBeNull();
  });
});
