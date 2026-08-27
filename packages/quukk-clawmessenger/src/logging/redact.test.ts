import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  LocalLogger,
  type LoggerDependencies,
  type SafeLogEvent,
} from './logger.js';

const TASK_TEMP_ROOT = join(tmpdir(), 'quukk-task11-tests');
const LOG_BYTES = 5 * 1024 * 1024;
const TIME = '2026-08-27T08:00:00.000Z';
const RUNTIME_ID = `rt_${'a'.repeat(32)}`;
const temporaryDirectories: string[] = [];

beforeAll(async () => {
  await mkdir(TASK_TEMP_ROOT, { recursive: true });
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryLog(name = 'bridge.log'): Promise<string> {
  const directory = join(
    TASK_TEMP_ROOT,
    `quukk-task11-logger-${process.pid}-${Date.now()}-${temporaryDirectories.length}`,
  );
  temporaryDirectories.push(directory);
  return join(directory, name);
}

async function records(filePath: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(filePath, 'utf8');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('LocalLogger safe serialization', () => {
  it('writes only the flat scalar allowlist and never serializes sensitive or user content', async () => {
    const filePath = await temporaryLog();
    const logger = await LocalLogger.open({
      filePath,
      level: 'debug',
      now: () => new Date(TIME),
    });
    const unsafe = {
      event: 'service_ready',
      category: 'runtime',
      runtimeId: RUNTIME_ID,
      nodeId: 'codex_node-a',
      provider: 'codex',
      conversationType: 3,
      conversationKeyHash: '0123456789abcdef',
      taskId: 'task_ab_cd',
      eventType: 'completed',
      errorCode: 'runtime_unavailable',
      queueDepth: 2,
      count: 3,
      durationMs: 4,
      pid: 123,
      port: 45_678,
      state: 'ready',
      command: 'status',
      ToKeN: 'TOKEN_SENTINEL',
      appKey: 'APPKEY_SENTINEL',
      secret: 'SECRET_SENTINEL',
      password: 'PASSWORD_SENTINEL',
      authorization: 'AUTHORIZATION_SENTINEL',
      cookie: 'COOKIE_SENTINEL',
      ticket: 'TICKET_SENTINEL',
      csrf: 'CSRF_SENTINEL',
      prompt: 'PROMPT_SENTINEL',
      content: 'CONTENT_SENTINEL',
      message: 'MESSAGE_SENTINEL',
      raw: 'RAW_SENTINEL',
      stack: 'STACK_SENTINEL',
      body: { token: 'NESTED_TOKEN_SENTINEL' },
      env: { NODE_OPTIONS: 'ENV_SENTINEL' },
      headers: { cookie: 'HEADER_SENTINEL' },
      path: 'C:\\Users\\secret\\PATH_SENTINEL',
      url: 'http://127.0.0.1/#ticket=FRAGMENT_SENTINEL',
      caught: new Error('ERROR_SENTINEL'),
    } as unknown as SafeLogEvent;

    expect(() => logger.info(unsafe)).not.toThrow();
    await logger.close();

    const text = await readFile(filePath, 'utf8');
    for (const sentinel of [
      'TOKEN_SENTINEL',
      'APPKEY_SENTINEL',
      'SECRET_SENTINEL',
      'PASSWORD_SENTINEL',
      'AUTHORIZATION_SENTINEL',
      'COOKIE_SENTINEL',
      'TICKET_SENTINEL',
      'CSRF_SENTINEL',
      'PROMPT_SENTINEL',
      'CONTENT_SENTINEL',
      'MESSAGE_SENTINEL',
      'RAW_SENTINEL',
      'STACK_SENTINEL',
      'NESTED_TOKEN_SENTINEL',
      'ENV_SENTINEL',
      'HEADER_SENTINEL',
      'PATH_SENTINEL',
      'FRAGMENT_SENTINEL',
      'ERROR_SENTINEL',
    ]) {
      expect(text).not.toContain(sentinel);
    }

    expect(await records(filePath)).toEqual([
      {
        time: TIME,
        level: 'info',
        event: 'service_ready',
        category: 'runtime',
        runtimeId: RUNTIME_ID,
        nodeId: 'codex_node-a',
        provider: 'codex',
        conversationType: 3,
        conversationKeyHash: '0123456789abcdef',
        taskId: 'task_ab_cd',
        eventType: 'completed',
        errorCode: 'runtime_unavailable',
        queueDepth: 2,
        count: 3,
        durationMs: 4,
        pid: 123,
        port: 45_678,
        state: 'ready',
        command: 'status',
      },
    ]);
    expect(logger.activity()).toEqual([
      {
        id: 1,
        time: TIME,
        level: 'info',
        event: 'service_ready',
        runtimeId: RUNTIME_ID,
        provider: 'codex',
        taskId: 'task_ab_cd',
        eventType: 'completed',
        errorCode: 'runtime_unavailable',
        count: 3,
        durationMs: 4,
      },
    ]);
    expect(logger.diagnostics()).toEqual({ dropped: 0, retained: 1 });
  });

  it('drops malformed allowed values, invalid events, and records above the UTF-8 bound', async () => {
    const filePath = await temporaryLog();
    const logger = await LocalLogger.open({ filePath, level: 'debug' });

    logger.info({
      event: 'service_ready',
      runtimeId: 'C:\\Users\\PATH_SENTINEL',
      nodeId: 'n'.repeat(10_000),
      conversationKeyHash: 'ABCDEF0123456789',
      errorCode: 'http://127.0.0.1/#ticket=FRAGMENT_SENTINEL',
    } as SafeLogEvent);
    logger.error({ event: 'invalid event with user content' });
    await logger.close();

    const text = await readFile(filePath, 'utf8');
    const lines = text.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(Buffer.byteLength(`${lines[0]}\n`, 'utf8')).toBeLessThanOrEqual(8 * 1024);
    expect(text).not.toMatch(/PATH_SENTINEL|FRAGMENT_SENTINEL/);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ event: 'service_ready', level: 'info' });
    expect(logger.diagnostics()).toEqual({ dropped: 1, retained: 1 });
  });

  it('honors log levels and keeps the newest 256 activity records in ascending id order', async () => {
    const filePath = await temporaryLog();
    const appendFile = (async () => undefined) as LoggerDependencies['appendFile'];
    const fakeStat = (async () => ({ size: 0 })) as unknown as LoggerDependencies['stat'];
    const logger = await LocalLogger.open({
      filePath,
      level: 'info',
      dependencies: { appendFile, stat: fakeStat },
    });

    logger.debug({ event: 'debug_filtered' });
    for (let count = 0; count <= 300; count += 1) {
      logger.info({ event: 'activity_recorded', count });
    }
    await logger.close();

    const activity = logger.activity();
    expect(activity).toHaveLength(256);
    expect(activity[0]).toMatchObject({ id: 46, count: 45 });
    expect(activity.at(-1)).toMatchObject({ id: 301, count: 300 });
    expect(logger.diagnostics()).toEqual({ dropped: 0, retained: 256 });
  });
});

describe('LocalLogger bounded file sink', () => {
  it('bounds the pending queue and preserves an error by evicting lower-priority work', async () => {
    const filePath = await temporaryLog();
    let releaseWrite!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const writes: string[] = [];
    const appendFile: LoggerDependencies['appendFile'] = async (_path, data) => {
      if (String(data).length === 0) return;
      await blocked;
      writes.push(String(data));
    };
    const fakeStat = (async () => ({ size: 0 })) as unknown as LoggerDependencies['stat'];
    const logger = await LocalLogger.open({
      filePath,
      level: 'debug',
      dependencies: { appendFile, stat: fakeStat },
    });

    for (let count = 0; count < 600; count += 1) {
      logger.info({ event: 'queue_item', count });
    }
    logger.error({ event: 'service_failed', errorCode: 'runtime_unavailable' });

    expect(logger.diagnostics().dropped).toBeGreaterThan(0);
    expect(logger.activity()).toHaveLength(256);
    releaseWrite();
    await logger.close();

    expect(writes.join('')).toContain('"event":"service_failed"');
  });

  it('rotates before crossing 5 MiB and retains exactly one backup', async () => {
    const filePath = await temporaryLog();
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, Buffer.alloc(LOG_BYTES - 1, 0x78));
    await writeFile(`${filePath}.1`, 'old-backup');
    const logger = await LocalLogger.open({ filePath, level: 'error' });

    logger.error({ event: 'service_failed', errorCode: 'runtime_unavailable' });
    await logger.close();

    expect((await stat(`${filePath}.1`)).size).toBe(LOG_BYTES - 1);
    expect((await stat(filePath)).size).toBeLessThan(LOG_BYTES);
    expect((await records(filePath))[0]).toMatchObject({
      level: 'error',
      event: 'service_failed',
    });
  });

  it('rotates successfully when no prior backup exists', async () => {
    const filePath = await temporaryLog();
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, Buffer.alloc(LOG_BYTES, 0x78));
    const logger = await LocalLogger.open({ filePath, level: 'error' });

    logger.error({ event: 'service_failed' });
    await logger.close();

    expect((await stat(`${filePath}.1`)).size).toBe(LOG_BYTES);
    expect((await records(filePath))[0]).toMatchObject({ event: 'service_failed' });
    expect(logger.diagnostics().dropped).toBe(0);
  });

  it('contains open and write failures without throwing into the service', async () => {
    const filePath = await temporaryLog();
    let call = 0;
    const appendFile: LoggerDependencies['appendFile'] = async () => {
      call += 1;
      if (call > 1) throw new Error('WRITE_FAILURE_SENTINEL');
    };
    const logger = await LocalLogger.open({
      filePath,
      level: 'error',
      dependencies: { appendFile },
    });

    expect(() => logger.error({ event: 'service_failed' })).not.toThrow();
    await expect(logger.close()).resolves.toBeUndefined();
    expect(logger.diagnostics().dropped).toBe(1);
  });

  it('bounds close when the file sink never settles', async () => {
    vi.useFakeTimers();
    const filePath = await temporaryLog();
    const appendFile: LoggerDependencies['appendFile'] = async (_path, data) => {
      if (String(data).length === 0) return;
      await new Promise<void>(() => undefined);
    };
    const fakeStat = (async () => ({ size: 0 })) as unknown as LoggerDependencies['stat'];
    const logger = await LocalLogger.open({
      filePath,
      level: 'error',
      dependencies: { appendFile, stat: fakeStat },
    });
    logger.error({ event: 'service_failed' });

    const closing = logger.close();
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(closing).resolves.toBeUndefined();
  });

  it('keeps the timeout referenced so close reliably resolves in a standalone process', async () => {
    const loggerTypeScriptUrl = new URL('./logger.ts', import.meta.url);
    const loggerUrl = (
      existsSync(loggerTypeScriptUrl) ? loggerTypeScriptUrl : new URL('./logger.js', import.meta.url)
    ).href;
    const filePath = await temporaryLog('close-child.log');
    const source = `
      import { LocalLogger } from ${JSON.stringify(loggerUrl)};
      const logger = await LocalLogger.open({
        filePath: ${JSON.stringify(filePath)},
        level: 'error',
        dependencies: {
          mkdir: async () => undefined,
          chmod: async () => undefined,
          stat: async () => ({ size: 0 }),
          rename: async () => undefined,
          unlink: async () => undefined,
          appendFile: async (_path, data) => {
            if (String(data).length > 0) await new Promise(() => undefined);
          },
        },
      });
      logger.error({ event: 'service_failed' });
      await logger.close();
      process.stdout.write(JSON.stringify(logger.diagnostics()));
    `;
    const startedAt = Date.now();
    const result = spawnSync(
      process.execPath,
      ['--no-warnings', '--experimental-strip-types', '--input-type=module', '--eval', source],
      {
        encoding: 'utf8',
        timeout: 3_000,
        env: {
          ...process.env,
          NODE_OPTIONS: undefined,
          NODE_TLS_REJECT_UNAUTHORIZED: undefined,
        },
      },
    );
    const elapsedMs = Date.now() - startedAt;

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('{"dropped":1,"retained":1}');
    expect(elapsedMs).toBeGreaterThanOrEqual(800);
    expect(elapsedMs).toBeLessThan(2_500);
  });

  it('counts timed-out work and discards active completion without follow-up sink calls', async () => {
    vi.useFakeTimers();
    const filePath = await temporaryLog();
    let enterWrite!: () => void;
    const enteredWrite = new Promise<void>((resolve) => {
      enterWrite = resolve;
    });
    let releaseWrite!: () => void;
    const blockedWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const initiated: string[] = [];
    const completed: string[] = [];
    let settleWrite!: () => void;
    const settledWrite = new Promise<void>((resolve) => {
      settleWrite = resolve;
    });
    const appendFile: LoggerDependencies['appendFile'] = async (_path, data) => {
      const line = String(data);
      if (line.length === 0) return;
      initiated.push(line);
      enterWrite();
      await blockedWrite;
      completed.push(line);
      settleWrite();
    };
    const fakeStat = (async () => ({ size: 0 })) as unknown as LoggerDependencies['stat'];
    const chmodSpy = vi.fn(async () => undefined);
    const chmod = chmodSpy as unknown as NonNullable<LoggerDependencies['chmod']>;
    const logger = await LocalLogger.open({
      filePath,
      level: 'error',
      dependencies: { appendFile, stat: fakeStat, chmod },
    });
    chmodSpy.mockClear();
    logger.error({ event: 'first_failed' });
    logger.error({ event: 'second_failed' });
    logger.error({ event: 'third_failed' });
    await enteredWrite;

    const closing = logger.close();
    await vi.advanceTimersByTimeAsync(1_000);
    await closing;

    expect(logger.diagnostics()).toEqual({ dropped: 3, retained: 3 });
    expect(initiated).toHaveLength(1);
    expect(completed).toHaveLength(0);
    releaseWrite();
    await settledWrite;
    await Promise.resolve();
    await Promise.resolve();
    expect(completed).toHaveLength(1);
    expect(initiated).toHaveLength(1);
    expect(chmodSpy).not.toHaveBeenCalled();
  });

  it('fences rotation and append when a delayed stat resumes after close timeout', async () => {
    vi.useFakeTimers();
    const filePath = await temporaryLog();
    let enterStat!: () => void;
    const enteredStat = new Promise<void>((resolve) => {
      enterStat = resolve;
    });
    let releaseStat!: () => void;
    const blockedStat = new Promise<void>((resolve) => {
      releaseStat = resolve;
    });
    const fakeStat = (async () => {
      enterStat();
      await blockedStat;
      return { size: LOG_BYTES };
    }) as unknown as LoggerDependencies['stat'];
    const unlink = vi.fn(async () => undefined) as unknown as LoggerDependencies['unlink'];
    const rename = vi.fn(async () => undefined) as unknown as LoggerDependencies['rename'];
    const nonEmptyAppends: string[] = [];
    const appendFile: LoggerDependencies['appendFile'] = async (_path, data) => {
      if (String(data).length > 0) nonEmptyAppends.push(String(data));
    };
    const logger = await LocalLogger.open({
      filePath,
      level: 'error',
      dependencies: { appendFile, stat: fakeStat, unlink, rename },
    });
    logger.error({ event: 'service_failed' });
    await enteredStat;

    const closing = logger.close();
    await vi.advanceTimersByTimeAsync(1_000);
    await closing;
    expect(logger.diagnostics()).toEqual({ dropped: 1, retained: 1 });

    releaseStat();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(unlink).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expect(nonEmptyAppends).toHaveLength(0);
  });
});
