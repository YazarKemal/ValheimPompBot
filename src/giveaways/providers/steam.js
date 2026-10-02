import { FreeGameProvider, GIVEAWAY_KINDS, isActive, normaliseGiveaway } from '../provider.js';
import { SteamDbFreeSource } from './steamdb/index.js';

/**
 * Steam promotions.
 *
 * The honest situation
 * --------------------
 * Steam has no official discovery endpoint that says "these titles are Free to
 * Keep". The featured-categories feed lists discounts, and a 100% discount
 * there is *usually* a Free Weekend - which does not grant permanent ownership
 * and must not be announced as a giveaway. The feed does not carry the flag
 * that separates the two.
 *
 * So the vendor read is split in two:
 *
 *   SteamDiscoverySource  - "give me raw candidate offers". Replaceable.
 *   classifySteamOffer()  - "is this a giveaway?" Pure, and the only thing that
 *                           decides whether something is announced.
 *
 * The default source cannot distinguish Free to Keep from Free Weekend, so it
 * marks everything `unknown` and `classifySteamOffer` refuses to announce
 * `unknown`. Steam therefore announces nothing until a source that does know is
 * plugged in - which is the correct failure mode for this feature. Announcing a
 * Free Weekend as a giveaway would be worse than staying quiet.
 *
 * To wire in a better source, implement `fetchOffers` and pass it as
 * `source`. Nothing else changes.
 */

export const STEAM_PROVIDER_NAME = 'steam';
export const STEAM_PLATFORM_LABEL = 'Steam';

export const STEAM_FEATURED_URL = 'https://store.steampowered.com/api/featuredcategories?cc=tr&l=tr';

/** What a Steam offer actually is. Only FREE_TO_KEEP is announced. */
export const STEAM_OFFER_KINDS = Object.freeze({
  FREE_TO_KEEP: 'free_to_keep',
  FREE_WEEKEND: 'free_weekend',
  PERMANENTLY_FREE: 'permanently_free',
  DISCOUNT: 'discount',
  UNKNOWN: 'unknown',
});

/**
 * Decides what a raw Steam offer is.
 *
 * Order matters: permanence is checked first so a permanently free title can
 * never be reclassified as a temporary giveaway.
 *
 * @param {object} offer
 * @returns {string} one of STEAM_OFFER_KINDS
 */
export function classifySteamOffer(offer) {
  if (!offer || typeof offer !== 'object') return STEAM_OFFER_KINDS.UNKNOWN;

  // 1. Permanence wins over everything. Steam's appdetails sets `is_free` for
  //    permanently free-to-play titles, which must never be announced.
  if (offer.is_free === true || offer.permanently_free === true) {
    return STEAM_OFFER_KINDS.PERMANENTLY_FREE;
  }

  // 2. An explicit statement of kind is authoritative, and is honoured whether
  //    or not the payload carries price fields at all. A discovery source that
  //    states "Free to Keep" has already done the classification; requiring a
  //    100% discount as well would reject a confirmed giveaway whose source
  //    simply does not publish prices.
  if (offer.promotion_kind === STEAM_OFFER_KINDS.FREE_WEEKEND || offer.free_weekend === true) {
    return STEAM_OFFER_KINDS.FREE_WEEKEND;
  }
  if (offer.promotion_kind === STEAM_OFFER_KINDS.FREE_TO_KEEP || offer.free_to_keep === true) {
    return STEAM_OFFER_KINDS.FREE_TO_KEEP;
  }

  // 3. Price heuristics only ever *downgrade*. A 100% discount with no stated
  //    kind could be either promotion, so it is never promoted to Free to Keep.
  const discount = Number(offer.discount_percent ?? 0);
  const finalPrice = Number(offer.final_price ?? offer.finalPrice ?? Number.NaN);
  const isFreeRightNow = discount >= 100 || finalPrice === 0;

  if (!isFreeRightNow) return discount > 0 ? STEAM_OFFER_KINDS.DISCOUNT : STEAM_OFFER_KINDS.UNKNOWN;
  return STEAM_OFFER_KINDS.UNKNOWN;
}

/** Builds the default source, keeping the transport injectable for tests. */
function createDefaultSteamSource(options) {
  return new SteamDbFreeSource({
    fetchImpl: options.steamDbFetch ?? options.fetchImpl ?? null,
    userAgent: options.userAgent,
    logger: options.logger,
  });
}

/**
 * Alternative discovery source: Steam's own featured categories.
 *
 * Kept because it is the only *official* Steam endpoint, and it demonstrates
 * that the source is genuinely replaceable. It cannot distinguish Free to Keep
 * from Free Weekend, so it announces nothing - see the classification rules
 * above. Prefer it only as a starting point for a better source.
 *
 * Requests exactly one URL and returns candidates for classification. It makes
 * no attempt to enrich each title with a per-app lookup - that would be one
 * request per game and is exactly the kind of hammering this feature avoids.
 */
export class SteamFeaturedSource {
  /** @param {{ url?: string, fetchImpl?: Function }} [options] */
  constructor(options = {}) {
    this.url = options.url ?? STEAM_FEATURED_URL;
    this.fetchImpl = options.fetchImpl ?? null;
  }

  async fetchOffers({ signal } = {}) {
    const doFetch = this.fetchImpl ?? globalThis.fetch;
    const response = await doFetch(this.url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal,
    });

    if (!response?.ok) {
      throw new Error(`Steam featured request failed with status ${response?.status ?? 'unknown'}`);
    }
    return extractFeaturedOffers(await response.json());
  }
}

/** Pulls candidate offers out of the featured-categories payload. */
export function extractFeaturedOffers(payload) {
  const offers = [];
  const groups = payload?.specials?.items ?? payload?.free_items?.items ?? [];
  for (const item of Array.isArray(groups) ? groups : []) {
    // The feed carries no kind flag, so every candidate is explicitly unknown.
    offers.push({ ...item, promotion_kind: STEAM_OFFER_KINDS.UNKNOWN });
  }
  return offers;
}

export class SteamProvider extends FreeGameProvider {
  /**
   * @param {object} [options]
   * @param {{ fetchOffers: Function }} [options.source] Replaceable discovery
   *   source. Defaults to the SteamDB free-promotions reader.
   */
  constructor(options = {}) {
    super({ name: STEAM_PROVIDER_NAME, label: STEAM_PLATFORM_LABEL });
    // Imported lazily to keep this module free of a hard dependency on the
    // SteamDB transport, which tests routinely replace.
    this.source = options.source ?? createDefaultSteamSource(options);
    this.logger = options.logger ?? null;
  }

  async fetchGiveaways({ signal, now = Date.now() } = {}) {
    const offers = await this.source.fetchOffers({ signal });
    return parseSteamGiveaways({ offers }, { now });
  }
}

/**
 * Pure parser: classifies every offer and keeps only Free to Keep.
 *
 * @param {{ offers?: object[] }} source
 * @param {{ now?: number }} [options]
 * @returns {object[]}
 */
export function parseSteamGiveaways(source, { now = Date.now() } = {}) {
  const offers = Array.isArray(source?.offers) ? source.offers : [];
  const giveaways = [];

  for (const offer of offers) {
    if (classifySteamOffer(offer) !== STEAM_OFFER_KINDS.FREE_TO_KEEP) continue;
    const id = offer.id ?? offer.steam_appid ?? offer.appid;
    if (id === undefined || id === null) continue;

    let giveaway;
    try {
      giveaway = normaliseGiveaway({
        provider: STEAM_PROVIDER_NAME,
        id: String(id),
        title: offer.name ?? offer.title,
        platform: STEAM_PLATFORM_LABEL,
        kind: GIVEAWAY_KINDS.FREE_TO_KEEP,
        url: offer.store_url ?? `https://store.steampowered.com/app/${id}`,
        imageUrl: offer.header_image ?? offer.large_capsule_image ?? null,
        originalPrice: steamPrice(offer.original_price, offer.currency),
        currentPrice: steamPrice(offer.final_price, offer.currency),
        startsAt: offer.promotion_start ?? null,
        endsAt: offer.promotion_end ?? null,
        // Carried through so third-party discovery is attributed in the embed.
        source: offer.source ?? null,
      });
    } catch {
      // A malformed entry is skipped, never fatal to the cycle.
      continue;
    }

    if (isActive(giveaway, now)) giveaways.push(giveaway);
  }
  return giveaways;
}

/** Steam prices are already in major units (kuruş are not used). */
function steamPrice(amount, currency) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return null;
  return { amount: value / 100, currency: currency ?? null, formatted: null };
}
