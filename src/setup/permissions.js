import { EVERYONE } from './blueprint.js';

/**
 * Permission configuration.
 *
 * Turns the terse `readOnly` / `private` / `overwrites` shorthands on a channel
 * definition into one canonical, de-duplicated list of overwrite rules.
 *
 * Keeping this pure means the whole permission model is unit-testable without
 * a Discord connection.
 */

/**
 * Rules applied to a `readOnly` channel: everyone can read, nobody can post.
 *
 * Only @everyone is referenced, which is why a blueprint can use `readOnly`
 * without defining any custom roles. Anything that needs a staff role must spell
 * the rule out in `overwrites`, so role names stay local to their blueprint.
 */
const READ_ONLY_RULES = [
  { role: EVERYONE, allow: ['ViewChannel', 'ReadMessageHistory'], deny: ['SendMessages'] },
];

/**
 * @param {{ readOnly?: boolean, overwrites?: object[] }} channel
 * @returns {Array<{ role: string, allow: string[], deny: string[] }>}
 */
export function resolveOverwrites(channel = {}) {
  const rules = [];

  if (channel.readOnly) rules.push(...READ_ONLY_RULES);
  rules.push(...(channel.overwrites ?? []));

  return mergeRules(rules);
}

/**
 * Merges rules that target the same role.
 *
 * Discord evaluates deny before allow, so a permission appearing in both sets
 * is dropped from `allow` - this keeps the emitted rule self-consistent instead
 * of relying on Discord's precedence to sort it out.
 *
 * @param {Array<{ role: string, allow?: string[], deny?: string[] }>} rules
 * @returns {Array<{ role: string, allow: string[], deny: string[] }>}
 */
export function mergeRules(rules) {
  /** @type {Map<string, { role: string, allow: Set<string>, deny: Set<string> }>} */
  const byRole = new Map();

  for (const rule of rules) {
    const role = normaliseRoleName(rule.role);
    if (!role) continue;

    let bucket = byRole.get(role.toLowerCase());
    if (!bucket) {
      bucket = { role, allow: new Set(), deny: new Set() };
      byRole.set(role.toLowerCase(), bucket);
    }
    for (const permission of rule.allow ?? []) bucket.allow.add(permission);
    for (const permission of rule.deny ?? []) bucket.deny.add(permission);
  }

  return [...byRole.values()].map((bucket) => ({
    role: bucket.role,
    allow: [...bucket.allow].filter((permission) => !bucket.deny.has(permission)).sort(),
    deny: [...bucket.deny].sort(),
  }));
}

/**
 * Normalises a role reference. `@everyone` is case-insensitive; other names are
 * trimmed. Case is preserved for real role names.
 * @param {unknown} role
 * @returns {string}
 */
export function normaliseRoleName(role) {
  const value = String(role ?? '').trim();
  if (!value) return '';
  return value.toLowerCase() === EVERYONE ? EVERYONE : value;
}

/**
 * Compares two overwrite rules for equality, ignoring ordering.
 * @param {{ allow: string[], deny: string[] }} a
 * @param {{ allow: string[], deny: string[] }} b
 */
export function rulesEqual(a, b) {
  return sortedEquals(a?.allow ?? [], b?.allow ?? []) && sortedEquals(a?.deny ?? [], b?.deny ?? []);
}

function sortedEquals(a, b) {
  const left = [...a].sort();
  const right = [...b].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
