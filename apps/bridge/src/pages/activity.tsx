import { Card, CardContent } from '@multica/ui/components/ui/card';
import { useEffect, useMemo, useState } from 'react';

import { runtimeDisplayLabel } from '../components/runtime-card';
import type { ActivityEntry, BridgeApi, BridgeRuntime } from '../types';

export function ActivityPage({
  api,
  runtimes,
}: {
  api: BridgeApi;
  runtimes: readonly BridgeRuntime[];
}) {
  const [entries, setEntries] = useState<readonly ActivityEntry[] | null>(null);
  const [error, setError] = useState(false);
  const runtimeLabels = useMemo(
    () =>
      new Map(
        runtimes.flatMap((runtime) =>
          runtime.id ? ([[runtime.id, runtimeDisplayLabel(runtime)]] as const) : [],
        ),
      ),
    [runtimes],
  );

  useEffect(() => {
    let active = true;
    void api.getActivity().then(
      (next) => {
        if (active) setEntries(next);
      },
      () => {
        if (active) setError(true);
      },
    );
    return () => {
      active = false;
    };
  }, [api]);

  return (
    <section className="grid gap-6" aria-labelledby="activity-title">
      <header className="grid max-w-2xl gap-2">
        <h1 id="activity-title" className="font-heading text-display-sm font-semibold tracking-tight">
          Recent activity
        </h1>
        <p className="text-body-lg text-muted-foreground">
          Local, bounded summaries only. Prompts and credentials are never shown here.
        </p>
      </header>

      {error ? (
        <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/8 p-3 text-destructive">
          Unable to load activity.
        </p>
      ) : entries === null ? (
        <div className="skeleton-block" aria-label="Loading activity" />
      ) : entries.length === 0 ? (
        <div className="empty-state">
          <h2>No activity yet</h2>
          <p>Messages and task lifecycle summaries will appear after an agent is enabled.</p>
        </div>
      ) : (
        <div className="grid gap-3">
          {entries.map((entry) => (
            <Card key={entry.id} size="sm">
              <CardContent className="grid gap-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-foreground">{entry.summary}</span>
                  <time className="text-caption text-muted-foreground" dateTime={entry.time}>
                    {entry.time}
                  </time>
                </div>
                <span className="text-caption text-muted-foreground">{entry.kind}</span>
                <span className="text-caption font-medium text-foreground">
                  {entry.runtimeId
                    ? (runtimeLabels.get(entry.runtimeId) ?? 'Unknown runtime')
                    : 'Bridge'}
                </span>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}
