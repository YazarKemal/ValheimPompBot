import { ChannelType, PermissionsBitField } from 'discord.js';
import { EVERYONE } from './blueprint.js';
import { CHANNEL_TYPES } from './state.js';
import { BotError } from '../utils/errors.js';

/**
 * Thin wrapper over discord.js state-changing calls.
 *
 * The planner produces plain action objects; this adapter is the only place
 * that knows how to turn them into API calls. Tests substitute a fake adapter
 * with the same method names, so the apply pipeline is exercised end to end
 * without a network connection.
 *
 * Adapter contract:
 *   createRole(spec)                  -> { id, name }
 *   updateRole(id, changes)           -> void
 *   createCategory(spec)              -> { id, name }
 *   createChannel(spec)               -> { id, name }
 *   updateChannel(id, changes)        -> void
 *   resolveRoleId(roleName)           -> string | null
 *   resolveChannelId(channelName)     -> string | null
 */

/**
 * @param {import('discord.js').Guild} guild
 * @returns {object} adapter bound to the given guild
 */
export function createDiscordGuildAdapter(guild) {
  const resolveRoleId = (roleName) => {
    if (String(roleName).toLowerCase() === EVERYONE) return guild.roles.everyone.id;
    return guild.roles.cache.find((role) => role.name.toLowerCase() === String(roleName).toLowerCase())?.id ?? null;
  };

  const resolveChannelId = (channelName) =>
    guild.channels.cache.find(
      (channel) => channel.name.toLowerCase() === String(channelName).toLowerCase(),
    )?.id ?? null;

  /**
   * Converts an overwrite rule into discord.js's `PermissionOverwriteOptions`
   * map: `{ ViewChannel: true, SendMessages: false }`.
   *
   * Note this is NOT the `{ allow, deny }` shape. `PermissionOverwriteManager`
   * only understands the per-permission map, silently ignoring an
   * `{ allow, deny }` object, so getting this wrong makes every overwrite a
   * no-op that still looks like it succeeded.
   */
  const toOverwriteOptions = (rule) => {
    const options = {};
    for (const permission of rule.allow ?? []) options[permission] = true;
    for (const permission of rule.deny ?? []) options[permission] = false;
    return options;
  };

  /**
   * Applies overwrite rules to a channel, one role at a time.
   *
   * Uses `permissionOverwrites.create()` rather than `edit()`: `create` starts
   * from an empty bitfield and therefore sets the rule exactly, whereas `edit`
   * merges with what is already present and could never revoke a permission.
   * It is scoped to a single role, so overwrites belonging to roles the
   * blueprint does not manage are left untouched.
   */
  const applyOverwrites = async (channel, rules, reason) => {
    for (const rule of rules ?? []) {
      const roleId = resolveRoleId(rule.role);
      if (!roleId) {
        throw new BotError(`Cannot resolve role "${rule.role}" for a channel overwrite.`, {
          code: 'SETUP_ROLE_NOT_FOUND',
          details: { role: rule.role },
        });
      }
      await channel.permissionOverwrites.create(roleId, toOverwriteOptions(rule), { reason });
    }
  };

  const OVERWRITE_REASON = 'PompBot setup: reconcile channel permissions with blueprint';

  return {
    resolveRoleId,
    resolveChannelId,

    async createRole(spec) {
      const role = await guild.roles.create({
        name: spec.name,
        color: hexToInt(spec.color),
        hoist: spec.hoist,
        mentionable: spec.mentionable,
        permissions: new PermissionsBitField(spec.permissions ?? []),
        reason: 'PompBot setup: create role from blueprint',
      });
      return { id: role.id, name: role.name };
    },

    async updateRole(id, changes) {
      const role = guild.roles.cache.get(id);
      if (!role) {
        throw new BotError(`Role ${id} disappeared before it could be updated.`, { code: 'SETUP_ROLE_MISSING' });
      }

      const payload = { reason: 'PompBot setup: reconcile role with blueprint' };
      if (changes.color !== undefined) payload.color = hexToInt(changes.color);
      if (changes.hoist !== undefined) payload.hoist = changes.hoist;
      if (changes.mentionable !== undefined) payload.mentionable = changes.mentionable;

      if (changes.addPermissions?.length) {
        // Additive only: a role never loses a permission it already holds.
        payload.permissions = new PermissionsBitField(changes.addPermissions).add(role.permissions);
      }
      await role.edit(payload);
    },

    async createCategory(spec) {
      const category = await guild.channels.create({
        name: spec.name,
        type: ChannelType.GuildCategory,
        reason: 'PompBot setup: create category from blueprint',
      });
      return { id: category.id, name: category.name };
    },

    async createChannel(spec) {
      const type = CHANNEL_TYPES[spec.type];
      if (type === undefined) {
        throw new BotError(`Unsupported channel type "${spec.type}".`, { code: 'SETUP_CHANNEL_TYPE_UNSUPPORTED' });
      }

      const payload = { name: spec.name, type, reason: 'PompBot setup: create channel from blueprint' };
      if (spec.parentName) {
        const parentId = resolveChannelId(spec.parentName);
        if (!parentId) {
          throw new BotError(`Cannot find category "${spec.parentName}".`, {
            code: 'SETUP_CATEGORY_NOT_FOUND',
            details: { category: spec.parentName },
          });
        }
        payload.parent = parentId;
      }
      if (spec.topic) payload.topic = spec.topic;

      const channel = await guild.channels.create(payload);

      // Overwrites go through the same verified path in both create and update.
      if (spec.overwrites?.length) {
        await applyOverwrites(channel, spec.overwrites, OVERWRITE_REASON);
      }
      return { id: channel.id, name: channel.name };
    },

    async updateChannel(id, changes) {
      const channel = guild.channels.cache.get(id);
      if (!channel) {
        throw new BotError(`Channel ${id} disappeared before it could be updated.`, { code: 'SETUP_CHANNEL_MISSING' });
      }

      const payload = { reason: 'PompBot setup: reconcile channel with blueprint' };
      if (changes.topic !== undefined) payload.topic = changes.topic;
      if (changes.parentName !== undefined) {
        payload.parent = changes.parentName ? resolveChannelId(changes.parentName) : null;
      }
      if (Object.keys(payload).length > 1) await channel.edit(payload);

      await applyOverwrites(channel, changes.overwriteEdits, OVERWRITE_REASON);
    },
  };
}

/**
 * `#rrggbb` (or a bare hex string) to the integer discord.js expects.
 * @param {string|null|undefined} color
 * @returns {number}
 */
export function hexToInt(color) {
  if (!color) return 0;
  const parsed = Number.parseInt(String(color).replace('#', ''), 16);
  return Number.isFinite(parsed) ? parsed : 0;
}
