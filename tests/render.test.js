import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PLATFORMS, describePersistence, detectPlatform, isInside, stateInventory } from '../src/deploy/platform.js';
import { DEFAULT_PORT, createHealthServer } from '../src/health/server.js';
import { createCapturingLogger, createNullLogger } from '../src/utils/logger.js';
import { main, warnAboutPersistence } from '../src/index.js';
import { createFunService, openFunDatabase } from '../src/fun/index.js';
import { createMusicService } from '../src/music/index.js';
import { normaliseTrack } from '../src/music/source.js';

/**
 * Render deployment readiness.
 *
 * The pieces that matter are the ones that cannot be checked by reading the
 * code: that the port is answering before Discord is contacted, that a refused
 * login does not leave a wedged process, that SIGTERM actually releases what it
 * claims to, and that no file in the deployment contains a secret.
 */

const REPO = path.resolve(import.meta.dirname, '..');

function httpRequest(url, { method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, agent: false }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () =>
        resolve({ status: response.statusCode, body, json: () => JSON.parse(body) }),
      );
    });
    req.on('error', (error) => {
      // "Nothing is listening" is a legitimate answer here - it is how a test
      // asks whether a port was released - so it resolves rather than throws.
      if (error.code === 'ECONNREFUSED') resolve(null);
      else reject(error);
    });
    req.end();
  });
}

function freePort() {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Waits until something answers on the port, or gives up. */
async function waitForHealth(port, { attempts = 100 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await httpRequest(`http://127.0.0.1:${port}/health`);
    if (response && response.status === 200) return response;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return null;
}

/** True when nothing is listening on the port any more. */
async function portIsFree(port) {
  const response = await httpRequest(`http://127.0.0.1:${port}/health`);
  return response === null;
}

/* -------------------------------------------------------------------------- */
/* Platform detection                                                          */
/* -------------------------------------------------------------------------- */

test('Render is detected from its own marker', () => {
  assert.equal(detectPlatform({}), PLATFORMS.LOCAL);
  assert.equal(detectPlatform({ RENDER: 'true' }), PLATFORMS.RENDER);
  assert.equal(detectPlatform({ RENDER: 'TRUE' }), PLATFORMS.RENDER);
  assert.equal(detectPlatform({ RENDER: '1' }), PLATFORMS.RENDER);
  assert.equal(detectPlatform({ RENDER_SERVICE_ID: 'srv-abc' }), PLATFORMS.RENDER);
  assert.equal(detectPlatform({ RENDER_EXTERNAL_HOSTNAME: 'x.onrender.com' }), PLATFORMS.RENDER);
});

test('a bare RENDER=false is not a Render deployment', () => {
  assert.equal(detectPlatform({ RENDER: 'false' }), PLATFORMS.LOCAL);
  assert.equal(detectPlatform({ RENDER: '' }), PLATFORMS.LOCAL);
});

test('DEPLOY_PLATFORM overrides detection in both directions', () => {
  // Forced on, so the Render path can be reproduced on a laptop.
  assert.equal(detectPlatform({}, 'render'), PLATFORMS.RENDER);
  // Forced off, so a Render-hosted test of the local path is honest.
  assert.equal(detectPlatform({ RENDER: 'true' }, 'local'), PLATFORMS.LOCAL);
  assert.equal(detectPlatform({ RENDER: 'true' }, 'auto'), PLATFORMS.RENDER);
});

/* -------------------------------------------------------------------------- */
/* Persistence audit                                                           */
/* -------------------------------------------------------------------------- */

test('the inventory lists every file the runtime writes', () => {
  const entries = stateInventory({
    funDbFile: '/app/data/pomp-fun.sqlite',
    giveawayStateFile: '/app/data/giveaways.json',
    root: '/app',
  });

  assert.deepEqual(
    entries.map((entry) => entry.key),
    ['fun', 'giveaways'],
  );
  assert.deepEqual(
    entries.map((entry) => entry.displayPath),
    ['data/pomp-fun.sqlite', 'data/giveaways.json'],
  );
  assert.equal(entries[0].kind, 'sqlite');
});

test('isInside compares path segments, not string prefixes', () => {
  assert.equal(isInside('/data/state/x.sqlite', '/data'), true);
  assert.equal(isInside('/data/state/x.sqlite', '/data/'), true);
  assert.equal(isInside('/database/x.sqlite', '/data'), false, 'a sibling prefix was treated as inside');
  assert.equal(isInside('/data', '/data'), false, 'the directory itself is not a file inside it');
  assert.equal(isInside('/elsewhere/x.sqlite', '/data'), false);
  assert.equal(isInside('/data/x.sqlite', null), false);
});

test('a local run is not ephemeral and produces no warning', () => {
  const result = describePersistence({
    platform: PLATFORMS.LOCAL,
    entries: stateInventory({ funDbFile: '/app/data/a.sqlite', giveawayStateFile: '/app/data/b.json' }),
  });

  assert.equal(result.ephemeral, false);
  assert.equal(result.warning, null);
});

test('Render with local files warns, naming what is at risk', () => {
  const result = describePersistence({
    platform: PLATFORMS.RENDER,
    entries: stateInventory({
      funDbFile: '/app/data/pomp-fun.sqlite',
      giveawayStateFile: '/app/data/giveaways.json',
      root: '/app',
    }),
  });

  assert.equal(result.ephemeral, true);
  assert.match(result.warning, /^Render ephemeral filesystem detected:/);
  assert.match(result.warning, /may be lost on restart/);
  assert.match(result.warning, /fun economy/);
  assert.match(result.warning, /giveaway state/);
  assert.match(result.warning, /data\/pomp-fun\.sqlite/);
  assert.match(result.warning, /data\/giveaways\.json/);
  // It says what to do about it rather than only what is wrong.
  assert.match(result.warning, /PERSISTENT_STORAGE_PATH/);
});

test('a persistent disk silences the warning once everything is on it', () => {
  const entries = stateInventory({
    funDbFile: '/var/data/pomp-fun.sqlite',
    giveawayStateFile: '/var/data/giveaways.json',
  });

  const result = describePersistence({ platform: PLATFORMS.RENDER, entries, diskPath: '/var/data' });
  assert.equal(result.ephemeral, false);
  assert.equal(result.warning, null);
  assert.match(result.note, /persistent disk/);
  assert.ok(result.entries.every((entry) => entry.onPersistentDisk));
});

test('a disk that does not hold every file still warns', () => {
  // Half a migration is the dangerous state: it looks configured and is not.
  const entries = stateInventory({
    funDbFile: '/var/data/pomp-fun.sqlite',
    giveawayStateFile: '/app/data/giveaways.json',
  });

  const result = describePersistence({ platform: PLATFORMS.RENDER, entries, diskPath: '/var/data' });
  assert.equal(result.ephemeral, true, 'a partial disk mount was treated as durable');
  assert.equal(result.entries.find((entry) => entry.key === 'fun').onPersistentDisk, true);
  assert.equal(result.entries.find((entry) => entry.key === 'giveaways').onPersistentDisk, false);
});

/* -------------------------------------------------------------------------- */
/* The startup warning                                                         */
/* -------------------------------------------------------------------------- */

function persistenceConfig(overrides = {}) {
  return {
    platform: 'auto',
    persistentStoragePath: null,
    fun: { dbFile: null },
    giveaways: { stateFile: null },
    ...overrides,
  };
}

test('the Render warning is emitted at startup', () => {
  const { logger, text } = createCapturingLogger({ level: 'debug' });
  const result = warnAboutPersistence({ config: persistenceConfig(), logger, env: { RENDER: 'true' } });

  assert.equal(result.ephemeral, true);
  assert.match(text(), /WARN/);
  assert.match(text(), /Render ephemeral filesystem detected/);
});

test('a local startup shows no Render warning', () => {
  const { logger, text } = createCapturingLogger({ level: 'debug' });
  const result = warnAboutPersistence({ config: persistenceConfig(), logger, env: {} });

  assert.equal(result.ephemeral, false);
  assert.ok(!text().includes('WARN'), `a local run warned about Render: ${text()}`);
  assert.ok(!text().includes('ephemeral'));
});

test('DEPLOY_PLATFORM=render warns even without Render\'s own marker', () => {
  const { logger, text } = createCapturingLogger({ level: 'debug' });
  warnAboutPersistence({ config: persistenceConfig({ platform: 'render' }), logger, env: {} });

  assert.match(text(), /Render ephemeral filesystem detected/);
});

test('a configured disk replaces the warning with a note', () => {
  const { logger, text } = createCapturingLogger({ level: 'debug' });
  const disk = mkdtempSync(path.join(tmpdir(), 'pomp-disk-'));

  try {
    warnAboutPersistence({
      config: persistenceConfig({
        platform: 'render',
        persistentStoragePath: disk,
        fun: { dbFile: path.join(disk, 'pomp-fun.sqlite') },
        giveaways: { stateFile: path.join(disk, 'giveaways.json') },
      }),
      logger,
      env: {},
    });

    assert.ok(!text().includes('WARN'), `a durable setup still warned: ${text()}`);
    assert.match(text(), /persistent disk/);
  } finally {
    rmSync(disk, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/* Node and node:sqlite                                                        */
/* -------------------------------------------------------------------------- */

test('the declared Node version is one that has node:sqlite', () => {
  const manifest = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const range = manifest.engines?.node ?? '';

  assert.match(range, />=\s*24/, `engines.node is "${range}", which may predate node:sqlite without a flag`);
  assert.ok(!/>=?\s*(18|20|22)\b/.test(range), 'the engine range allows a Node without unflagged node:sqlite');
});

test('the running Node actually provides node:sqlite', async () => {
  const major = Number(process.versions.node.split('.')[0]);
  assert.ok(major >= 24, `running Node ${process.versions.node}, which is below the supported floor`);

  // Imported without any flag: if this needed --experimental-sqlite the
  // engines field would be a lie.
  const sqlite = await import('node:sqlite');
  assert.equal(typeof sqlite.DatabaseSync, 'function');
});

test('closing the fun service releases the database handle', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pomp-fun-'));
  const file = path.join(dir, 'pomp-fun.sqlite');

  try {
    const service = createFunService({ config: { fun: {} }, database: openFunDatabase({ file }) });
    service.mine({ guildId: 'g1', userId: 'u1' });
    assert.equal(service.profile({ guildId: 'g1', userId: 'u1' }).mines, 1);

    service.close();

    // A closed handle is unusable, which is the observable proof it was closed.
    assert.throws(
      () => service.repo.getUser('g1', 'u1'),
      (error) => {
        assert.equal(error.code, 'ERR_INVALID_STATE');
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/* Deployment files                                                            */
/* -------------------------------------------------------------------------- */

test('the Dockerfile installs yt-dlp and CA certificates', async () => {
  const dockerfile = await readFile(path.join(REPO, 'Dockerfile'), 'utf8');

  assert.match(dockerfile, /ca-certificates/, 'CA certificates are missing, so TLS to YouTube will fail');
  assert.match(dockerfile, /yt-dlp/, 'yt-dlp is not installed in the image');
  assert.match(dockerfile, /FROM node:24/, 'the image does not use the Node 24 base');
  assert.match(dockerfile, /npm ci/, 'dependencies are not installed reproducibly');
  assert.match(dockerfile, /POMPMUSIC_STREAM_BACKEND=ytdlp/, 'the stream backend is not pinned to yt-dlp');
  assert.match(dockerfile, /CMD \["node", "src\/index\.js"\]/, 'the image does not run the application entrypoint');
});

test('yt-dlp is pinned to a version, not floating', async () => {
  const dockerfile = await readFile(path.join(REPO, 'Dockerfile'), 'utf8');
  const pin = /yt-dlp==\$\{YTDLP_VERSION\}|yt-dlp==(\d{4}\.\d+\.\d+)/.exec(dockerfile);

  assert.ok(pin, 'yt-dlp is installed without a version pin');
  const arg = /ARG YTDLP_VERSION=(\d{4}\.\d+\.\d+)/.exec(dockerfile);
  assert.ok(arg, 'YTDLP_VERSION has no default, so a build would install whatever is current');
  assert.match(arg[1], /^\d{4}\.\d{1,2}\.\d{1,2}$/, `"${arg[1]}" is not a yt-dlp release version`);
});

test('play-dl streaming is not restored anywhere in the deployment', async () => {
  for (const file of ['Dockerfile', 'render.yaml']) {
    const contents = await readFile(path.join(REPO, file), 'utf8');
    assert.ok(!/POMPMUSIC_STREAM_BACKEND[=:]\s*none/.test(contents), `${file} disables streaming`);
  }

  const source = await readFile(path.join(REPO, 'src/music/sources/youtube.js'), 'utf8');
  assert.ok(!/stream_from_info|play\.stream/.test(source), 'the play-dl extraction path is back');
});

test('no deployment file contains a secret', async () => {
  const files = ['render.yaml', 'Dockerfile', '.dockerignore', 'docs/render-env.md'];

  // Shapes that would be a real credential rather than a variable name.
  const forbidden = [
    /MT[A-Za-z0-9]{20,}\./, // a Discord bot token
    /sk-[A-Za-z0-9]{16,}/, // an API key
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\b\d{17,20}:[A-Za-z0-9_-]{30,}\b/, // a raw token pair
  ];

  for (const file of files) {
    const contents = await readFile(path.join(REPO, file), 'utf8');
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(contents), `${file} contains what looks like a real credential`);
    }
  }
});

test('render.yaml declares every credential as dashboard-supplied', async () => {
  const yaml = await readFile(path.join(REPO, 'render.yaml'), 'utf8');

  for (const key of [
    'DISCORD_TOKEN',
    'DISCORD_CLIENT_ID',
    'DISCORD_GUILD_ID',
    'POMPMUSIC_TOKEN',
    'POMPMUSIC_CLIENT_ID',
    'AI_API_KEY',
    'ITAD_API_KEY',
  ]) {
    const entry = new RegExp(`- key: ${key}\\n\\s+sync: false`).test(yaml);
    assert.ok(entry, `${key} is not marked sync: false, so its value would have to live in the file`);
  }
});

test('render.yaml describes one web service with the health check', async () => {
  const yaml = await readFile(path.join(REPO, 'render.yaml'), 'utf8');

  assert.equal((yaml.match(/- type: web/g) ?? []).length, 1, 'the blueprint does not declare exactly one web service');
  assert.match(yaml, /name: pomp-bots/);
  assert.match(yaml, /healthCheckPath: \/health/);
  assert.match(yaml, /runtime: docker/);
  assert.match(yaml, /plan: free/);
  assert.match(yaml, /BOT_CONNECT\n\s+value: "true"/, 'the service would configure itself and exit');
});

test('.dockerignore keeps secrets and local state out of the image', async () => {
  const ignore = await readFile(path.join(REPO, '.dockerignore'), 'utf8');
  const lines = ignore
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

  for (const pattern of ['.env', 'data/', 'node_modules/', '.git/']) {
    assert.ok(lines.includes(pattern), `${pattern} is not excluded from the build context`);
  }
  assert.ok(!lines.includes('!.env.example') === false, 'the placeholder file should stay available as documentation');
});

test('.env is still git-ignored and untracked', async () => {
  const ignore = await readFile(path.join(REPO, '.gitignore'), 'utf8');
  assert.match(ignore, /^\.env$/m, '.env is no longer ignored');
  assert.match(ignore, /^data\/$/m, 'runtime state is no longer ignored');
});

/* -------------------------------------------------------------------------- */
/* Startup ordering and shutdown                                               */
/* -------------------------------------------------------------------------- */

const BASE_ENV = (port, dir) => ({
  DISCORD_TOKEN: 'x'.repeat(60),
  DISCORD_CLIENT_ID: '111111111111111111',
  DISCORD_GUILD_ID: '222222222222222222',
  AI_PROVIDER: 'stub',
  BOT_CONNECT: 'true',
  DEPLOY_PLATFORM: 'local',
  PORT: String(port),
  FUN_DB_FILE: path.join(dir, 'pomp-fun.sqlite'),
});

function fakeClient({ onLogin = null } = {}) {
  const client = new EventEmitter();
  client.user = { id: '999999999999999999', tag: 'PompAI#0001' };
  client.guilds = { cache: new Map() };
  client.destroyed = false;
  client.login = async () => {
    await onLogin?.();
  };
  client.destroy = async () => {
    client.destroyed = true;
  };
  return client;
}

function fakeProcess() {
  const processRef = new EventEmitter();
  processRef.exitCode = null;
  processRef.forced = false;
  processRef.exit = () => {
    processRef.forced = true;
  };
  processRef.stderr = { write: () => {} };
  return processRef;
}

test('the health endpoint answers before Discord is contacted', async () => {
  const port = await freePort();
  const dir = mkdtempSync(path.join(tmpdir(), 'pomp-boot-'));

  try {
    let sawHealth = null;
    const client = fakeClient({
      onLogin: async () => {
        // The gateway is being contacted right now; the port must already work.
        sawHealth = await httpRequest(`http://127.0.0.1:${port}/health`);
      },
    });

    const { exitCode } = await main({
      env: BASE_ENV(port, dir),
      clientFactory: () => client,
      logger: createNullLogger(),
      waitForShutdown: false,
      processRef: fakeProcess(),
    });

    assert.equal(exitCode, 0);
    assert.ok(sawHealth, 'nothing was listening on PORT while Discord was being contacted');
    assert.equal(sawHealth.status, 200);
    assert.equal(sawHealth.json().pompAI, false, 'the endpoint claimed a connection that had not happened yet');
    assert.equal(sawHealth.json().pompMusic, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a refused Discord login does not leave a wedged process', async () => {
  const port = await freePort();
  const dir = mkdtempSync(path.join(tmpdir(), 'pomp-boot-'));

  try {
    const client = fakeClient({
      onLogin: async () => {
        throw Object.assign(new Error('Used disallowed intents'), { code: 'DISALLOWED_INTENTS' });
      },
    });

    const { exitCode } = await main({
      env: BASE_ENV(port, dir),
      clientFactory: () => client,
      logger: createNullLogger(),
      waitForShutdown: false,
      processRef: fakeProcess(),
    });

    assert.equal(exitCode, 1, 'a failed login reported success');
    // The socket has to be released, or the process never actually exits and
    // the platform sees a container that is up but doing nothing.
    assert.equal(await portIsFree(port), true, 'the health port was left listening after a failed login');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SIGTERM shuts the bots down and releases the port', async () => {
  const port = await freePort();
  const dir = mkdtempSync(path.join(tmpdir(), 'pomp-boot-'));

  try {
    const client = fakeClient();
    const processRef = fakeProcess();

    const running = main({
      env: BASE_ENV(port, dir),
      clientFactory: () => client,
      logger: createNullLogger(),
      waitForShutdown: true,
      processRef,
    });

    let health = null;
    try {
      health = await waitForHealth(port);
      assert.ok(health, 'the service never became reachable');
    } finally {
      // Signalled even if the assertion above failed, so `running` always
      // settles and the temporary directory is not cleaned up underneath a
      // process that still has the database open.
      processRef.emit('SIGTERM');
    }

    const { exitCode } = await running;

    assert.equal(exitCode, 0);
    assert.equal(client.destroyed, true, 'the Discord client was not torn down');
    assert.equal(processRef.forced, false, 'shutdown had to be forced, so something hung');
    assert.equal(await portIsFree(port), true, 'the health port outlived the shutdown');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SIGINT takes the same path as SIGTERM', async () => {
  const port = await freePort();
  const dir = mkdtempSync(path.join(tmpdir(), 'pomp-boot-'));

  try {
    const client = fakeClient();
    const processRef = fakeProcess();

    const running = main({
      env: BASE_ENV(port, dir),
      clientFactory: () => client,
      logger: createNullLogger(),
      waitForShutdown: true,
      processRef,
    });

    try {
      assert.ok(await waitForHealth(port));
    } finally {
      processRef.emit('SIGINT');
    }

    assert.equal((await running).exitCode, 0);
    assert.equal(client.destroyed, true);
    assert.equal(await portIsFree(port), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a configuration failure exits without opening the port', async () => {
  const port = await freePort();
  const processRef = fakeProcess();

  const { exitCode } = await main({
    env: { PORT: String(port) }, // no DISCORD_TOKEN
    logger: createNullLogger(),
    waitForShutdown: false,
    processRef,
  });

  assert.equal(exitCode, 1);
  // A service that is misconfigured must not answer as healthy.
  assert.equal(await portIsFree(port), true, 'a misconfigured process still served a healthy endpoint');
});

test('BOT_CONNECT=false releases the port instead of hanging', async () => {
  const port = await freePort();
  const dir = mkdtempSync(path.join(tmpdir(), 'pomp-boot-'));

  try {
    const client = fakeClient();
    const { exitCode } = await main({
      env: { ...BASE_ENV(port, dir), BOT_CONNECT: 'false' },
      clientFactory: () => client,
      logger: createNullLogger(),
      waitForShutdown: false,
      processRef: fakeProcess(),
    });

    assert.equal(exitCode, 0);
    assert.equal(await portIsFree(port), true, 'a listening socket kept the process alive');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/* Child process cleanup                                                       */
/* -------------------------------------------------------------------------- */

test('tearing the music service down kills the yt-dlp child it owns', async () => {
  // The path a redeploy takes: main() calls pompMusic.destroy(), which destroys
  // every session, and a session's destroy kills the process behind its stream.
  const kills = [];
  const source = {
    name: 'test',
    async search() {
      return [];
    },
    async createAudioStream(track) {
      return {
        stream: { pipe() {} },
        inputType: 'webm/opus',
        kill: () => {
          kills.push(track.id);
          return true;
        },
        meta: { backend: 'ytdlp' },
      };
    },
  };

  const service = createMusicService({
    client: { guilds: { cache: new Map() } },
    config: { music: { idleDisconnectSeconds: 0 } },
    source,
    logger: createNullLogger(),
    voiceFactory: () => ({
      channelId: null,
      async join(id) {
        this.channelId = id;
      },
      play() {},
      pause() {},
      resume() {},
      stop() {},
      destroy() {},
      on() {},
    }),
  });

  const session = service.summon({ guild: { id: 'g1' }, channelId: 'vc1' });
  await session.begin();
  await session.enqueue(normaliseTrack({ id: 'aaaaaaaaaaa', source: 'test', title: 'A' }), { id: 'u', name: 'U' });

  assert.equal(session.hasActiveStream(), true, 'no stream process was running to clean up');
  assert.equal(service.battles.size, 0);

  service.destroy();

  assert.deepEqual(kills, ['aaaaaaaaaaa'], 'the extractor process outlived the service');
});

test('the health server is independent of every bot subsystem', async () => {
  // It is constructed with a status object and nothing else: no client, no
  // service, no config. That is why PompMusic failing cannot take it down.
  const health = createHealthServer({ port: 0 });
  const started = await health.start();

  assert.equal(started.listening, true);
  assert.equal(health.port === 0 || health.address().port > 0, true);
  await health.stop();
});

test('the default port matches the documented value', () => {
  assert.equal(DEFAULT_PORT, 10000);
});
