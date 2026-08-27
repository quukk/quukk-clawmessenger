import { realpath as fsRealpath, readFile as fsReadFile, stat as fsStat } from 'node:fs/promises';
import {
  createServer as nodeCreateServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, isAbsolute, relative, resolve } from 'node:path';

import {
  type HttpLogger,
  LocalRoutes,
  type LocalRequestContext,
  type PublicErrorCode,
  writeHttpError,
} from './routes.js';
import { securityHeaders } from './security.js';

const HOST = '127.0.0.1' as const;
const MAX_HEADER_BYTES = 16 << 10;
const MAX_HEADERS = 64;
const MAX_CONNECTIONS = 32;
const HEADERS_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 15_000;
const KEEP_ALIVE_TIMEOUT_MS = 5_000;
const CLOSE_GRACE_MS = 2_000;
const MAX_STATIC_BYTES = 8 << 20;

const MIME_TYPES = Object.freeze<Record<string, string>>({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
});

export interface LocalHttpServerDependencies {
  createServer?: typeof nodeCreateServer;
  realpath?: typeof fsRealpath;
  stat?: typeof fsStat;
  readFile?: typeof fsReadFile;
}

export interface LocalHttpServerOptions {
  routes: LocalRoutes;
  staticRoot: string;
  logger: HttpLogger;
  dependencies?: LocalHttpServerDependencies;
}

type Dependencies = Required<LocalHttpServerDependencies>;
type ValidatedTarget = { pathname: string };

class ServerFailure extends Error {
  constructor(readonly code: PublicErrorCode) { super(code); }
}

function rawHeaderValues(request: IncomingMessage, name: string): string[] {
  const lower = name.toLowerCase();
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === lower) values.push(request.rawHeaders[index + 1] ?? '');
  }
  return values;
}

function validateTarget(target: string | undefined): ValidatedTarget {
  if (
    target === undefined
    || target.length === 0
    || !target.startsWith('/')
    || target.startsWith('//')
    || target.includes('#')
    || target.includes('\\')
    || target.includes('\0')
    || /[^\x21-\x7e]/.test(target)
  ) throw new ServerFailure('invalid_request');
  if (/%(?:2f|5c|00)/i.test(target)) throw new ServerFailure('invalid_request');
  for (let index = target.indexOf('%'); index >= 0; index = target.indexOf('%', index + 1)) {
    if (!/^[0-9a-f]{2}$/i.test(target.slice(index + 1, index + 3))) {
      throw new ServerFailure('invalid_request');
    }
  }
  const query = target.indexOf('?');
  if (query !== -1) throw new ServerFailure('invalid_request');
  try {
    decodeURIComponent(target);
  } catch {
    throw new ServerFailure('invalid_request');
  }
  return { pathname: target };
}

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function sendStatic(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  contentType: string,
  size: number,
  body?: Buffer,
): void {
  for (const [name, value] of Object.entries(securityHeaders())) response.setHeader(name, value);
  response.statusCode = status;
  response.setHeader('Content-Type', contentType);
  response.setHeader('Content-Length', String(size));
  response.end(request.method === 'HEAD' ? undefined : body);
}

function sendClientError(socket: import('node:stream').Duplex): void {
  if (!socket.writable) return;
  const body = Buffer.from(JSON.stringify({
    error: { code: 'invalid_request', category: 'policy', retryable: false },
  }), 'utf8');
  const headers = [
    'HTTP/1.1 400 Bad Request',
    ...Object.entries(securityHeaders()).map(([name, value]) => `${name}: ${value}`),
    'Content-Type: application/json; charset=utf-8',
    `Content-Length: ${body.byteLength}`,
    'Connection: close',
    '',
    '',
  ].join('\r\n');
  socket.end(Buffer.concat([Buffer.from(headers, 'ascii'), body]));
}

export class LocalHttpServer {
  readonly #routes: LocalRoutes;
  readonly #staticRoot: string;
  readonly #dependencies: Dependencies;
  #canonicalStaticRoot?: string;
  #server?: Server;
  #hostHeader?: string;
  #origin?: string;

  constructor(options: LocalHttpServerOptions) {
    if (!isAbsolute(options.staticRoot) || options.staticRoot.includes('\0')) {
      throw new RangeError('invalid_static_root');
    }
    this.#routes = options.routes;
    this.#staticRoot = options.staticRoot;
    this.#dependencies = {
      createServer: options.dependencies?.createServer ?? nodeCreateServer,
      realpath: options.dependencies?.realpath ?? fsRealpath,
      stat: options.dependencies?.stat ?? fsStat,
      readFile: options.dependencies?.readFile ?? fsReadFile,
    };
  }

  async start(): Promise<{ host: '127.0.0.1'; port: number; origin: string }> {
    if (this.#server !== undefined) throw new RangeError('http_server_already_started');
    await this.#resolveStaticRoot();
    const server = this.#dependencies.createServer(
      { maxHeaderSize: MAX_HEADER_BYTES },
      (request, response) => { void this.#handle(request, response); },
    );
    this.#server = server;
    server.maxHeadersCount = MAX_HEADERS;
    server.headersTimeout = HEADERS_TIMEOUT_MS;
    server.requestTimeout = REQUEST_TIMEOUT_MS;
    server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
    server.maxConnections = MAX_CONNECTIONS;
    server.on('checkContinue', (request, response) => { void this.#handle(request, response); });
    server.on('clientError', (_error, socket) => sendClientError(socket));

    await new Promise<void>((resolvePromise, rejectPromise) => {
      const failed = (error: Error) => {
        server.off('listening', listening);
        rejectPromise(error);
      };
      const listening = () => {
        server.off('error', failed);
        resolvePromise();
      };
      server.once('error', failed);
      server.once('listening', listening);
      server.listen(0, HOST);
    });
    const address = server.address() as AddressInfo | null;
    if (address === null || address.address !== HOST || address.family !== 'IPv4') {
      await this.close();
      throw new Error('http_listener_invalid');
    }
    this.#hostHeader = `${HOST}:${address.port}`;
    this.#origin = `http://${this.#hostHeader}`;
    return { host: HOST, port: address.port, origin: this.#origin };
  }

  async close(): Promise<void> {
    const server = this.#server;
    if (server === undefined) return;
    this.#server = undefined;
    await new Promise<void>((resolvePromise) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise();
      };
      const timer = setTimeout(() => {
        server.closeAllConnections();
        finish();
      }, CLOSE_GRACE_MS);
      server.close(() => finish());
      server.closeIdleConnections();
    });
    this.#hostHeader = undefined;
    this.#origin = undefined;
  }

  async #resolveStaticRoot(): Promise<void> {
    try {
      const canonical = await this.#dependencies.realpath(this.#staticRoot);
      const details = await this.#dependencies.stat(canonical);
      this.#canonicalStaticRoot = details.isDirectory() ? canonical : undefined;
    } catch {
      this.#canonicalStaticRoot = undefined;
    }
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.socket.remoteAddress !== HOST) throw new ServerFailure('host_rejected');
      const hosts = rawHeaderValues(request, 'host');
      if (hosts.length !== 1 || hosts[0] !== this.#hostHeader) throw new ServerFailure('host_rejected');
      const target = validateTarget(request.url);
      const context: LocalRequestContext = {
        peer: HOST,
        host: this.#hostHeader!,
        origin: this.#origin!,
        pathname: target.pathname,
        method: request.method ?? '',
      };
      const result = await this.#routes.handle(request, response, context);
      if (result === 'static') await this.#static(request, response, target.pathname);
    } catch (error) {
      const code = error instanceof ServerFailure ? error.code : 'internal_error';
      writeHttpError(request, response, code);
    }
  }

  async #static(request: IncomingMessage, response: ServerResponse, rawPathname: string): Promise<void> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      writeHttpError(request, response, 'method_not_allowed', { Allow: 'GET, HEAD' });
      return;
    }
    const root = this.#canonicalStaticRoot;
    if (root === undefined) {
      writeHttpError(request, response, 'ui_unavailable');
      return;
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(rawPathname);
    } catch {
      writeHttpError(request, response, 'invalid_request');
      return;
    }
    if (pathname.includes('\\') || pathname.includes('\0')) {
      writeHttpError(request, response, 'invalid_request');
      return;
    }
    const segments = pathname.slice(1).split('/');
    if (
      pathname !== '/'
      && segments.some((segment) => segment === '' || segment === '.' || segment === '..' || segment.startsWith('.'))
    ) {
      writeHttpError(request, response, 'not_found');
      return;
    }
    const acceptsHtml = rawHeaderValues(request, 'accept').some((value) =>
      value.split(',').some((entry) => entry.trim().split(';', 1)[0]?.toLowerCase() === 'text/html'),
    );
    const requested = pathname === '/'
      ? ['index.html']
      : extname(segments.at(-1)!) === '' && acceptsHtml
        ? ['index.html']
        : segments;
    const extension = extname(requested.at(-1)!);
    const contentType = MIME_TYPES[extension];
    if (contentType === undefined) {
      writeHttpError(request, response, 'not_found');
      return;
    }
    const lexicalCandidate = resolve(root, ...requested);
    if (!contained(root, lexicalCandidate)) {
      writeHttpError(request, response, 'not_found');
      return;
    }
    let candidate: string;
    let details: Awaited<ReturnType<typeof fsStat>>;
    try {
      candidate = await this.#dependencies.realpath(lexicalCandidate);
      if (!contained(root, candidate)) throw new ServerFailure('not_found');
      details = await this.#dependencies.stat(candidate);
    } catch (error) {
      const code = error instanceof ServerFailure || ['ENOENT', 'ENOTDIR', 'EACCES'].includes(errorCode(error) ?? '')
        ? 'not_found'
        : 'internal_error';
      writeHttpError(request, response, code);
      return;
    }
    if (!details.isFile()) {
      writeHttpError(request, response, 'not_found');
      return;
    }
    if (!Number.isSafeInteger(details.size) || details.size < 0 || details.size > MAX_STATIC_BYTES) {
      writeHttpError(request, response, 'body_too_large');
      return;
    }
    if (request.method === 'HEAD') {
      sendStatic(request, response, 200, contentType, details.size);
      return;
    }
    try {
      const body = await this.#dependencies.readFile(candidate);
      if (!Buffer.isBuffer(body) || body.byteLength !== details.size || body.byteLength > MAX_STATIC_BYTES) {
        throw new ServerFailure('internal_error');
      }
      sendStatic(request, response, 200, contentType, body.byteLength, body);
    } catch {
      writeHttpError(request, response, 'internal_error');
    }
  }
}
