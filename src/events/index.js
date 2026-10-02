import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LoadError } from '../utils/errors.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const EVENTS_DIR = HERE;
const SKIP_FILES = new Set(['index.js']);

/**
 * Validates a loaded event module.
 * @param {Record<string, unknown>} module
 * @param {string} filePath
 * @returns {string[]} problems, empty when valid
 */
export function validateEventModule(module, filePath = '<unknown>') {
  const problems = [];
  const label = path.basename(filePath);

  if (typeof module.name !== 'string' || module.name.length === 0) {
    problems.push(`${label}: missing an exported \`name\` string`);
  }
  if (typeof module.execute !== 'function') {
    problems.push(`${label}: missing an exported \`execute\` function`);
  }
  if (module.once !== undefined && typeof module.once !== 'boolean') {
    problems.push(`${label}: \`once\` must be a boolean when present`);
  }
  return problems;
}

/**
 * Loads and validates every event module in a directory.
 *
 * @param {string} [directory]
 * @returns {Promise<Array<{ name: string, once: boolean, execute: Function, filePath: string }>>}
 */
export async function loadEvents(directory = EVENTS_DIR) {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js') && !SKIP_FILES.has(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  const events = [];
  const problems = [];
  const seen = new Set();

  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    const module = await import(pathToFileURL(filePath).href);

    const moduleProblems = validateEventModule(module, filePath);
    if (moduleProblems.length > 0) {
      problems.push(...moduleProblems);
      continue;
    }

    const key = `${module.name}:${module.once ? 'once' : 'on'}`;
    if (seen.has(key)) {
      problems.push(`${entry.name}: duplicate handler for "${module.name}"`);
      continue;
    }
    seen.add(key);

    events.push({
      name: module.name,
      once: Boolean(module.once),
      execute: module.execute,
      filePath,
    });
  }

  if (problems.length > 0) {
    throw new LoadError(`Failed to load ${problems.length} event problem(s).`, {
      code: 'EVENT_LOAD_FAILED',
      details: { problems },
    });
  }
  return events;
}

/**
 * Binds loaded events to a discord.js client.
 *
 * The shared `ctx` object is appended as the final argument of every handler so
 * event modules never import application singletons directly.
 *
 * @param {{ on: Function, once: Function }} client
 * @param {Array<{ name: string, once: boolean, execute: Function }>} events
 * @param {object} ctx
 * @returns {() => void} unbind function, handy for tests and hot reloads
 */
export function registerEvents(client, events, ctx) {
  const bound = [];

  for (const event of events) {
    const listener = (...args) => {
      const result = event.execute(...args, ctx);
      // Async handlers must never produce unhandled rejections.
      if (result && typeof result.then === 'function') {
        result.catch((error) => {
          ctx?.logger?.error?.(`Unhandled error in event "${event.name}"`, error);
        });
      }
      return result;
    };

    if (event.once) client.once(event.name, listener);
    else client.on(event.name, listener);

    bound.push({ name: event.name, listener, once: event.once });
  }

  return () => {
    for (const { name, listener } of bound) {
      client.removeListener?.(name, listener);
    }
  };
}
