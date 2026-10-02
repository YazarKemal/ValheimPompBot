import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBlueprint, listBlueprints, hasBlueprint } from '../src/setup/blueprints/index.js';
import { validateBlueprint, DEFAULT_BLUEPRINT } from '../src/setup/blueprint.js';
import { createMiningFoolsBlueprint } from '../src/setup/blueprints/miningfools.js';
import { ACTION_KINDS, assertNoDestructiveActions, countMutations, planSetup } from '../src/setup/planner.js';
import { emptyGuildState } from '../src/setup/state.js';

const blueprint = buildBlueprint('miningfools');

/** The structure exactly as specified in the Phase 2B brief. */
const SPEC = {
  '⛏️ MININGFOOLS': ['genel', 'duyurular', 'fikirler', 'pompai'],
  '🌍 OYUN DÜNYASI': ['maden', 'ada', 'marketler', 'iskele-ve-tekne'],
  '🎮 GAMEPLAY': ['karakter', 'ekonomi', 'ilerleme'],
  '🛠️ GELİŞTİRME': ['unity', 'kod', 'buglar', 'test-build', 'performans'],
  '🎨 TASARIM': ['assetler', 'gorseller', 'ui-ux', 'ses-muzik'],
  '🔊 SES': ['MiningFools', 'Geliştirme Odası', 'Test Odası'],
  '🎁 FIRSATLAR': ['bedava-oyunlar'],
  '🎵 MÜZİK': ['muzik-istek', 'Müzik Odası'],
  '🎉 EĞLENCE': ['eglence'],
};

test('the registry exposes both layouts with miningfools as the default', () => {
  assert.deepEqual(listBlueprints(), ['miningfools', 'valheim']);
  assert.ok(hasBlueprint('miningfools'));
  assert.ok(!hasBlueprint('nope'));
  assert.equal(DEFAULT_BLUEPRINT, 'miningfools');
  assert.equal(buildBlueprint().key, 'miningfools');
});

test('the blueprint is structurally valid', () => {
  assert.deepEqual(validateBlueprint(blueprint), []);
});

test('the blueprint matches the specified structure exactly', () => {
  const actual = {};
  for (const category of blueprint.categories) {
    actual[category.name] = blueprint.channels
      .filter((channel) => channel.category === category.key)
      .map((channel) => channel.name);
  }

  assert.deepEqual(actual, SPEC);
});

test('the spec contains no duplicate channel or category names', () => {
  const channelNames = blueprint.channels.map((channel) => channel.name.toLowerCase());
  const categoryNames = blueprint.categories.map((category) => category.name.toLowerCase());

  assert.equal(new Set(channelNames).size, channelNames.length, 'duplicate channel name in the blueprint');
  assert.equal(new Set(categoryNames).size, categoryNames.length, 'duplicate category name in the blueprint');
});

test('the SES category holds three voice channels and nothing else', () => {
  const ses = blueprint.channels.filter((channel) => channel.category === 'ses');

  assert.deepEqual(ses.map((channel) => channel.name).sort(), ['Geliştirme Odası', 'MiningFools', 'Test Odası']);
  assert.ok(ses.every((channel) => channel.type === 'voice'));
});

test('the MÜZİK category holds one text channel and one voice channel', () => {
  const muzik = blueprint.channels.filter((channel) => channel.category === 'muzik');

  assert.deepEqual(
    muzik.map((channel) => `${channel.type}:${channel.name}`).sort(),
    ['text:muzik-istek', 'voice:Müzik Odası'],
  );
});

test('no channel is private, so no existing member loses access', () => {
  for (const channel of blueprint.channels) {
    const hidesEveryone = (channel.overwrites ?? []).some(
      (rule) => String(rule.role).toLowerCase() === '@everyone' && (rule.deny ?? []).includes('ViewChannel'),
    );
    assert.ok(!hidesEveryone, `"${channel.name}" hides the channel from @everyone`);
  }
});

test('duyurular is the only channel with a default permission rule', () => {
  const restricted = blueprint.channels.filter((channel) => channel.readOnly || (channel.overwrites ?? []).length > 0);

  assert.deepEqual(restricted.map((channel) => channel.name), ['duyurular']);
  assert.equal(restricted[0].readOnly, true);
});

test('the default blueprint creates no roles, so it needs no existing role to apply', () => {
  assert.deepEqual(blueprint.roles, []);
});

test('planning the spec against an empty server creates 9 categories and 27 channels', () => {
  const plan = planSetup(blueprint, emptyGuildState());
  const byKind = (kind) => plan.actions.filter((action) => action.kind === kind);

  assert.equal(byKind(ACTION_KINDS.CATEGORY_CREATE).length, 9);
  assert.equal(byKind(ACTION_KINDS.CHANNEL_CREATE).length, 27);
  assert.equal(byKind(ACTION_KINDS.ROLE_CREATE).length, 0);
  assert.equal(byKind(ACTION_KINDS.CHANNEL_UPDATE).length, 0);
  assert.equal(countMutations(plan), 36);
});

test('#pompai is public and lives under MININGFOOLS', () => {
  const pompai = blueprint.channels.find((channel) => channel.name === 'pompai');

  assert.ok(pompai, '#pompai is missing from the blueprint');
  assert.equal(pompai.type, 'text');
  assert.equal(pompai.category, 'miningfools');
  assert.equal(pompai.readOnly, undefined, '#pompai must not be read-only');
  assert.deepEqual(pompai.overwrites ?? [], [], '#pompai must carry no permission overwrites');
});

test('the empty-server plan is non-destructive', () => {
  assert.deepEqual(assertNoDestructiveActions(planSetup(blueprint, emptyGuildState())), []);
});

/* -------------------------------------------------------------------------- */
/* Reuse rather than recreate - the #genel requirement                         */
/* -------------------------------------------------------------------------- */

test('an existing #genel is moved into the new category instead of recreated', () => {
  const state = {
    roles: [],
    categories: [{ id: 'cat-old', name: 'GENEL' }],
    channels: [
      { id: 'chan-genel', name: 'genel', type: 'text', topic: 'sohbet', parentName: 'GENEL', overwrites: [] },
    ],
  };

  const plan = planSetup(blueprint, state);

  assert.equal(
    plan.actions.filter((a) => a.kind === ACTION_KINDS.CHANNEL_CREATE && a.name === 'genel').length,
    0,
    'genel was recreated instead of reused',
  );

  const move = plan.actions.find((a) => a.kind === ACTION_KINDS.CHANNEL_UPDATE && a.name === 'genel');
  assert.ok(move, '#genel was not moved');
  assert.equal(move.id, 'chan-genel', 'the existing channel id was not reused');
  assert.equal(move.changes.parentName, '⛏️ MININGFOOLS');
});

test('an existing channel that already matches is left completely alone', () => {
  const state = {
    roles: [],
    categories: [{ id: 'cat-mf', name: '⛏️ MININGFOOLS' }],
    channels: [
      { id: 'chan-genel', name: 'genel', type: 'text', topic: blueprint.channels[0].topic, parentName: '⛏️ MININGFOOLS', overwrites: [] },
    ],
  };

  const plan = planSetup(blueprint, state);
  const genel = plan.actions.filter((action) => action.name === 'genel');

  assert.equal(genel.length, 1);
  assert.equal(genel[0].kind, ACTION_KINDS.SKIP);
});

test('an emoji-less category is treated as different and preserved', () => {
  // The planner matches names exactly, so "MININGFOOLS" does not match
  // "⛏️ MININGFOOLS". The old category must survive and be reported.
  const state = { roles: [], categories: [{ id: 'cat-1', name: 'MININGFOOLS' }], channels: [] };

  const plan = planSetup(blueprint, state);

  assert.equal(plan.actions.filter((a) => a.kind === ACTION_KINDS.CATEGORY_CREATE).length, 9);
  const kept = plan.actions.find((a) => a.kind === ACTION_KINDS.KEEP && a.name === 'MININGFOOLS');
  assert.ok(kept, 'the emoji-less category was not reported as preserved');
  assert.deepEqual(assertNoDestructiveActions(plan), []);
});

test('a same-named channel of the wrong type is flagged, never converted', () => {
  const state = {
    roles: [],
    categories: [],
    channels: [{ id: 'c1', name: 'MiningFools', type: 'text', parentName: null, overwrites: [] }],
  };

  const plan = planSetup(blueprint, state);
  const warning = plan.actions.find((a) => a.kind === ACTION_KINDS.WARN && a.name === 'MiningFools');

  assert.ok(warning, 'the text/voice name clash was not surfaced');
  assert.equal(plan.actions.filter((a) => a.kind === ACTION_KINDS.CHANNEL_CREATE && a.name === 'MiningFools').length, 0);
});

/* -------------------------------------------------------------------------- */
/* Optional additions                                                          */
/* -------------------------------------------------------------------------- */

test('the music channels are opt-in and add a Jockie-friendly pair', () => {
  const withMusic = createMiningFoolsBlueprint({ includeMusic: true });

  assert.equal(withMusic.channels.length, blueprint.channels.length + 2);
  const musicText = withMusic.channels.find((c) => c.name === 'muzik');
  const musicVoice = withMusic.channels.find((c) => c.name === 'Müzik');

  assert.equal(musicText.type, 'text');
  assert.equal(musicVoice.type, 'voice');
  // Open to @everyone, so Jockie needs no permission change to work.
  assert.equal((musicText.overwrites ?? []).length, 0);
  assert.deepEqual(validateBlueprint(withMusic), []);
});

test('the proposed roles are opt-in and valid when enabled', () => {
  const withRoles = createMiningFoolsBlueprint({ includeRoles: true });

  assert.ok(withRoles.roles.length >= 6);
  assert.deepEqual(validateBlueprint(withRoles), []);
  assert.equal(planSetup(withRoles, emptyGuildState()).actions.filter((a) => a.kind === ACTION_KINDS.ROLE_CREATE).length, withRoles.roles.length);
});

test('the optional flags compose', () => {
  const full = createMiningFoolsBlueprint({ includeRoles: true, includeMusic: true });

  assert.deepEqual(validateBlueprint(full), []);
  assert.equal(planSetup(full, emptyGuildState()).actions.filter((a) => a.kind === ACTION_KINDS.CHANNEL_CREATE).length, 29);
});
