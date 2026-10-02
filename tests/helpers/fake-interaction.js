import { EventEmitter } from 'node:events';

/**
 * Fakes for the Discord side of a command.
 *
 * A command is handed an interaction and a context; nothing else about Discord
 * is reachable from it. These stand-ins record what a command sent so a test
 * can assert on the reply itself - whether it was public or ephemeral, what
 * numbers it carried - rather than on the code that produced it.
 */

/** Deterministic replacement for Math.random: same seed, same sequence. */
export function seededRandom(seed = 1) {
  let state = (seed >>> 0) || 1;
  return () => {
    // Numerical Recipes LCG. Not cryptographic; it only has to be repeatable.
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Returns a fixed value, then the next, then loops. */
export function sequenceRandom(values) {
  let index = 0;
  return () => {
    const value = values[index % values.length];
    index += 1;
    return value;
  };
}

/** A guild with a member cache and the REST-shaped `members.fetch`. */
export function createFakeGuild({ id = 'g1', name = 'MiningFools', members = [] } = {}) {
  const cache = new Map(members.map((member) => [member.id, member]));
  return {
    id,
    name,
    members: {
      cache,
      async fetch({ user }) {
        const ids = Array.isArray(user) ? user : [user];
        const found = new Map();
        for (const userId of ids) {
          if (cache.has(userId)) found.set(userId, cache.get(userId));
        }
        return found;
      },
    },
  };
}

/** A guild member as the commands read it: display name first. */
export function createFakeMember({ id, displayName = null, username = null, bot = false }) {
  return {
    id,
    displayName: displayName ?? username ?? id,
    user: { id, username: username ?? id, bot },
  };
}

const optionBag = (options) => ({
  getUser: (name) => options[name] ?? null,
  getMember: (name) => options[`${name}Member`] ?? null,
  getString: (name, required = false) => {
    const value = options[name];
    if (value === undefined && required) throw new Error(`the test did not supply the required option "${name}"`);
    return value ?? null;
  },
});

/**
 * A chat-input command interaction.
 *
 * `reply` and `followUp` record rather than send, and the flags are left
 * intact so a test can tell a public answer from an ephemeral one.
 */
export function createInteraction({
  commandName = 'kaz',
  options = {},
  user = { id: 'u1', username: 'kemal', bot: false },
  guildId = 'g1',
  channelId = 'c1',
  guild = null,
  member = null,
  client = null,
} = {}) {
  const interaction = {
    commandName,
    user,
    guildId,
    channelId,
    guild,
    client,
    member: member ?? createFakeMember({ id: user.id, username: user.username, bot: user.bot }),
    options: optionBag(options),
    deferred: false,
    replied: false,
    replies: [],
    followUps: [],
    edits: [],
    updates: [],

    isChatInputCommand: () => true,
    isButton: () => false,
    isStringSelectMenu: () => false,

    async reply(payload) {
      interaction.replied = true;
      interaction.replies.push(payload);
      return payload;
    },
    async followUp(payload) {
      interaction.followUps.push(payload);
      return payload;
    },
    async deferReply() {
      interaction.deferred = true;
    },
    async editReply(payload) {
      interaction.edits.push(payload);
      return payload;
    },
  };
  return interaction;
}

/** A button click, as the component handlers read it. */
export function createButtonInteraction({
  customId,
  user = { id: 'u1', username: 'kemal', bot: false },
  guildId = 'g1',
  channelId = 'c1',
  guild = null,
  values = [],
} = {}) {
  const interaction = {
    customId,
    user,
    guildId,
    channelId,
    guild,
    values,
    member: createFakeMember({ id: user.id, username: user.username, bot: user.bot }),
    deferred: false,
    replied: false,
    replies: [],
    followUps: [],
    updates: [],

    isChatInputCommand: () => false,
    isButton: () => true,
    isStringSelectMenu: () => false,

    async reply(payload) {
      interaction.replied = true;
      interaction.replies.push(payload);
      return payload;
    },
    async followUp(payload) {
      interaction.followUps.push(payload);
      return payload;
    },
    async update(payload) {
      interaction.updates.push(payload);
      return payload;
    },
  };
  return interaction;
}

/** A logger that records nothing, for contexts that only need the shape. */
export function silentLogger() {
  const noop = () => {};
  return { error: noop, warn: noop, info: noop, debug: noop, child: () => silentLogger() };
}

/** An event emitter shaped like a discord.js client, for tests that need one. */
export function createFakeClient() {
  const client = new EventEmitter();
  client.user = { id: '999999999999999999', tag: 'PompAI#0001' };
  client.guilds = { cache: new Map() };
  return client;
}

/** The public payload shapes, for readability in assertions. */
export const isEphemeral = (payload) => Boolean(payload?.flags & 64);
export const textOf = (payload) =>
  [payload?.content, payload?.embeds?.[0]?.data?.description, payload?.embeds?.[0]?.data?.title]
    .filter(Boolean)
    .join('\n');
