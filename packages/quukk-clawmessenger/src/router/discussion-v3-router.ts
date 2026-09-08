import { createHash, randomBytes } from 'node:crypto';
import type { BridgeTaskPort, BridgeTaskFenceProof } from '../go/types.js';
import { parseDiscussionV3, type DiscussionV3Message, type DiscussionV3Assignment, type DiscussionV3HostTurn, type DiscussionV3Cancel, type CancelResult } from '../protocol/discussion-v3.js';
import { buildDiscussionV3Prompt, discussionV3Identity, discussionV3ResponseKey, parseDiscussionV3Checkpoint } from '../protocol/discussion-v3-prompt.js';
import { interactiveSessionKey, type BindingIdentity } from './conversation.js';
import { RouterStateStore, type InteractiveRequest } from './session-store.js';
type Work = DiscussionV3Assignment | DiscussionV3HostTurn;
export interface InteractiveTaskPort extends BridgeTaskPort {
  health(): Promise<{
    instance_id: string;
  }>;
  fenceTask(taskId: string, options?: {
    signal?: AbortSignal;
  }): Promise<BridgeTaskFenceProof>;
}
export interface DiscussionV3RouterOptions {
  identity: BindingIdentity;
  memberId: string;
  task: InteractiveTaskPort;
  state: RouterStateStore;
  workdir(): Promise<string>;
  available(): Promise<boolean>;
  send(payload: DiscussionV3Message): Promise<void>;
  now?: () => number;
  cancelTimeoutMs?: number;
}
const REQUEST_TTL = 24 * 60 * 60 * 1000;
function canonical(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
/** Runs only authenticated server commands; durable state owns task and cancel identities. */
export class DiscussionV3Router {
  readonly #options: DiscussionV3RouterOptions;
  readonly #active = new Map<string, Promise<void>>();
  readonly #now: () => number;
  #disposed = false;
  constructor(options: DiscussionV3RouterOptions) { this.#options = options; this.#now = options.now ?? Date.now; }
  async handle(senderId: string, payload: DiscussionV3Message): Promise<void> {
    if (this.#disposed)
      return;
    const command = parseDiscussionV3(payload);
    if (senderId !== 'system' || !command || command.timestamp > this.#now() + 300000 || command.timestamp + REQUEST_TTL <= this.#now())
      return;
    if (command.msg_type === 'discussion_event') {
      await this.#options.state.rememberInteractiveRoom(this.#options.identity, command.chatroomId, command.discussionId);
      return;
    }
    if (command.msg_type === 'discussion_cancel') {
      if (command.targetMemberId !== this.#options.memberId)
        return;
      await this.#options.state.rememberInteractiveRoom(this.#options.identity, command.chatroomId, command.discussionId);
      await this.#cancel(senderId, command);
      return;
    }
    if (command.msg_type !== 'discussion_assignment' && command.msg_type !== 'discussion_host_turn')
      return;
    if (command.msg_type === 'discussion_assignment' && command.targetId !== this.#options.memberId)
      return;
    if (command.msg_type === 'discussion_host_turn' && !Object.values(command.roles).some(role => role.memberId === this.#options.memberId && role.isHost === true))
      return;
    await this.#options.state.rememberInteractiveRoom(this.#options.identity, command.chatroomId, command.discussionId);
    const key = this.#key(senderId, command.discussionId, command.requestId);
    const active = this.#active.get(key);
    if (active)
      return active;
    const run = this.#run(senderId, command).finally(() => this.#active.delete(key));
    this.#active.set(key, run);
    return run;
  }
  async dispose(): Promise<void> {
    this.#disposed = true;
    const { state, task, identity } = this.#options;
    for (const record of await state.interactiveRequests(identity)) {
      if (record.status === 'terminal')
        continue;
      await state.updateInteractive(record.key, { status: 'cancel_pending' });
      try {
        if ((await task.health()).instance_id !== record.instanceId)
          throw new Error('instance_changed');
        const proof = await this.#fence(record.taskId);
        await state.updateInteractive(record.key, { status: 'terminal', cancelResult: proof.result }, proof.session_id);
      }
      catch {
        await state.updateInteractive(record.key, { status: 'unconfirmed', cancelResult: 'failed' });
      }
    }
  }
  async #fence(taskId: string): Promise<BridgeTaskFenceProof> {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.#options.task.fenceTask(taskId, { signal: abort.signal }),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { abort.abort(); reject(new Error('stop_unconfirmed')); }, this.#options.cancelTimeoutMs ?? 10000); }),
      ]);
    }
    finally {
      if (timer)
        clearTimeout(timer);
    }
  }
  #key(sender: string, discussion: string, request: string): string {
    return JSON.stringify([this.#options.identity.runtimeId, this.#options.identity.nodeId, sender, discussion, request]);
  }
  async #record(senderId: string, command: Work | DiscussionV3Cancel): Promise<InteractiveRequest> {
    const { identity } = this.#options;
    const requestId = command.msg_type === 'discussion_cancel' ? command.targetRequestId : command.requestId;
    const health = await this.#options.task.health();
    return {
      key: this.#key(senderId, command.discussionId, requestId),
      sessionKey: interactiveSessionKey(identity.runtimeId, identity.nodeId, 'discussion', command.discussionId),
      ...identity, senderId, memberId: this.#options.memberId, discussionId: command.discussionId, chatroomId: command.chatroomId, requestId,
      taskId: `task_${this.#now().toString(16)}_${randomBytes(16).toString('hex')}`, instanceId: health.instance_id,
      stateVersion: command.stateVersion, round: command.round, roundRevision: command.roundRevision,
      expiresAt: command.timestamp + REQUEST_TTL, fingerprint: command.msg_type === 'discussion_cancel' ? '' : createHash('sha256').update(canonical(command)).digest('hex'),
      status: command.msg_type === 'discussion_cancel' ? 'cancel_pending' : 'reserved',
    };
  }
  async #run(sender: string, command: Work): Promise<void> {
    const { state, task } = this.#options;
    let record: InteractiveRequest | undefined;
    try {
      record = await state.interactiveRequest(this.#key(sender, command.discussionId, command.requestId));
      if (record) {
        if (record.fingerprint !== createHash('sha256').update(canonical(command)).digest('hex'))
          return;
        if (record.status === 'terminal') {
          const response = parseDiscussionV3(record.response);
          if (response)
            await this.#options.send(response);
          return;
        }
        if (record.status === 'cancel_pending' || record.status === 'unconfirmed')
          return;
      }
      if (!await this.#options.available()) {
        if (record)
          await state.updateInteractive(record.key, { status: 'unconfirmed' });
        else
          await this.#error(command, 'model_error', `Interactive rounds unavailable for runtime ${this.#options.identity.runtimeId}: verified cancel/session_resume/text_events required`);
        return;
      }
      const candidate = await this.#record(sender, command);
      record = await state.reserveInteractive(candidate);
      if (!record)
        return;
      if (record.fingerprint !== candidate.fingerprint)
        return;
      if (record.status === 'terminal') {
        const response = parseDiscussionV3(record.response);
        if (response)
          await this.#options.send(response);
        return;
      }
      if (record.status === 'cancel_pending' || record.status === 'unconfirmed')
        return;
      if (record.instanceId !== candidate.instanceId) {
        await state.updateInteractive(record.key, { status: 'unconfirmed' });
        return;
      }
      const workdir = await this.#options.workdir();
      const resumeSessionId = await state.interactiveSession(record.sessionKey);
      const latest = await state.interactiveRequest(record.key);
      if (latest?.status === 'cancel_pending' || latest?.status === 'terminal')
        return;
      if (this.#disposed) {
        const proof = await this.#fence(record.taskId);
        await state.updateInteractive(record.key, { status: 'terminal', cancelResult: proof.result }, proof.session_id);
        return;
      }
      const started = await task.startTask({ requestId: record.taskId, runtimeId: record.runtimeId, conversationKey: record.sessionKey, workdir, prompt: buildDiscussionV3Prompt(command), ...(command.msg_type === 'discussion_assignment' && command.model ? { model: command.model } : {}), ...(resumeSessionId ? { resumeSessionId } : {}) });
      if (started.taskId !== record.taskId)
        throw new Error('request_identity_mismatch');
      // A cancel can race the POST; do not replace its durable pending marker.
      if ((await state.interactiveRequest(record.key))?.status === 'reserved')
        await state.updateInteractive(record.key, { status: 'running' });
      let output = '';
      let seq = 0;
      for await (const event of task.events(record.taskId)) {
        if (event.task_id !== record.taskId)
          continue;
        const current = await state.interactiveRequest(record.key);
        if (!current || current.roundRevision !== command.roundRevision || current.requestId !== command.requestId)
          continue;
        const suppress = this.#disposed || current.status === 'cancel_pending' || current.status === 'terminal' || current.status === 'unconfirmed';
        if (event.type === 'text_delta' && !suppress && event.text) {
          output += event.text;
          if (output.length > 100000)
            throw new Error('output_too_large');
          if (command.msg_type === 'discussion_assignment' && event.text.trim())
            await this.#options.send({ ...discussionV3Identity(command), msg_type: 'discussion_contribution_delta', assignmentId: command.assignmentId, content: event.text, seq: seq++, idempotencyKey: discussionV3ResponseKey(command.requestId, `delta:${seq}`) });
        }
        if (event.type === 'completed' || event.type === 'failed' || event.type === 'cancelled') {
          if (event.type === 'failed' && event.error.category === 'stop_unconfirmed') {
            await state.updateInteractive(record.key, { status: 'unconfirmed' });
            return;
          }
          if (suppress) {
            if (event.session_id)
              await state.updateInteractive(record.key, {}, event.session_id);
            return;
          }
          let response: DiscussionV3Message | null = null;
          if (event.type === 'completed') {
            output = event.output || output;
            response = command.msg_type === 'discussion_host_turn' ? parseDiscussionV3Checkpoint(output, command)
              : parseDiscussionV3({ ...discussionV3Identity(command), msg_type: 'discussion_contribution_completed', assignmentId: command.assignmentId, content: output, idempotencyKey: discussionV3ResponseKey(command.requestId, 'completed') });
          }
          if (!response)
            response = this.#errorPayload(command, event.type === 'completed' ? 'invalid_response' : 'model_error', 'Runtime did not return a valid completed response');
          await state.updateInteractive(record.key, { status: 'terminal', response: { ...response } }, event.session_id);
          await this.#options.send(response);
          return;
        }
      }
      throw new Error('terminal_event_missing');
    }
    catch {
      if (record && (await state.interactiveRequest(record.key))?.status !== 'terminal')
        await state.updateInteractive(record.key, { status: 'unconfirmed' });
      // Without terminal proof, a node_error would falsely imply safe completion.
      // Keep the durable fence; the coordinator's timeout/cancel protocol reports failure.
    }
  }
  async #cancel(sender: string, command: DiscussionV3Cancel): Promise<void> {
    const { state, task } = this.#options;
    let result: CancelResult = 'failed';
    let record: InteractiveRequest | undefined;
    try {
      const key = this.#key(sender, command.discussionId, command.targetRequestId);
      record = await state.interactiveRequest(key);
      if (!record)
        record = await state.reserveInteractive(await this.#record(sender, command));
      if (!record || record.memberId !== command.targetMemberId || record.chatroomId !== command.chatroomId || record.round !== command.round
        || command.stateVersion < record.stateVersion || command.roundRevision < record.roundRevision)
        return;
      if (record.cancelResult && record.cancelResult !== 'failed')
        result = record.cancelResult;
      else if (record.status === 'terminal')
        result = 'already_terminal';
      else {
        await state.updateInteractive(record.key, { status: 'cancel_pending' });
        if ((await task.health()).instance_id !== record.instanceId)
          throw new Error('instance_changed');
        const proof = await this.#fence(record.taskId);
        result = proof.result;
        if (proof.session_id)
          await state.updateInteractive(record.key, {}, proof.session_id);
      }
      await state.updateInteractive(record.key, { status: 'terminal', cancelResult: result });
    }
    catch {
      if (record)
        await state.updateInteractive(record.key, { status: 'unconfirmed', cancelResult: 'failed' });
    }
    await this.#options.send({ ...discussionV3Identity(command), msg_type: 'discussion_cancel_ack', targetRequestId: command.targetRequestId, targetMemberId: command.targetMemberId, result });
  }
  #errorPayload(command: Work, category: 'model_error' | 'invalid_response', message: string): DiscussionV3Message {
    return { ...discussionV3Identity(command), msg_type: 'discussion_node_error', ...(command.msg_type === 'discussion_assignment' ? { assignmentId: command.assignmentId } : {}), category, message, idempotencyKey: discussionV3ResponseKey(command.requestId, 'error') };
  }
  async #error(command: Work, category: 'model_error' | 'invalid_response', message: string): Promise<void> {
    await this.#options.send(this.#errorPayload(command, category, message));
  }
}
