import { ACTION_KINDS } from './planner.js';

/**
 * Human-readable rendering of a plan. Kept separate from the planner so the
 * plan itself stays pure data that is easy to assert on in tests.
 */

const LABELS = Object.freeze({
  [ACTION_KINDS.ROLE_CREATE]: 'CREATE ROLE',
  [ACTION_KINDS.ROLE_UPDATE]: 'UPDATE ROLE',
  [ACTION_KINDS.CATEGORY_CREATE]: 'CREATE CATEGORY',
  [ACTION_KINDS.CHANNEL_CREATE]: 'CREATE CHANNEL',
  [ACTION_KINDS.CHANNEL_UPDATE]: 'UPDATE CHANNEL',
  [ACTION_KINDS.SKIP]: 'ok',
  [ACTION_KINDS.KEEP]: 'keep',
  [ACTION_KINDS.WARN]: 'WARN',
});

/**
 * @param {object} plan
 * @returns {string} multi-line preview
 */
export function renderPlan(plan) {
  const lines = [];
  lines.push(`Setup plan (blueprint v${plan.version})`);
  lines.push('='.repeat(60));

  const changes = plan.actions.filter((action) => action.kind !== ACTION_KINDS.SKIP);
  const skips = plan.actions.filter((action) => action.kind === ACTION_KINDS.SKIP);

  if (changes.length === 0) {
    lines.push('Everything already matches the blueprint. Nothing to do.');
  } else {
    for (const action of changes) {
      lines.push(`  ${(LABELS[action.kind] ?? action.kind).padEnd(16)} ${renderAction(action)}`);
    }
  }

  lines.push('');
  lines.push('Summary');
  lines.push('-'.repeat(60));
  for (const [kind, count] of Object.entries(plan.summary).sort()) {
    lines.push(`  ${String(count).padStart(3)}  ${kind}`);
  }
  lines.push(`  ${String(skips.length).padStart(3)}  already matching (not shown above)`);

  if (plan.notes.length > 0) {
    lines.push('');
    lines.push('Notes');
    lines.push('-'.repeat(60));
    for (const note of plan.notes) lines.push(`  - ${note}`);
  }

  return lines.join('\n');
}

function renderAction(action) {
  switch (action.kind) {
    case ACTION_KINDS.ROLE_CREATE:
      return `"${action.spec.name}" (${action.spec.permissions.length} permission(s))`;
    case ACTION_KINDS.ROLE_UPDATE:
      return `"${action.name}" -> ${summariseChanges(action.changes)}`;
    case ACTION_KINDS.CATEGORY_CREATE:
      return `"${action.spec.name}"`;
    case ACTION_KINDS.CHANNEL_CREATE:
      return `${action.type} "${action.spec.name}" in "${action.parentName ?? 'no category'}"`;
    case ACTION_KINDS.CHANNEL_UPDATE:
      return `"${action.name}" -> ${summariseChanges(action.changes)}`;
    case ACTION_KINDS.KEEP:
      return `${action.resource} "${action.name}": ${action.reason}`;
    case ACTION_KINDS.WARN:
      return `${action.resource} "${action.name}": ${action.reason}`;
    default:
      return `${action.name ?? ''} ${action.reason ?? ''}`.trim();
  }
}

function summariseChanges(changes) {
  const parts = [];
  for (const [field, value] of Object.entries(changes)) {
    if (field === 'overwriteEdits') parts.push(`${value.length} permission overwrite(s)`);
    else if (field === 'addPermissions') parts.push(`${value.length} permission(s) to add`);
    else parts.push(`${field}=${JSON.stringify(value)}`);
  }
  return parts.join(', ');
}
