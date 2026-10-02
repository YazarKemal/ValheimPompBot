import { sanitizeStderr } from './redact.js';

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
 * Diagnostic keys that are safe to log from an error's `details`.
 *
 * An allow-list rather than a deny-list: a field added later is dropped by
 * default instead of leaking by default. These are the ones an audio backend
 * fills with bounded, non-secret context.
 */
const SAFE_DETAIL_KEYS = Object.freeze(['exitCode', 'signal', 'bytes', 'stderrBytes', 'stderrTruncated', 'timeoutMs']);

/**
 * Extracts the loggable diagnostics from an error, sanitising the free text.
 *
 * `details.stderr` is a tool's raw output, so it is passed through the
 * sanitizer here - callers cannot accidentally log it unsanitised, and they do
 * not have to know it needs sanitising at all.
 *
 * @param {unknown} error
 * @returns {Record<string, string|number|boolean>} empty when there is nothing safe
 */
export function safeErrorDetails(error) {
  const details = error?.details;
  if (!details || typeof details !== 'object') return {};

  const safe = {};
  for (const key of SAFE_DETAIL_KEYS) {
    const value = details[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      safe[key] = value;
    }
  }

  const stderr = sanitizeStderr(details.stderr);
  if (stderr) safe.sanitizedStderr = stderr;

  return safe;
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
