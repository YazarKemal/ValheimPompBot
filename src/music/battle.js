/**
 * Song battles.
 *
 * A battle is a vote between two tracks. It is RAM-only and keyed by guild and
 * battle id, so a click in one server can never reach a vote in another.
 *
 * No audio is involved: this phase is voting only, so nothing here touches the
 * voice session, the queue or the stream backend. Nothing here calls a model
 * either - the store holds two titles and a map of clicks.
 */

export const BATTLE_SIDES = Object.freeze(['a', 'b']);

/** Prefix for every battle component id. */
export const BATTLE_PREFIX = 'savas';

export const DEFAULT_BATTLE_SECONDS = 60;

/** A battle is at most a few dozen voters; the cap only bounds memory. */
const MAX_VOTES = 5000;

export function battleComponentId(battleId, side) {
  return `${BATTLE_PREFIX}:${battleId}:${side}`;
}

/**
 * Parses a battle component id.
 *
 * Strict: anything not exactly `savas:<id>:<a|b>` is not ours, so a malformed
 * id cannot be used to reach a battle that was never issued.
 *
 * @returns {{ battleId: string, side: 'a'|'b' }|null}
 */
export function parseBattleComponentId(customId) {
  if (typeof customId !== 'string') return null;
  const match = /^savas:([A-Za-z0-9_-]{4,32}):(a|b)$/.exec(customId);
  if (!match) return null;
  return { battleId: match[1], side: match[2] };
}

export function isBattleComponent(customId) {
  return typeof customId === 'string' && customId.startsWith(`${BATTLE_PREFIX}:`);
}

/** Guild-scoped key. The separator cannot occur in a snowflake. */
function keyOf(guildId, battleId) {
  return `${guildId}:${battleId}`;
}

/**
 * @param {object} [options]
 * @param {number} [options.seconds]
 * @param {() => number} [options.now]
 * @param {() => string} [options.idFactory]
 * @param {Function} [options.setTimeoutImpl]
 * @param {Function} [options.clearTimeoutImpl]
 */
export function createBattleStore({
  seconds = DEFAULT_BATTLE_SECONDS,
  now = () => Date.now(),
  // A generator, not a factory of generators: this is called once per battle.
  idFactory = null,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  const nextId = idFactory ?? createIdFactory();
  /** @type {Map<string, object>} */
  const battles = new Map();

  function dispose(battle) {
    if (battle.timer) clearTimeoutImpl(battle.timer);
    battle.timer = null;
  }

  /** Tallies a battle without consuming it. */
  function countVotes(battle) {
    let a = 0;
    let b = 0;
    for (const side of battle.votes.values()) {
      if (side === 'a') a += 1;
      else b += 1;
    }

    // A draw is a real outcome and is reported as one; picking a side on equal
    // votes would be inventing a winner the voters did not choose.
    const winner = a === b ? null : a > b ? 'a' : 'b';
    return { a, b, total: a + b, winner };
  }

  function get(guildId, battleId) {
    if (!guildId || !battleId) return null;
    return battles.get(keyOf(guildId, battleId)) ?? null;
  }

  /**
   * Closes a battle and returns the result.
   *
   * The session is removed, so a click arriving after the announcement finds
   * nothing and is told the round is over rather than being counted.
   */
  function finish(guildId, battleId) {
    const key = keyOf(guildId, battleId);
    const battle = battles.get(key);
    if (!battle) return null;

    battle.settled = true;
    dispose(battle);
    battles.delete(key);

    return { battle, tally: countVotes(battle) };
  }

  return {
    /** The configured round length, for the embed countdown. */
    get seconds() {
      return seconds;
    },

    get size() {
      return battles.size;
    },

    /**
     * Opens a battle for a message that has already been posted.
     *
     * @param {object} options
     * @param {string} options.guildId
     * @param {string} options.channelId
     * @param {object} options.entries `{ a: {title, artist}, b: {...} }`
     * @param {string|null} [options.messageId]
     * @param {(result: object) => Promise<void>|void} [options.onExpire]
     * @returns {{ ok: true, battle: object }|{ ok: false, reason: string }}
     */
    open({ guildId, channelId, entries, messageId = null, onExpire = null }) {
      if (!guildId) return { ok: false, reason: 'no-guild' };
      if (!entries?.a || !entries?.b) return { ok: false, reason: 'no-entries' };

      const battle = {
        id: nextId(),
        guildId: String(guildId),
        channelId: channelId ? String(channelId) : null,
        messageId,
        entries: { a: entries.a, b: entries.b },
        votes: new Map(),
        startedAt: now(),
        endsAt: now() + seconds * 1000,
        timer: null,
        settled: false,
      };

      if (seconds > 0) {
        battle.timer = setTimeoutImpl(() => {
          // Settled from the timer, so the announcement happens once even if a
          // late click arrives at the same moment.
          const result = finish(guildId, battle.id);
          if (!result) return;
          Promise.resolve()
            .then(() => onExpire?.(result))
            .catch(() => {
              // The channel may be gone; the votes are still discarded.
            });
        }, seconds * 1000);
        battle.timer?.unref?.();
      }

      battles.set(keyOf(guildId, battle.id), battle);
      return { ok: true, battle };
    },

    get,

    /**
     * Records one vote.
     *
     * One vote per user, changeable until the round closes - the map is keyed
     * by user, so a second click replaces the first rather than adding to it.
     * Bots are refused here as well as at the interaction layer: a vote from a
     * bot is never meaningful, and two checks are cheaper than one mistake.
     */
    vote({ guildId, battleId, userId, side, isBot = false }) {
      const battle = get(guildId, battleId);
      if (!battle) return { ok: false, reason: 'no-battle', changed: false, side: null, tally: null };
      if (battle.settled) return { ok: false, reason: 'settled', changed: false, side: null, tally: countVotes(battle) };
      if (isBot) return { ok: false, reason: 'bot', changed: false, side: null, tally: countVotes(battle) };
      if (!userId) return { ok: false, reason: 'no-user', changed: false, side: null, tally: countVotes(battle) };
      if (!BATTLE_SIDES.includes(side)) {
        return { ok: false, reason: 'bad-side', changed: false, side: null, tally: countVotes(battle) };
      }
      if (battle.votes.size >= MAX_VOTES && !battle.votes.has(userId)) {
        return { ok: false, reason: 'full', changed: false, side: null, tally: countVotes(battle) };
      }

      const previous = battle.votes.get(userId) ?? null;
      battle.votes.set(userId, side);

      return {
        ok: true,
        reason: null,
        changed: previous !== null && previous !== side,
        side,
        previous,
        tally: countVotes(battle),
        voterCount: battle.votes.size,
      };
    },

    tally(guildId, battleId) {
      const battle = get(guildId, battleId);
      return battle ? countVotes(battle) : null;
    },

    finish,

    /** Closes every battle whose time has passed. Returns how many closed. */
    sweep() {
      let closed = 0;
      for (const battle of [...battles.values()]) {
        if (now() >= battle.endsAt) {
          if (finish(battle.guildId, battle.id)) closed += 1;
        }
      }
      return closed;
    },

    /** Cancels every timer. Called on shutdown so nothing outlives the client. */
    destroy() {
      for (const battle of battles.values()) dispose(battle);
      battles.clear();
    },
  };
}

/**
 * Short, opaque and safe in a customId.
 *
 * Discord caps a customId at 100 characters and the id is embedded in one. The
 * counter alone would repeat across a restart, which is why the clock is mixed
 * in.
 */
export function createIdFactory() {
  let counter = 0;
  return () => {
    counter += 1;
    return `${Date.now().toString(36)}${counter.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  };
}
