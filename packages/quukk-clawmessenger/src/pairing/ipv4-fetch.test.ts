// @vitest-environment node

import { createServer } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { createIPv4Fetch, type IPv4Lookup } from './ipv4-fetch.js';

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  })));
});

describe('createIPv4Fetch', () => {
  it('connects through an IPv4-only DNS lookup while preserving the URL hostname', async () => {
    const server = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ host: request.headers.host }));
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('missing_test_address');

    const lookup: IPv4Lookup = (_hostname, options, callback) => {
      if (options.family !== 4) {
        callback(new Error('expected_ipv4_lookup'), '', 4);
        return;
      }
      callback(null, '127.0.0.1', 4);
    };
    const ipv4Fetch = createIPv4Fetch(lookup);
    const response = await ipv4Fetch(`http://pairing.test:${address.port}/health`, {
      headers: { Accept: 'application/json' },
      redirect: 'manual',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ host: `pairing.test:${address.port}` });
  });
});
