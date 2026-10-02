import { SlashCommandBuilder } from 'discord.js';
import { resume } from '../music/commands.js';

export const meta = {
  category: 'music',
  // PompMusic owns the music commands; they are never registered to PompAI.
  bot: 'pompmusic',
  summary: 'Devam et.',
  order: 12,
};

export const data = new SlashCommandBuilder()
  .setName('devam')
  .setDescription('Duraklatılmış şarkıyı sürdür.')
  .setDMPermission(false);

/**
 * Secondary control. The primary flow is a plain song name in #muzik-istek.
 * Replies are public: a music action affects the whole channel.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ music?: object, logger?: object }} ctx
 */
export async function execute(interaction, ctx) {
  return resume(interaction, ctx);
}
