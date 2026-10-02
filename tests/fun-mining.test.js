import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MINE_OUTCOMES,
  RARE_ITEM_KEYS,
  isItemKey,
  pickOutcome,
  rollRange,
  totalWeight,
  validateLootTable,
} from '../src/fun/loot.js';
import { cooldownRemaining, mine, mineStatus } from '../src/fun/mining.js';
import { levelFromXp } from '../src/fun/levels.js';
import { openFunDatabase } from '../src/fun/db.js';
import { createFunRepository } from '../src/fun/repository.js';
import { sequenceRandom } from './helpers/fake-interaction.js';

/**
 * /kaz.
 *
 * The point of these tests is the boundary: the server picks the outcome and
 * the amount, the cooldown holds against a double click, and the client has no
 * input at all.
 */

const AT = 1_700_000_000_000;
const HOUR = 3_600_000;

function makeRepo() {
  const db = openFunDatabase({ file: ':memory:' });
  return { db, repo: createFunRepository({ db, now: () => AT }) };
}

/** A random in the middle of an outcome's bucket, so it is chosen deterministically. */
function rollFor(key) {
  let cumulative = 0;
  for (const outcome of MINE_OUTCOMES) {
    const start = cumulative;
    cumulative += outcome.weight;
    if (outcome.key === key) return (start + outcome.weight / 2) / totalWeight();
  }
  throw new Error(`no outcome named ${key}`);
}

const dig = (repo, random, options = {}) =>
  mine({ repo, guildId: 'g1', userId: 'u1', now: AT, random, ...options });

/* -------------------------------------------------------------------------- */
/* The table                                                                   */
/* -------------------------------------------------------------------------- */

test('the weighted table is internally consistent', () => {
  assert.deepEqual(validateLootTable(), []);
  assert.equal(totalWeight(), 1000, 'weights are per mille and must total 1000');
});

test('rare outcomes are actually rare', () => {
  const rare = MINE_OUTCOMES.filter((outcome) => outcome.rare);
  const rareWeight = rare.reduce((total, outcome) => total + outcome.weight, 0);

  assert.ok(rare.length >= 2, 'fewer than two rare outcomes');
  assert.ok(rareWeight / totalWeight() <= 0.05, `rare outcomes are ${((rareWeight / totalWeight()) * 100).toFixed(1)}%`);

  const nugget = MINE_OUTCOMES.find((outcome) => outcome.key === 'nugget');
  assert.ok(nugget, 'the legendary outcome is missing');
  assert.equal(nugget.weight, 4, 'the rarest outcome changed weight');
});

test('every declared rare key is a real item', () => {
  for (const key of RARE_ITEM_KEYS) assert.ok(isItemKey(key), `${key} is marked rare but is not an item`);
  assert.ok(RARE_ITEM_KEYS.includes('elmas'));
});

test('outcome keys are unique and every one is a valid item key', () => {
  const keys = MINE_OUTCOMES.map((outcome) => outcome.key);
  assert.equal(new Set(keys).size, keys.length, 'two outcomes share a key');
  for (const key of keys) assert.ok(isItemKey(key), `${key} is not accepted by the inventory`);
  assert.equal(isItemKey('nope'), false);
  assert.equal(isItemKey(null), false);
});

test('the draw is a pure function of the supplied random', () => {
  for (const value of [0, 0.0001, 0.3, 0.75, 0.999999]) {
    assert.equal(pickOutcome(() => value).key, pickOutcome(() => value).key, 'the draw is not deterministic');
  }
});

test('the whole table is reachable across the random range', () => {
  const seen = new Set();
  for (let step = 0; step < 1000; step += 1) seen.add(pickOutcome(() => step / 1000).key);

  for (const outcome of MINE_OUTCOMES) {
    assert.ok(seen.has(outcome.key), `"${outcome.key}" can never be drawn`);
  }
});

test('the share of draws matches the declared weights', () => {
  const counts = new Map(MINE_OUTCOMES.map((outcome) => [outcome.key, 0]));
  const samples = 20_000;
  for (let step = 0; step < samples; step += 1) {
    const outcome = pickOutcome(() => (step + 0.5) / samples);
    counts.set(outcome.key, counts.get(outcome.key) + 1);
  }

  for (const outcome of MINE_OUTCOMES) {
    const actual = counts.get(outcome.key) / samples;
    const expected = outcome.weight / totalWeight();
    // The deterministic sweep above makes this an exact check on the bucket
    // boundaries rather than a sampling estimate.
    assert.ok(Math.abs(actual - expected) < 0.002, `${outcome.key}: ${actual.toFixed(3)} vs ${expected.toFixed(3)}`);
  }
});

test('a reward range is inclusive at both ends', () => {
  assert.equal(rollRange([3, 7], () => 0), 3);
  assert.equal(rollRange([3, 7], () => 0.999999), 7);
  assert.equal(rollRange([5, 5], () => 0.5), 5, 'a single-value range moved');
});

/* -------------------------------------------------------------------------- */
/* One dig                                                                     */
/* -------------------------------------------------------------------------- */

test('a dig produces exactly one outcome, with rewards from that outcome', () => {
  for (const outcome of MINE_OUTCOMES) {
    const { db, repo } = makeRepo();
    const result = dig(repo, sequenceRandom([rollFor(outcome.key), 0.5, 0.5]));

    assert.equal(result.ok, true);
    assert.equal(result.outcome.key, outcome.key, 'a different outcome was awarded than was drawn');

    const [minCoins, maxCoins] = outcome.coins;
    const [minXp, maxXp] = outcome.xp;
    assert.ok(result.coins >= minCoins && result.coins <= maxCoins, `${outcome.key}: coins ${result.coins}`);
    assert.ok(result.xp >= minXp && result.xp <= maxXp, `${outcome.key}: xp ${result.xp}`);

    // What the database holds must be what was reported, in one step.
    const user = repo.getUser('g1', 'u1');
    assert.equal(user.xp, result.xp, 'the reported XP is not what was stored');
    assert.equal(user.coins, result.coins, 'the reported coins are not what was stored');
    db.close();
  }
});

test('an item outcome fills the inventory and a cave-in does not', () => {
  const { db, repo } = makeRepo();
  const nugget = dig(repo, sequenceRandom([rollFor('nugget'), 0, 0]));
  assert.equal(nugget.itemKey, 'nugget');
  assert.deepEqual(repo.getInventory('g1', 'u1'), [{ itemKey: 'nugget', quantity: 1 }]);
  db.close();

  const second = makeRepo();
  const gocuk = dig(second.repo, sequenceRandom([rollFor('gocuk'), 0, 0]));
  assert.equal(gocuk.itemKey, null, 'a cave-in awarded an item');
  assert.equal(gocuk.coins, 0, 'a cave-in awarded coins');
  assert.ok(gocuk.xp > 0, 'a cave-in should still be worth a little XP');
  assert.deepEqual(second.repo.getInventory('g1', 'u1'), []);
  second.db.close();
});

test('the counters and the cooldown stamp move with the reward', () => {
  const { db, repo } = makeRepo();
  dig(repo, sequenceRandom([rollFor('elmas'), 0.5, 0.5]));

  const user = repo.getUser('g1', 'u1');
  assert.equal(user.mines, 1, 'the dig counter did not move');
  assert.equal(user.rareFinds, 1, 'a rare find was not counted');
  assert.equal(user.lastMineAt, AT, 'the cooldown stamp was not written');
  db.close();
});

test('a common find is not counted as rare', () => {
  const { db, repo } = makeRepo();
  dig(repo, sequenceRandom([rollFor('tas'), 0.5, 0.5]));

  assert.equal(repo.getUser('g1', 'u1').rareFinds, 0);
  db.close();
});

test('a dig levels the miner up and says so', () => {
  const { db, repo } = makeRepo();
  repo.ensureUser('g1', 'u1', AT);
  // Just short of level 2, which needs 60 XP.
  repo.applyReward('g1', 'u1', { xp: 59, at: AT });

  const result = dig(repo, sequenceRandom([rollFor('demir'), 0.5, 0.999999]));

  assert.equal(result.levelBefore, 1);
  assert.ok(result.xp >= 1);
  assert.equal(result.leveledUp, true, 'the level-up was not reported');
  assert.equal(result.levelAfter, levelFromXp(result.user.xp));
  assert.ok(result.levelAfter > result.levelBefore);
  db.close();
});

test('a dig that does not cross a threshold is not announced as a level-up', () => {
  const { db, repo } = makeRepo();
  const result = dig(repo, sequenceRandom([rollFor('tas'), 0, 0]));

  assert.equal(result.xp, 3, 'the minimum XP for the commonest outcome changed');
  assert.equal(result.leveledUp, false, 'a level-up was announced that did not happen');
  assert.equal(result.levelAfter, 1);
  db.close();
});

test('the progress shown matches the XP that was stored', () => {
  const { db, repo } = makeRepo();
  const result = dig(repo, sequenceRandom([rollFor('altin'), 0.5, 0.5]));

  assert.equal(result.progress.xp, result.user.xp);
  assert.equal(result.progress.level, levelFromXp(result.user.xp));
  db.close();
});

/* -------------------------------------------------------------------------- */
/* Cooldown                                                                    */
/* -------------------------------------------------------------------------- */

test('a second dig inside the cooldown is refused and changes nothing', () => {
  const { db, repo } = makeRepo();
  const first = dig(repo, sequenceRandom([rollFor('elmas'), 0.5, 0.5]));
  assert.equal(first.ok, true);

  const before = repo.getUser('g1', 'u1');
  const second = dig(repo, sequenceRandom([rollFor('nugget'), 0.999999, 0.999999]));

  assert.equal(second.ok, false, 'the cooldown was bypassed');
  assert.equal(second.reason, 'cooldown');
  assert.ok(second.remainingSeconds > 0);
  assert.ok(second.remainingSeconds <= 300);

  const after = repo.getUser('g1', 'u1');
  assert.equal(after.xp, before.xp, 'XP was granted during the cooldown');
  assert.equal(after.coins, before.coins, 'coins were granted during the cooldown');
  assert.equal(after.mines, 1, 'a second dig was counted');
  db.close();
});

test('a burst of clicks in the same tick yields exactly one dig', () => {
  const { db, repo } = makeRepo();
  const results = [];
  // Synchronous calls with no await between them: the shape of a double click.
  for (let index = 0; index < 5; index += 1) {
    results.push(dig(repo, sequenceRandom([rollFor('zumrut'), 0.5, 0.5])));
  }

  assert.equal(results.filter((result) => result.ok).length, 1, 'more than one dig succeeded');
  assert.equal(repo.getUser('g1', 'u1').mines, 1, 'the dig counter moved more than once');
  db.close();
});

test('the dig is allowed again once the cooldown has passed', () => {
  const { db, repo } = makeRepo();
  dig(repo, sequenceRandom([rollFor('tas'), 0, 0]));

  assert.equal(dig(repo, sequenceRandom([rollFor('tas'), 0, 0]), { now: AT + 299_000 }).ok, false);
  assert.equal(dig(repo, sequenceRandom([rollFor('tas'), 0, 0]), { now: AT + 300_000 }).ok, true);
  assert.equal(repo.getUser('g1', 'u1').mines, 2);
  db.close();
});

test('the cooldown is configurable and zero disables it', () => {
  const { db, repo } = makeRepo();
  assert.equal(dig(repo, sequenceRandom([rollFor('tas'), 0, 0]), { cooldownSeconds: 0 }).ok, true);
  assert.equal(dig(repo, sequenceRandom([rollFor('tas'), 0, 0]), { cooldownSeconds: 0 }).ok, true);
  assert.equal(repo.getUser('g1', 'u1').mines, 2);
  db.close();
});

test('a clock that moved backwards does not hand out a free dig', () => {
  const { db, repo } = makeRepo();
  dig(repo, sequenceRandom([rollFor('tas'), 0, 0]));

  const backwards = dig(repo, sequenceRandom([rollFor('nugget'), 0.999999, 0.999999]), { now: AT - HOUR });
  assert.equal(backwards.ok, false, 'winding the clock back bypassed the cooldown');
  assert.equal(backwards.remainingSeconds, 300, 'a backwards clock should mean a full cooldown');
  db.close();
});

test('cooldownRemaining is exact at the boundaries', () => {
  assert.equal(cooldownRemaining(null, AT, 300_000), 0, 'a first-ever dig was blocked');
  assert.equal(cooldownRemaining(0, AT, 300_000), 0);
  assert.equal(cooldownRemaining(AT, AT, 300_000), 300_000);
  assert.equal(cooldownRemaining(AT, AT + 299_999, 300_000), 1);
  assert.equal(cooldownRemaining(AT, AT + 300_000, 300_000), 0);
  assert.equal(cooldownRemaining(AT, AT + 999_999, 300_000), 0);
  assert.equal(cooldownRemaining(AT, AT, 0), 0, 'a zero cooldown still blocked');
});

test('the cooldown is per user and per guild', () => {
  const { db, repo } = makeRepo();
  dig(repo, sequenceRandom([rollFor('tas'), 0, 0]));

  assert.equal(mine({ repo, guildId: 'g1', userId: 'u2', now: AT, random: () => 0 }).ok, true, 'another user was blocked');
  assert.equal(mine({ repo, guildId: 'g2', userId: 'u1', now: AT, random: () => 0 }).ok, true, 'another guild was blocked');
  assert.equal(dig(repo, () => 0).ok, false, 'the original user was not blocked');
  db.close();
});

test('mineStatus reports the timer without consuming a dig', () => {
  const { db, repo } = makeRepo();
  dig(repo, sequenceRandom([rollFor('tas'), 0, 0]));

  const status = mineStatus({ repo, guildId: 'g1', userId: 'u1', now: AT + 60_000 });
  assert.equal(status.ready, false);
  assert.equal(status.remainingSeconds, 240);
  assert.equal(repo.getUser('g1', 'u1').mines, 1, 'asking for the timer consumed a dig');

  assert.equal(mineStatus({ repo, guildId: 'g1', userId: 'nobody', now: AT }).ready, true);
  db.close();
});

/* -------------------------------------------------------------------------- */
/* No client input                                                             */
/* -------------------------------------------------------------------------- */

test('the dig takes no amount, item or outcome from its caller', () => {
  const { db, repo } = makeRepo();
  // Everything a caller could try to inject is either ignored or absent: the
  // signature has no place to put it, and passing it changes nothing.
  const honest = dig(repo, sequenceRandom([rollFor('tas'), 0, 0]), {
    coins: 999_999,
    xp: 999_999,
    itemKey: 'nugget',
    outcome: { key: 'nugget' },
  });

  assert.equal(honest.outcome.key, 'tas', 'a caller chose the outcome');
  assert.equal(honest.coins, 2, 'a caller chose the coin amount');
  assert.equal(honest.xp, 3, 'a caller chose the XP amount');
  assert.equal(honest.itemKey, 'tas');

  const user = repo.getUser('g1', 'u1');
  assert.equal(user.coins, 2);
  assert.equal(user.xp, 3);
  db.close();
});
