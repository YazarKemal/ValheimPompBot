import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuildQueue, ADD_RESULT } from '../src/music/queue.js';
import { rankResults, assessConfidence, scoreResult, tokenise } from '../src/music/search.js';
import { normaliseTrack, formatDuration } from '../src/music/source.js';
import { createRequestGuard } from '../src/music/request-guard.js';

/**
 * Pure music logic: queue ordering and limits, search ranking, the duplicate
 * guard. No Discord, no voice, no network.
 */

const track = (id, overrides = {}) =>
  normaliseTrack({ id, source: 'youtube', title: `Song ${id}`, durationSeconds: 200, ...overrides });

/* -------------------------------------------------------------------------- */
/* Queue                                                                       */
/* -------------------------------------------------------------------------- */

test('a track is added and reports its position', () => {
  const queue = new GuildQueue();

  const result = queue.add(track('a'), { id: 'u1', name: 'Ada' });

  assert.deepEqual(result, { ok: true, reason: null, position: 1 });
  assert.equal(queue.size, 1);
});

test('the queue refuses to grow past MUSIC_MAX_QUEUE_SIZE', () => {
  const queue = new GuildQueue({ maxSize: 3 });
  for (let index = 0; index < 3; index += 1) {
    assert.equal(queue.add(track(`t${index}`), { id: 'u', name: 'U' }).ok, true);
  }

  const overflow = queue.add(track('overflow'), { id: 'u', name: 'U' });

  assert.equal(overflow.ok, false);
  assert.equal(overflow.reason, ADD_RESULT.QUEUE_FULL);
  assert.equal(queue.size, 3, 'the queue grew past its limit');
});

test('a track longer than MUSIC_MAX_TRACK_MINUTES is rejected', () => {
  const queue = new GuildQueue({ maxTrackSeconds: 20 * 60 });

  const tooLong = queue.add(track('long', { durationSeconds: 21 * 60 }), { id: 'u', name: 'U' });
  const exactly = queue.add(track('edge', { durationSeconds: 20 * 60 }), { id: 'u', name: 'U' });

  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.reason, ADD_RESULT.TOO_LONG);
  assert.equal(exactly.ok, true, 'a track at exactly the limit should be accepted');
});

test('a track of unknown length is accepted', () => {
  const queue = new GuildQueue({ maxTrackSeconds: 60 });

  assert.equal(queue.add(track('x', { durationSeconds: null }), { id: 'u', name: 'U' }).ok, true);
});

test('next() advances in order and empties the queue', () => {
  const queue = new GuildQueue();
  queue.add(track('a'), { id: 'u', name: 'U' });
  queue.add(track('b'), { id: 'u', name: 'U' });

  assert.equal(queue.next().track.id, 'a');
  assert.equal(queue.next().track.id, 'b');
  assert.equal(queue.next(), null);
  assert.equal(queue.isEmpty, true);
});

test('repeat-all refills the queue from history', () => {
  const queue = new GuildQueue();
  queue.repeat = 'all';
  queue.add(track('a'), { id: 'u', name: 'U' });

  assert.equal(queue.next().track.id, 'a');
  assert.equal(queue.next().track.id, 'a', 'the queue did not refill');
});

test('repeat-off drains without refilling', () => {
  const queue = new GuildQueue();
  queue.repeat = 'off';
  queue.add(track('a'), { id: 'u', name: 'U' });

  queue.next();
  assert.equal(queue.next(), null);
});

test('repeat-one replays the current track', () => {
  const queue = new GuildQueue();
  queue.add(track('a'), { id: 'u', name: 'U' });
  queue.next();
  queue.replayCurrent();

  assert.equal(queue.next().track.id, 'a');
});

test('shuffle keeps every track, just in another order', () => {
  const queue = new GuildQueue();
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  for (const id of ids) queue.add(track(id), { id: 'u', name: 'U' });

  queue.shuffle(() => 0.99);

  assert.deepEqual(queue.items.map((item) => item.track.id).sort(), ids);
});

test('clear empties the queue and reports how many were dropped', () => {
  const queue = new GuildQueue();
  queue.add(track('a'), { id: 'u', name: 'U' });
  queue.add(track('b'), { id: 'u', name: 'U' });

  assert.equal(queue.clear(), 2);
  assert.equal(queue.size, 0);
});

test('the snapshot exposes the current track and what is next', () => {
  const queue = new GuildQueue();
  queue.add(track('a'), { id: 'u', name: 'Ada' });
  queue.add(track('b'), { id: 'u2', name: 'Bob' });
  queue.next();

  const snapshot = queue.snapshot();

  assert.equal(snapshot.current.track.id, 'a');
  assert.deepEqual(snapshot.upcoming.map((item) => item.track.id), ['b']);
  assert.equal(snapshot.upcoming[0].requestedBy, 'Bob');
});

test('total queued seconds excludes the current track', () => {
  const queue = new GuildQueue();
  queue.add(track('a', { durationSeconds: 100 }), { id: 'u', name: 'U' });
  queue.add(track('b', { durationSeconds: 200 }), { id: 'u', name: 'U' });
  queue.next();

  assert.equal(queue.totalQueuedSeconds(), 200);
});

/* -------------------------------------------------------------------------- */
/* Search ranking                                                              */
/* -------------------------------------------------------------------------- */

const result = (overrides) => ({ id: 'x', source: 'youtube', durationSeconds: 210, ...overrides });

test('tokenise lower-cases, strips punctuation and drops single letters', () => {
  assert.deepEqual(tokenise('Kerimcan Durmaz - Vida Loca!'), ['kerimcan', 'durmaz', 'vida', 'loca']);
  assert.deepEqual(tokenise('a I ı'), []);
});

test('a title matching the query outranks an unrelated one', () => {
  const query = 'Kerimcan Durmaz Vida Loca';
  const ranked = rankResults(
    [
      result({ id: 'bad', title: 'Random Podcast Episode 12', artist: 'Someone' }),
      result({ id: 'good', title: 'Kerimcan Durmaz - Vida Loca', artist: 'Kerimcan Durmaz' }),
    ],
    query,
  );

  assert.equal(ranked[0].track.id, 'good');
});

test('reaction videos, interviews and shorts are pushed down', () => {
  const query = 'Vida Loca';
  const ranked = rankResults(
    [
      result({ id: 'reaction', title: 'Vida Loca REACTION!!', artist: 'Reacts' }),
      result({ id: 'shorts', title: 'Vida Loca #shorts', artist: 'Clips' }),
      result({ id: 'interview', title: 'Vida Loca interview', artist: 'TV' }),
      result({ id: 'real', title: 'Vida Loca', artist: 'Kerimcan Durmaz - Topic' }),
    ],
    query,
  );

  assert.equal(ranked[0].track.id, 'real');
  assert.ok(ranked.slice(1).every((entry) => entry.score < ranked[0].score));
});

test('an official artist channel gets a bonus', () => {
  const plain = scoreResult(result({ title: 'Song', artist: 'Uploader' }), 'Song');
  const topic = scoreResult(result({ title: 'Song', artist: 'Artist - Topic' }), 'Song');

  assert.ok(topic.score > plain.score, 'the - Topic channel was not preferred');
});

test('a ten-hour loop is pushed below a normal upload', () => {
  const ranked = rankResults(
    [
      result({ id: 'loop', title: 'Vida Loca 10 hours loop', durationSeconds: 36000 }),
      result({ id: 'normal', title: 'Vida Loca', durationSeconds: 210 }),
    ],
    'Vida Loca',
  );

  assert.equal(ranked[0].track.id, 'normal');
});

test('ranking never throws on malformed results', () => {
  assert.doesNotThrow(() => rankResults([null, {}, { title: 42 }], 'x'));
  assert.equal(rankResults(null, 'x').length, 0);
});

/* -------------------------------------------------------------------------- */
/* Confidence                                                                  */
/* -------------------------------------------------------------------------- */

test('a clear winner is confident', () => {
  const ranked = rankResults(
    [
      result({ id: 'a', title: 'Vida Loca', artist: 'Kerimcan Durmaz - Topic' }),
      result({ id: 'b', title: 'Some Unrelated Thing', artist: 'Nobody' }),
    ],
    'Vida Loca',
  );

  assert.equal(assessConfidence(ranked).confident, true);
});

test('no results is never confident', () => {
  const verdict = assessConfidence([]);

  assert.equal(verdict.confident, false);
  assert.equal(verdict.reason, 'no-results');
});

test('a low score is not confident', () => {
  const verdict = assessConfidence([{ track: result({ id: 'a' }), score: 5 }]);

  assert.equal(verdict.confident, false);
  assert.equal(verdict.reason, 'low-score');
});

test('two near-identical results are not confident', () => {
  const verdict = assessConfidence([
    { track: result({ id: 'a' }), score: 60 },
    { track: result({ id: 'b' }), score: 58 },
  ]);

  assert.equal(verdict.confident, false);
  assert.equal(verdict.reason, 'too-close');
});

test('ambiguity is a reason to ask, not to guess', () => {
  const ranked = rankResults(
    [
      result({ id: 'a', title: 'Vida Loca', artist: 'One' }),
      result({ id: 'b', title: 'Vida Loca', artist: 'Two' }),
    ],
    'Vida Loca',
  );

  assert.equal(assessConfidence(ranked).confident, false);
});

/* -------------------------------------------------------------------------- */
/* Track normalisation and formatting                                          */
/* -------------------------------------------------------------------------- */

test('a track requires an id and a title', () => {
  assert.throws(() => normaliseTrack({ title: 'x' }), /id/);
  assert.throws(() => normaliseTrack({ id: 'x' }), /title/);
});

test('a non-numeric duration becomes null rather than NaN', () => {
  assert.equal(normaliseTrack({ id: 'a', title: 't', durationSeconds: 'nonsense' }).durationSeconds, null);
  assert.equal(normaliseTrack({ id: 'a', title: 't', durationSeconds: -5 }).durationSeconds, null);
});

test('durations render as m:ss and h:mm:ss', () => {
  assert.equal(formatDuration(0), '--:--');
  assert.equal(formatDuration(null), '--:--');
  assert.equal(formatDuration(5), '0:05');
  assert.equal(formatDuration(65), '1:05');
  assert.equal(formatDuration(3725), '1:02:05');
});

/* -------------------------------------------------------------------------- */
/* Duplicate request guard                                                     */
/* -------------------------------------------------------------------------- */

test('the same user repeating the same song inside the window is blocked', () => {
  let clock = 1_000_000;
  const guard = createRequestGuard({ cooldownSeconds: 3, now: () => clock });

  assert.equal(guard.check('g', 'u1', 'Vida Loca').ok, true);
  assert.equal(guard.check('g', 'u1', 'Vida Loca').ok, false);

  clock += 3001;
  assert.equal(guard.check('g', 'u1', 'Vida Loca').ok, true, 'the window never expired');
});

test('the guard is case- and whitespace-insensitive', () => {
  const guard = createRequestGuard({ cooldownSeconds: 10, now: () => 1_000_000 });

  guard.check('g', 'u1', 'Vida Loca');
  assert.equal(guard.check('g', 'u1', '  VIDA   LOCA ').ok, false);
});

test('different users and different songs are unaffected', () => {
  const guard = createRequestGuard({ cooldownSeconds: 10, now: () => 1_000_000 });

  guard.check('g', 'u1', 'Vida Loca');

  assert.equal(guard.check('g', 'u2', 'Vida Loca').ok, true, 'another user was blocked');
  assert.equal(guard.check('g', 'u1', 'Another Song').ok, true, 'another song was blocked');
  assert.equal(guard.check('other-guild', 'u1', 'Vida Loca').ok, true, 'another guild was blocked');
});

test('the guard reports the remaining wait', () => {
  let clock = 0;
  const guard = createRequestGuard({ cooldownSeconds: 5, now: () => clock });
  guard.check('g', 'u', 'x');
  clock = 2000;

  const verdict = guard.check('g', 'u', 'x');

  assert.equal(verdict.ok, false);
  assert.equal(verdict.retryAfterMs, 3000);
});

test('a zero cooldown disables the guard', () => {
  const guard = createRequestGuard({ cooldownSeconds: 0, now: () => 1_000_000 });

  assert.equal(guard.check('g', 'u', 'x').ok, true);
  assert.equal(guard.check('g', 'u', 'x').ok, true);
});
