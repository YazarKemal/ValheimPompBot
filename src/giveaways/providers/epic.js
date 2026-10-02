import { FreeGameProvider, GIVEAWAY_KINDS, isActive, normaliseGiveaway } from '../provider.js';

/**
 * Epic Games Store free promotions.
 *
 * Source: the store's public promotions endpoint, the same JSON the storefront
 * itself reads. It is a single request and returns both the current and the
 * upcoming promotions, so one call per cycle is enough.
 *
 * Distinguishing a giveaway from a permanently free game
 * ------------------------------------------------------
 * Epic marks a *temporary* promotion with a `promotionalOffers` entry whose
 * `discountSetting.discountPercentage` is 0 - the price is reduced to nothing
 * for a window. A permanently free-to-play title has no such entry: its price
 * is simply 0. Only the former is a giveaway, and that is the single check this
 * parser uses to decide.
 */

export const EPIC_PROVIDER_NAME = 'epic';
export const EPIC_PLATFORM_LABEL = 'Epic Games';

export const EPIC_PROMOTIONS_URL =
  'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions' +
  '?locale=en-US&country=US&allowCountries=US';

/** Image types in preference order. */
const IMAGE_PREFERENCE = ['OfferImageWide', 'DieselStoreFrontWide', 'Thumbnail', 'OfferImageTall'];

export class EpicProvider extends FreeGameProvider {
  /**
   * @param {object} [options]
   * @param {string} [options.url]
   * @param {Function} [options.fetchImpl] Injected transport (tests only).
   * @param {object} [options.logger]
   */
  constructor(options = {}) {
    super({ name: EPIC_PROVIDER_NAME, label: EPIC_PLATFORM_LABEL });
    this.url = options.url ?? EPIC_PROMOTIONS_URL;
    this.fetchImpl = options.fetchImpl ?? null;
    this.logger = options.logger ?? null;
  }

  async fetchGiveaways({ signal, now = Date.now() } = {}) {
    const doFetch = this.fetchImpl ?? globalThis.fetch;
    const response = await doFetch(this.url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal,
    });

    if (!response?.ok) {
      throw new Error(`Epic promotions request failed with status ${response?.status ?? 'unknown'}`);
    }

    const payload = await response.json();
    return parseEpicGiveaways(payload, { now });
  }
}

/**
 * Pure parser. Exported so the promotion rules can be tested against fixtures
 * without a network call.
 *
 * @param {object} payload
 * @param {{ now?: number }} [options]
 * @returns {object[]}
 */
export function parseEpicGiveaways(payload, { now = Date.now() } = {}) {
  const elements = payload?.data?.Catalog?.searchStore?.elements;
  if (!Array.isArray(elements)) return [];

  const giveaways = [];
  for (const element of elements) {
    const offer = currentFreeOffer(element);
    if (!offer) continue; // not a temporary promotion

    let giveaway;
    try {
      giveaway = normaliseGiveaway({
        provider: EPIC_PROVIDER_NAME,
        id: element.id,
        title: element.title,
        platform: EPIC_PLATFORM_LABEL,
        kind: GIVEAWAY_KINDS.EPIC_GIVEAWAY,
        url: epicStoreUrl(element),
        imageUrl: pickImage(element.keyImages),
        originalPrice: epicPrice(element.price?.totalPrice, 'originalPrice'),
        currentPrice: epicPrice(element.price?.totalPrice, 'discountPrice'),
        startsAt: offer.startDate,
        endsAt: offer.endDate,
      });
    } catch {
      // One unusable entry in the feed must not cost us the whole cycle, so it
      // is skipped rather than allowed to propagate.
      continue;
    }

    // Belt and braces: a promotion whose window has already closed is not
    // announced, even if the store still lists it.
    if (isActive(giveaway, now)) giveaways.push(giveaway);
  }
  return giveaways;
}

/**
 * Returns the currently running zero-price promotion, or null.
 *
 * Upcoming promotions are deliberately ignored: they are announced when their
 * window opens, not before.
 */
function currentFreeOffer(element) {
  const groups = element?.promotions?.promotionalOffers;
  if (!Array.isArray(groups)) return null;

  for (const group of groups) {
    const offers = group?.promotionalOffers;
    if (!Array.isArray(offers)) continue;
    for (const offer of offers) {
      // discountPercentage 0 is what makes it a giveaway rather than a discount.
      if (offer?.discountSetting?.discountPercentage === 0) return offer;
    }
  }
  return null;
}

function epicStoreUrl(element) {
  const slug =
    element?.offerMappings?.[0]?.pageSlug ??
    element?.catalogNs?.mappings?.[0]?.pageSlug ??
    element?.productSlug ??
    null;
  if (!slug) return null;
  // Slugs occasionally carry a trailing "/home" that is not part of the URL.
  return `https://store.epicgames.com/en-US/p/${String(slug).replace(/\/home$/, '')}`;
}

function pickImage(keyImages) {
  if (!Array.isArray(keyImages)) return null;
  for (const type of IMAGE_PREFERENCE) {
    const match = keyImages.find((image) => image?.type === type && image?.url);
    if (match) return match.url;
  }
  return keyImages.find((image) => image?.url)?.url ?? null;
}

/**
 * Prices arrive as minor units (kuruş/cent). `fmtPrice` is already formatted by
 * the store, so it is preferred when present; the numeric value is the fallback.
 */
function epicPrice(totalPrice, field) {
  if (!totalPrice) return null;
  const amount = totalPrice[field];
  const formatted = totalPrice.fmtPrice?.[field] ?? null;
  if (!Number.isFinite(amount) && !formatted) return null;

  return {
    amount: Number.isFinite(amount) ? amount / 100 : null,
    currency: totalPrice.currencyCode ?? null,
    formatted,
  };
}
