import { Button } from '@multica/ui/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from '@multica/ui/components/ui/card';
import { Checkbox } from '@multica/ui/components/ui/checkbox';

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

function guidance(runtime: BridgeRuntime): string {
  const label = runtimeDisplayLabel(runtime);
  switch (runtime.status) {
    case 'ready':
      return runtime.binding?.enabled
        ? 'This agent has its own RongCloud identity.'
        : 'Ready to register an independent RongCloud identity.';
    case 'needs_auth':
      return `Sign in to ${label}, then rescan.`;
    case 'found_not_runnable':
      return 'The executable was found but could not run. Check its permissions and path.';
    case 'not_found':
      return 'Not found on this device. Install it or set an explicit path in Settings.';
    case 'probe_failed':
      return 'Detection failed. Rescan or set an explicit path in Settings.';
    default:
      return 'The runtime state is unavailable.';
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
              aria-label={`Select ${label}`}
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
            progress={progress}
          />
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p className="text-body text-muted-foreground">{guidance(runtime)}</p>
        {runtime.version || runtime.path ? (
          <dl className="grid gap-1 text-caption text-muted-foreground">
            {runtime.version ? (
              <div className="flex gap-2">
                <dt className="min-w-14 font-medium text-foreground">Version</dt>
                <dd className="truncate">{runtime.version}</dd>
              </div>
            ) : null}
            {runtime.path ? (
              <div className="flex min-w-0 gap-2">
                <dt className="min-w-14 font-medium text-foreground">Path</dt>
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
                aria-label={`Disable ${label}`}
                onClick={onDisable}
              >
                Disable
              </Button>
            ) : null}
            {onReregister && runtime.binding ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                aria-label={`Reregister ${label}`}
                onClick={onReregister}
              >
                Reregister
              </Button>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
