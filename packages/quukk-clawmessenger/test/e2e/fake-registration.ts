import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { PROVIDERS, type Provider } from '../../src/config/schema.js';
import { RegistrationClient } from '../../src/registration/client.js';
import { CLAWMESSENGER_NODE_CAPABILITIES } from '../../src/registration/capabilities.js';

export const E2E_MAC_SENTINEL = '02:11:22:33:44:55';

type RegistrationRecord = { provider: Provider; nodeId: string };
type ProofOwner = RegistrationRecord & { token: string };

function containsString(value: unknown, sentinel: string, seen = new Set<object>()): boolean {
  if (typeof value === 'string') return value.includes(sentinel);
  if (typeof value !== 'object' || value === null || seen.has(value)) return false;
  seen.add(value);
  return Object.entries(value).some(([key, entry]) =>
    key.includes(sentinel) || containsString(entry, sentinel, seen));
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const responseBody = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(responseBody)),
  });
  response.end(responseBody);
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    bytes += buffer.byteLength;
    if (bytes > 64 * 1024) throw new Error('fake_registration_body_too_large');
    chunks.push(buffer);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('fake_registration_body_invalid');
  }
  return value as Record<string, unknown>;
}

export class FakeRegistrationServer {
  readonly appKey = 'E2E_APP_KEY_SENTINEL_7';
  readonly #failed = new Set<Provider>();
  readonly #identityMismatch = new Set<Provider>();
  readonly #proofOwners = new Map<string, ProofOwner>();
  readonly #records: RegistrationRecord[] = [];
  readonly #macs = new Set<string>();
  #server?: Server;
  #serverUrl?: string;
  #sequence = 0;
  #forbiddenSecret?: string;
  #rawSecretSeen = false;

  async start(): Promise<string> {
    if (this.#serverUrl !== undefined) return this.#serverUrl;
    const server = createServer((request, response) => {
      void this.#handle(request, response).catch(() => json(response, 500, { code: 500 }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    this.#server = server;
    this.#serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/im`;
    return this.#serverUrl;
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    this.#serverUrl = undefined;
    if (server === undefined) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    });
  }

  client(): RegistrationClient {
    return new RegistrationClient({
      networkInterfaces: (() => ({
        e2e: [{
          address: '192.0.2.10',
          netmask: '255.255.255.0',
          family: 'IPv4',
          mac: E2E_MAC_SENTINEL,
          internal: false,
          cidr: '192.0.2.10/24',
        }],
      })) as never,
      sleep: async () => undefined,
      random: () => 0,
      timeoutMs: 2_000,
    });
  }

  fail(provider: Provider): void {
    this.#failed.add(provider);
  }

  mismatchNext(provider: Provider): void {
    this.#identityMismatch.add(provider);
  }

  forbidRawSecret(secret: string): void {
    this.#forbiddenSecret = secret;
  }

  registrations(): readonly RegistrationRecord[] {
    return this.#records.map((record) => ({ ...record }));
  }

  tokens(): readonly string[] {
    return [...this.#proofOwners.values()].map(({ token }) => token);
  }

  proofs(): readonly string[] {
    return [...this.#proofOwners.keys()];
  }

  macs(): readonly string[] {
    return [...this.#macs];
  }

  rawSecretSeen(): boolean {
    return this.#rawSecretSeen;
  }

  isRunning(): boolean {
    return this.#server !== undefined;
  }

  #observeRawSecret(value: unknown): void {
    if (this.#forbiddenSecret !== undefined
      && containsString(value, this.#forbiddenSecret)) this.#rawSecretSeen = true;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.#observeRawSecret(request.url ?? '');
    this.#observeRawSecret(request.headers);
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (request.method === 'GET' && pathname === '/im/api/config/rongcloud') {
      json(response, 200, { code: 200, data: { appKey: this.appKey } });
      return;
    }
    if (request.method !== 'POST' || pathname !== '/im/api/ai/register') {
      json(response, 404, { code: 404 });
      return;
    }

    const input = await body(request);
    this.#observeRawSecret(input);
    const provider = input.node_type;
    const proof = request.headers['x-node-enrollment-token'];
    if (typeof provider !== 'string' || !PROVIDERS.includes(provider as Provider)
      || typeof proof !== 'string' || !/^qce_v1_[A-Za-z0-9_-]{43}$/.test(proof)) {
      json(response, 400, { code: 400 });
      return;
    }
    const typedProvider = provider as Provider;
    if (this.#failed.has(typedProvider)) {
      json(response, 200, { code: 500 });
      return;
    }
    const owner = this.#proofOwners.get(proof);
    if (owner !== undefined && owner.provider !== typedProvider) {
      json(response, 403, { code: 403 });
      return;
    }
    const mac = input.mac_address;
    if (typeof mac === 'string') this.#macs.add(mac);

    const created = owner ?? (() => {
      this.#sequence += 1;
      return {
        provider: typedProvider,
        nodeId: `${typedProvider}_e2e_${this.#sequence}`,
        token: `E2E_${typedProvider.toUpperCase()}_TOKEN_${this.#sequence}_SENTINEL`,
      };
    })();
    this.#proofOwners.set(proof, created);

    if (this.#identityMismatch.delete(typedProvider)) {
      json(response, 200, {
        code: 200,
        data: {
          node_id: created.nodeId,
          node_type: typedProvider === 'hermes' ? 'codex' : 'hermes',
          token: created.token,
          capabilities: [...CLAWMESSENGER_NODE_CAPABILITIES],
        },
      });
      return;
    }
    if (!this.#records.some(({ provider: seenProvider, nodeId }) =>
      seenProvider === typedProvider && nodeId === created.nodeId)) {
      this.#records.push({ provider: typedProvider, nodeId: created.nodeId });
    }
    json(response, 200, {
      code: 200,
      data: {
        node_id: created.nodeId,
        node_type: typedProvider,
        token: created.token,
        capabilities: [...CLAWMESSENGER_NODE_CAPABILITIES],
      },
    });
  }
}
