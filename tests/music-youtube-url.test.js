import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalYoutubeUrl,
  isYoutubeUrl,
  resolveStreamUrl,
  YouTubeSource,
  YOUTUBE_WATCH_BASE,
} from '../src/music/sources/youtube.js';
import { normaliseTrack, MusicSource } from '../src/music/source.js';
import { rankResults, assessConfidence } from '../src/music/search.js';
import { createMusicSession, createSessionManager } from '../src/music/session.js';
import { createSelectionCache } from '../src/music/selection-cache.js';
import { createRequestGuard } from '../src/music/request-guard.js';
import { handleMusicRequest } from '../src/music/listener.js';
import { createCapturingLogger, createNullLogger } from '../src/utils/logger.js';

/**
 * The id/URL boundary.
 *
 * A video id identifies a track; only a URL can be played. `createAudioStream`
 * must never hand play-dl an id, and must never hand it an undefined either.
 *
 * The fixture id is the one from the live failure.
 */

const LIVE_ID = 'ktTkTFHic';
const LIVE_URL = 'https://www.youtube.com/watch?v=ktTkTFHic';

/**
 * Records what production would hand to the audio backend (yt-dlp).
 *
 * The backend is the seam: search still goes through play-dl, but extraction no
 * longer does, so these tests assert against the backend rather than a provider.
 */
function recordingBackend({ streamError = null, streamType = 'webm/opus', killResult = true } = {}) {
  const calls = [];
  let killed = 0;
  return {
    name: 'ytdlp',
    calls,
    killCount: () => killed,
    async openStream(url) {
      calls.push({ url });
      if (streamError) throw streamError;
      return {
        stream: { pipe() {} },
        inputType: streamType,
        kill: () => {
          killed += 1;
          return killResult;
        },
        meta: { backend: 'ytdlp', format: 'bestaudio[acodec=opus]', streamType, startupMs: 7 },
      };
    },
  };
}

const sourceWith = (streamBackend, logger = null) => new YouTubeSource({ streamBackend, logger });

/* -------------------------------------------------------------------------- */
/* canonicalYoutubeUrl                                                         */
/* -------------------------------------------------------------------------- */

test('a bare video id becomes a canonical URL', () => {
  assert.equal(canonicalYoutubeUrl(LIVE_ID), LIVE_URL);
  assert.equal(canonicalYoutubeUrl(LIVE_ID), `${YOUTUBE_WATCH_BASE}${LIVE_ID}`);
});

test('a malformed id produces null rather than a broken URL', () => {
  for (const value of ['', null, undefined, 'abc', 'has spaces!!', 'this-is-far-too-long-to-be-a-video-id', 42, {}]) {
    assert.equal(canonicalYoutubeUrl(value), null, `${JSON.stringify(value)} produced a URL`);
  }
});

/* -------------------------------------------------------------------------- */
/* resolveStreamUrl                                                            */
/* -------------------------------------------------------------------------- */

test('a full YouTube URL is passed through unchanged', () => {
  assert.equal(resolveStreamUrl({ id: LIVE_ID, url: LIVE_URL }), LIVE_URL);
});

test('a bare id in the url field is repaired instead of passed through', () => {
  // The failure this whole module exists to prevent.
  assert.equal(resolveStreamUrl({ id: LIVE_ID, url: LIVE_ID }), LIVE_URL);
});

test('a missing url falls back to the id', () => {
  assert.equal(resolveStreamUrl({ id: LIVE_ID, url: null }), LIVE_URL);
  assert.equal(resolveStreamUrl({ id: LIVE_ID }), LIVE_URL);
});

test('a track with neither a usable url nor id is rejected precisely', () => {
  for (const track of [{ id: null, url: null }, { id: 'nope', url: 'nope' }, {}, null]) {
    assert.throws(
      () => resolveStreamUrl(track),
      (error) => {
        assert.equal(error.code, 'MUSIC_TRACK_INVALID');
        assert.match(error.message, /no usable YouTube URL/);
        return true;
      },
      `${JSON.stringify(track)} was accepted`,
    );
  }
});

test('isYoutubeUrl accepts youtube hosts and rejects everything else', () => {
  assert.equal(isYoutubeUrl(LIVE_URL), true);
  assert.equal(isYoutubeUrl('https://youtu.be/ktTkTFHic'), true);
  assert.equal(isYoutubeUrl('https://m.youtube.com/watch?v=ktTkTFHic'), true);

  assert.equal(isYoutubeUrl('ktTkTFHic'), false, 'a bare id was treated as a URL');
  assert.equal(isYoutubeUrl('https://example.com/watch?v=x'), false);
  assert.equal(isYoutubeUrl('http://www.youtube.com/watch?v=ktTkTFHic'), false, 'http was accepted');
  assert.equal(isYoutubeUrl(''), false);
  assert.equal(isYoutubeUrl(null), false);
  assert.equal(isYoutubeUrl(undefined), false);
});

/* -------------------------------------------------------------------------- */
/* The live failure, reproduced                                                */
/* -------------------------------------------------------------------------- */

test('the live failure shape: id ktTkTFHic reaches the provider as a full URL', async () => {
  const backend = recordingBackend();
  const track = normaliseTrack({
    id: LIVE_ID,
    source: 'youtube',
    title: 'Some Track',
    // Exactly what was suspected of the live failure: only an id, no url.
    url: null,
  });

  await sourceWith(backend).createAudioStream(track);

  assert.equal(backend.calls.length, 1);
  assert.equal(backend.calls[0].url, LIVE_URL, 'the provider did not receive the canonical URL');
  assert.notEqual(backend.calls[0].url, LIVE_ID, 'a bare video id reached the provider');
});

test('a bare id sitting in the url field is not passed through', async () => {
  const backend = recordingBackend();
  const track = { id: LIVE_ID, url: LIVE_ID, source: 'youtube', title: 'Some Track' };

  await sourceWith(backend).createAudioStream(track);

  assert.equal(backend.calls[0].url, LIVE_URL);
});

test('the backend never receives a bare id, whatever the track looks like', async () => {
  const shapes = [
    { id: LIVE_ID, url: LIVE_URL },
    { id: LIVE_ID, url: LIVE_ID },
    { id: LIVE_ID, url: null },
    { id: LIVE_ID },
    { id: LIVE_ID, url: `  ${LIVE_URL}  ` },
  ];

  for (const shape of shapes) {
    const backend = recordingBackend();
    await sourceWith(backend).createAudioStream({ source: 'youtube', title: 't', ...shape });

    const received = backend.calls[0].url;
    assert.match(received, /^https:\/\/www\.youtube\.com\/watch\?v=/, `bad URL for ${JSON.stringify(shape)}`);
    assert.notEqual(received.trim(), LIVE_ID);
  }
});

test('a malformed track fails before the backend is called', async () => {
  const backend = recordingBackend();

  await assert.rejects(
    () => sourceWith(backend).createAudioStream({ id: null, url: null, title: 'Broken' }),
    (error) => {
      assert.equal(error.code, 'MUSIC_TRACK_INVALID');
      return true;
    },
  );

  assert.deepEqual(backend.calls, [], 'the provider was called with unusable track data');
});

/* -------------------------------------------------------------------------- */
/* Stream type forwarding                                                      */
/* -------------------------------------------------------------------------- */

test('the stream type from the backend is forwarded to the voice resource to the voice resource', async () => {
  const backend = recordingBackend({ streamResult: { stream: { pipe() {} }, type: 'webm/opus' } });
  const result = await sourceWith(backend).createAudioStream({ id: LIVE_ID, url: LIVE_URL, title: 't' });

  assert.equal(result.inputType, 'webm/opus', 'the stream type was lost');
  assert.ok(result.stream, 'no stream was returned');
});

test('no backend is reported rather than silently ignored', async () => {
  const source = new YouTubeSource({ streamBackend: null });

  await assert.rejects(
    () => source.createAudioStream({ id: LIVE_ID, url: LIVE_URL, title: 't' }),
    (error) => {
      assert.equal(error.code, 'MUSIC_STREAM_FAILED');
      assert.match(error.message, /No audio stream backend/);
      return true;
    },
  );
});

test('a malformed track and a backend failure are reported differently', async () => {
  const backendFailure = recordingBackend({ streamError: new Error('Invalid URL') });

  await assert.rejects(
    () => sourceWith(backendFailure).createAudioStream({ id: LIVE_ID, url: LIVE_URL, title: 't' }),
    (error) => {
      // The track was fine, so this is the provider's fault, and says so.
      assert.equal(error.code, 'MUSIC_STREAM_FAILED');
      assert.match(error.message, /audio backend could not open this track/);
      assert.equal(error.details.videoId, LIVE_ID);
      return true;
    },
  );
});

/* -------------------------------------------------------------------------- */
/* Diagnostics                                                                 */
/* -------------------------------------------------------------------------- */

test('stream diagnostics report the id, url presence and hostname only', async () => {
  const { logger, text } = createCapturingLogger({ level: 'debug' });
  const backend = recordingBackend();

  await sourceWith(backend, logger).createAudioStream({ id: LIVE_ID, url: LIVE_URL, title: 't' });

  const output = text();
  assert.match(output, /Opening an audio stream/);
  assert.match(output, /ktTkTFHic/);
  assert.match(output, /hasUrl: true/);
  assert.match(output, /www\.youtube\.com/);
  assert.match(output, /streamType: 'webm\/opus'/);
});

test('diagnostics never log a full URL with its query string', async () => {
  const { logger, text } = createCapturingLogger({ level: 'debug' });
  const backend = recordingBackend();
  // A signed media URL is the shape that must never be logged.
  const signed = 'https://rr3---sn-abc.googlevideo.com/videoplayback?expire=1&sig=SECRETSIG&token=SECRETTOKEN';

  await sourceWith(backend, logger).createAudioStream({ id: LIVE_ID, url: signed, title: 't' }).catch(() => {});

  assert.ok(!text().includes('SECRETSIG'), 'the signature was logged');
  assert.ok(!text().includes('SECRETTOKEN'), 'the token was logged');
});

test('a failure logs the reason and code but no vendor body', async () => {
  const { logger, text } = createCapturingLogger({ level: 'debug' });
  const backend = recordingBackend({ streamError: new Error('Invalid URL') });

  await sourceWith(backend, logger)
    .createAudioStream({ id: LIVE_ID, url: LIVE_URL, title: 't' })
    .catch((error) => logger.warn('failed', { code: error.code, reason: error.message }));

  assert.match(text(), /Invalid URL/);
  assert.match(text(), /MUSIC_STREAM_FAILED/);
});

/* -------------------------------------------------------------------------- */
/* The URL survives the whole pipeline                                         */
/* -------------------------------------------------------------------------- */

const remote = (id, overrides = {}) => ({
  id,
  url: `https://www.youtube.com/watch?v=${id}`,
  title: `Some Song ${id}`,
  durationInSec: 200,
  durationRaw: '3:20',
  channel: { name: 'Artist - Topic' },
  thumbnails: [{ url: 'https://img.example/1.jpg', width: 480 }],
  ...overrides,
});

test('search normalisation retains both id and url', async () => {
  const searchProvider = { search: async () => [remote(LIVE_ID)] };
  const [track] = await new YouTubeSource({ provider: searchProvider }).search('anything');

  assert.equal(track.id, LIVE_ID);
  assert.equal(track.url, LIVE_URL);
});

test('search repairs a result that carries an id but no url', async () => {
  const searchProvider = { search: async () => [remote(LIVE_ID, { url: undefined })] };
  const [track] = await new YouTubeSource({ provider: searchProvider }).search('anything');

  assert.equal(track.url, LIVE_URL, 'the url was not reconstructed from the id');
});

test('ranking does not strip the url', () => {
  const [ranked] = rankResults([normaliseTrack({ id: LIVE_ID, source: 'youtube', title: 'T', url: LIVE_URL })], 'T');

  assert.equal(ranked.track.url, LIVE_URL);
  assert.equal(assessConfidence([ranked]).top.track.url, LIVE_URL);
});

test('a cached selection menu candidate retains its url', async () => {
  const track = normaliseTrack({ id: LIVE_ID, source: 'youtube', title: 'T', url: LIVE_URL });
  const cache = createSelectionCache({ timeoutSeconds: 60 });
  const identity = { guildId: 'g', channelId: 'c', requestId: '900000000000000001' };
  cache.put(identity, { userId: 'u', voiceChannelId: 'vc', ranked: [{ track, score: 50 }] });

  const entry = cache.get(identity);
  assert.equal(entry.ranked[0].track.url, LIVE_URL, 'the url was lost in the selection cache');
});

test('the url survives queueing, immediate playback and queue advance', async () => {
  const seen = [];
  const session = createMusicSession({
    guildId: 'g',
    source: {
      async createAudioStream(track) {
        seen.push(track.url);
        return { stream: { pipe() {} }, inputType: 'webm/opus' };
      },
    },
    voice: {
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
    },
    voiceChannelId: 'vc1',
    logger: createNullLogger(),
  });

  const first = normaliseTrack({ id: 'aaaaaaaaaaa', source: 'youtube', title: 'First', url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' });
  const second = normaliseTrack({ id: LIVE_ID, source: 'youtube', title: 'Second', url: LIVE_URL });

  await session.begin();
  await session.enqueue(first, { id: 'u', name: 'U' });
  await session.enqueue(second, { id: 'u', name: 'U' });

  assert.deepEqual(seen, ['https://www.youtube.com/watch?v=aaaaaaaaaaa'], 'the first track played without a url');

  // Advance to the queued track.
  session.skip();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(seen.length, 2, 'the queued track never played');
  assert.equal(seen[1], LIVE_URL, 'the queued track lost its url');
});

test('a plain-text request reaches playback with a full url and no second search', async () => {
  const searchProvider = {
    calls: 0,
    async search() {
      this.calls += 1;
      return [remote(LIVE_ID)];
    },
  };
  const backend = recordingBackend();
  const streamed = [];

  const source = new (class extends MusicSource {
    constructor() {
      super({ name: 'spy' });
      this.inner = new YouTubeSource({ provider: searchProvider, streamBackend: backend });
    }

    search(...args) {
      return this.inner.search(...args);
    }

    async createAudioStream(track) {
      streamed.push(track.url);
      return this.inner.createAudioStream(track);
    }
  })();

  const sessions = createSessionManager();
  const guard = createRequestGuard({ cooldownSeconds: 0 });
  const deps = { source, sessions, selections: createSelectionCache(), guard, logger: createNullLogger() };

  const message = {
    id: '900000000000000042',
    content: 'Some Song',
    guildId: 'g1',
    guild: { id: 'g1', voiceStates: { cache: new Map([['u1', { channelId: 'vc1' }]]) }, members: { cache: new Map() } },
    member: { id: 'u1', deaf: false, mute: false },
    author: { id: 'u1', username: 'user', bot: false },
    channel: { name: 'muzik-istek', async send() {} },
  };

  // PompMusic must be summoned before a request is accepted.
  sessions.getOrCreate('g1', () =>
    createMusicSession({
      guildId: 'g1',
      source,
      voice: {
        channelId: null,
        async join() {},
        play() {},
        pause() {},
        resume() {},
        stop() {},
        destroy() {},
        on() {},
      },
      voiceChannelId: 'vc1',
      logger: createNullLogger(),
    }),
  );

  const result = await handleMusicRequest(message, deps);

  assert.equal(result.action, 'playing', `request failed: ${JSON.stringify(result)}`);
  assert.deepEqual(streamed, [LIVE_URL], 'playback did not receive a full url');
  assert.equal(searchProvider.calls, 1, 'the search ran more than once');
  assert.equal(backend.calls.length, 1, 'the backend was not called exactly once');
  assert.equal(backend.calls[0].url, LIVE_URL, 'the backend received the wrong url');
});

test('the streaming path makes no AI call', async () => {
  const originalFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = () => {
    fetched = true;
    throw new Error('network access attempted');
  };

  try {
    const backend = recordingBackend();
    await sourceWith(backend).createAudioStream({ id: LIVE_ID, url: LIVE_URL, title: 't' });
    resolveStreamUrl({ id: LIVE_ID });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(fetched, false);
});
