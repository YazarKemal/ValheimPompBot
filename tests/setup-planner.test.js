import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBlueprint, validateBlueprint } from '../src/setup/blueprint.js';
import { ROLES } from '../src/setup/blueprints/valheim.js';
import { resolveOverwrites, mergeRules, rulesEqual } from '../src/setup/permissions.js';
import { ACTION_KINDS, assertNoDestructiveActions, countMutations, normaliseColor, planSetup } from '../src/setup/planner.js';
import { emptyGuildState } from '../src/setup/state.js';

const blueprint = buildBlueprint('valheim');

const of = (plan, kind) => plan.actions.filter((action) => action.kind === kind);

/** Builds a state that already matches the blueprint exactly. */
function matchingState() {
  const categoryName = (key) => blueprint.categories.find((category) => category.key === key).name;
  return {
    roles: blueprint.roles.map((role, index) => ({
      id: `role-${index}`,
      name: role.name,
      color: normaliseColor(role.color),
      hoist: Boolean(role.hoist),
      mentionable: Boolean(role.mentionable),
      permissions: [...role.permissions].sort(),
    })),
    categories: blueprint.categories.map((category, index) => ({ id: `cat-${index}`, name: category.name })),
    channels: blueprint.channels.map((channel, index) => ({
      id: `chan-${index}`,
      name: channel.name,
      type: channel.type ?? 'text',
      topic: channel.topic ?? null,
      parentName: categoryName(channel.category),
      overwrites: resolveOverwrites(channel),
    })),
  };
}

/* -------------------------------------------------------------------------- */
/* Blueprint                                                                   */
/* -------------------------------------------------------------------------- */

test('the built-in blueprint is valid', () => {
  assert.deepEqual(validateBlueprint(blueprint), []);
});

test('validateBlueprint catches structural mistakes', () => {
  const problems = validateBlueprint({
    roles: [{ key: 'a', name: 'A' }, { key: 'b', name: 'A' }],
    categories: [{ key: 'c', name: 'C' }],
    channels: [
      { key: 'x', name: 'x', category: 'missing' },
      { key: 'y', name: 'y', category: 'c', overwrites: [{ role: 'Ghost' }] },
    ],
  });

  assert.ok(problems.some((problem) => problem.includes('duplicate role name')));
  assert.ok(problems.some((problem) => problem.includes('unknown category')));
  assert.ok(problems.some((problem) => problem.includes('unknown role')));
});

/* -------------------------------------------------------------------------- */
/* Permissions                                                                 */
/* -------------------------------------------------------------------------- */

test('read-only channels allow viewing but deny sending for @everyone', () => {
  const rules = resolveOverwrites({ readOnly: true });
  const everyone = rules.find((rule) => rule.role === '@everyone');

  assert.ok(everyone.allow.includes('ViewChannel'));
  assert.ok(everyone.deny.includes('SendMessages'));
});

test('explicit overwrites can hide a channel from @everyone and admit named roles', () => {
  const rules = resolveOverwrites({
    overwrites: [
      { role: '@everyone', allow: [], deny: ['ViewChannel'] },
      { role: 'Chieftain', allow: ['ViewChannel', 'SendMessages'], deny: [] },
    ],
  });
  const byRole = Object.fromEntries(rules.map((rule) => [rule.role, rule]));

  assert.deepEqual(byRole['@everyone'].allow, []);
  assert.ok(byRole['@everyone'].deny.includes('ViewChannel'));
  assert.ok(byRole.Chieftain.allow.includes('ViewChannel'));
});

test('mergeRules never leaves a permission both allowed and denied', () => {
  const merged = mergeRules([
    { role: 'Drengr', allow: ['SendMessages', 'ViewChannel'] },
    { role: 'Drengr', deny: ['SendMessages'] },
  ]);

  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].allow, ['ViewChannel']);
  assert.deepEqual(merged[0].deny, ['SendMessages']);
});

test('@everyone is matched case-insensitively, real roles keep their case', () => {
  const merged = mergeRules([{ role: '@Everyone', allow: ['ViewChannel'] }, { role: 'Drengr', allow: [] }]);

  assert.equal(merged[0].role, '@everyone');
  assert.equal(merged[1].role, 'Drengr');
});

test('rulesEqual ignores ordering', () => {
  assert.ok(rulesEqual({ allow: ['A', 'B'], deny: [] }, { allow: ['B', 'A'], deny: [] }));
  assert.ok(!rulesEqual({ allow: ['A'], deny: [] }, { allow: ['A', 'B'], deny: [] }));
});

/* -------------------------------------------------------------------------- */
/* Planning                                                                    */
/* -------------------------------------------------------------------------- */

test('an empty server gets every role, category and channel created', () => {
  const plan = planSetup(blueprint, emptyGuildState());

  assert.equal(of(plan, ACTION_KINDS.ROLE_CREATE).length, blueprint.roles.length);
  assert.equal(of(plan, ACTION_KINDS.CATEGORY_CREATE).length, blueprint.categories.length);
  assert.equal(of(plan, ACTION_KINDS.CHANNEL_CREATE).length, blueprint.channels.length);
  assert.equal(of(plan, ACTION_KINDS.ROLE_UPDATE).length, 0);
  assert.equal(of(plan, ACTION_KINDS.CHANNEL_UPDATE).length, 0);
});

test('a state that already matches produces zero changes', () => {
  const plan = planSetup(blueprint, matchingState());

  assert.equal(countMutations(plan), 0, `unexpected work: ${JSON.stringify(of(plan, ACTION_KINDS.ROLE_UPDATE))}`);
  assert.equal(plan.summary[ACTION_KINDS.SKIP], blueprint.roles.length + blueprint.categories.length + blueprint.channels.length);
});

test('no plan is ever destructive', () => {
  const plans = [
    planSetup(blueprint, emptyGuildState()),
    planSetup(blueprint, matchingState()),
    planSetup(
      blueprint,
      { roles: [{ id: 'x', name: 'Ancient', permissions: [] }], categories: [], channels: [{ id: 'y', name: 'legacy', type: 'text' }] },
    ),
  ];

  for (const plan of plans) {
    assert.deepEqual(assertNoDestructiveActions(plan), []);
  }
});

test('roles are created before categories, which come before channels', () => {
  const kinds = planSetup(blueprint, emptyGuildState()).actions.map((action) => action.kind);

  const lastRole = kinds.lastIndexOf(ACTION_KINDS.ROLE_CREATE);
  const firstCategory = kinds.indexOf(ACTION_KINDS.CATEGORY_CREATE);
  const lastCategory = kinds.lastIndexOf(ACTION_KINDS.CATEGORY_CREATE);
  const firstChannel = kinds.indexOf(ACTION_KINDS.CHANNEL_CREATE);

  assert.ok(lastRole < firstCategory, 'a role is created after a category');
  assert.ok(lastCategory < firstChannel, 'a channel is created before its category');
});

test('channels are planned with their resolved category name and overwrites', () => {
  const plan = planSetup(blueprint, emptyGuildState());
  const staffChat = of(plan, ACTION_KINDS.CHANNEL_CREATE).find((action) => action.name === 'staff-chat');

  assert.equal(staffChat.parentName, 'STAFF');
  assert.ok(staffChat.spec.overwrites.some((rule) => rule.role === '@everyone' && rule.deny.includes('ViewChannel')));
});

/* -------------------------------------------------------------------------- */
/* Drift                                                                       */
/* -------------------------------------------------------------------------- */

test('a role missing a permission is updated additively', () => {
  const state = matchingState();
  state.roles[0].permissions = state.roles[0].permissions.filter((permission) => permission !== 'ManageGuild');

  const plan = planSetup(blueprint, state);
  const update = of(plan, ACTION_KINDS.ROLE_UPDATE).find((action) => action.name === 'Chieftain');

  assert.ok(update, 'no update was planned');
  assert.deepEqual(update.changes.addPermissions, ['ManageGuild']);
  assert.equal(update.changes.permissions, undefined, 'permissions must never be replaced wholesale');
});

test('a role with extra permissions keeps them and is reported as drift', () => {
  const state = matchingState();
  state.roles[1].permissions = [...state.roles[1].permissions, 'Administrator'].sort();

  const plan = planSetup(blueprint, state);

  assert.equal(of(plan, ACTION_KINDS.ROLE_UPDATE).filter((a) => a.name === 'Elder').length, 0);
  const note = of(plan, ACTION_KINDS.KEEP).find((action) => action.name === 'Elder');
  assert.ok(note, 'drift was not reported');
  assert.match(note.reason, /Administrator/);
});

test('a changed role colour is reconciled', () => {
  const state = matchingState();
  state.roles[0].color = '#000000';

  const plan = planSetup(blueprint, state);
  const update = of(plan, ACTION_KINDS.ROLE_UPDATE).find((action) => action.name === 'Chieftain');

  assert.equal(update.changes.color, normaliseColor(ROLES[0].color));
});

test('a changed channel topic is reconciled', () => {
  const state = matchingState();
  const general = state.channels.find((channel) => channel.name === 'general');
  general.topic = 'stale topic';

  const plan = planSetup(blueprint, state);
  const update = of(plan, ACTION_KINDS.CHANNEL_UPDATE).find((action) => action.name === 'general');

  assert.equal(update.changes.topic, 'General chat.');
});

test('a channel in the wrong category is moved, not recreated', () => {
  const state = matchingState();
  const general = state.channels.find((channel) => channel.name === 'general');
  general.parentName = 'STAFF';

  const plan = planSetup(blueprint, state);

  assert.equal(of(plan, ACTION_KINDS.CHANNEL_CREATE).filter((a) => a.name === 'general').length, 0);
  const update = of(plan, ACTION_KINDS.CHANNEL_UPDATE).find((action) => action.name === 'general');
  assert.equal(update.changes.parentName, 'COMMUNITY');
});

test('a missing permission overwrite is added for the managed role only', () => {
  const state = matchingState();
  const rules = state.channels.find((channel) => channel.name === 'rules');
  rules.overwrites = rules.overwrites.filter((rule) => rule.role !== '@everyone');

  const plan = planSetup(blueprint, state);
  const update = of(plan, ACTION_KINDS.CHANNEL_UPDATE).find((action) => action.name === 'rules');

  assert.equal(update.changes.overwriteEdits.length, 1);
  assert.equal(update.changes.overwriteEdits[0].role, '@everyone');
});

test('an overwrite for a role the blueprint does not manage is preserved', () => {
  const state = matchingState();
  const general = state.channels.find((channel) => channel.name === 'general');
  general.overwrites = [{ role: 'Guest', allow: ['ViewChannel'], deny: [] }];

  const plan = planSetup(blueprint, state);

  const note = of(plan, ACTION_KINDS.KEEP).find((action) => action.name === 'general');
  assert.ok(note, 'the unmanaged overwrite was not reported');
  assert.match(note.reason, /Guest/);

  for (const update of of(plan, ACTION_KINDS.CHANNEL_UPDATE).filter((a) => a.name === 'general')) {
    assert.ok(
      !(update.changes.overwriteEdits ?? []).some((edit) => edit.role === 'Guest'),
      'the unmanaged overwrite was rewritten',
    );
  }
});

test('resources absent from the blueprint are kept, never removed', () => {
  const state = matchingState();
  state.roles.push({ id: 'role-x', name: 'Ancient One', permissions: [] });
  state.channels.push({ id: 'chan-x', name: 'legacy-chat', type: 'text', parentName: 'COMMUNITY', overwrites: [] });
  state.categories.push({ id: 'cat-x', name: 'ARCHIVE' });

  const plan = planSetup(blueprint, state);
  const keeps = of(plan, ACTION_KINDS.KEEP).map((action) => action.name);

  assert.ok(keeps.includes('Ancient One'));
  assert.ok(keeps.includes('legacy-chat'));
  assert.ok(keeps.includes('ARCHIVE'));
  assert.deepEqual(assertNoDestructiveActions(plan), []);
});

test('a name collision with a different channel type is flagged, not resolved destructively', () => {
  const state = matchingState();
  state.channels = state.channels.filter((channel) => channel.name !== 'general');
  state.channels.push({ id: 'chan-voice', name: 'general', type: 'voice', parentName: 'COMMUNITY', overwrites: [] });

  const plan = planSetup(blueprint, state);

  assert.equal(of(plan, ACTION_KINDS.CHANNEL_CREATE).filter((a) => a.name === 'general').length, 0);
  const warning = of(plan, ACTION_KINDS.WARN).find((action) => action.name === 'general');
  assert.ok(warning, 'the type conflict was not surfaced');
  assert.match(warning.reason, /converting would require deletion/);
});

test('normaliseColor handles every input shape', () => {
  assert.equal(normaliseColor('#C0392B'), '#c0392b');
  assert.equal(normaliseColor('c0392b'), '#c0392b');
  assert.equal(normaliseColor(0xc0392b), '#c0392b');
  assert.equal(normaliseColor(null), null);
  assert.equal(normaliseColor(''), null);
});

test('the plan carries a summary and human-readable notes', () => {
  const plan = planSetup(blueprint, emptyGuildState());

  assert.equal(typeof plan.version, 'number');
  assert.ok(plan.summary[ACTION_KINDS.ROLE_CREATE] > 0);
  assert.ok(Array.isArray(plan.notes));
});
