import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PARTY_BANKS,
  PARTY_META,
  PARTY_TYPES,
  isPartyType,
  pickQuestion,
  questionsFor,
} from '../src/fun/content/party-banks.js';
import { NICKNAMES, pickNickname } from '../src/fun/content/nicknames.js';
import { FORTUNES, pickFortune } from '../src/fun/content/fortunes.js';
import {
  PARTY_ACTIONS,
  bankSize,
  createPartyStore,
  isPartyComponent,
  parsePartyComponentId,
  partyComponentId,
  partyKey,
} from '../src/fun/party.js';
import { sequenceRandom } from './helpers/fake-interaction.js';

/**
 * Party games and the curated content banks.
 *
 * Two things matter here: a round is scoped to one channel of one guild, and
 * the built-in content is safe to show in a general server - which is checked
 * against a list of things a dare must never involve, not just eyeballed.
 */

const AT = 1_700_000_000_000;

/* -------------------------------------------------------------------------- */
/* Content banks                                                               */
/* -------------------------------------------------------------------------- */

test('all three party types exist, with metadata for each', () => {
  assert.deepEqual([...PARTY_TYPES], ['dogruluk', 'cesaret', 'kim-daha-olasi']);
  for (const type of PARTY_TYPES) {
    assert.ok(isPartyType(type), `${type} is not recognised`);
    assert.ok(PARTY_META[type]?.emoji, `${type} has no emoji`);
    assert.ok(PARTY_META[type]?.title, `${type} has no title`);
  }
  assert.equal(isPartyType('nope'), false);
  assert.equal(isPartyType(null), false);
});

test('every bank is long enough to be worth playing', () => {
  for (const type of PARTY_TYPES) {
    const bank = questionsFor(type);
    assert.ok(Array.isArray(bank), `${type} is not an array`);
    assert.ok(bank.length >= 20, `${type} has only ${bank.length} questions`);
    assert.equal(bankSize(type), bank.length);
    assert.ok(bank.every((entry) => typeof entry === 'string' && entry.trim().length > 5), `${type} has an empty entry`);
    assert.equal(new Set(bank).size, bank.length, `${type} repeats a question`);
  }
});

test('an unknown type yields an empty bank rather than throwing', () => {
  assert.deepEqual(questionsFor('nope'), []);
  assert.equal(pickQuestion('nope', () => 0), null);
  assert.equal(bankSize('nope'), 0);
});

test('a question is chosen deterministically from the bank', () => {
  for (const type of PARTY_TYPES) {
    const bank = questionsFor(type);
    assert.equal(pickQuestion(type, () => 0), bank[0], `${type}: the first question is not the first entry`);
    assert.equal(pickQuestion(type, () => 0.999999), bank[bank.length - 1], `${type}: the last bucket is wrong`);
  }
  // No random value may fall outside the bank.
  for (const value of [0, 0.5, 0.999999, 1, -1, Number.NaN]) {
    for (const type of PARTY_TYPES) {
      assert.ok(questionsFor(type).includes(pickQuestion(type, () => value)), `${type} produced an out-of-range question`);
    }
  }
});

test('no dare asks anyone to do something unsafe or private', () => {
  // The bank is shown in a general server, so this list is the contract: a dare
  // must be doable from a chair, in Discord, with nothing at stake.
  const forbidden = [
    'alkol', 'içki', 'bira', 'şarap', 'sigara', 'sigar', 'nargile', 'madde', 'uyuşturucu',
    'araba', 'araç kullan', 'ehliyet', 'koş', 'şınav', 'mekik', 'kilo', 'diyet',
    'adres', 'telefon numara', 'şifre', 'parola', 'kredi kartı', 'kimlik', 'tc kimlik',
    'soy', 'çıplak', 'kıyafet çıkar', 'öp', 'seks', 'cinsel', 'flört',
    'para harca', 'satın al', 'bahis', 'iddaa', 'kumar',
  ];

  const offences = [];
  for (const question of questionsFor('cesaret')) {
    const lower = question.toLowerCase();
    for (const word of forbidden) {
      if (lower.includes(word)) offences.push(`${word} in "${question}"`);
    }
  }
  assert.deepEqual(offences, [], `a dare crosses a safety line: ${offences.join('; ')}`);
});

test('every bank entry is free of slurs and sexual content', () => {
  const forbidden = ['seks', 'cinsel', 'porno', 'çıplak', 'orospu', 'piç', 'amk', 'aq'];
  const offences = [];

  for (const type of PARTY_TYPES) {
    for (const question of questionsFor(type)) {
      const lower = question.toLowerCase();
      for (const word of forbidden) if (lower.includes(word)) offences.push(`${type}: ${word}`);
    }
  }
  assert.deepEqual(offences, []);
});

test('the nickname and fortune banks are usable and deterministic', () => {
  assert.ok(NICKNAMES.length >= 20, `only ${NICKNAMES.length} nicknames`);
  assert.ok(FORTUNES.length >= 20, `only ${FORTUNES.length} fortunes`);
  assert.equal(new Set(NICKNAMES).size, NICKNAMES.length, 'a nickname is repeated');
  assert.equal(new Set(FORTUNES).size, FORTUNES.length, 'a fortune is repeated');

  for (const value of [0, 0.5, 0.999999, 1.5]) {
    assert.ok(NICKNAMES.includes(pickNickname(() => value)), 'pickNickname left the bank');
    assert.ok(FORTUNES.includes(pickFortune(() => value)), 'pickFortune left the bank');
  }
  assert.equal(new Set([0, 0.1, 0.2, 0.3].map((v) => pickNickname(() => v))).size > 1, true, 'the nickname is not random');
});

test('the banks are pure data with no module-load randomness', async () => {
  const first = await import('../src/fun/content/nicknames.js');
  const second = await import('../src/fun/content/nicknames.js');
  // A frozen module evaluated once: the arrays are the same object every time.
  assert.equal(first.NICKNAMES, second.NICKNAMES);
  assert.ok(Object.isFrozen(first.NICKNAMES));
  assert.ok(Object.isFrozen(first.FORTUNES ?? first.NICKNAMES));
});

/* -------------------------------------------------------------------------- */
/* Sessions                                                                    */
/* -------------------------------------------------------------------------- */

function makeStore(options = {}) {
  let clock = AT;
  const store = createPartyStore({
    now: () => clock,
    idFactory: (() => {
      let counter = 0;
      return () => `session${++counter}`;
    })(),
    ...options,
  });
  return { store, advance: (ms) => { clock += ms; }, at: () => clock };
}

test('starting a round picks a question and records where it is running', () => {
  const { store } = makeStore();
  const started = store.start({ guildId: 'g1', channelId: 'c1', type: 'dogruluk' });

  assert.equal(started.ok, true);
  assert.equal(started.session.type, 'dogruluk');
  assert.ok(questionsFor('dogruluk').includes(started.session.question));
  assert.equal(started.session.guildId, 'g1');
  assert.equal(started.session.channelId, 'c1');
  assert.equal(started.session.asked, 1);
  assert.equal(store.size, 1);
});

test('an unknown type never starts a round', () => {
  const { store } = makeStore();
  assert.equal(store.start({ guildId: 'g1', channelId: 'c1', type: 'nope' }).ok, false);
  assert.equal(store.size, 0);
});

test('rounds are isolated per guild and per channel', () => {
  const { store } = makeStore();
  store.start({ guildId: 'g1', channelId: 'c1', type: 'dogruluk' });
  store.start({ guildId: 'g1', channelId: 'c2', type: 'cesaret' });
  store.start({ guildId: 'g2', channelId: 'c1', type: 'kim-daha-olasi' });

  assert.equal(store.size, 3, 'two rounds collided');
  assert.equal(store.get('g1', 'c1').type, 'dogruluk');
  assert.equal(store.get('g1', 'c2').type, 'cesaret');
  assert.equal(store.get('g2', 'c1').type, 'kim-daha-olasi', 'a round leaked across guilds');
  assert.equal(store.get('g2', 'c2'), null);
  assert.notEqual(partyKey('g1', 'c1'), partyKey('g2', 'c1'));
});

test('starting again in the same channel replaces the round', () => {
  const { store } = makeStore();
  store.start({ guildId: 'g1', channelId: 'c1', type: 'dogruluk' });
  const second = store.start({ guildId: 'g1', channelId: 'c1', type: 'cesaret' });

  assert.equal(store.size, 1);
  assert.equal(store.get('g1', 'c1').id, second.session.id);
  assert.equal(store.get('g1', 'c1').type, 'cesaret');
});

test('the next question replaces the current one', () => {
  const { store } = makeStore();
  const session = store.start({ guildId: 'g1', channelId: 'c1', type: 'dogruluk' }).session;

  const advanced = store.next({ guildId: 'g1', channelId: 'c1', sessionId: session.id, random: sequenceRandom([0.999999]) });
  assert.equal(advanced.ok, true);
  assert.equal(advanced.session.asked, 2);
  assert.equal(advanced.session.question, questionsFor('dogruluk').at(-1));
  assert.equal(advanced.session.id, session.id, 'advancing replaced the session');
  assert.equal(store.size, 1);
});

test('a button from a previous round cannot advance the current one', () => {
  const { store } = makeStore();
  const first = store.start({ guildId: 'g1', channelId: 'c1', type: 'dogruluk' }).session;
  const second = store.start({ guildId: 'g1', channelId: 'c1', type: 'cesaret' }).session;

  const stale = store.next({ guildId: 'g1', channelId: 'c1', sessionId: first.id });
  assert.equal(stale.ok, false, 'a stale button advanced a replaced round');
  assert.equal(stale.reason, 'stale');
  assert.equal(store.get('g1', 'c1').id, second.id);
  assert.equal(store.get('g1', 'c1').asked, 1, 'the question changed anyway');
});

test('advancing a channel with no round is refused', () => {
  const { store } = makeStore();
  assert.equal(store.next({ guildId: 'g1', channelId: 'empty' }).ok, false);
});

test('ending a round removes it, and only its own', () => {
  const { store } = makeStore();
  const session = store.start({ guildId: 'g1', channelId: 'c1', type: 'dogruluk' }).session;
  store.start({ guildId: 'g1', channelId: 'c2', type: 'cesaret' });

  assert.equal(store.end({ guildId: 'g1', channelId: 'c1', sessionId: session.id }), true);
  assert.equal(store.get('g1', 'c1'), null);
  assert.ok(store.get('g1', 'c2'), 'ending one round ended another');
  assert.equal(store.end({ guildId: 'g1', channelId: 'c1' }), false, 'ending twice reported success');
});

test('a stale session id cannot end the current round', () => {
  const { store } = makeStore();
  store.start({ guildId: 'g1', channelId: 'c1', type: 'dogruluk' });
  const second = store.start({ guildId: 'g1', channelId: 'c1', type: 'cesaret' }).session;

  assert.equal(store.end({ guildId: 'g1', channelId: 'c1', sessionId: 'session1' }), false);
  assert.ok(store.get('g1', 'c1'), 'a stale id ended the live round');
  assert.equal(store.get('g1', 'c1').id, second.id);
});

/* -------------------------------------------------------------------------- */
/* Timeout                                                                     */
/* -------------------------------------------------------------------------- */

test('an idle round expires and is dropped', () => {
  const { store, advance } = makeStore({ timeoutMinutes: 30 });
  store.start({ guildId: 'g1', channelId: 'c1', type: 'dogruluk' });

  advance(29 * 60_000);
  assert.ok(store.get('g1', 'c1'), 'the round expired early');

  advance(2 * 60_000);
  assert.equal(store.get('g1', 'c1'), null, 'the round outlived its timeout');
  assert.equal(store.size, 0);
});

test('activity keeps a round alive', () => {
  const { store, advance } = makeStore({ timeoutMinutes: 30 });
  const session = store.start({ guildId: 'g1', channelId: 'c1', type: 'dogruluk' }).session;

  for (let round = 0; round < 4; round += 1) {
    advance(25 * 60_000);
    assert.equal(store.next({ guildId: 'g1', channelId: 'c1', sessionId: session.id }).ok, true, 'an active round expired');
  }
  assert.equal(store.get('g1', 'c1').asked, 5);
});

test('sweep drops only the expired rounds', () => {
  const { store, advance } = makeStore({ timeoutMinutes: 10 });
  store.start({ guildId: 'g1', channelId: 'old', type: 'dogruluk' });

  advance(11 * 60_000);
  store.start({ guildId: 'g1', channelId: 'fresh', type: 'cesaret' });

  assert.equal(store.sweep(), 1);
  assert.equal(store.size, 1);
  assert.ok(store.get('g1', 'fresh'));
});

/* -------------------------------------------------------------------------- */
/* Component ids                                                               */
/* -------------------------------------------------------------------------- */

test('a component id round-trips and carries no reward', () => {
  const id = partyComponentId(PARTY_ACTIONS.NEW, 'abc12345');
  assert.equal(id, 'party:new:abc12345');
  assert.deepEqual(parsePartyComponentId(id), { action: 'new', sessionId: 'abc12345' });
  assert.ok(isPartyComponent(id));

  const end = partyComponentId(PARTY_ACTIONS.END, 'abc12345');
  assert.equal(parsePartyComponentId(end).action, 'end');
});

test('a malformed component id is rejected rather than guessed at', () => {
  const bad = [
    '',
    'party',
    'party:new',
    'party:new:',
    'party:new:abc:123',
    'party:give:abc12345',
    'music:abc',
    'party:new:abc 123',
    'party:new:a',
    `party:new:${'x'.repeat(40)}`,
  ];
  for (const customId of bad) {
    assert.equal(parsePartyComponentId(customId), null, `${JSON.stringify(customId)} was accepted`);
  }
  assert.equal(parsePartyComponentId(null), null);
  assert.equal(isPartyComponent('music:pause'), false);
});
