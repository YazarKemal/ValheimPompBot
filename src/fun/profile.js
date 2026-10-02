import { levelProgress, MAX_LEVEL } from './levels.js';
import { MINE_OUTCOMES, describeItem } from './loot.js';

/**
 * Profile and leaderboard reads.
 *
 * Pure assembly on top of the repository: no SQL, no Discord, no formatting
 * decisions beyond ordering. Every read is scoped to one guild, which is what
 * keeps a member of one server out of another server's board.
 */

/**
 * Ordering for the inventory list: rarest first, so the good stuff is on top.
 * The weight IS the rarity, so sorting ascending by it is the whole rule.
 */
const ITEM_RARITY = new Map(MINE_OUTCOMES.map((outcome) => [outcome.key, outcome.weight]));
const UNKNOWN_RARITY = Number.MAX_SAFE_INTEGER;

/**
 * Everything /profil shows.
 *
 * A user with no row yet is not an error: it is a miner who has not dug, and
 * the profile says so with zeros rather than refusing to render.
 *
 * @param {object} options
 * @param {object} options.repo
 * @param {string} options.guildId
 * @param {string} options.userId
 * @param {string} [options.displayName]
 */
export function buildProfile({ repo, guildId, userId, displayName = null } = {}) {
  const row = repo.getUser(guildId, userId);
  const xp = row?.xp ?? 0;
  const progress = levelProgress(xp);

  const inventory = repo
    .getInventory(guildId, userId)
    .map((entry) => ({
      itemKey: entry.itemKey,
      label: describeItem(entry.itemKey),
      quantity: entry.quantity,
    }))
    .sort((a, b) => {
      const left = ITEM_RARITY.get(a.itemKey) ?? UNKNOWN_RARITY;
      const right = ITEM_RARITY.get(b.itemKey) ?? UNKNOWN_RARITY;
      return left - right || a.itemKey.localeCompare(b.itemKey);
    });

  return {
    userId,
    displayName,
    exists: Boolean(row),
    level: progress.level,
    title: progress.title,
    xp,
    coins: row?.coins ?? 0,
    mines: row?.mines ?? 0,
    rareFinds: row?.rareFinds ?? 0,
    streak: row?.dailyStreak ?? 0,
    progress,
    inventory,
    maxLevel: MAX_LEVEL,
  };
}

/**
 * The top `limit` users of one guild.
 *
 * Rank is the position in the ordered result, so ties are still ranked
 * deterministically - XP first, then coins, then user id.
 *
 * @param {object} options
 * @param {object} options.repo
 * @param {string} options.guildId
 * @param {number} [options.limit]
 * @param {(userId: string) => string|null} [options.resolveName] Display-name lookup.
 */
export function buildLeaderboard({ repo, guildId, limit = 10, resolveName = null } = {}) {
  const rows = repo.leaderboard(guildId, limit);

  return rows.map((row, index) => {
    const progress = levelProgress(row.xp);
    return {
      rank: index + 1,
      userId: row.userId,
      displayName: resolveName ? resolveName(row.userId) : null,
      level: progress.level,
      title: progress.title,
      xp: row.xp,
      coins: row.coins,
    };
  });
}

/**
 * Where a user sits on their guild's board.
 *
 * Reads the whole ordered board and finds the position, because a SQL rank
 * would need a window function over a table this small. The board is bounded by
 * who has actually played, so this stays cheap.
 *
 * @returns {number|null} 1-based rank, or null when the user has no row
 */
export function rankOf({ repo, guildId, userId, max = 100 } = {}) {
  const rows = repo.leaderboard(guildId, max);
  const index = rows.findIndex((row) => row.userId === String(userId));
  return index === -1 ? null : index + 1;
}
