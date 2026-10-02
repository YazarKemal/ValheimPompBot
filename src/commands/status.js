import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { brandEmbed, WARNING_COLOR } from '../utils/embeds.js';

export const meta = {
  category: 'diagnostics',
  summary: 'Show PompAI runtime status.',
  order: 2,
};

export const data = new SlashCommandBuilder()
  .setName('status')
  .setDescription('Show PompAI runtime status.')
  .setDMPermission(false);

/** Human-readable provider names for the status embed. Raw ids are the fallback. */
const PROVIDER_LABELS = Object.freeze({
  stub: 'stub',
  deepseek: 'DeepSeek',
  openai: 'OpenAI',
  gemini: 'Gemini',
  glm: 'GLM',
});

/**
 * Reports only safe, non-identifying values.
 *
 * Deliberately absent: the Discord token, the AI API key, the client secret and
 * anything else derived from `config.discord.token` or `config.ai.apiKey`. The
 * AI fields come from `ai.describe()`, which is the same secret-free summary the
 * logger uses.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ config: object, ai: object, startedAt: number, commands: Map<string, unknown> }} ctx
 */
export async function execute(interaction, ctx) {
  const ai = ctx.ai.describe();
  const uptimeMs = Date.now() - ctx.startedAt;

  const embed = brandEmbed({
    title: '⛏️ PompAI status',
    color: ai.live ? undefined : WARNING_COLOR,
    footer: 'PompAI',
  });

  embed.addFields(
    { name: 'Status', value: '🟢 Online', inline: true },
    { name: 'Uptime', value: formatDuration(uptimeMs), inline: true },
    { name: 'Node', value: `\`${process.version}\``, inline: true },
    { name: 'AI provider', value: `\`${PROVIDER_LABELS[ai.provider] ?? ai.provider}\``, inline: true },
    { name: 'AI model', value: `\`${ai.model ?? 'provider default'}\``, inline: true },
    { name: 'Commands', value: `\`${ctx.commands.size}\` loaded`, inline: true },
    { name: 'Live AI', value: ai.live ? 'yes' : 'no', inline: true },
  );

  embed.addFields({
    name: 'AI configuration',
    value: ai.live
      ? 'A real provider is configured.'
      : '⚠️ **No real AI provider is configured yet.** PompAI answers using the offline ' +
        'stub, which echoes your prompt. No paid API calls are made.',
  });

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

/**
 * Renders a duration as `2d 3h 4m 5s`, dropping leading zero units.
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (days > 0 || hours > 0) parts.push(`${hours}h`);
  if (days > 0 || hours > 0 || minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
}
