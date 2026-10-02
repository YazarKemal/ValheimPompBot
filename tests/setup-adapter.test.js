import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionsBitField } from 'discord.js';
import { createDiscordGuildAdapter, hexToInt } from '../src/setup/adapter.js';
import { createDiscordLikeGuild } from './helpers/fake-discord-guild.js';

/**
 * These tests exist because of a specific trap: discord.js's
 * `permissionOverwrites.edit()` takes a per-permission map
 * (`{ SendMessages: false }`) and silently ignores the `{ allow, deny }`
 * bitfield shape - the call resolves, nothing changes, and the failure is
 * invisible. Everything here asserts the shapes discord.js actually honours.
 */

test('hexToInt converts colours and tolerates junk', () => {
  assert.equal(hexToInt('#c0392b'), 0xc0392b);
  assert.equal(hexToInt('c0392b'), 0xc0392b);
  assert.equal(hexToInt(null), 0);
  assert.equal(hexToInt(''), 0);
  assert.equal(hexToInt('not-a-colour'), 0);
});

test('resolveRoleId matches case-insensitively and special-cases @everyone', () => {
  const { guild } = createDiscordLikeGuild({ roles: [{ id: 'r1', name: 'Drengr' }] });
  const adapter = createDiscordGuildAdapter(guild);

  assert.equal(adapter.resolveRoleId('Drengr'), 'r1');
  assert.equal(adapter.resolveRoleId('drengr'), 'r1');
  assert.equal(adapter.resolveRoleId('@everyone'), 'guild-id');
  assert.equal(adapter.resolveRoleId('@Everyone'), 'guild-id');
  assert.equal(adapter.resolveRoleId('Missing'), null);
});

test('createRole sends an integer colour and a PermissionsBitField', async () => {
  const { guild, callsOf } = createDiscordLikeGuild();
  const adapter = createDiscordGuildAdapter(guild);

  await adapter.createRole({
    name: 'Chieftain',
    color: '#c0392b',
    hoist: true,
    mentionable: true,
    permissions: ['ManageGuild', 'ViewChannel'],
  });

  const [call] = callsOf('roles.create');
  assert.equal(call.payload.color, 0xc0392b);
  assert.equal(call.payload.hoist, true);
  assert.ok(call.payload.permissions instanceof PermissionsBitField);
  assert.ok(call.payload.permissions.has('ManageGuild'));
  assert.match(call.payload.reason, /blueprint/);
});

test('createChannel applies overwrites through the per-permission options map', async () => {
  const { guild, callsOf } = createDiscordLikeGuild({ roles: [{ id: 'r1', name: 'Drengr' }] });
  const adapter = createDiscordGuildAdapter(guild);

  await adapter.createChannel({
    name: 'rules',
    type: 'text',
    topic: 'Read me',
    parentName: null,
    overwrites: [{ role: 'Drengr', allow: ['ViewChannel'], deny: ['SendMessages'] }],
  });

  const [overwrite] = callsOf('overwrites.create');
  assert.ok(overwrite, 'no overwrite was written');
  assert.equal(overwrite.roleId, 'r1');
  assert.equal(overwrite.options.ViewChannel, true);
  assert.equal(overwrite.options.SendMessages, false);
  // The shape discord.js ignores must never be used.
  assert.equal(overwrite.options.allow, undefined);
  assert.equal(overwrite.options.deny, undefined);
});

test('createChannel writes one overwrite per role, including @everyone', async () => {
  const { guild, callsOf } = createDiscordLikeGuild({ roles: [{ id: 'r1', name: 'Elder' }] });
  const adapter = createDiscordGuildAdapter(guild);

  await adapter.createChannel({
    name: 'staff-chat',
    type: 'text',
    parentName: null,
    overwrites: [
      { role: '@everyone', allow: [], deny: ['ViewChannel'] },
      { role: 'Elder', allow: ['ViewChannel'], deny: [] },
    ],
  });

  const overwrites = callsOf('overwrites.create');
  assert.equal(overwrites.length, 2);
  assert.equal(overwrites.find((call) => call.roleId === 'guild-id').options.ViewChannel, false);
  assert.equal(overwrites.find((call) => call.roleId === 'r1').options.ViewChannel, true);
});

test('createChannel links the category it was asked for', async () => {
  const { guild, callsOf } = createDiscordLikeGuild({
    channels: [{ id: 'cat1', name: 'COMMUNITY', type: 4 }],
  });
  const adapter = createDiscordGuildAdapter(guild);

  await adapter.createChannel({ name: 'general', type: 'text', topic: 'chat', parentName: 'COMMUNITY' });

  assert.equal(callsOf('channels.create')[0].payload.parent, 'cat1');
});

test('createChannel fails loudly when the category is missing', async () => {
  const { guild } = createDiscordLikeGuild();
  const adapter = createDiscordGuildAdapter(guild);

  await assert.rejects(
    () => adapter.createChannel({ name: 'general', type: 'text', parentName: 'GHOST' }),
    (error) => {
      assert.equal(error.code, 'SETUP_CATEGORY_NOT_FOUND');
      return true;
    },
  );
});

test('createChannel rejects an unsupported channel type', async () => {
  const { guild } = createDiscordLikeGuild();
  const adapter = createDiscordGuildAdapter(guild);

  await assert.rejects(
    () => adapter.createChannel({ name: 'x', type: 'hologram' }),
    (error) => {
      assert.equal(error.code, 'SETUP_CHANNEL_TYPE_UNSUPPORTED');
      return true;
    },
  );
});

test('updateChannel edits metadata and replays only the supplied overwrite edits', async () => {
  const { guild, callsOf } = createDiscordLikeGuild({
    roles: [{ id: 'r1', name: 'Drengr' }],
    channels: [{ id: 'c1', name: 'general', type: 0 }],
  });
  const adapter = createDiscordGuildAdapter(guild);

  await adapter.updateChannel('c1', {
    topic: 'new topic',
    overwriteEdits: [{ role: 'Drengr', allow: ['AttachFiles'], deny: [] }],
  });

  assert.equal(callsOf('channel.edit')[0].payload.topic, 'new topic');
  const overwrites = callsOf('overwrites.create');
  assert.equal(overwrites.length, 1);
  assert.equal(overwrites[0].options.AttachFiles, true);
});

test('updateChannel does not touch Discord when nothing changed', async () => {
  const { guild, calls } = createDiscordLikeGuild({ channels: [{ id: 'c1', name: 'general', type: 0 }] });
  const adapter = createDiscordGuildAdapter(guild);

  await adapter.updateChannel('c1', {});

  assert.equal(calls.length, 0);
});

test('updateChannel moves a channel and clears its parent when asked', async () => {
  const { guild, callsOf } = createDiscordLikeGuild({
    channels: [
      { id: 'cat1', name: 'COMMUNITY', type: 4 },
      { id: 'c1', name: 'general', type: 0 },
    ],
  });
  const adapter = createDiscordGuildAdapter(guild);

  await adapter.updateChannel('c1', { parentName: 'COMMUNITY' });
  assert.equal(callsOf('channel.edit')[0].payload.parent, 'cat1');

  await adapter.updateChannel('c1', { parentName: null });
  assert.equal(callsOf('channel.edit')[1].payload.parent, null);
});

test('updateRole adds permissions without dropping existing ones', async () => {
  const existing = new PermissionsBitField(['ViewChannel']);
  const { guild, callsOf } = createDiscordLikeGuild({
    roles: [{ id: 'r1', name: 'Elder', permissions: existing }],
  });
  const adapter = createDiscordGuildAdapter(guild);

  await adapter.updateRole('r1', { color: '#e67e22', addPermissions: ['KickMembers'] });

  const [call] = callsOf('role.edit');
  assert.equal(call.payload.color, 0xe67e22);
  assert.ok(call.payload.permissions.has('KickMembers'), 'the new permission was not added');
  assert.ok(call.payload.permissions.has('ViewChannel'), 'an existing permission was dropped');
});

test('updateRole reports a vanished role instead of throwing a TypeError', async () => {
  const { guild } = createDiscordLikeGuild();
  const adapter = createDiscordGuildAdapter(guild);

  await assert.rejects(
    () => adapter.updateRole('gone', { hoist: true }),
    (error) => {
      assert.equal(error.code, 'SETUP_ROLE_MISSING');
      return true;
    },
  );
});

test('an unresolvable overwrite role is reported, not silently skipped', async () => {
  const { guild } = createDiscordLikeGuild();
  const adapter = createDiscordGuildAdapter(guild);

  await assert.rejects(
    () =>
      adapter.createChannel({
        name: 'x',
        type: 'text',
        parentName: null,
        overwrites: [{ role: 'Ghost', allow: ['ViewChannel'], deny: [] }],
      }),
    (error) => {
      assert.equal(error.code, 'SETUP_ROLE_NOT_FOUND');
      return true;
    },
  );
});
