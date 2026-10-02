import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Events } from 'discord.js';
import { loadEvents, registerEvents, validateEventModule } from '../src/events/index.js';

const EVENTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'events');

test('every event in src/events loads', async () => {
  const events = await loadEvents(EVENTS_DIR);

  const names = events.map((event) => event.name);
  assert.ok(names.includes(Events.ClientReady));
  assert.ok(names.includes(Events.InteractionCreate));
  assert.ok(names.includes(Events.Error));
});

test('ready is registered as a one-shot handler', async () => {
  const events = await loadEvents(EVENTS_DIR);
  const ready = events.find((event) => event.name === Events.ClientReady);

  assert.equal(ready.once, true);
  const interaction = events.find((event) => event.name === Events.InteractionCreate);
  assert.equal(interaction.once, false);
});

test('validateEventModule catches malformed modules', () => {
  assert.deepEqual(validateEventModule({ name: 'ready', execute() {}, once: true }), []);
  assert.ok(validateEventModule({ execute() {} }).some((p) => p.includes('name')));
  assert.ok(validateEventModule({ name: 'ready' }).some((p) => p.includes('execute')));
  assert.ok(validateEventModule({ name: 'ready', execute() {}, once: 'yes' }).some((p) => p.includes('once')));
});

test('registerEvents binds to the client and injects ctx last', () => {
  const client = new EventEmitter();
  const seen = [];
  const ctx = { logger: { error() {} }, marker: 'ctx' };

  const unbind = registerEvents(
    client,
    [{ name: 'ping', once: false, execute: (...args) => seen.push(args) }],
    ctx,
  );

  client.emit('ping', 'first');
  assert.deepEqual(seen[0], ['first', ctx]);

  unbind();
  client.emit('ping', 'second');
  assert.equal(seen.length, 1, 'handler still bound after unbind');
});

test('once handlers fire a single time', () => {
  const client = new EventEmitter();
  let calls = 0;

  registerEvents(client, [{ name: 'ready', once: true, execute: () => { calls += 1; } }], {});

  client.emit('ready');
  client.emit('ready');
  assert.equal(calls, 1);
});

test('a rejecting async handler does not become an unhandled rejection', async () => {
  const client = new EventEmitter();
  const logged = [];
  const ctx = { logger: { error: (message) => logged.push(message) } };

  registerEvents(
    client,
    [{ name: 'boom', once: false, execute: async () => { throw new Error('nope'); } }],
    ctx,
  );

  client.emit('boom');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(logged.length, 1);
  assert.match(logged[0], /boom/);
});

test('the interaction handler ignores non-command interactions', async () => {
  const events = await loadEvents(EVENTS_DIR);
  const handler = events.find((event) => event.name === Events.InteractionCreate);
  const ctx = { logger: { warn() {}, debug() {}, error() {} }, commands: new Map() };

  // A button interaction has isChatInputCommand() === false and must be a no-op.
  await assert.doesNotReject(() => handler.execute({ isChatInputCommand: () => false }, ctx));
});
