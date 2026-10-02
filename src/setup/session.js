import { Client, Events, GatewayIntentBits } from 'discord.js';
import { BotError } from '../utils/errors.js';
import { createNullLogger } from '../utils/logger.js';
import { createDiscordGuildAdapter } from './adapter.js';
import { guardGuild } from './snapshot.js';
import { snapshotGuild } from './state.js';

/**
 * A live guild connection.
 *
 * A session is the only object in the codebase that holds both a readable and a
 * writable view of a guild, so it is deliberately small and explicit:
 *
 *   guild    - the raw discord.js guild, for identity checks
 *   adapter  - the *only* write path, which has no delete method at all
 *   refresh()- re-reads the guild and returns a fresh, guarded snapshot
 *   close()  - disconnects
 *
 * Tests substitute a fake session with the same shape, which is what lets the
 * whole live-apply pipeline be exercised without touching Discord.
 */

/**
 * Connects a client and waits until the gateway is ready.
 * @param {{ token: string, logger?: object, timeoutMs?: number }} options
 * @returns {Promise<import('discord.js').Client>}
 */
export async function connectClient({ token, logger = createNullLogger(), timeoutMs = 30000 }) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  // Registered before login so a fast READY cannot be missed.
  let markReady;
  const ready = new Promise((resolve) => {
    markReady = resolve;
  });
  client.once(Events.ClientReady, markReady);

  try {
    logger.debug('Connecting to Discord.');
    await client.login(token);
    if (!client.isReady()) {
      await withTimeout(ready, timeoutMs, 'Timed out waiting for the gateway to become ready.');
    }
    return client;
  } catch (error) {
    await client.destroy().catch(() => {});
    throw error;
  }
}

/**
 * Picks the guild to operate on.
 * @param {import('discord.js').Client} client
 * @param {string|null} guildId
 */
export function resolveGuild(client, guildId) {
  const guild = guildId ? client.guilds.cache.get(guildId) : client.guilds.cache.first();
  if (!guild) {
    throw new BotError(
      guildId
        ? `The bot is not a member of guild ${guildId}.`
        : 'The bot is not a member of any guild.',
      { code: 'SNAPSHOT_GUILD_NOT_FOUND', details: { guildId } },
    );
  }
  return guild;
}

/**
 * Opens a live session against a guild.
 *
 * @param {{ token: string, guildId: string|null, logger?: object, timeoutMs?: number }} options
 * @returns {Promise<{ guild: object, adapter: object, refresh: Function, close: Function }>}
 */
export async function createDiscordSession({ token, guildId = null, logger = createNullLogger(), timeoutMs = 30000 }) {
  const client = await connectClient({ token, logger, timeoutMs });

  let guild;
  try {
    guild = resolveGuild(client, guildId);
  } catch (error) {
    await client.destroy().catch(() => {});
    throw error;
  }

  return {
    guild,
    adapter: createDiscordGuildAdapter(guild),

    /**
     * Re-reads the guild from Discord and returns a fresh snapshot.
     *
     * Forced fetches rather than trusting the cache: convergence verification is
     * only meaningful against state that came back from the API.
     */
    async refresh() {
      await guild.fetch();
      await Promise.all([guild.channels.fetch(), guild.roles.fetch()]);
      return snapshotGuild(guardGuild(guild));
    },

    async close() {
      await client.destroy().catch(() => {});
    },
  };
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} message
 * @returns {Promise<T>}
 */
export async function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new BotError(message, { code: 'SNAPSHOT_TIMEOUT' })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
