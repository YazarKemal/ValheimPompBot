import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyseSteamDbHtml,
  classifyRow,
  extractLabelTexts,
  extractTimestamps,
  parseSteamDbFree,
  steamStoreUrl,
  toText,
} from '../src/giveaways/providers/steamdb/parse.js';
import {
  DEFAULT_USER_AGENT,
  MIN_STEAMDB_INTERVAL_MINUTES,
  STEAMDB_FREE_URL,
  SteamDbBlockedError,
  SteamDbFreeSource,
} from '../src/giveaways/providers/steamdb/index.js';
import { parseSteamGiveaways, SteamProvider } from '../src/giveaways/providers/steam.js';
import { GIVEAWAY_KINDS } from '../src/giveaways/provider.js';
import { createGiveawayMonitor } from '../src/giveaways/monitor.js';

/**
 * Every test here is fixture-based. No test in this file touches the network:
 * transports are injected, and a global fetch trap in the last block proves it.
 */

const NOW = Date.parse('2026-10-03T12:00:00.000Z');
/** Epoch seconds, derived from the dates rather than hand-written. */
const START = Math.floor(Date.parse('2026-10-03T06:00:00.000Z') / 1000);
const END = Math.floor(Date.parse('2026-10-08T06:00:00.000Z') / 1000);

/** Builds a SteamDB-shaped row. */
function row({ appId, title, label, start = START, end = END, image = null }) {
  return `<tr>
    <td><img src="${image ?? `https://cdn.example/${appId}.jpg`}"></td>
    <td><a href="/app/${appId}/">${title}</a></td>
    <td><span>${label}</span></td>
    <td><span data-timestamp="${start}"></span></td>
    <td><span data-timestamp="${end}"></span></td>
  </tr>`;
}

const page = (...rows) =>
  `<!doctype html><html><body><table class="table"><tbody>${rows.join('\n')}</tbody></table></body></html>`;

/* -------------------------------------------------------------------------- */
/* Detection                                                                   */
/* -------------------------------------------------------------------------- */

test('one real Free to Keep entry is detected', () => {
  const html = page(row({ appId: '1245620', title: 'ELDEN RING', label: 'Free to Keep' }));
  const offers = parseSteamDbFree(html, { now: NOW });

  assert.equal(offers.length, 1);
  assert.equal(offers[0].id, '1245620');
  assert.equal(offers[0].name, 'ELDEN RING');
  assert.equal(offers[0].promotion_kind, 'free_to_keep');
});

test('the official Steam URL is extracted, never the SteamDB one', () => {
  const html = page(row({ appId: '1245620', title: 'ELDEN RING', label: 'Free to Keep' }));
  const [offer] = parseSteamDbFree(html, { now: NOW });

  assert.equal(offer.store_url, 'https://store.steampowered.com/app/1245620/');
  assert.ok(!offer.store_url.includes('steamdb'), 'the redemption link points at SteamDB');
  assert.equal(steamStoreUrl('999'), 'https://store.steampowered.com/app/999/');
});

test('start and end times are captured', () => {
  const html = page(row({ appId: '1', title: 'Game', label: 'Free to Keep' }));
  const [offer] = parseSteamDbFree(html, { now: NOW });

  assert.equal(offer.promotion_start, new Date(START * 1000).toISOString());
  assert.equal(offer.promotion_end, new Date(END * 1000).toISOString());
});

test('multiple Free to Keep entries are all detected', () => {
  const html = page(
    row({ appId: '1', title: 'First', label: 'Free to Keep' }),
    row({ appId: '2', title: 'Second', label: 'Free to Keep' }),
    row({ appId: '3', title: 'Third', label: 'free to keep' }),
  );
  const offers = parseSteamDbFree(html, { now: NOW });

  assert.deepEqual(offers.map((offer) => offer.name).sort(), ['First', 'Second', 'Third']);
});

test('the parsed offers flow through the existing Steam pipeline unchanged', () => {
  const html = page(row({ appId: '1245620', title: 'ELDEN RING', label: 'Free to Keep' }));
  const giveaways = parseSteamGiveaways({ offers: parseSteamDbFree(html, { now: NOW }) }, { now: NOW });

  assert.equal(giveaways.length, 1);
  assert.equal(giveaways[0].kind, GIVEAWAY_KINDS.FREE_TO_KEEP);
  assert.equal(giveaways[0].key, 'steam:1245620');
  assert.equal(giveaways[0].platform, 'Steam');
  assert.equal(giveaways[0].url, 'https://store.steampowered.com/app/1245620/');
});

/* -------------------------------------------------------------------------- */
/* Exclusions - the property that matters most                                 */
/* -------------------------------------------------------------------------- */

test('Free Weekend is excluded', () => {
  const html = page(row({ appId: '1', title: 'Weekend Game', label: 'Free Weekend' }));

  assert.deepEqual(parseSteamDbFree(html, { now: NOW }), []);
});

test('Play For Free is excluded', () => {
  const html = page(row({ appId: '1', title: 'Play Free', label: 'Play For Free' }));

  assert.deepEqual(parseSteamDbFree(html, { now: NOW }), []);
});

test('a permanently free-to-play game is excluded', () => {
  const html = page(
    row({ appId: '1', title: 'Always Free', label: 'Free to Play' }),
    row({ appId: '2', title: 'Other', label: 'Free To Play' }),
  );

  assert.deepEqual(parseSteamDbFree(html, { now: NOW }), []);
});

test('an upcoming or unconfirmed promotion is excluded', () => {
  for (const label of ['Upcoming', 'Unconfirmed', 'TBA', 'Unknown', 'Rumoured']) {
    const html = page(row({ appId: '1', title: 'Maybe', label }));
    assert.deepEqual(parseSteamDbFree(html, { now: NOW }), [], `"${label}" was accepted`);
  }
});

test('a zero price is never taken as evidence of Free to Keep', () => {
  // No label element at all, and a price that looks free. Must not be accepted.
  const html = `<!doctype html><table><tr>
      <td><a href="/app/123/">Some Game</a></td>
      <td><span class="price">0,00 TL</span></td>
      <td><span>100%</span></td>
    </tr></table>`;

  assert.deepEqual(parseSteamDbFree(html, { now: NOW }), []);
  assert.equal(classifyRow(['0,00 tl', '100%']), 'unknown');
});

test('a row labelled both Free to Keep and Free Weekend is rejected', () => {
  const html = page(
    `<tr><td><a href="/app/1/">Confusing</a></td><td><span>Free to Keep</span></td><td><span>Free Weekend</span></td></tr>`,
  );

  assert.deepEqual(parseSteamDbFree(html, { now: NOW }), []);
  assert.equal(classifyRow(['free to keep', 'free weekend']), 'rejected');
});

test('a game whose title merely contains a label is not accepted', () => {
  // The title text is not a label element of its own, and "Free to Keep" here
  // is part of a longer string, so it must not qualify.
  const html = page(row({ appId: '1', title: 'Free to Keep Simulator', label: 'Discount' }));

  assert.deepEqual(parseSteamDbFree(html, { now: NOW }), []);
});

test('excluded rows are counted so the reason is visible', () => {
  const html = page(
    row({ appId: '1', title: 'Keep', label: 'Free to Keep' }),
    row({ appId: '2', title: 'Weekend', label: 'Free Weekend' }),
    row({ appId: '3', title: 'Play', label: 'Play For Free' }),
  );
  const analysis = analyseSteamDbHtml(html, { now: NOW });

  assert.equal(analysis.accepted, 1);
  assert.equal(analysis.rejected, 2);
  assert.equal(analysis.offers.length, 1);
});

/* -------------------------------------------------------------------------- */
/* Upcoming windows through the pipeline                                       */
/* -------------------------------------------------------------------------- */

test('a Free to Keep promotion that has not started yet is not announced', () => {
  const future = Math.floor(NOW / 1000) + 86400;
  const html = page(row({ appId: '1', title: 'Later', label: 'Free to Keep', start: future, end: future + 86400 }));

  const offers = parseSteamDbFree(html, { now: NOW });
  assert.equal(offers.length, 1, 'the parser should surface it');

  // The existing pipeline is what holds it back until its window opens.
  assert.deepEqual(parseSteamGiveaways({ offers }, { now: NOW }), []);
});

test('an expired Free to Keep promotion is dropped by the pipeline', () => {
  const past = Math.floor(NOW / 1000) - 86400 * 3;
  const html = page(row({ appId: '1', title: 'Gone', label: 'Free to Keep', start: past - 86400, end: past }));

  assert.deepEqual(parseSteamGiveaways({ offers: parseSteamDbFree(html, { now: NOW }) }, { now: NOW }), []);
});

/* -------------------------------------------------------------------------- */
/* Robustness - markup changes must fail closed                                */
/* -------------------------------------------------------------------------- */

test('malformed HTML yields an empty list, not a throw', () => {
  const cases = [
    '',
    'not html at all',
    '<table><tr><td>unclosed',
    '<html><body><table></table></body></html>',
    '<table><tr></tr></table>',
    null,
    undefined,
  ];

  for (const html of cases) {
    assert.doesNotThrow(() => parseSteamDbFree(html, { now: NOW }), `threw on ${JSON.stringify(html)}`);
    assert.deepEqual(parseSteamDbFree(html, { now: NOW }), []);
  }
});

test('changed or missing selectors produce an empty list and a warning', () => {
  const renamed = '<div class="promo-card"><h3>Some Game</h3><p>Free to Keep</p></div>';
  const analysis = analyseSteamDbHtml(renamed, { now: NOW });

  assert.deepEqual(analysis.offers, []);
  assert.equal(analysis.shapeOk, false);
  assert.ok(analysis.warnings.length > 0, 'a structure change was not reported');
});

test('a Free to Keep row with no app id is skipped, leaving the others', () => {
  const html = page(
    `<tr><td><span>No Link</span></td><td><span>Free to Keep</span></td></tr>`,
    row({ appId: '42', title: 'Good', label: 'Free to Keep' }),
  );
  const analysis = analyseSteamDbHtml(html, { now: NOW });

  assert.deepEqual(analysis.offers.map((offer) => offer.id), ['42']);
  assert.ok(analysis.warnings.some((warning) => warning.includes('no Steam app id')));
});

test('a challenge page is recognised rather than parsed', () => {
  const challenge = '<html><head><title>Just a moment...</title></head><body>Checking your browser before accessing</body></html>';
  const analysis = analyseSteamDbHtml(challenge, { now: NOW });

  assert.equal(analysis.blocked, true);
  assert.deepEqual(analysis.offers, []);
});

test('nested tables do not leak a child row into its parent', () => {
  const html = `<table>
    <tr><td><a href="/app/1/">Parent</a><table><tr><td><span>Free to Keep</span></td></tr></table></td></tr>
    <tr><td><a href="/app/2/">Real</a></td><td><span>Free to Keep</span></td></tr>
  </table>`;
  const offers = parseSteamDbFree(html, { now: NOW });

  assert.ok(!offers.some((offer) => offer.id === '1'), 'a nested row was attributed to its parent');
});

/* -------------------------------------------------------------------------- */
/* Parsing helpers                                                             */
/* -------------------------------------------------------------------------- */

test('labels are matched on the whole element, not a substring', () => {
  const labels = extractLabelTexts('<td><span>Free to Keep</span></td><td><span>Free to Keep Simulator</span></td>');

  assert.ok(labels.includes('free to keep'));
  assert.ok(labels.includes('free to keep simulator'));
});

test('timestamps are read from attributes and time elements, ascending', () => {
  const stamps = extractTimestamps(`<span data-timestamp="${END}"></span><time datetime="2026-10-03T11:00:00Z"></time>`);

  assert.equal(stamps.length, 2);
  assert.ok(stamps[0] < stamps[1]);
});

test('millisecond timestamps are not multiplied again', () => {
  const [stamp] = extractTimestamps(`<span data-timestamp="${START * 1000}"></span>`);

  assert.equal(stamp, START * 1000);
});

test('toText strips markup and decodes entities', () => {
  assert.equal(toText('<b>Tom &amp; Jerry</b>'), 'Tom & Jerry');
  assert.equal(toText('<script>evil()</script>Hello'), 'Hello');
});

test('an image in the row is preferred, with the Steam CDN as fallback', () => {
  const withImage = parseSteamDbFree(page(row({ appId: '7', title: 'A', label: 'Free to Keep', image: 'https://cdn.example/a.jpg' })), { now: NOW });
  assert.equal(withImage[0].header_image, 'https://cdn.example/a.jpg');

  const withoutImage = parseSteamDbFree(
    page(`<tr><td><a href="/app/7/">A</a></td><td><span>Free to Keep</span></td></tr>`),
    { now: NOW },
  );
  assert.match(withoutImage[0].header_image, /cdn\.cloudflare\.steamstatic\.com\/steam\/apps\/7\/header\.jpg/);
});

/* -------------------------------------------------------------------------- */
/* Transport: blocking, rate limits and timeouts                               */
/* -------------------------------------------------------------------------- */

/** Builds a fake transport. */
function transport({ status = 200, body = '', throwError = null, delayMs = 0, headers = {} } = {}) {
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
        headers: { get: (name) => headers[name] ?? null },
        async text() {
          return body;
        },
      };
    },
  };
}

const source = (fake, options = {}) => new SteamDbFreeSource({ fetchImpl: fake.fetchImpl, ...options });

test('a 403 is reported as blocked, not worked around', async () => {
  const fake = transport({ status: 403, body: '<html>Just a moment...</html>' });

  await assert.rejects(
    () => source(fake).fetchOffers({}),
    (error) => {
      assert.ok(error instanceof SteamDbBlockedError);
      assert.equal(error.code, 'STEAMDB_BLOCKED');
      assert.equal(error.status, 403);
      assert.match(error.message, /No bypass is attempted/);
      return true;
    },
  );
  assert.equal(fake.calls.length, 1, 'a blocked request was retried');
});

test('429 and 5xx are reported as blocked too', async () => {
  for (const status of [429, 500, 502, 503]) {
    const fake = transport({ status, body: '' });
    await assert.rejects(() => source(fake).fetchOffers({}), SteamDbBlockedError, `status ${status} was not reported`);
  }
});

test('a timeout is reported as a timeout', async () => {
  const fake = transport({ status: 200, body: '<html></html>', delayMs: 5000 });

  await assert.rejects(
    () => source(fake, { timeoutMs: 40 }).fetchOffers({}),
    (error) => {
      assert.equal(error.code, 'STEAMDB_TIMEOUT');
      return true;
    },
  );
});

test('the request carries a descriptive User-Agent and no browser impersonation', async () => {
  const fake = transport({ status: 200, body: page(row({ appId: '1', title: 'A', label: 'Free to Keep' })) });

  await source(fake).fetchOffers({});

  const [{ url, options }] = fake.calls;
  assert.equal(url, STEAMDB_FREE_URL);
  assert.equal(options.headers['user-agent'], DEFAULT_USER_AGENT);
  assert.match(options.headers['user-agent'], /PompAI/);
  assert.ok(!/Mozilla|Chrome|Safari/i.test(options.headers['user-agent']), 'the UA impersonates a browser');
  assert.equal(options.redirect, 'follow');
  assert.ok(options.signal, 'no abort signal was passed');
});

test('a configured User-Agent overrides the default', async () => {
  const fake = transport({ status: 200, body: '<html></html>' });
  await source(fake, { userAgent: 'CustomBot/2.0 (admin@example.test)' }).fetchOffers({});

  assert.equal(fake.calls[0].options.headers['user-agent'], 'CustomBot/2.0 (admin@example.test)');
});

test('a challenge body on a 200 is still treated as blocked', async () => {
  const fake = transport({ status: 200, body: '<html><title>Just a moment...</title></html>' });

  await assert.rejects(() => source(fake).fetchOffers({}), SteamDbBlockedError);
});

test('one call makes exactly one request - no concurrency, no retry', async () => {
  const fake = transport({ status: 200, body: page(row({ appId: '1', title: 'A', label: 'Free to Keep' })) });
  const offers = await source(fake).fetchOffers({});

  assert.equal(fake.calls.length, 1);
  assert.equal(offers.length, 1);
});

test('no browser automation is present in the source', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const file = path.join(process.cwd(), 'src', 'giveaways', 'providers', 'steamdb', 'index.js');
  // Comments legitimately name the techniques this module refuses to use, so
  // only executable code is inspected.
  const code = (await fs.readFile(file, 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  for (const forbidden of ['puppeteer', 'playwright', 'selenium', 'headless', 'cloudscraper', 'cf_clearance']) {
    assert.ok(!code.includes(forbidden), `the source references ${forbidden}`);
  }
});

/* -------------------------------------------------------------------------- */
/* Integration with the monitor                                                */
/* -------------------------------------------------------------------------- */

test('a Steam giveaway from SteamDB is announced once, then deduplicated', async () => {
  const html = page(row({ appId: '1245620', title: 'ELDEN RING', label: 'Free to Keep' }));
  const fake = transport({ status: 200, body: html });
  const posted = [];

  const store = {
    entries: new Map(),
    has(key) {
      return this.entries.has(key);
    },
    async load() {},
    async markAnnounced(giveaway) {
      this.entries.set(giveaway.key, giveaway);
    },
    async prune() {
      return 0;
    },
    get size() {
      return this.entries.size;
    },
  };

  const monitor = createGiveawayMonitor({
    providers: [new SteamProvider({ source: source(fake) })],
    store,
    notifier: {
      async announce(giveaway) {
        posted.push(giveaway.key);
        return true;
      },
    },
    // Inject the clock so the fixture's promotion window is "now" rather than
    // depending on the wall clock when the suite runs.
    now: () => NOW,
  });

  await monitor.checkNow();
  await monitor.checkNow();

  assert.deepEqual(posted, ['steam:1245620'], 'the giveaway was announced more than once');
});

test('a blocked SteamDB does not stop the cycle or the Epic provider', async () => {
  const blocked = transport({ status: 403, body: '' });
  const epic = {
    name: 'epic',
    label: 'Epic Games',
    async fetchGiveaways() {
      return [];
    },
  };
  const monitor = createGiveawayMonitor({
    providers: [epic, new SteamProvider({ source: source(blocked) })],
  });

  const result = await monitor.checkNow();

  assert.equal(result.skipped, false);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].provider, 'steam');
  assert.match(result.failures[0].reason, /refused the request/);
});

test('the recommended SteamDB interval is at least 30 minutes', () => {
  assert.equal(MIN_STEAMDB_INTERVAL_MINUTES, 30);
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
    const fake = transport({ status: 200, body: page(row({ appId: '1', title: 'A', label: 'Free to Keep' })) });
    await source(fake).fetchOffers({});
    parseSteamDbFree(page(row({ appId: '2', title: 'B', label: 'Free to Keep' })), { now: NOW });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(called, false);
});

test('the SteamDB source makes zero AI calls', async () => {
  const fake = transport({ status: 200, body: page(row({ appId: '1', title: 'A', label: 'Free to Keep' })) });
  const instance = source(fake);

  assert.deepEqual(Object.keys(instance).filter((key) => /ai|complet|prompt|model/i.test(key)), []);
  await instance.fetchOffers({});
});
