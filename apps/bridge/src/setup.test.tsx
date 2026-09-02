import '@testing-library/jest-dom/vitest';

import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './app';
import type {
  BindingMutationResult,
  BridgeApi,
  BridgeRuntime,
  BridgeSettings,
} from './types';

const capabilities = {
  sessionResume: true,
  cancel: true,
  textEvents: true,
  toolEvents: true,
  approvalEvents: false,
};

const detectedRuntimes: BridgeRuntime[] = [
  {
    id: 'rt_11111111111111111111111111111111',
    provider: 'opencode',
    status: 'ready',
    version: '1.2.3',
    path: 'C:\\tools\\opencode.exe',
    capabilities,
  },
  {
    id: 'rt_22222222222222222222222222222222',
    provider: 'openclaw',
    status: 'ready',
    version: '2.0.0',
    path: 'C:\\tools\\openclaw.exe',
    capabilities,
  },
  { provider: 'codex', status: 'not_found', capabilities },
  { provider: 'hermes', status: 'not_found', capabilities },
];

const emptySettings: BridgeSettings = {
  serverUrl: 'https://newsradar.dreamdt.cn/im',
  defaultWorkdir: null,
  authorizedWorkRoots: [],
  providerPathOverrides: {},
  logLevel: 'info',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createApi(overrides: Partial<BridgeApi> = {}): BridgeApi {
  return {
    getRuntimes: vi.fn().mockResolvedValue(detectedRuntimes),
    rescanRuntimes: vi.fn().mockResolvedValue(detectedRuntimes),
    enableBindings: vi.fn().mockResolvedValue([]),
    disableBinding: vi.fn().mockResolvedValue(undefined),
    reregisterBinding: vi.fn().mockResolvedValue({ runtimeId: '', ok: true }),
    getActivity: vi.fn().mockResolvedValue([]),
    getDiagnostics: vi.fn().mockResolvedValue({
      schemaVersion: 1,
      service: {
        version: '0.1.0-beta.1',
        state: 'ready',
        pid: 123,
        startedAt: '2026-08-27T00:00:00Z',
        listenHost: '127.0.0.1',
        port: 48321,
        uptimeMs: 1_000,
      },
      bridge: { state: 'ready' },
      runtimes: [],
      workers: [],
      warnings: [],
      logging: { dropped: 0, retained: 0 },
    }),
    getSettings: vi.fn().mockResolvedValue(emptySettings),
    updateSettings: vi.fn().mockImplementation(async (settings) => settings),
    ...overrides,
  };
}

async function renderReady(api: BridgeApi) {
  render(<App api={api} />);
  await screen.findByRole('heading', { name: /choose local agents/i });
}

async function completePolicyForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/authorized work root/i), 'C:\\work');
  await user.type(screen.getByLabelText(/default work directory/i), 'C:\\work\\project');
  await user.click(
    screen.getByRole('checkbox', { name: /i understand the permission policy/i }),
  );
  await user.click(
    screen.getByRole('checkbox', { name: /i understand the cloud registration disclosure/i }),
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('runtime setup', () => {
  it('detects all providers and selects only ready runtimes by default', async () => {
    const api = createApi();
    await renderReady(api);

    expect(screen.getByRole('checkbox', { name: /select opencode/i })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /select openclaw/i })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /select codex/i })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('checkbox', { name: /select hermes/i })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(within(screen.getByTestId('runtime-codex')).getAllByText(/not found/i)).not.toHaveLength(0);
    expect(within(screen.getByTestId('runtime-hermes')).getAllByText(/not found/i)).not.toHaveLength(0);
  });

  it('supports individual keyboard selection and select all without unavailable runtimes', async () => {
    const user = userEvent.setup();
    await renderReady(createApi());

    const openClaw = screen.getByRole('checkbox', { name: /select openclaw/i });
    openClaw.focus();
    await user.keyboard(' ');
    expect(openClaw).not.toBeChecked();

    await user.click(screen.getByRole('checkbox', { name: /select all ready agents/i }));
    expect(screen.getByRole('checkbox', { name: /select opencode/i })).toBeChecked();
    expect(openClaw).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /select codex/i })).not.toBeChecked();
  });

  it('does not register before explicit consent and submit', async () => {
    const user = userEvent.setup();
    const api = createApi();
    await renderReady(api);

    expect(screen.getByText(/headless permission mode/i)).toBeVisible();
    expect(screen.getByText(/interactive approval is not available/i)).toBeVisible();
    expect(api.enableBindings).not.toHaveBeenCalled();
    expect(api.updateSettings).not.toHaveBeenCalled();

    await completePolicyForm(user);
    expect(api.enableBindings).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /register 2 agents/i }));

    expect(api.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        authorizedWorkRoots: ['C:\\work'],
        defaultWorkdir: 'C:\\work\\project',
      }),
    );
    expect(api.enableBindings).toHaveBeenCalledTimes(2);
  });

  it('requires consent to the outbound registration disclosure', async () => {
    const user = userEvent.setup();
    const api = createApi();
    await renderReady(api);

    expect(screen.getByRole('heading', { name: /cloud registration disclosure/i })).toBeVisible();
    expect(screen.getByText(/hostname-derived node label/i)).toBeVisible();
    expect(screen.getByText(/network-interface MAC address/i)).toBeVisible();
    expect(screen.getByText(/newsradar\.dreamdt\.cn\/im/i)).toBeVisible();
    expect(screen.getByText(/no self-service remote identity deletion/i)).toBeVisible();

    await user.type(screen.getByLabelText(/authorized work root/i), 'C:\\work');
    await user.type(screen.getByLabelText(/default work directory/i), 'C:\\work\\project');
    await user.click(
      screen.getByRole('checkbox', { name: /i understand the permission policy/i }),
    );
    expect(screen.getByRole('button', { name: /register 2 agents/i })).toBeDisabled();
    expect(api.enableBindings).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole('checkbox', { name: /i understand the cloud registration disclosure/i }),
    );
    expect(screen.getByRole('button', { name: /register 2 agents/i })).toBeEnabled();
  });

  it('keeps independent progress and successful rows when another registration fails', async () => {
    const user = userEvent.setup();
    const openCode = deferred<readonly BindingMutationResult[]>();
    const openClaw = deferred<readonly BindingMutationResult[]>();
    const enableBindings = vi.fn((runtimeIds: readonly string[]) =>
      runtimeIds[0] === detectedRuntimes[0]?.id ? openCode.promise : openClaw.promise,
    );
    const refreshedRuntimes: BridgeRuntime[] = [
      {
        ...detectedRuntimes[0]!,
        binding: { enabled: true, registrationState: 'online' },
      },
      {
        ...detectedRuntimes[1]!,
        binding: {
          enabled: false,
          registrationState: 'error',
          lastErrorCode: 'registration_transport',
        },
      },
      detectedRuntimes[2]!,
      detectedRuntimes[3]!,
    ];
    const getRuntimes = vi
      .fn<BridgeApi['getRuntimes']>()
      .mockResolvedValueOnce(detectedRuntimes)
      .mockResolvedValue(refreshedRuntimes);
    const api = createApi({ enableBindings, getRuntimes });
    await renderReady(api);
    await completePolicyForm(user);
    await user.click(screen.getByRole('button', { name: /register 2 agents/i }));

    const openCodeRow = screen.getByTestId('runtime-opencode');
    const openClawRow = screen.getByTestId('runtime-openclaw');
    expect(within(openCodeRow).getByText(/registering/i)).toBeVisible();
    expect(within(openClawRow).getByText(/registering/i)).toBeVisible();

    await act(async () => {
      openCode.resolve([{ runtimeId: detectedRuntimes[0]!.id!, ok: true }]);
      await openCode.promise;
    });
    expect(within(openCodeRow).getByText(/connected/i)).toBeVisible();
    expect(within(openClawRow).getByText(/registering/i)).toBeVisible();

    await act(async () => {
      openClaw.resolve([
        {
          runtimeId: detectedRuntimes[1]!.id!,
          ok: false,
          errorCode: 'registration_transport',
        },
      ]);
      await openClaw.promise;
    });
    expect(within(openCodeRow).getByText(/connected/i)).toBeVisible();
    expect(within(openClawRow).getByText(/registration failed/i)).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent(/openclaw/i);
    expect(getRuntimes).toHaveBeenCalledTimes(3);

    await user.click(screen.getByRole('button', { name: /^runtimes$/i }));
    const refreshedOpenCode = screen.getByTestId('runtime-opencode');
    expect(within(refreshedOpenCode).getByText(/online/i)).toBeVisible();
    expect(within(refreshedOpenCode).getByRole('button', { name: /disable opencode/i })).toBeVisible();
  });

  it('keeps successful progress visible when the post-registration refresh fails', async () => {
    const user = userEvent.setup();
    const getRuntimes = vi
      .fn<BridgeApi['getRuntimes']>()
      .mockResolvedValueOnce(detectedRuntimes)
      .mockRejectedValueOnce(new Error('refresh failed'));
    const api = createApi({
      getRuntimes,
      enableBindings: vi.fn().mockResolvedValue([
        { runtimeId: detectedRuntimes[0]!.id!, ok: true },
      ]),
    });
    await renderReady(api);
    await user.click(screen.getByRole('checkbox', { name: /select openclaw/i }));
    await completePolicyForm(user);
    await user.click(screen.getByRole('button', { name: /register 1 agent/i }));

    const openCodeRow = screen.getByTestId('runtime-opencode');
    expect(await within(openCodeRow).findByText(/connected/i)).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent(/status could not be refreshed/i);
  });

  it('refreshes on Runtimes after navigating while the Setup refresh is still pending', async () => {
    const user = userEvent.setup();
    const runtimeId = detectedRuntimes[0]!.id!;
    const setupRefresh = deferred<readonly BridgeRuntime[]>();
    const registeredStarting: BridgeRuntime[] = [
      {
        ...detectedRuntimes[0]!,
        binding: { enabled: true, registrationState: 'offline' },
        worker: { state: 'starting', restartCount: 0 },
      },
      ...detectedRuntimes.slice(1),
    ];
    const registeredOnline: BridgeRuntime[] = [
      {
        ...registeredStarting[0]!,
        worker: { state: 'online', restartCount: 0 },
      },
      ...registeredStarting.slice(1),
    ];
    const getRuntimes = vi
      .fn<BridgeApi['getRuntimes']>()
      .mockResolvedValueOnce(detectedRuntimes)
      .mockImplementationOnce(() => setupRefresh.promise)
      .mockResolvedValueOnce(registeredOnline);
    const api = createApi({
      getRuntimes,
      enableBindings: vi.fn().mockResolvedValue([{ runtimeId, ok: true }]),
    });

    await renderReady(api);
    await user.click(screen.getByRole('checkbox', { name: /select openclaw/i }));
    await completePolicyForm(user);
    await user.click(screen.getByRole('button', { name: /register 1 agent/i }));

    expect(
      await within(screen.getByTestId('runtime-opencode')).findByText(/connected/i),
    ).toBeVisible();
    expect(getRuntimes).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole('button', { name: /^runtimes$/i }));
    await vi.waitFor(() => expect(getRuntimes).toHaveBeenCalledTimes(3));
    expect(
      within(screen.getByTestId('runtime-opencode')).getByLabelText(/status: online/i),
    ).toBeVisible();

    await act(async () => {
      setupRefresh.resolve(registeredStarting);
      await setupRefresh.promise;
    });
  });

  it('replaces only the edited first authorized root and removes duplicates', async () => {
    const user = userEvent.setup();
    const configuredSettings: BridgeSettings = {
      ...emptySettings,
      defaultWorkdir: 'D:\\keep\\project',
      authorizedWorkRoots: ['C:\\old', 'D:\\keep', 'E:\\also-keep'],
    };
    const updateSettings = vi.fn<BridgeApi['updateSettings']>().mockImplementation(async (next) => next);
    const api = createApi({
      getSettings: vi.fn().mockResolvedValue(configuredSettings),
      updateSettings,
      enableBindings: vi.fn().mockResolvedValue([]),
    });
    await renderReady(api);

    const root = screen.getByLabelText(/authorized work root/i);
    await user.clear(root);
    await user.type(root, 'D:\\keep');
    await user.click(
      screen.getByRole('checkbox', { name: /i understand the permission policy/i }),
    );
    await user.click(
      screen.getByRole('checkbox', { name: /i understand the cloud registration disclosure/i }),
    );
    await user.click(screen.getByRole('button', { name: /register 2 agents/i }));

    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        authorizedWorkRoots: ['D:\\keep', 'E:\\also-keep'],
        defaultWorkdir: 'D:\\keep\\project',
      }),
    );
  });

  it('does not continue registration after setup unmounts while settings are pending', async () => {
    const user = userEvent.setup();
    const update = deferred<BridgeSettings>();
    const enableBindings = vi.fn<BridgeApi['enableBindings']>().mockResolvedValue([]);
    const api = createApi({
      updateSettings: vi.fn(() => update.promise),
      enableBindings,
    });
    await renderReady(api);
    await completePolicyForm(user);
    await user.click(screen.getByRole('button', { name: /register 2 agents/i }));
    await user.click(screen.getByRole('button', { name: /^runtimes$/i }));

    await act(async () => {
      update.resolve({
        ...emptySettings,
        authorizedWorkRoots: ['C:\\work'],
        defaultWorkdir: 'C:\\work\\project',
      });
      await update.promise;
    });

    expect(enableBindings).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /^settings$/i }));
    expect(await screen.findByLabelText(/default work directory/i)).toHaveValue('');
  });

  it('explains authentication, non-runnable, and probe failures', async () => {
    const api = createApi({
      getRuntimes: vi.fn().mockResolvedValue([
        { ...detectedRuntimes[0], status: 'needs_auth' },
        { ...detectedRuntimes[1], status: 'found_not_runnable' },
        { provider: 'codex', status: 'probe_failed', capabilities },
        { provider: 'hermes', status: 'not_found', capabilities },
      ]),
    });
    await renderReady(api);

    expect(screen.getByText(/sign in to opencode, then rescan/i)).toBeVisible();
    expect(screen.getByText(/executable was found but could not run/i)).toBeVisible();
    expect(screen.getByText(/detection failed.*rescan/i)).toBeVisible();
  });
});
