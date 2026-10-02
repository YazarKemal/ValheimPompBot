import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BATTLE_PREFIX,
  DEFAULT_BATTLE_SECONDS,
  battleComponentId,
  createBattleStore,
  isBattleComponent,
  parseBattleComponentId,
} from '../src/music/battle.js';
import { buildResultPayload, describeTrack, handleBattleInteraction, kapisma } from '../src/music/battle-command.js';
import { normaliseTrack } from '../src/music/source.js';
import {
  createFakeGuild,
  createInteraction,
  createButtonInteraction,
  isEphemeral,
  silentLogger,
  textOf,
} from './helpers/fake-interaction.js';

/**
 * /kapisma.
 *
 * Voting only: no audio, no queue, no model. The tests are about the vote rules
 * (one each, changeable, no bots) and about the boundary - a battle in one
 * guild is unreachable from another.
 */

const AT = 1_700_000_000_000;

/* -------------------------------------------------------------------------- */
/* The store                                                                   */
/* -------------------------------------------------------------------------- */

function makeStore(options = {}) {
  const timers = [];
  const cleared = [];
  const store = createBattleStore({
    seconds: 60,
    now: () => AT,
    idFactory: (() => {
      let counter = 0;
      return () => `savas${++counter}`;
    })(),
    setTimeoutImpl: (fn, ms) => {
      const timer = { fn, ms, unref: () => {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutImpl: (timer) => cleared.push(timer),
    ...options,
  });
  return { store, timers, cleared };
}

const entries = { a: { title: 'Senden Daha Güzel', artist: 'Duman' }, b: { title: 'Bir Kadın Çizeceksin', artist: 'maNga' } };

function openBattle(store, overrides = {}) {
  return store.open({ guildId: 'g1', channelId: 'c1', entries, ...overrides });
}

test('a battle opens with a short, customId-safe id', () => {
  const { store } = makeStore();
  const opened = openBattle(store);

  assert.equal(opened.ok, true);
  assert.ok(opened.battle.id.length <= 32, `the battle id is ${opened.battle.id.length} characters`);
  assert.ok(battleComponentId(opened.battle.id, 'a').length <= 100, 'the customId would exceed Discord\'s limit');
  assert.equal(store.size, 1);
  assert.equal(store.seconds, 60);
  assert.equal(DEFAULT_BATTLE_SECONDS, 60);
});

test('a battle needs a guild and two entries', () => {
  const { store } = makeStore();
  assert.equal(store.open({ guildId: null, entries }).ok, false);
  assert.equal(store.open({ guildId: 'g1', entries: { a: entries.a } }).ok, false);
  assert.equal(store.size, 0);
});

test('every user gets one vote, and may change it', () => {
  const { store } = makeStore();
  const { battle } = openBattle(store);

  const first = store.vote({ guildId: 'g1', battleId: battle.id, userId: 'u1', side: 'a' });
  assert.equal(first.ok, true);
  assert.equal(first.changed, false, 'a first vote is not a change');
  assert.equal(first.tally.a, 1);

  const changed = store.vote({ guildId: 'g1', battleId: battle.id, userId: 'u1', side: 'b' });
  assert.equal(changed.ok, true);
  assert.equal(changed.changed, true, 'changing a vote was not reported');
  assert.equal(changed.voterCount, 1, 'changing a vote added a voter');
  assert.deepEqual(changed.tally, { a: 0, b: 1, total: 1, winner: 'b' });

  // And changing back is also just a change, not a second vote.
  const again = store.vote({ guildId: 'g1', battleId: battle.id, userId: 'u1', side: 'a' });
  assert.equal(again.voterCount, 1);
  assert.equal(again.tally.a, 1);
  assert.equal(again.tally.total, 1);
});

test('a vote from a bot is refused', () => {
  const { store } = makeStore();
  const { battle } = openBattle(store);

  const result = store.vote({ guildId: 'g1', battleId: battle.id, userId: 'bot1', side: 'a', isBot: true });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'bot');
  assert.equal(result.tally.total, 0, 'a bot vote was counted');
});

test('a vote for an unknown side or battle is refused', () => {
  const { store } = makeStore();
  const { battle } = openBattle(store);

  assert.equal(store.vote({ guildId: 'g1', battleId: battle.id, userId: 'u1', side: 'c' }).reason, 'bad-side');
  assert.equal(store.vote({ guildId: 'g1', battleId: 'nope', userId: 'u1', side: 'a' }).reason, 'no-battle');
  assert.equal(store.vote({ guildId: 'g1', battleId: battle.id, userId: null, side: 'a' }).reason, 'no-user');
  assert.equal(store.tally('g1', battle.id).total, 0);
});

test('a battle in one guild is invisible from another', () => {
  const { store } = makeStore();
  const { battle } = openBattle(store);
  store.vote({ guildId: 'g1', battleId: battle.id, userId: 'u1', side: 'a' });

  const foreign = store.vote({ guildId: 'g2', battleId: battle.id, userId: 'u1', side: 'b' });
  assert.equal(foreign.ok, false, 'a vote crossed a guild boundary');
  assert.equal(foreign.reason, 'no-battle');
  assert.equal(store.get('g2', battle.id), null);
  assert.equal(store.tally('g1', battle.id).a, 1, 'the foreign vote reached the battle');
});

test('the tally reports a winner, or a draw when the votes are level', () => {
  const { store } = makeStore();
  const { battle } = openBattle(store);

  store.vote({ guildId: 'g1', battleId: battle.id, userId: 'u1', side: 'a' });
  store.vote({ guildId: 'g1', battleId: battle.id, userId: 'u2', side: 'a' });
  store.vote({ guildId: 'g1', battleId: battle.id, userId: 'u3', side: 'b' });
  assert.deepEqual(store.tally('g1', battle.id), { a: 2, b: 1, total: 3, winner: 'a' });

  store.vote({ guildId: 'g1', battleId: battle.id, userId: 'u4', side: 'b' });
  assert.deepEqual(store.tally('g1', battle.id), { a: 2, b: 2, total: 4, winner: null }, 'a draw invented a winner');
});

test('finishing closes the battle and further votes are refused', () => {
  const { store, cleared } = makeStore();
  const { battle } = openBattle(store);
  store.vote({ guildId: 'g1', battleId: battle.id, userId: 'u1', side: 'a' });

  const result = store.finish('g1', battle.id);
  assert.equal(result.tally.a, 1);
  assert.equal(store.size, 0, 'the battle was left open after finishing');
  assert.equal(cleared.length, 1, 'the timer was not cleared');

  const late = store.vote({ guildId: 'g1', battleId: battle.id, userId: 'u2', side: 'b' });
  assert.equal(late.ok, false, 'a vote landed after the result');
  assert.equal(store.finish('g1', battle.id), null, 'finishing twice reported a result');
});

test('the timer closes the battle and reports the result once', () => {
  const { store, timers } = makeStore();
  const results = [];
  openBattle(store, { onExpire: (result) => results.push(result) });

  assert.equal(timers.length, 1, 'no timer was scheduled');
  assert.equal(timers[0].ms, 60_000, 'the timer does not match the configured length');

  store.vote({ guildId: 'g1', battleId: 'savas1', userId: 'u1', side: 'a' });
  timers[0].fn();

  assert.equal(store.size, 0, 'the battle outlived its timer');
  // onExpire is invoked from a promise chain, so let it drain.
  return Promise.resolve().then(() => {
    assert.equal(results.length, 1, 'the result was not reported exactly once');
    assert.equal(results[0].tally.a, 1);
    assert.equal(results[0].battle.entries.a.title, 'Senden Daha Güzel');
  });
});

test('a battle with no duration schedules no timer', () => {
  const { store, timers } = makeStore({ seconds: 0 });
  openBattle(store);
  assert.equal(timers.length, 0);
  assert.equal(store.size, 1);
});

test('sweep closes only the battles whose time has passed', () => {
  let clock = AT;
  const timers = [];
  const store = createBattleStore({
    seconds: 60,
    now: () => clock,
    idFactory: (() => {
      let counter = 0;
      return () => `savas${++counter}`;
    })(),
    setTimeoutImpl: (fn, ms) => {
      const timer = { fn, ms, unref: () => {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutImpl: () => {},
  });

  openBattle(store);
  clock = AT + 61_000;
  openBattle(store, { channelId: 'c2' });

  assert.equal(store.sweep(), 1);
  assert.equal(store.size, 1);
});

test('destroy cancels every pending timer', () => {
  const { store, cleared } = makeStore();
  openBattle(store);
  openBattle(store, { channelId: 'c2' });

  store.destroy();
  assert.equal(store.size, 0);
  assert.equal(cleared.length, 2, 'a timer outlived the store');
});

test('a component id round-trips and carries only an id and a side', () => {
  assert.equal(battleComponentId('abc12345', 'a'), 'savas:abc12345:a');
  assert.deepEqual(parseBattleComponentId('savas:abc12345:b'), { battleId: 'abc12345', side: 'b' });
  assert.ok(isBattleComponent('savas:abc12345:a'));
  assert.equal(BATTLE_PREFIX, 'savas');
});

test('a malformed component id is rejected', () => {
  for (const customId of ['', 'savas', 'savas:abc', 'savas:abc:c', 'savas::a', 'music:pause', 'savas:a b:a', null]) {
    assert.equal(parseBattleComponentId(customId), null, `${JSON.stringify(customId)} was accepted`);
  }
  assert.equal(isBattleComponent('party:new:abc'), false);
});

/* -------------------------------------------------------------------------- */
/* The command                                                                 */
/* -------------------------------------------------------------------------- */

function track(id, title, artist) {
  return normaliseTrack({ id, source: 'youtube', title, artist, url: `https://www.youtube.com/watch?v=${id}` });
}

/** A music service with a scripted search backend. */
function makeService({ results = null, fail = false, battleSeconds = 60 } = {}) {
  const queries = [];
  const timers = [];
  const store = createBattleStore({
    seconds: battleSeconds,
    now: () => AT,
    idFactory: (() => {
      let counter = 0;
      return () => `savas${++counter}`;
    })(),
    setTimeoutImpl: (fn, ms) => {
      const timer = { fn, ms, unref: () => {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutImpl: () => {},
  });

  return {
    queries,
    timers,
    battles: store,
    settings: { searchLimit: 5, battleSeconds },
    source: {
      async search(query) {
        queries.push(query);
        if (fail) throw new Error('search is down');
        if (results) return results(query);
        return [track('aaaaaaaaaaa', query, 'Sanatçı')];
      },
    },
  };
}

const guild = createFakeGuild({ id: 'g1', name: 'MiningFools' });
const embed = (payload) => payload?.embeds?.[0]?.data ?? payload?.embeds?.[0] ?? null;
const embedText = (payload) => {
  const data = embed(payload);
  return data ? [data.title, data.description].filter(Boolean).join('\n') : '';
};

test('/kapisma searches both songs and posts the voting card', async () => {
  const service = makeService();
  const interaction = createInteraction({
    commandName: 'kapisma',
    guild,
    options: { sarki1: 'Senden Daha Güzel', sarki2: 'Bir Kadın Çizeceksin' },
  });

  await kapisma(interaction, { music: service, logger: silentLogger() });

  assert.deepEqual(service.queries, ['Senden Daha Güzel', 'Bir Kadın Çizeceksin'], 'both songs were not searched');
  assert.equal(interaction.deferred, true);

  const payload = interaction.edits.at(-1);
  const text = embedText(payload);
  assert.match(text, /ŞARKI KAPIŞMASI/);
  assert.match(text, /🅰️ Sanatçı — Senden Daha Güzel/);
  assert.match(text, /🅱️ Sanatçı — Bir Kadın Çizeceksin/);
  assert.match(text, /60 saniye/);

  const buttons = payload.components[0].components.map((button) => button.data);
  assert.deepEqual(buttons.map((button) => button.label), ['A', 'B']);
  assert.ok(buttons.every((button) => /^savas:[A-Za-z0-9_-]+:[ab]$/.test(button.custom_id)));
  assert.equal(service.battles.size, 1);
});

test('/kapisma refuses when a song cannot be found', async () => {
  const service = makeService({ results: (query) => (query === 'yok' ? [] : [track('aaaaaaaaaaa', query, 'X')]) });
  const interaction = createInteraction({
    commandName: 'kapisma',
    guild,
    options: { sarki1: 'var', sarki2: 'yok' },
  });

  await kapisma(interaction, { music: service, logger: silentLogger() });

  assert.equal(isEphemeral(interaction.edits.at(-1)), false);
  assert.match(textOf(interaction.edits.at(-1)), /bulunamadı/);
  assert.equal(service.battles.size, 0, 'a battle opened without two songs');
});

test('/kapisma survives a search backend failure', async () => {
  const service = makeService({ fail: true });
  const interaction = createInteraction({
    commandName: 'kapisma',
    guild,
    options: { sarki1: 'a', sarki2: 'b' },
  });

  await kapisma(interaction, { music: service, logger: silentLogger() });

  assert.match(textOf(interaction.edits.at(-1)), /bulunamadı/);
  assert.equal(service.battles.size, 0);
});

test('/kapisma refuses outside a guild and without a music service', async () => {
  const service = makeService();
  const dm = createInteraction({
    commandName: 'kapisma',
    guildId: null,
    guild: null,
    options: { sarki1: 'a', sarki2: 'b' },
  });
  await kapisma(dm, { music: service, logger: silentLogger() });
  assert.equal(isEphemeral(dm.replies[0]), true);
  assert.equal(service.queries.length, 0, 'a search ran outside a guild');

  const noService = createInteraction({ commandName: 'kapisma', guild, options: { sarki1: 'a', sarki2: 'b' } });
  await kapisma(noService, { logger: silentLogger() });
  assert.equal(isEphemeral(noService.replies[0]), true);
});

test('a battle never queues, plays or streams anything', async () => {
  const service = makeService();
  // The service has no session manager at all: if the command reached for one
  // it would throw, which is the assertion.
  const interaction = createInteraction({
    commandName: 'kapisma',
    guild,
    options: { sarki1: 'a', sarki2: 'b' },
  });

  await kapisma(interaction, { music: service, logger: silentLogger() });
  assert.equal(service.battles.size, 1);
  assert.ok(!('sessions' in service), 'the fixture grew a session manager');
});

test('the winner card names the winning track and both counts', () => {
  const payload = buildResultPayload({
    battle: { entries },
    tally: { a: 3, b: 1, total: 4, winner: 'a' },
  });
  const text = embedText(payload);

  assert.match(text, /KAZANAN/);
  assert.match(text, /Duman — Senden Daha Güzel/);
  assert.match(text, /A: 3/);
  assert.match(text, /B: 1/);
  assert.deepEqual(payload.components, [], 'the result card still has live buttons');
});

test('a draw is announced as one', () => {
  const payload = buildResultPayload({ battle: { entries }, tally: { a: 2, b: 2, total: 4, winner: null } });
  assert.match(embedText(payload), /BERABERE/);
  assert.ok(!embedText(payload).includes('KAZANAN'), 'a draw named a winner');
});

test('a track with no artist is described by its title alone', () => {
  assert.equal(describeTrack({ title: 'Solo' }), 'Solo');
  assert.equal(describeTrack({ title: 'Solo', artist: '' }), 'Solo');
  assert.equal(describeTrack({ title: 'Solo', artist: 'Biri' }), 'Biri — Solo');
  assert.equal(describeTrack(null), 'Bilinmeyen parça');
});

/* -------------------------------------------------------------------------- */
/* The buttons                                                                 */
/* -------------------------------------------------------------------------- */

test('a vote is acknowledged privately and counted', async () => {
  const service = makeService();
  await kapisma(
    createInteraction({ commandName: 'kapisma', guild, options: { sarki1: 'a', sarki2: 'b' } }),
    { music: service, logger: silentLogger() },
  );
  const battle = service.battles.get('g1', 'savas1');

  const click = createButtonInteraction({ customId: battleComponentId(battle.id, 'a'), guild });
  const handled = await handleBattleInteraction(click, { music: service, logger: silentLogger() });

  assert.equal(handled, true);
  assert.equal(isEphemeral(click.replies[0]), true, 'a vote was announced to the channel');
  assert.match(textOf(click.replies[0]), /Oyun kaydedildi: 🅰️/);
  assert.match(textOf(click.replies[0]), /A: 1 · B: 0/);
});

test('changing a vote says so', async () => {
  const service = makeService();
  await kapisma(
    createInteraction({ commandName: 'kapisma', guild, options: { sarki1: 'a', sarki2: 'b' } }),
    { music: service, logger: silentLogger() },
  );
  const battle = service.battles.get('g1', 'savas1');

  await handleBattleInteraction(createButtonInteraction({ customId: battleComponentId(battle.id, 'a'), guild }), {
    music: service,
    logger: silentLogger(),
  });
  const change = createButtonInteraction({ customId: battleComponentId(battle.id, 'b'), guild });
  await handleBattleInteraction(change, { music: service, logger: silentLogger() });

  assert.match(textOf(change.replies[0]), /Oyun değiştirildi: 🅱️/);
  assert.match(textOf(change.replies[0]), /A: 0 · B: 1/);
});

test('a bot click is refused', async () => {
  const service = makeService();
  await kapisma(
    createInteraction({ commandName: 'kapisma', guild, options: { sarki1: 'a', sarki2: 'b' } }),
    { music: service, logger: silentLogger() },
  );
  const battle = service.battles.get('g1', 'savas1');

  const bot = createButtonInteraction({
    customId: battleComponentId(battle.id, 'a'),
    guild,
    user: { id: 'bot1', username: 'bot', bot: true },
  });
  await handleBattleInteraction(bot, { music: service, logger: silentLogger() });

  assert.match(textOf(bot.replies[0]), /Botlar oy kullanamaz/);
  assert.equal(service.battles.tally('g1', battle.id).total, 0, 'a bot vote was counted');
});

test('a click in another guild cannot reach the battle', async () => {
  const service = makeService();
  await kapisma(
    createInteraction({ commandName: 'kapisma', guild, options: { sarki1: 'a', sarki2: 'b' } }),
    { music: service, logger: silentLogger() },
  );
  const battle = service.battles.get('g1', 'savas1');

  const foreign = createButtonInteraction({ customId: battleComponentId(battle.id, 'a'), guildId: 'g2', guild });
  await handleBattleInteraction(foreign, { music: service, logger: silentLogger() });

  assert.match(textOf(foreign.replies[0]), /sona erdi/);
  assert.equal(service.battles.tally('g1', battle.id).total, 0);
});

test('a click after the round ends is refused', async () => {
  const service = makeService();
  await kapisma(
    createInteraction({ commandName: 'kapisma', guild, options: { sarki1: 'a', sarki2: 'b' } }),
    { music: service, logger: silentLogger() },
  );
  service.battles.finish('g1', 'savas1');

  const late = createButtonInteraction({ customId: battleComponentId('savas1', 'a'), guild });
  await handleBattleInteraction(late, { music: service, logger: silentLogger() });

  assert.match(textOf(late.replies[0]), /sona erdi/);
});

test('the battle handler ignores anything that is not a battle button', async () => {
  const service = makeService();
  for (const customId of ['music:pause', 'party:new:abc12345', 'nonsense']) {
    const click = createButtonInteraction({ customId, guild });
    assert.equal(
      await handleBattleInteraction(click, { music: service, logger: silentLogger() }),
      false,
      `${customId} was claimed by the battle handler`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* Wiring                                                                      */
/* -------------------------------------------------------------------------- */

test('PompMusic routes a battle click that arrives on its own gateway', async () => {
  // The voting card is posted by PompMusic, so its buttons are delivered to
  // PompMusic's client. If this bot's handler did not route them, every vote
  // would silently do nothing.
  const { startPompMusic } = await import('../src/music/bot.js');
  const { Events } = await import('discord.js');
  const { EventEmitter } = await import('node:events');

  const client = new EventEmitter();
  client.login = async () => {};
  client.destroy = async () => {};
  client.guilds = { cache: new Map() };
  client.user = { tag: 'PompMusic#0001' };

  const bot = await startPompMusic({
    config: {
      pompMusic: {
        enabled: true,
        token: `pompmusic-${'x'.repeat(60)}`,
        clientId: '222222222222222222',
        textChannel: 'muzik-istek',
        stayConnected: true,
        streamBackend: 'none',
        battleSeconds: 60,
      },
    },
    logger: silentLogger(),
    clientFactory: () => client,
  });

  const opened = bot.service.battles.open({ guildId: 'g1', channelId: 'c1', entries });
  const click = createButtonInteraction({ customId: battleComponentId(opened.battle.id, 'a'), guild });

  client.emit(Events.InteractionCreate, click);
  // The handler is asynchronous and deliberately not awaited by the emitter.
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(bot.service.battles.tally('g1', opened.battle.id).a, 1, 'the vote never reached the battle');
  assert.match(textOf(click.replies[0]), /Oyun kaydedildi/);
});

/* -------------------------------------------------------------------------- */
/* Zero AI                                                                     */
/* -------------------------------------------------------------------------- */

test('a battle makes no network call at all', async () => {
  const originalFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = () => {
    fetched += 1;
    throw new Error('the battle tried to reach the network');
  };

  const service = makeService();
  try {
    await kapisma(
      createInteraction({ commandName: 'kapisma', guild, options: { sarki1: 'a', sarki2: 'b' } }),
      { music: service, logger: silentLogger() },
    );
    await handleBattleInteraction(createButtonInteraction({ customId: battleComponentId('savas1', 'a'), guild }), {
      music: service,
      logger: silentLogger(),
    });
    service.battles.finish('g1', 'savas1');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(fetched, 0, `${fetched} network call(s) were attempted`);
});
