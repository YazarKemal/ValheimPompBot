import { SlashCommandBuilder } from 'discord.js';
import { buildGiveawayEmbed } from '../giveaways/embed.js';
import { createVisibilityPolicy, isChannel, VISIBILITY } from '../ai/visibility.js';

export const meta = {
  category: 'giveaways',
  summary: 'Show the free games available right now.',
  order: 5,
};

export const data = new SlashCommandBuilder()
  .setName('ucretsiz')
  .setDescription('Şu anda ücretsiz olan Steam ve Epic oyunlarını göster.')
  .setDMPermission(false);

/** Exact wording required when nothing is running. */
export const EMPTY_MESSAGE = 'Şu anda tespit edilen aktif Steam/Epic hediyesi yok.';

/** Longest list rendered in full; the rest is summarised. */
export const MAX_LISTED = 5;

/**
 * On-demand query: reads the providers immediately instead of waiting for the
 * next polling interval.
 *
 * Ephemeral, so an on-demand lookup does not duplicate the monitor's public
 * announcements in the channel.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ giveaways?: { fetchActive: Function }, logger?: object }} ctx
 */
export async function execute(interaction, ctx) {
  // Not an AI command, so AI_RESPONSE_VISIBILITY does not apply. The giveaway
  // channel is a shared noticeboard and answers in the open there; anywhere
  // else the lookup stays private so it does not clutter unrelated channels.
  const visibility = createVisibilityPolicy(
    isChannel(interaction.channel?.name, ctx.config?.giveaways?.channelName)
      ? VISIBILITY.PUBLIC
      : VISIBILITY.EPHEMERAL,
  );

  await interaction.deferReply(visibility.replyOptions());

  const monitor = ctx.giveaways;
  if (!monitor) {
    await interaction.editReply('Ücretsiz oyun takibi bu kurulumda etkin değil.');
    return;
  }

  let result;
  try {
    result = await monitor.fetchActive();
  } catch (error) {
    ctx.logger?.warn?.('Free game lookup failed.', { reason: error?.message });
    await interaction.editReply('Ücretsiz oyun kaynaklarına şu anda ulaşılamıyor. Lütfen tekrar dene.');
    return;
  }

  const { giveaways = [], failures = [] } = result;

  if (giveaways.length === 0) {
    // A total provider outage is reported distinctly from a genuine empty list,
    // so "nothing is free" is never claimed when the truth is "we could not ask".
    const message =
      failures.length > 0 && failures.length >= (ctx.giveaways?.status?.().providers?.length ?? 0)
        ? 'Ücretsiz oyun kaynaklarına şu anda ulaşılamıyor. Lütfen tekrar dene.'
        : EMPTY_MESSAGE;
    await interaction.editReply(message);
    return;
  }

  const shown = giveaways.slice(0, MAX_LISTED);
  const embeds = shown.map((giveaway) => buildGiveawayEmbed(giveaway));

  const lines = [`🎁 **Şu anda ücretsiz: ${giveaways.length} oyun**`];
  if (giveaways.length > shown.length) {
    lines.push(`_(ilk ${shown.length} tanesi gösteriliyor)_`);
  }
  if (failures.length > 0) {
    lines.push(`_Bazı kaynaklara ulaşılamadı: ${failures.map((failure) => failure.provider).join(', ')}_`);
  }

  await interaction.editReply({ content: lines.join('\n'), embeds });
}
