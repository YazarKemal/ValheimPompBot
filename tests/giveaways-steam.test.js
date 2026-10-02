import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySteamOffer,
  extractFeaturedOffers,
  parseSteamGiveaways,
  STEAM_OFFER_KINDS,
} from '../src/giveaways/providers/steam.js';
import { GIVEAWAY_KINDS } from '../src/giveaways/provider.js';

const NOW = new Date('2026-10-03T12:00:00.000Z').getTime();

/** A genuine Free to Keep promotion: 100% off, and Steam says so. */
const freeToKeep = {
  id: 1245620,
  name: 'Some Game',
  discount_percent: 100,
  original_price: 59900,
  final_price: 0,
  currency: 'TRY',
  header_image: 'https://cdn.example/header.jpg',
  promotion_kind: STEAM_OFFER_KINDS.FREE_TO_KEEP,
  promotion_start: '2026-10-01T00:00:00.000Z',
  promotion_end: '2026-10-05T00:00:00.000Z',
};

/** A Free Weekend: also 100% off, but ownership is not granted. */
const freeWeekend = {
  id: 730,
  name: 'Weekend Game',
  discount_percent: 100,
  final_price: 0,
  promotion_kind: STEAM_OFFER_KINDS.FREE_WEEKEND,
};

/** Permanently free to play. */
const permanentlyFree = { id: 570, name: 'Always Free', is_free: true, discount_percent: 0, final_price: 0 };

/** An ordinary discount. */
const discounted = { id: 400, name: 'On Sale', discount_percent: 75, original_price: 10000, final_price: 2500 };

/* -------------------------------------------------------------------------- */
/* Classification                                                              */
/* -------------------------------------------------------------------------- */

test('Free to Keep is classified as a giveaway', () => {
  assert.equal(classifySteamOffer(freeToKeep), STEAM_OFFER_KINDS.FREE_TO_KEEP);
});

test('Free Weekend is never classified as Free to Keep', () => {
  assert.equal(classifySteamOffer(freeWeekend), STEAM_OFFER_KINDS.FREE_WEEKEND);
  assert.notEqual(classifySteamOffer(freeWeekend), STEAM_OFFER_KINDS.FREE_TO_KEEP);
});

test('a permanently free game is classified as permanent, not a giveaway', () => {
  assert.equal(classifySteamOffer(permanentlyFree), STEAM_OFFER_KINDS.PERMANENTLY_FREE);
});

test('permanence wins even when a free-weekend flag is also present', () => {
  const both = { ...permanentlyFree, promotion_kind: STEAM_OFFER_KINDS.FREE_WEEKEND };

  assert.equal(classifySteamOffer(both), STEAM_OFFER_KINDS.PERMANENTLY_FREE);
});

test('an ordinary discount is classified as a discount', () => {
  assert.equal(classifySteamOffer(discounted), STEAM_OFFER_KINDS.DISCOUNT);
});

test('100% off with no statement of kind is unknown, and therefore never announced', () => {
  const ambiguous = { id: 1, name: 'Ambiguous', discount_percent: 100, final_price: 0 };

  assert.equal(classifySteamOffer(ambiguous), STEAM_OFFER_KINDS.UNKNOWN);
  assert.deepEqual(parseSteamGiveaways({ offers: [ambiguous] }, { now: NOW }), []);
});

test('the explicit free_to_keep boolean is honoured', () => {
  assert.equal(classifySteamOffer({ discount_percent: 100, free_to_keep: true }), STEAM_OFFER_KINDS.FREE_TO_KEEP);
});

test('the explicit free_weekend boolean is honoured', () => {
  assert.equal(classifySteamOffer({ discount_percent: 100, free_weekend: true }), STEAM_OFFER_KINDS.FREE_WEEKEND);
});

test('junk input classifies as unknown rather than throwing', () => {
  for (const value of [null, undefined, 42, 'x', []]) {
    assert.equal(classifySteamOffer(value), STEAM_OFFER_KINDS.UNKNOWN);
  }
});

/* -------------------------------------------------------------------------- */
/* Parsing                                                                     */
/* -------------------------------------------------------------------------- */

test('only Free to Keep offers survive parsing', () => {
  const giveaways = parseSteamGiveaways(
    { offers: [freeToKeep, freeWeekend, permanentlyFree, discounted] },
    { now: NOW },
  );

  assert.equal(giveaways.length, 1, 'a non-FTK offer was announced');
  assert.equal(giveaways[0].id, '1245620');
  assert.equal(giveaways[0].kind, GIVEAWAY_KINDS.FREE_TO_KEEP);
  assert.equal(giveaways[0].platform, 'Steam');
  assert.equal(giveaways[0].key, 'steam:1245620');
});

test('the full record is captured', () => {
  const [giveaway] = parseSteamGiveaways({ offers: [freeToKeep] }, { now: NOW });

  assert.equal(giveaway.title, 'Some Game');
  assert.equal(giveaway.url, 'https://store.steampowered.com/app/1245620');
  assert.equal(giveaway.imageUrl, 'https://cdn.example/header.jpg');
  assert.equal(giveaway.originalPrice.amount, 599);
  assert.equal(giveaway.endsAt, '2026-10-05T00:00:00.000Z');
});

test('an expired Free to Keep offer is dropped', () => {
  const expired = { ...freeToKeep, promotion_end: '2026-10-02T00:00:00.000Z' };

  assert.deepEqual(parseSteamGiveaways({ offers: [expired] }, { now: NOW }), []);
});

test('an offer without a usable id is skipped', () => {
  const noId = { ...freeToKeep, id: undefined, steam_appid: undefined, appid: undefined };

  assert.deepEqual(parseSteamGiveaways({ offers: [noId] }, { now: NOW }), []);
});

/* -------------------------------------------------------------------------- */
/* The default source is honest about what it cannot tell                      */
/* -------------------------------------------------------------------------- */

test('the featured feed yields candidates marked unknown, so nothing is announced', () => {
  const payload = {
    specials: {
      items: [
        { id: 1, name: 'A', discount_percent: 100, final_price: 0 },
        { id: 2, name: 'B', discount_percent: 50, final_price: 1000 },
      ],
    },
  };

  const offers = extractFeaturedOffers(payload);
  assert.equal(offers.length, 2);
  assert.ok(offers.every((offer) => offer.promotion_kind === STEAM_OFFER_KINDS.UNKNOWN));

  // The whole point: the default source cannot distinguish Free to Keep from
  // Free Weekend, so it announces nothing rather than guessing.
  assert.deepEqual(parseSteamGiveaways({ offers }, { now: NOW }), []);
});

test('extractFeaturedOffers tolerates a payload with no specials', () => {
  for (const payload of [null, {}, { specials: {} }, { specials: { items: null } }]) {
    assert.deepEqual(extractFeaturedOffers(payload), []);
  }
});
