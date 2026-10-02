import { createNullLogger } from '../utils/logger.js';
import { isActive } from './provider.js';

/**
 * Giveaway monitor.
 *
 * Properties this module is responsible for:
 *
 *   - ZERO AI. No provider, no model, no API key. The monitor is constructed
 *     without any AI client, so a paid call during polling is not merely
 *     avoided by discipline - it is impossible to express.
 *   - No overlapping cycles. A cycle in flight makes any concurrent call a
 *     no-op, so a slow provider can never stack requests on top of itself.
 *   - Per-provider failure isolation. One store being down yields an empty list
 *     and a log line; the other store and the bot keep working.
 *   - Bounded requests. Every provider call is wrapped in an AbortController
 *     timeout.
 *   - No retries. A failed cycle waits for the next interval rather than
 *     hammering the store.
 */

export const DEFAULT_INTERVAL_MINUTES = 30;
export const DEFAULT_TIMEOUT_MS = 15000;

/** Never poll faster than this, whatever the configuration says. */
export const MIN_INTERVAL_MINUTES = 15;

/**
 * @param {object} options
 * @param {Array<{name: string, label: string, fetchGiveaways: Function}>} options.providers
 * @param {object|null} [options.store] Persistent announced-state. Omit to disable dedup.
 * @param {{announce: (giveaway: object) => Promise<boolean>}} [options.notifier]
 * @param {object} [options.logger]
 * @param {number} [options.intervalMinutes]
 * @param {number} [options.timeoutMs]
 * @param {() => number} [options.now]
 */
export function createGiveawayMonitor({
  providers = [],
  store = null,
  notifier = null,
  logger = createNullLogger(),
  intervalMinutes = DEFAULT_INTERVAL_MINUTES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => Date.now(),
} = {}) {
  let inFlight = false;
  let inFlightPromise = null;
  let timer = null;
  let lastRunAt = null;
  let lastError = null;

  /**
   * Queries every provider once. No state is written and nothing is announced,
   * which is what makes this safe for an on-demand command to call.
   *
   * @returns {Promise<{giveaways: object[], failures: object[]}>}
   */
  async function fetchActive() {
    const giveaways = [];
    const failures = [];
    const seen = new Set();

    await Promise.all(
      providers.map(async (provider) => {
        const controller = new AbortController();
        const timerHandle = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const found = await provider.fetchGiveaways({ signal: controller.signal, now: now() });
          for (const giveaway of Array.isArray(found) ? found : []) {
            // Two providers could theoretically surface the same key; and a
            // provider could repeat itself. Neither should double-count.
            if (seen.has(giveaway.key)) continue;
            seen.add(giveaway.key);
            if (isActive(giveaway, now())) giveaways.push(giveaway);
          }
        } catch (error) {
          // One store failing must never take the cycle down.
          const reason = error?.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : error?.message;
          failures.push({ provider: provider.name, reason: String(reason ?? 'unknown error') });
          logger.warn(`Free game provider "${provider.name}" failed.`, { reason: String(reason ?? 'unknown error') });
        } finally {
          clearTimeout(timerHandle);
        }
      }),
    );

    giveaways.sort((a, b) => a.title.localeCompare(b.title));
    return { giveaways, failures };
  }

  /**
   * One full cycle: fetch, deduplicate against the store, announce what is new,
   * then prune.
   *
   * @returns {Promise<{skipped: boolean, announced: object[], failures: object[], active: number}>}
   */
  async function checkNow({ reason = 'interval' } = {}) {
    // Overlap guard. Returning early is correct: the running cycle will pick
    // up anything this call would have found.
    if (inFlight) {
      logger.debug('Giveaway cycle already running; skipping.', { reason });
      return { skipped: true, announced: [], failures: [], active: 0 };
    }

    inFlight = true;
    const cycle = runCycle({ reason });
    inFlightPromise = cycle;
    try {
      return await cycle;
    } finally {
      inFlight = false;
      inFlightPromise = null;
    }
  }

  async function runCycle({ reason }) {
    await store?.load?.().catch(() => {});

    const { giveaways, failures } = await fetchActive();
    lastRunAt = now();

    const fresh = giveaways.filter((giveaway) => !store?.has?.(giveaway.key));

    const announced = [];
    for (const giveaway of fresh) {
      try {
        const posted = notifier ? await notifier.announce(giveaway) : false;
        // Recorded even when no notifier is wired up, so that a restart
        // between discovering and posting cannot re-announce it. A notifier
        // that *throws* skips this line on purpose: the record is written only
        // once the post succeeded, so a transient channel failure is retried
        // on the next cycle instead of losing the announcement silently.
        await store?.markAnnounced?.(giveaway);
        if (posted) announced.push(giveaway);
      } catch (error) {
        logger.warn('Failed to announce a giveaway; it will be retried.', {
          key: giveaway.key,
          reason: error?.message,
        });
      }
    }

    const pruned = (await store?.prune?.()) ?? 0;
    lastError = failures.length > 0 ? failures : null;

    logger.info('Giveaway cycle finished.', {
      reason,
      active: giveaways.length,
      announced: announced.length,
      pruned,
      failures: failures.length,
    });

    return { skipped: false, announced, failures, active: giveaways.length };
  }

  /**
   * Runs an immediate cycle, then one every interval.
   *
   * `unref` keeps the timer from holding the process open on its own; the
   * Discord client is what keeps the bot alive.
   */
  function start() {
    if (timer) return false;

    void checkNow({ reason: 'startup' });

    const effectiveMinutes = Math.max(MIN_INTERVAL_MINUTES, intervalMinutes);
    timer = setInterval(() => {
      void checkNow({ reason: 'interval' });
    }, effectiveMinutes * 60 * 1000);
    timer.unref?.();

    logger.info('Free game monitor started.', { intervalMinutes: effectiveMinutes, providers: providers.map((p) => p.name) });
    return true;
  }

  function stop() {
    if (!timer) return false;
    clearInterval(timer);
    timer = null;
    logger.info('Free game monitor stopped.');
    return true;
  }

  return {
    fetchActive,
    checkNow,
    start,
    stop,
    isRunning: () => timer !== null,
    isCycleInFlight: () => inFlight,
    /**
     * Resolves when the current cycle finishes, or immediately when idle.
     * Used by tests, and by shutdown to avoid cutting a cycle in half.
     */
    whenIdle: () => inFlightPromise ?? Promise.resolve(),
    status: () => ({
      running: timer !== null,
      inFlight,
      intervalMinutes: Math.max(MIN_INTERVAL_MINUTES, intervalMinutes),
      providers: providers.map((provider) => provider.name),
      lastRunAt: lastRunAt ? new Date(lastRunAt).toISOString() : null,
      lastError,
      announcedKeys: store?.size ?? 0,
    }),
  };
}
