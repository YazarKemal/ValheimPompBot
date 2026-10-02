import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildExtractorArgs,
  createPotDiagnostics,
  DEFAULT_POT_PLAYER_CLIENT,
  DEFAULT_POT_SERVER_HOME,
  POT_PLUGIN_MODULE,
  POT_PROVIDER_BGUTIL_SCRIPT,
  POT_PROVIDER_NONE,
  POT_UNAVAILABLE_CODE,
  potDiagnosticsSummary,
  scanPotDiagnostics,
  verifyPotProvider,
} from '../src/music/sources/pot-provider.js';
import { buildArguments, createStreamBackend, YtDlpStreamBackend, isYoutubeBlocked } from '../src/music/sources/ytdlp.js';
import { ENV_SCHEMA } from '../src/config/schema.js';
import { YouTubeSource } from '../src/music/sources/youtube.js';
import { createMusicService } from '../src/music/index.js';
import { createCapturingLogger, createNullLogger } from '../src/utils/logger.js';
import { safeErrorDetails } from '../src/utils/errors.js';

/**
 * The YouTube PO token provider.
 *
 * The bot-check that motivated this is answered with a token, not an account:
 * no cookies, no credentials, ever. These tests cover the four things that
 * could silently go wrong - the image is not pinned, the yt-dlp arguments are
 * wrong, the provider is missing but playback is attempted anyway, or a local
 * machine that needs none of this is broken by it.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readRepoFile = (name) => readFile(path.join(REPO, name), 'utf8');

const LIVE_URL = 'https://www.youtube.com/watch?v=ktTkTFHic';

/* -------------------------------------------------------------------------- */
/* Process doubles                                                             */
/* -------------------------------------------------------------------------- */

/** A child that answers a probe and exits. */
function probeChild({ stdout = '', code = 0 } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  setImmediate(() => {
    child.emit('spawn');
    setImmediate(() => {
      if (stdout) child.stdout.write(stdout);
      setImmediate(() => child.emit('close', code, null));
    });
  });
  return child;
}

/** Answers probes by command, recording every call. */
function probeRecorder({ scriptVersion = '2.0.1', pluginPath = '/usr/lib/python3/dist-packages/yt_dlp_plugins/extractor/getpot_bgutil_script.py', scriptFails = false, pluginMissing = false } = {}) {
  const calls = [];
  const impl = (command, args) => {
    calls.push({ command, args });
    if (command === 'yt-dlp' || String(command).endsWith('yt-dlp.exe')) return probeChild({ stdout: '2026.08.19\n' });
    if (command === 'node') return probeChild(scriptFails ? { code: 1 } : { stdout: `${scriptVersion}\n` });
    if (command === 'python3') return probeChild({ stdout: pluginMissing ? '\n' : `${pluginPath}\n` });
    return probeChild({ code: 1 });
  };
  impl.calls = calls;
  return impl;
}

/**
 * A provider home that really contains the script the plugin looks for.
 *
 * `verifyPotProvider` checks the filesystem first, so a passing case needs a
 * real file rather than a stubbed one.
 */
async function withProviderHome(fn) {
  const home = mkdtempSync(path.join(tmpdir(), 'bgutil-'));
  mkdirSync(path.join(home, 'build'), { recursive: true });
  writeFileSync(path.join(home, 'build', 'generate_once.js'), '// fixture\n');
  try {
    // Awaited: removing the directory while the body is still running would
    // make every check a race the test sometimes wins.
    return await fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/* -------------------------------------------------------------------------- */
/* The image is pinned                                                         */
/* -------------------------------------------------------------------------- */

test('the provider plugin is pinned to an explicit version', async () => {
  const dockerfile = await readRepoFile('Dockerfile');

  const pin = /bgutil-ytdlp-pot-provider==\$\{BGUTIL_POT_VERSION\}/.exec(dockerfile);
  assert.ok(pin, 'the bgutil plugin is installed without the version argument');

  const arg = /ARG BGUTIL_POT_VERSION=(\d+\.\d+\.\d+)/.exec(dockerfile);
  assert.ok(arg, 'BGUTIL_POT_VERSION has no default, so a build would install whatever is current');
  assert.match(arg[1], /^\d+\.\d+\.\d+$/, `"${arg[1]}" is not a release version`);
});

test('the provider server is built from the same pinned tag', async () => {
  const dockerfile = await readRepoFile('Dockerfile');

  assert.match(dockerfile, /git clone[\s\S]{0,400}?--branch "\$\{BGUTIL_POT_VERSION\}"/, 'the server is cloned without the pinned tag');
  assert.match(
    dockerfile,
    /github\.com\/Brainicism\/bgutil-ytdlp-pot-provider\.git/,
    'the provider server is not fetched from its own repository',
  );
  assert.ok(!/--branch (main|master|latest)/.test(dockerfile), 'the server is cloned from a moving branch');
  assert.ok(!/bgutil-ytdlp-pot-provider:latest/.test(dockerfile), 'a floating image tag was introduced');
});

test('the server is compiled and its runtime dependencies survive', async () => {
  const dockerfile = await readRepoFile('Dockerfile');

  assert.match(dockerfile, /npm ci/, 'the server dependencies are not installed reproducibly');
  assert.match(dockerfile, /npx tsc/, 'the server is not compiled, so generate_once.js would not exist');
  assert.match(dockerfile, /npm prune --omit=dev/, 'the build toolchain is left in the runtime image');
  assert.match(
    dockerfile,
    /node build\/generate_once\.js --version/,
    'the build does not prove the script the plugin runs actually works',
  );
});

test('nothing is downloaded at runtime and no secret is baked in', async () => {
  const dockerfile = await readRepoFile('Dockerfile');

  // The build fetches; the running container must not.
  assert.ok(!/CMD.*\b(curl|wget|pip install|npm install|git clone)\b/.test(dockerfile), 'the container downloads at startup');
  assert.ok(!/CMD.*youtube/i.test(dockerfile), 'the startup command reaches YouTube');
  assert.ok(dockerfile.includes('rm -rf "${BGUTIL_POT_HOME}/.git"'), 'the checkout history is left in the image');
});

test('the server home in the image is the directory that was built', async () => {
  const dockerfile = await readRepoFile('Dockerfile');

  const home = /ARG BGUTIL_POT_HOME=(\S+)/.exec(dockerfile);
  assert.ok(home, 'the provider home is not defined once and reused');
  assert.match(
    dockerfile,
    /ENV POMPMUSIC_POT_SERVER_HOME=\$\{BGUTIL_POT_HOME\}\/server/,
    'the configured server home is not the built directory, so the plugin would not find the script',
  );
});

/* -------------------------------------------------------------------------- */
/* No cookies, no account                                                      */
/* -------------------------------------------------------------------------- */

test('no cookies or account credentials are configured anywhere', async () => {
  const files = ['Dockerfile', 'render.yaml', 'src/music/sources/ytdlp.js', 'src/music/sources/pot-provider.js'];
  const forbidden = [
    /--cookies\b/,
    /--cookies-from-browser/,
    /--username/,
    /--password/,
    /--netrc/,
    /--video-password/,
    /COOKIES?_?FILE/i,
    /YOUTUBE_ACCOUNT/i,
  ];

  for (const file of files) {
    const contents = await readRepoFile(file);
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(contents), `${file} configures ${pattern} - a PO token must never be answered with an account`);
    }
  }
});

test('the extractor arguments contain no credential of any kind', () => {
  const args = buildExtractorArgs({ provider: POT_PROVIDER_BGUTIL_SCRIPT });

  for (const arg of args) {
    assert.ok(!/cookie|username|password|account|auth/i.test(arg), `credential in extractor args: ${arg}`);
  }
});

/* -------------------------------------------------------------------------- */
/* The yt-dlp arguments are the documented ones                                */
/* -------------------------------------------------------------------------- */

/**
 * The `youtube:` argument, split into its `;`-separated settings.
 *
 * Also asserts there is exactly ONE such argument, because yt-dlp REPLACES the
 * value stored for an extractor key instead of merging into it: a second
 * `youtube:` argument would silently discard the first.
 */
function youtubeSettings(extractorArgs) {
  const youtubeArgs = extractorArgs.filter((value) => value.startsWith('youtube:'));
  assert.equal(youtubeArgs.length, 1, 'a second youtube: argument would replace the first, not merge with it');

  return new Map(
    youtubeArgs[0]
      .slice('youtube:'.length)
      .split(';')
      .map((pair) => {
        const index = pair.indexOf('=');
        return [pair.slice(0, index), pair.slice(index + 1)];
      }),
  );
}

test('the script provider and server home are passed exactly as documented', () => {
  const args = buildExtractorArgs({ provider: POT_PROVIDER_BGUTIL_SCRIPT, serverHome: '/opt/x/server' });

  assert.deepEqual(args, [
    `youtube:player_client=${DEFAULT_POT_PLAYER_CLIENT};pot_trace=true`,
    'youtubepot-bgutilscript:server_home=/opt/x/server',
  ]);
});

test('the provider argument prefix and option names are the real ones', async () => {
  // The plugin registers as `youtubepot-bgutilscript` and reads `server_home`
  // in `bgutil-ytdlp-pot-provider`, and yt-dlp's YouTube extractor reads
  // `player_client`. These names are the whole integration: a typo here is a
  // silent no-op that looks exactly like the bot check it was meant to fix.
  const args = buildExtractorArgs({ provider: POT_PROVIDER_BGUTIL_SCRIPT });

  assert.ok(args.some((arg) => arg.startsWith('youtubepot-bgutilscript:')), 'the provider prefix is wrong');
  assert.ok(args.some((arg) => arg.includes('server_home=')), 'the option is not server_home');
  assert.ok(!args.some((arg) => arg.includes('script_path=')), 'script_path was invented; the plugin reads server_home');
  assert.equal(
    youtubeSettings(args).get('player_client'),
    DEFAULT_POT_PLAYER_CLIENT,
    'the YouTube player client argument is wrong',
  );
});

test('the client list is exactly mweb,tv,web_safari', () => {
  // One client is not enough: a client can fail with LOGIN_REQUIRED before the
  // token flow is reached, and then no token is ever requested. The list is the
  // documented fallback, in the documented order, and yt-dlp splits it on
  // commas.
  assert.equal(DEFAULT_POT_PLAYER_CLIENT, 'mweb,tv,web_safari');

  const settings = youtubeSettings(buildExtractorArgs({ provider: POT_PROVIDER_BGUTIL_SCRIPT }));
  const clients = settings.get('player_client').split(',');

  assert.deepEqual(clients, ['mweb', 'tv', 'web_safari'], 'the client list, in the order yt-dlp should try them');
  assert.ok(!settings.get('player_client').includes(' '), 'a space would make yt-dlp read the list as one client name');
});

test('a token is only counted when a response line says one was obtained', () => {
  // The line printed just before a cache lookup reads "Attempting to fetch PO
  // Token response from ... cache provider": similar wording, and no token has
  // been obtained at that point. Counting it would turn "the token flow never
  // ran" into a confident, wrong "the IP is blocked".
  const attempt = createPotDiagnostics();
  assert.deepEqual(
    scanPotDiagnostics('[debug] [pot] TRACE: Attempting to fetch PO Token response from "memory" cache provider\n', attempt),
    [],
  );
  assert.equal(potDiagnosticsSummary(attempt).potAvailable, false);

  // The real response line, in the shape the pinned yt-dlp prints it.
  const response = createPotDiagnostics();
  assert.deepEqual(
    scanPotDiagnostics(
      '[debug] [pot] TRACE: PO Token response from "bgutil:script-node" provider: PoTokenResponse(' +
        "po_token='SECRET1234567890', expires_at=1)\n",
      response,
    ),
    ['tokenGenerated'],
  );
  assert.equal(potDiagnosticsSummary(response).potAvailable, true);
});

test('the cache-provider list is not mistaken for the token-provider list', () => {
  // The two lines differ by one prefix: `[pot]` versus `[pot:cache]`. A cache
  // provider being registered says nothing about a token provider existing.
  const state = createPotDiagnostics();

  assert.deepEqual(scanPotDiagnostics('[debug] [pot:cache] PO Token Cache Providers: memory\n', state), []);
  assert.equal(potDiagnosticsSummary(state).potProviderLoaded, false);

  assert.deepEqual(scanPotDiagnostics('[debug] [pot] PO Token Providers: memory\n', state), []);
  assert.equal(potDiagnosticsSummary(state).potProviderLoaded, false, 'a non-bgutil provider was reported as bgutil');
});

test('the YouTube client is only set together with a provider that can supply its token', () => {
  // mweb formats are skipped outright when no GVS PO token is available, so
  // asking for mweb without a provider is worse than asking for nothing.
  assert.deepEqual(buildExtractorArgs({ provider: POT_PROVIDER_NONE }), []);
  assert.deepEqual(buildExtractorArgs({}), [], 'a default run must stay a plain run');
});

test('pot_trace is on, because without it a generated token leaves no evidence', () => {
  // The two lines that prove a token was obtained are printed at TRACE, one
  // level BELOW the DEBUG that --verbose reaches, so they appear only when
  // `pot_trace=true` is set. Without it a token can be generated perfectly and
  // the output looks identical to "the token flow never ran" - which is the
  // difference between "try another client" and "this address is blocked".
  const traced = youtubeSettings(buildExtractorArgs({ provider: POT_PROVIDER_BGUTIL_SCRIPT }));
  assert.equal(traced.get('pot_trace'), 'true');
  assert.equal(traced.get('player_client'), 'mweb,tv,web_safari', 'the client list must survive alongside it');

  // Still expressible without it, for a caller that only wants the provider list.
  const untraced = youtubeSettings(buildExtractorArgs({ provider: POT_PROVIDER_BGUTIL_SCRIPT, potTrace: false }));
  assert.equal(untraced.get('pot_trace'), undefined);
  assert.equal(untraced.get('player_client'), 'mweb,tv,web_safari');
});

test('no provider means no pot_trace either', () => {
  // The argument is part of the provider integration, not a global switch: a
  // plain run keeps exactly the command line it had before.
  assert.deepEqual(buildExtractorArgs({ provider: POT_PROVIDER_NONE, potTrace: true }), []);
});

test('the configured default is the same client list, so the two cannot drift', () => {
  // `buildExtractorArgs` has its own default, but the value that actually
  // reaches it in production comes from the config schema when
  // POMPMUSIC_YTDLP_PLAYER_CLIENT is unset - which is how the image ships,
  // since the Dockerfile sets the provider but not this. The two defaults
  // saying different things is a silent regression: the argument is still
  // well-formed, and only the client list is wrong.
  const entry = ENV_SCHEMA.find((item) => item.key === 'POMPMUSIC_YTDLP_PLAYER_CLIENT');

  assert.ok(entry, 'the player client setting is gone from the schema');
  assert.equal(entry.default, DEFAULT_POT_PLAYER_CLIENT);
  assert.equal(entry.default, 'mweb,tv,web_safari');
});

test('the arguments reach the spawned command as --extractor-args pairs', () => {
  const extractorArgs = buildExtractorArgs({ provider: POT_PROVIDER_BGUTIL_SCRIPT, serverHome: '/opt/x/server' });
  const args = buildArguments({ url: LIVE_URL, extractorArgs });

  const passed = args.reduce((values, value, index) => (value === '--extractor-args' ? [...values, args[index + 1]] : values), []);
  assert.deepEqual(passed, extractorArgs, 'the extractor arguments did not reach the command line');
  assert.equal(args.at(-1), LIVE_URL, 'the url is no longer last');
});

test('a plain run passes no extractor arguments at all', () => {
  const args = buildArguments({ url: LIVE_URL });

  assert.ok(!args.includes('--extractor-args'), 'a plain yt-dlp run gained arguments it did not ask for');
  // And the safety flags are all still there.
  for (const flag of ['--ignore-config', '--no-cache-dir', '--no-playlist', '--no-warnings']) {
    assert.ok(args.includes(flag), `${flag} was lost`);
  }
});

/* -------------------------------------------------------------------------- */
/* Startup validation                                                          */
/* -------------------------------------------------------------------------- */

test('a working provider is verified and reported ready', async () => {
  await withProviderHome(async (home) => {
    const spawnImpl = probeRecorder();
    const result = await verifyPotProvider({ provider: POT_PROVIDER_BGUTIL_SCRIPT, serverHome: home, spawnImpl });

    assert.equal(result.ok, true);
    assert.equal(result.enabled, true);
    assert.equal(result.details.mode, 'script');
    assert.equal(result.details.scriptVersion, '2.0.1');
    assert.ok(result.details.pluginPath, 'the plugin path was not reported');
    assert.equal(spawnImpl.calls.length, 2, 'the probes are not the two documented ones');
  });
});

test('the verification runs the same two probes the plugin does', async () => {
  await withProviderHome(async (home) => {
    const spawnImpl = probeRecorder();
    await verifyPotProvider({ provider: POT_PROVIDER_BGUTIL_SCRIPT, serverHome: home, spawnImpl });

    const [script, plugin] = spawnImpl.calls;
    assert.equal(script.command, 'node', 'the script is not run with the JS runtime the plugin uses');
    assert.deepEqual(script.args, [path.join(home, 'build', 'generate_once.js'), '--version']);
    assert.equal(plugin.command, 'python3');
    assert.ok(plugin.args[1].includes(POT_PLUGIN_MODULE), 'the plugin check does not look for the plugin module');
  });
});

test('a missing provider script fails with the provider code', async () => {
  const result = await verifyPotProvider({
    provider: POT_PROVIDER_BGUTIL_SCRIPT,
    serverHome: path.join(tmpdir(), 'definitely-not-here'),
    spawnImpl: probeRecorder(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, POT_UNAVAILABLE_CODE);
  assert.match(result.reason, /missing/i);
});

test('a provider script that cannot run fails with the provider code', async () => {
  await withProviderHome(async (home) => {
    const result = await verifyPotProvider({
      provider: POT_PROVIDER_BGUTIL_SCRIPT,
      serverHome: home,
      spawnImpl: probeRecorder({ scriptFails: true }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, POT_UNAVAILABLE_CODE);
    assert.match(result.reason, /did not run|exited/i);
  });
});

test('a missing plugin fails, because the arguments would be silently ignored', async () => {
  await withProviderHome(async (home) => {
    const result = await verifyPotProvider({
      provider: POT_PROVIDER_BGUTIL_SCRIPT,
      serverHome: home,
      spawnImpl: probeRecorder({ pluginMissing: true }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, POT_UNAVAILABLE_CODE);
    assert.match(result.reason, /plugin is not importable/i);
  });
});

test('a disabled provider is not verified and needs nothing installed', async () => {
  const spawnImpl = probeRecorder();
  const result = await verifyPotProvider({ provider: POT_PROVIDER_NONE, spawnImpl });

  assert.equal(result.ok, true);
  assert.equal(result.enabled, false);
  assert.equal(spawnImpl.calls.length, 0, 'a disabled provider still ran probes');
});

/* -------------------------------------------------------------------------- */
/* The backend refuses rather than falling back                                */
/* -------------------------------------------------------------------------- */

test('an unusable provider disables streaming instead of running plain yt-dlp', async () => {
  const spawnImpl = probeRecorder();
  const { backend, detection } = await createStreamBackend({
    settings: {
      streamBackend: 'ytdlp',
      potProvider: POT_PROVIDER_BGUTIL_SCRIPT,
      potServerHome: path.join(tmpdir(), 'definitely-not-here'),
    },
    spawnImpl,
  });

  assert.equal(backend, null, 'a backend was built without a working provider');
  assert.equal(detection.available, false);
  assert.equal(detection.code, POT_UNAVAILABLE_CODE);
  // yt-dlp itself was found; the provider is what is missing.
  assert.equal(detection.version, '2026.08.19');
});

test('the provider failure is logged with its code, provider and mode', async () => {
  const { logger, text } = createCapturingLogger({ level: 'debug' });
  await createStreamBackend({
    settings: {
      streamBackend: 'ytdlp',
      potProvider: POT_PROVIDER_BGUTIL_SCRIPT,
      potServerHome: path.join(tmpdir(), 'definitely-not-here'),
    },
    spawnImpl: probeRecorder(),
    logger,
  });

  const output = text();
  assert.match(output, new RegExp(POT_UNAVAILABLE_CODE));
  assert.match(output, /provider: 'bgutil'/);
  assert.match(output, /mode: 'script'/);
  assert.ok(!output.toLowerCase().includes('cookie'), 'the log mentions cookies');
});

test('a ready provider logs exactly the three promised facts', async () => {
  await withProviderHome(async (home) => {
    const { logger, text } = createCapturingLogger({ level: 'debug' });
    const { backend } = await createStreamBackend({
      settings: { streamBackend: 'ytdlp', potProvider: POT_PROVIDER_BGUTIL_SCRIPT, potServerHome: home },
      spawnImpl: probeRecorder(),
      logger,
    });

    assert.ok(backend, 'a verified provider did not produce a backend');
    const output = text();
    assert.match(output, /PO token provider ready/);
    assert.match(output, /provider: 'bgutil'/);
    assert.match(output, /mode: 'script'/);
    assert.deepEqual(backend.extractorArgs, [
      `youtube:player_client=${DEFAULT_POT_PLAYER_CLIENT};pot_trace=true`,
      `youtubepot-bgutilscript:server_home=${home}`,
    ]);
  });
});

test('streaming a track without a provider reports the provider code, not a generic one', async () => {
  const source = new YouTubeSource({
    streamBackend: null,
    streamUnavailable: { code: POT_UNAVAILABLE_CODE, reason: 'the provider script is missing at /opt/x' },
  });

  const error = await source.createAudioStream({ id: 'abc', url: LIVE_URL, title: 't' }).then(
    () => null,
    (failure) => failure,
  );

  assert.equal(error?.code, POT_UNAVAILABLE_CODE, 'the specific reason was replaced by a generic one');
  assert.match(error.message, /provider script is missing/);
});

test('without a stated reason, a missing backend keeps its old generic code', async () => {
  const source = new YouTubeSource({ streamBackend: null });

  await assert.rejects(
    () => source.createAudioStream({ id: 'abc', url: LIVE_URL, title: 't' }),
    (error) => {
      assert.equal(error.code, 'MUSIC_STREAM_FAILED');
      return true;
    },
  );
});

test('a local setup with the provider disabled still builds a working backend', async () => {
  const spawnImpl = probeRecorder();
  const { backend, detection } = await createStreamBackend({
    settings: { streamBackend: 'ytdlp', potProvider: POT_PROVIDER_NONE },
    spawnImpl,
  });

  assert.ok(backend, `the backend was not built: ${JSON.stringify(detection)}`);
  assert.deepEqual(backend.extractorArgs, [], 'a disabled provider still changed the command line');
  assert.equal(detection.potProvider.enabled, false);
  // Only the yt-dlp version probe ran: nothing checked for a provider.
  assert.equal(spawnImpl.calls.length, 1);
  assert.deepEqual(spawnImpl.calls[0].args, ['--version']);
});

test('the service reports the provider code through the source it builds', async () => {
  const service = createMusicService({
    client: { guilds: { cache: new Map() } },
    config: { music: { potProvider: POT_PROVIDER_BGUTIL_SCRIPT } },
    providedBackend: null,
    backendDetection: { available: false, code: POT_UNAVAILABLE_CODE, reason: 'provider is not installed' },
    logger: createNullLogger(),
  });

  const error = await service.source.createAudioStream({ id: 'abc', url: LIVE_URL, title: 't' }).then(
    () => null,
    (failure) => failure,
  );

  assert.equal(error?.code, POT_UNAVAILABLE_CODE);
});

/* -------------------------------------------------------------------------- */
/* YouTube still blocking, after the provider                                  */
/* -------------------------------------------------------------------------- */

test('a bot check is classified as YouTube blocking, not as a broken track', async () => {
  const spawnImpl = () => {
    const streamChild = new EventEmitter();
    streamChild.stdout = new PassThrough();
    streamChild.stderr = new PassThrough();
    streamChild.kill = () => true;
    setImmediate(() => {
      streamChild.emit('spawn');
      setImmediate(() => {
        streamChild.stderr.write("ERROR: [youtube] abc: Sign in to confirm you're not a bot. Use --cookies-from-browser\n");
        setImmediate(() => streamChild.emit('close', 1, null));
      });
    });
    return streamChild;
  };

  const backend = new YtDlpStreamBackend({ executable: 'yt-dlp', spawnImpl, maxAttempts: 1, logger: createNullLogger() });
  const error = await backend.openStream(LIVE_URL).then(
    () => null,
    (failure) => failure,
  );

  assert.equal(error?.code, 'MUSIC_YOUTUBE_BLOCKED', 'a block with no token generated is not an IP block');
  assert.match(error.message, /before a PO token was generated/);
  assert.equal(error.details.potAvailable, false);
});

/* -------------------------------------------------------------------------- */
/* The token flow, as facts                                                    */
/* -------------------------------------------------------------------------- */

/** A stream child whose stderr is scripted, line by line. */
function streamChildWithStderr(lines, { exitCode = 1 } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  setImmediate(() => {
    child.emit('spawn');
    setImmediate(() => {
      for (const line of lines) child.stderr.write(`${line}\n`);
      setImmediate(() => child.emit('close', exitCode, null));
    });
  });
  return child;
}

const BOT_CHECK = "ERROR: [youtube] abc: Sign in to confirm you're not a bot.";

/**
 * A realistic slice of what yt-dlp prints once a token is in play.
 *
 * Copied from the pinned yt-dlp (2026.8.19) rather than imagined, because the
 * LEVELS are the whole reason `pot_trace=true` is passed: the provider list is
 * a DEBUG line from `pot/_director.py`, the response lines are TRACE lines from
 * the same file, and `--verbose` alone stops one level short of them.
 */
const TOKEN_FLOW = [
  '[debug] [pot] PO Token Providers: bgutil:script-node-2.0.1 (external)',
  '[debug] [pot] PO Token Cache Providers: memory',
  '[pot:bgutil:script-node] Generating a gvs PO Token for tv client via bgutil script',
  '[debug] [pot] TRACE: PO Token response from "bgutil:script-node" provider: PoTokenResponse(' +
    "po_token='SECRETTOKENVALUE1234567890', expires_at=1759999999)",
];

test('the token flow is detected from the messages yt-dlp actually prints', async () => {
  const { logger, text } = createCapturingLogger({ level: 'debug' });
  const spawnImpl = () => streamChildWithStderr([...TOKEN_FLOW, BOT_CHECK]);
  const backend = new YtDlpStreamBackend({ executable: 'yt-dlp', spawnImpl, maxAttempts: 1, diagnostics: true, logger });

  const error = await backend.openStream(LIVE_URL).then(
    () => null,
    (failure) => failure,
  );

  assert.equal(error.details.potProviderLoaded, true, 'the provider was loaded but not reported');
  assert.equal(error.details.potGenerationRequested, true);
  assert.equal(error.details.potAvailable, true, 'a generated token was not recognised');
  assert.equal(error.details.potClient, 'tv');

  const output = text();
  assert.match(output, /PO Token provider loaded/);
  assert.match(output, /PO Token generation requested/);
  assert.match(output, /PO Token generation succeeded/);
});

test('the diagnostics survive the logger, rather than redacting themselves', async () => {
  // The logger masks any value whose KEY looks like a credential. A field named
  // `potTokenAvailable` was printed as `[redacted]`, which would have hidden
  // the one fact this whole phase exists to report - so the names are asserted
  // through a real logger, not just on the object.
  const { logger, text } = createCapturingLogger({ level: 'debug' });
  const spawnImpl = () => streamChildWithStderr([...TOKEN_FLOW, BOT_CHECK]);
  const backend = new YtDlpStreamBackend({ executable: 'yt-dlp', spawnImpl, maxAttempts: 1, diagnostics: true, logger });

  const error = await backend.openStream(LIVE_URL).then(
    () => null,
    (failure) => failure,
  );

  // Logged the way a session logs it: message plus the safe details.
  logger.warn('Failed to start a track; skipping.', { code: error.code, ...safeErrorDetails(error) });

  const output = text();
  assert.match(output, /potProviderLoaded: true/, 'the loaded flag was redacted or lost');
  assert.match(output, /potGenerationRequested: true/, 'the generation flag was redacted or lost');
  assert.match(output, /potAvailable: true/, 'the availability flag was redacted or lost');
  assert.ok(!output.includes('potAvailable: \[redacted\]'), 'a diagnostic redacted itself');
  assert.match(output, /potClient: 'tv'/);
});

test('the diagnostic never contains the token, in the log or the error', async () => {
  const { logger, text } = createCapturingLogger({ level: 'debug' });
  const spawnImpl = () => streamChildWithStderr([...TOKEN_FLOW, BOT_CHECK]);
  const backend = new YtDlpStreamBackend({ executable: 'yt-dlp', spawnImpl, maxAttempts: 1, diagnostics: true, logger });

  const error = await backend.openStream(LIVE_URL).then(
    () => null,
    (failure) => failure,
  );

  const logged = text();
  assert.ok(!logged.includes('SECRETTOKENVALUE1234567890'), 'the token reached the log');
  assert.ok(
    !JSON.stringify(error.details).includes('SECRETTOKENVALUE1234567890'),
    'the token reached the error details',
  );
  // The captured stderr is the one place a token could escape, because yt-dlp
  // prints the whole response at debug level. It is masked there too.
  assert.match(error.details.stderr, /po_token=\[redacted\]/, 'the token was not masked in the captured stderr');
  assert.match(error.details.stderr, /expires_at=1759999999/, 'the harmless part of the response was lost');
});

test('a block WITHOUT a token request is distinguished from one with', async () => {
  // The client failed before the token flow: no "Generating" line at all. This
  // is the case another client can fix.
  const silentFlow = ['[debug] [pot] PO Token Providers: bgutil:script-node-2.0.1 (external)', BOT_CHECK];
  const spawnImpl = () => streamChildWithStderr(silentFlow);
  const backend = new YtDlpStreamBackend({ executable: 'yt-dlp', spawnImpl, maxAttempts: 1, diagnostics: true, logger: createNullLogger() });

  const error = await backend.openStream(LIVE_URL).then(
    () => null,
    (failure) => failure,
  );

  assert.equal(error.code, 'MUSIC_YOUTUBE_BLOCKED');
  assert.equal(error.details.potProviderLoaded, true);
  assert.equal(error.details.potGenerationRequested, false, 'a token request was reported that never happened');
  assert.equal(error.details.potAvailable, false);
});

test('a block AFTER a token was generated is an IP block, and is not retried', async () => {
  let spawns = 0;
  const spawnImpl = () => {
    spawns += 1;
    return streamChildWithStderr([...TOKEN_FLOW, BOT_CHECK]);
  };
  const backend = new YtDlpStreamBackend({
    executable: 'yt-dlp',
    spawnImpl,
    maxAttempts: 3,
    retryDelayMs: 0,
    diagnostics: true,
    logger: createNullLogger(),
  });

  const error = await backend.openStream(LIVE_URL).then(
    () => null,
    (failure) => failure,
  );

  assert.equal(error.code, 'MUSIC_YOUTUBE_IP_BLOCKED', 'a post-token block must be classified as an IP block');
  assert.match(error.message, /IP block/);
  assert.equal(spawns, 1, 'an IP block was retried; it cannot succeed');
});

test('a token served from the yt-dlp cache also counts as available', async () => {
  // The memory cache means only the first track generates a token; later tracks
  // reuse it. Those must not be mistaken for "no token was requested".
  const cachedFlow = [
    '[debug] [pot] PO Token Providers: bgutil:script-node-2.0.1 (external)',
    '[debug] [pot:cache] TRACE: PO Token response retrieved from cache using "memory" provider: ' +
      "PoTokenResponse(po_token='CACHEDSECRET1234567890')",
    BOT_CHECK,
  ];
  const spawnImpl = () => streamChildWithStderr(cachedFlow);
  const backend = new YtDlpStreamBackend({ executable: 'yt-dlp', spawnImpl, maxAttempts: 1, diagnostics: true, logger: createNullLogger() });

  const error = await backend.openStream(LIVE_URL).then(
    () => null,
    (failure) => failure,
  );

  assert.equal(error.code, 'MUSIC_YOUTUBE_IP_BLOCKED');
  assert.equal(error.details.potAvailable, true);
  assert.ok(!JSON.stringify(error.details).includes('CACHEDSECRET'), 'a cached token reached the error details');
});

test('a marker split across two reads is still recognised', () => {
  const state = createPotDiagnostics();

  // Exactly what a chunk boundary does to a line.
  assert.deepEqual(scanPotDiagnostics('[debug] [pot] PO Token Prov', state), []);
  assert.deepEqual(scanPotDiagnostics('iders: bgutil:script-node-2.0.1 (external)\n', state), ['providerLoaded']);
  assert.equal(state.providerLoaded, true);
});

test('each fact is reported once, however often it is printed', () => {
  const state = createPotDiagnostics();
  const line = '[pot:bgutil:script-node] Generating a gvs PO Token for mweb client via bgutil script\n';

  assert.deepEqual(scanPotDiagnostics(line, state), ['generationRequested']);
  assert.deepEqual(scanPotDiagnostics(line, state), [], 'the same fact was reported twice');
  assert.equal(state.client, 'mweb');
});

test('a provider list without bgutil is not reported as loaded', () => {
  const state = createPotDiagnostics();

  assert.deepEqual(scanPotDiagnostics('[debug] [pot] PO Token Providers: none\n', state), []);
  assert.equal(state.providerLoaded, false, 'a loaded provider was claimed when there is none');
  assert.equal(potDiagnosticsSummary(state).potProviderLoaded, false);
});

test('verbose output stays out of a plain run', () => {
  // The diagnostics exist to watch the token flow; a run without a provider
  // keeps exactly the arguments it had before.
  assert.ok(!buildArguments({ url: LIVE_URL }).includes('--verbose'));
  assert.ok(buildArguments({ url: LIVE_URL }).includes('--no-warnings'));
  assert.ok(!buildArguments({ url: LIVE_URL, diagnostics: false }).includes('--verbose'));

  const withDiagnostics = buildArguments({ url: LIVE_URL, diagnostics: true });
  assert.ok(withDiagnostics.includes('--verbose'), 'the token flow would be invisible');
  assert.ok(!withDiagnostics.includes('--no-warnings'), 'the "no PO token was provided" warning would be suppressed');
  assert.equal(withDiagnostics.at(-1), LIVE_URL, 'the url is no longer last');
});

test('the blocked patterns are the ones YouTube actually sends', () => {
  assert.equal(isYoutubeBlocked("ERROR: [youtube] x: Sign in to confirm you're not a bot."), true);
  assert.equal(isYoutubeBlocked('ERROR: Sign in to confirm your age'), true);
  assert.equal(isYoutubeBlocked('ERROR: Video unavailable'), false);
  assert.equal(isYoutubeBlocked('ERROR: Requested format is not available'), false);
  assert.equal(isYoutubeBlocked(''), false);
});

test('a blocked failure is not retried', async () => {
  let spawns = 0;
  const spawnImpl = () => {
    spawns += 1;
    const streamChild = new EventEmitter();
    streamChild.stdout = new PassThrough();
    streamChild.stderr = new PassThrough();
    streamChild.kill = () => true;
    setImmediate(() => {
      streamChild.emit('spawn');
      setImmediate(() => {
        streamChild.stderr.write("ERROR: Sign in to confirm you're not a bot\n");
        setImmediate(() => streamChild.emit('close', 1, null));
      });
    });
    return streamChild;
  };

  const backend = new YtDlpStreamBackend({ executable: 'yt-dlp', spawnImpl, maxAttempts: 3, retryDelayMs: 0, logger: createNullLogger() });
  const error = await backend.openStream(LIVE_URL).then(
    () => null,
    (failure) => failure,
  );

  assert.equal(error?.code, 'MUSIC_YOUTUBE_BLOCKED');
  assert.equal(spawns, 1, 'a deterministic block was retried');
});

test('the blocked reason survives sanitization, without the URLs', async () => {
  const spawnImpl = () => {
    const streamChild = new EventEmitter();
    streamChild.stdout = new PassThrough();
    streamChild.stderr = new PassThrough();
    streamChild.kill = () => true;
    setImmediate(() => {
      streamChild.emit('spawn');
      setImmediate(() => {
        streamChild.stderr.write(
          "ERROR: Sign in to confirm you're not a bot\n  url: https://www.youtube.com/watch?v=abc&sig=SECRET\n",
        );
        setImmediate(() => streamChild.emit('close', 1, null));
      });
    });
    return streamChild;
  };

  const backend = new YtDlpStreamBackend({ executable: 'yt-dlp', spawnImpl, maxAttempts: 1, logger: createNullLogger() });
  const error = await backend.openStream(LIVE_URL).then(
    () => null,
    (failure) => failure,
  );

  // The diagnostics carried by the failure are what a session logs, so this is
  // where the guarantee has to hold: the reason readable, the URL not.
  assert.equal(error.code, 'MUSIC_YOUTUBE_BLOCKED');
  assert.match(error.details.stderr, /Sign in to confirm you're not a bot/);
  assert.ok(!error.details.stderr.includes('SECRET'), 'a signed URL reached the diagnostics');
  assert.match(error.details.stderr, /\[redacted\]/);
});
