import { inspect } from 'node:util';
import { redact } from './redact.js';

export const LOG_LEVELS = Object.freeze({ error: 0, warn: 1, info: 2, debug: 3 });
export const LOG_LEVEL_NAMES = Object.freeze(Object.keys(LOG_LEVELS));

/** Levels at or below this severity go to stderr instead of stdout. */
const STDERR_LEVELS = new Set(['error', 'warn']);

/**
 * Creates a small structured logger.
 *
 * @param {object} [options]
 * @param {'error'|'warn'|'info'|'debug'} [options.level='info']
 * @param {string} [options.name='bot'] Label shown on every line.
 * @param {Record<string, unknown>} [options.bindings] Context merged into every line.
 * @param {NodeJS.WritableStream|null} [options.stream] Force all output to one stream (used by tests).
 * @param {() => Date} [options.now] Injectable clock (used by tests).
 */
export function createLogger({
  level = 'info',
  name = 'bot',
  bindings = {},
  stream = null,
  now = () => new Date(),
} = {}) {
  const threshold = LOG_LEVELS[level] ?? LOG_LEVELS.info;

  const emit = (levelName, message, meta) => {
    if (LOG_LEVELS[levelName] > threshold) return;

    const target = stream ?? (STDERR_LEVELS.has(levelName) ? process.stderr : process.stdout);
    const safeBindings = redact(bindings);
    const parts = [
      `[${now().toISOString()}]`,
      levelName.toUpperCase().padEnd(5),
      `${name}:`,
      String(message),
    ];

    const payload = { ...safeBindings };
    if (meta !== undefined) payload.meta = redact(meta);
    if (Object.keys(payload).length > 0) {
      parts.push(inspect(payload, { depth: 5, breakLength: 120, colors: false, compact: true }));
    }

    target.write(`${parts.join(' ')}\n`);
  };

  return {
    level,
    name,
    error: (message, meta) => emit('error', message, meta),
    warn: (message, meta) => emit('warn', message, meta),
    info: (message, meta) => emit('info', message, meta),
    debug: (message, meta) => emit('debug', message, meta),
    /**
     * Derives a logger with extra context and an optional sub-label.
     * @param {Record<string, unknown>} extraBindings
     * @param {string} [childName]
     */
    child(extraBindings = {}, childName = null) {
      return createLogger({
        level,
        name: childName ? `${name}:${childName}` : name,
        bindings: { ...bindings, ...extraBindings },
        stream,
        now,
      });
    },
  };
}

/**
 * Logger that discards everything. Useful as a default so modules never need a
 * null-check before logging.
 */
export function createNullLogger() {
  const noop = () => {};
  return {
    level: 'error',
    name: 'null',
    error: noop,
    warn: noop,
    info: noop,
    debug: noop,
    child: () => createNullLogger(),
  };
}

/**
 * Captures log lines in memory. Intended for tests.
 * @returns {{ logger: ReturnType<typeof createLogger>, lines: string[], text: () => string }}
 */
export function createCapturingLogger(options = {}) {
  const lines = [];
  const stream = {
    write(chunk) {
      lines.push(String(chunk).replace(/\n$/, ''));
      return true;
    },
  };
  const logger = createLogger({ ...options, stream });
  return { logger, lines, text: () => lines.join('\n') };
}
