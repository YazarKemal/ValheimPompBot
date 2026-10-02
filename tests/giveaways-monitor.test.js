import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GiveawayStore } from '../src/giveaways/store.js';
import { createGiveawayMonitor, MIN_INTERVAL_MINUTES } from '../src/giveaways/monitor.js';
import { normaliseGiveaway, GIVEAWAY_KINDS } from '../src/giveaways/provider.js';
import { createCapturingLogger } from '../src/utils/logger.js';

const NOW = new Date('2026-10-03T12:00:00.000Z').getTime();

function giveaway(id, overrides = {}) {
  return normaliseGiveaway({
    provider: 'epic',
    id,
    title: `Game ${id}`,
    platform: 'Epic Games',
    kind: GIVEAWAY_KINDS.EPIC_GIVEAWAY,
    endsAt: '2026-10-08T15:00:00.000Z',
    ...overrides,
  });
}

/** A provider stub with a programmable result. */
function provider(name, result, { delayMs = 0, error = null } = {}) {
  const calls = [];
  return {
    name,
    label: name,
    calls,
    async fetchGiveaways({ signal } = {}) {
      calls.push({ at: Date.now() });
      if (delayMs > 0) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, delayMs);
          signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            const abort = new Error('aborted');
            abort.name = 'AbortError';
            reject(abort);
          });
        });
      }
      if (error) throw error;
      return typeof result === 'function' ? result() : result;
    },
  };
}

async function tempStore(overrides = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'pompbot-giveaways-'));
  return new GiveawayStore({
    filePath: path.join(directory, 'giveaways.json'),
    now: () => NOW,
    ...overrides,
  });
}

/** Records announcements without touching Discord. */
function notifier({ fail = false } = {}) {
  const announced = [];
  return {
    announced,
    async announce(item) {
      if (fail) throw new Error('channel exploded');
      announced.push(item.key);
      return true;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Deduplication                                                               */
/* -------------------------------------------------------------------------- */

test('a giveaway is announced once, not on every cycle', async () => {
  const store = await tempStore();
  const sink = notifier();
  const monitor = createGiveawayMonitor({
    providers: [provider('epic', [giveaway('a'), giveaway('b')])],
    store,
    notifier: sink,
    now: () => NOW,
  });

  const first = await monitor.checkNow();
  const second = await monitor.checkNow();

  assert.equal(first.announced.length, 2);
  assert.equal(second.announced.length, 0, 'the same giveaways were announced twice');
  assert.deepEqual(sink.announced.sort(), ['epic:a', 'epic:b']);
});

test('the dedup key includes the provider, so two stores are two announcements', async () => {
  const store = await tempStore();
  const sink = notifier();
  const monitor = createGiveawayMonitor({
    providers: [
      provider('epic', [giveaway('same-id')]),
      provider('steam', [giveaway('same-id', { provider: 'steam', kind: GIVEAWAY_KINDS.FREE_TO_KEEP })]),
    ],
    store,
    notifier: sink,
    now: () => NOW,
  });

  await monitor.checkNow();

  assert.deepEqual(sink.announced.sort(), ['epic:same-id', 'steam:same-id']);
});

test('a new giveaway appearing later is still announced', async () => {
  const store = await tempStore();
  const sink = notifier();
  let current = [giveaway('a')];
  const monitor = createGiveawayMonitor({
    providers: [provider('epic', () => current)],
    store,
    notifier: sink,
    now: () => NOW,
  });

  await monitor.checkNow();
  current = [giveaway('a'), giveaway('b')];
  const second = await monitor.checkNow();

  assert.deepEqual(second.announced.map((entry) => entry.key), ['epic:b']);
});

test('a duplicate within one payload is announced once', async () => {
  const store = await tempStore();
  const sink = notifier();
  const monitor = createGiveawayMonitor({
    providers: [provider('epic', [giveaway('a'), giveaway('a')])],
    store,
    notifier: sink,
    now: () => NOW,
  });

  await monitor.checkNow();

  assert.deepEqual(sink.announced, ['epic:a']);
});

test('an expired giveaway is never announced', async () => {
  const store = await tempStore();
  const sink = notifier();
  const monitor = createGiveawayMonitor({
    providers: [provider('epic', [giveaway('old', { endsAt: '2026-10-01T00:00:00.000Z' })])],
    store,
    notifier: sink,
    now: () => NOW,
  });

  const result = await monitor.checkNow();

  assert.equal(result.announced.length, 0);
  assert.equal(result.active, 0);
});

/* -------------------------------------------------------------------------- */
/* Persistence                                                                 */
/* -------------------------------------------------------------------------- */

test('state survives a restart - a new store still knows what was announced', async () => {
  const store = await tempStore();
  const monitor = createGiveawayMonitor({
    providers: [provider('epic', [giveaway('a')])],
    store,
    notifier: notifier(),
    now: () => NOW,
  });
  await monitor.checkNow();

  // Restart: a brand new store reading the same file.
  const reopened = new GiveawayStore({ filePath: store.filePath, now: () => NOW });
  await reopened.load();

  assert.equal(reopened.has('epic:a'), true, 'the announcement was forgotten across a restart');

  const sink = notifier();
  const afterRestart = createGiveawayMonitor({
    providers: [provider('epic', [giveaway('a')])],
    store: reopened,
    notifier: sink,
    now: () => NOW,
  });
  await afterRestart.checkNow();

  assert.deepEqual(sink.announced, [], 'everything was re-announced after a restart');
});

test('the state file is valid JSON and written atomically', async () => {
  const store = await tempStore();
  await store.markAnnounced(giveaway('a'));

  const raw = await readFile(store.filePath, 'utf8');
  const parsed = JSON.parse(raw);

  assert.equal(parsed.version, 1);
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].key, 'epic:a');
  assert.equal(parsed.entries[0].provider, 'epic');
  assert.equal(parsed.entries[0].id, 'a');
  assert.equal(parsed.entries[0].announcedAt, new Date(NOW).toISOString());
});

test('no temporary file is left behind', async () => {
  const store = await tempStore();
  await store.markAnnounced(giveaway('a'));

  const directory = path.dirname(store.filePath);
  const entries = await readFile(store.filePath, 'utf8');
  assert.ok(entries.length > 0);
  const files = await import('node:fs/promises').then((fs) => fs.readdir(directory));
  assert.deepEqual(files, ['giveaways.json'], `leftover files: ${files.join(', ')}`);
});

test('a missing state file loads as empty', async () => {
  const store = await tempStore();
  await store.load();

  assert.equal(store.size, 0);
});

test('a corrupt state file is survivable, not fatal', async () => {
  const store = await tempStore();
  await writeFile(store.filePath, '{ this is not json', 'utf8');

  await assert.doesNotReject(() => store.load());
  assert.equal(store.size, 0);

  // And it can still be written to afterwards.
  await store.markAnnounced(giveaway('a'));
  assert.equal(JSON.parse(await readFile(store.filePath, 'utf8')).entries.length, 1);
});

/* -------------------------------------------------------------------------- */
/* Pruning                                                                     */
/* -------------------------------------------------------------------------- */

test('entries whose giveaway ended long ago are pruned', async () => {
  const store = await tempStore({ retentionDays: 30 });
  await store.markAnnounced(giveaway('recent', { endsAt: '2026-10-08T00:00:00.000Z' }));
  await store.markAnnounced(giveaway('ancient', { endsAt: '2026-01-01T00:00:00.000Z' }));

  const dropped = await store.prune();

  assert.equal(dropped, 1);
  assert.equal(store.has('epic:recent'), true);
  assert.equal(store.has('epic:ancient'), false);
});

test('an entry with no end date is never pruned', async () => {
  const store = await tempStore({ retentionDays: 1 });
  await store.markAnnounced(giveaway('undated', { endsAt: null }));

  assert.equal(await store.prune(), 0);
  assert.equal(store.has('epic:undated'), true);
});

test('pruning persists the trimmed state', async () => {
  const store = await tempStore({ retentionDays: 30 });
  await store.markAnnounced(giveaway('ancient', { endsAt: '2026-01-01T00:00:00.000Z' }));
  await store.prune();

  const reopened = new GiveawayStore({ filePath: store.filePath, now: () => NOW });
  await reopened.load();

  assert.equal(reopened.size, 0);
});

test('a pruned giveaway can be announced again if it returns', async () => {
  const store = await tempStore({ retentionDays: 30 });
  const sink = notifier();
  const monitor = createGiveawayMonitor({
    providers: [provider('epic', [giveaway('a', { endsAt: '2026-01-01T00:00:00.000Z' })])],
    store,
    notifier: sink,
    now: () => NOW,
  });

  await store.load();
  await store.markAnnounced(giveaway('a', { endsAt: '2026-01-01T00:00:00.000Z' }));
  await store.prune();

  const future = createGiveawayMonitor({
    providers: [provider('epic', [giveaway('a')])],
    store,
    notifier: sink,
    now: () => NOW,
  });
  await future.checkNow();

  assert.deepEqual(sink.announced, ['epic:a']);
  assert.ok(monitor);
});

/* -------------------------------------------------------------------------- */
/* Concurrency and failure isolation                                           */
/* -------------------------------------------------------------------------- */

test('a second cycle cannot start while one is in flight', async () => {
  const store = await tempStore();
  const slow = provider('epic', [giveaway('a')], { delayMs: 60 });
  const monitor = createGiveawayMonitor({
    providers: [slow],
    store,
    notifier: notifier(),
    now: () => NOW,
  });

  const [first, second] = await Promise.all([monitor.checkNow(), monitor.checkNow()]);

  const skipped = [first, second].filter((result) => result.skipped);
  assert.equal(skipped.length, 1, 'both cycles ran concurrently');
  assert.equal(slow.calls.length, 1, `the provider was called ${slow.calls.length} times`);
});

test('a failing provider does not stop the healthy one', async () => {
  const store = await tempStore();
  const sink = notifier();
  const monitor = createGiveawayMonitor({
    providers: [
      provider('epic', null, { error: new Error('epic is down') }),
      provider('steam', [giveaway('s1', { provider: 'steam', kind: GIVEAWAY_KINDS.FREE_TO_KEEP })]),
    ],
    store,
    notifier: sink,
    now: () => NOW,
  });

  const result = await monitor.checkNow();

  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].provider, 'epic');
  assert.deepEqual(sink.announced, ['steam:s1']);
});

test('a provider that never answers is aborted by the timeout', async () => {
  const store = await tempStore();
  const hanging = provider('epic', null, { delayMs: 5000 });
  const { logger, text } = createCapturingLogger({ level: 'debug' });
  const monitor = createGiveawayMonitor({
    providers: [hanging],
    store,
    notifier: notifier(),
    logger,
    timeoutMs: 40,
    now: () => NOW,
  });

  const result = await monitor.checkNow();

  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].reason, /timed out/);
  assert.match(text(), /timed out/);
});

test('every provider failing still yields a clean empty result', async () => {
  const store = await tempStore();
  const monitor = createGiveawayMonitor({
    providers: [
      provider('epic', null, { error: new Error('down') }),
      provider('steam', null, { error: new Error('also down') }),
    ],
    store,
    notifier: notifier(),
    now: () => NOW,
  });

  const result = await monitor.checkNow();

  assert.equal(result.skipped, false);
  assert.deepEqual(result.announced, []);
  assert.equal(result.failures.length, 2);
});

test('a failing notifier does not abort the cycle', async () => {
  const store = await tempStore();
  const { logger, text } = createCapturingLogger({ level: 'debug' });
  const monitor = createGiveawayMonitor({
    providers: [provider('epic', [giveaway('a'), giveaway('b')])],
    store,
    notifier: notifier({ fail: true }),
    logger,
    now: () => NOW,
  });

  const result = await monitor.checkNow();

  assert.deepEqual(result.announced, []);
  assert.equal(result.skipped, false, 'the cycle aborted');

  // Nothing is recorded when the post failed, so the next cycle retries it.
  // Recording it here would lose the announcement silently.
  assert.equal(store.has('epic:a'), false);
  assert.equal(store.has('epic:b'), false);
  assert.match(text(), /will be retried/);
});

test('a post that failed once succeeds on the next cycle', async () => {
  const store = await tempStore();
  let healthy = false;
  const sink = {
    announced: [],
    async announce(item) {
      if (!healthy) throw new Error('channel unavailable');
      sink.announced.push(item.key);
      return true;
    },
  };
  const monitor = createGiveawayMonitor({
    providers: [provider('epic', [giveaway('a')])],
    store,
    notifier: sink,
    now: () => NOW,
  });

  await monitor.checkNow();
  healthy = true;
  const retry = await monitor.checkNow();

  assert.deepEqual(sink.announced, ['epic:a']);
  assert.equal(retry.announced.length, 1);
});

/* -------------------------------------------------------------------------- */
/* Scheduling                                                                  */
/* -------------------------------------------------------------------------- */

test('the interval floor is enforced', () => {
  const monitor = createGiveawayMonitor({ providers: [], intervalMinutes: 1, now: () => NOW });

  assert.equal(monitor.status().intervalMinutes, MIN_INTERVAL_MINUTES);
  assert.equal(MIN_INTERVAL_MINUTES, 15);
});

test('start runs an immediate cycle and stop clears the timer', async () => {
  const store = await tempStore();
  const epic = provider('epic', [giveaway('a')]);
  const monitor = createGiveawayMonitor({
    providers: [epic],
    store,
    notifier: notifier(),
    intervalMinutes: 60,
    now: () => NOW,
  });

  assert.equal(monitor.start(), true);
  assert.equal(monitor.isRunning(), true);
  assert.equal(monitor.start(), false, 'start() ran twice');

  await monitor.whenIdle();
  assert.ok(epic.calls.length >= 1, 'no startup cycle ran');

  assert.equal(monitor.stop(), true);
  assert.equal(monitor.isRunning(), false);
  assert.equal(monitor.stop(), false);
});

test('status reports the monitor state without leaking anything', async () => {
  const store = await tempStore();
  const monitor = createGiveawayMonitor({
    providers: [provider('epic', [])],
    store,
    notifier: notifier(),
    now: () => NOW,
  });

  const status = monitor.status();

  assert.equal(status.running, false);
  assert.equal(status.inFlight, false);
  assert.deepEqual(status.providers, ['epic']);
  assert.equal(status.announcedKeys, 0);
});

/* -------------------------------------------------------------------------- */
/* No AI, ever                                                                 */
/* -------------------------------------------------------------------------- */

test('polling makes zero AI calls', async () => {
  const store = await tempStore();

  // Deliberately absent from the monitor's options: there is no AI client to
  // call. This asserts that a cycle completes without one.
  const monitor = createGiveawayMonitor({
    providers: [provider('epic', [giveaway('a')])],
    store,
    notifier: notifier(),
    now: () => NOW,
  });

  const result = await monitor.checkNow();

  assert.equal(result.announced.length, 1);
  assert.deepEqual(Object.keys(monitor).filter((key) => /ai|complet|prompt/i.test(key)), []);
});
