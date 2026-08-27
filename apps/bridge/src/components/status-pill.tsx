import { Badge } from '@multica/ui/components/ui/badge';

import type { RegistrationProgress, RegistrationState, RuntimeStatus } from '../types';

type StatusPillProps = {
  runtimeStatus: RuntimeStatus;
  registrationState?: RegistrationState;
  progress?: RegistrationProgress;
};

function labelForStatus({
  runtimeStatus,
  registrationState,
  progress,
}: StatusPillProps): string {
  if (progress?.state === 'registering') return 'Registering';
  if (progress?.state === 'connected') return 'Connected';
  if (progress?.state === 'failed') return 'Registration failed';
  if (registrationState === 'online') return 'Online';
  if (registrationState === 'offline') return 'Registered offline';
  if (registrationState === 'registering') return 'Registering';
  if (registrationState === 'error') return 'Connection error';

  switch (runtimeStatus) {
    case 'ready':
      return 'Ready';
    case 'needs_auth':
      return 'Needs sign-in';
    case 'found_not_runnable':
      return 'Cannot run';
    case 'not_found':
      return 'Not found';
    case 'probe_failed':
      return 'Probe failed';
    default:
      return 'Unknown';
  }
}

export function StatusPill(props: StatusPillProps) {
  const failed =
    props.progress?.state === 'failed' ||
    props.registrationState === 'error' ||
    props.runtimeStatus === 'probe_failed' ||
    props.runtimeStatus === 'found_not_runnable';
  const positive =
    props.progress?.state === 'connected' ||
    props.registrationState === 'online' ||
    (props.runtimeStatus === 'ready' && props.progress?.state !== 'registering');

  return (
    <Badge
      variant={failed ? 'destructive' : positive ? 'default' : 'outline'}
      aria-label={`Status: ${labelForStatus(props)}`}
    >
      {labelForStatus(props)}
    </Badge>
  );
}
