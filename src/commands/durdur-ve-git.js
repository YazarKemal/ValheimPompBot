import { SlashCommandBuilder } from 'discord.js';
import { stopAndLeave } from '../music/commands.js';

export const meta = {
  category: 'music',
  // PompMusic owns every music command; none are registered to PompAI.
  bot: 'pompmusic',
  summary: 'Durdur ve kanaldan çıkar.',
  order: 22,
};

export const data = new SlashCommandBuilder()
  .setName('durdur-ve-git')
  .setDescription('Çalmayı durdur ve PompMusic botunu çıkar.')
  .setDMPermission(false);

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ music?: object, logger?: object }} ctx
 */
export async function execute(interaction, ctx) {
  return stopAndLeave(interaction, ctx);
}
