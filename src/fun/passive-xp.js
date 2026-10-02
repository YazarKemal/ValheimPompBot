import { rollRange } from './loot.js';
import { levelFromXp } from './levels.js';

/**
 * Activity XP from ordinary messages.
 *
 * This works WITHOUT the Message Content intent. Discord delivers a
 * `messageCreate` event to anyone holding `GuildMessages`; what it withholds
 * without the privileged intent is the message text. That is exactly the part
 * this feature does not want - it counts that a message happened, and nothing
 * about what it said.
 *
 * Accordingly this module never reads `message.content`. `npm run check`
 * asserts that, and a test drives it with a message object that throws on
 * content access.
 *
 * The cooldown lives in RAM so a burst of chatter costs one Map lookup per
 * message and at most one write per user per cooldown window.
 */

export const DEFAULT_MESSAGE_XP_COOLDOWN_SECONDS = 60;

/** XP per eligible message. Small next to a dig, which is the point. */
export const MESSAGE_XP_RANGE = Object.freeze([5, 10]);

/**
 * @param {object} options
 * @param {object} options.repo
 * @param {boolean} [options.enabled]
 * @param {number} [options.cooldownSeconds]
 * @param {() => number} [options.now]
 * @param {() => number} [options.random]
 * @param {number} [options.maxTracked]
 */
export function createPassiveXp({
  repo,
  enabled = true,
  cooldownSeconds = DEFAULT_MESSAGE_XP_COOLDOWN_SECONDS,
  now = () => Date.now(),
  random = Math.random,
  maxTracked = 5000,
} = {}) {
  /** `${guildId}:${userId}` -> timestamp of the last award. */
  const lastAwardedAt = new Map();
  const cooldownMs = Math.max(0, Number(cooldownSeconds) || 0) * 1000;

  /** Drops entries that can no longer deny anyone an award. */
  function prune() {
    if (lastAwardedAt.size <= maxTracked) return;
    const cutoff = now() - cooldownMs;
    for (const [key, at] of lastAwardedAt) {
      if (at < cutoff) lastAwardedAt.delete(key);
    }
    // Still over the cap after dropping the stale ones: the map is being used
    // as a cache, so discarding the oldest half is safe and bounded.
    if (lastAwardedAt.size > maxTracked) {
      const excess = lastAwardedAt.size - maxTracked;
      let removed = 0;
      for (const key of lastAwardedAt.keys()) {
        lastAwardedAt.delete(key);
        if (++removed >= excess) break;
      }
    }
  }

  /**
   * Whether a message may earn XP, and why not when it may not.
   *
   * @param {object} message
   * @returns {{ eligible: boolean, reason: string|null, key: string|null }}
   */
  function evaluate(message) {
    if (!enabled) return { eligible: false, reason: 'disabled', key: null };
    if (!message) return { eligible: false, reason: 'no-message', key: null };
    // Bots and webhooks never earn: a webhook could otherwise mint XP.
    if (message.author?.bot) return { eligible: false, reason: 'bot', key: null };
    if (message.system) return { eligible: false, reason: 'system', key: null };

    const guildId = message.guildId ?? message.guild?.id ?? null;
    const userId = message.author?.id ?? null;
    // Guild-scoped by construction: no guild means no row to write.
    if (!guildId || !userId) return { eligible: false, reason: 'no-identity', key: null };

    const key = `${guildId}:${userId}`;
    const previous = lastAwardedAt.get(key);
    if (previous !== undefined && now() - previous < cooldownMs) {
      // The cheap path, and the one that runs most often: no query, no write.
      return { eligible: false, reason: 'cooldown', key };
    }
    return { eligible: true, reason: null, key };
  }

  return {
    evaluate,
    cooldownMs,

    /** True when the message would earn XP right now. Reads no content. */
    isEligible(message) {
      return evaluate(message).eligible;
    },

    /**
     * Awards XP for one message, if it is eligible.
     *
     * @returns {{ awarded: boolean, xp: number, reason: string|null, leveledUp: boolean }}
     */
    handle(message) {
      const verdict = evaluate(message);
      if (!verdict.eligible) return { awarded: false, xp: 0, reason: verdict.reason, leveledUp: false };

      const guildId = message.guildId ?? message.guild?.id ?? null;
      const userId = message.author?.id ?? null;
      const at = now();
      const xp = rollRange(MESSAGE_XP_RANGE, random);

      const result = repo.transaction(() => {
        const before = repo.ensureUser(guildId, userId, at);
        const user = repo.applyReward(guildId, userId, { xp, at });
        return { levelBefore: levelFromXp(before.xp), levelAfter: levelFromXp(user.xp) };
      });

      lastAwardedAt.set(verdict.key, at);
      prune();

      return { awarded: true, xp, reason: null, leveledUp: result.levelAfter > result.levelBefore };
    },

    /** For diagnostics and tests. */
    get trackedCount() {
      return lastAwardedAt.size;
    },

    /** Forgets every cooldown, so the next message from anyone earns XP. */
    reset() {
      lastAwardedAt.clear();
    },
  };
}
