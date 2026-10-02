import { MessageFlags, SlashCommandBuilder } from 'discord.js';

export const meta = {
  category: 'ai',
  summary: 'Forget your PompAI conversation in this channel.',
  order: 4,
};

export const data = new SlashCommandBuilder()
  .setName('clear')
  .setDescription('Forget your PompAI conversation in this channel.')
  .setDMPermission(false);

/**
 * Clears the invoking user's memory for the current channel only.
 *
 * Deliberately narrow: it cannot touch another user's history, and it cannot
 * touch this user's history in any other channel. The reply is always
 * ephemeral, so clearing never announces itself to the channel.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ memory?: object, logger?: object }} ctx
 */
export async function execute(interaction, ctx) {
  const scope = {
    guildId: interaction.guildId ?? interaction.guild?.id ?? null,
    channelId: interaction.channelId ?? interaction.channel?.id ?? null,
    userId: interaction.user?.id ?? 'unknown',
  };

  const removed = ctx.memory?.clear(scope) ?? 0;

  const content =
    removed === 0
      ? '🧹 Nothing to clear - you have no PompAI history in this channel.'
      : `🧹 Cleared ${removed} message${removed === 1 ? '' : 's'} of your PompAI history in this channel.`;

  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}
