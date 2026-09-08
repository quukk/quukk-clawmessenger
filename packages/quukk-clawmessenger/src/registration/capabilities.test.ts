// @vitest-environment node
import { expect, it } from 'vitest';
import { nodeCapabilitiesForRuntime } from './capabilities.js';
import type { BridgeRuntime } from '../go/types.js';
it('advertises interaction only with installed runtime proof and all three required capabilities', () => {
  const runtime: BridgeRuntime = { id: `rt_${'a'.repeat(32)}`, provider: 'hermes', status: 'ready', version: '1.0.0', path: 'D:/fake/hermes.exe', capabilities: { interactive_rounds: true, session_resume: true, cancel: true, text_events: true, tool_events: false, approval_events: false } };
  expect(nodeCapabilitiesForRuntime(runtime)).toContain('discussion_interactive_rounds');
  for (const capability of ['interactive_rounds', 'session_resume', 'cancel', 'text_events'] as const)
    expect(nodeCapabilitiesForRuntime({ ...runtime, capabilities: { ...runtime.capabilities, [capability]: false } })).not.toContain('discussion_interactive_rounds');
  expect(nodeCapabilitiesForRuntime({ ...runtime, status: 'needs_auth' })).not.toContain('discussion_interactive_rounds');
});
