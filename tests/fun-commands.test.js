import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { createFunService, openFunDatabase } from '../src/fun/index.js';
import { envanter, fal, gunluk, kaz, lakap, liderlik, parti, profil } from '../src/fun/commands.js';
import { handleFunInteraction } from '../src/fun/interactions.js';
import { PARTY_TYPES } from '../src/fun/content/party-banks.js';
import {
  createFakeGuild,
  createFakeMember,
  createInteraction,
  createButtonInteraction,
  isEphemeral,
  seededRandom,
  silentLogger,
  textOf,
} from './helpers/fake-interaction.js';

/**
 * The command layer.
 *
 * A command is driven through the same entry point Discord uses, against a real
 * service and a real database, and the assertions are about what was SENT:
 * whether the answer was public, what it said, and - for the refusals - whether
 * the channel saw it at all.
 */

const AT = 1_700_000_000_000;

function setup({ seed = 7, members = [] } = {}) {
  const db = openFunDatabase({ file: ':memory:' });
  const service = createFunService({
    database: db,
    config: { fun: { mineCooldownSeconds: 300, dailyCooldownHours: 20, partyTimeoutMinutes: 30 } },
    now: () => AT,
    random: seededRandom(seed),
  });
  const guild = createFakeGuild({ id: 'g1', name: 'MiningFools', members });
  const ctx = { fun: service, logger: silentLogger(), random: seededRandom(seed) };
  return { db, service, guild, ctx };
}

const embed = (payload) => payload?.embeds?.[0]?.data ?? payload?.embeds?.[0] ?? null;
const embedText = (payload) => {
  const data = embed(payload);
  if (!data) return '';
  return [data.title, data.description, ...(data.fields ?? []).map((field) => `${field.name}: ${field.value}`)]
    .filter(Boolean)
    .join('\n');
};

/* -------------------------------------------------------------------------- */
/* /kaz                                                                        */
/* -------------------------------------------------------------------------- */

test('/kaz answers publicly with one result', async () => {
  const { db, ctx, guild } = setup();
  const interaction = createInteraction({ commandName: 'kaz', guild });

  await kaz(interaction, ctx);

  assert.equal(interaction.replies.length, 1);
  assert.equal(isEphemeral(interaction.replies[0]), false, 'a dig should be public');
  assert.match(embedText(interaction.replies[0]), /KAZI SONUCU/);
  assert.match(embedText(interaction.replies[0]), /Seviye: \d+ — /);

  const user = ctx.fun.repo.getUser('g1', 'u1');
  assert.equal(user.mines, 1, 'the dig was not recorded exactly once');
  db.close();
});

test('/kaz refuses a second dig privately and does not touch the account', async () => {
  const { db, ctx, guild } = setup();
  await kaz(createInteraction({ commandName: 'kaz', guild }), ctx);

  const before = { ...ctx.fun.repo.getUser('g1', 'u1') };
  const second = createInteraction({ commandName: 'kaz', guild });
  await kaz(second, ctx);

  assert.equal(second.replies.length, 1);
  assert.equal(isEphemeral(second.replies[0]), true, 'a cooldown should not be announced to the channel');
  assert.match(textOf(second.replies[0]), /Kazman hazır değil/);
  assert.match(textOf(second.replies[0]), /4 dk|5 dk/);
  assert.deepEqual({ ...ctx.fun.repo.getUser('g1', 'u1') }, before, 'the refused dig changed the account');
  db.close();
});

test('/kaz announces a level-up in the same answer', async () => {
  const { db, ctx, guild } = setup();
  ctx.fun.repo.ensureUser('g1', 'u1', AT);
  ctx.fun.repo.applyReward('g1', 'u1', { xp: 55, at: AT });

  const interaction = createInteraction({ commandName: 'kaz', guild });
  await kaz(interaction, ctx);

  const text = embedText(interaction.replies[0]);
  assert.match(text, /Seviye atladın/, 'a level-up was not announced');
  assert.match(text, /Seviye 2 — /);
  db.close();
});

/* -------------------------------------------------------------------------- */
/* /gunluk                                                                     */
/* -------------------------------------------------------------------------- */

test('/gunluk answers publicly and shows the streak', async () => {
  const { db, ctx, guild } = setup();
  const interaction = createInteraction({ commandName: 'gunluk', guild });

  await gunluk(interaction, ctx);

  const text = embedText(interaction.replies[0]);
  assert.equal(isEphemeral(interaction.replies[0]), false);
  assert.match(text, /GÜNLÜK KASA/);
  assert.match(text, /Seri: 1 gün/);
  assert.equal(ctx.fun.repo.getUser('g1', 'u1').dailyStreak, 1);
  db.close();
});

test('/gunluk refuses a second claim privately', async () => {
  const { db, ctx, guild } = setup();
  await gunluk(createInteraction({ commandName: 'gunluk', guild }), ctx);

  const second = createInteraction({ commandName: 'gunluk', guild });
  await gunluk(second, ctx);

  assert.equal(isEphemeral(second.replies[0]), true);
  assert.match(textOf(second.replies[0]), /Kasayı bugün zaten açtın/);
  assert.equal(ctx.fun.repo.getUser('g1', 'u1').dailyStreak, 1, 'the refused claim advanced the streak');
  db.close();
});

/* -------------------------------------------------------------------------- */
/* /envanter, /profil, /liderlik                                               */
/* -------------------------------------------------------------------------- */

test('/envanter is empty before the first dig and filled after it', async () => {
  const { db, ctx, guild } = setup();

  const empty = createInteraction({ commandName: 'envanter', guild });
  await envanter(empty, ctx);
  assert.match(embedText(empty.replies[0]), /Envanterin boş/);

  await kaz(createInteraction({ commandName: 'kaz', guild }), ctx);

  const filled = createInteraction({ commandName: 'envanter', guild });
  await envanter(filled, ctx);
  assert.equal(isEphemeral(filled.replies[0]), false);
  assert.match(embedText(filled.replies[0]), /ENVANTER — KEMAL/);
  db.close();
});

test('/profil renders every line the brief lists', async () => {
  const { db, ctx, guild } = setup();
  ctx.fun.repo.ensureUser('g1', 'u1', AT);
  ctx.fun.repo.applyReward('g1', 'u1', { xp: 2430, coins: 4820, at: AT });
  ctx.fun.repo.recordMine('g1', 'u1', { at: AT, rare: true });
  ctx.fun.repo.recordDaily('g1', 'u1', { at: AT, streak: 6 });

  const interaction = createInteraction({ commandName: 'profil', guild });
  await profil(interaction, ctx);

  const text = embedText(interaction.replies[0]);
  assert.match(text, /KEMAL MADENCİ PROFİLİ/, 'the profile title is wrong');
  assert.match(text, /Seviye: 12/);
  assert.match(text, /Unvan: Usta Kazmacı/);
  assert.match(text, /XP: 2,430/);
  assert.match(text, /Altın: 4,820/);
  assert.match(text, /Kazı: 1/);
  assert.match(text, /Nadir buluntu: 1/);
  assert.match(text, /Günlük seri: 6 gün/);
  db.close();
});

test('/profil can look up another member without touching your own account', async () => {
  const { db, ctx, guild } = setup();
  ctx.fun.repo.ensureUser('g1', 'other', AT);
  ctx.fun.repo.applyReward('g1', 'other', { xp: 500, at: AT });

  const interaction = createInteraction({
    commandName: 'profil',
    guild,
    options: { kullanici: { id: 'other', username: 'deniz' } },
  });
  await profil(interaction, ctx);

  // Turkish uppercase: "deniz" becomes "DENİZ" with a dotted İ, which is what a
  // Turkish reader expects in a title.
  assert.match(embedText(interaction.replies[0]), /DENİZ MADENCİ PROFİLİ/);
  assert.equal(ctx.fun.repo.getUser('g1', 'u1'), null, 'looking someone up created your account');
  db.close();
});

test('/profil renders a member who has never played', async () => {
  const { db, ctx, guild } = setup();
  const interaction = createInteraction({ commandName: 'profil', guild });

  await profil(interaction, ctx);

  const text = embedText(interaction.replies[0]);
  assert.match(text, /Seviye: 1/);
  assert.match(text, /Çaylak Madenci/);
  assert.equal(isEphemeral(interaction.replies[0]), false);
  db.close();
});

test('/liderlik lists the guild board with real names', async () => {
  const { db, ctx } = setup({
    members: [
      createFakeMember({ id: 'u2', displayName: 'Deniz' }),
      createFakeMember({ id: 'u3', displayName: 'Ada' }),
    ],
  });
  for (const [userId, xp] of [['u1', 300], ['u2', 900], ['u3', 100]]) {
    ctx.fun.repo.ensureUser('g1', userId, AT);
    ctx.fun.repo.applyReward('g1', userId, { xp, at: AT });
  }

  const guild = createFakeGuild({
    id: 'g1',
    name: 'MiningFools',
    members: [
      createFakeMember({ id: 'u2', displayName: 'Deniz' }),
      createFakeMember({ id: 'u3', displayName: 'Ada' }),
    ],
  });
  const interaction = createInteraction({ commandName: 'liderlik', guild });
  await liderlik(interaction, ctx);

  const text = embedText(interaction.replies[0]);
  assert.match(text, /LİDERLİK — MiningFools/);
  assert.match(text, /🥇 Deniz — Seviye \d+ — 900 XP/);
  assert.match(text, /🥈 u1 — /, 'a cached name should be used, and a missing one fall back to the id');
  assert.match(text, /🥉 Ada — /);
  db.close();
});

test('/liderlik never shows another guild', async () => {
  const { db, ctx, guild } = setup();
  ctx.fun.repo.ensureUser('g2', 'stranger', AT);
  ctx.fun.repo.applyReward('g2', 'stranger', { xp: 999999, at: AT });
  ctx.fun.repo.ensureUser('g1', 'u1', AT);
  ctx.fun.repo.applyReward('g1', 'u1', { xp: 10, at: AT });

  const interaction = createInteraction({ commandName: 'liderlik', guild });
  await liderlik(interaction, ctx);

  const text = embedText(interaction.replies[0]);
  assert.ok(!text.includes('stranger'), 'another guild\'s member appeared on the board');
  assert.match(text, /999999|10 XP/);
  db.close();
});

/* -------------------------------------------------------------------------- */
/* /parti                                                                      */
/* -------------------------------------------------------------------------- */

test('/parti posts a question with its two controls', async () => {
  const { db, ctx, guild } = setup();
  const interaction = createInteraction({ commandName: 'parti', guild, options: { tur: 'dogruluk' } });

  await parti(interaction, ctx);

  const payload = interaction.replies[0];
  assert.equal(isEphemeral(payload), false, 'a party round should be public');
  assert.match(embedText(payload), /DOĞRULUK/);
  assert.equal(payload.components.length, 1);
  const buttons = payload.components[0].components.map((button) => button.data);
  assert.deepEqual(buttons.map((button) => button.label), ['Yeni Soru', 'Bitir']);
  assert.ok(buttons.every((button) => /^party:(new|end):[A-Za-z0-9_-]+$/.test(button.custom_id)));
  assert.equal(ctx.fun.party.size, 1);
  db.close();
});

test('/parti refuses an unknown type privately', async () => {
  const { db, ctx, guild } = setup();
  const interaction = createInteraction({ commandName: 'parti', guild, options: { tur: 'nope' } });

  await parti(interaction, ctx);

  assert.equal(isEphemeral(interaction.replies[0]), true);
  assert.equal(ctx.fun.party.size, 0);
  db.close();
});

test('every party type can actually be started', async () => {
  const { db, ctx, guild } = setup();
  for (const type of PARTY_TYPES) {
    const interaction = createInteraction({ commandName: 'parti', guild, options: { tur: type } });
    await parti(interaction, ctx);
    assert.equal(isEphemeral(interaction.replies[0]), false, `${type} was refused`);
    assert.match(embedText(interaction.replies[0]), /[A-ZÇĞİÖŞÜ]/);
  }
  db.close();
});

test('the new-question button swaps the question in place', async () => {
  const { db, ctx, guild } = setup();
  await parti(createInteraction({ commandName: 'parti', guild, options: { tur: 'cesaret' } }), ctx);
  const session = ctx.fun.party.get('g1', 'c1');

  const click = createButtonInteraction({ customId: `party:new:${session.id}`, guild });
  const handled = await handleFunInteraction(click, ctx);

  assert.equal(handled, true);
  assert.equal(click.updates.length, 1, 'the message was not updated in place');
  assert.equal(click.replies.length, 0, 'a new question should not post a new message');
  assert.equal(ctx.fun.party.get('g1', 'c1').asked, 2);
  db.close();
});

test('the end button retires the controls', async () => {
  const { db, ctx, guild } = setup();
  await parti(createInteraction({ commandName: 'parti', guild, options: { tur: 'dogruluk' } }), ctx);
  const session = ctx.fun.party.get('g1', 'c1');

  const click = createButtonInteraction({ customId: `party:end:${session.id}`, guild });
  await handleFunInteraction(click, ctx);

  assert.equal(click.updates.length, 1);
  assert.deepEqual(click.updates[0].components, [], 'the buttons are still on the message');
  assert.equal(ctx.fun.party.size, 0, 'the round is still running');
  db.close();
});

test('a button from a dead round is refused privately and changes nothing', async () => {
  const { db, ctx, guild } = setup();
  await parti(createInteraction({ commandName: 'parti', guild, options: { tur: 'dogruluk' } }), ctx);

  const click = createButtonInteraction({ customId: 'party:new:staleid1', guild });
  await handleFunInteraction(click, ctx);

  assert.equal(click.updates.length, 0, 'a stale button rewrote the message');
  assert.equal(isEphemeral(click.replies[0]), true);
  assert.equal(ctx.fun.party.get('g1', 'c1').asked, 1, 'a stale button advanced the round');
  db.close();
});

test('a party round in one guild is invisible to another', async () => {
  const { db, ctx, guild } = setup();
  await parti(createInteraction({ commandName: 'parti', guild, options: { tur: 'dogruluk' } }), ctx);
  const session = ctx.fun.party.get('g1', 'c1');

  // The same channel id, a different guild.
  const elsewhere = createButtonInteraction({ customId: `party:new:${session.id}`, guildId: 'g2', guild });
  await handleFunInteraction(elsewhere, ctx);

  assert.equal(elsewhere.updates.length, 0, 'a click in another guild advanced this round');
  assert.equal(ctx.fun.party.get('g1', 'c1').asked, 1);
  db.close();
});

test('the fun handler ignores anything that is not a party button', async () => {
  const { db, ctx, guild } = setup();
  for (const customId of ['music:pause', 'savas:abc:a', 'nonsense']) {
    const click = createButtonInteraction({ customId, guild });
    assert.equal(await handleFunInteraction(click, ctx), false, `${customId} was claimed by the fun layer`);
  }
  db.close();
});

/* -------------------------------------------------------------------------- */
/* /lakap and /fal                                                             */
/* -------------------------------------------------------------------------- */

test('/lakap answers publicly from the local bank, with no AI involved', async () => {
  const { db, ctx, guild } = setup();
  const interaction = createInteraction({ commandName: 'lakap', guild });

  await lakap(interaction, ctx);

  assert.equal(isEphemeral(interaction.replies[0]), false);
  assert.match(textOf(interaction.replies[0]), /artık \*\*.+\*\* olarak biliniyor/);
  db.close();
});

test('/lakap can nickname someone else', async () => {
  const { db, ctx, guild } = setup();
  const interaction = createInteraction({
    commandName: 'lakap',
    guild,
    options: { kullanici: { id: 'u2', username: 'deniz' } },
  });

  await lakap(interaction, ctx);
  assert.match(textOf(interaction.replies[0]), /deniz/i);
  db.close();
});

test('/fal answers publicly from the local bank', async () => {
  const { db, ctx, guild } = setup();
  const interaction = createInteraction({ commandName: 'fal', guild });

  await fal(interaction, ctx);

  assert.equal(isEphemeral(interaction.replies[0]), false);
  assert.match(embedText(interaction.replies[0]), /PompAI Falı/);
  db.close();
});

/* -------------------------------------------------------------------------- */
/* Refusals that apply to everything                                           */
/* -------------------------------------------------------------------------- */

test('every command that touches an account refuses outside a guild, privately', async () => {
  const { db, ctx } = setup();
  const stateful = { kaz, gunluk, envanter, profil, liderlik, parti };

  for (const [name, execute] of Object.entries(stateful)) {
    const interaction = createInteraction({ commandName: name, guildId: null, guild: null });
    await execute(interaction, ctx);
    assert.equal(interaction.replies.length, 1, `${name} did not answer`);
    assert.equal(isEphemeral(interaction.replies[0]), true, `${name} answered publicly outside a guild`);
  }
  assert.equal(ctx.fun.repo.getUser('g1', 'u1'), null, 'a DM-shaped command wrote an account');
  assert.equal(ctx.fun.party.size, 0, 'a DM-shaped command started a party round');
  db.close();
});

test('/lakap and /fal need no guild because they touch no state', async () => {
  // They draw from a local bank and write nothing. Both are guild-scoped at
  // registration, so this is about the handler not inventing a dependency it
  // does not have.
  const { db, ctx } = setup();
  for (const [name, execute] of Object.entries({ lakap, fal })) {
    const interaction = createInteraction({ commandName: name, guildId: null, guild: null });
    await execute(interaction, ctx);
    assert.equal(interaction.replies.length, 1, `${name} did not answer`);
    assert.equal(isEphemeral(interaction.replies[0]), false, `${name} should not need a guild`);
  }
  db.close();
});

test('a server without the fun service says so instead of throwing', async () => {
  const interaction = createInteraction({ commandName: 'kaz' });
  await kaz(interaction, { logger: silentLogger() });

  assert.equal(isEphemeral(interaction.replies[0]), true);
  assert.match(textOf(interaction.replies[0]), /Eğlence sistemi bu etkin değil/);
});

/* -------------------------------------------------------------------------- */
/* Zero AI                                                                     */
/* -------------------------------------------------------------------------- */

test('no fun command makes a network call', async () => {
  const originalFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = () => {
    fetched += 1;
    throw new Error('a fun command tried to reach the network');
  };

  const { db, ctx, guild } = setup();
  try {
    await kaz(createInteraction({ commandName: 'kaz', guild }), ctx);
    await gunluk(createInteraction({ commandName: 'gunluk', guild }), ctx);
    await envanter(createInteraction({ commandName: 'envanter', guild }), ctx);
    await profil(createInteraction({ commandName: 'profil', guild }), ctx);
    await liderlik(createInteraction({ commandName: 'liderlik', guild }), ctx);
    await parti(createInteraction({ commandName: 'parti', guild, options: { tur: 'cesaret' } }), ctx);
    await lakap(createInteraction({ commandName: 'lakap', guild }), ctx);
    await fal(createInteraction({ commandName: 'fal', guild }), ctx);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(fetched, 0, `${fetched} network call(s) were attempted`);
  db.close();
});

test('the fun service exposes no AI client and no shared state', () => {
  const { db, service } = setup();
  const keys = Object.keys(service);

  for (const forbidden of ['ai', 'provider', 'model', 'complete', 'memory', 'giveaways', 'conversations']) {
    assert.ok(!keys.includes(forbidden), `the fun service exposes "${forbidden}"`);
  }
  // Nothing on the surface is a function that could reach a model.
  assert.deepEqual(
    keys.filter((key) => /^(ask|complete|generate|prompt)$/i.test(key)),
    [],
  );
  db.close();
});

test('the public payloads carry no ephemeral flag', async () => {
  const { db, ctx, guild } = setup();
  const interaction = createInteraction({ commandName: 'kaz', guild });
  await kaz(interaction, ctx);

  assert.equal(interaction.replies[0].flags, undefined, 'a public answer was flagged');
  assert.ok(!(interaction.replies[0].flags & MessageFlags.Ephemeral));
  db.close();
});
