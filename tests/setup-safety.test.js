import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertGuildMatches,
  assertPlanIsSafe,
  checkConvergence,
  FORBIDDEN_PERMISSIONS,
  PROTECTED_RESOURCES,
} from '../src/setup/safety.js';
import { buildBlueprint } from '../src/setup/blueprints/index.js';
import { ACTION_KINDS, planSetup } from '../src/setup/planner.js';
import { emptyGuildState } from '../src/setup/state.js';
import { miningFoolsSeed } from './helpers/fake-session.js';

const blueprint = buildBlueprint('miningfools');
const seedState = {
  roles: [],
  categories: miningFoolsSeed().categories,
  channels: miningFoolsSeed().channels,
};

/** Asserts the gate fired, and returns the abort for further inspection. */
function expectAbort(fn, gate) {
  let thrown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, 'expected the gate to abort');
  assert.equal(thrown.code, 'LIVE_APPLY_ABORTED');
  assert.equal(thrown.gate, gate);
  assert.ok(thrown.violations.length > 0, 'an abort must carry its evidence');
  return thrown;
}

/* -------------------------------------------------------------------------- */
/* Gate: guild identity                                                        */
/* -------------------------------------------------------------------------- */

test('the guild gate accepts the configured guild', () => {
  assert.doesNotThrow(() =>
    assertGuildMatches(
      { id: 'g1', name: 'MiningFools' },
      { guildId: 'g1', expectedName: 'MiningFools' },
    ),
  );
});

test('the guild gate matches the name case-insensitively and ignores padding', () => {
  assert.doesNotThrow(() =>
    assertGuildMatches(
      { id: 'g1', name: '  miningfools ' },
      { guildId: 'g1', expectedName: 'MiningFools' },
    ),
  );
});

test('the guild gate aborts on an id mismatch', () => {
  const abort = expectAbort(
    () => assertGuildMatches({ id: 'other', name: 'MiningFools' }, { guildId: 'g1', expectedName: 'MiningFools' }),
    'guild-identity',
  );
  assert.match(abort.violations.join(' '), /does not equal DISCORD_GUILD_ID/);
});

test('the guild gate aborts on a name mismatch', () => {
  const abort = expectAbort(
    () => assertGuildMatches({ id: 'g1', name: 'Valheim Pomp' }, { guildId: 'g1', expectedName: 'MiningFools' }),
    'guild-identity',
  );
  assert.match(abort.violations.join(' '), /does not match expected/);
});

test('the guild gate aborts when no guild id is configured', () => {
  expectAbort(() => assertGuildMatches({ id: 'g1', name: 'MiningFools' }, { guildId: null }), 'guild-identity');
});

test('the guild gate skips the name check when none is configured', () => {
  assert.doesNotThrow(() => assertGuildMatches({ id: 'g1', name: 'anything' }, { guildId: 'g1', expectedName: null }));
});

/* -------------------------------------------------------------------------- */
/* Gate: plan safety                                                           */
/* -------------------------------------------------------------------------- */

test('a clean MiningFools plan passes every safety gate', () => {
  assert.doesNotThrow(() => assertPlanIsSafe(planSetup(blueprint, emptyGuildState())));
  assert.doesNotThrow(() => assertPlanIsSafe(planSetup(blueprint, seedState), { state: seedState }));
});

test('the plan-safety gate rejects a destructive action', () => {
  const abort = expectAbort(
    () =>
      assertPlanIsSafe({
        actions: [{ kind: 'channel.delete', name: 'genel' }],
      }),
    'plan-safety',
  );
  assert.match(abort.violations.join(' '), /destructive action/);
});

test('the plan-safety gate rejects role mutations', () => {
  for (const kind of [ACTION_KINDS.ROLE_CREATE, ACTION_KINDS.ROLE_UPDATE]) {
    const abort = expectAbort(
      () => assertPlanIsSafe({ actions: [{ kind, name: 'Yönetici', spec: {}, changes: {} }] }),
      'plan-safety',
    );
    assert.match(abort.violations.join(' '), /role mutation/);
  }
});

test('the plan-safety gate rejects an unexpected action type', () => {
  const abort = expectAbort(
    () => assertPlanIsSafe({ actions: [{ kind: 'channel.explode', name: 'genel' }] }),
    'plan-safety',
  );
  assert.match(abort.violations.join(' '), /unexpected action type/);
});

test('the plan-safety gate rejects an action without a kind', () => {
  const abort = expectAbort(() => assertPlanIsSafe({ actions: [{ name: 'genel' }] }), 'plan-safety');
  assert.match(abort.violations.join(' '), /without a kind/);
});

test('the plan-safety gate refuses to modify a protected resource by id', () => {
  const abort = expectAbort(
    () =>
      assertPlanIsSafe(
        { actions: [{ kind: ACTION_KINDS.CHANNEL_UPDATE, id: 'chan-ses-genel', name: 'Genel', changes: { topic: 'x' } }] },
        { state: seedState },
      ),
    'plan-safety',
  );
  assert.match(abort.violations.join(' '), /protected resource "Genel"/);
});

test('the plan-safety gate refuses to recreate a protected category', () => {
  for (const name of ['Metin Kanalları', 'Ses Kanalları']) {
    const abort = expectAbort(
      () => assertPlanIsSafe({ actions: [{ kind: ACTION_KINDS.CATEGORY_CREATE, name, spec: { name } }] }),
      'plan-safety',
    );
    assert.match(abort.violations.join(' '), /protected category/);
  }
});

test('the plan-safety gate allows KEEP notes for protected resources', () => {
  const plan = planSetup(blueprint, seedState);
  const kept = plan.actions.filter((action) => action.kind === ACTION_KINDS.KEEP).map((action) => action.name);

  assert.ok(kept.includes('Genel'), 'the voice channel was not reported as kept');
  assert.ok(kept.includes('Metin Kanalları'));
  assert.ok(kept.includes('Ses Kanalları'));
  assert.doesNotThrow(() => assertPlanIsSafe(plan, { state: seedState }));
});

test('the plan-safety gate rejects a privileged permission in an overwrite', () => {
  const abort = expectAbort(
    () =>
      assertPlanIsSafe({
        actions: [
          {
            kind: ACTION_KINDS.CHANNEL_UPDATE,
            id: 'c1',
            name: 'genel',
            changes: { overwriteEdits: [{ role: '@everyone', allow: ['Administrator'], deny: [] }] },
          },
        ],
      }),
    'plan-safety',
  );
  assert.match(abort.violations.join(' '), /privileged permission "Administrator"/);
});

test('the plan-safety gate rejects a privileged permission on a created role', () => {
  const abort = expectAbort(
    () =>
      assertPlanIsSafe({
        actions: [{ kind: ACTION_KINDS.ROLE_CREATE, name: 'X', spec: { permissions: ['ManageRoles'] } }],
        allowRoleMutations: true,
      }),
    'plan-safety',
  );
  assert.match(abort.violations.join(' '), /privileged permission "ManageRoles"/);
});

test('the MiningFools blueprint grants none of the forbidden permissions', () => {
  const plan = planSetup(blueprint, seedState);
  const mentioned = JSON.stringify(plan.actions);

  for (const permission of FORBIDDEN_PERMISSIONS) {
    assert.ok(!mentioned.includes(`"${permission}"`), `the plan grants ${permission}`);
  }
});

test('every protected resource is documented with a reason', () => {
  assert.ok(PROTECTED_RESOURCES.length >= 3);
  for (const resource of PROTECTED_RESOURCES) {
    assert.ok(['voice', 'category'].includes(resource.type));
    assert.ok(resource.reason.length > 0, `${resource.name} has no documented reason`);
  }
});

/* -------------------------------------------------------------------------- */
/* Gate: convergence                                                           */
/* -------------------------------------------------------------------------- */

test('convergence reports remaining mutations', () => {
  const result = checkConvergence(planSetup(blueprint, emptyGuildState()));

  assert.equal(result.converged, false);
  assert.ok(result.remaining > 0);
});

test('convergence ignores KEEP notes', () => {
  const result = checkConvergence({
    actions: [{ kind: ACTION_KINDS.KEEP, name: 'Genel', reason: 'outside the blueprint' }],
    notes: ['1 resource preserved.'],
  });

  assert.equal(result.converged, true);
  assert.equal(result.remaining, 0);
  assert.deepEqual(result.notes, ['1 resource preserved.']);
});
