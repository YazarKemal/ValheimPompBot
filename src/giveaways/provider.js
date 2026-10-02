import { BotError } from '../utils/errors.js';

/**
 * Free-game provider interface.
 *
 * A provider knows how to read ONE store and return a list of normalised
 * giveaways. Everything downstream - deduplication, storage, embeds, polling -
 * works against the normalised shape and never against a vendor payload, so a
 * source can be replaced without touching any of it.
 *
 * Contract:
 *   name            string, stable id used in the dedup key
 *   label           human-readable platform name for the embed
 *   fetchGiveaways({ signal, now }) -> Giveaway[]
 *
 * A provider must only ever return *temporary* giveaways. Permanently
 * free-to-play titles are not giveaways and must be filtered out inside the
 * provider, where the vendor's own signals are available.
 */

/** Giveaway kinds, in the order they are trusted. */
export const GIVEAWAY_KINDS = Object.freeze({
  /** Epic's weekly free promotion. */
  EPIC_GIVEAWAY: 'epic_giveaway',
  /** Steam's "Free to Keep" - permanently added to the account. */
  FREE_TO_KEEP: 'free_to_keep',
});

/** Human-readable labels for the embed. */
export const KIND_LABELS = Object.freeze({
  [GIVEAWAY_KINDS.EPIC_GIVEAWAY]: 'Epic Giveaway',
  [GIVEAWAY_KINDS.FREE_TO_KEEP]: 'Free to Keep',
});

/** Kinds that may be announced. Anything else is dropped. */
export const ANNOUNCED_KINDS = Object.freeze(Object.values(GIVEAWAY_KINDS));

/**
 * The dedup key. Provider + the store's own stable product id, so two stores
 * giving away the same game are two separate announcements, and the same store
 * giving it away again later is a new one only after the old entry is pruned.
 */
export function giveawayKey(provider, id) {
  return `${provider}:${id}`;
}

/**
 * Validates and freezes a normalised giveaway.
 *
 * @param {object} raw
 * @returns {object}
 */
export function normaliseGiveaway(raw) {
  const provider = String(raw?.provider ?? '').trim();
  const id = String(raw?.id ?? '').trim();
  const title = String(raw?.title ?? '').trim();

  if (!provider) throw new BotError('A giveaway requires a provider.', { code: 'GIVEAWAY_INVALID' });
  if (!id) throw new BotError('A giveaway requires a stable id.', { code: 'GIVEAWAY_INVALID' });
  if (!title) throw new BotError('A giveaway requires a title.', { code: 'GIVEAWAY_INVALID' });
  if (!ANNOUNCED_KINDS.includes(raw?.kind)) {
    throw new BotError(`Unsupported giveaway kind "${raw?.kind}".`, { code: 'GIVEAWAY_INVALID' });
  }

  return Object.freeze({
    key: giveawayKey(provider, id),
    provider,
    id,
    title,
    platform: String(raw.platform ?? provider),
    kind: raw.kind,
    url: raw.url ? String(raw.url) : null,
    imageUrl: raw.imageUrl ? String(raw.imageUrl) : null,
    originalPrice: normalisePrice(raw.originalPrice),
    currentPrice: normalisePrice(raw.currentPrice),
    startsAt: toIso(raw.startsAt),
    endsAt: toIso(raw.endsAt),
    // Attribution for data we did not originate (e.g. IsThereAnyDeal). Null for
    // sources we read directly, so no embed claims a partner it does not have.
    source: raw.source ? String(raw.source) : null,
    discoveredAt: toIso(raw.discoveredAt) ?? new Date().toISOString(),
  });
}

function normalisePrice(price) {
  if (!price) return null;
  const amount = Number(price.amount);
  if (!Number.isFinite(amount)) return null;
  return {
    amount,
    currency: price.currency ? String(price.currency) : null,
    formatted: price.formatted ? String(price.formatted) : null,
  };
}

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * True when the giveaway is still running at `now`.
 *
 * A giveaway with no end date is treated as active: refusing to show it would
 * hide a real offer, and the dedup store still prevents repeat announcements.
 *
 * @param {object} giveaway
 * @param {number} now
 */
export function isActive(giveaway, now = Date.now()) {
  if (giveaway.startsAt && new Date(giveaway.startsAt).getTime() > now) return false;
  if (giveaway.endsAt && new Date(giveaway.endsAt).getTime() <= now) return false;
  return true;
}

/** Base class. Providers override `fetchGiveaways`. */
export class FreeGameProvider {
  /** @param {{ name: string, label: string }} options */
  constructor({ name, label }) {
    this.name = name;
    this.label = label;
  }

  /**
   * @param {{ signal?: AbortSignal, now?: number }} [options]
   * @returns {Promise<object[]>}
   */
  // eslint-disable-next-line no-unused-vars -- interface method
  async fetchGiveaways(options = {}) {
    throw new BotError(`Provider "${this.name}" does not implement fetchGiveaways().`, {
      code: 'GIVEAWAY_PROVIDER_UNIMPLEMENTED',
    });
  }
}
