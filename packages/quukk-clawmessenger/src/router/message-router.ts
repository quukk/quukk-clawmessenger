import { createHash, randomBytes as cryptoRandomBytes } from 'node:crypto';

import {
  buildUnsupportedApprovalResult,
  routeCardAction,
  type ActionIntent,
  type CardActionRoute,
} from '../cardkit/action-router.js';
import { buildCardMessage, buildCardUpdate } from '../cardkit/builders.js';
import { INVALID_CARD_MARKER_TEXT, parseCardMarkers, streamSafeContent } from '../cardkit/parse-marker.js';
import type { CardModel } from '../cardkit/schema.js';
import { validateCard } from '../cardkit/validate.js';
import type { Provider } from '../config/schema.js';
import type {
  BridgeEventType,
  BridgeTaskEvent,
  BridgeTaskPort,
} from '../go/types.js';
import {
  DISCUSSION_TURN_TIMEOUT_MS,
  advanceAfterCompleted,
  advanceAfterTimeout,
  buildDiscussionV1,
  discussionV1Key,
  parseDiscussionV1,
  type DiscussionV1Message,
} from '../protocol/discussion-v1.js';
import {
  DISCUSSION_V2_LIMITS,
  DiscussionV2Guard,
  buildArtifactUpdate,
  buildContributionCompleted,
  buildContributionDelta,
  buildHostDecisionOutput,
  buildModelCatalogResponse,
  buildNodeError,
  discussionV2LogicalKey,
  parseDiscussionModelCatalogRequest,
  parseRoleRecommendationRequest,
  parseRoleRecommendationResponse,
  parseDiscussionV2Command,
  parseHostDecision,
  type ArtifactAckExpectation,
  type ArtifactReference,
  type DiscussionAssignment,
  type DiscussionHostTurn,
  type HostDecision,
  type RoleRecommendationRequest,
} from '../protocol/discussion-v2.js';
import { DiscussionWireReassembler, encodeDiscussionWire } from '../protocol/discussion-wire.js';
import {
  buildLegacyEnvelope,
  parseProtocolContent,
  parseSlashCommand,
  type ExternalMessageType,
  type NormalizedRongCloudMessage,
} from '../protocol/messages.js';
import type { ModelCatalog } from '../protocol/discussion-v2.js';
import type { WorkerEvent } from '../rongcloud/worker-protocol.js';
import type { WorkerIdentity } from '../rongcloud/worker-supervisor.js';
import {
  bindingKey,
  conversationKey,
  replyTargetId,
  type ConversationIdentity,
} from './conversation.js';
import type { RouterStateStore } from './session-store.js';

const MAX_PROMPT_BYTES = 128 * 1024;
const MAX_WAITING_PER_CONVERSATION = 8;
const MAX_WAITING_PER_BINDING = 256;
const MAX_WAITING_PROCESS = 1_024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const OUTPUT_TRUNCATED_TEXT = '[output_truncated]';
const MAX_OUTPUT_CONTENT_BYTES = MAX_OUTPUT_BYTES - Buffer.byteLength(OUTPUT_TRUNCATED_TEXT, 'utf8');
const OUTPUT_FLUSH_MS = 250;
const OUTPUT_EARLY_FLUSH_BYTES = 16 * 1024;
const OUTPUT_CHUNK_BYTES = 32 * 1024;
const TASK_WATCHDOG_MS = 2 * 60 * 60 * 1_000 + 60_000;
const ROLE_RECOMMENDATION_WATCHDOG_MS = 3 * 60 * 1_000;
const MAX_BUFFERED_OUTPUT_ENTRIES = 32;
const MAX_BUFFERED_OUTPUT_BYTES = 1024 * 1024;
const TRANSIENT_OUTPUT_CODES = new Set([
  'not_connected', 'disconnected', 'timeout', 'worker_exited',
]);
const controlCharacters = /[\p{Cc}\p{Cf}]/gu;

export type RouterWorkerSend =
  | {
      conversationType: 1 | 3 | 4;
      targetId: string;
      messageType: 'text';
      content: string;
    }
  | {
      conversationType: 1 | 3 | 4;
      targetId: string;
      messageType:
        | 'command'
        | 'command_result'
        | 'card_message'
        | 'card_update'
        | 'card_action'
        | 'chatroom_invite';
      content: Record<string, unknown>;
    };

export interface RouterReceipt {
  messageUid: string;
  senderId: string;
  targetId: string;
  conversationType: 1 | 3 | 4;
  direction: number | string;
}

export interface RouterWorkerPort {
  send(identity: WorkerIdentity, input: RouterWorkerSend): Promise<string | undefined>;
  receipt(identity: WorkerIdentity, input: RouterReceipt): Promise<void>;
  joinChatroom(
    identity: WorkerIdentity,
    input: { roomId: string; historyCount: number },
  ): Promise<void>;
}

export interface RouterBindingPort {
  binding(identity: WorkerIdentity): Promise<{
    runtimeId: string;
    nodeId: string;
    provider: Provider;
    enabled: true;
  } | undefined>;
  authorizeDefaultWorkdir(identity: WorkerIdentity): Promise<string>;
}

export type SafeRuntimeState =
  | 'ready'
  | 'needs_auth'
  | 'found_not_runnable'
  | 'not_found'
  | 'probe_failed';

export interface SafeDeviceStatus {
  enabled: boolean;
  worker: 'starting' | 'online' | 'offline' | 'backoff' | 'stopped';
  runtime: SafeRuntimeState;
}

export type DeviceCommand =
  | 'status'
  | 'disable'
  | 'stop'
  | 'enable'
  | 'start'
  | 'delete'
  | 'restart'
  | 'rename_device';

export interface AuthorizedControl {
  identity: WorkerIdentity;
  conversationKey: string;
  senderId: string;
  scope: 'device.read' | 'device.mutate' | 'card.answer' | 'card.custom';
}

export interface AuthorizedDeviceCommand {
  identity: WorkerIdentity;
  senderId: string;
  command: DeviceCommand;
  name?: string;
}

export type AuthorizedCardIntent = (
  | Extract<ActionIntent, { kind: 'answer' }>
  | Extract<ActionIntent, { kind: 'custom' }>
) & {
  identity: WorkerIdentity;
  senderId: string;
  conversationKey: string;
};

export interface SafeDeviceResult {
  status: 'success' | 'error';
  code: string;
  message: string;
  data?: SafeDeviceStatus;
}

export interface SafeCardResult {
  status: 'success' | 'error';
  code: string;
  message: string;
  card?: CardModel;
}

export interface RouterControlPort {
  authorize(input: AuthorizedControl): Promise<boolean>;
  status(identity: WorkerIdentity): Promise<SafeDeviceStatus>;
  device(input: AuthorizedDeviceCommand): Promise<SafeDeviceResult>;
  card(input: AuthorizedCardIntent): Promise<SafeCardResult>;
  modelCatalog(identity: WorkerIdentity): Promise<ModelCatalog>;
}

export interface RouterLogEvent {
  event: string;
  runtimeId?: string;
  nodeId?: string;
  provider?: Provider;
  conversationType?: 1 | 3 | 4;
  conversationKeyHash?: string;
  taskId?: string;
  eventType?: BridgeEventType;
  errorCode?: string;
  queueDepth?: number;
  count?: number;
  durationMs?: number;
}

export interface RouterLogger {
  debug(event: RouterLogEvent): void;
  info(event: RouterLogEvent): void;
  warn(event: RouterLogEvent): void;
  error(event: RouterLogEvent): void;
}

export interface MessageRouterOptions {
  task: BridgeTaskPort;
  worker: RouterWorkerPort;
  binding: RouterBindingPort;
  control: RouterControlPort;
  state: RouterStateStore;
  logger: RouterLogger;
  clock?: () => number;
  timers?: {
    setTimeout(callback: () => void, milliseconds: number): unknown;
    clearTimeout(timer: unknown): void;
  };
  randomBytes?: (size: number) => Buffer;
  sleep?: (milliseconds: number) => Promise<void>;
}

type LaneItem = {
  state: 'waiting' | 'executing' | 'released';
  run: () => Promise<void>;
  resolve: () => void;
};

interface Lane {
  identity: WorkerIdentity;
  bindingKey: string;
  conversationKey: string;
  running: boolean;
  queue: LaneItem[];
}

interface InflightBindingOperations {
  identity: WorkerIdentity;
  operations: Set<Promise<void>>;
}

interface ActiveTask {
  identity: WorkerIdentity;
  conversation: ConversationIdentity;
  bindingKey: string;
  conversationKey: string;
  taskId: string;
  generation: number;
  submittedResumeSessionId?: string;
  lastEventId: number;
  suppressed: boolean;
  terminal: boolean;
  timedOut: boolean;
  rawOutput: string;
  rawOutputBytes: number;
  deliveredTextCharacters: number;
  sawTextDelta: boolean;
  outputTruncated: boolean;
  outputTail: Promise<void>;
  flushTimer?: unknown;
  watchdogTimer?: unknown;
  watchdogPromise?: Promise<void>;
  iterator?: AsyncIterator<BridgeTaskEvent>;
  done: Promise<void>;
  resolveDone: () => void;
}

interface BufferedOutput {
  identity: WorkerIdentity;
  taskId: string;
  kind: 'coarse' | 'terminal';
  messages: RouterWorkerSend[];
  bytes: number;
  order: number;
}

interface DiscussionActive {
  identity: WorkerIdentity;
  conversation: ConversationIdentity;
  bindingKey: string;
  logicalKey: string;
  taskId: string;
  generation: number;
  command: DiscussionAssignment | DiscussionHostTurn;
  submittedResumeSessionId?: string;
  lastEventId: number;
  output: string;
  outputBytes: number;
  outputTruncated: boolean;
  pendingDelta: string;
  seq: number;
  outputTail: Promise<void>;
  outputFinalQueued: boolean;
  suppressed: boolean;
  terminal: boolean;
  iterator?: AsyncIterator<BridgeTaskEvent>;
  deltaTimer?: unknown;
  watchdogTimer?: unknown;
  watchdogPromise?: Promise<void>;
  cleanupPromise?: Promise<void>;
  logicalOwner?: V2LogicalOwner;
}

interface V1Owner {
  token: string;
  state: 'active' | 'terminal';
  expiresAt: number;
  task?: V1Active;
}

interface V2LogicalOwner {
  logicalKey: string;
  senderId: string;
  discussionId: string;
  stateVersion: number;
  round: number;
  state: 'prestart' | 'committing' | 'active' | 'terminal';
  expiresAt: number;
}

interface V2Cancellation {
  senderId: string;
  discussionId: string;
  stateVersion: number;
  round: number;
}

interface V1Active {
  identity: WorkerIdentity;
  conversation: ConversationIdentity;
  bindingKey: string;
  logicalKey: string;
  taskId: string;
  generation: number;
  message: DiscussionV1Message;
  submittedResumeSessionId?: string;
  lastEventId: number;
  output: string;
  outputBytes: number;
  outputTruncated: boolean;
  suppressed: boolean;
  terminal: boolean;
  iterator?: AsyncIterator<BridgeTaskEvent>;
  timer?: unknown;
  timeoutPromise?: Promise<void>;
}

interface BindingDiscussionState {
  identity: WorkerIdentity;
  guard: DiscussionV2Guard;
  wire: DiscussionWireReassembler;
  active: Map<string, DiscussionActive>;
  v1: Map<string, V1Owner>;
  logicalV2: Map<string, V2LogicalOwner>;
  v2Cancellations: Map<string, V2Cancellation>;
  ackWaiters: Map<string, ArtifactAckWaiter>;
}

interface ArtifactAckWaiter {
  logicalKey: string;
  timer: unknown;
  resolve: (reference: ArtifactReference | undefined) => void;
}

type TaskCandidate = {
  conversation: ConversationIdentity;
  prompt: string;
  effectiveMessageUid: string;
  joinRoom?: string;
};

type ClaimedMessage = { key: string; claimId: string };

const RESPONSE_ONLY_TYPES = new Set<ExternalMessageType>([
  'opencode_session_created',
  'device_status_report',
  'device_control_result',
  'command_result',
  'card_message',
  'card_update',
  'discussion_host_decision',
  'discussion_contribution_delta',
  'discussion_contribution_completed',
  'discussion_artifact_update',
  'discussion_node_error',
  'discussion_model_catalog_response',
  'discussion_role_recommendation_response',
]);

const DEVICE_COMMANDS = new Set<DeviceCommand>([
  'status', 'disable', 'stop', 'enable', 'start', 'delete', 'restart', 'rename_device',
]);

function safeIdentifier(value: string, maximum = 256): boolean {
  return value.length >= 1
    && value.length <= maximum
    && value === value.trim()
    && !/[\p{Cc}\p{Cf}]/u.test(value);
}

function safeText(value: string): string {
  return value.replace(controlCharacters, ' ').trim();
}

function httpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname.length > 0
      && url.username === ''
      && url.password === '';
  } catch {
    return false;
  }
}

function promptFor(message: NormalizedRongCloudMessage): string | undefined {
  const text = message.text === undefined ? '' : message.text.trim();
  if (message.attachments.length === 0) {
    if (text.length === 0 || Buffer.byteLength(text, 'utf8') > MAX_PROMPT_BYTES) return undefined;
    return text;
  }
  if (message.attachments.length > 16
    || message.attachments.some((attachment) => !httpsUrl(attachment.url))) return undefined;
  const lines = ['[untrusted user message]', text || '(no text)', '[untrusted attachments]'];
  for (const attachment of message.attachments) {
    const metadata = [
      `kind=${attachment.kind}`,
      attachment.name === undefined ? undefined : `name=${safeText(attachment.name)}`,
      attachment.mimeType === undefined ? undefined : `mime=${safeText(attachment.mimeType)}`,
      attachment.size === undefined ? undefined : `size=${attachment.size}`,
      `url=${attachment.url}`,
    ].filter((value): value is string => value !== undefined);
    lines.push(`- ${metadata.join(' ')}`);
  }
  const rendered = lines.join('\n');
  return Buffer.byteLength(rendered, 'utf8') <= MAX_PROMPT_BYTES ? rendered : undefined;
}

function conversationFrom(message: NormalizedRongCloudMessage, identity: WorkerIdentity): ConversationIdentity {
  return {
    ...identity,
    conversationType: message.conversationType,
    targetId: message.targetId,
    senderId: message.senderId,
  };
}

function hashConversation(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function workerErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;
}

function utf8Prefix(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return '';
  if (Buffer.byteLength(value, 'utf8') <= maximumBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), 'utf8') <= maximumBytes) low = middle;
    else high = middle - 1;
  }
  if (low > 0 && /[\uD800-\uDBFF]/u.test(value[low - 1]!)) low -= 1;
  return value.slice(0, low);
}

function textChunks(value: string, maximumBytes: number): string[] {
  const chunks: string[] = [];
  let remaining = value;
  while (remaining.length > 0) {
    const chunk = utf8Prefix(remaining, maximumBytes);
    if (chunk.length === 0) break;
    chunks.push(chunk);
    remaining = remaining.slice(chunk.length);
  }
  return chunks;
}

function serializedBytes(messages: readonly RouterWorkerSend[]): number {
  try {
    return Buffer.byteLength(JSON.stringify(messages), 'utf8');
  } catch {
    return MAX_BUFFERED_OUTPUT_BYTES + 1;
  }
}

export class MessageRouter {
  readonly #task: BridgeTaskPort;
  readonly #worker: RouterWorkerPort;
  readonly #binding: RouterBindingPort;
  readonly #control: RouterControlPort;
  readonly #state: RouterStateStore;
  readonly #logger: RouterLogger;
  readonly #clock: () => number;
  readonly #randomBytes: (size: number) => Buffer;
  readonly #setTimeout: (callback: () => void, milliseconds: number) => unknown;
  readonly #clearTimeout: (timer: unknown) => void;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #lanes = new Map<string, Lane>();
  readonly #waitingByBinding = new Map<string, number>();
  readonly #active = new Map<string, ActiveTask>();
  readonly #bufferedOutput = new Map<string, BufferedOutput[]>();
  readonly #bufferDrains = new Map<string, Promise<void>>();
  readonly #bufferDrainTasks = new Map<string, string>();
  readonly #discussion = new Map<string, BindingDiscussionState>();
  readonly #inflightByBinding = new Map<string, InflightBindingOperations>();
  readonly #outboundByBinding = new Map<string, Set<Promise<unknown>>>();
  readonly #bindingDisposals = new Map<string, Promise<void>>();
  readonly #disposedBindings = new Set<string>();
  readonly #bindingGenerations = new Map<string, number>();
  #bufferOrder = 0;
  #waiting = 0;
  #disposed = false;
  #disposeAttempt?: Promise<void>;

  constructor(options: MessageRouterOptions) {
    this.#task = options.task;
    this.#worker = options.worker;
    this.#binding = options.binding;
    this.#control = options.control;
    this.#state = options.state;
    this.#logger = options.logger;
    this.#clock = options.clock ?? Date.now;
    this.#randomBytes = options.randomBytes ?? cryptoRandomBytes;
    this.#setTimeout = options.timers?.setTimeout
      ?? ((callback, milliseconds) => setTimeout(callback, milliseconds));
    this.#clearTimeout = options.timers?.clearTimeout
      ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    this.#sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => {
      this.#setTimeout(resolve, milliseconds);
    }));
  }

  async onWorkerEvent(identity: WorkerIdentity, event: WorkerEvent): Promise<void> {
    if (this.#disposed
      || this.#disposedBindings.has(bindingKey(identity))
      || event.runtimeId !== identity.runtimeId) return;
    const key = bindingKey(identity);
    let inflight = this.#inflightByBinding.get(key);
    if (!inflight) {
      inflight = { identity: { ...identity }, operations: new Set() };
      this.#inflightByBinding.set(key, inflight);
    }
    const operation = Promise.resolve().then(() => this.#routeWorkerEvent(identity, event));
    inflight.operations.add(operation);
    try {
      await operation;
    } finally {
      inflight.operations.delete(operation);
      if (inflight.operations.size === 0 && this.#inflightByBinding.get(key) === inflight) {
        this.#inflightByBinding.delete(key);
      }
    }
  }

  async #routeWorkerEvent(identity: WorkerIdentity, event: WorkerEvent): Promise<void> {
    if (this.#disposed
      || this.#disposedBindings.has(bindingKey(identity))
      || event.runtimeId !== identity.runtimeId) return;
    if (event.type === 'connection') {
      if (event.state === 'online') await this.#drainBufferedOutput(identity);
      return;
    }
    if (event.type !== 'message') return;
    if (!this.#validMessage(identity, event.message)) {
      await this.#safeSendText(identity, conversationFrom(event.message, identity), '[invalid_message]');
      return;
    }
    const protocolInput = event.message.rawContent
      && typeof event.message.rawContent.msg_type === 'string'
      ? event.message.rawContent
      : event.message.text;
    const parsed = parseProtocolContent(protocolInput);
    if (parsed.kind === 'ignored') return;
    if (parsed.kind === 'invalid') {
      await this.#safeSendText(identity, conversationFrom(event.message, identity), '[invalid_message]');
      return;
    }
    if (parsed.kind === 'protocol') {
      await this.#dispatchProtocol(identity, event.message, parsed.msgType, parsed.value);
      return;
    }
    const slash = parseSlashCommand(parsed.text);
    if (slash.kind === 'invalid') {
      await this.#safeSendText(identity, conversationFrom(event.message, identity), '[invalid_message]');
      return;
    }
    if (slash.kind === 'command') {
      const conversation = conversationFrom(event.message, identity);
      this.#logValidated(identity, conversation);
      if (slash.name === '/stop') {
        await this.#runStop(identity, event.message, conversation);
        return;
      }
      await this.#enqueue(identity, conversation, () =>
        this.#runSlash(identity, event.message, conversation, slash),
      );
      return;
    }
    const candidate = this.#plainCandidate(identity, event.message, slash.text);
    if (!candidate) {
      await this.#safeSendText(identity, conversationFrom(event.message, identity), '[invalid_message]');
      return;
    }
    this.#logValidated(identity, candidate.conversation);
    await this.#enqueue(identity, candidate.conversation, () =>
      this.#runPlain(identity, event.message, candidate),
    );
  }

  disposeBinding(identity: WorkerIdentity): Promise<void> {
    const key = bindingKey(identity);
    const existing = this.#bindingDisposals.get(key);
    if (existing) return existing;
    if (this.#disposeAttempt !== undefined) return this.#disposeAttempt;
    return this.#beginBindingDisposal(identity);
  }

  #beginBindingDisposal(identity: WorkerIdentity): Promise<void> {
    const key = bindingKey(identity);
    const existing = this.#bindingDisposals.get(key);
    if (existing) return existing;
    let resolveDisposal!: () => void;
    let rejectDisposal!: (error: unknown) => void;
    const disposal = new Promise<void>((resolve, reject) => {
      resolveDisposal = resolve;
      rejectDisposal = reject;
    });
    this.#bindingDisposals.set(key, disposal);
    void this.#disposeBindingOnce(identity).then(resolveDisposal, rejectDisposal);
    return disposal;
  }

  async activateBinding(identity: WorkerIdentity): Promise<void> {
    if (this.#disposed) throw new Error('router_disposed');
    const key = bindingKey(identity);
    const disposal = this.#bindingDisposals.get(key);
    if (disposal !== undefined) await disposal;
    if (this.#disposed) throw new Error('router_disposed');
    if (!this.#disposedBindings.has(key)) return;
    if (disposal !== undefined && this.#bindingDisposals.get(key) !== disposal) return;
    this.#bindingDisposals.delete(key);
    this.#disposedBindings.delete(key);
    this.#bindingGenerations.set(key, (this.#bindingGenerations.get(key) ?? 0) + 1);
  }

  async #disposeBindingOnce(identity: WorkerIdentity): Promise<void> {
    const key = bindingKey(identity);
    this.#disposedBindings.add(key);
    this.#bindingGenerations.set(key, (this.#bindingGenerations.get(key) ?? 0) + 1);
    this.#bufferedOutput.delete(key);
    for (const [laneKey, lane] of this.#lanes) {
      if (lane.bindingKey !== key) continue;
      for (const item of lane.queue.splice(0)) {
        if (item.state !== 'waiting') continue;
        item.state = 'released';
        this.#decrementWaiting(key);
        item.resolve();
      }
      if (!lane.running) this.#lanes.delete(laneKey);
    }
    const cancellations: Promise<unknown>[] = [];
    for (const active of this.#active.values()) {
      if (active.bindingKey !== key) continue;
      active.suppressed = true;
      if (active.flushTimer !== undefined) this.#clearTimeout(active.flushTimer);
      if (active.watchdogTimer !== undefined) this.#clearTimeout(active.watchdogTimer);
      cancellations.push(this.#task.cancelTask(active.taskId).catch(() => undefined));
      if (active.iterator?.return !== undefined) {
        cancellations.push(active.iterator.return().catch(() => undefined));
      }
    }
    const discussion = this.#discussion.get(key);
    if (discussion) {
      discussion.guard.dispose();
      discussion.wire.dispose();
      for (const active of discussion.active.values()) {
        if (active.cleanupPromise !== undefined) {
          cancellations.push(active.cleanupPromise);
          continue;
        }
        active.suppressed = true;
        if (active.deltaTimer !== undefined) this.#clearTimeout(active.deltaTimer);
        if (active.watchdogTimer !== undefined) this.#clearTimeout(active.watchdogTimer);
        cancellations.push(this.#task.cancelTask(active.taskId).catch(() => undefined));
        if (active.iterator?.return !== undefined) {
          cancellations.push(active.iterator.return().catch(() => undefined));
        }
      }
      for (const owner of discussion.v1.values()) {
        if (owner.task === undefined) continue;
        owner.task.suppressed = true;
        if (owner.task.timer !== undefined) this.#clearTimeout(owner.task.timer);
        cancellations.push(this.#task.cancelTask(owner.task.taskId).catch(() => undefined));
        if (owner.task.iterator?.return !== undefined) {
          cancellations.push(owner.task.iterator.return().catch(() => undefined));
        }
      }
      for (const waiter of discussion.ackWaiters.values()) {
        this.#clearTimeout(waiter.timer);
        waiter.resolve(undefined);
      }
      discussion.ackWaiters.clear();
      this.#discussion.delete(key);
    }
    await Promise.allSettled(cancellations);
    while (true) {
      const outbound = this.#outboundByBinding.get(key);
      if (outbound === undefined || outbound.size === 0) break;
      await Promise.allSettled([...outbound]);
    }
  }

  dispose(): Promise<void> {
    if (this.#disposeAttempt !== undefined) return this.#disposeAttempt;
    let resolveDisposal!: () => void;
    let rejectDisposal!: (error: unknown) => void;
    const attempt = new Promise<void>((resolve, reject) => {
      resolveDisposal = resolve;
      rejectDisposal = reject;
    });
    this.#disposeAttempt = attempt;
    void this.#disposeOnce().then(resolveDisposal, rejectDisposal);
    return attempt;
  }

  async #disposeOnce(): Promise<void> {
    this.#disposed = true;
    const identities = new Map<string, WorkerIdentity>();
    for (const active of this.#active.values()) identities.set(active.bindingKey, active.identity);
    for (const [key, discussion] of this.#discussion) identities.set(key, discussion.identity);
    for (const lane of this.#lanes.values()) identities.set(lane.bindingKey, lane.identity);
    for (const [key, entries] of this.#bufferedOutput) {
      if (entries[0]) identities.set(key, entries[0].identity);
    }
    for (const [key, inflight] of this.#inflightByBinding) identities.set(key, inflight.identity);
    for (const identity of identities.values()) this.#beginBindingDisposal(identity);
    const results = await Promise.allSettled([...this.#bindingDisposals.values()]);
    const rejected = results.find((result) => result.status === 'rejected');
    if (rejected !== undefined && rejected.status === 'rejected') throw rejected.reason;
  }

  #validMessage(
    identity: WorkerIdentity,
    message: NormalizedRongCloudMessage,
  ): boolean {
    return safeIdentifier(identity.runtimeId, 128)
      && safeIdentifier(identity.nodeId, 137)
      && safeIdentifier(message.messageUid)
      && safeIdentifier(message.senderId)
      && safeIdentifier(message.targetId)
      && (message.conversationType === 1
        || message.conversationType === 3
        || message.conversationType === 4);
  }

  #plainCandidate(
    identity: WorkerIdentity,
    message: NormalizedRongCloudMessage,
    text = message.text,
  ): TaskCandidate | undefined {
    const prompt = promptFor({ ...message, ...(text === undefined ? {} : { text }) });
    if (prompt === undefined) return undefined;
    return {
      conversation: conversationFrom(message, identity),
      prompt,
      effectiveMessageUid: message.messageUid,
    };
  }

  #logValidated(identity: WorkerIdentity, conversation: ConversationIdentity): void {
    this.#logger.debug({
      event: 'validated',
      runtimeId: identity.runtimeId,
      nodeId: identity.nodeId,
      conversationType: conversation.conversationType,
      conversationKeyHash: hashConversation(conversationKey(conversation)),
    });
  }

  async #dispatchProtocol(
    identity: WorkerIdentity,
    message: NormalizedRongCloudMessage,
    msgType: ExternalMessageType,
    value: Record<string, unknown>,
  ): Promise<void> {
    if (msgType === 'discussion_wire_chunk') {
      await this.#runDiscussionWire(identity, message, value);
      return;
    }
    if (msgType === 'discussion_token'
      || msgType === 'discussion_host_turn'
      || msgType === 'discussion_assignment'
      || msgType === 'discussion_cancel'
      || msgType === 'discussion_artifact_ack'
      || msgType === 'discussion_model_catalog_request'
      || msgType === 'discussion_role_recommendation_request') {
      await this.#dispatchDiscussion(identity, message, msgType, value, false);
      return;
    }
    if (RESPONSE_ONLY_TYPES.has(msgType)) return;
    if (!this.#sourceDestinationMatches(identity, message, value)) return;
    if (msgType === 'card_action') {
      const conversation = conversationFrom(message, identity);
      const routed = routeCardAction(value);
      this.#logValidated(identity, conversation);
      if (routed.ok && routed.kind === 'command' && routed.name === '/stop') {
        await this.#runCardAction(identity, message, conversation, value, routed);
      } else {
        await this.#enqueue(identity, conversation, () =>
          this.#runCardAction(identity, message, conversation, value, routed));
      }
      return;
    }
    if (msgType === 'chatroom_message') {
      const roomId = typeof value.chatroom_id === 'string' ? value.chatroom_id : undefined;
      const text = typeof value.content === 'string' ? value.content : undefined;
      if (!roomId
        || !text
        || message.conversationType !== 4
        || message.targetId !== roomId
        || !safeIdentifier(roomId)) return;
      const origin = typeof value.origin_message_uid === 'string'
        && safeIdentifier(value.origin_message_uid)
        ? value.origin_message_uid
        : message.messageUid;
      const conversation: ConversationIdentity = {
        ...identity,
        conversationType: 4,
        targetId: roomId,
        senderId: message.senderId,
      };
      const prompt = promptFor({ ...message, conversationType: 4, targetId: roomId, text, attachments: [] });
      if (!prompt) return;
      const candidate: TaskCandidate = {
        conversation,
        prompt,
        effectiveMessageUid: origin,
        joinRoom: roomId,
      };
      this.#logValidated(identity, conversation);
      await this.#enqueue(identity, conversation, () => this.#runPlain(identity, message, candidate));
      return;
    }

    const conversation = conversationFrom(message, identity);
    if (msgType === 'chatroom_invite') {
      const roomId = typeof value.chatroom_id === 'string' ? value.chatroom_id : undefined;
      if (!roomId || !safeIdentifier(roomId)) return;
      this.#logValidated(identity, conversation);
      await this.#enqueue(identity, conversation, () =>
        this.#runChatroomInvite(identity, message, conversation, roomId),
      );
      return;
    }
    if (msgType === 'create_opencode_session'
      || msgType === 'delete_opencode_session'
      || msgType === 'device_status_request'
      || msgType === 'device_control') {
      if (msgType === 'device_control' && !this.#validDeviceCommand(value)) return;
      this.#logValidated(identity, conversation);
      await this.#enqueue(identity, conversation, () =>
        this.#runLocalProtocol(identity, message, conversation, msgType, value),
      );
    }
  }

  #sourceDestinationMatches(
    identity: WorkerIdentity,
    message: NormalizedRongCloudMessage,
    value: Record<string, unknown>,
  ): boolean {
    return (value.source_im_id === undefined || value.source_im_id === message.senderId)
      && (value.destination_im_id === undefined || value.destination_im_id === identity.nodeId);
  }

  #validDeviceCommand(value: Record<string, unknown>): boolean {
    if (typeof value.command !== 'string' || !DEVICE_COMMANDS.has(value.command as DeviceCommand)) {
      return false;
    }
    if (value.command !== 'rename_device') return true;
    if (typeof value.name !== 'string') return false;
    const name = value.name.trim();
    return name.length >= 1 && name.length <= 128 && !/[\p{Cc}\p{Cf}]/u.test(name);
  }

  #discussionState(identity: WorkerIdentity): BindingDiscussionState {
    const key = bindingKey(identity);
    let state = this.#discussion.get(key);
    if (!state) {
      state = {
        identity: { ...identity },
        guard: new DiscussionV2Guard({ clock: this.#clock }),
        wire: new DiscussionWireReassembler({ clock: this.#clock }),
        active: new Map(),
        v1: new Map(),
        logicalV2: new Map(),
        v2Cancellations: new Map(),
        ackWaiters: new Map(),
      };
      this.#discussion.set(key, state);
    }
    return state;
  }

  async #dispatchDiscussion(
    identity: WorkerIdentity,
    message: NormalizedRongCloudMessage,
    msgType: ExternalMessageType,
    value: Record<string, unknown>,
    physicalAdmitted: boolean,
  ): Promise<void> {
    const conversation = conversationFrom(message, identity);
    if (msgType === 'discussion_cancel' || msgType === 'discussion_artifact_ack') {
      await this.#runDiscussionControl(identity, message, msgType, value, physicalAdmitted);
      return;
    }
    if (msgType === 'discussion_model_catalog_request') {
      await this.#runDiscussionCatalog(identity, message, value, physicalAdmitted);
      return;
    }
    if (msgType === 'discussion_role_recommendation_request') {
      await this.#runRoleRecommendation(identity, message, value, physicalAdmitted);
      return;
    }
    if (msgType !== 'discussion_token'
      && msgType !== 'discussion_host_turn'
      && msgType !== 'discussion_assignment') return;
    this.#logValidated(identity, conversation);
    await this.#enqueue(identity, conversation, () => msgType === 'discussion_token'
      ? this.#runDiscussionV1(identity, message, value, physicalAdmitted)
      : this.#runDiscussionV2(identity, message, value, physicalAdmitted));
  }

  async #runDiscussionWire(
    identity: WorkerIdentity,
    message: NormalizedRongCloudMessage,
    value: Record<string, unknown>,
  ): Promise<void> {
    const generation = this.#bindingGeneration(identity);
    const conversation = conversationFrom(message, identity);
    const claim = await this.#claimLocal(identity, message.messageUid, conversation, generation);
    if (!claim) return;
    const result = this.#discussionState(identity).wire.accept(message.senderId, value);
    const admitted = await this.#admitOnly(identity, message, claim, generation, true);
    if (!admitted
      || !this.#bindingGenerationCurrent(identity, generation)
      || (result.status !== 'complete' && result.status !== 'passthrough')) return;
    const payload = result.payload;
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return;
    const valuePayload = payload as Record<string, unknown>;
    const innerType = valuePayload.msg_type;
    if (typeof innerType !== 'string'
      || ![
        'discussion_token',
        'discussion_host_turn',
        'discussion_assignment',
        'discussion_cancel',
        'discussion_artifact_ack',
        'discussion_model_catalog_request',
      ].includes(innerType)) return;
    await this.#dispatchDiscussion(
      identity,
      message,
      innerType as ExternalMessageType,
      valuePayload,
      true,
    );
  }

  async #runDiscussionV1(
    identity: WorkerIdentity,
    message: NormalizedRongCloudMessage,
    raw: Record<string, unknown>,
    physicalAdmitted: boolean,
  ): Promise<void> {
    const generation = this.#bindingGeneration(identity);
    const conversation = conversationFrom(message, identity);
    const claim = physicalAdmitted
      ? undefined
      : await this.#claimLocal(identity, message.messageUid, conversation, generation);
    if (!physicalAdmitted && !claim) return;
    const parsed = parseDiscussionV1(raw);
    if (!parsed
      || parsed.payload.group_id !== message.targetId
      || parsed.action !== 'pass_turn'
      || parsed.payload.current_speaker !== identity.nodeId) {
      if (claim) await this.#admitOnly(identity, message, claim, generation);
      return;
    }
    const state = this.#discussionState(identity);
    this.#pruneV1(state);
    const logicalKey = JSON.stringify([bindingKey(identity), discussionV1Key(parsed)]);
    if (state.v1.has(logicalKey) || state.v1.size >= 1_024) {
      if (claim) await this.#admitOnly(identity, message, claim, generation);
      return;
    }
    const owner: V1Owner = {
      token: claim?.claimId ?? message.messageUid,
      state: 'active',
      expiresAt: Number.POSITIVE_INFINITY,
    };
    state.v1.set(logicalKey, owner);
    let started = false;
    try {
      await this.#recheckBinding(identity);
      this.#requireBindingGeneration(identity, generation);
      const submittedResumeSessionId = await this.#state.currentSession(conversation);
      this.#requireBindingGeneration(identity, generation);
      const workdir = await this.#binding.authorizeDefaultWorkdir(identity);
      this.#requireBindingGeneration(identity, generation);
      await this.#recheckBinding(identity);
      this.#requireBindingGeneration(identity, generation);
      const prompt = this.#v1Prompt(parsed);
      if (!prompt) throw new Error('prompt_too_large');
      const response = await this.#task.startTask({
        runtimeId: identity.runtimeId,
        conversationKey: conversationKey(conversation),
        prompt,
        workdir,
        ...(submittedResumeSessionId === undefined ? {} : { resumeSessionId: submittedResumeSessionId }),
      });
      started = true;
      if (!this.#bindingGenerationCurrent(identity, generation)) {
        await this.#task.cancelTask(response.taskId).catch(() => undefined);
        this.#terminalV1(state, owner);
        return;
      }
      const active: V1Active = {
        identity: { ...identity },
        conversation: { ...conversation },
        bindingKey: bindingKey(identity),
        logicalKey,
        taskId: response.taskId,
        generation,
        message: parsed,
        ...(submittedResumeSessionId === undefined ? {} : { submittedResumeSessionId }),
        lastEventId: 0,
        output: '',
        outputBytes: 0,
        outputTruncated: false,
        suppressed: false,
        terminal: false,
      };
      owner.task = active;
      if (claim) {
        const admitted = await this.#state.admitMessage(claim.key, claim.claimId).catch(() => false);
        if (!admitted) {
          active.suppressed = true;
          await this.#task.cancelTask(active.taskId).catch(() => undefined);
          this.#terminalV1(state, owner);
          return;
        }
        if (!this.#bindingGenerationCurrent(identity, generation)) {
          active.suppressed = true;
          this.#terminalV1(state, owner);
          return;
        }
        await this.#sendReceipt(identity, this.#receipt(message, message.messageUid), generation);
        if (!this.#bindingGenerationCurrent(identity, generation)) {
          active.suppressed = true;
          this.#terminalV1(state, owner);
          return;
        }
      }
      await this.#consumeV1(state, owner, active);
    } catch {
      if (!started && claim
        && owner.token === claim.claimId
        && state.v1.get(logicalKey) === owner) {
        state.v1.delete(logicalKey);
        await this.#state.releaseMessage(claim.key, claim.claimId).catch(() => undefined);
      } else {
        this.#terminalV1(state, owner);
      }
      if (physicalAdmitted && this.#bindingGenerationCurrent(identity, generation)) {
        await this.#sendV1Advance(identity, conversation, parsed, '[runtime_failed]', false);
      }
    }
  }

  #v1Prompt(message: DiscussionV1Message): string | undefined {
    const parts = [
      '[discussion v1 public turn]',
      `Originator: ${message.payload.originator_text}`,
      ...(message.payload.last_speaker_response === undefined
        ? [] : [`Previous public response: ${message.payload.last_speaker_response}`]),
      'Return only a public response for the next participant.',
    ];
    const prompt = parts.join('\n');
    return Buffer.byteLength(prompt, 'utf8') <= MAX_PROMPT_BYTES ? prompt : undefined;
  }

  async #consumeV1(
    state: BindingDiscussionState,
    owner: V1Owner,
    active: V1Active,
  ): Promise<void> {
    try {
      const iterator = this.#task.events(active.taskId)[Symbol.asyncIterator]();
      active.iterator = iterator;
      active.timer = this.#setTimeout(() => {
        active.timer = undefined;
        active.timeoutPromise = this.#expireV1(state, owner, active);
        void active.timeoutPromise.catch(() => undefined);
      }, DISCUSSION_TURN_TIMEOUT_MS);
      while (true) {
        const next = await iterator.next();
        if (next.done || active.suppressed) break;
        const event = next.value;
        if (event.task_id !== active.taskId || event.id <= active.lastEventId) continue;
        active.lastEventId = event.id;
        await this.#applyDiscussionSession(active, event);
        if (active.suppressed
          || !this.#bindingGenerationCurrent(active.identity, active.generation)) break;
        if (event.type === 'text_delta' && event.text) {
          this.#appendDiscussionOutput(active, event.text);
          continue;
        }
        if (event.type === 'completed') {
          if (event.output) this.#appendDiscussionCompleted(active, event.output);
          active.terminal = true;
          await this.#sendV1Advance(
            active.identity,
            active.conversation,
            active.message,
            active.output || '[no_response]',
            false,
            active,
          );
          break;
        }
        if (event.type === 'failed' || event.type === 'cancelled') {
          active.terminal = true;
          await this.#sendV1Advance(
            active.identity,
            active.conversation,
            active.message,
            event.type === 'cancelled' ? '[cancelled]' : '[runtime_failed]',
            false,
            active,
          );
          break;
        }
      }
    } catch {
      if (!active.suppressed) {
        await this.#sendV1Advance(
          active.identity,
          active.conversation,
          active.message,
          '[runtime_failed]',
          false,
          active,
        );
      }
    } finally {
      if (active.timer !== undefined) this.#clearTimeout(active.timer);
      if (active.timeoutPromise !== undefined) await active.timeoutPromise.catch(() => undefined);
      this.#terminalV1(state, owner);
    }
  }

  async #expireV1(
    state: BindingDiscussionState,
    owner: V1Owner,
    active: V1Active,
  ): Promise<void> {
    if (active.terminal || active.suppressed) return;
    active.terminal = true;
    await this.#task.cancelTask(active.taskId).catch(() => undefined);
    if (active.iterator?.return !== undefined) await active.iterator.return().catch(() => undefined);
    try {
      await this.#sendV1Advance(
        active.identity,
        active.conversation,
        active.message,
        '[turn_timeout]',
        true,
        active,
      );
    } finally {
      active.suppressed = true;
    }
    this.#terminalV1(state, owner);
  }

  #terminalV1(state: BindingDiscussionState, owner: V1Owner): void {
    owner.state = 'terminal';
    owner.expiresAt = this.#time() + DISCUSSION_V2_LIMITS.logicalTombstoneTtlMs;
    owner.task = undefined;
    this.#pruneV1(state);
  }

  #pruneV1(state: BindingDiscussionState): void {
    const now = this.#time();
    for (const [key, owner] of state.v1) {
      if (owner.state === 'terminal' && owner.expiresAt <= now) state.v1.delete(key);
    }
  }

  #terminalV2Reservation(state: BindingDiscussionState, owner: V2LogicalOwner | undefined): void {
    if (owner === undefined || state.logicalV2.get(owner.logicalKey) !== owner) return;
    owner.state = 'terminal';
    owner.expiresAt = this.#time() + DISCUSSION_V2_LIMITS.logicalTombstoneTtlMs;
    this.#pruneV2Reservations(state);
  }

  #pruneV2Reservations(state: BindingDiscussionState): void {
    const now = this.#time();
    for (const [key, owner] of state.logicalV2) {
      if (owner.state === 'terminal' && owner.expiresAt <= now) state.logicalV2.delete(key);
    }
  }

  #v2CancellationKey(cancellation: V2Cancellation): string {
    return JSON.stringify([
      cancellation.senderId,
      cancellation.discussionId,
      cancellation.stateVersion,
      cancellation.round,
    ]);
  }

  #v2CancellationMatches(
    cancellation: V2Cancellation,
    value: Pick<V2LogicalOwner, 'senderId' | 'discussionId' | 'stateVersion' | 'round'>,
  ): boolean {
    return cancellation.senderId === value.senderId
      && cancellation.discussionId === value.discussionId
      && (cancellation.stateVersion > value.stateVersion
        || (cancellation.stateVersion === value.stateVersion && cancellation.round === value.round));
  }

  #recordV2Cancellation(state: BindingDiscussionState, cancellation: V2Cancellation): void {
    const key = this.#v2CancellationKey(cancellation);
    if (!state.v2Cancellations.has(key)) {
      if (state.v2Cancellations.size >= DISCUSSION_V2_LIMITS.maxCancelTombstones) {
        const oldest = state.v2Cancellations.keys().next().value;
        if (oldest !== undefined) state.v2Cancellations.delete(oldest);
      }
      state.v2Cancellations.set(key, cancellation);
    }
    for (const owner of state.logicalV2.values()) {
      if (owner.state === 'prestart' && this.#v2CancellationMatches(cancellation, owner)) {
        this.#terminalV2Reservation(state, owner);
      }
    }
  }

  #v2Cancelled(state: BindingDiscussionState, owner: V2LogicalOwner): boolean {
    return [...state.v2Cancellations.values()].some((cancellation) =>
      this.#v2CancellationMatches(cancellation, owner));
  }

  #v2ReservationCurrent(state: BindingDiscussionState, owner: V2LogicalOwner): boolean {
    return state.logicalV2.get(owner.logicalKey) === owner && owner.state === 'prestart';
  }

  #requireV2Reservation(state: BindingDiscussionState, owner: V2LogicalOwner): void {
    if (!this.#v2ReservationCurrent(state, owner)) throw new Error('logical_reservation_invalidated');
  }

  async #sendV1Advance(
    identity: WorkerIdentity,
    conversation: ConversationIdentity,
    message: DiscussionV1Message,
    response: string,
    timeout: boolean,
    buffer?: Pick<V1Active, 'bindingKey' | 'taskId' | 'generation' | 'suppressed'>,
  ): Promise<void> {
    const advance = timeout
      ? advanceAfterTimeout(message.payload, identity.nodeId)
      : advanceAfterCompleted(message.payload, identity.nodeId);
    const base = {
      ...message.payload,
      last_speaker_response: utf8Prefix(response, 100_000),
    };
    let output: DiscussionV1Message;
    if (advance.kind === 'pass_turn') {
      output = buildDiscussionV1({
        action: 'pass_turn',
        discussionId: message.discussion_id,
        payload: {
          ...base,
          current_speaker: advance.nextSpeaker,
          next_speaker: advance.nextSpeaker,
          round: advance.round,
        },
        timestamp: this.#time(),
      });
    } else {
      output = buildDiscussionV1({
        action: advance.kind === 'end_discussion' ? 'end_discussion' : 'abort',
        discussionId: message.discussion_id,
        payload: {
          ...base,
          round: advance.kind === 'end_discussion' ? advance.round : message.payload.round,
          next_speaker: undefined,
        },
        timestamp: this.#time(),
      });
    }
    await this.#sendDiscussionPayload(
      identity,
      conversation,
      'command',
      output as unknown as Record<string, unknown>,
      buffer === undefined
        ? undefined
        : {
            bindingKey: buffer.bindingKey,
            taskId: buffer.taskId,
            kind: 'terminal',
            generation: buffer.generation,
            active: buffer,
          },
    );
  }

  async #runDiscussionV2(
    identity: WorkerIdentity,
    message: NormalizedRongCloudMessage,
    raw: Record<string, unknown>,
    physicalAdmitted: boolean,
  ): Promise<void> {
    const generation = this.#bindingGeneration(identity);
    const conversation = conversationFrom(message, identity);
    const claim = physicalAdmitted
      ? undefined
      : await this.#claimLocal(identity, message.messageUid, conversation, generation);
    if (!physicalAdmitted && !claim) return;
    const parsed = parseDiscussionV2Command(raw);
    if (!parsed
      || (parsed.msg_type !== 'discussion_assignment' && parsed.msg_type !== 'discussion_host_turn')
      || parsed.chatroomId !== message.targetId
      || identity.nodeId.length > DISCUSSION_V2_LIMITS.maxId
      || message.senderId.length > DISCUSSION_V2_LIMITS.maxId
      || (parsed.msg_type === 'discussion_assignment' && parsed.targetId !== identity.nodeId)) {
      if (claim) await this.#admitOnly(identity, message, claim, generation);
      return;
    }
    if (parsed.msg_type === 'discussion_host_turn'
      && !Object.values(parsed.roles).some((role) =>
        role.nodeId === identity.nodeId && role.isHost === true)) {
      if (claim) await this.#admitOnly(identity, message, claim, generation);
      return;
    }
    const state = this.#discussionState(identity);
    this.#pruneV2Reservations(state);
    const logicalKey = discussionV2LogicalKey(message.senderId, parsed);
    const logicalOwner: V2LogicalOwner = {
      logicalKey,
      senderId: message.senderId,
      discussionId: parsed.discussionId,
      stateVersion: parsed.stateVersion,
      round: parsed.round,
      state: 'prestart',
      expiresAt: Number.POSITIVE_INFINITY,
    };
    if (this.#v2Cancelled(state, logicalOwner)
      || state.logicalV2.has(logicalKey)
      || state.logicalV2.size >= DISCUSSION_V2_LIMITS.maxLogicalTombstones) {
      if (claim) await this.#admitOnly(identity, message, claim, generation);
      return;
    }
    state.logicalV2.set(logicalKey, logicalOwner);
    let started = false;
    let logicalClaimed = false;
    try {
      await this.#recheckBinding(identity);
      this.#requireBindingGeneration(identity, generation);
      this.#requireV2Reservation(state, logicalOwner);
      const submittedResumeSessionId = await this.#state.currentSession(conversation);
      this.#requireBindingGeneration(identity, generation);
      this.#requireV2Reservation(state, logicalOwner);
      const workdir = await this.#binding.authorizeDefaultWorkdir(identity);
      this.#requireBindingGeneration(identity, generation);
      this.#requireV2Reservation(state, logicalOwner);
      await this.#recheckBinding(identity);
      this.#requireBindingGeneration(identity, generation);
      this.#requireV2Reservation(state, logicalOwner);
      const prompt = this.#v2Prompt(parsed);
      if (!prompt || Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) throw new Error('prompt_too_large');
      const response = await this.#task.startTask({
        runtimeId: identity.runtimeId,
        conversationKey: conversationKey(conversation),
        prompt,
        workdir,
        ...(submittedResumeSessionId === undefined ? {} : { resumeSessionId: submittedResumeSessionId }),
      });
      started = true;
      if (!this.#bindingGenerationCurrent(identity, generation)
        || !this.#v2ReservationCurrent(state, logicalOwner)) {
        await this.#task.cancelTask(response.taskId).catch(() => undefined);
        this.#terminalV2Reservation(state, logicalOwner);
        if (claim) await this.#admitOnly(identity, message, claim, generation, true);
        return;
      }
      const logical = state.guard.claim(message.senderId, parsed, identity.nodeId);
      if (logical.status !== 'accepted' || logical.key !== logicalKey) {
        this.#terminalV2Reservation(state, logicalOwner);
        await this.#task.cancelTask(response.taskId).catch(() => undefined);
        if (claim) await this.#admitOnly(identity, message, claim, generation, true);
        return;
      }
      logicalClaimed = true;
      logicalOwner.state = 'committing';
      const active: DiscussionActive = {
        identity: { ...identity },
        conversation: { ...conversation },
        bindingKey: bindingKey(identity),
        logicalKey,
        taskId: response.taskId,
        generation,
        command: parsed,
        ...(submittedResumeSessionId === undefined ? {} : { submittedResumeSessionId }),
        lastEventId: 0,
        output: '',
        outputBytes: 0,
        outputTruncated: false,
        pendingDelta: '',
        seq: 0,
        outputTail: Promise.resolve(),
        outputFinalQueued: false,
        suppressed: false,
        terminal: false,
        logicalOwner,
      };
      state.active.set(logicalKey, active);
      if (claim) {
        const admitted = await this.#state.admitMessage(claim.key, claim.claimId).catch(() => false);
        if (!admitted) {
          active.suppressed = true;
          state.active.delete(logicalKey);
          state.guard.complete(logicalKey);
          this.#terminalV2Reservation(state, logicalOwner);
          await this.#task.cancelTask(active.taskId).catch(() => undefined);
          return;
        }
        if (!this.#bindingGenerationCurrent(identity, generation)
          || state.logicalV2.get(logicalKey) !== logicalOwner
          || logicalOwner.state !== 'committing') {
          await this.#cancelDiscussionV2Active(state, active);
          return;
        }
        logicalOwner.state = 'active';
        await this.#sendReceipt(identity, this.#receipt(message, message.messageUid), generation);
        if (!this.#bindingGenerationCurrent(identity, generation)) {
          await this.#cancelDiscussionV2Active(state, active);
          return;
        }
      } else {
        logicalOwner.state = 'active';
      }
      if (active.suppressed) {
        if (active.cleanupPromise !== undefined) await active.cleanupPromise;
        return;
      }
      await this.#consumeDiscussionV2(state, active);
    } catch {
      if (logicalClaimed) {
        state.guard.complete(logicalKey);
        state.active.delete(logicalKey);
      }
      if (!started
        && logicalOwner.state === 'prestart'
        && state.logicalV2.get(logicalOwner.logicalKey) === logicalOwner) {
        state.logicalV2.delete(logicalOwner.logicalKey);
        if (claim) await this.#state.releaseMessage(claim.key, claim.claimId).catch(() => undefined);
      } else {
        this.#terminalV2Reservation(state, logicalOwner);
        if (claim) await this.#admitOnly(identity, message, claim, generation, true);
      }
      if (physicalAdmitted && this.#bindingGenerationCurrent(identity, generation)) {
        await this.#sendV2NodeError(identity, conversation, parsed, 'model_error');
      }
    }
  }

  #v2Prompt(command: DiscussionAssignment | DiscussionHostTurn): string {
    if (command.msg_type === 'discussion_assignment') {
      return [
        '[discussion v2 public contribution]',
        `Topic: ${command.topic}`,
        `Goal: ${command.goal}`,
        `Task: ${command.task}`,
        ...(command.role === undefined ? [] : [`Role: ${command.role.roleInstructions}`]),
        'Return only the public contribution.',
      ].join('\n');
    }
    return [
      '[discussion v2 host decision]',
      `Topic: ${command.topic}`,
      `Goal: ${command.goal}`,
      `Event summary: ${command.eventSummary}`,
      `Allowed decisions: ${command.allowedDecisions.join(', ')}`,
      'Return exactly one JSON object matching an allowed public decision.',
    ].join('\n');
  }

  async #consumeDiscussionV2(
    state: BindingDiscussionState,
    active: DiscussionActive,
  ): Promise<void> {
    try {
      const iterator = this.#task.events(active.taskId)[Symbol.asyncIterator]();
      active.iterator = iterator;
      active.watchdogTimer = this.#setTimeout(() => {
        active.watchdogTimer = undefined;
        active.watchdogPromise = this.#expireDiscussionV2(state, active);
        void active.watchdogPromise.catch(() => undefined);
      }, TASK_WATCHDOG_MS);
      while (true) {
        const next = await iterator.next();
        if (next.done || active.suppressed) break;
        const event = next.value;
        if (event.task_id !== active.taskId || event.id <= active.lastEventId) continue;
        active.lastEventId = event.id;
        await this.#applyDiscussionSession(active, event);
        if (active.suppressed
          || !this.#bindingGenerationCurrent(active.identity, active.generation)) break;
        if (event.type === 'text_delta' && event.text) {
          const previousLength = active.output.length;
          this.#appendDiscussionOutput(active, event.text);
          if (active.command.msg_type === 'discussion_assignment') {
            active.pendingDelta += active.output.slice(previousLength);
            await this.#scheduleDiscussionDelta(active);
          }
          continue;
        }
        if (event.type === 'completed') {
          if (event.output) this.#appendDiscussionCompleted(active, event.output);
          active.terminal = true;
          await this.#flushDiscussionDelta(active);
          await this.#queueDiscussionOutput(active, true, async () => {
            if (active.command.msg_type === 'discussion_assignment') {
              if (active.output.trim().length > 0) {
                const payload = buildContributionCompleted(
                  active.command,
                  active.identity.nodeId,
                  active.output,
                  this.#time(),
                );
                await this.#sendDiscussionPayload(
                  active.identity,
                  active.conversation,
                  'command_result',
                  payload as unknown as Record<string, unknown>,
                  {
                    bindingKey: active.bindingKey,
                    taskId: active.taskId,
                    kind: 'terminal',
                    generation: active.generation,
                    active,
                  },
                );
              } else {
                await this.#sendV2NodeErrorDirect(
                  active.identity,
                  active.conversation,
                  active.command,
                  'model_error',
                  active,
                );
              }
            } else {
              await this.#finishHostDecision(active);
            }
          });
          break;
        }
        if (event.type === 'failed' || event.type === 'cancelled') {
          active.terminal = true;
          await this.#sendV2NodeError(
            active.identity,
            active.conversation,
            active.command,
            'model_error',
            active,
          );
          break;
        }
      }
    } catch {
      if (!active.suppressed) {
        await this.#sendV2NodeError(
          active.identity,
          active.conversation,
          active.command,
          'model_error',
          active,
        ).catch(() => undefined);
      }
    } finally {
      if (active.cleanupPromise !== undefined) {
        await active.cleanupPromise;
      } else {
        if (active.deltaTimer !== undefined) this.#clearTimeout(active.deltaTimer);
        if (active.watchdogTimer !== undefined) this.#clearTimeout(active.watchdogTimer);
        if (active.watchdogPromise !== undefined) await active.watchdogPromise.catch(() => undefined);
        await active.outputTail;
        if (state.active.get(active.logicalKey) === active) state.active.delete(active.logicalKey);
        state.guard.complete(active.logicalKey);
        this.#terminalV2Reservation(state, active.logicalOwner);
      }
    }
  }

  async #scheduleDiscussionDelta(active: DiscussionActive): Promise<void> {
    if (Buffer.byteLength(active.pendingDelta, 'utf8') >= OUTPUT_EARLY_FLUSH_BYTES) {
      if (active.deltaTimer !== undefined) {
        this.#clearTimeout(active.deltaTimer);
        active.deltaTimer = undefined;
      }
      await this.#flushDiscussionDelta(active);
      return;
    }
    if (active.deltaTimer !== undefined) return;
    active.deltaTimer = this.#setTimeout(() => {
      active.deltaTimer = undefined;
      void this.#flushDiscussionDelta(active).catch(() => undefined);
    }, OUTPUT_FLUSH_MS);
  }

  #queueDiscussionOutput(
    active: DiscussionActive,
    terminal: boolean,
    operation: () => Promise<void>,
  ): Promise<void> {
    if (active.outputFinalQueued) return active.outputTail;
    if (terminal) active.outputFinalQueued = true;
    const queued = active.outputTail.then(async () => {
      if (!active.suppressed
        && this.#bindingGenerationCurrent(active.identity, active.generation)) await operation();
    });
    active.outputTail = queued.catch(() => undefined);
    return queued;
  }

  #flushDiscussionDelta(active: DiscussionActive): Promise<void> {
    if (active.deltaTimer !== undefined) {
      this.#clearTimeout(active.deltaTimer);
      active.deltaTimer = undefined;
    }
    if (active.suppressed
      || active.command.msg_type !== 'discussion_assignment'
      || active.pendingDelta.length === 0) return Promise.resolve();
    const content = active.pendingDelta;
    active.pendingDelta = '';
    const payload = buildContributionDelta(
      active.command,
      active.identity.nodeId,
      content,
      active.seq,
      this.#time(),
    );
    active.seq += 1;
    return this.#queueDiscussionOutput(active, false, () => this.#sendDiscussionPayload(
      active.identity,
      active.conversation,
      'command_result',
      payload as unknown as Record<string, unknown>,
      {
        bindingKey: active.bindingKey,
        taskId: active.taskId,
        kind: 'coarse',
        generation: active.generation,
        active,
      },
    ));
  }

  async #finishHostDecision(active: DiscussionActive): Promise<void> {
    if (active.command.msg_type !== 'discussion_host_turn') return;
    try {
      const decision = parseHostDecision(active.output, active.command);
      if (decision.action === 'finish') {
        const reference = await this.#sendArtifact(active, decision);
        if (active.suppressed) return;
        if (!reference) {
          await this.#sendV2NodeErrorDirect(
            active.identity,
            active.conversation,
            active.command,
            'timeout',
            active,
          );
          return;
        }
        const payload = buildHostDecisionOutput(
          active.command,
          active.identity.nodeId,
          decision,
          this.#time(),
          reference,
        );
        await this.#sendDiscussionPayload(
          active.identity,
          active.conversation,
          'command_result',
          payload,
          {
            bindingKey: active.bindingKey,
            taskId: active.taskId,
            kind: 'terminal',
            generation: active.generation,
            active,
          },
        );
        return;
      }
      const payload = buildHostDecisionOutput(
        active.command,
        active.identity.nodeId,
        decision,
        this.#time(),
      );
      await this.#sendDiscussionPayload(
        active.identity,
        active.conversation,
        'command_result',
        payload,
        {
          bindingKey: active.bindingKey,
          taskId: active.taskId,
          kind: 'terminal',
          generation: active.generation,
          active,
        },
      );
    } catch {
      await this.#sendV2NodeErrorDirect(
        active.identity,
        active.conversation,
        active.command,
        'invalid_response',
        active,
      );
    }
  }

  async #sendArtifact(
    active: DiscussionActive,
    decision: Extract<HostDecision, { action: 'finish' }>,
  ): Promise<ArtifactReference | undefined> {
    const state = this.#discussion.get(active.bindingKey);
    const turn = active.command;
    if (!state || active.suppressed || turn.msg_type !== 'discussion_host_turn') return undefined;
    let remaining = decision.artifact.content;
    let baseVersion = decision.artifact.baseVersion;
    let artifactId = turn.currentArtifact?.artifactId;
    let pieceIndex = 0;
    while (remaining.length > 0 && !active.suppressed) {
      const built = this.#buildArtifactPiece(
        turn,
        active.identity.nodeId,
        decision,
        remaining,
        baseVersion,
        pieceIndex,
      );
      if (!built) return undefined;
      const updateId = built.payload.idempotencyKey;
      if (typeof updateId !== 'string') return undefined;
      const expectation: ArtifactAckExpectation = {
        senderId: active.conversation.senderId,
        discussionId: turn.discussionId,
        requestId: turn.requestId,
        stateVersion: turn.stateVersion,
        round: turn.round,
        updateId,
        ...(artifactId === undefined ? {} : { artifactId }),
        artifactVersion: baseVersion + 1,
      };
      if (state.guard.registerArtifactAck(expectation).status !== 'accepted') return undefined;
      const acknowledgement = this.#installArtifactWaiter(state, active.logicalKey, expectation);
      try {
        await this.#sendDiscussionPayload(
          active.identity,
          active.conversation,
          'command_result',
          built.payload,
          {
            bindingKey: active.bindingKey,
            taskId: active.taskId,
            kind: 'terminal',
            generation: active.generation,
            active,
          },
        );
      } catch {
        this.#clearArtifactWaiter(state, this.#artifactAckKey(expectation));
        return undefined;
      }
      const reference = await acknowledgement;
      if (!reference || active.suppressed) return undefined;
      if (artifactId !== undefined && reference.artifactId !== artifactId) return undefined;
      artifactId = reference.artifactId;
      baseVersion = reference.artifactVersion;
      remaining = remaining.slice(built.characters);
      pieceIndex += 1;
      if (remaining.length > 0) await this.#sleep(DISCUSSION_V2_LIMITS.artifactPacingMs);
    }
    return artifactId === undefined ? undefined : { artifactId, artifactVersion: baseVersion };
  }

  #buildArtifactPiece(
    turn: DiscussionHostTurn,
    senderId: string,
    decision: Extract<HostDecision, { action: 'finish' }>,
    remaining: string,
    baseVersion: number,
    pieceIndex: number,
  ): { payload: Record<string, unknown>; characters: number } | undefined {
    let low = 1;
    let high = remaining.length;
    let selected: { payload: Record<string, unknown>; characters: number } | undefined;
    while (low <= high) {
      let middle = Math.floor((low + high) / 2);
      if (middle < remaining.length && /[\uD800-\uDBFF]/.test(remaining[middle - 1]!)) middle -= 1;
      if (middle < 1) break;
      const content = remaining.slice(0, middle);
      try {
        const payload = buildArtifactUpdate(
          turn,
          senderId,
          {
            artifactType: decision.artifact.artifactType,
            title: decision.artifact.title,
            operation: pieceIndex === 0 ? 'replace' : 'append',
            content,
            baseVersion,
            isFinal: middle === remaining.length,
          },
          this.#time(),
          `piece-${pieceIndex}`,
        );
        selected = { payload, characters: middle };
        low = middle + 1;
      } catch {
        high = middle - 1;
      }
    }
    return selected;
  }

  #artifactAckKey(value: Pick<ArtifactAckExpectation,
    'senderId' | 'discussionId' | 'requestId' | 'stateVersion' | 'round' | 'updateId'>): string {
    return JSON.stringify([
      value.senderId,
      value.discussionId,
      value.requestId,
      value.stateVersion,
      value.round,
      value.updateId,
    ]);
  }

  #installArtifactWaiter(
    state: BindingDiscussionState,
    logicalKey: string,
    expectation: ArtifactAckExpectation,
  ): Promise<ArtifactReference | undefined> {
    const key = this.#artifactAckKey(expectation);
    return new Promise((resolve) => {
      const timer = this.#setTimeout(() => {
        const waiter = state.ackWaiters.get(key);
        if (!waiter) return;
        state.ackWaiters.delete(key);
        waiter.resolve(undefined);
      }, DISCUSSION_V2_LIMITS.ackTimeoutMs);
      state.ackWaiters.set(key, { logicalKey, timer, resolve });
    });
  }

  #clearArtifactWaiter(state: BindingDiscussionState, key: string): void {
    const waiter = state.ackWaiters.get(key);
    if (!waiter) return;
    state.ackWaiters.delete(key);
    this.#clearTimeout(waiter.timer);
    waiter.resolve(undefined);
  }

  #clearArtifactWaitersForLogical(state: BindingDiscussionState, logicalKey: string): void {
    for (const [key, waiter] of state.ackWaiters) {
      if (waiter.logicalKey === logicalKey) this.#clearArtifactWaiter(state, key);
    }
  }

  async #expireDiscussionV2(
    state: BindingDiscussionState,
    active: DiscussionActive,
  ): Promise<void> {
    if (active.cleanupPromise !== undefined) {
      await active.cleanupPromise;
      return;
    }
    if (active.terminal || active.suppressed) return;
    active.terminal = true;
    this.#clearArtifactWaitersForLogical(state, active.logicalKey);
    if (active.deltaTimer !== undefined) this.#clearTimeout(active.deltaTimer);
    await this.#task.cancelTask(active.taskId).catch(() => undefined);
    if (active.iterator?.return !== undefined) await active.iterator.return().catch(() => undefined);
    try {
      await this.#sendV2NodeError(
        active.identity,
        active.conversation,
        active.command,
        'timeout',
        active,
      ).catch(() => undefined);
    } finally {
      active.suppressed = true;
    }
    state.active.delete(active.logicalKey);
    state.guard.complete(active.logicalKey);
    this.#terminalV2Reservation(state, active.logicalOwner);
  }

  async #sendV2NodeError(
    identity: WorkerIdentity,
    conversation: ConversationIdentity,
    command: DiscussionAssignment | DiscussionHostTurn,
    category: 'invalid_response' | 'model_error' | 'timeout',
    active?: DiscussionActive,
  ): Promise<void> {
    if (active !== undefined) {
      await this.#queueDiscussionOutput(active, true, () => this.#sendV2NodeErrorDirect(
        identity,
        conversation,
        command,
        category,
        active,
      ));
      return;
    }
    await this.#sendV2NodeErrorDirect(identity, conversation, command, category);
  }

  async #sendV2NodeErrorDirect(
    identity: WorkerIdentity,
    conversation: ConversationIdentity,
    command: DiscussionAssignment | DiscussionHostTurn,
    category: 'invalid_response' | 'model_error' | 'timeout',
    active?: Pick<DiscussionActive, 'bindingKey' | 'taskId' | 'generation' | 'suppressed'>,
  ): Promise<void> {
    await this.#sendDiscussionPayload(
      identity,
      conversation,
      'command_result',
      buildNodeError(command, identity.nodeId, category, this.#time()),
      active === undefined
        ? undefined
        : {
            bindingKey: active.bindingKey,
            taskId: active.taskId,
            kind: 'terminal',
            generation: active.generation,
            active,
          },
    );
  }

  async #runDiscussionControl(
    identity: WorkerIdentity,
    message: NormalizedRongCloudMessage,
    msgType: 'discussion_cancel' | 'discussion_artifact_ack',
    value: Record<string, unknown>,
    physicalAdmitted: boolean,
  ): Promise<void> {
    const generation = this.#bindingGeneration(identity);
    const conversation = conversationFrom(message, identity);
    const claim = physicalAdmitted
      ? undefined
      : await this.#claimLocal(identity, message.messageUid, conversation, generation);
    if (!physicalAdmitted && !claim) return;
    const state = this.#discussionState(identity);
    let mutationAccepted = false;
    if (msgType === 'discussion_cancel') {
      const result = state.guard.cancel(message.senderId, value);
      if (result.status === 'accepted') {
        mutationAccepted = true;
        const parsed = parseDiscussionV2Command(value);
        if (parsed?.msg_type === 'discussion_cancel') {
          this.#recordV2Cancellation(state, {
            senderId: message.senderId,
            discussionId: parsed.discussionId,
            stateVersion: parsed.stateVersion,
            round: parsed.round,
          });
        }
        state.wire.clearDiscussion(result.clearSenderId, result.clearDiscussionId);
        await Promise.all(result.abortedKeys.map((key) => {
          const active = state.active.get(key);
          return active === undefined
            ? Promise.resolve()
            : this.#cancelDiscussionV2Active(state, active);
        }));
        if (!this.#bindingGenerationCurrent(identity, generation) && !claim) return;
      }
    } else {
      const parsed = parseDiscussionV2Command(value);
      const accepted = parsed?.msg_type === 'discussion_artifact_ack'
        && parsed.chatroomId === message.targetId
        ? state.guard.acceptArtifactAck(message.senderId, parsed)
        : { status: 'invalid' as const };
      if (accepted.status === 'accepted' && parsed?.msg_type === 'discussion_artifact_ack') {
        mutationAccepted = true;
        const key = this.#artifactAckKey({
          senderId: message.senderId,
          discussionId: parsed.discussionId,
          requestId: parsed.requestId,
          stateVersion: parsed.stateVersion,
          round: parsed.round,
          updateId: parsed.updateId,
        });
        const waiter = state.ackWaiters.get(key);
        if (waiter) {
          state.ackWaiters.delete(key);
          this.#clearTimeout(waiter.timer);
          waiter.resolve({ artifactId: parsed.artifactId, artifactVersion: parsed.artifactVersion });
        }
      }
    }
    if (claim) await this.#admitOnly(identity, message, claim, generation, mutationAccepted);
  }

  #cancelDiscussionV2Active(
    state: BindingDiscussionState,
    active: DiscussionActive,
  ): Promise<void> {
    if (active.cleanupPromise !== undefined) return active.cleanupPromise;
    active.suppressed = true;
    active.terminal = true;
    if (active.deltaTimer !== undefined) {
      this.#clearTimeout(active.deltaTimer);
      active.deltaTimer = undefined;
    }
    this.#clearArtifactWaitersForLogical(state, active.logicalKey);
    this.#removeBufferedTask(active.bindingKey, active.taskId);
    const cleanup = Promise.resolve().then(async () => {
      await Promise.all([
        this.#task.cancelTask(active.taskId).catch(() => undefined),
        active.iterator?.return === undefined
          ? Promise.resolve()
          : active.iterator.return().then(() => undefined).catch(() => undefined),
      ]);
      await active.outputTail;
      this.#removeBufferedTask(active.bindingKey, active.taskId);
    }).finally(() => {
      if (active.watchdogTimer !== undefined) {
        this.#clearTimeout(active.watchdogTimer);
        active.watchdogTimer = undefined;
      }
      if (state.active.get(active.logicalKey) === active) state.active.delete(active.logicalKey);
      state.guard.complete(active.logicalKey);
      this.#terminalV2Reservation(state, active.logicalOwner);
    });
    active.cleanupPromise = cleanup;
    return cleanup;
  }

  async #runDiscussionCatalog(
    identity: WorkerIdentity,
    message: NormalizedRongCloudMessage,
    value: Record<string, unknown>,
    physicalAdmitted: boolean,
  ): Promise<void> {
    const generation = this.#bindingGeneration(identity);
    const conversation = conversationFrom(message, identity);
    const claim = physicalAdmitted
      ? undefined
      : await this.#claimLocal(identity, message.messageUid, conversation, generation);
    if (!physicalAdmitted && !claim) return;
    const request = parseDiscussionModelCatalogRequest(value);
    if (!request) {
      if (claim) await this.#admitOnly(identity, message, claim, generation);
      return;
    }
    let outputSent = false;
    try {
      const catalog = await this.#control.modelCatalog(identity);
      this.#requireBindingGeneration(identity, generation);
      const payload = buildModelCatalogResponse(
        request,
        catalog,
        this.#time(),
      );
      this.#requireBindingGeneration(identity, generation);
      await this.#sendDiscussionPayload(
        identity,
        conversation,
        'command_result',
        payload as unknown as Record<string, unknown>,
        undefined,
        generation,
      );
      outputSent = true;
    } catch {
      if (claim) await this.#state.releaseMessage(claim.key, claim.claimId).catch(() => undefined);
      return;
    }
    if (claim) await this.#admitOnly(identity, message, claim, generation, outputSent);
  }

  async #runRoleRecommendation(
    identity: WorkerIdentity,
    message: NormalizedRongCloudMessage,
    value: Record<string, unknown>,
    physicalAdmitted: boolean,
  ): Promise<void> {
    const generation = this.#bindingGeneration(identity);
    const conversation = conversationFrom(message, identity);
    const claim = physicalAdmitted
      ? undefined
      : await this.#claimLocal(identity, message.messageUid, conversation, generation);
    if (!physicalAdmitted && !claim) return;
    const request = message.senderId === 'system'
      ? parseRoleRecommendationRequest(value)
      : null;
    if (!request) {
      if (claim) await this.#admitOnly(identity, message, claim, generation);
      return;
    }

    let taskId: string | undefined;
    let iterator: AsyncIterator<BridgeTaskEvent> | undefined;
    let watchdog: unknown;
    try {
      await this.#recheckBinding(identity);
      this.#requireBindingGeneration(identity, generation);
      const workdir = await this.#binding.authorizeDefaultWorkdir(identity);
      this.#requireBindingGeneration(identity, generation);
      await this.#recheckBinding(identity);
      this.#requireBindingGeneration(identity, generation);
      const prompt = this.#roleRecommendationPrompt(request);
      if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) throw new Error('prompt_too_large');
      const started = await this.#task.startTask({
        runtimeId: identity.runtimeId,
        conversationKey: conversationKey(conversation),
        prompt,
        workdir,
      });
      taskId = started.taskId;
      this.#requireBindingGeneration(identity, generation);
      iterator = this.#task.events(taskId)[Symbol.asyncIterator]();
      const output = await this.#collectRoleRecommendation(taskId, iterator, (timer) => {
        watchdog = timer;
      });
      this.#requireBindingGeneration(identity, generation);
      const roles = output.kind === 'completed'
        ? parseRoleRecommendationResponse(JSON.parse(output.output.trim()) as unknown, request)
        : null;
      const response = this.#structuredResponse(conversation, 'command_result', roles === null ? {
        msg_type: 'discussion_role_recommendation_response',
        request_id: request.requestId,
        error_code: output.kind === 'timeout'
          ? 'role_recommendation_timeout'
          : 'role_recommendation_invalid',
      } : {
        msg_type: 'discussion_role_recommendation_response',
        request_id: request.requestId,
        roles: roles.map((role) => ({
          role_name: role.roleName,
          role_prompt: role.rolePrompt,
          node_id: role.nodeId,
          model: role.model,
          speaking_order: role.speakingOrder,
        })),
      });
      if (claim) {
        await this.#finishRead(identity, message, conversation, claim, response, generation);
      } else {
        await this.#sendWorker(identity, response);
      }
    } catch {
      if (taskId !== undefined) await this.#task.cancelTask(taskId).catch(() => undefined);
      if (!this.#bindingGenerationCurrent(identity, generation)) {
        if (claim) await this.#state.releaseMessage(claim.key, claim.claimId).catch(() => undefined);
        return;
      }
      const response = this.#structuredResponse(conversation, 'command_result', {
        msg_type: 'discussion_role_recommendation_response',
        request_id: request.requestId,
        error_code: 'role_recommendation_invalid',
      });
      if (claim) {
        await this.#finishRead(identity, message, conversation, claim, response, generation);
      } else {
        await this.#sendWorker(identity, response).catch(() => undefined);
      }
    } finally {
      if (watchdog !== undefined) this.#clearTimeout(watchdog);
      if (iterator?.return !== undefined) void iterator.return().catch(() => undefined);
    }
  }

  #roleRecommendationPrompt(request: RoleRecommendationRequest): string {
    return [
      '[private system role recommendation]',
      `Topic: ${request.topic}`,
      `Goal: ${request.goal}`,
      `Maximum roles: ${request.maxRoles}`,
      `Candidates: ${JSON.stringify(request.candidates)}`,
      `Host instructions: ${request.recommendationPrompt}`,
      'Return exactly one JSON object with a roles array. Use each node_id at most once, use only listed models or null, and use contiguous speaking_order values beginning at 0. Do not wrap the JSON in Markdown.',
    ].join('\n');
  }

  async #collectRoleRecommendation(
    taskId: string,
    iterator: AsyncIterator<BridgeTaskEvent>,
    registerWatchdog: (timer: unknown) => void,
  ): Promise<{ kind: 'completed'; output: string } | { kind: 'invalid' } | { kind: 'timeout' }> {
    const output = { output: '', outputBytes: 0, outputTruncated: false };
    const terminal = (async () => {
      while (true) {
        const next = await iterator.next();
        if (next.done) return { kind: 'invalid' as const };
        const event = next.value;
        if (event.task_id !== taskId) continue;
        if (event.type === 'text_delta' && event.text) {
          this.#appendDiscussionOutput(output, event.text);
          continue;
        }
        if (event.type === 'completed') {
          if (event.output) this.#appendDiscussionCompleted(output, event.output);
          return output.outputTruncated || output.output.trim().length === 0
            ? { kind: 'invalid' as const }
            : { kind: 'completed' as const, output: output.output };
        }
        if (event.type === 'failed' || event.type === 'cancelled') {
          return { kind: 'invalid' as const };
        }
      }
    })();
    const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
      registerWatchdog(this.#setTimeout(() => resolve({ kind: 'timeout' }), ROLE_RECOMMENDATION_WATCHDOG_MS));
    });
    const result = await Promise.race([terminal, timeout]);
    if (result.kind === 'timeout') {
      await this.#task.cancelTask(taskId).catch(() => undefined);
    }
    return result;
  }

  async #recheckBinding(identity: WorkerIdentity): Promise<void> {
    const bound = await this.#binding.binding(identity);
    if (!bound
      || bound.runtimeId !== identity.runtimeId
      || bound.nodeId !== identity.nodeId
      || this.#disposedBindings.has(bindingKey(identity))) throw new Error('binding_unavailable');
  }

  #bindingGeneration(identity: WorkerIdentity): number {
    return this.#bindingGenerations.get(bindingKey(identity)) ?? 0;
  }

  #bindingGenerationCurrent(identity: WorkerIdentity, generation: number): boolean {
    return !this.#disposed
      && !this.#disposedBindings.has(bindingKey(identity))
      && this.#bindingGeneration(identity) === generation;
  }

  #requireBindingGeneration(identity: WorkerIdentity, generation: number): void {
    if (!this.#bindingGenerationCurrent(identity, generation)) {
      throw new Error('binding_generation_invalidated');
    }
  }

  #trackOutbound<T>(identity: WorkerIdentity, operation: Promise<T>): Promise<T> {
    const key = bindingKey(identity);
    let outbound = this.#outboundByBinding.get(key);
    if (outbound === undefined) {
      outbound = new Set();
      this.#outboundByBinding.set(key, outbound);
    }
    outbound.add(operation);
    const complete = (): void => {
      outbound.delete(operation);
      if (outbound.size === 0 && this.#outboundByBinding.get(key) === outbound) {
        this.#outboundByBinding.delete(key);
      }
    };
    void operation.then(complete, complete);
    return operation;
  }

  #sendWorker(identity: WorkerIdentity, input: RouterWorkerSend): Promise<string | undefined> {
    return this.#trackOutbound(identity, this.#worker.send(identity, input));
  }

  #receiptWorker(identity: WorkerIdentity, input: RouterReceipt): Promise<void> {
    return this.#trackOutbound(identity, this.#worker.receipt(identity, input));
  }

  async #admitOnly(
    identity: WorkerIdentity,
    message: NormalizedRongCloudMessage,
    claim: ClaimedMessage,
    generation: number,
    mutationAccepted = false,
  ): Promise<boolean> {
    if (!this.#bindingGenerationCurrent(identity, generation) && !mutationAccepted) {
      await this.#state.releaseMessage(claim.key, claim.claimId).catch(() => undefined);
      return false;
    }
    const admitted = await this.#state.admitMessage(claim.key, claim.claimId).catch(() => false);
    if (!admitted) return false;
    if (this.#bindingGenerationCurrent(identity, generation)) {
      await this.#sendReceipt(identity, this.#receipt(message, message.messageUid), generation);
    }
    return true;
  }

  async #sendDiscussionPayload(
    identity: WorkerIdentity,
    conversation: ConversationIdentity,
    carrier: 'command' | 'command_result',
    payload: Record<string, unknown>,
    buffer?: {
      bindingKey: string;
      taskId: string;
      kind: BufferedOutput['kind'];
      generation: number;
      active: { suppressed: boolean };
    },
    generation?: number,
  ): Promise<void> {
    const messages = encodeDiscussionWire(payload).map((frame) => {
      const content = JSON.parse(frame) as Record<string, unknown>;
      return this.#structuredResponse(
        conversation,
        content.msg_type === 'discussion_wire_chunk' ? 'command' : carrier,
        content,
      );
    });
    for (let index = 0; index < messages.length; index += 1) {
      const expectedGeneration = buffer?.generation ?? generation;
      if (expectedGeneration !== undefined
        && !this.#bindingGenerationCurrent(identity, expectedGeneration)) return;
      if (buffer !== undefined
        && (buffer.active.suppressed
          || !this.#bindingGenerationCurrent(identity, buffer.generation))) return;
      try {
        await this.#sendWorker(identity, messages[index]!);
        if (expectedGeneration !== undefined
          && !this.#bindingGenerationCurrent(identity, expectedGeneration)) return;
        if (buffer !== undefined
          && (buffer.active.suppressed
            || !this.#bindingGenerationCurrent(identity, buffer.generation))) return;
      } catch (error) {
        const code = workerErrorCode(error);
        if (buffer
          && !buffer.active.suppressed
          && this.#bindingGenerationCurrent(identity, buffer.generation)
          && code !== undefined
          && TRANSIENT_OUTPUT_CODES.has(code)) {
          this.#bufferTaskOutput(
            identity,
            buffer.bindingKey,
            buffer.taskId,
            buffer.kind,
            messages.slice(index),
          );
          return;
        }
        throw error;
      }
    }
  }

  #appendDiscussionOutput(
    active: Pick<DiscussionActive | V1Active,
      'output' | 'outputBytes' | 'outputTruncated'>,
    value: string,
  ): void {
    if (value.length === 0 || active.outputTruncated) return;
    const markerBytes = Buffer.byteLength(OUTPUT_TRUNCATED_TEXT, 'utf8');
    const maximum = 100_000 - markerBytes;
    const accepted = utf8Prefix(value, Math.max(0, maximum - active.outputBytes));
    active.output += accepted;
    active.outputBytes += Buffer.byteLength(accepted, 'utf8');
    if (accepted.length !== value.length) {
      active.output += OUTPUT_TRUNCATED_TEXT;
      active.outputBytes += markerBytes;
      active.outputTruncated = true;
    }
  }

  #appendDiscussionCompleted(
    active: Pick<DiscussionActive | V1Active,
      'output' | 'outputBytes' | 'outputTruncated'>,
    output: string,
  ): void {
    if (output.startsWith(active.output)) {
      this.#appendDiscussionOutput(active, output.slice(active.output.length));
    } else if (!active.output.startsWith(output)) {
      this.#appendDiscussionOutput(active, active.output.length === 0 ? output : `\n${output}`);
    }
  }

  async #applyDiscussionSession(
    active: Pick<DiscussionActive | V1Active,
      'conversation' | 'submittedResumeSessionId'>,
    event: BridgeTaskEvent,
  ): Promise<void> {
    const status = 'status' in event ? event.status : undefined;
    if (event.session_id === undefined && status !== 'resume_invalidated') return;
    await this.#state.applyEventSession({
      conversation: active.conversation,
      submittedResumeSessionId: active.submittedResumeSessionId,
      ...(status === undefined ? {} : { status }),
      ...(event.session_id === undefined ? {} : { authoritativeSessionId: event.session_id }),
    }).catch(() => undefined);
  }

  async #runCardAction(
    identity: WorkerIdentity,
    message: NormalizedRongCloudMessage,
    conversation: ConversationIdentity,
    raw: Record<string, unknown>,
    routed: CardActionRoute,
  ): Promise<void> {
    const generation = this.#bindingGeneration(identity);
    const claim = await this.#claimLocal(identity, message.messageUid, conversation, generation);
    if (!claim) return;
    if (!routed.ok) {
      const response = routed.code === 'unsupported_interactive_approval'
        ? buildUnsupportedApprovalResult(raw, this.#time()) as unknown as Record<string, unknown>
        : this.#cardCommandResult(
          routed.requestId,
          'error',
          routed.code,
          routed.code,
        );
      await this.#finishRead(identity, message, conversation, claim, this.#structuredResponse(
        conversation,
        'command_result',
        response,
      ), generation);
      return;
    }
    if (routed.kind === 'none' || routed.kind === 'navigate') {
      await this.#admitOnly(identity, message, claim, generation);
      return;
    }
    if (routed.kind === 'command') {
      await this.#runSlashClaimed(identity, message, conversation, {
        kind: 'command',
        name: routed.name,
        ...(routed.argument === undefined ? {} : { argument: routed.argument }),
      }, claim, generation);
      return;
    }
    if (routed.kind === 'session') {
      await this.#runSlashClaimed(identity, message, conversation, {
        kind: 'command',
        name: routed.op === 'switch' ? '/switch' : '/delete',
        argument: routed.sessionId,
      }, claim, generation);
      return;
    }
    const scope = routed.kind === 'answer' ? 'card.answer' : 'card.custom';
    const allowed = await this.#control.authorize({
      identity,
      conversationKey: conversationKey(conversation),
      senderId: conversation.senderId,
      scope,
    }).catch(() => false);
    if (!this.#bindingGenerationCurrent(identity, generation)) {
      await this.#state.releaseMessage(claim.key, claim.claimId).catch(() => undefined);
      return;
    }
    if (!allowed) {
      await this.#finishRead(identity, message, conversation, claim, this.#structuredResponse(
        conversation,
        'command_result',
        this.#cardCommandResult(
          routed.requestId,
          'error',
          'unsupported_action',
          'unsupported_action',
        ),
      ), generation);
      return;
    }
    const intent: AuthorizedCardIntent = {
      ...routed,
      identity: { ...identity },
      senderId: conversation.senderId,
      conversationKey: conversationKey(conversation),
    };
    let result: SafeCardResult;
    let sideEffectAccepted = false;
    try {
      const received = await this.#control.card(intent);
      sideEffectAccepted = true;
      if (!this.#bindingGenerationCurrent(identity, generation)) {
        await this.#admitOnly(identity, message, claim, generation, true);
        return;
      }
      result = this.#validCardResult(received, routed.cardId)
        ? received
        : { status: 'error', code: 'unsupported_action', message: 'unsupported_action' };
    } catch {
      if (sideEffectAccepted) {
        await this.#state.admitMessage(claim.key, claim.claimId).catch(() => false);
      } else {
        await this.#state.releaseMessage(claim.key, claim.claimId).catch(() => undefined);
      }
      return;
    }
    let update: RouterWorkerSend | undefined;
    if (result.card !== undefined) {
      try {
        update = this.#structuredResponse(
          conversation,
          'card_update',
          buildCardUpdate(routed.cardId, result.card, this.#time()) as unknown as Record<string, unknown>,
        );
      } catch {
        result = { status: 'error', code: 'unsupported_action', message: 'unsupported_action' };
      }
    }
    const response = this.#structuredResponse(
      conversation,
      'command_result',
      this.#cardCommandResult(
        routed.requestId,
        result.status,
        result.code,
        result.message,
      ),
    );
    const admitted = await this.#state.admitMessage(claim.key, claim.claimId).catch(() => false);
    if (!admitted) return;
    if (!this.#bindingGenerationCurrent(identity, generation)) return;
    await this.#sendWorker(identity, response).catch(() => undefined);
    if (!this.#bindingGenerationCurrent(identity, generation)) return;
    if (update !== undefined && result.status === 'success') {
      await this.#sendWorker(identity, update).catch(() => undefined);
      if (!this.#bindingGenerationCurrent(identity, generation)) return;
    }
    await this.#sendReceipt(identity, this.#receipt(message, message.messageUid), generation);
  }

  #cardCommandResult(
    requestId: string | undefined,
    status: 'success' | 'error',
    code: string,
    message: string,
  ): Record<string, unknown> {
    return {
      msg_type: 'command_result',
      ...(requestId === undefined ? {} : { request_id: requestId }),
      status,
      code,
      message,
      timestamp: this.#time(),
    };
  }

  #validCardResult(result: SafeCardResult, cardId: string): boolean {
    if ((result.status !== 'success' && result.status !== 'error')
      || !/^[a-z0-9_]{1,64}$/.test(result.code)
      || result.message.length < 1
      || result.message.length > 512
      || /[\p{Cc}\p{Cf}]/u.test(result.message)) return false;
    if (result.card === undefined) return true;
    const validated = validateCard(result.card);
    return validated.ok && validated.value.id === cardId;
  }

  async #runSlash(
    identity: WorkerIdentity,
    message: NormalizedRongCloudMessage,
    conversation: ConversationIdentity,
    slash: Extract<ReturnType<typeof parseSlashCommand>, { kind: 'command' }>,
  ): Promise<void> {
    const generation = this.#bindingGeneration(identity);
    const claim = await this.#claimLocal(identity, message.messageUid, conversation, generation);
    if (!claim) return;
    await this.#runSlashClaimed(identity, message, conversation, slash, claim, generation);
  }

  async #runSlashClaimed(
    identity: WorkerIdentity,
    message: NormalizedRongCloudMessage,
    conversation: ConversationIdentity,
    slash: Extract<ReturnType<typeof parseSlashCommand>, { kind: 'command' }>,
    claim: ClaimedMessage,
    generation: number,
  ): Promise<void> {
    let mutationAccepted = false;
    try {
      if (slash.name === '/stop') {
        const active = this.#active.get(conversationKey(conversation));
        if (!active || active.bindingKey !== bindingKey(identity)) {
          await this.#finishRead(identity, message, conversation, claim, this.#textResponse(
            conversation,
            '[no_active_task]',
          ), generation);
          return;
        }
        await this.#task.cancelTask(active.taskId);
        mutationAccepted = true;
        await this.#finishMutation(identity, message, conversation, claim, this.#textResponse(
          conversation,
          '[stop_requested]',
        ), generation);
        await active.done;
        return;
      }
      if (slash.name === '/session') {
        const current = await this.#state.currentSession(conversation);
        await this.#finishRead(identity, message, conversation, claim, {
          conversationType: conversation.conversationType,
          targetId: replyTargetId(conversation),
          messageType: 'text',
          content: `[session] ${current ?? 'none'}`,
        }, generation);
        return;
      }
      if (slash.name === '/sessions') {
        const sessions = await this.#state.knownSessions(conversation);
        await this.#finishRead(identity, message, conversation, claim, {
          conversationType: conversation.conversationType,
          targetId: replyTargetId(conversation),
          messageType: 'text',
          content: sessions.length === 0 ? '[sessions] none' : `[sessions]\n${sessions.join('\n')}`,
        }, generation);
        return;
      }
      if (slash.name === '/status') {
        const allowed = await this.#control.authorize({
          identity,
          conversationKey: conversationKey(conversation),
          senderId: conversation.senderId,
          scope: 'device.read',
        });
        if (!this.#bindingGenerationCurrent(identity, generation)) {
          await this.#state.releaseMessage(claim.key, claim.claimId).catch(() => undefined);
          return;
        }
        const status = allowed ? await this.#control.status(identity) : undefined;
        const content = allowed && status !== undefined
          ? this.#statusText(status)
          : '[authorization_denied]';
        await this.#finishRead(identity, message, conversation, claim, {
          conversationType: conversation.conversationType,
          targetId: replyTargetId(conversation),
          messageType: 'text',
          content,
        }, generation);
        return;
      }
      if (slash.name === '/switch') {
        const switched = await this.#state.switchKnown(conversation, slash.argument!);
        if (!switched) {
          await this.#finishRead(identity, message, conversation, claim, this.#textResponse(
            conversation,
            '[session_not_found]',
          ), generation);
          return;
        }
        mutationAccepted = true;
        await this.#finishMutation(identity, message, conversation, claim, this.#textResponse(
          conversation,
          '[session_switched]',
        ), generation);
        return;
      }
      if (slash.name === '/delete') {
        const deleted = await this.#state.deleteKnown(conversation, slash.argument!);
        if (!deleted) {
          await this.#finishRead(identity, message, conversation, claim, this.#textResponse(
            conversation,
            '[session_not_found]',
          ), generation);
          return;
        }
        mutationAccepted = true;
        await this.#finishMutation(identity, message, conversation, claim, this.#textResponse(
          conversation,
          '[session_deleted]',
        ), generation);
        return;
      }
      await this.#state.clearCurrent(conversation);
      mutationAccepted = true;
      await this.#finishMutation(identity, message, conversation, claim, this.#textResponse(
        conversation,
        '[new_session]',
      ), generation);
    } catch {
      if (mutationAccepted) {
        await this.#state.admitMessage(claim.key, claim.claimId).catch(() => false);
      } else {
        await this.#state.releaseMessage(claim.key, claim.claimId).catch(() => undefined);
      }
      if (this.#bindingGenerationCurrent(identity, generation)) {
        await this.#safeSendText(identity, conversation, '[router_state_invalid]');
      }
    }
  }

  async #runStop(
    identity: WorkerIdentity,
    message: NormalizedRongCloudMessage,
    conversation: ConversationIdentity,
  ): Promise<void> {
    const generation = this.#bindingGeneration(identity);
    const claim = await this.#claimLocal(identity, message.messageUid, conversation, generation);
    if (!claim) return;
    const active = this.#active.get(conversationKey(conversation));
    if (!active || active.bindingKey !== bindingKey(identity)) {
      await this.#finishRead(identity, message, conversation, claim, this.#textResponse(
        conversation,
        '[no_active_task]',
      ), generation);
      return;
    }
    try {
      await this.#task.cancelTask(active.taskId);
    } catch {
      await this.#state.releaseMessage(claim.key, claim.claimId).catch(() => undefined);
      if (this.#bindingGenerationCurrent(identity, generation)) {
        await this.#safeSendText(identity, conversation, '[runtime_transport_error]');
      }
      return;
    }
    await this.#finishMutation(identity, message, conversation, claim, this.#textResponse(
      conversation,
      '[stop_requested]',
    ), generation);
    await active.done;
  }

  async #runLocalProtocol(
    identity: WorkerIdentity,
    message: NormalizedRongCloudMessage,
    conversation: ConversationIdentity,
    msgType: 'create_opencode_session' | 'delete_opencode_session' | 'device_status_request' | 'device_control',
    value: Record<string, unknown>,
  ): Promise<void> {
    const generation = this.#bindingGeneration(identity);
    const claim = await this.#claimLocal(identity, message.messageUid, conversation, generation);
    if (!claim) return;
    const requestId = typeof value.request_id === 'string' ? value.request_id : undefined;
    let mutationAccepted = false;
    try {
      if (msgType === 'create_opencode_session') {
        const current = await this.#state.currentSession(conversation);
        const envelope = buildLegacyEnvelope({
          msgType: 'opencode_session_created',
          ...(requestId === undefined ? {} : { requestId }),
          sourceImId: identity.nodeId,
          destinationImId: message.senderId,
          content: current === undefined
            ? { status: 'error', code: 'session_pending_first_prompt' }
            : { status: 'success', session_id: current },
          timestamp: this.#time(),
        });
        await this.#finishRead(identity, message, conversation, claim, this.#structuredResponse(
          conversation,
          'command_result',
          envelope,
        ), generation);
        return;
      }
      if (msgType === 'delete_opencode_session') {
        const sessionId = typeof value.session_id === 'string'
          ? value.session_id
          : typeof value.opencode_session_id === 'string' ? value.opencode_session_id : '';
        const deleted = sessionId.length > 0 && await this.#state.deleteKnown(conversation, sessionId);
        mutationAccepted = deleted;
        const response = this.#commandResult(requestId, deleted ? 'success' : 'error', deleted ? 'ok' : 'session_not_found');
        if (deleted) await this.#finishMutation(identity, message, conversation, claim, this.#structuredResponse(
          conversation,
          'command_result',
          response,
        ), generation);
        else await this.#finishRead(identity, message, conversation, claim, this.#structuredResponse(
          conversation,
          'command_result',
          response,
        ), generation);
        return;
      }
      if (msgType === 'device_status_request') {
        const allowed = await this.#control.authorize({
          identity,
          conversationKey: conversationKey(conversation),
          senderId: conversation.senderId,
          scope: 'device.read',
        });
        if (!this.#bindingGenerationCurrent(identity, generation)) {
          await this.#state.releaseMessage(claim.key, claim.claimId).catch(() => undefined);
          return;
        }
        const status = allowed ? await this.#control.status(identity) : undefined;
        const content = status !== undefined && this.#validDeviceStatus(status)
          ? { status: 'success', code: 'ok', message: 'ok', data: status }
          : { status: 'error', code: 'authorization_denied', message: 'authorization_denied' };
        const envelope = buildLegacyEnvelope({
          msgType: 'device_status_report',
          requestId: requestId ?? 'missing_request',
          sourceImId: identity.nodeId,
          destinationImId: message.senderId,
          content,
          timestamp: this.#time(),
        });
        await this.#finishRead(identity, message, conversation, claim, this.#structuredResponse(
          conversation,
          'command_result',
          envelope,
        ), generation);
        return;
      }
      const command = value.command as DeviceCommand;
      const scope = command === 'status' ? 'device.read' : 'device.mutate';
      const allowed = await this.#control.authorize({
        identity,
        conversationKey: conversationKey(conversation),
        senderId: conversation.senderId,
        scope,
      });
      if (!this.#bindingGenerationCurrent(identity, generation)) {
        await this.#state.releaseMessage(claim.key, claim.claimId).catch(() => undefined);
        return;
      }
      let result: SafeDeviceResult;
      let accepted = false;
      if (!allowed) {
        result = { status: 'error', code: 'authorization_denied', message: 'authorization_denied' };
      } else {
        const name = command === 'rename_device' ? (value.name as string).trim() : undefined;
        const received = await this.#control.device({
          identity,
          senderId: conversation.senderId,
          command,
          ...(name === undefined ? {} : { name }),
        });
        accepted = true;
        mutationAccepted = command !== 'status';
        if (!this.#bindingGenerationCurrent(identity, generation)) {
          await this.#admitOnly(identity, message, claim, generation, mutationAccepted);
          return;
        }
        result = this.#validDeviceResult(received)
          ? received
          : { status: 'error', code: 'unsupported_action', message: 'unsupported_action' };
      }
      const envelope = buildLegacyEnvelope({
        msgType: 'device_control_result',
        requestId: requestId ?? 'missing_request',
        sourceImId: identity.nodeId,
        destinationImId: message.senderId,
        content: result,
        timestamp: this.#time(),
      });
      const response = this.#structuredResponse(conversation, 'command_result', envelope);
      if (accepted && command !== 'status') {
        await this.#finishMutation(identity, message, conversation, claim, response, generation);
      } else {
        await this.#finishRead(identity, message, conversation, claim, response, generation);
      }
    } catch {
      if (mutationAccepted) {
        await this.#state.admitMessage(claim.key, claim.claimId).catch(() => false);
      } else {
        await this.#state.releaseMessage(claim.key, claim.claimId).catch(() => undefined);
      }
      if (this.#bindingGenerationCurrent(identity, generation)) {
        await this.#safeSendText(identity, conversation, '[runtime_failed]');
      }
    }
  }

  async #runChatroomInvite(
    identity: WorkerIdentity,
    message: NormalizedRongCloudMessage,
    conversation: ConversationIdentity,
    roomId: string,
  ): Promise<void> {
    const generation = this.#bindingGeneration(identity);
    const claim = await this.#claimLocal(identity, message.messageUid, conversation, generation);
    if (!claim) return;
    try {
      await this.#worker.joinChatroom(identity, { roomId, historyCount: 0 });
    } catch {
      await this.#state.releaseMessage(claim.key, claim.claimId).catch(() => undefined);
      return;
    }
    await this.#admitOnly(identity, message, claim, generation, true);
  }

  async #claimLocal(
    identity: WorkerIdentity,
    messageUid: string,
    conversation: ConversationIdentity,
    generation: number,
  ): Promise<ClaimedMessage | undefined> {
    const claimId = this.#claimId();
    if (!claimId) return undefined;
    let claim;
    try {
      claim = await this.#state.claimMessage(identity.runtimeId, messageUid, claimId);
    } catch {
      if (this.#bindingGenerationCurrent(identity, generation)) {
        await this.#safeSendText(identity, conversation, '[dedup_capacity]');
      }
      return undefined;
    }
    if (claim.status === 'duplicate') return undefined;
    if (!this.#bindingGenerationCurrent(identity, generation)) {
      await this.#state.releaseMessage(claim.key, claimId).catch(() => undefined);
      return undefined;
    }
    try {
      const bound = await this.#binding.binding(identity);
      this.#requireBindingGeneration(identity, generation);
      if (!bound
        || bound.runtimeId !== identity.runtimeId
        || bound.nodeId !== identity.nodeId
        || this.#disposedBindings.has(bindingKey(identity))) {
        throw new Error('unavailable');
      }
    } catch {
      await this.#state.releaseMessage(claim.key, claimId).catch(() => undefined);
      if (this.#bindingGenerationCurrent(identity, generation)) {
        await this.#safeSendText(identity, conversation, '[binding_unavailable]');
      }
      return undefined;
    }
    return { key: claim.key, claimId };
  }

  async #finishRead(
    identity: WorkerIdentity,
    message: NormalizedRongCloudMessage,
    _conversation: ConversationIdentity,
    claim: ClaimedMessage,
    response: RouterWorkerSend,
    generation: number,
  ): Promise<void> {
    if (!this.#bindingGenerationCurrent(identity, generation)) {
      await this.#state.releaseMessage(claim.key, claim.claimId).catch(() => undefined);
      return;
    }
    try {
      await this.#sendWorker(identity, response);
    } catch {
      await this.#state.releaseMessage(claim.key, claim.claimId).catch(() => undefined);
      return;
    }
    const admitted = await this.#state.admitMessage(claim.key, claim.claimId).catch(() => false);
    if (!admitted) return;
    if (this.#bindingGenerationCurrent(identity, generation)) {
      await this.#sendReceipt(identity, this.#receipt(message, message.messageUid), generation);
    }
  }

  async #finishMutation(
    identity: WorkerIdentity,
    message: NormalizedRongCloudMessage,
    _conversation: ConversationIdentity,
    claim: ClaimedMessage,
    response: RouterWorkerSend,
    generation: number,
  ): Promise<void> {
    const admitted = await this.#state.admitMessage(claim.key, claim.claimId).catch(() => false);
    if (!admitted) return;
    if (!this.#bindingGenerationCurrent(identity, generation)) return;
    await this.#sendWorker(identity, response).catch(() => undefined);
    if (!this.#bindingGenerationCurrent(identity, generation)) return;
    await this.#sendReceipt(identity, this.#receipt(message, message.messageUid), generation);
  }

  async #sendReceipt(
    identity: WorkerIdentity,
    receipt: RouterReceipt,
    generation: number,
  ): Promise<void> {
    if (!this.#bindingGenerationCurrent(identity, generation)) return;
    await this.#receiptWorker(identity, receipt).catch(() => undefined);
  }

  #textResponse(conversation: ConversationIdentity, content: string): RouterWorkerSend {
    return {
      conversationType: conversation.conversationType,
      targetId: replyTargetId(conversation),
      messageType: 'text',
      content,
    };
  }

  #structuredResponse(
    conversation: ConversationIdentity,
    messageType: Exclude<RouterWorkerSend['messageType'], 'text'>,
    content: Record<string, unknown>,
  ): RouterWorkerSend {
    return {
      conversationType: conversation.conversationType,
      targetId: replyTargetId(conversation),
      messageType,
      content,
    };
  }

  #commandResult(
    requestId: string | undefined,
    status: 'success' | 'error',
    code: string,
  ): Record<string, unknown> {
    return {
      msg_type: 'command_result',
      ...(requestId === undefined ? {} : { request_id: requestId }),
      status,
      code,
      message: code,
      timestamp: this.#time(),
    };
  }

  #validDeviceStatus(value: SafeDeviceStatus): boolean {
    return typeof value.enabled === 'boolean'
      && ['starting', 'online', 'offline', 'backoff', 'stopped'].includes(value.worker)
      && ['ready', 'needs_auth', 'found_not_runnable', 'not_found', 'probe_failed'].includes(value.runtime);
  }

  #validDeviceResult(value: SafeDeviceResult): boolean {
    return (value.status === 'success' || value.status === 'error')
      && /^[a-z0-9_]{1,64}$/.test(value.code)
      && value.message.length >= 1
      && value.message.length <= 512
      && !/[\p{Cc}\p{Cf}]/u.test(value.message)
      && (value.data === undefined || this.#validDeviceStatus(value.data));
  }

  #statusText(value: SafeDeviceStatus): string {
    return this.#validDeviceStatus(value)
      ? `[status] enabled=${value.enabled} worker=${value.worker} runtime=${value.runtime}`
      : '[runtime_failed]';
  }

  #time(): number {
    const now = this.#clock();
    return Number.isSafeInteger(now) && now >= 0 ? now : 0;
  }

  #enqueue(
    identity: WorkerIdentity,
    conversation: ConversationIdentity,
    operation: () => Promise<void>,
  ): Promise<void> {
    const bindKey = bindingKey(identity);
    const key = conversationKey(conversation);
    if (this.#disposedBindings.has(bindKey)) return Promise.resolve();
    let lane = this.#lanes.get(key);
    if (!lane) {
      lane = {
        identity: { ...identity },
        bindingKey: bindKey,
        conversationKey: key,
        running: false,
        queue: [],
      };
      this.#lanes.set(key, lane);
    }
    if (lane.running || lane.queue.length > 0) {
      const bindingWaiting = this.#waitingByBinding.get(bindKey) ?? 0;
      if (lane.queue.length >= MAX_WAITING_PER_CONVERSATION
        || bindingWaiting >= MAX_WAITING_PER_BINDING
        || this.#waiting >= MAX_WAITING_PROCESS) {
        return this.#safeSendText(identity, conversation, '[conversation_busy]');
      }
    }
    this.#logger.debug({
      event: 'lane_reserved',
      runtimeId: identity.runtimeId,
      nodeId: identity.nodeId,
      conversationType: conversation.conversationType,
      conversationKeyHash: hashConversation(key),
      queueDepth: lane.queue.length,
    });
    return new Promise<void>((resolve) => {
      const item: LaneItem = { state: lane!.running ? 'waiting' : 'executing', run: operation, resolve };
      if (item.state === 'waiting') this.#incrementWaiting(bindKey);
      lane!.queue.push(item);
      if (!lane!.running) {
        lane!.running = true;
        void this.#runLane(lane!);
      }
    });
  }

  async #runLane(lane: Lane): Promise<void> {
    while (lane.queue.length > 0) {
      const item = lane.queue.shift()!;
      if (item.state === 'released') continue;
      if (item.state === 'waiting') {
        item.state = 'executing';
        this.#decrementWaiting(lane.bindingKey);
      }
      try {
        await item.run();
      } finally {
        item.state = 'released';
        item.resolve();
      }
    }
    lane.running = false;
    if (this.#lanes.get(lane.conversationKey) === lane) this.#lanes.delete(lane.conversationKey);
  }

  #incrementWaiting(bindKey: string): void {
    this.#waiting += 1;
    this.#waitingByBinding.set(bindKey, (this.#waitingByBinding.get(bindKey) ?? 0) + 1);
  }

  #decrementWaiting(bindKey: string): void {
    this.#waiting = Math.max(0, this.#waiting - 1);
    const next = Math.max(0, (this.#waitingByBinding.get(bindKey) ?? 0) - 1);
    if (next === 0) this.#waitingByBinding.delete(bindKey);
    else this.#waitingByBinding.set(bindKey, next);
  }

  async #runPlain(
    identity: WorkerIdentity,
    message: NormalizedRongCloudMessage,
    candidate: TaskCandidate,
  ): Promise<void> {
    const generation = this.#bindingGeneration(identity);
    const claimId = this.#claimId();
    if (!claimId) {
      await this.#safeSendText(identity, candidate.conversation, '[invalid_message]');
      return;
    }
    let claim;
    try {
      claim = await this.#state.claimMessage(
        identity.runtimeId,
        candidate.effectiveMessageUid,
        claimId,
      );
      this.#requireBindingGeneration(identity, generation);
    } catch (error) {
      if (!this.#bindingGenerationCurrent(identity, generation)) {
        if (claim?.status === 'claimed') {
          await this.#state.releaseMessage(claim.key, claimId).catch(() => undefined);
        }
        return;
      }
      await this.#safeSendText(
        identity,
        candidate.conversation,
        workerErrorCode(error) === 'dedup_capacity' ? '[dedup_capacity]' : '[router_state_invalid]',
      );
      return;
    }
    if (claim.status === 'duplicate') return;

    let started = false;
    let taskId: string | undefined;
    try {
      const bound = await this.#binding.binding(identity);
      this.#requireBindingGeneration(identity, generation);
      if (!bound
        || bound.runtimeId !== identity.runtimeId
        || bound.nodeId !== identity.nodeId
        || this.#disposedBindings.has(bindingKey(identity))) {
        throw new Error('binding_unavailable');
      }
      if (candidate.joinRoom !== undefined) {
        await this.#worker.joinChatroom(identity, { roomId: candidate.joinRoom, historyCount: 0 });
        this.#requireBindingGeneration(identity, generation);
      }
      const submittedResumeSessionId = await this.#state.currentSession(candidate.conversation);
      this.#requireBindingGeneration(identity, generation);
      const workdir = await this.#binding.authorizeDefaultWorkdir(identity);
      this.#requireBindingGeneration(identity, generation);
      await this.#recheckBinding(identity);
      this.#requireBindingGeneration(identity, generation);
      const response = await this.#task.startTask({
        runtimeId: identity.runtimeId,
        conversationKey: conversationKey(candidate.conversation),
        prompt: candidate.prompt,
        workdir,
        ...(submittedResumeSessionId === undefined ? {} : { resumeSessionId: submittedResumeSessionId }),
      });
      started = true;
      taskId = response.taskId;
      if (!this.#bindingGenerationCurrent(identity, generation)) {
        await this.#task.cancelTask(taskId).catch(() => undefined);
        return;
      }
      let resolveDone!: () => void;
      const done = new Promise<void>((resolve) => { resolveDone = resolve; });
      const active: ActiveTask = {
        identity: { ...identity },
        conversation: { ...candidate.conversation },
        bindingKey: bindingKey(identity),
        conversationKey: conversationKey(candidate.conversation),
        taskId,
        generation,
        ...(submittedResumeSessionId === undefined ? {} : { submittedResumeSessionId }),
        lastEventId: 0,
        suppressed: false,
        terminal: false,
        timedOut: false,
        rawOutput: '',
        rawOutputBytes: 0,
        deliveredTextCharacters: 0,
        sawTextDelta: false,
        outputTruncated: false,
        outputTail: Promise.resolve(),
        done,
        resolveDone,
      };
      this.#active.set(active.conversationKey, active);
      try {
        const admitted = await this.#state.admitMessage(claim.key, claimId);
        if (!admitted) throw new Error('admit_failed');
        if (!this.#bindingGenerationCurrent(identity, generation)) {
          active.suppressed = true;
          this.#active.delete(active.conversationKey);
          active.resolveDone();
          return;
        }
      } catch {
        active.suppressed = true;
        this.#active.delete(active.conversationKey);
        await this.#task.cancelTask(taskId).catch(() => undefined);
        return;
      }

      await this.#receiptWorker(identity, this.#receipt(message, candidate.effectiveMessageUid))
        .catch(() => this.#logFailure(active, 'receipt_failed'));
      if (!this.#bindingGenerationCurrent(identity, generation)) {
        active.suppressed = true;
        this.#active.delete(active.conversationKey);
        active.resolveDone();
        return;
      }
      await this.#sendWorker(identity, {
        conversationType: candidate.conversation.conversationType,
        targetId: replyTargetId(candidate.conversation),
        messageType: 'text',
        content: '[processing]',
      }).catch(() => this.#logFailure(active, 'output_dropped'));
      if (!this.#bindingGenerationCurrent(identity, generation)) {
        active.suppressed = true;
        this.#active.delete(active.conversationKey);
        active.resolveDone();
        return;
      }
      await this.#consume(active);
    } catch {
      if (!started) {
        await this.#state.releaseMessage(claim.key, claimId).catch(() => undefined);
        if (this.#bindingGenerationCurrent(identity, generation)) {
          await this.#safeSendText(identity, candidate.conversation, '[task_start_failed]');
        }
      } else if (taskId !== undefined) {
        if (this.#bindingGenerationCurrent(identity, generation)) {
          await this.#safeSendText(identity, candidate.conversation, '[runtime_transport_error]');
        }
      }
    }
  }

  async #consume(active: ActiveTask): Promise<void> {
    try {
      const iterator = this.#task.events(active.taskId)[Symbol.asyncIterator]();
      active.iterator = iterator;
      active.watchdogTimer = this.#setTimeout(() => {
        active.watchdogTimer = undefined;
        active.watchdogPromise = this.#expireTask(active);
        void active.watchdogPromise.catch(() => this.#logFailure(active, 'watchdog_failed'));
      }, TASK_WATCHDOG_MS);
      while (true) {
        const next = await iterator.next();
        if (next.done || active.timedOut) break;
        const event = next.value;
        if (active.suppressed
          || event.task_id !== active.taskId
          || event.id <= active.lastEventId) continue;
        active.lastEventId = event.id;
        const eventStatus = 'status' in event ? event.status : undefined;
        if (event.session_id !== undefined || eventStatus === 'resume_invalidated') {
          await this.#state.applyEventSession({
            conversation: active.conversation,
            submittedResumeSessionId: active.submittedResumeSessionId,
            ...(eventStatus === undefined ? {} : { status: eventStatus }),
            ...(event.session_id === undefined ? {} : { authoritativeSessionId: event.session_id }),
          }).catch(() => this.#logFailure(active, 'router_state_invalid'));
          if (active.suppressed
            || !this.#bindingGenerationCurrent(active.identity, active.generation)) break;
        }
        if (event.type === 'text_delta') {
          if (event.text) {
            active.sawTextDelta = true;
            this.#appendOutput(active, event.text);
            await this.#scheduleDeltaFlush(active);
          }
          continue;
        }
        if (event.type === 'completed') {
          if (event.output) this.#appendCompletedOutput(active, event.output);
          active.terminal = true;
          await this.#flushTerminal(active);
          break;
        }
        if (event.type === 'failed') {
          const code = event.error.category === 'authentication'
            ? 'runtime_needs_auth'
            : event.error.category === 'transport'
              ? 'runtime_transport_error'
              : 'runtime_failed';
          this.#appendOutput(active, `[${code}]`);
          active.terminal = true;
          await this.#flushTerminal(active);
          break;
        }
        if (event.type === 'cancelled') {
          this.#appendOutput(active, '[cancelled]');
          active.terminal = true;
          await this.#flushTerminal(active);
          break;
        }
      }
    } catch {
      if (!active.suppressed && !active.timedOut) {
        this.#appendOutput(active, '[runtime_transport_error]');
        active.terminal = true;
        await this.#flushTerminal(active);
      }
    } finally {
      if (active.watchdogTimer !== undefined) {
        this.#clearTimeout(active.watchdogTimer);
        active.watchdogTimer = undefined;
      }
      if (active.watchdogPromise !== undefined) await active.watchdogPromise.catch(() => undefined);
      if (!active.terminal && !active.suppressed && !active.timedOut) {
        this.#appendOutput(active, '[runtime_transport_error]');
        active.terminal = true;
        await this.#flushTerminal(active);
      }
      if (active.flushTimer !== undefined) {
        this.#clearTimeout(active.flushTimer);
        active.flushTimer = undefined;
      }
      await active.outputTail;
      if (this.#active.get(active.conversationKey) === active) {
        this.#active.delete(active.conversationKey);
      }
      active.resolveDone();
    }
  }

  #appendOutput(active: ActiveTask, value: string): void {
    if (value.length === 0 || active.outputTruncated) return;
    const available = Math.max(0, MAX_OUTPUT_CONTENT_BYTES - active.rawOutputBytes);
    const accepted = utf8Prefix(value, available);
    active.rawOutput += accepted;
    active.rawOutputBytes += Buffer.byteLength(accepted, 'utf8');
    if (accepted.length !== value.length) {
      active.rawOutput += OUTPUT_TRUNCATED_TEXT;
      active.rawOutputBytes += Buffer.byteLength(OUTPUT_TRUNCATED_TEXT, 'utf8');
      active.outputTruncated = true;
    }
  }

  #appendCompletedOutput(active: ActiveTask, output: string): void {
    if (!active.sawTextDelta) {
      this.#appendOutput(active, output);
      return;
    }
    if (output.startsWith(active.rawOutput)) {
      this.#appendOutput(active, output.slice(active.rawOutput.length));
      return;
    }
    if (!active.rawOutput.startsWith(output)) this.#appendOutput(active, `\n${output}`);
  }

  async #scheduleDeltaFlush(active: ActiveTask): Promise<void> {
    const safe = streamSafeContent(active.rawOutput);
    const pending = safe.slice(active.deliveredTextCharacters);
    if (Buffer.byteLength(pending, 'utf8') >= OUTPUT_EARLY_FLUSH_BYTES) {
      if (active.flushTimer !== undefined) {
        this.#clearTimeout(active.flushTimer);
        active.flushTimer = undefined;
      }
      await this.#flushCoarse(active);
      return;
    }
    if (active.flushTimer !== undefined) return;
    active.flushTimer = this.#setTimeout(() => {
      active.flushTimer = undefined;
      void this.#flushCoarse(active).catch(() => this.#logFailure(active, 'output_dropped'));
    }, OUTPUT_FLUSH_MS);
  }

  #queueOutput(active: ActiveTask, operation: () => Promise<void>): Promise<void> {
    const guarded = async (): Promise<void> => {
      const drain = this.#bufferDrainTasks.get(active.bindingKey) === active.taskId
        ? this.#bufferDrains.get(active.bindingKey)
        : undefined;
      if (drain !== undefined) await drain;
      if (!active.suppressed
        && this.#bindingGenerationCurrent(active.identity, active.generation)) await operation();
    };
    const queued = active.outputTail.then(guarded, guarded);
    active.outputTail = queued.catch(() => this.#logFailure(active, 'output_dropped'));
    return active.outputTail;
  }

  #flushCoarse(active: ActiveTask): Promise<void> {
    return this.#queueOutput(active, async () => {
      if (active.suppressed
        || active.terminal
        || active.timedOut
        || !this.#bindingGenerationCurrent(active.identity, active.generation)) return;
      const safe = streamSafeContent(active.rawOutput);
      const pending = safe.slice(active.deliveredTextCharacters);
      const chunks = textChunks(pending, OUTPUT_CHUNK_BYTES);
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index]!;
        const message = this.#textResponse(active.conversation, chunk);
        try {
          await this.#sendWorker(active.identity, message);
          active.deliveredTextCharacters += chunk.length;
          if (!this.#bindingGenerationCurrent(active.identity, active.generation)) return;
        } catch (error) {
          const code = workerErrorCode(error);
          if (code !== undefined && TRANSIENT_OUTPUT_CODES.has(code)) {
            this.#bufferOutput(active, 'coarse', chunks.slice(index).map((content) =>
              this.#textResponse(active.conversation, content)));
          } else {
            active.deliveredTextCharacters = safe.length;
            this.#removeBufferedTask(active.bindingKey, active.taskId);
          }
          this.#logFailure(active, code ?? 'output_dropped');
          return;
        }
      }
      this.#removeBufferedTask(active.bindingKey, active.taskId, 'coarse');
    });
  }

  #flushTerminal(active: ActiveTask): Promise<void> {
    if (active.flushTimer !== undefined) {
      this.#clearTimeout(active.flushTimer);
      active.flushTimer = undefined;
    }
    return this.#queueOutput(active, async () => {
      if ((active.suppressed && !active.timedOut)
        || !this.#bindingGenerationCurrent(active.identity, active.generation)) return;
      const parsed = parseCardMarkers(active.rawOutput);
      const cardMessages: RouterWorkerSend[] = [];
      let invalidCards = 0;
      for (const rawCard of parsed.cards) {
        const validated = validateCard(rawCard);
        if (!validated.ok) {
          invalidCards += 1;
          continue;
        }
        try {
          cardMessages.push(this.#structuredResponse(
            active.conversation,
            'card_message',
            buildCardMessage(validated.value, this.#time()) as unknown as Record<string, unknown>,
          ));
        } catch {
          invalidCards += 1;
        }
      }
      const finalText = parsed.text + INVALID_CARD_MARKER_TEXT.repeat(invalidCards);
      const text = finalText.slice(Math.min(active.deliveredTextCharacters, finalText.length));
      const textMessages = textChunks(text, OUTPUT_CHUNK_BYTES).map((content) =>
        this.#textResponse(active.conversation, content));
      const messages = [...textMessages, ...cardMessages];
      for (let index = 0; index < messages.length; index += 1) {
        try {
          await this.#sendWorker(active.identity, messages[index]!);
          if (!this.#bindingGenerationCurrent(active.identity, active.generation)) return;
        } catch (error) {
          const code = workerErrorCode(error);
          if (code !== undefined && TRANSIENT_OUTPUT_CODES.has(code)) {
            this.#bufferOutput(active, 'terminal', messages.slice(index));
          } else {
            this.#removeBufferedTask(active.bindingKey, active.taskId);
          }
          this.#logFailure(active, code ?? 'output_dropped');
          return;
        }
      }
      this.#removeBufferedTask(active.bindingKey, active.taskId);
      active.deliveredTextCharacters = finalText.length;
    });
  }

  async #expireTask(active: ActiveTask): Promise<void> {
    if (active.terminal || active.suppressed || active.timedOut) return;
    active.timedOut = true;
    active.terminal = true;
    await this.#task.cancelTask(active.taskId).catch(() => this.#logFailure(active, 'cancel_failed'));
    if (active.iterator?.return !== undefined) {
      await active.iterator.return().catch(() => this.#logFailure(active, 'reader_close_failed'));
    }
    this.#appendOutput(active, '[task_timeout]');
    await this.#flushTerminal(active);
  }

  #bufferOutput(
    active: ActiveTask,
    kind: BufferedOutput['kind'],
    messages: RouterWorkerSend[],
  ): void {
    this.#bufferTaskOutput(active.identity, active.bindingKey, active.taskId, kind, messages);
  }

  #bufferTaskOutput(
    identity: WorkerIdentity,
    bindKey: string,
    taskId: string,
    kind: BufferedOutput['kind'],
    messages: RouterWorkerSend[],
  ): void {
    if (messages.length === 0 || this.#disposedBindings.has(bindKey)) return;
    const existing = this.#bufferedOutput.get(bindKey) ?? [];
    const retained = existing.filter((entry) =>
      entry.taskId !== taskId || (kind === 'coarse' && entry.kind === 'terminal'));
    const entry: BufferedOutput = {
      identity: { ...identity },
      taskId,
      kind,
      messages,
      bytes: serializedBytes(messages),
      order: this.#bufferOrder++,
    };
    retained.push(entry);
    let dropped = 0;
    const totalBytes = (): number => retained.reduce((total, item) => total + item.bytes, 0);
    while (retained.length > MAX_BUFFERED_OUTPUT_ENTRIES
      || totalBytes() > MAX_BUFFERED_OUTPUT_BYTES) {
      let removeAt = retained
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => item.kind === 'coarse')
        .sort((left, right) => left.item.order - right.item.order)[0]?.index;
      if (removeAt === undefined) {
        removeAt = retained
          .map((item, index) => ({ item, index }))
          .sort((left, right) => left.item.order - right.item.order)[0]?.index;
      }
      if (removeAt === undefined) break;
      retained.splice(removeAt, 1);
      dropped += 1;
    }
    if (retained.length === 0) this.#bufferedOutput.delete(bindKey);
    else this.#bufferedOutput.set(bindKey, retained);
    if (dropped > 0) {
      this.#logger.warn({
        event: 'output_buffer_dropped',
        runtimeId: identity.runtimeId,
        nodeId: identity.nodeId,
        count: dropped,
      });
    }
  }

  #removeBufferedTask(
    bindKey: string,
    taskId: string,
    kind?: BufferedOutput['kind'],
  ): void {
    const entries = this.#bufferedOutput.get(bindKey);
    if (!entries) return;
    const retained = entries.filter((entry) =>
      entry.taskId !== taskId || (kind !== undefined && entry.kind !== kind));
    if (retained.length === 0) this.#bufferedOutput.delete(bindKey);
    else this.#bufferedOutput.set(bindKey, retained);
  }

  async #drainBufferedOutput(identity: WorkerIdentity): Promise<void> {
    const bindKey = bindingKey(identity);
    if (this.#disposedBindings.has(bindKey)) return;
    const existing = this.#bufferDrains.get(bindKey);
    if (existing) return existing;
    let shared!: Promise<void>;
    shared = this.#performBufferedDrain(bindKey).finally(() => {
      if (this.#bufferDrains.get(bindKey) === shared) {
        this.#bufferDrainTasks.delete(bindKey);
        this.#bufferDrains.delete(bindKey);
      }
    });
    this.#bufferDrains.set(bindKey, shared);
    return shared;
  }

  async #performBufferedDrain(bindKey: string): Promise<void> {
    while (!this.#disposedBindings.has(bindKey)) {
      const entries = this.#bufferedOutput.get(bindKey);
      if (!entries || entries.length === 0) return;
      const entry = entries.reduce((oldest, candidate) =>
        candidate.order < oldest.order ? candidate : oldest);
      const message = entry.messages[0];
      if (!message) {
        this.#deleteBufferedEntry(bindKey, entry);
        continue;
      }
      this.#bufferDrainTasks.set(bindKey, entry.taskId);
      try {
        await this.#sendWorker(entry.identity, message);
      } catch (error) {
        const code = workerErrorCode(error);
        if (this.#bufferDrainTasks.get(bindKey) === entry.taskId) {
          this.#bufferDrainTasks.delete(bindKey);
        }
        if (code === 'queue_full' || (code !== undefined && TRANSIENT_OUTPUT_CODES.has(code))) {
          return;
        }
        this.#deleteBufferedEntry(bindKey, entry);
        continue;
      }
      this.#advanceDrainedText(bindKey, entry.taskId, message);
      if (this.#bufferDrainTasks.get(bindKey) === entry.taskId) {
        this.#bufferDrainTasks.delete(bindKey);
      }
      const current = this.#bufferedOutput.get(bindKey);
      if (!current || !current.includes(entry) || entry.messages[0] !== message) continue;
      entry.messages.shift();
      entry.bytes = serializedBytes(entry.messages);
      if (entry.messages.length === 0) this.#deleteBufferedEntry(bindKey, entry);
    }
  }

  #deleteBufferedEntry(bindKey: string, entry: BufferedOutput): void {
    const current = this.#bufferedOutput.get(bindKey);
    if (!current || !current.includes(entry)) return;
    const retained = current.filter((candidate) => candidate !== entry);
    if (this.#bufferedOutput.get(bindKey) !== current) return;
    if (retained.length === 0) this.#bufferedOutput.delete(bindKey);
    else this.#bufferedOutput.set(bindKey, retained);
  }

  #advanceDrainedText(bindKey: string, taskId: string, message: RouterWorkerSend): void {
    if (message.messageType !== 'text' || typeof message.content !== 'string') return;
    const active = [...this.#active.values()].find((candidate) =>
      candidate.bindingKey === bindKey && candidate.taskId === taskId);
    if (!active) return;
    active.deliveredTextCharacters = Math.min(
      active.rawOutput.length,
      active.deliveredTextCharacters + message.content.length,
    );
  }

  #receipt(message: NormalizedRongCloudMessage, messageUid: string): RouterReceipt {
    return {
      messageUid,
      senderId: message.senderId,
      targetId: message.targetId,
      conversationType: message.conversationType,
      direction: message.direction ?? 'RECEIVE',
    };
  }

  #claimId(): string | undefined {
    try {
      const bytes = this.#randomBytes(16);
      if (!Buffer.isBuffer(bytes) || bytes.byteLength !== 16) return undefined;
      return bytes.toString('hex');
    } catch {
      return undefined;
    }
  }

  async #safeSendText(
    identity: WorkerIdentity,
    conversation: ConversationIdentity,
    content: string,
  ): Promise<void> {
    if (this.#disposedBindings.has(bindingKey(identity))) return;
    const bounded = Buffer.byteLength(content, 'utf8') <= 32 * 1024
      ? content
      : Buffer.from(content, 'utf8').subarray(0, 32 * 1024).toString('utf8');
    await this.#sendWorker(identity, {
      conversationType: conversation.conversationType,
      targetId: replyTargetId(conversation),
      messageType: 'text',
      content: bounded,
    }).catch(() => undefined);
  }

  #logFailure(active: ActiveTask, errorCode: string): void {
    this.#logger.warn({
      event: 'router_failure',
      runtimeId: active.identity.runtimeId,
      nodeId: active.identity.nodeId,
      conversationType: active.conversation.conversationType,
      conversationKeyHash: hashConversation(active.conversationKey),
      taskId: active.taskId,
      errorCode,
    });
  }
}
