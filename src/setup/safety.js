import { ACTION_KINDS } from './planner.js';
import { LiveApplyAbort } from './errors.js';

/**
 * Safety gates for the live apply path.
 *
 * These are deliberately separate from the planner. The planner decides what
 * *should* change; this module decides whether a given plan is allowed anywhere
 * near a real guild. A plan can be perfectly correct and still be refused here.
 *
 * Every gate is a pure function over the plan and the observed state, so the
 * whole safety policy is testable without touching Discord.
 */

/** Resources that must survive untouched, whatever the blueprint says. */
export const PROTECTED_RESOURCES = Object.freeze([
  {
    name: 'Genel',
    type: 'voice',
    reason: 'Pre-existing voice channel. Its name is not in the blueprint; it is reused as-is.',
  },
  {
    name: 'Metin Kanalları',
    type: 'category',
    reason: 'Pre-existing category holding the current text channels. Never deleted or renamed.',
  },
  {
    name: 'Ses Kanalları',
    type: 'category',
    reason: 'Pre-existing category holding the current voice channels. Never deleted or renamed.',
  },
]);

/** Every action kind the planner is allowed to emit. */
const ALLOWED_ACTION_KINDS = new Set(Object.values(ACTION_KINDS));

/** Kinds that write to Discord. */
const MUTATING_KINDS = new Set([
  ACTION_KINDS.ROLE_CREATE,
  ACTION_KINDS.ROLE_UPDATE,
  ACTION_KINDS.CATEGORY_CREATE,
  ACTION_KINDS.CHANNEL_CREATE,
  ACTION_KINDS.CHANNEL_UPDATE,
]);

/** Kinds that would change the role model. Forbidden in this phase. */
const ROLE_KINDS = new Set([ACTION_KINDS.ROLE_CREATE, ACTION_KINDS.ROLE_UPDATE]);

/** Anything matching these must never reach a live guild. */
const DESTRUCTIVE_PATTERN = /delete|destroy|purge|remove|wipe|reset/i;

/**
 * Privileges this phase must not grant.
 *
 * `Administrator` bypasses every other permission; the `Manage*` family lets a
 * role reshape the server. The MiningFools blueprint needs none of them.
 */
export const FORBIDDEN_PERMISSIONS = Object.freeze([
  'Administrator',
  'ManageRoles',
  'ManageGuild',
  'ManageChannels',
  'ManageWebhooks',
  'ManageEmojisAndStickers',
  'ManageNicknames',
]);

/**
 * Gate: the connected guild must be the configured one.
 *
 * Checked on both id and name. The id is authoritative; the name catches the
 * case where a stale or wrong DISCORD_GUILD_ID points at a different server
 * that happens to be reachable.
 *
 * @param {{ id: string, name: string }} guild
 * @param {{ guildId: string|null, expectedName?: string|null }} expected
 */
export function assertGuildMatches(guild, { guildId, expectedName = null }) {
  const violations = [];

  if (!guildId) {
    throw new LiveApplyAbort('DISCORD_GUILD_ID is not set; refusing to apply to an unknown guild.', {
      gate: 'guild-identity',
      violations: ['DISCORD_GUILD_ID is not set'],
    });
  }
  if (guild.id !== guildId) {
    violations.push(`connected guild id "${guild.id}" does not equal DISCORD_GUILD_ID "${guildId}"`);
  }
  if (expectedName && normalise(guild.name) !== normalise(expectedName)) {
    violations.push(`connected guild name "${guild.name}" does not match expected "${expectedName}"`);
  }

  if (violations.length > 0) {
    throw new LiveApplyAbort(
      'Refusing to apply: the target guild is not the configured MiningFools guild.',
      { gate: 'guild-identity', violations },
    );
  }
}

/**
 * Gate: the plan must contain nothing outside the allowed vocabulary.
 *
 * Rejects unknown action types, anything destructive, role mutations, edits to
 * protected resources, and any attempt to grant a privileged permission.
 *
 * @param {object} plan
 * @param {object} [options]
 * @param {{ roles?: object[], categories?: object[], channels?: object[] }} [options.state]
 * @param {Array<{name: string, type: string}>} [options.protectedResources]
 * @param {boolean} [options.allowRoleMutations] Defaults to false.
 */
export function assertPlanIsSafe(
  plan,
  { state = {}, protectedResources = PROTECTED_RESOURCES, allowRoleMutations = false } = {},
) {
  const violations = [];
  const protectedIds = collectProtectedIds(state, protectedResources);

  for (const action of plan?.actions ?? []) {
    const label = action.name ?? action.key ?? '<unnamed>';

    if (typeof action.kind !== 'string') {
      violations.push('plan contains an action without a kind');
      continue;
    }
    if (DESTRUCTIVE_PATTERN.test(action.kind)) {
      violations.push(`destructive action "${action.kind}" on "${label}"`);
    } else if (!ALLOWED_ACTION_KINDS.has(action.kind)) {
      violations.push(`unexpected action type "${action.kind}" on "${label}"`);
    }

    if (!allowRoleMutations && ROLE_KINDS.has(action.kind)) {
      violations.push(`role mutation "${action.kind}" on "${label}"`);
    }

    if (!MUTATING_KINDS.has(action.kind)) continue;

    // Two complementary protected-resource checks, because neither is precise
    // enough alone:
    //   - actions on an existing resource carry an id, which is unambiguous
    //   - creations carry no id, so they are matched on name AND type
    // Matching on name alone would flag the text channel `#genel` as if it were
    // the protected voice channel `Genel`.
    if (action.id) {
      if (protectedIds.has(action.id)) {
        violations.push(`action "${action.kind}" would modify protected resource "${label}"`);
      }
    } else {
      for (const resource of protectedResources) {
        if (normalise(resource.name) === normalise(action.name) && createdType(action) === resource.type) {
          violations.push(`action "${action.kind}" would create a protected ${resource.type} "${resource.name}"`);
        }
      }
    }

    for (const permission of permissionsIn(action)) {
      if (FORBIDDEN_PERMISSIONS.includes(permission)) {
        violations.push(`action "${action.kind}" on "${label}" grants privileged permission "${permission}"`);
      }
    }
  }

  if (violations.length > 0) {
    throw new LiveApplyAbort(
      `Refusing to apply: the plan failed ${violations.length} safety check(s).`,
      { gate: 'plan-safety', violations },
    );
  }
}

/**
 * Gate: a re-planned state must require no further changes.
 *
 * KEEP notes are allowed - they mean the planner found resources outside the
 * blueprint, which is expected and correct.
 *
 * @param {object} plan
 * @returns {{ converged: boolean, remaining: number, changes: object[], notes: string[] }}
 */
export function checkConvergence(plan) {
  const changes = (plan?.actions ?? []).filter((action) => MUTATING_KINDS.has(action.kind));
  return {
    converged: changes.length === 0,
    remaining: changes.length,
    changes,
    notes: plan?.notes ?? [],
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function normalise(value) {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * Resolves the ids of protected resources present in the observed state.
 *
 * Name AND type must both match. Without the type check, the protected voice
 * channel `Genel` would also claim the text channel `#genel`, and the planner's
 * legitimate move of `#genel` would be rejected as a protected-resource edit.
 */
function collectProtectedIds(state, protectedResources) {
  const ids = new Set();
  for (const resource of protectedResources) {
    const pool = resource.type === 'category' ? (state.categories ?? []) : (state.channels ?? []);
    for (const item of pool) {
      if (normalise(item.name) !== normalise(resource.name)) continue;
      if (resource.type !== 'category' && item.type !== resource.type) continue;
      ids.add(item.id);
    }
  }
  return ids;
}

/**
 * The resource type a creation action would produce, or null for anything else.
 * @returns {string|null}
 */
function createdType(action) {
  if (action.kind === ACTION_KINDS.CATEGORY_CREATE) return 'category';
  if (action.kind === ACTION_KINDS.CHANNEL_CREATE) return action.type ?? 'text';
  return null;
}

/** Collects every permission name an action would apply. */
function permissionsIn(action) {
  const permissions = [];

  for (const permission of action.spec?.permissions ?? []) permissions.push(permission);
  for (const permission of action.changes?.addPermissions ?? []) permissions.push(permission);

  for (const overwrite of action.spec?.overwrites ?? []) {
    permissions.push(...(overwrite.allow ?? []), ...(overwrite.deny ?? []));
  }
  for (const edit of action.changes?.overwriteEdits ?? []) {
    permissions.push(...(edit.allow ?? []), ...(edit.deny ?? []));
  }

  return permissions;
}

export { MUTATING_KINDS, ALLOWED_ACTION_KINDS, ROLE_KINDS };
