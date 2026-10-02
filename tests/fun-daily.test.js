import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DAILY_COINS,
  DAILY_ITEM_CHANCE,
  DAILY_ITEM_POOL,
  DAILY_XP,
  STREAK_GRACE_HOURS,
  claimDaily,
  dailyStatus,
  nextStreak,
  pickDailyItem,
  streakWindowMs,
} from '../src/fun/daily.js';
import { isItemKey } from '../src/fun/loot.js';
import { openFunDatabase } from '../src/fun/db.js';
import { createFunRepository } from '../src/fun/repository.js';
import { sequenceRandom } from './helpers/fake-interaction.js';

/**
 * /gunluk.
 *
 * The rolling window is measured in elapsed time, not a calendar day, so the
 * tests move the clock rather than the date - and a clock that moves backwards
 * must not cost the user a streak.
 */

const AT = 1_700_000_000_000;
const HOUR = 3_600_000;

function makeRepo() {
  const db = openFunDatabase({ file: ':memory:' });
  return { db, repo: createFunRepository({ db, now: () => AT }) };
}

const claim = (repo, random, options = {}) =>
  claimDaily({ repo, guildId: 'g1', userId: 'u1', now: AT, random, ...options });

/** coins, xp, then the item chance roll. */
const rolls = (coins = 0.5, xp = 0.5, chance = 0.99, item = 0.5) => sequenceRandom([coins, xp, chance, item]);

/* -------------------------------------------------------------------------- */
/* The streak rule                                                             */
/* -------------------------------------------------------------------------- */

test('a first claim starts a streak of one', () => {
  assert.deepEqual(nextStreak(null, AT, 0, streakWindowMs(20)), { streak: 1, change: 'started' });
  assert.deepEqual(nextStreak(0, AT, 5, streakWindowMs(20)), { streak: 1, change: 'started' });
});

test('claiming inside the window grows the streak', () => {
  const window = streakWindowMs(20);
  assert.deepEqual(nextStreak(AT, AT + HOUR, 3, window), { streak: 4, change: 'incremented' });
  assert.deepEqual(nextStreak(AT, AT + window, 3, window), { streak: 4, change: 'incremented' });
});

test('missing the window resets the streak to one', () => {
  const window = streakWindowMs(20);
  assert.deepEqual(nextStreak(AT, AT + window + 1, 9, window), { streak: 1, change: 'reset' });
});

test('the streak window is the cooldown plus a day of grace', () => {
  assert.equal(STREAK_GRACE_HOURS, 24);
  assert.equal(streakWindowMs(20), (20 + 24) * HOUR);
  assert.equal(streakWindowMs(0), 24 * HOUR);
});

test('a clock that moved backwards keeps the streak', () => {
  // Losing a streak to an NTP correction or a timezone change would be worse
  // than one extra claim.
  assert.deepEqual(nextStreak(AT, AT - 5 * HOUR, 6, streakWindowMs(20)), { streak: 7, change: 'incremented' });
});

test('the streak survives being stored and read back', () => {
  const { db, repo } = makeRepo();
  repo.ensureUser('g1', 'u1', AT);
  repo.recordDaily('g1', 'u1', { at: AT, streak: 12 });

  assert.equal(repo.getUser('g1', 'u1').dailyStreak, 12);
  db.close();
});

/* -------------------------------------------------------------------------- */
/* Claiming                                                                    */
/* -------------------------------------------------------------------------- */

test('a claim awards coins and XP from the configured ranges', () => {
  const { db, repo } = makeRepo();
  const result = claim(repo, rolls(0, 0));

  assert.equal(result.ok, true);
  assert.equal(result.coins, DAILY_COINS[0], 'the smallest chest changed');
  assert.equal(result.xp, DAILY_XP[0], 'the smallest chest changed');
  assert.equal(result.streak, 1);
  assert.equal(result.streakChange, 'started');

  const user = repo.getUser('g1', 'u1');
  assert.equal(user.coins, result.coins);
  assert.equal(user.xp, result.xp);
  assert.equal(user.dailyStreak, 1);
  assert.equal(user.lastDailyAt, AT, 'the cooldown stamp was not written');
  db.close();
});

test('the largest chest is bounded by the configured range', () => {
  const { db, repo } = makeRepo();
  const result = claim(repo, rolls(0.999999, 0.999999));

  assert.equal(result.coins, DAILY_COINS[1]);
  assert.equal(result.xp, DAILY_XP[1]);
  db.close();
});

test('a chest contains an item only when the chance roll wins', () => {
  const lucky = makeRepo();
  const withItem = claim(lucky.repo, rolls(0.5, 0.5, DAILY_ITEM_CHANCE - 0.01, 0));
  assert.ok(withItem.itemKey, 'a winning roll produced no item');
  assert.ok(isItemKey(withItem.itemKey));
  assert.deepEqual(lucky.repo.getInventory('g1', 'u1'), [{ itemKey: withItem.itemKey, quantity: 1 }]);
  lucky.db.close();

  const unlucky = makeRepo();
  const without = claim(unlucky.repo, rolls(0.5, 0.5, DAILY_ITEM_CHANCE, 0));
  assert.equal(without.itemKey, null, 'a losing roll produced an item');
  assert.deepEqual(unlucky.repo.getInventory('g1', 'u1'), []);
  unlucky.db.close();
});

test('every item the pool offers is one the game defines', () => {
  for (const entry of DAILY_ITEM_POOL) {
    assert.ok(isItemKey(entry.key), `${entry.key} is in the daily pool but not in the loot table`);
    assert.ok(entry.weight > 0);
  }

  const seen = new Set();
  for (let step = 0; step < 1000; step += 1) seen.add(pickDailyItem(() => step / 1000));
  for (const entry of DAILY_ITEM_POOL) assert.ok(seen.has(entry.key), `${entry.key} can never be drawn`);
});

/* -------------------------------------------------------------------------- */
/* Cooldown                                                                    */
/* -------------------------------------------------------------------------- */

test('a second claim is refused and leaves the account untouched', () => {
  const { db, repo } = makeRepo();
  assert.equal(claim(repo, rolls()).ok, true);

  const before = repo.getUser('g1', 'u1');
  const second = claim(repo, rolls());

  assert.equal(second.ok, false, 'the chest was claimed twice');
  assert.equal(second.reason, 'cooldown');
  assert.ok(second.remainingSeconds > 0);
  assert.equal(second.streak, 1, 'the refused claim reported the wrong streak');

  const after = repo.getUser('g1', 'u1');
  assert.equal(after.coins, before.coins, 'coins were granted during the cooldown');
  assert.equal(after.xp, before.xp, 'XP was granted during the cooldown');
  assert.equal(after.dailyStreak, before.dailyStreak);
  db.close();
});

test('a burst of clicks in the same tick claims exactly one chest', () => {
  const { db, repo } = makeRepo();
  const results = [];
  for (let index = 0; index < 5; index += 1) results.push(claim(repo, rolls()));

  assert.equal(results.filter((result) => result.ok).length, 1, 'more than one chest was claimed');
  assert.equal(repo.getUser('g1', 'u1').dailyStreak, 1, 'the streak advanced more than once');
  db.close();
});

test('claiming again after the cooldown grows the streak', () => {
  const { db, repo } = makeRepo();
  claim(repo, rolls());

  const later = AT + 21 * HOUR;
  const second = claimDaily({ repo, guildId: 'g1', userId: 'u1', now: later, random: rolls() });

  assert.equal(second.ok, true);
  assert.equal(second.streak, 2);
  assert.equal(second.streakChange, 'incremented');
  assert.equal(repo.getUser('g1', 'u1').dailyStreak, 2);
  db.close();
});

test('claiming after the whole window has lapsed resets the streak', () => {
  const { db, repo } = makeRepo();
  repo.ensureUser('g1', 'u1', AT);
  repo.recordDaily('g1', 'u1', { at: AT, streak: 9 });

  const tooLate = AT + streakWindowMs(20) + 1;
  const result = claimDaily({ repo, guildId: 'g1', userId: 'u1', now: tooLate, random: rolls() });

  assert.equal(result.ok, true);
  assert.equal(result.streak, 1);
  assert.equal(result.streakChange, 'reset');
  db.close();
});

test('the cooldown is per user and per guild', () => {
  const { db, repo } = makeRepo();
  claim(repo, rolls());

  assert.equal(claimDaily({ repo, guildId: 'g1', userId: 'u2', now: AT, random: rolls() }).ok, true);
  assert.equal(claimDaily({ repo, guildId: 'g2', userId: 'u1', now: AT, random: rolls() }).ok, true);
  assert.equal(claim(repo, rolls()).ok, false);
  db.close();
});

test('dailyStatus reports the timer without claiming', () => {
  const { db, repo } = makeRepo();
  claim(repo, rolls());

  const status = dailyStatus({ repo, guildId: 'g1', userId: 'u1', now: AT + 4 * HOUR });
  assert.equal(status.ready, false);
  assert.equal(status.remainingSeconds, 16 * 3600);
  assert.equal(status.streak, 1);
  assert.equal(repo.getUser('g1', 'u1').dailyStreak, 1, 'reading the status claimed a chest');

  assert.equal(dailyStatus({ repo, guildId: 'g1', userId: 'nobody', now: AT }).ready, true);
  db.close();
});

test('a clock that moved backwards does not reset the streak', () => {
  const { db, repo } = makeRepo();
  repo.ensureUser('g1', 'u1', AT);
  repo.recordDaily('g1', 'u1', { at: AT, streak: 4 });

  const result = claimDaily({ repo, guildId: 'g1', userId: 'u1', now: AT - 2 * HOUR, random: rolls() });
  assert.equal(result.ok, true, 'a backwards clock blocked the claim');
  assert.equal(result.streak, 5, 'a backwards clock reset the streak');
  db.close();
});
