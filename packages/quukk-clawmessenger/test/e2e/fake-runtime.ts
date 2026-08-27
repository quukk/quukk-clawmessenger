import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';

import { BindingService } from '../../src/bindings/service.js';
import { localPaths } from '../../src/config/paths.js';
import { PROVIDERS, type Provider, type RuntimeDiscoveryStatus } from '../../src/config/schema.js';
import { LocalStore } from '../../src/config/store.js';
import { BridgeClient } from '../../src/go/client.js';
import type { BridgeRuntime, BridgeTaskEvent } from '../../src/go/types.js';
import { LocalHttpServer } from '../../src/http/server.js';
import { deriveControlCredential } from '../../src/http/security.js';
import { LocalLogger } from '../../src/logging/logger.js';
import { DaemonIdentityStore, type StartingDaemonIdentity } from '../../src/process/service-identity.js';
import { MessageRouter } from '../../src/router/message-router.js';
import { RouterStateStore } from '../../src/router/session-store.js';
import {
  startProductionService,
  type ProductionServiceFactories,
  type QuukkService,
} from '../../src/service.js';
import { FakeRegistrationServer } from './fake-registration.js';
import { FakeRongCloudWorkers } from './fake-rongcloud-worker.js';

export const E2E_RUNTIME_IDS = {
  opencode: `rt_${'1'.repeat(32)}`,
  openclaw: `rt_${'2'.repeat(32)}`,
  codex: `rt_${'3'.repeat(32)}`,
  hermes: `rt_${'4'.repeat(32)}`,
} as const;

const DEFAULT_STATUSES: Readonly<Record<Provider, RuntimeDiscoveryStatus>> = {
  opencode: 'ready',
  openclaw: 'ready',
  codex: 'found_not_runnable',
  hermes: 'not_found',
};
const STARTED_AT = '2026-08-28T00:00:00.000Z';
let serviceSequence = 0;

type TaskStart = {
  taskId: string;
  runtimeId: string;
  conversationKey: string;
  resumeSessionId?: string;
  sessionId: string;
};

type TaskGate = {
  promise: Promise<void>;
  release(): void;
};

type FakeTask = TaskStart & {
  provider: Provider;
  events: BridgeTaskEvent[];
  terminal: boolean;
  waiters: Set<() => void>;
  gate?: TaskGate;
};

function gate(): TaskGate {
  let releasePromise!: () => void;
  let released = false;
  const promise = new Promise<void>((resolvePromise) => { releasePromise = resolvePromise; });
  return {
    promise,
    release() {
      if (released) return;
      released = true;
      releasePromise();
    },
  };
}

function capabilities(): BridgeRuntime['capabilities'] {
  return {
    session_resume: true,
    cancel: true,
    text_events: true,
    tool_events: true,
    approval_events: false,
  };
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(body)),
  });
  response.end(body);
}

function sendEmpty(response: ServerResponse, status: number): void {
  response.writeHead(status, { 'Cache-Control': 'no-store', 'Content-Length': '0' });
  response.end();
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    bytes += buffer.byteLength;
    if (bytes > 1 << 20) throw new Error('fake_bridge_body_too_large');
    chunks.push(buffer);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('fake_bridge_body_invalid');
  }
  return value as Record<string, unknown>;
}

function eventFrame(event: BridgeTaskEvent): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export class FakeBridgeRuntime {
  readonly #homeDirectory: string;
  readonly #trace: string[];
  readonly #statuses = new Map<Provider, RuntimeDiscoveryStatus>(
    PROVIDERS.map((provider) => [provider, DEFAULT_STATUSES[provider]]),
  );
  readonly #tasks = new Map<string, FakeTask>();
  readonly #starts: TaskStart[] = [];
  readonly #nextGates = new Map<Provider, TaskGate>();
  readonly #disconnectNext = new Set<Provider>();
  #server?: Server;
  #secret?: string;
  #client?: BridgeClient;
  #baseUrl?: string;
  #taskSequence = 0;
  #sessionSequence = 0;
  #eventStreamRequests = 0;
  #reconnectRequests = 0;
  #cancelRequests = 0;
  #shutdownRequests = 0;

  constructor(homeDirectory: string, trace: string[] = []) {
    this.#homeDirectory = homeDirectory;
    this.#trace = trace;
  }

  catalog(): BridgeRuntime[] {
    return PROVIDERS.map((provider) => ({
      id: E2E_RUNTIME_IDS[provider],
      provider,
      version: `${provider}-e2e-1.0.0`,
      path: this.runtimePath(provider),
      status: this.#statuses.get(provider)!,
      capabilities: capabilities(),
    }));
  }

  runtimePath(provider: Provider): string {
    return join(this.#homeDirectory, 'provider-bin', `${provider}-ABSOLUTE-PATH-SENTINEL.exe`);
  }

  setStatus(provider: Provider, status: RuntimeDiscoveryStatus): void {
    this.#statuses.set(provider, status);
  }

  setAllReady(): void {
    for (const provider of PROVIDERS) this.#statuses.set(provider, 'ready');
  }

  holdNext(provider: Provider): TaskGate {
    const next = gate();
    this.#nextGates.set(provider, next);
    return next;
  }

  disconnectNextEventStream(provider: Provider): void {
    this.#disconnectNext.add(provider);
  }

  taskStarts(): readonly TaskStart[] {
    return this.#starts.map((start) => ({ ...start }));
  }

  eventStreamRequests(): number { return this.#eventStreamRequests; }
  reconnectRequests(): number { return this.#reconnectRequests; }
  cancelRequests(): number { return this.#cancelRequests; }
  shutdownRequests(): number { return this.#shutdownRequests; }
  trace(): readonly string[] { return this.#trace.slice(); }

  async start(secret: string): Promise<{
    client: BridgeClient;
    identity: {
      schema_version: 1;
      address: string;
      pid: number;
      version: string;
      instance_id: string;
      started_at: string;
    };
  }> {
    if (this.#client !== undefined && this.#baseUrl !== undefined) {
      if (secret !== this.#secret) throw new Error('fake_bridge_secret_changed');
      return { client: this.#client, identity: this.#identity() };
    }
    this.#secret = secret;
    const server = createServer((request, response) => {
      void this.#handle(request, response).catch(() => sendJson(response, 500, { error: 'internal_error' }));
    });
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolvePromise);
    });
    this.#server = server;
    this.#baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    this.#client = new BridgeClient({
      baseUrl: this.#baseUrl,
      secret,
      requestTimeoutMs: 2_000,
      refreshTimeoutMs: 2_000,
      sseIdleTimeoutMs: 2_000,
      reconnectBaseDelayMs: 1,
      reconnectMaximumDelayMs: 4,
    });
    this.#trace.push('bridge.http.start');
    return { client: this.#client, identity: this.#identity() };
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    this.#client = undefined;
    this.#baseUrl = undefined;
    this.#secret = undefined;
    if (server === undefined) return;
    server.closeAllConnections();
    await new Promise<void>((resolvePromise, reject) => {
      server.close((error) => error === undefined ? resolvePromise() : reject(error));
    });
    this.#trace.push('bridge.http.close');
  }

  #identity() {
    const address = this.#baseUrl!.slice('http://'.length);
    return {
      schema_version: 1 as const,
      address,
      pid: process.pid,
      version: '0.1.0-beta.1',
      instance_id: `br_${'a'.repeat(32)}`,
      started_at: STARTED_AT,
    };
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.headers.authorization !== `Bearer ${this.#secret}`) {
      sendJson(response, 401, { error: 'unauthorized' });
      return;
    }
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (request.method === 'GET' && pathname === '/v1/runtimes') {
      sendJson(response, 200, this.catalog());
      return;
    }
    if (request.method === 'POST' && pathname === '/v1/runtimes/refresh') {
      sendJson(response, 200, this.catalog());
      return;
    }
    if (request.method === 'GET' && pathname === '/healthz') {
      sendJson(response, 200, {
        status: 'ok',
        version: '0.1.0-beta.1',
        pid: process.pid,
        instance_id: `br_${'a'.repeat(32)}`,
        started_at: STARTED_AT,
        probe_status: 'ready',
      });
      return;
    }
    if (request.method === 'POST' && pathname === '/v1/tasks') {
      await this.#startTask(request, response);
      return;
    }
    const events = /^\/v1\/tasks\/(task_[0-9a-f]+_[0-9a-f]+)\/events$/.exec(pathname);
    if (request.method === 'GET' && events !== null) {
      await this.#events(request, response, events[1]!);
      return;
    }
    const cancel = /^\/v1\/tasks\/(task_[0-9a-f]+_[0-9a-f]+)\/cancel$/.exec(pathname);
    if (request.method === 'POST' && cancel !== null) {
      this.#cancelRequests += 1;
      const task = this.#tasks.get(cancel[1]!);
      if (task === undefined) {
        sendJson(response, 404, { error: 'task_not_found' });
        return;
      }
      if (!task.terminal) this.#finish(task, 'cancelled');
      sendEmpty(response, 202);
      return;
    }
    if (request.method === 'POST' && pathname === '/shutdown') {
      this.#shutdownRequests += 1;
      sendEmpty(response, 202);
      this.#trace.push('bridge.shutdown.flushed');
      return;
    }
    sendJson(response, 404, { error: 'not_found' });
  }

  async #startTask(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const input = await readJson(request);
    const runtimeId = input.runtime_id;
    if (typeof runtimeId !== 'string') {
      sendJson(response, 409, { error: 'runtime_not_ready' });
      return;
    }
    const provider = PROVIDERS.find((candidate) => E2E_RUNTIME_IDS[candidate] === runtimeId);
    if (provider === undefined || this.#statuses.get(provider) !== 'ready') {
      sendJson(response, 409, { error: 'runtime_not_ready' });
      return;
    }
    this.#taskSequence += 1;
    this.#sessionSequence += 1;
    const taskId = `task_${this.#taskSequence.toString(16)}_1`;
    const resumeSessionId = typeof input.resume_session_id === 'string' ? input.resume_session_id : undefined;
    const start: TaskStart = {
      taskId,
      runtimeId,
      conversationKey: String(input.conversation_key),
      ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
      sessionId: resumeSessionId ?? `session-${provider}-${this.#sessionSequence}`,
    };
    const task: FakeTask = {
      ...start,
      provider,
      events: [{ id: 1, task_id: taskId, type: 'started', time: STARTED_AT }],
      terminal: false,
      waiters: new Set(),
      gate: this.#nextGates.get(provider),
    };
    this.#nextGates.delete(provider);
    this.#starts.push(start);
    this.#tasks.set(taskId, task);
    if (task.gate === undefined) queueMicrotask(() => this.#finish(task, 'completed'));
    else void task.gate.promise.then(() => this.#finish(task, 'completed'));
    sendJson(response, 201, { task_id: taskId, events_url: `/v1/tasks/${taskId}/events` });
  }

  #finish(task: FakeTask, terminal: 'completed' | 'cancelled'): void {
    if (task.terminal) return;
    task.terminal = true;
    const common = {
      id: task.events.length + 1,
      task_id: task.taskId,
      type: terminal,
      time: STARTED_AT,
      session_id: task.sessionId,
    } as const;
    task.events.push(terminal === 'completed'
      ? { ...common, type: 'completed', output: `reply:${task.provider}` }
      : { ...common, type: 'cancelled' });
    for (const notify of task.waiters) notify();
    task.waiters.clear();
  }

  async #events(request: IncomingMessage, response: ServerResponse, taskId: string): Promise<void> {
    const task = this.#tasks.get(taskId);
    if (task === undefined) {
      sendJson(response, 404, { error: 'task_not_found' });
      return;
    }
    const rawCursor = request.headers['last-event-id'];
    let cursor = typeof rawCursor === 'string' ? Number(rawCursor) : 0;
    this.#eventStreamRequests += 1;
    if (cursor > 0) this.#reconnectRequests += 1;
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/event-stream',
    });
    response.flushHeaders();
    while (!response.destroyed) {
      const next = task.events.find(({ id }) => id > cursor);
      if (next !== undefined) {
        response.write(eventFrame(next));
        cursor = next.id;
        if (this.#disconnectNext.delete(task.provider)) {
          response.end();
          return;
        }
        if (next.type === 'completed' || next.type === 'failed' || next.type === 'cancelled') {
          response.end();
          return;
        }
        continue;
      }
      if (task.terminal) {
        response.end();
        return;
      }
      await new Promise<void>((resolvePromise) => {
        const ready = () => {
          response.off('close', ready);
          task.waiters.delete(ready);
          resolvePromise();
        };
        task.waiters.add(ready);
        response.once('close', ready);
      });
    }
  }
}

class BrowserApi {
  readonly #origin: string;
  readonly #cookie: string;
  readonly #csrf: string;

  private constructor(origin: string, cookie: string, csrf: string) {
    this.#origin = origin;
    this.#cookie = cookie;
    this.#csrf = csrf;
  }

  static async connect(origin: string, controlCredential: string): Promise<BrowserApi> {
    const issued = await internalControl(origin, controlCredential, 'launch_ticket');
    if (issued.status !== 201) throw new Error(`launch_ticket_failed:${issued.status}`);
    const ticket = issued.body as { ticket: string };
    const exchanged = await fetch(`${origin}/api/session/exchange`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket: ticket.ticket }),
    });
    if (exchanged.status !== 200) throw new Error(`session_exchange_failed:${exchanged.status}`);
    const session = await exchanged.json() as { csrfToken: string };
    const cookie = exchanged.headers.get('set-cookie')?.split(';', 1)[0];
    if (cookie === undefined) throw new Error('session_cookie_missing');
    return new BrowserApi(origin, cookie, session.csrfToken);
  }

  get<T = any>(pathname: string): Promise<T> {
    return this.#request<T>('GET', pathname);
  }

  post<T = any>(pathname: string, value?: unknown): Promise<T> {
    return this.#request<T>('POST', pathname, value);
  }

  async #request<T>(method: 'GET' | 'POST', pathname: string, value?: unknown): Promise<T> {
    const mutating = method !== 'GET';
    const response = await fetch(`${this.#origin}${pathname}`, {
      method,
      headers: {
        Cookie: this.#cookie,
        ...(mutating ? { Origin: this.#origin, 'X-Quukk-CSRF': this.#csrf } : {}),
        ...(value === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
    const parsed = await response.json() as T;
    if (!response.ok) throw Object.assign(new Error('e2e_api_error'), { status: response.status, body: parsed });
    return parsed;
  }
}

async function internalControl(
  origin: string,
  controlCredential: string,
  command: 'launch_ticket' | 'shutdown',
): Promise<{ status: number; body: unknown }> {
  const body = Buffer.from(JSON.stringify({ command }), 'utf8');
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest(new URL('/internal/control', origin), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${controlCredential}`,
        'Content-Type': 'application/json',
        'Content-Length': String(body.byteLength),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          resolvePromise({
            status: response.statusCode ?? 0,
            body: text.length === 0 ? undefined : JSON.parse(text),
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.once('error', reject);
    request.end(body);
  });
}

export interface E2EHarness {
  homeDirectory: string;
  workdir: string;
  logPath: string;
  api: BrowserApi;
  service: QuukkService;
  store: LocalStore;
  runtime: FakeBridgeRuntime;
  registration: FakeRegistrationServer;
  workers: FakeRongCloudWorkers;
  trace(): readonly string[];
  stop(): Promise<void>;
  shutdownViaControl(): Promise<{ status: number; body: unknown }>;
  close(): Promise<void>;
}

export async function temporaryE2EHome(): Promise<string> {
  const configured = process.env.TEMP ?? process.env.TMP;
  if (configured === undefined) throw new Error('task_temp_required');
  const root = resolve(configured);
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'quukk-task14-e2e-'));
  if (resolve(directory) !== root && !resolve(directory).startsWith(root + sep)) {
    throw new Error('unsafe_e2e_home');
  }
  return directory;
}

export async function removeE2EHome(directory: string): Promise<void> {
  const configured = process.env.TEMP ?? process.env.TMP;
  if (configured === undefined) throw new Error('task_temp_required');
  const root = resolve(configured);
  const target = resolve(directory);
  if (!target.startsWith(root + sep) || basename(target).length < 12) throw new Error('unsafe_e2e_cleanup');
  await rm(target, { recursive: true, force: true });
}

export async function createE2EHarness(options: {
  homeDirectory?: string;
  runtime?: FakeBridgeRuntime;
  registration?: FakeRegistrationServer;
  allReady?: boolean;
  trace?: string[];
} = {}): Promise<E2EHarness> {
  const ownsHome = options.homeDirectory === undefined;
  const homeDirectory = options.homeDirectory ?? await temporaryE2EHome();
  const trace = options.trace ?? [];
  const runtime = options.runtime ?? new FakeBridgeRuntime(homeDirectory, trace);
  if (options.allReady) runtime.setAllReady();
  const registration = options.registration ?? new FakeRegistrationServer();
  const ownsRegistration = options.registration === undefined;
  const serverUrl = await registration.start();
  const workdir = join(homeDirectory, 'authorized-work');
  const staticRoot = join(homeDirectory, 'ui');
  await Promise.all([mkdir(workdir, { recursive: true }), mkdir(staticRoot, { recursive: true })]);
  await writeFile(join(staticRoot, 'index.html'), '<!doctype html><title>Quukk E2E</title>', 'utf8');

  const paths = localPaths(homeDirectory);
  await mkdir(dirname(paths.daemonPid), { recursive: true });
  serviceSequence += 1;
  const starting: StartingDaemonIdentity = {
    schema_version: 1,
    state: 'starting',
    pid: process.pid,
    version: '0.1.0-beta.1',
    instance_id: `svc_${serviceSequence.toString(16).padStart(32, '0')}`,
    started_at: STARTED_AT,
  };
  const identityStore = new DaemonIdentityStore({ filePath: paths.daemonPid });
  if (!await identityStore.claim(starting)) throw new Error('e2e_identity_conflict');

  let store!: LocalStore;
  let workers!: FakeRongCloudWorkers;
  let bridgeClient: BridgeClient | undefined;
  const factories: ProductionServiceFactories = {
    openStore: async ({ homeDirectory: root }) => {
      store = await LocalStore.open({ homeDirectory: root });
      return store;
    },
    openLogger: (loggerOptions) => LocalLogger.open(loggerOptions),
    createBridge: () => ({
      ensureStarted: async () => {
        const running = await runtime.start(store.bridgeIdentity().secret);
        bridgeClient ??= running.client;
        if (bridgeClient !== running.client) throw new Error('e2e_bridge_client_changed');
        return { ...running, recovered: false };
      },
      stop: async () => {
        trace.push('bridge.stop.begin');
        if (bridgeClient !== undefined) await bridgeClient.shutdown();
        await runtime.close();
        trace.push('bridge.stop.end');
      },
    }),
    createRegistrationClient: () => registration.client(),
    openBindings: (bindingOptions) => BindingService.open({
      ...bindingOptions,
      store: bindingOptions.store as LocalStore,
    }),
    createRouterState: (stateOptions) => new RouterStateStore(stateOptions),
    createWorkers: (workerOptions) => {
      workers = new FakeRongCloudWorkers(workerOptions, trace);
      return workers;
    },
    createRouter: (routerOptions) => new MessageRouter({
      ...routerOptions,
      state: routerOptions.state as RouterStateStore,
    }),
    createHttp: (httpOptions) => new LocalHttpServer(httpOptions),
  };

  let service: QuukkService;
  try {
    service = await startProductionService({
      identity: starting,
      identityStore,
      homeDirectory,
      processEnvironment: { TEMP: process.env.TEMP, TMP: process.env.TMP },
      configOverrides: {
        serverUrl,
        defaultWorkdir: workdir,
        authorizedWorkRoots: [workdir],
        logLevel: 'debug',
      },
      staticRoot,
      factories,
      startupTimeoutMs: 10_000,
      shutdownTimeoutMs: 10_000,
    });
  } catch (error) {
    await runtime.close().catch(() => undefined);
    if (ownsRegistration) await registration.close().catch(() => undefined);
    if (ownsHome) await removeE2EHome(homeDirectory).catch(() => undefined);
    throw error;
  }
  const identity = await service.status(new AbortController().signal);
  const origin = `http://${identity.identity.address}`;
  const controlCredential = deriveControlCredential(store.bridgeIdentity().secret, starting.instance_id);
  registration.forbidRawSecret(store.bridgeIdentity().secret);
  const api = await BrowserApi.connect(origin, controlCredential);
  let closed = false;
  const stop = () => service.stop();
  return {
    homeDirectory,
    workdir,
    logPath: paths.bridgeLog,
    api,
    service,
    store,
    runtime,
    registration,
    workers,
    trace: () => trace.slice(),
    stop,
    async shutdownViaControl() {
      const response = await internalControl(origin, controlCredential, 'shutdown');
      await service.stop();
      return response;
    },
    async close() {
      if (closed) return;
      closed = true;
      await service.stop().catch(() => undefined);
      await runtime.close().catch(() => undefined);
      if (ownsRegistration) await registration.close().catch(() => undefined);
      if (ownsHome) await removeE2EHome(homeDirectory);
    },
  };
}
