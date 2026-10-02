import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { createNullLogger } from '../utils/logger.js';
import {
  CONTROL_ACTIONS,
  authorizeControl,
  authorizeSelection,
  parseControlId,
  parseSelectionId,
  isMusicControl,
} from './controls.js';
import { enqueue } from './listener.js';
import { retireSelectionPayload } from './messages.js';
import { resolveMemberVoiceChannel } from './voice-state.js';

/**
 * Music button and menu handling.
 *
 * Three things arrive here: playback controls, a selection from a disambiguation
 * menu, and nothing else. Everything is namespaced `music:`, so routing is a
 * prefix check and never a guess.
 *
 * Playback controls are open to anyone in the active voice channel. A selection
 * is stricter: only the person who asked for the song may choose, because the
 * candidate list is their search.
 *
 * Refusals are ephemeral - a button that does nothing is worse than one that
 * explains why - and everything that changes playback is public.
 */

export { isMusicControl };

/**
 * @param {object} interaction A button or string-select interaction.
 * @param {object} ctx
 * @returns {Promise<boolean>} whether the interaction was handled
 */
export async function handleMusicInteraction(interaction, ctx) {
  if (!isMusicControl(interaction.customId)) return false;

  const logger = ctx.logger ?? createNullLogger();
  const service = ctx.music;
  const action = parseControlId(interaction.customId);

  if (!service || !action) {
    await respond(interaction, '🔇 Bu kontrol artık geçerli değil.', true);
    return true;
  }

  // The selection menu is a different flow with different rules, so it is
  // routed before the playback controls.
  if (action === CONTROL_ACTIONS.SELECT) {
    await handleSelection(interaction, ctx, service, logger);
    return true;
  }

  const guildId = interaction.guildId ?? interaction.guild?.id ?? null;
  const session = service.sessions.get(guildId);

  const memberChannelId = resolveMemberVoiceChannel({
    guild: interaction.guild,
    userId: interaction.user?.id,
    member: interaction.member,
  });

  const rejection = authorizeControl({
    action,
    member: interaction.member,
    memberChannelId,
    session,
    requesterId: session?.queue?.current?.requestedById ?? null,
    djRoleId: service.settings?.djRoleId ?? null,
    manageChannelsFlag: PermissionFlagsBits.ManageChannels,
  });

  if (!rejection.ok) {
    await respond(interaction, rejection.message, true);
    return true;
  }

  try {
    await respond(interaction, await applyControl(action, session), true);
  } catch (error) {
    logger.warn('Music control failed.', { action, reason: error?.message });
    await respond(interaction, '🔇 Bu kontrol şu anda çalışmıyor.', true);
  }
  return true;
}

/** Applies one playback control and returns the text to acknowledge with. */
async function applyControl(action, session) {
  switch (action) {
    case CONTROL_ACTIONS.PAUSE: {
      // One button toggles, which is what the ⏯ glyph promises.
      if (!session.pause()) {
        session.resume();
        return '▶️ Devam ediyor.';
      }
      return '⏸ Duraklatıldı.';
    }
    case CONTROL_ACTIONS.SKIP: {
      session.skip();
      const next = session.queue.current;
      return next ? `⏭ Geçildi. Şimdi: **${next.track.title}**` : '⏭ Geçildi. Sıra boş.';
    }
    case CONTROL_ACTIONS.STOP: {
      const removed = session.stop();
      return `⏹ Durduruldu. Sıradan ${removed} şarkı çıkarıldı.`;
    }
    case CONTROL_ACTIONS.SHUFFLE: {
      const count = session.shuffle();
      return count > 0 ? `🔀 ${count} şarkı karıştırıldı.` : '🔀 Karıştırılacak bir şey yok.';
    }
    case CONTROL_ACTIONS.REPEAT: {
      const mode = session.cycleRepeat();
      const label = { off: 'kapalı', all: 'tümü', one: 'tek şarkı' }[mode];
      return `🔁 Tekrar: **${label}**`;
    }
    default:
      return '🔇 Bilinmeyen kontrol.';
  }
}

/**
 * Resolves a disambiguation selection.
 *
 * The chosen track is read from the cached candidate list, never re-searched:
 * a second search could return a different ordering and play something the
 * person never saw.
 *
 * The entry is consumed on success only. An unauthorized or invalid attempt
 * leaves it in place, so a bystander clicking the menu cannot destroy the
 * requester's chance to use it.
 *
 * A valid selection is acknowledged BEFORE any playback work. Opening a stream
 * now waits for yt-dlp's first audio byte, plus a bounded retry, plus the
 * player reaching Playing - far past Discord's three-second interaction
 * deadline. Deferring first is what keeps a slow extraction from showing
 * "Application did not respond"; the outcome is then reported with followUp.
 */
async function handleSelection(interaction, ctx, service, logger) {
  const cache = service.selections;
  const requestId = parseSelectionId(interaction.customId);
  const identity = {
    guildId: interaction.guildId ?? null,
    channelId: interaction.channelId ?? null,
    requestId,
  };

  const entry = cache?.get(identity) ?? null;
  const session = service.sessions.get(identity.guildId) ?? null;

  const verdict = authorizeSelection({
    memberId: interaction.user?.id ?? null,
    memberChannelId: resolveMemberVoiceChannel({
      guild: interaction.guild,
      userId: interaction.user?.id,
      member: interaction.member,
    }),
    entry,
    session,
  });
  if (!verdict.ok) {
    // An expired or missing entry is worth clearing; anything else is left
    // alone so the rightful requester can still use it.
    if (verdict.reason === 'expired') cache?.delete(identity);
    await respond(interaction, verdict.message, true);
    return;
  }

  const index = Number(interaction.values?.[0]);
  if (!Number.isInteger(index) || index < 0 || index >= entry.ranked.length) {
    await respond(interaction, '🔇 Geçersiz seçim.', true);
    return;
  }

  // Consumed before playback so a double click cannot enqueue twice, and - as
  // the last synchronous step - before the first await, so a second click
  // cannot slip in while this one is being acknowledged.
  cache.take(identity);

  // Everything above is synchronous and local. Everything below can take as
  // long as yt-dlp takes, so the interaction is acknowledged first.
  await acknowledgeSelection(interaction, logger);

  await retireMenu(interaction, entry, logger);

  const chosen = entry.ranked[index].track;

  try {
    const result = await enqueue(
      {
        guildId: identity.guildId,
        guild: interaction.guild,
        channel: interaction.channel,
        // `member` is required when no session exists yet: the session is
        // created from the requester's voice channel.
        member: interaction.member,
        author: { id: entry.userId },
      },
      { ...service.listenerDeps(), session },
      chosen,
      logger,
    );

    // The outcome is reported from the result, not assumed. A rejected
    // selection (too long, queue full) must not be announced as a success.
    await respond(interaction, result.message ?? `➕ Sıraya eklendi: **${chosen.title}**`, true);
  } catch (error) {
    logger.warn('Could not play the selected track.', { reason: error?.message });
    await respond(interaction, '🔇 Seçilen şarkı çalınamadı.', true);
  }
}

/**
 * Acknowledges a component interaction without changing the message.
 *
 * This is the whole fix for the three-second deadline: after `deferUpdate` the
 * interaction no longer has one, so a selection that takes thirty seconds to
 * open a stream still answers. `respond` picks the deferral up and delivers the
 * result through `followUp`.
 *
 * A failure here is not fatal. The token may already have expired, and the
 * selection is still worth playing - the person simply will not see the reply.
 *
 * @returns {Promise<boolean>} whether the interaction is now deferred
 */
async function acknowledgeSelection(interaction, logger) {
  if (interaction.deferred || interaction.replied) return true;
  if (typeof interaction.deferUpdate !== 'function') return false;
  try {
    await interaction.deferUpdate();
    return true;
  } catch (error) {
    logger?.debug?.('Could not defer the selection interaction.', { reason: error?.message });
    return false;
  }
}

/** Removes the menu from the message so it cannot be clicked again. */
async function retireMenu(interaction, entry, logger) {
  try {
    const message = interaction.message;
    if (!message?.edit) return;
    await message.edit(retireSelectionPayload(message, `Seçildi: **${entry.ranked[Number(interaction.values[0])].track.title}**`));
  } catch (error) {
    // The menu is cosmetic; failing to edit it must not fail the selection.
    logger.debug('Could not retire the selection menu.', { reason: error?.message });
  }
}

/** Acknowledges a component interaction, tolerating an expired token. */
async function respond(interaction, content, ephemeral) {
  const payload = ephemeral ? { content, flags: MessageFlags.Ephemeral } : { content };
  try {
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
    else await interaction.reply(payload);
  } catch {
    // The 3-second window can lapse; there is nothing useful left to do.
  }
}

export { CONTROL_ACTIONS };
