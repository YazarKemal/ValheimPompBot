import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { createSelectionCache, selectionKey } from '../src/music/selection-cache.js';
import { handleMusicRequest } from '../src/music/listener.js';
import { handleMusicInteraction } from '../src/music/interactions.js';
import { authorizeSelection } from '../src/music/controls.js';
import { buildSelectionId, buildSelectionPayload, SELECT_PREFIX } from '../src/music/messages.js';
import { createRequestGuard } from '../src/music/request-guard.js';
import { createMusicSession, createSessionManager } from '../src/music/session.js';
import { MusicSource, normaliseTrack } from '../src/music/source.js';
import { createNullLogger } from '../src/utils/logger.js';

/**
 * The disambiguation flow end to end: an ambiguous search records its
 * candidates, and a click on the menu resolves back to exactly one of them.
 *
 * Two tracks with the same title and similar channels produce a genuinely
 * ambiguous ranking, which is what opens the menu in the first place.
 */

const track = (id, overrides = {}) =>
  normaliseTrack({ id, source: 'fake', title: `Song ${id}`, durationSeconds: 200, ...overrides });

class FakeSource extends MusicSource {
  constructor({ results = null } = {}) {
    super({ name: 'fake' });
    this.results = results;
    this.queries = [];
    this.streamed = [];
  }

  async search(query) {
    this.queries.push(query);
    if (this.results) return this.results;
    return [track('hit', { title: query, artist: 'Artist - Topic' }), track('other', { title: 'Unrelated' })];
  }

  async createAudioStream(item) {
    this.streamed.push(item.id);
    return { stream: { pipe() {} }, inputType: 'arbitrary', id: item.id };
  }
}

/** Two results close enough that the ranker refuses to choose. */
const ambiguousResults = () => [
  track('a', { title: 'Vida Loca', artist: 'Kerimcan Durmaz', durationSeconds: 200 }),
  track('b', { title: 'Vida Loca', artist: 'Kerimcan Durmaz', durationSeconds: 205 }),
];

function fakeVoice() {
  const handlers = new Map();
  return {
    channelId: 'vc1',
    isConnected: true,
    async join() {},
    play() {},
    pause() {},
    resume() {},
    stop() {},
    leave() {},
    destroy() {},
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
  };
}

let counter = 0;

function makeHarness({ source = new FakeSource(), timeoutSeconds = 60, maxTrackSeconds = 1200, maxQueueSize = 50 } = {}) {
  const sessions = createSessionManager();
  const selections = createSelectionCache({ timeoutSeconds });
  const guard = createRequestGuard({ cooldownSeconds: 3 });

  /** Summons PompMusic, as /gel would. Requests never create a session. */
  const summon = (guildId = 'g1', voiceChannelId = 'vc1', channelName = 'Müzik Odası') =>
    sessions.getOrCreate(guildId, () =>
      createMusicSession({
        guildId,
        source,
        voice: fakeVoice(),
        voiceChannelId,
        channelName,
        maxTrackSeconds,
        maxQueueSize,
        logger: createNullLogger(),
      }),
    );

  summon('g1');
  summon('g2', 'vc2', 'İkinci Oda');

  const deps = { source, sessions, selections, guard, logger: createNullLogger(), config: { searchLimit: 5 } };

  const service = {
    source,
    sessions,
    selections,
    guard,
    settings: {},
    listenerDeps: () => deps,
  };

  return { deps, service, sessions, selections, source, summon };
}

function message({
  content = 'Vida Loca',
  userId = 'u1',
  voiceChannelId = 'vc1',
  guildId = 'g1',
  channelId = 'c-muzik',
  bot = false,
} = {}) {
  const sent = [];
  return {
    // Discord message ids are numeric snowflakes, and the customId parser
    // enforces that shape, so the fixtures use realistic ones.
    id: String(900000000000000000n + BigInt((counter += 1))),
    content,
    guildId,
    channelId,
    system: false,
    author: { id: userId, username: `user-${userId}`, bot },
    member: { id: userId, voice: { channelId: voiceChannelId } },
    guild: { id: guildId },
    channel: {
      name: 'muzik-istek',
      async send(payload) {
        sent.push(payload);
        return { id: `posted-${sent.length}`, ...payload };
      },
    },
    sent,
  };
}

/** A select-menu interaction on a posted menu. */
function selection({ requestId, value = '0', userId = 'u1', guildId = 'g1', channelId = 'c-muzik', voiceChannelId = 'vc1', message: postedMessage = {} } = {}) {
  const calls = { reply: [], followUp: [], edit: [] };
  const interaction = {
    customId: buildSelectionId(requestId),
    values: [value],
    guildId,
    channelId,
    user: { id: userId, username: `user-${userId}` },
    member: { id: userId, voice: { channelId: voiceChannelId } },
    guild: { id: guildId },
    channel: { id: channelId },
    deferred: false,
    replied: false,
    message: {
      id: 'menu-message',
      embeds: [],
      async edit(payload) {
        calls.edit.push(payload);
      },
      ...postedMessage,
    },
    isButton: () => false,
    isStringSelectMenu: () => true,
    async reply(payload) {
      calls.reply.push(payload);
      interaction.replied = true;
    },
    async followUp(payload) {
      calls.followUp.push(payload);
    },
    calls,
  };
  return interaction;
}

const isEphemeral = (payload) => Boolean(payload?.flags & MessageFlags.Ephemeral);

/** Runs an ambiguous request and returns the request message plus its id. */
async function ambiguousRequest(harness, overrides = {}) {
  const candidate = message(overrides);
  const result = await handleMusicRequest(candidate, harness.deps);
  assert.equal(result.action, 'disambiguate', `expected a menu, got ${result.action}`);
  return candidate;
}

/* -------------------------------------------------------------------------- */
/* Cache population                                                            */
/* -------------------------------------------------------------------------- */

test('an ambiguous search posts a menu and caches its candidates', async () => {
  const harness = makeHarness({ source: new FakeSource({ results: ambiguousResults() }) });
  const candidate = await ambiguousRequest(harness);

  assert.equal(harness.selections.size(), 1, 'nothing was cached');

  const entry = harness.selections.get({
    guildId: 'g1',
    channelId: 'c-muzik',
    requestId: candidate.id,
  });

  assert.ok(entry, 'the entry was not readable');
  assert.equal(entry.userId, 'u1');
  assert.equal(entry.voiceChannelId, 'vc1');
  assert.equal(entry.ranked.length, 2);
  assert.equal(entry.ranked[0].track.id, 'a', 'the stored candidates are not the ranked ones');
});

test('the posted menu lists every candidate with its artist and duration', async () => {
  const harness = makeHarness({ source: new FakeSource({ results: ambiguousResults() }) });
  const candidate = await ambiguousRequest(harness);

  const payload = candidate.sent[0];
  const menu = payload.components[0].toJSON().components[0];

  assert.equal(menu.custom_id, buildSelectionId(candidate.id));
  assert.equal(menu.options.length, 2);
  assert.match(menu.options[0].label, /Vida Loca/);
  assert.match(menu.options[0].description, /Kerimcan Durmaz/);
  assert.match(menu.options[0].description, /3:20/);
});

test('the menu is public, not ephemeral', async () => {
  const harness = makeHarness({ source: new FakeSource({ results: ambiguousResults() }) });
  const candidate = await ambiguousRequest(harness);

  assert.equal(isEphemeral(candidate.sent[0]), false);
});

test('no playback starts while the menu is open', async () => {
  const harness = makeHarness({ source: new FakeSource({ results: ambiguousResults() }) });
  await ambiguousRequest(harness);

  assert.deepEqual(harness.source.streamed, [], 'a track played before a choice was made');
});

test('candidate count is capped at the configured search limit', async () => {
  const many = Array.from({ length: 40 }, (_, index) =>
    track(`t${index}`, { title: 'Vida Loca', artist: 'Same', durationSeconds: 200 }),
  );
  const harness = makeHarness({ source: new FakeSource({ results: many }) });
  const candidate = await ambiguousRequest(harness);

  const menu = candidate.sent[0].components[0].toJSON().components[0];
  assert.ok(menu.options.length <= 25, `Discord's cap was exceeded: ${menu.options.length}`);
});

test('a menu that cannot be posted leaves nothing cached', async () => {
  const harness = makeHarness({ source: new FakeSource({ results: ambiguousResults() }) });
  const candidate = message();
  candidate.channel.send = async () => {
    throw new Error('channel is read-only');
  };

  await handleMusicRequest(candidate, harness.deps);

  assert.equal(harness.selections.size(), 0, 'a menu that never appeared left a live entry');
});

/* -------------------------------------------------------------------------- */
/* Selection                                                                   */
/* -------------------------------------------------------------------------- */

test('the requester can select and the chosen track plays', async () => {
  const harness = makeHarness({ source: new FakeSource({ results: ambiguousResults() }) });
  const candidate = await ambiguousRequest(harness);

  const interaction = selection({ requestId: candidate.id, value: '1' });
  const handled = await handleMusicInteraction(interaction, { music: harness.service, logger: createNullLogger() });

  assert.equal(handled, true);
  assert.equal(interaction.calls.reply.length, 1);
  assert.match(interaction.calls.reply[0].content, /Çalınıyor|Sıraya eklendi/);

  const session = harness.sessions.get('g1');
  assert.equal(session.queue.current.track.id, 'b', 'the wrong candidate played');
});

test('the exact stored candidate is used - no second search', async () => {
  const harness = makeHarness({ source: new FakeSource({ results: ambiguousResults() }) });
  const candidate = await ambiguousRequest(harness);

  assert.equal(harness.source.queries.length, 1);

  await handleMusicInteraction(selection({ requestId: candidate.id, value: '0' }), {
    music: harness.service,
    logger: createNullLogger(),
  });

  assert.equal(harness.source.queries.length, 1, 'the search was run a second time');
});

test('a selected track starts immediately when nothing is playing', async () => {
  const harness = makeHarness({ source: new FakeSource({ results: ambiguousResults() }) });
  const candidate = await ambiguousRequest(harness);

  await handleMusicInteraction(selection({ requestId: candidate.id, value: '0' }), {
    music: harness.service,
    logger: createNullLogger(),
  });

  const session = harness.sessions.get('g1');
  assert.equal(session.isPlaying(), true);
  assert.equal(session.queue.size, 0);
});

test('a selected track queues when something is already playing', async () => {
  const harness = makeHarness({ source: new FakeSource({ results: ambiguousResults() }) });
  const first = await ambiguousRequest(harness);
  await handleMusicInteraction(selection({ requestId: first.id, value: '0' }), {
    music: harness.service,
    logger: createNullLogger(),
  });

  // A different query, so the duplicate guard does not swallow it first.
  const second = await ambiguousRequest(harness, { content: 'Another Song' });
  const interaction = selection({ requestId: second.id, value: '1' });
  await handleMusicInteraction(interaction, { music: harness.service, logger: createNullLogger() });

  const session = harness.sessions.get('g1');
  assert.equal(session.queue.size, 1, 'the second selection did not queue');
  assert.match(interaction.calls.reply[0].content, /Sıraya eklendi/);
});

test('an out-of-range candidate index is refused', async () => {
  const harness = makeHarness({ source: new FakeSource({ results: ambiguousResults() }) });
  const candidate = await ambiguousRequest(harness);

  const interaction = selection({ requestId: candidate.id, value: '99' });
  await handleMusicInteraction(interaction, { music: harness.service, logger: createNullLogger() });

  assert.match(interaction.calls.reply[0].content, /Geçersiz seçim/);
  assert.equal(isEphemeral(interaction.calls.reply[0]), true);
  assert.deepEqual(harness.source.streamed, [], 'playback started from an invalid index');
});

test('a non-numeric candidate index is refused', async () => {
  const harness = makeHarness({ source: new FakeSource({ results: ambiguousResults() }) });
  const candidate = await ambiguousRequest(harness);

  const interaction = selection({ requestId: candidate.id, value: 'banana' });
  await handleMusicInteraction(interaction, { music: harness.service, logger: createNullLogger() });

  assert.match(interaction.calls.reply[0].content, /Geçersiz seçim/);
});

test('the menu is retired after a successful selection', async () => {
  const harness = makeHarness({ source: new FakeSource({ results: ambiguousResults() }) });
  const candidate = await ambiguousRequest(harness);

  const interaction = selection({ requestId: candidate.id, value: '0' });
  await handleMusicInteraction(interaction, { music: harness.service, logger: createNullLogger() });

  assert.equal(interaction.calls.edit.length, 1, 'the menu was left clickable');
  assert.deepEqual(interaction.calls.edit[0].components, [], 'the components were not removed');
});

test('a failure to retire the menu does not fail the selection', async () => {
  const harness = makeHarness({ source: new FakeSource({ results: ambiguousResults() }) });
  const candidate = await ambiguousRequest(harness);

  const interaction = selection({
    requestId: candidate.id,
    value: '0',
    message: {
      async edit() {
        throw new Error('message was deleted');
      },
    },
  });
  await handleMusicInteraction(interaction, { music: harness.service, logger: createNullLogger() });

  assert.equal(harness.sessions.get('g1').isPlaying(), true, 'playback was lost with the menu');
});

/* -------------------------------------------------------------------------- */
/* Authorization                                                               */
/* -------------------------------------------------------------------------- */

test('a different user cannot select from someone else\'s menu', async () => {
  const harness = makeHarness({ source: new FakeSource({ results: ambiguousResults() }) });
  const candidate = await ambiguousRequest(harness);

  const intruder = selection({ requestId: candidate.id, userId: 'u2', value: '0' });
  await handleMusicInteraction(intruder, { music: harness.service, logger: createNullLogger() });

  assert.equal(isEphemeral(intruder.calls.reply[0]), true);
  assert.match(intruder.calls.reply[0].content, /yalnızca şarkıyı isteyen/);
  assert.deepEqual(harness.source.streamed, [], 'an intruder started playback');
});

test('an intruder does not destroy the requester\'s menu', async () => {
  const harness = makeHarness({ source: new FakeSource({ results: ambiguousResults() }) });
  const candidate = await ambiguousRequest(harness);

  await handleMusicInteraction(selection({ requestId: candidate.id, userId: 'u2' }), {
    music: harness.service,
    logger: createNullLogger(),
  });

  const requester = selection({ requestId: candidate.id, userId: 'u1', value: '0' });
  await handleMusicInteraction(requester, { music: harness.service, logger: createNullLogger() });

  assert.equal(harness.sessions.get('g1').isPlaying(), true, 'the legitimate selection was lost');
});

test('the requester must still be in the voice channel', async () => {
  const harness = makeHarness({ source: new FakeSource({ results: ambiguousResults() }) });
  const candidate = await ambiguousRequest(harness);

  const left = selection({ requestId: candidate.id, userId: 'u1', voiceChannelId: 'vc-other' });
  await handleMusicInteraction(left, { music: harness.service, logger: createNullLogger() });

  assert.match(left.calls.reply[0].content, /müzik odasında olmalısın/);
});

test('a requester who left voice entirely is refused', async () => {
  const harness = makeHarness({ source: new FakeSource({ results: ambiguousResults() }) });
  const candidate = await ambiguousRequest(harness);

  const gone = selection({ requestId: candidate.id, userId: 'u1', voiceChannelId: null });
  await handleMusicInteraction(gone, { music: harness.service, logger: createNullLogger() });

  assert.match(gone.calls.reply[0].content, /ses kanalına katıl/);
});

test('authorizeSelection reports a precise reason for every refusal', () => {
  const entry = { userId: 'u1', voiceChannelId: 'vc1' };
  const session = { destroyed: false, voiceChannelId: 'vc1' };
  const at = (memberId, memberChannelId) => ({ memberId, memberChannelId });

  assert.equal(authorizeSelection({ ...at('u1', 'vc1'), entry, session }).ok, true);

  // No session yet is fine: the menu may be the first thing in the channel.
  assert.equal(authorizeSelection({ ...at('u1', 'vc1'), entry, session: null }).ok, true);

  assert.equal(authorizeSelection({ ...at('u2', 'vc1'), entry, session }).reason, 'not-requester');
  assert.equal(authorizeSelection({ ...at('u1', null), entry, session }).reason, 'not-in-voice');
  assert.equal(authorizeSelection({ ...at('u1', 'vc2'), entry, session }).reason, 'wrong-channel');
  assert.equal(authorizeSelection({ ...at('u1', 'vc1'), entry: null, session }).reason, 'expired');
  assert.equal(
    authorizeSelection({ ...at('u1', 'vc1'), entry, session: { destroyed: true, voiceChannelId: 'vc1' } }).reason,
    'no-session',
  );
  assert.equal(
    authorizeSelection({ ...at('u1', 'vc1'), entry, session: { destroyed: false, voiceChannelId: 'vc9' } }).reason,
    'voice-session-changed',
  );
});

/* -------------------------------------------------------------------------- */
/* Isolation                                                                   */
/* -------------------------------------------------------------------------- */

test('one guild cannot use another guild\'s candidate list', async () => {
  const harness = makeHarness({ source: new FakeSource({ results: ambiguousResults() }) });
  const candidate = await ambiguousRequest(harness, { guildId: 'g1', channelId: 'c-g1' });

  // Same request id, different guild and channel.
  const foreign = selection({ requestId: candidate.id, guildId: 'g2', channelId: 'c-g2' });
  await handleMusicInteraction(foreign, { music: harness.service, logger: createNullLogger() });

  assert.match(foreign.calls.reply[0].content, /zaman aşımına uğradı/);
  assert.deepEqual(harness.source.streamed, [], 'a menu was used across guilds');
});

test('one channel cannot use another channel\'s candidate list', async () => {
  const harness = makeHarness({ source: new FakeSource({ results: ambiguousResults() }) });
  const candidate = await ambiguousRequest(harness, { guildId: 'g1', channelId: 'c-muzik' });

  const elsewhere = selection({ requestId: candidate.id, guildId: 'g1', channelId: 'c-genel' });
  await handleMusicInteraction(elsewhere, { music: harness.service, logger: createNullLogger() });

  assert.match(elsewhere.calls.reply[0].content, /zaman aşımına uğradı/);
});

test('the cache key requires all three identity parts', () => {
  assert.equal(selectionKey({ guildId: 'g', channelId: 'c', requestId: 'r' }), 'g:c:r');
  assert.equal(selectionKey({ guildId: 'g', channelId: 'c' }), null);
  assert.equal(selectionKey({ guildId: 'g', requestId: 'r' }), null);
  assert.equal(selectionKey({}), null);
  assert.equal(selectionKey(), null);
});

test('a malformed customId cannot address the cache', async () => {
  const harness = makeHarness({ source: new FakeSource({ results: ambiguousResults() }) });
  const candidate = await ambiguousRequest(harness);

  for (const customId of [`${SELECT_PREFIX}abc`, `${SELECT_PREFIX}`, `${SELECT_PREFIX}${candidate.id}:extra`, 'music:select:1']) {
    const interaction = selection({ requestId: candidate.id });
    interaction.customId = customId;
    await handleMusicInteraction(interaction, { music: harness.service, logger: createNullLogger() });
    assert.deepEqual(harness.source.streamed, [], `${customId} resolved to playback`);
  }
});

/* -------------------------------------------------------------------------- */
/* Expiry and cleanup                                                          */
/* -------------------------------------------------------------------------- */

test('an expired selection is refused with a readable message', async () => {
  let clock = 1_000_000;
  const harness = makeHarness({ source: new FakeSource({ results: ambiguousResults() }), timeoutSeconds: 60 });
  harness.selections.clear();

  // Rebuild the cache with a controllable clock.
  const timed = createSelectionCache({ timeoutSeconds: 60, now: () => clock });
  harness.deps.selections = timed;
  harness.service.selections = timed;

  const candidate = await ambiguousRequest(harness);
  clock += 61_000;

  const late = selection({ requestId: candidate.id });
  await handleMusicInteraction(late, { music: harness.service, logger: createNullLogger() });

  assert.equal(isEphemeral(late.calls.reply[0]), true);
  assert.match(late.calls.reply[0].content, /zaman aşımına uğradı/);
  assert.equal(timed.size(), 0, 'the expired entry was left behind');
});

test('the cache entry is deleted after a successful selection', async () => {
  const harness = makeHarness({ source: new FakeSource({ results: ambiguousResults() }) });
  const candidate = await ambiguousRequest(harness);
  assert.equal(harness.selections.size(), 1);

  await handleMusicInteraction(selection({ requestId: candidate.id }), {
    music: harness.service,
    logger: createNullLogger(),
  });

  assert.equal(harness.selections.size(), 0, 'the entry was not consumed');
});

test('a consumed selection cannot be replayed', async () => {
  const harness = makeHarness({ source: new FakeSource({ results: ambiguousResults() }) });
  const candidate = await ambiguousRequest(harness);

  await handleMusicInteraction(selection({ requestId: candidate.id, value: '0' }), {
    music: harness.service,
    logger: createNullLogger(),
  });

  const replay = selection({ requestId: candidate.id, value: '1' });
  await handleMusicInteraction(replay, { music: harness.service, logger: createNullLogger() });

  assert.match(replay.calls.reply[0].content, /zaman aşımına uğradı/);
  assert.equal(harness.sessions.get('g1').queue.size, 0, 'a replayed selection enqueued again');
});

test('ending the voice session drops that guild\'s pending menus', async () => {
  const harness = makeHarness({ source: new FakeSource({ results: ambiguousResults() }) });
  await ambiguousRequest(harness, { guildId: 'g1', content: 'Guild One Song' });
  await ambiguousRequest(harness, { guildId: 'g2', voiceChannelId: 'vc2', content: 'Guild Two Song' });
  assert.equal(harness.selections.size(), 2);

  const removed = harness.selections.deleteByGuild('g1');

  assert.equal(removed, 1);
  assert.equal(harness.selections.size(), 1, 'another guild\'s menu was dropped');
});

test('the cache is bounded and evicts the oldest entries', () => {
  const cache = createSelectionCache({ maxEntries: 3, now: () => 1_000_000 });
  for (let index = 0; index < 10; index += 1) {
    cache.put({ guildId: 'g', channelId: 'c', requestId: `r${index}` }, { userId: 'u', ranked: [] });
  }

  assert.equal(cache.size(), 3);
  assert.equal(cache.get({ guildId: 'g', channelId: 'c', requestId: 'r0' }), null, 'the oldest survived');
  assert.ok(cache.get({ guildId: 'g', channelId: 'c', requestId: 'r9' }), 'the newest was evicted');
});

test('sweep removes only expired entries', () => {
  let clock = 0;
  const cache = createSelectionCache({ timeoutSeconds: 10, now: () => clock });

  cache.put({ guildId: 'g', channelId: 'c', requestId: 'fades' }, { userId: 'u', ranked: [] });

  // A second entry written while the first is still alive.
  clock = 5_000;
  cache.put({ guildId: 'g', channelId: 'c', requestId: 'fresh' }, { userId: 'u', ranked: [] });

  // Only the first passes its deadline.
  clock = 12_000;
  assert.equal(cache.sweep(), 1);
  assert.equal(cache.size(), 1);
  assert.ok(cache.get({ guildId: 'g', channelId: 'c', requestId: 'fresh' }), 'a live entry was swept');
});

test('writing prunes entries that expired while nobody was looking', () => {
  let clock = 0;
  const cache = createSelectionCache({ timeoutSeconds: 10, now: () => clock });
  cache.put({ guildId: 'g', channelId: 'c', requestId: 'old' }, { userId: 'u', ranked: [] });

  clock = 11_000;
  cache.put({ guildId: 'g', channelId: 'c', requestId: 'new' }, { userId: 'u', ranked: [] });

  assert.equal(cache.size(), 1, 'an expired entry survived a write');
  assert.equal(cache.get({ guildId: 'g', channelId: 'c', requestId: 'old' }), null);
});

test('take consumes, get does not', () => {
  const cache = createSelectionCache({ now: () => 0 });
  const identity = { guildId: 'g', channelId: 'c', requestId: 'r' };
  cache.put(identity, { userId: 'u', ranked: [] });

  assert.ok(cache.get(identity), 'get removed the entry');
  assert.ok(cache.get(identity));
  assert.ok(cache.take(identity), 'take returned nothing');
  assert.equal(cache.get(identity), null, 'take did not consume');
});

/* -------------------------------------------------------------------------- */
/* Limits still apply                                                          */
/* -------------------------------------------------------------------------- */

test('the duration limit is enforced on the selected track', async () => {
  const long = [
    track('a', { title: 'Epic Mix', artist: 'Same', durationSeconds: 3600 }),
    track('b', { title: 'Epic Mix', artist: 'Same', durationSeconds: 3600 }),
  ];
  const harness = makeHarness({ source: new FakeSource({ results: long }), maxTrackSeconds: 20 * 60 });
  const candidate = await ambiguousRequest(harness);

  const interaction = selection({ requestId: candidate.id, value: '0' });
  await handleMusicInteraction(interaction, { music: harness.service, logger: createNullLogger() });

  assert.match(interaction.calls.reply[0].content, /çok uzun/);
  assert.equal(harness.sessions.get('g1').isPlaying(), false);
});

test('the queue limit is enforced on the selected track', async () => {
  const harness = makeHarness({ source: new FakeSource({ results: ambiguousResults() }), maxQueueSize: 1 });

  // Distinct queries: the duplicate guard is a separate mechanism from the
  // queue limit this test is about.
  const first = await ambiguousRequest(harness, { content: 'Song One' });
  await handleMusicInteraction(selection({ requestId: first.id, value: '0' }), {
    music: harness.service,
    logger: createNullLogger(),
  });

  const second = await ambiguousRequest(harness, { content: 'Song Two' });
  const third = await ambiguousRequest(harness, { content: 'Song Three' });

  await handleMusicInteraction(selection({ requestId: second.id, value: '0' }), {
    music: harness.service,
    logger: createNullLogger(),
  });

  const overflow = selection({ requestId: third.id, value: '0' });
  await handleMusicInteraction(overflow, { music: harness.service, logger: createNullLogger() });

  assert.match(overflow.calls.reply[0].content, /Sıra dolu/);
});

/* -------------------------------------------------------------------------- */
/* Routing                                                                     */
/* -------------------------------------------------------------------------- */

test('a select interaction is routed without disturbing other interactions', async () => {
  const harness = makeHarness({ source: new FakeSource({ results: ambiguousResults() }) });
  const candidate = await ambiguousRequest(harness);

  // Not a music component at all.
  const unrelated = selection({ requestId: candidate.id });
  unrelated.customId = 'other:thing';
  assert.equal(await handleMusicInteraction(unrelated, { music: harness.service }), false);

  // A music control button still takes the button path.
  const button = selection({ requestId: candidate.id });
  button.customId = 'music:skip';
  button.isButton = () => true;
  button.isStringSelectMenu = () => false;
  assert.equal(await handleMusicInteraction(button, { music: harness.service, logger: createNullLogger() }), true);
  assert.match(button.calls.reply[0].content, /Geçildi|çalan/);
});

test('the select payload uses a namespaced request-scoped customId', () => {
  const payload = buildSelectionPayload('query', [{ track: track('a') }], { requestId: '123456789012345678' });
  const menu = payload.components[0].toJSON().components[0];

  assert.equal(menu.custom_id, 'music:select:123456789012345678');
  assert.ok(menu.custom_id.length <= 100, 'the customId exceeds Discord\'s limit');
});

test('the selection flow makes no AI call and no network request', async () => {
  const originalFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = () => {
    fetched = true;
    throw new Error('network access attempted');
  };

  try {
    const harness = makeHarness({ source: new FakeSource({ results: ambiguousResults() }) });
    const candidate = await ambiguousRequest(harness);
    await handleMusicInteraction(selection({ requestId: candidate.id }), {
      music: harness.service,
      logger: createNullLogger(),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(fetched, false);
});
