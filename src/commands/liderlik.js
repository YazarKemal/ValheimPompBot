import { SlashCommandBuilder } from 'discord.js';
import { liderlik } from '../fun/commands.js';

export const meta = {
  category: 'fun',
  summary: 'Sunucunun en çok kazan madencileri.',
  order: 44,
};

export const data = new SlashCommandBuilder()
  .setName('liderlik')
  .setDescription('Bu sunucunun ilk 10 madencisini göster.')
  .setDMPermission(false);

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ fun?: object, logger?: object }} ctx
 */
export async function execute(interaction, ctx) {
  return liderlik(interaction, ctx);
}
