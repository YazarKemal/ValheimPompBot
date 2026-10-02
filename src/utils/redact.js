/**
 * Secret redaction helpers.
 *
 * Two complementary defences:
 *  1. Key-based  - object keys that look like credentials are replaced wholesale.
 *  2. Value-based - strings that look like Discord tokens are masked in place.
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
