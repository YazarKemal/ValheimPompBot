/**
 * IsThereAnyDeal giveaway classification.
 *
 * Pure functions over one ITAD giveaway entry. The whole accept/reject policy
 * lives here so it can be tested exhaustively against fixtures, and so a change
 * to the policy is a reviewable diff rather than a tweak buried in transport.
 *
 * The governing rule is FAIL CLOSED. ITAD aggregates giveaways from many shops
 * and many kinds of promotion, so anything that is not unambiguously a direct
 * Steam acquire-to-keep giveaway is rejected. A missed giveaway costs nothing;
 * announcing a Free Weekend as free-to-keep is a lie told to the whole server.
 *
 * Schema reference (ITAD OpenAPI, `obj.giveaway`):
 *   { id, title, shop: {id,name}|null, url, details, isMature,
 *     publish, expiry|null, note|null, games: [{ id, slug, title,
 *     type: 'game'|'dlc'|'package'|null, assets: {banner600, boxart, ...},
 *     keys: [{id,name}], platforms: [...] }] }
 */

export const ITAD_SOURCE_LABEL = 'IsThereAnyDeal';
export const STEAM_SHOP_NAME = 'Steam';

/** Why an entry was rejected. Stable codes, used in logs and tests. */
export const REJECTION = Object.freeze({
  NOT_ACTIVE: 'not-active',
  EXPIRED: 'expired',
  MISSING_SHOP: 'missing-shop',
  NOT_STEAM: 'not-steam',
  NO_FULL_GAME: 'no-full-game',
  TEMPORARY_ACCESS: 'temporary-access',
  PERMANENTLY_FREE: 'permanently-free',
  AMBIGUOUS: 'ambiguous',
  MALFORMED: 'malformed',
});

/**
 * Wording that means temporary *access* rather than ownership.
 *
 * These are checked against the title, the note and every game title/slug. A
 * game whose own title contains one of these words is rejected too - a false
 * negative is the safe direction.
 */
export const TEMPORARY_ACCESS_PATTERNS = Object.freeze([
  /\bfree\s+weekend\b/i,
  /\bplay\s+for\s+free\b/i,
  /\bweekend\s+trial\b/i,
  /\bfree\s+trial\b/i,
  /\btrial\b/i,
  /\bdemo\b/i,
  /\bbeta\b/i,
  /\bplaytest\b/i,
  /\bearly\s+access\s+weekend\b/i,
]);

/**
 * Wording that suggests the title is free to play all the time, which is not a
 * giveaway. Overridden only by an explicit keep signal below.
 */
export const PERMANENTLY_FREE_PATTERNS = Object.freeze([
  /\bfree\s+to\s+play\b/i,
  /\bfree-to-play\b/i,
  /\bf2p\b/i,
  /\balways\s+free\b/i,
  /\bpermanently\s+free\b/i,
]);

/**
 * Explicit statements that the recipient *keeps* the game.
 *
 * This is what allows a normally free-to-play title to be announced when the
 * promotion is a genuine temporary acquire-to-keep transition.
 */
export const KEEP_SIGNALS = Object.freeze([
  /\bfree\s+to\s+keep\b/i,
  /\bkeep\s+it\b/i,
  /\byours\s+to\s+keep\b/i,
  /\bacquire\s+to\s+keep\b/i,
  /\bkeep\s+forever\b/i,
  /\bpermanently\s+(?:added|yours)\b/i,
]);

/** Builds the text that classification patterns are matched against. */
export function buildHaystack(entry) {
  const games = Array.isArray(entry?.games) ? entry.games : [];
  return [
    entry?.title,
    entry?.note,
    ...games.flatMap((game) => [game?.title, game?.slug]),
  ]
    .filter((value) => typeof value === 'string' && value !== '')
    .join(' | ');
}

/** True when the entry states, in words, that the game is kept. */
export function hasKeepSignal(haystack) {
  return KEEP_SIGNALS.some((pattern) => pattern.test(haystack));
}

/**
 * Classifies one ITAD entry.
 *
 * @param {object} entry
 * @param {{ now?: number }} [options]
 * @returns {{ accepted: boolean, reason: string|null, offer: object|null }}
 */
export function classifyItadGiveaway(entry, { now = Date.now() } = {}) {
  if (!entry || typeof entry !== 'object' || entry.id === undefined || entry.id === null) {
    return reject(REJECTION.MALFORMED);
  }

  // 1. Shop must be Steam itself. A key for Steam sold by another shop is not a
  //    Steam giveaway, and ITAD lists plenty of those.
  if (!entry.shop || typeof entry.shop.name !== 'string') return reject(REJECTION.MISSING_SHOP);
  if (entry.shop.name.trim().toLowerCase() !== STEAM_SHOP_NAME.toLowerCase()) {
    return reject(REJECTION.NOT_STEAM);
  }

  // 2. At least one full game. A DLC-only or soundtrack-only giveaway has no
  //    entry with type "game", which rejects both without special-casing them.
  const games = Array.isArray(entry.games) ? entry.games : [];
  const fullGames = games.filter((game) => game?.type === 'game');
  if (fullGames.length === 0) return reject(REJECTION.NO_FULL_GAME);

  const haystack = buildHaystack(entry);

  // 3. Temporary access is never ownership, whatever else the entry says.
  if (TEMPORARY_ACCESS_PATTERNS.some((pattern) => pattern.test(haystack))) {
    return reject(REJECTION.TEMPORARY_ACCESS);
  }

  // 4. A permanently free title is not a giveaway - unless this promotion
  //    explicitly says the game is being kept.
  const keepSignal = hasKeepSignal(haystack);
  if (!keepSignal && PERMANENTLY_FREE_PATTERNS.some((pattern) => pattern.test(haystack))) {
    return reject(REJECTION.PERMANENTLY_FREE);
  }

  // 5. Timing. ITAD excludes expired entries by default; this is defence in
  //    depth, and it is what stops a stale cached response from announcing.
  const publishedAt = parseDate(entry.publish);
  const expiresAt = parseDate(entry.expiry);

  if (publishedAt && publishedAt > now) return reject(REJECTION.NOT_ACTIVE);
  if (expiresAt && expiresAt <= now) return reject(REJECTION.EXPIRED);

  // 6. Ambiguity. A titled entry with a real shop and a real game is as
  //    confirmed as this source gets; anything less is not announced.
  if (typeof entry.title !== 'string' || entry.title.trim() === '') return reject(REJECTION.AMBIGUOUS);
  if (typeof entry.url !== 'string' || entry.url.trim() === '') return reject(REJECTION.AMBIGUOUS);

  return {
    accepted: true,
    reason: null,
    offer: buildOffer(entry, { fullGames, publishedAt, expiresAt }),
  };
}

/**
 * Builds a discovery offer in the shape `classifySteamOffer` consumes.
 *
 * `store_url` is ITAD's own URL, passed through completely unaltered - their
 * terms require the link (including any affiliate parameters) to be preserved,
 * and ITAD's giveaway payload carries no Steam app id to build an official
 * store URL from. Inventing one would be worse than linking to the source.
 */
function buildOffer(entry, { fullGames, publishedAt, expiresAt }) {
  return {
    // Consumed by classifySteamOffer, which requires this explicit statement.
    id: String(entry.id),
    name: entry.title.trim(),
    promotion_kind: 'free_to_keep',
    store_url: entry.url,
    header_image: pickImage(fullGames) ?? pickImage(entry.games ?? []),
    promotion_start: publishedAt ? new Date(publishedAt).toISOString() : null,
    promotion_end: expiresAt ? new Date(expiresAt).toISOString() : null,
    // Provenance, surfaced in the embed. Never implies affiliation.
    source: ITAD_SOURCE_LABEL,
    itad_giveaway_id: entry.id,
    itad_game_ids: fullGames.map((game) => game.id).filter(Boolean),
    shop_name: entry.shop.name,
    details_url: typeof entry.details === 'string' ? entry.details : null,
  };
}

/** Largest available cover art. */
function pickImage(games) {
  for (const game of games) {
    const assets = game?.assets;
    if (!assets) continue;
    for (const key of ['banner600', 'banner400', 'banner300', 'banner145', 'boxart']) {
      if (typeof assets[key] === 'string' && assets[key] !== '') return assets[key];
    }
  }
  return null;
}

function parseDate(value) {
  if (typeof value !== 'string' || value === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function reject(reason) {
  return { accepted: false, reason, offer: null };
}

/**
 * Classifies a whole response.
 *
 * @param {unknown} payload
 * @param {{ now?: number }} [options]
 * @returns {{ offers: object[], rejected: Array<{id: unknown, reason: string}>, total: number }}
 */
export function classifyItadResponse(payload, { now = Date.now() } = {}) {
  const list = Array.isArray(payload) ? payload : Array.isArray(payload?.list) ? payload.list : [];
  const offers = [];
  const rejected = [];

  for (const entry of list) {
    const verdict = classifyItadGiveaway(entry, { now });
    if (verdict.accepted) offers.push(verdict.offer);
    else rejected.push({ id: entry?.id ?? null, reason: verdict.reason });
  }

  return { offers, rejected, total: list.length };
}
