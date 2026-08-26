/**
 * Adapted under MIT from the balanced marker protocol in
 * quukk/clawmessenger@a50f2393213f6f1c42da139491d2fe20937e7c7a
 * (`src/cardkit/parse-marker.ts`). This implementation adds bounded roots,
 * count limits, and fail-closed streaming. See THIRD_PARTY_NOTICES.md.
 */

export const CARD_MARKER_BYTE_LIMIT = 10 * 1024;
export const MAX_CARD_MARKERS = 16;
export const INVALID_CARD_MARKER_TEXT = '[invalid card marker]';

export type CardMarkerError =
  | 'invalid_marker'
  | 'incomplete_marker'
  | 'marker_too_large'
  | 'too_many_markers';

export interface CardMarkerParseResult {
  text: string;
  cards: Array<Record<string, unknown>>;
  commands: unknown[][];
  errors: CardMarkerError[];
}

interface Opener {
  tag: 'CARD' | 'COMMANDS';
  value: '[CARD][' | '[COMMANDS][';
  root: '{' | '[';
}

interface ScanResult {
  end: number;
  complete: boolean;
  oversized: boolean;
}

const openers: readonly Opener[] = [
  { tag: 'CARD', value: '[CARD][', root: '{' },
  { tag: 'COMMANDS', value: '[COMMANDS][', root: '[' },
];

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function earliestOpener(text: string, from: number): { opener: Opener; index: number } | null {
  let selected: { opener: Opener; index: number } | null = null;
  for (const opener of openers) {
    const index = text.indexOf(opener.value, from);
    if (index >= 0 && (selected === null || index < selected.index)) selected = { opener, index };
  }
  return selected;
}

function matchingClose(value: string): string {
  return value === '{' ? '}' : ']';
}

function scanJson(text: string, start: number): ScanResult {
  const first = text[start];
  if (first !== '{' && first !== '[') return { end: start, complete: false, oversized: false };
  const stack = [matchingClose(first)];
  let inString = false;
  let escaped = false;
  let bytes = 0;
  let oversized = false;
  for (let index = start; index < text.length;) {
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) break;
    const width = codePoint > 0xffff ? 2 : 1;
    const character = text.slice(index, index + width);
    bytes += Buffer.byteLength(character, 'utf8');
    if (bytes > CARD_MARKER_BYTE_LIMIT) oversized = true;

    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      index += width;
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === '{' || character === '[') {
      if (index !== start) stack.push(matchingClose(character));
    } else if (character === '}' || character === ']') {
      if (stack.at(-1) !== character) return { end: index + width, complete: true, oversized };
      stack.pop();
      if (stack.length === 0) return { end: index + width, complete: true, oversized };
    }
    index += width;
  }
  return { end: text.length, complete: false, oversized };
}

function trailingOpenerPrefix(text: string): number {
  let longest = 0;
  for (const { value } of openers) {
    for (let length = 1; length < value.length && length <= text.length; length += 1) {
      if (text.endsWith(value.slice(0, length))) longest = Math.max(longest, length);
    }
  }
  return longest;
}

function parse(text: string, final: boolean): CardMarkerParseResult {
  const cards: Array<Record<string, unknown>> = [];
  const commands: unknown[][] = [];
  const errors: CardMarkerError[] = [];
  let markerCount = 0;
  let cursor = 0;
  let output = '';

  while (cursor < text.length) {
    const found = earliestOpener(text, cursor);
    if (!found) {
      const tail = text.slice(cursor);
      const partial = trailingOpenerPrefix(tail);
      if (partial === 0) output += tail;
      else {
        output += tail.slice(0, -partial);
        if (final) {
          output += INVALID_CARD_MARKER_TEXT;
          errors.push('incomplete_marker');
        }
      }
      break;
    }

    output += text.slice(cursor, found.index);
    const jsonStart = found.index + found.opener.value.length;
    if (jsonStart >= text.length) {
      if (final) {
        output += INVALID_CARD_MARKER_TEXT;
        errors.push('incomplete_marker');
      }
      break;
    }

    const scan = scanJson(text, jsonStart);
    if (!scan.complete) {
      if (final) {
        output += INVALID_CARD_MARKER_TEXT;
        errors.push(scan.oversized ? 'marker_too_large' : 'incomplete_marker');
      }
      break;
    }
    const markerEnd = text[scan.end] === ']' ? scan.end + 1 : text.length;
    const hasMarkerClose = text[scan.end] === ']';
    const rawJson = text.slice(jsonStart, scan.end);
    markerCount += 1;
    let parsed: unknown;
    let valid = hasMarkerClose && text[jsonStart] === found.opener.root && !scan.oversized;
    if (valid) {
      try {
        parsed = JSON.parse(rawJson);
      } catch {
        valid = false;
      }
    }
    if (valid) {
      valid = found.opener.tag === 'CARD' ? record(parsed) : Array.isArray(parsed);
    }
    if (markerCount > MAX_CARD_MARKERS) {
      output += INVALID_CARD_MARKER_TEXT;
      errors.push('too_many_markers');
    } else if (!valid) {
      output += INVALID_CARD_MARKER_TEXT;
      errors.push(scan.oversized ? 'marker_too_large' : 'invalid_marker');
    } else if (found.opener.tag === 'CARD') {
      cards.push(parsed as Record<string, unknown>);
    } else {
      commands.push(parsed as unknown[]);
    }
    cursor = markerEnd;
  }

  return { text: output, cards, commands, errors };
}

export function parseCardMarkers(text: string): CardMarkerParseResult {
  return parse(text, true);
}

export function stripMarkers(text: string): string {
  return parseCardMarkers(text).text;
}

export function streamSafeContent(cumulativeText: string): string {
  return parse(cumulativeText, false).text;
}

export class CardMarkerStream {
  #buffer = '';

  push(chunk: string): CardMarkerParseResult {
    this.#buffer += chunk;
    return parse(this.#buffer, false);
  }

  finish(): CardMarkerParseResult {
    return parse(this.#buffer, true);
  }
}
