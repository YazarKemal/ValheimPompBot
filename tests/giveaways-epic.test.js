import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEpicGiveaways } from '../src/giveaways/providers/epic.js';
import { GIVEAWAY_KINDS, isActive } from '../src/giveaways/provider.js';

/**
 * Fixtures mirror the shape of Epic's public promotions payload. The parser is
 * pure, so the promotion rules are tested without touching the network.
 */

/** A temporary weekly giveaway. */
function temporaryGiveaway(overrides = {}) {
  return {
    id: 'epic-1',
    title: 'Mystery Game',
    keyImages: [{ type: 'OfferImageWide', url: 'https://cdn.example/wide.jpg' }],
    offerMappings: [{ pageSlug: 'mystery-game-abc123' }],
    price: {
      totalPrice: {
        discountPrice: 0,
        originalPrice: 19999,
        currencyCode: 'TRY',
        fmtPrice: { originalPrice: '199,00 TL', discountPrice: '0' },
      },
    },
    promotions: {
      promotionalOffers: [
        {
          promotionalOffers: [
            {
              startDate: '2026-10-01T15:00:00.000Z',
              endDate: '2026-10-08T15:00:00.000Z',
              discountSetting: { discountPercentage: 0 },
            },
          ],
        },
      ],
    },
    ...overrides,
  };
}

/** A permanently free-to-play title: price 0, but no promotion of any kind. */
function permanentlyFree(overrides = {}) {
  return {
    id: 'epic-f2p',
    title: 'Forever Free Battle Royale',
    keyImages: [],
    price: { totalPrice: { discountPrice: 0, originalPrice: 0, currencyCode: 'TRY' } },
    promotions: { promotionalOffers: [] },
    ...overrides,
  };
}

const wrap = (elements) => ({ data: { Catalog: { searchStore: { elements } } } });

const NOW = new Date('2026-10-03T12:00:00.000Z').getTime();

/* -------------------------------------------------------------------------- */
/* Detection                                                                   */
/* -------------------------------------------------------------------------- */

test('a temporary weekly giveaway is detected', () => {
  const [giveaway] = parseEpicGiveaways(wrap([temporaryGiveaway()]), { now: NOW });

  assert.ok(giveaway, 'the giveaway was not detected');
  assert.equal(giveaway.title, 'Mystery Game');
  assert.equal(giveaway.provider, 'epic');
  assert.equal(giveaway.platform, 'Epic Games');
  assert.equal(giveaway.kind, GIVEAWAY_KINDS.EPIC_GIVEAWAY);
  assert.equal(giveaway.key, 'epic:epic-1');
});

test('the full record is captured when the payload carries it', () => {
  const [giveaway] = parseEpicGiveaways(wrap([temporaryGiveaway()]), { now: NOW });

  assert.equal(giveaway.url, 'https://store.epicgames.com/en-US/p/mystery-game-abc123');
  assert.equal(giveaway.imageUrl, 'https://cdn.example/wide.jpg');
  assert.equal(giveaway.startsAt, '2026-10-01T15:00:00.000Z');
  assert.equal(giveaway.endsAt, '2026-10-08T15:00:00.000Z');
  assert.equal(giveaway.originalPrice.amount, 199.99);
  assert.equal(giveaway.originalPrice.formatted, '199,00 TL');
  assert.equal(giveaway.currentPrice.amount, 0);
});

test('a permanently free-to-play game is excluded', () => {
  const giveaways = parseEpicGiveaways(wrap([permanentlyFree()]), { now: NOW });

  assert.deepEqual(giveaways, [], 'a permanently free game was treated as a giveaway');
});

test('a discounted but not free game is excluded', () => {
  const discounted = temporaryGiveaway({
    id: 'epic-sale',
    promotions: {
      promotionalOffers: [
        { promotionalOffers: [{ discountSetting: { discountPercentage: 75 } }] },
      ],
    },
  });

  assert.deepEqual(parseEpicGiveaways(wrap([discounted]), { now: NOW }), []);
});

test('a game with no promotions block at all is excluded', () => {
  const noPromotions = temporaryGiveaway({ id: 'epic-plain', promotions: {} });

  assert.deepEqual(parseEpicGiveaways(wrap([noPromotions]), { now: NOW }), []);
});

test('mixed payloads yield only the giveaways', () => {
  const giveaways = parseEpicGiveaways(
    wrap([temporaryGiveaway(), permanentlyFree(), temporaryGiveaway({ id: 'epic-2', title: 'Second' })]),
    { now: NOW },
  );

  assert.deepEqual(giveaways.map((entry) => entry.id).sort(), ['epic-1', 'epic-2']);
});

/* -------------------------------------------------------------------------- */
/* Windows                                                                     */
/* -------------------------------------------------------------------------- */

test('an upcoming promotion is not announced before its window opens', () => {
  const upcoming = temporaryGiveaway({
    id: 'epic-soon',
    promotions: { upcomingPromotionalOffers: [{ promotionalOffers: [{ discountSetting: { discountPercentage: 0 } }] }] },
  });

  assert.deepEqual(parseEpicGiveaways(wrap([upcoming]), { now: NOW }), []);
});

test('a promotion whose window has closed is dropped', () => {
  const ended = temporaryGiveaway({
    id: 'epic-old',
    promotions: {
      promotionalOffers: [
        {
          promotionalOffers: [
            {
              startDate: '2026-09-01T15:00:00.000Z',
              endDate: '2026-09-08T15:00:00.000Z',
              discountSetting: { discountPercentage: 0 },
            },
          ],
        },
      ],
    },
  });

  assert.deepEqual(parseEpicGiveaways(wrap([ended]), { now: NOW }), []);
});

test('isActive handles missing dates, open windows and closed windows', () => {
  assert.equal(isActive({ startsAt: null, endsAt: null }, NOW), true);
  assert.equal(isActive({ startsAt: '2026-10-01T00:00:00Z', endsAt: '2026-10-08T00:00:00Z' }, NOW), true);
  assert.equal(isActive({ startsAt: '2026-10-05T00:00:00Z', endsAt: null }, NOW), false);
  assert.equal(isActive({ startsAt: null, endsAt: '2026-10-02T00:00:00Z' }, NOW), false);
});

/* -------------------------------------------------------------------------- */
/* Robustness                                                                  */
/* -------------------------------------------------------------------------- */

test('a malformed payload yields an empty list rather than throwing', () => {
  for (const payload of [null, undefined, {}, { data: {} }, { data: { Catalog: {} } }, { data: { Catalog: { searchStore: {} } } }]) {
    assert.deepEqual(parseEpicGiveaways(payload, { now: NOW }), []);
  }
});

test('an element without an id or title is skipped, leaving the rest intact', () => {
  const broken = temporaryGiveaway({ id: undefined });
  const good = temporaryGiveaway({ id: 'epic-ok', title: 'Fine' });

  const giveaways = parseEpicGiveaways(wrap([broken, good]), { now: NOW });

  assert.deepEqual(giveaways.map((entry) => entry.id), ['epic-ok']);
});

test('image selection prefers the wide store art', () => {
  const element = temporaryGiveaway({
    keyImages: [
      { type: 'Thumbnail', url: 'https://cdn.example/thumb.jpg' },
      { type: 'OfferImageWide', url: 'https://cdn.example/wide.jpg' },
    ],
  });

  assert.equal(parseEpicGiveaways(wrap([element]), { now: NOW })[0].imageUrl, 'https://cdn.example/wide.jpg');
});

test('a missing image does not break parsing', () => {
  const element = temporaryGiveaway({ keyImages: [] });
  const [giveaway] = parseEpicGiveaways(wrap([element]), { now: NOW });

  assert.equal(giveaway.imageUrl, null);
});

test('a trailing /home in the slug is stripped from the store url', () => {
  const element = temporaryGiveaway({ offerMappings: [{ pageSlug: 'some-game/home' }] });

  assert.equal(parseEpicGiveaways(wrap([element]), { now: NOW })[0].url, 'https://store.epicgames.com/en-US/p/some-game');
});
