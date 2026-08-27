import {
  appendFile,
  chmod,
  mkdir,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { dirname } from 'node:path';

import type { LogLevel, Provider } from '../config/schema.js';
import type { BridgeEventType } from '../go/types.js';

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_RECORD_BYTES = 8 * 1024;
const MAX_PENDING = 512;
const MAX_ACTIVITY = 256;
const CLOSE_TIMEOUT_MS = 1_000;

const LEVEL_PRIORITY: Readonly<Record<LogLevel, number>> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};
const PROVIDERS = new Set<Provider>(['opencode', 'openclaw', 'codex', 'hermes']);
const CATEGORIES = new Set<string>([
  'detection',
  'authentication',
  'registration',
  'transport',
  'runtime',
  'policy',
]);
const CONVERSATION_TYPES = new Set([1, 3, 4]);
const EVENT_TYPES = new Set<BridgeEventType>([
  'started',
  'text_delta',
  'tool_started',
  'tool_finished',
  'status',
  'completed',
  'failed',
  'cancelled',
]);
const SAFE_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const SAFE_COMMAND = /^[a-z][a-z0-9_-]{0,31}$/;
const RUNTIME_ID = /^rt_[0-9a-f]{32}$/;
const NODE_ID = /^(?:opencode|openclaw|codex|hermes)_[a-z0-9][a-z0-9_-]{0,127}$/;
const TASK_ID = /^task_[0-9a-f]+_[0-9a-f]+$/;
const CONVERSATION_HASH = /^[0-9a-f]{16}$/;

export interface SafeLogEvent {
  event: string;
  category?:
    | 'detection'
    | 'authentication'
    | 'registration'
    | 'transport'
    | 'runtime'
    | 'policy';
  runtimeId?: string;
  nodeId?: string;
  provider?: Provider;
  conversationType?: 1 | 3 | 4;
  conversationKeyHash?: string;
  taskId?: string;
  eventType?: BridgeEventType;
  errorCode?: string;
  queueDepth?: number;
  count?: number;
  durationMs?: number;
  pid?: number;
  port?: number;
  state?: string;
  command?: string;
}

export type ActivityRecord = {
  id: number;
  time: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  event: string;
  runtimeId?: string;
  provider?: Provider;
  taskId?: string;
  eventType?: BridgeEventType;
  errorCode?: string;
  count?: number;
  durationMs?: number;
};

export interface LocalLoggerOptions {
  filePath: string;
  level: LogLevel;
  now?: () => Date;
  dependencies?: LoggerDependencies;
}

export interface LoggerDependencies {
  mkdir?: typeof mkdir;
  chmod?: typeof chmod;
  stat?: typeof stat;
  rename?: typeof rename;
  unlink?: typeof unlink;
  appendFile?: typeof appendFile;
}

type LogMethodLevel = ActivityRecord['level'];
type SanitizedEvent = Omit<ActivityRecord, 'id' | 'time' | 'level'> & {
  category?: SafeLogEvent['category'];
  nodeId?: string;
  conversationType?: 1 | 3 | 4;
  conversationKeyHash?: string;
  queueDepth?: number;
  pid?: number;
  port?: number;
  state?: string;
  command?: string;
};
type SerializedRecord = SanitizedEvent & { time: string; level: LogMethodLevel };
type PendingRecord = { level: LogMethodLevel; line: string };

const DEFAULT_DEPENDENCIES: Required<LoggerDependencies> = {
  mkdir,
  chmod,
  stat,
  rename,
  unlink,
  appendFile,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeInteger(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : undefined;
}

function safeString(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === 'string' && pattern.test(value) ? value : undefined;
}

function put<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) target[key] = value;
}

function sanitizeEvent(input: unknown): SanitizedEvent | undefined {
  try {
    if (!isRecord(input)) return undefined;
    const event = safeString(input.event, SAFE_CODE);
    if (event === undefined) return undefined;

    const output: SanitizedEvent = { event };
    put(
      output,
      'category',
      typeof input.category === 'string' && CATEGORIES.has(input.category)
        ? (input.category as SafeLogEvent['category'])
        : undefined,
    );
    put(output, 'runtimeId', safeString(input.runtimeId, RUNTIME_ID));
    put(output, 'nodeId', safeString(input.nodeId, NODE_ID));
    put(
      output,
      'provider',
      typeof input.provider === 'string' && PROVIDERS.has(input.provider as Provider)
        ? (input.provider as Provider)
        : undefined,
    );
    put(
      output,
      'conversationType',
      typeof input.conversationType === 'number' && CONVERSATION_TYPES.has(input.conversationType)
        ? (input.conversationType as 1 | 3 | 4)
        : undefined,
    );
    put(output, 'conversationKeyHash', safeString(input.conversationKeyHash, CONVERSATION_HASH));
    put(output, 'taskId', safeString(input.taskId, TASK_ID));
    put(
      output,
      'eventType',
      typeof input.eventType === 'string' && EVENT_TYPES.has(input.eventType as BridgeEventType)
        ? (input.eventType as BridgeEventType)
        : undefined,
    );
    put(output, 'errorCode', safeString(input.errorCode, SAFE_CODE));
    put(output, 'queueDepth', safeInteger(input.queueDepth, 0));
    put(output, 'count', safeInteger(input.count, 0));
    put(output, 'durationMs', safeInteger(input.durationMs, 0));
    put(output, 'pid', safeInteger(input.pid, 1));
    put(output, 'port', safeInteger(input.port, 1, 65_535));
    put(output, 'state', safeString(input.state, SAFE_CODE));
    put(output, 'command', safeString(input.command, SAFE_COMMAND));
    return output;
  } catch {
    return undefined;
  }
}

function isNotFound(error: unknown): boolean {
  try {
    return (
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ENOENT'
    );
  } catch {
    return false;
  }
}

function activityRecord(
  id: number,
  record: SerializedRecord,
): ActivityRecord {
  const activity: ActivityRecord = {
    id,
    time: record.time,
    level: record.level,
    event: record.event,
  };
  put(activity, 'runtimeId', record.runtimeId);
  put(activity, 'provider', record.provider);
  put(activity, 'taskId', record.taskId);
  put(activity, 'eventType', record.eventType);
  put(activity, 'errorCode', record.errorCode);
  put(activity, 'count', record.count);
  put(activity, 'durationMs', record.durationMs);
  return activity;
}

export class LocalLogger {
  readonly #filePath: string;
  readonly #backupPath: string;
  readonly #now: () => Date;
  readonly #dependencies: Required<LoggerDependencies>;
  #level: LogLevel;
  #pending: PendingRecord[] = [];
  #activity: ActivityRecord[] = [];
  #nextActivityId = 1;
  #dropped = 0;
  #drainPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;
  #accepting = true;

  private constructor(options: LocalLoggerOptions) {
    this.#filePath = options.filePath;
    this.#backupPath = `${options.filePath}.1`;
    this.#level = options.level;
    this.#now = options.now ?? (() => new Date());
    this.#dependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
  }

  static async open(options: LocalLoggerOptions): Promise<LocalLogger> {
    const logger = new LocalLogger(options);
    await logger.#initialize();
    return logger;
  }

  debug(event: SafeLogEvent): void {
    this.#log('debug', event);
  }

  info(event: SafeLogEvent): void {
    this.#log('info', event);
  }

  warn(event: SafeLogEvent): void {
    this.#log('warn', event);
  }

  error(event: SafeLogEvent): void {
    this.#log('error', event);
  }

  setLevel(level: LogLevel): void {
    if (Object.hasOwn(LEVEL_PRIORITY, level)) this.#level = level;
  }

  activity(): readonly ActivityRecord[] {
    return this.#activity.slice();
  }

  diagnostics(): { dropped: number; retained: number } {
    return { dropped: this.#dropped, retained: this.#activity.length };
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  async #initialize(): Promise<void> {
    try {
      const directory = dirname(this.#filePath);
      await this.#dependencies.mkdir(directory, {
        recursive: true,
        ...(process.platform === 'win32' ? {} : { mode: 0o700 }),
      });
      if (process.platform !== 'win32') await this.#dependencies.chmod(directory, 0o700);
      await this.#dependencies.appendFile(this.#filePath, '', {
        encoding: 'utf8',
        ...(process.platform === 'win32' ? {} : { mode: 0o600 }),
      });
      if (process.platform !== 'win32') await this.#dependencies.chmod(this.#filePath, 0o600);
    } catch {
      // The sink is best-effort. A later record may succeed after a transient failure.
    }
  }

  #log(level: LogMethodLevel, input: unknown): void {
    try {
      if (!this.#accepting || LEVEL_PRIORITY[level] > LEVEL_PRIORITY[this.#level]) return;
      const event = sanitizeEvent(input);
      if (event === undefined) {
        this.#dropped += 1;
        return;
      }
      const time = this.#now().toISOString();
      const record: SerializedRecord = { time, level, ...event };
      const line = `${JSON.stringify(record)}\n`;
      if (Buffer.byteLength(line, 'utf8') > MAX_RECORD_BYTES) {
        this.#dropped += 1;
        return;
      }

      this.#activity.push(activityRecord(this.#nextActivityId, record));
      this.#nextActivityId += 1;
      if (this.#activity.length > MAX_ACTIVITY) this.#activity.shift();
      this.#enqueue({ level, line });
    } catch {
      this.#dropped += 1;
    }
  }

  #enqueue(record: PendingRecord): void {
    if (this.#pending.length >= MAX_PENDING) {
      if (record.level === 'warn' || record.level === 'error') {
        const lowerPriority = this.#pending.findIndex(
          (candidate) => candidate.level === 'debug' || candidate.level === 'info',
        );
        if (lowerPriority >= 0) {
          this.#pending.splice(lowerPriority, 1);
          this.#dropped += 1;
        } else {
          this.#dropped += 1;
          return;
        }
      } else {
        this.#dropped += 1;
        return;
      }
    }
    this.#pending.push(record);
    this.#scheduleDrain();
  }

  #scheduleDrain(): void {
    if (this.#drainPromise !== undefined) return;
    const draining = Promise.resolve()
      .then(async () => this.#drain())
      .finally(() => {
        if (this.#drainPromise === draining) this.#drainPromise = undefined;
        if (this.#pending.length > 0) this.#scheduleDrain();
      });
    this.#drainPromise = draining;
    void draining.catch(() => undefined);
  }

  async #drain(): Promise<void> {
    while (this.#pending.length > 0) {
      const record = this.#pending.shift();
      if (record === undefined) return;
      try {
        await this.#write(record.line);
      } catch {
        this.#dropped += 1;
      }
    }
  }

  async #write(line: string): Promise<void> {
    let currentSize = 0;
    try {
      currentSize = (await this.#dependencies.stat(this.#filePath)).size;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    if (currentSize + Buffer.byteLength(line, 'utf8') > MAX_LOG_BYTES) {
      try {
        await this.#dependencies.unlink(this.#backupPath);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      try {
        await this.#dependencies.rename(this.#filePath, this.#backupPath);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
    await this.#dependencies.appendFile(this.#filePath, line, {
      encoding: 'utf8',
      ...(process.platform === 'win32' ? {} : { mode: 0o600 }),
    });
    if (process.platform !== 'win32') await this.#dependencies.chmod(this.#filePath, 0o600);
  }

  async #close(): Promise<void> {
    this.#accepting = false;
    this.#scheduleDrain();
    const draining = this.#drainPromise ?? Promise.resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      draining,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (this.#pending.length > 0) {
      this.#dropped += this.#pending.length;
      this.#pending = [];
    }
  }
}
