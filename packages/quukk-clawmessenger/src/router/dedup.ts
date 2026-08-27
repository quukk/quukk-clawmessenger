import { z } from 'zod';

export const DEDUP_TTL_MS = 24 * 60 * 60 * 1_000;
export const MAX_DEDUP_PER_RUNTIME = 2_048;
export const MAX_DEDUP_ENTRIES = 8_192;

const controlCharacters = /[\p{Cc}\p{Cf}]/u;
const identifier = (maximum: number) => z.string()
  .min(1)
  .max(maximum)
  .refine((value) => value === value.trim() && !controlCharacters.test(value));

export const DedupEntrySchema = z.strictObject({
  key: identifier(8_192),
  runtimeId: z.string().regex(/^rt_[0-9a-f]{32}$/),
  messageUid: identifier(256),
  claimId: z.string().regex(/^[0-9a-f]{32}$/),
  state: z.enum(['claimed', 'admitted']),
  claimedAt: z.number().int().nonnegative().safe(),
  admittedAt: z.number().int().nonnegative().safe().optional(),
});

export type DedupState = 'claimed' | 'admitted';
export type DedupEntry = z.infer<typeof DedupEntrySchema>;

export type ClaimResult =
  | { status: 'claimed'; key: string; claimId: string }
  | { status: 'duplicate'; key: string };

export type DedupClaimTransition =
  | { status: 'claimed'; key: string; claimId: string; entries: DedupEntry[] }
  | { status: 'duplicate'; key: string; entries: DedupEntry[] }
  | { status: 'capacity'; key: string; entries: DedupEntry[] };

export interface DedupCasTransition {
  accepted: boolean;
  changed: boolean;
  entries: DedupEntry[];
}

export function dedupKey(runtimeId: string, messageUid: string): string {
  return JSON.stringify([runtimeId, messageUid]);
}

function stateTime(entry: DedupEntry): number {
  return entry.state === 'admitted' ? entry.admittedAt! : entry.claimedAt;
}

export function pruneDedup(entries: readonly DedupEntry[], now: number): DedupEntry[] {
  return entries
    .filter((entry) => stateTime(entry) + DEDUP_TTL_MS > now)
    .map((entry) => ({ ...entry }));
}

export function claimDedup(
  entries: readonly DedupEntry[],
  runtimeId: string,
  messageUid: string,
  claimId: string,
  now: number,
): DedupClaimTransition {
  const parsed = DedupEntrySchema.safeParse({
    key: dedupKey(runtimeId, messageUid),
    runtimeId,
    messageUid,
    claimId,
    state: 'claimed',
    claimedAt: now,
  });
  if (!parsed.success) throw new TypeError('invalid dedup claim');
  const current = pruneDedup(entries, now);
  if (current.some((entry) => entry.key === parsed.data.key)) {
    return { status: 'duplicate', key: parsed.data.key, entries: current };
  }
  const runtimeCount = current.filter((entry) => entry.runtimeId === runtimeId).length;
  if (runtimeCount >= MAX_DEDUP_PER_RUNTIME || current.length >= MAX_DEDUP_ENTRIES) {
    return { status: 'capacity', key: parsed.data.key, entries: current };
  }
  current.push(parsed.data);
  return {
    status: 'claimed',
    key: parsed.data.key,
    claimId,
    entries: current,
  };
}

export function admitDedup(
  entries: readonly DedupEntry[],
  key: string,
  claimId: string,
  now: number,
): DedupCasTransition {
  const current = entries.map((entry) => ({ ...entry }));
  const entry = current.find((candidate) => candidate.key === key);
  if (!entry || entry.claimId !== claimId) return { accepted: false, changed: false, entries: current };
  if (entry.state === 'admitted') return { accepted: true, changed: false, entries: current };
  entry.state = 'admitted';
  entry.admittedAt = now;
  return { accepted: true, changed: true, entries: current };
}

export function releaseDedup(
  entries: readonly DedupEntry[],
  key: string,
  claimId: string,
): DedupCasTransition {
  const current = entries.map((entry) => ({ ...entry }));
  const index = current.findIndex((entry) => entry.key === key && entry.claimId === claimId);
  if (index < 0 || current[index]?.state !== 'claimed') {
    return { accepted: false, changed: false, entries: current };
  }
  current.splice(index, 1);
  return { accepted: true, changed: true, entries: current };
}
