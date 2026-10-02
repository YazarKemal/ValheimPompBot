import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  MIGRATIONS,
  SCHEMA_VERSION,
  migrate,
  openFunDatabase,
  readSchemaVersion,
  withTransaction,
} from '../src/fun/db.js';
import { createFunRepository } from '../src/fun/repository.js';

/**
 * Storage: migrations, the guild+user key, and transactions.
 *
 * The economy is the only state in this project that is meant to survive a
 * restart, so the guarantees here are the ones worth pinning: an old database
 * still opens, a newer one is refused, and a failed write leaves nothing behind.
 */

const AT = 1_700_000_000_000;

function makeRepo(options = {}) {
  const db = openFunDatabase({ file: ':memory:' });
  return { db, repo: createFunRepository({ db, now: () => AT, ...options }) };
}

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), 'pomp-fun-'));
}

/* -------------------------------------------------------------------------- */
/* Schema                                                                      */
/* -------------------------------------------------------------------------- */

test('a fresh database is created at the current schema version', () => {
  const db = openFunDatabase({ file: ':memory:' });

  assert.equal(readSchemaVersion(db), SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, MIGRATIONS.length, 'SCHEMA_VERSION and the migration list disagree');

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name);
  assert.ok(tables.includes('guild_users'), 'guild_users is missing');
  assert.ok(tables.includes('inventory'), 'inventory is missing');
  db.close();
});

test('migrating again is a no-op, not an error', () => {
  const db = openFunDatabase({ file: ':memory:' });
  assert.deepEqual(migrate(db), [], 'a second migration pass applied something');
  assert.equal(readSchemaVersion(db), SCHEMA_VERSION);
  db.close();
});

test('migrations only ever add: no drop, delete or truncate', () => {
  const destructive = /\b(DROP\s+TABLE|DROP\s+COLUMN|DELETE\s+FROM|TRUNCATE)\b/i;
  for (const migration of MIGRATIONS) {
    for (const statement of migration.statements) {
      assert.ok(!destructive.test(statement), `migration ${migration.version} destroys data`);
    }
  }
});

test('a database from a newer build is refused rather than downgraded', () => {
  const db = openFunDatabase({ file: ':memory:' });
  // Stand in for a future schema this build knows nothing about.
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 5}`);

  assert.throws(
    () => migrate(db),
    (error) => {
      assert.equal(error.code, 'FUN_DB_TOO_NEW');
      assert.equal(error.details.found, SCHEMA_VERSION + 5);
      return true;
    },
  );
  db.close();
});

/* -------------------------------------------------------------------------- */
/* Persistence                                                                 */
/* -------------------------------------------------------------------------- */

test('state survives closing and reopening the database', () => {
  const dir = tempDir();
  const file = path.join(dir, 'pomp-fun.sqlite');

  try {
    const first = openFunDatabase({ file });
    const repo = createFunRepository({ db: first, now: () => AT });
    repo.ensureUser('g1', 'u1', AT);
    repo.applyReward('g1', 'u1', { xp: 420, coins: 999, at: AT });
    repo.addItem('g1', 'u1', 'elmas', 3, AT);
    repo.recordMine('g1', 'u1', { at: AT, rare: true });
    first.close();

    const second = openFunDatabase({ file });
    const reopened = createFunRepository({ db: second, now: () => AT });
    const user = reopened.getUser('g1', 'u1');

    assert.equal(user.xp, 420);
    assert.equal(user.coins, 999);
    assert.equal(user.mines, 1);
    assert.equal(user.rareFinds, 1);
    assert.deepEqual(reopened.getInventory('g1', 'u1'), [{ itemKey: 'elmas', quantity: 3 }]);
    second.close();

    // Opening an already-migrated file must not re-run anything over live data.
    const third = openFunDatabase({ file });
    assert.equal(readSchemaVersion(third), SCHEMA_VERSION);
    assert.equal(createFunRepository({ db: third }).getUser('g1', 'u1').xp, 420, 'data was lost on a second reopen');
    third.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the database directory is created when it does not exist', () => {
  const dir = tempDir();
  const file = path.join(dir, 'nested', 'deeper', 'pomp-fun.sqlite');
  try {
    const db = openFunDatabase({ file });
    assert.equal(readSchemaVersion(db), SCHEMA_VERSION);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/* Isolation                                                                   */
/* -------------------------------------------------------------------------- */

test('the same user id in two guilds has two separate accounts', () => {
  const { db, repo } = makeRepo();
  repo.ensureUser('g1', 'u1', AT);
  repo.ensureUser('g2', 'u1', AT);

  repo.applyReward('g1', 'u1', { xp: 100, coins: 50, at: AT });
  repo.addItem('g1', 'u1', 'altin', 2, AT);

  assert.equal(repo.getUser('g2', 'u1').xp, 0, 'XP crossed a guild boundary');
  assert.equal(repo.getUser('g2', 'u1').coins, 0, 'coins crossed a guild boundary');
  assert.deepEqual(repo.getInventory('g2', 'u1'), [], 'inventory crossed a guild boundary');
  db.close();
});

test('two users in one guild have two separate accounts', () => {
  const { db, repo } = makeRepo();
  repo.ensureUser('g1', 'u1', AT);
  repo.ensureUser('g1', 'u2', AT);
  repo.applyReward('g1', 'u1', { xp: 100, at: AT });

  assert.equal(repo.getUser('g1', 'u2').xp, 0, 'XP crossed a user boundary');
  assert.deepEqual(repo.getInventory('g1', 'u2'), []);
  db.close();
});

test('a read for an unknown guild or user is empty, never someone else\'s row', () => {
  const { db, repo } = makeRepo();
  repo.ensureUser('g1', 'u1', AT);
  repo.applyReward('g1', 'u1', { xp: 10, at: AT });

  assert.equal(repo.getUser('g1', 'nobody'), null);
  assert.equal(repo.getUser('nope', 'u1'), null);
  assert.equal(repo.getUser(null, 'u1'), null);
  assert.equal(repo.getUser('g1', null), null);
  assert.deepEqual(repo.getInventory('nope', 'u1'), []);
  assert.deepEqual(repo.leaderboard('nope'), []);
  db.close();
});

/* -------------------------------------------------------------------------- */
/* Writes                                                                      */
/* -------------------------------------------------------------------------- */

test('the inventory accepts only item keys the game defines', () => {
  const { db, repo } = makeRepo();
  repo.ensureUser('g1', 'u1', AT);

  assert.throws(
    () => repo.addItem('g1', 'u1', 'hileli-elmas', 9999, AT),
    (error) => {
      assert.equal(error.code, 'FUN_ITEM_UNKNOWN');
      return true;
    },
  );
  assert.throws(() => repo.addItem('g1', 'u1', 'DROP TABLE inventory', 1, AT));
  assert.deepEqual(repo.getInventory('g1', 'u1'), [], 'an unknown key reached the inventory');
  db.close();
});

test('an item stacks rather than duplicating', () => {
  const { db, repo } = makeRepo();
  repo.ensureUser('g1', 'u1', AT);
  repo.addItem('g1', 'u1', 'komur', 2, AT);
  repo.addItem('g1', 'u1', 'komur', 3, AT);

  assert.deepEqual(repo.getInventory('g1', 'u1'), [{ itemKey: 'komur', quantity: 5 }]);
  db.close();
});

test('writing without a guild or a user is refused', () => {
  const { db, repo } = makeRepo();

  assert.throws(() => repo.ensureUser(null, 'u1', AT), /guild and user together/);
  assert.throws(() => repo.ensureUser('g1', null, AT), /guild and user together/);
  assert.throws(() => repo.addItem('g1', null, 'altin', 1, AT), (error) => error.code === 'FUN_IDENTITY_MISSING');
  db.close();
});

test('a failed transaction leaves nothing behind', () => {
  const { db, repo } = makeRepo();
  repo.ensureUser('g1', 'u1', AT);

  assert.throws(
    () =>
      withTransaction(db, () => {
        repo.applyReward('g1', 'u1', { xp: 500, coins: 500, at: AT });
        repo.addItem('g1', 'u1', 'elmas', 1, AT);
        throw new Error('something went wrong halfway');
      }),
    /halfway/,
  );

  const user = repo.getUser('g1', 'u1');
  assert.equal(user.xp, 0, 'XP survived a rolled-back transaction');
  assert.equal(user.coins, 0, 'coins survived a rolled-back transaction');
  assert.deepEqual(repo.getInventory('g1', 'u1'), [], 'an item survived a rolled-back transaction');
  db.close();
});

test('a committed transaction keeps every change together', () => {
  const { db, repo } = makeRepo();
  repo.ensureUser('g1', 'u1', AT);

  withTransaction(db, () => {
    repo.applyReward('g1', 'u1', { xp: 30, coins: 40, at: AT });
    repo.addItem('g1', 'u1', 'demir', 1, AT);
  });

  assert.equal(repo.getUser('g1', 'u1').xp, 30);
  assert.deepEqual(repo.getInventory('g1', 'u1'), [{ itemKey: 'demir', quantity: 1 }]);
  db.close();
});

test('a nested transaction joins the outer one instead of committing early', () => {
  const { db, repo } = makeRepo();
  repo.ensureUser('g1', 'u1', AT);

  assert.throws(() =>
    withTransaction(db, () => {
      repo.applyReward('g1', 'u1', { xp: 10, at: AT });
      // The inner call must not commit what the outer one is about to undo.
      withTransaction(db, () => repo.applyReward('g1', 'u1', { xp: 20, at: AT }));
      throw new Error('outer failed');
    }),
  );

  assert.equal(repo.getUser('g1', 'u1').xp, 0, 'a nested transaction committed independently');
  db.close();
});

/* -------------------------------------------------------------------------- */
/* Leaderboard ordering                                                        */
/* -------------------------------------------------------------------------- */

test('the leaderboard is ordered by XP, then coins, then user id', () => {
  const { db, repo } = makeRepo();
  for (const [userId, xp, coins] of [
    ['u1', 100, 0],
    ['u2', 300, 0],
    ['u3', 300, 50],
    ['u4', 300, 50],
  ]) {
    repo.ensureUser('g1', userId, AT);
    repo.applyReward('g1', userId, { xp, coins, at: AT });
  }

  const board = repo.leaderboard('g1', 10);
  assert.deepEqual(board.map((row) => row.userId), ['u3', 'u4', 'u2', 'u1']);
  assert.deepEqual(board.map((row) => row.xp), [300, 300, 300, 100]);
  db.close();
});

test('the leaderboard never returns another guild\'s users', () => {
  const { db, repo } = makeRepo();
  repo.ensureUser('g1', 'mine', AT);
  repo.applyReward('g1', 'mine', { xp: 10, at: AT });
  repo.ensureUser('g2', 'theirs', AT);
  repo.applyReward('g2', 'theirs', { xp: 9999, at: AT });

  const board = repo.leaderboard('g1', 10);
  assert.deepEqual(board.map((row) => row.userId), ['mine']);
  db.close();
});

test('the leaderboard respects its limit', () => {
  const { db, repo } = makeRepo();
  for (let index = 0; index < 25; index += 1) {
    const userId = `u${String(index).padStart(2, '0')}`;
    repo.ensureUser('g1', userId, AT);
    repo.applyReward('g1', userId, { xp: index + 1, at: AT });
  }

  assert.equal(repo.leaderboard('g1', 10).length, 10);
  assert.equal(repo.leaderboard('g1', 1).length, 1);
  assert.equal(repo.leaderboard('g1', 1000).length, 25, 'the limit was not capped at the table size');
  // A caller cannot ask for an unbounded board.
  assert.ok(repo.leaderboard('g1', 100000).length <= 100);
  db.close();
});
