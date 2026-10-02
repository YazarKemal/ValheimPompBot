import { createNullLogger } from '../utils/logger.js';
import { applyPlan } from './apply.js';
import { countMutations, planSetup } from './planner.js';
import { renderPlan } from './render.js';
import { assertGuildMatches, assertPlanIsSafe, checkConvergence, PROTECTED_RESOURCES } from './safety.js';
import { LiveApplyAbort } from './errors.js';

/**
 * Live apply pipeline.
 *
 * Ordered gates, each of which aborts before anything is written:
 *
 *   1. confirmation   `--confirm` was passed explicitly
 *   2. dry-run        DRY_RUN is false
 *   3. identity       the connected guild is the configured MiningFools guild
 *   4. fresh state    a NEW snapshot is taken now, and the plan recomputed from
 *                     it - the reviewed plan is never replayed blindly
 *   5. plan safety    no deletes, no role mutations, no protected resource
 *                     touched, no privileged permission, no unknown action
 *   6. preview        the final plan is printed immediately before mutating
 *
 * Then: sequential fail-fast execution, a fresh read-only snapshot afterwards,
 * and a convergence check proving a second plan needs zero changes.
 */

/**
 * @param {object} options
 * @param {object} options.config Parsed configuration.
 * @param {object} options.session Live session (see session.js).
 * @param {object} [options.blueprint]
 * @param {boolean} [options.confirm] The explicit CLI confirmation flag.
 * @param {object} [options.logger]
 * @param {(text: string) => void} [options.print] Where the pre-apply preview goes.
 * @returns {Promise<{ ok: boolean, applied: boolean, plan: object, report: object|null, verification: object|null, failure: object|null }>}
 */
export async function liveApply({
  config,
  session,
  blueprint,
  confirm = false,
  logger = createNullLogger(),
  print = () => {},
}) {
  const startedAt = Date.now();

  /* -- Gate 1: explicit confirmation ------------------------------------- */
  if (!confirm) {
    throw new LiveApplyAbort(
      'Refusing to apply: the --confirm flag is required for a live run.',
      { gate: 'confirmation' },
    );
  }

  /* -- Gate 2: dry run must be off --------------------------------------- */
  if (config.dryRun) {
    throw new LiveApplyAbort(
      'Refusing to apply: DRY_RUN is true. Set DRY_RUN=false in .env to allow a live run.',
      { gate: 'dry-run' },
    );
  }

  /* -- Gate 3: identity --------------------------------------------------- */
  assertGuildMatches(session.guild, {
    guildId: config.discord.guildId,
    expectedName: config.discord.expectedGuildName,
  });

  /* -- Gate 4: fresh snapshot, plan recomputed from it -------------------- */
  logger.info('Fetching a fresh snapshot before planning.');
  const before = await session.refresh();
  const plan = planSetup(blueprint, before);

  /* -- Gate 5: plan safety ------------------------------------------------ */
  assertPlanIsSafe(plan, { state: before });

  /* -- Gate 6: preview ---------------------------------------------------- */
  const total = countMutations(plan);
  print(renderPlan(plan));
  print('\n');
  print(`Protected: ${PROTECTED_RESOURCES.map((r) => `${r.type} "${r.name}"`).join(', ')}\n`);
  print(`Target:    ${session.guild.name} (${session.guild.id})\n\n`);

  logger.info('Plan approved by all safety gates.', { mutations: total, guild: session.guild.name });

  if (total === 0) {
    logger.info('Nothing to do: the guild already matches the blueprint.');
    return {
      ok: true,
      applied: false,
      plan,
      report: null,
      verification: checkConvergence(plan),
      failure: null,
    };
  }

  /* -- Sequential, fail-fast execution ------------------------------------ */
  logger.info(`Applying ${total} change(s) sequentially.`);
  const report = await applyPlan(plan, {
    adapter: session.adapter,
    dryRun: false,
    logger,
    stopOnError: true,
  });

  if (report.counts.failed) {
    const failure = report.results.find((result) => result.status === 'failed');
    const succeeded = report.results.filter((result) => result.status === 'applied');
    logger.error('Apply stopped at the first failure.', {
      succeeded: succeeded.length,
      failed: failure?.name,
    });
    return { ok: false, applied: true, plan, report, verification: null, failure };
  }

  /* -- Convergence verification ------------------------------------------- */
  logger.info('Apply finished. Re-reading the guild to verify convergence.');
  const after = await session.refresh();
  const verification = checkConvergence(planSetup(blueprint, after));

  if (verification.converged) {
    logger.info('Converged: a second plan needs no changes.', {
      applied: report.counts.applied,
      kept: plan.summary.keep ?? 0,
      elapsedMs: Date.now() - startedAt,
    });
  } else {
    logger.error('Not converged: a second plan still wants changes.', {
      remaining: verification.remaining,
      changes: verification.changes.map((action) => `${action.kind} ${action.name}`),
    });
  }

  return { ok: verification.converged, applied: true, plan, report, verification, failure: null };
}

/**
 * Renders a human-readable outcome report for the console.
 * @param {object} result
 * @returns {string}
 */
export function renderOutcome(result) {
  const lines = [];

  if (result.failure) {
    lines.push('');
    lines.push('APPLY FAILED - stopped at the first error.');
    lines.push('-'.repeat(60));
    const succeeded = result.report.results.filter((r) => r.status === 'applied');
    lines.push(`  succeeded: ${succeeded.length}`);
    for (const item of succeeded) lines.push(`    ok    ${item.kind} ${item.name}`);
    lines.push(`  failed:    ${result.failure.kind} ${result.failure.name}`);
    lines.push(`    ${String(result.failure.detail).split('\n')[0]}`);
    lines.push('');
    lines.push('  Nothing was rolled back. Setup is idempotent: fix the cause and');
    lines.push('  re-run the same command - completed work is skipped.');
    return `${lines.join('\n')}\n`;
  }

  if (!result.applied) {
    lines.push('\nAlready converged. Nothing was written.\n');
    return lines.join('\n');
  }

  lines.push('');
  lines.push('APPLY COMPLETE');
  lines.push('-'.repeat(60));
  lines.push(`  applied:   ${result.report.counts.applied ?? 0}`);
  lines.push(`  kept:      ${result.plan.summary.keep ?? 0} (outside the blueprint, preserved)`);
  lines.push('');
  lines.push('  Convergence check');
  lines.push(`    second plan requires: ${result.verification.remaining} change(s)`);
  lines.push(`    status: ${result.verification.converged ? 'CONVERGED' : 'NOT CONVERGED'}`);

  if (result.verification.notes.length > 0) {
    for (const note of result.verification.notes) lines.push(`    - ${note}`);
  }
  return `${lines.join('\n')}\n`;
}
