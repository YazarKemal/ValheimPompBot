import { BotError } from '../utils/errors.js';
import { isItemKey, rollRange } from './loot.js';
import { levelFromXp, levelProgress } from './levels.js';

/**
 * /gunluk - the daily chest.
 *
 * A rolling cooldown measured in elapsed time, never a calendar day. A calendar
 * day would need a timezone, and picking one would mean the reset lands at an
 * arbitrary hour for everyone not in it; elapsed hours are the same for every
 * user and need no assumption about where they are.
 *
 * The streak is the reward for habit: claim again within the window and it
 * grows, let the window lapse and it starts over at one.
 */

export const DEFAULT_DAILY_COOLDOWN_HOURS = 20;

/**
 * Extra room after the cooldown before a streak breaks.
 *
 * The cooldown alone would make a streak fragile - a claim at 20h and the next
 * at 20h01m is fine, but life does not run on a 20-hour clock. A full extra day
 * means "once a day, roughly" keeps the streak alive.
 */
export const STREAK_GRACE_HOURS = 24;

/** Coins awarded per claim. */
export const DAILY_COINS = Object.freeze([200, 500]);

/** XP awarded per claim. */
export const DAILY_XP = Object.freeze([60, 110]);

/** Probability that a claim also contains an item. */
export const DAILY_ITEM_CHANCE = 0.35;

/**
 * The item pool for the chest, weighted.
 *
 * Only keys the mining table also defines, so a chest can never put something
 * in an inventory that /envanter does not know how to name.
 */
export const DAILY_ITEM_POOL = Object.freeze([
  Object.freeze({ key: 'altin', weight: 60 }),
  Object.freeze({ key: 'zumrut', weight: 30 }),
  Object.freeze({ key: 'elmas', weight: 10 }),
]);

const DAILY_ITEM_WEIGHT = DAILY_ITEM_POOL.reduce((total, entry) => total + entry.weight, 0);

/** Which bucket of the sequence a random draw is used for. */
export const DAILY_ROLLS = Object.freeze(['coins', 'xp', 'itemChance', 'item']);

/**
 * How long after a claim the streak is still alive.
 * @param {number} cooldownHours
 */
export function streakWindowMs(cooldownHours = DEFAULT_DAILY_COOLDOWN_HOURS) {
  return (Math.max(0, Number(cooldownHours) || 0) + STREAK_GRACE_HOURS) * 3_600_000;
}

/**
 * The streak a claim produces, given when the last one was.
 *
 * @param {number|null} lastDailyAt
 * @param {number} now
 * @param {number} previousStreak
 * @param {number} windowMs
 * @returns {{ streak: number, change: 'started'|'incremented'|'reset' }}
 */
export function nextStreak(lastDailyAt, now, previousStreak, windowMs) {
  const last = Number(lastDailyAt);
  const previous = Number.isFinite(Number(previousStreak)) ? Math.max(0, Math.trunc(Number(previousStreak))) : 0;

  if (!Number.isFinite(last) || last <= 0) return { streak: 1, change: 'started' };

  // A clock that moved backwards keeps the streak rather than resetting it:
  // losing progress to a timezone change or an NTP correction would be worse
  // than one extra claim.
  const elapsed = now - last;
  if (elapsed < 0) return { streak: previous + 1, change: 'incremented' };

  if (elapsed <= windowMs) return { streak: previous + 1, change: 'incremented' };
  return { streak: 1, change: 'reset' };
}

/**
 * Draws one item key from the chest pool.
 * @param {() => number} random
 */
export function pickDailyItem(random = Math.random) {
  const roll = Math.min(1 - Number.EPSILON, Math.max(0, Number(random()) || 0)) * DAILY_ITEM_WEIGHT;

  let cumulative = 0;
  for (const entry of DAILY_ITEM_POOL) {
    cumulative += entry.weight;
    if (roll < cumulative) return entry.key;
  }
  return DAILY_ITEM_POOL[DAILY_ITEM_POOL.length - 1].key;
}

/**
 * Claims the daily chest.
 *
 * The cooldown check, the reward and the streak update share one transaction,
 * so a double-clicked button cannot grant two chests: the second call sees the
 * timestamp the first one wrote.
 *
 * @param {object} options
 * @param {object} options.repo
 * @param {string} options.guildId
 * @param {string} options.userId
 * @param {number} [options.now]
 * @param {() => number} [options.random]
 * @param {number} [options.cooldownHours]
 * @returns {{ ok: true, coins: number, xp: number, itemKey: string|null, streak: number, streakChange: string, leveledUp: boolean, progress: object, user: object }
 *         | { ok: false, reason: 'cooldown', remainingMs: number, remainingSeconds: number, user: object }}
 */
export function claimDaily({
  repo,
  guildId,
  userId,
  now = Date.now(),
  random = Math.random,
  cooldownHours = DEFAULT_DAILY_COOLDOWN_HOURS,
} = {}) {
  const hours = Math.max(0, Number(cooldownHours) || 0);
  const cooldownMs = hours * 3_600_000;
  const windowMs = streakWindowMs(hours);

  return repo.transaction(() => {
    const before = repo.ensureUser(guildId, userId, now);

    const last = Number(before.lastDailyAt);
    if (Number.isFinite(last) && last > 0) {
      const elapsed = now - last;
      // Only a forward-running clock inside the cooldown blocks a claim.
      if (elapsed >= 0 && elapsed < cooldownMs) {
        const remainingMs = cooldownMs - elapsed;
        return {
          ok: false,
          reason: 'cooldown',
          remainingMs,
          remainingSeconds: Math.ceil(remainingMs / 1000),
          user: before,
          streak: before.dailyStreak,
        };
      }
    }

    const coins = rollRange(DAILY_COINS, random);
    const xp = rollRange(DAILY_XP, random);
    const winsItem = Number(random()) < DAILY_ITEM_CHANCE;
    const itemKey = winsItem ? pickDailyItem(random) : null;

    if (itemKey !== null && !isItemKey(itemKey)) {
      // Defensive: the pool and the loot table are both server-side, so a
      // mismatch is a coding error, not a user one. Fail loudly rather than
      // writing an item nothing can display.
      throw new BotError(`The daily pool offers "${itemKey}", which the loot table does not define.`, {
        code: 'FUN_ITEM_UNKNOWN',
        details: { itemKey },
      });
    }

    const { streak, change } = nextStreak(before.lastDailyAt, now, before.dailyStreak, windowMs);
    const levelBefore = levelFromXp(before.xp);

    repo.applyReward(guildId, userId, { xp, coins, at: now });
    if (itemKey) repo.addItem(guildId, userId, itemKey, 1, now);
    repo.recordDaily(guildId, userId, { at: now, streak });

    const user = repo.getUser(guildId, userId);
    const levelAfter = levelFromXp(user.xp);

    return {
      ok: true,
      coins,
      xp,
      itemKey,
      streak,
      streakChange: change,
      levelBefore,
      levelAfter,
      leveledUp: levelAfter > levelBefore,
      progress: levelProgress(user.xp),
      user,
    };
  });
}

/** The daily cooldown state, for a command that only wants to show the timer. */
export function dailyStatus({ repo, guildId, userId, now = Date.now(), cooldownHours = DEFAULT_DAILY_COOLDOWN_HOURS } = {}) {
  const user = repo.getUser(guildId, userId);
  const cooldownMs = Math.max(0, Number(cooldownHours) || 0) * 3_600_000;
  const last = Number(user?.lastDailyAt);

  let remainingMs = 0;
  if (Number.isFinite(last) && last > 0 && cooldownMs > 0) {
    const elapsed = now - last;
    if (elapsed >= 0 && elapsed < cooldownMs) remainingMs = cooldownMs - elapsed;
  }

  return {
    remainingMs,
    remainingSeconds: Math.ceil(remainingMs / 1000),
    ready: remainingMs === 0,
    streak: user?.dailyStreak ?? 0,
  };
}
