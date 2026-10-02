import { MessageFlags, SlashCommandBuilder } from 'discord.js';

export const meta = {
  category: 'diagnostics',
  summary: 'Check that PompAI is awake and measure latency.',
  order: 1,
};

export const data = new SlashCommandBuilder()
  .setName('ping')
  .setDescription('Check that PompAI is awake and measure latency.')
  .setDMPermission(false);

/**
 * Reply is ephemeral: latency is only interesting to the person asking, and it
 * keeps the channel clean.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function execute(interaction) {
  const startedAt = Date.now();
  await interaction.reply({ content: 'Pinging...', flags: MessageFlags.Ephemeral });

  // The edit is a second full round trip through the gateway.
  const roundTripMs = Date.now() - startedAt;
  const gatewayMs = Math.round(interaction.client?.ws?.ping ?? -1);

  await interaction.editReply({
    content: [
      '🏓 **Pong!**',
      `Round trip: \`${roundTripMs}ms\``,
      `Gateway: \`${gatewayMs >= 0 ? `${gatewayMs}ms` : 'unavailable'}\``,
    ].join('\n'),
  });
}
