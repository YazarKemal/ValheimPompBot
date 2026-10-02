import { SlashCommandBuilder } from 'discord.js';
import { showQueue } from '../music/commands.js';

export const meta = {
  category: 'music',
  // PompMusic owns the music commands; they are never registered to PompAI.
  bot: 'pompmusic',
  summary: 'Kuyruğu göster.',
  order: 8,
};

export const data = new SlashCommandBuilder()
  .setName('kuyruk')
  .setDescription('Sıradaki şarkıları göster.')
  .setDMPermission(false);

/**
 * Secondary control. The primary flow is a plain song name in #muzik-istek.
 * Replies are public: a music action affects the whole channel.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ music?: object, logger?: object }} ctx
 */
export async function execute(interaction, ctx) {
  return showQueue(interaction, ctx);
}
