import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertGuildScoped,
  commandsMatch,
  deployGuildCommands,
  diffCommands,
  projectOnto,
} from '../src/deploy/index.js';
import { runDeployCli, parseArgs } from '../src/deploy/cli.js';
import { loadCommands } from '../src/commands/index.js';
import { createCapturingLogger } from '../src/utils/logger.js';

const COMMANDS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'commands');
const GUILD_ID = '111111111111111111';
const CLIENT_ID = '123456789012345678';

/** Fake REST client that records calls and serves a canned command list. */
function makeRest({ existing = [] } = {}) {
  const calls = [];
  return {
    calls,
    async get(route) {
      calls.push({ method: 'GET', route });
      return existing;
    },
    async put(route, options) {
      calls.push({ method: 'PUT', route, body: options.body });
      return options.body;
    },
  };
}

async function commands() {
  return loadCommands(COMMANDS_DIR, { owner: 'pompai' });
}

function baseOptions(overrides = {}) {
  return {
    token: 'unused-in-tests',
    clientId: CLIENT_ID,
    guildId: GUILD_ID,
    commands: null,
    logger: createCapturingLogger({ level: 'debug' }).logger,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Guild scoping                                                               */
/* -------------------------------------------------------------------------- */

test('registration refuses to run without a guild id', () => {
  for (const guildId of [null, undefined, '', '   ']) {
    assert.throws(
      () => assertGuildScoped(guildId),
      (error) => {
        assert.equal(error.code, 'DEPLOY_GUILD_REQUIRED');
        assert.match(error.message, /guild-scoped only/);
        return true;
      },
      `guild id ${JSON.stringify(guildId)} was accepted`,
    );
  }
});

test('registration never targets the global command route', async () => {
  const rest = makeRest();
  await deployGuildCommands({ ...baseOptions({ rest }), commands: await commands() });

  for (const call of rest.calls) {
    assert.match(call.route, /\/guilds\/\d+\/commands$/, `unexpected route: ${call.route}`);
    assert.ok(!/^\/applications\/\d+\/commands$/.test(call.route), 'a global route was used');
  }
});

test('the deploy CLI refuses to run without a guild id', async () => {
  const chunks = [];
  const exitCode = await runDeployCli({
    argv: [],
    stdout: { write: (c) => chunks.push(String(c)) },
    stderr: { write: (c) => chunks.push(String(c)) },
    env: { DISCORD_TOKEN: 'x'.repeat(60), DISCORD_CLIENT_ID: CLIENT_ID, DISCORD_GUILD_ID: '' },
  });

  assert.equal(exitCode, 1);
  assert.match(chunks.join(''), /guild-scoped only/);
});

/* -------------------------------------------------------------------------- */
/* Diffing                                                                     */
/* -------------------------------------------------------------------------- */

test('diffCommands classifies added, updated, unchanged and removed', () => {
  const existing = [
    { name: 'ping', description: 'old' },
    { name: 'stale', description: 'gone' },
  ];
  const desired = [
    { name: 'ping', description: 'new' },
    { name: 'status', description: 'fresh' },
  ];

  assert.deepEqual(diffCommands(existing, desired), {
    added: ['status'],
    updated: ['ping'],
    unchanged: [],
    removed: ['stale'],
  });
});

test('diffCommands reports an identical set as unchanged', () => {
  const desired = [{ name: 'ping', description: 'pong' }];
  assert.deepEqual(diffCommands([{ name: 'ping', description: 'pong' }], desired).unchanged, ['ping']);
});

/**
 * The exact shape Discord returns for a registered guild command, captured from
 * the live API. It carries server-assigned fields and drops defaults, so a
 * naive deep-equal reports every command as changed on every deploy.
 */
const REGISTERED_BY_DISCORD = {
  id: '1555349533402202277',
  application_id: '1555334946346893394',
  version: '1555349533402202281',
  default_member_permissions: null,
  type: 1,
  name: 'ping',
  description: 'Check that PompAI is awake and measure latency.',
  guild_id: '1555336684630184056',
  nsfw: false,
};

const DESIRED_PING = {
  options: [],
  name: 'ping',
  description: 'Check that PompAI is awake and measure latency.',
  dm_permission: false,
  type: 1,
};

test('a command registered by Discord is recognised as unchanged', () => {
  assert.deepEqual(diffCommands([REGISTERED_BY_DISCORD], [DESIRED_PING]), {
    added: [],
    updated: [],
    removed: [],
    unchanged: ['ping'],
  });
});

test('server-assigned fields never count as a change', () => {
  for (const field of ['id', 'version', 'application_id', 'guild_id', 'nsfw', 'default_member_permissions']) {
    const mutated = { ...REGISTERED_BY_DISCORD, [field]: 'changed-by-discord' };
    assert.deepEqual(
      diffCommands([mutated], [DESIRED_PING]).unchanged,
      ['ping'],
      `a change to "${field}" was treated as a real difference`,
    );
  }
});

test('a genuine change is still detected', () => {
  const renamed = { ...REGISTERED_BY_DISCORD, description: 'Something else entirely.' };
  assert.deepEqual(diffCommands([renamed], [DESIRED_PING]).updated, ['ping']);
});

test('projectOnto keeps only the fields we manage', () => {
  assert.deepEqual(projectOnto(REGISTERED_BY_DISCORD, DESIRED_PING), DESIRED_PING);
});

test('options are compared, including nested ones', () => {
  const remote = {
    ...REGISTERED_BY_DISCORD,
    name: 'ask',
    options: [{ type: 3, name: 'prompt', description: 'What do you want to ask?', required: true, max_length: 1500 }],
  };
  const desired = {
    options: [{ type: 3, name: 'prompt', description: 'What do you want to ask?', required: true, max_length: 1500 }],
    name: 'ask',
    description: 'x',
    dm_permission: false,
    type: 1,
  };

  assert.equal(commandsMatch({ ...remote, description: 'x' }, desired), true);

  const changed = { ...remote, description: 'x', options: [{ ...remote.options[0], max_length: 500 }] };
  assert.equal(commandsMatch(changed, desired), false, 'a nested option change was missed');
});

/* -------------------------------------------------------------------------- */
/* Safety: never silently drop a command                                       */
/* -------------------------------------------------------------------------- */

test('deploy refuses to remove a stale command unless told to', async () => {
  const rest = makeRest({ existing: [{ name: 'legacy', description: 'registered earlier' }] });
  const loaded = await commands();

  await assert.rejects(
    () => deployGuildCommands({ ...baseOptions({ rest }), commands: loaded }),
    (error) => {
      assert.equal(error.code, 'DEPLOY_WOULD_REMOVE');
      assert.match(error.message, /--allow-removals/);
      assert.deepEqual(error.details.removed, ['legacy']);
      return true;
    },
  );

  assert.equal(rest.calls.filter((call) => call.method === 'PUT').length, 0, 'a write happened despite the refusal');
});

test('deploy proceeds past a removal when explicitly allowed', async () => {
  const rest = makeRest({ existing: [{ name: 'legacy', description: 'x' }] });

  const result = await deployGuildCommands({
    ...baseOptions({ rest, allowRemovals: true }),
    commands: await commands(),
  });

  assert.deepEqual(result.diff.removed, ['legacy']);
  assert.equal(rest.calls.filter((call) => call.method === 'PUT').length, 1);
});

/* -------------------------------------------------------------------------- */
/* Dry run and idempotency                                                     */
/* -------------------------------------------------------------------------- */

test('a dry run reads but never writes', async () => {
  const rest = makeRest();
  const result = await deployGuildCommands({ ...baseOptions({ rest, dryRun: true }), commands: await commands() });

  assert.equal(result.dryRun, true);
  assert.deepEqual(result.registered, []);
  assert.equal(rest.calls.filter((call) => call.method === 'PUT').length, 0);
});

test('deploy registers every command in the payload', async () => {
  const rest = makeRest();
  const loaded = await commands();

  const result = await deployGuildCommands({ ...baseOptions({ rest }), commands: loaded });

  assert.deepEqual(result.registered.sort(), [
    'ask',
    'clear',
    'envanter',
    'fal',
    'gunluk',
    'help',
    'kaz',
    'lakap',
    'liderlik',
    'oyun',
    'oyun-temizle',
    'parti',
    'ping',
    'profil',
    'status',
    'ucretsiz',
  ]);
  const put = rest.calls.find((call) => call.method === 'PUT');
  assert.equal(put.body.length, loaded.size);
  for (const command of put.body) {
    assert.equal(typeof command.name, 'string');
    assert.equal(typeof command.description, 'string');
    assert.equal(command.dm_permission, false);
  }
});

test('re-registering the same set is a no-op edit', async () => {
  const loaded = await commands();
  const alreadyRegistered = (await import('../src/commands/index.js')).toRegistrationPayload(loaded);
  const rest = makeRest({ existing: alreadyRegistered });

  const result = await deployGuildCommands({ ...baseOptions({ rest }), commands: loaded });

  assert.deepEqual(result.diff.added, []);
  assert.deepEqual(result.diff.updated, []);
  assert.deepEqual(result.diff.removed, []);
  assert.equal(result.diff.unchanged.length, loaded.size);
});

test('deploy refuses an empty command set', async () => {
  const rest = makeRest();
  await assert.rejects(
    () => deployGuildCommands({ ...baseOptions({ rest }), commands: new Map() }),
    (error) => {
      assert.equal(error.code, 'DEPLOY_EMPTY');
      return true;
    },
  );
});

/* -------------------------------------------------------------------------- */
/* CLI                                                                         */
/* -------------------------------------------------------------------------- */

test('the deploy CLI parses its flags', () => {
  assert.deepEqual(parseArgs([]), { dryRun: false, allowRemovals: false, owner: 'pompai', help: false });
  assert.equal(parseArgs(['--dry-run']).dryRun, true);
  assert.equal(parseArgs(['--allow-removals']).allowRemovals, true);
  assert.equal(parseArgs(['-h']).help, true);
  assert.match(parseArgs(['--nope']).error, /Unknown argument/);
});

test('the deploy CLI prints usage on --help', async () => {
  const chunks = [];
  const exitCode = await runDeployCli({
    argv: ['--help'],
    stdout: { write: (c) => chunks.push(String(c)) },
    stderr: { write: (c) => chunks.push(String(c)) },
  });

  assert.equal(exitCode, 0);
  assert.match(chunks.join(''), /guild-scoped/);
});

test('the deploy CLI never prints the token', async () => {
  const secret = 'M'.repeat(24) + '.' + 'X'.repeat(6) + '.' + 'Y'.repeat(38);
  const chunks = [];
  const out = { write: (c) => chunks.push(String(c)) };

  await runDeployCli({
    argv: [],
    stdout: out,
    stderr: out,
    env: {
      DISCORD_TOKEN: secret,
      DISCORD_CLIENT_ID: CLIENT_ID,
      DISCORD_GUILD_ID: GUILD_ID,
      LOG_LEVEL: 'debug',
    },
    deploy: async () => ({ dryRun: false, diff: { added: ['ping'], updated: [], unchanged: [], removed: [] }, registered: ['ping'] }),
  });

  assert.ok(!chunks.join('').includes(secret), 'the token was printed');
  assert.match(chunks.join(''), /Registered 1 command/);
});

test('the deploy CLI reports a refusal readably', async () => {
  const chunks = [];
  const exitCode = await runDeployCli({
    argv: [],
    stdout: { write: (c) => chunks.push(String(c)) },
    stderr: { write: (c) => chunks.push(String(c)) },
    env: { DISCORD_TOKEN: 'x'.repeat(60), DISCORD_CLIENT_ID: CLIENT_ID, DISCORD_GUILD_ID: GUILD_ID },
    deploy: async () => {
      const { BotError } = await import('../src/utils/errors.js');
      throw new BotError('Refusing to register: legacy would be removed.', { code: 'DEPLOY_WOULD_REMOVE' });
    },
  });

  assert.equal(exitCode, 1);
  assert.match(chunks.join(''), /DEPLOY_WOULD_REMOVE/);
});
