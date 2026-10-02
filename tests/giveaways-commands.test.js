import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { execute as ucretsiz, EMPTY_MESSAGE } from '../src/commands/ucretsiz.js';
import { buildGiveawayEmbed, EMBED_TITLE } from '../src/giveaways/embed.js';
import { formatDateTime, formatPrice, formatRemaining, DISPLAY_TIME_ZONE } from '../src/giveaways/format.js';
import { normaliseGiveaway, GIVEAWAY_KINDS } from '../src/giveaways/provider.js';

const NOW = new Date('2026-10-03T12:00:00.000Z').getTime();

const sampleGiveaway = normaliseGiveaway({
  provider: 'epic',
  id: 'abc',
  title: 'Mystery Game',
  platform: 'Epic Games',
  kind: GIVEAWAY_KINDS.EPIC_GIVEAWAY,
  url: 'https://store.epicgames.com/en-US/p/mystery',
  imageUrl: 'https://cdn.example/wide.jpg',
  originalPrice: { amount: 199.99, currency: 'TRY', formatted: '199,00 TL' },
  currentPrice: { amount: 0, currency: 'TRY', formatted: '0' },
  startsAt: '2026-10-01T15:00:00.000Z',
  endsAt: '2026-10-08T15:00:00.000Z',
});

function makeInteraction() {
  const calls = { reply: [], deferReply: [], editReply: [], followUp: [] };
  const interaction = {
    deferred: false,
    replied: false,
    options: { getString: () => 'x' },
    async reply(payload) {
      calls.reply.push(payload);
      interaction.replied = true;
    },
    async deferReply(payload) {
      calls.deferReply.push(payload);
      interaction.deferred = true;
    },
    async editReply(payload) {
      calls.editReply.push(payload);
    },
    async followUp(payload) {
      calls.followUp.push(payload);
    },
    calls,
  };
  return interaction;
}

const isEphemeral = (payload) => Boolean(payload?.flags & MessageFlags.Ephemeral);

/** A monitor stub; no provider, no network. */
function monitor({ giveaways = [], failures = [], providers = ['epic', 'steam'] } = {}) {
  return {
    async fetchActive() {
      return { giveaways, failures };
    },
    status: () => ({ providers }),
  };
}

/* -------------------------------------------------------------------------- */
/* /ucretsiz                                                                   */
/* -------------------------------------------------------------------------- */

test('/ucretsiz lists active giveaways immediately', async () => {
  const interaction = makeInteraction();
  await ucretsiz(interaction, { giveaways: monitor({ giveaways: [sampleGiveaway] }) });

  const payload = interaction.calls.editReply.at(-1);
  assert.equal(isEphemeral(interaction.calls.deferReply[0]), true);
  assert.match(payload.content, /Şu anda ücretsiz: 1 oyun/);
  assert.equal(payload.embeds.length, 1);
});

test('/ucretsiz uses the exact wording when nothing is running', async () => {
  const interaction = makeInteraction();
  await ucretsiz(interaction, { giveaways: monitor({ giveaways: [] }) });

  assert.equal(interaction.calls.editReply.at(-1), EMPTY_MESSAGE);
  assert.equal(EMPTY_MESSAGE, 'Şu anda tespit edilen aktif Steam/Epic hediyesi yok.');
});

test('/ucretsiz reports an outage distinctly from an empty list', async () => {
  const interaction = makeInteraction();
  await ucretsiz(interaction, {
    giveaways: monitor({ giveaways: [], failures: [{ provider: 'epic', reason: 'down' }, { provider: 'steam', reason: 'down' }] }),
  });

  const content = interaction.calls.editReply.at(-1);
  assert.notEqual(content, EMPTY_MESSAGE, 'an outage was reported as "nothing is free"');
  assert.match(content, /ulaşılamıyor/);
});

test('a partial outage still lists what was found', async () => {
  const interaction = makeInteraction();
  await ucretsiz(interaction, {
    giveaways: monitor({ giveaways: [sampleGiveaway], failures: [{ provider: 'steam', reason: 'down' }] }),
  });

  const payload = interaction.calls.editReply.at(-1);
  assert.equal(payload.embeds.length, 1);
  assert.match(payload.content, /Bazı kaynaklara ulaşılamadı: steam/);
});

test('/ucretsiz caps the number of embeds', async () => {
  const many = Array.from({ length: 9 }, (_, index) =>
    normaliseGiveaway({ ...sampleGiveaway, id: `g${index}`, key: undefined }),
  );
  const interaction = makeInteraction();
  await ucretsiz(interaction, { giveaways: monitor({ giveaways: many }) });

  const payload = interaction.calls.editReply.at(-1);
  assert.equal(payload.embeds.length, 5);
  assert.match(payload.content, /ilk 5 tanesi/);
});

test('/ucretsiz survives a provider explosion', async () => {
  const interaction = makeInteraction();
  const exploding = {
    async fetchActive() {
      throw new Error('boom');
    },
    status: () => ({ providers: ['epic'] }),
  };

  await ucretsiz(interaction, { giveaways: exploding, logger: { warn() {} } });

  assert.match(interaction.calls.editReply.at(-1), /ulaşılamıyor/);
});

test('/ucretsiz degrades when monitoring is not configured', async () => {
  const interaction = makeInteraction();
  await ucretsiz(interaction, {});

  assert.match(interaction.calls.editReply.at(-1), /etkin değil/);
});

/* -------------------------------------------------------------------------- */
/* Embed                                                                       */
/* -------------------------------------------------------------------------- */

test('the announcement embed has the required shape', () => {
  const embed = buildGiveawayEmbed(sampleGiveaway, { now: NOW }).toJSON();

  assert.equal(embed.title, EMBED_TITLE);
  assert.equal(embed.title, '🎁 ÜCRETSİZ OYUN');
  assert.match(embed.description, /Mystery Game/);
  assert.equal(embed.url, sampleGiveaway.url);
  assert.equal(embed.image.url, 'https://cdn.example/wide.jpg');

  const names = embed.fields.map((field) => field.name);
  assert.ok(names.includes('Platform'));
  assert.ok(names.includes('Normal fiyat'));
  assert.ok(names.includes('Tür'));
  assert.ok(names.includes('Ücretsiz bitiş'));
  assert.ok(names.includes('Mağaza'));
});

test('the embed names the platform and the giveaway type', () => {
  const embed = buildGiveawayEmbed(sampleGiveaway, { now: NOW }).toJSON();
  const byName = Object.fromEntries(embed.fields.map((field) => [field.name, field.value]));

  assert.equal(byName.Platform, 'Epic Games');
  assert.equal(byName.Tür, 'Epic Giveaway');
  assert.equal(byName['Normal fiyat'], '199,00 TL');
  assert.match(byName.Mağaza, /\[Şimdi Al\]\(https:\/\/store\.epicgames\.com/);
});

test('a Free to Keep giveaway is labelled correctly', () => {
  const steam = normaliseGiveaway({
    provider: 'steam',
    id: '1',
    title: 'Keep Me',
    platform: 'Steam',
    kind: GIVEAWAY_KINDS.FREE_TO_KEEP,
  });
  const embed = buildGiveawayEmbed(steam, { now: NOW }).toJSON();
  const byName = Object.fromEntries(embed.fields.map((field) => [field.name, field.value]));

  assert.equal(byName.Tür, 'Free to Keep');
  assert.equal(embed.image, undefined, 'an absent image should not be set');
  assert.equal(embed.url, undefined);
});

test('an unknown price is omitted rather than shown as zero', () => {
  const noPrice = normaliseGiveaway({
    provider: 'epic',
    id: '2',
    title: 'No Price',
    platform: 'Epic Games',
    kind: GIVEAWAY_KINDS.EPIC_GIVEAWAY,
  });
  const embed = buildGiveawayEmbed(noPrice, { now: NOW }).toJSON();

  assert.ok(!embed.fields.some((field) => field.name === 'Normal fiyat'));
});

test('the embed never carries a mention', () => {
  const embed = buildGiveawayEmbed(sampleGiveaway, { now: NOW }).toJSON();
  const serialised = JSON.stringify(embed);

  assert.ok(!/@everyone|@here|<@&/.test(serialised), 'the embed contains a mention');
});

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

test('dates render in Europe/Istanbul, not the host time zone', () => {
  assert.equal(DISPLAY_TIME_ZONE, 'Europe/Istanbul');

  // 14:00 UTC is 17:00 in Istanbul (UTC+3, no DST since 2016).
  const formatted = formatDateTime('2026-10-05T14:00:00.000Z');

  assert.match(formatted, /17:00/, `expected Istanbul time, got ${formatted}`);
  assert.match(formatted, /TSİ/);
  assert.match(formatted, /2026/);
});

test('formatDateTime tolerates junk', () => {
  for (const value of [null, undefined, '', 'not-a-date']) {
    assert.equal(formatDateTime(value), null);
  }
});

test('prices prefer the store string, then Intl, then plain', () => {
  assert.equal(formatPrice({ amount: 10, currency: 'TRY', formatted: '10,00 TL' }), '10,00 TL');
  assert.match(formatPrice({ amount: 199.99, currency: 'TRY', formatted: null }), /199,99/);
  assert.equal(formatPrice({ amount: 5, currency: null, formatted: null }), '5');
  assert.equal(formatPrice({ amount: null, currency: 'TRY', formatted: null }), null);
  assert.equal(formatPrice(null), null);
});

test('formatPrice survives an unknown currency code', () => {
  assert.doesNotThrow(() => formatPrice({ amount: 5, currency: 'NOT_A_CURRENCY', formatted: null }));
});

test('remaining time is phrased in Turkish', () => {
  const endsAt = new Date(NOW + 3 * 3_600_000).toISOString();
  assert.equal(formatRemaining(endsAt, NOW), '3 saat kaldı');

  const days = new Date(NOW + 3 * 24 * 3_600_000).toISOString();
  assert.equal(formatRemaining(days, NOW), '3 gün kaldı');

  const minutes = new Date(NOW + 30 * 60_000).toISOString();
  assert.equal(formatRemaining(minutes, NOW), '30 dakika kaldı');

  assert.equal(formatRemaining(null, NOW), null);
  assert.equal(formatRemaining(new Date(NOW - 1000).toISOString(), NOW), null);
});
