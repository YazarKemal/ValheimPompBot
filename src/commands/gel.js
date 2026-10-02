import { SlashCommandBuilder } from 'discord.js';
import { summon } from '../music/commands.js';

export const meta = {
  category: 'music',
  // PompMusic owns every music command; none are registered to PompAI.
  bot: 'pompmusic',
  summary: 'Bulunduğun ses kanalına PompMusic botunu çağır.',
  order: 20,
};

export const data = new SlashCommandBuilder()
  .setName('gel')
  .setDescription('PompMusic botunu bulunduğun ses kanalına çağır.')
  .setDMPermission(false);

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ music?: object, logger?: object }} ctx
 */
export async function execute(interaction, ctx) {
  return summon(interaction, ctx);
}
