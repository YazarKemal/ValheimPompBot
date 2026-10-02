import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPassiveXp, DEFAULT_MESSAGE_XP_COOLDOWN_SECONDS, MESSAGE_XP_RANGE } from '../src/fun/passive-xp.js';
import { openFunDatabase } from '../src/fun/db.js';
import { createFunRepository } from '../src/fun/repository.js';
import { sequenceRandom } from './helpers/fake-interaction.js';

/**
 * Activity XP.
 *
 * Two properties are load-bearing and are tested against the real database:
 * a message costs no write while the cooldown is running, and the message body
 * is never touched - which is what lets PompAI award this without holding the
 * privileged Message Content intent.
 */

const AT = 1_700_000_000_000;

function message(overrides = {}) {
  return {
    id: 'm1',
    guildId: 'g1',
    channelId: 'c1',
    author: { id: 'u1', bot: false },
    ...overrides,
  };
}

/** Counts the writes a message causes. */
function countingRepo(repo) {
  const counts = { transactions: 0, ensureUser: 0, applyReward: 0 };
  return {
    counts,
    transaction: (fn) => {
      counts.transactions += 1;
      return repo.transaction(fn);
    },
    ensureUser: (...args) => {
      counts.ensureUser += 1;
      return repo.ensureUser(...args);
    },
    applyReward: (...args) => {
      counts.applyReward += 1;
      return repo.applyReward(...args);
    },
  };
}

function setup(options = {}) {
  const db = openFunDatabase({ file: ':memory:' });
  const repo = createFunRepository({ db, now: () => AT });
  let clock = AT;
  const spy = countingRepo(repo);
  const xp = createPassiveXp({
    repo: spy,
    now: () => clock,
    random: sequenceRandom([0, 1]),
    ...options,
  });
  return { db, repo, spy, xp, setNow: (value) => { clock = value; }, advance: (ms) => { clock += ms; } };
}

/* -------------------------------------------------------------------------- */
/* Awarding                                                                    */
/* -------------------------------------------------------------------------- */

test('an ordinary message awards XP inside the configured range', () => {
  const { db, repo, xp } = setup();

  const result = xp.handle(message());
  assert.equal(result.awarded, true);
  assert.equal(result.xp, MESSAGE_XP_RANGE[0], 'the smallest award changed');

  assert.equal(repo.getUser('g1', 'u1').xp, MESSAGE_XP_RANGE[0]);
  db.close();
});

test('the largest award is bounded by the configured range', () => {
  const db = openFunDatabase({ file: ':memory:' });
  const repo = createFunRepository({ db, now: () => AT });
  const xp = createPassiveXp({ repo, now: () => AT, random: () => 0.999999 });

  const result = xp.handle(message());
  assert.equal(result.xp, MESSAGE_XP_RANGE[1]);
  db.close();
});

test('a level-up from a message is reported but never announced', () => {
  const { db, repo, xp } = setup();
  repo.ensureUser('g1', 'u1', AT);
  repo.applyReward('g1', 'u1', { xp: 59, at: AT });

  const result = xp.handle(message());
  assert.equal(result.leveledUp, true, 'crossing a level threshold was not reported');
  assert.equal(repo.getUser('g1', 'u1').xp, 59 + result.xp);
  db.close();
});

/* -------------------------------------------------------------------------- */
/* Cooldown, and the writes it avoids                                          */
/* -------------------------------------------------------------------------- */

test('a second message inside the cooldown awards nothing and writes nothing', () => {
  const { db, repo, spy, xp, advance } = setup();

  xp.handle(message());
  const afterFirst = { ...repo.getUser('g1', 'u1') };
  const writesAfterFirst = { ...spy.counts };

  advance(59_000);
  const blocked = xp.handle(message());

  assert.equal(blocked.awarded, false, 'the cooldown did not hold');
  assert.equal(blocked.reason, 'cooldown');
  assert.deepEqual(spy.counts, writesAfterFirst, 'a message inside the cooldown reached the database');
  assert.deepEqual({ ...repo.getUser('g1', 'u1') }, afterFirst, 'the account changed inside the cooldown');
  db.close();
});

test('a burst of spam costs exactly one write', () => {
  const { db, spy, xp } = setup();

  for (let index = 0; index < 50; index += 1) xp.handle(message());

  assert.equal(spy.counts.applyReward, 1, `50 messages caused ${spy.counts.applyReward} writes`);
  assert.equal(spy.counts.transactions, 1);
  assert.equal(spy.counts.ensureUser, 1);
  db.close();
});

test('the award is allowed again once the cooldown has passed', () => {
  const { db, repo, xp, advance } = setup();

  xp.handle(message());
  advance(59_999);
  assert.equal(xp.handle(message()).awarded, false);
  advance(1);
  assert.equal(xp.handle(message()).awarded, true, 'the cooldown never expired');

  assert.equal(repo.getUser('g1', 'u1').xp, MESSAGE_XP_RANGE[0] + MESSAGE_XP_RANGE[1]);
  db.close();
});

test('the cooldown is configurable and zero awards every message', () => {
  const { db, spy, xp } = setup({ cooldownSeconds: 0 });

  assert.equal(xp.handle(message()).awarded, true);
  assert.equal(xp.handle(message()).awarded, true);
  assert.equal(spy.counts.applyReward, 2);
  assert.equal(DEFAULT_MESSAGE_XP_COOLDOWN_SECONDS, 60);
  db.close();
});

test('the cooldown is per user and per guild', () => {
  const { db, xp } = setup();

  assert.equal(xp.handle(message()).awarded, true);
  assert.equal(xp.handle(message({ author: { id: 'u2', bot: false } })).awarded, true, 'another user was blocked');
  assert.equal(xp.handle(message({ guildId: 'g2' })).awarded, true, 'another guild was blocked');
  assert.equal(xp.handle(message()).awarded, false, 'the original user was not blocked');
  db.close();
});

test('the cooldown map stays bounded under many users', () => {
  const { db, xp } = setup({ maxTracked: 10 });

  for (let index = 0; index < 200; index += 1) {
    xp.handle(message({ author: { id: `u${index}`, bot: false } }));
  }
  assert.ok(xp.trackedCount <= 10, `the cooldown map grew to ${xp.trackedCount}`);

  xp.reset();
  assert.equal(xp.trackedCount, 0);
  db.close();
});

/* -------------------------------------------------------------------------- */
/* Who does not earn                                                           */
/* -------------------------------------------------------------------------- */

test('a bot message never earns XP', () => {
  const { db, spy, xp } = setup();
  const result = xp.handle(message({ author: { id: 'bot1', bot: true } }));

  assert.equal(result.awarded, false);
  assert.equal(result.reason, 'bot');
  assert.equal(spy.counts.applyReward, 0, 'a bot message reached the database');
  db.close();
});

test('a webhook-shaped message with no bot flag but a bot author id is still just a message', () => {
  // Discord marks webhook messages with `webhookId`; they carry a bot author.
  const { db, xp } = setup();
  const result = xp.handle(message({ webhookId: 'w1', author: { id: 'w1', bot: true } }));
  assert.equal(result.awarded, false);
  db.close();
});

test('a system message never earns XP', () => {
  const { db, xp } = setup();
  const result = xp.handle(message({ system: true }));

  assert.equal(result.awarded, false);
  assert.equal(result.reason, 'system');
  db.close();
});

test('a message with no guild is ignored, so nothing is written outside a server', () => {
  const { db, spy, xp } = setup();
  const result = xp.handle({ id: 'm1', guildId: null, author: { id: 'u1', bot: false } });

  assert.equal(result.awarded, false);
  assert.equal(result.reason, 'no-identity');
  assert.equal(spy.counts.applyReward, 0, 'a DM-shaped message reached the database');
  db.close();
});

test('a missing user or message is ignored rather than throwing', () => {
  const { db, xp } = setup();
  assert.equal(xp.handle(null).awarded, false);
  assert.equal(xp.handle({ guildId: 'g1' }).awarded, false);
  assert.equal(xp.handle({ guildId: 'g1', author: {} }).awarded, false);
  db.close();
});

test('disabling the feature stops every award', () => {
  const { db, spy, xp } = setup({ enabled: false });

  assert.equal(xp.handle(message()).awarded, false);
  assert.equal(xp.handle(message()).reason, 'disabled');
  assert.equal(spy.counts.applyReward, 0);
  db.close();
});

/* -------------------------------------------------------------------------- */
/* Content is never touched                                                    */
/* -------------------------------------------------------------------------- */

test('the message body is never read', () => {
  const { db, repo, xp } = setup();
  const hostile = message();
  // Reading the body is the one thing this feature must not do. A getter that
  // throws proves nothing touches it.
  Object.defineProperty(hostile, 'content', {
    get() {
      throw new Error('the message content was read');
    },
    enumerable: true,
  });

  const result = xp.handle(hostile);
  assert.equal(result.awarded, true, 'the award was skipped for the wrong reason');
  assert.equal(repo.getUser('g1', 'u1').xp, MESSAGE_XP_RANGE[0]);
  db.close();
});

test('nothing resembling a message body is stored', () => {
  const { db, xp } = setup();
  xp.handle(message());

  const columns = db
    .prepare('SELECT name FROM pragma_table_info(?)')
    .all('guild_users')
    .map((row) => row.name);

  for (const column of columns) {
    assert.ok(!/content|message|text|body/i.test(column), `guild_users stores a column named "${column}"`);
  }

  // And the only rows in the database are counters and timestamps.
  const row = db.prepare('SELECT * FROM guild_users').get();
  for (const [key, value] of Object.entries(row)) {
    if (value === null) continue; // an untouched timestamp
    assert.ok(typeof value === 'number' || typeof value === 'string', `${key} holds something unexpected`);
    if (typeof value === 'string') {
      assert.ok(['g1', 'u1'].includes(value), `a column holds text that is not an id: ${key}`);
    }
  }
  db.close();
});
