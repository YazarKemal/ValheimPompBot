import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { BotError } from '../utils/errors.js';
import { redact } from '../utils/redact.js';
import { DISCORD_GROUP, ENV_SCHEMA } from './schema.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Repository root: src/config -> src -> root. */
export const PROJECT_ROOT = path.resolve(HERE, '..', '..');

/** Thrown when the environment is unusable. Never contains secret values. */
export class ConfigError extends BotError {
  /**
   * @param {string} message
   * @param {{ issues?: Array<{key: string, problem: string}>, code?: string }} [options]
   */
  constructor(message, { issues = [], code = 'CONFIG_INVALID' } = {}) {
    super(message, {
      code,
      details: { fields: issues.map((issue) => `${issue.key} (${issue.problem})`) },
    });
    this.issues = issues;
  }
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off']);

/**
 * Coerces a raw string according to its schema entry.
 * @returns {{ value: unknown, problem: string|null }}
 */
function coerce(field, raw) {
  switch (field.type) {
    case 'boolean': {
      const normalized = raw.toLowerCase();
      if (TRUTHY.has(normalized)) return { value: true, problem: null };
      if (FALSY.has(normalized)) return { value: false, problem: null };
      return { value: null, problem: `must be one of ${[...TRUTHY].join(', ')} / ${[...FALSY].join(', ')}` };
    }
    case 'number': {
      const value = Number(raw);
      if (!Number.isFinite(value)) return { value: null, problem: 'must be a number' };
      return { value, problem: null };
    }
    case 'enum': {
      if (!field.values.includes(raw)) {
        return { value: null, problem: `must be one of: ${field.values.join(', ')}` };
      }
      return { value: raw, problem: null };
    }
    default:
      return { value: raw, problem: null };
  }
}

/**
 * Pure environment parser. Collects every problem instead of failing on the
 * first one, so a misconfigured `.env` can be fixed in a single pass.
 *
 * @param {Record<string, string|undefined>} env
 * @param {{ requireDiscord?: boolean }} [options]
 * @returns {{ config: object|null, issues: Array<{key: string, problem: string}> }}
 */
export function parseEnv(env = {}, { requireDiscord = true } = {}) {
  const issues = [];
  const flat = {};
  /** Old names that were used because the new one was not set. */
  const aliasesUsed = [];

  for (const field of ENV_SCHEMA) {
    const skipRequired = !requireDiscord && field.group === DISCORD_GROUP && field.required;

    // A renamed variable still works under its old name, so an existing .env
    // keeps running. The substitution is reported so it can be fixed rather
    // than silently depended on.
    let raw = env[field.key];
    let usedAlias = null;
    if ((raw === undefined || raw === null || String(raw).trim() === '') && Array.isArray(field.aliases)) {
      const fallback = field.aliases.find(
        (alias) => env[alias] !== undefined && env[alias] !== null && String(env[alias]).trim() !== '',
      );
      if (fallback) {
        raw = env[fallback];
        usedAlias = fallback;
        aliasesUsed.push({ from: fallback, to: field.key });
      }
    }

    const present = raw !== undefined && raw !== null && String(raw).trim() !== '';

    if (!present) {
      if (field.required && !skipRequired) {
        issues.push({ key: field.key, problem: 'is required but was not set' });
        continue;
      }
      if (field.default === undefined) {
        flat[field.key] = null;
        continue;
      }
      // Defaults are declared as strings so the schema stays a plain data file;
      // they must go through the same coercion as real values.
      const { value, problem } = coerce(field, String(field.default));
      if (problem) {
        issues.push({ key: field.key, problem: `has an invalid default: ${problem}` });
        continue;
      }
      flat[field.key] = value;
      continue;
    }

    const { value, problem } = coerce(field, String(raw).trim());
    if (problem) {
      issues.push({ key: field.key, problem });
      continue;
    }
    if (field.validate) {
      const validationProblem = field.validate(value);
      if (validationProblem) {
        issues.push({ key: field.key, problem: validationProblem });
        continue;
      }
    }
    flat[field.key] = value;
  }

  if (issues.length > 0) return { config: null, issues, aliasesUsed };

  const config = Object.freeze({
    env: flat.BOT_ENV,
    logLevel: flat.LOG_LEVEL,
    dryRun: flat.DRY_RUN,
    connect: flat.BOT_CONNECT,
    platform: flat.DEPLOY_PLATFORM,
    persistentStoragePath: flat.PERSISTENT_STORAGE_PATH || null,
    discord: Object.freeze({
      token: flat.DISCORD_TOKEN,
      clientId: flat.DISCORD_CLIENT_ID,
      guildId: flat.DISCORD_GUILD_ID || null,
      expectedGuildName: flat.DISCORD_EXPECTED_GUILD_NAME || null,
    }),
    ai: Object.freeze({
      provider: flat.AI_PROVIDER,
      apiKey: flat.AI_API_KEY || null,
      model: flat.AI_MODEL || null,
      timeoutMs: flat.AI_TIMEOUT_MS,
      maxOutputTokens: flat.AI_MAX_OUTPUT_TOKENS,
      temperature: flat.AI_TEMPERATURE,
      userCooldownSeconds: flat.AI_USER_COOLDOWN_SECONDS,
      maxPromptChars: flat.AI_MAX_PROMPT_CHARS,
      historyMessages: flat.AI_HISTORY_MESSAGES,
      responseVisibility: flat.AI_RESPONSE_VISIBILITY,
    }),
    /**
     * PompMusic is a separate Discord application with its own token. Its
     * settings are grouped apart from PompAI's so the two can never be
     * confused for one another.
     */
    pompMusic: Object.freeze({
      enabled: flat.POMPMUSIC_ENABLED,
      token: flat.POMPMUSIC_TOKEN || null,
      clientId: flat.POMPMUSIC_CLIENT_ID || null,
      textChannel: flat.POMPMUSIC_TEXT_CHANNEL,
      voiceChannel: flat.POMPMUSIC_VOICE_CHANNEL,
      // Stay-connected overrides the idle timer: 0 means "never disconnect".
      stayConnected: flat.POMPMUSIC_STAY_CONNECTED,
      idleDisconnectSeconds: flat.POMPMUSIC_STAY_CONNECTED ? 0 : flat.POMPMUSIC_IDLE_DISCONNECT_SECONDS,
      requestCooldownSeconds: flat.POMPMUSIC_REQUEST_COOLDOWN_SECONDS,
      maxQueueSize: flat.POMPMUSIC_MAX_QUEUE_SIZE,
      maxTrackMinutes: flat.POMPMUSIC_MAX_TRACK_MINUTES,
      searchLimit: flat.POMPMUSIC_SEARCH_RESULTS,
      selectionTimeoutSeconds: flat.POMPMUSIC_SELECTION_TIMEOUT_SECONDS,
      streamBackend: flat.POMPMUSIC_STREAM_BACKEND,
      ytdlpPath: flat.YTDLP_PATH || null,
      ytdlpFormat: flat.POMPMUSIC_YTDLP_FORMAT,
      ytdlpStartupTimeoutMs: flat.POMPMUSIC_YTDLP_STARTUP_TIMEOUT_MS,
      ytdlpFirstByteTimeoutMs: flat.POMPMUSIC_YTDLP_FIRST_BYTE_TIMEOUT_MS,
      ytdlpMaxAttempts: flat.POMPMUSIC_YTDLP_MAX_ATTEMPTS,
      ytdlpRetryDelayMs: flat.POMPMUSIC_YTDLP_RETRY_DELAY_MS,
      potProvider: flat.POMPMUSIC_POT_PROVIDER,
      potServerHome: flat.POMPMUSIC_POT_SERVER_HOME,
      potPython: flat.POMPMUSIC_POT_PYTHON,
      potPlayerClient: flat.POMPMUSIC_YTDLP_PLAYER_CLIENT,
      battleSeconds: flat.POMPMUSIC_BATTLE_SECONDS,
    }),
    /**
     * The fun layer. Nothing here reaches a model: every reward comes from a
     * server-side table, so the whole economy runs with no AI key configured.
     */
    fun: Object.freeze({
      mineCooldownSeconds: flat.FUN_MINE_COOLDOWN_SECONDS,
      dailyCooldownHours: flat.FUN_DAILY_COOLDOWN_HOURS,
      messageXpEnabled: flat.FUN_MESSAGE_XP_ENABLED,
      messageXpCooldownSeconds: flat.FUN_MESSAGE_XP_COOLDOWN_SECONDS,
      partyTimeoutMinutes: flat.FUN_PARTY_TIMEOUT_MINUTES,
      dbFile: flat.FUN_DB_FILE || null,
    }),
    giveaways: Object.freeze({
      enabled: flat.FREE_GAMES_ENABLED,
      intervalMinutes: flat.FREE_GAMES_INTERVAL_MINUTES,
      timeoutMs: flat.FREE_GAMES_TIMEOUT_MS,
      retentionDays: flat.FREE_GAMES_RETENTION_DAYS,
      stateFile: flat.FREE_GAMES_STATE_FILE || null,
      channelName: flat.FREE_GAMES_CHANNEL,
      userAgent: flat.FREE_GAMES_USER_AGENT || null,
      steamSource: flat.STEAM_GIVEAWAY_SOURCE,
      itadApiKey: flat.ITAD_API_KEY || null,
    }),
  });

  return { config, issues: [], aliasesUsed };
}

/**
 * Builds the runtime configuration.
 *
 * @param {object} [options]
 * @param {Record<string, string|undefined>} [options.env] Environment source.
 *   Defaults to `process.env`.
 * @param {boolean} [options.requireDiscord] Enforce DISCORD_TOKEN / CLIENT_ID.
 *   Defaults to true; pass false for offline tooling such as the setup CLI.
 * @param {boolean} [options.loadDotenv] Read `.env` from disk. Defaults to true
 *   only when reading from `process.env`, so tests never touch the real file.
 * @param {string} [options.dotenvPath]
 * @returns {object} Frozen config object.
 * @throws {ConfigError}
 */
export function loadConfig(options = {}) {
  const usingProcessEnv = options.env === undefined;
  const env = options.env ?? process.env;
  // Only an explicit caller-provided env skips the .env file, so tests and
  // offline tooling never read the developer's real credentials.
  const loadDotenv = options.loadDotenv ?? usingProcessEnv;
  const requireDiscord = options.requireDiscord ?? true;

  const result = loadDotenv
    ? parseEnv(readDotenvFile(env, options.dotenvPath), { requireDiscord })
    : parseEnv(env, { requireDiscord });

  if (!result.config) {
    throw new ConfigError(
      `Configuration is invalid - ${result.issues.length} problem(s) found. ` +
        'Copy .env.example to .env and fill in the missing values.',
      { issues: result.issues },
    );
  }
  return result.config;
}

/**
 * Reads `.env` into a plain object without mutating `process.env`, so a bad
 * file cannot leak into unrelated code paths.
 *
 * Real environment variables take precedence over the file. That is the
 * convention every other tool follows, and it is what makes an ad-hoc override
 * such as `BOT_CONNECT=false npm start` actually work.
 *
 * @param {Record<string, string|undefined>} base Usually `process.env`.
 * @param {string} [dotenvPath]
 */
function readDotenvFile(base, dotenvPath) {
  const filePath = dotenvPath ?? path.join(PROJECT_ROOT, '.env');
  const parsed = dotenv.config({ path: filePath, quiet: true, processEnv: {} }).parsed ?? {};
  return { ...parsed, ...base };
}

/**
 * Config summary safe to log or print. Secrets are replaced with `[redacted]`.
 * @param {object} config
 */
export function describeConfig(config) {
  return redact({
    env: config.env,
    logLevel: config.logLevel,
    dryRun: config.dryRun,
    connect: config.connect,
    discord: {
      token: config.discord.token,
      clientId: config.discord.clientId,
      guildId: config.discord.guildId ?? '(global)',
      expectedGuildName: config.discord.expectedGuildName ?? '(not checked)',
    },
    ai: {
      provider: config.ai.provider,
      apiKey: config.ai.apiKey,
      model: config.ai.model ?? '(provider default)',
      timeoutMs: config.ai.timeoutMs,
    },
  });
}

export { ENV_SCHEMA };
