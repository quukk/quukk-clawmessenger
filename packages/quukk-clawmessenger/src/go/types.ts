import { z } from 'zod';

const boundedString = (maximum: number) => z.string().max(maximum);
const nonEmptyString = (maximum: number) => boundedString(maximum).min(1);

export const BridgeProviderSchema = z.enum(['opencode', 'openclaw', 'codex', 'hermes']);
export type BridgeProvider = z.infer<typeof BridgeProviderSchema>;

export const BridgeRuntimeStatusSchema = z.enum([
  'ready',
  'needs_auth',
  'found_not_runnable',
  'not_found',
  'probe_failed',
]);
export type BridgeRuntimeStatus = z.infer<typeof BridgeRuntimeStatusSchema>;

export const BridgeRuntimeCapabilitiesSchema = z.strictObject({
  session_resume: z.boolean(),
  cancel: z.boolean(),
  text_events: z.boolean(),
  tool_events: z.boolean(),
  approval_events: z.boolean(),
});
export type BridgeRuntimeCapabilities = z.infer<typeof BridgeRuntimeCapabilitiesSchema>;

export const BridgeRuntimeSchema = z.strictObject({
  id: z.string().regex(/^rt_[0-9a-f]{32}$/).optional(),
  provider: BridgeProviderSchema,
  version: nonEmptyString(256).optional(),
  path: nonEmptyString(4096).refine((value) => !value.includes('\0')).optional(),
  status: BridgeRuntimeStatusSchema,
  capabilities: BridgeRuntimeCapabilitiesSchema,
});
export type BridgeRuntime = z.infer<typeof BridgeRuntimeSchema>;

export const BridgeRuntimeListSchema = z
  .array(BridgeRuntimeSchema)
  .length(4)
  .superRefine((runtimes, context) => {
    const expected = ['opencode', 'openclaw', 'codex', 'hermes'] as const;
    for (let index = 0; index < expected.length; index += 1) {
      if (runtimes[index]?.provider !== expected[index]) {
        context.addIssue({ code: 'custom', path: [index, 'provider'], message: 'runtime_order' });
      }
    }
  });

export const BridgeTaskIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^task_[0-9a-f]+_[0-9a-f]+$/);

export const BridgeTaskStartInputSchema = z.strictObject({
  runtimeId: z.string().regex(/^rt_[0-9a-f]{32}$/),
  conversationKey: nonEmptyString(4096).refine((value) => value.trim().length > 0),
  prompt: nonEmptyString(1 << 20).refine((value) => value.trim().length > 0),
  workdir: nonEmptyString(4096).refine((value) => !value.includes('\0')),
  resumeSessionId: nonEmptyString(4096).optional(),
});
export type BridgeTaskStartInput = z.infer<typeof BridgeTaskStartInputSchema>;

export const BridgeTaskStartWireSchema = z.strictObject({
  runtime_id: z.string().regex(/^rt_[0-9a-f]{32}$/),
  conversation_key: nonEmptyString(4096),
  prompt: nonEmptyString(1 << 20),
  workdir: nonEmptyString(4096),
  resume_session_id: nonEmptyString(4096).optional(),
});

export const BridgeTaskStartResponseSchema = z.strictObject({
  task_id: BridgeTaskIdSchema,
  events_url: nonEmptyString(256),
});
export type BridgeTaskStartResponse = z.infer<typeof BridgeTaskStartResponseSchema>;

const rfc3339NanoSchema = z
  .string()
  .min(20)
  .max(40)
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/)
  .refine((value) => Number.isFinite(Date.parse(value)));

const pidSchema = z.number().int().positive().safe();
const addressSchema = z.string().regex(/^127\.0\.0\.1:(?:[1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5])$/);
const instanceIdSchema = z.string().regex(/^br_[0-9a-f]{32}$/);

export const BridgeReadinessSchema = z.strictObject({
  address: addressSchema,
  pid: pidSchema,
  version: nonEmptyString(128),
  instance_id: instanceIdSchema,
  started_at: rfc3339NanoSchema,
});
export type BridgeReadiness = z.infer<typeof BridgeReadinessSchema>;

export const BridgeHealthSchema = z.strictObject({
  status: z.literal('ok'),
  version: nonEmptyString(128),
  pid: pidSchema,
  instance_id: instanceIdSchema,
  started_at: rfc3339NanoSchema,
  probe_status: z.enum(['ready', 'refreshing']),
});
export type BridgeHealth = z.infer<typeof BridgeHealthSchema>;

export const BridgeSafeErrorSchema = z.strictObject({
  category: z.enum(['authentication', 'transport', 'runtime']),
  message: nonEmptyString(512),
});
export type BridgeSafeError = z.infer<typeof BridgeSafeErrorSchema>;

export const BridgeEventTypeSchema = z.enum([
  'started',
  'text_delta',
  'tool_started',
  'tool_finished',
  'status',
  'completed',
  'failed',
  'cancelled',
]);
export type BridgeEventType = z.infer<typeof BridgeEventTypeSchema>;

const eventBase = {
  id: z.number().int().positive().safe(),
  task_id: BridgeTaskIdSchema,
  time: rfc3339NanoSchema,
  session_id: nonEmptyString(4096).optional(),
};

export const BridgeTaskEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...eventBase, type: z.literal('started') }),
  z.strictObject({ ...eventBase, type: z.literal('text_delta'), text: boundedString(1 << 20).optional() }),
  z.strictObject({
    ...eventBase,
    type: z.literal('tool_started'),
    tool: boundedString(512).optional(),
    call_id: boundedString(512).optional(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal('tool_finished'),
    tool: boundedString(512).optional(),
    call_id: boundedString(512).optional(),
    output: boundedString(1 << 20).optional(),
  }),
  z.strictObject({ ...eventBase, type: z.literal('status'), status: boundedString(512).optional() }),
  z.strictObject({
    ...eventBase,
    type: z.literal('completed'),
    output: boundedString(1 << 20).optional(),
    status: boundedString(512).optional(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal('failed'),
    status: boundedString(512).optional(),
    error: BridgeSafeErrorSchema,
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal('cancelled'),
    status: boundedString(512).optional(),
  }),
]);
export type BridgeTaskEvent = z.infer<typeof BridgeTaskEventSchema>;

export const BridgeHTTPErrorEnvelopeSchema = z.strictObject({
  error: z.string().min(1).max(64).regex(/^[a-z0-9_]+$/),
});
export type BridgeHTTPErrorEnvelope = z.infer<typeof BridgeHTTPErrorEnvelopeSchema>;

export function isTerminalBridgeTaskEvent(event: BridgeTaskEvent): boolean {
  return event.type === 'completed' || event.type === 'failed' || event.type === 'cancelled';
}

export interface BridgeTaskPort {
  startTask(input: {
    runtimeId: string;
    conversationKey: string;
    prompt: string;
    workdir: string;
    resumeSessionId?: string;
  }): Promise<{ taskId: string; eventsUrl: string }>;
  events(taskId: string, afterEventId?: number): AsyncIterable<BridgeTaskEvent>;
  cancelTask(taskId: string): Promise<void>;
}
