import { resolveOverwrites, rulesEqual } from './permissions.js';

/**
 * Setup planner.
 *
 * A pure function from (desired state, observed state) to a list of actions.
 * No Discord imports, no I/O, no clock - which makes the entire reconciliation
 * policy reviewable and testable in isolation.
 *
 * Two guarantees hold for every plan this module produces:
 *
 *   1. NO DELETIONS. There is no `delete` action kind. Resources that exist but
 *      are absent from the blueprint produce a `keep` note and are left alone.
 *
 *   2. ADDITIVE PERMISSIONS. Scalar properties (colour, hoist, mentionable,
 *      topic, category) are reconciled to match the blueprint exactly, but a
 *      role never loses a permission it already has and a permission overwrite
 *      for a role the blueprint does not mention is never touched. Both cases
 *      are reported as drift instead.
 */

/** Action kinds, in the order they are emitted and applied. */
export const ACTION_KINDS = Object.freeze({
  ROLE_CREATE: 'role.create',
  ROLE_UPDATE: 'role.update',
  CATEGORY_CREATE: 'category.create',
  CHANNEL_CREATE: 'channel.create',
  CHANNEL_UPDATE: 'channel.update',
  SKIP: 'skip',
  KEEP: 'keep',
  WARN: 'warn',
});

/** Kinds that write to Discord. Everything else is informational. */
const MUTATING_KINDS = new Set([
  ACTION_KINDS.ROLE_CREATE,
  ACTION_KINDS.ROLE_UPDATE,
  ACTION_KINDS.CATEGORY_CREATE,
  ACTION_KINDS.CHANNEL_CREATE,
  ACTION_KINDS.CHANNEL_UPDATE,
]);

/** Normalises a resource name for comparison. Discord names are case-insensitive in practice. */
const key = (name) => String(name ?? '').trim().toLowerCase();

const TOPIC_BEARING_TYPES = new Set(['text', 'announcement', 'forum']);

/**
 * @param {object} blueprint
 * @param {{ roles?: object[], categories?: object[], channels?: object[] }} [state]
 * @returns {{ version: number, actions: object[], summary: Record<string, number>, notes: string[] }}
 */
export function planSetup(blueprint, state = {}) {
  const actions = [];
  const categoryNameByKey = new Map((blueprint.categories ?? []).map((c) => [c.key, c.name]));

  planRoles(blueprint.roles ?? [], state.roles ?? [], actions);
  planCategories(blueprint.categories ?? [], state.categories ?? [], actions);
  planChannels(blueprint.channels ?? [], state.channels ?? [], categoryNameByKey, actions);

  return {
    version: blueprint.version ?? 1,
    actions,
    summary: summarise(actions),
    notes: buildNotes(actions),
  };
}

/* -------------------------------------------------------------------------- */
/* Roles                                                                       */
/* -------------------------------------------------------------------------- */

function planRoles(desiredRoles, stateRoles, actions) {
  const remaining = new Map(stateRoles.map((role) => [key(role.name), role]));

  for (const role of desiredRoles) {
    const existing = remaining.get(key(role.name));
    const desiredPermissions = [...new Set(role.permissions ?? [])].sort();

    if (!existing) {
      actions.push({
        kind: ACTION_KINDS.ROLE_CREATE,
        key: role.key,
        name: role.name,
        resource: 'role',
        spec: {
          name: role.name,
          color: normaliseColor(role.color),
          hoist: Boolean(role.hoist),
          mentionable: Boolean(role.mentionable),
          permissions: desiredPermissions,
        },
      });
      continue;
    }
    remaining.delete(key(role.name));

    const changes = {};
    const color = normaliseColor(role.color);
    if (color !== null && normaliseColor(existing.color) !== color) changes.color = color;
    if (Boolean(role.hoist) !== Boolean(existing.hoist)) changes.hoist = Boolean(role.hoist);
    if (Boolean(role.mentionable) !== Boolean(existing.mentionable)) {
      changes.mentionable = Boolean(role.mentionable);
    }

    const current = new Set(existing.permissions ?? []);
    const missing = desiredPermissions.filter((permission) => !current.has(permission));
    if (missing.length > 0) changes.addPermissions = missing;

    if (Object.keys(changes).length > 0) {
      actions.push({ kind: ACTION_KINDS.ROLE_UPDATE, key: role.key, name: role.name, resource: 'role', id: existing.id, changes });
    } else {
      actions.push({
        kind: ACTION_KINDS.SKIP,
        key: role.key,
        name: role.name,
        resource: 'role',
        reason: 'matches blueprint',
      });
    }

    // Reported, never corrected: silently revoking a permission is exactly the
    // kind of privilege change this module refuses to make on its own.
    const extra = [...current].filter((permission) => !desiredPermissions.includes(permission)).sort();
    if (extra.length > 0) {
      actions.push({
        kind: ACTION_KINDS.KEEP,
        key: role.key,
        name: role.name,
        resource: 'role',
        reason: `has ${extra.length} permission(s) beyond the blueprint: ${extra.join(', ')}`,
      });
    }
  }

  for (const orphan of remaining.values()) {
    actions.push({
      kind: ACTION_KINDS.KEEP,
      name: orphan.name,
      resource: 'role',
      reason: 'exists in the guild but is not in the blueprint',
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Categories                                                                  */
/* -------------------------------------------------------------------------- */

function planCategories(desiredCategories, stateCategories, actions) {
  const remaining = new Map(stateCategories.map((category) => [key(category.name), category]));

  for (const category of desiredCategories) {
    if (remaining.has(key(category.name))) {
      remaining.delete(key(category.name));
      actions.push({
        kind: ACTION_KINDS.SKIP,
        key: category.key,
        name: category.name,
        resource: 'category',
        reason: 'matches blueprint',
      });
      continue;
    }
    actions.push({
      kind: ACTION_KINDS.CATEGORY_CREATE,
      key: category.key,
      name: category.name,
      resource: 'category',
      spec: { name: category.name, type: 'category' },
    });
  }

  for (const orphan of remaining.values()) {
    actions.push({
      kind: ACTION_KINDS.KEEP,
      name: orphan.name,
      resource: 'category',
      reason: 'exists in the guild but is not in the blueprint',
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Channels                                                                    */
/* -------------------------------------------------------------------------- */

function planChannels(desiredChannels, stateChannels, categoryNameByKey, actions) {
  const remainingById = new Map(stateChannels.map((channel) => [channel.id, channel]));
  const byNameAndType = new Map(stateChannels.map((channel) => [`${key(channel.name)}|${channel.type}`, channel]));
  const byName = new Map(stateChannels.map((channel) => [key(channel.name), channel]));

  for (const channel of desiredChannels) {
    const type = channel.type ?? 'text';
    const parentName = categoryNameByKey.get(channel.category) ?? null;
    const desiredOverwrites = resolveOverwrites(channel);
    const existing = byNameAndType.get(`${key(channel.name)}|${type}`);

    // A same-named channel of a different type cannot be converted without
    // destroying it, so surface the conflict and change nothing.
    if (!existing) {
      const colliding = byName.get(key(channel.name));
      if (colliding) {
        remainingById.delete(colliding.id);
        actions.push({
          kind: ACTION_KINDS.WARN,
          key: channel.key,
          name: channel.name,
          resource: 'channel',
          reason:
            `exists as type "${colliding.type}" but the blueprint wants "${type}"; ` +
            'converting would require deletion, so it was left untouched',
        });
        continue;
      }

      actions.push({
        kind: ACTION_KINDS.CHANNEL_CREATE,
        key: channel.key,
        name: channel.name,
        resource: 'channel',
        type,
        parentName,
        spec: {
          name: channel.name,
          type,
          topic: channel.topic ?? null,
          parentName,
          overwrites: desiredOverwrites,
        },
      });
      continue;
    }

    remainingById.delete(existing.id);

    const changes = {};
    if (TOPIC_BEARING_TYPES.has(type) && (channel.topic ?? null) !== (existing.topic ?? null)) {
      changes.topic = channel.topic ?? null;
    }
    if (parentName !== (existing.parentName ?? null)) {
      changes.parentName = parentName;
    }

    const { edits, kept } = diffOverwrites(desiredOverwrites, existing.overwrites ?? []);
    if (edits.length > 0) changes.overwriteEdits = edits;

    if (Object.keys(changes).length > 0) {
      actions.push({
        kind: ACTION_KINDS.CHANNEL_UPDATE,
        key: channel.key,
        name: channel.name,
        resource: 'channel',
        id: existing.id,
        changes,
      });
    } else {
      actions.push({
        kind: ACTION_KINDS.SKIP,
        key: channel.key,
        name: channel.name,
        resource: 'channel',
        reason: 'matches blueprint',
      });
    }

    for (const rule of kept) {
      actions.push({
        kind: ACTION_KINDS.KEEP,
        key: channel.key,
        name: channel.name,
        resource: 'channel',
        reason: `keeps the existing overwrite for "${rule.role}", which the blueprint does not manage`,
      });
    }
  }

  for (const orphan of remainingById.values()) {
    actions.push({
      kind: ACTION_KINDS.KEEP,
      name: orphan.name,
      resource: 'channel',
      reason: 'exists in the guild but is not in the blueprint',
    });
  }
}

/**
 * Works out which overwrite rules must be written.
 *
 * Only roles named in the blueprint are ever written. An overwrite for a role
 * the blueprint does not mention is reported as `kept` and left untouched, so a
 * rule an admin added by hand survives every setup run.
 */
function diffOverwrites(desired, current) {
  const remaining = new Map(current.map((rule) => [key(rule.role), rule]));
  const edits = [];
  const kept = [];

  for (const rule of desired) {
    const existing = remaining.get(key(rule.role));
    if (existing && rulesEqual(rule, existing)) {
      remaining.delete(key(rule.role));
      continue;
    }
    remaining.delete(key(rule.role));
    edits.push({ role: rule.role, allow: rule.allow, deny: rule.deny });
  }

  for (const leftover of remaining.values()) {
    kept.push({ role: leftover.role ?? leftover.name ?? '<unknown>' });
  }

  return { edits, kept };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * @param {unknown} color
 * @returns {string|null} lower-case `#rrggbb`, or null when unset
 */
export function normaliseColor(color) {
  if (color === null || color === undefined || color === '') return null;
  if (typeof color === 'number') return `#${color.toString(16).padStart(6, '0').slice(-6)}`;
  const text = String(color).trim().toLowerCase();
  return text.startsWith('#') ? text : `#${text}`;
}

function summarise(actions) {
  const summary = {};
  for (const action of actions) {
    summary[action.kind] = (summary[action.kind] ?? 0) + 1;
  }
  return summary;
}

function buildNotes(actions) {
  const notes = [];
  const keeps = actions.filter((action) => action.kind === ACTION_KINDS.KEEP).length;
  const warns = actions.filter((action) => action.kind === ACTION_KINDS.WARN).length;
  if (keeps > 0) {
    notes.push(`${keeps} existing resource(s)/rule(s) fall outside the blueprint and will be preserved.`);
  }
  if (warns > 0) {
    notes.push(`${warns} conflict(s) need a manual decision; nothing was changed for those.`);
  }
  return notes;
}

/**
 * Safety net used by tests and `npm run check`: proves a plan cannot delete.
 * @param {{ actions?: object[] }} plan
 * @returns {string[]} problems, empty when the plan is non-destructive
 */
export function assertNoDestructiveActions(plan) {
  const problems = [];
  const known = new Set(Object.values(ACTION_KINDS));

  for (const action of plan?.actions ?? []) {
    if (typeof action.kind !== 'string') {
      problems.push('encountered an action without a kind');
      continue;
    }
    if (/delete|destroy|purge|remove/i.test(action.kind)) {
      problems.push(`destructive action kind "${action.kind}"`);
    } else if (!known.has(action.kind)) {
      problems.push(`unknown action kind "${action.kind}"`);
    }
  }
  return problems;
}

/** @param {object} plan */
export function countMutations(plan) {
  return (plan?.actions ?? []).filter((action) => MUTATING_KINDS.has(action.kind)).length;
}
