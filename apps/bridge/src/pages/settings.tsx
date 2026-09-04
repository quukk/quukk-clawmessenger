import { Button } from '@multica/ui/components/ui/button';
import { useEffect, useState } from 'react';

import { useI18n } from '../i18n';
import type { BridgeApi, BridgeSettings, Provider } from '../types';
import { useRequestFence } from '../use-request-fence';

const PROVIDER_LABELS: Record<Provider, string> = {
  opencode: 'OpenCode',
  openclaw: 'OpenClaw',
  codex: 'Codex',
  hermes: 'Hermes',
};

type SettingsPageProps = {
  api: BridgeApi;
  settings: BridgeSettings;
  onSettingsChange(settings: BridgeSettings): void;
};

export function SettingsPage({ api, settings, onSettingsChange }: SettingsPageProps) {
  const { t } = useI18n();
  const [serverUrl, setServerUrl] = useState(settings.serverUrl);
  const [defaultWorkdir, setDefaultWorkdir] = useState(settings.defaultWorkdir ?? '');
  const [authorizedRoots, setAuthorizedRoots] = useState(settings.authorizedWorkRoots.join('\n'));
  const [pathOverrides, setPathOverrides] = useState(settings.providerPathOverrides);
  const [logLevel, setLogLevel] = useState(settings.logLevel);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const requestFence = useRequestFence();

  useEffect(() => {
    setServerUrl(settings.serverUrl);
    setDefaultWorkdir(settings.defaultWorkdir ?? '');
    setAuthorizedRoots(settings.authorizedWorkRoots.join('\n'));
    setPathOverrides(settings.providerPathOverrides);
    setLogLevel(settings.logLevel);
  }, [settings]);

  async function save() {
    const generation = requestFence.begin();
    setSaveState('saving');
    const next: BridgeSettings = {
      serverUrl: serverUrl.trim(),
      defaultWorkdir: defaultWorkdir.trim() || null,
      authorizedWorkRoots: authorizedRoots
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean),
      providerPathOverrides: Object.fromEntries(
        Object.entries(pathOverrides).filter((entry) => entry[1]?.trim()),
      ),
      logLevel,
    };
    try {
      const saved = await api.updateSettings(next);
      if (!requestFence.isCurrent(generation)) return;
      onSettingsChange(saved);
      setSaveState('saved');
    } catch {
      if (requestFence.isCurrent(generation)) setSaveState('failed');
    }
  }

  return (
    <section className="grid gap-6" aria-labelledby="settings-title">
      <header className="grid max-w-2xl gap-2">
        <h1 id="settings-title" className="font-heading text-display-sm font-semibold tracking-tight">
          {t('settings.title')}
        </h1>
        <p className="text-body-lg text-muted-foreground">
          {t('settings.description')}
        </p>
        <p className="text-caption text-muted-foreground">
          {t('settings.precedence')}
        </p>
      </header>

      <div className="grid gap-5 rounded-xl border border-surface-border bg-surface p-4 sm:p-5">
        <div className="settings-grid">
          <label className="field-group" htmlFor="settings-server-url">
            <span>{t('settings.serverUrl')}</span>
            <input
              id="settings-server-url"
              value={serverUrl}
              onChange={(event) => setServerUrl(event.target.value)}
              autoComplete="url"
            />
            <small>{t('settings.serverUrlHelp')}</small>
          </label>
          <label className="field-group" htmlFor="settings-log-level">
            <span>{t('settings.logLevel')}</span>
            <select
              id="settings-log-level"
              value={logLevel}
              onChange={(event) => setLogLevel(event.target.value as BridgeSettings['logLevel'])}
            >
              <option value="silent">{t('settings.log.silent')}</option>
              <option value="error">{t('settings.log.error')}</option>
              <option value="warn">{t('settings.log.warn')}</option>
              <option value="info">{t('settings.log.info')}</option>
              <option value="debug">{t('settings.log.debug')}</option>
            </select>
            <small>{t('settings.logHelp')}</small>
          </label>
        </div>

        <label className="field-group" htmlFor="settings-authorized-roots">
          <span>{t('settings.authorizedRoots')}</span>
          <textarea
            id="settings-authorized-roots"
            rows={3}
            value={authorizedRoots}
            onChange={(event) => setAuthorizedRoots(event.target.value)}
            placeholder={t('settings.authorizedRootsPlaceholder')}
          />
          <small>{t('settings.authorizedRootsHelp')}</small>
        </label>

        <label className="field-group" htmlFor="settings-default-workdir">
          <span>{t('settings.defaultWorkdir')}</span>
          <input
            id="settings-default-workdir"
            value={defaultWorkdir}
            onChange={(event) => setDefaultWorkdir(event.target.value)}
            placeholder={t('settings.defaultWorkdirPlaceholder')}
            autoComplete="off"
          />
          <small>{t('settings.defaultWorkdirHelp')}</small>
        </label>

        <fieldset className="grid gap-3">
          <legend className="font-medium">{t('settings.overrides')}</legend>
          <div className="settings-grid">
            {(Object.keys(PROVIDER_LABELS) as Provider[]).map((provider) => (
              <label className="field-group" htmlFor={`override-${provider}`} key={provider}>
                <span>{PROVIDER_LABELS[provider]}</span>
                <input
                  id={`override-${provider}`}
                  value={pathOverrides[provider] ?? ''}
                  onChange={(event) =>
                    setPathOverrides((current) => ({
                      ...current,
                      [provider]: event.target.value,
                    }))
                  }
                  placeholder={t('settings.overridePlaceholder')}
                  autoComplete="off"
                />
              </label>
            ))}
          </div>
        </fieldset>

        {saveState === 'saved' ? (
          <p role="status" className="text-body font-medium text-success">
            {t('settings.saved')}
          </p>
        ) : saveState === 'failed' ? (
          <p role="alert" className="text-body font-medium text-destructive">
            {t('settings.saveError')}
          </p>
        ) : null}

        <div className="flex justify-end">
          <Button disabled={saveState === 'saving'} onClick={() => void save()}>
            {saveState === 'saving' ? t('settings.saving') : t('settings.save')}
          </Button>
        </div>
      </div>
    </section>
  );
}
