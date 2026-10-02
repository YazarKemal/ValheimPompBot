/**
 * Per-guild music queue.
 *
 * A plain data structure with no Discord and no audio in it, so every ordering,
 * limit and repeat rule is testable in isolation. One instance exists per guild;
 * the session owns it.
 *
 * Repeat modes:
 *   off  - play through and stop
 *   one  - replay the current track forever
 *   all  - when the queue empties, refill it from what has been played
 */

export const REPEAT_MODES = Object.freeze(['off', 'one', 'all']);

export const ADD_RESULT = Object.freeze({
  ADDED: 'added',
  QUEUE_FULL: 'queue-full',
  TOO_LONG: 'too-long',
});

export class GuildQueue {
  /**
   * @param {object} [options]
   * @param {number} [options.maxSize] Maximum queued tracks (excluding current).
   * @param {number} [options.maxTrackSeconds] Longest accepted track.
   */
  constructor({ maxSize = 50, maxTrackSeconds = 20 * 60 } = {}) {
    this.maxSize = maxSize;
    this.maxTrackSeconds = maxTrackSeconds;
    /** @type {Array<{track: object, requestedBy: string, requestedById: string}>} */
    this.items = [];
    /** @type {{track: object, requestedBy: string, requestedById: string}|null} */
    this.current = null;
    this.repeat = 'off';
    /** Tracks already played this session, used to refill in repeat-all. */
    this.history = [];
  }

  get size() {
    return this.items.length;
  }

  get isEmpty() {
    return this.current === null && this.items.length === 0;
  }

  /**
   * Adds a track to the back of the queue.
   *
   * @param {object} track
   * @param {{ id: string, name: string }} requester
   * @returns {{ ok: boolean, reason: string|null, position: number|null }}
   */
  add(track, requester) {
    if (Number.isFinite(track?.durationSeconds) && track.durationSeconds > this.maxTrackSeconds) {
      return { ok: false, reason: ADD_RESULT.TOO_LONG, position: null };
    }
    if (this.items.length >= this.maxSize) {
      return { ok: false, reason: ADD_RESULT.QUEUE_FULL, position: null };
    }

    this.items.push({
      track,
      requestedBy: requester?.name ?? 'bilinmiyor',
      requestedById: requester?.id ?? null,
    });
    return { ok: true, reason: null, position: this.items.length };
  }

  /**
   * Takes the next item. Under repeat-all the queue is refilled from history
   * first, so playback loops without the caller knowing.
   *
   * @returns {{track: object, requestedBy: string, requestedById: string}|null}
   */
  next() {
    if (this.items.length === 0 && this.repeat === 'all' && this.history.length > 0) {
      this.items = this.history.map((item) => ({ ...item }));
      this.history = [];
    }

    const item = this.items.shift() ?? null;
    this.current = item;
    if (item) this.history.push(item);
    return item;
  }

  /** Puts the current track back at the front, for repeat-one. */
  replayCurrent() {
    if (!this.current) return null;
    this.items.unshift(this.current);
    this.history = this.history.filter((item) => item !== this.current);
    return this.current;
  }

  /** Removes and returns the item at `index`. */
  removeAt(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.items.length) return null;
    return this.items.splice(index, 1)[0];
  }

  /** Fisher-Yates, so shuffling is uniform rather than merely "different". */
  shuffle(random = Math.random) {
    for (let index = this.items.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(random() * (index + 1));
      [this.items[index], this.items[swap]] = [this.items[swap], this.items[index]];
    }
    return this.items.length;
  }

  clear() {
    const removed = this.items.length;
    this.items = [];
    return removed;
  }

  /** Everything the UI shows: the current track followed by what is queued. */
  snapshot() {
    return {
      current: this.current,
      upcoming: this.items.map((item) => ({ ...item })),
      repeat: this.repeat,
      size: this.items.length,
    };
  }

  /** Total queued runtime in seconds (excludes the current track). */
  totalQueuedSeconds() {
    return this.items.reduce((total, item) => total + (item.track?.durationSeconds ?? 0), 0);
  }
}
