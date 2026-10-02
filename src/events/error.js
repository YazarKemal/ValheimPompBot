import { Events } from 'discord.js';

export const name = Events.Error;
export const once = false;

/**
 * Last-resort handler for gateway/client errors.
 *
 * Logging and swallowing here keeps a transient network error from tearing down
 * the process; genuinely fatal startup errors are handled in `src/index.js`.
 *
 * @param {Error} error
 * @param {{ logger: object }} ctx
 */
export async function execute(error, ctx) {
  ctx.logger.error('Discord client error.', error);
}
