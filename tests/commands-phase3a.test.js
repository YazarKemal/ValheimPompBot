import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MessageFlags } from 'discord.js';
import { loadCommands } from '../src/commands/index.js';
import { createAIClient } from '../src/ai/index.js';
import { formatDuration } from '../src/commands/status.js';
import { NOT_CONFIGURED_NOTICE } from '../src/commands/ask.js';

const COMMANDS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'commands');

// userCooldownSeconds: 0 keeps the per-user cooldown (Phase 3B) out of these
// command-shape tests; the cooldown has its own coverage in ask-phase3b.test.js.
const STUB_CONFIG = { provider: 'stub', apiKey: null, model: null, timeoutMs: 30000, userCooldownSeconds: 0 };

/** Builds the ctx a command receives, with a real (offline) AI client. */
function makeCtx(overrides = {}) {
  const ai = createAIClient(STUB_CONFIG);
  return {
    ai,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    commands: new Map(),
    startedAt: Date.now() - 5000,
    config: { ai: STUB_CONFIG, dryRun: true },
    ...overrides,
  };
}

/** Minimal interaction double that records what the command sent. */
function makeInteraction({ options = {} } = {}) {
  const calls = { reply: [], editReply: [], deferReply: [], followUp: [] };
  const interaction = {
    client: { ws: { ping: 42 } },
    deferred: false,
    replied: false,
    options: { getString: (name, required) => options[name] ?? (required ? 'default' : null) },
    async reply(payload) {
      calls.reply.push(payload);
      interaction.replied = true;
      return payload;
    },
    async editReply(payload) {
      calls.editReply.push(payload);
      return payload;
    },
    async deferReply(payload) {
      calls.deferReply.push(payload);
      interaction.deferred = true;
      return payload;
    },
    async followUp(payload) {
      calls.followUp.push(payload);
      return payload;
    },
    calls,
  };
  return interaction;
}

const isEphemeral = (payload) => Boolean(payload?.flags & MessageFlags.Ephemeral);

/* -------------------------------------------------------------------------- */
/* Registration set                                                            */
/* -------------------------------------------------------------------------- */

test('exactly the expected commands are loaded', async () => {
  const commands = await loadCommands(COMMANDS_DIR, { owner: 'pompai' });

  assert.deepEqual([...commands.keys()].sort(), [
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
});

test('every command is guild-scoped and non-DM', async () => {
  const commands = await loadCommands(COMMANDS_DIR, { owner: 'pompai' });

  for (const command of commands.values()) {
    assert.equal(command.data.dm_permission, false, `${command.name} allows DMs`);
  }
});

test('deploy modules are not mistaken for slash commands', async () => {
  const commands = await loadCommands(COMMANDS_DIR, { owner: 'pompai' });
  assert.ok(!commands.has('deploy'), 'src/deploy leaked into the command set');
  assert.ok(!commands.has('deploy-cli'));
});

/* -------------------------------------------------------------------------- */
/* /ping                                                                       */
/* -------------------------------------------------------------------------- */

test('/ping replies ephemerally with latency', async () => {
  const commands = await loadCommands(COMMANDS_DIR, { owner: 'pompai' });
  const interaction = makeInteraction();

  await commands.get('ping').execute(interaction, makeCtx());

  assert.equal(interaction.calls.reply.length, 1);
  assert.equal(isEphemeral(interaction.calls.reply[0]), true, '/ping is not ephemeral');

  const final = interaction.calls.editReply.at(-1).content;
  assert.match(final, /Pong/);
  assert.match(final, /Round trip: `\d+ms`/);
  assert.match(final, /Gateway: `42ms`/);
});

test('/ping tolerates a client without a websocket ping', async () => {
  const commands = await loadCommands(COMMANDS_DIR, { owner: 'pompai' });
  const interaction = makeInteraction();
  interaction.client = {};

  await commands.get('ping').execute(interaction, makeCtx());

  assert.match(interaction.calls.editReply.at(-1).content, /unavailable/);
});

/* -------------------------------------------------------------------------- */
/* /status                                                                     */
/* -------------------------------------------------------------------------- */

test('/status shows the required fields', async () => {
  const commands = await loadCommands(COMMANDS_DIR, { owner: 'pompai' });
  const interaction = makeInteraction();
  const ctx = makeCtx({ commands: new Map([['ping', {}], ['help', {}]]) });

  await commands.get('status').execute(interaction, ctx);

  const [payload] = interaction.calls.reply;
  assert.equal(isEphemeral(payload), true);

  const embed = payload.embeds[0].toJSON();
  const names = embed.fields.map((field) => field.name);
  assert.ok(names.includes('Status'));
  assert.ok(names.includes('Uptime'));
  assert.ok(names.includes('Node'));
  assert.ok(names.includes('AI provider'));
  assert.ok(names.includes('AI model'));

  const byName = Object.fromEntries(embed.fields.map((field) => [field.name, field.value]));
  assert.match(byName.Status, /Online/);
  assert.equal(byName.Node, `\`${process.version}\``);
  assert.equal(byName['AI provider'], '`stub`');
});

test('/status never exposes the token or the API key', async () => {
  const commands = await loadCommands(COMMANDS_DIR, { owner: 'pompai' });
  const interaction = makeInteraction();

  const secretToken = 'M'.repeat(24) + '.' + 'X'.repeat(6) + '.' + 'Y'.repeat(38);
  const ctx = makeCtx({
    config: {
      discord: { token: secretToken, clientId: '1'.repeat(18), guildId: '2'.repeat(18) },
      ai: { provider: 'stub', apiKey: 'sk-must-not-appear', model: null, timeoutMs: 30000 },
    },
  });

  await commands.get('status').execute(interaction, ctx);

  const rendered = JSON.stringify(interaction.calls.reply[0]);
  assert.ok(!rendered.includes(secretToken), 'the Discord token leaked into /status');
  assert.ok(!rendered.includes('sk-must-not-appear'), 'the API key leaked into /status');
});

test('/status says plainly that no real AI is configured', async () => {
  const commands = await loadCommands(COMMANDS_DIR, { owner: 'pompai' });
  const interaction = makeInteraction();

  await commands.get('status').execute(interaction, makeCtx());

  const embed = interaction.calls.reply[0].embeds[0].toJSON();
  const config = embed.fields.find((field) => field.name === 'AI configuration');
  assert.match(config.value, /No real AI provider is configured yet/);
  assert.match(config.value, /No paid API calls/);
});

test('formatDuration renders readable uptimes', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(5_000), '5s');
  assert.equal(formatDuration(65_000), '1m 5s');
  assert.equal(formatDuration(3_665_000), '1h 1m 5s');
  assert.equal(formatDuration(90_065_000), '1d 1h 1m 5s');
  assert.equal(formatDuration(-100), '0s');
});

/* -------------------------------------------------------------------------- */
/* /help                                                                       */
/* -------------------------------------------------------------------------- */

test('/help renders an embed listing every command', async () => {
  const commands = await loadCommands(COMMANDS_DIR, { owner: 'pompai' });
  const interaction = makeInteraction();

  await commands.get('help').execute(interaction, makeCtx({ commands }));

  const embed = interaction.calls.reply[0].embeds[0].toJSON();
  assert.match(embed.title, /PompAI/);
  assert.match(embed.description, /MiningFools/);

  const names = embed.fields.map((field) => field.name);
  for (const commandName of commands.keys()) {
    assert.ok(names.includes(`/${commandName}`), `/${commandName} is missing from /help`);
  }
});

test('/help lists commands in a deliberate order', async () => {
  const commands = await loadCommands(COMMANDS_DIR, { owner: 'pompai' });
  const interaction = makeInteraction();

  await commands.get('help').execute(interaction, makeCtx({ commands }));

  const names = interaction.calls.reply[0].embeds[0].toJSON().fields.map((field) => field.name);
  assert.deepEqual(names.slice(0, 5), ['/help', '/ping', '/status', '/ask', '/clear']);
});

/* -------------------------------------------------------------------------- */
/* /ask                                                                        */
/* -------------------------------------------------------------------------- */

test('/ask uses the stub and says AI is not configured', async () => {
  const commands = await loadCommands(COMMANDS_DIR, { owner: 'pompai' });
  const interaction = makeInteraction({ options: { prompt: 'Merhaba PompAI' } });

  await commands.get('ask').execute(interaction, makeCtx());

  assert.equal(interaction.calls.deferReply.length, 1);
  // AI answers are public; the "not configured" notice is part of the answer.
  assert.equal(isEphemeral(interaction.calls.deferReply[0]), false);

  const answer = interaction.calls.editReply.at(-1);
  assert.match(answer, /no real AI provider configured yet/i);
  assert.match(answer, /Merhaba PompAI/, 'the stub did not echo the prompt');
  assert.match(answer, /stub/);
});

test('/ask does not touch the network', async () => {
  const commands = await loadCommands(COMMANDS_DIR, { owner: 'pompai' });
  const interaction = makeInteraction({ options: { prompt: 'hi' } });

  // Any global fetch during this command would be a real API call.
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = () => {
    called = true;
    throw new Error('network access attempted');
  };

  try {
    await commands.get('ask').execute(interaction, makeCtx());
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(called, false, '/ask attempted a network call');
  assert.ok(!/error/i.test(interaction.calls.editReply.at(-1)), 'the command reported an error');
});

test('/ask reports a provider failure without leaking it as a crash', async () => {
  const commands = await loadCommands(COMMANDS_DIR, { owner: 'pompai' });
  const interaction = makeInteraction({ options: { prompt: 'hi' } });
  const ctx = makeCtx({
    ai: {
      describe: () => ({ provider: 'openai', model: null, configured: false, live: false, stub: false }),
      complete: async () => {
        throw new Error('provider exploded');
      },
    },
  });

  await commands.get('ask').execute(interaction, ctx);

  assert.match(interaction.calls.editReply.at(-1), /could not answer/);
});

test('/ask truncates an oversized answer to fit a Discord message', async () => {
  const commands = await loadCommands(COMMANDS_DIR, { owner: 'pompai' });
  const interaction = makeInteraction({ options: { prompt: 'hi' } });
  const ctx = makeCtx({
    ai: {
      describe: () => ({ provider: 'stub', model: 'x', configured: true, live: false, stub: true }),
      complete: async () => ({ text: 'z'.repeat(5000), provider: 'stub', model: 'x' }),
    },
  });

  await commands.get('ask').execute(interaction, ctx);

  const answer = interaction.calls.editReply.at(-1);
  assert.ok(answer.length <= 2000, `answer was ${answer.length} characters`);
});

test('the not-configured notice names no secrets and no vendor', () => {
  assert.match(NOT_CONFIGURED_NOTICE, /no real AI provider configured yet/i);
  assert.match(NOT_CONFIGURED_NOTICE, /No paid API calls/);
  assert.ok(!/sk-|token/i.test(NOT_CONFIGURED_NOTICE));
});
