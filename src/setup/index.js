import { createNullLogger } from '../utils/logger.js';
import { buildBlueprint } from './blueprints/index.js';
import { snapshotGuild, emptyGuildState } from './state.js';
import { planSetup } from './planner.js';
import { applyPlan } from './apply.js';
import { createDiscordGuildAdapter } from './adapter.js';

export {
  buildBlueprint,
  validateBlueprint,
  listBlueprints,
  describeBlueprints,
  hasBlueprint,
  BLUEPRINT_VERSION,
  EVERYONE,
  DEFAULT_BLUEPRINT,
} from './blueprint.js';
export { buildSnapshotDocument, captureGuildSnapshot, SNAPSHOT_VERSION } from './snapshot.js';
export { createDiscordSession, connectClient } from './session.js';
export { liveApply, renderOutcome } from './live-apply.js';
export {
  assertGuildMatches,
  assertPlanIsSafe,
  checkConvergence,
  PROTECTED_RESOURCES,
  FORBIDDEN_PERMISSIONS,
} from './safety.js';
export { LiveApplyAbort } from './errors.js';
export { planSetup, assertNoDestructiveActions, countMutations, ACTION_KINDS } from './planner.js';
export { applyPlan } from './apply.js';
export { renderPlan } from './render.js';
export { snapshotGuild, emptyGuildState, channelTypeName, CHANNEL_TYPES } from './state.js';
export { resolveOverwrites, mergeRules, rulesEqual } from './permissions.js';
export { createDiscordGuildAdapter, hexToInt } from './adapter.js';

/**
 * End-to-end server setup: observe, plan, apply.
 *
 * Idempotent by construction - the planner emits work only for differences, so
 * running this repeatedly converges instead of duplicating. Nothing is ever
 * deleted, and `dryRun` (the default) writes nothing at all.
 *
 * @param {object} [options]
 * @param {object} [options.blueprint] Defaults to the built-in Valheim blueprint.
 * @param {import('discord.js').Guild|null} [options.guild] Live guild. When given,
 *   the state snapshot and the adapter are derived from it automatically.
 * @param {object|null} [options.state] Pre-observed state. Use instead of `guild`
 *   when planning against a saved snapshot or a test double.
 * @param {object|null} [options.adapter] Guild adapter. Required for a real apply
 *   unless `guild` was supplied.
 * @param {boolean} [options.dryRun] Defaults to true.
 * @param {object} [options.logger]
 * @returns {Promise<{ plan: object, report: object, state: object }>}
 */
export async function runSetup({
  blueprint = buildBlueprint(),
  guild = null,
  state = null,
  adapter = null,
  dryRun = true,
  logger = createNullLogger(),
} = {}) {
  const observed = state ?? (guild ? snapshotGuild(guild) : emptyGuildState());
  const target = adapter ?? (guild ? createDiscordGuildAdapter(guild) : null);

  const plan = planSetup(blueprint, observed);
  const report = await applyPlan(plan, { adapter: target, dryRun, logger });
  return { plan, report, state: observed };
}
