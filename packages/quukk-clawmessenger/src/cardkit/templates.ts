/**
 * Adapted under MIT from deterministic CardKit compositions in
 * quukk/clawmessenger@a50f2393213f6f1c42da139491d2fe20937e7c7a
 * (`src/cardkit/templates.ts`). IDs are explicit and permission UI is replaced
 * with a non-interactive notice. See THIRD_PARTY_NOTICES.md.
 */

import {
  action,
  btn,
  buttons,
  card,
  divider,
  kv,
  md,
  note,
} from './builders.js';
import type { CardColor, CardModel, CardSection } from './schema.js';

export function permissionUnsupportedCard(
  cardId: string,
  input: { permissionId: string; permission: string; title: string; patterns: string[] },
): CardModel {
  return card(cardId, 'Interactive approval unavailable', [
    kv([
      { label: 'Permission', value: input.permission },
      { label: 'Request', value: input.permissionId },
    ]),
    note(input.title),
    note(input.patterns.slice(0, 50).join('\n')),
    note('unsupported_interactive_approval'),
  ], { color: 'orange' });
}

export function errorCard(cardId: string, message: string): CardModel {
  return card(cardId, 'Error', [note(message)], { color: 'red' });
}

export function noticeCard(
  cardId: string,
  title: string,
  body: string,
  options: { color?: CardColor; icon?: string } = {},
): CardModel {
  return card(cardId, title, [md(body)], options);
}

export function statusCard(
  cardId: string,
  status: { branch?: string; commit?: string; files?: Array<{ path: string; status: string }> },
): CardModel {
  const sections: CardSection[] = [
    kv([
      { label: 'Branch', value: status.branch ?? 'unknown' },
      { label: 'Commit', value: status.commit?.slice(0, 12) ?? 'none' },
    ]),
  ];
  if (status.files?.length) {
    sections.push(divider());
    sections.push(md(status.files.slice(0, 20).map((file) => `${file.status} ${file.path}`).join('\n')));
  } else {
    sections.push(note('No changed files'));
  }
  return card(cardId, 'Project status', sections, { color: 'blue' });
}

export function sessionsCard(
  cardId: string,
  sessions: Array<{ id: string; title: string; updatedAt?: number }>,
  currentSessionId?: string,
): CardModel {
  const sections: CardSection[] = sessions.slice(0, 20).map((session) => buttons(
    session.id === currentSessionId
      ? [btn(`Current: ${session.title}`, action.none(), { disabled: true })]
      : [
        btn(`Switch: ${session.title}`, action.session('switch', session.id), { variant: 'primary' }),
        btn('Delete', action.session('delete', session.id), { variant: 'danger' }),
      ],
  ));
  if (sections.length === 0) sections.push(note('No sessions'));
  return card(cardId, 'Sessions', sections);
}

export function commandsCard(
  cardId: string,
  commands: Array<{ name: string; description?: string }>,
): CardModel {
  const sections = commands.slice(0, 20).map((command) => buttons([
    btn(command.description ? `${command.name} — ${command.description}` : command.name, action.command(command.name)),
  ]));
  if (sections.length === 0) sections.push(note('No commands'));
  return card(cardId, 'Commands', sections);
}
