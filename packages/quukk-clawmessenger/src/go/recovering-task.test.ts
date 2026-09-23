// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { BridgeClientError } from './client.js';
import { RecoveringBridgeTask } from './recovering-task.js';
import type { BridgeTaskPort } from './types.js';

const input = {
  runtimeId: `rt_${'a'.repeat(32)}`,
  conversationKey: 'discussion-a',
  prompt: 'Review',
  workdir: 'D:/work',
};

const started = { taskId: 'task_a_b', eventsUrl: '/v1/tasks/task_a_b/events' };
const retried = { taskId: 'task_c_d', eventsUrl: '/v1/tasks/task_c_d/events' };

function transportError(): BridgeClientError {
  return new BridgeClientError('transport_error', { retryable: true });
}

function timeoutError(): BridgeClientError {
  return new BridgeClientError('request_timeout', { retryable: true });
}

function remoteError(status: number): BridgeClientError {
  return new BridgeClientError('remote_error', { status, remoteCode: 'runtime_not_ready' });
}

type Harness = {
  facade: RecoveringBridgeTask;
  first: BridgeTaskPort;
  second: BridgeTaskPort;
  ensureBridge: ReturnType<typeof vi.fn>;
  refreshRuntime: ReturnType<typeof vi.fn>;
};

function harness(options: {
  firstStart: BridgeTaskPort['startTask'];
  secondStart?: BridgeTaskPort['startTask'];
  refreshReady?: boolean;
}): Harness {
  const first: BridgeTaskPort = {
    startTask: vi.fn(options.firstStart),
    events: vi.fn(),
    cancelTask: vi.fn(),
  };
  const second: BridgeTaskPort = {
    startTask: vi.fn(options.secondStart ?? (async () => retried)),
    events: vi.fn(),
    cancelTask: vi.fn(),
  };
  let current: BridgeTaskPort = first;
  const ensureBridge = vi.fn(async () => {
    current = second;
  });
  const refreshRuntime = vi.fn(async () => options.refreshReady ?? true);
  const facade = new RecoveringBridgeTask({
    resolveTask: () => current,
    ensureBridge,
    refreshRuntime,
  });
  return { facade, first, second, ensureBridge, refreshRuntime };
}

describe('RecoveringBridgeTask.startTask', () => {
  it('passes successful starts through without recovery', async () => {
    const { facade, first, ensureBridge, refreshRuntime } = harness({
      firstStart: async () => started,
    });
    await expect(facade.startTask(input)).resolves.toEqual(started);
    expect(first.startTask).toHaveBeenCalledTimes(1);
    expect(ensureBridge).not.toHaveBeenCalled();
    expect(refreshRuntime).not.toHaveBeenCalled();
  });

  it('restarts the bridge and retries once on transport_error', async () => {
    const { facade, first, second, ensureBridge } = harness({
      firstStart: async () => {
        throw transportError();
      },
    });
    await expect(facade.startTask(input)).resolves.toEqual(retried);
    expect(ensureBridge).toHaveBeenCalledTimes(1);
    expect(first.startTask).toHaveBeenCalledTimes(1);
    expect(second.startTask).toHaveBeenCalledWith(input);
    expect(second.startTask).toHaveBeenCalledTimes(1);
  });

  it('throws the original error when the bridge cannot be restarted', async () => {
    const { facade, first, second, ensureBridge } = harness({
      firstStart: async () => {
        throw transportError();
      },
    });
    ensureBridge.mockRejectedValueOnce(new Error('startup_failed'));
    await expect(facade.startTask(input)).rejects.toMatchObject({ code: 'transport_error' });
    expect(ensureBridge).toHaveBeenCalledTimes(1);
    expect(second.startTask).not.toHaveBeenCalled();
    expect(first.startTask).toHaveBeenCalledTimes(1);
  });

  it('throws the original error when the retry after recovery fails again', async () => {
    const { facade, first, second, ensureBridge } = harness({
      firstStart: async () => {
        throw transportError();
      },
      secondStart: async () => {
        throw transportError();
      },
    });
    await expect(facade.startTask(input)).rejects.toMatchObject({ code: 'transport_error' });
    expect(ensureBridge).toHaveBeenCalledTimes(1);
    expect(first.startTask).toHaveBeenCalledTimes(1);
    expect(second.startTask).toHaveBeenCalledTimes(1);
  });

  it('restarts the bridge on request_timeout but never retries the task', async () => {
    const { facade, first, second, ensureBridge } = harness({
      firstStart: async () => {
        throw timeoutError();
      },
    });
    await expect(facade.startTask(input)).rejects.toMatchObject({ code: 'request_timeout' });
    expect(ensureBridge).toHaveBeenCalledTimes(1);
    expect(first.startTask).toHaveBeenCalledTimes(1);
    expect(second.startTask).not.toHaveBeenCalled();
  });

  it('refreshes the runtime and retries once on remote_error 409', async () => {
    let attempts = 0;
    const { facade, first, second, refreshRuntime, ensureBridge } = harness({
      firstStart: async () => {
        attempts += 1;
        if (attempts === 1) throw remoteError(409);
        return retried;
      },
    });
    await expect(facade.startTask(input)).resolves.toEqual(retried);
    expect(refreshRuntime).toHaveBeenCalledTimes(1);
    expect(refreshRuntime).toHaveBeenCalledWith(input.runtimeId);
    expect(ensureBridge).not.toHaveBeenCalled();
    expect(first.startTask).toHaveBeenCalledTimes(2);
    expect(second.startTask).not.toHaveBeenCalled();
  });

  it('refreshes the runtime and retries once on remote_error 404', async () => {
    let attempts = 0;
    const { facade, first, second, refreshRuntime } = harness({
      firstStart: async () => {
        attempts += 1;
        if (attempts === 1) throw remoteError(404);
        return retried;
      },
    });
    await expect(facade.startTask(input)).resolves.toEqual(retried);
    expect(refreshRuntime).toHaveBeenCalledTimes(1);
    expect(first.startTask).toHaveBeenCalledTimes(2);
    expect(second.startTask).not.toHaveBeenCalled();
  });

  it('skips the retry when the runtime is still not ready after refresh', async () => {
    const { facade, first, second, refreshRuntime } = harness({
      firstStart: async () => {
        throw remoteError(409);
      },
      refreshReady: false,
    });
    await expect(facade.startTask(input)).rejects.toMatchObject({ code: 'remote_error', status: 409 });
    expect(refreshRuntime).toHaveBeenCalledTimes(1);
    expect(first.startTask).toHaveBeenCalledTimes(1);
    expect(second.startTask).not.toHaveBeenCalled();
  });

  it('leaves other remote statuses unrecovered', async () => {
    const { facade, first, ensureBridge, refreshRuntime } = harness({
      firstStart: async () => {
        throw remoteError(500);
      },
    });
    await expect(facade.startTask(input)).rejects.toMatchObject({ code: 'remote_error', status: 500 });
    expect(ensureBridge).not.toHaveBeenCalled();
    expect(refreshRuntime).not.toHaveBeenCalled();
    expect(first.startTask).toHaveBeenCalledTimes(1);
  });

  it('leaves invalid_request failures unrecovered', async () => {
    const { facade, first, ensureBridge, refreshRuntime } = harness({
      firstStart: async () => {
        throw new BridgeClientError('invalid_request');
      },
    });
    await expect(facade.startTask(input)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(ensureBridge).not.toHaveBeenCalled();
    expect(refreshRuntime).not.toHaveBeenCalled();
    expect(first.startTask).toHaveBeenCalledTimes(1);
  });

  it('rethrows non-bridge errors untouched', async () => {
    const plain = new Error('interactive_work_requires_v3');
    const { facade, first, ensureBridge, refreshRuntime } = harness({
      firstStart: async () => {
        throw plain;
      },
    });
    await expect(facade.startTask(input)).rejects.toBe(plain);
    expect(ensureBridge).not.toHaveBeenCalled();
    expect(refreshRuntime).not.toHaveBeenCalled();
  });
});

describe('RecoveringBridgeTask forwarding', () => {
  it('forwards events and cancelTask to the active task', async () => {
    const { facade, first } = harness({ firstStart: async () => started });
    await facade.cancelTask('task_a_b');
    expect(first.cancelTask).toHaveBeenCalledWith('task_a_b');
    void facade.events('task_a_b', 3);
    expect(first.events).toHaveBeenCalledWith('task_a_b', 3);
  });

  it('forwards events to the replaced task after bridge recovery', async () => {
    const { facade, second, ensureBridge } = harness({
      firstStart: async () => {
        throw transportError();
      },
    });
    await facade.startTask(input);
    expect(ensureBridge).toHaveBeenCalledTimes(1);
    void facade.events('task_c_d');
    expect(second.events).toHaveBeenCalledWith('task_c_d', undefined);
  });

  it('forwards health and fenceTask to the active task', async () => {
    const { facade, first } = harness({ firstStart: async () => started });
    const target = first as unknown as {
      health: ReturnType<typeof vi.fn>;
      fenceTask: ReturnType<typeof vi.fn>;
    };
    target.health = vi.fn(async () => ({ instance_id: `br_${'a'.repeat(32)}` }));
    target.fenceTask = vi.fn(async () => ({ result: 'accepted' }) as never);
    await expect(facade.health()).resolves.toEqual({ instance_id: `br_${'a'.repeat(32)}` });
    await expect(facade.fenceTask('task_a_b')).resolves.toEqual({ result: 'accepted' });
    expect(target.health).toHaveBeenCalledTimes(1);
    expect(target.fenceTask).toHaveBeenCalledWith('task_a_b', undefined);
  });

  it('forwards health and fenceTask to the replaced task after bridge recovery', async () => {
    const { facade, second, ensureBridge } = harness({
      firstStart: async () => {
        throw transportError();
      },
    });
    await facade.startTask(input);
    expect(ensureBridge).toHaveBeenCalledTimes(1);
    const target = second as unknown as {
      health: ReturnType<typeof vi.fn>;
      fenceTask: ReturnType<typeof vi.fn>;
    };
    target.health = vi.fn(async () => ({ instance_id: `br_${'b'.repeat(32)}` }));
    target.fenceTask = vi.fn(async () => ({ result: 'cancelled' }) as never);
    await expect(facade.health()).resolves.toEqual({ instance_id: `br_${'b'.repeat(32)}` });
    await expect(facade.fenceTask('task_c_d')).resolves.toEqual({ result: 'cancelled' });
    expect(target.health).toHaveBeenCalledTimes(1);
    expect(target.fenceTask).toHaveBeenCalledWith('task_c_d', undefined);
  });
});
