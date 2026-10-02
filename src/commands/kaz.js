import { SlashCommandBuilder } from 'discord.js';
import { kaz } from '../fun/commands.js';

export const meta = {
  category: 'fun',
  summary: 'Kazma salladın mı? Madenden bir şeyler çıkar.',
  order: 40,
};

export const data = new SlashCommandBuilder()
  .setName('kaz')
  .setDescription('Madende kazı yap; cevher, altın ve XP kazan.')
  .setDMPermission(false);

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ fun?: object, logger?: object }} ctx
 */
export async function execute(interaction, ctx) {
  return kaz(interaction, ctx);
}
