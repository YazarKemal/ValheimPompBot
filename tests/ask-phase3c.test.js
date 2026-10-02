import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { execute as ask, resetAskState } from '../src/commands/ask.js';
import { execute as clear } from '../src/commands/clear.js';
import { ConversationMemory } from '../src/ai/memory.js';

/**
 * These tests never reach a provider. A fake AI client records the requests it
 * receives, which is also how the prompt, history and isolation properties are
 * asserted.
 */

const GUILD = 'g1';
const POMPAI_CHANNEL = 'chan-pompai';
const MADEN_CHANNEL = 'chan-maden';

/** Records every request so tests can inspect exactly what the model saw. */
function makeAi({ reply = 'cevap', describe } = {}) {
  const requests = [];
  return {
    requests,
    describe: () =>
      describe ?? {
        provider: 'stub',
        model: 'stub-echo-v1',
        configured: true,
        live: false,
        stub: true,
        timeoutMs: 30000,
      },
    async complete(request) {
      requests.push(request);
      return { text: reply, provider: 'stub', model: 'stub-echo-v1' };
    },
  };
}

function makeCtx(overrides = {}) {
  return {
    ai: makeAi(),
    memory: new ConversationMemory({ maxMessages: 10 }),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    commands: new Map(),
    config: {
      ai: { responseVisibility: 'public', historyMessages: 10, userCooldownSeconds: 0, maxPromptChars: 6000 },
    },
    startedAt: Date.now(),
    ...overrides,
  };
}

function makeInteraction({
  channelName = 'genel',
  channelId = 'chan-generic',
  userId = 'u1',
  guildId = GUILD,
  prompt = 'soru',
} = {}) {
  const calls = { reply: [], deferReply: [], editReply: [], followUp: [] };
  const interaction = {
    guildId,
    channelId,
    channel: { id: channelId, name: channelName },
    user: { id: userId },
    client: { ws: { ping: 1 } },
    deferred: false,
    replied: false,
    options: { getString: () => prompt },
    async reply(payload) {
      calls.reply.push(payload);
      interaction.replied = true;
    },
    async deferReply(payload) {
      calls.deferReply.push(payload ?? {});
      interaction.deferred = true;
    },
    async editReply(payload) {
      calls.editReply.push(payload);
    },
    async followUp(payload) {
      calls.followUp.push(payload);
    },
    calls,
  };
  return interaction;
}

const isEphemeral = (payload) => Boolean(payload?.flags & MessageFlags.Ephemeral);

/* -------------------------------------------------------------------------- */
/* Visibility: AI answers are public everywhere                                */
/* -------------------------------------------------------------------------- */

test('/ask is public in #pompai', async () => {
  resetAskState();
  const interaction = makeInteraction({ channelName: 'pompai', channelId: POMPAI_CHANNEL });

  await ask(interaction, makeCtx());

  assert.equal(interaction.calls.deferReply.length, 1);
  assert.equal(isEphemeral(interaction.calls.deferReply[0]), false, 'the defer was ephemeral');
});

test('/ask is public in every other channel too', async () => {
  for (const channelName of ['genel', 'maden', 'ada', 'unity', 'kod', 'buglar', 'rastgele-bir-kanal']) {
    resetAskState();
    const interaction = makeInteraction({ channelName, channelId: `c-${channelName}` });

    await ask(interaction, makeCtx());

    assert.equal(isEphemeral(interaction.calls.deferReply[0]), false, `/ask was private in #${channelName}`);
  }
});

test('a fresh channel never changes the answer visibility', async () => {
  resetAskState();
  const interaction = makeInteraction({ channelName: null, channelId: null });

  await ask(interaction, makeCtx());

  assert.equal(isEphemeral(interaction.calls.deferReply[0]), false, 'an unknown channel produced a private answer');
});

test('AI_RESPONSE_VISIBILITY=ephemeral restores private answers', async () => {
  resetAskState();
  const interaction = makeInteraction({ channelName: 'genel', channelId: 'c1' });
  const ctx = makeCtx({
    config: { ai: { responseVisibility: 'ephemeral', userCooldownSeconds: 0, maxPromptChars: 6000 } },
  });

  await ask(interaction, ctx);

  assert.equal(isEphemeral(interaction.calls.deferReply[0]), true, 'the escape hatch did not work');
});

test('an unrecognised visibility value falls back to public', async () => {
  resetAskState();
  const interaction = makeInteraction({ channelName: 'genel', channelId: 'c1' });
  const ctx = makeCtx({
    config: { ai: { responseVisibility: 'nonsense', userCooldownSeconds: 0, maxPromptChars: 6000 } },
  });

  await ask(interaction, ctx);

  assert.equal(isEphemeral(interaction.calls.deferReply[0]), false, 'a typo silently made answers private');
});

test('follow-up chunks of a long answer are public', async () => {
  resetAskState();
  const interaction = makeInteraction({ channelName: 'maden', channelId: MADEN_CHANNEL });
  const ctx = makeCtx({ ai: makeAi({ reply: 'z'.repeat(5000) }) });

  await ask(interaction, ctx);

  assert.ok(interaction.calls.followUp.length > 0, 'expected the answer to be split');
  for (const chunk of interaction.calls.followUp) {
    assert.equal(isEphemeral(chunk), false, 'a follow-up chunk of a public answer was private');
  }
});

/* -------------------------------------------------------------------------- */
/* Channel-aware context                                                       */
/* -------------------------------------------------------------------------- */

test('the current channel name reaches the system prompt', async () => {
  resetAskState();
  const ctx = makeCtx();
  await ask(makeInteraction({ channelName: 'maden', channelId: MADEN_CHANNEL }), ctx);

  const [request] = ctx.ai.requests;
  assert.match(request.system, /#maden/);
  assert.match(request.system, /mining and digging/i);
});

test('a different channel yields different context', async () => {
  resetAskState();
  const ctx = makeCtx();
  await ask(makeInteraction({ channelName: 'performans', channelId: 'c-perf' }), ctx);

  assert.match(ctx.ai.requests[0].system, /profiling/i);
});

/* -------------------------------------------------------------------------- */
/* Conversation memory                                                         */
/* -------------------------------------------------------------------------- */

test('a follow-up question carries the previous turn', async () => {
  resetAskState();
  const ctx = makeCtx();
  const scope = { channelName: 'pompai', channelId: POMPAI_CHANNEL, userId: 'u1' };

  await ask(makeInteraction({ ...scope, prompt: 'ilk soru' }), ctx);
  await ask(makeInteraction({ ...scope, prompt: 'ikinci soru' }), ctx);

  const [first, second] = ctx.ai.requests;
  assert.deepEqual(first.messages.map((m) => m.content), ['ilk soru']);
  assert.deepEqual(
    second.messages.map((m) => m.content),
    ['ilk soru', 'cevap', 'ikinci soru'],
    'the previous turn was not replayed',
  );
});

test('history is bounded by AI_HISTORY_MESSAGES', async () => {
  resetAskState();
  const ctx = makeCtx({ memory: new ConversationMemory({ maxMessages: 2 }) });
  const scope = { channelName: 'pompai', channelId: POMPAI_CHANNEL, userId: 'u1' };

  await ask(makeInteraction({ ...scope, prompt: 'bir' }), ctx);
  await ask(makeInteraction({ ...scope, prompt: 'iki' }), ctx);
  await ask(makeInteraction({ ...scope, prompt: 'uc' }), ctx);

  const last = ctx.ai.requests.at(-1);
  assert.ok(last.messages.length <= 3, `history grew unbounded: ${last.messages.length}`);
  assert.equal(last.messages.at(-1).content, 'uc');
});

test('a fresh memory store means a fresh conversation - the restart case', async () => {
  resetAskState();
  const shared = new ConversationMemory();
  const scope = { channelName: 'pompai', channelId: POMPAI_CHANNEL, userId: 'u1' };

  const before = makeCtx({ memory: shared });
  await ask(makeInteraction({ ...scope, prompt: 'ilk soru' }), before);

  // A restart constructs a new store; the old conversation is gone.
  const after = makeCtx({ memory: new ConversationMemory() });
  await ask(makeInteraction({ ...scope, prompt: 'yeni soru' }), after);

  assert.deepEqual(after.ai.requests[0].messages.map((m) => m.content), ['yeni soru']);
});

test('/ask still works when no memory is wired up', async () => {
  resetAskState();
  const ctx = makeCtx({ memory: undefined });

  await ask(makeInteraction({ channelName: 'pompai', channelId: POMPAI_CHANNEL }), ctx);

  assert.equal(ctx.ai.requests[0].messages.length, 1);
});

/* -------------------------------------------------------------------------- */
/* Isolation                                                                   */
/* -------------------------------------------------------------------------- */

test('one user never sees another user\'s conversation', async () => {
  resetAskState();
  const ctx = makeCtx();
  const base = { channelName: 'pompai', channelId: POMPAI_CHANNEL };

  await ask(makeInteraction({ ...base, userId: 'alice', prompt: 'alice sorusu' }), ctx);
  await ask(makeInteraction({ ...base, userId: 'bob', prompt: 'bob sorusu' }), ctx);

  const bobRequest = ctx.ai.requests.at(-1);
  assert.deepEqual(bobRequest.messages.map((m) => m.content), ['bob sorusu']);
  assert.ok(!JSON.stringify(bobRequest).includes('alice sorusu'), "alice's prompt leaked into bob's context");
});

test('the same user in two channels keeps two separate histories', async () => {
  resetAskState();
  const ctx = makeCtx();

  await ask(makeInteraction({ channelName: 'pompai', channelId: POMPAI_CHANNEL, userId: 'u1', prompt: 'pompai sorusu' }), ctx);
  await ask(makeInteraction({ channelName: 'maden', channelId: MADEN_CHANNEL, userId: 'u1', prompt: 'maden sorusu' }), ctx);

  assert.deepEqual(ctx.ai.requests.at(-1).messages.map((m) => m.content), ['maden sorusu']);
});

test('concurrent users in one channel stay isolated', async () => {
  resetAskState();
  const ctx = makeCtx();
  const base = { channelName: 'pompai', channelId: POMPAI_CHANNEL };

  // Interleave three users with distinct cooldown slots (cooldown is disabled).
  await Promise.all([
    ask(makeInteraction({ ...base, userId: 'a', prompt: 'a1' }), ctx),
    ask(makeInteraction({ ...base, userId: 'b', prompt: 'b1' }), ctx),
    ask(makeInteraction({ ...base, userId: 'c', prompt: 'c1' }), ctx),
  ]);
  await Promise.all([
    ask(makeInteraction({ ...base, userId: 'a', prompt: 'a2' }), ctx),
    ask(makeInteraction({ ...base, userId: 'b', prompt: 'b2' }), ctx),
    ask(makeInteraction({ ...base, userId: 'c', prompt: 'c2' }), ctx),
  ]);

  for (const user of ['a', 'b', 'c']) {
    const own = ctx.ai.requests.filter((request) => request.messages.some((m) => m.content.startsWith(`${user}1`)));
    const follow = own.at(-1);
    const contents = follow.messages.map((m) => m.content);
    assert.deepEqual(contents, [`${user}1`, 'cevap', `${user}2`], `${user} saw the wrong history`);

    for (const other of ['a', 'b', 'c'].filter((candidate) => candidate !== user)) {
      assert.ok(!contents.includes(`${other}1`), `${user} saw ${other}'s turn`);
    }
  }
});

/* -------------------------------------------------------------------------- */
/* /clear                                                                      */
/* -------------------------------------------------------------------------- */

test('/clear empties only the caller\'s history in the current channel', async () => {
  resetAskState();
  const ctx = makeCtx();
  const scope = { channelName: 'pompai', channelId: POMPAI_CHANNEL };

  await ask(makeInteraction({ ...scope, userId: 'alice', prompt: 'alice' }), ctx);
  await ask(makeInteraction({ ...scope, userId: 'bob', prompt: 'bob' }), ctx);
  await ask(makeInteraction({ channelName: 'maden', channelId: MADEN_CHANNEL, userId: 'alice', prompt: 'maden' }), ctx);

  const interaction = makeInteraction({ ...scope, userId: 'alice' });
  await clear(interaction, ctx);

  assert.equal(isEphemeral(interaction.calls.reply[0]), true, '/clear must be ephemeral');
  assert.match(interaction.calls.reply[0].content, /Cleared 2 message/);

  // Alice's #pompai history is gone.
  await ask(makeInteraction({ ...scope, userId: 'alice', prompt: 'yeni' }), ctx);
  assert.deepEqual(ctx.ai.requests.at(-1).messages.map((m) => m.content), ['yeni']);

  // Bob's, and Alice's other channel, are untouched.
  await ask(makeInteraction({ ...scope, userId: 'bob', prompt: 'bob2' }), ctx);
  assert.deepEqual(ctx.ai.requests.at(-1).messages.map((m) => m.content), ['bob', 'cevap', 'bob2']);

  await ask(makeInteraction({ channelName: 'maden', channelId: MADEN_CHANNEL, userId: 'alice', prompt: 'maden2' }), ctx);
  assert.deepEqual(ctx.ai.requests.at(-1).messages.map((m) => m.content), ['maden', 'cevap', 'maden2']);
});

test('/clear on an empty history says so without failing', async () => {
  resetAskState();
  const interaction = makeInteraction({ channelName: 'pompai', channelId: POMPAI_CHANNEL });

  await clear(interaction, makeCtx());

  assert.match(interaction.calls.reply[0].content, /Nothing to clear/);
});

test('/clear is safe without a memory store', async () => {
  const interaction = makeInteraction();
  await assert.doesNotReject(() => clear(interaction, makeCtx({ memory: undefined })));
});

/* -------------------------------------------------------------------------- */
/* Privacy and cost                                                            */
/* -------------------------------------------------------------------------- */

test('no secrets reach the provider', async () => {
  resetAskState();
  const ctx = makeCtx({
    config: {
      discord: { token: 'M'.repeat(24) + '.' + 'X'.repeat(6) + '.' + 'Y'.repeat(38) },
      ai: {
        provider: 'deepseek',
        apiKey: 'sk-super-secret-key',
        responseVisibility: 'public',
        userCooldownSeconds: 0,
        maxPromptChars: 6000,
      },
    },
  });

  await ask(makeInteraction({ channelName: 'pompai', channelId: POMPAI_CHANNEL }), ctx);

  const serialised = JSON.stringify(ctx.ai.requests[0]);
  assert.ok(!serialised.includes('sk-super-secret-key'), 'the API key was sent to the provider');
  assert.ok(!serialised.includes('M'.repeat(24)), 'the Discord token was sent to the provider');
});

test('the system prompt is sent as `system`, never as conversation history', async () => {
  resetAskState();
  const ctx = makeCtx();
  await ask(makeInteraction({ channelName: 'pompai', channelId: POMPAI_CHANNEL }), ctx);

  const [request] = ctx.ai.requests;
  assert.equal(typeof request.system, 'string');
  assert.ok(request.messages.every((message) => message.role === 'user' || message.role === 'assistant'));
});

test('only PompAI traffic is remembered - nothing is read from Discord', async () => {
  resetAskState();
  const ctx = makeCtx();

  await ask(makeInteraction({ channelName: 'pompai', channelId: POMPAI_CHANNEL }), ctx);

  // Two messages stored: the prompt and the answer. No channel history.
  assert.equal(ctx.memory.messageCount, 2);
});

test('/ask makes no network call of its own', async () => {
  resetAskState();
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = () => {
    called = true;
    throw new Error('network access attempted');
  };

  try {
    await ask(makeInteraction({ channelName: 'pompai', channelId: POMPAI_CHANNEL }), makeCtx());
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(called, false, '/ask attempted a network call');
});

test('an over-long prompt is refused before any provider call', async () => {
  resetAskState();
  const ctx = makeCtx({
    config: { ai: { responseVisibility: 'public', userCooldownSeconds: 0, maxPromptChars: 10 } },
  });
  const interaction = makeInteraction({ channelName: 'pompai', channelId: POMPAI_CHANNEL, prompt: 'x'.repeat(50) });

  await ask(interaction, ctx);

  assert.equal(ctx.ai.requests.length, 0, 'the provider was called despite an over-long prompt');
  assert.match(interaction.calls.reply[0].content, /at most 10/);
});

test('a failed request does not poison the conversation history', async () => {
  resetAskState();
  const ctx = makeCtx({
    ai: {
      describe: () => ({ provider: 'stub', live: false, stub: true, model: null, configured: true }),
      complete: async () => {
        throw new Error('provider exploded');
      },
    },
  });

  await ask(makeInteraction({ channelName: 'pompai', channelId: POMPAI_CHANNEL, prompt: 'soru' }), ctx);

  assert.equal(ctx.memory.messageCount, 0, 'a failed turn was written to memory');
});
