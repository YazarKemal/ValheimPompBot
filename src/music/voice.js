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
 *   play(stream, opts)   play one audio stream
 *   pause() / resume() / stop()
 *   on(event, handler)   'idle' | 'error' | 'stateChange'
 *   channelId            the channel currently connected to, or null
 *   destroy()
 */

export const VOICE_EVENTS = Object.freeze(['idle', 'error', 'stateChange']);

/** How long to wait for a voice connection to become ready. */
export const VOICE_READY_TIMEOUT_MS = 20000;

/**
 * @param {object} options
 * @param {import('discord.js').Guild} options.guild
 * @param {object} [options.logger]
 */
export function createDiscordVoiceAdapter({ guild, logger = null }) {
  const player = createAudioPlayer();
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
      connection.on(VoiceConnectionStatus.Disconnected, () => emit('stateChange', 'disconnected'));

      await entersState(connection, VoiceConnectionStatus.Ready, VOICE_READY_TIMEOUT_MS);
      connection.subscribe(player);
      return connection;
    },

    /**
     * @param {import('node:stream').Readable} stream
     * @param {{ inputType?: unknown }} [options] StreamType from play-dl.
     */
    play(stream, options = {}) {
      const resource = createAudioResource(stream, options.inputType ? { inputType: options.inputType } : {});
      player.play(resource);
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
