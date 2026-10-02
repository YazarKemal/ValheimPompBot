import { Events } from 'discord.js';
import { handleMusicRequest, shouldHandle } from '../music/listener.js';

export const name = Events.MessageCreate;
export const once = false;

/**
 * Plain-text music requests.
 *
 * This is the only place in the bot that reads message content, and it is the
 * reason the privileged **Message Content** intent must be enabled in the
 * Developer Portal. Without it Discord delivers empty `content` and every
 * request silently does nothing.
 *
 * The channel gate runs first and fails closed: a message outside
 * `MUSIC_TEXT_CHANNEL` is dropped before anything else looks at it. Someone
 * mentioning a band in #genel must never start playback.
 *
 * No AI is involved: a song name is a search query.
 *
 * @param {import('discord.js').Message} message
 * @param {{ music?: object, fun?: object, config?: object, logger: object }} ctx
 */
export async function execute(message, ctx) {
  // Activity XP runs FIRST and on its own, because it is the one thing here
  // that works without the privileged intent: it counts that a message
  // happened and never looks at what it said. It must therefore not sit behind
  // a music check that cannot pass on PompAI.
  //
  // A failure must not reach the gateway: XP is the least important thing in
  // the process.
  try {
    ctx.fun?.handleMessage(message);
  } catch (error) {
    ctx.logger.warn('Activity XP failed.', { reason: error?.message, code: error?.code ?? null });
  }

  const service = ctx.music;
  if (!service) return;

  const settings = ctx.config?.music ?? {};
  if (!settings.enabled) return;

  if (
    !shouldHandle(message, {
      musicChannelName: settings.textChannel,
      musicChannelId: service.musicChannelId ?? null,
    })
  ) {
    return;
  }

  try {
    await handleMusicRequest(message, service.listenerDeps());
  } catch (error) {
    // A failed request must never take the gateway connection down.
    ctx.logger.error('Music request failed.', error);
  }
}
