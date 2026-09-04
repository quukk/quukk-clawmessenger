import { Button } from '@multica/ui/components/ui/button';
import { useCallback, useEffect, useState } from 'react';

import { useI18n } from '../i18n';
import type { BridgeApi, DiagnosticsSnapshot } from '../types';
import { useRequestFence } from '../use-request-fence';

export function DiagnosticsPage({ api }: { api: BridgeApi }) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot | null>(null);
  const [error, setError] = useState(false);
  const requestFence = useRequestFence();

  const load = useCallback(async () => {
    const generation = requestFence.begin();
    setError(false);
    try {
      const nextSnapshot = await api.getDiagnostics();
      if (requestFence.isCurrent(generation)) setSnapshot(nextSnapshot);
    } catch {
      if (requestFence.isCurrent(generation)) setError(true);
    }
  }, [api, requestFence]);

  useEffect(() => {
    void load();
    return () => {
      requestFence.begin();
    };
  }, [load, requestFence]);

  return (
    <section className="grid gap-6" aria-labelledby="diagnostics-title">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="grid max-w-2xl gap-2">
          <h1 id="diagnostics-title" className="font-heading text-display-sm font-semibold tracking-tight">
            {t('diagnostics.title')}
          </h1>
          <p className="text-body-lg text-muted-foreground">
            {t('diagnostics.description')}
          </p>
        </div>
        <Button variant="outline" onClick={() => void load()}>
          {t('diagnostics.refresh')}
        </Button>
      </header>

      {error ? (
        <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/8 p-3 text-destructive">
          {t('diagnostics.loadError')}
        </p>
      ) : snapshot === null ? (
        <div className="skeleton-block" aria-label={t('diagnostics.loading')} />
      ) : (
        <pre className="diagnostics-output">{JSON.stringify(snapshot, null, 2)}</pre>
      )}
    </section>
  );
}
