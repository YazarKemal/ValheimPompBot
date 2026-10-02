import { createNullLogger } from '../utils/logger.js';
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
   * Opens the stream for an item and hands it to the voice adapter.
   * A failure here skips the track rather than stopping playback.
   */
  async function startItem(item) {
    // The previous track's process is torn down before a new one starts, so a
    // skip cannot leave the old yt-dlp running alongside the new.
    killCurrentStream();

    try {
      const { stream, inputType, kill } = await source.createAudioStream(item.track);
      // Ownership of the child process travels with the stream.
      currentStream = typeof kill === 'function' ? { kill, trackId: item.track?.id ?? null } : null;
      voice.play(stream, { inputType });
      startedAt = now();
      emit('trackStart', item);
      return item;
    } catch (error) {
      logger.warn('Failed to open an audio stream; skipping.', {
        // The title, not just the id: logging only the id once made this look
        // like a bare id was being passed to the provider.
        track: item.track?.title ?? item.track?.id ?? null,
        videoId: item.track?.id ?? null,
        reason: error?.message,
        code: error?.code ?? null,
      });
      emit('error', { stage: 'stream', track: item.track, error });
      return null;
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
    if (!started) return advance();
    return started;
  }

  voice.on('idle', () => {
    if (destroyed) return;
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
        await advance();
        // `advance` pulled the item we just added.
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
