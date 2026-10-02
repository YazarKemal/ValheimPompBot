import { EmbedBuilder } from 'discord.js';

/**
 * Shared embed styling, so every PompAI response looks like it came from the
 * same bot. Kept tiny on purpose - commands still build their own fields.
 */

/** Discord blurple; matches the bot's presence and role colour. */
export const BRAND_COLOR = 0x5865f2;

/** Amber, used when something needs the reader's attention. */
export const WARNING_COLOR = 0xfaa61a;

/**
 * @param {object} [options]
 * @param {string} [options.title]
 * @param {string} [options.description]
 * @param {number} [options.color]
 * @param {string} [options.footer]
 */
export function brandEmbed({ title, description, color = BRAND_COLOR, footer = null } = {}) {
  const embed = new EmbedBuilder().setColor(color);
  if (title) embed.setTitle(title);
  if (description) embed.setDescription(description);
  if (footer) embed.setFooter({ text: footer });
  return embed;
}
