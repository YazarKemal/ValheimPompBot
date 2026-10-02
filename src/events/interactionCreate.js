import { Events, MessageFlags } from 'discord.js';
import { handleMusicInteraction } from '../music/interactions.js';
import { handleBattleInteraction } from '../music/battle-command.js';
import { handleFunInteraction } from '../fun/interactions.js';

export const name = Events.InteractionCreate;
export const once = false;

/**
 * Routes chat-input commands to their handler, and components to the subsystem
 * that owns their customId prefix. Any other interaction type is ignored.
 *
 * Components are routed BEFORE the command check so one never falls through to
 * the command map. Each handler claims an interaction only by its own prefix
 * (`party:`, `savas:`, `music:`), so the order here is not load-bearing.
 *
 * @param {import('discord.js').Interaction} interaction
 * @param {{ logger: object, commands: Map<string, { execute: Function, meta: object }> }} ctx
 */
export async function execute(interaction, ctx) {
  // Optional calls: not every interaction object implements every guard, and a
  // missing one must not throw here.
  if (interaction.isButton?.() || interaction.isStringSelectMenu?.()) {
    if (await handleFunInteraction(interaction, ctx)) return;
    if (await handleBattleInteraction(interaction, ctx)) return;
    const handled = await handleMusicInteraction(interaction, ctx);
    if (handled) return;
  }

  if (!interaction.isChatInputCommand()) return;

  const command = ctx.commands.get(interaction.commandName);
  if (!command) {
    ctx.logger.warn('Received an unknown command.', { command: interaction.commandName });
    await respondSafely(interaction, {
      content: 'That command is not loaded on this instance.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    await command.execute(interaction, ctx);
    ctx.logger.debug('Command handled.', {
      command: command.name,
      user: interaction.user?.tag ?? interaction.user?.id ?? 'unknown',
    });
  } catch (error) {
    ctx.logger.error(`Command "${command.name}" failed.`, error);
    await respondSafely(interaction, {
      content: 'Something went wrong while running that command.',
      flags: MessageFlags.Ephemeral,
    });
  }
}

/**
 * Replies whether or not the interaction was already acknowledged, so error
 * reporting never masks the original failure with an "already replied" error.
 */
async function respondSafely(interaction, payload) {
  try {
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
    else await interaction.reply(payload);
  } catch {
    // The interaction token can expire; there is nothing useful left to do.
  }
}
