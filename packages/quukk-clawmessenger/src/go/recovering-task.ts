import { BridgeClientError } from './client.js';
import type { BridgeHealth, BridgeTaskEvent, BridgeTaskFenceProof, BridgeTaskPort } from './types.js';

export interface RecoveringBridgeTaskOptions {
  resolveTask(): BridgeTaskPort;
  ensureBridge(): Promise<void>;
  refreshRuntime(runtimeId: string): Promise<boolean>;
}

export class RecoveringBridgeTask implements BridgeTaskPort {
  readonly #options: RecoveringBridgeTaskOptions;

  constructor(options: RecoveringBridgeTaskOptions) {
    this.#options = options;
  }

  async startTask(input: {
    model?: string;
    requestId?: string;
    runtimeId: string;
    conversationKey: string;
    prompt: string;
    workdir: string;
    resumeSessionId?: string;
  }): Promise<{ taskId: string; eventsUrl: string }> {
    try {
      return await this.#options.resolveTask().startTask(input);
    } catch (error) {
      if (!(error instanceof BridgeClientError)) throw error;
      if (error.code === 'transport_error') {
        await this.#recover(error, () => this.#options.ensureBridge());
        return this.#options.resolveTask().startTask(input);
      }
      if (error.code === 'request_timeout') {
        await this.#recover(error, () => this.#options.ensureBridge());
        throw error;
      }
      if (error.code === 'remote_error' && (error.status === 409 || error.status === 404)) {
        const ready = await this.#recover(error, () => this.#options.refreshRuntime(input.runtimeId));
        if (!ready) throw error;
        return this.#options.resolveTask().startTask(input);
      }
      throw error;
    }
  }

  async #recover<T>(original: BridgeClientError, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch {
      throw original;
    }
  }

  events(taskId: string, afterEventId?: number): AsyncIterable<BridgeTaskEvent> {
    return this.#options.resolveTask().events(taskId, afterEventId);
  }

  async cancelTask(taskId: string): Promise<void> {
    await this.#options.resolveTask().cancelTask(taskId);
  }

  health(options?: { signal?: AbortSignal }): Promise<BridgeHealth> {
    return (this.#options.resolveTask() as unknown as {
      health(options?: { signal?: AbortSignal }): Promise<BridgeHealth>;
    }).health(options);
  }

  fenceTask(taskId: string, options?: { signal?: AbortSignal }): Promise<BridgeTaskFenceProof> {
    return (this.#options.resolveTask() as unknown as {
      fenceTask(taskId: string, options?: { signal?: AbortSignal }): Promise<BridgeTaskFenceProof>;
    }).fenceTask(taskId, options);
  }
}
