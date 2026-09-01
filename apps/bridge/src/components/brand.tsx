import { MulticaIcon } from '@multica/ui/components/common/multica-icon';

export function Brand() {
  return (
    <div className="flex min-w-0 items-center gap-3" aria-label="Multica Quukk ClawMessenger">
      <MulticaIcon bordered size="md" noSpin className="shrink-0 text-foreground" />
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="font-heading text-title-sm font-semibold text-foreground">Multica</span>
          <span className="text-caption text-muted-foreground">Quukk ClawMessenger</span>
        </div>
        <p className="text-caption text-muted-foreground">Local agent messaging bridge</p>
      </div>
    </div>
  );
}
