import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeVoiceResolution, resolveMemberVoiceChannel } from '../src/music/voice-state.js';
import { evaluateSummon, evaluateActiveMember, evaluateLeave, SUMMON } from '../src/music/presence.js';
import { authorizeControl, authorizeSelection } from '../src/music/controls.js';
import { handleMusicRequest } from '../src/music/listener.js';
import { createSessionManager } from '../src/music/session.js';
import { createSelectionCache } from '../src/music/selection-cache.js';
import { createRequestGuard } from '../src/music/request-guard.js';
import { MusicSource, normaliseTrack } from '../src/music/source.js';
import { createNullLogger } from '../src/utils/logger.js';

/**
 * Voice-state resolution in real Discord.
 *
 * The live bug: a member visibly sitting in a voice channel was told to join
 * one. The cause was `interaction.member.voice` - which is `undefined` whenever
 * `interaction.member` is the *raw* API payload rather than a hydrated
 * GuildMember, because the raw shape has no `voice` field at all.
 *
 * These tests reproduce that exact shape, which is why several fixtures look
 * deliberately impoverished: that is what the gateway actually sends.
 */

/** A raw API interaction member: no `voice` property whatsoever. */
const rawMember = (id = 'u1') => ({
  id,
  user: { id },
  nick: null,
  roles: [],
  joined_at: '2026-01-01T00:00:00.000Z',
  deaf: false,
  mute: false,
  // NOTE: no `voice` key. This is the shape that broke /gel.
});

/** A hydrated discord.js GuildMember. */
const hydratedMember = (id = 'u1', channelId = 'vc1') => ({
  id,
  user: { id, bot: false },
  voice: { channelId, channel: channelId ? { id: channelId } : null },
});

/** A guild whose voice-state cache knows about `voiceStates`. */
function guild({ id = 'g1', voiceStates = {}, members = {} } = {}) {
  return {
    id,
    voiceStates: { cache: new Map(Object.entries(voiceStates)) },
    members: { cache: new Map(Object.entries(members)) },
  };
}

/* -------------------------------------------------------------------------- */
/* The resolver                                                                */
/* -------------------------------------------------------------------------- */

test('resolves the channel from the guild voice-state cache', () => {
  const id = resolveMemberVoiceChannel({
    guild: guild({ voiceStates: { u1: { channelId: 'vc1' } } }),
    userId: 'u1',
    member: null,
  });

  assert.equal(id, 'vc1');
});

test('works when the interaction member has no voice property at all', () => {
  // This is the live bug, reproduced exactly.
  const member = rawMember('u1');
  assert.equal('voice' in member, false, 'the fixture is not a raw member');

  const id = resolveMemberVoiceChannel({
    guild: guild({ voiceStates: { u1: { channelId: 'vc1' } } }),
    userId: 'u1',
    member,
  });

  assert.equal(id, 'vc1', 'a raw interaction member still broke resolution');
});

test('works when the guild member cache does not contain the member', () => {
  const id = resolveMemberVoiceChannel({
    guild: guild({ voiceStates: { u1: { channelId: 'vc1' } }, members: {} }),
    userId: 'u1',
    member: rawMember('u1'),
  });

  assert.equal(id, 'vc1');
});

test('falls back to a hydrated member when the voice-state cache is empty', () => {
  const id = resolveMemberVoiceChannel({
    guild: guild(),
    userId: 'u1',
    member: hydratedMember('u1', 'vc2'),
  });

  assert.equal(id, 'vc2');
});

test('falls back to the cached guild member next', () => {
  const id = resolveMemberVoiceChannel({
    guild: guild({ members: { u1: hydratedMember('u1', 'vc3') } }),
    userId: 'u1',
    member: rawMember('u1'),
  });

  assert.equal(id, 'vc3');
});

test('the voice-state cache wins over a stale member object', () => {
  const id = resolveMemberVoiceChannel({
    guild: guild({ voiceStates: { u1: { channelId: 'vc-current' } } }),
    userId: 'u1',
    member: hydratedMember('u1', 'vc-stale'),
  });

  assert.equal(id, 'vc-current', 'a stale member.voice overrode the authoritative cache');
});

test('a raw snake_case channel_id is understood', () => {
  const id = resolveMemberVoiceChannel({
    guild: guild(),
    userId: 'u1',
    member: { id: 'u1', voice: { channel_id: 'vc9', session_id: 's', deaf: false, mute: false } },
  });

  assert.equal(id, 'vc9', 'the raw API voice shape was not handled');
});

test('a voice state exposing a channel object rather than an id still works', () => {
  const id = resolveMemberVoiceChannel({
    guild: guild({ voiceStates: { u1: { channel: { id: 'vc7' } } } }),
    userId: 'u1',
  });

  assert.equal(id, 'vc7');
});

test('a genuinely disconnected member resolves to null', () => {
  for (const options of [
    { guild: guild(), userId: 'u1', member: rawMember('u1') },
    { guild: guild(), userId: 'u1', member: hydratedMember('u1', null) },
    { guild: guild({ voiceStates: { u1: { channelId: null } } }), userId: 'u1' },
    { guild: null, userId: 'u1', member: null },
    {},
  ]) {
    assert.equal(resolveMemberVoiceChannel(options), null, `resolved for ${JSON.stringify(options)}`);
  }
});

test('the resolver never throws on an unusable guild or member', () => {
  for (const options of [
    { guild: {}, userId: 'u1' },
    { guild: { voiceStates: {} }, userId: 'u1' },
    { guild: { voiceStates: { cache: null } }, userId: 'u1' },
    { guild: guild(), userId: null, member: null },
    { guild: guild(), member: 42 },
  ]) {
    assert.doesNotThrow(() => resolveMemberVoiceChannel(options));
  }
});

test('the user id is taken from the member when not supplied', () => {
  const id = resolveMemberVoiceChannel({
    guild: guild({ voiceStates: { u5: { channelId: 'vc5' } } }),
    member: { id: 'u5' },
  });

  assert.equal(id, 'vc5');
});

/* -------------------------------------------------------------------------- */
/* Diagnostics                                                                 */
/* -------------------------------------------------------------------------- */

test('the diagnostic report explains a failed resolution without leaking anything', () => {
  const report = describeVoiceResolution({
    guild: guild({ id: 'g1', voiceStates: {}, members: {} }),
    userId: 'u1',
    member: rawMember('u1'),
  });

  assert.equal(report.guildId, 'g1');
  assert.equal(report.userId, 'u1');
  assert.equal(report.voiceStatesCacheHit, false);
  assert.equal(report.guildMemberCached, false);
  assert.equal(report.interactionMemberHydrated, false, 'the raw member was reported as hydrated');
  assert.equal(report.resolvedVoiceChannelId, null);
});

test('the diagnostic report distinguishes a hydrated member', () => {
  const report = describeVoiceResolution({ guild: guild(), userId: 'u1', member: hydratedMember('u1', 'vc1') });

  assert.equal(report.interactionMemberHydrated, true);
  assert.equal(report.memberHasChannelId, true);
  assert.equal(report.resolvedVoiceChannelId, 'vc1');
});

test('a successful diagnostic reports the resolved channel id', () => {
  const report = describeVoiceResolution({
    guild: guild({ id: 'g1', voiceStates: { u1: { channelId: 'vc1' } } }),
    userId: 'u1',
    member: rawMember('u1'),
  });

  assert.equal(report.voiceStatesCacheHit, true);
  assert.equal(report.resolvedVoiceChannelId, 'vc1');
});

test('the diagnostic report contains no names, tokens or message content', () => {
  const report = describeVoiceResolution({ guild: guild(), userId: 'u1', member: rawMember('u1') });
  const keys = Object.keys(report).sort();

  assert.deepEqual(keys, [
    'guildId',
    'guildMemberCached',
    'interactionMemberHydrated',
    'memberHasChannelId',
    'resolvedVoiceChannelId',
    'userId',
    'voiceStatesCacheHit',
  ]);
  for (const value of Object.values(report)) {
    assert.ok(['string', 'boolean', 'object'].includes(typeof value), 'a value has an unexpected type');
  }
});

/* -------------------------------------------------------------------------- */
/* The same fix applies to every caller                                        */
/* -------------------------------------------------------------------------- */

test('/gel succeeds for a raw member whose voice state is cached', () => {
  const resolved = resolveMemberVoiceChannel({
    guild: guild({ voiceStates: { u1: { channelId: 'vc1' } } }),
    userId: 'u1',
    member: rawMember('u1'),
  });

  const verdict = evaluateSummon({ memberChannelId: resolved, session: null, requestedChannelName: 'Genel' });

  assert.equal(verdict.action, SUMMON.JOIN, '/gel still claimed the member was not in voice');
});

test('a truly disconnected member is still rejected by /gel', () => {
  const resolved = resolveMemberVoiceChannel({ guild: guild(), userId: 'u1', member: rawMember('u1') });

  const verdict = evaluateSummon({ memberChannelId: resolved, session: null });

  assert.equal(verdict.action, SUMMON.REFUSE);
  assert.equal(verdict.reason, 'not-in-voice');
});

test('control authorization uses the resolved channel, not member.voice', () => {
  const session = { destroyed: false, voiceChannelId: 'vc1' };
  const resolved = resolveMemberVoiceChannel({
    guild: guild({ voiceStates: { u1: { channelId: 'vc1' } } }),
    userId: 'u1',
    member: rawMember('u1'),
  });

  const verdict = authorizeControl({
    action: 'skip',
    member: rawMember('u1'),
    memberChannelId: resolved,
    session,
  });

  assert.equal(verdict.ok, true, 'a raw member was refused the controls');
});

test('selection authorization uses the resolved channel and id', () => {
  const entry = { userId: 'u1', voiceChannelId: 'vc1' };
  const session = { destroyed: false, voiceChannelId: 'vc1' };

  const verdict = authorizeSelection({
    memberId: 'u1',
    memberChannelId: resolveMemberVoiceChannel({
      guild: guild({ voiceStates: { u1: { channelId: 'vc1' } } }),
      userId: 'u1',
      member: rawMember('u1'),
    }),
    entry,
    session,
  });

  assert.equal(verdict.ok, true);
});

test('/git and the controls still refuse a member in another channel', () => {
  const session = { destroyed: false, voiceChannelId: 'vc1' };

  assert.equal(evaluateLeave({ memberChannelId: 'vc2', session }).ok, false);
  assert.equal(evaluateActiveMember({ memberChannelId: 'vc2', session }).ok, false);
  assert.equal(evaluateActiveMember({ memberChannelId: 'vc1', session }).ok, true);
});

/* -------------------------------------------------------------------------- */
/* Plain-text requests                                                         */
/* -------------------------------------------------------------------------- */

class FakeSource extends MusicSource {
  constructor() {
    super({ name: 'fake' });
    this.queries = [];
  }

  async search(query) {
    this.queries.push(query);
    return [normaliseTrack({ id: 'a', source: 'fake', title: query, durationSeconds: 200, artist: 'Artist - Topic' })];
  }

  async createAudioStream() {
    return { stream: { pipe() {} }, inputType: 'arbitrary' };
  }
}

test('a plain-text request resolves the sender voice channel the same way', async () => {
  const source = new FakeSource();
  const sessions = createSessionManager();
  sessions.getOrCreate('g1', () => ({
    destroyed: false,
    voiceChannelId: 'vc1',
    channelName: 'Genel',
    queue: { current: null, items: [] },
    isPlaying: () => false,
    async enqueue() {
      return { ok: true, reason: null, position: 0, started: true };
    },
  }));

  const deps = {
    source,
    sessions,
    selections: createSelectionCache(),
    guard: createRequestGuard({ cooldownSeconds: 0 }),
    logger: createNullLogger(),
  };

  const sent = [];
  const message = {
    id: '900000000000000001',
    content: 'Müslüm Gürses Affet',
    guildId: 'g1',
    // The guild knows about the voice state; the message member does not.
    guild: guild({ id: 'g1', voiceStates: { u1: { channelId: 'vc1' } }, members: {} }),
    member: rawMember('u1'),
    author: { id: 'u1', username: 'user', bot: false },
    channel: {
      name: 'muzik-istek',
      async send(payload) {
        sent.push(payload);
      },
    },
  };

  const result = await handleMusicRequest(message, deps);

  assert.equal(result.action, 'playing', `a raw message member broke the request: ${JSON.stringify(result)}`);
  assert.deepEqual(source.queries, ['Müslüm Gürses Affet']);
});

test('a plain-text request from someone genuinely not in voice is refused', async () => {
  const deps = {
    source: new FakeSource(),
    sessions: createSessionManager(),
    selections: createSelectionCache(),
    guard: createRequestGuard({ cooldownSeconds: 0 }),
    logger: createNullLogger(),
  };
  deps.sessions.getOrCreate('g1', () => ({
    destroyed: false,
    voiceChannelId: 'vc1',
    channelName: 'Genel',
    queue: { current: null, items: [] },
    isPlaying: () => false,
  }));

  const sent = [];
  const message = {
    id: '900000000000000002',
    content: 'Metallica One',
    guildId: 'g1',
    guild: guild({ id: 'g1', voiceStates: {}, members: {} }),
    member: rawMember('u1'),
    author: { id: 'u1', username: 'user', bot: false },
    channel: {
      name: 'muzik-istek',
      async send(payload) {
        sent.push(payload);
      },
    },
  };

  const result = await handleMusicRequest(message, deps);

  assert.equal(result.reason, 'not-in-voice');
  assert.match(sent[0].content, /ses kanalına katıl/);
});

/* -------------------------------------------------------------------------- */
/* Intents                                                                     */
/* -------------------------------------------------------------------------- */

test('resolving voice state needs no privileged intent', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');

  // Comments legitimately name the intent we are avoiding, so only executable
  // code is inspected.
  const strip = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const resolver = strip(await fs.readFile(path.join(process.cwd(), 'src', 'music', 'voice-state.js'), 'utf8'));
  assert.ok(!/GuildMembers/.test(resolver), 'the resolver asks for the privileged members intent');

  const bot = strip(await fs.readFile(path.join(process.cwd(), 'src', 'music', 'bot.js'), 'utf8'));
  assert.match(bot, /GuildVoiceStates/, 'PompMusic no longer requests voice states');
  assert.ok(!/GatewayIntentBits\.GuildMembers\b/.test(bot), 'PompMusic now requires the privileged members intent');
});

test('every voice lookup goes through the shared resolver', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');

  const files = [];
  const walk = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.js') && entry.name !== 'voice-state.js') files.push(full);
    }
  };
  await walk(path.join(process.cwd(), 'src', 'music'));

  const offenders = [];
  for (const file of files) {
    const code = (await fs.readFile(file, 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    // The only module allowed to read a member's voice state directly is the
    // resolver itself.
    if (/\.voice\?\.channelId|\.voice\.channelId/.test(code)) offenders.push(path.basename(file));
  }

  assert.deepEqual(offenders, [], `voice state read outside the resolver in: ${offenders.join(', ')}`);
});
