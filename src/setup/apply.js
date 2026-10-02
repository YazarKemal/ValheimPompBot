import { createNullLogger } from '../utils/logger.js';
import { formatError } from '../utils/errors.js';
import { ACTION_KINDS, assertNoDestructiveActions } from './planner.js';

/**
 * Executes a plan produced by the planner.
 *
 * Safety properties:
 *  - A dry run never touches the adapter, and reports exactly what a real run
 *    would do.
 *  - There is no delete path: the only adapter methods reachable from here are
 *    create/update calls.
 *  - A failing action is recorded. By default the run continues, because setup
 *    is idempotent and re-running retries whatever did not land; pass
 *    `stopOnError` for the live path, which must halt at the first failure.
 */

const MUTATING_KINDS = new Set([
  ACTION_KINDS.ROLE_CREATE,
  ACTION_KINDS.ROLE_UPDATE,
  ACTION_KINDS.CATEGORY_CREATE,
  ACTION_KINDS.CHANNEL_CREATE,
  ACTION_KINDS.CHANNEL_UPDATE,
]);

/**
 * @param {object} plan
 * @param {object} [options]
 * @param {object|null} [options.adapter] Guild adapter. Required unless dry-running.
 * @param {object} [options.logger]
 * @param {boolean} [options.dryRun] Defaults to true - writing must be opt-in.
 * @param {boolean} [options.stopOnError] Halt at the first failure instead of
 *   continuing. Used by the live apply path.
 * @returns {Promise<{ dryRun: boolean, applied: boolean, counts: object, results: object[] }>}
 */
export async function applyPlan(
  plan,
  { adapter = null, logger = createNullLogger(), dryRun = true, stopOnError = false } = {},
) {
  const destructive = assertNoDestructiveActions(plan);
  if (destructive.length > 0) {
    throw new Error(`Refusing to apply a destructive plan: ${destructive.join('; ')}`);
  }

  const mutating = plan.actions.filter((action) => MUTATING_KINDS.has(action.kind));

  if (dryRun || !adapter) {
    logger.info(`Dry run: ${mutating.length} change(s) would be applied, nothing was written.`);
    return {
      dryRun: true,
      applied: false,
      counts: summariseResults(mutating.map((action) => ({ action, status: 'planned' }))),
      results: mutating.map((action) => ({
        kind: action.kind,
        name: action.name,
        status: 'planned',
        detail: describeAction(action),
      })),
    };
  }

  const results = [];
  let position = 0;

  for (const action of plan.actions) {
    if (!MUTATING_KINDS.has(action.kind)) {
      // KEEP / SKIP / WARN notes are informational - nothing is written.
      results.push({ kind: action.kind, name: action.name, status: 'noted', detail: action.reason });
      continue;
    }

    position += 1;
    // Operations run strictly sequentially, one awaited call at a time.
    try {
      await executeAction(adapter, action);
      results.push({ kind: action.kind, name: action.name, status: 'applied', detail: describeAction(action) });
      logger.info(`[${position}/${mutating.length}] ${describeAction(action)}`);
    } catch (error) {
      results.push({ kind: action.kind, name: action.name, status: 'failed', detail: formatError(error) });
      logger.error(`Setup action "${action.kind}" failed for "${action.name}".`, error);
      if (stopOnError) break;
    }
  }

  return { dryRun: false, applied: true, counts: summariseResults(results), results };
}

/**
 * @param {object} adapter
 * @param {object} action
 */
async function executeAction(adapter, action) {
  switch (action.kind) {
    case ACTION_KINDS.ROLE_CREATE:
      return adapter.createRole(action.spec);
    case ACTION_KINDS.ROLE_UPDATE:
      return adapter.updateRole(action.id, action.changes);
    case ACTION_KINDS.CATEGORY_CREATE:
      return adapter.createCategory(action.spec);
    case ACTION_KINDS.CHANNEL_CREATE:
      return adapter.createChannel(action.spec);
    case ACTION_KINDS.CHANNEL_UPDATE:
      return adapter.updateChannel(action.id, action.changes);
    default:
      throw new Error(`No executor for action kind "${action.kind}".`);
  }
}

function describeAction(action) {
  switch (action.kind) {
    case ACTION_KINDS.ROLE_CREATE:
      return `create role "${action.spec.name}"`;
    case ACTION_KINDS.ROLE_UPDATE:
      return `update role "${action.name}": ${Object.keys(action.changes).join(', ')}`;
    case ACTION_KINDS.CATEGORY_CREATE:
      return `create category "${action.spec.name}"`;
    case ACTION_KINDS.CHANNEL_CREATE:
      return `create ${action.type} channel "${action.spec.name}" in "${action.parentName ?? 'no category'}"`;
    case ACTION_KINDS.CHANNEL_UPDATE:
      return `update channel "${action.name}": ${Object.keys(action.changes).join(', ')}`;
    default:
      return action.reason ?? '';
  }
}

function summariseResults(results) {
  const counts = {};
  for (const result of results) {
    counts[result.status] = (counts[result.status] ?? 0) + 1;
  }
  return counts;
}
