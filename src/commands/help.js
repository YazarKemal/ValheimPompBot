import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { brandEmbed } from '../utils/embeds.js';

export const meta = {
  category: 'diagnostics',
  summary: 'List everything PompAI can do.',
  order: 0,
};

export const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('List everything PompAI can do.')
  .setDMPermission(false);

/**
 * Commands receive a context object rather than importing singletons, which
 * keeps them trivially testable and free of module-load side effects.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ commands: Map<string, { name: string, data: object, meta: object }>, ai: object, config: object }} ctx
 */
export async function execute(interaction, ctx) {
  const commands = [...ctx.commands.values()].sort(
    (a, b) => (a.meta.order ?? 99) - (b.meta.order ?? 99) || a.name.localeCompare(b.name),
  );

  const embed = brandEmbed({
    title: '⛏️ PompAI commands',
    description:
      'PompAI is the MiningFools helper bot. Here is everything it can do right now.',
    footer: `${commands.length} command${commands.length === 1 ? '' : 's'} available`,
  });

  for (const command of commands) {
    embed.addFields({
      name: `/${command.name}`,
      value: command.meta.summary ?? command.data.description,
    });
  }

  const ai = ctx.ai.describe();
  embed.addFields({
    name: 'AI provider',
    value: ai.live
      ? `\`${ai.provider}\` / \`${ai.model ?? 'provider default'}\``
      : `\`${ai.provider}\` (offline stub — no real AI is configured yet)`,
  });

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
