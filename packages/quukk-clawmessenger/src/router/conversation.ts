export interface BindingIdentity {
  runtimeId: string;
  nodeId: string;
}

export interface ConversationIdentity extends BindingIdentity {
  conversationType: 1 | 3 | 4;
  targetId: string;
  senderId: string;
}

export function bindingKey(identity: BindingIdentity): string {
  return JSON.stringify([identity.runtimeId, identity.nodeId]);
}

export function conversationKey(identity: ConversationIdentity): string {
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
