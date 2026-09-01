import { Button } from '@multica/ui/components/ui/button';
import { useEffect, useState } from 'react';

import { getBrowserBridgeApi } from './api';
import { Brand } from './components/brand';
import { ActivityPage } from './pages/activity';
import { DiagnosticsPage } from './pages/diagnostics';
import { RuntimesPage } from './pages/runtimes';
import { SettingsPage } from './pages/settings';
import { SetupPage } from './pages/setup';
import type { BridgeApi, BridgeRuntime, BridgeSettings } from './types';

type Page = 'setup' | 'runtimes' | 'activity' | 'diagnostics' | 'settings';

const NAVIGATION: readonly { page: Page; label: string }[] = [
  { page: 'setup', label: 'Setup' },
  { page: 'runtimes', label: 'Runtimes' },
  { page: 'activity', label: 'Activity' },
  { page: 'diagnostics', label: 'Diagnostics' },
  { page: 'settings', label: 'Settings' },
];

export function App({ api: suppliedApi }: { api?: BridgeApi }) {
  const api = suppliedApi ?? getBrowserBridgeApi();
  const [page, setPage] = useState<Page>('setup');
  const [runtimes, setRuntimes] = useState<readonly BridgeRuntime[] | null>(null);
  const [settings, setSettings] = useState<BridgeSettings | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const applyTheme = () => document.documentElement.classList.toggle('dark', query.matches);
    applyTheme();
    query.addEventListener('change', applyTheme);
    return () => query.removeEventListener('change', applyTheme);
  }, []);

  useEffect(() => {
    let active = true;
    void Promise.all([api.getRuntimes(), api.getSettings()]).then(
      ([nextRuntimes, nextSettings]) => {
        if (!active) return;
        setRuntimes(nextRuntimes);
        setSettings(nextSettings);
      },
      () => {
        if (active) setLoadError(true);
      },
    );
    return () => {
      active = false;
    };
  }, [api]);

  let content;
  if (loadError) {
    content = (
      <div role="alert" className="empty-state border-destructive/30">
        <h1>Unable to open the local bridge</h1>
        <p>Run quukk-clawmessenger setup again to create a fresh local session.</p>
      </div>
    );
  } else if (runtimes === null || settings === null) {
    content = (
      <div className="grid gap-4" aria-label="Loading local bridge">
        <div className="skeleton-line w-44" />
        <div className="skeleton-block" />
        <div className="skeleton-block" />
      </div>
    );
  } else {
    switch (page) {
      case 'setup':
        content = (
          <SetupPage
            api={api}
            runtimes={runtimes}
            settings={settings}
            onRuntimesChange={setRuntimes}
            onSettingsChange={setSettings}
          />
        );
        break;
      case 'runtimes':
        content = (
          <RuntimesPage api={api} runtimes={runtimes} onRuntimesChange={setRuntimes} />
        );
        break;
      case 'activity':
        content = <ActivityPage api={api} runtimes={runtimes} />;
        break;
      case 'diagnostics':
        content = <DiagnosticsPage api={api} />;
        break;
      case 'settings':
        content = (
          <SettingsPage api={api} settings={settings} onSettingsChange={setSettings} />
        );
        break;
      default:
        content = null;
    }
  }

  return (
    <div className="min-h-[100dvh] bg-app-shell text-foreground">
      <header className="border-b border-surface-border bg-surface/95">
        <div className="app-container flex min-h-18 flex-col gap-3 py-3 md:flex-row md:items-center md:justify-between">
          <Brand />
          <nav aria-label="Bridge pages" className="nav-strip">
            {NAVIGATION.map((item) => (
              <Button
                key={item.page}
                type="button"
                size="sm"
                variant={page === item.page ? 'brandSubtle' : 'ghost'}
                aria-current={page === item.page ? 'page' : undefined}
                onClick={() => setPage(item.page)}
              >
                {item.label}
              </Button>
            ))}
          </nav>
        </div>
      </header>

      <main className="app-container py-6 sm:py-8">{content}</main>

      <footer className="app-container flex flex-wrap items-center justify-between gap-2 border-t border-surface-border py-5 text-caption text-muted-foreground">
        <span>Multica interface and attribution retained.</span>
        <a
          className="font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          href="https://github.com/multica-ai/multica"
          target="_blank"
          rel="noreferrer"
        >
          Built on Multica
        </a>
      </footer>
    </div>
  );
}
