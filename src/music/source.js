import { BotError } from '../utils/errors.js';

/**
 * Music source interface.
 *
 * The queue, the player and every control talk to this shape and never to a
 * media provider. Replacing YouTube with something else means writing one
 * module; nothing in the Discord layer changes.
 *
 * Contract:
 *   name                        stable id, shown in embeds
 *   search(query, {limit})      -> Track[]   (ranked by relevance, best first)
 *   resolve(track)              -> Track     (full metadata for a chosen track)
 *   createAudioStream(track)    -> { stream: Readable, inputType }
 *
 * `inputType` is the Discord stream type. YouTube serves Opus inside WebM, which
 * Discord accepts directly, so no transcoding step is needed.
 *
 * Deliberately absent: any notion of the AI layer. Music never calls a model.
 */

/** Normalised track. Every field the UI needs, nothing provider-specific. */
export function normaliseTrack(raw) {
  const id = String(raw?.id ?? '').trim();
  if (!id) throw new BotError('A track requires an id.', { code: 'MUSIC_TRACK_INVALID' });

  const title = String(raw?.title ?? '').trim();
  if (!title) throw new BotError('A track requires a title.', { code: 'MUSIC_TRACK_INVALID' });

  const duration = Number(raw?.durationSeconds);

  return Object.freeze({
    id,
    source: String(raw.source ?? 'unknown'),
    title,
    artist: raw.artist ? String(raw.artist) : null,
    durationSeconds: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null,
    thumbnailUrl: raw.thumbnailUrl ? String(raw.thumbnailUrl) : null,
    url: raw.url ? String(raw.url) : null,
  });
}

/**
 * Base class. Concrete sources override the three methods.
 *
 * Every method must throw a `BotError` with a stable code rather than letting a
 * vendor error escape: the caller turns those into user-facing text, and a raw
 * provider message must never reach Discord.
 */
export class MusicSource {
  /** @param {{ name: string }} options */
  constructor({ name }) {
    this.name = name;
  }

  /** @returns {boolean} whether the source can run at all right now */
  isConfigured() {
    return true;
  }

  /**
   * @param {string} query
   * @param {{ limit?: number, signal?: AbortSignal }} [options]
   * @returns {Promise<object[]>}
   */
  // eslint-disable-next-line no-unused-vars -- interface method
  async search(query, options = {}) {
    throw new BotError(`Music source "${this.name}" does not implement search().`, {
      code: 'MUSIC_SOURCE_UNIMPLEMENTED',
    });
  }

  /**
   * @param {object} track
   * @returns {Promise<object>}
   */
  // eslint-disable-next-line no-unused-vars -- interface method
  async resolve(track) {
    return track;
  }

  /**
   * @param {object} track
   * @returns {Promise<{ stream: import('node:stream').Readable, inputType: unknown }>}
   */
  // eslint-disable-next-line no-unused-vars -- interface method
  async createAudioStream(track) {
    throw new BotError(`Music source "${this.name}" does not implement createAudioStream().`, {
      code: 'MUSIC_SOURCE_UNIMPLEMENTED',
    });
  }
}

/** Formats a duration as `m:ss` or `h:mm:ss`. */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '--:--';
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  const pad = (value) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}
