import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } from 'discord.js';
import { createNullLogger } from '../utils/logger.js';
import { rankResults } from './search.js';
import { battleComponentId, isBattleComponent, parseBattleComponentId } from './battle.js';

/**
 * /kapisma - the song battle.
 *
 * Belongs to the PompMusic application, and only touches its search backend:
 * two queries in, two titles out. No audio is started, nothing is queued, and
 * the winner is announced rather than played.
 *
 * Zero AI calls. A song name is a search query here, exactly as it is in the
 * channel listener.
 */

export const BATTLE_COLOR = 0x1db954;

/** `Artist — Title`, or just the title when the provider gave no artist. */
export function describeTrack(track) {
  const title = String(track?.title ?? '').trim() || 'Bilinmeyen parça';
  const artist = String(track?.artist ?? '').trim();
  return artist ? `${artist} — ${title}` : title;
}

/** The public voting card. */
export function buildBattlePayload(battle, seconds) {
  const embed = new EmbedBuilder()
    .setColor(BATTLE_COLOR)
    .setTitle('🎵 ŞARKI KAPIŞMASI')
    .setDescription(
      [
        `🅰️ ${describeTrack(battle.entries.a)}`,
        `🅱️ ${describeTrack(battle.entries.b)}`,
        '',
        `⏱️ ${seconds} saniye`,
        'Oyunu değiştirmek için diğer butona bas.',
      ].join('\n'),
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(battleComponentId(battle.id, 'a'))
      .setLabel('A')
      .setEmoji('🅰️')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(battleComponentId(battle.id, 'b'))
      .setLabel('B')
      .setEmoji('🅱️')
      .setStyle(ButtonStyle.Danger),
  );

  return { embeds: [embed], components: [row] };
}

/** The closing card: buttons removed, result shown. */
export function buildResultPayload(result) {
  const { battle, tally } = result;
  const lines = [];

  if (tally.winner === null) {
    lines.push('🤝 **BERABERE**', '');
    lines.push(`🅰️ ${describeTrack(battle.entries.a)}`);
    lines.push(`🅱️ ${describeTrack(battle.entries.b)}`);
  } else {
    const winning = tally.winner === 'a' ? battle.entries.a : battle.entries.b;
    lines.push('🏆 **KAZANAN**', describeTrack(winning), '');
    lines.push(`🅰️ ${describeTrack(battle.entries.a)}`);
    lines.push(`🅱️ ${describeTrack(battle.entries.b)}`);
  }

  lines.push('', `A: ${tally.a}`, `B: ${tally.b}`);

  return {
    embeds: [new EmbedBuilder().setColor(BATTLE_COLOR).setTitle('🎵 ŞARKI KAPIŞMASI').setDescription(lines.join('\n'))],
    components: [],
  };
}

/** Resolves one query to its best candidate, or null. */
async function bestCandidate(service, query, settings, logger) {
  let results;
  try {
    results = await service.source.search(query, { limit: settings.searchLimit });
  } catch (error) {
    logger.warn('Battle search failed.', { reason: error?.message });
    return { ok: false, reason: 'search-failed' };
  }

  if (!Array.isArray(results) || results.length === 0) return { ok: false, reason: 'no-results' };

  // The same local ranking the channel listener uses, so a battle and a request
  // resolve a title to the same recording.
  const ranked = rankResults(results, query, { limit: settings.searchLimit });
  const track = ranked[0]?.track ?? null;
  if (!track) return { ok: false, reason: 'no-results' };
  return { ok: true, track };
}

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ music?: object, logger?: object }} ctx
 */
export async function kapisma(interaction, ctx) {
  const logger = ctx.logger ?? createNullLogger();
  const service = ctx.music;
  const store = service?.battles;
  const settings = service?.settings ?? {};

  if (!service || !store) {
    await respond(interaction, '🔇 Müzik sistemi bu etkin değil.', true);
    return;
  }

  const guildId = interaction.guildId ?? interaction.guild?.id ?? null;
  if (!guildId) {
    await respond(interaction, '🎵 Şarkı kapışması sadece sunucularda çalışıyor.', true);
    return;
  }

  const first = interaction.options?.getString?.('sarki1', true) ?? '';
  const second = interaction.options?.getString?.('sarki2', true) ?? '';

  await interaction.deferReply();

  const [left, right] = await Promise.all([
    bestCandidate(service, first, settings, logger),
    bestCandidate(service, second, settings, logger),
  ]);

  if (!left.ok || !right.ok) {
    await interaction
      .editReply({
        content:
          '🔍 İki şarkıdan en az biri bulunamadı. İsimleri biraz daha belirgin yazıp tekrar dene.',
      })
      .catch(() => {});
    return;
  }

  const opened = store.open({
    guildId,
    channelId: interaction.channelId ?? null,
    entries: { a: { title: left.track.title, artist: left.track.artist }, b: { title: right.track.title, artist: right.track.artist } },
    onExpire: async (result) => {
      // The command's own reply is the voting card, so editing it needs no
      // extra fetch and no stored message id.
      await interaction.editReply(buildResultPayload(result)).catch(() => {});
    },
  });

  if (!opened.ok) {
    await interaction.editReply({ content: '🔇 Kapışma başlatılamadı.' }).catch(() => {});
    return;
  }

  await interaction.editReply(buildBattlePayload(opened.battle, store.seconds));
}

const REJECTIONS = Object.freeze({
  'no-battle': '⏱️ Bu kapışma sona erdi.',
  settled: '⏱️ Bu kapışma sona erdi.',
  bot: '🤖 Botlar oy kullanamaz.',
  'bad-side': '🎵 Geçersiz oy.',
  full: '🎵 Bu kapışmada yeterince oy var.',
  'no-user': '🎵 Oyun kaydedilemedi.',
});

/**
 * Battle vote buttons.
 *
 * The component id carries an opaque battle id and a side - never a count, a
 * title or a reward - and the battle is looked up under the guild the click
 * came from, so one server cannot vote in another's round.
 *
 * @returns {Promise<boolean>} whether the interaction was handled
 */
export async function handleBattleInteraction(interaction, ctx) {
  if (!interaction?.isButton?.()) return false;
  if (!isBattleComponent(interaction.customId)) return false;

  const store = ctx.music?.battles;
  const parsed = parseBattleComponentId(interaction.customId);

  if (!parsed || !store) {
    await respond(interaction, '🎵 Bu kapışma artık geçerli değil.', true);
    return true;
  }

  const result = store.vote({
    guildId: interaction.guildId ?? interaction.guild?.id ?? null,
    battleId: parsed.battleId,
    userId: interaction.user?.id ?? null,
    side: parsed.side,
    // A bot can call the API to click a button; the check has to be here, not
    // only in whatever renders the card.
    isBot: Boolean(interaction.user?.bot),
  });

  if (!result.ok) {
    await respond(interaction, REJECTIONS[result.reason] ?? '🎵 Oy kaydedilemedi.', true);
    return true;
  }

  const label = result.side === 'a' ? '🅰️' : '🅱️';
  const prefix = result.changed ? '🔁 Oyun değiştirildi' : '✅ Oyun kaydedildi';
  await respond(interaction, `${prefix}: ${label} — A: ${result.tally.a} · B: ${result.tally.b}`, true);
  return true;
}

/** Acknowledges an interaction, tolerating an expired token. */
async function respond(interaction, content, ephemeral) {
  const payload = ephemeral ? { content, flags: MessageFlags.Ephemeral } : { content };
  try {
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
    else await interaction.reply(payload);
  } catch {
    // The three-second window can lapse; there is nothing useful left to do.
  }
}
