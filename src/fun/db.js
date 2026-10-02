import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BotError } from '../utils/errors.js';

/**
 * Persistence for the fun layer.
 *
 * Storage is `node:sqlite`, which ships with Node 24 - the whole reason the
 * economy survives a restart without a native build step, a compiler on the
 * host, or a dependency to keep patched.
 *
 * Two properties this module owns:
 *
 *   - MIGRATIONS ARE ADDITIVE. `PRAGMA user_version` records the schema level,
 *     each migration only ever creates a table or adds a column, and a database
 *     written by a NEWER build is refused rather than silently downgraded. A
 *     user's XP is not something to lose to a rollback.
 *   - WRITES THAT BELONG TOGETHER COMMIT TOGETHER. `withTransaction` wraps the
 *     coin, XP, item and timestamp changes of one action, so a crash cannot
 *     leave a mine that took the cooldown but granted no reward.
 */

/** Where the database lives when no path is configured. */
export const DEFAULT_DB_RELATIVE_PATH = 'data/pomp-fun.sqlite';

/** Schema level this build expects. */
export const SCHEMA_VERSION = 1;

const GUILD_USERS_DDL = `
  CREATE TABLE IF NOT EXISTS guild_users (
    guild_id     TEXT    NOT NULL,
    user_id      TEXT    NOT NULL,
    xp           INTEGER NOT NULL DEFAULT 0,
    coins        INTEGER NOT NULL DEFAULT 0,
    mines        INTEGER NOT NULL DEFAULT 0,
    rare_finds   INTEGER NOT NULL DEFAULT 0,
    daily_streak INTEGER NOT NULL DEFAULT 0,
    last_mine_at INTEGER,
    last_daily_at INTEGER,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  )
`;

const INVENTORY_DDL = `
  CREATE TABLE IF NOT EXISTS inventory (
    guild_id   TEXT    NOT NULL,
    user_id    TEXT    NOT NULL,
    item_key   TEXT    NOT NULL,
    quantity   INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id, item_key)
  )
`;

/**
 * Ordered schema changes. Append only: `version` must increase by one each time,
 * and no migration may drop, rename or rewrite existing data.
 */
export const MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 1,
    description: 'guild_users and inventory',
    statements: Object.freeze([
      GUILD_USERS_DDL,
      INVENTORY_DDL,
      // The leaderboard is "top N of one guild ordered by XP", so the index
      // carries the guild and the ordering together.
      `CREATE INDEX IF NOT EXISTS idx_guild_users_rank
         ON guild_users (guild_id, xp DESC, coins DESC, user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_inventory_owner
         ON inventory (guild_id, user_id)`,
    ]),
  }),
]);

/** The schema level a database is currently at. */
export function readSchemaVersion(db) {
  return Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
}

/**
 * Brings a database up to `SCHEMA_VERSION`.
 *
 * Each migration is its own transaction: a failure leaves the previous level
 * intact rather than a half-applied schema.
 *
 * @param {DatabaseSync} db
 * @returns {number[]} the versions applied by this call
 */
export function migrate(db) {
  const current = readSchemaVersion(db);

  if (current > SCHEMA_VERSION) {
    throw new BotError(
      `The fun database is at schema version ${current}, but this build only understands ${SCHEMA_VERSION}. ` +
        'Refusing to open it: a newer schema may hold columns this code would drop on write.',
      { code: 'FUN_DB_TOO_NEW', details: { found: current, supported: SCHEMA_VERSION } },
    );
  }

  const applied = [];
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;

    db.exec('BEGIN IMMEDIATE');
    try {
      for (const statement of migration.statements) db.exec(statement);
      // Integer literal, not a bound parameter: PRAGMA does not accept one.
      db.exec(`PRAGMA user_version = ${Number(migration.version)}`);
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // The transaction is already gone; the original error is the useful one.
      }
      throw new BotError(`Fun database migration ${migration.version} failed: ${error?.message}`, {
        code: 'FUN_DB_MIGRATION_FAILED',
        details: { version: migration.version, description: migration.description },
        cause: error,
      });
    }
    applied.push(migration.version);
  }
  return applied;
}

/**
 * Opens (creating if needed) and migrates the fun database.
 *
 * @param {object} [options]
 * @param {string} [options.file] Path, or `:memory:` for tests.
 * @returns {DatabaseSync}
 */
export function openFunDatabase({ file = ':memory:' } = {}) {
  if (file !== ':memory:') {
    // Creating the directory here means a fresh clone needs no setup step.
    mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }

  const db = new DatabaseSync(file);
  // A second process reading while the bot writes should wait, not fail.
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');

  migrate(db);
  return db;
}

/** Databases with a transaction in flight, so nesting joins instead of failing. */
const ACTIVE = new WeakSet();

/**
 * Runs `fn` inside one transaction.
 *
 * Nested calls join the outer transaction rather than starting a second one:
 * SQLite has no nested BEGIN, and an inner COMMIT would end the outer unit of
 * work early. Only the outermost call commits.
 *
 * @template T
 * @param {DatabaseSync} db
 * @param {() => T} fn
 * @returns {T}
 */
export function withTransaction(db, fn) {
  if (ACTIVE.has(db)) return fn();

  // IMMEDIATE takes the write lock up front. A deferred transaction that starts
  // by reading can fail later with SQLITE_BUSY midway through the writes.
  db.exec('BEGIN IMMEDIATE');
  ACTIVE.add(db);
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Nothing to roll back; the original error is the informative one.
    }
    throw error;
  } finally {
    ACTIVE.delete(db);
  }
}
