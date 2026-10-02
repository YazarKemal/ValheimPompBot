import { createNullLogger } from '../utils/logger.js';
import { connectClient, resolveGuild } from './session.js';
import { guardGuild } from './read-only-guard.js';
import { snapshotGuild } from './state.js';

/**
 * Read-only guild snapshot.
 *
 * This module observes a server and writes nothing. It is the input side of the
 * planner: `npm run setup:plan -- --from-json <snapshot>` turns the file this
 * produces into an exact dry-run plan.
 *
 * The read-only promise is defended three ways:
 *   1. `guardReadOnly` (read-only-guard.js) wraps the guild and its managers, so
 *      calling any known mutating method throws instead of changing the server.
 *   2. Nothing here reaches for a channel or role object's own mutating methods;
 *      every value comes from a cache.
 *   3. `npm run check` statically asserts this file contains no mutating calls.
 */

export const SNAPSHOT_VERSION = 1;

// Re-exported so callers can reach the guard through the snapshot module.
export { guardReadOnly, guardGuild, MUTATING_METHODS } from './read-only-guard.js';

/**
 * Builds the snapshot document. Pure observation - reads caches only.
 *
 * @param {import('discord.js').Guild} guild
 * @param {{ capturedAt?: string }} [options]
 */
export function buildSnapshotDocument(guild, { capturedAt = new Date().toISOString() } = {}) {
  const state = snapshotGuild(guild);

  return {
    snapshotVersion: SNAPSHOT_VERSION,
    capturedAt,
    blueprintHint: null,
    guild: {
      id: guild.id,
      name: guild.name,
      memberCount: guild.memberCount ?? null,
      ownerId: guild.ownerId ?? null,
      createdTimestamp: guild.createdTimestamp ?? null,
    },
    // Bot and integration roles are managed by Discord. They are reported so a
    // human can see what must keep working, and excluded from `roles` so the
    // planner can never propose changing one.
    managedRoles: [...guild.roles.cache.values()]
      .filter((role) => role.managed)
      .map((role) => ({ id: role.id, name: role.name })),
    ...state,
  };
}

/**
 * Connects, captures a snapshot, and disconnects. Issues GET requests only.
 *
 * @param {object} options
 * @param {string} options.token Bot token. Never logged.
 * @param {string|null} [options.guildId] Defaults to the bot's first guild.
 * @param {object} [options.logger]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{ document: object, client: import('discord.js').Client }>}
 */
export async function captureGuildSnapshot({
  token,
  guildId = null,
  logger = createNullLogger(),
  timeoutMs = 30000,
}) {
  const client = await connectClient({ token, logger, timeoutMs });

  try {
    const guild = resolveGuild(client, guildId);
    logger.debug('Capturing guild state.', { guild: guild.name, id: guild.id });
    return { document: buildSnapshotDocument(guardGuild(guild)), client };
  } catch (error) {
    await client.destroy().catch(() => {});
    throw error;
  }
}
