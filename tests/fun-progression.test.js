import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_LEVEL,
  TITLES,
  formatNumber,
  levelFromXp,
  levelProgress,
  titleForLevel,
  xpToReach,
} from '../src/fun/levels.js';
import { buildLeaderboard, buildProfile, rankOf } from '../src/fun/profile.js';
import { openFunDatabase } from '../src/fun/db.js';
import { createFunRepository } from '../src/fun/repository.js';

/**
 * Levels, titles, the profile and the leaderboard.
 *
 * The curve is a pure function, so it is checked exactly rather than sampled:
 * a change to a threshold silently rebalances every account, and that should
 * break a test rather than a user's expectations.
 */

const AT = 1_700_000_000_000;

function makeRepo() {
  const db = openFunDatabase({ file: ':memory:' });
  return { db, repo: createFunRepository({ db, now: () => AT }) };
}

/* -------------------------------------------------------------------------- */
/* The curve                                                                   */
/* -------------------------------------------------------------------------- */

test('level 1 starts at zero XP', () => {
  assert.equal(xpToReach(1), 0);
  assert.equal(levelFromXp(0), 1);
  assert.equal(levelFromXp(-5), 1);
  assert.equal(levelFromXp(Number.NaN), 1);
});

test('the curve rises and never repeats a value', () => {
  let previous = -1;
  for (let level = 1; level <= MAX_LEVEL; level += 1) {
    const required = xpToReach(level);
    assert.ok(required > previous, `level ${level} costs ${required}, which is not more than ${previous}`);
    previous = required;
  }
});

test('the thresholds are the ones the profile examples use', () => {
  assert.equal(xpToReach(2), 60);
  assert.equal(xpToReach(5), 420);
  assert.equal(xpToReach(10), 1620);
  assert.equal(xpToReach(12), 2310);
  assert.equal(xpToReach(20), 6270);
  assert.equal(xpToReach(50), 38220);
});

test('a level begins exactly at its threshold and ends one XP short of the next', () => {
  for (const level of [1, 2, 5, 10, 20, 35, 50]) {
    assert.equal(levelFromXp(xpToReach(level)), level, `XP ${xpToReach(level)} did not land on level ${level}`);
    if (level < MAX_LEVEL) {
      assert.equal(levelFromXp(xpToReach(level + 1) - 1), level, `one XP below level ${level + 1} was not level ${level}`);
      assert.equal(levelFromXp(xpToReach(level + 1)), level + 1);
    }
  }
});

test('the example profile numbers resolve as the brief shows', () => {
  assert.equal(levelFromXp(2430), 12);
  assert.equal(titleForLevel(12), 'Usta Kazmacı');
  assert.equal(formatNumber(2430), '2,430');
  assert.equal(formatNumber(4820), '4,820');
});

test('the level is capped, so the curve cannot run away', () => {
  assert.equal(levelFromXp(xpToReach(MAX_LEVEL) + 10_000_000), MAX_LEVEL);

  const maxed = levelProgress(xpToReach(MAX_LEVEL) + 10_000_000);
  assert.equal(maxed.maxed, true);
  assert.equal(maxed.toNextLevel, 0);
  assert.equal(maxed.ratio, 1);
});

test('every title threshold is reachable and ordered', () => {
  let previous = 0;
  for (const entry of TITLES) {
    assert.ok(entry.level > previous, `title "${entry.title}" is out of order`);
    previous = entry.level;
    assert.equal(titleForLevel(entry.level), entry.title);
  }

  assert.equal(titleForLevel(1), 'Çaylak Madenci');
  assert.equal(titleForLevel(4), 'Çaylak Madenci');
  assert.equal(titleForLevel(5), 'Kazmacı');
  assert.equal(titleForLevel(9), 'Kazmacı');
  assert.equal(titleForLevel(10), 'Usta Kazmacı');
  assert.equal(titleForLevel(19), 'Usta Kazmacı');
  assert.equal(titleForLevel(20), 'Maden Ustası');
  assert.equal(titleForLevel(35), 'Cevher Baronu');
  assert.equal(titleForLevel(50), 'Yeraltı Lordu');
  assert.equal(titleForLevel(90), 'Yeraltı Lordu');
});

test('progress within a level adds up', () => {
  const progress = levelProgress(2310 + 100);

  assert.equal(progress.level, 12);
  assert.equal(progress.intoLevel, 100);
  assert.equal(progress.levelSpan, xpToReach(13) - xpToReach(12));
  assert.equal(progress.toNextLevel, progress.levelSpan - 100);
  assert.ok(progress.ratio > 0 && progress.ratio < 1);
  assert.equal(progress.xp, 2410);
});

test('numbers are formatted identically regardless of host locale', () => {
  assert.equal(formatNumber(0), '0');
  assert.equal(formatNumber(7), '7');
  assert.equal(formatNumber(999), '999');
  assert.equal(formatNumber(1000), '1,000');
  assert.equal(formatNumber(1234567), '1,234,567');
  assert.equal(formatNumber(-2500), '-2,500');
  assert.equal(formatNumber(12.7), '12');
  assert.equal(formatNumber(null), '0');
  assert.equal(formatNumber('nonsense'), '0');
});

/* -------------------------------------------------------------------------- */
/* Profile                                                                     */
/* -------------------------------------------------------------------------- */

test('a miner who has never dug still has a profile', () => {
  const { db, repo } = makeRepo();
  const profile = buildProfile({ repo, guildId: 'g1', userId: 'new', displayName: 'Yeni' });

  assert.equal(profile.exists, false);
  assert.equal(profile.level, 1);
  assert.equal(profile.title, 'Çaylak Madenci');
  assert.equal(profile.xp, 0);
  assert.equal(profile.coins, 0);
  assert.equal(profile.mines, 0);
  assert.deepEqual(profile.inventory, []);
  db.close();
});

test('the profile reports what the account actually holds', () => {
  const { db, repo } = makeRepo();
  repo.ensureUser('g1', 'u1', AT);
  repo.applyReward('g1', 'u1', { xp: 2430, coins: 4820, at: AT });
  repo.recordMine('g1', 'u1', { at: AT, rare: true });
  repo.recordMine('g1', 'u1', { at: AT, rare: false });
  repo.recordDaily('g1', 'u1', { at: AT, streak: 6 });

  const profile = buildProfile({ repo, guildId: 'g1', userId: 'u1', displayName: 'kemal' });

  assert.equal(profile.exists, true);
  assert.equal(profile.displayName, 'kemal');
  assert.equal(profile.level, 12);
  assert.equal(profile.title, 'Usta Kazmacı');
  assert.equal(profile.xp, 2430);
  assert.equal(profile.coins, 4820);
  assert.equal(profile.mines, 2);
  assert.equal(profile.rareFinds, 1);
  assert.equal(profile.streak, 6);
  db.close();
});

test('the profile never reads another guild\'s account', () => {
  const { db, repo } = makeRepo();
  repo.ensureUser('g2', 'u1', AT);
  repo.applyReward('g2', 'u1', { xp: 9999, coins: 9999, at: AT });

  const profile = buildProfile({ repo, guildId: 'g1', userId: 'u1' });
  assert.equal(profile.xp, 0, 'a profile crossed a guild boundary');
  assert.equal(profile.coins, 0);
  db.close();
});

test('the inventory is listed rarest first', () => {
  const { db, repo } = makeRepo();
  repo.ensureUser('g1', 'u1', AT);
  repo.addItem('g1', 'u1', 'tas', 50, AT);
  repo.addItem('g1', 'u1', 'nugget', 1, AT);
  repo.addItem('g1', 'u1', 'elmas', 2, AT);
  repo.addItem('g1', 'u1', 'demir', 5, AT);

  const profile = buildProfile({ repo, guildId: 'g1', userId: 'u1' });
  assert.deepEqual(
    profile.inventory.map((entry) => entry.itemKey),
    ['nugget', 'elmas', 'demir', 'tas'],
    'the inventory should list the rarest find first',
  );
  assert.equal(profile.inventory.find((entry) => entry.itemKey === 'nugget').quantity, 1);
  assert.ok(profile.inventory.every((entry) => entry.label.includes(' ')), 'an item has no label');
  db.close();
});

/* -------------------------------------------------------------------------- */
/* Leaderboard                                                                 */
/* -------------------------------------------------------------------------- */

test('the leaderboard is ranked by XP, one guild at a time', () => {
  const { db, repo } = makeRepo();
  const accounts = [
    ['g1', 'a', 500],
    ['g1', 'b', 1500],
    ['g1', 'c', 100],
    ['g2', 'z', 99999],
  ];
  for (const [guildId, userId, xp] of accounts) {
    repo.ensureUser(guildId, userId, AT);
    repo.applyReward(guildId, userId, { xp, at: AT });
  }

  const board = buildLeaderboard({ repo, guildId: 'g1', limit: 10 });

  assert.deepEqual(board.map((row) => row.userId), ['b', 'a', 'c'], 'the board is not ordered by XP');
  assert.deepEqual(board.map((row) => row.rank), [1, 2, 3], 'ranks are not 1-based and contiguous');
  assert.deepEqual(board.map((row) => row.xp), [1500, 500, 100]);
  assert.ok(!board.some((row) => row.userId === 'z'), 'another guild\'s user appeared on the board');
  db.close();
});

test('the leaderboard shows a level and a title for every row', () => {
  const { db, repo } = makeRepo();
  repo.ensureUser('g1', 'u1', AT);
  repo.applyReward('g1', 'u1', { xp: 2310, at: AT });

  const [row] = buildLeaderboard({ repo, guildId: 'g1' });
  assert.equal(row.level, 12);
  assert.equal(row.title, 'Usta Kazmacı');
  db.close();
});

test('the leaderboard resolves display names when it can', () => {
  const { db, repo } = makeRepo();
  repo.ensureUser('g1', 'u1', AT);

  const [named] = buildLeaderboard({ repo, guildId: 'g1', resolveName: (id) => (id === 'u1' ? 'Kemal' : null) });
  assert.equal(named.displayName, 'Kemal');

  const [fallback] = buildLeaderboard({ repo, guildId: 'g1', resolveName: () => null });
  assert.equal(fallback.displayName, null, 'a missing name should stay missing, not become a placeholder');
  db.close();
});

test('an empty guild has an empty board', () => {
  const { db, repo } = makeRepo();
  assert.deepEqual(buildLeaderboard({ repo, guildId: 'nobody' }), []);
  db.close();
});

test('a rank is found for a user on their own board and nowhere else', () => {
  const { db, repo } = makeRepo();
  for (const [userId, xp] of [['a', 300], ['b', 200], ['c', 100]]) {
    repo.ensureUser('g1', userId, AT);
    repo.applyReward('g1', userId, { xp, at: AT });
  }

  assert.equal(rankOf({ repo, guildId: 'g1', userId: 'a' }), 1);
  assert.equal(rankOf({ repo, guildId: 'g1', userId: 'c' }), 3);
  assert.equal(rankOf({ repo, guildId: 'g1', userId: 'nobody' }), null);
  assert.equal(rankOf({ repo, guildId: 'g2', userId: 'a' }), null, 'a rank leaked across guilds');
  db.close();
});
