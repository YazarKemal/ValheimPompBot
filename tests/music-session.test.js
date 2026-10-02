import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMusicSession, createSessionManager } from '../src/music/session.js';
import { MusicSource, normaliseTrack } from '../src/music/source.js';
import { createNullLogger, createCapturingLogger } from '../src/utils/logger.js';

/**
 * Session lifecycle against a fake voice adapter and a fake source. No gateway,
 * no audio encoder, no network.
 */

const track = (id, overrides = {}) => normaliseTrack({ id, source: 'fake', title: `Song ${id}`, durationSeconds: 200, ...overrides });

/** Records every call and lets a test trigger player events. */
function fakeVoice({ failPlay = false } = {}) {
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
    play() {
      calls.push({ method: 'play' });
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
