import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveApply, renderOutcome } from '../src/setup/live-apply.js';
import { buildBlueprint } from '../src/setup/blueprints/index.js';
import { ACTION_KINDS, countMutations, planSetup } from '../src/setup/planner.js';
import { createCapturingLogger } from '../src/utils/logger.js';
import { createFakeSession, miningFoolsSeed } from './helpers/fake-session.js';

const blueprint = buildBlueprint('miningfools');
const GUILD_ID = 'guild-123456789012345678';

/** Config shaped like the real thing, with every gate satisfied. */
function liveConfig(overrides = {}) {
  return {
    env: 'production',
    logLevel: 'debug',
    dryRun: false,
    connect: true,
    discord: {
      token: 'token',
      clientId: '123456789012345678',
      guildId: GUILD_ID,
      expectedGuildName: 'MiningFools',
    },
    ai: { provider: 'stub', apiKey: null, model: null, timeoutMs: 30000 },
    ...overrides,
  };
}

async function run(overrides = {}) {
  const session = overrides.session ?? createFakeSession({ id: GUILD_ID, seed: miningFoolsSeed() });
  const { logger, lines } = createCapturingLogger({ level: 'debug' });
  const printed = [];

  const result = await liveApply({
    config: liveConfig(overrides.config),
    session,
    blueprint,
    confirm: overrides.confirm ?? true,
    logger,
    print: (text) => printed.push(text),
    ...overrides.extra,
  });

  return { result, session, printed: printed.join(''), lines };
}

/* -------------------------------------------------------------------------- */
/* Gate 1 & 2: dual opt-in                                                     */
/* -------------------------------------------------------------------------- */

test('a live apply refuses to run without --confirm', async () => {
  await assert.rejects(
    () => run({ confirm: false }),
    (error) => {
      assert.equal(error.code, 'LIVE_APPLY_ABORTED');
      assert.equal(error.gate, 'confirmation');
      return true;
    },
  );
});

test('a live apply refuses to run while DRY_RUN is true', async () => {
  await assert.rejects(
    () => run({ config: { dryRun: true } }),
    (error) => {
      assert.equal(error.gate, 'dry-run');
      assert.match(error.message, /DRY_RUN is true/);
      return true;
    },
  );
});

test('both opt-ins are checked before anything is written', async () => {
  const session = createFakeSession({ id: GUILD_ID, seed: miningFoolsSeed() });

  await assert.rejects(() => run({ confirm: false, session }));
  await assert.rejects(() => run({ config: { dryRun: true }, session }));

  assert.equal(session.mutationCount(), 0, 'a gate failure still wrote to the guild');
});

/* -------------------------------------------------------------------------- */
/* Gate 3: identity                                                            */
/* -------------------------------------------------------------------------- */

test('a live apply aborts when the guild id does not match', async () => {
  const session = createFakeSession({ id: 'some-other-guild', seed: miningFoolsSeed() });

  await assert.rejects(
    () => run({ session }),
    (error) => {
      assert.equal(error.gate, 'guild-identity');
      return true;
    },
  );
  assert.equal(session.mutationCount(), 0);
});

test('a live apply aborts when the guild name does not match', async () => {
  const session = createFakeSession({ id: GUILD_ID, name: 'Valheim Pomp', seed: miningFoolsSeed() });

  await assert.rejects(
    () => run({ session }),
    (error) => {
      assert.equal(error.gate, 'guild-identity');
      assert.match(error.violations.join(' '), /Valheim Pomp/);
      return true;
    },
  );
  assert.equal(session.mutationCount(), 0);
});

/* -------------------------------------------------------------------------- */
/* Gates 4 & 12: fresh snapshot, plan printed before mutating                  */
/* -------------------------------------------------------------------------- */

test('the plan is recomputed from a fresh snapshot, not replayed', async () => {
  const session = createFakeSession({ id: GUILD_ID, seed: miningFoolsSeed() });
  let refreshes = 0;
  const original = session.refresh.bind(session);
  session.refresh = async () => {
    refreshes += 1;
    return original();
  };

  await run({ session });

  // Once before applying, once to verify convergence.
  assert.equal(refreshes, 2, 'expected a fresh snapshot before and after applying');
});

test('the final plan is printed immediately before mutating', async () => {
  const { printed, result } = await run();

  assert.match(printed, /Setup plan \(blueprint v1\)/);
  assert.match(printed, /CREATE CATEGORY/);
  assert.match(printed, /Protected: voice "Genel"/);
  assert.match(printed, /Target: {4}MiningFools/);
  assert.ok(countMutations(result.plan) > 0);
});

/* -------------------------------------------------------------------------- */
/* Gates 13 & 14: sequential execution, fail-fast                              */
/* -------------------------------------------------------------------------- */

test('a successful apply reports every completed operation', async () => {
  const { result, lines } = await run();

  assert.equal(result.ok, true);
  assert.equal(result.applied, true);
  assert.ok(result.report.counts.applied > 0);
  assert.equal(result.report.counts.failed, undefined);

  // "[n/total] ..." for each completed operation.
  const progress = lines.filter((line) => /\[\d+\/\d+\]/.test(line));
  assert.equal(progress.length, result.report.counts.applied);
  assert.match(progress[0], /\[1\//);
});

test('a failure stops the run immediately and reports what landed', async () => {
  const session = createFakeSession({ id: GUILD_ID, seed: miningFoolsSeed() });
  session.fake.failOnce('createChannel');
  const { result } = await run({ session });

  assert.equal(result.ok, false);
  assert.equal(result.applied, true);
  assert.equal(result.report.counts.failed, 1);
  assert.ok(result.failure, 'the failure was not reported');
  assert.equal(result.failure.status, 'failed');
  assert.match(result.failure.detail, /simulated failure/);
  assert.equal(result.verification, null, 'a failed run must not claim convergence');
});

test('a failure reports exactly what succeeded before it', async () => {
  const session = createFakeSession({ id: GUILD_ID, seed: miningFoolsSeed() });
  session.fake.failOnce('createChannel');
  const { result, printed } = await run({ session });

  const outcome = renderOutcome(result);
  assert.match(outcome, /APPLY FAILED/);
  assert.match(outcome, /succeeded: \d+/);
  assert.match(outcome, /Nothing was rolled back/);

  const applied = result.report.results.filter((r) => r.status === 'applied');
  assert.ok(applied.length > 0, 'nothing succeeded before the failure');
  assert.ok(printed.length > 0);
});

test('fail-fast means no further operations are attempted after an error', async () => {
  const session = createFakeSession({ id: GUILD_ID, seed: miningFoolsSeed() });
  session.fake.failOnce('createChannel');

  const { result } = await run({ session });
  const attempted = result.report.results.filter((r) => r.status === 'applied' || r.status === 'failed').length;
  const planned = countMutations(result.plan);

  assert.ok(attempted < planned, `kept going after the failure: ${attempted} of ${planned} attempted`);
});

/* -------------------------------------------------------------------------- */
/* Gates 15 & 16: convergence verification                                     */
/* -------------------------------------------------------------------------- */

test('a successful apply converges: a second plan has zero mutations', async () => {
  const { result, session } = await run();

  assert.equal(result.verification.converged, true);
  assert.equal(result.verification.remaining, 0);
  assert.equal(countMutations(planSetup(blueprint, session.state())), 0);
});

test('KEEP notes are allowed in the converged state', async () => {
  const { result } = await run();
  const keeps = result.verification.notes.join(' ');

  assert.match(keeps, /preserved/);
});

test('an already-converged guild is a no-op', async () => {
  const first = await run();
  assert.equal(first.result.ok, true);

  // Re-run against the same (now converged) session.
  const second = await run({ session: first.session });

  assert.equal(second.result.applied, false);
  assert.equal(second.result.ok, true);
  assert.match(renderOutcome(second.result), /Already converged/);
});

test('the outcome report states the convergence result', async () => {
  const { result } = await run();
  const outcome = renderOutcome(result);

  assert.match(outcome, /APPLY COMPLETE/);
  assert.match(outcome, /second plan requires: 0 change\(s\)/);
  assert.match(outcome, /status: CONVERGED/);
});

/* -------------------------------------------------------------------------- */
/* Preservation guarantees                                                     */
/* -------------------------------------------------------------------------- */

test('existing #genel is moved and reused, never recreated', async () => {
  const { session, result } = await run();

  const created = result.plan.actions.filter(
    (action) => action.kind === ACTION_KINDS.CHANNEL_CREATE && action.name === 'genel',
  );
  assert.equal(created.length, 0, '#genel was recreated');

  const moved = result.plan.actions.find(
    (action) => action.kind === ACTION_KINDS.CHANNEL_UPDATE && action.name === 'genel',
  );
  assert.equal(moved.id, 'chan-genel', 'the existing channel id was not reused');

  const after = session.state().channels.find((channel) => channel.name === 'genel');
  assert.equal(after.id, 'chan-genel', 'the channel id changed during apply');
  assert.equal(after.parentName, '⛏️ MININGFOOLS');
});

test('the existing "Genel" voice channel is never modified', async () => {
  const { session, result } = await run();

  // No action may target it, by id or by creation of a same-named voice channel.
  const byId = result.plan.actions.filter((action) => action.id === 'chan-ses-genel');
  assert.deepEqual(byId, [], 'an action targeted the protected voice channel');
  const byName = result.plan.actions.filter(
    (action) => action.kind === ACTION_KINDS.CHANNEL_CREATE && action.name.toLowerCase() === 'genel',
  );
  assert.deepEqual(byName, [], 'a duplicate "Genel" channel would be created');

  const voice = session.state().channels.find((channel) => channel.id === 'chan-ses-genel');
  assert.ok(voice, 'the "Genel" voice channel disappeared');
  assert.equal(voice.name, 'Genel');
  assert.equal(voice.parentName, 'Ses Kanalları', 'the voice channel was moved');
});

test('protected resources are reported as KEEP rather than silently ignored', async () => {
  const { result } = await run();
  const kept = result.plan.actions
    .filter((action) => action.kind === ACTION_KINDS.KEEP)
    .map((action) => action.name);

  for (const name of ['Genel', 'Metin Kanalları', 'Ses Kanalları']) {
    assert.ok(kept.includes(name), `"${name}" was not reported as preserved`);
  }
  assert.equal(kept.length, 3, `expected exactly 3 keeps, got ${kept.length}: ${kept.join(', ')}`);
});

test('"Metin Kanalları" and "Ses Kanalları" survive the apply', async () => {
  const { session } = await run();
  const categories = session.state().categories.map((category) => category.name);

  assert.ok(categories.includes('Metin Kanalları'));
  assert.ok(categories.includes('Ses Kanalları'));
});

test('no role is created, modified or removed', async () => {
  const { session, result } = await run();

  assert.equal(session.state().roles.length, 0);
  assert.equal(result.plan.actions.filter((a) => a.kind.startsWith('role.')).length, 0);
});

test('nothing is ever deleted: the guild only grows', async () => {
  const before = createFakeSession({ id: GUILD_ID, seed: miningFoolsSeed() });
  const beforeIds = new Set([
    ...before.state().categories.map((c) => c.id),
    ...before.state().channels.map((c) => c.id),
  ]);

  const { session } = await run({ session: before });
  const afterIds = new Set([
    ...session.state().categories.map((c) => c.id),
    ...session.state().channels.map((c) => c.id),
  ]);

  for (const id of beforeIds) {
    assert.ok(afterIds.has(id), `resource ${id} was removed`);
  }
  assert.ok(afterIds.size > beforeIds.size, 'nothing was created');
});

test('the plan contains no destructive action kind', async () => {
  const { result } = await run();

  for (const action of result.plan.actions) {
    assert.ok(!/delete|destroy|remove|purge/i.test(action.kind), `destructive action ${action.kind}`);
  }
});
