import { MessageFlags } from 'discord.js';
import { createNullLogger } from '../utils/logger.js';
import { pickFortune } from './content/fortunes.js';
import { pickNickname } from './content/nicknames.js';
import { PARTY_TYPES, isPartyType } from './content/party-banks.js';
import {
  buildDailyEmbed,
  buildFortuneEmbed,
  buildInventoryEmbed,
  buildLeaderboardEmbed,
  buildMineEmbed,
  buildPartyPayload,
  buildProfileEmbed,
  cooldownText,
  dailyCooldownText,
  nicknameText,
} from './messages.js';

/**
 * Slash-command implementations for the fun layer.
 *
 * Two rules run through all of them:
 *
 *   - THE SERVER DECIDES. A command passes a guild id, a user id and nothing
 *     else. No amount, item or outcome ever arrives from the client, and the
 *     only component ids this feature issues carry an opaque party session id.
 *   - REFUSALS ARE PRIVATE, RESULTS ARE PUBLIC. A cooldown is about one person
 *     and gets an ephemeral reply; a find, a chest and a rank are social and go
 *     to the channel, which is what makes the game worth playing in a server.
 *
 * No AI is called anywhere in this file.
 */

/** Replies whether or not the interaction was already acknowledged. */
export async function respond(interaction, payload) {
  try {
    const body = typeof payload === 'string' ? { content: payload } : payload;
    if (interaction.deferred || interaction.replied) await interaction.followUp(body);
    else await interaction.reply(body);
  } catch {
    // The three-second window can lapse; there is nothing useful left to do.
  }
}

/** An ephemeral refusal. */
async function refuse(interaction, content) {
  return respond(interaction, { content, flags: MessageFlags.Ephemeral });
}

/** The fun service, or null with the reason already sent. */
async function requireService(interaction, ctx) {
  if (ctx.fun) return ctx.fun;
  await refuse(interaction, '🎲 Eğlence sistemi bu etkin değil.');
  return null;
}

/** Guild and user, or null. A DM has no economy: state is per guild. */
function identity(interaction) {
  const guildId = interaction.guildId ?? interaction.guild?.id ?? null;
  const userId = interaction.user?.id ?? null;
  if (!guildId || !userId) return null;
  return { guildId, userId };
}

/** The name shown on a card. Never a mention: a leaderboard should not ping. */
export function displayNameOf(interaction, user = null) {
  const target = user ?? interaction.user;
  const member = interaction.guild?.members?.cache?.get?.(target?.id ?? '');
  return member?.displayName ?? target?.displayName ?? target?.globalName ?? target?.username ?? target?.id ?? null;
}

/* -------------------------------------------------------------------------- */
/* /kaz                                                                        */
/* -------------------------------------------------------------------------- */

/** The public dig. Cooldown refusals are ephemeral so a busy channel is not spammed. */
export async function kaz(interaction, ctx) {
  const service = await requireService(interaction, ctx);
  if (!service) return;

  const who = identity(interaction);
  if (!who) {
    await refuse(interaction, '⛏️ Madencilik sadece sunucularda çalışıyor.');
    return;
  }

  const result = service.mine(who);
  if (!result.ok) {
    await refuse(interaction, cooldownText(result.remainingSeconds));
    return;
  }

  await respond(interaction, { embeds: [buildMineEmbed(result, displayNameOf(interaction))] });
}

/* -------------------------------------------------------------------------- */
/* /gunluk                                                                     */
/* -------------------------------------------------------------------------- */

export async function gunluk(interaction, ctx) {
  const service = await requireService(interaction, ctx);
  if (!service) return;

  const who = identity(interaction);
  if (!who) {
    await refuse(interaction, '🎁 Günlük kasa sadece sunucularda çalışıyor.');
    return;
  }

  const result = service.claimDaily(who);
  if (!result.ok) {
    await refuse(interaction, dailyCooldownText(result.remainingSeconds, result.streak ?? 0));
    return;
  }

  await respond(interaction, { embeds: [buildDailyEmbed(result, displayNameOf(interaction))] });
}

/* -------------------------------------------------------------------------- */
/* /envanter, /profil, /liderlik                                               */
/* -------------------------------------------------------------------------- */

export async function envanter(interaction, ctx) {
  const service = await requireService(interaction, ctx);
  if (!service) return;

  const who = identity(interaction);
  if (!who) {
    await refuse(interaction, '🎒 Envanter sadece sunucularda çalışıyor.');
    return;
  }

  const profile = service.profile({ ...who, displayName: displayNameOf(interaction) });
  await respond(interaction, { embeds: [buildInventoryEmbed(profile)] });
}

export async function profil(interaction, ctx) {
  const service = await requireService(interaction, ctx);
  if (!service) return;

  const who = identity(interaction);
  if (!who) {
    await refuse(interaction, '⛏️ Profil sadece sunucularda çalışıyor.');
    return;
  }

  const target = interaction.options?.getUser?.('kullanici') ?? null;
  const userId = target?.id ?? who.userId;

  const profile = service.profile({ guildId: who.guildId, userId, displayName: displayNameOf(interaction, target) });
  await respond(interaction, { embeds: [buildProfileEmbed(profile)] });
}

export async function liderlik(interaction, ctx) {
  const service = await requireService(interaction, ctx);
  if (!service) return;

  const who = identity(interaction);
  if (!who) {
    await refuse(interaction, '🏆 Liderlik sadece sunucularda çalışıyor.');
    return;
  }

  const rows = service.leaderboard({ guildId: who.guildId, limit: 10 });
  const names = await resolveNames(
    interaction,
    rows.map((row) => row.userId),
    ctx,
  );

  await respond(interaction, {
    embeds: [
      buildLeaderboardEmbed(
        rows.map((row) => ({ ...row, displayName: names.get(row.userId) ?? null })),
        interaction.guild?.name ?? null,
      ),
    ],
  });
}

/**
 * Display names for the board.
 *
 * PompAI does not hold the GuildMembers intent - the cache is usually empty -
 * so the missing ids are resolved over REST in ONE request. A failed lookup
 * degrades to the raw id rather than failing the command: a leaderboard with an
 * id on it beats no leaderboard.
 */
async function resolveNames(interaction, userIds, ctx = {}) {
  const names = new Map();
  const guild = interaction.guild;
  if (!guild || userIds.length === 0) return names;

  const missing = [];
  for (const id of userIds) {
    const member = guild.members?.cache?.get?.(id);
    if (member) names.set(id, member.displayName ?? member.user?.username ?? id);
    else missing.push(id);
  }
  if (missing.length === 0) return names;

  try {
    const fetched = await guild.members.fetch({ user: missing });
    for (const [id, member] of fetched) {
      names.set(id, member.displayName ?? member.user?.username ?? id);
    }
  } catch (error) {
    (ctx.logger ?? createNullLogger()).debug?.('Could not resolve leaderboard names.', {
      reason: error?.message,
      count: missing.length,
    });
  }
  return names;
}

/* -------------------------------------------------------------------------- */
/* /parti                                                                      */
/* -------------------------------------------------------------------------- */

export async function parti(interaction, ctx) {
  const service = await requireService(interaction, ctx);
  if (!service) return;

  const who = identity(interaction);
  if (!who) {
    await refuse(interaction, '🎉 Parti oyunları sadece sunucularda çalışıyor.');
    return;
  }

  const type = interaction.options?.getString?.('tur', true) ?? null;
  if (!isPartyType(type)) {
    await refuse(interaction, `Bilinmeyen parti türü. Seçenekler: ${PARTY_TYPES.join(', ')}`);
    return;
  }

  // Cheap housekeeping: party state is RAM-only, so nothing else expires it.
  service.party.sweep();

  const started = service.party.start({
    guildId: who.guildId,
    channelId: interaction.channelId ?? null,
    type,
  });

  if (!started.ok) {
    await refuse(interaction, '🎲 Soru bankası okunamadı, sonra tekrar dene.');
    return;
  }

  await respond(interaction, buildPartyPayload(started.session));
}

/* -------------------------------------------------------------------------- */
/* /lakap and /fal                                                             */
/* -------------------------------------------------------------------------- */

export async function lakap(interaction, ctx) {
  const target = interaction.options?.getUser?.('kullanici') ?? null;
  const name = displayNameOf(interaction, target);

  // Local bank, injected randomness. No model, no network.
  const nickname = pickNickname(ctx.random ?? Math.random);
  await respond(interaction, nicknameText(name ?? 'Bilinmeyen madenci', nickname));
}

export async function fal(interaction, ctx) {
  const fortune = pickFortune(ctx.random ?? Math.random);
  await respond(interaction, { embeds: [buildFortuneEmbed(fortune, displayNameOf(interaction))] });
}

/** Logs a command failure without leaking anything into the channel. */
export function logFailure(ctx, command, error) {
  (ctx.logger ?? createNullLogger()).warn(`Fun command "${command}" failed.`, {
    reason: error?.message,
    code: error?.code ?? null,
  });
}
