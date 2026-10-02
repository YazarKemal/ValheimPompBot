import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { buildGamingSystemPrompt, MAX_GAME_NAME_CHARS, normaliseGameName } from '../ai/gaming.js';
import { resolveAiVisibility } from '../ai/visibility.js';
import { splitForDiscord, describeAskFailure, DEFAULT_MAX_PROMPT_CHARS, DEFAULT_USER_COOLDOWN_SECONDS, DISCORD_MESSAGE_LIMIT } from './ask.js';

export const meta = {
  category: 'ai',
  summary: 'Ask PompAI about any game.',
  order: 6,
};

export const data = new SlashCommandBuilder()
  .setName('oyun')
  .setDescription('PompAI\'ye bir oyun hakkında soru sor.')
  .setDMPermission(false)
  .addStringOption((option) =>
    option
      .setName('oyun')
      .setDescription('Hangi oyun?')
      .setRequired(true)
      .setMaxLength(MAX_GAME_NAME_CHARS),
  )
  .addStringOption((option) =>
    option
      .setName('soru')
      .setDescription('Sorun ne?')
      .setRequired(true)
      .setMaxLength(1500),
  );

/** Memory namespace. Kept apart from /ask so the two never share context. */
export const GAME_NAMESPACE = 'game';

/** Fallback used when AI_USER_COOLDOWN_SECONDS is not present on ctx.config. */
export { DEFAULT_USER_COOLDOWN_SECONDS, DEFAULT_MAX_PROMPT_CHARS };

/**
 * Gaming Q&A.
 *
 * Always ephemeral in this phase: a question about a game is not project
 * chatter, and keeping it private avoids filling the channel.
 *
 * The provider is the same DeepSeek client /ask uses, so `AI_MODEL`
 * (deepseek-flash) and the cooldown, prompt-length and output-token limits all
 * apply unchanged. There is no fallback model and no retry.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ ai: object, memory?: object, config?: object, logger?: object }} ctx
 */
export async function execute(interaction, ctx) {
  const game = normaliseGameName(interaction.options.getString('oyun', true));
  const question = interaction.options.getString('soru', true);
  const aiConfig = ctx.config?.ai ?? {};
  const maxPromptChars = aiConfig.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS;
  const userId = interaction.user?.id ?? 'unknown';

  if (question.length > maxPromptChars) {
    await interaction.reply({
      content: `✂️ Soru ${question.length} karakter; PompAI en fazla ${maxPromptChars} karakter kabul ediyor.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (game === '') {
    await interaction.reply({ content: 'Bir oyun adı yazmalısın.', flags: MessageFlags.Ephemeral });
    return;
  }

  // Per user AND per game: asking about two games keeps two separate threads,
  // and never touches the MiningFools /ask conversation.
  const scope = {
    namespace: GAME_NAMESPACE,
    guildId: interaction.guildId ?? interaction.guild?.id ?? null,
    topic: game.toLowerCase(),
    userId,
  };

  // Same shared policy as /ask: gaming answers are public by default.
  const visibility = resolveAiVisibility(ctx.config);

  try {
    await interaction.deferReply(visibility.replyOptions());

    const ai = ctx.ai.describe();
    const history = ctx.memory?.history(scope) ?? [];

    const response = await ctx.ai.complete({
      system: buildGamingSystemPrompt({ game }),
      messages: [...history, { role: 'user', content: question }],
    });
    const body = String(response.text ?? '').trim() || '(boş yanıt)';

    ctx.memory?.append(scope, { role: 'user', content: question }, { role: 'assistant', content: body });

    const chunks = splitForDiscord(body, DISCORD_MESSAGE_LIMIT);
    await interaction.editReply(chunks[0]);
    for (const chunk of chunks.slice(1)) {
      // Every chunk of a long answer inherits the original visibility.
      await interaction.followUp(visibility.followUpOptions(chunk));
    }

    if (!ai.live) {
      ctx.logger?.warn?.('Gaming answer came from a non-live AI provider.', { provider: ai.provider });
    }
  } catch (error) {
    ctx.logger?.warn?.('Gaming completion failed.', { code: error?.code ?? 'AI_ERROR' });
    // Generic text built from a stable code: no stack trace, no vendor body,
    // no credential. It replaces the public acknowledgement, so it is public.
    const content = describeAskFailure(error);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(content).catch(() => {});
    } else {
      await interaction.reply(visibility.replyOptions({ content })).catch(() => {});
    }
  }
}
