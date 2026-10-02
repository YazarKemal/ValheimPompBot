import { createNullLogger } from '../utils/logger.js';
import { BotError } from '../utils/errors.js';
import { GuildQueue, ADD_RESULT } from './queue.js';

/**
 * One music session per guild.
 *
 * Owns the queue, the voice adapter and the idle timer. Everything here is
 * driven by explicit method calls so the whole lifecycle - join, play, queue,
 * skip, drain, disconnect - is testable against a fake voice adapter.
 *
 * Guarantees:
 *   - one session, one queue, one voice connection per guild
 *   - the session never moves between voice channels on its own; a request from
 *     a different channel is refused rather than obeyed
 *   - when the queue drains, the bot lingers for `idleDisconnectSeconds` and
 *     then leaves by itself
 *   - a failure to open a stream skips that track instead of wedging playback
 *   - no AI call is made anywhere in this file, or anything it imports
 */

export const SESSION_EVENTS = Object.freeze(['trackStart', 'queueEmpty', 'error', 'disconnected']);

/**
 * Extra result reasons returned by `enqueue`.
 *
 * `START_FAILED` means the item was accepted into the queue but never reached
 * playback - the stream produced no audio, or the player refused it. Reporting
 * this as "playing" is exactly the false claim the first-byte gate exists to
 * remove.
 */
export const ENQUEUE_RESULT = Object.freeze({
  START_FAILED: 'start-failed',
});

/**
 * Returned by a start that was superseded before it reached playback.
 *
 * Distinct from a failure and from null: an abandoned start must not be
 * announced, must not be reported as a failed track, and must not advance the
 * queue - the skip or stop that superseded it already did.
 */
const ABANDONED = Symbol('music-start-abandoned');

export function createMusicSession({
  guildId,
  source,
  voice,
  voiceChannelId,
  channelName = null,
  idleDisconnectSeconds = 120,
  maxQueueSize = 50,
  maxTrackSeconds = 20 * 60,
  logger = createNullLogger(),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  now = () => Date.now(),
}) {
  const queue = new GuildQueue({ maxSize: maxQueueSize, maxTrackSeconds });
  const listeners = new Map();
  let idleTimer = null;
  let destroyed = false;
  let startedAt = null;
  /** The stream currently playing, and the means to terminate its process. */
  let currentStream = null;
  /**
   * True between asking the voice adapter to play and the adapter reporting
   * whether playback began. The player emits `idle` in that window when a
   * stream turns out not to be playable, and `startItem` owns that failure -
   * without this flag the idle handler would advance a second time and skip an
   * extra track.
   */
  let starting = false;
  /** Incremented per start attempt; an older generation is stale on sight. */
  let startGeneration = 0;

  /**
   * Terminates the process behind the current stream.
   *
   * Scoped to this session, so one guild's skip can never reach another
   * guild's process. Safe to call when nothing is playing.
   */
  function killCurrentStream() {
    const stream = currentStream;
    currentStream = null;
    if (!stream) return false;
    try {
      return stream.kill() === true;
    } catch (error) {
      logger.debug('Killing an audio stream threw.', { reason: error?.message });
      return false;
    }
  }

  /**
   * Terminates a process handle this session opened but does not own anymore.
   * Used when a start is superseded before it could take ownership.
   */
  function stopOwnedStream(handle) {
    if (typeof handle?.kill !== 'function') return false;
    try {
      return handle.kill() === true;
    } catch (error) {
      logger.debug('Killing a superseded stream threw.', { reason: error?.message });
      return false;
    }
  }

  const emit = (event, payload) => {
    for (const handler of listeners.get(event) ?? []) {
      try {
        handler(payload);
      } catch (error) {
        logger.error('Music session listener threw.', error);
      }
    }
  };

  const cancelIdle = () => {
    if (idleTimer) {
      clearTimeoutImpl(idleTimer);
      idleTimer = null;
    }
  };

  /**
   * Schedules the automatic departure.
   *
   * `idleDisconnectSeconds` of 0 means never: PompMusic stays in the channel
   * after the queue drains and waits for the next request. That is the default
   * (POMPMUSIC_STAY_CONNECTED=true), and it is why an empty queue is not a
   * reason to leave.
   */
  const scheduleIdleDisconnect = () => {
    cancelIdle();
    if (idleDisconnectSeconds <= 0) return;
    idleTimer = setTimeoutImpl(() => {
      idleTimer = null;
      logger.info('Music idle timeout reached; leaving the voice channel.', { guildId });
      destroy();
    }, idleDisconnectSeconds * 1000);
    idleTimer?.unref?.();
  };

  /**
   * Opens the stream for an item, plays it, and only then announces it.
   *
   * `trackStart` is emitted once playback has actually reached the player's
   * Playing state - never when a process was merely spawned. That is what the
   * now-playing card is hung off, so the card cannot claim a track is playing
   * while the channel is silent.
   *
   * A failure at either stage skips the track rather than stopping playback.
   *
   * Opening a stream now takes as long as yt-dlp takes to produce audio, so a
   * skip can land while a track is still starting. Each start carries a
   * generation: a superseded one tears down what it opened and reports
   * `ABANDONED`, and never announces itself over the track that replaced it.
   *
   * @returns {Promise<object|symbol|null>} the item, ABANDONED, or null on failure
   */
  async function startItem(item) {
    // The previous track's process is torn down before a new one starts, so a
    // skip cannot leave the old yt-dlp running alongside the new.
    killCurrentStream();

    const generation = (startGeneration += 1);
    const requestedAt = now();
    starting = true;
    let owned = null;

    try {
      const { stream, inputType, kill } = await source.createAudioStream(item.track);

      if (generation !== startGeneration) {
        // Superseded while the extractor was opening. This stream belongs to no
        // one now, and `currentStream` is not ours to clear.
        stopOwnedStream({ kill });
        return ABANDONED;
      }

      // Ownership of the child process travels with the stream.
      owned = typeof kill === 'function' ? { kill, trackId: item.track?.id ?? null } : null;
      currentStream = owned;

      const outcome = await voice.play(stream, {
        inputType,
        metadata: { trackId: item.track?.id ?? null, title: item.track?.title ?? null },
      });

      if (generation !== startGeneration) {
        // Superseded while the player was starting; the newer start owns
        // playback now, so this one is dropped without a word.
        if (currentStream === owned) killCurrentStream();
        return ABANDONED;
      }

      // A voice adapter that reports nothing (a test double, or an older
      // implementation) is treated as started: the gate belongs to the adapter,
      // and inventing a failure here would break every other adapter.
      if (outcome && outcome.ok === false) {
        killCurrentStream();
        throw new BotError(`Playback did not start (${outcome.reason ?? 'unknown'}).`, {
          code: 'MUSIC_PLAYBACK_NOT_STARTED',
          details: { reason: outcome.reason ?? null, status: outcome.status ?? null, playerStatus: outcome.status ?? null },
        });
      }

      startedAt = now();
      logger.info('Track is now playing.', {
        track: item.track?.title ?? item.track?.id ?? null,
        videoId: item.track?.id ?? null,
        startMs: startedAt - requestedAt,
        playerStatus: outcome?.status ?? 'unknown',
      });
      emit('trackStart', item);
      return item;
    } catch (error) {
      // A failure after the stream opened is a player failure, not an
      // extraction one - the distinction matters when reading a Render log.
      const stage = error?.code === 'MUSIC_PLAYBACK_NOT_STARTED' ? 'player' : 'stream';
      logger.warn('Failed to start a track; skipping.', {
        // The title, not just the id: logging only the id once made this look
        // like a bare id was being passed to the provider.
        track: item.track?.title ?? item.track?.id ?? null,
        videoId: item.track?.id ?? null,
        reason: error?.message,
        code: error?.code ?? null,
        stage,
      });
      emit('error', { stage, track: item.track, error });
      return null;
    } finally {
      // Only the newest start owns the flag; an older one finishing must not
      // declare the startup over while a newer one is still running.
      if (generation === startGeneration) starting = false;
    }
  }

  /** Pulls the next item and plays it. Returns null when the queue is drained. */
  async function advance() {
    const item = queue.next();
    if (!item) {
      // Nothing follows. The finished track's process is already gone, but a
      // SKIP to an empty queue leaves one running, and it must not outlive the
      // track it was started for.
      killCurrentStream();
      scheduleIdleDisconnect();
      emit('queueEmpty', null);
      return null;
    }

    const started = await startItem(item);
    // Abandoned: a newer advance is already responsible for what plays next.
    // Recursing here would pull a second track out from under it.
    if (started === ABANDONED) return null;
    if (!started) return advance();
    return started;
  }

  voice.on('idle', () => {
    if (destroyed) return;
    // The player can fall back to Idle while a track is still being started
    // (the resource turned out not to be playable). `startItem` is awaiting
    // that outcome and will skip the track itself; advancing here as well
    // would skip two.
    if (starting) return;
    // The track finished on its own; its process has already exited, but the
    // handle must not linger and be killed later by an unrelated action.
    killCurrentStream();
    // Repeat-one replays the same track; anything else moves on.
    if (queue.repeat === 'one' && queue.current) {
      void startItem(queue.current);
      return;
    }
    void advance();
  });

  voice.on('error', (error) => {
    logger.warn('Voice playback error.', { reason: error?.message });
    emit('error', { stage: 'voice', error });
  });

  voice.on('stateChange', (state) => {
    if (state === 'disconnected') {
      logger.warn('Voice connection dropped.', { guildId });
      emit('disconnected', state);
      destroy();
    }
  });

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    // Anything still starting is superseded and must not announce itself into a
    // session that is already gone.
    startGeneration += 1;
    cancelIdle();
    killCurrentStream();
    try {
      voice.destroy();
    } catch (error) {
      logger.debug('Voice teardown threw.', { reason: error?.message });
    }
    listeners.clear();
  }

  return {
    guildId,
    get voiceChannelId() {
      return voiceChannelId;
    },
    /** Human-readable channel name, used by the presence messages. */
    get channelName() {
      return channelName;
    },
    /** True while the bot sits in voice with nothing to play. */
    isIdle() {
      return !queue.current && queue.items.length === 0;
    },
    get destroyed() {
      return destroyed;
    },
    get startedAt() {
      return startedAt;
    },
    queue,

    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
      return () => listeners.get(event)?.splice(listeners.get(event).indexOf(handler), 1);
    },

    onDisconnected(handler) {
      return this.on('disconnected', handler);
    },

    /**
     * Joins voice and, if nothing is playing, starts immediately.
     *
     * @returns {Promise<{ ok: boolean, reason: string|null }>}
     */
    async begin() {
      await voice.join(voiceChannelId);
      cancelIdle();
      if (!queue.current) await advance();
      return { ok: true, reason: null };
    },

    /**
     * Queues a track and starts playback when the bot was idle.
     *
     * @returns {Promise<{ ok: boolean, reason: string|null, position: number|null, started: boolean }>}
     */
    async enqueue(track, requester) {
      const wasPlaying = Boolean(queue.current);

      const added = queue.add(track, requester);
      if (!added.ok) return { ...added, started: false };

      if (!wasPlaying) {
        await voice.join(voiceChannelId);
        cancelIdle();
        // `advance` pulled the item we just added. It returns null when nothing
        // reached playback, which is reported rather than dressed up as a start.
        const started = await advance();
        if (!started) return { ok: false, reason: ENQUEUE_RESULT.START_FAILED, position: null, started: false };
        return { ok: true, reason: null, position: 0, started: true };
      }

      return { ok: true, reason: null, position: added.position, started: false };
    },

    /** Skips the current track. Returns false when nothing is playing. */
    skip() {
      if (!queue.current) return false;
      cancelIdle();
      void advance();
      return true;
    },

    /** Stops playback and empties the queue, staying connected. */
    stop() {
      // A start still in flight is superseded here, so a track that was opening
      // cannot begin playing after the queue has been emptied.
      startGeneration += 1;
      killCurrentStream();
      const cleared = queue.clear();
      queue.current = null;
      queue.history = [];
      cancelIdle();
      voice.stop();
      scheduleIdleDisconnect();
      return cleared;
    },

    pause() {
      if (!queue.current) return false;
      voice.pause();
      return true;
    },

    resume() {
      if (!queue.current) return false;
      voice.resume();
      return true;
    },

    shuffle() {
      return queue.shuffle();
    },

    setRepeat(mode) {
      queue.repeat = mode;
      return queue.repeat;
    },

    /** Cycles off -> all -> one -> off. */
    cycleRepeat() {
      const order = ['off', 'all', 'one'];
      queue.repeat = order[(order.indexOf(queue.repeat) + 1) % order.length];
      return queue.repeat;
    },

    snapshot() {
      return queue.snapshot();
    },

    isPlaying() {
      return Boolean(queue.current);
    },

    /** True while a stream process is owned by this session. */
    hasActiveStream() {
      return currentStream !== null;
    },

    killStream: killCurrentStream,

    destroy,
  };
}

/**
 * Registry of sessions, one per guild.
 *
 * Kept separate from the session so a guild's session can be asserted absent
 * after it ends, which is how per-guild isolation is verified.
 */
export function createSessionManager() {
  /** @type {Map<string, object>} */
  const sessions = new Map();

  return {
    get(guildId) {
      return sessions.get(guildId) ?? null;
    },

    has(guildId) {
      return sessions.has(guildId);
    },

    get size() {
      return sessions.size;
    },

    /**
     * Returns the guild's session, creating it when absent.
     * @param {string} guildId
     * @param {() => object} factory
     */
    getOrCreate(guildId, factory) {
      const existing = sessions.get(guildId);
      if (existing && !existing.destroyed) return existing;

      const session = factory();
      sessions.set(guildId, session);

      // A session that tears itself down must not linger in the registry.
      session.onDisconnected?.(() => sessions.delete(guildId));
      return session;
    },

    remove(guildId) {
      const session = sessions.get(guildId);
      if (session) session.destroy();
      sessions.delete(guildId);
    },

    clear() {
      for (const session of sessions.values()) session.destroy();
      sessions.clear();
    },
  };
}

export { ADD_RESULT };

