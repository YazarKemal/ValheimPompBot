import { ChannelType } from 'discord.js';
import { createNullLogger } from '../utils/logger.js';
import { createDiscordVoiceAdapter } from './voice.js';
import { createMusicSession, createSessionManager } from './session.js';
import { createRequestGuard } from './request-guard.js';
import { createSelectionCache } from './selection-cache.js';
import { createYouTubeSource } from './sources/youtube.js';
import { createStreamBackend } from './sources/ytdlp.js';
import { createBattleStore, DEFAULT_BATTLE_SECONDS } from './battle.js';
import { buildNowPlayingEmbed, buildControlRow } from './messages.js';

/**
 * Music service.
 *
 * Wires the pieces together for a running bot: source, per-guild sessions,
 * request guard, and the now-playing card. Everything below it is injectable,
 * so a test can drive the full request flow against fakes.
 *
 * There is no AI anywhere in this module tree. A song name is a search query.
 */

export { createMusicSession, createSessionManager, ENQUEUE_RESULT } from './session.js';
export { createRequestGuard } from './request-guard.js';
export { createSelectionCache, selectionKey } from './selection-cache.js';
export { createYouTubeSource, YouTubeSource, canonicalYoutubeUrl, resolveStreamUrl } from './sources/youtube.js';
export { createStreamBackend, detectYtDlp, YtDlpStreamBackend, DEFAULT_FORMAT } from './sources/ytdlp.js';
export { handleMusicRequest, shouldHandle, matchesChannelName } from './listener.js';
export { createDiscordVoiceAdapter } from './voice.js';
export * from './messages.js';
export * from './controls.js';
export { GuildQueue, REPEAT_MODES, ADD_RESULT } from './queue.js';
export { rankResults, assessConfidence, scoreResult, tokenise } from './search.js';
export { normaliseTrack, formatDuration, MusicSource } from './source.js';

/**
 * @param {object} options
 * @param {import('discord.js').Client} options.client
 * @param {object} options.config Parsed application config.
 * @param {object} [options.logger]
 * @param {object} [options.source] Injected MusicSource (tests).
 * @param {Function} [options.voiceFactory] Injected voice adapter (tests).
 */
export function createMusicService({
  client,
  config,
  logger = createNullLogger(),
  source = null,
  providedBackend = null,
  backendDetection = null,
  voiceFactory = createDiscordVoiceAdapter,
}) {
  const settings = config?.music ?? {};
  // Extraction goes through yt-dlp; search still uses play-dl. The backend is
  // resolved once, so every stream in this process shares the same executable.
  const streamBackend = providedBackend ?? null;
  // When there is no backend, the detection says whether that was ordinary (no
  // yt-dlp) or a specific refusal (an unusable PO token provider), so a failed
  // request reports the real cause.
  const streamUnavailable =
    !streamBackend && backendDetection && !backendDetection.available
      ? { code: backendDetection.code ?? null, reason: backendDetection.reason ?? null }
      : null;
  const musicSource = source ?? createYouTubeSource({ logger, streamBackend, streamUnavailable });
  const sessions = createSessionManager();
  const guard = createRequestGuard({ cooldownSeconds: settings.requestCooldownSeconds });
  // Holds the candidates for a disambiguation menu between the message that
  // posted it and the click that resolves it.
  const selections = createSelectionCache({ timeoutSeconds: settings.selectionTimeoutSeconds });
  // /kapisma is voting only: it never queues, plays or streams anything, so it
  // lives beside the session manager rather than inside it.
  const battles = createBattleStore({ seconds: settings.battleSeconds ?? DEFAULT_BATTLE_SECONDS });

  const maxTrackSeconds = (settings.maxTrackMinutes ?? 20) * 60;

  /** Finds the configured music text channel across the bot's guilds. */
  async function resolveTextChannel() {
    for (const guild of client.guilds.cache.values()) {
      const channel = guild.channels.cache.find(
        (candidate) =>
          candidate.type === ChannelType.GuildText &&
          candidate.name.toLowerCase() === String(settings.textChannel ?? '').toLowerCase(),
      );
      if (channel) return channel;
    }
    return null;
  }

  /** Posts the public now-playing card, with the control buttons. */
  async function publishNowPlaying(session) {
    const item = session.queue.current;
    if (!item) return false;

    const channel = await resolveTextChannel();
    if (!channel) {
      logger.warn('Music text channel not found; skipping the now-playing card.', {
        channel: settings.textChannel,
      });
      return false;
    }

    try {
      await channel.send({
        embeds: [buildNowPlayingEmbed(item, { repeat: session.queue.repeat })],
        components: [buildControlRow()],
      });
      return true;
    } catch (error) {
      logger.warn('Could not post the now-playing card.', { reason: error?.message });
      return false;
    }
  }

  /**
   * Summons PompMusic into a voice channel.
   *
   * The only way a session is created. Requests never create one, which is what
   * stops a plain song name from dragging the bot into a channel.
   *
   * @param {object} options
   * @param {import('discord.js').Guild} options.guild
   * @param {string} options.channelId
   * @param {string|null} [options.channelName]
   */
  function summon({ guild, channelId, channelName = null }) {
    return sessions.getOrCreate(guild.id, () => {
      const voice = voiceFactory({ guild, logger });
      const session = createMusicSession({
        guildId: guild.id,
        source: musicSource,
        voice,
        voiceChannelId: channelId,
        channelName,
        idleDisconnectSeconds: settings.idleDisconnectSeconds,
        maxQueueSize: settings.maxQueueSize,
        maxTrackSeconds,
        logger,
      });

      // The card follows playback, so an auto-advanced track is announced too.
      session.on('trackStart', () => {
        void publishNowPlaying(session);
      });

      // A pending menu belongs to a voice session. When that session ends, the
      // candidates it offered are meaningless and are dropped with it.
      session.onDisconnected(() => {
        selections.deleteByGuild(guild.id);
      });

      logger.info('PompMusic summoned.', { guildId: guild.id, voiceChannelId: channelId });
      return session;
    });
  }

  return {
    source: musicSource,
    sessions,
    guard,
    selections,
    battles,
    settings,
    maxTrackSeconds,
    publishNowPlaying,
    resolveTextChannel,
    summon,

    /** Destroys the guild session and disconnects PompMusic. */
    leave(guildId) {
      const session = sessions.get(guildId);
      if (!session) return false;
      selections.deleteByGuild(guildId);
      sessions.remove(guildId);
      logger.info('PompMusic left the voice channel.', { guildId });
      return true;
    },


    /** Everything the message listener needs. */
    listenerDeps() {
      return {
        source: musicSource,
        sessions,
        selections,
        guard,
        logger,
        config: { searchLimit: settings.searchLimit, confidence: settings.confidence },
      };
    },

    destroy() {
      sessions.clear();
      selections.clear();
      // Cancels every pending battle timer so nothing fires after shutdown.
      battles.destroy();
    },
  };
}
