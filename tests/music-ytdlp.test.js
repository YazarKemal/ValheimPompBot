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

/** Stand-in for the first bytes yt-dlp would write to stdout. */
const AUDIO_BYTES = Buffer.from('1a45dfa3-webm-opus-audio');

/**
 * A child process double.
 *
 * Events are emitted across separate turns of the event loop: `spawn` first,
 * then the output and exit. A real child cannot deliver its exit in the same
 * tick it announces itself, and code that attaches listeners after awaiting
 * `openStream` depends on that ordering.
 *
 * A stream child that is expected to succeed writes audio by default, because
 * `openStream` no longer resolves without it. Tests about silence pass
 * `audio: null`; tests about failure set an exit code, which suppresses the
 * default bytes so the child really does exit without producing anything.
 *
 * @param {object} [options]
 * @param {string|null} [options.version] Emit this on stdout and exit 0 (a probe).
 * @param {number|null} [options.exitCode] Exit after spawn (a stream child).
 * @param {string} [options.stderr]
 * @param {Buffer|null} [options.audio] Bytes to write to stdout. Defaults to a
 *   chunk for a stream child that is neither failing nor exiting immediately.
 * @param {Error|null} [options.failSpawn]
 */
function fakeChild({ version = '2026.01.01', exitCode = null, stderr = '', audio, failSpawn = null } = {}) {
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

  const isStreamChild = version === null;
  const silentByDesign = Boolean(failSpawn) || exitCode !== null;
  const audioBytes = audio === undefined ? (isStreamChild && !silentByDesign ? AUDIO_BYTES : null) : audio;

  // Started when the recorder hands the child out, not when it is constructed.
  // A retry reuses the same scripted list, and a child that had already emitted
  // 'spawn' before its attempt began would otherwise never be seen to start.
  child.start = () =>
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
        } else if (audioBytes) {
          // Deliberately not ended: a live stream stays open until the test says
          // otherwise, which is what a real extraction looks like.
          child.stdout.write(audioBytes);
        }
        if (stderr) child.stderr.write(stderr);
        const code = version !== null ? 0 : exitCode;
        // One turn later, so output is always delivered before the exit - the
        // ordering a real process gives, and the reason stderr can be read from
        // the failure it caused.
        if (code !== null) setImmediate(() => child.emit('close', code, null));
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
    const child = queue.shift() ?? fakeChild({ version: null, failSpawn: enoent() });
    child.start?.();
    return child;
  };
  impl.calls = calls;
  return impl;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Starts a child handed out by a spawnImpl that is not a recorder. */
function serve(child) {
  child.start?.();
  return child;
}

/* -------------------------------------------------------------------------- */
/* Detection                                                                   */
/* -------------------------------------------------------------------------- */

test('a configured path is probed first and wins', async () => {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    return serve(command === '/opt/yt-dlp/yt-dlp' ? fakeChild({ version: '2026.09.01' }) : fakeChild({ version: null, failSpawn: enoent() }));
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
    serve(command === EXECUTABLE_CANDIDATES[0] ? fakeChild({ version: '2026.03.04' }) : fakeChild({ version: null, failSpawn: enoent() }));

  const result = await detectYtDlp({ spawnImpl });

  assert.equal(result.available, true);
  assert.equal(result.path, 'yt-dlp');
  assert.equal(result.source, 'path');
});

test('detection falls back to yt-dlp.exe when the bare name is missing', async () => {
  const attempted = [];
  const spawnImpl = (command) => {
    attempted.push(command);
    return serve(command === 'yt-dlp.exe' ? fakeChild({ version: '2026.05.06' }) : fakeChild({ version: null, failSpawn: enoent() }));
  };

  const result = await detectYtDlp({ spawnImpl });

  assert.equal(result.available, true);
  assert.equal(result.path, 'yt-dlp.exe');
  assert.equal(result.source, 'path-windows');
  assert.deepEqual(attempted, ['yt-dlp', 'yt-dlp.exe'], 'the resolution order changed');
});

test('a missing yt-dlp is reported as unavailable with a reason, not thrown', async () => {
  const result = await detectYtDlp({ spawnImpl: () => serve(fakeChild({ version: null, failSpawn: enoent() })) });

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
  const spawnImpl = () => serve(fakeChild({ version: null, failSpawn: enoent() }));
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

/**
 * A backend over a scripted child.
 *
 * One attempt by default: retrying is itself under test elsewhere, and a
 * scripted recorder only has the children a test gave it.
 */
function backendWith(child, options = {}) {
  const spawnImpl = spawnRecorder([child]);
  return {
    spawnImpl,
    backend: new YtDlpStreamBackend({
      executable: 'yt-dlp',
      spawnImpl,
      logger: createNullLogger(),
      maxAttempts: 1,
      ...options,
    }),
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
  const noisy = fakeChild({ version: null, exitCode: 1, stderr: 'x'.repeat(MAX_STDERR_BYTES * 3), audio: null });
  const { backend } = backendWith(noisy);

  const error = await backend.openStream(LIVE_URL).then(
    () => null,
    (failure) => failure,
  );

  assert.ok(error, 'a child that produced nothing was reported as a start');
  assert.equal(error.details.stderrTruncated, true, 'truncation was not recorded');
  // What travels into the error is bounded far below the capture buffer.
  assert.ok(error.details.stderr.length <= 500, `stderr in the error grew to ${error.details.stderr.length} bytes`);
});

test('a non-zero exit before any audio is a startup failure', async () => {
  const { backend } = backendWith(fakeChild({ version: null, exitCode: 1, stderr: 'ERROR: nope', audio: null }));

  const error = await backend.openStream(LIVE_URL).then(
    () => null,
    (failure) => failure,
  );

  assert.ok(error, 'a failed extraction resolved as though it had started');
  assert.equal(error.code, 'MUSIC_YTDLP_EXITED');
  assert.equal(error.details.exitCode, 1);
  assert.equal(error.details.bytes, 0);
});

test('an unavailable format is reported as no-audio, not as a crash', async () => {
  const child = fakeChild({
    version: null,
    exitCode: 1,
    stderr: 'ERROR: Requested format is not available',
    audio: null,
  });
  const { backend } = backendWith(child);

  const error = await backend.openStream(LIVE_URL).then(
    () => null,
    (failure) => failure,
  );

  assert.equal(error?.code, 'MUSIC_YTDLP_NO_AUDIO');
  assert.match(error.message, /no playable audio/i);
});

test('a clean exit with no audio is a failure, not a track that ended', async () => {
  // The silent case: yt-dlp exits 0 having written nothing. It used to look
  // like a track that played and finished instantly.
  const { backend } = backendWith(fakeChild({ version: null, exitCode: 0, audio: null }));

  const error = await backend.openStream(LIVE_URL).then(
    () => null,
    (failure) => failure,
  );

  assert.equal(error?.code, 'MUSIC_YTDLP_NO_AUDIO');
  assert.equal(error.details.exitCode, 0);
  assert.equal(error.details.bytes, 0);
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
    // The timeout is retryable, so a single attempt is what makes the code
    // under test the thing that surfaces here.
    maxAttempts: 1,
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
/* The first-byte gate                                                         */
/* -------------------------------------------------------------------------- */

test('openStream does not resolve on spawn alone', async () => {
  // A process that spawns and then says nothing must not look like a start.
  const silent = fakeChild({ version: null, audio: null });
  const { backend } = backendWith(silent, { firstByteTimeoutMs: 40, maxAttempts: 1 });

  const pending = backend.openStream(LIVE_URL);
  const outcome = await Promise.race([pending.then(() => 'resolved'), tick().then(() => 'still-pending')]);

  assert.equal(outcome, 'still-pending', 'a silent process was treated as a started stream');

  // It does fail, just later - and the process does not outlive the attempt.
  const error = await pending.catch((failure) => failure);
  assert.equal(error.code, 'MUSIC_YTDLP_FIRST_BYTE_TIMEOUT');
  assert.equal(silent.killed, true, 'the silent process was left running');
});

test('openStream resolves on the first audio byte, not before', async () => {
  const child = fakeChild({ version: null, audio: null });
  const { backend } = backendWith(child, { firstByteTimeoutMs: 1000, maxAttempts: 1 });

  const pending = backend.openStream(LIVE_URL);
  let settled = false;
  void pending.then(() => {
    settled = true;
  });

  await tick();
  await tick();
  assert.equal(settled, false, 'the stream resolved without any audio');

  child.stdout.write(AUDIO_BYTES);
  const handle = await pending;

  assert.equal(settled, true);
  assert.ok(handle.meta.firstByteMs >= 0, 'the first-byte time was not recorded');
  assert.equal(handle.meta.attempt, 1);
});

test('the first audio byte is not swallowed by the gate', async () => {
  const child = fakeChild({ version: null, audio: null });
  const { backend } = backendWith(child, { firstByteTimeoutMs: 1000, maxAttempts: 1 });

  const pending = backend.openStream(LIVE_URL);
  await tick();
  await tick();
  child.stdout.write(AUDIO_BYTES);

  const handle = await pending;
  const received = [];
  handle.stream.on('data', (chunk) => received.push(chunk));

  await tick();
  await tick();

  const total = Buffer.concat(received);
  assert.equal(total.length, AUDIO_BYTES.length, 'the audio that satisfied the gate was dropped');
  assert.deepEqual(total, AUDIO_BYTES);
});

test('a silent process is abandoned after the first-byte timeout and killed', async () => {
  const silent = fakeChild({ version: null, audio: null });
  const { backend } = backendWith(silent, { firstByteTimeoutMs: 40, maxAttempts: 1, retryDelayMs: 0 });

  const error = await backend.openStream(LIVE_URL).then(
    () => null,
    (failure) => failure,
  );

  assert.equal(error?.code, 'MUSIC_YTDLP_FIRST_BYTE_TIMEOUT');
  assert.equal(error.details.timeoutMs, 40);
  assert.equal(silent.killed, true, 'the stuck process was left running');
});

test('a pre-audio failure is retried, and a later attempt can succeed', async () => {
  const silent = fakeChild({ version: null, audio: null });
  const working = fakeChild({ version: null });
  const spawnImpl = spawnRecorder([silent, working]);
  const backend = new YtDlpStreamBackend({
    executable: 'yt-dlp',
    spawnImpl,
    firstByteTimeoutMs: 40,
    retryDelayMs: 0,
    logger: createNullLogger(),
  });

  const handle = await backend.openStream(LIVE_URL);

  assert.equal(spawnImpl.calls.length, 2, 'the silent attempt was not retried');
  assert.equal(handle.meta.attempt, 2);
  assert.equal(handle.meta.attempts, 2);
  assert.equal(silent.killed, true, 'the failed attempt was left running');
});

test('retries are bounded by maxAttempts', async () => {
  const spawnImpl = spawnRecorder([
    fakeChild({ version: null, audio: null }),
    fakeChild({ version: null, audio: null }),
    fakeChild({ version: null, audio: null }),
  ]);
  const backend = new YtDlpStreamBackend({
    executable: 'yt-dlp',
    spawnImpl,
    firstByteTimeoutMs: 40,
    maxAttempts: 2,
    retryDelayMs: 0,
    logger: createNullLogger(),
  });

  const error = await backend.openStream(LIVE_URL).then(
    () => null,
    (failure) => failure,
  );

  assert.ok(error, 'a track that never produced audio resolved as a start');
  assert.equal(spawnImpl.calls.length, 2, `yt-dlp was started ${spawnImpl.calls.length} times`);
});

test('a missing executable is not retried', async () => {
  const spawnImpl = spawnRecorder([]);
  const backend = new YtDlpStreamBackend({
    executable: 'yt-dlp',
    spawnImpl,
    retryDelayMs: 0,
    maxAttempts: 3,
    logger: createNullLogger(),
  });

  await assert.rejects(
    () => backend.openStream(LIVE_URL),
    (error) => {
      assert.equal(error.code, 'MUSIC_YTDLP_NOT_FOUND');
      return true;
    },
  );
  assert.equal(spawnImpl.calls.length, 1, 'a deterministic failure was retried');
});

test('a failure after audio has flowed is never retried', async () => {
  const child = fakeChild({ version: null });
  const spawnImpl = spawnRecorder([child]);
  const backend = new YtDlpStreamBackend({
    executable: 'yt-dlp',
    spawnImpl,
    maxAttempts: 3,
    retryDelayMs: 0,
    logger: createNullLogger(),
  });

  const handle = await backend.openStream(LIVE_URL);
  const errors = [];
  handle.stream.on('error', (error) => errors.push(error));

  child.emit('close', 1, null);
  await tick();

  assert.deepEqual(errors, [], 'a mid-track failure was reported as an error');
  assert.equal(spawnImpl.calls.length, 1, 'a track that had started was restarted');
});

test('spawn, first byte and exit are all logged', async () => {
  const { logger, text } = createCapturingLogger({ level: 'debug' });
  const child = fakeChild({ version: null });
  const spawnImpl = spawnRecorder([child]);
  const backend = new YtDlpStreamBackend({ executable: 'yt-dlp', spawnImpl, logger });

  const handle = await backend.openStream(LIVE_URL);
  child.emit('close', 0, null);
  handle.stream.on('error', () => {});

  const output = text();
  assert.match(output, /yt-dlp spawned/);
  assert.match(output, /first audio byte/);
  assert.match(output, /yt-dlp exited/);
  assert.match(output, /spawnMs/);
  assert.match(output, /firstByteMs/);
  assert.match(output, /bytes/);
});

test('a retry is logged with the reason', async () => {
  const { logger, text } = createCapturingLogger({ level: 'debug' });
  const spawnImpl = spawnRecorder([fakeChild({ version: null, audio: null }), fakeChild({ version: null })]);
  const backend = new YtDlpStreamBackend({
    executable: 'yt-dlp',
    spawnImpl,
    firstByteTimeoutMs: 40,
    retryDelayMs: 0,
    logger,
  });

  await backend.openStream(LIVE_URL);

  assert.match(text(), /retrying/);
  assert.match(text(), /MUSIC_YTDLP_FIRST_BYTE_TIMEOUT/);
});

test('the retry log carries sanitized stderr, never the raw output', async () => {
  const { logger, text } = createCapturingLogger({ level: 'debug' });
  const failing = fakeChild({
    version: null,
    audio: null,
    stderr:
      "ERROR: [youtube] abc: Sign in to confirm you're not a bot\n" +
      '  url: https://www.youtube.com/watch?v=abc&sig=SECRETSIG\n' +
      'cookie: SID=SECRETCOOKIE; HSID=ALSOSECRET',
  });
  const spawnImpl = spawnRecorder([failing, fakeChild({ version: null })]);
  const backend = new YtDlpStreamBackend({
    executable: 'yt-dlp',
    spawnImpl,
    firstByteTimeoutMs: 40,
    retryDelayMs: 0,
    logger,
  });

  await backend.openStream(LIVE_URL);

  const output = text();
  assert.match(output, /Sign in to confirm you're not a bot/, 'the real reason is missing from the retry log');
  assert.match(output, /sanitizedStderr/);
  assert.ok(!output.includes('SECRETSIG'), 'a signed media URL reached the log');
  assert.ok(!output.includes('SECRETCOOKIE'), 'a cookie value reached the log');
  assert.ok(!output.includes('ALSOSECRET'), 'a cookie value reached the log');
});

test('a failed attempt carries the diagnostics a Render log needs', async () => {
  const child = fakeChild({
    version: null,
    exitCode: 1,
    audio: null,
    stderr: 'ERROR: unable to download video data: HTTP Error 403: Forbidden\nurl: https://x.example.com/v?sig=SECRET',
  });
  const { backend } = backendWith(child);

  const error = await backend.openStream(LIVE_URL).then(
    () => null,
    (failure) => failure,
  );

  assert.equal(error.code, 'MUSIC_YTDLP_EXITED');
  assert.equal(error.details.exitCode, 1);
  assert.equal(error.details.bytes, 0);
  assert.match(error.details.stderr, /HTTP Error 403/);
  assert.ok(!error.details.stderr.includes('SECRET'), 'a signed URL travelled inside the error');
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
    spawnImpl: () => serve(fakeChild({ version: null, failSpawn: enoent() })),
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
