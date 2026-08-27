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
import { useEffect, useMemo, useRef, useState } from 'react';

import { RuntimeCard, runtimeDisplayLabel } from '../components/runtime-card';
import type {
  BridgeApi,
  BridgeRuntime,
  BridgeSettings,
  RegistrationProgress,
} from '../types';
import { useRequestFence } from '../use-request-fence';

type SetupPageProps = {
  api: BridgeApi;
  runtimes: readonly BridgeRuntime[];
  settings: BridgeSettings;
  onRuntimesChange(runtimes: readonly BridgeRuntime[]): void;
  onSettingsChange(settings: BridgeSettings): void;
};

function registrationErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return 'request_failed';
}

function replaceFirstAuthorizedRoot(roots: readonly string[], replacement: string): string[] {
  return [replacement, ...roots.slice(1)].filter(
    (root, index, allRoots) => allRoots.indexOf(root) === index,
  );
}

export function SetupPage({
  api,
  runtimes,
  settings,
  onRuntimesChange,
  onSettingsChange,
}: SetupPageProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<Record<string, RegistrationProgress>>({});
  const [authorizedRoot, setAuthorizedRoot] = useState(settings.authorizedWorkRoots[0] ?? '');
  const [defaultWorkdir, setDefaultWorkdir] = useState(settings.defaultWorkdir ?? '');
  const [policyAccepted, setPolicyAccepted] = useState(false);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  const initializedSelection = useRef(false);
  const requestFence = useRequestFence();

  useEffect(() => {
    if (initializedSelection.current || runtimes.length === 0) return;
    initializedSelection.current = true;
    setSelectedIds(
      new Set(
        runtimes
          .filter((runtime) => runtime.status === 'ready' && runtime.id !== undefined)
          .map((runtime) => runtime.id!),
      ),
    );
  }, [runtimes]);

  const readyIds = useMemo(
    () =>
      runtimes
        .filter((runtime) => runtime.status === 'ready' && runtime.id !== undefined)
        .map((runtime) => runtime.id!),
    [runtimes],
  );
  const allReadySelected = readyIds.length > 0 && readyIds.every((id) => selectedIds.has(id));
  const someReadySelected = readyIds.some((id) => selectedIds.has(id));
  const selectedCount = selectedIds.size;
  const registering = Object.values(progress).some((entry) => entry.state === 'registering');
  const failedRuntimes = runtimes.filter(
    (runtime) => runtime.id && progress[runtime.id]?.state === 'failed',
  );
  const connectedCount = Object.values(progress).filter(
    (entry) => entry.state === 'connected',
  ).length;
  const policyComplete =
    authorizedRoot.trim().length > 0 && defaultWorkdir.trim().length > 0 && policyAccepted;

  function toggleRuntime(runtimeId: string, selected: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (selected) next.add(runtimeId);
      else next.delete(runtimeId);
      return next;
    });
  }

  function toggleAll(selected: boolean) {
    setSelectedIds(selected ? new Set(readyIds) : new Set());
  }

  async function registerSelected() {
    const ids = [...selectedIds];
    if (ids.length === 0 || !policyComplete || registering) return;
    const generation = requestFence.begin();
    const isCurrent = () => requestFence.isCurrent(generation);
    setRefreshError(false);
    setSavingPolicy(true);
    try {
      const nextSettings = await api.updateSettings({
        ...settings,
        authorizedWorkRoots: replaceFirstAuthorizedRoot(
          settings.authorizedWorkRoots,
          authorizedRoot.trim(),
        ),
        defaultWorkdir: defaultWorkdir.trim(),
      });
      if (!isCurrent()) return;
      onSettingsChange(nextSettings);
    } catch {
      if (!isCurrent()) return;
      setProgress(
        Object.fromEntries(
          ids.map((id) => [id, { state: 'failed', errorCode: 'settings_update_failed' }]),
        ),
      );
      setSavingPolicy(false);
      return;
    }
    if (!isCurrent()) return;
    setSavingPolicy(false);
    setProgress((current) => ({
      ...current,
      ...Object.fromEntries(ids.map((id) => [id, { state: 'registering' as const }])),
    }));

    let refreshTail = Promise.resolve();
    const queueRefresh = () => {
      refreshTail = refreshTail.then(async () => {
        if (!isCurrent()) return;
        try {
          const nextRuntimes = await api.getRuntimes();
          if (isCurrent()) onRuntimesChange(nextRuntimes);
        } catch {
          if (isCurrent()) setRefreshError(true);
        }
      });
      return refreshTail;
    };

    await Promise.all(
      ids.map(async (runtimeId) => {
        try {
          const results = await api.enableBindings([runtimeId]);
          if (!isCurrent()) return;
          const result = results.find((entry) => entry.runtimeId === runtimeId);
          setProgress((current) => ({
            ...current,
            [runtimeId]: result?.ok
              ? { state: 'connected' }
              : {
                  state: 'failed',
                  errorCode: result?.errorCode ?? 'invalid_response',
                },
          }));
        } catch (error) {
          if (!isCurrent()) return;
          setProgress((current) => ({
            ...current,
            [runtimeId]: { state: 'failed', errorCode: registrationErrorCode(error) },
          }));
        }
        await queueRefresh();
      }),
    );
  }

  return (
    <section className="grid gap-6" aria-labelledby="setup-title">
      <header className="grid max-w-2xl gap-2">
        <p className="text-label font-medium text-brand">Detect, select, register</p>
        <h1 id="setup-title" className="font-heading text-display-sm font-semibold tracking-tight">
          Choose local agents
        </h1>
        <p className="text-body-lg text-muted-foreground">
          Each selected agent receives an independent RongCloud identity and connection.
        </p>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-surface-border bg-surface px-4 py-3">
        <label className="flex cursor-pointer items-center gap-2 font-medium">
          <Checkbox
            aria-label="Select all ready agents"
            checked={allReadySelected}
            indeterminate={someReadySelected && !allReadySelected}
            disabled={readyIds.length === 0 || registering}
            onCheckedChange={(checked) => toggleAll(checked === true)}
          />
          Select all ready agents
        </label>
        <span className="text-caption text-muted-foreground">{selectedCount} selected</span>
      </div>

      <div className="runtime-grid">
        {runtimes.map((runtime) => (
          <RuntimeCard
            key={runtime.provider}
            runtime={runtime}
            selectable
            selected={runtime.id ? selectedIds.has(runtime.id) : false}
            progress={runtime.id ? progress[runtime.id] : undefined}
            busy={registering}
            onSelectedChange={(selected) => {
              if (runtime.id) toggleRuntime(runtime.id, selected);
            }}
          />
        ))}
      </div>

      <div className="grid gap-4 rounded-xl border border-surface-border bg-surface p-4 sm:p-5">
        <div className="grid gap-1">
          <h2 className="font-heading text-title-sm font-medium">Headless permission mode</h2>
          <p className="text-body text-muted-foreground">
            Interactive approval is not available. Remote tasks can only use directories you
            explicitly authorize here.
          </p>
          <Button
            type="button"
            variant="link"
            className="h-auto w-fit px-0 py-1"
            onClick={() => setPolicyOpen(true)}
          >
            Review permission details
          </Button>
        </div>

        <div className="settings-grid">
          <label className="field-group" htmlFor="setup-authorized-root">
            <span>Authorized work root</span>
            <input
              id="setup-authorized-root"
              value={authorizedRoot}
              onChange={(event) => setAuthorizedRoot(event.target.value)}
              placeholder="C:\\work or /Users/me/work"
              autoComplete="off"
              disabled={registering || savingPolicy}
            />
            <small>Remote tasks are rejected outside this directory.</small>
          </label>
          <label className="field-group" htmlFor="setup-default-workdir">
            <span>Default work directory</span>
            <input
              id="setup-default-workdir"
              value={defaultWorkdir}
              onChange={(event) => setDefaultWorkdir(event.target.value)}
              placeholder="C:\\work\\project or /Users/me/work/project"
              autoComplete="off"
              disabled={registering || savingPolicy}
            />
            <small>Choose a real project directory inside the authorized root.</small>
          </label>
        </div>

        <label className="flex cursor-pointer items-start gap-3 text-body">
          <Checkbox
            aria-label="I understand the permission policy"
            checked={policyAccepted}
            disabled={registering || savingPolicy}
            onCheckedChange={(checked) => setPolicyAccepted(checked === true)}
            className="mt-0.5"
          />
          <span>I understand the permission policy and authorize the directory above.</span>
        </label>

        {failedRuntimes.length > 0 ? (
          <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/8 p-3">
            <p className="font-medium text-destructive">Some agents could not be registered.</p>
            <ul className="mt-1 grid gap-1 text-body text-muted-foreground">
              {failedRuntimes.map((runtime) => (
                <li key={runtime.provider}>
                  {runtimeDisplayLabel(runtime)}: {progress[runtime.id!]?.errorCode}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {refreshError ? (
          <p role="alert" className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-body">
            Registration finished, but the latest runtime status could not be refreshed. Your
            completed registrations were not changed; use Rescan on the Runtimes page.
          </p>
        ) : null}

        {connectedCount > 0 && policyComplete ? (
          <p role="status" aria-live="polite" className="text-body font-medium text-success">
            {connectedCount} {connectedCount === 1 ? 'agent is' : 'agents are'} connected and
            task-ready.
          </p>
        ) : (
          <p role="status" aria-live="polite" className="sr-only">
            {registering ? 'Registration is in progress.' : 'Ready for your confirmation.'}
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            size="lg"
            disabled={selectedCount === 0 || !policyComplete || registering || savingPolicy}
            onClick={() => void registerSelected()}
          >
            {registering || savingPolicy
              ? 'Registering agents'
              : `Register ${selectedCount} ${selectedCount === 1 ? 'agent' : 'agents'}`}
          </Button>
        </div>
      </div>

      <Dialog open={policyOpen} onOpenChange={setPolicyOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Permission policy</DialogTitle>
            <DialogDescription>
              Quukk ClawMessenger invokes each provider in its existing headless mode. Card
              actions cannot pause a running task for interactive approval.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2 text-body text-muted-foreground">
            <p>Only allowlisted commands and message actions are routed.</p>
            <p>Every task directory must resolve inside an authorized work root.</p>
            <p>Review each provider login and local permission configuration before enabling it.</p>
          </div>
          <DialogFooter>
            <Button type="button" onClick={() => setPolicyOpen(false)}>
              Understood
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
