import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMusicSession, createSessionManager, ENQUEUE_RESULT } from '../src/music/session.js';
import { MusicSource, normaliseTrack } from '../src/music/source.js';
import { BotError } from '../src/utils/errors.js';
import { createNullLogger, createCapturingLogger } from '../src/utils/logger.js';

/**
 * Session lifecycle against a fake voice adapter and a fake source. No gateway,
 * no audio encoder, no network.
 */

const track = (id, overrides = {}) => normaliseTrack({ id, source: 'fake', title: `Song ${id}`, durationSeconds: 200, ...overrides });

/**
 * Records every call and lets a test trigger player events.
 *
 * `playOutcome` stands in for what the Discord adapter reports about playback:
 * a promise that resolves once the player reaches Playing, `{ ok: false }` when
 * it never does, or nothing at all for an adapter that does not report - which
 * the session must still tolerate.
 */
function fakeVoice({ failPlay = false, playOutcome = undefined } = {}) {
  const handlers = new Map();
  const calls = [];
  let joined = null;

  return {
    calls,
    get channelId() {
      return joined;
    },
    isConnected: true,
    async join(channelId) {
      if (failPlay && channelId === 'broken') throw new Error('cannot join');
      joined = channelId;
      calls.push({ method: 'join', channelId });
    },
    play(stream, options) {
      calls.push({ method: 'play', options });
      return typeof playOutcome === 'function' ? playOutcome(stream, options) : playOutcome;
    },
    pause() {
      calls.push({ method: 'pause' });
    },
    resume() {
      calls.push({ method: 'resume' });
    },
    stop() {
      calls.push({ method: 'stop' });
    },
    leave() {
      calls.push({ method: 'leave' });
    },
    destroy() {
      calls.push({ method: 'destroy' });
      joined = null;
    },
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    /** Test hook: simulate the player finishing a track. */
    emit(event, payload) {
      for (const handler of handlers.get(event) ?? []) handler(payload);
    },
  };
}

/** A source that hands back a dummy stream. */
class FakeSource extends MusicSource {
  constructor({ failStream = null } = {}) {
    super({ name: 'fake' });
    this.failStream = failStream;
    this.streamed = [];
  }

  async search(query) {
    return [track('a', { title: query })];
  }

  async createAudioStream(item) {
    this.streamed.push(item.id);
    if (this.failStream === item.id) throw new Error('stream unavailable');
    return { stream: { pipe() {} }, inputType: 'arbitrary' };
  }
}

function makeSession(overrides = {}) {
  const voice = overrides.voice ?? fakeVoice();
  const source = overrides.source ?? new FakeSource();
  const session = createMusicSession({
    guildId: 'g1',
    source,
    voice,
    voiceChannelId: 'vc1',
    idleDisconnectSeconds: overrides.idleDisconnectSeconds ?? 120,
    maxQueueSize: overrides.maxQueueSize ?? 50,
    maxTrackSeconds: overrides.maxTrackSeconds ?? 1200,
    logger: overrides.logger ?? createNullLogger(),
    ...overrides.sessionOptions,
  });
  return { session, voice, source };
}

/* -------------------------------------------------------------------------- */
/* Playback is announced only once it is playing                               */
/* -------------------------------------------------------------------------- */

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a track is announced only after the player reports playback', async () => {
  let release;
  const voice = fakeVoice({ playOutcome: () => new Promise((resolve) => { release = resolve; }) });
  const { session } = makeSession({ voice });
  const announced = [];
  session.on('trackStart', (item) => announced.push(item.track.id));

  const pending = session.enqueue(track('a'), { id: 'u1', name: 'Ada' });
  await settle();

  assert.deepEqual(announced, [], 'the track was announced before playback began');

  release({ ok: true, reason: null, status: 'playing' });
  const result = await pending;

  assert.equal(result.started, true);
  assert.deepEqual(announced, ['a']);
});

test('a track that never reaches Playing is skipped and reported, not announced', async () => {
  const voice = fakeVoice({ playOutcome: () => ({ ok: false, reason: 'idle-before-playing', status: 'idle' }) });
  const { session, source } = makeSession({ voice });
  const announced = [];
  const errors = [];
  session.on('trackStart', (item) => announced.push(item.track.id));
  session.on('error', (payload) => errors.push(payload));

  const result = await session.enqueue(track('a'), { id: 'u1', name: 'Ada' });

  assert.deepEqual(announced, [], 'a track that never played was announced as playing');
  assert.equal(result.ok, false);
  assert.equal(result.reason, ENQUEUE_RESULT.START_FAILED);
  assert.equal(result.started, false);
  assert.equal(session.isPlaying(), false);
  assert.deepEqual(source.streamed, ['a']);
  assert.equal(errors.length, 1, 'the failure was not reported');
  assert.equal(errors[0].stage, 'player');
  assert.equal(errors[0].error.code, 'MUSIC_PLAYBACK_NOT_STARTED');
});

test('a player failure moves on to the next queued track', async () => {
  let call = 0;
  const voice = fakeVoice({
    playOutcome: () => {
      call += 1;
      return call === 1 ? { ok: false, reason: 'idle-before-playing', status: 'idle' } : { ok: true, reason: null, status: 'playing' };
    },
  });
  const { session, source } = makeSession({ voice });
  const announced = [];
  session.on('trackStart', (item) => announced.push(item.track.id));

  await session.enqueue(track('a'), { id: 'u1', name: 'Ada' });
  await session.enqueue(track('b'), { id: 'u1', name: 'Ada' });

  assert.deepEqual(source.streamed, ['a', 'b'], 'the next track was not started too');
  assert.deepEqual(announced, ['b'], 'only the track that played should be announced');
});

test('an idle player during startup does not skip an extra track', async () => {
  // The player falls back to Idle while the first track is still starting. The
  // start path owns that failure; the idle handler must not advance as well.
  let release;
  let call = 0;
  const voice = fakeVoice({
    playOutcome: () => {
      call += 1;
      // Only the first track stalls; the one behind it must play normally.
      if (call > 1) return { ok: true, reason: null, status: 'playing' };
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  const { session, source } = makeSession({ voice });

  const first = session.enqueue(track('a'), { id: 'u1', name: 'Ada' });
  await settle();
  await session.enqueue(track('b'), { id: 'u1', name: 'Ada' });

  voice.emit('idle');
  await settle();
  assert.deepEqual(source.streamed, ['a'], 'a second stream started before the first had failed');

  release({ ok: false, reason: 'idle-before-playing', status: 'idle' });
  await first;
  await settle();

  assert.deepEqual(source.streamed, ['a', 'b'], 'the queued track was skipped twice or not at all');
});

test('a skip during startup does not announce or replay the abandoned track', async () => {
  // Opening a stream takes as long as yt-dlp takes. A skip landing in that
  // window must not produce two "now playing" claims, or two streams.
  const releases = [];
  const voice = fakeVoice({
    playOutcome: () =>
      new Promise((resolve) => {
        releases.push(resolve);
      }),
  });
  const { session, source } = makeSession({ voice });
  const announced = [];
  session.on('trackStart', (item) => announced.push(item.track.id));

  // The first request is not awaited: it cannot resolve until its track either
  // plays or is superseded, which is exactly what this test controls.
  const first = session.enqueue(track('a'), { id: 'u1', name: 'Ada' });
  await settle();
  await session.enqueue(track('b'), { id: 'u1', name: 'Ada' });

  const skipped = session.skip();
  assert.equal(skipped, true);

  // The abandoned track resolves now; it must stay silent.
  releases[0]?.({ ok: true, reason: null, status: 'playing' });
  await settle();
  await settle();

  assert.deepEqual(announced, [], 'a superseded start announced itself');
  assert.deepEqual(source.streamed, ['a', 'b']);

  releases[1]?.({ ok: true, reason: null, status: 'playing' });
  await settle();

  assert.deepEqual(announced, ['b'], 'the skipped-to track was not announced exactly once');

  // The superseded request reports that its own track did not start, which is
  // true - it simply must not be dressed up as a failure of the session.
  const firstResult = await first;
  assert.equal(firstResult.ok, false);
  assert.equal(firstResult.reason, ENQUEUE_RESULT.START_FAILED);
});

test('a voice adapter that reports nothing is still treated as started', async () => {
  // The gate lives in the Discord adapter. A different adapter must not be
  // declared broken merely because it returns nothing.
  const { session } = makeSession();
  const announced = [];
  session.on('trackStart', (item) => announced.push(item.track.id));

  const result = await session.enqueue(track('a'), { id: 'u1', name: 'Ada' });

  assert.equal(result.started, true);
  assert.deepEqual(announced, ['a']);
});

test('a failed extraction logs why, with the credentials stripped out', async () => {
  // The Render log said only "Failed to start a track". The reason was already
  // captured in the error's details and was being dropped here.
  const { logger, text } = createCapturingLogger({ level: 'debug' });
  const source = new FakeSource();
  source.createAudioStream = async () => {
    throw new BotError('yt-dlp exited before producing any audio.', {
      code: 'MUSIC_YTDLP_EXITED',
      details: {
        exitCode: 1,
        signal: null,
        bytes: 0,
        stderrBytes: 240,
        stderrTruncated: false,
        stderr:
          'ERROR: unable to download video data: HTTP Error 403: Forbidden\n' +
          '  url: https://rr3---sn-abc.googlevideo.com/videoplayback?expire=1&sig=SECRETSIG',
      },
    });
  };
  const { session } = makeSession({ source, logger });

  await session.enqueue(track('a'), { id: 'u1', name: 'Ada' });

  const output = text();
  assert.match(output, /Failed to start a track/, 'the failure was not logged at all');
  assert.match(output, /MUSIC_YTDLP_EXITED/);
  assert.match(output, /stage: 'stream'/, 'the stage was not reported');
  assert.match(output, /HTTP Error 403/, 'the actual yt-dlp error is missing');
  assert.match(output, /sanitizedStderr/, 'stderr did not reach the log');
  assert.match(output, /exitCode: 1/);
  assert.match(output, /stderrBytes: 240/);
  assert.ok(!output.includes('SECRETSIG'), 'a signed media URL reached the log');
});

test('a player failure logs the player stage, not the extraction one', async () => {
  const { logger, text } = createCapturingLogger({ level: 'debug' });
  const voice = fakeVoice({ playOutcome: () => ({ ok: false, reason: 'idle-before-playing', status: 'idle' }) });
  const { session } = makeSession({ voice, logger });

  await session.enqueue(track('a'), { id: 'u1', name: 'Ada' });

  assert.match(text(), /stage: 'player'/);
  assert.match(text(), /MUSIC_PLAYBACK_NOT_STARTED/);
});

/* -------------------------------------------------------------------------- */
/* Join and play                                                               */
/* -------------------------------------------------------------------------- */

test('the first request joins voice and starts playing immediately', async () => {
  const { session, voice, source } = makeSession();

  const result = await session.enqueue(track('a'), { id: 'u1', name: 'Ada' });

  assert.equal(result.ok, true);
  assert.equal(result.started, true);
  assert.equal(voice.channelId, 'vc1', 'the bot did not join the requester channel');
  assert.deepEqual(source.streamed, ['a']);
  assert.equal(session.isPlaying(), true);
});

test('a second request queues instead of interrupting', async () => {
  const { session, voice, source } = makeSession();

  await session.enqueue(track('a'), { id: 'u1', name: 'Ada' });
  const second = await session.enqueue(track('b'), { id: 'u2', name: 'Bob' });

  assert.equal(second.started, false);
  assert.equal(second.position, 1);
  assert.deepEqual(source.streamed, ['a'], 'the first track was interrupted');
  assert.equal(session.queue.size, 1);
  assert.equal(voice.calls.filter((call) => call.method === 'join').length, 1, 'joined twice');
});

test('finishing a track advances to the next one', async () => {
  const { session, voice, source } = makeSession();
  await session.enqueue(track('a'), { id: 'u1', name: 'Ada' });
  await session.enqueue(track('b'), { id: 'u1', name: 'Ada' });

  voice.emit('idle');
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(source.streamed, ['a', 'b']);
  assert.equal(session.queue.current.track.id, 'b');
});

test('the queue drains and reports it', async () => {
  const { session, voice } = makeSession();
  const events = [];
  session.on('queueEmpty', () => events.push('empty'));

  await session.enqueue(track('a'), { id: 'u1', name: 'Ada' });
  voice.emit('idle');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(session.isPlaying(), false);
  assert.deepEqual(events, ['empty']);
});

test('a stream failure skips to the next track instead of wedging', async () => {
  const { session, voice, source } = makeSession({ source: new FakeSource({ failStream: 'b' }) });
  const errors = [];
  session.on('error', (payload) => errors.push(payload));

  await session.enqueue(track('a'), { id: 'u1', name: 'Ada' });
  await session.enqueue(track('b'), { id: 'u1', name: 'Ada' });
  await session.enqueue(track('c'), { id: 'u1', name: 'Ada' });

  voice.emit('idle');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(errors.some((entry) => entry.stage === 'stream'), 'the failure was not reported');
  assert.equal(session.queue.current.track.id, 'c', 'playback did not recover');
  assert.ok(source.streamed.includes('c'));
});

test('a failing join surfaces rather than silently doing nothing', async () => {
  const voice = fakeVoice({ failPlay: true });
  const session = createMusicSession({
    guildId: 'g1',
    source: new FakeSource(),
    voice,
    voiceChannelId: 'broken',
    logger: createNullLogger(),
  });

  await assert.rejects(() => session.enqueue(track('a'), { id: 'u', name: 'U' }), /cannot join/);
});

/* -------------------------------------------------------------------------- */
/* Controls                                                                    */
/* -------------------------------------------------------------------------- */

test('skip advances to the next track', async () => {
  const { session, source } = makeSession();
  await session.enqueue(track('a'), { id: 'u', name: 'U' });
  await session.enqueue(track('b'), { id: 'u', name: 'U' });

  assert.equal(session.skip(), true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(source.streamed, ['a', 'b']);
});

test('skip with nothing playing reports false', () => {
  const { session } = makeSession();
  assert.equal(session.skip(), false);
});

test('pause and resume reach the voice adapter', async () => {
  const { session, voice } = makeSession();
  await session.enqueue(track('a'), { id: 'u', name: 'U' });

  assert.equal(session.pause(), true);
  assert.equal(session.resume(), true);

  assert.ok(voice.calls.some((call) => call.method === 'pause'));
  assert.ok(voice.calls.some((call) => call.method === 'resume'));
});

test('pause with nothing playing reports false', () => {
  const { session } = makeSession();
  assert.equal(session.pause(), false);
  assert.equal(session.resume(), false);
});

test('stop clears the queue and stops playback', async () => {
  const { session, voice } = makeSession();
  await session.enqueue(track('a'), { id: 'u', name: 'U' });
  await session.enqueue(track('b'), { id: 'u', name: 'U' });

  const removed = session.stop();

  assert.equal(removed, 1);
  assert.equal(session.isPlaying(), false);
  assert.equal(session.queue.size, 0);
  assert.ok(voice.calls.some((call) => call.method === 'stop'));
});

test('shuffle reorders without losing anything', async () => {
  const { session } = makeSession();
  for (const id of ['a', 'b', 'c']) await session.enqueue(track(id), { id: 'u', name: 'U' });

  // 'a' is already playing, so only 'b' and 'c' are queued.
  const count = session.shuffle();

  assert.equal(count, 2);
  assert.deepEqual(session.queue.items.map((item) => item.track.id).sort(), ['b', 'c']);
});

test('repeat cycles off, all, one', async () => {
  const { session } = makeSession();

  assert.equal(session.cycleRepeat(), 'all');
  assert.equal(session.cycleRepeat(), 'one');
  assert.equal(session.cycleRepeat(), 'off');
});

test('repeat-one replays the same track when it ends', async () => {
  const { session, voice, source } = makeSession();
  await session.enqueue(track('a'), { id: 'u', name: 'U' });
  session.setRepeat('one');

  voice.emit('idle');
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(source.streamed, ['a', 'a']);
});

/* -------------------------------------------------------------------------- */
/* Idle disconnect                                                             */
/* -------------------------------------------------------------------------- */

test('the bot leaves after the idle timeout once the queue empties', async () => {
  const timers = [];
  const voice = fakeVoice();
  const session = createMusicSession({
    guildId: 'g1',
    source: new FakeSource(),
    voice,
    voiceChannelId: 'vc1',
    idleDisconnectSeconds: 120,
    logger: createNullLogger(),
    // Capture the timer instead of waiting two minutes.
    setTimeoutImpl: (fn, ms) => {
      timers.push({ fn, ms });
      return { unref() {} };
    },
    clearTimeoutImpl: () => {},
  });

  await session.enqueue(track('a'), { id: 'u', name: 'U' });
  voice.emit('idle');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(timers.length, 1, 'no idle timer was scheduled');
  assert.equal(timers[0].ms, 120 * 1000);

  timers[0].fn();

  assert.equal(session.destroyed, true);
  assert.ok(voice.calls.some((call) => call.method === 'destroy'), 'the bot stayed in voice');
});

test('a new track cancels a pending idle disconnect', async () => {
  let cleared = 0;
  const voice = fakeVoice();
  const session = createMusicSession({
    guildId: 'g1',
    source: new FakeSource(),
    voice,
    voiceChannelId: 'vc1',
    idleDisconnectSeconds: 120,
    logger: createNullLogger(),
    setTimeoutImpl: () => ({ unref() {} }),
    clearTimeoutImpl: () => {
      cleared += 1;
    },
  });

  await session.enqueue(track('a'), { id: 'u', name: 'U' });
  voice.emit('idle');
  await new Promise((resolve) => setImmediate(resolve));
  await session.enqueue(track('b'), { id: 'u', name: 'U' });

  assert.ok(cleared > 0, 'the idle timer was not cancelled');
  assert.equal(session.destroyed, false);
});

test('a dropped voice connection tears the session down', async () => {
  const { session, voice } = makeSession();
  const events = [];
  session.onDisconnected(() => events.push('disconnected'));

  await session.enqueue(track('a'), { id: 'u', name: 'U' });
  voice.emit('stateChange', 'disconnected');

  assert.deepEqual(events, ['disconnected']);
  assert.equal(session.destroyed, true);
});

/* -------------------------------------------------------------------------- */
/* Per-guild isolation                                                         */
/* -------------------------------------------------------------------------- */

test('each guild gets its own session and queue', async () => {
  const sessions = createSessionManager();
  const makeFor = (guildId) =>
    sessions.getOrCreate(guildId, () => {
      const voice = fakeVoice();
      return createMusicSession({
        guildId,
        source: new FakeSource(),
        voice,
        voiceChannelId: `vc-${guildId}`,
        logger: createNullLogger(),
      });
    });

  const first = makeFor('g1');
  const second = makeFor('g2');

  await first.enqueue(track('a'), { id: 'u', name: 'U' });
  await second.enqueue(track('b'), { id: 'u', name: 'U' });

  assert.notEqual(first, second);
  assert.equal(sessions.size, 2);
  assert.equal(first.queue.current.track.id, 'a');
  assert.equal(second.queue.current.track.id, 'b');
  assert.equal(first.voiceChannelId, 'vc-g1');
  assert.equal(second.voiceChannelId, 'vc-g2');
});

test('the manager returns the same session for the same guild', () => {
  const sessions = createSessionManager();
  const factory = () =>
    createMusicSession({
      guildId: 'g1',
      source: new FakeSource(),
      voice: fakeVoice(),
      voiceChannelId: 'vc',
      logger: createNullLogger(),
    });

  assert.equal(sessions.getOrCreate('g1', factory), sessions.getOrCreate('g1', factory));
});

test('a destroyed session is replaced rather than reused', () => {
  const sessions = createSessionManager();
  const factory = () =>
    createMusicSession({
      guildId: 'g1',
      source: new FakeSource(),
      voice: fakeVoice(),
      voiceChannelId: 'vc',
      logger: createNullLogger(),
    });

  const first = sessions.getOrCreate('g1', factory);
  first.destroy();
  const second = sessions.getOrCreate('g1', factory);

  assert.notEqual(first, second);
});

test('removing a guild session stops its voice connection', () => {
  const sessions = createSessionManager();
  const voice = fakeVoice();
  sessions.getOrCreate('g1', () =>
    createMusicSession({ guildId: 'g1', source: new FakeSource(), voice, voiceChannelId: 'vc', logger: createNullLogger() }),
  );

  sessions.remove('g1');

  assert.equal(sessions.size, 0);
  assert.ok(voice.calls.some((call) => call.method === 'destroy'));
});

test('a session logs an idle teardown at info level', async () => {
  const timers = [];
  const { logger, text } = createCapturingLogger({ level: 'debug' });
  const session = createMusicSession({
    guildId: 'g1',
    source: new FakeSource(),
    voice: fakeVoice(),
    voiceChannelId: 'vc',
    idleDisconnectSeconds: 10,
    logger,
    setTimeoutImpl: (fn) => {
      timers.push(fn);
      return { unref() {} };
    },
    clearTimeoutImpl: () => {},
  });

  session.destroy();

  assert.equal(session.destroyed, true);
  assert.doesNotThrow(() => session.destroy(), 'destroy is not idempotent');
  assert.ok(typeof text() === 'string');
  assert.equal(timers.length, 0);
});
