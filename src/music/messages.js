import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder } from 'discord.js';
import { formatDuration } from './source.js';

/**
 * Music presentation.
 *
 * Embeds and components are built here so the now-playing card, the queue view
 * and the disambiguation menu all look the same, and so the session logic never
 * has to know what a ButtonStyle is.
 *
 * Every payload built here is public. The controls carry no mentions.
 */

export const MUSIC_COLOR = 0x9b59b6;

export const TEXTS = Object.freeze({
  NOW_PLAYING: '🎵 Şimdi Çalıyor',
  QUEUE: '📜 Sıra',
  PICK_ONE: '🔎 Bunu mu demek istedin?',
  NOT_IN_VOICE: '🎧 Önce bir ses kanalına katıl.',
  NOTHING_PLAYING: 'Şu anda çalan bir şey yok.',
  queueEmpty: 'Sıra boş.',
});

/**
 * Component custom ids.
 *
 * Everything the bot owns is namespaced `music:` so interaction routing can
 * recognise it without inspecting anything else. The selection menu carries the
 * id of the *requesting* message, which is what ties a click back to the search
 * that produced it.
 */
export const CONTROL_IDS = Object.freeze({
  PAUSE: 'music:pause',
  SKIP: 'music:skip',
  STOP: 'music:stop',
  SHUFFLE: 'music:shuffle',
  REPEAT: 'music:repeat',
});

/** Prefix for the disambiguation menu, followed by the request id. */
export const SELECT_PREFIX = 'music:select:';

/** @param {string} requestId The id of the message that asked for the song. */
export function buildSelectionId(requestId) {
  return `${SELECT_PREFIX}${requestId}`;
}

/** The five controls, in the order they are shown. */
export function buildControlRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(CONTROL_IDS.PAUSE).setEmoji('⏯').setLabel('Duraklat / Devam').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(CONTROL_IDS.SKIP).setEmoji('⏭').setLabel('Geç').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(CONTROL_IDS.STOP).setEmoji('⏹').setLabel('Durdur').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(CONTROL_IDS.SHUFFLE).setEmoji('🔀').setLabel('Karıştır').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(CONTROL_IDS.REPEAT).setEmoji('🔁').setLabel('Tekrar').setStyle(ButtonStyle.Secondary),
  );
}

const repeatLabel = (mode) => ({ off: 'kapalı', all: 'tümü', one: 'tek şarkı' })[mode] ?? mode;

/**
 * The now-playing card.
 *
 * @param {object} item `{ track, requestedBy }`
 * @param {{ position?: number|null, repeat?: string }} [options]
 */
export function buildNowPlayingEmbed(item, { position = null, repeat = 'off' } = {}) {
  const { track } = item;
  const embed = new EmbedBuilder()
    .setColor(MUSIC_COLOR)
    .setTitle(TEXTS.NOW_PLAYING)
    .setDescription(`## ${track.title}`)
    .addFields(
      { name: 'Sanatçı / kaynak', value: track.artist ?? track.source, inline: true },
      { name: 'Süre', value: formatDuration(track.durationSeconds), inline: true },
      { name: 'İsteyen', value: item.requestedBy ?? 'bilinmiyor', inline: true },
    );

  if (position !== null && position > 0) {
    embed.addFields({ name: 'Sıradaki yeri', value: `${position}. sırada`, inline: true });
  }
  if (repeat !== 'off') {
    embed.addFields({ name: 'Tekrar', value: repeatLabel(repeat), inline: true });
  }
  if (track.url) embed.setURL(track.url);
  if (track.thumbnailUrl) embed.setThumbnail(track.thumbnailUrl);

  return embed;
}

/**
 * The queue view: what is playing, then what is next, with requester and length.
 *
 * @param {{ current: object|null, upcoming: object[], repeat: string }} snapshot
 * @param {{ max?: number, totalSeconds?: number }} [options]
 */
export function buildQueueEmbed(snapshot, { max = 10, totalSeconds = 0 } = {}) {
  const embed = new EmbedBuilder().setColor(MUSIC_COLOR).setTitle(TEXTS.QUEUE);

  embed.addFields({
    name: 'Şimdi çalıyor',
    value: snapshot.current
      ? `${snapshot.current.track.title} \`${formatDuration(snapshot.current.track.durationSeconds)}\` — ${snapshot.current.requestedBy}`
      : TEXTS.NOTHING_PLAYING,
  });

  if (snapshot.upcoming.length === 0) {
    embed.addFields({ name: 'Sırada', value: TEXTS.queueEmpty });
    return embed;
  }

  const shown = snapshot.upcoming.slice(0, max);
  embed.addFields({
    name: `Sırada (${snapshot.upcoming.length})`,
    value: shown
      .map(
        (item, index) =>
          `\`${index + 1}.\` ${item.track.title} \`${formatDuration(item.track.durationSeconds)}\` — ${item.requestedBy}`,
      )
      .join('\n'),
  });

  if (snapshot.upcoming.length > shown.length) {
    embed.setFooter({ text: `+${snapshot.upcoming.length - shown.length} şarkı daha` });
  }
  if (totalSeconds > 0) {
    embed.addFields({ name: 'Toplam süre', value: formatDuration(totalSeconds), inline: true });
  }
  embed.addFields({ name: 'Tekrar', value: repeatLabel(snapshot.repeat), inline: true });

  return embed;
}

/** Discord caps a select menu at 25 options. */
export const MAX_SELECT_OPTIONS = 25;

/**
 * Disambiguation menu, shown when the search result is not clear enough to play
 * unasked. Choosing the wrong song in a shared channel is worse than one click.
 *
 * The option *value* is the candidate's index, not its id: the chosen track is
 * read from the cached candidate list, so nothing about the track travels
 * through Discord and back.
 *
 * @param {string} query
 * @param {Array<{track: object}>} ranked
 * @param {{ requestId: string }} options
 */
export function buildSelectionPayload(query, ranked, { requestId }) {
  const shown = ranked.slice(0, MAX_SELECT_OPTIONS);

  const embed = new EmbedBuilder()
    .setColor(MUSIC_COLOR)
    .setTitle(TEXTS.PICK_ONE)
    .setDescription(
      shown
        .map((entry) => {
          const artist = entry.track.artist ?? entry.track.source;
          return `**${entry.track.title}**\n${artist} · \`${formatDuration(entry.track.durationSeconds)}\``;
        })
        .join('\n\n'),
    )
    .setFooter({ text: `Arama: ${query} · menüyü yalnızca isteyen kullanabilir` });

  const menu = new StringSelectMenuBuilder()
    .setCustomId(buildSelectionId(requestId))
    .setPlaceholder('Şarkı seç')
    .addOptions(
      shown.map((entry, index) => ({
        label: entry.track.title.slice(0, 100),
        value: `${index}`,
        description: `${(entry.track.artist ?? entry.track.source).slice(0, 90)} · ${formatDuration(entry.track.durationSeconds)}`,
      })),
    );

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] };
}

/**
 * The same payload with the menu taken away.
 *
 * Used after a selection so the message stops being interactive rather than
 * leaving a menu that no longer resolves to anything.
 *
 * @param {object} payload The original message payload.
 * @param {string} [note] Line appended to the embed description.
 */
export function retireSelectionPayload(payload, note = null) {
  const embed = payload.embeds?.[0];
  if (embed && note) {
    const description = embed.data?.description ?? '';
    embed.setDescription(`${description}\n\n${note}`);
  }
  return { embeds: payload.embeds ?? [], components: [] };
}
