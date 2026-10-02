import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import {
  DEFAULT_VISIBILITY,
  createVisibilityPolicy,
  isChannel,
  normaliseVisibility,
  resolveAiVisibility,
  VISIBILITY,
} from '../src/ai/visibility.js';

const ephemeralOf = (payload) => Boolean(payload?.flags & MessageFlags.Ephemeral);

/* -------------------------------------------------------------------------- */
/* The default                                                                 */
/* -------------------------------------------------------------------------- */

test('the product default is public', () => {
  assert.equal(DEFAULT_VISIBILITY, VISIBILITY.PUBLIC);
  assert.equal(createVisibilityPolicy().mode, 'public');
  assert.equal(createVisibilityPolicy().ephemeral, false);
});

test('an unconfigured policy resolves to public', () => {
  assert.equal(resolveAiVisibility(undefined).mode, 'public');
  assert.equal(resolveAiVisibility({}).mode, 'public');
  assert.equal(resolveAiVisibility({ ai: {} }).mode, 'public');
});

test('an unrecognised value falls back to public, never to private', () => {
  for (const value of ['nonsense', '', null, undefined, 42, 'PUBLIC', 'true']) {
    assert.equal(normaliseVisibility(value), VISIBILITY.PUBLIC, `"${value}" did not fall back to public`);
  }
});

test('only the exact ephemeral value opts out', () => {
  assert.equal(normaliseVisibility(VISIBILITY.EPHEMERAL), VISIBILITY.EPHEMERAL);
  assert.equal(resolveAiVisibility({ ai: { responseVisibility: 'ephemeral' } }).ephemeral, true);
});

/* -------------------------------------------------------------------------- */
/* Option shapes                                                               */
/* -------------------------------------------------------------------------- */

test('a public policy produces flag-free payloads', () => {
  const policy = createVisibilityPolicy(VISIBILITY.PUBLIC);

  assert.equal(ephemeralOf(policy.replyOptions()), false);
  assert.equal(ephemeralOf(policy.replyOptions({ content: 'hi' })), false);
  assert.equal(ephemeralOf(policy.followUpOptions('chunk')), false);
  assert.deepEqual(policy.followUpOptions('chunk'), { content: 'chunk' });
});

test('an ephemeral policy flags every payload', () => {
  const policy = createVisibilityPolicy(VISIBILITY.EPHEMERAL);

  assert.equal(ephemeralOf(policy.replyOptions()), true);
  assert.equal(ephemeralOf(policy.followUpOptions('chunk')), true);
  assert.equal(ephemeralOf(policy.replyOptions({ content: 'hi' })), true);
});

test('extra options survive the policy', () => {
  const policy = createVisibilityPolicy(VISIBILITY.PUBLIC);

  assert.deepEqual(policy.replyOptions({ content: 'x', withResponse: true }), { content: 'x', withResponse: true });
});

test('a public reply payload carries no flags key at all', () => {
  // Guards against a stray `flags: undefined`, which is noise in the payload
  // and easy to mistake for a deliberate setting.
  assert.ok(!Object.hasOwn(createVisibilityPolicy(VISIBILITY.PUBLIC).replyOptions(), 'flags'));
});

/* -------------------------------------------------------------------------- */
/* Channel matching                                                            */
/* -------------------------------------------------------------------------- */

test('isChannel matches case-insensitively and trims', () => {
  assert.equal(isChannel('bedava-oyunlar', 'bedava-oyunlar'), true);
  assert.equal(isChannel('Bedava-Oyunlar', 'bedava-oyunlar'), true);
  assert.equal(isChannel('  bedava-oyunlar  ', 'bedava-oyunlar'), true);
});

test('isChannel rejects near misses and junk', () => {
  assert.equal(isChannel('bedava-oyunlar-arsiv', 'bedava-oyunlar'), false);
  assert.equal(isChannel('genel', 'bedava-oyunlar'), false);
  assert.equal(isChannel(null, 'bedava-oyunlar'), false);
  assert.equal(isChannel('genel', null), false);
  assert.equal(isChannel('', ''), false);
  assert.equal(isChannel(undefined, undefined), false);
});
