/**
 * Adapted under MIT from CardKit builders in
 * quukk/codex-clawmessenger@3f3a2e4d6a8cb143a0088350aed2e1b4d1675473
 * (`src/cardkit/builders.ts`) and
 * quukk/clawmessenger@a50f2393213f6f1c42da139491d2fe20937e7c7a
 * (`src/cardkit/builders.ts`). See THIRD_PARTY_NOTICES.md.
 */

import {
  CARD_SCHEMA_VERSION,
  type ButtonLayout,
  type ButtonVariant,
  type CardAction,
  type CardButton,
  type CardColor,
  type CardMessageEnvelope,
  type CardModel,
  type CardSection,
  type CardUpdateEnvelope,
  type CommandPaletteSection,
  type InputSection,
  type PermissionSection,
  type ProgressSection,
  type QuestionSection,
  type SelectOption,
  type SessionListSection,
  type StatusReportSection,
} from './schema.js';
import { validateCard } from './validate.js';

export interface CardOptions {
  icon?: string;
  color?: CardColor;
  subtitle?: string;
  wide?: boolean;
  collapsible?: boolean;
  reasoning?: string;
  loading?: boolean;
}

function cloneJson(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }
  if (depth >= 8) return null;
  if (Array.isArray(value)) return value.map((item) => cloneJson(item, depth + 1));
  if (typeof value !== 'object') return null;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') continue;
    output[key] = cloneJson(item, depth + 1);
  }
  return output;
}

function cloneAction(value: CardAction): CardAction {
  if (value.type === 'permission') {
    return { type: value.type, permissionId: value.permissionId, reply: value.reply };
  }
  if (value.type === 'answer') return { type: value.type, questionId: value.questionId, value: [...value.value] };
  if (value.type === 'command') return { type: value.type, name: value.name };
  if (value.type === 'session') return { type: value.type, op: value.op, sessionId: value.sessionId };
  if (value.type === 'navigate') return { type: value.type, target: value.target };
  if (value.type === 'custom') {
    return { type: value.type, kind: value.kind, payload: cloneJson(value.payload) as Record<string, unknown> };
  }
  return { type: 'none' };
}

function cloneButton(value: CardButton): CardButton {
  return {
    label: value.label,
    action: cloneAction(value.action),
    ...(value.id === undefined ? {} : { id: value.id }),
    ...(value.icon === undefined ? {} : { icon: value.icon }),
    ...(value.variant === undefined ? {} : { variant: value.variant }),
    ...(value.disabled === undefined ? {} : { disabled: value.disabled }),
    ...(value.url === undefined ? {} : { url: value.url }),
  };
}

function cloneSection(section: CardSection): CardSection {
  switch (section.kind) {
    case 'markdown':
      return { kind: section.kind, content: section.content, ...(section.collapsed === undefined ? {} : { collapsed: section.collapsed }) };
    case 'divider':
      return { kind: section.kind };
    case 'note':
      return { kind: section.kind, text: section.text };
    case 'buttonRow':
      return { kind: section.kind, buttons: section.buttons.map(cloneButton), ...(section.layout === undefined ? {} : { layout: section.layout }) };
    case 'keyValue':
      return {
        kind: section.kind,
        items: section.items.map((item) => ({
          label: item.label,
          value: item.value,
          ...(item.icon === undefined ? {} : { icon: item.icon }),
        })),
      };
    case 'select':
      return {
        kind: section.kind,
        placeholder: section.placeholder,
        options: section.options.map((option) => ({ label: option.label, value: option.value })),
        action: cloneAction(section.action),
      };
    case 'input':
      return {
        kind: section.kind,
        placeholder: section.placeholder,
        ...(section.label === undefined ? {} : { label: section.label }),
        ...(section.multiline === undefined ? {} : { multiline: section.multiline }),
        ...(section.submitButton === undefined ? {} : { submitButton: cloneButton(section.submitButton) }),
      };
    case 'image':
      return {
        kind: section.kind,
        src: section.src,
        ...(section.alt === undefined ? {} : { alt: section.alt }),
        ...(section.url === undefined ? {} : { url: section.url }),
      };
    case 'table': {
      const columns = section.columns.map((column) => ({
        key: column.key,
        label: column.label,
        ...(column.width === undefined ? {} : { width: column.width }),
      }));
      return {
        kind: section.kind,
        columns,
        rows: section.rows.map((row) => Object.fromEntries(
          columns.flatMap(({ key }) => typeof row[key] === 'string' ? [[key, row[key]]] : []),
        )),
      };
    }
    case 'permission':
      return {
        kind: section.kind,
        permissionId: section.permissionId,
        permission: section.permission,
        title: section.title,
        patterns: [...section.patterns],
        ...(section.buttons === undefined ? {} : { buttons: section.buttons.map(cloneButton) }),
      };
    case 'question':
      return {
        kind: section.kind,
        questionId: section.questionId,
        header: section.header,
        question: section.question,
        options: section.options.map((option) => ({
          label: option.label,
          ...(option.description === undefined ? {} : { description: option.description }),
        })),
        ...(section.multiple === undefined ? {} : { multiple: section.multiple }),
        ...(section.custom === undefined ? {} : { custom: section.custom }),
      };
    case 'progress':
      return {
        kind: section.kind,
        ...(section.tools === undefined ? {} : {
          tools: section.tools.map((tool) => ({
            name: tool.name,
            status: tool.status,
            ...(tool.error === undefined ? {} : { error: tool.error }),
          })),
        }),
        ...(section.thinking === undefined ? {} : { thinking: section.thinking }),
        ...(section.elapsedMs === undefined ? {} : { elapsedMs: section.elapsedMs }),
        ...(section.done === undefined ? {} : { done: section.done }),
      };
    case 'statusReport':
      return {
        kind: section.kind,
        ...(section.branch === undefined ? {} : { branch: section.branch }),
        ...(section.commit === undefined ? {} : { commit: section.commit }),
        ...(section.files === undefined ? {} : {
          files: section.files.map((file) => ({ path: file.path, status: file.status })),
        }),
      };
    case 'sessionList':
      return {
        kind: section.kind,
        ...(section.currentSessionId === undefined ? {} : { currentSessionId: section.currentSessionId }),
        sessions: section.sessions.map((session) => ({
          id: session.id,
          title: session.title,
          ...(session.updatedAt === undefined ? {} : { updatedAt: session.updatedAt }),
        })),
      };
    case 'commandPalette':
      return {
        kind: section.kind,
        ...(section.title === undefined ? {} : { title: section.title }),
        ...(section.commands === undefined ? {} : {
          commands: section.commands.map((command) => ({
            name: command.name,
            ...(command.description === undefined ? {} : { description: command.description }),
          })),
        }),
        ...(section.groups === undefined ? {} : {
          groups: section.groups.map((group) => ({
            label: group.label,
            ...(group.collapsed === undefined ? {} : { collapsed: group.collapsed }),
            items: group.items.map((command) => ({
              name: command.name,
              ...(command.description === undefined ? {} : { description: command.description }),
            })),
          })),
        }),
      };
  }
}

export function card(id: string, title: string, sections: CardSection[], options: CardOptions = {}): CardModel {
  return {
    schema: CARD_SCHEMA_VERSION,
    id,
    header: {
      title,
      ...(options.icon === undefined ? {} : { icon: options.icon }),
      ...(options.color === undefined ? {} : { color: options.color }),
      ...(options.subtitle === undefined ? {} : { subtitle: options.subtitle }),
    },
    sections: sections.map(cloneSection),
    config: {
      ...(options.wide === undefined ? {} : { wide: options.wide }),
      ...(options.collapsible === undefined ? {} : { collapsible: options.collapsible }),
    },
    ...(options.reasoning === undefined || options.reasoning.length === 0 ? {} : { reasoning: options.reasoning }),
    ...(options.loading === true ? { loading: true } : {}),
  };
}

export const action = {
  permission: (permissionId: string, reply: 'once' | 'always' | 'reject'): CardAction => ({ type: 'permission', permissionId, reply }),
  answer: (questionId: string, value: string[]): CardAction => ({ type: 'answer', questionId, value: [...value] }),
  command: (name: string): CardAction => ({ type: 'command', name }),
  session: (op: 'switch' | 'delete', sessionId: string): CardAction => ({ type: 'session', op, sessionId }),
  navigate: (target: string): CardAction => ({ type: 'navigate', target }),
  custom: (kind: string, payload: Record<string, unknown> = {}): CardAction => ({ type: 'custom', kind, payload: cloneJson(payload) as Record<string, unknown> }),
  none: (): CardAction => ({ type: 'none' }),
};

export interface ButtonOptions {
  id?: string;
  icon?: string;
  variant?: ButtonVariant;
  disabled?: boolean;
  url?: string;
}

export function btn(label: string, cardAction: CardAction, options: ButtonOptions = {}): CardButton {
  return cloneButton({
    label,
    action: cardAction,
    ...(options.id === undefined ? {} : { id: options.id }),
    ...(options.icon === undefined ? {} : { icon: options.icon }),
    ...(options.variant === undefined ? {} : { variant: options.variant }),
    ...(options.disabled === undefined ? {} : { disabled: options.disabled }),
    ...(options.url === undefined ? {} : { url: options.url }),
  });
}

export function linkBtn(label: string, url: string, options: ButtonOptions = {}): CardButton {
  return btn(label, action.none(), { ...options, url });
}

export function md(content: string, collapsed = false): CardSection {
  return { kind: 'markdown', content, ...(collapsed ? { collapsed: true } : {}) };
}
export function divider(): CardSection { return { kind: 'divider' }; }
export function note(text: string): CardSection { return { kind: 'note', text }; }
export function buttons(values: CardButton[], layout: ButtonLayout = 'inline'): CardSection {
  return { kind: 'buttonRow', buttons: values.map(cloneButton), layout };
}
export function kv(items: Array<{ label: string; value: string; icon?: string }>): CardSection {
  return cloneSection({ kind: 'keyValue', items });
}
export function select(placeholder: string, options: SelectOption[], cardAction: CardAction): CardSection {
  return cloneSection({ kind: 'select', placeholder, options, action: cardAction });
}
export function input(
  placeholder: string,
  options: { label?: string; multiline?: boolean; submitButton?: CardButton } = {},
): InputSection {
  return cloneSection({ kind: 'input', placeholder, ...options }) as InputSection;
}
export function image(src: string, alt?: string, url?: string): CardSection {
  return cloneSection({ kind: 'image', src, ...(alt === undefined ? {} : { alt }), ...(url === undefined ? {} : { url }) });
}
export function table(
  columns: Array<{ key: string; label: string; width?: number }>,
  rows: Array<Record<string, string>>,
): CardSection {
  return cloneSection({ kind: 'table', columns, rows });
}
export function permission(inputValue: Omit<PermissionSection, 'kind'>): PermissionSection {
  return cloneSection({ kind: 'permission', ...inputValue }) as PermissionSection;
}
export function question(inputValue: Omit<QuestionSection, 'kind'>): QuestionSection {
  return cloneSection({ kind: 'question', ...inputValue }) as QuestionSection;
}
export function progress(inputValue: Omit<ProgressSection, 'kind'> = {}): ProgressSection {
  return cloneSection({ kind: 'progress', ...inputValue }) as ProgressSection;
}
export function statusReport(inputValue: Omit<StatusReportSection, 'kind'>): StatusReportSection {
  return cloneSection({ kind: 'statusReport', ...inputValue }) as StatusReportSection;
}
export function sessionList(inputValue: Omit<SessionListSection, 'kind'>): SessionListSection {
  return cloneSection({ kind: 'sessionList', ...inputValue }) as SessionListSection;
}
export function commandPalette(inputValue: Omit<CommandPaletteSection, 'kind'>): CommandPaletteSection {
  return cloneSection({ kind: 'commandPalette', ...inputValue }) as CommandPaletteSection;
}

function safeTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function envelopeWithinTarget(value: unknown): boolean {
  return Buffer.byteLength(JSON.stringify(value), 'utf8') <= 9_000;
}

export function buildCardMessage(model: CardModel, timestamp: number): CardMessageEnvelope {
  const validated = validateCard(model);
  if (!validated.ok || !safeTimestamp(timestamp)) throw new TypeError('Invalid card_message input');
  const envelope: CardMessageEnvelope = {
    msg_type: 'card_message',
    schema: CARD_SCHEMA_VERSION,
    card: validated.value,
    timestamp,
  };
  if (!envelopeWithinTarget(envelope)) throw new RangeError('card_message exceeds the 9000-byte builder target');
  return envelope;
}

export function buildCardUpdate(cardId: string, model: CardModel, timestamp: number): CardUpdateEnvelope {
  const validated = validateCard(model);
  if (!validated.ok || cardId !== validated.value.id || !safeTimestamp(timestamp)) {
    throw new TypeError('cardId must match a valid card_update model');
  }
  const envelope: CardUpdateEnvelope = {
    msg_type: 'card_update',
    cardId,
    card: validated.value,
    timestamp,
  };
  if (!envelopeWithinTarget(envelope)) throw new RangeError('card_update exceeds the 9000-byte builder target');
  return envelope;
}
