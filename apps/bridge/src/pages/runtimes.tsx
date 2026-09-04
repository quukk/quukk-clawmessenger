import { Button } from '@multica/ui/components/ui/button';
import { useEffect, useState } from 'react';

import { RuntimeCard } from '../components/runtime-card';
import { useI18n } from '../i18n';
import type { BridgeApi, BridgeRuntime } from '../types';
import { useRequestFence } from '../use-request-fence';

type RuntimesPageProps = {
  api: BridgeApi;
  runtimes: readonly BridgeRuntime[];
  onRuntimesChange(runtimes: readonly BridgeRuntime[]): void;
};

const AUTOMATIC_REFRESH_INTERVAL_MS = 250;
const AUTOMATIC_REFRESH_ATTEMPTS = 20;

function hasPendingWorker(runtimes: readonly BridgeRuntime[]): boolean {
  return runtimes.some((runtime) => {
    if (!runtime.binding?.enabled) return false;
    if (runtime.worker !== undefined) return runtime.worker.state !== 'online';
    return runtime.binding.registrationState === 'registering';
  });
}

async function waitForAutomaticRefresh(): Promise<void> {
  await new Promise<void>((resolve) => window.setTimeout(resolve, AUTOMATIC_REFRESH_INTERVAL_MS));
}

export function RuntimesPage({ api, runtimes, onRuntimesChange }: RuntimesPageProps) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestFence = useRequestFence();

  useEffect(() => {
    const generation = requestFence.begin();

    void (async () => {
      for (let attempt = 0; attempt < AUTOMATIC_REFRESH_ATTEMPTS; attempt += 1) {
        if (attempt > 0) await waitForAutomaticRefresh();
        if (!requestFence.isCurrent(generation)) return;
        try {
          const nextRuntimes = await api.getRuntimes();
          if (!requestFence.isCurrent(generation)) return;
          onRuntimesChange(nextRuntimes);
          setError(null);
          if (!hasPendingWorker(nextRuntimes)) return;
        } catch {
          if (
            attempt === AUTOMATIC_REFRESH_ATTEMPTS - 1 &&
            requestFence.isCurrent(generation)
          ) {
            setError(t('runtimes.refreshError'));
          }
        }
      }
    })();
  }, [api, onRuntimesChange, requestFence, t]);

  async function refresh() {
    const generation = requestFence.begin();
    setBusy('rescan');
    setError(null);
    try {
      const nextRuntimes = await api.rescanRuntimes();
      if (requestFence.isCurrent(generation)) onRuntimesChange(nextRuntimes);
    } catch {
      if (requestFence.isCurrent(generation)) setError(t('runtimes.rescanError'));
    } finally {
      if (requestFence.isCurrent(generation)) setBusy(null);
    }
  }

  async function mutate(runtimeId: string, operation: 'disable' | 'reregister') {
    const generation = requestFence.begin();
    setBusy(runtimeId);
    setError(null);
    try {
      if (operation === 'disable') await api.disableBinding(runtimeId);
      else if (!(await api.reregisterBinding(runtimeId)).ok) throw new Error('reregister_failed');
      if (!requestFence.isCurrent(generation)) return;
      const nextRuntimes = await api.getRuntimes();
      if (requestFence.isCurrent(generation)) onRuntimesChange(nextRuntimes);
    } catch {
      if (requestFence.isCurrent(generation)) {
        setError(t(operation === 'disable' ? 'runtimes.disableError' : 'runtimes.reregisterError'));
      }
    } finally {
      if (requestFence.isCurrent(generation)) setBusy(null);
    }
  }

  return (
    <section className="grid gap-6" aria-labelledby="runtimes-title">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="grid max-w-2xl gap-2">
          <h1 id="runtimes-title" className="font-heading text-display-sm font-semibold tracking-tight">
            {t('runtimes.title')}
          </h1>
          <p className="text-body-lg text-muted-foreground">
            {t('runtimes.description')}
          </p>
        </div>
        <Button variant="outline" disabled={busy !== null} onClick={() => void refresh()}>
          {busy === 'rescan' ? t('runtimes.rescanning') : t('runtimes.rescan')}
        </Button>
      </header>

      {error ? (
        <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/8 p-3 text-destructive">
          {error}
        </p>
      ) : null}

      <div className="runtime-grid">
        {runtimes.map((runtime) => (
          <RuntimeCard
            key={runtime.provider}
            runtime={runtime}
            busy={busy !== null}
            onDisable={
              runtime.id ? () => void mutate(runtime.id!, 'disable') : undefined
            }
            onReregister={
              runtime.id ? () => void mutate(runtime.id!, 'reregister') : undefined
            }
          />
        ))}
      </div>
    </section>
  );
}
