import { SlashCommandBuilder } from 'discord.js';
import { envanter } from '../fun/commands.js';

export const meta = {
  category: 'fun',
  summary: 'Kazıp biriktirdiğin cevherleri göster.',
  order: 42,
};

export const data = new SlashCommandBuilder()
  .setName('envanter')
  .setDescription('Envanterindeki cevherleri ve miktarlarını göster.')
  .setDMPermission(false);

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ fun?: object, logger?: object }} ctx
 */
export async function execute(interaction, ctx) {
  return envanter(interaction, ctx);
}
