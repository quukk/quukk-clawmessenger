import { Button } from '@multica/ui/components/ui/button';
import { useCallback, useEffect, useState } from 'react';

import type { BridgeApi, DiagnosticsSnapshot } from '../types';
import { useRequestFence } from '../use-request-fence';

export function DiagnosticsPage({ api }: { api: BridgeApi }) {
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
            Diagnostics
          </h1>
          <p className="text-body-lg text-muted-foreground">
            This view is redacted by the local service before it reaches the browser.
          </p>
        </div>
        <Button variant="outline" onClick={() => void load()}>
          Refresh
        </Button>
      </header>

      {error ? (
        <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/8 p-3 text-destructive">
          Unable to load diagnostics.
        </p>
      ) : snapshot === null ? (
        <div className="skeleton-block" aria-label="Loading diagnostics" />
      ) : (
        <pre className="diagnostics-output">{JSON.stringify(snapshot, null, 2)}</pre>
      )}
    </section>
  );
}
