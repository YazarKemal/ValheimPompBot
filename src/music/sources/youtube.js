import { MusicSource, normaliseTrack } from '../source.js';
import { BotError } from '../../utils/errors.js';

/**
 * YouTube music source.
 *
 * Search and streaming both go through a `provider` object, defaulting to
 * play-dl. Injecting it keeps the tests free of network access and keeps this
 * module replaceable: swapping YouTube for anything else means writing one
 * provider, not rewriting the player.
 *
 * No AI is involved. A song name is a search query.
 */

export const YOUTUBE_SOURCE_NAME = 'youtube';

/** Canonical watch URL. A video id on its own is never playable. */
export const YOUTUBE_WATCH_BASE = 'https://www.youtube.com/watch?v=';

/**
 * Shape of a video id: URL-safe base64, within a plausible length window.
 *
 * Deliberately NOT pinned to exactly 11, which is what YouTube has used for
 * years. Pinning it would turn a provider-side rejection ("this video does not
 * exist") into a silent "no usable track" here, which is the worse failure: the
 * id is only ever used to build a URL, and play-dl is the thing that can
 * actually judge whether it resolves. The window is wide enough to survive a
 * length change and narrow enough to reject a sentence or a stray value.
 */
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{6,24}$/;

/** Hosts that serve a playable watch page. */
const YOUTUBE_HOSTS = new Set(['www.youtube.com', 'youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']);

/**
 * Builds a canonical watch URL from a video id.
 *
 * An id is an identifier; a URL is what play-dl can actually open. The two are
 * not interchangeable, and this function is the only sanctioned way to move
 * from one to the other.
 *
 * @param {string} videoId
 * @returns {string|null} null when the id is not a well-formed video id
 */
export function canonicalYoutubeUrl(videoId) {
  const id = String(videoId ?? '').trim();
  if (!VIDEO_ID_PATTERN.test(id)) return null;
  return `${YOUTUBE_WATCH_BASE}${id}`;
}

/**
 * True when the value is an absolute https URL on a YouTube host.
 * @param {unknown} value
 */
export function isYoutubeUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' && YOUTUBE_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Produces the URL to hand to play-dl.
 *
 * Order:
 *   1. a valid YouTube URL on the track
 *   2. a bare video id in the `url` field, repaired into a canonical URL
 *   3. a valid video id on the track
 *   otherwise a precise error - never a silent undefined passed downstream.
 *
 * @param {object} track
 * @returns {string}
 * @throws {BotError} code MUSIC_TRACK_INVALID
 */
export function resolveStreamUrl(track) {
  const raw = typeof track?.url === 'string' ? track.url.trim() : '';
  if (isYoutubeUrl(raw)) return raw;

  // A repaired id in the url field. This is the shape that would otherwise be
  // handed to play-dl as a bare id.
  const repaired = canonicalYoutubeUrl(raw);
  if (repaired) return repaired;

  const fromId = canonicalYoutubeUrl(track?.id);
  if (fromId) return fromId;

  throw new BotError(
    `Track "${track?.title ?? track?.id ?? 'unknown'}" has no usable YouTube URL ` +
      `(id=${JSON.stringify(track?.id ?? null)}, url=${JSON.stringify(track?.url ?? null)}).`,
    { code: 'MUSIC_TRACK_INVALID' },
  );
}

/** Loaded lazily so importing this module costs nothing and never throws. */
async function loadPlayDl() {
  const module = await import('play-dl');
  return module.default ?? module;
}

export class YouTubeSource extends MusicSource {
  /**
   * @param {object} [options]
   * @param {object} [options.provider] play-dl-shaped object (tests inject a fake).
   * @param {object} [options.logger]
   */
  /**
   * @param {object} [options]
   * @param {object} [options.provider] play-dl-shaped object, used for SEARCH only.
   * @param {object} [options.streamBackend] Audio extraction backend (yt-dlp).
   * @param {object} [options.logger]
   */
  constructor({ provider = null, streamBackend = null, logger = null } = {}) {
    super({ name: YOUTUBE_SOURCE_NAME });
    this.injectedProvider = provider;
    this.streamBackend = streamBackend;
    this.logger = logger;
    this.loadedProvider = null;
  }

  /** Whether audio can be played at all right now. */
  canStream() {
    return Boolean(this.streamBackend);
  }

  /** Resolves the provider once, on first use. */
  async provider() {
    if (this.injectedProvider) return this.injectedProvider;
    if (!this.loadedProvider) {
      this.loadedProvider = await loadPlayDl();
    }
    return this.loadedProvider;
  }

  isConfigured() {
    return true;
  }

  /**
   * @param {string} query
   * @param {{ limit?: number }} [options]
   * @returns {Promise<object[]>}
   */
  async search(query, { limit = 10 } = {}) {
    const provider = await this.provider();

    let results;
    try {
      results = await provider.search(query, {
        limit,
        source: { youtube: 'video' },
      });
    } catch (error) {
      throw new BotError(`YouTube search failed: ${error?.message ?? 'unknown error'}`, {
        code: 'MUSIC_SEARCH_FAILED',
        cause: error,
      });
    }

    if (!Array.isArray(results)) return [];

    return results
      .map((video) => {
        try {
          return normaliseTrack({
            id: video?.id,
            source: YOUTUBE_SOURCE_NAME,
            title: video?.title,
            artist: video?.channel?.name ?? null,
            durationSeconds: video?.durationInSec ?? video?.durationRaw,
            thumbnailUrl: pickThumbnail(video?.thumbnails),
            url: video?.url ?? (video?.id ? `https://www.youtube.com/watch?v=${video.id}` : null),
          });
        } catch {
          // One unusable result must not fail the whole search.
          return null;
        }
      })
      .filter(Boolean);
  }

  /**
   * Opens a playable stream.
   *
   * Returns `{ stream, inputType }`. YouTube serves Opus inside WebM, so
   * Discord can play it directly - no ffmpeg transcoding step.
   *
   * @param {object} track
   * @returns {Promise<{ stream: import('node:stream').Readable, inputType: unknown }>}
   */
  /**
   * Opens a playable stream through the yt-dlp backend.
   *
   * play-dl is no longer used for extraction: its YouTube media reader broke
   * when the player response format changed, and it could not be repaired from
   * this side. Search still uses it.
   *
   * This resolves only after the backend has seen real audio bytes, so a
   * track that YouTube refuses to serve fails here - naming the reason - rather
   * than becoming a silent "playing" state.
   *
   * @param {object} track
   * @returns {Promise<{ stream: import('node:stream').Readable, inputType: unknown, kill: Function, meta: object }>}
   */
  async createAudioStream(track) {
    // Resolved and validated BEFORE any process is started. A malformed track
    // fails here, naming the offending fields, rather than spawning yt-dlp
    // with something unusable.
    const url = resolveStreamUrl(track);

    if (!this.streamBackend) {
      throw new BotError('No audio stream backend is configured.', { code: 'MUSIC_STREAM_FAILED' });
    }

    this.logger?.debug?.('Opening an audio stream.', {
      source: YOUTUBE_SOURCE_NAME,
      videoId: track?.id ?? null,
      hasUrl: typeof track?.url === 'string' && track.url !== '',
      // Hostname only: a signed media URL carries credentials in its query.
      urlHost: safeHostname(url),
    });

    let result;
    try {
      result = await this.streamBackend.openStream(url);
    } catch (error) {
      // A backend error already carrying a code (MUSIC_YTDLP_*) is precise and
      // is passed through, whichever backend raised it. Anything else is wrapped
      // so callers always get a stable code rather than a vendor string.
      if (error instanceof BotError || String(error?.code ?? '').startsWith('MUSIC_')) throw error;
      throw new BotError(`The audio backend could not open this track: ${error?.message ?? 'unknown error'}`, {
        code: 'MUSIC_STREAM_FAILED',
        details: { videoId: track?.id ?? null },
        cause: error,
      });
    }

    // Reached only after yt-dlp wrote audio, so this line is evidence of real
    // extraction rather than of a process having been started.
    this.logger?.info?.('Audio stream started.', {
      backend: result.meta.backend,
      trackId: track?.id ?? null,
      source: YOUTUBE_SOURCE_NAME,
      format: result.meta.format,
      streamType: result.meta.streamType,
      startupMs: result.meta.startupMs,
      firstByteMs: result.meta.firstByteMs ?? null,
      attempt: result.meta.attempt ?? 1,
      attempts: result.meta.attempts ?? 1,
      // Hostname only: a signed media URL carries credentials in its query.
      urlHost: safeHostname(url),
    });

    return result;
  }
}

/** Hostname of a URL, or null. Never the full URL: those are signed. */
function safeHostname(value) {
  try {
    return new URL(String(value)).hostname;
  } catch {
    return null;
  }
}

/** Largest available thumbnail. */
function pickThumbnail(thumbnails) {
  if (!Array.isArray(thumbnails) || thumbnails.length === 0) return null;
  const sorted = [...thumbnails].filter((entry) => entry?.url).sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
  return sorted[0]?.url ?? null;
}

export function createYouTubeSource(options = {}) {
  return new YouTubeSource(options);
}
