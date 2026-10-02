import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createMusicSession, createSessionManager } from '../src/music/session.js';
import { evaluateSummon, evaluateLeave, evaluateActiveMember, PRESENCE_TEXTS, SUMMON } from '../src/music/presence.js';
import { handleMusicRequest } from '../src/music/listener.js';
import { createSelectionCache } from '../src/music/selection-cache.js';
import { createRequestGuard } from '../src/music/request-guard.js';
import { MusicSource, normaliseTrack } from '../src/music/source.js';
import { loadCommands } from '../src/commands/index.js';
import { startPompMusic } from '../src/music/bot.js';
import { createNullLogger } from '../src/utils/logger.js';

/**
 * The two-bot split: separate clients, separate command sets, and a voice
 * lifecycle that stays put once summoned.
 *
 * No gateway, no audio, no network anywhere in this file.
 */

const track = (id, overrides = {}) =>
  normaliseTrack({ id, source: 'fake', title: `Song ${id}`, durationSeconds: 200, ...overrides });

class FakeSource extends MusicSource {
  constructor() {
    super({ name: 'fake' });
    this.queries = [];
    this.streamed = [];
  }

  async search(query) {
    this.queries.push(query);
    return [track('hit', { title: query, artist: 'Artist - Topic' }), track('other', { title: 'Unrelated' })];
  }

  async createAudioStream(item) {
    this.streamed.push(item.id);
    return { stream: { pipe() {} }, inputType: 'arbitrary' };
  }
}

function fakeVoice() {
  const handlers = new Map();
  return {
    channelId: null,
    isConnected: false,
    async join(channelId) {
      this.channelId = channelId;
      this.isConnected = true;
    },
    play() {},
    pause() {},
    resume() {},
    stop() {},
    leave() {},
    destroy() {
      this.channelId = null;
      this.isConnected = false;
    },
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    emit(event, payload) {
      for (const handler of handlers.get(event) ?? []) handler(payload);
    },
  };
}

/** A guild with channels and members, enough for the presence checks. */
function guild({ id = 'g1', channels = {}, humansIn = {} } = {}) {
  return {
    id,
    channels: {
      cache: {
        get: (channelId) => {
          const name = channels[channelId];
          if (!name) return null;
          const members = new Set((humansIn[channelId] ?? []).map((userId) => ({ user: { bot: false, id: userId } })));
          return {
            id: channelId,
            name,
            members: { filter: (predicate) => [...members].filter(predicate) },
          };
        },
      },
    },
  };
}

const member = ({ id = 'u1', channelId = 'vc1', manageChannels = false } = {}) => ({
  id,
  voice: { channelId },
  permissions: { has: () => manageChannels },
});

/* -------------------------------------------------------------------------- */
/* Presence: /gel                                                              */
/* -------------------------------------------------------------------------- */

test('/gel requires the caller to be in a voice channel', () => {
  const verdict = evaluateSummon({ memberChannelId: null, session: null });

  assert.equal(verdict.action, SUMMON.REFUSE);
  assert.equal(verdict.reason, 'not-in-voice');
  assert.match(verdict.message, /ses kanalına katıl/);
});

test('/gel joins when no session exists', () => {
  const verdict = evaluateSummon({ memberChannelId: 'vc1', session: null, requestedChannelName: 'MiningFools' });

  assert.equal(verdict.action, SUMMON.JOIN);
  assert.equal(verdict.message, PRESENCE_TEXTS.arrived('MiningFools'));
  assert.match(verdict.message, /PompMusic "MiningFools" kanalına geldi/);
});

test('/gel in the channel it already occupies says so and changes nothing', () => {
  const session = { destroyed: false, voiceChannelId: 'vc1' };
  const verdict = evaluateSummon({ memberChannelId: 'vc1', session, currentChannelName: 'MiningFools' });

  assert.equal(verdict.action, SUMMON.ALREADY);
  assert.match(verdict.message, /zaten "MiningFools" kanalında/);
});

test('/gel does not hijack an occupied channel', () => {
  const session = { destroyed: false, voiceChannelId: 'vc1' };
  const verdict = evaluateSummon({
    memberChannelId: 'vc2',
    session,
    currentChannelName: 'MiningFools',
    currentChannelEmpty: false,
    hasManageChannels: false,
  });

  assert.equal(verdict.action, SUMMON.REFUSE);
  assert.equal(verdict.reason, 'in-use');
  assert.match(verdict.message, /şu anda "MiningFools" kanalında kullanılıyor/);
});

test('/gel may move when the current channel is empty', () => {
  const session = { destroyed: false, voiceChannelId: 'vc1' };
  const verdict = evaluateSummon({
    memberChannelId: 'vc2',
    session,
    currentChannelEmpty: true,
    requestedChannelName: 'MiningFools',
  });

  assert.equal(verdict.action, SUMMON.MOVE);
});

test('/gel may move for a member with Manage Channels', () => {
  const session = { destroyed: false, voiceChannelId: 'vc1' };
  const verdict = evaluateSummon({
    memberChannelId: 'vc2', hasManageChannels: true,
    session,
    currentChannelEmpty: false,
    hasManageChannels: true,
  });

  assert.equal(verdict.action, SUMMON.MOVE);
});

/* -------------------------------------------------------------------------- */
/* Presence: /git                                                              */
/* -------------------------------------------------------------------------- */

test('/git is refused for a member in another channel without Manage Channels', () => {
  const session = { destroyed: false, voiceChannelId: 'vc1' };
  const verdict = evaluateLeave({ memberChannelId: 'vc2', session });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'not-permitted');
});

test('/git is allowed for a member in the active channel', () => {
  const session = { destroyed: false, voiceChannelId: 'vc1' };
  assert.equal(evaluateLeave({ memberChannelId: 'vc1', session }).ok, true);
});

test('/git is allowed for a member with Manage Channels', () => {
  const session = { destroyed: false, voiceChannelId: 'vc1' };
  assert.equal(evaluateLeave({ memberChannelId: 'vc2', session, hasManageChannels: true }).ok, true);
});

test('/git with nothing summoned says so', () => {
  const verdict = evaluateLeave({ member: member(), session: null });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'no-session');
});

test('a member outside the active channel may not use the controls', () => {
  const session = { destroyed: false, voiceChannelId: 'vc1' };
  const verdict = evaluateActiveMember({ memberChannelId: 'vc2', session });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'wrong-channel');
});

/* -------------------------------------------------------------------------- */
/* Voice lifecycle                                                             */
/* -------------------------------------------------------------------------- */

function makeSession({ stayConnected = true, voice = fakeVoice() } = {}) {
  const source = new FakeSource();
  const session = createMusicSession({
    guildId: 'g1',
    source,
    voice,
    voiceChannelId: 'vc1',
    channelName: 'Müzik Odası',
    // Stay-connected is expressed as "never schedule the disconnect".
    idleDisconnectSeconds: stayConnected ? 0 : 120,
    logger: createNullLogger(),
  });
  return { session, voice, source };
}

test('an empty queue does not disconnect PompMusic', async () => {
  const { session, voice } = makeSession();
  await session.begin();

  // Nothing was ever queued; the queue drains immediately.
  voice.emit('idle');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(session.destroyed, false, 'PompMusic left on its own');
  assert.equal(voice.isConnected, true, 'the voice connection was dropped');
  assert.equal(session.isIdle(), true, 'the session should be idle, not gone');
});

test('a track ending does not disconnect PompMusic', async () => {
  const { session, voice } = makeSession();
  await session.enqueue(track('a'), { id: 'u1', name: 'Ada' });

  voice.emit('idle');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(session.destroyed, false);
  assert.equal(voice.isConnected, true);
  assert.equal(session.isPlaying(), false, 'playback should have finished');
});

test('staying connected survives several finished tracks', async () => {
  const { session, voice } = makeSession();

  for (const id of ['a', 'b', 'c']) {
    await session.enqueue(track(id), { id: 'u1', name: 'Ada' });
    voice.emit('idle');
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(session.destroyed, false);
  assert.equal(voice.isConnected, true);
});

test('the next request after an idle period starts playing again', async () => {
  const { session, voice, source } = makeSession();
  await session.enqueue(track('a'), { id: 'u1', name: 'Ada' });
  voice.emit('idle');
  await new Promise((resolve) => setImmediate(resolve));

  await session.enqueue(track('b'), { id: 'u1', name: 'Ada' });

  assert.deepEqual(source.streamed, ['a', 'b']);
  assert.equal(session.queue.current.track.id, 'b');
});

test('stay-connected off restores the idle disconnect', async () => {
  const timers = [];
  const voice = fakeVoice();
  const session = createMusicSession({
    guildId: 'g1',
    source: new FakeSource(),
    voice,
    voiceChannelId: 'vc1',
    idleDisconnectSeconds: 120,
    logger: createNullLogger(),
    setTimeoutImpl: (fn) => {
      timers.push(fn);
      return { unref() {} };
    },
    clearTimeoutImpl: () => {},
  });

  await session.begin();
  voice.emit('idle');
  await new Promise((resolve) => setImmediate(resolve));

  // `begin()` over an empty queue schedules one, and the finished track
  // schedules another; either firing must disconnect.
  assert.ok(timers.length >= 1, 'no idle timer was scheduled');
  timers.at(-1)();
  assert.equal(session.destroyed, true);
});

/* -------------------------------------------------------------------------- */
/* Request gating                                                              */
/* -------------------------------------------------------------------------- */

function harness({ summoned = true } = {}) {
  const source = new FakeSource();
  const sessions = createSessionManager();
  const selections = createSelectionCache({ timeoutSeconds: 60 });
  const guard = createRequestGuard({ cooldownSeconds: 3 });

  const summon = (guildId = 'g1', voiceChannelId = 'vc1', channelName = 'Müzik Odası') =>
    sessions.getOrCreate(guildId, () =>
      createMusicSession({
        guildId,
        source,
        voice: fakeVoice(),
        voiceChannelId,
        channelName,
        idleDisconnectSeconds: 0,
        logger: createNullLogger(),
      }),
    );

  if (summoned) summon('g1');

  return { deps: { source, sessions, selections, guard, logger: createNullLogger() }, source, sessions, summon };
}

let counter = 0;

function message({ content = 'Müslüm Gürses Affet', userId = 'u1', voiceChannelId = 'vc1', guildId = 'g1', channelName = 'muzik-istek' } = {}) {
  const sent = [];
  return {
    id: String(900000000000000000n + BigInt((counter += 1))),
    content,
    guildId,
    channelId: `c-${channelName}`,
    system: false,
    author: { id: userId, username: `user-${userId}`, bot: false },
    member: { id: userId, voice: { channelId: voiceChannelId } },
    guild: { id: guildId },
    channel: {
      name: channelName,
      async send(payload) {
        sent.push(payload);
        return { id: 'posted', ...payload };
      },
    },
    sent,
  };
}

const textOf = (payload) => (typeof payload === 'string' ? payload : payload?.content ?? '');

test('a plain song name works once PompMusic has been summoned', async () => {
  const { deps } = harness();
  const candidate = message();

  const result = await handleMusicRequest(candidate, deps);

  assert.equal(result.action, 'playing');
  assert.deepEqual(deps.source.queries, ['Müslüm Gürses Affet']);
});

test('a song before /gel tells the user to summon PompMusic', async () => {
  const { deps } = harness({ summoned: false });
  const candidate = message();

  const result = await handleMusicRequest(candidate, deps);

  assert.equal(result.action, 'rejected');
  assert.equal(result.reason, 'no-session');
  assert.match(textOf(candidate.sent[0]), /\/gel ile PompMusic'i çağır/);
});

test('a request never summons PompMusic by itself', async () => {
  const { deps, sessions } = harness({ summoned: false });

  await handleMusicRequest(message(), deps);

  assert.equal(sessions.size, 0, 'a plain song name brought the bot into a channel');
});

test('someone outside the active voice channel cannot queue', async () => {
  const { deps } = harness();
  const outsider = message({ userId: 'u2', voiceChannelId: 'vc9' });

  const result = await handleMusicRequest(outsider, deps);

  assert.equal(result.reason, 'wrong-channel');
  assert.match(textOf(outsider.sent[0]), /Müzik Odası.*kanalına katıl/);
  assert.deepEqual(deps.source.queries, [], 'a search ran for a refused request');
});

test('someone inside the active voice channel can queue', async () => {
  const { deps } = harness();
  await handleMusicRequest(message({ userId: 'u1', content: 'First Song' }), deps);

  const second = message({ userId: 'u2', content: 'Second Song' });
  const result = await handleMusicRequest(second, deps);

  assert.equal(result.action, 'queued');
});

test('messages outside #muzik-istek never reach the handler', async () => {
  const { shouldHandle } = await import('../src/music/listener.js');

  for (const channelName of ['genel', 'maden', 'kod', 'pompai', 'ada']) {
    assert.equal(
      shouldHandle(message({ channelName }), { musicChannelName: 'muzik-istek' }),
      false,
      `#${channelName} would have triggered music`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* Two-bot separation                                                          */
/* -------------------------------------------------------------------------- */

test('the two applications own disjoint command sets', async () => {
  const ai = await loadCommands(undefined, { owner: 'pompai' });
  const music = await loadCommands(undefined, { owner: 'pompmusic' });

  const overlap = [...ai.keys()].filter((name) => music.has(name));
  assert.deepEqual(overlap, [], `commands registered to both bots: ${overlap.join(', ')}`);
  assert.ok(music.has('gel') && music.has('git') && music.has('durdur-ve-git'));
  assert.ok(!ai.has('gel') && !ai.has('git'), 'a music command was owned by PompAI');
  assert.ok(ai.has('ask') && ai.has('oyun'), 'an AI command was lost');
});

test('every music command declares PompMusic as its owner', async () => {
  const music = await loadCommands(undefined, { owner: 'pompmusic' });

  assert.ok(music.size >= 9, `expected the full music set, found ${music.size}`);
  for (const command of music.values()) {
    assert.equal(command.owner, 'pompmusic', `${command.name} is not owned by PompMusic`);
  }
});

test('PompMusic loads its own commands and none of PompAI\'s', async () => {
  const music = await loadCommands(undefined, { owner: 'pompmusic' });

  for (const name of ['ask', 'oyun', 'ucretsiz', 'ping', 'status']) {
    assert.ok(!music.has(name), `${name} was loaded for PompMusic`);
  }
});

test('PompMusic uses its own token, never PompAI\'s', async () => {
  const config = {
    discord: { token: 'pompai-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', clientId: '111111111111111111' },
    pompMusic: {
      enabled: true,
      token: 'pompmusic-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      clientId: '222222222222222222',
      textChannel: 'muzik-istek',
      voiceChannel: 'Müzik Odası',
      stayConnected: true,
      idleDisconnectSeconds: 0,
      maxQueueSize: 50,
      maxTrackMinutes: 20,
    },
  };

  let loggedInWith = null;
  const client = new EventEmitter();
  client.login = async (token) => {
    loggedInWith = token;
    return token;
  };
  client.destroy = async () => {};
  client.guilds = { cache: new Map() };
  client.user = { tag: 'PompMusic#0001' };

  const bot = await startPompMusic({
    config,
    logger: createNullLogger(),
    source: new FakeSource(),
    clientFactory: () => client,
  });

  assert.equal(loggedInWith, config.pompMusic.token);
  assert.notEqual(loggedInWith, config.discord.token, 'PompMusic logged in with PompAI\'s token');
  assert.equal(bot.commands.has('gel'), true);
  assert.equal(bot.commands.has('ask'), false);
});

test('PompMusic requests the voice and message intents, PompAI does not', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');

  // Comments legitimately name the intent PompAI does *not* want, so only
  // executable code is inspected.
  const strip = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const musicBot = strip(await fs.readFile(path.join(process.cwd(), 'src', 'music', 'bot.js'), 'utf8'));
  const pompai = strip(await fs.readFile(path.join(process.cwd(), 'src', 'index.js'), 'utf8'));

  assert.match(musicBot, /MessageContent/, 'PompMusic does not ask for Message Content');
  assert.match(musicBot, /GuildVoiceStates/, 'PompMusic does not ask for voice states');

  assert.ok(
    !/MessageContent/.test(pompai),
    'PompAI still requests the privileged Message Content intent',
  );
});

test('enabling PompMusic without a token fails with a readable message', async () => {
  const config = {
    discord: { token: 'x' },
    pompMusic: { enabled: true, token: null, clientId: null },
  };

  await assert.rejects(
    () => startPompMusic({ config, logger: createNullLogger() }),
    (error) => {
      assert.equal(error.code, 'POMPMUSIC_NOT_CONFIGURED');
      assert.match(error.message, /separate Discord application/);
      return true;
    },
  );
});

test('a disabled PompMusic starts nothing at all', async () => {
  const bot = await startPompMusic({ config: { pompMusic: { enabled: false } }, logger: createNullLogger() });

  assert.equal(bot, null);
});

/* -------------------------------------------------------------------------- */
/* Isolation                                                                   */
/* -------------------------------------------------------------------------- */

test('nothing in the music tree can reach the AI layer', async () => {
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

  for (const file of files) {
    const code = await fs.readFile(file, 'utf8');
    assert.ok(!/from\s+['"][^'"]*\/ai\//.test(code), `${path.basename(file)} imports the AI layer`);
    assert.ok(!/\.complete\s*\(/.test(code), `${path.basename(file)} calls a model`);
  }
  assert.ok(files.length >= 15, `expected the full music tree, found ${files.length} files`);
});

test('a music failure does not propagate out of the request handler', async () => {
  const { deps } = harness();
  deps.source.search = async () => {
    throw new Error('YouTube is down');
  };
  const candidate = message();

  // The handler reports the failure; it does not throw at its caller, which is
  // what keeps a dead media backend from reaching the process crash handler.
  await assert.doesNotReject(() => handleMusicRequest(candidate, deps));
  assert.match(textOf(candidate.sent[0]), /Arama şu anda çalışmıyor/);
});

test('a session that fails to join surfaces rather than half-starting', async () => {
  const voice = fakeVoice();
  voice.join = async () => {
    throw new Error('voice unavailable');
  };
  const session = createMusicSession({
    guildId: 'g1',
    source: new FakeSource(),
    voice,
    voiceChannelId: 'vc1',
    logger: createNullLogger(),
  });

  await assert.rejects(() => session.begin(), /voice unavailable/);
});
