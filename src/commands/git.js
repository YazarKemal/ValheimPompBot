import { SlashCommandBuilder } from 'discord.js';
import { leave } from '../music/commands.js';

export const meta = {
  category: 'music',
  // PompMusic owns every music command; none are registered to PompAI.
  bot: 'pompmusic',
  summary: 'PompMusic botunu kanaldan çıkar.',
  order: 21,
};

export const data = new SlashCommandBuilder()
  .setName('git')
  .setDescription('PompMusic botunu kanaldan çıkar.')
  .setDMPermission(false);

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ music?: object, logger?: object }} ctx
 */
export async function execute(interaction, ctx) {
  return leave(interaction, ctx);
}
