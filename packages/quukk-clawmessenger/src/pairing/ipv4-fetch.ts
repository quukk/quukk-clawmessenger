import { lookup as defaultLookup } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import { Readable } from 'node:stream';

export type IPv4Lookup = LookupFunction;

const systemIPv4Lookup = defaultLookup as IPv4Lookup;

function responseHeaders(source: NodeJS.Dict<string | string[]>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(source)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.append(name, value);
    }
  }
  return headers;
}

function writeRequestBody(
  request: ReturnType<typeof httpRequest>,
  body: BodyInit | null | undefined,
): void {
  if (body === undefined || body === null) {
    request.end();
    return;
  }
  if (typeof body === 'string' || body instanceof Uint8Array) {
    request.end(body);
    return;
  }
  if (body instanceof URLSearchParams) {
    request.end(body.toString());
    return;
  }
  if (body instanceof ArrayBuffer) {
    request.end(Buffer.from(body));
    return;
  }
  request.destroy(new TypeError('unsupported_request_body'));
}

export function createIPv4Fetch(lookup: IPv4Lookup = systemIPv4Lookup): typeof globalThis.fetch {
  return ((input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return Promise.reject(new TypeError('unsupported_protocol'));
    }
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init.headers).forEach((value, name) => headers.set(name, value));
    const method = init.method ?? (input instanceof Request ? input.method : 'GET');
    const requestBody = init.body ?? (input instanceof Request ? input.body : undefined);

    return new Promise<Response>((resolve, reject) => {
      const requestFactory = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const request = requestFactory({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port === '' ? undefined : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method,
        headers: Object.fromEntries(headers.entries()),
        family: 4,
        lookup: (hostname, _options, callback) => {
          lookup(hostname, { family: 4, all: false }, callback);
        },
        signal: init.signal ?? undefined,
      }, (incoming) => {
        const status = incoming.statusCode ?? 0;
        if (status < 200 || status > 599) {
          incoming.destroy();
          reject(new TypeError('invalid_response_status'));
          return;
        }
        const noBody = method === 'HEAD' || status === 204 || status === 205 || status === 304;
        const body = noBody
          ? null
          : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>);
        resolve(new Response(body, {
          status,
          statusText: incoming.statusMessage,
          headers: responseHeaders(incoming.headersDistinct),
        }));
      });
      request.once('error', reject);
      writeRequestBody(request, requestBody);
    });
  }) as typeof globalThis.fetch;
}
