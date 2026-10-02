import { ChannelType } from 'discord.js';
import { normaliseRoleName } from './permissions.js';

/**
 * Reads the live guild into a plain, serialisable snapshot.
 *
 * The planner only ever sees this shape, which is what makes the whole setup
 * pipeline testable without a Discord connection: in tests a hand-written
 * object is indistinguishable from a real snapshot.
 */

/** Discord channel type number -> blueprint type name. */
const CHANNEL_TYPE_NAMES = Object.freeze({
  [ChannelType.GuildText]: 'text',
  [ChannelType.GuildVoice]: 'voice',
  [ChannelType.GuildCategory]: 'category',
  [ChannelType.GuildAnnouncement]: 'announcement',
  [ChannelType.GuildForum]: 'forum',
  [ChannelType.GuildStageVoice]: 'stage',
});

/** Blueprint type name -> Discord channel type number. */
export const CHANNEL_TYPES = Object.freeze({
  text: ChannelType.GuildText,
  voice: ChannelType.GuildVoice,
  category: ChannelType.GuildCategory,
  announcement: ChannelType.GuildAnnouncement,
  forum: ChannelType.GuildForum,
});

/**
 * @param {number} type
 * @returns {string}
 */
export function channelTypeName(type) {
  return CHANNEL_TYPE_NAMES[type] ?? `unknown(${type})`;
}

/** An empty guild, used for planning against a fresh server. */
export function emptyGuildState() {
  return { roles: [], categories: [], channels: [] };
}

/**
 * @param {number} color
 * @returns {string} lower-case `#rrggbb`
 */
function toHexColor(color) {
  return `#${(color ?? 0).toString(16).padStart(6, '0').slice(-6)}`;
}

/**
 * Snapshots a discord.js Guild.
 * @param {import('discord.js').Guild} guild
 * @returns {{ roles: object[], categories: object[], channels: object[] }}
 */
export function snapshotGuild(guild) {
  const roles = [];
  for (const role of guild.roles.cache.values()) {
    // @everyone is managed by Discord and cannot be created or meaningfully edited.
    if (role.id === guild.id || role.managed) continue;
    roles.push({
      id: role.id,
      name: role.name,
      color: toHexColor(role.color),
      hoist: Boolean(role.hoist),
      mentionable: Boolean(role.mentionable),
      permissions: [...role.permissions.toArray()].sort(),
    });
  }

  const categories = [];
  const channels = [];
  for (const channel of guild.channels.cache.values()) {
    if (channel.type === ChannelType.GuildCategory) {
      categories.push({ id: channel.id, name: channel.name });
      continue;
    }
    channels.push({
      id: channel.id,
      name: channel.name,
      type: channelTypeName(channel.type),
      topic: channel.topic ?? null,
      parentId: channel.parentId ?? null,
      parentName: channel.parent?.name ?? null,
      overwrites: readOverwrites(channel),
    });
  }

  return { roles, categories, channels };
}

/**
 * Reads a channel's permission overwrites into planner-friendly rules.
 * @param {import('discord.js').GuildChannel} channel
 */
export function readOverwrites(channel) {
  const rules = [];
  for (const overwrite of channel.permissionOverwrites?.cache?.values() ?? []) {
    const isEveryone = overwrite.id === channel.guild?.id;
    const roleName = isEveryone ? '@everyone' : (overwrite.name ?? overwrite.id);
    rules.push({
      role: normaliseRoleName(roleName),
      allow: [...overwrite.allow.toArray()].sort(),
      deny: [...overwrite.deny.toArray()].sort(),
    });
  }
  return rules;
}
