import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import {
  AIAuthenticationError,
  AIProviderUnavailableError,
  AIRateLimitError,
  AIRequestTimeoutError,
  AIResponseError,
} from '../ai/errors.js';
import { buildSystemPrompt } from '../ai/miningfools.js';
import { resolveAiVisibility } from '../ai/visibility.js';

export const meta = {
  category: 'ai',
  summary: 'Ask PompAI a question.',
  order: 3,
};

/** Discord's hard limit for a string option value. */
export const PROMPT_OPTION_MAX_LENGTH = 6000;
/** Discord's hard limit for a single message. */
export const DISCORD_MESSAGE_LIMIT = 2000;
/** Fallback used when AI_MAX_PROMPT_CHARS is not present on ctx.config. */
export const DEFAULT_MAX_PROMPT_CHARS = 6000;
/** Fallback used when AI_USER_COOLDOWN_SECONDS is not present on ctx.config. */
export const DEFAULT_USER_COOLDOWN_SECONDS = 10;

export const data = new SlashCommandBuilder()
  .setName('ask')
  .setDescription('Ask PompAI a question.')
  .setDMPermission(false)
  .addStringOption((option) =>
    option
      .setName('prompt')
      .setDescription('What do you want to ask?')
      .setRequired(true)
      .setMaxLength(PROMPT_OPTION_MAX_LENGTH),
  );

/** Shown verbatim when no real provider is wired up. */
export const NOT_CONFIGURED_NOTICE =
  '⚠️ **PompAI has no real AI provider configured yet.**\n' +
  'This reply comes from the offline stub, which echoes your prompt. ' +
  'No paid API calls are made and no model was consulted.\n' +
  'Set `AI_PROVIDER` and `AI_API_KEY` to enable real answers.';

/**
 * Per-user request state: the last attempt timestamp (cooldown) and whether a
 * request is currently in flight (duplicate protection). Keyed by Discord user
 * id and never by prompt content, so one user can never affect another's
 * prompt. Exported reset hook exists for tests only.
 */
const userState = new Map();

/** Test hook: forget every cooldown and in-flight marker. */
export function resetAskState() {
  userState.clear();
}

/** Drops stale entries so the map cannot grow without bound. */
function pruneUserState(now, cooldownMs) {
  if (userState.size < 500) return;
  const maxAge = Math.max(cooldownMs, 60_000) * 10;
  for (const [userId, state] of userState) {
    if (!state.inFlight && now - state.lastRequestAt > maxAge) userState.delete(userId);
  }
}

/**
 * Reserves the user's single request slot.
 * @returns {{ ok: true, state: object } | { ok: false, reason: 'in-flight' | 'cooldown', retryAfterMs: number }}
 */
function acquireTurn(userId, cooldownMs, now) {
  pruneUserState(now, cooldownMs);
  const state = userState.get(userId) ?? { lastRequestAt: 0, inFlight: false };

  if (state.inFlight) return { ok: false, reason: 'in-flight', retryAfterMs: 0 };
  const elapsed = now - state.lastRequestAt;
  if (state.lastRequestAt > 0 && elapsed < cooldownMs) {
    return { ok: false, reason: 'cooldown', retryAfterMs: cooldownMs - elapsed };
  }

  state.inFlight = true;
  state.lastRequestAt = now;
  userState.set(userId, state);
  return { ok: true, state };
}

/**
 * Splits text into chunks that each fit Discord's message limit.
 *
 * Splitting happens on grapheme boundaries (via Intl.Segmenter when available),
 * so surrogate pairs, emoji and combining marks are never cut in half. Line
 * breaks are preferred as split points; overlong single lines are hard-split.
 */
export function splitForDiscord(text, limit = DISCORD_MESSAGE_LIMIT) {
  const value = String(text ?? '').trim();
  if (value === '') return ['(empty response)'];
  if (value.length <= limit) return [value];

  const chunks = [];
  let current = '';

  for (const [index, line] of value.split('\n').entries()) {
    // The line break belongs to the text, so it is carried into whichever
    // chunk it fits in; dropping it would silently merge two lines.
    const separator = index === 0 ? '' : '\n';
    const piece = separator + line;

    if (current.length + piece.length <= limit) {
      current += piece;
      continue;
    }

    if (current !== '') {
      if (separator !== '' && current.length + separator.length <= limit) chunks.push(current + separator);
      else chunks.push(current);
      current = '';
    }

    if (line.length <= limit) {
      current = line;
      continue;
    }

    const parts = hardSplit(line, limit);
    chunks.push(...parts.slice(0, -1));
    current = parts.at(-1) ?? '';
  }

  if (current !== '') chunks.push(current);
  return chunks.length > 0 ? chunks : [value.slice(0, limit)];
}

/** Hard split of one overlong line, one grapheme at a time. */
function hardSplit(line, limit) {
  const units =
    typeof Intl?.Segmenter === 'function'
      ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(line)].map((part) => part.segment)
      : Array.from(line);

  const parts = [];
  let current = '';
  for (const unit of units) {
    if (current.length + unit.length > limit && current !== '') {
      parts.push(current);
      current = '';
    }
    current += unit;
  }
  if (current !== '') parts.push(current);
  return parts;
}

/**
 * Concise, user-safe failure text. Never contains a stack trace, a raw vendor
 * message or a credential - only a stable error code.
 */
export function describeAskFailure(error) {
  if (error instanceof AIRequestTimeoutError) {
    return '⌛ PompAI took too long to answer. Please try again.';
  }
  if (error instanceof AIAuthenticationError) {
    return "🔒 PompAI's AI provider rejected its credentials. An administrator needs to check the API key.";
  }
  if (error instanceof AIRateLimitError) {
    return '🚦 The AI provider is limiting how often PompAI may ask. Please try again shortly.';
  }
  if (error instanceof AIProviderUnavailableError) {
    return '🛠️ The AI provider is temporarily unavailable. Please try again in a moment.';
  }
  if (error instanceof AIResponseError) {
    return '📡 PompAI received an unusable answer from the AI provider. Please try again.';
  }
  const code = typeof error?.code === 'string' ? ` \`${error.code}\`` : '';
  return `PompAI could not answer that.${code}`;
}

/**
 * Deliberately provider-agnostic: this file never imports a concrete AI
 * implementation. Swapping in a real provider changes configuration only.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ ai: { complete: Function, describe: Function }, config?: object, logger: object }} ctx
 */
export async function execute(interaction, ctx) {
  const prompt = interaction.options.getString('prompt', true);
  const aiConfig = ctx.config?.ai ?? {};
  const maxPromptChars = aiConfig.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS;
  const cooldownMs = (aiConfig.userCooldownSeconds ?? DEFAULT_USER_COOLDOWN_SECONDS) * 1000;
  const userId = interaction.user?.id ?? 'unknown';

  // Visibility is decided here, before the first reply, because Discord fixes
  // it when the interaction is acknowledged and it cannot be changed after.
  // The shared policy makes every AI answer public by default.
  const visibility = resolveAiVisibility(ctx.config);
  const channelName = interaction.channel?.name ?? null;
  const scope = {
    guildId: interaction.guildId ?? interaction.guild?.id ?? null,
    channelId: interaction.channelId ?? interaction.channel?.id ?? null,
    userId,
  };

  // Pre-flight rejections stay ephemeral on purpose. They are personal
  // feedback about a request that was never sent, not an AI answer, and the
  // product rule covers answers. Only the answer itself (and the failure that
  // replaces it) is public.
  if (prompt.length > maxPromptChars) {
    await interaction.reply({
      content: `✂️ That prompt is ${prompt.length} characters long; PompAI accepts at most ${maxPromptChars}.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const turn = acquireTurn(userId, cooldownMs, Date.now());
  if (!turn.ok) {
    const content =
      turn.reason === 'in-flight'
        ? '⏳ PompAI is still answering your previous question. Please wait for it to finish.'
        : `⏳ PompAI is cooling down. Try again in ${Math.ceil(turn.retryAfterMs / 1000)}s.`;
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    return;
  }

  try {
    // Acknowledge before the network call so Discord's 3-second window is met
    // even when the provider is slow.
    await interaction.deferReply(visibility.replyOptions());

    const ai = ctx.ai.describe();

    // Recent turns for THIS user in THIS channel only. An empty array when no
    // memory is wired up, which keeps the command usable in isolation.
    const history = ctx.memory?.history(scope) ?? [];
    const system = buildSystemPrompt({ channelName });

    const response = await ctx.ai.complete({
      system,
      messages: [...history, { role: 'user', content: prompt }],
    });
    const body = String(response.text ?? '').trim() || '(empty response)';

    // Only the model's own answer is remembered - never the system prompt, and
    // never the "not configured" banner.
    ctx.memory?.append(
      scope,
      { role: 'user', content: prompt },
      { role: 'assistant', content: body },
    );

    // The "not configured" notice leads, so nobody mistakes stub output for a
    // real model's answer.
    const sections = [];
    if (!ai.live) sections.push(NOT_CONFIGURED_NOTICE);

    sections.push(`**${response.provider}${response.model ? ` / ${response.model}` : ''}**\n${body}`);

    const chunks = splitForDiscord(sections.join('\n\n'), DISCORD_MESSAGE_LIMIT);
    await interaction.editReply(chunks[0]);
    for (const chunk of chunks.slice(1)) {
      // Every chunk of a long answer inherits the original visibility.
      await interaction.followUp(visibility.followUpOptions(chunk));
    }
  } catch (error) {
    ctx.logger?.warn?.('AI completion failed.', { code: error?.code ?? 'AI_ERROR' });
    // The message is built from a stable error code only - never a stack trace,
    // a vendor body or a credential. It replaces the public acknowledgement, so
    // it uses the same policy.
    const content = describeAskFailure(error);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(content).catch(() => {});
    } else {
      await interaction.reply(visibility.replyOptions({ content })).catch(() => {});
    }
  } finally {
    turn.state.inFlight = false;
  }
}
