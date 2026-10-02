import { pickQuestion, questionsFor, isPartyType, PARTY_META } from './content/party-banks.js';

/**
 * Party game sessions.
 *
 * Deliberately RAM-only. A party is a few minutes of chat in one channel; if
 * the bot restarts mid-round, losing the current question is a much smaller
 * problem than a table of stale sessions to expire. Nothing here is worth
 * persisting, and keeping it out of SQLite means a game cannot touch the
 * economy tables.
 *
 * Sessions are keyed by guild AND channel, so the same channel name in two
 * servers can never resolve to the same session.
 */

export const DEFAULT_PARTY_TIMEOUT_MINUTES = 30;

/** Prefix for every party component id. */
export const PARTY_ID_PREFIX = 'party';

export const PARTY_ACTIONS = Object.freeze({ NEW: 'new', END: 'end' });

/** Session key. The separator cannot appear in a Discord snowflake. */
export function partyKey(guildId, channelId) {
  return `${guildId ?? 'dm'}:${channelId ?? 'unknown'}`;
}

/** Builds a component id. Carries an opaque session id only, never a reward. */
export function partyComponentId(action, sessionId) {
  return `${PARTY_ID_PREFIX}:${action}:${sessionId}`;
}

/**
 * Parses a party component id.
 *
 * Strict on purpose: anything that is not exactly `party:<action>:<id>` is not
 * ours, so a malformed id is ignored rather than guessed at.
 *
 * @returns {{ action: string, sessionId: string }|null}
 */
export function parsePartyComponentId(customId) {
  if (typeof customId !== 'string') return null;
  const match = /^party:(new|end):([A-Za-z0-9_-]{4,32})$/.exec(customId);
  if (!match) return null;
  return { action: match[1], sessionId: match[2] };
}

export function isPartyComponent(customId) {
  return typeof customId === 'string' && customId.startsWith(`${PARTY_ID_PREFIX}:`);
}

/**
 * @param {object} [options]
 * @param {number} [options.timeoutMinutes]
 * @param {() => number} [options.now]
 * @param {() => string} [options.idFactory]
 */
export function createPartyStore({
  timeoutMinutes = DEFAULT_PARTY_TIMEOUT_MINUTES,
  now = () => Date.now(),
  // A generator, not a factory of generators: this is called once per session.
  idFactory = null,
} = {}) {
  const nextId = idFactory ?? createIdFactory();
  /** @type {Map<string, object>} */
  const sessions = new Map();
  const timeoutMs = Math.max(0, Number(timeoutMinutes) || 0) * 60_000;

  /** Removes a session once it has been idle past the timeout. */
  function expireIfStale(key) {
    const session = sessions.get(key);
    if (!session) return null;
    if (timeoutMs > 0 && now() - session.lastActivityAt > timeoutMs) {
      sessions.delete(key);
      return null;
    }
    return session;
  }

  return {
    /**
     * Starts a round in a channel, replacing whatever was running there.
     * @returns {{ ok: true, session: object }}
     */
    start({ guildId, channelId, type, random = Math.random }) {
      if (!isPartyType(type)) {
        return { ok: false, reason: 'unknown-type' };
      }
      if (!guildId) {
        return { ok: false, reason: 'no-guild' };
      }

      const question = pickQuestion(type, random);
      if (question === null) return { ok: false, reason: 'empty-bank' };

      const session = {
        id: nextId(),
        guildId: String(guildId),
        channelId: channelId ? String(channelId) : null,
        type,
        meta: PARTY_META[type],
        question,
        asked: 1,
        startedAt: now(),
        lastActivityAt: now(),
      };
      sessions.set(partyKey(guildId, channelId), session);
      return { ok: true, session };
    },

    get(guildId, channelId) {
      return expireIfStale(partyKey(guildId, channelId));
    },

    /**
     * Advances the round to another question.
     *
     * `sessionId` must match the running session. A button left on an old
     * message would otherwise append to a round that has already been replaced.
     */
    next({ guildId, channelId, sessionId, random = Math.random }) {
      const key = partyKey(guildId, channelId);
      const session = expireIfStale(key);
      if (!session) return { ok: false, reason: 'no-session' };
      if (sessionId && session.id !== sessionId) return { ok: false, reason: 'stale' };

      // A bank is never empty for a known type, but a wrong answer here must not
      // repeat the same question silently.
      const question = pickQuestion(session.type, random);
      if (question === null) return { ok: false, reason: 'empty-bank' };

      session.question = question;
      session.asked += 1;
      session.lastActivityAt = now();
      return { ok: true, session };
    },

    /** Ends the round in a channel. Returns whether one was running. */
    end({ guildId, channelId, sessionId }) {
      const key = partyKey(guildId, channelId);
      const session = expireIfStale(key);
      if (!session) return false;
      if (sessionId && session.id !== sessionId) return false;
      sessions.delete(key);
      return true;
    },

    /** Drops every expired session. Returns how many were removed. */
    sweep() {
      let removed = 0;
      for (const key of [...sessions.keys()]) {
        if (expireIfStale(key) === null) removed += 1;
      }
      return removed;
    },

    clear() {
      sessions.clear();
    },

    get size() {
      return sessions.size;
    },
  };
}

/** How many questions a type offers, for the help text and tests. */
export function bankSize(type) {
  return questionsFor(type).length;
}

/**
 * Short, opaque and safe in a customId.
 *
 * Discord caps a customId at 100 characters, and the id is embedded in one, so
 * it is kept to a handful of base-36 characters. The counter alone would repeat
 * across a restart, which is why the clock is mixed in.
 */
export function createIdFactory() {
  let counter = 0;
  return () => {
    counter += 1;
    return `${Date.now().toString(36)}${counter.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  };
}
