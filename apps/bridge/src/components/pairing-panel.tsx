import { Button } from '@multica/ui/components/ui/button';
import { useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'react-qr-code';

import type {
  BridgeApi,
  PairingCandidate,
  PairingCandidateResult,
  PairingSnapshot,
  PairingState,
  PairingStatusReason,
} from '../types';

const TERMINAL_STATES = new Set<PairingState>([
  'completed',
  'partial',
  'cancelled',
  'expired',
]);
const MAX_TIMEOUT_MS = 2_147_483_647;

const STATE_COPY: Record<PairingState, string> = {
  idle: 'Pairing is ready to start.',
  waiting: 'Waiting for a scan',
  claimed: 'Awaiting platform selection',
  processing: 'Registering selected platforms',
  completed: 'Pairing completed',
  partial: 'Pairing partially completed',
  cancelled: 'Pairing cancelled',
  expired: 'Pairing code expired',
};

const RESULT_COPY: Record<PairingCandidateResult['status'], string> = {
  pending: 'Waiting',
  registering: 'Registering',
  bound: 'Connected',
  already_bound: 'Already connected',
  failed: 'Could not add this platform',
};

const PROVIDER_COPY: Record<PairingCandidate['provider'], string> = {
  opencode: 'OpenCode',
  openclaw: 'OpenClaw',
  codex: 'Codex',
  hermes: 'Hermes',
};

const STATUS_REASON_COPY: Omit<Record<PairingStatusReason, string>, 'needs_auth'> = {
  found_not_runnable: 'This platform is not ready to run locally.',
  not_found: 'This platform is not installed locally.',
  probe_failed: 'This platform could not be checked locally.',
  provider_conflict: 'Another local installation of this platform was detected.',
};

function statusReasonCopy(candidate: PairingCandidate): string | null {
  if (candidate.statusReason === null) return null;
  if (candidate.statusReason === 'needs_auth') {
    return `Sign in to ${PROVIDER_COPY[candidate.provider]} locally.`;
  }
  return STATUS_REASON_COPY[candidate.statusReason];
}

function safeVersion(value: string | null): string | null {
  return value !== null && /^v?(?:0|[1-9]\d{0,4})(?:\.(?:0|[1-9]\d{0,4})){0,3}$/u.test(value)
    ? value
    : null;
}

function readinessCopy(candidate: PairingCandidate): string {
  switch (candidate.readiness) {
    case 'ready':
      return 'Ready';
    case 'not_ready':
      return 'Not ready';
    case 'already_registered':
      return 'Already registered';
    default:
      return 'Unavailable';
  }
}

function expiresCopy(expiresAt: string | null, now: number): string | null {
  if (expiresAt === null) return null;
  const remainingSeconds = Math.ceil((Date.parse(expiresAt) - now) / 1_000);
  if (remainingSeconds <= 0) return null;
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  return `Expires in ${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function isExpiredWaiting(snapshot: PairingSnapshot, now: number): boolean {
  return (
    snapshot.state === 'waiting' &&
    snapshot.expiresAt !== null &&
    Date.parse(snapshot.expiresAt) <= now
  );
}

type PairingPanelProps = {
  api: BridgeApi;
  initialSnapshot: PairingSnapshot;
  now?: () => number;
};

export function PairingPanel({ api, initialSnapshot, now: clock = Date.now }: PairingPanelProps) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [currentTime, setCurrentTime] = useState(() => clock());
  const [actionBusy, setActionBusy] = useState(false);
  const [requestFailed, setRequestFailed] = useState(false);
  const actionGeneration = useRef(0);
  const mounted = useRef(true);
  const actionController = useRef<AbortController | undefined>(undefined);
  const pollController = useRef<AbortController | undefined>(undefined);
  const displayState: PairingState = isExpiredWaiting(snapshot, currentTime)
    ? 'expired'
    : snapshot.state;

  useEffect(
    () => () => {
      mounted.current = false;
      actionGeneration.current += 1;
      actionController.current?.abort();
      pollController.current?.abort();
    },
    [],
  );

  useEffect(() => {
    if (TERMINAL_STATES.has(displayState) || displayState === 'idle' || actionBusy) return;
    const controller = new AbortController();
    pollController.current = controller;
    let active = true;
    const timer = window.setTimeout(() => {
      const requestTime = clock();
      if (isExpiredWaiting(snapshot, requestTime)) {
        if (active && mounted.current) setCurrentTime(requestTime);
        return;
      }
      void api.getPairing(controller.signal).then(
        (next) => {
          if (active && mounted.current) {
            setRequestFailed(false);
            setSnapshot({ ...next });
          }
        },
        () => {
          if (active && mounted.current && !controller.signal.aborted) {
            setRequestFailed(true);
            setSnapshot((current) => ({ ...current }));
          }
        },
      );
    }, 1_000);
    return () => {
      active = false;
      window.clearTimeout(timer);
      controller.abort();
      if (pollController.current === controller) pollController.current = undefined;
    };
  }, [actionBusy, api, clock, displayState, snapshot]);

  useEffect(() => {
    if (snapshot.expiresAt === null || TERMINAL_STATES.has(displayState)) return;
    const timer = window.setInterval(() => setCurrentTime(clock()), 1_000);
    return () => window.clearInterval(timer);
  }, [clock, displayState, snapshot.expiresAt]);

  useEffect(() => {
    if (snapshot.state !== 'waiting' || snapshot.expiresAt === null) return;
    const deadline = Date.parse(snapshot.expiresAt);
    let active = true;
    let timer: number | undefined;
    const schedule = () => {
      const observedTime = clock();
      const remaining = deadline - observedTime;
      if (remaining <= 0) {
        if (active && mounted.current) setCurrentTime(observedTime);
        return;
      }
      timer = window.setTimeout(schedule, Math.min(remaining, MAX_TIMEOUT_MS));
    };
    schedule();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [clock, snapshot.expiresAt, snapshot.state]);

  const resultByCandidate = useMemo(
    () => new Map(snapshot.results.map((result) => [result.candidateId, result])),
    [snapshot.results],
  );
  const retryCandidateIds = snapshot.results
    .filter((result) => result.status === 'failed' && result.retryable)
    .map((result) => result.candidateId);
  const canRetry =
    snapshot.state === 'partial' &&
    retryCandidateIds.length > 0 &&
    snapshot.expiresAt !== null &&
    Date.parse(snapshot.expiresAt) > currentTime;
  const expires = displayState === 'expired' ? null : expiresCopy(snapshot.expiresAt, currentTime);

  function beginAction(): { controller: AbortController; generation: number } {
    pollController.current?.abort();
    pollController.current = undefined;
    actionController.current?.abort();
    const controller = new AbortController();
    actionController.current = controller;
    const generation = ++actionGeneration.current;
    setActionBusy(true);
    setRequestFailed(false);
    return { controller, generation };
  }

  function isCurrent(generation: number): boolean {
    return mounted.current && actionGeneration.current === generation;
  }

  async function regenerate() {
    const { controller, generation } = beginAction();
    try {
      await api.cancelPairing(controller.signal);
      if (!isCurrent(generation)) return;
      const next = await api.startPairing(controller.signal);
      if (isCurrent(generation)) setSnapshot(next);
    } catch {
      if (isCurrent(generation) && !controller.signal.aborted) setRequestFailed(true);
    } finally {
      if (isCurrent(generation)) setActionBusy(false);
    }
  }

  async function cancel() {
    const { controller, generation } = beginAction();
    try {
      const next = await api.cancelPairing(controller.signal);
      if (isCurrent(generation)) setSnapshot(next);
    } catch {
      if (isCurrent(generation) && !controller.signal.aborted) setRequestFailed(true);
    } finally {
      if (isCurrent(generation)) setActionBusy(false);
    }
  }

  async function retry() {
    if (!canRetry) return;
    const { controller, generation } = beginAction();
    try {
      const next = await api.retryPairing(retryCandidateIds, controller.signal);
      if (isCurrent(generation)) setSnapshot(next);
    } catch {
      if (isCurrent(generation) && !controller.signal.aborted) setRequestFailed(true);
    } finally {
      if (isCurrent(generation)) setActionBusy(false);
    }
  }

  return (
    <section
      aria-labelledby="pairing-panel-title"
      className="grid gap-4 rounded-xl border border-surface-border bg-surface p-4 sm:p-5"
    >
      <div className="grid gap-1">
        <h2 id="pairing-panel-title" className="font-heading text-title-sm font-medium">
          Pair with ClawMessenger
        </h2>
        <p role="status" aria-live="polite" className="text-body text-muted-foreground">
          {STATE_COPY[displayState]}
          {expires === null ? null : ` · ${expires}`}
        </p>
      </div>

      {displayState === 'waiting' && snapshot.qrContent !== null ? (
        <div className="grid justify-items-center gap-3 rounded-lg bg-white p-4 sm:justify-self-start">
          <div role="img" aria-label="Pairing QR code" className="size-56 max-w-full">
            <QRCode value={snapshot.qrContent} size={224} className="size-full" />
          </div>
          <p className="text-center text-body text-foreground">
            Scan with ClawMessenger to choose platforms.
          </p>
        </div>
      ) : null}

      <ul className="grid gap-2" aria-label="Detected pairing platforms">
        {snapshot.candidates.map((candidate) => {
          const result = resultByCandidate.get(candidate.candidateId);
          const label = PROVIDER_COPY[candidate.provider];
          const version = safeVersion(candidate.version);
          const reason = statusReasonCopy(candidate);
          return (
            <li
              key={candidate.candidateId}
              data-testid={`pairing-candidate-${candidate.provider}`}
              className="grid gap-1 rounded-lg border border-surface-border px-3 py-2"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">
                  {label}
                  {version ? <span className="ml-2 text-caption text-muted-foreground">{version}</span> : null}
                </span>
                <span className="text-caption font-medium text-muted-foreground">
                  {result ? RESULT_COPY[result.status] : readinessCopy(candidate)}
                </span>
              </div>
              {reason ? <p className="text-caption text-muted-foreground">{reason}</p> : null}
              {result?.status === 'failed' ? (
                <p className="text-caption text-destructive">Try again if this platform becomes available.</p>
              ) : null}
            </li>
          );
        })}
      </ul>

      {requestFailed ? (
        <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/8 p-3 text-body">
          Pairing status is temporarily unavailable. Try again.
        </p>
      ) : null}

      <div className="flex flex-wrap justify-end gap-2">
        {!TERMINAL_STATES.has(displayState) && displayState !== 'idle' ? (
          <Button type="button" variant="outline" disabled={actionBusy} onClick={() => void cancel()}>
            Cancel pairing
          </Button>
        ) : null}
        {canRetry ? (
          <Button type="button" disabled={actionBusy} onClick={() => void retry()}>
            Retry failed platforms
          </Button>
        ) : null}
        <Button type="button" variant="outline" disabled={actionBusy} onClick={() => void regenerate()}>
          Generate a new QR code
        </Button>
      </div>
    </section>
  );
}
