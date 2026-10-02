import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { handleMusicRequest, shouldHandle, matchesChannelName } from '../src/music/listener.js';
import { authorizeControl, parseControlId, parseSelectionId, isMusicControl } from '../src/music/controls.js';
import { createRequestGuard } from '../src/music/request-guard.js';
import { createSelectionCache } from '../src/music/selection-cache.js';
import { createMusicSession, createSessionManager, ENQUEUE_RESULT } from '../src/music/session.js';
import { MusicSource, normaliseTrack } from '../src/music/source.js';
import { CONTROL_IDS, buildSelectionId } from '../src/music/messages.js';
import { createNullLogger } from '../src/utils/logger.js';

/**
 * The end-to-end request flow: a plain message in #muzik-istek becomes a search,
 * the same message anywhere else does nothing, and the controls are gated.
 *
 * No network, no voice, no gateway.
 */

const MUSIC_CHANNEL = 'muzik-istek';

const track = (id, overrides = {}) =>
  normaliseTrack({ id, source: 'fake', title: `Song ${id}`, durationSeconds: 200, ...overrides });

class FakeSource extends MusicSource {
  constructor({ results = null, failSearch = false } = {}) {
    super({ name: 'fake' });
    this.results = results;
    this.failSearch = failSearch;
    this.queries = [];
  }

  async search(query) {
    this.queries.push(query);
    if (this.failSearch) throw new Error('search backend down');
    if (this.results) return this.results;
    // A clear winner: exact title, official artist channel.
    return [track('hit', { title: query, artist: 'Artist - Topic' }), track('other', { title: 'Unrelated', artist: 'Nobody' })];
  }

  async createAudioStream() {
    return { stream: { pipe() {} }, inputType: 'arbitrary' };
  }
}

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

/** Builds the listener dependencies around one guild. */
function makeDeps({
  source = new FakeSource(),
  cooldownSeconds = 3,
  maxTrackSeconds = 1200,
  maxQueueSize = 50,
  selectionTimeoutSeconds = 60,
  summoned = true,
} = {}) {
  const sessions = createSessionManager();
  const guard = createRequestGuard({ cooldownSeconds });
  const selections = createSelectionCache({ timeoutSeconds: selectionTimeoutSeconds });

  /** Summons PompMusic into a channel, as /gel would. */
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

  // Most request behaviour only applies once PompMusic has been summoned, so
  // the harness summons by default. Tests about the un-summoned state pass
  // `summoned: false`.
  if (summoned) summon('g1');

  return {
    deps: { source, sessions, selections, guard, logger: createNullLogger(), config: { searchLimit: 5 } },
    sessions,
    guard,
    selections,
    summon,
  };
}

/** A message, with a channel that records what was posted. */
let messageCounter = 0;

function message({
  content = 'Vida Loca',
  channelName = MUSIC_CHANNEL,
  userId = 'u1',
  username = 'Ada',
  voiceChannelId = 'vc1',
  guildId = 'g1',
  bot = false,
  id = null,
} = {}) {
  const sent = [];
  return {
    // The selection cache is keyed on the asking message's id, so every fake
    // message needs a distinct one.
    id: id ?? `req-${(messageCounter += 1)}`,
    content,
    guildId,
    channelId: `c-${channelName}`,
    system: false,
    author: { id: userId, username, bot },
    member: { id: userId, voice: { channelId: voiceChannelId } },
    guild: { id: guildId },
    channel: {
      name: channelName,
      async send(payload) {
        sent.push(payload);
        return { id: `posted-${sent.length}`, ...payload };
      },
    },
    sent,
  };
}

const textOf = (payload) => (typeof payload === 'string' ? payload : payload?.content ?? '');

/* -------------------------------------------------------------------------- */
/* The strict channel rule                                                     */
/* -------------------------------------------------------------------------- */

test('a plain song name in #muzik-istek is handled', () => {
  assert.equal(shouldHandle(message(), { musicChannelName: MUSIC_CHANNEL }), true);
});

test('the same text in any other channel is ignored', () => {
  for (const channelName of ['genel', 'maden', 'kod', 'pompai', 'ada', 'unity', 'buglar', 'bedava-oyunlar']) {
    assert.equal(
      shouldHandle(message({ channelName }), { musicChannelName: MUSIC_CHANNEL }),
      false,
      `#${channelName} triggered music`,
    );
  }
});

test('an unresolved channel id is not treated as a match', () => {
  const candidate = message({ channelName: 'genel' });
  // A configured channel id that does not match must not fall through to the
  // name check and match anyway.
  assert.equal(shouldHandle(candidate, { musicChannelName: MUSIC_CHANNEL, musicChannelId: 'c-muzik-istek' }), false);
  assert.equal(shouldHandle(message(), { musicChannelName: MUSIC_CHANNEL, musicChannelId: 'c-muzik-istek' }), true);
});

test('bots, empty messages and command-looking text are ignored', () => {
  assert.equal(shouldHandle(message({ bot: true }), { musicChannelName: MUSIC_CHANNEL }), false);
  assert.equal(shouldHandle(message({ content: '   ' }), { musicChannelName: MUSIC_CHANNEL }), false);
  assert.equal(shouldHandle(message({ content: '/ask hello' }), { musicChannelName: MUSIC_CHANNEL }), false);
  assert.equal(shouldHandle(null, { musicChannelName: MUSIC_CHANNEL }), false);
  assert.equal(shouldHandle({ ...message(), system: true }, { musicChannelName: MUSIC_CHANNEL }), false);
});

test('channel comparison is case- and padding-insensitive', () => {
  assert.equal(matchesChannelName('  Muzik-Istek ', MUSIC_CHANNEL), true);
  assert.equal(matchesChannelName('muzik-istek-2', MUSIC_CHANNEL), false);
  assert.equal(matchesChannelName(null, MUSIC_CHANNEL), false);
});

/* -------------------------------------------------------------------------- */
/* Voice requirements                                                          */
/* -------------------------------------------------------------------------- */

test('a requester who is not in voice is told to join first', async () => {
  const { deps } = makeDeps();
  const candidate = message({ voiceChannelId: null });

  const result = await handleMusicRequest(candidate, deps);

  assert.equal(result.action, 'rejected');
  assert.equal(result.reason, 'not-in-voice');
  assert.match(textOf(candidate.sent[0]), /🎧 Önce bir ses kanalına katıl\./);
});

test('a request from a different voice channel does not move the bot', async () => {
  const { deps, sessions } = makeDeps();
  const first = message({ voiceChannelId: 'vc1' });
  await handleMusicRequest(first, deps);

  // A second person, in another room, asks for something else.
  const second = message({ userId: 'u2', voiceChannelId: 'vc2', content: 'Other Song' });
  const result = await handleMusicRequest(second, deps);

  assert.equal(result.reason, 'wrong-channel');
  assert.match(textOf(second.sent[0]), /Müzik Odası/);
  assert.equal(sessions.get('g1').voiceChannelId, 'vc1', 'the bot changed voice channel');
  assert.equal(deps.source.queries.length, 1, 'a search was issued for a refused request');
});

/* -------------------------------------------------------------------------- */
/* Playback flow                                                               */
/* -------------------------------------------------------------------------- */

test('the first request searches and starts playback', async () => {
  const { deps } = makeDeps();
  const candidate = message({ content: 'Kerimcan Durmaz Vida Loca' });

  const result = await handleMusicRequest(candidate, deps);

  assert.equal(result.action, 'playing');
  assert.deepEqual(deps.source.queries, ['Kerimcan Durmaz Vida Loca']);
});

test('a second request queues behind the first', async () => {
  const { deps, sessions } = makeDeps();
  await handleMusicRequest(message({ content: 'First Song' }), deps);

  const second = message({ userId: 'u2', content: 'Second Song' });
  const result = await handleMusicRequest(second, deps);

  assert.equal(result.action, 'queued');
  assert.equal(sessions.get('g1').queue.size, 1);
  assert.match(textOf(second.sent[0]), /Sıraya eklendi/);
});

test('an empty search result is reported, not guessed at', async () => {
  const { deps } = makeDeps({ source: new FakeSource({ results: [] }) });
  const candidate = message({ content: 'Nothing At All' });

  const result = await handleMusicRequest(candidate, deps);

  assert.equal(result.reason, 'no-results');
  assert.match(textOf(candidate.sent[0]), /sonuç bulunamadı/);
});

test('a search failure is reported without leaking the backend message', async () => {
  const { deps } = makeDeps({ source: new FakeSource({ failSearch: true }) });
  const candidate = message({ content: 'Anything' });

  const result = await handleMusicRequest(candidate, deps);

  assert.equal(result.reason, 'search-failed');
  assert.match(textOf(candidate.sent[0]), /Arama şu anda çalışmıyor/);
  assert.ok(!textOf(candidate.sent[0]).includes('search backend down'), 'the raw error leaked');
});

test('an ambiguous search offers choices instead of playing the wrong song', async () => {
  const source = new FakeSource({
    results: [track('a', { title: 'Vida Loca', artist: 'One' }), track('b', { title: 'Vida Loca', artist: 'Two' })],
  });
  const { deps, sessions } = makeDeps({ source });
  const candidate = message({ content: 'Vida Loca' });

  const result = await handleMusicRequest(candidate, deps);

  assert.equal(result.action, 'disambiguate');
  assert.equal(result.reason, 'too-close');
  assert.equal(candidate.sent[0].components.length, 1, 'no selection menu was offered');
  // A session exists (PompMusic was summoned) but nothing is playing yet.
  assert.equal(sessions.get('g1').isPlaying(), false, 'playback started despite the ambiguity');
});

/* -------------------------------------------------------------------------- */
/* Duplicate guard and limits                                                  */
/* -------------------------------------------------------------------------- */

test('the same user repeating the same song is refused with a notice', async () => {
  const { deps } = makeDeps();
  await handleMusicRequest(message({ content: 'Vida Loca' }), deps);

  const repeat = message({ content: 'Vida Loca' });
  const result = await handleMusicRequest(repeat, deps);

  assert.equal(result.reason, 'duplicate');
  assert.match(textOf(repeat.sent[0]), /az önce istedin/);
  assert.equal(deps.source.queries.length, 1, 'the duplicate reached the search backend');
});

test('a track longer than the limit is refused', async () => {
  const source = new FakeSource({
    results: [track('long', { title: 'Epic Mix', artist: 'Topic - X', durationSeconds: 3600 })],
  });
  const { deps } = makeDeps({ source, maxTrackSeconds: 20 * 60 });
  const candidate = message({ content: 'Epic Mix' });

  const result = await handleMusicRequest(candidate, deps);

  assert.equal(result.reason, 'too-long');
  assert.match(textOf(candidate.sent[0]), /çok uzun/);
});

test('a full queue is refused with a readable notice', async () => {
  const { deps } = makeDeps({ maxQueueSize: 1 });
  await handleMusicRequest(message({ content: 'First' }), deps);
  await handleMusicRequest(message({ userId: 'u2', content: 'Second' }), deps);

  const overflow = message({ userId: 'u3', content: 'Third' });
  const result = await handleMusicRequest(overflow, deps);

  assert.equal(result.reason, 'queue-full');
  assert.match(textOf(overflow.sent[0]), /Sıra dolu/);
});

test('a track that could not start is reported as such, never as playing', async () => {
  // The session reports START_FAILED when the stream produced no audio or the
  // player never began. Saying "playing" here is the false claim the first-byte
  // gate exists to remove.
  const { deps } = makeDeps();
  const candidate = message({ content: 'Vida Loca' });
  deps.session = {
    destroyed: false,
    queue: { maxSize: 50, maxTrackSeconds: 1200 },
    async enqueue() {
      return { ok: false, reason: ENQUEUE_RESULT.START_FAILED, position: null, started: false };
    },
  };

  const result = await handleMusicRequest(candidate, deps);

  assert.equal(result.action, 'rejected');
  assert.equal(result.reason, ENQUEUE_RESULT.START_FAILED);
  assert.doesNotMatch(textOf(candidate.sent[0]), /Çalınıyor/);
  assert.match(textOf(candidate.sent[0]), /başlatılamadı/);
});

/* -------------------------------------------------------------------------- */
/* Controls                                                                    */
/* -------------------------------------------------------------------------- */

test('control ids parse and are namespaced', () => {
  assert.equal(isMusicControl(CONTROL_IDS.SKIP), true);
  assert.equal(isMusicControl('something:else'), false);
  assert.equal(isMusicControl(undefined), false);

  assert.equal(parseControlId(CONTROL_IDS.PAUSE), 'pause');
  assert.equal(parseControlId(CONTROL_IDS.SKIP), 'skip');
  assert.equal(parseControlId(CONTROL_IDS.STOP), 'stop');
  assert.equal(parseControlId('music:nonsense'), null);

  // The selection menu carries its request id in the customId.
  assert.equal(parseControlId(buildSelectionId('123456789012345678')), 'select');
  assert.equal(parseSelectionId(buildSelectionId('123456789012345678')), '123456789012345678');
  assert.equal(parseSelectionId('music:select:abc'), null, 'a non-snowflake id was accepted');
  assert.equal(parseSelectionId('music:select:'), null);
  assert.equal(parseSelectionId('music:select:123:456'), null);
});

/**
 * A caller: the member object plus the voice channel id the shared resolver
 * would return for them. Production code resolves the id once and passes it in;
 * these tests supply it directly so the authorization rules can be exercised
 * without a gateway.
 */
const caller = (options = {}) => ({
  member: member(options),
  memberChannelId: options.channelId === undefined ? 'vc1' : options.channelId,
});

/** A member in (or not in) a voice channel. */
const member = ({ channelId = 'vc1', id = 'u1', manageChannels = false, roles = [] } = {}) => ({
  id,
  voice: { channelId },
  roles: { cache: { has: (roleId) => roles.includes(roleId) } },
  permissions: { has: (flag) => manageChannels && flag === PermissionFlagsBits.ManageChannels },
});

const liveSession = { destroyed: false, voiceChannelId: 'vc1', queue: { current: { requestedById: 'u1' } } };

test('a member in the active voice channel may skip', () => {
  const verdict = authorizeControl({ action: 'skip', ...caller(), session: liveSession });

  assert.equal(verdict.ok, true);
});

test('a member outside the voice channel is refused', () => {
  const verdict = authorizeControl({ action: 'skip', ...caller({ channelId: 'vc2' }), session: liveSession });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'wrong-channel');
});

test('a member in no voice channel is refused with the join hint', () => {
  const verdict = authorizeControl({ action: 'skip', ...caller({ channelId: null }), session: liveSession });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'not-in-voice');
  assert.match(verdict.message, /ses kanalına katıl/);
});

test('stop is refused for a bystander but allowed for the requester', () => {
  const bystander = authorizeControl({
    action: 'stop',
    ...caller({ id: 'u2' }),
    session: liveSession,
    requesterId: 'u1',
    manageChannelsFlag: PermissionFlagsBits.ManageChannels,
  });
  const requester = authorizeControl({
    action: 'stop',
    ...caller({ id: 'u1' }),
    session: liveSession,
    requesterId: 'u1',
    manageChannelsFlag: PermissionFlagsBits.ManageChannels,
  });

  assert.equal(bystander.ok, false);
  assert.equal(bystander.reason, 'not-permitted');
  assert.equal(requester.ok, true);
});

test('stop is allowed for a member with Manage Channels', () => {
  const verdict = authorizeControl({
    action: 'stop',
    ...caller({ id: 'u9', manageChannels: true }),
    session: liveSession,
    requesterId: 'u1',
    manageChannelsFlag: PermissionFlagsBits.ManageChannels,
  });

  assert.equal(verdict.ok, true);
});

test('stop is allowed for the configured DJ role', () => {
  const verdict = authorizeControl({
    action: 'stop',
    ...caller({ id: 'u9', roles: ['dj-role'] }),
    session: liveSession,
    requesterId: 'u1',
    djRoleId: 'dj-role',
  });

  assert.equal(verdict.ok, true);
});

test('every control is refused when nothing is playing', () => {
  for (const action of ['pause', 'skip', 'stop', 'shuffle', 'repeat']) {
    const verdict = authorizeControl({ action, ...caller(), session: null });
    assert.equal(verdict.ok, false, `${action} was allowed with no session`);
    assert.equal(verdict.reason, 'no-session');
  }
});

test('a destroyed session refuses every control', () => {
  const verdict = authorizeControl({ action: 'skip', ...caller(), session: { destroyed: true } });
  assert.equal(verdict.ok, false);
});

/* -------------------------------------------------------------------------- */
/* Isolation                                                                   */
/* -------------------------------------------------------------------------- */

test('two guilds never share a queue or a session', async () => {
  const { deps, sessions, summon } = makeDeps();
  // Both guilds must have been summoned; a request alone never joins.
  summon('g2', 'vc2', 'İkinci Oda');

  await handleMusicRequest(message({ guildId: 'g1', content: 'Guild One Song' }), deps);
  await handleMusicRequest(message({ guildId: 'g2', voiceChannelId: 'vc2', content: 'Guild Two Song' }), deps);

  assert.equal(sessions.size, 2);
  assert.equal(sessions.get('g1').queue.current.track.title, 'Guild One Song');
  assert.equal(sessions.get('g2').queue.current.track.title, 'Guild Two Song');
});

test('the music subsystem imports no AI and makes no AI call', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');

  const files = [];
  const walk = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  };
  await walk(path.join(process.cwd(), 'src', 'music'));

  assert.ok(files.length > 0);
  for (const file of files) {
    const code = await fs.readFile(file, 'utf8');
    assert.ok(
      !/from\s+['"][^'"]*\/ai\//.test(code),
      `${path.basename(file)} imports the AI layer`,
    );
    assert.ok(!/\.complete\s*\(/.test(code), `${path.basename(file)} calls a model`);
  }
});
