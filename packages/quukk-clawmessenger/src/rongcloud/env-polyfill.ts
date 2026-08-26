import { Buffer } from 'node:buffer';
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { request as requestHttp } from 'node:http';
import { request as requestHttps } from 'node:https';

import * as fakeIndexedDb from 'fake-indexeddb';
import { JSDOM } from 'jsdom';
import WebSocket from 'ws';

export const MAX_XHR_RESPONSE_BYTES = 1024 * 1024;

const MAX_XHR_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_XHR_TIMEOUT_MS = 30_000;
const MAX_XHR_TIMEOUT_MS = 60_000;
const activeRequests = new Set<NodeXMLHttpRequest>();

type ReadyStateHandler = (() => void) | null;

function normalizedHeaders(headers: IncomingHttpHeaders): Map<string, string> {
  const result = new Map<string, string>();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    result.set(name.toLowerCase(), Array.isArray(value) ? value.join(', ') : value);
  }
  return result;
}

function requestBody(value: unknown): Buffer | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError('unsupported_xhr_body');
}

/** Minimal HTTP(S)-only XMLHttpRequest for the isolated RongCloud child. */
export class NodeXMLHttpRequest {
  static readonly UNSENT = 0;
  static readonly OPENED = 1;
  static readonly HEADERS_RECEIVED = 2;
  static readonly LOADING = 3;
  static readonly DONE = 4;

  readonly UNSENT = 0;
  readonly OPENED = 1;
  readonly HEADERS_RECEIVED = 2;
  readonly LOADING = 3;
  readonly DONE = 4;

  readyState = NodeXMLHttpRequest.UNSENT;
  status = 0;
  statusText = '';
  responseText = '';
  response: unknown = '';
  responseType = '';
  responseURL = '';
  timeout = DEFAULT_XHR_TIMEOUT_MS;
  withCredentials = false;

  onreadystatechange: ReadyStateHandler = null;
  onload: ReadyStateHandler = null;
  onerror: ReadyStateHandler = null;
  onabort: ReadyStateHandler = null;
  ontimeout: ReadyStateHandler = null;
  onloadend: ReadyStateHandler = null;

  readonly #requestHeaders = new Map<string, { name: string; value: string }>();
  #responseHeaders = new Map<string, string>();
  #method = '';
  #url?: URL;
  #request?: ClientRequest;
  #incoming?: IncomingMessage;
  #timer?: ReturnType<typeof setTimeout>;
  #sent = false;
  #settled = false;

  open(method: string, rawUrl: string, asynchronous = true): void {
    if (!asynchronous) throw new TypeError('synchronous_xhr_not_supported');
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(method)) throw new TypeError('invalid_xhr_method');
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TypeError('unsupported_xhr_protocol');
    if (url.username || url.password) throw new TypeError('xhr_credentials_not_supported');
    if (this.#request && !this.#settled) this.abort();
    this.#method = method.toUpperCase();
    this.#url = url;
    this.#sent = false;
    this.#settled = false;
    this.status = 0;
    this.statusText = '';
    this.responseText = '';
    this.response = '';
    this.responseURL = '';
    this.#requestHeaders.clear();
    this.#responseHeaders.clear();
    this.#setReadyState(NodeXMLHttpRequest.OPENED);
  }

  setRequestHeader(name: string, value: string): void {
    if (this.readyState !== NodeXMLHttpRequest.OPENED || this.#sent) throw new Error('xhr_invalid_state');
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n]/.test(value)) {
      throw new TypeError('invalid_xhr_header');
    }
    const key = name.toLowerCase();
    const previous = this.#requestHeaders.get(key);
    this.#requestHeaders.set(key, {
      name: previous?.name ?? name,
      value: previous ? `${previous.value}, ${value}` : value,
    });
  }

  getResponseHeader(name: string): string | null {
    if (this.readyState < NodeXMLHttpRequest.HEADERS_RECEIVED) return null;
    return this.#responseHeaders.get(name.toLowerCase()) ?? null;
  }

  getAllResponseHeaders(): string {
    if (this.readyState < NodeXMLHttpRequest.HEADERS_RECEIVED) return '';
    return [...this.#responseHeaders]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => `${name}: ${value}\r\n`)
      .join('');
  }

  send(body?: string | ArrayBuffer | ArrayBufferView | null): void {
    if (this.readyState !== NodeXMLHttpRequest.OPENED || this.#sent || !this.#url) {
      throw new Error('xhr_invalid_state');
    }
    const payload = requestBody(body);
    if ((payload?.byteLength ?? 0) > MAX_XHR_REQUEST_BYTES) throw new RangeError('xhr_request_too_large');
    this.#sent = true;
    this.#settled = false;
    activeRequests.add(this);

    const headers = Object.fromEntries(
      [...this.#requestHeaders.values()].map(({ name, value }) => [name, value]),
    );
    const request = (this.#url.protocol === 'https:' ? requestHttps : requestHttp)(
      this.#url,
      { method: this.#method, headers, agent: false },
      (response) => this.#readResponse(response),
    );
    this.#request = request;
    request.once('error', () => this.#finishError(false));

    const requestedTimeout = Number.isFinite(this.timeout) && this.timeout > 0
      ? Math.min(this.timeout, MAX_XHR_TIMEOUT_MS)
      : DEFAULT_XHR_TIMEOUT_MS;
    this.#timer = setTimeout(() => {
      if (this.#settled) return;
      request.destroy();
      this.#finishError(true);
    }, requestedTimeout);

    if (payload) request.end(payload);
    else request.end();
  }

  abort(): void {
    if (this.#settled || (!this.#sent && this.readyState === NodeXMLHttpRequest.UNSENT)) return;
    this.#settled = true;
    this.status = 0;
    this.statusText = '';
    this.responseText = '';
    this.response = '';
    this.#incoming?.destroy();
    this.#request?.destroy();
    this.#cleanup();
    this.#setReadyState(NodeXMLHttpRequest.DONE);
    this.#call(this.onabort);
    this.#call(this.onloadend);
  }

  #readResponse(response: IncomingMessage): void {
    if (this.#settled) {
      response.destroy();
      return;
    }
    this.#incoming = response;
    this.status = response.statusCode ?? 0;
    this.statusText = response.statusMessage ?? '';
    this.responseURL = this.#url?.toString() ?? '';
    this.#responseHeaders = normalizedHeaders(response.headers);
    this.#setReadyState(NodeXMLHttpRequest.HEADERS_RECEIVED);

    const chunks: Buffer[] = [];
    let bytes = 0;
    response.on('data', (chunk: Buffer | Uint8Array | string) => {
      if (this.#settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > MAX_XHR_RESPONSE_BYTES) {
        response.destroy();
        this.#request?.destroy();
        this.#finishError(false);
        return;
      }
      chunks.push(buffer);
      this.#setReadyState(NodeXMLHttpRequest.LOADING);
    });
    response.once('end', () => {
      if (this.#settled) return;
      const buffer = Buffer.concat(chunks, bytes);
      this.responseText = buffer.toString('utf8');
      this.response = this.responseType === 'arraybuffer'
        ? buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
        : this.responseText;
      this.#settled = true;
      this.#cleanup();
      this.#setReadyState(NodeXMLHttpRequest.DONE);
      this.#call(this.onload);
      this.#call(this.onloadend);
    });
    response.once('error', () => this.#finishError(false));
    response.once('aborted', () => this.#finishError(false));
  }

  #finishError(timedOut: boolean): void {
    if (this.#settled) return;
    this.#settled = true;
    this.status = 0;
    this.statusText = '';
    this.responseText = '';
    this.response = '';
    this.#incoming?.destroy();
    this.#request?.destroy();
    this.#cleanup();
    this.#setReadyState(NodeXMLHttpRequest.DONE);
    this.#call(timedOut ? this.ontimeout : this.onerror);
    this.#call(this.onloadend);
  }

  #cleanup(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#request = undefined;
    this.#incoming = undefined;
    activeRequests.delete(this);
  }

  #setReadyState(value: number): void {
    this.readyState = value;
    this.#call(this.onreadystatechange);
  }

  #call(handler: ReadyStateHandler): void {
    try {
      handler?.call(this);
    } catch {
      // Event consumers cannot retain transport resources.
    }
  }
}

class RestrictedWebSocket extends WebSocket {
  constructor(address: string | URL, protocols?: string | string[]) {
    const url = new URL(address.toString());
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new TypeError('unsupported_websocket_protocol');
    super(url, protocols);
  }
}

type MutableGlobal = Record<PropertyKey, unknown>;

function defineValue(target: MutableGlobal, key: PropertyKey, value: unknown): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: false,
    writable: true,
    value,
  });
}

export function installWorkerPolyfills(): () => void {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://localhost/' });
  const globalObject = globalThis as unknown as MutableGlobal;
  const windowObject = dom.window as unknown as MutableGlobal;
  const previous = new Map<PropertyKey, PropertyDescriptor | undefined>();
  const installGlobal = (key: PropertyKey, value: unknown): void => {
    if (!previous.has(key)) previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    defineValue(globalObject, key, value);
  };

  installGlobal('window', dom.window);
  installGlobal('document', dom.window.document);
  installGlobal('navigator', dom.window.navigator);
  installGlobal('location', dom.window.location);
  installGlobal('localStorage', dom.window.localStorage);
  installGlobal('sessionStorage', dom.window.sessionStorage);

  for (const [key, value] of Object.entries(fakeIndexedDb)) {
    if (!key.startsWith('IDB') && key !== 'indexedDB') continue;
    installGlobal(key, value);
    defineValue(windowObject, key, value);
  }

  installGlobal('WebSocket', RestrictedWebSocket);
  installGlobal('XMLHttpRequest', NodeXMLHttpRequest);
  defineValue(windowObject, 'WebSocket', RestrictedWebSocket);
  defineValue(windowObject, 'XMLHttpRequest', NodeXMLHttpRequest);

  const typedGlobals = {
    Buffer,
    ArrayBuffer,
    DataView,
    Int8Array,
    Uint8Array,
    Uint8ClampedArray,
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array,
    Float32Array,
    Float64Array,
    BigInt64Array,
    BigUint64Array,
    TextDecoder,
    TextEncoder,
  };
  for (const [key, value] of Object.entries(typedGlobals)) defineValue(windowObject, key, value);

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const request of [...activeRequests]) request.abort();
    for (const [key, descriptor] of [...previous].reverse()) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  };
}
