import { PermissionsBitField } from 'discord.js';

/**
 * Minimal stand-in for a discord.js `Guild`, shaped like the real thing.
 *
 * `tests/helpers/fake-guild.js` verifies planner behaviour; this one verifies
 * that `src/setup/adapter.js` calls discord.js correctly - argument shapes,
 * method choice, and bitfield handling. It records every call so tests can
 * assert on what was actually sent.
 */

export function createDiscordLikeGuild(seed = {}) {
  let counter = 0;
  const nextId = (prefix) => `${prefix}${++counter}`;
  const calls = [];

  const roles = [];
  const channels = [];

  const everyoneRole = { id: 'guild-id', name: '@everyone' };
  if (seed.everyone === false) roles.push(everyoneRole);

  for (const role of seed.roles ?? []) {
    roles.push({
      id: role.id ?? nextId('role'),
      name: role.name,
      color: role.color ?? 0,
      // Bot and integration roles are flagged `managed` by Discord.
      managed: role.managed ?? false,
      hoist: role.hoist ?? false,
      mentionable: role.mentionable ?? false,
      permissions: role.permissions ?? new PermissionsBitField(),
      edit: async (payload) => {
        calls.push({ method: 'role.edit', id: role.id, payload });
      },
    });
  }

  function makeChannel(data) {
    return {
      id: data.id ?? nextId('chan'),
      name: data.name,
      type: data.type,
      topic: data.topic ?? null,
      parentId: data.parentId ?? null,
      edit: async (payload) => {
        calls.push({ method: 'channel.edit', id: data.id, payload });
      },
      permissionOverwrites: {
        // Mirrors discord.js: `create` takes a per-permission options map.
        create: async (roleId, options, overwriteOptions) => {
          calls.push({ method: 'overwrites.create', roleId, options, overwriteOptions });
        },
      },
    };
  }

  for (const channel of seed.channels ?? []) {
    channels.push(makeChannel(channel));
  }

  const asCache = (items) => ({
    values: () => items.values(),
    get: (id) => items.find((entry) => entry.id === id),
    find: (predicate) => items.find(predicate),
    size: items.length,
    [Symbol.iterator]: () => items[Symbol.iterator](),
  });

  const guild = {
    id: 'guild-id',
    name: seed.name ?? 'Valheim Pomp',
    memberCount: seed.memberCount ?? 42,
    ownerId: seed.ownerId ?? 'owner-id',
    createdTimestamp: seed.createdTimestamp ?? 1_700_000_000_000,
    roles: {
      everyone: everyoneRole,
      cache: asCache(roles),
      create: async (payload) => {
        calls.push({ method: 'roles.create', payload });
        const role = {
          id: nextId('role'),
          name: payload.name,
          color: payload.color,
          permissions: payload.permissions,
        };
        roles.push(role);
        return role;
      },
    },
    channels: {
      cache: asCache(channels),
      create: async (payload) => {
        calls.push({ method: 'channels.create', payload });
        const channel = makeChannel({ name: payload.name, type: payload.type, topic: payload.topic, parentId: payload.parent });
        channels.push(channel);
        return channel;
      },
    },
  };

  return {
    guild,
    calls,
    roles,
    channels,
    callsOf: (method) => calls.filter((call) => call.method === method),
  };
}
