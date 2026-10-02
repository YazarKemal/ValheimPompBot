import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  buildArguments,
  createStreamBackend,
  DEFAULT_FORMAT,
  DEFAULT_STREAM_TYPE,
  detectYtDlp,
  EXECUTABLE_CANDIDATES,
  MAX_STDERR_BYTES,
  YtDlpStreamBackend,
} from '../src/music/sources/ytdlp.js';
import { YouTubeSource, resolveStreamUrl } from '../src/music/sources/youtube.js';
import { createMusicSession, createSessionManager } from '../src/music/session.js';
import { normaliseTrack, MusicSource } from '../src/music/source.js';
import { startPompMusic } from '../src/music/bot.js';
import { createCapturingLogger, createNullLogger } from '../src/utils/logger.js';

/**
 * The yt-dlp streaming backend.
 *
 * `child_process.spawn` is injected everywhere, so no test starts a real
 * process, touches the network or writes a file.
 */

const LIVE_ID = 'ktTkTFHic';
const LIVE_URL = `https://www.youtube.com/watch?v=${LIVE_ID}`;

const enoent = () => Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });

/**
 * A child process double.
 *
 * Events are emitted across separate turns of the event loop: `spawn` first,
 * then the output and exit. A real child cannot deliver its exit in the same
 * tick it announces itself, and code that attaches listeners after awaiting
 * `openStream` depends on that ordering.
 *
 * @param {object} [options]
 * @param {string|null} [options.version] Emit this on stdout and exit 0 (a probe).
 * @param {number|null} [options.exitCode] Exit after spawn (a stream child).
 * @param {string} [options.stderr]
 * @param {Error|null} [options.failSpawn]
 */
function fakeChild({ version = '2026.01.01', exitCode = null, stderr = '', failSpawn = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.killSignals = [];
  child.kill = (signal) => {
    child.killed = true;
    child.killSignals.push(signal ?? 'SIGTERM');
    return true;
  };

  setImmediate(() => {
    if (failSpawn) {
      child.emit('error', failSpawn);
      return;
    }
    child.emit('spawn');

    setImmediate(() => {
      if (version !== null) {
        child.stdout.write(`${version}\n`);
        child.stdout.end();
      }
      if (stderr) child.stderr.write(stderr);
      const code = version !== null ? 0 : exitCode;
      if (code !== null) child.emit('close', code, null);
    });
  });

  return child;
}

/** Records every spawn call and serves scripted children in order. */
function spawnRecorder(children = []) {
  const calls = [];
  const queue = [...children];
  const impl = (command, args, options) => {
    calls.push({ command, args, options });
    return queue.shift() ?? fakeChild({ version: null, failSpawn: enoent() });
  };
  impl.calls = calls;
  return impl;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

/* -------------------------------------------------------------------------- */
/* Detection                                                                   */
/* -------------------------------------------------------------------------- */

test('a configured path is probed first and wins', async () => {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    return command === '/opt/yt-dlp/yt-dlp'
      ? fakeChild({ version: '2026.09.01' })
      : fakeChild({ version: null, failSpawn: enoent() });
  };

  const result = await detectYtDlp({ configuredPath: '/opt/yt-dlp/yt-dlp', spawnImpl });

  assert.equal(result.available, true);
  assert.equal(result.path, '/opt/yt-dlp/yt-dlp');
  assert.equal(result.version, '2026.09.01');
  assert.equal(result.source, 'configured');
  assert.equal(calls.length, 1, 'the configured path was not the only candidate tried');
});

test('detection falls back to yt-dlp on PATH', async () => {
  const spawnImpl = (command) =>
    command === EXECUTABLE_CANDIDATES[0]
      ? fakeChild({ version: '2026.03.04' })
      : fakeChild({ version: null, failSpawn: enoent() });

  const result = await detectYtDlp({ spawnImpl });

  assert.equal(result.available, true);
  assert.equal(result.path, 'yt-dlp');
  assert.equal(result.source, 'path');
});

test('detection falls back to yt-dlp.exe when the bare name is missing', async () => {
  const attempted = [];
  const spawnImpl = (command) => {
    attempted.push(command);
    return command === 'yt-dlp.exe' ? fakeChild({ version: '2026.05.06' }) : fakeChild({ version: null, failSpawn: enoent() });
  };

  const result = await detectYtDlp({ spawnImpl });

  assert.equal(result.available, true);
  assert.equal(result.path, 'yt-dlp.exe');
  assert.equal(result.source, 'path-windows');
  assert.deepEqual(attempted, ['yt-dlp', 'yt-dlp.exe'], 'the resolution order changed');
});

test('a missing yt-dlp is reported as unavailable with a reason, not thrown', async () => {
  const result = await detectYtDlp({ spawnImpl: () => fakeChild({ version: null, failSpawn: enoent() }) });

  assert.equal(result.available, false);
  assert.equal(result.path, null);
  assert.equal(result.source, 'none');
  assert.match(result.reason, /ENOENT/);
});

test('a yt-dlp that exits non-zero on --version is not treated as usable', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  const spawnImpl = () => {
    setImmediate(() => {
      child.emit('spawn');
      setImmediate(() => {
        child.stdout.write('2026.01.01\n');
        child.stdout.end();
        child.emit('close', 1, null);
      });
    });
    return child;
  };

  const result = await detectYtDlp({ spawnImpl });

  assert.equal(result.available, false, 'a broken shim was accepted as an install');
  assert.match(result.reason, /exited with code 1/);
});

test('the probe runs --version and never a shell', async () => {
  const spawnImpl = spawnRecorder([fakeChild({ version: '2026.01.01' })]);
  await detectYtDlp({ spawnImpl });

  assert.deepEqual(spawnImpl.calls[0].args, ['--version']);
  assert.equal(spawnImpl.calls[0].options?.shell, false, 'a shell was requested');
});

test('streaming can be disabled outright', async () => {
  const { backend, detection } = await createStreamBackend({ settings: { streamBackend: 'none' } });

  assert.equal(backend, null);
  assert.equal(detection.source, 'disabled');
});

test('an unavailable yt-dlp yields no backend rather than a broken one', async () => {
  const spawnImpl = () => fakeChild({ version: null, failSpawn: enoent() });
  const { backend, detection } = await createStreamBackend({ settings: { streamBackend: 'ytdlp' }, spawnImpl });

  assert.equal(backend, null, 'a backend was produced without yt-dlp');
  assert.equal(detection.available, false);
});

test('settings flow into the backend: executable, format and timeout', async () => {
  const spawnImpl = spawnRecorder([fakeChild({ version: '2026.01.01' })]);
  const { backend } = await createStreamBackend({
    settings: {
      streamBackend: 'ytdlp',
      ytdlpPath: 'C:\\tools\\yt-dlp.exe',
      ytdlpFormat: 'bestaudio[acodec=opus]/bestaudio',
      ytdlpStartupTimeoutMs: 5000,
    },
    spawnImpl,
  });

  assert.equal(backend.executable, 'C:\\tools\\yt-dlp.exe');
  assert.equal(backend.format, 'bestaudio[acodec=opus]/bestaudio');
  assert.equal(backend.startupTimeoutMs, 5000);
});

/* -------------------------------------------------------------------------- */
/* Command construction                                                        */
/* -------------------------------------------------------------------------- */

test('the argument list is fixed, array-passed and carries the URL once', () => {
  const args = buildArguments({ url: LIVE_URL });

  assert.ok(Array.isArray(args));
  assert.equal(args.filter((arg) => arg === LIVE_URL).length, 1, 'the url is not a single argument');
  assert.ok(args.includes('--no-playlist'));
  assert.ok(args.includes('--no-progress'));
  assert.ok(args.includes('--ignore-config'), 'a user config could change behaviour');
  assert.ok(args.includes('--no-cache-dir'), 'yt-dlp could write a cache to disk');
  assert.deepEqual(args.slice(-3), ['--format', DEFAULT_FORMAT, LIVE_URL]);
});

test('the default format is Opus, which Discord can play without transcoding', () => {
  assert.equal(DEFAULT_FORMAT, 'bestaudio[acodec=opus]');
  assert.ok(!DEFAULT_FORMAT.includes('bestaudio/'), 'the selector can fall back to a non-Opus stream');
  assert.equal(DEFAULT_STREAM_TYPE, 'webm/opus', 'the stream type must match what the format selector yields');
});

test('the url is last so it can never be read as a flag', () => {
  assert.equal(buildArguments({ url: LIVE_URL }).at(-1), LIVE_URL);
});

test('a hostile-looking url is still just one argument', () => {
  // resolveStreamUrl rejects this long before here, but the argument builder
  // must not be the thing that makes it dangerous.
  const args = buildArguments({ url: 'https://www.youtube.com/watch?v=x; rm -rf /' });

  assert.ok(args.some((arg) => arg.includes('rm -rf')), 'the value should be intact as a single argument');
  assert.ok(!args.includes('sh'), 'a shell was introduced');
  assert.ok(!args.includes('-c'));
});

/* -------------------------------------------------------------------------- */
/* Streaming                                                                   */
/* -------------------------------------------------------------------------- */

/** A backend over a scripted child. */
function backendWith(child, options = {}) {
  const spawnImpl = spawnRecorder([child]);
  return {
    spawnImpl,
    backend: new YtDlpStreamBackend({ executable: 'yt-dlp', spawnImpl, logger: createNullLogger(), ...options }),
  };
}

test('the full canonical URL is passed to spawn', async () => {
  const { backend, spawnImpl } = backendWith(fakeChild({ version: null }));
  await backend.openStream(LIVE_URL);

  const [{ command, args, options }] = spawnImpl.calls;
  assert.equal(command, 'yt-dlp');
  assert.equal(args.at(-1), LIVE_URL, 'the url was not passed');
  assert.notEqual(args.at(-1), LIVE_ID, 'a bare id was passed');
  assert.equal(options.shell, false, 'spawn was asked to use a shell');
});

test('stdout becomes the audio stream', async () => {
  const { backend } = backendWith(fakeChild({ version: null }));
  const { stream } = await backend.openStream(LIVE_URL);

  assert.ok(stream instanceof PassThrough);
  assert.equal(typeof stream.pipe, 'function');
});

test('the reported input type is the one Discord expects for Opus in WebM', async () => {
  const { backend } = backendWith(fakeChild({ version: null }));
  const { inputType } = await backend.openStream(LIVE_URL);

  assert.equal(inputType, DEFAULT_STREAM_TYPE);
  assert.equal(inputType, 'webm/opus');
});

test('the metadata reports the backend, format and startup time', async () => {
  const { backend } = backendWith(fakeChild({ version: null }));
  const { meta } = await backend.openStream(LIVE_URL);

  assert.equal(meta.backend, 'ytdlp');
  assert.equal(meta.format, DEFAULT_FORMAT);
  assert.equal(meta.streamType, DEFAULT_STREAM_TYPE);
  assert.ok(Number.isFinite(meta.startupMs));
});

test('stderr is captured into a bounded buffer', async () => {
  const noisy = fakeChild({ version: null, exitCode: 1, stderr: 'x'.repeat(MAX_STDERR_BYTES * 3) });
  const { backend } = backendWith(noisy);
  const handle = await backend.openStream(LIVE_URL);
  // The child will fail; the stream must be drained rather than left to throw.
  handle.stream.on('error', () => {});

  await tick();

  assert.ok(
    handle.meta.diagnostics.stderr.length <= MAX_STDERR_BYTES,
    `stderr grew to ${handle.meta.diagnostics.stderr.length} bytes`,
  );
  assert.equal(handle.meta.diagnostics.truncated, true, 'truncation was not recorded');
});

test('a non-zero exit before any audio errors the stream', async () => {
  const { backend } = backendWith(fakeChild({ version: null, exitCode: 1, stderr: 'ERROR: nope' }));
  const { stream } = await backend.openStream(LIVE_URL);

  const error = await new Promise((resolve) => stream.once('error', resolve));
  assert.equal(error.code, 'MUSIC_YTDLP_EXITED');
  assert.equal(error.details.exitCode, 1);
});

test('an unavailable format is reported as no-audio, not as a crash', async () => {
  const child = fakeChild({ version: null, exitCode: 1, stderr: 'ERROR: Requested format is not available' });
  const { backend } = backendWith(child);
  const { stream } = await backend.openStream(LIVE_URL);

  const error = await new Promise((resolve) => stream.once('error', resolve));
  assert.equal(error.code, 'MUSIC_YTDLP_NO_AUDIO');
  assert.match(error.message, /no playable audio/i);
});

test('a non-zero exit AFTER audio has flowed is not an error', async () => {
  const child = fakeChild({ version: null });
  const { backend } = backendWith(child);
  const { stream } = await backend.openStream(LIVE_URL);

  const errors = [];
  stream.on('error', (error) => errors.push(error));

  child.stdout.write(Buffer.from('audio'));
  await tick();
  child.emit('close', 1, null);
  await tick();

  assert.deepEqual(errors, [], 'a normal end-of-track was reported as a failure');
});

test('a missing executable is reported as a startup failure', async () => {
  const spawnImpl = spawnRecorder([fakeChild({ version: null, failSpawn: enoent() })]);
  const backend = new YtDlpStreamBackend({ executable: 'yt-dlp', spawnImpl, logger: createNullLogger() });

  await assert.rejects(
    () => backend.openStream(LIVE_URL),
    (error) => {
      assert.equal(error.code, 'MUSIC_YTDLP_NOT_FOUND');
      return true;
    },
  );
});

test('a child that never spawns times out and is killed', async () => {
  const silent = new EventEmitter();
  silent.stdout = new PassThrough();
  silent.stderr = new PassThrough();
  silent.killed = false;
  silent.kill = () => {
    silent.killed = true;
    return true;
  };
  const spawnImpl = spawnRecorder([silent]);
  const backend = new YtDlpStreamBackend({
    executable: 'yt-dlp',
    spawnImpl,
    startupTimeoutMs: 40,
    logger: createNullLogger(),
  });

  await assert.rejects(
    () => backend.openStream(LIVE_URL),
    (error) => {
      assert.equal(error.code, 'MUSIC_YTDLP_TIMEOUT');
      return true;
    },
  );
  assert.equal(silent.killed, true, 'the stuck child was left running');
});

test('kill terminates the process and is idempotent', async () => {
  const child = fakeChild({ version: null });
  const { backend } = backendWith(child);
  const handle = await backend.openStream(LIVE_URL);

  assert.equal(handle.kill(), true);
  assert.equal(child.killed, true);

  child.emit('close', 0, null);
  assert.equal(handle.kill(), false, 'a finished process was killed again');
});

test('closing the audio stream kills the process behind it', async () => {
  const child = fakeChild({ version: null });
  const { backend } = backendWith(child);
  const handle = await backend.openStream(LIVE_URL);

  handle.stream.destroy();
  await tick();

  assert.equal(child.killed, true, 'the process outlived its stream');
});

test('opening two streams starts two independent processes', async () => {
  const first = fakeChild({ version: null });
  const second = fakeChild({ version: null });
  const spawnImpl = spawnRecorder([first, second]);
  const backend = new YtDlpStreamBackend({ executable: 'yt-dlp', spawnImpl, logger: createNullLogger() });

  const handleA = await backend.openStream('https://www.youtube.com/watch?v=aaaaaaaaaaa');
  const handleB = await backend.openStream('https://www.youtube.com/watch?v=bbbbbbbbbbb');

  assert.equal(spawnImpl.calls.length, 2);
  assert.ok(handleB);
  handleA.kill();

  assert.equal(first.killed, true);
  assert.equal(second.killed, false, 'killing one stream killed another');
});

/* -------------------------------------------------------------------------- */
/* Track contract and the source                                               */
/* -------------------------------------------------------------------------- */

test('a malformed track never spawns a process', async () => {
  const spawnImpl = spawnRecorder([]);
  const backend = new YtDlpStreamBackend({ executable: 'yt-dlp', spawnImpl, logger: createNullLogger() });
  const source = new YouTubeSource({ streamBackend: backend });

  await assert.rejects(
    () => source.createAudioStream({ id: null, url: null, title: 'Broken' }),
    (error) => {
      assert.equal(error.code, 'MUSIC_TRACK_INVALID');
      return true;
    },
  );

  assert.deepEqual(spawnImpl.calls, [], 'yt-dlp was started for an unusable track');
});

test('a bare id is canonicalised before reaching spawn', async () => {
  const { backend, spawnImpl } = backendWith(fakeChild({ version: null }));
  const source = new YouTubeSource({ streamBackend: backend });

  await source.createAudioStream({ id: LIVE_ID, url: null, title: 't' });

  assert.equal(spawnImpl.calls[0].args.at(-1), LIVE_URL);
});

test('the search text never reaches the process arguments', async () => {
  const { backend, spawnImpl } = backendWith(fakeChild({ version: null }));
  const source = new YouTubeSource({ streamBackend: backend });
  const searchText = 'sezen aksu & "gülünse" ; rm -rf /';

  await source.createAudioStream({ id: LIVE_ID, url: LIVE_URL, title: searchText });

  const args = spawnImpl.calls[0].args;
  assert.ok(!args.some((arg) => arg.includes('sezen')), 'the search text was passed to yt-dlp');
  assert.ok(!args.some((arg) => arg.includes('rm -rf')));
});

test('an unknown backend failure is wrapped with a stable code', async () => {
  const source = new YouTubeSource({
    streamBackend: {
      async openStream() {
        throw new Error('vendor exploded');
      },
    },
  });

  await assert.rejects(
    () => source.createAudioStream({ id: LIVE_ID, url: LIVE_URL, title: 't' }),
    (error) => {
      assert.equal(error.code, 'MUSIC_STREAM_FAILED');
      assert.equal(error.details.videoId, LIVE_ID);
      return true;
    },
  );
});

test('a backend error with its own code passes through unchanged', async () => {
  const source = new YouTubeSource({
    streamBackend: {
      async openStream() {
        const error = new Error('no audio');
        error.code = 'MUSIC_YTDLP_NO_AUDIO';
        throw error;
      },
    },
  });

  await assert.rejects(
    () => source.createAudioStream({ id: LIVE_ID, url: LIVE_URL, title: 't' }),
    (error) => {
      assert.equal(error.code, 'MUSIC_YTDLP_NO_AUDIO');
      return true;
    },
  );
});

test('stream startup logs the backend, track, format and stream type', async () => {
  const { logger, text } = createCapturingLogger({ level: 'debug' });
  const { backend } = backendWith(fakeChild({ version: null }));
  const source = new YouTubeSource({ streamBackend: backend, logger });

  await source.createAudioStream({ id: LIVE_ID, url: LIVE_URL, title: 't' });

  const output = text();
  assert.match(output, /Audio stream started/);
  assert.match(output, /backend: 'ytdlp'/);
  assert.match(output, /trackId: 'ktTkTFHic'/);
  assert.match(output, /startupMs/);
});

test('no signed media URL is ever logged', async () => {
  const { logger, text } = createCapturingLogger({ level: 'debug' });
  const { backend } = backendWith(fakeChild({ version: null }));
  const source = new YouTubeSource({ streamBackend: backend, logger });
  const signed = 'https://rr3---sn-abc.googlevideo.com/videoplayback?expire=1&sig=SECRETSIG&token=SECRETTOKEN';

  await source.createAudioStream({ id: LIVE_ID, url: signed, title: 't' }).catch(() => {});

  assert.ok(!text().includes('SECRETSIG'), 'the signature was logged');
  assert.ok(!text().includes('SECRETTOKEN'), 'the token was logged');
});

/* -------------------------------------------------------------------------- */
/* Process lifecycle in the session                                            */
/* -------------------------------------------------------------------------- */

/** A source whose streams record their own lifetime. */
class LifecycleSource extends MusicSource {
  constructor() {
    super({ name: 'lifecycle' });
    this.opened = [];
    this.killed = [];
    this.failOn = null;
  }

  async search() {
    return [];
  }

  async createAudioStream(track) {
    const id = track.id;
    this.opened.push(id);
    if (this.failOn === id) {
      const error = new Error('no audio');
      error.code = 'MUSIC_YTDLP_NO_AUDIO';
      throw error;
    }
    return {
      stream: { pipe() {} },
      inputType: 'webm/opus',
      kill: () => {
        this.killed.push(id);
        return true;
      },
      meta: { backend: 'ytdlp' },
    };
  }
}

function sessionWith(source, guildId = 'g1') {
  const voice = new EventEmitter();
  Object.assign(voice, {
    channelId: null,
    async join(channelId) {
      this.channelId = channelId;
    },
    play() {},
    pause() {},
    resume() {},
    stop() {},
    destroy() {},
  });
  const session = createMusicSession({
    guildId,
    source,
    voice,
    voiceChannelId: `vc-${guildId}`,
    idleDisconnectSeconds: 0,
    logger: createNullLogger(),
  });
  return { session, voice };
}

const makeTrack = (id, title) =>
  normaliseTrack({ id, source: 'youtube', title, url: `https://www.youtube.com/watch?v=${id}` });
const trackA = makeTrack('aaaaaaaaaaa', 'A');
const trackB = makeTrack('bbbbbbbbbbb', 'B');
const REQUESTER = { id: 'u', name: 'U' };

test('queue advance starts a new process and kills the previous one', async () => {
  const source = new LifecycleSource();
  const { session } = sessionWith(source);

  await session.begin();
  await session.enqueue(trackA, REQUESTER);
  await session.enqueue(trackB, REQUESTER);

  assert.deepEqual(source.opened, ['aaaaaaaaaaa']);

  session.skip();
  await tick();

  assert.deepEqual(source.opened, ['aaaaaaaaaaa', 'bbbbbbbbbbb'], 'the next track did not open a process');
  assert.ok(source.killed.includes('aaaaaaaaaaa'), 'the previous process was left running');
});

test('skip kills the running process', async () => {
  const source = new LifecycleSource();
  const { session } = sessionWith(source);

  await session.begin();
  await session.enqueue(trackA, REQUESTER);
  session.skip();
  await tick();

  assert.ok(source.killed.includes('aaaaaaaaaaa'));
});

test('stop kills the running process', async () => {
  const source = new LifecycleSource();
  const { session } = sessionWith(source);

  await session.begin();
  await session.enqueue(trackA, REQUESTER);
  session.stop();

  assert.ok(source.killed.includes('aaaaaaaaaaa'), 'stop left the process running');
  assert.equal(session.hasActiveStream(), false);
});

test('pause and resume do not disturb the process', async () => {
  const source = new LifecycleSource();
  const { session } = sessionWith(source);

  await session.begin();
  await session.enqueue(trackA, REQUESTER);
  session.pause();
  session.resume();

  assert.deepEqual(source.killed, [], 'pausing killed the stream');
  assert.equal(session.hasActiveStream(), true);
});

test('a natural track end releases the process handle', async () => {
  const source = new LifecycleSource();
  const { session, voice } = sessionWith(source);

  await session.begin();
  await session.enqueue(trackA, REQUESTER);
  assert.equal(session.hasActiveStream(), true);

  voice.emit('idle');
  await tick();

  assert.equal(session.hasActiveStream(), false);
});

test('destroying the session kills the running process', async () => {
  const source = new LifecycleSource();
  const { session, voice } = sessionWith(source);

  await session.begin();
  await session.enqueue(trackA, REQUESTER);
  voice.emit('stateChange', 'disconnected');

  assert.ok(source.killed.includes('aaaaaaaaaaa'), 'a dropped voice connection left yt-dlp running');
  assert.equal(session.destroyed, true);
});

test('/git destroys the session and its process', async () => {
  const source = new LifecycleSource();
  const sessions = createSessionManager();
  const { session } = sessionWith(source);
  sessions.getOrCreate('g1', () => session);

  await session.begin();
  await session.enqueue(trackA, REQUESTER);
  sessions.remove('g1');

  assert.ok(source.killed.includes('aaaaaaaaaaa'));
  assert.equal(sessions.size, 0);
});

test('a stream failure skips the track instead of wedging playback', async () => {
  const source = new LifecycleSource();
  source.failOn = 'bbbbbbbbbbb';
  const { session, voice } = sessionWith(source);

  await session.begin();
  await session.enqueue(trackA, REQUESTER);
  await session.enqueue(trackB, REQUESTER);

  voice.emit('idle');
  await tick();
  await tick();

  assert.equal(session.destroyed, false, 'a failed stream took the session down');
  assert.ok(source.killed.includes('aaaaaaaaaaa'), 'the finished track was not cleaned up');
});

test("one guild cannot kill another guild's process", async () => {
  const source = new LifecycleSource();
  const first = sessionWith(source, 'g1');
  const second = sessionWith(source, 'g2');

  await first.session.begin();
  await second.session.begin();
  await first.session.enqueue(trackA, REQUESTER);
  await second.session.enqueue(trackB, REQUESTER);

  first.session.stop();

  assert.deepEqual(source.killed, ['aaaaaaaaaaa'], "guild one killed guild two's process");
  assert.equal(second.session.hasActiveStream(), true, 'guild two lost its stream');
});

/* -------------------------------------------------------------------------- */
/* Startup reporting                                                           */
/* -------------------------------------------------------------------------- */

function musicConfig(overrides = {}) {
  return {
    pompMusic: {
      enabled: true,
      token: `pompmusic-${'x'.repeat(60)}`,
      clientId: '222222222222222222',
      textChannel: 'muzik-istek',
      stayConnected: true,
      streamBackend: 'ytdlp',
      maxQueueSize: 50,
      maxTrackMinutes: 20,
      ...overrides,
    },
  };
}

function fakeClient() {
  const client = new EventEmitter();
  client.login = async () => {};
  client.destroy = async () => {};
  client.guilds = { cache: new Map() };
  client.user = { tag: 'PompMusic#0001' };
  return client;
}

test('a missing backend is reported clearly and does not stop the bot', async () => {
  const { logger, text } = createCapturingLogger({ level: 'debug' });

  const bot = await startPompMusic({
    config: musicConfig(),
    logger,
    clientFactory: fakeClient,
    spawnImpl: () => fakeChild({ version: null, failSpawn: enoent() }),
  });

  assert.ok(bot, 'PompMusic failed to start entirely');
  assert.equal(bot.canStream, false);
  assert.match(text(), /stream backend unavailable/i);
  assert.match(text(), /YTDLP_PATH/);
});

test('a present backend logs its version and path category, never a secret', async () => {
  const { logger, text } = createCapturingLogger({ level: 'debug' });
  const config = musicConfig();

  const bot = await startPompMusic({
    config,
    logger,
    clientFactory: fakeClient,
    spawnImpl: spawnRecorder([fakeChild({ version: '2026.07.08' })]),
  });

  assert.equal(bot.canStream, true);
  assert.match(text(), /Music stream backend ready/);
  assert.match(text(), /2026\.07\.08/);
  assert.match(text(), /source: 'path'/);
  assert.ok(!text().includes(config.pompMusic.token), 'the token reached the log');
});

test('resolution is pure and needs no process', () => {
  assert.equal(resolveStreamUrl({ id: LIVE_ID, url: null }), LIVE_URL);
  assert.equal(resolveStreamUrl({ id: LIVE_ID, url: LIVE_URL }), LIVE_URL);
});
