import { SlashCommandBuilder } from 'discord.js';
import { profil } from '../fun/commands.js';

export const meta = {
  category: 'fun',
  summary: 'Seviye, unvan, altın ve kazı istatistikleri.',
  order: 43,
};

export const data = new SlashCommandBuilder()
  .setName('profil')
  .setDescription('Madenci profilini göster.')
  .setDMPermission(false)
  .addUserOption((option) =>
    option.setName('kullanici').setDescription('Kimin profili? Boş bırakırsan kendin.').setRequired(false),
  );

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ fun?: object, logger?: object }} ctx
 */
export async function execute(interaction, ctx) {
  return profil(interaction, ctx);
}
