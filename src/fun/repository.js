import { BotError } from '../utils/errors.js';
import { isItemKey } from './loot.js';
import { withTransaction } from './db.js';

/**
 * Every SQL statement the fun layer runs.
 *
 * This is the only module that knows the schema. Two rules hold throughout:
 *
 *   1. EVERY user row is addressed by `guild_id AND user_id`. There is no
 *      accessor that takes a user id alone, so a cross-guild read is not
 *      something a caller can accidentally write.
 *   2. Nothing here decides a reward. Amounts and item keys arrive already
 *      resolved from the loot table; the item key is checked against that table
 *      before it is written, so the inventory cannot grow arbitrary keys.
 */

/** Columns returned for a user, in a shape the game modules can read without guessing. */
const USER_COLUMNS = `
  guild_id AS guildId,
  user_id AS userId,
  xp,
  coins,
  mines,
  rare_finds AS rareFinds,
  daily_streak AS dailyStreak,
  last_mine_at AS lastMineAt,
  last_daily_at AS lastDailyAt,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

export function createFunRepository({ db, now = () => Date.now() } = {}) {
  if (!db) throw new BotError('A fun repository needs a database.', { code: 'FUN_DB_MISSING' });

  const statements = {
    insertUser: db.prepare(`
      INSERT OR IGNORE INTO guild_users (guild_id, user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `),
    selectUser: db.prepare(`SELECT ${USER_COLUMNS} FROM guild_users WHERE guild_id = ? AND user_id = ?`),
    addReward: db.prepare(`
      UPDATE guild_users
         SET xp = xp + ?, coins = coins + ?, updated_at = ?
       WHERE guild_id = ? AND user_id = ?
    `),
    recordMine: db.prepare(`
      UPDATE guild_users
         SET last_mine_at = ?, mines = mines + 1, rare_finds = rare_finds + ?, updated_at = ?
       WHERE guild_id = ? AND user_id = ?
    `),
    recordDaily: db.prepare(`
      UPDATE guild_users
         SET last_daily_at = ?, daily_streak = ?, updated_at = ?
       WHERE guild_id = ? AND user_id = ?
    `),
    upsertItem: db.prepare(`
      INSERT INTO inventory (guild_id, user_id, item_key, quantity, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (guild_id, user_id, item_key)
      DO UPDATE SET quantity = quantity + excluded.quantity, updated_at = excluded.updated_at
    `),
    selectInventory: db.prepare(`
      SELECT item_key AS itemKey, quantity
        FROM inventory
       WHERE guild_id = ? AND user_id = ?
       ORDER BY quantity DESC, item_key ASC
    `),
    selectLeaderboard: db.prepare(`
      SELECT user_id AS userId, xp, coins
        FROM guild_users
       WHERE guild_id = ?
       ORDER BY xp DESC, coins DESC, user_id ASC
       LIMIT ?
    `),
  };

  /** Creates the row on first contact and returns it. */
  function ensureUser(guildId, userId, at = now()) {
    assertIdentity(guildId, userId);
    statements.insertUser.run(guildId, userId, at, at);
    return readUser(guildId, userId);
  }

  function readUser(guildId, userId) {
    return plain(statements.selectUser.get(guildId, userId));
  }

  return {
    db,

    /** Runs `fn` in one transaction. Nested calls join it. */
    transaction(fn) {
      return withTransaction(db, fn);
    },

    ensureUser,

    getUser(guildId, userId) {
      if (!guildId || !userId) return null;
      return readUser(String(guildId), String(userId));
    },

    /** Adds coins and/or XP. Returns the updated row. */
    applyReward(guildId, userId, { xp = 0, coins = 0, at = now() } = {}) {
      assertIdentity(guildId, userId);
      statements.addReward.run(whole(xp), whole(coins), at, guildId, userId);
      return readUser(guildId, userId);
    },

    /**
     * Adds an item. Only keys the loot table defines are accepted, so a caller
     * cannot invent one and the inventory stays a closed set.
     */
    addItem(guildId, userId, itemKey, quantity = 1, at = now()) {
      assertIdentity(guildId, userId);
      if (!isItemKey(itemKey)) {
        throw new BotError(`"${itemKey}" is not an item this game defines.`, {
          code: 'FUN_ITEM_UNKNOWN',
          details: { itemKey: String(itemKey) },
        });
      }
      const amount = whole(quantity);
      if (amount <= 0) return;
      statements.upsertItem.run(guildId, userId, itemKey, amount, at);
    },

    getInventory(guildId, userId) {
      if (!guildId || !userId) return [];
      return statements.selectInventory.all(String(guildId), String(userId)).map(plain);
    },

    /** Records a completed dig: the cooldown stamp and the counters move together. */
    recordMine(guildId, userId, { at = now(), rare = false } = {}) {
      assertIdentity(guildId, userId);
      statements.recordMine.run(at, rare ? 1 : 0, at, guildId, userId);
    },

    recordDaily(guildId, userId, { at = now(), streak = 1 } = {}) {
      assertIdentity(guildId, userId);
      statements.recordDaily.run(at, whole(streak), at, guildId, userId);
    },

    /**
     * Top users of ONE guild, already ordered.
     *
     * @param {string} guildId
     * @param {number} [limit]
     */
    leaderboard(guildId, limit = 10) {
      if (!guildId) return [];
      const capped = Math.min(100, Math.max(1, whole(limit) || 10));
      return statements.selectLeaderboard.all(String(guildId), capped).map(plain);
    },
  };
}

/**
 * node:sqlite hands back rows with a null prototype. Every caller gets a plain
 * object instead, so a row behaves the same as any other value in this codebase.
 */
function plain(row) {
  return row ? { ...row } : null;
}

/** Rounds to an integer so a fractional reward can never reach SQLite. */
function whole(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}

function assertIdentity(guildId, userId) {
  if (!guildId || !userId) {
    throw new BotError('Fun state is addressed by guild and user together; one of them is missing.', {
      code: 'FUN_IDENTITY_MISSING',
      details: { hasGuild: Boolean(guildId), hasUser: Boolean(userId) },
    });
  }
}
