import { EmbedBuilder } from 'discord.js';
import { KIND_LABELS } from './provider.js';
import { formatDateTime, formatPrice, formatRemaining } from './format.js';
import { BRAND_COLOR } from '../utils/embeds.js';

/** Free stuff gets its own colour. */
export const GIVEAWAY_COLOR = 0x2ecc71;

export const EMBED_TITLE = '🎁 ÜCRETSİZ OYUN';
export const STORE_LINK_LABEL = 'Şimdi Al';

/**
 * Builds the announcement embed.
 *
 * The caller sends this with no content and no mentions, so an announcement
 * never pings @everyone.
 *
 * @param {object} giveaway Normalised giveaway.
 * @param {{ now?: number }} [options]
 * @returns {import('discord.js').EmbedBuilder}
 */
export function buildGiveawayEmbed(giveaway, { now = Date.now() } = {}) {
  const embed = new EmbedBuilder()
    .setColor(GIVEAWAY_COLOR)
    .setTitle(EMBED_TITLE)
    .setDescription(`## ${giveaway.title}`)
    .setFooter({ text: `PompAI · ${giveaway.platform}` });

  if (giveaway.url) embed.setURL(giveaway.url);

  const fields = [{ name: 'Platform', value: giveaway.platform, inline: true }];

  const normalPrice = formatPrice(giveaway.originalPrice);
  if (normalPrice) fields.push({ name: 'Normal fiyat', value: normalPrice, inline: true });

  const kind = KIND_LABELS[giveaway.kind] ?? giveaway.kind;
  fields.push({ name: 'Tür', value: kind, inline: true });

  const endsAt = formatDateTime(giveaway.endsAt);
  if (endsAt) {
    const remaining = formatRemaining(giveaway.endsAt, now);
    fields.push({
      name: 'Ücretsiz bitiş',
      value: remaining ? `${endsAt}\n(${remaining})` : endsAt,
      inline: false,
    });
  }

  if (giveaway.url) {
    fields.push({ name: 'Mağaza', value: `[${STORE_LINK_LABEL}](${giveaway.url})`, inline: false });
  }

  // Attribution for data we did not originate. Stated plainly and without any
  // logo or "powered by" wording, so nothing implies a partnership.
  if (giveaway.source) {
    fields.push({ name: 'Source', value: giveaway.source, inline: false });
  }

  embed.addFields(fields);

  // Wide store art reads best as the embed image; the colour bar stays visible.
  if (giveaway.imageUrl) embed.setImage(giveaway.imageUrl);

  return embed;
}

/**
 * Header line for a batch of announcements. Kept separate so the monitor can
 * post a single summary even when there is nothing to announce.
 */
export function buildSummaryLine(count) {
  if (count === 0) return null;
  return count === 1 ? 'Yeni bir ücretsiz oyun var!' : `${count} yeni ücretsiz oyun var!`;
}

export { BRAND_COLOR };
