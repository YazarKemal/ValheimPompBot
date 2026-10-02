/**
 * In-memory stand-in for a Discord guild.
 *
 * Implements exactly the adapter contract from `src/setup/adapter.js`, so the
 * apply pipeline can be exercised end to end - including the idempotency
 * round-trip - with no network access and no discord.js objects.
 */

const UNKNOWN = '<unknown>';

export function createFakeGuild(seed = {}) {
  let counter = 0;
  const nextId = (prefix) => `${prefix}-${++counter}`;

  const roles = [];
  const categories = [];
  const channels = [];

  let mutations = 0;
  let failNext = null;

  for (const role of seed.roles ?? []) {
    roles.push({
      id: role.id ?? nextId('role'),
      name: role.name,
      color: role.color ?? '#000000',
      hoist: Boolean(role.hoist),
      mentionable: Boolean(role.mentionable),
      permissions: [...(role.permissions ?? [])].sort(),
    });
  }
  for (const category of seed.categories ?? []) {
    categories.push({ id: category.id ?? nextId('cat'), name: category.name });
  }
  for (const channel of seed.channels ?? []) {
    channels.push({
      id: channel.id ?? nextId('chan'),
      name: channel.name,
      type: channel.type ?? 'text',
      topic: channel.topic ?? null,
      parentName: channel.parentName ?? null,
      overwrites: (channel.overwrites ?? []).map((rule) => ({
        role: rule.role,
        allow: [...(rule.allow ?? [])].sort(),
        deny: [...(rule.deny ?? [])].sort(),
      })),
    });
  }

  function guard(action) {
    if (failNext === action) {
      failNext = null;
      throw new Error(`simulated failure: ${action}`);
    }
    mutations += 1;
  }

  const findRole = (id) => roles.find((role) => role.id === id);
  const findChannel = (id) => channels.find((channel) => channel.id === id);

  const adapter = {
    async createRole(spec) {
      guard('createRole');
      const role = {
        id: nextId('role'),
        name: spec.name,
        color: spec.color ?? '#000000',
        hoist: Boolean(spec.hoist),
        mentionable: Boolean(spec.mentionable),
        permissions: [...(spec.permissions ?? [])].sort(),
      };
      roles.push(role);
      return { id: role.id, name: role.name };
    },

    async updateRole(id, changes) {
      guard('updateRole');
      const role = findRole(id);
      if (!role) throw new Error(`no role with id ${id}`);
      if (changes.color !== undefined) role.color = changes.color;
      if (changes.hoist !== undefined) role.hoist = changes.hoist;
      if (changes.mentionable !== undefined) role.mentionable = changes.mentionable;
      if (changes.addPermissions) {
        role.permissions = [...new Set([...role.permissions, ...changes.addPermissions])].sort();
      }
    },

    async createCategory(spec) {
      guard('createCategory');
      const category = { id: nextId('cat'), name: spec.name };
      categories.push(category);
      return { id: category.id, name: category.name };
    },

    async createChannel(spec) {
      guard('createChannel');
      const channel = {
        id: nextId('chan'),
        name: spec.name,
        type: spec.type,
        topic: spec.topic ?? null,
        parentName: spec.parentName ?? null,
        overwrites: (spec.overwrites ?? []).map((rule) => ({
          role: rule.role,
          allow: [...(rule.allow ?? [])].sort(),
          deny: [...(rule.deny ?? [])].sort(),
        })),
      };
      channels.push(channel);
      return { id: channel.id, name: channel.name };
    },

    async updateChannel(id, changes) {
      guard('updateChannel');
      const channel = findChannel(id);
      if (!channel) throw new Error(`no channel with id ${id}`);
      if (changes.topic !== undefined) channel.topic = changes.topic;
      if (changes.parentName !== undefined) channel.parentName = changes.parentName;

      for (const edit of changes.overwriteEdits ?? []) {
        const existing = channel.overwrites.find(
          (rule) => rule.role.toLowerCase() === String(edit.role).toLowerCase(),
        );
        if (existing) {
          // Mirrors the real adapter's explicit allow/deny set for one role.
          existing.allow = [...(edit.allow ?? [])].sort();
          existing.deny = [...(edit.deny ?? [])].sort();
        } else {
          channel.overwrites.push({
            role: edit.role,
            allow: [...(edit.allow ?? [])].sort(),
            deny: [...(edit.deny ?? [])].sort(),
          });
        }
      }
    },

    resolveRoleId(name) {
      const wanted = String(name ?? '').toLowerCase();
      if (wanted === '@everyone') return 'everyone';
      return roles.find((role) => role.name.toLowerCase() === wanted)?.id ?? null;
    },

    resolveChannelId(name) {
      const wanted = String(name ?? '').toLowerCase();
      return (
        categories.find((category) => category.name.toLowerCase() === wanted)?.id ??
        channels.find((channel) => channel.name.toLowerCase() === wanted)?.id ??
        null
      );
    },
  };

  return {
    adapter,
    roles,
    categories,
    channels,

    /** Deep copy in the shape `snapshotGuild` produces. */
    snapshot() {
      return {
        roles: roles.map((role) => ({ ...role, permissions: [...role.permissions] })),
        categories: categories.map((category) => ({ ...category })),
        channels: channels.map((channel) => ({
          ...channel,
          overwrites: channel.overwrites.map((rule) => ({
            role: rule.role,
            allow: [...rule.allow],
            deny: [...rule.deny],
          })),
        })),
      };
    },

    mutationCount: () => mutations,
    resetMutations: () => {
      mutations = 0;
    },
    failOnce: (action) => {
      failNext = action;
    },
    UNKNOWN,
  };
}
