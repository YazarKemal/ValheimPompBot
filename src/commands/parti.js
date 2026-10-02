import { SlashCommandBuilder } from 'discord.js';
import { PARTY_META } from '../fun/content/party-banks.js';
import { parti } from '../fun/commands.js';

export const meta = {
  category: 'fun',
  summary: 'Doğruluk, cesaret ve "kim daha olası" oyunları.',
  order: 45,
};

export const data = new SlashCommandBuilder()
  .setName('parti')
  .setDescription('Parti oyunu başlat. Sorular hazır, cevaplar sunucudan.')
  .setDMPermission(false)
  .addStringOption((option) =>
    option
      .setName('tur')
      .setDescription('Hangi oyun?')
      .setRequired(true)
      .addChoices(
        { name: `${PARTY_META.dogruluk.emoji} Doğruluk`, value: 'dogruluk' },
        { name: `${PARTY_META.cesaret.emoji} Cesaret`, value: 'cesaret' },
        { name: `${PARTY_META['kim-daha-olasi'].emoji} Kim daha olası?`, value: 'kim-daha-olasi' },
      ),
  );

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ fun?: object, logger?: object }} ctx
 */
export async function execute(interaction, ctx) {
  return parti(interaction, ctx);
}
