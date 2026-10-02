/**
 * Blueprint primitives shared by every server definition.
 *
 * This module deliberately imports nothing. Blueprint files import it, and the
 * blueprint registry imports them, so keeping constants at a leaf avoids an
 * import cycle that would break module evaluation order.
 */

export const BLUEPRINT_VERSION = 1;

/** Special overwrite target representing the guild's built-in @everyone role. */
export const EVERYONE = '@everyone';

/**
 * Blueprint used when none is named. The server is being repurposed around
 * MiningFools, so that is the default; the Valheim definition is still available
 * by name.
 */
export const DEFAULT_BLUEPRINT = 'miningfools';
