import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { createNullLogger } from '../utils/logger.js';
import { TEXTS, buildQueueEmbed, buildNowPlayingEmbed, buildControlRow } from './messages.js';
import { PRESENCE_TEXTS, evaluateActiveMember, evaluateLeave, evaluateSummon, SUMMON } from './presence.js';
import { describeVoiceResolution, resolveMemberVoiceChannel } from './voice-state.js';

/**
 * Slash-command implementations for PompMusic.
 *
 * These belong to the PompMusic application and are registered against
 * POMPMUSIC_CLIENT_ID. The primary flow stays "type a song name in
 * #muzik-istek"; these exist for summoning, leaving and steering.
 *
 * Every one of them is public: a music action affects the whole channel.
 */

const MANAGE = PermissionFlagsBits.ManageChannels;

const hasManage = (member) => Boolean(member?.permissions?.has?.(MANAGE));

/** Replies or refuses through the interaction, tolerating an expired token. */
async function respond(interaction, content, ephemeral = false) {
  const payload = ephemeral ? { content, flags: MessageFlags.Ephemeral } : { content };
  try {
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
    else await interaction.reply(payload);
  } catch {
    // The 3-second window can lapse; there is nothing useful left to do.
  }
}

/* -------------------------------------------------------------------------- */
/* /gel - summon                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Brings PompMusic into the caller's voice channel.
 *
 * Refusals are ephemeral (personal), the arrival is public (the channel should
 * know the bot is now listening there).
 */
export async function summon(interaction, ctx) {
  const logger = ctx.logger ?? createNullLogger();
  const service = ctx.music;

  if (!service) {
    await respond(interaction, 'Müzik sistemi bu etkin değil.', true);
    return;
  }

  const guildId = interaction.guildId ?? interaction.guild?.id ?? null;
  const session = service.sessions.get(guildId);
  // Resolved through the shared helper, never from interaction.member.voice:
  // that object is the raw API payload whenever the member is uncached, and the
  // raw payload has no `voice` field at all - only `deaf` and `mute`.
  const member = interaction.member;
  const memberId = interaction.user?.id ?? member?.id ?? null;
  const requestedChannelId = resolveMemberVoiceChannel({
    guild: interaction.guild,
    userId: memberId,
    member,
  });

  const requestedChannel = requestedChannelId
    ? interaction.guild?.channels?.cache?.get?.(requestedChannelId) ?? null
    : null;

  const currentChannel = session ? interaction.guild?.channels?.cache?.get?.(session.voiceChannelId) ?? null : null;

  if (!requestedChannelId) {
    // Only logged when resolution fails, and only ids and booleans.
    logger.debug?.('Could not resolve a voice channel for /gel.', describeVoiceResolution({
      guild: interaction.guild,
      userId: memberId,
      member,
    }));
  }

  const verdict = evaluateSummon({
    memberChannelId: requestedChannelId,
    session,
    currentChannelName: currentChannel?.name ?? session?.channelName ?? null,
    // An empty channel is safe to leave: nobody is listening there.
    currentChannelEmpty: countHumans(currentChannel) === 0,
    hasManageChannels: hasManage(member),
    requestedChannelName: requestedChannel?.name ?? null,
  });

  if (verdict.action === SUMMON.REFUSE) {
    await respond(interaction, verdict.message, true);
    return;
  }

  if (verdict.action === SUMMON.ALREADY) {
    await respond(interaction, verdict.message);
    return;
  }

  if (verdict.action === SUMMON.MOVE) {
    // Leaving the old channel first keeps exactly one session alive.
    service.leave(guildId);
  }

  const active = service.summon({
    guild: interaction.guild,
    channelId: requestedChannelId,
    channelName: requestedChannel?.name ?? null,
  });

  try {
    await active.begin();
  } catch (error) {
    logger.warn('Could not join the voice channel.', { reason: error?.message });
    service.leave(guildId);
    await respond(interaction, '🔇 Ses kanalına katılamadım.', true);
    return;
  }

  await respond(interaction, verdict.message);
}

/** Human members currently in a voice channel. */
function countHumans(channel) {
  const members = channel?.members;
  if (!members || typeof members.filter !== 'function') return 0;
  return members.filter((member) => !member.user?.bot).size;
}

/* -------------------------------------------------------------------------- */
/* /git and /durdur-ve-git - leave                                             */
/* -------------------------------------------------------------------------- */

/**
 * Stops playback, clears the queue and disconnects.
 *
 * `/durdur-ve-git` is the same operation under a name that says what it does;
 * stopping and leaving is one action, and offering two subtly different
 * versions of it would only be a way to get it wrong.
 */
export async function leave(interaction, ctx) {
  const service = ctx.music;

  if (!service) {
    await respond(interaction, 'Müzik sistemi bu etkin değil.', true);
    return;
  }

  const guildId = interaction.guildId ?? interaction.guild?.id ?? null;
  const session = service.sessions.get(guildId);

  const verdict = evaluateLeave({
    memberChannelId: resolveMemberVoiceChannel({
      guild: interaction.guild,
      userId: interaction.user?.id,
      member: interaction.member,
    }),
    session,
    hasManageChannels: hasManage(interaction.member),
  });
  if (!verdict.ok) {
    await respond(interaction, verdict.message, true);
    return;
  }

  service.leave(guildId);
  await respond(interaction, PRESENCE_TEXTS.left);
}

export const git = leave;
export const stopAndLeave = leave;

/* -------------------------------------------------------------------------- */
/* Playback controls                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Runs a music control command.
 *
 * @param {boolean} [options.requiresPlaying]
 */
export async function runMusicControl(interaction, ctx, { action, run, requiresPlaying = true }) {
  const logger = ctx.logger ?? createNullLogger();
  const service = ctx.music;

  if (!service) {
    await respond(interaction, 'Müzik sistemi bu etkin değil.', true);
    return;
  }

  const guildId = interaction.guildId ?? interaction.guild?.id ?? null;
  const session = service.sessions.get(guildId);
  const verdict = evaluateActiveMember({
    memberChannelId: resolveMemberVoiceChannel({
      guild: interaction.guild,
      userId: interaction.user?.id,
      member: interaction.member,
    }),
    session,
    hasManageChannels: hasManage(interaction.member),
  });

  if (!verdict.ok) {
    await respond(interaction, verdict.message, true);
    return;
  }

  if (requiresPlaying && !session.isPlaying()) {
    await respond(interaction, TEXTS.NOTHING_PLAYING, true);
    return;
  }

  try {
    await respond(interaction, await run(session, ctx));
  } catch (error) {
    logger.warn('Music control failed.', { action, reason: error?.message });
    await respond(interaction, '🔇 Bu komut şu anda çalışmıyor.', true);
  }
}

/** `/kuyruk` - the public queue view. */
export async function showQueue(interaction, ctx) {
  const service = ctx.music;
  const session = service?.sessions.get(interaction.guildId ?? null);

  if (!session || session.destroyed) {
    await respond(interaction, PRESENCE_TEXTS.needSummon);
    return;
  }

  const snapshot = session.snapshot();
  const embed = buildQueueEmbed(snapshot, { max: 10, totalSeconds: session.queue.totalQueuedSeconds() });

  try {
    await interaction.reply({ embeds: [embed] });
  } catch (error) {
    ctx.logger?.debug?.('Could not post the queue.', { reason: error?.message });
  }
}

export async function skip(interaction, ctx) {
  return runMusicControl(interaction, ctx, {
    action: 'skip',
    run: async (session) => {
      session.skip();
      const next = session.queue.current;
      return next ? `⏭ Geçildi. Şimdi: **${next.track.title}**` : '⏭ Geçildi. Sıra boş.';
    },
  });
}

export async function stop(interaction, ctx) {
  return runMusicControl(interaction, ctx, {
    action: 'stop',
    requiresPlaying: false,
    run: async (session) => {
      const removed = session.stop();
      return `⏹ Durduruldu. Sıradan ${removed} şarkı çıkarıldı. PompMusic kanalda bekliyor.`;
    },
  });
}

export async function pause(interaction, ctx) {
  return runMusicControl(interaction, ctx, {
    action: 'pause',
    run: async (session) => {
      session.pause();
      return '⏸ Duraklatıldı. `/devam` ile sürdürebilirsin.';
    },
  });
}

export async function resume(interaction, ctx) {
  return runMusicControl(interaction, ctx, {
    action: 'resume',
    run: async (session) => {
      session.resume();
      return '▶️ Devam ediyor.';
    },
  });
}

export async function shuffle(interaction, ctx) {
  return runMusicControl(interaction, ctx, {
    action: 'shuffle',
    run: async (session) => {
      const count = session.shuffle();
      return count > 0 ? `🔀 ${count} şarkı karıştırıldı.` : '🔀 Karıştırılacak bir şey yok.';
    },
  });
}

export { buildNowPlayingEmbed, buildControlRow };
