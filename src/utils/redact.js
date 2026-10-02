/**
 * Secret redaction helpers.
 *
 * Three complementary defences:
 *  1. Key-based  - object keys that look like credentials are replaced wholesale.
 *  2. Value-based - strings that look like Discord tokens are masked in place.
 *  3. Free text   - `sanitizeStderr` makes a third-party tool's output safe to
 *     log: URLs lose their query strings, credential values are masked, and the
 *     result is bounded. The error text itself survives, because that is the
 *     whole reason for logging it.
 *
 * Nothing in this project should log raw configuration without passing it
 * through `redact()` first.
 */

export const REDACTED = '[redacted]';

// Requires a separator (or string boundary) around the keyword so that innocent
// keys such as `maxTokens` are not mistaken for credentials. camelCase keys are
// split first, so `clientSecret` is caught while `author` still is not.
const SECRET_KEY_PATTERN =
  /(^|[_.-])(token|secret|password|passwd|api[_.-]?key|apikey|authorization|auth|cookie|session|credential)([_.-]|$)/i;

const CAMEL_BOUNDARY = /([a-z0-9])([A-Z])/g;

// Discord bot tokens look like <base64>.<base64>.<base64>. Mask them wherever
// they appear, even inside free-form messages.
const DISCORD_TOKEN_PATTERN = /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{25,}/g;

const MAX_DEPTH = 6;

/**
 * @param {string} key
 * @returns {boolean} true when the key name suggests a credential.
 */
export function isSecretKey(key) {
  return SECRET_KEY_PATTERN.test(String(key).replace(CAMEL_BOUNDARY, '$1_$2'));
}

/**
 * Returns a structurally-similar copy with credential values masked.
 * Safe to call on arbitrary values, including cycles at shallow depth.
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
export function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    return value.replace(DISCORD_TOKEN_PATTERN, REDACTED);
  }
  if (typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[max-depth]';

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redact(value.message, depth + 1),
      ...(value.code ? { code: value.code } : {}),
    };
  }
  if (value instanceof Map) {
    return redact(Object.fromEntries(value), depth + 1);
  }
  if (value instanceof Set) {
    return redact([...value], depth + 1);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1));
  }

  const output = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = isSecretKey(key) ? REDACTED : redact(item, depth + 1);
  }
  return output;
}

/** Longest excerpt `sanitizeStderr` returns, marker included. */
export const MAX_STDERR_CHARS = 500;

const TRUNCATION_MARK = '…[truncated]';

/**
 * A URL, up to but not including whitespace or the punctuation that usually
 * follows one in a log line.
 */
const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>()[\]{}]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

/**
 * `key=value` and `key: value` credentials.
 *
 * The LABEL is kept and only the value is masked, so a log still reads as
 * "PO Token: [redacted]" rather than losing the fact that a PO token was the
 * problem. Bare `key` is deliberately absent - too many innocent uses.
 */
const ASSIGNED_SECRET_PATTERN =
  /(^|[\s&?;,])((?:access[_-]?)?token|sig|signature|api[_-]?key|apikey|cookie|authorization|password|session[_-]?id|visitor[_-]?data|po[_-]?token)(\s*[:=]\s*)((?:bearer|basic)[ \t]+)?([^\s&;,)"']+)/gi;

/**
 * A PO token value, in any of the shapes it gets printed in.
 *
 * yt-dlp's own debug output renders one as `PoTokenResponse(po_token='eyJ...')`,
 * which the assignment rule above cannot see: the label is preceded by `(` and
 * the value is quoted. A token is a credential - it is the whole reason this
 * project refuses to use cookies - so it gets its own rule rather than relying
 * on the label happening to sit after a space.
 */
const PO_TOKEN_PATTERN = /(\bpo[ _-]?token\b["']?\s*[:=]\s*)['"]?[A-Za-z0-9_+/.%=-]{8,}['"]?/gi;

/**
 * A whole cookie header, not just its first pair.
 *
 * `Cookie: SID=…; HSID=…` is one credential made of several, and masking only
 * the first would leave the rest in the log.
 */
const COOKIE_HEADER_PATTERN = /(^|\n)([ \t]*(?:set-)?cookie[ \t]*[:=][ \t]*)[^\n]*/gi;

/**
 * Replaces a URL with its origin and path.
 *
 * yt-dlp prints the URLs it works with, and a media URL carries its signature,
 * expiry and token in the query string. The host and path are the useful part -
 * they say which service refused and for what - so only the query and fragment
 * are dropped, and visibly so.
 */
function stripUrlQuery(raw) {
  const trailing = TRAILING_PUNCTUATION.exec(raw)?.[0] ?? '';
  const bare = trailing ? raw.slice(0, -trailing.length) : raw;

  try {
    const url = new URL(bare);
    const path = `${url.origin}${url.pathname}`;
    const hadQuery = url.search !== '' || url.hash !== '';
    return `${path}${hadQuery ? '?[redacted]' : ''}${trailing}`;
  } catch {
    // Not parseable, so nothing about it can be trusted.
    return `[url]${trailing}`;
  }
}

/**
 * Makes a tool's stderr safe to log.
 *
 * Keeps what a diagnosis needs - "HTTP Error 403", "Sign in to confirm you're
 * not a bot", "Requested format is not available" - and removes what must never
 * reach a log: media URLs with their signatures, and credential values.
 *
 * Idempotent: sanitising an already-sanitised string returns it unchanged.
 *
 * @param {unknown} text
 * @param {{ maxChars?: number }} [options]
 * @returns {string|null} null when there is nothing to show
 */
export function sanitizeStderr(text, { maxChars = MAX_STDERR_CHARS } = {}) {
  if (typeof text !== 'string') return null;

  const trimmed = text.replace(/\r\n?/g, '\n').trim();
  if (trimmed === '') return null;

  let output = trimmed
    .replace(URL_PATTERN, stripUrlQuery)
    .replace(COOKIE_HEADER_PATTERN, `$1$2${REDACTED}`)
    .replace(PO_TOKEN_PATTERN, `$1${REDACTED}`)
    // The scheme word ("Bearer") is kept; only the credential after it goes.
    .replace(ASSIGNED_SECRET_PATTERN, `$1$2$3$4${REDACTED}`)
    .replace(DISCORD_TOKEN_PATTERN, REDACTED);

  if (output.length > maxChars) {
    // The marker counts towards the cap, so the bound is the bound.
    output = `${output.slice(0, Math.max(0, maxChars - TRUNCATION_MARK.length))}${TRUNCATION_MARK}`;
  }
  return output;
}
