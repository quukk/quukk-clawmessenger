import '@testing-library/jest-dom/vitest';

import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './app';
import type { BridgeApi, BridgeRuntime, BridgeSettings, PairingSnapshot } from './types';

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

const pairing: PairingSnapshot = {
  state: 'waiting',
  expiresAt: '2099-09-02T10:05:00.000Z',
  qrContent: JSON.stringify({
    type: 'clawmessenger_pairing',
    version: 1,
    server: 'https://configured.example',
    ticket: 'p'.repeat(43),
    expiresAt: Date.parse('2099-09-02T10:05:00.000Z'),
  }),
  candidates: [
    {
      candidateId: 'cand-opencode',
      provider: 'opencode',
      version: '1.2.3',
      readiness: 'ready',
      statusReason: null,
      registrationState: 'unregistered',
    },
  ],
  results: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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
    startPairing: vi.fn().mockResolvedValue(pairing),
    getPairing: vi.fn().mockResolvedValue(pairing),
    cancelPairing: vi.fn().mockResolvedValue({ ...pairing, state: 'cancelled', qrContent: null }),
    retryPairing: vi.fn().mockResolvedValue(pairing),
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
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('runtime setup', () => {
  it('shows discovered agents without registration checkboxes or local identifiers', async () => {
    const api = createApi();
    const { container } = render(<App api={api} />);
    expect(await screen.findByText('OpenCode')).toBeVisible();
    expect(screen.queryByRole('checkbox', { name: /OpenCode/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /select all ready agents/i })).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent('rt_11111111111111111111111111111111');
    expect(container).not.toHaveTextContent('C:\\tools\\opencode.exe');
    expect(within(screen.getByTestId('runtime-codex')).getAllByText(/not found/i)).not.toHaveLength(0);
  });

  it('saves local policy and starts exactly one QR session', async () => {
    const user = userEvent.setup();
    const api = createApi();
    await renderReady(api);

    expect(screen.queryByRole('checkbox', { name: /cloud registration/i })).not.toBeInTheDocument();
    const generate = screen.getByRole('button', { name: /generate pairing qr code/i });
    expect(generate).toBeDisabled();
    await completePolicyForm(user);
    expect(generate).toBeEnabled();
    await user.click(generate);

    expect(api.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        authorizedWorkRoots: ['C:\\work'],
        defaultWorkdir: 'C:\\work\\project',
      }),
    );
    expect(api.startPairing).toHaveBeenCalledTimes(1);
    expect(api.enableBindings).not.toHaveBeenCalled();
    expect(await screen.findByLabelText(/pairing qr code/i)).toBeVisible();
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
    });
    await renderReady(api);

    const root = screen.getByLabelText(/authorized work root/i);
    await user.clear(root);
    await user.type(root, 'D:\\keep');
    await user.click(
      screen.getByRole('checkbox', { name: /i understand the permission policy/i }),
    );
    await user.click(screen.getByRole('button', { name: /generate pairing qr code/i }));

    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        authorizedWorkRoots: ['D:\\keep', 'E:\\also-keep'],
        defaultWorkdir: 'D:\\keep\\project',
      }),
    );
  });

  it('does not start pairing after setup unmounts while settings are pending', async () => {
    const user = userEvent.setup();
    const update = deferred<BridgeSettings>();
    const startPairing = vi.fn<BridgeApi['startPairing']>().mockResolvedValue(pairing);
    const api = createApi({
      updateSettings: vi.fn(() => update.promise),
      startPairing,
    });
    await renderReady(api);
    await completePolicyForm(user);
    await user.click(screen.getByRole('button', { name: /generate pairing qr code/i }));
    await user.click(screen.getByRole('button', { name: /^runtimes$/i }));

    await act(async () => {
      update.resolve({
        ...emptySettings,
        authorizedWorkRoots: ['C:\\work'],
        defaultWorkdir: 'C:\\work\\project',
      });
      await update.promise;
    });

    expect(startPairing).not.toHaveBeenCalled();
  });

  it('aborts a pending pairing start when Setup unmounts', async () => {
    const user = userEvent.setup();
    let startSignal: AbortSignal | undefined;
    const startPairing = vi.fn<BridgeApi['startPairing']>((signal) => {
      startSignal = signal;
      return new Promise(() => undefined);
    });
    const api = createApi({ startPairing });
    await renderReady(api);
    await completePolicyForm(user);
    await user.click(screen.getByRole('button', { name: /generate pairing qr code/i }));
    await vi.waitFor(() => expect(startPairing).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('button', { name: /^runtimes$/i }));
    expect(startSignal?.aborted).toBe(true);
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
