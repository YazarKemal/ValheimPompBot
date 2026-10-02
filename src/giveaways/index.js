import path from 'node:path';
import { createNullLogger } from '../utils/logger.js';
import { PROJECT_ROOT } from '../config/index.js';
import { EpicProvider } from './providers/epic.js';
import { SteamProvider } from './providers/steam.js';
import { MIN_STEAMDB_INTERVAL_MINUTES, SteamDbFreeSource } from './providers/steamdb/index.js';
import { ItadGiveawaySource } from './providers/itad/index.js';
import { GiveawayStore } from './store.js';
import { createGiveawayMonitor } from './monitor.js';

/**
 * Free game alerts.
 *
 * Everything here is HTTP-only. There is no AI client anywhere in this module
 * tree, which is what guarantees that polling costs nothing.
 */

export { GIVEAWAY_KINDS, KIND_LABELS, normaliseGiveaway, giveawayKey, isActive, FreeGameProvider } from './provider.js';
export { EpicProvider, parseEpicGiveaways, EPIC_PROMOTIONS_URL } from './providers/epic.js';
export {
  SteamProvider,
  SteamFeaturedSource,
  parseSteamGiveaways,
  classifySteamOffer,
  STEAM_OFFER_KINDS,
} from './providers/steam.js';
export {
  ItadGiveawaySource,
  ItadAuthError,
  ItadUnavailableError,
  classifyItadGiveaway,
  classifyItadResponse,
  ITAD_GIVEAWAYS_URL,
  ITAD_SOURCE_LABEL,
} from './providers/itad/index.js';
export {
  SteamDbFreeSource,
  SteamDbBlockedError,
  parseSteamDbFree,
  analyseSteamDbHtml,
  STEAMDB_FREE_URL,
  MIN_STEAMDB_INTERVAL_MINUTES,
} from './providers/steamdb/index.js';
export { GiveawayStore } from './store.js';
export { createGiveawayMonitor, MIN_INTERVAL_MINUTES } from './monitor.js';
export { buildGiveawayEmbed } from './embed.js';
export { formatDateTime, formatPrice, formatRemaining } from './format.js';

/** Default location of the announced-state file. */
export const DEFAULT_STATE_FILE = path.join(PROJECT_ROOT, 'data', 'giveaways.json');

/**
 * Builds the provider list from configuration.
 *
 * Providers are constructed even when the monitor is disabled, so `/ucretsiz`
 * works on demand regardless of whether background polling is on.
 *
 * @param {object} [options]
 * @param {object} [options.logger]
 * @param {Function} [options.epicFetch] Injected transport (tests only).
 * @param {Function} [options.steamFetch] Injected transport (tests only).
 */
export function createGiveawayProviders({
  logger = createNullLogger(),
  epicFetch = null,
  steamDbFetch = null,
  itadFetch = null,
  userAgent = null,
  steamSource = 'itad',
  itadApiKey = null,
  itadTimeoutMs = undefined,
} = {}) {
  const providers = [new EpicProvider({ logger, fetchImpl: epicFetch })];

  const steam = createSteamProvider({
    logger,
    steamSource,
    itadApiKey,
    itadFetch,
    steamDbFetch,
    userAgent,
    itadTimeoutMs,
  });
  if (steam) providers.push(steam);

  return providers;
}

/**
 * Builds the Steam provider for the configured source.
 *
 * Returns null when the source cannot run, so the provider is simply absent
 * rather than failing every cycle. That is what keeps `/ucretsiz` honest: an
 * unconfigured Steam source is not an outage, and must not be reported as one.
 *
 * @returns {SteamProvider|null}
 */
export function createSteamProvider({
  logger = createNullLogger(),
  steamSource = 'itad',
  itadApiKey = null,
  itadFetch = null,
  steamDbFetch = null,
  userAgent = null,
  itadTimeoutMs = undefined,
} = {}) {
  if (steamSource === 'none') {
    logger.info('Steam giveaway discovery is disabled (STEAM_GIVEAWAY_SOURCE=none).');
    return null;
  }

  if (steamSource === 'steamdb') {
    // Opt-in only. SteamDB sits behind a Cloudflare challenge that must not be
    // bypassed, so this normally yields nothing. Kept for debugging.
    logger.warn('Steam giveaway discovery uses SteamDB, which is normally blocked by Cloudflare.');
    return new SteamProvider({
      logger,
      source: new SteamDbFreeSource({ fetchImpl: steamDbFetch, userAgent, logger }),
    });
  }

  const source = new ItadGiveawaySource({ apiKey: itadApiKey, fetchImpl: itadFetch, timeoutMs: itadTimeoutMs, logger });
  if (!source.isConfigured()) {
    logger.warn(
      'Steam giveaways are disabled: ITAD_API_KEY is not set. ' +
        'Set it to enable IsThereAnyDeal discovery, or set STEAM_GIVEAWAY_SOURCE=none to silence this.',
    );
    return null;
  }

  logger.info('Steam giveaway discovery uses IsThereAnyDeal.');
  return new SteamProvider({ logger, source });
}

/**
 * Wires the monitor together from configuration.
 *
 * @param {object} options
 * @param {object} options.config Parsed application config.
 * @param {{announce: Function}|null} [options.notifier]
 * @param {object} [options.logger]
 * @param {Array<object>} [options.providers]
 * @param {string} [options.stateFile]
 */
export function createGiveawayMonitorFromConfig({
  config,
  notifier = null,
  logger = createNullLogger(),
  providers = null,
  stateFile = null,
} = {}) {
  const settings = config?.giveaways ?? {};

  const store = new GiveawayStore({
    filePath: stateFile ?? settings.stateFile ?? DEFAULT_STATE_FILE,
    retentionDays: settings.retentionDays,
  });

  if (settings.enabled && settings.steamSource === 'steamdb' && (settings.intervalMinutes ?? 30) < MIN_STEAMDB_INTERVAL_MINUTES) {
    // Not enforced: SteamDB is one of two sources, and the interval floor is
    // already 15 minutes. But polling a third-party site every 15 minutes is
    // inconsiderate, so it is called out.
    logger.warn('A free-game interval below 30 minutes is not advised for the SteamDB source.', {
      configured: settings.intervalMinutes,
      recommended: MIN_STEAMDB_INTERVAL_MINUTES,
    });
  }

  return createGiveawayMonitor({
    providers:
      providers ??
      createGiveawayProviders({
        logger,
        userAgent: settings.userAgent,
        steamSource: settings.steamSource,
        itadApiKey: settings.itadApiKey,
        itadTimeoutMs: settings.timeoutMs,
      }),
    store,
    notifier,
    logger,
    intervalMinutes: settings.intervalMinutes,
    timeoutMs: settings.timeoutMs,
  });
}
