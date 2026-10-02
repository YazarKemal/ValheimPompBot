import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPlan } from '../src/setup/apply.js';
import { buildBlueprint } from '../src/setup/blueprint.js';
import { ACTION_KINDS, countMutations, planSetup } from '../src/setup/planner.js';
import { runSetup } from '../src/setup/index.js';
import { renderPlan } from '../src/setup/render.js';
import { createCapturingLogger, createNullLogger } from '../src/utils/logger.js';
import { createFakeGuild } from './helpers/fake-guild.js';

const blueprint = buildBlueprint('valheim');

/* -------------------------------------------------------------------------- */
/* Dry run                                                                     */
/* -------------------------------------------------------------------------- */

test('a dry run writes nothing even when an adapter is supplied', async () => {
  const guild = createFakeGuild();
  const plan = planSetup(blueprint, guild.snapshot());

  const report = await applyPlan(plan, { adapter: guild.adapter, dryRun: true, logger: createNullLogger() });

  assert.equal(report.dryRun, true);
  assert.equal(report.applied, false);
  assert.equal(guild.mutationCount(), 0);
  assert.equal(guild.roles.length, 0);
  assert.equal(guild.channels.length, 0);
});

test('a dry run still reports exactly what would happen', async () => {
  const guild = createFakeGuild();
  const plan = planSetup(blueprint, guild.snapshot());

  const report = await applyPlan(plan, { adapter: guild.adapter, dryRun: true, logger: createNullLogger() });

  assert.equal(report.counts.planned, countMutations(plan));
  assert.ok(report.results.length > 0);
  assert.ok(report.results.every((result) => result.status === 'planned'));
});

test('dryRun defaults to true', async () => {
  const guild = createFakeGuild();
  const plan = planSetup(blueprint, guild.snapshot());

  const report = await applyPlan(plan, { adapter: guild.adapter });

  assert.equal(report.applied, false);
  assert.equal(guild.mutationCount(), 0);
});

/* -------------------------------------------------------------------------- */
/* Apply                                                                       */
/* -------------------------------------------------------------------------- */

test('applying a plan against an empty guild creates everything', async () => {
  const guild = createFakeGuild();
  const plan = planSetup(blueprint, guild.snapshot());

  const report = await applyPlan(plan, { adapter: guild.adapter, dryRun: false, logger: createNullLogger() });

  assert.equal(report.applied, true);
  assert.equal(report.counts.failed, undefined, JSON.stringify(report.results.filter((r) => r.status === 'failed')));
  assert.equal(guild.roles.length, blueprint.roles.length);
  assert.equal(guild.categories.length, blueprint.categories.length);
  assert.equal(guild.channels.length, blueprint.channels.length);
});

test('roles are created with the permissions the blueprint declares', async () => {
  const guild = createFakeGuild();
  await applyPlan(planSetup(blueprint, guild.snapshot()), {
    adapter: guild.adapter,
    dryRun: false,
    logger: createNullLogger(),
  });

  const chieftain = guild.roles.find((role) => role.name === 'Chieftain');
  assert.ok(chieftain);
  assert.equal(chieftain.color, '#c0392b');
  assert.equal(chieftain.hoist, true);
  assert.ok(chieftain.permissions.includes('ManageGuild'));
});

test('private channels are created with their access rules', async () => {
  const guild = createFakeGuild();
  await applyPlan(planSetup(blueprint, guild.snapshot()), {
    adapter: guild.adapter,
    dryRun: false,
    logger: createNullLogger(),
  });

  const staffChat = guild.channels.find((channel) => channel.name === 'staff-chat');
  const everyone = staffChat.overwrites.find((rule) => rule.role === '@everyone');

  assert.ok(everyone, 'staff-chat has no @everyone overwrite');
  assert.ok(everyone.deny.includes('ViewChannel'));
});

/* -------------------------------------------------------------------------- */
/* Idempotency - the core promise of the setup module                          */
/* -------------------------------------------------------------------------- */

test('re-planning after an apply produces no further work', async () => {
  const guild = createFakeGuild();

  await applyPlan(planSetup(blueprint, guild.snapshot()), {
    adapter: guild.adapter,
    dryRun: false,
    logger: createNullLogger(),
  });

  const secondPlan = planSetup(blueprint, guild.snapshot());
  const remaining = secondPlan.actions.filter((action) => action.kind !== ACTION_KINDS.SKIP);

  assert.equal(
    countMutations(secondPlan),
    0,
    `second pass still wants to change: ${JSON.stringify(remaining, null, 2)}`,
  );
});

test('a third apply is a no-op and does not duplicate resources', async () => {
  const guild = createFakeGuild();

  for (let pass = 0; pass < 3; pass += 1) {
    await applyPlan(planSetup(blueprint, guild.snapshot()), {
      adapter: guild.adapter,
      dryRun: false,
      logger: createNullLogger(),
    });
  }

  assert.equal(guild.roles.length, blueprint.roles.length, 'roles were duplicated');
  assert.equal(guild.categories.length, blueprint.categories.length, 'categories were duplicated');
  assert.equal(guild.channels.length, blueprint.channels.length, 'channels were duplicated');
});

test('runSetup is idempotent end to end', async () => {
  const guild = createFakeGuild();

  const first = await runSetup({ blueprint, state: guild.snapshot(), adapter: guild.adapter, dryRun: false });
  const second = await runSetup({ blueprint, state: guild.snapshot(), adapter: guild.adapter, dryRun: false });

  assert.ok(countMutations(first.plan) > 0);
  assert.equal(countMutations(second.plan), 0);
  assert.equal(second.report.counts.applied, undefined);
});

/* -------------------------------------------------------------------------- */
/* Non-destructive guarantees                                                  */
/* -------------------------------------------------------------------------- */

test('an apply never removes resources it did not create', async () => {
  const guild = createFakeGuild({
    roles: [{ id: 'role-ancient', name: 'Ancient One', permissions: [] }],
    channels: [{ id: 'chan-legacy', name: 'legacy-chat', type: 'text', parentName: null, overwrites: [] }],
  });

  await applyPlan(planSetup(blueprint, guild.snapshot()), {
    adapter: guild.adapter,
    dryRun: false,
    logger: createNullLogger(),
  });

  assert.ok(guild.roles.some((role) => role.name === 'Ancient One'), 'an existing role was removed');
  assert.ok(guild.channels.some((channel) => channel.name === 'legacy-chat'), 'an existing channel was removed');
});

test('a manually added permission survives an apply', async () => {
  const guild = createFakeGuild({
    roles: [{ id: 'role-elder', name: 'Elder', color: '#000000', permissions: ['Administrator'] }],
  });

  await applyPlan(planSetup(blueprint, guild.snapshot()), {
    adapter: guild.adapter,
    dryRun: false,
    logger: createNullLogger(),
  });

  const elder = guild.roles.find((role) => role.name === 'Elder');
  assert.ok(elder.permissions.includes('Administrator'), 'a manually granted permission was stripped');
  assert.ok(elder.permissions.includes('KickMembers'), 'blueprint permissions were not added');
});

test('a plan containing a destructive action is refused outright', async () => {
  const guild = createFakeGuild();

  await assert.rejects(
    () =>
      applyPlan(
        { version: 1, actions: [{ kind: 'channel.delete', name: 'general' }], summary: {} },
        { adapter: guild.adapter, dryRun: false, logger: createNullLogger() },
      ),
    /destructive/,
  );

  assert.equal(guild.mutationCount(), 0);
});

/* -------------------------------------------------------------------------- */
/* Failure handling                                                            */
/* -------------------------------------------------------------------------- */

test('one failing action does not abort the rest of the run', async () => {
  const guild = createFakeGuild();
  guild.failOnce('createRole');
  const plan = planSetup(blueprint, guild.snapshot());

  const report = await applyPlan(plan, { adapter: guild.adapter, dryRun: false, logger: createNullLogger() });

  assert.equal(report.counts.failed, 1);
  assert.ok(report.counts.applied > 0, 'the run stopped after the first failure');
  assert.equal(guild.channels.length, blueprint.channels.length, 'channels were not created after the role failure');
});

test('stopOnError halts at the first failure instead of pressing on', async () => {
  const guild = createFakeGuild();
  guild.failOnce('createRole');

  const report = await applyPlan(planSetup(blueprint, guild.snapshot()), {
    adapter: guild.adapter,
    dryRun: false,
    logger: createNullLogger(),
    stopOnError: true,
  });

  assert.equal(report.counts.failed, 1);
  assert.equal(report.counts.applied, undefined, 'kept going after the first failure');
  assert.equal(guild.channels.length, 0, 'later operations ran after the failure');
});

test('every completed operation is logged, in order', async () => {
  const { logger, lines } = createCapturingLogger({ level: 'info' });
  const guild = createFakeGuild();

  const report = await applyPlan(planSetup(blueprint, guild.snapshot()), {
    adapter: guild.adapter,
    dryRun: false,
    logger,
    stopOnError: true,
  });

  const progress = lines.filter((line) => /\[\d+\/\d+\]/.test(line));
  assert.equal(progress.length, report.counts.applied);
  assert.match(progress[0], /\[1\//);
  assert.match(progress.at(-1), new RegExp(`\\[${report.counts.applied}\\/${report.counts.applied}\\]`));
});

test('a dry run logs no per-operation progress', async () => {
  const { logger, lines } = createCapturingLogger({ level: 'info' });
  const guild = createFakeGuild();

  await applyPlan(planSetup(blueprint, guild.snapshot()), {
    adapter: guild.adapter,
    dryRun: true,
    logger,
  });

  assert.equal(lines.filter((line) => /\[\d+\/\d+\]/.test(line)).length, 0);
});

test('a failure is reported with its reason', async () => {
  const guild = createFakeGuild();
  guild.failOnce('createChannel');

  const report = await applyPlan(planSetup(blueprint, guild.snapshot()), {
    adapter: guild.adapter,
    dryRun: false,
    logger: createNullLogger(),
  });

  const failure = report.results.find((result) => result.status === 'failed');
  assert.ok(failure);
  assert.match(failure.detail, /simulated failure/);
});

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

test('renderPlan produces a readable preview of both plans', () => {
  const fresh = renderPlan(planSetup(blueprint, createFakeGuild().snapshot()));

  assert.match(fresh, /Setup plan \(blueprint v1\)/);
  assert.match(fresh, /CREATE ROLE/);
  assert.match(fresh, /CREATE CHANNEL/);

  const guild = createFakeGuild();
  const empty = renderPlan({ version: 1, actions: [], summary: {}, notes: [] });
  assert.match(empty, /Nothing to do/);
  assert.ok(guild.mutationCount() === 0);
});
