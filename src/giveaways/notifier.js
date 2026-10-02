import { ChannelType } from 'discord.js';
import { createNullLogger } from '../utils/logger.js';
import { buildGiveawayEmbed } from './embed.js';

/**
 * Posts giveaway announcements into a Discord channel.
 *
 * The notifier is the only part of the giveaway pipeline that touches Discord,
 * which is what keeps the monitor itself a pure HTTP-and-state component.
 *
 * Announcements are sent with no `content` and no mentions, so a giveaway can
 * never ping @everyone.
 */

/**
 * @param {object} options
 * @param {import('discord.js').Client} options.client
 * @param {string} options.channelName
 * @param {object} [options.logger]
 */
export function createChannelNotifier({ client, channelName, logger = createNullLogger() }) {
  /** Resolved once and cached; the channel is created by the setup blueprint. */
  let cached = null;

  async function resolveChannel() {
    if (cached) return cached;

    for (const guild of client.guilds.cache.values()) {
      const channel = guild.channels.cache.find(
        (candidate) =>
          candidate.type === ChannelType.GuildText &&
          candidate.name.toLowerCase() === channelName.toLowerCase(),
      );
      if (channel) {
        cached = channel;
        return channel;
      }
    }

    logger.warn('Giveaway channel not found; skipping announcements.', { channel: channelName });
    return null;
  }

  return {
    /**
     * @param {object} giveaway
     * @returns {Promise<boolean>} whether the message was posted
     */
    async announce(giveaway) {
      const channel = await resolveChannel();
      if (!channel) return false;

      // No `content`, no `allowedMentions` ping - an embed only.
      await channel.send({ embeds: [buildGiveawayEmbed(giveaway)] });
      logger.info('Announced a free game.', { key: giveaway.key, title: giveaway.title });
      return true;
    },

    /** Test seam: forget the resolved channel. */
    reset() {
      cached = null;
    },
  };
}
