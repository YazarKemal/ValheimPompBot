import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { GAME_NAMESPACE } from './oyun.js';
import { MAX_GAME_NAME_CHARS, normaliseGameName } from '../ai/gaming.js';

export const meta = {
  category: 'ai',
  summary: 'Forget your PompAI chat about one game.',
  order: 7,
};

export const data = new SlashCommandBuilder()
  .setName('oyun-temizle')
  .setDescription('Bir oyun hakkındaki PompAI sohbetini unut.')
  .setDMPermission(false)
  .addStringOption((option) =>
    option
      .setName('oyun')
      .setDescription('Hangi oyunun sohbeti silinsin?')
      .setRequired(true)
      .setMaxLength(MAX_GAME_NAME_CHARS),
  );

/**
 * Clears the invoking user's memory for exactly one game.
 *
 * Scoped as narrowly as /clear: it cannot reach another user's history, nor
 * this user's history for any other game, nor the MiningFools /ask history.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ memory?: object }} ctx
 */
export async function execute(interaction, ctx) {
  const game = normaliseGameName(interaction.options.getString('oyun', true));

  const scope = {
    namespace: GAME_NAMESPACE,
    guildId: interaction.guildId ?? interaction.guild?.id ?? null,
    topic: game.toLowerCase(),
    userId: interaction.user?.id ?? 'unknown',
  };

  const removed = ctx.memory?.clear(scope) ?? 0;

  const content =
    removed === 0
      ? `🧹 **${game}** için temizlenecek bir sohbet geçmişin yok.`
      : `🧹 **${game}** için ${removed} mesajlık PompAI geçmişin silindi.`;

  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}
