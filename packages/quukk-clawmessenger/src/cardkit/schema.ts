/**
 * Adapted under MIT from CardKit schemas in
 * quukk/codex-clawmessenger@3f3a2e4d6a8cb143a0088350aed2e1b4d1675473
 * (`src/cardkit/schema.ts`) and
 * quukk/clawmessenger@a50f2393213f6f1c42da139491d2fe20937e7c7a
 * (`src/cardkit/schema.ts`). See THIRD_PARTY_NOTICES.md.
 */

export const CARD_SCHEMA_VERSION = '1.0.0' as const;

export const ACTION_TYPES = [
  'permission', 'answer', 'command', 'session', 'navigate', 'custom', 'none',
] as const;

export const SECTION_KINDS = [
  'markdown', 'divider', 'note', 'buttonRow', 'keyValue', 'select', 'input', 'image', 'table',
  'permission', 'question', 'progress', 'statusReport', 'sessionList', 'commandPalette',
] as const;

export type CardColor =
  | 'default' | 'blue' | 'green' | 'turquoise' | 'orange' | 'red' | 'grey' | 'purple';
export type ButtonVariant = 'primary' | 'default' | 'danger' | 'success' | 'text';
export type ButtonLayout = 'inline' | 'flow' | 'stack';

export type CardAction =
  | { type: 'permission'; permissionId: string; reply: 'once' | 'always' | 'reject' }
  | { type: 'answer'; questionId: string; value: string[] }
  | { type: 'command'; name: string }
  | { type: 'session'; op: 'switch' | 'delete'; sessionId: string }
  | { type: 'navigate'; target: string }
  | { type: 'custom'; kind: string; payload: Record<string, unknown> }
  | { type: 'none' };

export interface CardButton {
  id?: string;
  label: string;
  icon?: string;
  variant?: ButtonVariant;
  disabled?: boolean;
  action: CardAction;
  url?: string;
}

export interface MarkdownSection { kind: 'markdown'; content: string; collapsed?: boolean }
export interface DividerSection { kind: 'divider' }
export interface NoteSection { kind: 'note'; text: string }
export interface ButtonRowSection { kind: 'buttonRow'; buttons: CardButton[]; layout?: ButtonLayout }
export interface KeyValueSection {
  kind: 'keyValue';
  items: Array<{ label: string; value: string; icon?: string }>;
}
export interface SelectOption { label: string; value: string }
export interface SelectSection {
  kind: 'select';
  placeholder: string;
  options: SelectOption[];
  action: CardAction;
}
export interface InputSection {
  kind: 'input';
  placeholder: string;
  label?: string;
  multiline?: boolean;
  submitButton?: CardButton;
}
export interface ImageSection { kind: 'image'; src: string; alt?: string; url?: string }
export interface TableSection {
  kind: 'table';
  columns: Array<{ key: string; label: string; width?: number }>;
  rows: Array<Record<string, string>>;
}
export interface PermissionSection {
  kind: 'permission';
  permissionId: string;
  permission: string;
  title: string;
  patterns: string[];
  buttons?: CardButton[];
}
export interface QuestionSection {
  kind: 'question';
  questionId: string;
  header: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiple?: boolean;
  custom?: boolean;
}
export interface ProgressSection {
  kind: 'progress';
  tools?: Array<{ name: string; status: 'running' | 'completed' | 'error'; error?: string }>;
  thinking?: string;
  elapsedMs?: number;
  done?: boolean;
}
export interface StatusReportSection {
  kind: 'statusReport';
  branch?: string;
  commit?: string;
  files?: Array<{ path: string; status: string }>;
}
export interface SessionListSection {
  kind: 'sessionList';
  currentSessionId?: string;
  sessions: Array<{ id: string; title: string; updatedAt?: number }>;
}
export interface CommandPaletteSection {
  kind: 'commandPalette';
  title?: string;
  commands?: Array<{ name: string; description?: string }>;
  groups?: Array<{
    label: string;
    collapsed?: boolean;
    items: Array<{ name: string; description?: string }>;
  }>;
}

export type CardSection =
  | MarkdownSection | DividerSection | NoteSection | ButtonRowSection | KeyValueSection
  | SelectSection | InputSection | ImageSection | TableSection | PermissionSection
  | QuestionSection | ProgressSection | StatusReportSection | SessionListSection
  | CommandPaletteSection;

export interface CardModel {
  schema: typeof CARD_SCHEMA_VERSION;
  id: string;
  header: { title: string; icon?: string; color?: CardColor; subtitle?: string };
  sections: CardSection[];
  config?: { wide?: boolean; collapsible?: boolean };
  reasoning?: string;
  loading?: boolean;
}

export interface CardMessageEnvelope {
  msg_type: 'card_message';
  schema: typeof CARD_SCHEMA_VERSION;
  card: CardModel;
  timestamp: number;
}

export interface CardUpdateEnvelope {
  msg_type: 'card_update';
  cardId: string;
  card: CardModel;
  timestamp: number;
}
