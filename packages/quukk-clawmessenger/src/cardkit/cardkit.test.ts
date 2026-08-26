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
