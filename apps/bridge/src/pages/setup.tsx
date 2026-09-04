import { Button } from '@multica/ui/components/ui/button';
import { Checkbox } from '@multica/ui/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@multica/ui/components/ui/dialog';
import { useEffect, useRef, useState } from 'react';

import { BridgeApiError } from '../api';
import { PairingPanel } from '../components/pairing-panel';
import { RuntimeCard } from '../components/runtime-card';
import { useI18n, type TranslationKey } from '../i18n';
import type { BridgeApi, BridgeRuntime, BridgeSettings, PairingSnapshot } from '../types';
import { useRequestFence } from '../use-request-fence';

type SetupPageProps = {
  api: BridgeApi;
  runtimes: readonly BridgeRuntime[];
  settings: BridgeSettings;
  onRuntimesChange(runtimes: readonly BridgeRuntime[]): void;
  onSettingsChange(settings: BridgeSettings): void;
};

function replaceFirstAuthorizedRoot(roots: readonly string[], replacement: string): string[] {
  return [replacement, ...roots.slice(1)].filter(
    (root, index, allRoots) => allRoots.indexOf(root) === index,
  );
}

function discoveryView(runtime: BridgeRuntime): BridgeRuntime {
  return {
    provider: runtime.provider,
    status: runtime.status,
    capabilities: runtime.capabilities,
    ...(runtime.version === undefined ? {} : { version: runtime.version }),
    ...(runtime.binding === undefined ? {} : { binding: runtime.binding }),
    ...(runtime.worker === undefined ? {} : { worker: runtime.worker }),
  };
}

export function SetupPage({
  api,
  runtimes,
  settings,
  onSettingsChange,
}: SetupPageProps) {
  const { t } = useI18n();
  const [authorizedRoot, setAuthorizedRoot] = useState(settings.authorizedWorkRoots[0] ?? '');
  const [defaultWorkdir, setDefaultWorkdir] = useState(settings.defaultWorkdir ?? '');
  const [policyAccepted, setPolicyAccepted] = useState(false);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [pairing, setPairing] = useState<PairingSnapshot | null>(null);
  const [startFailure, setStartFailure] = useState<TranslationKey | null>(null);
  const pairingStartController = useRef<AbortController | undefined>(undefined);
  const requestFence = useRequestFence();
  const policyComplete =
    authorizedRoot.trim().length > 0 &&
    defaultWorkdir.trim().length > 0 &&
    policyAccepted;

  useEffect(
    () => () => {
      pairingStartController.current?.abort();
    },
    [],
  );

  async function generatePairing() {
    if (!policyComplete || savingPolicy || pairing !== null) return;
    const generation = requestFence.begin();
    pairingStartController.current?.abort();
    const controller = new AbortController();
    pairingStartController.current = controller;
    setSavingPolicy(true);
    setStartFailure(null);
    try {
      const nextSettings = await api.updateSettings({
        ...settings,
        authorizedWorkRoots: replaceFirstAuthorizedRoot(
          settings.authorizedWorkRoots,
          authorizedRoot.trim(),
        ),
        defaultWorkdir: defaultWorkdir.trim(),
      });
      if (!requestFence.isCurrent(generation)) return;
      onSettingsChange(nextSettings);
      const nextPairing = await api.startPairing(controller.signal);
      if (!requestFence.isCurrent(generation)) return;
      setPairing(nextPairing);
    } catch (error) {
      if (requestFence.isCurrent(generation)) {
        const code = error instanceof BridgeApiError ? error.code : '';
        const key: TranslationKey = [
          'session_required',
          'pairing_api_unavailable',
          'pairing_transport',
          'pairing_timeout',
          'pairing_unavailable',
          'pairing_unauthorized',
        ].includes(code)
          ? (`setup.error.${code}` as TranslationKey)
          : 'setup.error.default';
        setStartFailure(key);
      }
    } finally {
      if (pairingStartController.current === controller) {
        pairingStartController.current = undefined;
      }
      if (requestFence.isCurrent(generation)) setSavingPolicy(false);
    }
  }

  return (
    <section className="grid gap-6" aria-labelledby="setup-title">
      <header className="grid max-w-2xl gap-2">
        <p className="text-label font-medium text-brand">{t('setup.eyebrow')}</p>
        <h1 id="setup-title" className="font-heading text-display-sm font-semibold tracking-tight">
          {t('setup.title')}
        </h1>
        <p className="text-body-lg text-muted-foreground">
          {t('setup.description')}
        </p>
      </header>

      <div className="runtime-grid" aria-label={t('setup.detectedAria')}>
        {runtimes.map((runtime) => (
          <RuntimeCard key={runtime.provider} runtime={discoveryView(runtime)} />
        ))}
      </div>

      <div className="grid gap-4 rounded-xl border border-surface-border bg-surface p-4 sm:p-5">
        <div className="grid gap-1">
          <h2 className="font-heading text-title-sm font-medium">{t('setup.permissionTitle')}</h2>
          <p className="text-body text-muted-foreground">
            {t('setup.permissionDescription')}
          </p>
          <Button
            type="button"
            variant="link"
            className="h-auto w-fit px-0 py-1"
            onClick={() => setPolicyOpen(true)}
          >
            {t('setup.reviewPermission')}
          </Button>
        </div>

        <div className="settings-grid">
          <label className="field-group" htmlFor="setup-authorized-root">
            <span>{t('setup.authorizedRoot')}</span>
            <input
              id="setup-authorized-root"
              value={authorizedRoot}
              onChange={(event) => setAuthorizedRoot(event.target.value)}
              placeholder="C:\\work or /Users/me/work"
              autoComplete="off"
              disabled={savingPolicy || pairing !== null}
            />
            <small>{t('setup.authorizedRootHelp')}</small>
          </label>
          <label className="field-group" htmlFor="setup-default-workdir">
            <span>{t('setup.defaultWorkdir')}</span>
            <input
              id="setup-default-workdir"
              value={defaultWorkdir}
              onChange={(event) => setDefaultWorkdir(event.target.value)}
              placeholder="C:\\work\\project or /Users/me/work/project"
              autoComplete="off"
              disabled={savingPolicy || pairing !== null}
            />
            <small>{t('setup.defaultWorkdirHelp')}</small>
          </label>
        </div>

        <label className="flex cursor-pointer items-start gap-3 text-body">
          <Checkbox
            aria-label={t('setup.policyAria')}
            checked={policyAccepted}
            disabled={savingPolicy || pairing !== null}
            onCheckedChange={(checked) => setPolicyAccepted(checked === true)}
            className="mt-0.5"
          />
          <span>{t('setup.policyAccept')}</span>
        </label>

        {startFailure ? (
          <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/8 p-3 text-body">
            {t(startFailure)}
          </p>
        ) : null}

        {pairing === null ? (
          <div className="flex justify-end">
            <Button
              type="button"
              size="lg"
              disabled={!policyComplete || savingPolicy}
              onClick={() => void generatePairing()}
            >
              {savingPolicy ? t('setup.generating') : t('setup.generate')}
            </Button>
          </div>
        ) : null}
      </div>

      {pairing === null ? null : <PairingPanel api={api} initialSnapshot={pairing} />}

      <Dialog open={policyOpen} onOpenChange={setPolicyOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('setup.permissionDialogTitle')}</DialogTitle>
            <DialogDescription>
              {t('setup.permissionDialogDescription')}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2 text-body text-muted-foreground">
            <p>{t('setup.permissionRuleCommands')}</p>
            <p>{t('setup.permissionRuleRoots')}</p>
            <p>{t('setup.permissionRuleProviders')}</p>
          </div>
          <DialogFooter>
            <Button type="button" onClick={() => setPolicyOpen(false)}>
              {t('setup.understood')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
