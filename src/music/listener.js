import { createNullLogger } from '../utils/logger.js';
import { rankResults, assessConfidence } from './search.js';
import { ADD_RESULT } from './queue.js';
import { TEXTS, buildNowPlayingEmbed, buildControlRow, buildSelectionPayload } from './messages.js';
import { PRESENCE_TEXTS } from './presence.js';
import { resolveMemberVoiceChannel } from './voice-state.js';

/**
 * Plain-text music requests.
 *
 * The whole point of the feature: someone types a song name into #muzik-istek
 * and it plays. No prefix, no slash command, no URL.
 *
 * The channel check is the single most important line in this file. Message
 * content arrives from every channel the bot can read, and a false positive
 * here means a song starts playing because somebody said a band name in #genel.
 * `shouldHandle` is therefore explicit, tested, and fails closed on anything it
 * does not recognise.
 *
 * No AI is involved at any point: a song name is a search query, not a prompt.
 */

/** Config used when a caller does not supply one. */
export const DEFAULTS = Object.freeze({
  requestCooldownSeconds: 3,
  searchLimit: 5,
  confidence: undefined,
});

/**
 * Whether a message should be treated as a music request.
 *
 * Fails closed: anything that is not a plain text message in the configured
 * music channel, from a human, is ignored.
 *
 * @param {object} message
 * @param {{ musicChannelName: string, musicChannelId?: string|null }} options
 * @returns {boolean}
 */
export function shouldHandle(message, { musicChannelName, musicChannelId = null } = {}) {
  if (!message) return false;
  if (message.author?.bot) return false;
  if (message.system) return false;
  // Only ordinary messages. Replies, slash invocations and pins are not requests.
  if (typeof message.content !== 'string') return false;
  if (message.content.trim() === '') return false;
  // Commands start with a prefix; they are never a song name.
  if (message.content.trim().startsWith('/')) return false;

  if (musicChannelId) return message.channelId === musicChannelId;
  return matchesChannelName(message.channel?.name, musicChannelName);
}

/** Channel-name comparison, case- and padding-insensitive. */
export function matchesChannelName(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  // Plain toLowerCase: the Turkish locale turns an ASCII "I" into a dotless
  // "ı", which would stop a channel name matching itself when typed in capitals.
  const left = actual.trim().toLowerCase();
  const right = expected.trim().toLowerCase();
  return left !== '' && right !== '' && left === right;
}

/**
 * Handles one candidate message.
 *
 * @param {object} message
 * @param {object} deps
 * @param {object} deps.source MusicSource
 * @param {object} deps.sessions Session manager
 * @param {object} deps.sessions Per-guild session registry.
 * @param {object} deps.guard Request guard
 * @param {object} [deps.logger]
 * @param {object} [deps.config]
 * @returns {Promise<{ handled: boolean, action: string, reason?: string }>}
 */
export async function handleMusicRequest(message, deps) {
  const logger = deps.logger ?? createNullLogger();
  const query = message.content.trim();
  const guildId = message.guildId ?? message.guild?.id ?? null;
  const userId = message.author?.id ?? null;

  // 1. PompMusic must already have been summoned. A plain song name never
  //    makes it appear: it is called once with /gel and then stays. This is the
  //    product change that stops every request from moving the bot around.
  const session = deps.sessions?.get?.(guildId) ?? null;
  if (!session || session.destroyed) {
    await reply(message, PRESENCE_TEXTS.needSummon, logger);
    return { handled: true, action: 'rejected', reason: 'no-session' };
  }

  // 2. The requester must be in the channel PompMusic is actually sitting in.
  //    Someone elsewhere in the server cannot add to this session.
  const voiceChannelId = resolveMemberVoiceChannel({
    guild: message.guild,
    userId: userId ?? message.author?.id,
    member: message.member,
  });
  if (!voiceChannelId) {
    await reply(message, PRESENCE_TEXTS.NOT_IN_VOICE, logger);
    return { handled: true, action: 'rejected', reason: 'not-in-voice' };
  }
  if (session.voiceChannelId !== voiceChannelId) {
    await reply(message, PRESENCE_TEXTS.wrongChannel(session.channelName ?? session.voiceChannelId), logger);
    return { handled: true, action: 'rejected', reason: 'wrong-channel' };
  }

  // 2. Burst protection, before any search is issued.
  const verdict = deps.guard?.check(guildId, userId, query);
  if (verdict && !verdict.ok) {
    await reply(
      message,
      `⏳ Bu şarkıyı az önce istedin. ${Math.ceil(verdict.retryAfterMs / 1000)} sn sonra tekrar dene.`,
      logger,
    );
    return { handled: true, action: 'rejected', reason: 'duplicate' };
  }

  // 3. Search. Ranked by the pure scorer, never by the provider's own order.
  let results;
  try {
    results = await deps.source.search(query, { limit: deps.config?.searchLimit ?? DEFAULTS.searchLimit });
  } catch (error) {
    logger.warn('Music search failed.', { reason: error?.message });
    await reply(message, '🔇 Arama şu anda çalışmıyor. Lütfen sonra tekrar dene.', logger);
    return { handled: true, action: 'rejected', reason: 'search-failed' };
  }

  if (!Array.isArray(results) || results.length === 0) {
    await reply(message, `🔍 **${query}** için sonuç bulunamadı.`, logger);
    return { handled: true, action: 'rejected', reason: 'no-results' };
  }

  const ranked = rankResults(results, query, { limit: deps.config?.searchLimit ?? DEFAULTS.searchLimit });
  const confidence = assessConfidence(ranked, deps.config?.confidence);

  // 4. Ambiguous searches ask rather than guess. Playing the wrong song in a
  //    shared channel is worse than one extra click.
  if (!confidence.confident) {
    const offered = await offerChoices(message, deps, { query, ranked, voiceChannelId, logger });
    return { handled: true, action: 'disambiguate', reason: confidence.reason, offered };
  }

  return enqueue(message, deps, confidence.top.track, logger);
}

/**
 * Posts the selection menu and records the candidates so a click can be
 * resolved later.
 *
 * The cache entry is written **before** the menu is sent and removed again if
 * sending fails, so a click can never arrive for a menu that was not recorded -
 * and a menu is never left on screen with nothing behind it.
 *
 * The request id is the id of the *asking* message, which is known up front.
 * That is what lets the customId be built before the reply exists.
 *
 * @returns {Promise<boolean>} whether the menu was posted
 */
export async function offerChoices(message, deps, { query, ranked, voiceChannelId, logger = createNullLogger() }) {
  const cache = deps.selections;
  if (!cache) {
    logger.warn('No selection cache is wired up; refusing to post a menu that cannot resolve.');
    await reply(message, '🔇 Arama belirsiz çıktı ve seçim menüsü kullanılamıyor. Şarkı adını daha belirgin yaz.', logger);
    return false;
  }

  const requestId = message.id ?? null;
  const identity = { guildId: message.guildId ?? null, channelId: message.channelId ?? null, requestId };

  const key = cache.put(identity, {
    userId: message.author?.id ?? null,
    voiceChannelId,
    ranked,
    query,
  });

  if (!key) {
    logger.warn('Could not key a selection; the message has no id.');
    await reply(message, '🔇 Seçim menüsü oluşturulamadı. Şarkı adını tekrar yaz.', logger);
    return false;
  }

  const payload = buildSelectionPayload(query, ranked, { requestId });

  try {
    const posted = await message.channel.send(payload);
    // Remembered so the menu can be retired once a choice is made.
    const entry = cache.get(identity);
    if (entry) entry.messageId = posted?.id ?? null;
    return true;
  } catch (error) {
    // The menu never reached Discord, so nothing can legitimately resolve to it.
    cache.delete(identity);
    logger.warn('Could not post the selection menu.', { reason: error?.message });
    return false;
  }
}

/**
 * Queues a chosen track and posts the now-playing card.
 * Exported so the disambiguation menu reuses exactly this path.
 */
export async function enqueue(message, deps, track, logger = createNullLogger()) {
  // `deps.session` lets a caller supply an already-resolved session, which is
  // how a menu selection reuses the original voice session.
  const guildId = message.guildId ?? message.guild?.id ?? null;
  const session = deps.session ?? deps.sessions?.get?.(guildId) ?? null;

  // Never create a session here. PompMusic is summoned with /gel and not
  // otherwise; a request must not be able to bring it into a channel.
  if (!session || session.destroyed) {
    await reply(message, PRESENCE_TEXTS.needSummon, logger);
    return { handled: true, action: 'rejected', reason: 'no-session', message: PRESENCE_TEXTS.needSummon };
  }

  const requester = { id: message.author?.id ?? null, name: message.author?.username ?? 'bilinmiyor' };

  const result = await session.enqueue(track, requester);

  if (!result.ok) {
    const text =
      result.reason === ADD_RESULT.TOO_LONG
        ? `⏱️ Bu parça çok uzun (en fazla ${Math.round(session.queue.maxTrackSeconds / 60)} dakika).`
        : `📛 Sıra dolu (en fazla ${session.queue.maxSize} şarkı).`;
    await reply(message, text, logger);
    // The text travels back with the result so a caller that answers through an
    // interaction can reply with it rather than inventing its own message.
    return { handled: true, action: 'rejected', reason: result.reason, message: text };
  }

  if (!result.started) {
    const text = `➕ Sıraya eklendi: **${track.title}** (${result.position}. sırada)`;
    await reply(message, text, logger);
    return { handled: true, action: 'queued', message: text };
  }

  // The now-playing card is posted by the service's `trackStart` handler, so it
  // fires for auto-advanced tracks too, not only the first one.
  return { handled: true, action: 'playing', message: `▶️ Çalınıyor: **${track.title}**` };
}

/** Sends a reply, tolerating a channel the bot can no longer post in. */
async function reply(message, payload, logger) {
  const body = typeof payload === 'string' ? { content: payload } : payload;
  try {
    await message.channel.send(body);
  } catch (error) {
    logger.warn('Could not reply in the music channel.', { reason: error?.message });
  }
}

export { buildNowPlayingEmbed, buildControlRow };
