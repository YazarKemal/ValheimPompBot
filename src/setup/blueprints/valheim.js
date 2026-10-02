import { BLUEPRINT_VERSION, EVERYONE } from '../constants.js';

/**
 * The original Valheim Pomp layout from Phase 1.
 *
 * Kept as a named blueprint rather than deleted: the server is moving to
 * MiningFools, but this definition still documents the previous structure and
 * can be planned against with `--blueprint valheim`.
 */

export const ROLE_KEYS = Object.freeze({
  CHIEFTAIN: 'chieftain',
  ELDER: 'elder',
  SKALD: 'skald',
  HIRDMAN: 'hirdman',
  DRENGR: 'drengr',
  THRALL: 'thrall',
  POMPBOT: 'pompbot',
});

export const ROLES = Object.freeze([
  {
    key: 'chieftain',
    name: 'Chieftain',
    color: '#c0392b',
    hoist: true,
    mentionable: true,
    permissions: [
      'ViewChannel',
      'ManageGuild',
      'ManageRoles',
      'ManageChannels',
      'KickMembers',
      'BanMembers',
      'ModerateMembers',
      'ViewAuditLog',
      'ManageMessages',
    ],
  },
  {
    key: 'elder',
    name: 'Elder',
    color: '#e67e22',
    hoist: true,
    mentionable: true,
    permissions: ['ViewChannel', 'KickMembers', 'ModerateMembers', 'ManageMessages', 'ViewAuditLog'],
  },
  {
    key: 'skald',
    name: 'Skald',
    color: '#9b59b6',
    hoist: true,
    mentionable: true,
    permissions: ['ViewChannel', 'SendMessages', 'EmbedLinks', 'AttachFiles', 'ManageMessages'],
  },
  {
    key: 'hirdman',
    name: 'Hirdman',
    color: '#3498db',
    hoist: false,
    mentionable: true,
    permissions: ['ViewChannel', 'SendMessages', 'EmbedLinks', 'AttachFiles', 'UseExternalEmojis'],
  },
  {
    key: 'drengr',
    name: 'Drengr',
    color: '#2ecc71',
    hoist: false,
    mentionable: true,
    permissions: ['ViewChannel', 'SendMessages', 'AddReactions', 'ReadMessageHistory'],
  },
  {
    key: 'thrall',
    name: 'Thrall',
    color: '#95a5a6',
    hoist: false,
    mentionable: false,
    permissions: ['ViewChannel', 'ReadMessageHistory'],
  },
  {
    key: 'pompbot',
    name: 'PompBot',
    color: '#5865f2',
    hoist: false,
    mentionable: false,
    permissions: [
      'ViewChannel',
      'SendMessages',
      'EmbedLinks',
      'AttachFiles',
      'ReadMessageHistory',
      'ManageMessages',
      'UseApplicationCommands',
    ],
  },
]);

export const CATEGORIES = Object.freeze([
  { key: 'info', name: 'INFORMATION' },
  { key: 'community', name: 'COMMUNITY' },
  { key: 'voice', name: 'VOICE' },
  { key: 'staff', name: 'STAFF' },
]);

export const CHANNELS = Object.freeze([
  {
    key: 'welcome',
    name: 'welcome',
    type: 'text',
    category: 'info',
    topic: 'Welcome to the Valheim Pomp server. Start here.',
    readOnly: true,
  },
  {
    key: 'rules',
    name: 'rules',
    type: 'text',
    category: 'info',
    topic: 'Server rules. Read before posting.',
    readOnly: true,
  },
  {
    key: 'announcements',
    name: 'announcements',
    type: 'text',
    category: 'info',
    topic: 'Server news and event announcements.',
    overwrites: [
      { role: EVERYONE, deny: ['SendMessages'] },
      { role: 'Skald', allow: ['SendMessages'] },
    ],
  },
  {
    key: 'general',
    name: 'general',
    type: 'text',
    category: 'community',
    topic: 'General chat.',
  },
  {
    key: 'valheim-chat',
    name: 'valheim-chat',
    type: 'text',
    category: 'community',
    topic: 'Valheim talk: seeds, bosses, builds.',
  },
  {
    key: 'screenshots',
    name: 'screenshots',
    type: 'text',
    category: 'community',
    topic: 'Share your builds and adventures.',
    overwrites: [
      { role: 'Drengr', deny: ['AttachFiles'] },
      { role: 'Hirdman', allow: ['AttachFiles'] },
    ],
  },
  {
    key: 'bot-commands',
    name: 'bot-commands',
    type: 'text',
    category: 'community',
    topic: 'PompBot commands and AI experiments.',
  },
  { key: 'voice-general', name: 'General Voice', type: 'voice', category: 'voice' },
  { key: 'voice-valheim', name: 'Valheim Voice', type: 'voice', category: 'voice' },
  {
    key: 'staff-chat',
    name: 'staff-chat',
    type: 'text',
    category: 'staff',
    topic: 'Staff coordination.',
    // Spelled out explicitly rather than via a shorthand, so the staff role
    // names stay local to this blueprint instead of leaking into others.
    overwrites: [
      { role: EVERYONE, allow: [], deny: ['ViewChannel'] },
      { role: 'Chieftain', allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'], deny: [] },
      { role: 'Elder', allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'], deny: [] },
    ],
  },
]);

/**
 * @param {{ roles?: object[], categories?: object[], channels?: object[] }} [overrides]
 */
export function createValheimBlueprint(overrides = {}) {
  return {
    version: BLUEPRINT_VERSION,
    key: 'valheim',
    title: 'Valheim Pomp',
    roles: structuredClone(overrides.roles ?? ROLES),
    categories: structuredClone(overrides.categories ?? CATEGORIES),
    channels: structuredClone(overrides.channels ?? CHANNELS),
  };
}
