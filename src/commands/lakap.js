import { SlashCommandBuilder } from 'discord.js';
import { lakap } from '../fun/commands.js';

export const meta = {
  category: 'fun',
  summary: 'Sunucudaki birine madencilik lakabı tak.',
  order: 46,
};

export const data = new SlashCommandBuilder()
  .setName('lakap')
  .setDescription('Bir madenciye lakap tak. Tamamen şans.')
  .setDMPermission(false)
  .addUserOption((option) =>
    option.setName('kullanici').setDescription('Kime? Boş bırakırsan kendine.').setRequired(false),
  );

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ fun?: object, random?: Function, logger?: object }} ctx
 */
export async function execute(interaction, ctx) {
  return lakap(interaction, ctx);
}
