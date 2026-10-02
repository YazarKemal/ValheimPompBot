import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { execute as ask, resetAskState } from '../src/commands/ask.js';
import { execute as oyun } from '../src/commands/oyun.js';
import { execute as clear } from '../src/commands/clear.js';
import { execute as oyunTemizle } from '../src/commands/oyun-temizle.js';
import { ConversationMemory } from '../src/ai/memory.js';
import { createGiveawayProviders } from '../src/giveaways/index.js';
import { GIVEAWAY_KINDS, normaliseGiveaway } from '../src/giveaways/provider.js';
import { createNullLogger } from '../src/utils/logger.js';

/**
 * PUBLIC OUTPUT != SHARED MEMORY.
 *
 * Every answer is now visible to the whole channel, but the conversation that
 * produced it is still private to one user in one channel (or one user and one
 * game). These tests exist to pin that distinction down: making replies public
 * must not have made context public.
 *
 * No provider is called: the fake AI records requests instead.
 */

const GUILD = 'g1';
const PUBLIC_CONFIG = { ai: { responseVisibility: 'public', userCooldownSeconds: 0, maxPromptChars: 6000 } };

function makeAi({ reply = 'cevap' } = {}) {
  const requests = [];
  return {
    requests,
    describe: () => ({ provider: 'deepseek', model: 'deepseek-flash', configured: true, live: true, stub: false }),
    async complete(request) {
      requests.push(request);
      return { text: reply, provider: 'deepseek', model: 'deepseek-flash' };
    },
  };
}

function makeCtx(overrides = {}) {
  return {
    ai: makeAi(),
    memory: new ConversationMemory({ maxMessages: 10 }),
    logger: createNullLogger(),
    commands: new Map(),
    config: PUBLIC_CONFIG,
    startedAt: Date.now(),
    ...overrides,
  };
}

function makeInteraction({
  channelName = 'genel',
  channelId = 'c1',
  userId = 'u1',
  guildId = GUILD,
  prompt = 'soru',
  game = null,
} = {}) {
  const calls = { reply: [], deferReply: [], editReply: [], followUp: [] };
  const interaction = {
    guildId,
    channelId,
    channel: { id: channelId, name: channelName },
    user: { id: userId },
    deferred: false,
    replied: false,
    options: { getString: (name) => (name === 'oyun' ? game : prompt) },
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
/* Visibility per command                                                      */
/* -------------------------------------------------------------------------- */

test('/ask and /oyun are public; /clear and /oyun-temizle stay private', async () => {
  resetAskState();

  const asked = makeInteraction({ channelName: 'genel' });
  await ask(asked, makeCtx());
  assert.equal(isEphemeral(asked.calls.deferReply[0]), false, '/ask was private');

  const gamed = makeInteraction({ game: 'Valheim', channelName: 'genel' });
  await oyun(gamed, makeCtx());
  assert.equal(isEphemeral(gamed.calls.deferReply[0]), false, '/oyun was private');

  const cleared = makeInteraction({ channelName: 'genel' });
  await clear(cleared, makeCtx());
  assert.equal(isEphemeral(cleared.calls.reply[0]), true, '/clear must stay private');

  const clearedGame = makeInteraction({ game: 'Valheim' });
  await oyunTemizle(clearedGame, makeCtx());
  assert.equal(isEphemeral(clearedGame.calls.reply[0]), true, '/oyun-temizle must stay private');
});

/* -------------------------------------------------------------------------- */
/* The distinction that matters                                                */
/* -------------------------------------------------------------------------- */

test("a public answer never carries another user's private conversation", async () => {
  resetAskState();
  const ctx = makeCtx();
  const channel = { channelName: 'genel', channelId: 'c1' };

  await ask(makeInteraction({ ...channel, userId: 'alice', prompt: 'alice gizli sorusu' }), ctx);
  await ask(makeInteraction({ ...channel, userId: 'bob', prompt: 'bob sorusu' }), ctx);

  const bobRequest = ctx.ai.requests.at(-1);

  // Bob's answer is public, but the request that produced it is not.
  assert.deepEqual(bobRequest.messages.map((message) => message.content), ['bob sorusu']);
  assert.ok(
    !JSON.stringify(bobRequest).includes('alice gizli sorusu'),
    "alice's private prompt reached bob's request",
  );
});

test('a public answer is produced from a private per-user conversation', async () => {
  resetAskState();
  const ctx = makeCtx();
  const channel = { channelName: 'genel', channelId: 'c1' };

  await ask(makeInteraction({ ...channel, userId: 'alice', prompt: 'ilk' }), ctx);
  await ask(makeInteraction({ ...channel, userId: 'alice', prompt: 'ikinci' }), ctx);

  // Alice's own continuity is intact...
  assert.deepEqual(
    ctx.ai.requests.at(-1).messages.map((message) => message.content),
    ['ilk', 'cevap', 'ikinci'],
  );

  // ...while a second user in the same channel starts clean.
  await ask(makeInteraction({ ...channel, userId: 'carol', prompt: 'carol soruyor' }), ctx);
  assert.deepEqual(ctx.ai.requests.at(-1).messages.map((message) => message.content), ['carol soruyor']);
});

test('public answers do not merge histories across channels', async () => {
  resetAskState();
  const ctx = makeCtx();

  await ask(makeInteraction({ channelName: 'maden', channelId: 'c-maden', userId: 'u1', prompt: 'maden sorusu' }), ctx);
  await ask(makeInteraction({ channelName: 'ada', channelId: 'c-ada', userId: 'u1', prompt: 'ada sorusu' }), ctx);

  assert.deepEqual(ctx.ai.requests.at(-1).messages.map((message) => message.content), ['ada sorusu']);
});

test('gaming and project memory stay separate even though both are public', async () => {
  resetAskState();
  const ctx = makeCtx();

  await ask(makeInteraction({ channelName: 'genel', channelId: 'c1', userId: 'u1', prompt: 'proje sorusu' }), ctx);
  await oyun(makeInteraction({ game: 'Valheim', channelName: 'genel', channelId: 'c1', userId: 'u1', prompt: 'oyun sorusu' }), ctx);

  const gamingRequest = ctx.ai.requests.at(-1);
  assert.deepEqual(gamingRequest.messages.map((message) => message.content), ['oyun sorusu']);
  assert.ok(!JSON.stringify(gamingRequest).includes('proje sorusu'), 'project memory leaked into a game answer');
});

test('concurrent users in one public channel never see each other', async () => {
  resetAskState();
  const ctx = makeCtx();
  const channel = { channelName: 'genel', channelId: 'c1' };

  await Promise.all([
    ask(makeInteraction({ ...channel, userId: 'a', prompt: 'a1' }), ctx),
    ask(makeInteraction({ ...channel, userId: 'b', prompt: 'b1' }), ctx),
    ask(makeInteraction({ ...channel, userId: 'c', prompt: 'c1' }), ctx),
  ]);
  await Promise.all([
    ask(makeInteraction({ ...channel, userId: 'a', prompt: 'a2' }), ctx),
    ask(makeInteraction({ ...channel, userId: 'b', prompt: 'b2' }), ctx),
    ask(makeInteraction({ ...channel, userId: 'c', prompt: 'c2' }), ctx),
  ]);

  for (const user of ['a', 'b', 'c']) {
    const own = ctx.ai.requests.filter((request) => request.messages.some((m) => m.content === `${user}1`));
    const contents = own.at(-1).messages.map((message) => message.content);

    assert.deepEqual(contents, [`${user}1`, 'cevap', `${user}2`], `${user} lost their own thread`);
    for (const other of ['a', 'b', 'c'].filter((candidate) => candidate !== user)) {
      assert.ok(!contents.includes(`${other}1`), `${user} saw ${other}'s private turn`);
    }
  }
});

/* -------------------------------------------------------------------------- */
/* Chunking stays public and stays isolated                                    */
/* -------------------------------------------------------------------------- */

test('long /ask answers are fully public, chunk by chunk', async () => {
  resetAskState();
  const ctx = makeCtx({ ai: makeAi({ reply: 'z'.repeat(5000) }) });
  const interaction = makeInteraction({ channelName: 'genel' });

  await ask(interaction, ctx);

  assert.ok(interaction.calls.followUp.length > 1, 'the answer was not split');
  for (const chunk of interaction.calls.followUp) {
    assert.equal(isEphemeral(chunk), false, 'a chunk of a public answer was private');
  }
});

test('long /oyun answers are fully public, chunk by chunk', async () => {
  const ctx = makeCtx({ ai: makeAi({ reply: 'y'.repeat(5000) }) });
  const interaction = makeInteraction({ game: 'Valheim', channelName: 'genel' });

  await oyun(interaction, ctx);

  assert.ok(interaction.calls.followUp.length > 1, 'the answer was not split');
  for (const chunk of interaction.calls.followUp) {
    assert.equal(isEphemeral(chunk), false, 'a chunk of a public answer was private');
  }
});

/* -------------------------------------------------------------------------- */
/* Cost protections are unaffected by the visibility change                    */
/* -------------------------------------------------------------------------- */

test('the cooldown still applies, and its notice stays private', async () => {
  resetAskState();
  const ctx = makeCtx({
    config: { ai: { responseVisibility: 'public', userCooldownSeconds: 3600, maxPromptChars: 6000 } },
  });

  await ask(makeInteraction({ channelName: 'genel', userId: 'u1', prompt: 'ilk' }), ctx);
  const second = makeInteraction({ channelName: 'genel', userId: 'u1', prompt: 'ikinci' });
  await ask(second, ctx);

  assert.equal(ctx.ai.requests.length, 1, 'the cooldown did not stop the second call');
  assert.match(second.calls.reply[0].content, /cooling down/i);
  // Personal feedback about a request that was never sent is not an AI answer.
  assert.equal(isEphemeral(second.calls.reply[0]), true);
});

test('one in-flight request per user is still enforced', async () => {
  resetAskState();
  let release;
  const ctx = makeCtx({
    ai: {
      describe: () => ({ provider: 'deepseek', live: true }),
      complete: () =>
        new Promise((resolve) => {
          release = () => resolve({ text: 'ok', provider: 'deepseek', model: 'deepseek-flash' });
        }),
    },
  });

  const first = makeInteraction({ channelName: 'genel', userId: 'u1', prompt: 'ilk' });
  const pending = ask(first, ctx);
  await new Promise((resolve) => setImmediate(resolve));

  const second = makeInteraction({ channelName: 'genel', userId: 'u1', prompt: 'ikinci' });
  await ask(second, ctx);

  assert.match(second.calls.reply[0].content, /still answering/i);
  assert.equal(isEphemeral(second.calls.reply[0]), true);

  release();
  await pending;
});

test('the prompt-length guard still refuses before any provider call', async () => {
  resetAskState();
  const ctx = makeCtx({
    config: { ai: { responseVisibility: 'public', userCooldownSeconds: 0, maxPromptChars: 10 } },
  });
  const interaction = makeInteraction({ channelName: 'genel', prompt: 'x'.repeat(50) });

  await ask(interaction, ctx);

  assert.equal(ctx.ai.requests.length, 0, 'the provider was called despite an over-long prompt');
  assert.equal(isEphemeral(interaction.calls.reply[0]), true);
});

/* -------------------------------------------------------------------------- */
/* Giveaway announcements are public, and cost nothing                         */
/* -------------------------------------------------------------------------- */

test('giveaway announcements are public and mention nobody', async () => {
  const giveaway = normaliseGiveaway({
    provider: 'epic',
    id: '1',
    title: 'Free Game',
    platform: 'Epic Games',
    kind: GIVEAWAY_KINDS.EPIC_GIVEAWAY,
    endsAt: '2027-01-01T00:00:00.000Z',
  });
  const sent = [];
  const notifier = {
    async announce(item) {
      sent.push(item);
      return true;
    },
  };

  await notifier.announce(giveaway);

  assert.equal(sent.length, 1);
  assert.ok(!/@everyone|@here|<@&/.test(JSON.stringify(sent[0])), 'the announcement carries a mention');
});

test('the giveaway pipeline contains no AI providers at all', () => {
  const providers = createGiveawayProviders({ logger: createNullLogger(), itadApiKey: null });

  assert.deepEqual(providers.map((provider) => provider.name), ['epic']);
  for (const provider of providers) {
    assert.equal(typeof provider.complete, 'undefined', 'a giveaway provider can make an AI call');
    assert.equal(typeof provider.describe, 'undefined');
  }
});
