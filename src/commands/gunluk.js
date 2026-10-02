import { SlashCommandBuilder } from 'discord.js';
import { gunluk } from '../fun/commands.js';

export const meta = {
  category: 'fun',
  summary: 'Günlük kasanı aç; seriyi bozmadan devam et.',
  order: 41,
};

export const data = new SlashCommandBuilder()
  .setName('gunluk')
  .setDescription('Günlük ödül kasasını aç. Her gün gelirsen seri büyür.')
  .setDMPermission(false);

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ fun?: object, logger?: object }} ctx
 */
export async function execute(interaction, ctx) {
  return gunluk(interaction, ctx);
}
