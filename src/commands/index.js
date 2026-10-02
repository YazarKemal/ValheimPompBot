import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LoadError } from '../utils/errors.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Directory scanned when no explicit path is supplied. */
export const COMMANDS_DIR = HERE;

const SKIP_FILES = new Set(['index.js']);

/**
 * Normalises a command's `data` export to plain JSON.
 *
 * Accepts either a discord.js `SlashCommandBuilder` or a hand-written object,
 * so command authors are not forced to import discord.js for static commands.
 *
 * @param {unknown} data
 * @param {string} filePath
 * @returns {object}
 */
export function toCommandJSON(data, filePath = '<unknown>') {
  if (data && (typeof data.toJSON === 'function' || (typeof data === 'object' && !Array.isArray(data)))) {
    const raw = typeof data.toJSON === 'function' ? data.toJSON() : data;
    // discord.js builders emit keys set to `undefined`, which vanish on
    // serialisation. Stripping them here keeps the loader's output canonical and
    // equal to what Discord will actually receive.
    return stripUndefined(JSON.parse(JSON.stringify(raw)));
  }
  throw new LoadError(`Command "${path.basename(filePath)}" does not export a usable \`data\` object.`, {
    code: 'COMMAND_DATA_INVALID',
    details: { file: filePath },
  });
}

/** Recursively removes `undefined` entries. */
function stripUndefined(value) {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value === null || typeof value !== 'object') return value;

  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    output[key] = stripUndefined(item);
  }
  return output;
}

/**
 * Validates a loaded command module.
 * @param {Record<string, unknown>} module
 * @param {string} filePath
 * @returns {string[]} problems, empty when valid
 */
export function validateCommandModule(module, filePath = '<unknown>') {
  const problems = [];
  const label = path.basename(filePath);

  if (typeof module.execute !== 'function') {
    problems.push(`${label}: missing an exported \`execute\` function`);
  }
  if (module.data === undefined) {
    problems.push(`${label}: missing an exported \`data\` definition`);
  } else {
    try {
      const json = toCommandJSON(module.data, filePath);
      if (typeof json.name !== 'string' || json.name.length === 0) {
        problems.push(`${label}: \`data.name\` must be a non-empty string`);
      } else if (!/^[-_\p{L}\p{N}]{1,32}$/u.test(json.name)) {
        problems.push(`${label}: \`data.name\` must match Discord's naming rules`);
      } else if (json.name !== json.name.toLowerCase()) {
        problems.push(`${label}: \`data.name\` must be lowercase`);
      }
      if (typeof json.description !== 'string' || json.description.length === 0) {
        problems.push(`${label}: \`data.description\` must be a non-empty string`);
      }
    } catch (error) {
      problems.push(`${label}: \`data\` could not be serialised (${error.message})`);
    }
  }
  if (module.meta !== undefined && (typeof module.meta !== 'object' || module.meta === null)) {
    problems.push(`${label}: \`meta\` must be an object when present`);
  }
  return problems;
}

/** Commands belong to exactly one bot application. */
export const COMMAND_OWNERS = Object.freeze({
  POMPAI: 'pompai',
  POMPMUSIC: 'pompmusic',
});

export const DEFAULT_OWNER = COMMAND_OWNERS.POMPAI;

/** The owner a command declares, defaulting to PompAI. */
export function commandOwner(meta) {
  return meta?.bot ?? DEFAULT_OWNER;
}

/**
 * Loads and validates every command module in a directory.
 *
 * `owner` filters the set. The two bot applications are separate Discord
 * clients with separate command registrations, so neither may ever load the
 * other's commands - a mistake there would register music commands against
 * PompAI's application, which is exactly what this phase exists to prevent.
 *
 * @param {string} [directory]
 * @param {{ owner?: string|null }} [options] `null` loads every command.
 * @returns {Promise<Map<string, { name: string, data: object, builder: unknown, execute: Function, meta: object, filePath: string }>>}
 */
export async function loadCommands(directory = COMMANDS_DIR, { owner = null } = {}) {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js') && !SKIP_FILES.has(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  /** @type {Map<string, any>} */
  const commands = new Map();
  const problems = [];

  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    const module = await import(pathToFileURL(filePath).href);

    const moduleProblems = validateCommandModule(module, filePath);
    if (moduleProblems.length > 0) {
      problems.push(...moduleProblems);
      continue;
    }

    const declares = commandOwner(module.meta);
    if (owner !== null && declares !== owner) continue;

    const json = toCommandJSON(module.data, filePath);
    if (commands.has(json.name)) {
      problems.push(
        `${entry.name}: command name "${json.name}" is already defined by ${path.basename(commands.get(json.name).filePath)}`,
      );
      continue;
    }

    commands.set(json.name, {
      name: json.name,
      data: json,
      builder: module.data,
      execute: module.execute,
      meta: module.meta ?? {},
      owner: declares,
      filePath,
    });
  }

  if (problems.length > 0) {
    throw new LoadError(`Failed to load ${problems.length} command problem(s).`, {
      code: 'COMMAND_LOAD_FAILED',
      details: { problems },
    });
  }
  return commands;
}

/**
 * The payload Discord expects when registering application commands.
 * Registration itself is a network call and belongs to a later phase.
 * @param {Map<string, { data: object }>} commands
 */
export function toRegistrationPayload(commands) {
  return [...commands.values()].map((command) => command.data);
}
