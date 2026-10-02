import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { readFile } from 'node:fs/promises';
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  HEALTH_PATHS,
  SERVICE_NAME,
  buildHealthPayload,
  createHealthServer,
  resolvePort,
} from '../src/health/server.js';
import { createCapturingLogger } from '../src/utils/logger.js';
import { fakeDiscordToken, fakeApiKey } from './helpers/fake-secrets.js';

/**
 * The HTTP health endpoint.
 *
 * Requests go over a real socket, but only to 127.0.0.1 on a port the server
 * itself chose - nothing leaves the machine and no fixed port can collide with
 * another test run.
 *
 * The client is `node:http` with `agent: false` rather than `fetch`: the global
 * fetch keeps a keep-alive pool alive, and an idle pooled socket holds the
 * event loop open, which hangs the test process after the last assertion.
 */

function httpRequest(url, { method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, agent: false }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () =>
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body,
          json: () => JSON.parse(body),
        }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Starts a server on an ephemeral port, and guarantees it is closed when the
 * test ends - including when an assertion throws first.
 */
async function startHealth(t, options = {}) {
  const health = createHealthServer({ port: 0, ...options });
  const started = await health.start();
  assert.equal(started.listening, true, `the server did not bind: ${started.reason}`);
  t.after(() => health.stop());

  const { port } = health.address();
  return { health, port, base: `http://127.0.0.1:${port}` };
}

/** A port nothing is listening on right now. */
function freePort() {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/* -------------------------------------------------------------------------- */
/* The payload                                                                 */
/* -------------------------------------------------------------------------- */

test('the payload has exactly the documented shape', () => {
  const payload = buildHealthPayload({
    status: { pompAI: true, pompMusic: true },
    startedAt: 1_000_000,
    now: () => 1_000_000 + 1234 * 1000,
  });

  assert.deepEqual(payload, {
    ok: true,
    service: SERVICE_NAME,
    pompAI: true,
    pompMusic: true,
    uptimeSeconds: 1234,
  });
  assert.equal(SERVICE_NAME, 'PompBots');
});

test('missing status flags report false rather than undefined', () => {
  const payload = buildHealthPayload({ status: {}, startedAt: 0, now: () => 5000 });
  assert.equal(payload.pompAI, false);
  assert.equal(payload.pompMusic, false);
  assert.equal(payload.uptimeSeconds, 5);
  assert.equal(payload.ok, true, 'the service is answering, so it is up');
});

test('uptime never goes negative when the clock steps backwards', () => {
  const payload = buildHealthPayload({ status: {}, startedAt: 10_000, now: () => 0 });
  assert.equal(payload.uptimeSeconds, 0);
});

test('the payload carries no secret and no identifier', () => {
  // Planted the way a leak would actually happen: a value that reached the
  // process through the environment.
  // Token- and key-SHAPED, assembled at runtime so the repository text never
  // contains a credential-shaped literal. See tests/helpers/fake-secrets.js.
  const secrets = {
    DISCORD_TOKEN: fakeDiscordToken(),
    AI_API_KEY: fakeApiKey(),
    ITAD_API_KEY: 'itad-secret-key',
    POMPMUSIC_TOKEN: 'pompmusic-secret-token',
    DISCORD_GUILD_ID: '123456789012345678',
  };

  const payload = buildHealthPayload({ status: { pompAI: true, pompMusic: true }, startedAt: 0, now: () => 1000 });
  const body = JSON.stringify(payload);

  for (const [key, value] of Object.entries(secrets)) {
    assert.ok(!body.includes(value), `${key} leaked into the health payload`);
  }
  // And structurally: the only keys are the five allowed ones.
  assert.deepEqual(Object.keys(payload).sort(), ['ok', 'pompAI', 'pompMusic', 'service', 'uptimeSeconds']);
  assert.ok(
    !/token|key|secret|guild|env|config|database|sqlite/i.test(body),
    'the payload mentions something it should not',
  );
});

/* -------------------------------------------------------------------------- */
/* Routing                                                                     */
/* -------------------------------------------------------------------------- */

test('GET / and /health both answer 200 JSON', async (t) => {
  const { base } = await startHealth(t, { status: { pompAI: true, pompMusic: false } });

  for (const path of HEALTH_PATHS) {
    const response = await httpRequest(`${base}${path}`);
    assert.equal(response.status, 200, `${path} did not answer 200`);
    assert.match(response.headers['content-type'], /application\/json/);
    assert.equal(response.headers['cache-control'], 'no-store');

    const body = response.json();
    assert.equal(body.ok, true);
    assert.equal(body.service, SERVICE_NAME);
    assert.equal(body.pompAI, true);
    assert.equal(body.pompMusic, false);
    assert.equal(typeof body.uptimeSeconds, 'number');
  }
});

test('the status is read per request, not cached at startup', async (t) => {
  const status = { pompAI: false, pompMusic: false };
  const { base } = await startHealth(t, { status });

  assert.equal((await httpRequest(`${base}/health`)).json().pompAI, false);

  // PompMusic comes up later; the endpoint must reflect that.
  status.pompAI = true;
  status.pompMusic = true;

  const body = (await httpRequest(`${base}/health`)).json();
  assert.equal(body.pompAI, true);
  assert.equal(body.pompMusic, true);
});

test('an unknown path is a 404', async (t) => {
  const { base } = await startHealth(t);
  const response = await httpRequest(`${base}/admin`);

  assert.equal(response.status, 404);
  assert.equal(response.json().ok, false);
  assert.equal(response.json().error, 'not-found');
});

test('a write method is refused', async (t) => {
  const { base } = await startHealth(t);
  const response = await httpRequest(`${base}/health`, { method: 'POST' });

  assert.equal(response.status, 405);
  assert.equal(response.headers.allow, 'GET, HEAD');
});

test('HEAD answers without a body', async (t) => {
  const { base } = await startHealth(t);
  const response = await httpRequest(`${base}/health`, { method: 'HEAD' });

  assert.equal(response.status, 200);
  assert.equal(response.body, '');
});

/* -------------------------------------------------------------------------- */
/* Binding                                                                     */
/* -------------------------------------------------------------------------- */

test('the default host is the wildcard a platform expects', () => {
  assert.equal(DEFAULT_HOST, '0.0.0.0');
  assert.equal(DEFAULT_PORT, 10000);
});

test('the server binds 0.0.0.0, not loopback', async (t) => {
  const health = createHealthServer({ port: 0, host: DEFAULT_HOST });
  await health.start();
  t.after(() => health.stop());

  const address = health.address();
  assert.equal(address.address, '0.0.0.0', `bound ${address.address} instead of the wildcard`);
  assert.ok(address.port > 0);
});

test('PORT is respected', async (t) => {
  const port = await freePort();
  const health = createHealthServer({ env: { PORT: String(port) } });
  assert.equal(health.port, port);

  const started = await health.start();
  assert.equal(started.listening, true);
  t.after(() => health.stop());

  assert.equal(health.address().port, port, 'the configured port was not used');
  assert.equal((await httpRequest(`http://127.0.0.1:${port}/health`)).status, 200);
});

test('an unusable PORT falls back to 10000 rather than crashing', () => {
  assert.equal(resolvePort('8080'), 8080);
  assert.equal(resolvePort('  8080  '), 8080);
  assert.equal(resolvePort('0'), 0, 'ephemeral is a legitimate request');

  for (const bad of [undefined, null, '', '   ', 'abc', '-1', '70000', '80.5', 'NaN']) {
    assert.equal(resolvePort(bad), DEFAULT_PORT, `${JSON.stringify(bad)} was accepted`);
  }
});

test('an explicit port argument beats the environment', () => {
  assert.equal(createHealthServer({ port: 4000, env: { PORT: '5000' } }).port, 4000);
});

test('a port already in use is logged and does not throw', async (t) => {
  const port = await freePort();
  const first = createHealthServer({ port });
  await first.start();
  t.after(() => first.stop());

  const { logger, text } = createCapturingLogger({ level: 'debug' });
  const second = createHealthServer({ port, logger });
  const result = await second.start();
  t.after(() => second.stop());

  assert.equal(result.listening, false, 'a second bind on the same port claimed success');
  assert.equal(result.reason, 'EADDRINUSE');
  // The failure is reported, not swallowed.
  assert.match(text(), /could not bind/);
  assert.match(text(), /EADDRINUSE/);
  // And the first server is untouched: one bot losing a port does not take the
  // other down.
  assert.equal((await httpRequest(`http://127.0.0.1:${port}/health`)).status, 200);
});

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                   */
/* -------------------------------------------------------------------------- */

test('stop releases the port and is safe to call twice', async () => {
  const port = await freePort();
  const health = createHealthServer({ port });
  await health.start();

  assert.equal(await health.stop(), true);
  assert.equal(await health.stop(), false, 'a second stop reported work it did not do');
  assert.equal(health.listening, false);

  // The port is free again, which is what makes a redeploy able to bind it.
  const rebound = createHealthServer({ port });
  assert.equal((await rebound.start()).listening, true);
  await rebound.stop();
});

test('stop closes keep-alive connections rather than waiting for them', async (t) => {
  const { health, base } = await startHealth(t);
  // A completed request leaves the socket in the keep-alive pool, which is
  // exactly what makes a bare server.close() hang behind a proxy.
  await httpRequest(`${base}/health`);

  const stopped = await Promise.race([
    health.stop().then(() => 'stopped'),
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve('timed-out'), 2000);
      timer.unref();
    }),
  ]);
  assert.equal(stopped, 'stopped', 'stop() waited on an idle keep-alive connection');
});

test('starting twice does not bind twice', async (t) => {
  const { health, base } = await startHealth(t);
  const before = health.address();
  const again = await health.start();

  assert.equal(again.listening, true);
  // The same socket, not a second one that quietly replaced it.
  assert.deepEqual(health.address(), before);
  assert.equal((await httpRequest(`${base}/health`)).status, 200);
});

/* -------------------------------------------------------------------------- */
/* Independence from Discord                                                   */
/* -------------------------------------------------------------------------- */

test('the health module never references Discord or a credential', async () => {
  const source = await readFile(new URL('../src/health/server.js', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  assert.ok(!/discord/i.test(code), 'the health server references discord');
  assert.ok(!/token|apiKey|api_key/i.test(code), 'the health server references a credential');
  // No environment VALUE is read here. `process.env` may only appear as the
  // default argument, which the caller can override - never as `process.env.X`.
  assert.ok(!/process\.env\./.test(code), 'the health server reads an environment value directly');

  // And the function that builds the response cannot see the environment at
  // all, which is the property that makes a leak structurally impossible.
  const payloadBuilder = code.slice(
    code.indexOf('export function buildHealthPayload'),
    code.indexOf('export function createHealthServer'),
  );
  assert.ok(payloadBuilder.length > 0, 'the payload builder was not found');
  assert.ok(!/env|process/i.test(payloadBuilder), 'the payload builder can reach the environment');
});
