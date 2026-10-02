import { SlashCommandBuilder } from 'discord.js';
import { skip } from '../music/commands.js';

export const meta = {
  category: 'music',
  // PompMusic owns the music commands; they are never registered to PompAI.
  bot: 'pompmusic',
  summary: 'Sıradaki şarkıya geç.',
  order: 9,
};

export const data = new SlashCommandBuilder()
  .setName('gec')
  .setDescription('Sıradaki şarkıya geç.')
  .setDMPermission(false);

/**
 * Secondary control. The primary flow is a plain song name in #muzik-istek.
 * Replies are public: a music action affects the whole channel.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ music?: object, logger?: object }} ctx
 */
export async function execute(interaction, ctx) {
  return skip(interaction, ctx);
}
