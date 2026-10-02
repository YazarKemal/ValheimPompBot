import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardGuild, guardReadOnly, buildSnapshotDocument, SNAPSHOT_VERSION } from '../src/setup/snapshot.js';
import { createDiscordLikeGuild } from './helpers/fake-discord-guild.js';

/**
 * The snapshot module is the only place the bot reads a live server. These tests
 * pin down the read-only guarantee, because a regression here would mutate a
 * real guild during what is supposed to be an observation.
 */

function seededGuild() {
  return createDiscordLikeGuild({
    roles: [
      { id: 'r1', name: 'Yönetici', color: 0xc0392b },
      { id: 'r2', name: 'Jockie Music', managed: true },
    ],
    channels: [
      { id: 'cat1', name: '⛏️ MININGFOOLS', type: 4 },
      { id: 'c1', name: 'genel', type: 0, topic: 'sohbet', parentId: 'cat1' },
      { id: 'c2', name: 'MiningFools', type: 2 },
    ],
  });
}

/* -------------------------------------------------------------------------- */
/* Read-only guard                                                             */
/* -------------------------------------------------------------------------- */

test('the guard blocks mutating methods on the guild', () => {
  const { guild } = seededGuild();
  const guarded = guardReadOnly(guild, 'guild');

  for (const method of ['edit', 'delete', 'setName', 'setIcon']) {
    assert.throws(
      () => guarded[method](),
      (error) => {
        assert.equal(error.code, 'SNAPSHOT_READ_ONLY_VIOLATION');
        assert.match(error.message, /read-only/);
        return true;
      },
      `${method}() was not blocked`,
    );
  }
});

test('the guard blocks creating roles and channels through the managers', () => {
  const { guild } = seededGuild();
  const guarded = guardGuild(guild);

  assert.throws(() => guarded.roles.create({ name: 'x' }), /read-only/);
  assert.throws(() => guarded.channels.create({ name: 'x' }), /read-only/);
});

test('the guard leaves every read untouched', () => {
  const { guild } = seededGuild();
  const guarded = guardGuild(guild);

  assert.equal(guarded.id, 'guild-id');
  assert.equal(guarded.name, 'Valheim Pomp');
  assert.equal(guarded.memberCount, 42);
  assert.equal(guarded.roles.cache.size, 2);
  assert.equal(guarded.roles.cache.get('r1').name, 'Yönetici');
  assert.equal(guarded.channels.cache.find((c) => c.name === 'genel').id, 'c1');
  assert.equal(typeof guarded.roles.cache.get('r1').edit, 'function'); // readable, only calling is blocked
});

test('guarding is idempotent and preserves identity', () => {
  const { guild } = seededGuild();

  assert.equal(guardReadOnly(guild), guardReadOnly(guild));
});

test('non-objects pass through the guard unchanged', () => {
  assert.equal(guardReadOnly(null), null);
  assert.equal(guardReadOnly(42), 42);
  assert.equal(guardReadOnly('text'), 'text');
});

test('the blocked call is reported with the exact path for debugging', () => {
  const { guild } = seededGuild();
  const guarded = guardGuild(guild);

  assert.throws(
    () => guarded.channels.create({}),
    (error) => {
      assert.equal(error.details.method, 'create');
      assert.equal(error.details.label, 'guild.channels');
      assert.match(error.message, /guild\.channels\.create\(\)/);
      return true;
    },
  );
});

/* -------------------------------------------------------------------------- */
/* Document shape                                                              */
/* -------------------------------------------------------------------------- */

test('the snapshot document carries the guild identity', () => {
  const { guild } = seededGuild();
  const document = buildSnapshotDocument(guild, { capturedAt: '2026-01-02T03:04:05.000Z' });

  assert.equal(document.snapshotVersion, SNAPSHOT_VERSION);
  assert.equal(document.capturedAt, '2026-01-02T03:04:05.000Z');
  assert.equal(document.guild.id, 'guild-id');
  assert.equal(document.guild.name, 'Valheim Pomp');
  assert.equal(document.guild.memberCount, 42);
});

test('the snapshot document separates categories from channels', () => {
  const { guild } = seededGuild();
  const document = buildSnapshotDocument(guild);

  assert.deepEqual(document.categories.map((c) => c.name), ['⛏️ MININGFOOLS']);
  assert.deepEqual(document.channels.map((c) => c.name).sort(), ['MiningFools', 'genel']);
});

test('managed bot roles are reported separately and never planned against', () => {
  const { guild } = seededGuild();
  const document = buildSnapshotDocument(guild);

  assert.deepEqual(document.managedRoles.map((r) => r.name), ['Jockie Music']);
  assert.ok(
    !document.roles.some((role) => role.name === 'Jockie Music'),
    'a managed bot role leaked into the plannable role list',
  );
});

test('the snapshot document is JSON-serialisable', () => {
  const { guild } = seededGuild();
  const document = buildSnapshotDocument(guild);

  assert.deepEqual(JSON.parse(JSON.stringify(document)), document);
});

test('capturing a snapshot through the guard never mutates the guild', () => {
  const fake = seededGuild();
  const document = buildSnapshotDocument(guardGuild(fake.guild));

  assert.ok(document.channels.length > 0);
  assert.equal(fake.calls.length, 0, `the snapshot issued a write: ${JSON.stringify(fake.calls)}`);
});

test('a guild with no managed roles reports an empty list', () => {
  const { guild } = createDiscordLikeGuild({ roles: [{ id: 'r1', name: 'Oyuncu' }] });
  assert.deepEqual(buildSnapshotDocument(guild).managedRoles, []);
});
