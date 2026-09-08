import type { BridgeRuntime } from '../go/types.js';

export const CLAWMESSENGER_NODE_CAPABILITIES = [
  'discussion_host',
  'discussion_participant',
  'artifact_markdown',
  'artifact_html',
  'discussion_roundtable',
  'discussion_model_routing',
  'discussion_role_recommendation',
  'discussion_role_auto_assignment',
] as const;

export function nodeCapabilitiesForRuntime(runtime: BridgeRuntime): string[] {
  const caps = runtime.capabilities;
  return [...CLAWMESSENGER_NODE_CAPABILITIES, ...(runtime.status === 'ready'
    && caps.interactive_rounds === true && caps.cancel === true
    && caps.session_resume === true && caps.text_events === true
    ? ['discussion_interactive_rounds'] : [])];
}
