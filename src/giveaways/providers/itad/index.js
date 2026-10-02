import { BotError } from '../../../utils/errors.js';
import { classifyItadResponse } from './classify.js';

/**
 * IsThereAnyDeal giveaway source.
 *
 * ITAD's documented, authenticated HTTP API - not a scrape. One GET per cycle,
 * no concurrency, no retries inside a cycle, and a caller-supplied AbortSignal
 * carries the existing FREE_GAMES_TIMEOUT_MS.
 *
 * The API key travels only in the `ITAD-API-Key` header. It is never placed in
 * a URL, a message, a log line or an error: every diagnostic below is built
 * from the status code and the rejection reasons only.
 */

export const ITAD_GIVEAWAYS_URL = 'https://api.isthereanydeal.com/giveaways/v1';
export const ITAD_API_KEY_HEADER = 'ITAD-API-Key';
export const DEFAULT_ITAD_TIMEOUT_MS = 15000;
export const ITAD_PROVIDER_NAME = 'steam';

/** ITAD caps `limit` at 50 per request. */
export const ITAD_MAX_LIMIT = 50;

/** The source was refused because the key is missing, wrong or unauthorised. */
export class ItadAuthError extends BotError {
  constructor(message, { status = null, ...rest } = {}) {
    super(message, { code: 'ITAD_AUTH_ERROR', details: { status }, ...rest });
    this.status = status;
  }
}

/** The source is rate limiting us, or is unhealthy. */
export class ItadUnavailableError extends BotError {
  constructor(message, { status = null, ...rest } = {}) {
    super(message, { code: 'ITAD_UNAVAILABLE', details: { status }, ...rest });
    this.status = status;
  }
}

export { classifyItadGiveaway, classifyItadResponse, ITAD_SOURCE_LABEL } from './classify.js';

export class ItadGiveawaySource {
  /**
   * @param {object} [options]
   * @param {string|null} [options.apiKey]
   * @param {string} [options.url]
   * @param {Function} [options.fetchImpl] Injected transport (tests only).
   * @param {number} [options.timeoutMs]
   * @param {number} [options.limit]
   * @param {object} [options.logger]
   */
  constructor(options = {}) {
    this.apiKey = options.apiKey ?? null;
    this.url = options.url ?? ITAD_GIVEAWAYS_URL;
    this.fetchImpl = options.fetchImpl ?? null;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_ITAD_TIMEOUT_MS;
    this.limit = Math.min(options.limit ?? ITAD_MAX_LIMIT, ITAD_MAX_LIMIT);
    this.logger = options.logger ?? null;
  }

  /** Whether the source can run at all. */
  isConfigured() {
    return typeof this.apiKey === 'string' && this.apiKey.trim() !== '';
  }

  /**
   * @param {{ signal?: AbortSignal, now?: number }} [options]
   * @returns {Promise<object[]>} discovery offers; empty when nothing qualifies
   */
  async fetchOffers({ signal, now = Date.now() } = {}) {
    if (!this.isConfigured()) {
      // A configuration error, not a runtime failure: no request is made.
      throw new ItadAuthError(
        'IsThereAnyDeal is not configured: ITAD_API_KEY is not set. ' +
          'Steam giveaways stay disabled until a key is provided.',
        { status: null },
      );
    }

    const doFetch = this.fetchImpl ?? globalThis.fetch;
    if (typeof doFetch !== 'function') {
      throw new BotError('No fetch implementation is available for the ITAD source.', {
        code: 'ITAD_NO_TRANSPORT',
      });
    }

    // `expired=false` is ITAD's default, but it is sent explicitly so the
    // contract is visible rather than implied.
    const requestUrl = `${this.url}?expired=false&limit=${this.limit}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;

    let response;
    try {
      response = await doFetch(requestUrl, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          // The only place the key appears. Never logged, never in the URL.
          [ITAD_API_KEY_HEADER]: this.apiKey,
        },
        redirect: 'follow',
        signal: combined,
      });
    } catch (error) {
      if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
        throw new ItadUnavailableError(`IsThereAnyDeal did not answer within ${this.timeoutMs}ms.`);
      }
      throw new ItadUnavailableError(
        `IsThereAnyDeal request failed: ${scrub(error?.message) ?? 'unknown error'}`,
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response?.ok) {
      throw this.#errorForStatus(response?.status ?? null);
    }

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new ItadUnavailableError('IsThereAnyDeal returned a body that is not JSON.', { cause: error });
    }

    const { offers, rejected, total } = classifyItadResponse(payload, { now });

    // Rejection reasons are aggregated, never per-entry detail, and carry no
    // user data. This is what makes a "no Steam giveaways" cycle explainable.
    if (rejected.length > 0) {
      const counts = {};
      for (const entry of rejected) counts[entry.reason] = (counts[entry.reason] ?? 0) + 1;
      this.logger?.debug?.('ITAD entries rejected.', { total, counts, accepted: offers.length });
    }

    return offers;
  }

  /**
   * Maps a status onto the error contract the monitor understands.
   *
   * 401/403 - the provider is unusable this cycle and is skipped; the message
   *           names the setting but never the value.
   * 429     - rate limited; the cycle gives up and waits for the next interval.
   * 5xx     - the source is unhealthy; fail closed.
   */
  #errorForStatus(status) {
    if (status === 401 || status === 403) {
      return new ItadAuthError(
        `IsThereAnyDeal rejected the configured credentials (HTTP ${status}). ` +
          'Check that ITAD_API_KEY is valid. Steam giveaways are disabled for this cycle.',
        { status },
      );
    }
    if (status === 429) {
      return new ItadUnavailableError(
        'IsThereAnyDeal is rate limiting this client (HTTP 429). Waiting until the next interval.',
        { status },
      );
    }
    return new ItadUnavailableError(`IsThereAnyDeal returned HTTP ${status}.`, { status });
  }
}

/** Removes anything key-shaped from a message before it reaches a log. */
function scrub(message) {
  if (typeof message !== 'string') return null;
  return message.replace(/[A-Za-z0-9_-]{20,}/g, '[redacted]');
}
