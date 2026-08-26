/**
 * Adapted under MIT from CardKit validation contracts in
 * quukk/codex-clawmessenger@3f3a2e4d6a8cb143a0088350aed2e1b4d1675473
 * (`src/cardkit/validate.ts`) and
 * quukk/clawmessenger@a50f2393213f6f1c42da139491d2fe20937e7c7a
 * (`src/cardkit/validate.ts`). This validator is a fresh-object hardened
 * implementation. See THIRD_PARTY_NOTICES.md.
 */

import { isProxy } from 'node:util/types';

import {
  CARD_SCHEMA_VERSION,
  type CardAction,
  type CardButton,
  type CardModel,
  type CardSection,
} from './schema.js';

export const CARD_HARD_BYTE_LIMIT = 10 * 1024;

export type CardValidationResult =
  | { ok: true; value: CardModel; warnings: string[] }
  | { ok: false; code: 'invalid_card' | 'card_too_large'; errors: string[] };

const invalid = Symbol('invalid');
const dangerousKeys = new Set(['__proto__', 'prototype', 'constructor']);
const colors = new Set(['default', 'blue', 'green', 'turquoise', 'orange', 'red', 'grey', 'purple']);
const buttonVariants = new Set(['primary', 'default', 'danger', 'success', 'text']);
const buttonLayouts = new Set(['inline', 'flow', 'stack']);
const forbiddenTextControls = /[\p{Cc}\p{Cf}]/gu;

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function read(value: Record<string, unknown>, key: string): unknown | typeof invalid {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return undefined;
    return Object.prototype.hasOwnProperty.call(descriptor, 'value') ? descriptor.value : invalid;
  } catch {
    return invalid;
  }
}

function allowedText(value: unknown, max: number, allowEmpty = false): value is string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && value.length === 0)) return false;
  forbiddenTextControls.lastIndex = 0;
  for (const match of value.matchAll(forbiddenTextControls)) {
    if (match[0] !== '\t' && match[0] !== '\n' && match[0] !== '\r') return false;
  }
  return true;
}

function identifier(value: unknown, max = 128): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= max
    && value.trim() === value
    && !/[\p{Cc}\p{Cf}]/u.test(value);
}

function safeInteger(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

function safeBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function httpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2_048) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '';
  } catch {
    return false;
  }
}

interface JsonBudget { keys: number }

function plainArray(value: unknown, maximum: number): value is unknown[] {
  try {
    if (!Array.isArray(value) || isProxy(value) || value.length > maximum) return false;
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function mapPlain<T>(value: unknown[], mapper: (item: unknown, index: number) => T): T[] {
  const output: T[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new TypeError('active array element');
    }
    output.push(mapper(descriptor.value, index));
  }
  return output;
}

function everyPlain(value: unknown[], predicate: (item: unknown, index: number) => boolean): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      || !predicate(descriptor.value, index)) return false;
  }
  return true;
}

function cloneJson(
  value: unknown,
  budget: JsonBudget,
  depth: number,
): unknown | typeof invalid {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : invalid;
  if (typeof value === 'string') return allowedText(value, 4_096, true) ? value : invalid;
  if (depth > 8) return invalid;
  if (Array.isArray(value)) {
    if (!plainArray(value, 64)) return invalid;
    const output: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      } catch {
        return invalid;
      }
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return invalid;
      const item = cloneJson(descriptor.value, budget, depth + 1);
      if (item === invalid) return invalid;
      output.push(item);
    }
    return output;
  }
  if (!record(value)) return invalid;
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    return invalid;
  }
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    if (dangerousKeys.has(key)) continue;
    budget.keys += 1;
    if (budget.keys > 64 || !identifier(key, 256)) return invalid;
    const raw = read(value, key);
    if (raw === invalid) return invalid;
    const item = cloneJson(raw, budget, depth + 1);
    if (item === invalid) return invalid;
    output[key] = item;
  }
  return output;
}

export function sanitizeCustomPayload(value: unknown): Record<string, unknown> | null {
  if (!record(value)) return null;
  const cloned = cloneJson(value, { keys: 0 }, 0);
  if (!record(cloned)) return null;
  try {
    return Buffer.byteLength(JSON.stringify(cloned), 'utf8') <= 4_096 ? cloned : null;
  } catch {
    return null;
  }
}

function sanitizeAction(value: unknown): CardAction | null {
  if (!record(value)) return null;
  const type = read(value, 'type');
  if (type === 'permission') {
    const permissionId = read(value, 'permissionId');
    const reply = read(value, 'reply');
    return identifier(permissionId) && (reply === 'once' || reply === 'always' || reply === 'reject')
      ? { type, permissionId, reply }
      : null;
  }
  if (type === 'answer') {
    const questionId = read(value, 'questionId');
    const selected = read(value, 'value');
    return identifier(questionId)
      && plainArray(selected, 50)
      && everyPlain(selected, (item) => allowedText(item, 1_000))
      ? { type, questionId, value: mapPlain(selected, (item) => item as string) }
      : null;
  }
  if (type === 'command') {
    const name = read(value, 'name');
    return allowedText(name, 256) ? { type, name } : null;
  }
  if (type === 'session') {
    const op = read(value, 'op');
    const sessionId = read(value, 'sessionId');
    return (op === 'switch' || op === 'delete') && identifier(sessionId)
      ? { type, op, sessionId }
      : null;
  }
  if (type === 'navigate') {
    const target = read(value, 'target');
    return identifier(target, 256) ? { type, target } : null;
  }
  if (type === 'custom') {
    const kind = read(value, 'kind');
    const payload = sanitizeCustomPayload(read(value, 'payload'));
    return identifier(kind) && payload ? { type, kind, payload } : null;
  }
  return type === 'none' ? { type } : null;
}

function sanitizeButton(value: unknown): CardButton | null {
  if (!record(value)) return null;
  const label = read(value, 'label');
  const action = sanitizeAction(read(value, 'action'));
  if (!allowedText(label, 1_000) || !action) return null;
  const result: CardButton = { label, action };
  const id = read(value, 'id');
  if (id !== undefined) {
    if (!identifier(id)) return null;
    result.id = id;
  }
  const icon = read(value, 'icon');
  if (icon !== undefined) {
    if (!allowedText(icon, 256)) return null;
    result.icon = icon;
  }
  const variant = read(value, 'variant');
  if (variant !== undefined) {
    if (typeof variant !== 'string' || !buttonVariants.has(variant)) return null;
    result.variant = variant as CardButton['variant'];
  }
  const disabled = read(value, 'disabled');
  if (disabled !== undefined) {
    if (!safeBoolean(disabled)) return null;
    result.disabled = disabled;
  }
  const url = read(value, 'url');
  if (url !== undefined) {
    if (!httpsUrl(url)) return null;
    result.url = url;
  }
  return result;
}

function boundedArray(value: unknown, maximum: number): value is unknown[] {
  return plainArray(value, maximum);
}

function stringItem(value: unknown, fields: readonly string[]): Record<string, string> | null {
  if (!record(value)) return null;
  const output: Record<string, string> = {};
  for (const field of fields) {
    const item = read(value, field);
    if (!allowedText(item, 4_096)) return null;
    output[field] = item;
  }
  return output;
}

function sanitizeSection(value: unknown): CardSection | null {
  if (!record(value)) return null;
  const kind = read(value, 'kind');
  if (kind === 'markdown') {
    const content = read(value, 'content');
    const collapsed = read(value, 'collapsed');
    if (!allowedText(content, 20_000, true) || (collapsed !== undefined && !safeBoolean(collapsed))) return null;
    return { kind, content, ...(collapsed === undefined ? {} : { collapsed }) };
  }
  if (kind === 'divider') return { kind };
  if (kind === 'note') {
    const text = read(value, 'text');
    return allowedText(text, 4_096, true) ? { kind, text } : null;
  }
  if (kind === 'buttonRow') {
    const buttons = read(value, 'buttons');
    const layout = read(value, 'layout');
    if (!boundedArray(buttons, 10) || buttons.length < 1
      || (layout !== undefined && (typeof layout !== 'string' || !buttonLayouts.has(layout)))) return null;
    const clean = mapPlain(buttons, sanitizeButton);
    return clean.every((button): button is CardButton => button !== null)
      ? { kind, buttons: clean, ...(layout === undefined ? {} : { layout: layout as 'inline' | 'flow' | 'stack' }) }
      : null;
  }
  if (kind === 'keyValue') {
    const items = read(value, 'items');
    if (!boundedArray(items, 50)) return null;
    const clean = mapPlain(items, (item) => {
      if (!record(item)) return null;
      const label = read(item, 'label');
      const itemValue = read(item, 'value');
      const icon = read(item, 'icon');
      if (!allowedText(label, 1_000) || !allowedText(itemValue, 4_096, true)
        || (icon !== undefined && !allowedText(icon, 256))) return null;
      return { label, value: itemValue, ...(icon === undefined ? {} : { icon }) };
    });
    return clean.every((item): item is NonNullable<typeof item> => item !== null)
      ? { kind, items: clean }
      : null;
  }
  if (kind === 'select') {
    const placeholder = read(value, 'placeholder');
    const options = read(value, 'options');
    const action = sanitizeAction(read(value, 'action'));
    if (!allowedText(placeholder, 1_000) || !boundedArray(options, 50) || !action) return null;
    const clean = mapPlain(options, (option) => stringItem(option, ['label', 'value']));
    return clean.every((option): option is NonNullable<typeof option> => option !== null)
      ? { kind, placeholder, options: clean as Array<{ label: string; value: string }>, action }
      : null;
  }
  if (kind === 'input') {
    const placeholder = read(value, 'placeholder');
    const label = read(value, 'label');
    const multiline = read(value, 'multiline');
    const rawButton = read(value, 'submitButton');
    const submitButton = rawButton === undefined ? undefined : sanitizeButton(rawButton);
    if (!allowedText(placeholder, 1_000)
      || (label !== undefined && !allowedText(label, 1_000))
      || (multiline !== undefined && !safeBoolean(multiline))
      || (rawButton !== undefined && !submitButton)) return null;
    return {
      kind,
      placeholder,
      ...(label === undefined ? {} : { label }),
      ...(multiline === undefined ? {} : { multiline }),
      ...(rawButton === undefined ? {} : { submitButton: submitButton! }),
    };
  }
  if (kind === 'image') {
    const src = read(value, 'src');
    const alt = read(value, 'alt');
    const url = read(value, 'url');
    if (!httpsUrl(src)
      || (alt !== undefined && !allowedText(alt, 1_000, true))
      || (url !== undefined && !httpsUrl(url))) return null;
    return { kind, src, ...(alt === undefined ? {} : { alt }), ...(url === undefined ? {} : { url }) };
  }
  if (kind === 'table') {
    const columns = read(value, 'columns');
    const rows = read(value, 'rows');
    if (!boundedArray(columns, 16) || columns.length < 1 || !boundedArray(rows, 10)) return null;
    const cleanColumns = mapPlain(columns, (column) => {
      if (!record(column)) return null;
      const key = read(column, 'key');
      const label = read(column, 'label');
      const width = read(column, 'width');
      if (!identifier(key, 128) || !allowedText(label, 1_000)
        || (width !== undefined && !safeInteger(width, 1))) return null;
      return { key, label, ...(width === undefined ? {} : { width }) };
    });
    if (!cleanColumns.every((column): column is NonNullable<typeof column> => column !== null)) return null;
    const cleanRows = mapPlain(rows, (row) => {
      if (!record(row)) return null;
      const output: Record<string, string> = {};
      for (const { key } of cleanColumns) {
        const cell = read(row, key);
        if (cell === undefined) continue;
        if (!allowedText(cell, 4_096, true)) return null;
        output[key] = cell;
      }
      return output;
    });
    return cleanRows.every((row): row is Record<string, string> => row !== null)
      ? { kind, columns: cleanColumns, rows: cleanRows }
      : null;
  }
  if (kind === 'permission') {
    const permissionId = read(value, 'permissionId');
    const permission = read(value, 'permission');
    const title = read(value, 'title');
    const patterns = read(value, 'patterns');
    const rawButtons = read(value, 'buttons');
    if (!identifier(permissionId) || !identifier(permission, 256) || !allowedText(title, 1_000)
      || !boundedArray(patterns, 50) || !everyPlain(patterns, (pattern) => allowedText(pattern, 1_000, true))
      || (rawButtons !== undefined && !boundedArray(rawButtons, 10))) return null;
    const buttons = rawButtons === undefined ? undefined : mapPlain(rawButtons, sanitizeButton);
    if (buttons && !buttons.every((button): button is CardButton => button !== null)) return null;
    return {
      kind,
      permissionId,
      permission,
      title,
      patterns: mapPlain(patterns, (pattern) => pattern as string),
      ...(buttons === undefined ? {} : { buttons }),
    };
  }
  if (kind === 'question') {
    const questionId = read(value, 'questionId');
    const header = read(value, 'header');
    const question = read(value, 'question');
    const options = read(value, 'options');
    const multiple = read(value, 'multiple');
    const custom = read(value, 'custom');
    if (!identifier(questionId) || !allowedText(header, 1_000) || !allowedText(question, 4_096)
      || !boundedArray(options, 50)
      || (multiple !== undefined && !safeBoolean(multiple))
      || (custom !== undefined && !safeBoolean(custom))) return null;
    const clean = mapPlain(options, (option) => {
      if (!record(option)) return null;
      const label = read(option, 'label');
      const description = read(option, 'description');
      if (!allowedText(label, 1_000) || (description !== undefined && !allowedText(description, 2_000, true))) return null;
      return { label, ...(description === undefined ? {} : { description }) };
    });
    return clean.every((option): option is NonNullable<typeof option> => option !== null)
      ? { kind, questionId, header, question, options: clean, ...(multiple === undefined ? {} : { multiple }), ...(custom === undefined ? {} : { custom }) }
      : null;
  }
  if (kind === 'progress') {
    const rawTools = read(value, 'tools');
    const thinking = read(value, 'thinking');
    const elapsedMs = read(value, 'elapsedMs');
    const done = read(value, 'done');
    if ((rawTools !== undefined && !boundedArray(rawTools, 50))
      || (thinking !== undefined && !allowedText(thinking, 10_000, true))
      || (elapsedMs !== undefined && !safeInteger(elapsedMs))
      || (done !== undefined && !safeBoolean(done))) return null;
    const tools = rawTools === undefined ? undefined : mapPlain(rawTools, (tool) => {
      if (!record(tool)) return null;
      const name = read(tool, 'name');
      const status = read(tool, 'status');
      const error = read(tool, 'error');
      if (!allowedText(name, 1_000)
        || (status !== 'running' && status !== 'completed' && status !== 'error')
        || (error !== undefined && !allowedText(error, 2_000, true))) return null;
      return {
        name,
        status: status as 'running' | 'completed' | 'error',
        ...(error === undefined ? {} : { error }),
      };
    });
    if (tools && !tools.every((tool): tool is NonNullable<typeof tool> => tool !== null)) return null;
    return { kind, ...(tools === undefined ? {} : { tools }), ...(thinking === undefined ? {} : { thinking }), ...(elapsedMs === undefined ? {} : { elapsedMs }), ...(done === undefined ? {} : { done }) };
  }
  if (kind === 'statusReport') {
    const branch = read(value, 'branch');
    const commit = read(value, 'commit');
    const rawFiles = read(value, 'files');
    if ((branch !== undefined && !allowedText(branch, 1_000, true))
      || (commit !== undefined && !allowedText(commit, 256, true))
      || (rawFiles !== undefined && !boundedArray(rawFiles, 50))) return null;
    const files = rawFiles === undefined
      ? undefined
      : mapPlain(rawFiles, (file) => stringItem(file, ['path', 'status']));
    if (files && !files.every((file): file is NonNullable<typeof file> => file !== null)) return null;
    return { kind, ...(branch === undefined ? {} : { branch }), ...(commit === undefined ? {} : { commit }), ...(files === undefined ? {} : { files: files as Array<{ path: string; status: string }> }) };
  }
  if (kind === 'sessionList') {
    const currentSessionId = read(value, 'currentSessionId');
    const sessions = read(value, 'sessions');
    if ((currentSessionId !== undefined && !identifier(currentSessionId)) || !boundedArray(sessions, 20)) return null;
    const clean = mapPlain(sessions, (session) => {
      if (!record(session)) return null;
      const id = read(session, 'id');
      const title = read(session, 'title');
      const updatedAt = read(session, 'updatedAt');
      if (!identifier(id) || !allowedText(title, 1_000) || (updatedAt !== undefined && !safeInteger(updatedAt))) return null;
      return { id, title, ...(updatedAt === undefined ? {} : { updatedAt }) };
    });
    return clean.every((session): session is NonNullable<typeof session> => session !== null)
      ? { kind, ...(currentSessionId === undefined ? {} : { currentSessionId }), sessions: clean }
      : null;
  }
  if (kind === 'commandPalette') {
    const title = read(value, 'title');
    const commands = read(value, 'commands');
    const groups = read(value, 'groups');
    if ((title !== undefined && !allowedText(title, 1_000))
      || (commands === undefined) === (groups === undefined)) return null;
    if (commands !== undefined) {
      if (!boundedArray(commands, 20)) return null;
      const clean = mapPlain(commands, (command) => {
        if (!record(command)) return null;
        const name = read(command, 'name');
        const description = read(command, 'description');
        if (!allowedText(name, 256) || (description !== undefined && !allowedText(description, 2_000, true))) return null;
        return { name, ...(description === undefined ? {} : { description }) };
      });
      return clean.every((command): command is NonNullable<typeof command> => command !== null)
        ? { kind, ...(title === undefined ? {} : { title }), commands: clean }
        : null;
    }
    if (!boundedArray(groups, 20)) return null;
    let total = 0;
    const cleanGroups = mapPlain(groups, (group) => {
      if (!record(group)) return null;
      const label = read(group, 'label');
      const collapsed = read(group, 'collapsed');
      const items = read(group, 'items');
      if (!allowedText(label, 1_000) || (collapsed !== undefined && !safeBoolean(collapsed))
        || !boundedArray(items, 20)) return null;
      total += items.length;
      if (total > 20) return null;
      const cleanItems = mapPlain(items, (command) => {
        if (!record(command)) return null;
        const name = read(command, 'name');
        const description = read(command, 'description');
        if (!allowedText(name, 256) || (description !== undefined && !allowedText(description, 2_000, true))) return null;
        return { name, ...(description === undefined ? {} : { description }) };
      });
      return cleanItems.every((command): command is NonNullable<typeof command> => command !== null)
        ? { label, ...(collapsed === undefined ? {} : { collapsed }), items: cleanItems }
        : null;
    });
    return cleanGroups.every((group): group is NonNullable<typeof group> => group !== null)
      ? { kind, ...(title === undefined ? {} : { title }), groups: cleanGroups }
      : null;
  }
  return null;
}

function invalidCard(reason: string): CardValidationResult {
  return { ok: false, code: 'invalid_card', errors: [reason] };
}

export function validateCard(value: unknown): CardValidationResult {
  try {
    if (!record(value)) return invalidCard('card must be a plain object');
    const schema = read(value, 'schema');
    const id = read(value, 'id');
    const rawHeader = read(value, 'header');
    const rawSections = read(value, 'sections');
    if (schema !== CARD_SCHEMA_VERSION || !identifier(id) || !record(rawHeader)
      || !boundedArray(rawSections, 64)) return invalidCard('invalid card envelope');
    const title = read(rawHeader, 'title');
    const icon = read(rawHeader, 'icon');
    const color = read(rawHeader, 'color');
    const subtitle = read(rawHeader, 'subtitle');
    if (!allowedText(title, 1_000)
      || (icon !== undefined && !allowedText(icon, 256))
      || (color !== undefined && (typeof color !== 'string' || !colors.has(color)))
      || (subtitle !== undefined && !allowedText(subtitle, 2_000, true))) return invalidCard('invalid card header');
    const sections = mapPlain(rawSections, sanitizeSection);
    if (!sections.every((section): section is CardSection => section !== null)) {
      return invalidCard('invalid card section');
    }
    const output: CardModel = {
      schema: CARD_SCHEMA_VERSION,
      id,
      header: {
        title,
        ...(icon === undefined ? {} : { icon }),
        ...(color === undefined ? {} : { color: color as CardModel['header']['color'] }),
        ...(subtitle === undefined ? {} : { subtitle }),
      },
      sections,
    };
    const rawConfig = read(value, 'config');
    if (rawConfig !== undefined) {
      if (!record(rawConfig)) return invalidCard('invalid card config');
      const wide = read(rawConfig, 'wide');
      const collapsible = read(rawConfig, 'collapsible');
      if ((wide !== undefined && !safeBoolean(wide))
        || (collapsible !== undefined && !safeBoolean(collapsible))) return invalidCard('invalid card config');
      output.config = {
        ...(wide === undefined ? {} : { wide }),
        ...(collapsible === undefined ? {} : { collapsible }),
      };
    }
    const reasoning = read(value, 'reasoning');
    if (reasoning !== undefined) {
      if (!allowedText(reasoning, 20_000, true)) return invalidCard('invalid reasoning');
      output.reasoning = reasoning;
    }
    const loading = read(value, 'loading');
    if (loading !== undefined) {
      if (!safeBoolean(loading)) return invalidCard('invalid loading state');
      output.loading = loading;
    }
    if (Buffer.byteLength(JSON.stringify(output), 'utf8') > CARD_HARD_BYTE_LIMIT) {
      return { ok: false, code: 'card_too_large', errors: ['card exceeds 10 KiB'] };
    }
    return { ok: true, value: output, warnings: [] };
  } catch {
    return invalidCard('card validation failed safely');
  }
}
