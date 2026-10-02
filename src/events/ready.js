import { Events } from 'discord.js';

export const name = Events.ClientReady;
export const once = true;

/**
 * @param {import('discord.js').Client} client
 * @param {{ logger: object, config: object, commands: Map<string, unknown>, startedAt: number }} ctx
 */
export async function execute(client, ctx) {
  const startupMs = Date.now() - ctx.startedAt;
  ctx.logger.info('Gateway connection established.', {
    user: client.user?.tag ?? '(unknown)',
    id: client.user?.id ?? null,
    guilds: client.guilds.cache.size,
    commands: ctx.commands.size,
    startupMs,
  });

  // A presence is cosmetic and safe; it makes the bot easy to spot in a member list.
  client.user?.setPresence?.({
    status: 'online',
    activities: [{ name: 'for the Chieftain', type: 3 }],
  });
}
