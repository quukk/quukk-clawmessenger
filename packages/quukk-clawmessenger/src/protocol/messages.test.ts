// @vitest-environment node

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  EXTERNAL_MESSAGE_TYPES,
  MAX_RONGCLOUD_MESSAGE_BYTES,
  buildLegacyEnvelope,
  normalizeRongCloudMessage,
  parseProtocolContent,
  parseSlashCommand,
} from './messages.js';

const baseMessage = {
  messageUId: 'message-1',
  senderUserId: 'user-1',
  targetId: 'node-1',
  conversationType: 1,
  messageType: 'command',
};

const contentFixture = JSON.parse(readFileSync(
  new URL('./fixtures/rongcloud-content-shapes.json', import.meta.url),
  'utf8',
)) as {
  base: Record<string, unknown>;
  cases: Array<{
    name: string;
    content: unknown;
    expected: Record<string, unknown>;
  }>;
};

describe('normalizeRongCloudMessage', () => {
  it.each(contentFixture.cases)('matches shared RongCloud content fixture: $name', ({ content, expected }) => {
    expect(normalizeRongCloudMessage({ ...contentFixture.base, content }))
      .toMatchObject({ ok: true, value: expected });
  });

  it.each([
    ['plain text', 'hello', 'hello'],
    ['content object', { content: 'hello' }, 'hello'],
    ['JSON content', JSON.stringify({ content: 'hello' }), 'hello'],
    ['one nested JSON layer', { content: JSON.stringify({ content: 'hello' }) }, 'hello'],
  ])('normalizes %s without provider state', (_name, content, expected) => {
    const result = normalizeRongCloudMessage({ ...baseMessage, content });

    expect(result).toMatchObject({
      ok: true,
      value: {
        messageUid: 'message-1',
        senderId: 'user-1',
        targetId: 'node-1',
        conversationType: 1,
        objectName: 'command',
        text: expected,
        attachments: [],
      },
    });
  });

  it('maps provider aliases and bounded attachments to one internal shape', () => {
    const result = normalizeRongCloudMessage({
      messageId: 'message-2',
      senderId: 'user-2',
      targetId: 'room-1',
      conversationType: 4,
      objectName: 'RC:TxtMsg',
      sentTime: 123,
      isOffLineMessage: true,
      messageDirection: 2,
      content: {
        content: 'with file',
        attachments: [{ kind: 'file', url: 'https://example.test/a.txt', name: 'a.txt', size: 12 }],
      },
    });

    expect(result).toEqual({
      ok: true,
      value: {
        messageUid: 'message-2',
        senderId: 'user-2',
        targetId: 'room-1',
        conversationType: 4,
        objectName: 'RC:TxtMsg',
        text: 'with file',
        attachments: [{ kind: 'file', url: 'https://example.test/a.txt', name: 'a.txt', size: 12 }],
        rawContent: {
          content: 'with file',
          attachments: [{ kind: 'file', url: 'https://example.test/a.txt', name: 'a.txt', size: 12 }],
        },
        sentTime: 123,
        offline: true,
        direction: 2,
      },
    });
  });

  it('rejects missing identities, control characters, and conflicting aliases', () => {
    expect(normalizeRongCloudMessage({ ...baseMessage, messageUId: undefined, content: 'x' }))
      .toEqual({ ok: false, code: 'missing_message_uid' });
    expect(normalizeRongCloudMessage({ ...baseMessage, senderUserId: 'bad\u0000id', content: 'x' }))
      .toEqual({ ok: false, code: 'invalid_identifier' });
    expect(normalizeRongCloudMessage({
      ...baseMessage,
      messageId: 'different-message',
      content: 'x',
    })).toEqual({ ok: false, code: 'conflicting_alias' });
  });

  it('accepts only numeric RongCloud conversation types 1, 3 and 4', () => {
    for (const conversationType of ['private', 'group', 'chatroom', 0, 2, 5]) {
      expect(normalizeRongCloudMessage({ ...baseMessage, conversationType, content: 'x' }))
        .toEqual({ ok: false, code: 'invalid_conversation_type' });
    }
    for (const conversationType of [1, 3, 4]) {
      expect(normalizeRongCloudMessage({ ...baseMessage, conversationType, content: 'x' }))
        .toMatchObject({ ok: true, value: { conversationType } });
    }
  });

  it('rebuilds raw content as a detached top-level allowlist', () => {
    const content = {
      content: 'hello',
      data: { status: 'before' },
      attachments: [{ kind: 'file', url: 'https://example.test/a.txt', name: 'a.txt' }],
      unexpectedProviderState: { credential: 'must-not-survive' },
    };
    const result = normalizeRongCloudMessage({ ...baseMessage, content });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected normalized message');
    expect(result.value.rawContent).toEqual({
      content: 'hello',
      data: { status: 'before' },
      attachments: [{ kind: 'file', url: 'https://example.test/a.txt', name: 'a.txt' }],
    });
    expect(result.value.rawContent).not.toBe(content);
    content.data.status = 'after';
    content.attachments[0]!.name = 'changed.txt';
    expect(result.value.rawContent).toMatchObject({
      data: { status: 'before' },
      attachments: [{ name: 'a.txt' }],
    });
  });

  it('rejects envelopes over 64 KiB before parsing nested content', () => {
    expect(normalizeRongCloudMessage({
      ...baseMessage,
      content: 'x'.repeat(MAX_RONGCLOUD_MESSAGE_BYTES + 1),
    })).toEqual({ ok: false, code: 'message_too_large' });

    expect(normalizeRongCloudMessage({
      ...baseMessage,
      content: 'x'.repeat(MAX_RONGCLOUD_MESSAGE_BYTES - 1_024),
    }).ok).toBe(true);
  });
});

describe('parseProtocolContent', () => {
  it.each([
    { msg_type: 'device_status_request', request_id: 'request-1' },
    JSON.stringify({ msg_type: 'device_status_request', request_id: 'request-1' }),
    { content: JSON.stringify({ msg_type: 'device_status_request', request_id: 'request-1' }) },
    JSON.stringify({ content: JSON.stringify({ msg_type: 'device_status_request', request_id: 'request-1' }) }),
  ])('recognizes direct and nested protocol content', (content) => {
    expect(parseProtocolContent(content)).toEqual({
      kind: 'protocol',
      msgType: 'device_status_request',
      value: { msg_type: 'device_status_request', request_id: 'request-1' },
    });
  });

  it('canonicalizes legacy aliases but leaves v2 field spelling untouched', () => {
    expect(parseProtocolContent({
      msg_type: 'chatroom_message',
      requestId: 'request-2',
      chatroomId: 'room-2',
      originMessageUId: 'origin-2',
      openclaw_max_rounds: 20,
      content: 'relay',
    })).toEqual({
      kind: 'protocol',
      msgType: 'chatroom_message',
      value: {
        msg_type: 'chatroom_message',
        request_id: 'request-2',
        chatroom_id: 'room-2',
        origin_message_uid: 'origin-2',
        max_rounds: 20,
        content: 'relay',
      },
    });

    const v2 = { msg_type: 'discussion_host_turn', discussion_id: 'not-canonical' };
    expect(parseProtocolContent(v2)).toEqual({
      kind: 'protocol',
      msgType: 'discussion_host_turn',
      value: v2,
    });
  });

  it('rejects conflicting legacy aliases instead of silently choosing one', () => {
    expect(parseProtocolContent({
      msg_type: 'chatroom_invite',
      chatroom_id: 'room-a',
      chatroomId: 'room-b',
    })).toEqual({ kind: 'invalid', code: 'conflicting_alias' });
  });

  it('allows only the existing device-control command vocabulary', () => {
    for (const command of ['status', 'disable', 'stop', 'enable', 'start', 'delete', 'restart', 'rename_device']) {
      expect(parseProtocolContent({ msg_type: 'device_control', command }))
        .toEqual({ kind: 'protocol', msgType: 'device_control', value: { msg_type: 'device_control', command } });
    }
    expect(parseProtocolContent({ msg_type: 'device_control', command: 'run_arbitrary_process' }))
      .toEqual({ kind: 'invalid', code: 'invalid_content' });
    expect(parseProtocolContent({ msg_type: 'device_control', command: 'status', action: 'restart' }))
      .toEqual({ kind: 'invalid', code: 'conflicting_alias' });
  });

  it('enforces required legacy chatroom and response correlation fields', () => {
    expect(parseProtocolContent({ msg_type: 'chatroom_invite' }))
      .toEqual({ kind: 'invalid', code: 'invalid_content' });
    expect(parseProtocolContent({ msg_type: 'chatroom_message', chatroom_id: 'room-1', content: '' }))
      .toEqual({ kind: 'invalid', code: 'invalid_content' });
    expect(parseProtocolContent({ msg_type: 'chatroom_message', content: 'hello' }))
      .toEqual({ kind: 'invalid', code: 'invalid_content' });
    for (const msg_type of ['device_status_report', 'device_control_result', 'command_result']) {
      expect(parseProtocolContent({ msg_type, content: 'result' }))
        .toEqual({ kind: 'invalid', code: 'invalid_content' });
    }
  });

  it('rejects oversized complete CardKit envelopes before specialized validation', () => {
    expect(parseProtocolContent({
      msg_type: 'card_message',
      schema: '1.0.0',
      card: { padding: 'x'.repeat(10 * 1024) },
      timestamp: 1,
    })).toEqual({ kind: 'invalid', code: 'content_too_large' });
    expect(parseProtocolContent({
      msg_type: 'command_result',
      status: 'success',
      code: 200,
      message: 'ok',
      data: { card_state: { padding: 'x'.repeat(10 * 1024) } },
      timestamp: 1,
    })).toEqual({ kind: 'invalid', code: 'content_too_large' });
  });

  it('ignores unknown and server-only message types instead of turning them into prompts', () => {
    expect(parseProtocolContent({ msg_type: 'future_message', content: 'do this' }))
      .toEqual({ kind: 'ignored', code: 'unknown_message_type' });
    expect(parseProtocolContent({ msg_type: 'discussion_event', content: 'do this' }))
      .toEqual({ kind: 'ignored', code: 'server_only_message' });
    expect(parseProtocolContent({ msg_type: 'system_notify', content: 'do this' }))
      .toEqual({ kind: 'ignored', code: 'system_message' });
  });

  it('preserves the complete external compatibility name set', () => {
    expect(EXTERNAL_MESSAGE_TYPES).toEqual([
      'create_opencode_session',
      'opencode_session_created',
      'delete_opencode_session',
      'device_status_request',
      'device_status_report',
      'device_control',
      'device_control_result',
      'command_result',
      'chatroom_invite',
      'chatroom_message',
      'card_message',
      'card_update',
      'card_action',
      'discussion_token',
      'discussion_host_turn',
      'discussion_assignment',
      'discussion_cancel',
      'discussion_artifact_ack',
      'discussion_host_decision',
      'discussion_contribution_delta',
      'discussion_contribution_completed',
      'discussion_artifact_update',
      'discussion_node_error',
      'discussion_model_catalog_request',
      'discussion_model_catalog_response',
      'discussion_wire_chunk',
    ]);
  });
});

describe('slash commands and legacy builders', () => {
  it.each(['/new', '/session', '/sessions', '/status', '/stop'] as const)(
    'parses exact no-argument command %s',
    (name) => expect(parseSlashCommand(name)).toEqual({ kind: 'command', name }),
  );

  it('bounds command arguments and leaves unknown slash text as chat', () => {
    expect(parseSlashCommand('/switch session-1')).toEqual({
      kind: 'command',
      name: '/switch',
      argument: 'session-1',
    });
    expect(parseSlashCommand('/delete session-1 extra')).toEqual({ kind: 'invalid', code: 'invalid_command' });
    expect(parseSlashCommand('/switch bad\u0000id')).toEqual({ kind: 'invalid', code: 'invalid_command' });
    expect(parseSlashCommand('/future option')).toEqual({ kind: 'text', text: '/future option' });
  });

  it('builds canonical snake-case session and device response envelopes', () => {
    expect(buildLegacyEnvelope({
      msgType: 'opencode_session_created',
      requestId: 'request-3',
      sourceImId: 'node-1',
      destinationImId: 'user-1',
      content: {
        status: 'success',
        opencode_session_id: 'provider-session-1',
        session_id: 'session-1',
        title: 'New session',
      },
      timestamp: 123,
    })).toEqual({
      msg_type: 'opencode_session_created',
      request_id: 'request-3',
      source_im_id: 'node-1',
      destination_im_id: 'user-1',
      content: JSON.stringify({
        status: 'success',
        opencode_session_id: 'provider-session-1',
        session_id: 'session-1',
        title: 'New session',
      }),
      timestamp: 123,
    });

    expect(buildLegacyEnvelope({
      msgType: 'device_control_result',
      requestId: 'request-4',
      sourceImId: 'node-1',
      destinationImId: 'user-1',
      content: { status: 'success', message: 'running', data: { command: 'status' } },
      timestamp: 124,
    })).toMatchObject({
      msg_type: 'device_control_result',
      request_id: 'request-4',
      source_im_id: 'node-1',
      destination_im_id: 'user-1',
      timestamp: 124,
    });

    expect(() => buildLegacyEnvelope({
      msgType: 'device_status_report',
      content: { status: 'success' },
      timestamp: 125,
    })).toThrow(/request/i);
  });
});
