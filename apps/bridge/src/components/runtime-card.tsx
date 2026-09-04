import { Button } from '@multica/ui/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from '@multica/ui/components/ui/card';
import { Checkbox } from '@multica/ui/components/ui/checkbox';

import { useI18n } from '../i18n';
import type { BridgeRuntime, Provider, RegistrationProgress } from '../types';
import { StatusPill } from './status-pill';

const PROVIDER_LABELS: Record<Provider, string> = {
  opencode: 'OpenCode',
  openclaw: 'OpenClaw',
  codex: 'Codex',
  hermes: 'Hermes',
};

export function runtimeDisplayLabel(runtime: Pick<BridgeRuntime, 'provider'>): string {
  return PROVIDER_LABELS[runtime.provider];
}

function guidance(runtime: BridgeRuntime, t: ReturnType<typeof useI18n>['t']): string {
  const label = runtimeDisplayLabel(runtime);
  switch (runtime.status) {
    case 'ready':
      return runtime.binding?.enabled
        ? t('runtime.readyRegistered')
        : t('runtime.ready');
    case 'needs_auth':
      return t('runtime.needsAuth', { provider: label });
    case 'found_not_runnable':
      return t('runtime.notRunnable');
    case 'not_found':
      return runtime.provider === 'codex' ? t('runtime.codexNotFound') : t('runtime.notFound');
    case 'probe_failed':
      return t('runtime.probeFailed');
    default:
      return t('runtime.unknown');
  }
}

type RuntimeCardProps = {
  runtime: BridgeRuntime;
  selectable?: boolean;
  selected?: boolean;
  progress?: RegistrationProgress;
  onSelectedChange?(selected: boolean): void;
  onDisable?(): void;
  onReregister?(): void;
  busy?: boolean;
};

export function RuntimeCard({
  runtime,
  selectable = false,
  selected = false,
  progress,
  onSelectedChange,
  onDisable,
  onReregister,
  busy = false,
}: RuntimeCardProps) {
  const { t } = useI18n();
  const label = runtimeDisplayLabel(runtime);
  const canSelect = runtime.status === 'ready' && runtime.id !== undefined;

  return (
    <Card
      size="sm"
      data-testid={`runtime-${runtime.provider}`}
      className={selected ? 'border-brand/50 bg-surface-selected' : undefined}
    >
      <CardHeader>
        <CardTitle className="flex min-w-0 items-center gap-2">
          {selectable ? (
            <Checkbox
              aria-label={t('runtime.select', { provider: label })}
              checked={selected}
              disabled={!canSelect || busy}
              onCheckedChange={(checked) => onSelectedChange?.(checked === true)}
            />
          ) : null}
          <span className="truncate">{label}</span>
        </CardTitle>
        <CardAction>
          <StatusPill
            runtimeStatus={runtime.status}
            registrationState={runtime.binding?.registrationState}
            workerState={runtime.worker?.state}
            progress={progress}
          />
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p className="text-body text-muted-foreground">{guidance(runtime, t)}</p>
        {runtime.version || runtime.path ? (
          <dl className="grid gap-1 text-caption text-muted-foreground">
            {runtime.version ? (
              <div className="flex gap-2">
                <dt className="min-w-14 font-medium text-foreground">{t('runtime.version')}</dt>
                <dd className="truncate">{runtime.version}</dd>
              </div>
            ) : null}
            {runtime.path ? (
              <div className="flex min-w-0 gap-2">
                <dt className="min-w-14 font-medium text-foreground">{t('runtime.path')}</dt>
                <dd className="truncate font-mono" title={runtime.path}>
                  {runtime.path}
                </dd>
              </div>
            ) : null}
          </dl>
        ) : null}
        {!selectable && runtime.id && (onDisable || onReregister) ? (
          <div className="flex flex-wrap gap-2 pt-1">
            {onDisable && runtime.binding?.enabled ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                aria-label={t('runtime.disableAria', { provider: label })}
                onClick={onDisable}
              >
                {t('runtime.disable')}
              </Button>
            ) : null}
            {onReregister && runtime.binding ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                aria-label={t('runtime.reregisterAria', { provider: label })}
                onClick={onReregister}
              >
                {t('runtime.reregister')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
