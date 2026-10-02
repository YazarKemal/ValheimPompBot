/**
 * Resolving which voice channel a member is in.
 *
 * This exists because the obvious lookup is wrong in real Discord:
 *
 *   interaction.member.voice?.channelId
 *
 * `CommandInteraction#member` is typed `GuildMember | APIInteractionGuildMember`.
 * When the member is not in `guild.members.cache` - which is normal without the
 * privileged GuildMembers intent - discord.js hands back the *raw* API payload.
 * That shape has no `voice` property at all, only `deaf` and `mute`, so
 * `.voice.channelId` is `undefined` and the caller concludes the member is not
 * in voice. That was the live `/gel` bug: a member visibly sitting in a channel
 * being told to join one.
 *
 * The authoritative source is the guild's own voice state cache, which
 * discord.js maintains from VOICE_STATE_UPDATE and GUILD_CREATE and which needs
 * only the (non-privileged) GuildVoiceStates intent. `member.voice` is still
 * consulted, but only as a fallback.
 */

/** Reads a channel id out of whatever shape a voice object happens to be. */
function readChannelId(voice) {
  if (!voice || typeof voice !== 'object') return null;
  // discord.js VoiceState
  if (typeof voice.channelId === 'string') return voice.channelId;
  // Hydrated GuildMember's voice state exposes the channel object too.
  if (typeof voice.channel?.id === 'string') return voice.channel.id;
  // Raw API payload, which uses snake_case.
  if (typeof voice.channel_id === 'string') return voice.channel_id;
  return null;
}

/**
 * Finds the member's current voice channel id, or null when they are not in one.
 *
 * @param {object} options
 * @param {import('discord.js').Guild|null} [options.guild]
 * @param {string|null} [options.userId] Falls back to the member's own id.
 * @param {object|null} [options.member] Interaction or message member, possibly raw.
 * @returns {string|null}
 */
export function resolveMemberVoiceChannel({ guild = null, userId = null, member = null } = {}) {
  const id = userId ?? member?.id ?? member?.user?.id ?? null;

  // 1. Authoritative: the guild's voice state cache. Requires no privileged
  //    intent and is kept current by the gateway.
  if (id && guild?.voiceStates?.cache) {
    const fromVoiceStates = readChannelId(guild.voiceStates.cache.get?.(id));
    if (fromVoiceStates) return fromVoiceStates;
  }

  // 2. The member object we were handed, if it happens to be hydrated.
  const fromMember = readChannelId(member?.voice);
  if (fromMember) return fromMember;

  // 3. The guild's cached member, if that path is populated.
  if (id && guild?.members?.cache) {
    const fromCache = readChannelId(guild.members.cache.get?.(id)?.voice);
    if (fromCache) return fromCache;
  }

  // 4. Not in voice, as far as anything can tell.
  return null;
}

/**
 * A privacy-safe account of how a resolution went, for logging when it fails.
 *
 * Reports only ids and booleans. Never a token, never message content, never a
 * user name.
 *
 * @param {object} options Same shape as `resolveMemberVoiceChannel`.
 * @returns {object}
 */
export function describeVoiceResolution({ guild = null, userId = null, member = null } = {}) {
  const id = userId ?? member?.id ?? member?.user?.id ?? null;
  const voiceState = id ? guild?.voiceStates?.cache?.get?.(id) ?? null : null;
  const cachedMember = id ? guild?.members?.cache?.get?.(id) ?? null : null;

  return {
    guildId: guild?.id ?? null,
    userId: id,
    voiceStatesCacheHit: voiceState !== null,
    guildMemberCached: cachedMember !== null,
    // A hydrated GuildMember has `voice`; the raw API payload does not.
    interactionMemberHydrated: Boolean(member && typeof member === 'object' && 'voice' in member),
    memberHasChannelId: readChannelId(member?.voice) !== null,
    resolvedVoiceChannelId: resolveMemberVoiceChannel({ guild, userId: id, member }),
  };
}
