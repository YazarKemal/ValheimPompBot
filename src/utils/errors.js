/**
 * Base error type for the bot.
 *
 * Every error carries a stable machine-readable `code` so callers can branch on
 * the failure without string matching, and an optional `details` bag for
 * structured context. Secret values must never be put in `message` or `details`.
 */
export class BotError extends Error {
  /**
   * @param {string} message Human readable, safe to show in a terminal.
   * @param {{ code?: string, details?: unknown, cause?: unknown }} [options]
   */
  constructor(message, { code = 'BOT_ERROR', details = null, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
}

/** Thrown when module loading (commands, events) finds a malformed definition. */
export class LoadError extends BotError {
  constructor(message, options = {}) {
    super(message, { code: 'LOAD_ERROR', ...options });
  }
}

/**
 * Formats an error for a terminal without leaking secrets.
 * @param {unknown} error
 * @returns {string}
 */
export function formatError(error) {
  if (!(error instanceof Error)) return String(error);
  const code = error.code ? ` [${error.code}]` : '';
  const lines = [`${error.name}${code}: ${error.message}`];
  if (error.details && typeof error.details === 'object') {
    for (const [key, value] of Object.entries(error.details)) {
      lines.push(`  - ${key}: ${Array.isArray(value) ? value.join(', ') : String(value)}`);
    }
  }
  return lines.join('\n');
}
