import { createHash } from 'node:crypto';

import type { NormalizedRongCloudMessage } from '../../src/protocol/messages.js';
import type { WorkerEvent } from '../../src/rongcloud/worker-protocol.js';
import type {
  RongCloudWorkerSupervisorOptions,
  SupervisorBinding,
  WorkerIdentity,
  WorkerSnapshot,
} from '../../src/rongcloud/worker-supervisor.js';
import type {
  RouterReceipt,
  RouterWorkerSend,
} from '../../src/router/message-router.js';

type WorkerRecord = {
  binding: SupervisorBinding;
  state: WorkerSnapshot['state'];
  instanceId: string;
  restartCount: number;
  credentialDigest: string;
};

export type FakeOutbound = { identity: WorkerIdentity; input: RouterWorkerSend };

function cloneBinding(binding: SupervisorBinding): SupervisorBinding {
  return { ...binding };
}

function fixedWorkerError(): Error & { code: 'worker_exited' } {
  return Object.assign(new Error('worker_exited'), { code: 'worker_exited' as const });
}

export class FakeRongCloudWorkers {
  readonly #options: RongCloudWorkerSupervisorOptions;
  readonly #trace: string[];
  readonly #records = new Map<string, WorkerRecord>();
  readonly #outbound: FakeOutbound[] = [];
  readonly #receipts: Array<{ identity: WorkerIdentity; input: RouterReceipt }> = [];
  #nextMessage = 0;

  constructor(options: RongCloudWorkerSupervisorOptions, trace: string[]) {
    this.#options = options;
    this.#trace = trace;
  }

  async reconcile(bindings: readonly SupervisorBinding[]): Promise<void> {
    this.#trace.push('workers.reconcile');
    const desired = new Set(bindings.map(({ runtimeId }) => runtimeId));
    for (const runtimeId of this.#records.keys()) {
      if (!desired.has(runtimeId)) this.#records.delete(runtimeId);
    }
    for (const binding of bindings) {
      const credential = await this.#options.resolveCredential(binding);
      const previous = this.#records.get(binding.runtimeId);
      const record: WorkerRecord = {
        binding: cloneBinding(binding),
        state: 'online',
        instanceId: `rcw_${binding.runtimeId.slice(3)}`,
        restartCount: previous?.restartCount ?? 0,
        credentialDigest: createHash('sha256')
          .update(credential.appKey, 'utf8')
          .update('\0', 'utf8')
          .update(credential.token, 'utf8')
          .digest('hex'),
      };
      this.#records.set(binding.runtimeId, record);
      this.#emit(record, {
        type: 'connection',
        runtimeId: binding.runtimeId,
        instanceId: record.instanceId,
        state: 'online',
      });
    }
  }

  async stop(identity: WorkerIdentity): Promise<void> {
    this.#trace.push(`workers.stop:${identity.runtimeId}`);
    const current = this.#records.get(identity.runtimeId);
    if (current?.binding.nodeId === identity.nodeId) this.#records.delete(identity.runtimeId);
  }

  async restart(identity: WorkerIdentity): Promise<void> {
    const current = this.#exact(identity);
    current.restartCount += 1;
    current.state = 'online';
    this.#emit(current, {
      type: 'connection', runtimeId: identity.runtimeId, instanceId: current.instanceId, state: 'online',
    });
  }

  snapshots(): readonly WorkerSnapshot[] {
    return [...this.#records.values()].map((record) => ({
      runtimeId: record.binding.runtimeId,
      nodeId: record.binding.nodeId,
      state: record.state,
      instanceId: record.instanceId,
      restartCount: record.restartCount,
    }));
  }

  async dispose(): Promise<void> {
    this.#trace.push('workers.dispose');
    this.#records.clear();
  }

  async send(identity: WorkerIdentity, input: RouterWorkerSend): Promise<string> {
    const current = this.#exact(identity);
    if (current.state !== 'online') throw fixedWorkerError();
    this.#outbound.push({
      identity: { ...identity },
      input: structuredClone(input),
    });
    this.#nextMessage += 1;
    return `e2e-outbound-${this.#nextMessage}`;
  }

  async receipt(identity: WorkerIdentity, input: RouterReceipt): Promise<void> {
    const current = this.#exact(identity);
    if (current.state !== 'online') throw fixedWorkerError();
    this.#receipts.push({ identity: { ...identity }, input: { ...input } });
  }

  async joinChatroom(identity: WorkerIdentity): Promise<void> {
    const current = this.#exact(identity);
    if (current.state !== 'online') throw fixedWorkerError();
  }

  bindings(): readonly SupervisorBinding[] {
    return [...this.#records.values()].map(({ binding }) => cloneBinding(binding));
  }

  credentialDigests(): readonly string[] {
    return [...this.#records.values()].map(({ credentialDigest }) => credentialDigest);
  }

  outbound(): readonly FakeOutbound[] {
    return this.#outbound.map(({ identity, input }) => ({
      identity: { ...identity }, input: structuredClone(input),
    }));
  }

  receipts(): ReadonlyArray<{ identity: WorkerIdentity; input: RouterReceipt }> {
    return this.#receipts.map(({ identity, input }) => ({ identity: { ...identity }, input: { ...input } }));
  }

  emitMessage(runtimeId: string, message: NormalizedRongCloudMessage): void {
    const current = this.#records.get(runtimeId);
    if (current === undefined || current.state !== 'online') throw fixedWorkerError();
    this.#emit(current, {
      type: 'message',
      runtimeId,
      instanceId: current.instanceId,
      message: structuredClone(message),
    });
  }

  crash(runtimeId: string): void {
    const current = this.#records.get(runtimeId);
    if (current === undefined) throw fixedWorkerError();
    current.state = 'backoff';
    current.restartCount += 1;
    this.#emit(current, {
      type: 'connection', runtimeId, instanceId: current.instanceId, state: 'offline',
    });
  }

  reconnect(runtimeId: string): void {
    const current = this.#records.get(runtimeId);
    if (current === undefined) throw fixedWorkerError();
    current.state = 'online';
    this.#emit(current, {
      type: 'connection', runtimeId, instanceId: current.instanceId, state: 'online',
    });
  }

  #exact(identity: WorkerIdentity): WorkerRecord {
    const current = this.#records.get(identity.runtimeId);
    if (current === undefined || current.binding.nodeId !== identity.nodeId) throw fixedWorkerError();
    return current;
  }

  #emit(record: WorkerRecord, event: WorkerEvent): void {
    this.#options.onEvent?.({
      runtimeId: record.binding.runtimeId,
      nodeId: record.binding.nodeId,
    }, event);
  }
}
