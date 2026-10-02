import { SlashCommandBuilder } from 'discord.js';
import { kapisma } from '../music/battle-command.js';

export const meta = {
  category: 'music',
  // PompMusic owns every music command; none are registered to PompAI.
  bot: 'pompmusic',
  summary: 'İki şarkıyı karşı karşıya getir, sunucu oylasın.',
  order: 30,
};

export const data = new SlashCommandBuilder()
  .setName('kapisma')
  .setDescription('İki şarkı arasında oylama başlat. Müzik çalınmaz, sadece oylama.')
  .setDMPermission(false)
  .addStringOption((option) =>
    option.setName('sarki1').setDescription('Birinci şarkı').setRequired(true).setMaxLength(200),
  )
  .addStringOption((option) =>
    option.setName('sarki2').setDescription('İkinci şarkı').setRequired(true).setMaxLength(200),
  );

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ music?: object, logger?: object }} ctx
 */
export async function execute(interaction, ctx) {
  return kapisma(interaction, ctx);
}
