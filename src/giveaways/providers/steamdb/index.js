import { BotError } from '../../../utils/errors.js';
import { analyseSteamDbHtml } from './parse.js';

/**
 * SteamDB free-promotions discovery source.
 *
 * Implements the `SteamDiscoverySource` contract: fetch a page, return raw
 * offers for `classifySteamOffer` to judge. It never decides anything itself.
 *
 * Boundaries this module holds to
 * ------------------------------
 *   - Plain HTTPS GET with a descriptive User-Agent. No headless browser, no
 *     cookie or challenge solving, no proxy rotation, no attempt to look like a
 *     browser beyond the honest identification below.
 *   - One request per call, no concurrency, redirects followed by the platform.
 *   - A caller-supplied AbortSignal carries the configured timeout.
 *   - SteamDB is treated strictly as a *discovery* source. Redemption links are
 *     rebuilt against store.steampowered.com in the parser.
 *   - If the response is a block, a rate limit or a server error, this fails
 *     closed: the cycle gets an error, announces nothing, and the monitor
 *     retries at the next normal interval. It is never retried in a loop.
 *
 * SteamDB is protected by a bot challenge. A plain client will normally be
 * served HTTP 403, which is reported as `SteamDbBlockedError` rather than
 * worked around.
 */

export const STEAMDB_FREE_URL = 'https://steamdb.info/upcoming/free/';

/** Descriptive, honest identification. Override with FREE_GAMES_USER_AGENT. */
export const DEFAULT_USER_AGENT =
  'PompAI/1.0 (Discord free-game alert bot; read-only; respects robots.txt)';

/** SteamDB is a third-party site; never poll it faster than this. */
export const MIN_STEAMDB_INTERVAL_MINUTES = 30;

export const STEAMDB_TIMEOUT_MS = 20000;

/** Thrown when SteamDB refuses the request rather than when it returns a page. */
export class SteamDbBlockedError extends BotError {
  constructor(message, { status = null, ...rest } = {}) {
    super(message, { code: 'STEAMDB_BLOCKED', details: { status }, ...rest });
    this.status = status;
  }
}

export { analyseSteamDbHtml, parseSteamDbFree, FREE_TO_KEEP_LABEL, REJECT_LABELS } from './parse.js';

export class SteamDbFreeSource {
  /**
   * @param {object} [options]
   * @param {string} [options.url]
   * @param {Function} [options.fetchImpl] Injected transport (tests only).
   * @param {string} [options.userAgent]
   * @param {number} [options.timeoutMs]
   * @param {object} [options.logger]
   */
  constructor(options = {}) {
    this.url = options.url ?? STEAMDB_FREE_URL;
    this.fetchImpl = options.fetchImpl ?? null;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.timeoutMs = options.timeoutMs ?? STEAMDB_TIMEOUT_MS;
    this.logger = options.logger ?? null;
  }

  /**
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<object[]>} raw offers; empty when the page is unreadable
   */
  async fetchOffers({ signal } = {}) {
    const doFetch = this.fetchImpl ?? globalThis.fetch;
    if (typeof doFetch !== 'function') {
      throw new BotError('No fetch implementation is available for the SteamDB source.', {
        code: 'STEAMDB_NO_TRANSPORT',
      });
    }

    // The monitor's timeout is authoritative; this is a backstop if a caller
    // invokes the source directly.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;

    let response;
    try {
      response = await doFetch(this.url, {
        method: 'GET',
        headers: {
          'user-agent': this.userAgent,
          accept: 'text/html,application/xhtml+xml',
          'accept-language': 'en-US,en;q=0.9',
        },
        redirect: 'follow',
        signal: combined,
      });
    } catch (error) {
      if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
        throw new BotError(`SteamDB did not answer within ${this.timeoutMs}ms.`, {
          code: 'STEAMDB_TIMEOUT',
          cause: error,
        });
      }
      throw new BotError(`SteamDB request failed: ${error?.message ?? 'unknown error'}`, {
        code: 'STEAMDB_REQUEST_FAILED',
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response?.ok) {
      const status = response?.status ?? null;
      // 403/429/5xx all land here. The brief forbids working around this.
      throw new SteamDbBlockedError(
        `SteamDB refused the request (HTTP ${status ?? 'unknown'}). ` +
          'No bypass is attempted; the cycle will retry at the next interval.',
        { status },
      );
    }

    const html = await response.text();
    const analysis = analyseSteamDbHtml(html);

    if (analysis.blocked) {
      throw new SteamDbBlockedError('SteamDB served a bot challenge instead of the promotions table.');
    }
    for (const warning of analysis.warnings) {
      this.logger?.debug?.('SteamDB parse warning.', { warning });
    }
    this.logger?.debug?.('SteamDB page parsed.', {
      rows: analysis.rows,
      accepted: analysis.accepted,
      rejected: analysis.rejected,
    });

    // An empty list is a valid, safe answer: no confirmed Free to Keep offer.
    return analysis.offers;
  }
}
