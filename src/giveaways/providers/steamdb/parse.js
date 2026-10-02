/**
 * SteamDB free-promotions HTML parser.
 *
 * Isolated from the transport on purpose: everything here is a pure function
 * over a string, so the promotion rules can be tested exhaustively against
 * fixtures without a network call, and a change in SteamDB's markup can only
 * ever produce an empty list - never a wrong announcement.
 *
 * The governing rule is FAIL CLOSED. An offer is accepted only when the page
 * contains an element whose entire text is exactly "Free to Keep", and no
 * element stating otherwise. Price is never consulted: a 100% discount is not
 * evidence of Free to Keep, because Free Weekends have one too.
 */

/** The only label that qualifies an offer for announcement. */
export const FREE_TO_KEEP_LABEL = 'free to keep';

/**
 * Labels that disqualify an offer, matched against an element's *entire* text.
 *
 * Matching the whole element rather than a substring is what stops a game
 * called "Free Weekend Simulator" from being silently dropped, and - more
 * importantly - stops a game called "Free to Keep" from being announced.
 */
export const REJECT_LABELS = Object.freeze([
  'free weekend',
  'play for free',
  'free to play',
  'free-to-play',
  'permanently free',
  'always free',
  'upcoming',
  'unconfirmed',
  'rumoured',
  'rumored',
  'tba',
  'unknown',
]);

/** Elements whose text is treated as a label candidate. */
const LABEL_TAGS = ['td', 'th', 'span', 'div', 'strong', 'b', 'a', 'li', 'p'];

const ROW_PATTERN = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
const NESTED_TABLE_PATTERN = /<table\b[\s\S]*?<\/table>/gi;
const APP_HREF_PATTERN = /href=["'](?:https?:\/\/steamdb\.info)?\/app\/(\d+)\/?(?:[^"']*)?["']/i;
const ANY_APP_HREF_PATTERN = /href=["'][^"']*?\/app\/(\d+)\/?[^"']*["']/i;
const IMG_SRC_PATTERN = /<img\b[^>]*\bsrc=["']([^"']+)["']/i;
const TIMESTAMP_ATTR_PATTERN = /data-timestamp=["'](\d{9,13})["']/gi;
const TIME_DATETIME_PATTERN = /<time\b[^>]*\bdatetime=["']([^"']+)["']/gi;

/** Signatures of a bot-challenge page rather than the real promotions table. */
const CHALLENGE_PATTERNS = [
  /just a moment/i,
  /cf[-_]chl/i,
  /challenge-platform/i,
  /enable javascript and cookies to continue/i,
  /checking your browser/i,
  /attention required/i,
];

/**
 * Collapses markup and entities to plain text.
 * @param {string} html
 */
export function toText(html) {
  return String(html ?? '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalises a label for exact comparison. */
function normaliseLabel(value) {
  return toText(value).toLowerCase().replace(/[.:!]+$/, '').trim();
}

/**
 * Extracts the trimmed text of every candidate label element in a row.
 * @param {string} rowHtml
 * @returns {string[]}
 */
export function extractLabelTexts(rowHtml) {
  const texts = [];
  for (const tag of LABEL_TAGS) {
    const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
    for (const match of String(rowHtml).matchAll(pattern)) {
      const text = normaliseLabel(match[1]);
      if (text !== '') texts.push(text);
    }
  }
  return texts;
}

/**
 * Classifies a row from its label elements.
 *
 * @param {string[]} labels
 * @returns {'free_to_keep'|'rejected'|'unknown'}
 */
export function classifyRow(labels) {
  // A row that says anything disqualifying is out, even if it also says
  // "Free to Keep" - contradictory markup is not a licence to guess.
  if (labels.some((label) => REJECT_LABELS.includes(label))) return 'rejected';
  if (labels.some((label) => label === FREE_TO_KEEP_LABEL)) return 'free_to_keep';
  return 'unknown';
}

/**
 * Removes nested tables so a child row cannot be read as part of its parent.
 *
 * Two passes are needed. The row regex is non-greedy, so a row containing a
 * nested table is truncated at the *inner* `</tr>`, leaving the nested `<table>`
 * unclosed. The first pass removes complete nested tables; the second discards
 * anything from a still-unclosed `<table` onwards. Without that second pass a
 * child row's "Free to Keep" label is attributed to its parent.
 *
 * @param {string} rowHtml
 */
function stripNestedTables(rowHtml) {
  return String(rowHtml)
    .replace(NESTED_TABLE_PATTERN, ' ')
    .replace(/<table\b[\s\S]*$/i, ' ');
}

/**
 * Collects every timestamp in a row, ascending.
 * @param {string} rowHtml
 * @returns {number[]} epoch milliseconds
 */
export function extractTimestamps(rowHtml) {
  const stamps = [];
  const source = String(rowHtml);

  for (const match of source.matchAll(TIMESTAMP_ATTR_PATTERN)) {
    const raw = Number(match[1]);
    // SteamDB uses seconds; tolerate milliseconds too.
    const ms = match[1].length >= 13 ? raw : raw * 1000;
    if (Number.isFinite(ms)) stamps.push(ms);
  }
  for (const match of source.matchAll(TIME_DATETIME_PATTERN)) {
    const ms = Date.parse(match[1]);
    if (Number.isFinite(ms)) stamps.push(ms);
  }

  return [...new Set(stamps)].sort((a, b) => a - b);
}

/** The official Steam store page - never SteamDB - is the redemption link. */
export function steamStoreUrl(appId) {
  return `https://store.steampowered.com/app/${appId}/`;
}

/** Steam's own CDN header art, used when the row carries no image. */
export function steamHeaderImage(appId) {
  return `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`;
}

/**
 * Parses the SteamDB free-promotions page into discovery offers.
 *
 * The returned shape is what `SteamDiscoverySource` implementations produce, so
 * `parseSteamGiveaways` and `classifySteamOffer` handle it unchanged.
 *
 * @param {string} html
 * @param {{ now?: number }} [options]
 * @returns {object[]}
 */
export function parseSteamDbFree(html, { now = Date.now() } = {}) {
  return analyseSteamDbHtml(html, { now }).offers;
}

/**
 * Parses the page and reports what it saw, so a caller can tell "no giveaways
 * today" apart from "the markup changed" or "we were served a challenge page".
 *
 * @param {string} html
 * @param {{ now?: number }} [options]
 * @returns {{ offers: object[], rows: number, accepted: number, rejected: number, shapeOk: boolean, blocked: boolean, warnings: string[] }}
 */
export function analyseSteamDbHtml(html, { now = Date.now() } = {}) {
  const source = String(html ?? '');
  const warnings = [];
  const offers = [];
  let accepted = 0;
  let rejected = 0;

  const blocked = CHALLENGE_PATTERNS.some((pattern) => pattern.test(source));
  if (blocked) {
    return { offers: [], rows: 0, accepted: 0, rejected: 0, shapeOk: false, blocked: true, warnings: ['challenge page'] };
  }

  const rows = [...source.matchAll(ROW_PATTERN)];
  if (rows.length === 0) {
    warnings.push('no table rows found - markup may have changed');
    return { offers: [], rows: 0, accepted: 0, rejected: 0, shapeOk: false, blocked: false, warnings };
  }

  for (const row of rows) {
    const rowHtml = stripNestedTables(row[1]);
    const labels = extractLabelTexts(rowHtml);
    const verdict = classifyRow(labels);

    if (verdict === 'rejected') {
      rejected += 1;
      continue;
    }
    if (verdict !== 'free_to_keep') continue;

    const appId = APP_HREF_PATTERN.exec(rowHtml)?.[1] ?? ANY_APP_HREF_PATTERN.exec(rowHtml)?.[1];
    if (!appId) {
      warnings.push('a Free to Keep row had no Steam app id');
      continue;
    }

    const title = extractTitle(rowHtml, appId);
    if (!title) {
      warnings.push(`app ${appId} had no title`);
      continue;
    }

    accept(offers, { rowHtml, appId, title, now });
    accepted += 1;
  }

  if (accepted === 0 && rejected === 0) {
    warnings.push('rows were found but none carried a recognisable promotion label');
  }

  return { offers, rows: rows.length, accepted, rejected, shapeOk: true, blocked: false, warnings };
}

function accept(offers, { rowHtml, appId, title, now }) {
  const timestamps = extractTimestamps(rowHtml);
  // The last timestamp in a promotion row is its end; the first is its start.
  const startsAt = timestamps.length >= 2 ? new Date(timestamps[0]).toISOString() : null;
  const endsAt = timestamps.length >= 1 ? new Date(timestamps.at(-1)).toISOString() : null;
  const image = IMG_SRC_PATTERN.exec(rowHtml)?.[1] ?? steamHeaderImage(appId);

  offers.push({
    // Consumed by classifySteamOffer, which requires this explicit statement.
    id: String(appId),
    name: title,
    promotion_kind: 'free_to_keep',
    store_url: steamStoreUrl(appId),
    header_image: image,
    promotion_start: startsAt,
    promotion_end: endsAt,
    // Discovery provenance: which page this came from, never the redemption link.
    discovered_via: 'steamdb',
    discovered_at: new Date(now).toISOString(),
  });
}

/** Pulls the game title from the anchor that links to the app page. */
function extractTitle(rowHtml, appId) {
  const anchor = new RegExp(`<a\\b[^>]*href=["'][^"']*?/app/${appId}/?[^"']*["'][^>]*>([\\s\\S]*?)<\\/a>`, 'i');
  const fromAnchor = toText(anchor.exec(rowHtml)?.[1] ?? '');
  if (fromAnchor) return fromAnchor;

  // Fall back to the row's first non-empty text run, which is the game column
  // on every layout observed so far.
  const cell = /<td\b[^>]*>([\s\S]*?)<\/td>/i.exec(rowHtml);
  return toText(cell?.[1] ?? '');
}
