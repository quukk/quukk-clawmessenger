import '@testing-library/jest-dom/vitest';

import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './app';
import { RuntimesPage } from './pages/runtimes';
import type { BridgeApi, BridgeRuntime, BridgeSettings, DiagnosticsSnapshot } from './types';

const capabilities = {
  sessionResume: true,
  cancel: true,
  textEvents: true,
  toolEvents: true,
  approvalEvents: false,
};

const runtimes: BridgeRuntime[] = [
  {
    id: 'rt_11111111111111111111111111111111',
    provider: 'opencode',
    status: 'ready',
    capabilities,
    binding: { enabled: true, registrationState: 'offline' },
    worker: { state: 'online', restartCount: 0 },
  },
  {
    id: 'rt_22222222222222222222222222222222',
    provider: 'openclaw',
    status: 'ready',
    capabilities,
    binding: { enabled: false, registrationState: 'offline' },
    worker: { state: 'offline', restartCount: 0 },
  },
  { provider: 'codex', status: 'not_found', capabilities },
  { provider: 'hermes', status: 'not_found', capabilities },
];

const settings: BridgeSettings = {
  serverUrl: 'https://newsradar.dreamdt.cn/im',
  defaultWorkdir: 'C:\\work\\project',
  authorizedWorkRoots: ['C:\\work'],
  providerPathOverrides: {},
  logLevel: 'info',
};

function diagnostics(version: string, startedAt = '2026-08-27T08:00:00Z'): DiagnosticsSnapshot {
  return {
    schemaVersion: 1,
    service: {
      version,
      state: 'ready',
      pid: 123,
      startedAt,
      listenHost: '127.0.0.1',
      port: 48321,
      uptimeMs: 1_000,
    },
    bridge: { state: 'ready' },
    runtimes: [],
    workers: [],
    warnings: [],
    logging: { dropped: 0, retained: 1 },
  };
}

function createApi(overrides: Partial<BridgeApi> = {}): BridgeApi {
  return {
    getRuntimes: vi.fn().mockResolvedValue(runtimes),
    rescanRuntimes: vi.fn().mockResolvedValue(runtimes),
    enableBindings: vi.fn().mockResolvedValue([]),
    disableBinding: vi.fn().mockResolvedValue(undefined),
    reregisterBinding: vi.fn().mockResolvedValue({
      runtimeId: runtimes[0]!.id!,
      ok: true,
    }),
    getActivity: vi.fn().mockResolvedValue([
      {
        id: 1,
        time: '2026-08-27T08:00:00Z',
        runtimeId: runtimes[0]!.id,
        kind: 'message',
        summary: 'Message routed',
      },
    ]),
    getDiagnostics: vi.fn().mockResolvedValue(diagnostics('0.1.0-beta.1')),
    getSettings: vi.fn().mockResolvedValue(settings),
    updateSettings: vi.fn().mockImplementation(async (next) => next),
    startPairing: vi.fn().mockResolvedValue({
      state: 'idle',
      expiresAt: null,
      qrContent: null,
      candidates: [],
      results: [],
    }),
    getPairing: vi.fn().mockResolvedValue({
      state: 'idle',
      expiresAt: null,
      qrContent: null,
      candidates: [],
      results: [],
    }),
    cancelPairing: vi.fn().mockResolvedValue({
      state: 'idle',
      expiresAt: null,
      qrContent: null,
      candidates: [],
      results: [],
    }),
    retryPairing: vi.fn().mockResolvedValue({
      state: 'idle',
      expiresAt: null,
      qrContent: null,
      candidates: [],
      results: [],
    }),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('bridge app', () => {
  it('keeps Multica attribution beside the derivative product name', async () => {
    render(<App api={createApi()} />);

    expect(await screen.findByText('Multica')).toBeVisible();
    expect(screen.getByText('Quukk ClawMessenger')).toBeVisible();
    expect(screen.getByRole('link', { name: /built on multica/i })).toHaveAttribute(
      'href',
      'https://github.com/multica-ai/multica',
    );
  });

  it('rescans, disables, and reregisters runtimes', async () => {
    const user = userEvent.setup();
    const api = createApi();
    render(<App api={api} />);
    await screen.findByRole('heading', { name: /choose local agents/i });

    await user.click(screen.getByRole('button', { name: /^runtimes$/i }));
    await screen.findByRole('heading', { name: /local runtimes/i });
    await user.click(screen.getByRole('button', { name: /rescan/i }));
    expect(api.rescanRuntimes).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: /disable opencode/i }));
    expect(api.disableBinding).toHaveBeenCalledWith(runtimes[0]!.id);

    await user.click(screen.getByRole('button', { name: /reregister opencode/i }));
    expect(api.reregisterBinding).toHaveBeenCalledWith(runtimes[0]!.id);
  });

  it('shows an online worker as online even while the stored registration state is offline', async () => {
    const user = userEvent.setup();
    render(<App api={createApi()} />);
    await screen.findByRole('heading', { name: /choose local agents/i });

    await user.click(screen.getByRole('button', { name: /^runtimes$/i }));

    expect(
      await within(screen.getByTestId('runtime-opencode')).findByLabelText(/status: online/i),
    ).toBeVisible();
    expect(
      within(screen.getByTestId('runtime-openclaw')).getByLabelText(/status: registered offline/i),
    ).toBeVisible();
  });

  it('refreshes a starting worker on Runtimes mount until the worker is online', async () => {
    const user = userEvent.setup();
    const startingRuntimes: BridgeRuntime[] = [
      {
        ...runtimes[0]!,
        binding: { enabled: true, registrationState: 'online' },
        worker: { state: 'starting', restartCount: 0 },
      },
      ...runtimes.slice(1),
    ];
    const onlineRuntimes: BridgeRuntime[] = [
      { ...startingRuntimes[0]!, worker: { state: 'online', restartCount: 0 } },
      ...startingRuntimes.slice(1),
    ];
    const getRuntimes = vi
      .fn<BridgeApi['getRuntimes']>()
      .mockResolvedValueOnce(startingRuntimes)
      .mockResolvedValueOnce(startingRuntimes)
      .mockResolvedValueOnce(onlineRuntimes);

    render(<App api={createApi({ getRuntimes })} />);
    await screen.findByRole('heading', { name: /choose local agents/i });
    await user.click(screen.getByRole('button', { name: /^runtimes$/i }));

    expect(
      within(screen.getByTestId('runtime-opencode')).getByLabelText(
        /status: registered offline/i,
      ),
    ).toBeVisible();
    await vi.waitFor(() => expect(getRuntimes).toHaveBeenCalledTimes(3));
    expect(
      await within(screen.getByTestId('runtime-opencode')).findByLabelText(/status: online/i),
    ).toBeVisible();
  });

  it('stops automatic Runtimes refresh after the bounded attempt limit', async () => {
    vi.useFakeTimers();
    const startingRuntimes: BridgeRuntime[] = [
      {
        ...runtimes[0]!,
        worker: { state: 'starting', restartCount: 0 },
      },
      ...runtimes.slice(1),
    ];
    const getRuntimes = vi
      .fn<BridgeApi['getRuntimes']>()
      .mockResolvedValue(startingRuntimes);

    render(
      <RuntimesPage
        api={createApi({ getRuntimes })}
        runtimes={startingRuntimes}
        onRuntimesChange={vi.fn()}
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(getRuntimes).toHaveBeenCalledTimes(20);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(getRuntimes).toHaveBeenCalledTimes(20);
  });

  it('recovers when an automatic Runtimes refresh fails transiently', async () => {
    const user = userEvent.setup();
    const startingRuntimes: BridgeRuntime[] = [
      {
        ...runtimes[0]!,
        worker: { state: 'starting', restartCount: 0 },
      },
      ...runtimes.slice(1),
    ];
    const onlineRuntimes: BridgeRuntime[] = [
      { ...startingRuntimes[0]!, worker: { state: 'online', restartCount: 0 } },
      ...startingRuntimes.slice(1),
    ];
    const getRuntimes = vi
      .fn<BridgeApi['getRuntimes']>()
      .mockResolvedValueOnce(startingRuntimes)
      .mockRejectedValueOnce(new Error('temporary refresh failure'))
      .mockResolvedValueOnce(onlineRuntimes);

    render(<App api={createApi({ getRuntimes })} />);
    await screen.findByRole('heading', { name: /choose local agents/i });
    await user.click(screen.getByRole('button', { name: /^runtimes$/i }));

    await vi.waitFor(() => expect(getRuntimes).toHaveBeenCalledTimes(3));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(
      await within(screen.getByTestId('runtime-opencode')).findByLabelText(/status: online/i),
    ).toBeVisible();
  });

  it('surfaces an explicit reregister failure without refreshing as if it succeeded', async () => {
    const user = userEvent.setup();
    const getRuntimes = vi.fn<BridgeApi['getRuntimes']>().mockResolvedValue(runtimes);
    const api = createApi({
      getRuntimes,
      reregisterBinding: vi.fn().mockResolvedValue({
        runtimeId: runtimes[0]!.id!,
        ok: false,
        errorCode: 'invalid_response',
      }),
    });
    render(<App api={api} />);
    await screen.findByRole('heading', { name: /choose local agents/i });

    await user.click(screen.getByRole('button', { name: /^runtimes$/i }));
    await vi.waitFor(() => expect(getRuntimes).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole('button', { name: /reregister opencode/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/unable to reregister this agent/i);
    expect(getRuntimes).toHaveBeenCalledTimes(2);
  });

  it('labels activity by runtime and safely falls back for an unknown runtime', async () => {
    const user = userEvent.setup();
    const api = createApi({
      getActivity: vi.fn().mockResolvedValue([
        {
          id: 1,
          time: '2026-08-27T08:00:00Z',
          runtimeId: runtimes[0]!.id,
          kind: 'message',
          summary: 'Message routed',
        },
        {
          id: 2,
          time: '2026-08-27T08:01:00Z',
          runtimeId: 'rt_unknown',
          kind: 'message',
          summary: 'Another message routed',
        },
      ]),
    });
    render(<App api={api} />);
    await screen.findByRole('heading', { name: /choose local agents/i });

    await user.click(screen.getByRole('button', { name: /^activity$/i }));
    expect(await screen.findByText('Message routed')).toBeVisible();
    expect(screen.getByText('OpenCode')).toBeVisible();
    expect(screen.getByText('Unknown runtime')).toBeVisible();
    expect(api.getActivity).toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /^diagnostics$/i }));
    expect(await screen.findByText(/0.1.0-beta.1/i)).toBeVisible();
    expect(api.getDiagnostics).toHaveBeenCalled();
  });

  it('keeps the newest diagnostics response when StrictMode overlaps requests', async () => {
    const user = userEvent.setup();
    const older = deferred<Awaited<ReturnType<BridgeApi['getDiagnostics']>>>();
    const newer = deferred<Awaited<ReturnType<BridgeApi['getDiagnostics']>>>();
    const getDiagnostics = vi
      .fn<BridgeApi['getDiagnostics']>()
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const api = createApi({ getDiagnostics });

    render(
      <StrictMode>
        <App api={api} />
      </StrictMode>,
    );
    await screen.findByRole('heading', { name: /choose local agents/i });
    await user.click(screen.getByRole('button', { name: /^diagnostics$/i }));
    expect(getDiagnostics).toHaveBeenCalledTimes(2);

    await act(async () => {
      newer.resolve(diagnostics('newer', '2026-08-27T08:01:00Z'));
      await newer.promise;
    });
    expect(screen.getByText(/newer/i)).toBeVisible();

    await act(async () => {
      older.resolve(diagnostics('older'));
      await older.promise;
    });
    expect(screen.getByText(/newer/i)).toBeVisible();
    expect(screen.queryByText(/older/i)).not.toBeInTheDocument();
  });

  it('does not apply a rescan response after the runtimes page unmounts', async () => {
    const user = userEvent.setup();
    const rescan = deferred<readonly BridgeRuntime[]>();
    const api = createApi({ rescanRuntimes: vi.fn(() => rescan.promise) });
    render(<App api={api} />);
    await screen.findByRole('heading', { name: /choose local agents/i });

    await user.click(screen.getByRole('button', { name: /^runtimes$/i }));
    await user.click(screen.getByRole('button', { name: /rescan/i }));
    await user.click(screen.getByRole('button', { name: /^activity$/i }));
    await act(async () => {
      rescan.resolve([
        ...runtimes.slice(0, 2),
        { ...runtimes[2]!, id: 'rt_33333333333333333333333333333333', status: 'ready' },
        runtimes[3]!,
      ]);
      await rescan.promise;
    });

    await user.click(screen.getByRole('button', { name: /^runtimes$/i }));
    expect(
      within(screen.getByTestId('runtime-codex')).getByLabelText(/status: not found/i),
    ).toBeVisible();
  });

  it('does not apply settings saved after the settings page unmounts', async () => {
    const user = userEvent.setup();
    const update = deferred<BridgeSettings>();
    const api = createApi({ updateSettings: vi.fn(() => update.promise) });
    render(<App api={api} />);
    await screen.findByRole('heading', { name: /choose local agents/i });

    await user.click(screen.getByRole('button', { name: /^settings$/i }));
    const serverUrl = await screen.findByLabelText(/server url/i);
    await user.clear(serverUrl);
    await user.type(serverUrl, 'https://example.invalid/im');
    await user.click(screen.getByRole('button', { name: /save settings/i }));
    await user.click(screen.getByRole('button', { name: /^activity$/i }));
    await act(async () => {
      update.resolve({ ...settings, serverUrl: 'https://example.invalid/im' });
      await update.promise;
    });

    await user.click(screen.getByRole('button', { name: /^settings$/i }));
    expect(await screen.findByLabelText(/server url/i)).toHaveValue(settings.serverUrl);
  });

  it('saves a default directory inside an authorized root', async () => {
    const user = userEvent.setup();
    const api = createApi();
    render(<App api={api} />);
    await screen.findByRole('heading', { name: /choose local agents/i });

    await user.click(screen.getByRole('button', { name: /^settings$/i }));
    expect(screen.getByText(/environment and cli overrides still take precedence/i)).toBeVisible();
    const defaultDirectory = await screen.findByLabelText(/default work directory/i);
    await user.clear(defaultDirectory);
    await user.type(defaultDirectory, 'C:\\work\\second-project');
    await user.click(screen.getByRole('button', { name: /save settings/i }));

    expect(api.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        authorizedWorkRoots: ['C:\\work'],
        defaultWorkdir: 'C:\\work\\second-project',
      }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent(/settings saved/i);
  });
});
