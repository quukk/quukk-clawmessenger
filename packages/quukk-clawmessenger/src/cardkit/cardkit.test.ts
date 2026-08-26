// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  ACTION_TYPES,
  CARD_SCHEMA_VERSION,
  SECTION_KINDS,
  type CardModel,
  type CardSection,
} from './schema.js';
import {
  action,
  btn,
  buildCardMessage,
  buildCardUpdate,
  card,
  md,
} from './builders.js';
import { validateCard } from './validate.js';
import {
  CARD_MARKER_BYTE_LIMIT,
  MAX_CARD_MARKERS,
  CardMarkerStream,
  parseCardMarkers,
  streamSafeContent,
  stripMarkers,
} from './parse-marker.js';
import {
  commandsCard,
  errorCard,
  permissionUnsupportedCard,
  sessionsCard,
} from './templates.js';
import { buildUnsupportedApprovalResult, routeCardAction } from './action-router.js';

function allSections(): CardSection[] {
  const actions = [
    action.permission('permission-1', 'once'),
    action.answer('question-1', ['A']),
    action.command('/status'),
    action.session('switch', 'session-1'),
    action.navigate('session.next'),
    action.custom('inspect', { scope: 'public' }),
    action.none(),
  ];
  return [
    { kind: 'markdown', content: '**Public result**' },
    { kind: 'divider' },
    { kind: 'note', text: 'A note' },
    { kind: 'buttonRow', buttons: actions.map((item, index) => btn(`Action ${index}`, item)), layout: 'flow' },
    { kind: 'keyValue', items: [{ label: 'Status', value: 'ready', icon: 'ok' }] },
    { kind: 'select', placeholder: 'Choose', options: [{ label: 'A', value: 'a' }], action: action.custom('select') },
    { kind: 'input', placeholder: 'Type', label: 'Value', multiline: true, submitButton: btn('Send', action.custom('submit')) },
    { kind: 'image', src: 'https://example.test/image.png', alt: 'Preview', url: 'https://example.test/' },
    { kind: 'table', columns: [{ key: 'name', label: 'Name', width: 50 }], rows: [{ name: 'alpha' }] },
    { kind: 'permission', permissionId: 'permission-1', permission: 'edit', title: 'Edit a file', patterns: ['src/**'] },
    { kind: 'question', questionId: 'question-1', header: 'Pick', question: 'Which?', options: [{ label: 'A', description: 'First' }], multiple: false, custom: false },
    { kind: 'progress', tools: [{ name: 'check', status: 'completed' }], thinking: 'Done', elapsedMs: 10, done: true },
    { kind: 'statusReport', branch: 'main', commit: 'abc123', files: [{ path: 'src/a.ts', status: 'modified' }] },
    { kind: 'sessionList', currentSessionId: 'session-1', sessions: [{ id: 'session-1', title: 'Current', updatedAt: 100 }] },
    { kind: 'commandPalette', title: 'Commands', commands: [{ name: '/status', description: 'Show status' }] },
  ];
}

function completeCard(): CardModel {
  return card('card-1', 'Task result', allSections(), {
    icon: 'result', color: 'blue', subtitle: 'Safe public data', wide: true,
    collapsible: false, reasoning: 'Public summary only', loading: false,
  });
}

describe('CardKit schema and builders', () => {
  it('locks schema version, all 15 sections and all 7 actions', () => {
    expect(CARD_SCHEMA_VERSION).toBe('1.0.0');
    expect(SECTION_KINDS).toEqual([
      'markdown', 'divider', 'note', 'buttonRow', 'keyValue', 'select', 'input', 'image', 'table',
      'permission', 'question', 'progress', 'statusReport', 'sessionList', 'commandPalette',
    ]);
    expect(ACTION_TYPES).toEqual([
      'permission', 'answer', 'command', 'session', 'navigate', 'custom', 'none',
    ]);
    expect(completeCard().sections.map((section) => section.kind)).toEqual(SECTION_KINDS);
  });

  it('constructs fresh allowlisted cards from explicit IDs without time or randomness', () => {
    const sections = [md('Original')];
    const built = card('explicit-card', 'Explicit title', sections, { color: 'green' });
    expect(built).toEqual({
      schema: '1.0.0',
      id: 'explicit-card',
      header: { title: 'Explicit title', color: 'green' },
      sections: [{ kind: 'markdown', content: 'Original' }],
      config: {},
    });
    expect(built.sections).not.toBe(sections);
    sections[0] = md('Mutated');
    expect(built.sections).toEqual([{ kind: 'markdown', content: 'Original' }]);
  });

  it('builds exact card_message and card_update envelopes with explicit timestamps', () => {
    const model = card('card-wire', 'Wire', [md('Body')]);
    expect(buildCardMessage(model, 100)).toEqual({
      msg_type: 'card_message', schema: '1.0.0', card: model, timestamp: 100,
    });
    expect(buildCardUpdate('card-wire', model, 101)).toEqual({
      msg_type: 'card_update', cardId: 'card-wire', card: model, timestamp: 101,
    });
    expect(() => buildCardUpdate('some-other-card', model, 101)).toThrow(/cardId/);
  });
});

describe('CardKit fresh-object validation', () => {
  it('validates every section/action and returns a detached model', () => {
    const source = completeCard();
    const result = validateCard(source);
    expect(result).toMatchObject({ ok: true, warnings: [] });
    if (!result.ok) throw new Error('expected valid card');
    expect(result.value).toEqual(source);
    expect(result.value).not.toBe(source);
    expect(result.value.sections).not.toBe(source.sections);
  });

  it('drops unknown and prototype keys at every represented nesting level', () => {
    const raw = JSON.parse(`{
      "schema":"1.0.0","id":"safe-card","unknownTop":"drop",
      "__proto__":{"polluted":true},
      "header":{"title":"Safe","unknownHeader":"drop"},
      "sections":[
        {"kind":"buttonRow","unknownSection":"drop","buttons":[{
          "label":"Inspect","unknownButton":"drop",
          "action":{"type":"custom","kind":"inspect","payload":{"safe":true,"__proto__":{"polluted":true}},"unknownAction":"drop"}
        }]},
        {"kind":"table","columns":[{"key":"name","label":"Name","unknownColumn":"drop"}],
          "rows":[{"name":"alpha","unknownRow":"drop","__proto__":"drop"}]}
      ]
    }`) as unknown;
    const result = validateCard(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected sanitized card');
    expect(result.value).toEqual({
      schema: '1.0.0', id: 'safe-card', header: { title: 'Safe' },
      sections: [
        { kind: 'buttonRow', buttons: [{ label: 'Inspect', action: { type: 'custom', kind: 'inspect', payload: { safe: true } } }] },
        { kind: 'table', columns: [{ key: 'name', label: 'Name' }], rows: [{ name: 'alpha' }] },
      ],
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('rejects accessors, unsafe URLs, control characters and unknown section/action kinds', () => {
    const getterCard = completeCard() as unknown as Record<string, unknown>;
    Object.defineProperty(getterCard, 'header', {
      enumerable: true,
      get: () => { throw new Error('untrusted getter'); },
    });
    expect(() => validateCard(getterCard)).not.toThrow();
    expect(validateCard(getterCard)).toMatchObject({ ok: false, code: 'invalid_card' });

    for (const src of ['javascript:alert(1)', 'data:text/plain,x', 'file:///tmp/x', '//example.test/x', 'http://example.test/x', 'https://user:pass@example.test/x']) {
      expect(validateCard(card('bad-url', 'Bad', [{ kind: 'image', src }])))
        .toMatchObject({ ok: false, code: 'invalid_card' });
    }
    expect(validateCard(card('bad-control', 'Bad\u0000title', [md('body')])))
      .toMatchObject({ ok: false, code: 'invalid_card' });
    expect(validateCard({ ...completeCard(), sections: [{ kind: 'future', content: 'x' }] }))
      .toMatchObject({ ok: false, code: 'invalid_card' });
    expect(validateCard({
      ...completeCard(),
      sections: [{ kind: 'buttonRow', buttons: [{ label: 'x', action: { type: 'future' } }] }],
    })).toMatchObject({ ok: false, code: 'invalid_card' });
  });

  it('enforces section, button, table, session, command and option array caps', () => {
    expect(validateCard(card('too-many-sections', 'Bad', Array.from({ length: 65 }, () => md('x')))))
      .toMatchObject({ ok: false, code: 'invalid_card' });
    expect(validateCard(card('too-many-buttons', 'Bad', [{
      kind: 'buttonRow', buttons: Array.from({ length: 11 }, (_, index) => btn(String(index), action.none())),
    }]))) .toMatchObject({ ok: false, code: 'invalid_card' });
    expect(validateCard(card('too-many-columns', 'Bad', [{
      kind: 'table', columns: Array.from({ length: 17 }, (_, index) => ({ key: `c${index}`, label: `C${index}` })), rows: [],
    }]))) .toMatchObject({ ok: false, code: 'invalid_card' });
    expect(validateCard(card('too-many-rows', 'Bad', [{
      kind: 'table', columns: [{ key: 'c', label: 'C' }], rows: Array.from({ length: 11 }, () => ({ c: 'x' })),
    }]))) .toMatchObject({ ok: false, code: 'invalid_card' });
    expect(validateCard(card('too-many-sessions', 'Bad', [{
      kind: 'sessionList', sessions: Array.from({ length: 21 }, (_, index) => ({ id: `s${index}`, title: 'S' })),
    }]))) .toMatchObject({ ok: false, code: 'invalid_card' });
    expect(validateCard(card('too-many-commands', 'Bad', [{
      kind: 'commandPalette', commands: Array.from({ length: 21 }, () => ({ name: '/status' })),
    }]))) .toMatchObject({ ok: false, code: 'invalid_card' });
    expect(validateCard(card('too-many-options', 'Bad', [{
      kind: 'select', placeholder: 'Pick', options: Array.from({ length: 51 }, (_, index) => ({ label: String(index), value: String(index) })), action: action.none(),
    }]))) .toMatchObject({ ok: false, code: 'invalid_card' });
  });

  it('separates the 10 KiB validation hard limit from the 9 KiB builder target', () => {
    const targetOnly = card('large-card', 'Large', [md('x'.repeat(9_100))]);
    expect(validateCard(targetOnly).ok).toBe(true);
    expect(() => buildCardMessage(targetOnly, 100)).toThrow(/9000/);

    const overHardLimit = card('oversized-card', 'Large', [md('x'.repeat(10_200))]);
    expect(validateCard(overHardLimit)).toMatchObject({ ok: false, code: 'card_too_large' });
  });
});

describe('CardKit balanced markers', () => {
  const cardJson = JSON.stringify({
    schema: '1.0.0',
    id: 'marker-card',
    header: { title: 'Nested } and ] with an escaped "quote"' },
    sections: [{ kind: 'markdown', content: 'Body [inside] {text}' }],
  });
  const commandsJson = JSON.stringify([{ name: '/status' }, { name: '/sessions' }]);

  it('extracts nested CARD objects and legacy COMMANDS arrays without consuming tail text', () => {
    const source = `before[CARD][${cardJson}]middle[COMMANDS][${commandsJson}]after`;
    const parsed = parseCardMarkers(source);
    expect(parsed).toEqual({
      text: 'beforemiddleafter',
      cards: [JSON.parse(cardJson)],
      commands: [JSON.parse(commandsJson)],
      errors: [],
    });
    expect(stripMarkers(source)).toBe(parsed.text);
    expect(streamSafeContent(source)).toBe(parsed.text);
  });

  it('buffers every partial opener and incomplete JSON without leaking marker bytes', () => {
    for (const value of ['hello [', 'hello [C', 'hello [CARD]', 'hello [CARD][', 'hello [CARD][{"schema":']) {
      expect(streamSafeContent(value)).toBe('hello ');
    }
    expect(streamSafeContent(`hello [CARD][${cardJson}] tail`)).toBe('hello  tail');
  });

  it('caches split stream chunks and emits a safe final diagnostic for unfinished data', () => {
    const stream = new CardMarkerStream();
    expect(stream.push('hello [C').text).toBe('hello ');
    expect(stream.push(`ARD][${cardJson.slice(0, 30)}`).text).toBe('hello ');
    expect(stream.push(`${cardJson.slice(30)}] tail`).text).toBe('hello  tail');
    expect(stream.finish()).toMatchObject({ text: 'hello  tail', cards: [JSON.parse(cardJson)], errors: [] });

    const incomplete = new CardMarkerStream();
    incomplete.push('safe [CARD][{"secret":"never leak"');
    const final = incomplete.finish();
    expect(final.text).toContain('[invalid card marker]');
    expect(final.text).not.toContain('secret');
    expect(final.text).not.toContain('[CARD]');
  });

  it('fails closed for wrong roots, malformed JSON, oversized markers and marker-count overflow', () => {
    for (const source of [
      '[CARD][[1,2]]tail',
      '[COMMANDS][{"name":"/status"}]tail',
      '[CARD][{"x":invalid}]tail',
    ]) {
      const parsed = parseCardMarkers(source);
      expect(parsed.cards).toEqual([]);
      expect(parsed.commands).toEqual([]);
      expect(parsed.text).toContain('[invalid card marker]');
      expect(parsed.text).not.toContain('[CARD]');
      expect(parsed.text).not.toContain('[COMMANDS]');
    }

    const oversizedJson = JSON.stringify({ value: 'x'.repeat(CARD_MARKER_BYTE_LIMIT + 1) });
    const oversized = parseCardMarkers(`[CARD][${oversizedJson}]tail`);
    expect(oversized.errors).toContain('marker_too_large');
    expect(oversized.text).toBe('[invalid card marker]tail');
    expect(oversized.text).not.toContain('xxx');

    const many = Array.from({ length: MAX_CARD_MARKERS + 1 }, (_, index) =>
      `[CARD][${JSON.stringify({ id: `card-${index}` })}]`).join('');
    const overflow = parseCardMarkers(`${many}tail`);
    expect(overflow.cards).toHaveLength(MAX_CARD_MARKERS);
    expect(overflow.errors).toContain('too_many_markers');
    expect(overflow.text).toBe('[invalid card marker]tail');
  });
});

describe('CardKit pure action routing', () => {
  const baseAction = {
    msg_type: 'card_action',
    cardId: 'card-1',
    buttonId: 'button-1',
    request_id: 'request-1',
    timestamp: 100,
  };

  it('routes all supported non-permission intents without side effects', () => {
    expect(routeCardAction({ ...baseAction, action: { type: 'command', name: '/status' } })).toEqual({
      ok: true, kind: 'command', cardId: 'card-1', buttonId: 'button-1', requestId: 'request-1',
      name: '/status',
    });
    expect(routeCardAction({ ...baseAction, action: { type: 'session', op: 'delete', sessionId: 'session-1' } }))
      .toMatchObject({ ok: true, kind: 'session', op: 'delete', sessionId: 'session-1' });
    expect(routeCardAction({ ...baseAction, action: { type: 'answer', questionId: 'question-1', value: ['A'] } }))
      .toMatchObject({ ok: true, kind: 'answer', questionId: 'question-1', value: ['A'] });
    expect(routeCardAction({ ...baseAction, action: { type: 'navigate', target: 'session.next' } }))
      .toMatchObject({ ok: true, kind: 'navigate', target: 'session.next' });
    const customPayload = { public: { value: 1 } };
    const custom = routeCardAction({ ...baseAction, action: { type: 'custom', kind: 'inspect', payload: customPayload } });
    expect(custom).toMatchObject({ ok: true, kind: 'custom', customKind: 'inspect', payload: customPayload });
    if (custom.ok && custom.kind === 'custom') expect(custom.payload).not.toBe(customPayload);
    expect(routeCardAction({ ...baseAction, action: { type: 'none' } }))
      .toMatchObject({ ok: true, kind: 'none' });
  });

  it('rejects arbitrary commands, aliases, unknown keys and unknown actions without custom fallback', () => {
    expect(routeCardAction({ ...baseAction, action: { type: 'command', name: '/future' } }))
      .toMatchObject({ ok: false, code: 'unsupported_command' });
    expect(routeCardAction({ ...baseAction, requestId: 'alias', action: { type: 'none' } }))
      .toMatchObject({ ok: false, code: 'invalid_action' });
    expect(routeCardAction({ ...baseAction, extra: true, action: { type: 'none' } }))
      .toMatchObject({ ok: false, code: 'invalid_action' });
    expect(routeCardAction({ ...baseAction, action: { type: 'none', extra: true } }))
      .toMatchObject({ ok: false, code: 'invalid_action' });
    expect(routeCardAction({ ...baseAction, action: { type: 'future', payload: {} } }))
      .toMatchObject({ ok: false, code: 'unsupported_action' });
    expect(routeCardAction({ ...baseAction, cardId: 'bad\u200bid', action: { type: 'none' } }))
      .toMatchObject({ ok: false, code: 'invalid_action' });
  });

  it('bounds custom JSON by bytes, depth, keys and prototype safety', () => {
    expect(routeCardAction({
      ...baseAction, action: { type: 'custom', kind: 'large', payload: { value: 'x'.repeat(4_097) } },
    })).toMatchObject({ ok: false, code: 'invalid_action' });
    let deep: Record<string, unknown> = { value: true };
    for (let depth = 0; depth < 9; depth += 1) deep = { nested: deep };
    expect(routeCardAction({ ...baseAction, action: { type: 'custom', kind: 'deep', payload: deep } }))
      .toMatchObject({ ok: false, code: 'invalid_action' });
    const keys = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`k${index}`, index]));
    expect(routeCardAction({ ...baseAction, action: { type: 'custom', kind: 'keys', payload: keys } }))
      .toMatchObject({ ok: false, code: 'invalid_action' });
    const polluted = JSON.parse('{"safe":true,"__proto__":{"polluted":true}}') as unknown;
    expect(routeCardAction({ ...baseAction, action: { type: 'custom', kind: 'unsafe', payload: polluted } }))
      .toMatchObject({ ok: false, code: 'invalid_action' });

    const throwing: Record<string, unknown> = {};
    Object.defineProperty(throwing, 'value', { enumerable: true, get: () => { throw new Error('no getter'); } });
    expect(() => routeCardAction({ ...baseAction, action: { type: 'custom', kind: 'getter', payload: throwing } }))
      .not.toThrow();
    expect(routeCardAction({ ...baseAction, action: { type: 'custom', kind: 'getter', payload: throwing } }))
      .toMatchObject({ ok: false, code: 'invalid_action' });
  });

  it('maps permission wire compatibility to a fixed unsupported approval and nested result card', () => {
    const permissionAction = {
      ...baseAction,
      action: { type: 'permission', permissionId: 'permission-1', reply: 'once' },
    };
    expect(routeCardAction(permissionAction)).toEqual({
      ok: false,
      code: 'unsupported_interactive_approval',
      status: 501,
      cardId: 'card-1',
      buttonId: 'button-1',
      requestId: 'request-1',
    });
    const result = buildUnsupportedApprovalResult(permissionAction, 200);
    expect(result).toMatchObject({
      msg_type: 'command_result',
      request_id: 'request-1',
      status: 'error',
      code: 501,
      message: 'unsupported_interactive_approval',
      data: {
        card_state: {
          card_id: 'card-1',
          status: 'error',
          result: 'unsupported_interactive_approval',
          completed_action: 'permission',
          completed_at: 200,
          card: { id: 'card-1' },
        },
      },
      timestamp: 200,
    });
    const resultCard = result.data.card_state.card;
    expect(resultCard.sections.some((section) => section.kind === 'permission' || section.kind === 'buttonRow'))
      .toBe(false);
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(10 * 1024);
  });
});

describe('CardKit deterministic templates', () => {
  it('never renders unsupported permission allow/deny buttons', () => {
    const model = permissionUnsupportedCard('permission-card', {
      permissionId: 'permission-1', permission: 'edit', title: 'Edit a file', patterns: ['src/**'],
    });
    expect(model.id).toBe('permission-card');
    expect(model.sections.some((section) => section.kind === 'permission' || section.kind === 'buttonRow'))
      .toBe(false);
    expect(JSON.stringify(model)).toContain('unsupported_interactive_approval');
  });

  it('uses only explicit IDs and applies list caps', () => {
    expect(errorCard('error-card', 'Safe error').id).toBe('error-card');
    expect(sessionsCard(
      'sessions-card',
      Array.from({ length: 25 }, (_, index) => ({ id: `session-${index}`, title: `Session ${index}` })),
      'session-1',
    ).sections).toHaveLength(20);
    expect(commandsCard(
      'commands-card',
      Array.from({ length: 25 }, (_, index) => ({ name: `/command-${index}` })),
    ).sections).toHaveLength(20);
  });
});
