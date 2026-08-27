import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  LocalRoutes,
  type LocalApiPort,
  type LocalControlPort,
  type ReadyDaemonIdentity,
  type RuntimesResponse,
} from './routes.js';
import { LocalHttpServer } from './server.js';
import { BrowserSessionStore, securityHeaders } from './security.js';
import { LaunchTicketStore } from './tickets.js';

const INSTANCE_ID = `svc_${'c'.repeat(32)}`;
const CREDENTIAL = Buffer.alloc(32, 7).toString('base64url');
const TIME = '2026-08-27T10:00:00.000Z';
const emptyRuntimes: RuntimesResponse = {
  schemaVersion: 1,
  runtimes: ['opencode', 'openclaw', 'codex', 'hermes'].map((provider) => ({
    provider: provider as 'opencode' | 'openclaw' | 'codex' | 'hermes',
    runtimeId: null,
    version: null,
    path: null,
    status: 'not_found' as const,
    capabilities: {
      sessionResume: false, cancel: false, textEvents: false, toolEvents: false, approvalEvents: false,
    },
    binding: null,
    worker: null,
  })),
};

const temporaryDirectories: string[] = [];
const servers: LocalHttpServer[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'quukk-http-'));
  temporaryDirectories.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

type HttpResponse = { status: number; headers: IncomingHttpHeaders; body: Buffer; json: unknown };
type Harness = {
  origin: string;
  address: { host: '127.0.0.1'; port: number; origin: string };
  send(input?: { method?: string; path?: string; headers?: Record<string, string>; body?: string }): Promise<HttpResponse>;
};

async function startServer(staticRoot: string, dependencies?: ConstructorParameters<typeof LocalHttpServer>[0]['dependencies']): Promise<Harness> {
  let currentIdentity: ReadyDaemonIdentity = {
    schema_version: 1, state: 'ready', pid: 4242, version: '0.1.0-beta.1',
    instance_id: INSTANCE_ID, started_at: TIME, address: '127.0.0.1:1',
  };
  const api: LocalApiPort = {
    async runtimes() { return emptyRuntimes; }, async rescan() { return emptyRuntimes; },
    async enable() { return { schemaVersion: 1, results: [] }; },
    async disable() { throw Object.assign(new Error(), { code: 'runtime_not_found' }); },
    async reregister() { throw Object.assign(new Error(), { code: 'runtime_not_found' }); },
    async activity() { return { schemaVersion: 1, events: [] }; },
    async diagnostics() { throw Object.assign(new Error(), { code: 'operation_unavailable' }); },
    async settings() { throw Object.assign(new Error(), { code: 'operation_unavailable' }); },
    async saveSettings() { throw Object.assign(new Error(), { code: 'operation_unavailable' }); },
  };
  const control: LocalControlPort = {
    async status() { return { schemaVersion: 1, identity: currentIdentity, state: 'ready' }; },
    async rescan() { return emptyRuntimes; },
    shutdownAfterResponse() {},
  };
  const routes = new LocalRoutes({
    api, control,
    tickets: new LaunchTicketStore({ instanceId: INSTANCE_ID }),
    sessions: new BrowserSessionStore(),
    readyIdentity: () => currentIdentity,
    controlCredential: CREDENTIAL,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  const server = new LocalHttpServer({
    routes, staticRoot, logger: { debug() {}, info() {}, warn() {}, error() {} }, dependencies,
  });
  servers.push(server);
  const address = await server.start();
  currentIdentity = { ...currentIdentity, address: `${address.host}:${address.port}` };
  return {
    origin: address.origin,
    address,
    send: (input = {}) => new Promise<HttpResponse>((resolve, reject) => {
      const body = input.body ?? '';
      const outgoing = request({
        hostname: address.host,
        port: address.port,
        method: input.method ?? 'GET',
        path: input.path ?? '/',
        headers: input.headers,
      }, (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.on('end', () => {
          const bytes = Buffer.concat(chunks);
          let json: unknown;
          try { json = JSON.parse(bytes.toString('utf8')); } catch { json = undefined; }
          resolve({ status: incoming.statusCode!, headers: incoming.headers, body: bytes, json });
        });
      });
      outgoing.on('error', reject);
      if (body === '') outgoing.end(); else outgoing.end(body);
    }),
  };
}

async function populatedRoot(): Promise<string> {
  const root = await temporaryRoot();
  await mkdir(join(root, 'assets'));
  await Promise.all([
    writeFile(join(root, 'index.html'), '<!doctype html><title>Quukk</title>'),
    writeFile(join(root, 'assets', 'app.js'), 'globalThis.__quukk = true;'),
    writeFile(join(root, 'data.json'), '{"schemaVersion":1}'),
    writeFile(join(root, '.secret'), 'hidden'),
    writeFile(join(root, 'debug.map'), '{}'),
    writeFile(join(root, 'notes.txt'), 'hidden'),
  ]);
  return root;
}

describe('LocalHttpServer perimeter', () => {
  it('binds only an ephemeral IPv4 loopback origin and enforces the actual Host', async () => {
    const value = await startServer(await populatedRoot());
    expect(value.address.host).toBe('127.0.0.1');
    expect(value.address.port).toBeGreaterThan(0);
    expect(value.address.origin).toBe(`http://127.0.0.1:${value.address.port}`);
    const rejected = await value.send({ headers: { Host: 'localhost' } });
    expect(rejected.status).toBe(403);
    expect(rejected.json).toEqual({ error: { code: 'host_rejected', category: 'policy', retryable: false } });
    expect(rejected.headers['content-security-policy']).toBe(securityHeaders()['Content-Security-Policy']);
  });

  it('rejects non-origin-form targets, API queries, malformed percent and OPTIONS without CORS', async () => {
    const value = await startServer(await populatedRoot());
    for (const path of ['http://example.test/', '//example.test/', '/api/runtimes?x=1', '/%zz']) {
      const response = await value.send({ path });
      expect(response.status).toBe(400);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    }
    const options = await value.send({ method: 'OPTIONS', path: '/api/runtimes' });
    expect(options.status).toBe(405);
    expect(options.headers.allow).toBe('GET');
  });

  it('keeps the internal control route available when the UI root is missing', async () => {
    const missing = join(await temporaryRoot(), 'missing-ui');
    const value = await startServer(missing);
    const ui = await value.send();
    expect(ui.status).toBe(503);
    expect(ui.json).toEqual({ error: { code: 'ui_unavailable', category: 'transport', retryable: true } });
    const control = await value.send({
      method: 'POST', path: '/internal/control',
      headers: { Authorization: `Bearer ${CREDENTIAL}`, 'Content-Type': 'application/json' },
      body: '{"command":"status"}',
    });
    expect(control.status).toBe(200);
    expect(control.json).toEqual({
      schemaVersion: 1,
      identity: expect.objectContaining({ address: `127.0.0.1:${value.address.port}` }),
      state: 'ready',
    });
  });
});

describe('LocalHttpServer static assets', () => {
  it('serves allowlisted MIME types, identical HEAD headers, and HTML-only SPA navigation', async () => {
    const value = await startServer(await populatedRoot());
    const index = await value.send();
    expect(index.status).toBe(200);
    expect(index.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(index.body.toString('utf8')).toContain('<title>Quukk</title>');
    const script = await value.send({ path: '/assets/app.js' });
    expect(script.status).toBe(200);
    expect(script.headers['content-type']).toBe('text/javascript; charset=utf-8');
    const head = await value.send({ method: 'HEAD', path: '/assets/app.js' });
    expect(head.status).toBe(200);
    expect(head.body).toHaveLength(0);
    expect(head.headers['content-length']).toBe(script.headers['content-length']);
    const spa = await value.send({ path: '/setup/runtime', headers: { Accept: 'text/html' } });
    expect(spa.status).toBe(200);
    expect(spa.body).toEqual(index.body);
    expect((await value.send({ path: '/setup/runtime', headers: { Accept: 'application/json' } })).status).toBe(404);
  });

  it('rejects traversal aliases, dotfiles, empty segments and unreviewed extensions', async () => {
    const value = await startServer(await populatedRoot());
    const cases: Array<[string, number]> = [
      ['/%2e%2e/secret.json', 404],
      ['/%2fetc/passwd.json', 400],
      ['/%5cwindows.json', 400],
      ['/.secret', 404],
      ['/assets//app.js', 404],
      ['/assets/app.js/', 404],
      ['/debug.map', 404],
      ['/notes.txt', 404],
      ['/data.json?download=1', 400],
    ];
    for (const [path, status] of cases) expect((await value.send({ path })).status).toBe(status);
  });

  it('never falls back API/internal paths to index and rejects methods outside GET/HEAD', async () => {
    const value = await startServer(await populatedRoot());
    expect((await value.send({ path: '/api/missing', headers: { Accept: 'text/html' } })).status).toBe(404);
    expect((await value.send({ path: '/internal/missing', headers: { Accept: 'text/html' } })).status).toBe(404);
    const post = await value.send({ method: 'POST', path: '/' });
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe('GET, HEAD');
  });

  it('fails closed when canonical resolution leaves the configured root', async () => {
    const root = await populatedRoot();
    let calls = 0;
    const value = await startServer(root, {
      realpath: (async (path) => {
        calls += 1;
        return calls === 1 ? String(path) : join(await temporaryRoot(), 'escaped.html');
      }) as typeof import('node:fs/promises').realpath,
    });
    expect((await value.send()).status).toBe(404);
  });

  it('rejects files above the fixed 8 MiB cap without reading them', async () => {
    const root = await populatedRoot();
    const huge = join(root, 'huge.json');
    await writeFile(huge, Buffer.alloc((8 << 20) + 1));
    const value = await startServer(root);
    expect((await value.send({ path: '/huge.json' })).status).toBe(413);
  });

  it('requires an explicit absolute static root', () => {
    const routes = {} as LocalRoutes;
    expect(() => new LocalHttpServer({
      routes, staticRoot: 'dist/ui', logger: { debug() {}, info() {}, warn() {}, error() {} },
    })).toThrow(RangeError);
  });
});
