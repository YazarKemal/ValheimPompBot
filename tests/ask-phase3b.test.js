import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MessageFlags } from 'discord.js';
import { loadCommands } from '../src/commands/index.js';
import { resetAskState, splitForDiscord, DISCORD_MESSAGE_LIMIT } from '../src/commands/ask.js';
import { AIAuthenticationError, AIRequestTimeoutError } from '../src/ai/errors.js';

const COMMANDS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'commands');

const LIVE_AI = { provider: 'deepseek', model: 'deepseek-flash', configured: true, live: true, stub: false };

beforeEach(() => {
  resetAskState();
});

/** Interaction double; options are captured per interaction in a closure. */
function makeInteraction({ id = 'i-1', userId = 'user-1', prompt } = {}) {
  const calls = { reply: [], editReply: [], deferReply: [], followUp: [] };
  const interaction = {
    id,
    commandName: 'ask',
    user: { id: userId, tag: `${userId}#0001` },
    client: { ws: { ping: 42 } },
    deferred: false,
    replied: false,
    isChatInputCommand: () => true,
    options: { getString: (name) => (name === 'prompt' ? prompt : null) },
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

function makeCtx(ai, { userCooldownSeconds = 0, maxPromptChars = 6000 } = {}) {
  return {
    ai,
    commands: new Map(),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    config: { ai: { ...LIVE_AI, userCooldownSeconds, maxPromptChars } },
  };
}

/** A provider double that answers immediately, echoing the prompt, and records requests. */
function createEchoAi({ text = null, describeOverrides = {} } = {}) {
  const calls = [];
  return {
    calls,
    describe: () => ({ ...LIVE_AI, ...describeOverrides }),
    async complete(request) {
      calls.push(request);
      const prompt = request.messages.at(-1).content;
      return { text: text ?? `Echo: ${prompt}`, provider: 'deepseek', model: 'deepseek-flash' };
    },
  };
}

/** Lets a test hold a completion open, so a second request is truly in flight. */
function createGate() {
  const deferred = [];
  let notify = null;
  return {
    enter() {
      const promise = new Promise((resolve) => deferred.push(resolve));
      notify?.();
      return promise;
    },
    async waitFor(count) {
      while (deferred.length < count) {
        await new Promise((resolve) => {
          notify = resolve;
        });
      }
    },
    releaseAll() {
      for (const release of deferred) release();
    },
  };
}

function createGatedAi({ describeOverrides = {} } = {}) {
  const gate = createGate();
  const calls = [];
  return {
    gate,
    calls,
    describe: () => ({ ...LIVE_AI, ...describeOverrides }),
    async complete(request) {
      calls.push(request);
      await gate.enter();
      return { text: `Echo: ${request.messages.at(-1).content}`, provider: 'deepseek', model: 'deepseek-flash' };
    },
  };
}

async function ask(interaction, ctx) {
  const commands = await loadCommands(COMMANDS_DIR);
  await commands.get('ask').execute(interaction, ctx);
}

const ephemeral = (payload) => Boolean(payload?.flags & MessageFlags.Ephemeral);
const lastText = (interaction) =>
  interaction.calls.editReply.at(-1) ?? interaction.calls.reply.at(-1)?.content ?? null;

/* -------------------------------------------------------------------------- */
/* Prompt length                                                               */
/* -------------------------------------------------------------------------- */

test('a prompt over AI_MAX_PROMPT_CHARS is refused before any provider call', async () => {
  const ai = createEchoAi();
  const interaction = makeInteraction({ prompt: 'x'.repeat(21) });

  await ask(interaction, makeCtx(ai, { maxPromptChars: 20 }));

  const [reply] = interaction.calls.reply;
  assert.equal(ephemeral(reply), true);
  assert.match(reply.content, /at most 20/);
  assert.match(reply.content, /21 characters/);
  assert.equal(ai.calls.length, 0, 'the provider was called for an over-long prompt');
  assert.equal(interaction.calls.deferReply.length, 0, 'an over-long prompt was deferred');
});

test('a prompt exactly at the limit is accepted', async () => {
  const ai = createEchoAi();
  const prompt = 'y'.repeat(30);
  const interaction = makeInteraction({ prompt });

  await ask(interaction, makeCtx(ai, { maxPromptChars: 30 }));

  assert.equal(ai.calls.length, 1);
  assert.match(lastText(interaction), new RegExp(`Echo: ${prompt}`));
});

/* -------------------------------------------------------------------------- */
/* Cooldown and duplicate protection                                           */
/* -------------------------------------------------------------------------- */

test('a second request from the same user is refused during the cooldown', async () => {
  const ai = createEchoAi();
  const ctx = makeCtx(ai, { userCooldownSeconds: 30 });

  const first = makeInteraction({ id: 'first', userId: 'miner-1', prompt: 'ilk soru' });
  const second = makeInteraction({ id: 'second', userId: 'miner-1', prompt: 'ikinci soru' });

  await ask(first, ctx);
  await ask(second, ctx);

  assert.equal(ai.calls.length, 1, 'the cooldown did not stop the second call');
  assert.match(second.calls.reply[0].content, /cooling down/i);
  assert.equal(ephemeral(second.calls.reply[0]), true);
});

test('a cooldown of 0 disables the wait', async () => {
  const ai = createEchoAi();
  const ctx = makeCtx(ai, { userCooldownSeconds: 0 });

  await ask(makeInteraction({ id: 'a', userId: 'miner-2', prompt: 'bir' }), ctx);
  await ask(makeInteraction({ id: 'b', userId: 'miner-2', prompt: 'iki' }), ctx);

  assert.equal(ai.calls.length, 2);
});

test('another user is not affected by someone else cooldown', async () => {
  const ai = createEchoAi();
  const ctx = makeCtx(ai, { userCooldownSeconds: 60 });

  await ask(makeInteraction({ id: 'a', userId: 'miner-3', prompt: 'selam' }), ctx);
  const other = makeInteraction({ id: 'b', userId: 'miner-4', prompt: 'merhaba' });
  await ask(other, ctx);

  assert.equal(ai.calls.length, 2, "one user's cooldown blocked another user");
  assert.match(lastText(other), /Echo: merhaba/);
});

test('a duplicate in-flight request from the same user is refused', async () => {
  const ai = createGatedAi();
  const ctx = makeCtx(ai);

  const first = makeInteraction({ id: 'first', userId: 'miner-5', prompt: 'uzun soru' });
  const second = makeInteraction({ id: 'second', userId: 'miner-5', prompt: 'aynı anda ikinci' });

  const firstRun = ask(first, ctx);
  await ai.gate.waitFor(1); // the first request is now inside the provider
  await ask(second, ctx);

  assert.match(second.calls.reply[0].content, /still answering your previous question/i);
  assert.equal(ai.calls.length, 1, 'a duplicate reached the provider');

  ai.gate.releaseAll();
  await firstRun;
  assert.match(lastText(first), /Echo: uzun soru/);
});

test('two users may request concurrently', async () => {
  const ai = createGatedAi();
  const ctx = makeCtx(ai);

  const alice = makeInteraction({ id: 'alice', userId: 'alice', prompt: 'alice sorusu' });
  const bob = makeInteraction({ id: 'bob', userId: 'bob', prompt: 'bob sorusu' });

  const both = Promise.all([ask(alice, ctx), ask(bob, ctx)]);
  await ai.gate.waitFor(2);
  ai.gate.releaseAll();
  await both;

  assert.equal(ai.calls.length, 2);
  assert.match(lastText(alice), /Echo: alice sorusu/);
  assert.match(lastText(bob), /Echo: bob sorusu/);
  assert.ok(!lastText(alice).includes('bob sorusu'));
});

/* -------------------------------------------------------------------------- */
/* Discord message limits                                                      */
/* -------------------------------------------------------------------------- */

test('an answer longer than one Discord message is split into public follow-ups', async () => {
  const long = 'A'.repeat(5000);
  const ai = createEchoAi({ text: long });
  const interaction = makeInteraction({ prompt: 'uzun cevap' });

  await ask(interaction, makeCtx(ai));

  const chunks = [interaction.calls.editReply.at(-1), ...interaction.calls.followUp.map((p) => p.content)];
  assert.ok(chunks.length >= 3, `expected multiple chunks, got ${chunks.length}`);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= DISCORD_MESSAGE_LIMIT, `a chunk was ${chunk.length} characters`);
  }
  for (const payload of interaction.calls.followUp) {
    assert.equal(ephemeral(payload), false, 'a follow-up of a public answer was private');
  }
  assert.ok(chunks.join('').includes(long), 'the answer was lost while splitting');
});

test('splitting never cuts a surrogate pair in half', async () => {
  const emoji = '😀'.repeat(1500); // 3000 UTF-16 code units
  const ai = createEchoAi({ text: emoji });
  const interaction = makeInteraction({ prompt: 'emoji' });

  await ask(interaction, makeCtx(ai));

  const chunks = [interaction.calls.editReply.at(-1), ...interaction.calls.followUp.map((p) => p.content)];
  for (const chunk of chunks) {
    assert.ok(chunk.length <= DISCORD_MESSAGE_LIMIT);
    assert.ok(!/[\uD800-\uDBFF]$/.test(chunk), 'a chunk ends with half an emoji');
    assert.ok(!/^[\uDC00-\uDFFF]/.test(chunk), 'a chunk starts with half an emoji');
  }
  assert.ok(chunks.join('').includes(emoji), 'emoji were lost while splitting');
});

test('splitForDiscord keeps short text intact and never returns an empty chunk', () => {
  assert.deepEqual(splitForDiscord('kısa cevap'), ['kısa cevap']);
  assert.deepEqual(splitForDiscord(''), ['(empty response)']);
  assert.deepEqual(splitForDiscord('   '), ['(empty response)']);

  const parts = splitForDiscord('satır\n'.repeat(1200), 100);
  for (const part of parts) {
    assert.ok(part.length <= 100);
    assert.ok(part.length > 0);
  }
  assert.equal(parts.join(''), 'satır\n'.repeat(1200).trimEnd());
});

/* -------------------------------------------------------------------------- */
/* User-facing failures                                                        */
/* -------------------------------------------------------------------------- */

test('a timeout produces a friendly message with no stack trace', async () => {
  const ai = {
    describe: () => LIVE_AI,
    async complete() {
      throw new AIRequestTimeoutError('DeepSeek did not answer within 30000ms.', {
        details: { provider: 'deepseek', timeoutMs: 30000 },
      });
    },
  };
  const interaction = makeInteraction({ prompt: 'yavaş soru' });

  await ask(interaction, makeCtx(ai));

  const answer = lastText(interaction);
  assert.match(answer, /took too long/i);
  assert.ok(!answer.includes('at '), 'a stack frame leaked to Discord');
  assert.ok(!answer.includes('AI_REQUEST_TIMEOUT'), 'an internal code leaked to Discord');
});

test('a credential rejection never exposes the key or the vendor message', async () => {
  const ai = {
    describe: () => LIVE_AI,
    async complete() {
      throw new AIAuthenticationError('DeepSeek rejected the configured API key.', {
        details: { provider: 'deepseek', status: 401, apiKey: 'sk-must-not-appear' },
      });
    },
  };
  const interaction = makeInteraction({ prompt: 'gizli' });

  await ask(interaction, makeCtx(ai));

  const answer = lastText(interaction);
  assert.match(answer, /rejected its credentials/i);
  assert.ok(!answer.includes('sk-must-not-appear'), 'a credential leaked to Discord');
  assert.ok(!answer.includes('DeepSeek rejected'), 'the raw vendor message leaked to Discord');
});

test('every failure reply matches the answer visibility and is never a raw exception', async () => {
  const ai = {
    describe: () => LIVE_AI,
    async complete() {
      const error = new Error('boom');
      error.stack = 'Error: boom\n    at secretFunction (/app/src/secret.js:1:1)';
      throw error;
    },
  };
  const interaction = makeInteraction({ prompt: 'hata' });

  await ask(interaction, makeCtx(ai));

  assert.match(lastText(interaction), /could not answer/);
  assert.ok(!lastText(interaction).includes('secretFunction'), 'a stack trace reached Discord');
  // The failure replaces a public answer, so it is public too.
  assert.equal(ephemeral(interaction.calls.deferReply[0]), false);
});

test('the deferral happens before the provider call and the notice stays on the stub', async () => {
  const order = [];
  const ai = {
    describe: () => ({ ...LIVE_AI, provider: 'stub', model: 'stub-echo-v1', live: false, stub: true }),
    async complete() {
      order.push('complete');
      return { text: 'stub cevabı', provider: 'stub', model: 'stub-echo-v1' };
    },
  };
  const interaction = makeInteraction({ prompt: 'stub mı?' });
  const originalDefer = interaction.deferReply.bind(interaction);
  interaction.deferReply = async (payload) => {
    order.push('defer');
    return originalDefer(payload);
  };

  await ask(interaction, makeCtx(ai));

  assert.deepEqual(order, ['defer', 'complete'], 'the network call happened before the deferral');
  assert.match(lastText(interaction), /no real AI provider configured yet/i);
});
