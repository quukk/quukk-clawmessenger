import { Badge } from '@multica/ui/components/ui/badge';

import { useI18n } from '../i18n';
import type {
  RegistrationProgress,
  RegistrationState,
  RuntimeStatus,
  WorkerState,
} from '../types';

type StatusPillProps = {
  runtimeStatus: RuntimeStatus;
  registrationState?: RegistrationState;
  workerState?: WorkerState;
  progress?: RegistrationProgress;
};

function labelForStatus({
  runtimeStatus,
  registrationState,
  workerState,
  progress,
}: StatusPillProps, t: ReturnType<typeof useI18n>['t']): string {
  if (progress?.state === 'registering') return t('status.registering');
  if (progress?.state === 'connected') return t('status.connected');
  if (progress?.state === 'failed') return t('status.registrationFailed');
  if (registrationState === 'error') return t('status.connectionError');
  if (registrationState === 'registering') return t('status.registering');
  if (workerState === 'online') return t('status.online');
  if (workerState !== undefined) return t('status.registeredOffline');
  if (registrationState === 'online') return t('status.online');
  if (registrationState === 'offline') return t('status.registeredOffline');

  switch (runtimeStatus) {
    case 'ready':
      return t('status.ready');
    case 'needs_auth':
      return t('status.needsSignIn');
    case 'found_not_runnable':
      return t('status.cannotRun');
    case 'not_found':
      return t('status.notFound');
    case 'probe_failed':
      return t('status.probeFailed');
    default:
      return t('status.unknown');
  }
}

export function StatusPill(props: StatusPillProps) {
  const { t } = useI18n();
  const failed =
    props.progress?.state === 'failed' ||
    props.registrationState === 'error' ||
    props.runtimeStatus === 'probe_failed' ||
    props.runtimeStatus === 'found_not_runnable';
  const positive =
    props.progress?.state === 'connected' ||
    props.workerState === 'online' ||
    (props.workerState === undefined && props.registrationState === 'online') ||
    (props.runtimeStatus === 'ready' && props.progress?.state !== 'registering');

  return (
    <Badge
      variant={failed ? 'destructive' : positive ? 'default' : 'outline'}
      aria-label={t('status.aria', { status: labelForStatus(props, t) })}
    >
      {labelForStatus(props, t)}
    </Badge>
  );
}
