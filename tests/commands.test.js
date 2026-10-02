import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCommands, toCommandJSON, toRegistrationPayload, validateCommandModule } from '../src/commands/index.js';

const COMMANDS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'commands');

test('every command in src/commands loads', async () => {
  const commands = await loadCommands(COMMANDS_DIR);

  assert.ok(commands.size >= 3, `expected at least 3 commands, found ${commands.size}`);
  for (const name of ['ping', 'help', 'ask']) {
    assert.ok(commands.has(name), `command "${name}" was not loaded`);
  }
});

test('commands expose the full contract', async () => {
  const commands = await loadCommands(COMMANDS_DIR);

  for (const [name, command] of commands) {
    assert.equal(command.name, name);
    assert.equal(typeof command.execute, 'function', `${name} has no execute()`);
    assert.equal(typeof command.meta, 'object', `${name} has no meta`);
    assert.equal(typeof command.data.name, 'string');
    assert.equal(typeof command.data.description, 'string');
    assert.equal(command.data.name, name, 'map key and payload name disagree');
  }
});

test('command payloads survive JSON serialisation for registration', async () => {
  const commands = await loadCommands(COMMANDS_DIR);
  const payload = toRegistrationPayload(commands);

  assert.equal(payload.length, commands.size);
  const roundTripped = JSON.parse(JSON.stringify(payload));
  assert.deepEqual(roundTripped, payload);
});

test('a discord.js builder and a plain object are both accepted', () => {
  const fromBuilder = toCommandJSON({ toJSON: () => ({ name: 'x', description: 'y' }) }, 'a.js');
  assert.deepEqual(fromBuilder, { name: 'x', description: 'y' });

  const fromObject = toCommandJSON({ name: 'x', description: 'y' }, 'b.js');
  assert.deepEqual(fromObject, { name: 'x', description: 'y' });
  assert.notEqual(fromObject, undefined);
});

test('validateCommandModule reports precise problems', () => {
  assert.deepEqual(validateCommandModule({ data: { name: 'ok', description: 'fine' }, execute() {} }), []);

  const missingExecute = validateCommandModule({ data: { name: 'ok', description: 'fine' } }, 'missing.js');
  assert.ok(missingExecute.some((problem) => problem.includes('execute')));

  const badName = validateCommandModule({ data: { name: 'NotLowerCase', description: 'x' }, execute() {} }, 'bad.js');
  assert.ok(badName.some((problem) => problem.includes('lowercase')));

  const noDescription = validateCommandModule({ data: { name: 'ok', description: '' }, execute() {} }, 'nodesc.js');
  assert.ok(noDescription.some((problem) => problem.includes('description')));

  const badData = validateCommandModule({ data: 42, execute() {} }, 'bad-data.js');
  assert.ok(badData.some((problem) => problem.includes('data')));
});

test('the command loader rejects a directory with a broken command', async () => {
  const brokenDir = path.join(COMMANDS_DIR, '..', '..', 'tests', 'helpers', 'broken-commands');

  await assert.rejects(
    () => loadCommands(brokenDir),
    (error) => {
      assert.equal(error.code, 'COMMAND_LOAD_FAILED');
      return true;
    },
  );
});

test('command modules do not reach for application singletons', async () => {
  const commands = await loadCommands(COMMANDS_DIR);
  const fs = await import('node:fs/promises');

  for (const command of commands.values()) {
    const source = await fs.readFile(command.filePath, 'utf8');
    assert.ok(!/from\s+['"].*\/config\//.test(source), `${command.name} imports config directly; use ctx instead`);
    assert.ok(!/process\.env/.test(source), `${command.name} reads process.env directly; use ctx instead`);
  }
});
