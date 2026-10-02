import path from 'node:path';
import { PROJECT_ROOT } from '../config/index.js';
import { createNullLogger } from '../utils/logger.js';
import { DEFAULT_DB_RELATIVE_PATH, openFunDatabase } from './db.js';
import { createFunRepository } from './repository.js';
import { createPartyStore, DEFAULT_PARTY_TIMEOUT_MINUTES } from './party.js';
import { createPassiveXp, DEFAULT_MESSAGE_XP_COOLDOWN_SECONDS } from './passive-xp.js';
import { mine as runMine, DEFAULT_MINE_COOLDOWN_SECONDS } from './mining.js';
import { claimDaily, DEFAULT_DAILY_COOLDOWN_HOURS } from './daily.js';
import { buildLeaderboard, buildProfile } from './profile.js';

/**
 * The fun layer, wired together.
 *
 * This is the only place that knows both the database and the game rules, and
 * it is what commands are handed. There is no AI client anywhere in this tree:
 * every outcome comes from a server-side table, so the whole economy works with
 * AI_PROVIDER unset and no API key present.
 */

export { DEFAULT_DB_RELATIVE_PATH, SCHEMA_VERSION, openFunDatabase, migrate, readSchemaVersion } from './db.js';
export { createFunRepository } from './repository.js';
export {
  createPartyStore,
  partyKey,
  parsePartyComponentId,
  isPartyComponent,
  bankSize,
  PARTY_ACTIONS,
  PARTY_ID_PREFIX,
} from './party.js';
export { createPassiveXp } from './passive-xp.js';
export { mine, mineStatus, cooldownRemaining, DEFAULT_MINE_COOLDOWN_SECONDS } from './mining.js';
export { claimDaily, dailyStatus, DEFAULT_DAILY_COOLDOWN_HOURS, STREAK_GRACE_HOURS } from './daily.js';
export { buildProfile, buildLeaderboard, rankOf } from './profile.js';
export * from './levels.js';
export * from './loot.js';
export { PARTY_TYPES, PARTY_META, PARTY_BANKS, isPartyType, questionsFor } from './content/party-banks.js';
export { NICKNAMES, pickNickname } from './content/nicknames.js';
export { FORTUNES, pickFortune } from './content/fortunes.js';

/**
 * Absolute path to the database file.
 *
 * A configured path may be relative to the repository root, which is what makes
 * `FUN_DB_FILE=data/other.sqlite` mean the same thing on any machine.
 */
export function resolveDatabasePath(configured) {
  if (!configured) return path.join(PROJECT_ROOT, DEFAULT_DB_RELATIVE_PATH);
  return path.isAbsolute(configured) ? configured : path.join(PROJECT_ROOT, configured);
}

/**
 * @param {object} [options]
 * @param {object} [options.config] Full application config.
 * @param {object} [options.logger]
 * @param {object} [options.database] Pre-opened DatabaseSync (tests).
 * @param {() => number} [options.now]
 * @param {() => number} [options.random]
 */
export function createFunService({
  config = {},
  logger = createNullLogger(),
  database = null,
  now = () => Date.now(),
  random = Math.random,
} = {}) {
  const settings = config.fun ?? {};
  const db = database ?? openFunDatabase({ file: resolveDatabasePath(settings.dbFile) });
  const repo = createFunRepository({ db, now });

  const party = createPartyStore({
    timeoutMinutes: settings.partyTimeoutMinutes ?? DEFAULT_PARTY_TIMEOUT_MINUTES,
    now,
  });

  const passiveXp = createPassiveXp({
    repo,
    enabled: settings.messageXpEnabled !== false,
    cooldownSeconds: settings.messageXpCooldownSeconds ?? DEFAULT_MESSAGE_XP_COOLDOWN_SECONDS,
    now,
    random,
  });

  logger.debug?.('Fun service ready.', {
    database: database ? '(injected)' : resolveDatabasePath(settings.dbFile),
    mineCooldownSeconds: settings.mineCooldownSeconds ?? DEFAULT_MINE_COOLDOWN_SECONDS,
    dailyCooldownHours: settings.dailyCooldownHours ?? DEFAULT_DAILY_COOLDOWN_HOURS,
    messageXp: settings.messageXpEnabled !== false,
  });

  return {
    repo,
    party,
    passiveXp,
    db,
    settings,

    /** One dig. All randomness is server-side. */
    mine({ guildId, userId, random: roll = null }) {
      return runMine({
        repo,
        guildId,
        userId,
        now: now(),
        random: roll ?? random,
        cooldownSeconds: settings.mineCooldownSeconds ?? DEFAULT_MINE_COOLDOWN_SECONDS,
      });
    },

    /** One daily chest. */
    claimDaily({ guildId, userId, random: roll = null }) {
      return claimDaily({
        repo,
        guildId,
        userId,
        now: now(),
        random: roll ?? random,
        cooldownHours: settings.dailyCooldownHours ?? DEFAULT_DAILY_COOLDOWN_HOURS,
      });
    },

    profile({ guildId, userId, displayName = null }) {
      return buildProfile({ repo, guildId, userId, displayName });
    },

    leaderboard({ guildId, limit = 10, resolveName = null }) {
      return buildLeaderboard({ repo, guildId, limit, resolveName });
    },

    /** Passive activity XP for one message. Never reads message content. */
    handleMessage(message) {
      return passiveXp.handle(message);
    },

    /** Releases the database handle. */
    close() {
      try {
        db.close();
      } catch (error) {
        logger.debug?.('Closing the fun database threw.', { reason: error?.message });
      }
    },
  };
}
