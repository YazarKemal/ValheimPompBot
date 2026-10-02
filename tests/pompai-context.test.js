import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt, CORE_LOOP, PROJECT_FACTS, SYSTEMS } from '../src/ai/miningfools.js';
import { describeChannelContext, describeChannelFocus, CHANNEL_FOCUS } from '../src/ai/channel-context.js';
import { buildBlueprint } from '../src/setup/blueprints/index.js';

/* -------------------------------------------------------------------------- */
/* MiningFools system prompt                                                   */
/* -------------------------------------------------------------------------- */

test('the prompt describes MiningFools as a Unity project', () => {
  const prompt = buildSystemPrompt();

  assert.match(prompt, /MiningFools/);
  assert.match(prompt, /Unity/);
  assert.equal(PROJECT_FACTS.engine, 'Unity');
});

test('the prompt states the full core loop in order', () => {
  const prompt = buildSystemPrompt();

  let cursor = -1;
  for (const step of CORE_LOOP) {
    const index = prompt.indexOf(step);
    assert.ok(index > cursor, `"${step}" is missing or out of order`);
    cursor = index;
  }
  assert.match(prompt, /explore the island/);
  assert.match(prompt, /unlock deeper mine progression/);
});

test('the prompt lists every important system', () => {
  const prompt = buildSystemPrompt();

  for (const system of SYSTEMS) {
    assert.ok(prompt.includes(system), `"${system}" is missing from the system prompt`);
  }
});

test('the prompt forbids inventing project facts', () => {
  const prompt = buildSystemPrompt();

  assert.match(prompt, /Do NOT invent project facts/);
  assert.match(prompt, /say plainly that you do not know/);
});

test('the prompt contains no credentials or configuration values', () => {
  const prompt = buildSystemPrompt({ channelName: 'pompai' });

  for (const pattern of [/sk-[A-Za-z0-9]/, /Bearer\s/, /DISCORD_TOKEN/, /API_KEY/, /[MN][A-Za-z\d]{23,}\./]) {
    assert.ok(!pattern.test(prompt), `the system prompt matches ${pattern}`);
  }
});

test('the prompt carries the channel context', () => {
  assert.match(buildSystemPrompt({ channelName: 'maden' }), /#maden/);
  assert.match(buildSystemPrompt({ channelName: 'performans' }), /profiling/i);
});

test('extra context is appended when supplied, and omitted otherwise', () => {
  assert.match(buildSystemPrompt({ extraContext: 'Sprint hedefi: demo.' }), /Sprint hedefi: demo\./);
  assert.ok(!buildSystemPrompt().includes('Additional context'));
});

/* -------------------------------------------------------------------------- */
/* Channel-aware context                                                       */
/* -------------------------------------------------------------------------- */

test('every text channel in the blueprint has a focus hint', () => {
  const blueprint = buildBlueprint('miningfools');

  // Voice channels are excluded: a slash command cannot be invoked in one, so
  // /ask can never run there and the hint would be dead weight.
  const textChannels = blueprint.channels.filter((channel) => channel.type !== 'voice');
  assert.ok(textChannels.length > 0);

  for (const channel of textChannels) {
    assert.ok(
      Object.hasOwn(CHANNEL_FOCUS, channel.name),
      `#${channel.name} exists in the blueprint but has no channel focus hint`,
    );
  }
});

test('channel focus hints do not reference channels that no longer exist', () => {
  const blueprint = buildBlueprint('miningfools');
  const known = new Set(blueprint.channels.map((channel) => channel.name));

  for (const name of Object.keys(CHANNEL_FOCUS)) {
    assert.ok(known.has(name), `CHANNEL_FOCUS mentions "#${name}", which is not in the blueprint`);
  }
});

test('the spec channel examples map to the right focus', () => {
  const expectations = [
    ['maden', /mining and digging/i],
    ['ada', /island/i],
    ['marketler', /economy/i],
    ['iskele-ve-tekne', /dock and boat/i],
    ['karakter', /player/i],
    ['unity', /unity implementation/i],
    ['kod', /architecture/i],
    ['buglar', /debugging/i],
    ['performans', /performance/i],
    ['assetler', /assets/i],
    ['ui-ux', /interface and user experience/i],
    ['ses-muzik', /game audio/i],
  ];

  for (const [channel, pattern] of expectations) {
    const focus = describeChannelFocus(channel);
    assert.ok(focus, `#${channel} has no focus`);
    assert.match(focus, pattern, `#${channel} has the wrong focus: ${focus}`);
  }
});

test('channel names are matched case-insensitively and trimmed', () => {
  assert.equal(describeChannelFocus('  MADEN '), describeChannelFocus('maden'));
  assert.equal(describeChannelFocus('PompAI'), describeChannelFocus('pompai'));
});

test('an unknown channel degrades gracefully', () => {
  assert.equal(describeChannelFocus('rastgele-kanal'), null);
  assert.match(describeChannelContext('rastgele-kanal'), /No specific focus is known/);
  assert.match(describeChannelContext(null), /channel is unknown/);
  assert.match(describeChannelContext(''), /channel is unknown/);
});

test('channel context never leaks anything beyond the channel name', () => {
  const context = describeChannelContext('pompai');
  assert.match(context, /^Discord channel: #pompai\./);
});

/* -------------------------------------------------------------------------- */
/* The #pompai channel itself                                                  */
/* -------------------------------------------------------------------------- */

test('#pompai exists in the blueprint, public and under MININGFOOLS', () => {
  const blueprint = buildBlueprint('miningfools');
  const pompai = blueprint.channels.find((channel) => channel.name === 'pompai');
  const category = blueprint.categories.find((entry) => entry.key === pompai?.category);

  assert.ok(pompai, '#pompai is missing');
  assert.equal(category.name, '⛏️ MININGFOOLS');
  assert.equal(pompai.readOnly, undefined);
  assert.deepEqual(pompai.overwrites ?? [], []);
});

test('adding #pompai did not disturb the rest of the structure', () => {
  const blueprint = buildBlueprint('miningfools');
  const names = blueprint.channels.map((channel) => channel.name);

  assert.equal(blueprint.categories.length, 9, 'the category count changed');
  assert.equal(names.length, 27, 'the channel count changed');
  for (const expected of ['genel', 'duyurular', 'fikirler', 'maden', 'ada', 'marketler', 'unity', 'kod']) {
    assert.ok(names.includes(expected), `#${expected} disappeared`);
  }
});
