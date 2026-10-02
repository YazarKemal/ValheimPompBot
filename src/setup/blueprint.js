import { EVERYONE } from './constants.js';

/**
 * Blueprint primitives and validation.
 *
 * The server layouts themselves live in `blueprints/`; this module holds the
 * shared rules they all obey and re-exports the registry so existing imports of
 * `buildBlueprint` keep working.
 */

export { BLUEPRINT_VERSION, EVERYONE, DEFAULT_BLUEPRINT } from './constants.js';
export {
  buildBlueprint,
  listBlueprints,
  describeBlueprints,
  hasBlueprint,
} from './blueprints/index.js';

/**
 * Structural validation, used by `npm run check` and by tests.
 *
 * @param {object} blueprint
 * @returns {string[]} problems, empty when valid
 */
export function validateBlueprint(blueprint) {
  const problems = [];
  if (!blueprint || typeof blueprint !== 'object') return ['blueprint must be an object'];

  for (const group of ['roles', 'categories', 'channels']) {
    if (!Array.isArray(blueprint[group])) problems.push(`blueprint.${group} must be an array`);
  }
  if (problems.length > 0) return problems;

  // An empty `roles` array is legitimate: a structure-only blueprint that relies
  // on @everyone rules. It is not treated as a problem.

  const roleNames = new Set();
  for (const role of blueprint.roles ?? []) {
    if (!role.key || !role.name) problems.push('every role needs a `key` and a `name`');
    else if (roleNames.has(role.name.toLowerCase())) problems.push(`duplicate role name "${role.name}"`);
    else roleNames.add(role.name.toLowerCase());
  }

  const categoryKeys = new Set();
  const categoryNames = new Set();
  for (const category of blueprint.categories) {
    if (!category.key || !category.name) {
      problems.push('every category needs a `key` and a `name`');
      continue;
    }
    categoryKeys.add(category.key);
    if (categoryNames.has(category.name.toLowerCase())) {
      problems.push(`duplicate category name "${category.name}"`);
    }
    categoryNames.add(category.name.toLowerCase());
  }

  const channelNames = new Set();
  for (const channel of blueprint.channels) {
    const label = channel.key ?? channel.name ?? '<unnamed>';
    if (!channel.key || !channel.name) problems.push('every channel needs a `key` and a `name`');
    if (!channel.category) problems.push(`channel "${label}" must reference a category`);
    else if (!categoryKeys.has(channel.category)) {
      problems.push(`channel "${label}" references unknown category "${channel.category}"`);
    }

    const name = String(channel.name ?? '').toLowerCase();
    if (channelNames.has(name)) problems.push(`duplicate channel name "${channel.name}"`);
    else channelNames.add(name);

    if (channel.type === 'category') {
      problems.push(`channel "${label}" must not declare type "category"; use blueprint.categories`);
    }

    for (const overwrite of channel.overwrites ?? []) {
      const roleName = String(overwrite.role ?? '').toLowerCase();
      if (roleName !== EVERYONE && !roleNames.has(roleName)) {
        problems.push(`channel "${label}" overwrite references unknown role "${overwrite.role}"`);
      }
    }
  }

  return problems;
}
