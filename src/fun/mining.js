import { levelFromXp, levelProgress } from './levels.js';
import { pickOutcome, rollRange } from './loot.js';

/**
 * /kaz.
 *
 * The whole action - cooldown check, draw, reward, counters, timestamp - runs
 * inside ONE transaction. That is what makes the cooldown unbypassable: a second
 * attempt cannot read the timestamp before the first has written it, because
 * node:sqlite is synchronous and the transaction has no await inside it.
 *
 * Nothing a caller passes in decides the outcome. The random source is injected
 * for testability, never supplied by the client, and the amounts come from the
 * loot table.
 */

export const DEFAULT_MINE_COOLDOWN_SECONDS = 300;

/**
 * Milliseconds left before the next dig, or 0 when one is allowed now.
 *
 * A clock that has moved backwards yields a full cooldown rather than a free
 * dig, so turning the system clock back is not a way to farm.
 *
 * @param {number|null} lastAt
 * @param {number} now
 * @param {number} cooldownMs
 */
export function cooldownRemaining(lastAt, now, cooldownMs) {
  if (!Number.isFinite(cooldownMs) || cooldownMs <= 0) return 0;
  const last = Number(lastAt);
  if (!Number.isFinite(last) || last <= 0) return 0;

  const elapsed = now - last;
  if (elapsed >= cooldownMs) return 0;
  return cooldownMs - Math.max(0, elapsed);
}

/**
 * Performs one dig.
 *
 * @param {object} options
 * @param {object} options.repo
 * @param {string} options.guildId
 * @param {string} options.userId
 * @param {number} [options.now]
 * @param {() => number} [options.random]
 * @param {number} [options.cooldownSeconds]
 * @returns {{ ok: true, outcome: object, coins: number, xp: number, itemKey: string|null, leveledUp: boolean, levelBefore: number, levelAfter: number, progress: object, user: object }
 *         | { ok: false, reason: 'cooldown', remainingMs: number, remainingSeconds: number, user: object }}
 */
export function mine({
  repo,
  guildId,
  userId,
  now = Date.now(),
  random = Math.random,
  cooldownSeconds = DEFAULT_MINE_COOLDOWN_SECONDS,
} = {}) {
  const cooldownMs = Math.max(0, Number(cooldownSeconds) || 0) * 1000;

  return repo.transaction(() => {
    const before = repo.ensureUser(guildId, userId, now);

    const remainingMs = cooldownRemaining(before.lastMineAt, now, cooldownMs);
    if (remainingMs > 0) {
      return {
        ok: false,
        reason: 'cooldown',
        remainingMs,
        remainingSeconds: Math.ceil(remainingMs / 1000),
        user: before,
      };
    }

    // Draw order is coins, XP, then nothing else - the outcome is already
    // chosen, so an injected sequence of randoms maps predictably in tests.
    const outcome = pickOutcome(random);
    const coins = rollRange(outcome.coins, random);
    const xp = rollRange(outcome.xp, random);

    const levelBefore = levelFromXp(before.xp);

    repo.applyReward(guildId, userId, { xp, coins, at: now });
    if (outcome.item) repo.addItem(guildId, userId, outcome.key, 1, now);
    repo.recordMine(guildId, userId, { at: now, rare: outcome.rare });

    const user = repo.getUser(guildId, userId);
    const levelAfter = levelFromXp(user.xp);

    return {
      ok: true,
      outcome,
      coins,
      xp,
      itemKey: outcome.item ? outcome.key : null,
      levelBefore,
      levelAfter,
      leveledUp: levelAfter > levelBefore,
      progress: levelProgress(user.xp),
      user,
    };
  });
}

/**
 * The cooldown state for a user, for a command that wants to show the timer
 * without attempting a dig.
 *
 * @returns {{ remainingMs: number, remainingSeconds: number, ready: boolean }}
 */
export function mineStatus({ repo, guildId, userId, now = Date.now(), cooldownSeconds = DEFAULT_MINE_COOLDOWN_SECONDS } = {}) {
  const user = repo.getUser(guildId, userId);
  const remainingMs = cooldownRemaining(user?.lastMineAt ?? null, now, Math.max(0, cooldownSeconds) * 1000);
  return { remainingMs, remainingSeconds: Math.ceil(remainingMs / 1000), ready: remainingMs === 0 };
}
