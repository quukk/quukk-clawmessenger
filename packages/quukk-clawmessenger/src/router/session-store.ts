import { isAbsolute } from 'node:path';

import { z } from 'zod';

import {
  atomicWriteJson,
  readJsonFileIfExists,
  type AtomicJsonDependencies,
} from '../config/atomic-json.js';
import {
  bindingKey,
  conversationKey,
  type ConversationIdentity,
} from './conversation.js';
import {
  DedupEntrySchema,
  MAX_DEDUP_ENTRIES,
  MAX_DEDUP_PER_RUNTIME,
  admitDedup,
  claimDedup,
  dedupKey,
  pruneDedup,
  releaseDedup,
  type ClaimResult,
  type DedupEntry,
} from './dedup.js';

const MAX_STATE_BYTES = 8 * 1024 * 1024;
const MAX_SESSIONS_PER_RUNTIME = 512;
const MAX_SESSIONS = 2_048;
const MAX_KNOWN_SESSIONS = 32;
const controlCharacters = /[\p{Cc}\p{Cf}]/u;

const identifier = (maximum = 4_096) => z.string()
  .min(1)
  .max(maximum)
  .refine((value) => value === value.trim() && !controlCharacters.test(value));
const runtimeId = z.string().regex(/^rt_[0-9a-f]{32}$/);
const timestamp = z.number().int().nonnegative().safe();

const knownSessionSchema = z.strictObject({
  sessionId: identifier(),
  updatedAt: timestamp,
});

const sessionSchema = z.strictObject({
  conversationKey: identifier(16_384),
  bindingKey: identifier(8_192),
  runtimeId,
  nodeId: identifier(137),
  conversationType: z.union([z.literal(1), z.literal(3), z.literal(4)]),
  targetId: identifier(256),
  senderId: identifier(256),
  currentSessionId: identifier().optional(),
  knownSessions: z.array(knownSessionSchema).max(MAX_KNOWN_SESSIONS),
  updatedAt: timestamp,
});

const routerStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sessions: z.array(sessionSchema).max(MAX_SESSIONS),
  dedup: z.array(DedupEntrySchema).max(MAX_DEDUP_ENTRIES),
});

type SessionEntry = z.infer<typeof sessionSchema>;
type RouterState = z.infer<typeof routerStateSchema>;

export type RouterStateErrorCode =
  | 'router_state_invalid'
  | 'session_conflict'
  | 'dedup_capacity';

export class RouterStateError extends Error {
  readonly code: RouterStateErrorCode;

  constructor(code: RouterStateErrorCode) {
    super(code);
    this.name = 'RouterStateError';
    this.code = code;
  }

  toJSON(): { code: RouterStateErrorCode } {
    return { code: this.code };
  }
}

export interface RouterStateStoreOptions {
  filePath: string;
  atomicDependencies?: AtomicJsonDependencies;
  now?: () => number;
}

function emptyState(): RouterState {
  return { schemaVersion: 1, sessions: [], dedup: [] };
}

function cloneState(state: RouterState): RouterState {
  return structuredClone(state);
}

function countByRuntime<T extends { runtimeId: string }>(entries: readonly T[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.runtimeId, (counts.get(entry.runtimeId) ?? 0) + 1);
  return counts;
}

function validIdentity(identity: ConversationIdentity): boolean {
  return runtimeId.safeParse(identity.runtimeId).success
    && identifier(137).safeParse(identity.nodeId).success
    && (identity.conversationType === 1
      || identity.conversationType === 3
      || identity.conversationType === 4)
    && identifier(256).safeParse(identity.targetId).success
    && identifier(256).safeParse(identity.senderId).success;
}

function validateState(value: unknown): RouterState {
  const parsed = routerStateSchema.safeParse(value);
  if (!parsed.success) throw new RouterStateError('router_state_invalid');
  const state = parsed.data;
  const sessionCounts = countByRuntime(state.sessions);
  const dedupCounts = countByRuntime(state.dedup);
  if ([...sessionCounts.values()].some((count) => count > MAX_SESSIONS_PER_RUNTIME)
    || [...dedupCounts.values()].some((count) => count > MAX_DEDUP_PER_RUNTIME)) {
    throw new RouterStateError('router_state_invalid');
  }

  const conversationKeys = new Set<string>();
  const sessionOwners = new Set<string>();
  for (const entry of state.sessions) {
    if (!validIdentity(entry)
      || entry.conversationKey !== conversationKey(entry)
      || entry.bindingKey !== bindingKey(entry)
      || conversationKeys.has(entry.conversationKey)) {
      throw new RouterStateError('router_state_invalid');
    }
    conversationKeys.add(entry.conversationKey);
    const known = new Set<string>();
    let previous = Number.NEGATIVE_INFINITY;
    for (const session of entry.knownSessions) {
      if (known.has(session.sessionId) || session.updatedAt < previous) {
        throw new RouterStateError('router_state_invalid');
      }
      known.add(session.sessionId);
      previous = session.updatedAt;
      const ownerKey = JSON.stringify([entry.runtimeId, session.sessionId]);
      if (sessionOwners.has(ownerKey)) throw new RouterStateError('router_state_invalid');
      sessionOwners.add(ownerKey);
    }
    if (entry.currentSessionId !== undefined && !known.has(entry.currentSessionId)) {
      throw new RouterStateError('router_state_invalid');
    }
  }

  const dedupKeys = new Set<string>();
  for (const entry of state.dedup) {
    if (entry.key !== dedupKey(entry.runtimeId, entry.messageUid)
      || dedupKeys.has(entry.key)
      || (entry.state === 'claimed' && entry.admittedAt !== undefined)
      || (entry.state === 'admitted'
        && (entry.admittedAt === undefined || entry.admittedAt < entry.claimedAt))) {
      throw new RouterStateError('router_state_invalid');
    }
    dedupKeys.add(entry.key);
  }
  return state;
}

function serializedBytes(state: RouterState): number {
  return Buffer.byteLength(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function stateEntry(state: RouterState, identity: ConversationIdentity): SessionEntry | undefined {
  const key = conversationKey(identity);
  return state.sessions.find((entry) => entry.conversationKey === key);
}

function createEntry(identity: ConversationIdentity, now: number): SessionEntry {
  return {
    conversationKey: conversationKey(identity),
    bindingKey: bindingKey(identity),
    ...identity,
    knownSessions: [],
    updatedAt: now,
  };
}

function assertSessionAvailable(
  state: RouterState,
  identity: ConversationIdentity,
  sessionId: string,
): void {
  const expectedOwner = conversationKey(identity);
  for (const entry of state.sessions) {
    if (entry.runtimeId === identity.runtimeId
      && entry.conversationKey !== expectedOwner
      && entry.knownSessions.some((session) => session.sessionId === sessionId)) {
      throw new RouterStateError('session_conflict');
    }
  }
}

function acceptAuthoritative(entry: SessionEntry, sessionId: string, now: number): void {
  const existing = entry.knownSessions.findIndex((session) => session.sessionId === sessionId);
  if (existing >= 0) entry.knownSessions.splice(existing, 1);
  entry.knownSessions.push({ sessionId, updatedAt: now });
  entry.currentSessionId = sessionId;
  entry.updatedAt = now;
  while (entry.knownSessions.length > MAX_KNOWN_SESSIONS) {
    const oldestNonCurrent = entry.knownSessions.findIndex(
      (session) => session.sessionId !== entry.currentSessionId,
    );
    if (oldestNonCurrent < 0) throw new RouterStateError('router_state_invalid');
    entry.knownSessions.splice(oldestNonCurrent, 1);
  }
}

export class RouterStateStore {
  readonly #filePath: string;
  readonly #atomicDependencies: AtomicJsonDependencies;
  readonly #now: () => number;
  #state = emptyState();
  #initialized = false;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: RouterStateStoreOptions) {
    if (!isAbsolute(options.filePath)
      || options.filePath !== options.filePath.trim()
      || options.filePath.includes('\0')) {
      throw new RouterStateError('router_state_invalid');
    }
    this.#filePath = options.filePath;
    this.#atomicDependencies = options.atomicDependencies ?? {};
    this.#now = options.now ?? Date.now;
  }

  initialize(): Promise<void> {
    return this.#serialize(async () => {
      if (this.#initialized) return;
      try {
        const loaded = await readJsonFileIfExists(
          this.#filePath,
          routerStateSchema,
          MAX_STATE_BYTES,
          this.#atomicDependencies,
        );
        const current = validateState(loaded ?? emptyState());
        const dedup = pruneDedup(current.dedup, this.#time());
        const next = validateState({ ...current, dedup });
        if (loaded !== undefined && dedup.length !== current.dedup.length) {
          await atomicWriteJson(this.#filePath, next, this.#atomicDependencies);
        }
        this.#state = next;
        this.#initialized = true;
      } catch (error) {
        if (error instanceof RouterStateError) throw error;
        throw new RouterStateError('router_state_invalid');
      }
    });
  }

  currentSession(identity: ConversationIdentity): Promise<string | undefined> {
    return this.#read((state) => stateEntry(state, this.#identity(identity))?.currentSessionId);
  }

  knownSessions(identity: ConversationIdentity): Promise<readonly string[]> {
    return this.#read((state) =>
      stateEntry(state, this.#identity(identity))?.knownSessions.map((session) => session.sessionId) ?? [],
    );
  }

  clearCurrent(identity: ConversationIdentity): Promise<void> {
    return this.#mutate((state, now) => {
      const entry = stateEntry(state, this.#identity(identity));
      if (entry?.currentSessionId === undefined) return { changed: false, value: undefined };
      delete entry.currentSessionId;
      entry.updatedAt = now;
      return { changed: true, value: undefined };
    });
  }

  switchKnown(identity: ConversationIdentity, sessionId: string): Promise<boolean> {
    return this.#mutate((state, now) => {
      const entry = stateEntry(state, this.#identity(identity));
      if (!entry || !entry.knownSessions.some((session) => session.sessionId === sessionId)) {
        return { changed: false, value: false };
      }
      if (entry.currentSessionId === sessionId) return { changed: false, value: true };
      entry.currentSessionId = sessionId;
      entry.updatedAt = now;
      return { changed: true, value: true };
    });
  }

  deleteKnown(identity: ConversationIdentity, sessionId: string): Promise<boolean> {
    return this.#mutate((state, now) => {
      const entry = stateEntry(state, this.#identity(identity));
      if (!entry) return { changed: false, value: false };
      const index = entry.knownSessions.findIndex((session) => session.sessionId === sessionId);
      if (index < 0) return { changed: false, value: false };
      entry.knownSessions.splice(index, 1);
      if (entry.currentSessionId === sessionId) delete entry.currentSessionId;
      entry.updatedAt = now;
      return { changed: true, value: true };
    });
  }

  applyEventSession(input: {
    conversation: ConversationIdentity;
    submittedResumeSessionId?: string;
    status?: string;
    authoritativeSessionId?: string;
  }): Promise<void> {
    return this.#mutate((state, now) => {
      const identity = this.#identity(input.conversation);
      const submitted = input.submittedResumeSessionId === undefined
        ? undefined
        : this.#sessionId(input.submittedResumeSessionId);
      const authoritative = input.authoritativeSessionId === undefined
        ? undefined
        : this.#sessionId(input.authoritativeSessionId);
      let entry = stateEntry(state, identity);
      const canClear = input.status === 'resume_invalidated'
        && submitted !== undefined
        && entry?.currentSessionId === submitted;
      if (!canClear && authoritative === undefined) return { changed: false, value: undefined };
      if (authoritative !== undefined) assertSessionAvailable(state, identity, authoritative);
      if (!entry) {
        entry = createEntry(identity, now);
        state.sessions.push(entry);
      }
      if (canClear) {
        delete entry.currentSessionId;
        entry.knownSessions = entry.knownSessions.filter(
          (session) => session.sessionId !== submitted,
        );
        entry.updatedAt = now;
      }
      if (authoritative !== undefined) acceptAuthoritative(entry, authoritative, now);
      return { changed: true, value: undefined };
    });
  }

  claimMessage(
    runtime: string,
    messageUid: string,
    claimId: string,
  ): Promise<ClaimResult> {
    return this.#mutate((state, now) => {
      let transition;
      try {
        transition = claimDedup(state.dedup, runtime, messageUid, claimId, now);
      } catch {
        throw new RouterStateError('router_state_invalid');
      }
      state.dedup = transition.entries;
      if (transition.status === 'capacity') throw new RouterStateError('dedup_capacity');
      return {
        changed: transition.status === 'claimed',
        value: transition.status === 'claimed'
          ? { status: 'claimed' as const, key: transition.key, claimId: transition.claimId }
          : { status: 'duplicate' as const, key: transition.key },
      };
    });
  }

  admitMessage(key: string, claimId: string): Promise<boolean> {
    return this.#mutate((state, now) => {
      const transition = admitDedup(state.dedup, key, claimId, now);
      state.dedup = transition.entries;
      return { changed: transition.changed, value: transition.accepted };
    });
  }

  releaseMessage(key: string, claimId: string): Promise<boolean> {
    return this.#mutate((state) => {
      const transition = releaseDedup(state.dedup, key, claimId);
      state.dedup = transition.entries;
      return { changed: transition.changed, value: transition.accepted };
    });
  }

  #identity(identity: ConversationIdentity): ConversationIdentity {
    if (!validIdentity(identity)) throw new RouterStateError('router_state_invalid');
    return identity;
  }

  #sessionId(value: string): string {
    const parsed = identifier().safeParse(value);
    if (!parsed.success) throw new RouterStateError('router_state_invalid');
    return parsed.data;
  }

  #time(): number {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) throw new RouterStateError('router_state_invalid');
    return now;
  }

  #assertInitialized(): void {
    if (!this.#initialized) throw new RouterStateError('router_state_invalid');
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const running = this.#tail.catch(() => undefined).then(operation);
    this.#tail = running.then(() => undefined, () => undefined);
    return running;
  }

  #read<T>(reader: (state: RouterState) => T): Promise<T> {
    return this.#serialize(async () => {
      this.#assertInitialized();
      return reader(this.#state);
    });
  }

  #mutate<T>(
    transition: (state: RouterState, now: number) => { changed: boolean; value: T },
  ): Promise<T> {
    return this.#serialize(async () => {
      this.#assertInitialized();
      const candidate = cloneState(this.#state);
      const now = this.#time();
      const beforePrune = candidate.dedup.length;
      candidate.dedup = pruneDedup(candidate.dedup, now);
      const result = transition(candidate, now);
      const changed = result.changed || candidate.dedup.length !== beforePrune;
      if (!changed) return result.value;
      const valid = validateState(candidate);
      if (serializedBytes(valid) > MAX_STATE_BYTES) {
        throw new RouterStateError('router_state_invalid');
      }
      try {
        await atomicWriteJson(this.#filePath, valid, this.#atomicDependencies);
      } catch {
        throw new RouterStateError('router_state_invalid');
      }
      this.#state = valid;
      return result.value;
    });
  }
}

export type PersistedDedupEntry = DedupEntry;
