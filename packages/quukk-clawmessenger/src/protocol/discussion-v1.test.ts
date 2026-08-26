// @vitest-environment node

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  DISCUSSION_TURN_TIMEOUT_MS,
  advanceAfterCompleted,
  advanceAfterTimeout,
  buildDiscussionV1,
  discussionV1Key,
  parseDiscussionV1,
} from './discussion-v1.js';

const valid = JSON.parse(readFileSync(new URL('./fixtures/discussion-v1.valid.json', import.meta.url), 'utf8'));
const invalid = JSON.parse(
  readFileSync(new URL('./fixtures/discussion-v1.invalid.json', import.meta.url), 'utf8'),
) as Array<{ name: string; value: unknown }>;

describe('discussion v1 parser and builder', () => {
  it('parses the shared valid fixture and rebuilds only exact keys', () => {
    expect(parseDiscussionV1(valid.passTurn)).toEqual(valid.passTurn);
    expect(parseDiscussionV1(valid.endDiscussion)).toEqual(valid.endDiscussion);
  });

  it.each(invalid)('rejects fixture case: $name', (fixture) => {
    expect(parseDiscussionV1(fixture.value)).toBeNull();
  });

  it('rejects unknown payload keys and unsafe bounds', () => {
    expect(parseDiscussionV1({
      ...valid.passTurn,
      payload: { ...valid.passTurn.payload, unexpected: true },
    })).toBeNull();
    expect(parseDiscussionV1({
      ...valid.passTurn,
      payload: { ...valid.passTurn.payload, round: 3, max_rounds: 2 },
    })).toBeNull();
    expect(parseDiscussionV1({
      ...valid.passTurn,
      payload: { ...valid.passTurn.payload, turn_order: Array.from({ length: 65 }, (_, index) => `node-${index}`) },
    })).toBeNull();
    expect(parseDiscussionV1({
      ...valid.passTurn,
      payload: { ...valid.passTurn.payload, originator_text: '界'.repeat(34_000) },
    })).toBeNull();
    expect(parseDiscussionV1({
      ...valid.passTurn,
      payload: { ...valid.passTurn.payload, next_speaker: 'not-a-participant' },
    })).toBeNull();
  });

  it('builds deterministically from explicit identity and time', () => {
    expect(buildDiscussionV1({
      action: 'pass_turn',
      discussionId: 'discussion-explicit',
      payload: valid.passTurn.payload,
      timestamp: 42,
    })).toEqual({
      msg_type: 'discussion_token',
      service: 'openclaw_coord',
      discussion_id: 'discussion-explicit',
      version: 1,
      action: 'pass_turn',
      payload: valid.passTurn.payload,
      timestamp: 42,
    });
  });

  it('uses a collision-safe duplicate key', () => {
    const first = parseDiscussionV1(valid.passTurn)!;
    const second = parseDiscussionV1({
      ...valid.passTurn,
      discussion_id: 'discussion-1#1',
      payload: { ...valid.passTurn.payload, current_speaker: 'node-b', next_speaker: 'node-a' },
    })!;

    expect(discussionV1Key(first)).toBe(JSON.stringify([
      'discussion-1', 1, 'pass_turn', 'node-a', 'node-b',
    ]));
    expect(discussionV1Key(second)).not.toBe(discussionV1Key(first));
    expect(new Set([discussionV1Key(first), discussionV1Key(first)]).size).toBe(1);
  });
});

describe('discussion v1 turn decisions', () => {
  it('advances within a round after completion', () => {
    expect(advanceAfterCompleted(valid.passTurn.payload, 'node-a')).toEqual({
      kind: 'pass_turn',
      nextSpeaker: 'node-b',
      round: 1,
    });
  });

  it('wraps to the first participant only when another round remains', () => {
    expect(advanceAfterCompleted({ ...valid.passTurn.payload, current_speaker: 'node-b' }, 'node-b')).toEqual({
      kind: 'pass_turn',
      nextSpeaker: 'node-a',
      round: 2,
    });
    expect(advanceAfterCompleted({
      ...valid.passTurn.payload,
      current_speaker: 'node-b',
      round: 2,
    }, 'node-b')).toEqual({ kind: 'end_discussion', round: 2 });
  });

  it('applies the same deterministic skip rule after timeout', () => {
    expect(DISCUSSION_TURN_TIMEOUT_MS).toBe(60_000);
    expect(advanceAfterTimeout(valid.passTurn.payload, 'node-a')).toEqual({
      kind: 'pass_turn',
      nextSpeaker: 'node-b',
      round: 1,
    });
    expect(advanceAfterTimeout(valid.passTurn.payload, 'unknown')).toEqual({ kind: 'invalid' });
  });
});
