import { SlashCommandBuilder } from 'discord.js';
import { fal } from '../fun/commands.js';

export const meta = {
  category: 'fun',
  summary: 'PompAI falı: ciddiye almayın, eğlencesine.',
  order: 47,
};

export const data = new SlashCommandBuilder()
  .setName('fal')
  .setDescription('PompAI senin için fal bakar. Sadece eğlence.')
  .setDMPermission(false);

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ fun?: object, random?: Function, logger?: object }} ctx
 */
export async function execute(interaction, ctx) {
  return fal(interaction, ctx);
}
