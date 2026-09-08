export interface BindingIdentity {
  runtimeId: string;
  nodeId: string;
}

export interface ConversationIdentity extends BindingIdentity {
  sessionScope?: 'group';
  conversationType: 1 | 3 | 4;
  targetId: string;
  senderId: string;
}

export function bindingKey(identity: BindingIdentity): string {
  return JSON.stringify([identity.runtimeId, identity.nodeId]);
}

export function conversationKey(identity: ConversationIdentity): string {
  if (identity.sessionScope === 'group' && identity.conversationType !== 1) {
    return interactiveSessionKey(identity.runtimeId, identity.nodeId, identity.conversationType === 3 ? 'group' : 'chatroom', identity.targetId);
  }
  return JSON.stringify([
    identity.runtimeId,
    identity.nodeId,
    identity.conversationType,
    identity.targetId,
    identity.senderId,
  ]);
}

export function replyTargetId(identity: ConversationIdentity): string {
  return identity.conversationType === 1 ? identity.senderId : identity.targetId;
}

/** New namespace: existing session keys and histories remain untouched. */
export function interactiveSessionKey(runtimeId: string, nodeId: string, conversationType: string, targetId: string): string {
  return JSON.stringify([runtimeId, nodeId, conversationType, targetId]);
}
