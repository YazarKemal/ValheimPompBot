import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MessageFlags } from 'discord.js';
import { loadCommands } from '../src/commands/index.js';
import { createAIClient } from '../src/ai/index.js';
import { createRegistry } from '../src/ai/registry.js';
import { StubProvider } from '../src/ai/providers/stub.js';
import { execute as handleInteractionCreate } from '../src/events/interactionCreate.js';

/**
 * Regression coverage for the live incident where a `/ask` invocation with a
 * long prompt came back as "Echo: naber".
 *
 * These tests drive the real path - interactionCreate -> /ask handler -> AI
 * client -> provider - and assert that every request carries only the prompt of
 * its own interaction, sequentially and concurrently.
 */

const COMMANDS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'commands');

// userCooldownSeconds: 0 keeps the per-user cooldown out of these tests; prompt
// isolation is the property under test here. Cooldowns are covered separately.
const STUB_CONFIG = { provider: 'stub', apiKey: null, model: null, timeoutMs: 30000, userCooldownSeconds: 0 };

/** The prompt from the incident report. */
const REPORTED_PROMPT = 'Son 3 günde maden sistemiyle ilgili aldığımız kararları özetle';
/** The stale value that was echoed instead. */
const STALE_PROMPT = 'naber';

/**
 * Minimal interaction double. Options are captured per interaction in a
 * closure, so one double can never observe another's values.
 */
function makeInteraction({ id = 'interaction-1', userId = 'user-1', prompt } = {}) {
  const calls = { reply: [], editReply: [], deferReply: [], followUp: [] };
  const interaction = {
    id,
    commandName: 'ask',
    user: { id: userId, tag: `${userId}#0001` },
    client: { ws: { ping: 42 } },
    deferred: false,
    replied: false,
    isChatInputCommand: () => true,
    options: {
      getString: (name, required) => (name === 'prompt' ? prompt : required ? 'default' : null),
    },
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

/** Builds the ctx the event handler passes to commands. */
function makeCtx(ai, commands) {
  return {
    ai,
    commands,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    config: { ai: STUB_CONFIG },
  };
}

/** The final reply the interaction received, after checking it was public. */
function finalReply(interaction) {
  const deferred = interaction.calls.deferReply.at(-1);
  assert.ok(deferred, `interaction ${interaction.id} never deferred`);
  assert.equal(
    deferred.flags & MessageFlags.Ephemeral,
    0,
    `interaction ${interaction.id} deferred privately; AI answers are public`,
  );

  const payload = interaction.calls.editReply.at(-1);
  assert.ok(typeof payload === 'string', `interaction ${interaction.id} never got a reply`);
  return payload;
}

/** Provider that records every request before behaving like the stub. */
class RecordingStubProvider extends StubProvider {
  constructor(options = {}) {
    super(options);
    this.requests = [];
  }

  async complete(request) {
    this.requests.push(request);
    return super.complete(request);
  }
}

/**
 * Lets the test hold provider calls open until it releases them, so two
 * completions can be forced to finish out of order - the interleaving that
 * would expose shared per-request state.
 */
function createProviderGate() {
  const deferred = [];
  let notifyEntered = null;

  return {
    enter() {
      const promise = new Promise((resolve) => deferred.push({ release: resolve }));
      notifyEntered?.();
      return promise;
    },
    async waitFor(count) {
      while (deferred.length < count) {
        await new Promise((resolve) => {
          notifyEntered = resolve;
        });
      }
    },
    release(index) {
      deferred[index].release();
    },
  };
}

class GatedStubProvider extends RecordingStubProvider {
  constructor(options, gate) {
    super(options);
    this.gate = gate;
  }

  async complete(request) {
    this.requests.push(request);
    await this.gate.enter();
    return StubProvider.prototype.complete.call(this, request);
  }
}

/* -------------------------------------------------------------------------- */
/* Single interaction                                                          */
/* -------------------------------------------------------------------------- */

test('the stub echoes exactly the current interaction prompt', async () => {
  const commands = await loadCommands(COMMANDS_DIR);
  const ctx = makeCtx(createAIClient(STUB_CONFIG), commands);
  const interaction = makeInteraction({ prompt: REPORTED_PROMPT });

  await handleInteractionCreate(interaction, ctx);

  const lines = finalReply(interaction).split('\n');
  assert.equal(lines.at(-1), `Echo: ${REPORTED_PROMPT}`);
  assert.ok(!finalReply(interaction).includes(STALE_PROMPT), 'the stale value leaked into the answer');
});

/* -------------------------------------------------------------------------- */
/* Sequential interactions                                                     */
/* -------------------------------------------------------------------------- */

test('two sequential /ask interactions with different prompts never cross', async () => {
  const commands = await loadCommands(COMMANDS_DIR);
  // One shared ctx, exactly as the live bot holds one AI client for every
  // interaction it serves.
  const ctx = makeCtx(createAIClient(STUB_CONFIG), commands);

  const first = makeInteraction({ id: 'first', userId: 'user-1', prompt: REPORTED_PROMPT });
  const second = makeInteraction({ id: 'second', userId: 'user-1', prompt: STALE_PROMPT });

  await handleInteractionCreate(first, ctx);
  await handleInteractionCreate(second, ctx);

  const firstReply = finalReply(first);
  const secondReply = finalReply(second);

  assert.ok(firstReply.includes(`Echo: ${REPORTED_PROMPT}`), 'the first prompt was not echoed verbatim');
  assert.ok(!firstReply.includes(STALE_PROMPT), 'the second prompt leaked into the first reply');

  assert.equal(secondReply.split('\n').at(-1), `Echo: ${STALE_PROMPT}`);
  assert.ok(!secondReply.includes(REPORTED_PROMPT), 'the first prompt leaked into the second reply');
});

test('each request is a fresh object built from its own prompt', async () => {
  const commands = await loadCommands(COMMANDS_DIR);
  const registry = createRegistry();
  const provider = new RecordingStubProvider();
  registry.register('recording-stub', () => provider);
  const ctx = makeCtx(createAIClient({ ...STUB_CONFIG, provider: 'recording-stub' }, { registry }), commands);

  await handleInteractionCreate(makeInteraction({ id: 'a', userId: 'user-1', prompt: REPORTED_PROMPT }), ctx);
  await handleInteractionCreate(makeInteraction({ id: 'b', userId: 'user-1', prompt: STALE_PROMPT }), ctx);

  assert.equal(provider.requests.length, 2);
  const [first, second] = provider.requests;

  assert.notEqual(first, second, 'the same request object was reused');
  assert.notEqual(first.messages, second.messages, 'the same messages array was reused');
  assert.notEqual(first.messages[0], second.messages[0], 'the same message object was reused');

  assert.deepEqual(first.messages, [{ role: 'user', content: REPORTED_PROMPT }]);
  assert.deepEqual(second.messages, [{ role: 'user', content: STALE_PROMPT }]);
});

/* -------------------------------------------------------------------------- */
/* Concurrent interactions                                                     */
/* -------------------------------------------------------------------------- */

test('two concurrent /ask interactions from two users keep their own prompts', async () => {
  const commands = await loadCommands(COMMANDS_DIR);
  const registry = createRegistry();
  const gate = createProviderGate();
  const provider = new GatedStubProvider({}, gate);
  registry.register('gated-stub', () => provider);
  const ctx = makeCtx(createAIClient({ ...STUB_CONFIG, provider: 'gated-stub' }, { registry }), commands);

  const alice = makeInteraction({ id: 'alice-1', userId: 'alice', prompt: REPORTED_PROMPT });
  const bob = makeInteraction({ id: 'bob-1', userId: 'bob', prompt: STALE_PROMPT });

  const both = Promise.all([handleInteractionCreate(alice, ctx), handleInteractionCreate(bob, ctx)]);

  // Both requests are in flight before either provider call is allowed to
  // finish, and they complete in reverse order.
  await gate.waitFor(2);
  gate.release(1);
  gate.release(0);
  await both;

  const aliceReply = finalReply(alice);
  const bobReply = finalReply(bob);

  assert.equal(aliceReply.split('\n').at(-1), `Echo: ${REPORTED_PROMPT}`);
  assert.equal(bobReply.split('\n').at(-1), `Echo: ${STALE_PROMPT}`);

  assert.ok(!aliceReply.includes(STALE_PROMPT), "bob's prompt leaked into alice's reply");
  assert.ok(!bobReply.includes(REPORTED_PROMPT), "alice's prompt leaked into bob's reply");

  const contents = provider.requests.map((request) => request.messages[0].content).sort();
  assert.deepEqual(contents, [REPORTED_PROMPT, STALE_PROMPT].sort());
  for (const request of provider.requests) {
    assert.equal(request.messages.length, 1, 'a request carried more than the current prompt');
  }
});

test('a burst of interactions from many users each echo only their own prompt', async () => {
  const commands = await loadCommands(COMMANDS_DIR);
  const ctx = makeCtx(createAIClient(STUB_CONFIG), commands);

  const cases = Array.from({ length: 8 }, (_, index) => ({
    interaction: makeInteraction({
      id: `burst-${index}`,
      userId: `user-${index}`,
      prompt: `prompt-${index}-${'x'.repeat(index)}`,
    }),
    prompt: `prompt-${index}-${'x'.repeat(index)}`,
  }));

  await Promise.all(cases.map(({ interaction }) => handleInteractionCreate(interaction, ctx)));

  for (const { interaction, prompt } of cases) {
    assert.equal(finalReply(interaction).split('\n').at(-1), `Echo: ${prompt}`);
  }
});
