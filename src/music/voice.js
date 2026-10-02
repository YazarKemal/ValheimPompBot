import {
  AudioPlayerStatus,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice';

/**
 * Discord voice adapter.
 *
 * The only module that imports `@discordjs/voice`. Everything above it talks to
 * the small interface below, which is what lets the queue and session logic be
 * tested without a gateway, an audio encoder or an actual voice channel.
 *
 * Interface returned:
 *   join(channelId)      connect to a voice channel and become ready
 *   leave()              disconnect and release the player
 *   play(stream, opts)   play one audio stream; resolves when it is PLAYING
 *   pause() / resume() / stop()
 *   on(event, handler)   'idle' | 'error' | 'stateChange' | 'playerState'
 *   channelId            the channel currently connected to, or null
 *   destroy()
 */

export const VOICE_EVENTS = Object.freeze(['idle', 'error', 'stateChange', 'playerState']);

/** How long to wait for a voice connection to become ready. */
export const VOICE_READY_TIMEOUT_MS = 20000;

/**
 * How long the player has to leave Buffering and reach Playing.
 *
 * Every state transition is logged, so a track that stalls here says exactly
 * which state it stalled in rather than just going quiet.
 */
export const PLAY_START_TIMEOUT_MS = 15000;

/**
 * @param {object} options
 * @param {import('discord.js').Guild} options.guild
 * @param {object} [options.logger]
 * @param {number} [options.playStartTimeoutMs] Overridable so the timeout path
 *   can be exercised without waiting out the real one.
 */
export function createDiscordVoiceAdapter({ guild, logger = null, playStartTimeoutMs = PLAY_START_TIMEOUT_MS }) {
  // `debug: true` makes the player emit its own diagnostics instead of printing
  // them; they are forwarded at debug level below. Without it a player that
  // never starts is completely silent about why.
  const player = createAudioPlayer({ debug: true });
  /** @type {Map<string, Function[]>} */
  const listeners = new Map();
  let connection = null;

  const emit = (event, payload) => {
    for (const handler of listeners.get(event) ?? []) {
      try {
        handler(payload);
      } catch (error) {
        logger?.error?.('Music listener threw.', error);
      }
    }
  };

  // The state machine is the diagnostic: buffering -> playing is the boundary
  // between "Discord accepted the stream" and "Discord is being fed audio".
  player.on('stateChange', (oldState, newState) => {
    logger?.info?.('Audio player state changed.', {
      guildId: guild?.id ?? null,
      from: oldState?.status ?? null,
      to: newState?.status ?? null,
      resource: newState?.resource?.metadata ?? null,
    });
    emit('playerState', { from: oldState?.status ?? null, to: newState?.status ?? null });
  });

  player.on('debug', (message) => logger?.debug?.('Audio player debug.', { guildId: guild?.id ?? null, message: String(message) }));
  player.on(AudioPlayerStatus.Idle, () => emit('idle'));
  player.on('error', (error) => emit('error', error));

  return {
    get channelId() {
      return connection?.joinConfig?.channelId ?? null;
    },

    get isConnected() {
      return Boolean(connection) && connection.state.status !== VoiceConnectionStatus.Destroyed;
    },

    /**
     * Joins a voice channel, or does nothing when already connected to it.
     * Rejoining a *different* channel is the caller's decision, not this one's:
     * the session refuses to move between channels mid-session.
     */
    async join(channelId) {
      if (connection && connection.joinConfig.channelId === channelId) return connection;

      connection = joinVoiceChannel({
        channelId,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: true,
      });

      connection.on('error', (error) => emit('error', error));
      // Connection transitions are logged for the same reason as the player's:
      // a connection that never reaches Ready, or that drops mid-track, is
      // otherwise indistinguishable from a track that plays silently.
      connection.on('stateChange', (oldState, newState) => {
        logger?.info?.('Voice connection state changed.', {
          guildId: guild?.id ?? null,
          channelId: connection?.joinConfig?.channelId ?? channelId,
          from: oldState?.status ?? null,
          to: newState?.status ?? null,
        });
      });
      connection.on(VoiceConnectionStatus.Disconnected, () => emit('stateChange', 'disconnected'));

      await entersState(connection, VoiceConnectionStatus.Ready, VOICE_READY_TIMEOUT_MS);
      connection.subscribe(player);
      return connection;
    },

    /**
     * Plays one stream and reports whether playback actually began.
     *
     * The returned promise resolves only once the player reaches `Playing`.
     * That is a real boundary, not a formality: with a `webm/opus` resource the
     * player sits in `Buffering` until the WebM demuxer has parsed a header and
     * produced at least one Opus packet, so `Playing` means Discord is holding
     * decodable audio. It fails fast instead when the player gives up first
     * (`Idle` before ever playing, i.e. the stream was not decodable) or when it
     * never leaves `Buffering` within `PLAY_START_TIMEOUT_MS`.
     *
     * @param {import('node:stream').Readable} stream
     * @param {{ inputType?: unknown, metadata?: object }} [options]
     * @returns {Promise<{ ok: boolean, reason: string|null, status: string|null }>}
     */
    play(stream, options = {}) {
      const resource = createAudioResource(stream, {
        ...(options.inputType ? { inputType: options.inputType } : {}),
        ...(options.metadata ? { metadata: options.metadata } : {}),
      });

      /** Settles the promise below; replaced once the executor has run. */
      let settle = () => {};

      const started = new Promise((resolve) => {
        let settled = false;
        const cleanup = () => {
          clearTimeout(timer);
          player.off('stateChange', onStateChange);
          player.off('error', onError);
        };
        const finish = (value) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        };

        const onStateChange = (_oldState, newState) => {
          if (newState.status === AudioPlayerStatus.Playing) {
            finish({ ok: true, reason: null, status: newState.status });
          } else if (newState.status === AudioPlayerStatus.Idle) {
            // Back to Idle without ever playing: the resource was not playable.
            finish({ ok: false, reason: 'idle-before-playing', status: newState.status });
          }
        };
        const onError = (error) => finish({ ok: false, reason: error?.message ?? 'player error', status: null });

        const timer = setTimeout(() => {
          const status = player.state?.status ?? null;
          // Settled BEFORE stopping: `stop()` emits its own state change
          // synchronously, and resolving after it would report the stop as the
          // reason rather than the timeout that caused it.
          finish({ ok: false, reason: 'start-timeout', status });
          // Nothing is going to start. Stopping keeps a stuck resource from
          // holding the player for the next track.
          player.stop(true);
        }, playStartTimeoutMs);
        timer.unref?.();

        player.on('stateChange', onStateChange);
        player.on('error', onError);
        settle = finish;
      });

      try {
        player.play(resource);
      } catch (error) {
        // A resource that has already ended, or is owned by another player.
        // Reported the same way as any other failure to start, rather than
        // thrown past a caller that expects a promise.
        settle({ ok: false, reason: error?.message ?? 'player error', status: null });
      }

      return started;
    },

    pause() {
      return player.pause();
    },

    resume() {
      return player.unpause();
    },

    stop() {
      player.stop(true);
    },

    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
      return () => {
        const handlers = listeners.get(event) ?? [];
        const index = handlers.indexOf(handler);
        if (index >= 0) handlers.splice(index, 1);
      };
    },

    leave() {
      player.stop(true);
      if (connection) {
        connection.destroy();
        connection = null;
      }
    },

    destroy() {
      listeners.clear();
      player.stop(true);
      if (connection) {
        connection.destroy();
        connection = null;
      }
    },
  };
}
