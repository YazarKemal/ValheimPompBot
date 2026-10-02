import { BotError } from '../../utils/errors.js';
import { DEFAULT_BLUEPRINT } from '../constants.js';
import { createValheimBlueprint } from './valheim.js';
import { createMiningFoolsBlueprint } from './miningfools.js';

/**
 * Blueprint registry.
 *
 * Adding a server layout means adding one entry here plus its module. Nothing
 * else in the codebase needs to change: the planner, the apply pipeline and the
 * setup CLI all work from the shape, not from a specific definition.
 */
const REGISTRY = new Map([
  ['valheim', { title: 'Valheim Pomp', create: createValheimBlueprint }],
  ['miningfools', { title: 'MiningFools', create: createMiningFoolsBlueprint }],
]);

/** @returns {string[]} blueprint names, sorted */
export function listBlueprints() {
  return [...REGISTRY.keys()].sort();
}

/** @returns {Array<{ name: string, title: string }>} */
export function describeBlueprints() {
  return [...REGISTRY.entries()]
    .map(([name, entry]) => ({ name, title: entry.title }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** @param {string} name */
export function hasBlueprint(name) {
  return REGISTRY.has(name);
}

/**
 * Builds a blueprint by name.
 *
 * @param {string} [name] Defaults to `DEFAULT_BLUEPRINT`.
 * @param {object} [options] Forwarded to the blueprint factory.
 * @returns {{ version: number, key: string, title: string, roles: object[], categories: object[], channels: object[] }}
 */
export function buildBlueprint(name = DEFAULT_BLUEPRINT, options = {}) {
  const entry = REGISTRY.get(name) ?? REGISTRY.get(name?.toLowerCase?.());
  if (!entry) {
    throw new BotError(`Unknown blueprint "${name}". Available: ${listBlueprints().join(', ')}.`, {
      code: 'BLUEPRINT_UNKNOWN',
      details: { blueprint: name, available: listBlueprints() },
    });
  }
  return entry.create(options);
}

export { createValheimBlueprint, createMiningFoolsBlueprint };
