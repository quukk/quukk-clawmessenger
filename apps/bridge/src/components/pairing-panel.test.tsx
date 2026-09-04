import '@testing-library/jest-dom/vitest';

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { StrictMode, useState } from 'react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BridgeApi, PairingSnapshot } from '../types';
import { PairingPanel } from './pairing-panel';

const expiresAt = '2099-09-02T10:05:00.000Z';

const waiting: PairingSnapshot = {
  state: 'waiting',
  expiresAt,
  pairingCode: 'ABCDEF23',
  qrContent: JSON.stringify({
    type: 'clawmessenger_pairing',
    version: 1,
    server: 'https://configured.example',
    ticket: 'p'.repeat(43),
    expiresAt: Date.parse(expiresAt),
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
    {
      candidateId: 'cand-codex',
      provider: 'codex',
      version: null,
      readiness: 'not_ready',
      statusReason: 'probe_failed',
      registrationState: 'unregistered',
    },
  ],
  results: [],
};

const completed: PairingSnapshot = {
  ...waiting,
  state: 'completed',
  pairingCode: null,
  qrContent: null,
  results: [
    {
      candidateId: 'cand-opencode',
      status: 'bound',
      errorCode: null,
      retryable: false,
    },
  ],
};

function createApi(overrides: Partial<BridgeApi> = {}): BridgeApi {
  return {
    getRuntimes: vi.fn().mockResolvedValue([]),
    rescanRuntimes: vi.fn().mockResolvedValue([]),
    enableBindings: vi.fn().mockResolvedValue([]),
    disableBinding: vi.fn().mockResolvedValue(undefined),
    reregisterBinding: vi.fn().mockResolvedValue({ runtimeId: '', ok: true }),
    getActivity: vi.fn().mockResolvedValue([]),
    getDiagnostics: vi.fn(),
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
    startPairing: vi.fn().mockResolvedValue(waiting),
    getPairing: vi.fn().mockResolvedValue(waiting),
    cancelPairing: vi.fn().mockResolvedValue({
      ...waiting, state: 'cancelled', pairingCode: null, qrContent: null,
    }),
    retryPairing: vi.fn().mockResolvedValue(waiting),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('pairing panel', () => {
  it('renders one accessible QR, expiration, and sanitized platform rows', () => {
    const api = createApi();
    const { container } = render(<PairingPanel api={api} initialSnapshot={waiting} />);

    expect(screen.getByLabelText(/pairing qr code/i)).toBeVisible();
    expect(screen.getByLabelText(/pairing code/i)).toHaveTextContent('ABCDEF23');
    expect(screen.getByText(/expires/i)).toBeVisible();
    expect(within(screen.getByTestId('pairing-candidate-opencode')).getByText('OpenCode')).toBeVisible();
    expect(
      within(screen.getByTestId('pairing-candidate-codex')).getByText(/could not be checked/i),
    ).toBeVisible();
    expect(container).not.toHaveTextContent('cand-opencode');
    expect(container).not.toHaveTextContent('rt_11111111111111111111111111111111');
    expect(container).not.toHaveTextContent('C:\\tools\\opencode.exe');
    expect(container).not.toHaveTextContent('p'.repeat(43));
  });

  it('keeps the manual pairing code readable on the fixed white QR card in dark mode', () => {
    render(
      <div className="dark">
        <PairingPanel api={createApi()} initialSnapshot={waiting} />
      </div>,
    );

    expect(screen.getByText(/or enter this code/i)).toHaveClass('text-neutral-600');
    expect(screen.getByText('ABCDEF23')).toHaveClass('text-neutral-950');
  });

  it('renders an expired waiting snapshot without a stale QR or polling at zero', async () => {
    vi.useFakeTimers();
    const getPairing = vi.fn<BridgeApi['getPairing']>().mockResolvedValue(waiting);
    render(
      <PairingPanel
        api={createApi({ getPairing })}
        initialSnapshot={waiting}
        now={() => Date.parse(expiresAt)}
      />,
    );

    expect(screen.getByText(/pairing code expired/i)).toBeVisible();
    expect(screen.queryByLabelText(/pairing qr code/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/expires in 0:00/i)).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(getPairing).not.toHaveBeenCalled();
  });

  it('hides a waiting QR at its exact deadline without polling or revival', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-09-02T10:00:00.000Z');
    const deadline = Date.now() + 1;
    const expiring = {
      ...waiting,
      expiresAt: new Date(deadline).toISOString(),
      qrContent: JSON.stringify({
        ...JSON.parse(waiting.qrContent!),
        expiresAt: deadline,
      }),
    };
    const getPairing = vi.fn<BridgeApi['getPairing']>().mockResolvedValue(expiring);
    const api = createApi({ getPairing });
    const clock = () => Date.now();

    function Harness() {
      const [renderCount, setRenderCount] = useState(0);
      return (
        <>
          <button type="button" onClick={() => setRenderCount((count) => count + 1)}>
            Unrelated render {renderCount}
          </button>
          <PairingPanel api={api} initialSnapshot={expiring} now={clock} />
        </>
      );
    }

    render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    );
    expect(screen.getByLabelText(/pairing qr code/i)).toBeVisible();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByText(/pairing code expired/i)).toBeVisible();
    expect(screen.queryByLabelText(/pairing qr code/i)).not.toBeInTheDocument();
    expect(getPairing).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /unrelated render/i }));
    expect(screen.queryByLabelText(/pairing qr code/i)).not.toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(getPairing).not.toHaveBeenCalled();
  });

  it('uses fixed provider and reason copy instead of free-form local text', () => {
    const hostile = {
      ...waiting,
      candidates: [
        {
          ...waiting.candidates[0],
          displayName: 'API key: abc123',
          version: 'token=secret',
          statusReason: 'C:\\private\\runtime-id.txt',
        },
        {
          ...waiting.candidates[1],
          displayName: 'rt_deadbeef',
          version: '1.2.3',
          statusReason: 'needs_auth',
        },
      ],
    } as unknown as PairingSnapshot;
    const { container } = render(<PairingPanel api={createApi()} initialSnapshot={hostile} />);

    expect(screen.getByText('OpenCode')).toBeVisible();
    expect(screen.getByText('Codex')).toBeVisible();
    expect(screen.getByText(/sign in to codex locally/i)).toBeVisible();
    expect(container).not.toHaveTextContent('API key: abc123');
    expect(container).not.toHaveTextContent('token=secret');
    expect(container).not.toHaveTextContent('C:\\private\\runtime-id.txt');
    expect(container).not.toHaveTextContent('rt_deadbeef');
    expect(container).not.toHaveTextContent('needs_auth');
  });

  it('polls while active and stops after a terminal snapshot', async () => {
    vi.useFakeTimers();
    const getPairing = vi
      .fn<BridgeApi['getPairing']>()
      .mockResolvedValueOnce({ ...waiting, state: 'claimed', pairingCode: null, qrContent: null })
      .mockResolvedValueOnce(completed);
    render(<PairingPanel api={createApi({ getPairing })} initialSnapshot={waiting} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByText(/pairing completed/i)).toBeVisible();
    expect(getPairing).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(getPairing).toHaveBeenCalledTimes(2);
  });

  it('aborts an in-flight poll and ignores its result after unmount', async () => {
    vi.useFakeTimers();
    const poll = deferred<PairingSnapshot>();
    let pollSignal: AbortSignal | undefined;
    const getPairing = vi.fn<BridgeApi['getPairing']>((signal) => {
      pollSignal = signal;
      return poll.promise;
    });
    const { unmount } = render(
      <PairingPanel api={createApi({ getPairing })} initialSnapshot={waiting} />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(getPairing).toHaveBeenCalledTimes(1);
    unmount();
    expect(pollSignal?.aborted).toBe(true);

    await act(async () => {
      poll.resolve(completed);
      await poll.promise;
    });
    expect(screen.queryByText(/pairing completed/i)).not.toBeInTheDocument();
  });

  it('keeps polling a non-terminal session after a safe transient error', async () => {
    vi.useFakeTimers();
    const getPairing = vi
      .fn<BridgeApi['getPairing']>()
      .mockRejectedValueOnce(new Error('contains C:\\private and token-secret'))
      .mockResolvedValueOnce(completed);
    const { container } = render(
      <PairingPanel api={createApi({ getPairing })} initialSnapshot={waiting} />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByRole('alert')).toHaveTextContent(/temporarily unavailable/i);
    expect(container).not.toHaveTextContent('C:\\private');
    expect(container).not.toHaveTextContent('token-secret');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByText(/pairing completed/i)).toBeVisible();
    expect(getPairing).toHaveBeenCalledTimes(2);
  });

  it('cancels the active session before starting a regenerated QR', async () => {
    vi.useFakeTimers();
    const cancellation = deferred<PairingSnapshot>();
    let pollSignal: AbortSignal | undefined;
    const getPairing = vi.fn<BridgeApi['getPairing']>((signal) => {
      pollSignal = signal;
      return new Promise(() => undefined);
    });
    let pollWasAbortedBeforeCancel = false;
    const cancelPairing = vi.fn<BridgeApi['cancelPairing']>(() => {
      pollWasAbortedBeforeCancel = pollSignal?.aborted === true;
      return cancellation.promise;
    });
    const startPairing = vi.fn<BridgeApi['startPairing']>().mockResolvedValue(waiting);
    render(
      <PairingPanel
        api={createApi({ cancelPairing, getPairing, startPairing })}
        initialSnapshot={waiting}
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    fireEvent.click(screen.getByRole('button', { name: /generate a new qr code/i }));
    expect(cancelPairing).toHaveBeenCalledTimes(1);
    expect(pollWasAbortedBeforeCancel).toBe(true);
    expect(startPairing).not.toHaveBeenCalled();

    await act(async () => {
      cancellation.resolve({
        ...waiting, state: 'cancelled', pairingCode: null, qrContent: null,
      });
      await cancellation.promise;
    });
    expect(startPairing).toHaveBeenCalledTimes(1);
  });

  it('retries only failed selected candidates that are retryable', async () => {
    const user = userEvent.setup();
    const partial: PairingSnapshot = {
      ...waiting,
      state: 'partial',
      pairingCode: null,
      qrContent: null,
      results: [
        {
          candidateId: 'cand-opencode',
          status: 'failed',
          errorCode: 'runtime_unavailable',
          retryable: true,
        },
        {
          candidateId: 'cand-codex',
          status: 'failed',
          errorCode: 'owned_by_other_account',
          retryable: false,
        },
      ],
    };
    const retryPairing = vi.fn<BridgeApi['retryPairing']>().mockResolvedValue({
      ...partial,
      state: 'processing',
    });
    render(
      <PairingPanel api={createApi({ retryPairing })} initialSnapshot={partial} />,
    );

    await user.click(screen.getByRole('button', { name: /retry failed platform/i }));
    expect(retryPairing).toHaveBeenCalledWith(['cand-opencode'], expect.any(AbortSignal));
    expect(screen.queryByText('runtime_unavailable')).not.toBeInTheDocument();
    expect(screen.queryByText('owned_by_other_account')).not.toBeInTheDocument();
  });
});
