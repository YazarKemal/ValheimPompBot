import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyItadGiveaway,
  classifyItadResponse,
  ITAD_SOURCE_LABEL,
  REJECTION,
} from '../src/giveaways/providers/itad/classify.js';
import {
  ITAD_API_KEY_HEADER,
  ITAD_GIVEAWAYS_URL,
  ItadAuthError,
  ItadGiveawaySource,
  ItadUnavailableError,
} from '../src/giveaways/providers/itad/index.js';
import { classifySteamOffer, parseSteamGiveaways, STEAM_OFFER_KINDS } from '../src/giveaways/providers/steam.js';
import { createGiveawayProviders, createSteamProvider } from '../src/giveaways/index.js';
import { createGiveawayMonitor } from '../src/giveaways/monitor.js';
import { buildGiveawayEmbed } from '../src/giveaways/embed.js';
import { createCapturingLogger } from '../src/utils/logger.js';

/**
 * Fixtures follow the ITAD OpenAPI `obj.giveaway` schema exactly. No test here
 * touches the network: every transport is injected, and a global fetch trap in
 * the final block proves it.
 */

const NOW = Date.parse('2026-10-03T12:00:00.000Z');
const PUBLISHED = '2026-10-01T15:00:00.000Z';
const EXPIRES = '2026-10-08T15:00:00.000Z';
const PAST = '2026-09-01T15:00:00.000Z';
const FUTURE = '2026-11-01T15:00:00.000Z';

/** A Steam full game asset. */
const steamGame = (overrides = {}) => ({
  id: '11111111-2222-3333-4444-555555555555',
  slug: 'some-game',
  title: 'Some Game',
  type: 'game',
  mature: false,
  assets: { banner600: 'https://assets.example/banner600.jpg', boxart: 'https://assets.example/box.jpg' },
  drmFree: false,
  keys: [{ id: 61, name: 'Steam' }],
  platforms: [],
  ...overrides,
});

/** A well-formed, accepted ITAD giveaway. */
const giveaway = (overrides = {}) => ({
  id: 16541,
  title: 'Some Game - Free on Steam',
  shop: { id: 61, name: 'Steam' },
  url: 'https://isthereanydeal.com/giveaway/abc123/',
  details: 'https://isthereanydeal.com/giveaway/abc123/details/',
  isMature: false,
  publish: PUBLISHED,
  expiry: EXPIRES,
  note: null,
  games: [steamGame()],
  ...overrides,
});

/* -------------------------------------------------------------------------- */
/* Acceptance                                                                  */
/* -------------------------------------------------------------------------- */

test('an active Steam giveaway is accepted', () => {
  const verdict = classifyItadGiveaway(giveaway(), { now: NOW });

  assert.equal(verdict.accepted, true, `rejected: ${verdict.reason}`);
  assert.equal(verdict.offer.id, '16541');
  assert.equal(verdict.offer.name, 'Some Game - Free on Steam');
  assert.equal(verdict.offer.promotion_kind, 'free_to_keep');
  assert.equal(verdict.offer.shop_name, 'Steam');
});

test('an accepted offer flows through the Steam pipeline as Free to Keep', () => {
  const { offers } = classifyItadResponse([giveaway()], { now: NOW });
  const giveaways = parseSteamGiveaways({ offers }, { now: NOW });

  assert.equal(giveaways.length, 1);
  assert.equal(giveaways[0].kind, 'free_to_keep');
  assert.equal(giveaways[0].key, 'steam:16541');
  assert.equal(giveaways[0].source, ITAD_SOURCE_LABEL);
  assert.equal(giveaways[0].imageUrl, 'https://assets.example/banner600.jpg');
});

test('the explicit free_to_keep kind is honoured without any price data', () => {
  // ITAD's payload carries no prices at all; classification must not need them.
  const { offers } = classifyItadResponse([giveaway()], { now: NOW });

  assert.equal(classifySteamOffer(offers[0]), STEAM_OFFER_KINDS.FREE_TO_KEEP);
});

test('a temporary free-to-play-to-keep transition is accepted when metadata says keep', () => {
  const entry = giveaway({
    title: 'Always Free Brawler - Free to Keep this week',
    note: 'Free to keep permanently if you add it now.',
    games: [steamGame({ title: 'Always Free Brawler' })],
  });
  const verdict = classifyItadGiveaway(entry, { now: NOW });

  assert.equal(verdict.accepted, true, `rejected: ${verdict.reason}`);
});

test('a giveaway with a null expiry is still accepted', () => {
  const verdict = classifyItadGiveaway(giveaway({ expiry: null }), { now: NOW });

  assert.equal(verdict.accepted, true);
  assert.equal(verdict.offer.promotion_end, null);
});

/* -------------------------------------------------------------------------- */
/* Rejection                                                                   */
/* -------------------------------------------------------------------------- */

test('an expired giveaway is rejected', () => {
  const verdict = classifyItadGiveaway(giveaway({ expiry: PAST }), { now: NOW });

  assert.equal(verdict.accepted, false);
  assert.equal(verdict.reason, REJECTION.EXPIRED);
});

test('a giveaway that has not been published yet is rejected', () => {
  const verdict = classifyItadGiveaway(giveaway({ publish: FUTURE, expiry: null }), { now: NOW });

  assert.equal(verdict.accepted, false);
  assert.equal(verdict.reason, REJECTION.NOT_ACTIVE);
});

test('a non-Steam giveaway is rejected', () => {
  for (const shop of [{ id: 35, name: 'GOG' }, { id: 16, name: 'Epic Game Store' }, { id: 1, name: 'Humble' }]) {
    const verdict = classifyItadGiveaway(giveaway({ shop }), { now: NOW });
    assert.equal(verdict.accepted, false, `${shop.name} was accepted`);
    assert.equal(verdict.reason, REJECTION.NOT_STEAM);
  }
});

test('a giveaway with no shop is rejected as ambiguous', () => {
  assert.equal(classifyItadGiveaway(giveaway({ shop: null }), { now: NOW }).reason, REJECTION.MISSING_SHOP);
});

test('Free Weekend is rejected', () => {
  const entry = giveaway({ title: 'Some Game - Free Weekend on Steam' });
  const verdict = classifyItadGiveaway(entry, { now: NOW });

  assert.equal(verdict.accepted, false);
  assert.equal(verdict.reason, REJECTION.TEMPORARY_ACCESS);
});

test('Play For Free is rejected', () => {
  const entry = giveaway({ title: 'Some Game - Play For Free' });
  assert.equal(classifyItadGiveaway(entry, { now: NOW }).reason, REJECTION.TEMPORARY_ACCESS);
});

test('a Weekend Trial is rejected', () => {
  const entry = giveaway({ note: 'Weekend Trial - access ends Sunday.' });
  assert.equal(classifyItadGiveaway(entry, { now: NOW }).reason, REJECTION.TEMPORARY_ACCESS);
});

test('a demo is rejected', () => {
  const entry = giveaway({ games: [steamGame({ title: 'Some Game Demo', slug: 'some-game-demo' })] });
  assert.equal(classifyItadGiveaway(entry, { now: NOW }).reason, REJECTION.TEMPORARY_ACCESS);
});

test('beta access is rejected', () => {
  const entry = giveaway({ title: 'Some Game - Closed Beta access' });
  assert.equal(classifyItadGiveaway(entry, { now: NOW }).reason, REJECTION.TEMPORARY_ACCESS);
});

test('a DLC-only giveaway is rejected', () => {
  const entry = giveaway({ games: [steamGame({ type: 'dlc', title: 'Some Game - Expansion Pack' })] });
  const verdict = classifyItadGiveaway(entry, { now: NOW });

  assert.equal(verdict.accepted, false);
  assert.equal(verdict.reason, REJECTION.NO_FULL_GAME);
});

test('a soundtrack-only giveaway is rejected', () => {
  const entry = giveaway({
    games: [steamGame({ type: 'dlc', title: 'Some Game Soundtrack', slug: 'some-game-soundtrack' })],
  });
  assert.equal(classifyItadGiveaway(entry, { now: NOW }).accepted, false);
});

test('a package-only giveaway is rejected', () => {
  const entry = giveaway({ games: [steamGame({ type: 'package' })] });
  assert.equal(classifyItadGiveaway(entry, { now: NOW }).reason, REJECTION.NO_FULL_GAME);
});

test('a third-party Steam-key giveaway is rejected', () => {
  // The key is for Steam, but the shop giving it away is not Steam itself.
  const entry = giveaway({
    shop: { id: 1, name: 'Fanatical' },
    games: [steamGame({ keys: [{ id: 61, name: 'Steam' }] })],
  });
  const verdict = classifyItadGiveaway(entry, { now: NOW });

  assert.equal(verdict.accepted, false);
  assert.equal(verdict.reason, REJECTION.NOT_STEAM);
});

test('a permanently free-to-play title without a keep signal is rejected', () => {
  const entry = giveaway({ title: 'Free to Play Brawler - Free on Steam' });
  const verdict = classifyItadGiveaway(entry, { now: NOW });

  assert.equal(verdict.accepted, false);
  assert.equal(verdict.reason, REJECTION.PERMANENTLY_FREE);
});

test('an ambiguous entry is rejected', () => {
  for (const overrides of [
    { title: '' },
    { url: '' },
    { games: [] },
    { games: [{ ...steamGame(), type: null }] },
  ]) {
    const verdict = classifyItadGiveaway(giveaway(overrides), { now: NOW });
    assert.equal(verdict.accepted, false, `accepted ${JSON.stringify(overrides)}`);
  }
});

test('malformed entries are rejected rather than throwing', () => {
  for (const entry of [null, undefined, 42, 'x', {}, { title: 'no id' }]) {
    assert.doesNotThrow(() => classifyItadGiveaway(entry, { now: NOW }));
    assert.equal(classifyItadGiveaway(entry, { now: NOW }).accepted, false);
  }
});

test('rejection reasons are counted across a whole response', () => {
  const { offers, rejected, total } = classifyItadResponse(
    [
      giveaway({ id: 1 }),
      giveaway({ id: 2, shop: { id: 35, name: 'GOG' } }),
      giveaway({ id: 3, title: 'X - Free Weekend' }),
      giveaway({ id: 4, expiry: PAST }),
    ],
    { now: NOW },
  );

  assert.equal(total, 4);
  assert.deepEqual(offers.map((offer) => offer.id), ['1']);
  assert.equal(rejected.length, 3);
});

/* -------------------------------------------------------------------------- */
/* URLs and attribution                                                        */
/* -------------------------------------------------------------------------- */

test('the ITAD redirect URL is preserved verbatim, never rewritten', () => {
  const url = 'https://isthereanydeal.com/giveaway/abc123/?ref=pompai&utm_source=discord';
  const { offers } = classifyItadResponse([giveaway({ url })], { now: NOW });

  assert.equal(offers[0].store_url, url, 'the ITAD URL was modified');
});

test('no Steam URL is fabricated when no Steam id is available', () => {
  const { offers } = classifyItadResponse([giveaway()], { now: NOW });

  assert.ok(
    !offers[0].store_url.includes('store.steampowered.com'),
    'a Steam URL was invented from an ITAD giveaway id',
  );
});

test('the offer carries IsThereAnyDeal attribution', () => {
  const verdict = classifyItadGiveaway(giveaway(), { now: NOW });

  assert.equal(verdict.offer.source, ITAD_SOURCE_LABEL);
  assert.equal(verdict.offer.source, 'IsThereAnyDeal');
});

test('the embed shows a plain Source field with no implied affiliation', () => {
  const { offers } = classifyItadResponse([giveaway()], { now: NOW });
  const [item] = parseSteamGiveaways({ offers }, { now: NOW });
  const embed = buildGiveawayEmbed(item, { now: NOW }).toJSON();
  const source = embed.fields.find((field) => field.name === 'Source');

  assert.ok(source, 'no Source field was rendered');
  assert.equal(source.value, 'IsThereAnyDeal');

  const serialised = JSON.stringify(embed).toLowerCase();
  for (const claim of ['powered by', 'partner', 'sponsor', 'official partner']) {
    assert.ok(!serialised.includes(claim), `the embed implies "${claim}"`);
  }
});

test('a directly-read source renders no Source field', () => {
  const epic = {
    key: 'epic:1',
    provider: 'epic',
    id: '1',
    title: 'Game',
    platform: 'Epic Games',
    kind: 'epic_giveaway',
    source: null,
  };
  const embed = buildGiveawayEmbed(epic, { now: NOW }).toJSON();

  assert.ok(!embed.fields.some((field) => field.name === 'Source'));
});

/* -------------------------------------------------------------------------- */
/* Transport                                                                   */
/* -------------------------------------------------------------------------- */

function transport({ status = 200, body = '[]', throwError = null, delayMs = 0, json = true } = {}) {
  const calls = [];
  return {
    calls,
    async fetchImpl(url, options) {
      calls.push({ url, options });
      if (delayMs > 0) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, delayMs);
          options.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            const abort = new Error('aborted');
            abort.name = 'AbortError';
            reject(abort);
          });
        });
      }
      if (throwError) throw throwError;
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => null },
        async json() {
          if (!json) throw new Error('not json');
          return typeof body === 'string' ? JSON.parse(body) : body;
        },
        async text() {
          return typeof body === 'string' ? body : JSON.stringify(body);
        },
      };
    },
  };
}

const source = (fake, options = {}) => new ItadGiveawaySource({ apiKey: 'test-key', fetchImpl: fake.fetchImpl, ...options });

test('the request targets the documented endpoint with the documented header', async () => {
  const fake = transport({ body: JSON.stringify([giveaway()]) });
  await source(fake).fetchOffers({ now: NOW });

  const [{ url, options }] = fake.calls;
  assert.ok(url.startsWith(ITAD_GIVEAWAYS_URL), `wrong endpoint: ${url}`);
  assert.equal(options.headers[ITAD_API_KEY_HEADER], 'test-key');
  assert.equal(options.headers['ITAD-API-Key'], 'test-key');
  assert.ok(options.signal, 'no abort signal was passed');
  assert.equal(fake.calls.length, 1, 'more than one request was made');
});

test('the API key never appears in the URL', async () => {
  const fake = transport({ body: '[]' });
  await source(fake).fetchOffers({ now: NOW });

  assert.ok(!fake.calls[0].url.includes('test-key'), 'the key leaked into the query string');
});

test('401 and 403 produce an auth error naming no key material', async () => {
  for (const status of [401, 403]) {
    const fake = transport({ status, body: '{"status_code":403,"reason_phrase":"Missing api key"}' });

    await assert.rejects(
      () => source(fake).fetchOffers({ now: NOW }),
      (error) => {
        assert.ok(error instanceof ItadAuthError, `${status} produced ${error.name}`);
        assert.equal(error.code, 'ITAD_AUTH_ERROR');
        assert.equal(error.status, status);
        assert.match(error.message, /ITAD_API_KEY/);
        assert.ok(!error.message.includes('test-key'), 'the key leaked into the error');
        assert.ok(!JSON.stringify(error.details).includes('test-key'));
        return true;
      },
    );
  }
});

test('429 is reported as rate limiting and not retried', async () => {
  const fake = transport({ status: 429, body: '' });

  await assert.rejects(
    () => source(fake).fetchOffers({ now: NOW }),
    (error) => {
      assert.ok(error instanceof ItadUnavailableError);
      assert.equal(error.status, 429);
      assert.match(error.message, /rate limiting/);
      return true;
    },
  );
  assert.equal(fake.calls.length, 1, 'a rate-limited request was retried');
});

test('5xx fails closed', async () => {
  for (const status of [500, 502, 503]) {
    const fake = transport({ status, body: '' });
    await assert.rejects(() => source(fake).fetchOffers({ now: NOW }), ItadUnavailableError, `status ${status}`);
  }
});

test('a timeout is reported as a timeout', async () => {
  const fake = transport({ body: '[]', delayMs: 5000 });

  await assert.rejects(
    () => source(fake, { timeoutMs: 40 }).fetchOffers({ now: NOW }),
    (error) => {
      assert.equal(error.code, 'ITAD_UNAVAILABLE');
      assert.match(error.message, /did not answer/);
      return true;
    },
  );
});

test('a non-JSON body fails closed', async () => {
  const fake = transport({ status: 200, body: '<html>', json: false });
  await assert.rejects(() => source(fake).fetchOffers({ now: NOW }), ItadUnavailableError);
});

test('a missing key throws before any request is made', async () => {
  const fake = transport({ body: '[]' });
  const unconfigured = new ItadGiveawaySource({ apiKey: null, fetchImpl: fake.fetchImpl });

  assert.equal(unconfigured.isConfigured(), false);
  await assert.rejects(() => unconfigured.fetchOffers({}), ItadAuthError);
  assert.equal(fake.calls.length, 0, 'a request was made without a key');
});

test('an empty result is a success, not a failure', async () => {
  const fake = transport({ body: '[]' });
  assert.deepEqual(await source(fake).fetchOffers({ now: NOW }), []);
});

test('an all-rejected response yields an empty list, not an error', async () => {
  const fake = transport({ body: JSON.stringify([giveaway({ shop: { id: 35, name: 'GOG' } })]) });
  const offers = await source(fake).fetchOffers({ now: NOW });

  assert.deepEqual(offers, []);
});

/* -------------------------------------------------------------------------- */
/* Secret redaction                                                            */
/* -------------------------------------------------------------------------- */

test('the API key never reaches a log line', async () => {
  const secret = 'itad_live_0123456789abcdefghijklmnop';
  const { logger, text } = createCapturingLogger({ level: 'debug' });
  const fake = transport({
    body: JSON.stringify([giveaway(), giveaway({ id: 2, shop: { id: 35, name: 'GOG' } })]),
  });

  const instance = new ItadGiveawaySource({ apiKey: secret, fetchImpl: fake.fetchImpl, logger });
  await instance.fetchOffers({ now: NOW });

  assert.ok(!text().includes(secret), 'the key reached the log');

  // And on the failure paths.
  const failing = new ItadGiveawaySource({
    apiKey: secret,
    fetchImpl: transport({ status: 401, body: '' }).fetchImpl,
    logger,
  });
  await failing.fetchOffers({ now: NOW }).catch((error) => logger.warn('failed', error));

  assert.ok(!text().includes(secret), 'the key reached the log on the failure path');
});

/* -------------------------------------------------------------------------- */
/* Provider selection and the monitor                                          */
/* -------------------------------------------------------------------------- */

test('ITAD is the default Steam source, and SteamDB is opt-in only', async () => {
  const { logger, text } = createCapturingLogger({ level: 'debug' });
  const providers = createGiveawayProviders({ logger, itadApiKey: 'k' });

  assert.deepEqual(providers.map((provider) => provider.name), ['epic', 'steam']);
  assert.ok(!text().includes('SteamDB'), 'SteamDB was used by default');
});

test('SteamDB is selected only when explicitly configured', () => {
  const { logger, text } = createCapturingLogger({ level: 'debug' });
  const provider = createSteamProvider({ logger, steamSource: 'steamdb' });

  assert.ok(provider, 'no provider was built');
  assert.match(text(), /Cloudflare/);
});

test('an unconfigured ITAD source removes the Steam provider rather than failing', () => {
  const { logger, text } = createCapturingLogger({ level: 'debug' });
  const providers = createGiveawayProviders({ logger, itadApiKey: null });

  assert.deepEqual(providers.map((provider) => provider.name), ['epic'], 'a broken Steam provider was registered');
  assert.match(text(), /ITAD_API_KEY is not set/);
});

test('STEAM_GIVEAWAY_SOURCE=none disables Steam discovery', () => {
  const providers = createGiveawayProviders({ itadApiKey: 'k', steamSource: 'none' });

  assert.deepEqual(providers.map((provider) => provider.name), ['epic']);
});

test('a 401 disables only the Steam provider; Epic keeps working', async () => {
  const fake = transport({ status: 401, body: '' });
  const epicCalls = [];
  const epic = {
    name: 'epic',
    label: 'Epic Games',
    async fetchGiveaways() {
      epicCalls.push(Date.now());
      return [];
    },
  };

  const monitor = createGiveawayMonitor({
    providers: [epic, createSteamProvider({ itadApiKey: 'k', itadFetch: fake.fetchImpl })],
    now: () => NOW,
  });

  const result = await monitor.checkNow();

  assert.equal(result.skipped, false, 'the cycle aborted');
  assert.equal(epicCalls.length, 1, 'Epic did not run');
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].provider, 'steam');
  assert.equal(fake.calls.length, 1, 'the failing request was retried');
});

test('a successful but empty ITAD cycle produces no failure', async () => {
  const fake = transport({ body: '[]' });
  const monitor = createGiveawayMonitor({
    providers: [createSteamProvider({ itadApiKey: 'k', itadFetch: fake.fetchImpl })],
    now: () => NOW,
  });

  const result = await monitor.checkNow();

  assert.equal(result.failures.length, 0, 'an empty result was reported as a failure');
  assert.equal(result.active, 0);
});

/* -------------------------------------------------------------------------- */
/* Deduplication                                                               */
/* -------------------------------------------------------------------------- */

test('a rediscovered ITAD giveaway is not announced twice', async () => {
  const store = {
    entries: new Map(),
    has(key) {
      return this.entries.has(key);
    },
    async load() {},
    async markAnnounced(item) {
      this.entries.set(item.key, item);
    },
    async prune() {
      return 0;
    },
    get size() {
      return this.entries.size;
    },
  };
  const posted = [];
  const fake = transport({ body: JSON.stringify([giveaway()]) });

  const monitor = createGiveawayMonitor({
    providers: [createSteamProvider({ itadApiKey: 'k', itadFetch: fake.fetchImpl })],
    store,
    notifier: {
      async announce(item) {
        posted.push(item.key);
        return true;
      },
    },
    now: () => NOW,
  });

  await monitor.checkNow();
  await monitor.checkNow();

  assert.deepEqual(posted, ['steam:16541'], 'the same giveaway was announced twice');
});

test('the dedup key is the stable ITAD giveaway id', () => {
  const { offers } = classifyItadResponse([giveaway({ id: 98765 })], { now: NOW });
  const [item] = parseSteamGiveaways({ offers }, { now: NOW });

  assert.equal(item.key, 'steam:98765');
  assert.equal(item.id, '98765');
});

/* -------------------------------------------------------------------------- */
/* Guards                                                                      */
/* -------------------------------------------------------------------------- */

test('no test in this file performs real network access', async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = () => {
    called = true;
    throw new Error('a test reached the real network');
  };

  try {
    await source(transport({ body: JSON.stringify([giveaway()]) })).fetchOffers({ now: NOW });
    classifyItadResponse([giveaway()], { now: NOW });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(called, false);
});

test('the ITAD source makes zero AI calls', async () => {
  const instance = source(transport({ body: '[]' }));

  assert.deepEqual(Object.keys(instance).filter((key) => /ai|complet|prompt|model/i.test(key)), []);
  await instance.fetchOffers({ now: NOW });
});
