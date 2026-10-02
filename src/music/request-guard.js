/**
 * Duplicate-request guard.
 *
 * Stops the same person submitting the same song over and over in a burst.
 * Keyed by guild + user + normalised query, so two different people asking for
 * the same song are both honoured, and the same person asking for two different
 * songs is not penalised.
 *
 * RAM only, like the queue itself: a restart clears it.
 */

export function createRequestGuard({ cooldownSeconds = 3, now = () => Date.now(), maxEntries = 1000 } = {}) {
  /** @type {Map<string, number>} */
  const seen = new Map();

  const keyFor = (guildId, userId, query) =>
    `${guildId ?? 'dm'}:${userId ?? 'unknown'}:${normaliseQuery(query)}`;

  /**
   * Lower-cased and whitespace-collapsed.
   *
   * Plain `toLowerCase`, not the Turkish locale: `tr` maps an ASCII "I" to the
   * dotless "ı", so "VIDA LOCA" would not match "Vida Loca" and the guard would
   * let a duplicate through.
   */
  function normaliseQuery(query) {
    return String(query ?? '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  function prune(currentTime) {
    if (seen.size < maxEntries) return;
    const cutoff = currentTime - cooldownSeconds * 1000;
    for (const [key, at] of seen) {
      if (at < cutoff) seen.delete(key);
    }
  }

  return {
    /**
     * Records a request and reports whether it is a duplicate.
     *
     * @returns {{ ok: boolean, retryAfterMs: number }}
     */
    check(guildId, userId, query) {
      const currentTime = now();
      prune(currentTime);

      const key = keyFor(guildId, userId, query);
      const previous = seen.get(key);
      const windowMs = cooldownSeconds * 1000;

      if (previous !== undefined && currentTime - previous < windowMs) {
        return { ok: false, retryAfterMs: windowMs - (currentTime - previous) };
      }

      seen.set(key, currentTime);
      return { ok: true, retryAfterMs: 0 };
    },

    size: () => seen.size,
    clear: () => seen.clear(),
  };
}

export { normaliseQueryKey };

/** Shared with the search ranker so both agree on what "the same text" means. */
function normaliseQueryKey(query) {
  return String(query ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
