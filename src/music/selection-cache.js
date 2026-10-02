/**
 * Pending selection cache.
 *
 * When a search is ambiguous, PompAI posts a menu instead of guessing. The
 * candidates shown have to survive until someone clicks, and the click arrives
 * as a separate gateway event with nothing but a customId - so the list is held
 * here in between.
 *
 * Properties this module is responsible for:
 *
 *   - IDENTITY IS PART OF THE KEY. Guild, channel and the original request
 *     message id together. One guild's candidate list can never be reached from
 *     another guild, or from a different channel, because the key simply does
 *     not exist there.
 *   - BOUNDED. An entry cap with oldest-first eviction, so a busy channel cannot
 *     grow the process without limit.
 *   - EXPIRING. Entries carry a deadline and are dropped on read, on write, and
 *     by an explicit sweep. No timer keeps the process alive.
 *   - SINGLE USE. `take()` removes the entry as it returns it, so a double click
 *     cannot enqueue the same track twice.
 *
 * RAM only, like the queue: a restart clears pending selections, which is the
 * correct outcome - the menu is stale by then anyway.
 */

export const DEFAULT_SELECTION_TIMEOUT_SECONDS = 60;
export const DEFAULT_MAX_SELECTIONS = 200;

/**
 * Composite key.
 *
 * All three parts are required. Message ids are snowflakes and globally unique,
 * but including guild and channel means a hand-crafted or replayed customId
 * cannot address an entry from somewhere else.
 *
 * @param {{ guildId?: string|null, channelId?: string|null, requestId?: string|null }} identity
 * @returns {string|null} null when any part is missing
 */
export function selectionKey({ guildId = null, channelId = null, requestId = null } = {}) {
  if (!guildId || !channelId || !requestId) return null;
  return `${guildId}:${channelId}:${requestId}`;
}

/**
 * @param {object} [options]
 * @param {number} [options.timeoutSeconds]
 * @param {number} [options.maxEntries]
 * @param {() => number} [options.now]
 */
export function createSelectionCache({
  timeoutSeconds = DEFAULT_SELECTION_TIMEOUT_SECONDS,
  maxEntries = DEFAULT_MAX_SELECTIONS,
  now = () => Date.now(),
} = {}) {
  /** @type {Map<string, object>} Insertion-ordered, which is the eviction order. */
  const entries = new Map();

  /** Drops everything past its deadline. */
  function prune(currentTime = now()) {
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= currentTime) entries.delete(key);
    }
  }

  /** Keeps the map under the cap by dropping the oldest entries. */
  function evict() {
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      entries.delete(oldest);
    }
  }

  return {
    timeoutSeconds,
    maxEntries,

    /**
     * Records a pending selection.
     *
     * @param {object} identity `{ guildId, channelId, requestId }`
     * @param {object} entry `{ userId, voiceChannelId, ranked, messageId }`
     * @returns {string|null} the cache key, or null when the identity is incomplete
     */
    put(identity, entry) {
      const key = selectionKey(identity);
      if (!key) return null;

      const currentTime = now();
      prune(currentTime);

      entries.set(key, {
        ...entry,
        requestId: identity.requestId,
        guildId: identity.guildId,
        channelId: identity.channelId,
        createdAt: currentTime,
        expiresAt: currentTime + timeoutSeconds * 1000,
      });

      evict();
      return key;
    },

    /**
     * Reads without consuming. Expired entries are removed and reported missing.
     *
     * @returns {object|null}
     */
    get(identity) {
      const key = selectionKey(identity);
      if (!key) return null;

      const entry = entries.get(key);
      if (!entry) return null;

      if (entry.expiresAt <= now()) {
        entries.delete(key);
        return null;
      }
      return entry;
    },

    /**
     * Reads and consumes in one step.
     *
     * Used for a valid selection so the entry cannot be replayed; a double click
     * or a re-delivered event finds nothing.
     *
     * @returns {object|null}
     */
    take(identity) {
      const key = selectionKey(identity);
      const entry = this.get(identity);
      if (key) entries.delete(key);
      return entry;
    },

    /** Forgets one entry. Returns whether it existed. */
    delete(identity) {
      const key = selectionKey(identity);
      return key ? entries.delete(key) : false;
    },

    /** Forgets every pending selection for a guild, used when a session ends. */
    deleteByGuild(guildId) {
      let removed = 0;
      for (const [key, entry] of entries) {
        if (entry.guildId === guildId) {
          entries.delete(key);
          removed += 1;
        }
      }
      return removed;
    },

    /** Drops everything past its deadline. Returns how many were removed. */
    sweep() {
      const before = entries.size;
      prune();
      return before - entries.size;
    },

    has(identity) {
      return this.get(identity) !== null;
    },

    size() {
      prune();
      return entries.size;
    },

    clear() {
      entries.clear();
    },
  };
}
