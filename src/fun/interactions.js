import { MessageFlags } from 'discord.js';
import { createNullLogger } from '../utils/logger.js';
import { PARTY_ACTIONS, isPartyComponent, parsePartyComponentId } from './party.js';
import { buildPartyPayload, retiredPartyPayload } from './messages.js';

/**
 * Party buttons.
 *
 * Everything party-owned is namespaced `party:`, so routing is a prefix check
 * rather than a guess, and a malformed id is rejected instead of falling
 * through to the command map.
 *
 * The component id carries an opaque session id and nothing else. That is the
 * anti-abuse property that matters here: there is no field a client could edit
 * to ask for a different question, a different reward, or another channel's
 * session - the session is looked up from the id the server issued, keyed by
 * the guild and channel the click actually came from.
 */

/**
 * @param {object} interaction
 * @param {{ fun?: object, logger?: object }} ctx
 * @returns {Promise<boolean>} whether the interaction was handled
 */
export async function handleFunInteraction(interaction, ctx) {
  if (!interaction?.isButton?.()) return false;
  if (!isPartyComponent(interaction.customId)) return false;

  const logger = ctx.logger ?? createNullLogger();
  const service = ctx.fun;
  const parsed = parsePartyComponentId(interaction.customId);

  if (!parsed || !service) {
    await respond(interaction, '🎲 Bu parti oturumu artık geçerli değil.', true);
    return true;
  }

  const scope = {
    guildId: interaction.guildId ?? interaction.guild?.id ?? null,
    channelId: interaction.channelId ?? null,
    sessionId: parsed.sessionId,
  };

  if (!scope.guildId) {
    await respond(interaction, '🎲 Parti oyunları sadece sunucularda çalışıyor.', true);
    return true;
  }

  try {
    if (parsed.action === PARTY_ACTIONS.END) {
      await handleEnd(interaction, service, scope);
      return true;
    }
    await handleNext(interaction, service, scope, logger);
    return true;
  } catch (error) {
    logger.warn('Party button failed.', { action: parsed.action, reason: error?.message });
    await respond(interaction, '🎲 Bu buton şu anda çalışmıyor.', true);
    return true;
  }
}

/** 🎲 Yeni Soru - replaces the question in place. */
async function handleNext(interaction, service, scope, logger) {
  const result = service.party.next(scope);

  if (!result.ok) {
    await respond(
      interaction,
      result.reason === 'stale'
        ? '🎲 Bu tur çoktan bitti. `/parti` ile yenisini başlat.'
        : '🎲 Parti oturumu zaman aşımına uğradı. `/parti` ile yenisini başlat.',
      true,
    );
    return;
  }

  try {
    // `update` rewrites the message the button lives on, so the round stays one
    // message rather than a new one per question.
    await interaction.update(buildPartyPayload(result.session));
  } catch (error) {
    logger.debug('Could not refresh the party message.', { reason: error?.message });
  }
}

/** ⛔ Bitir - retires the controls so the round cannot be resumed. */
async function handleEnd(interaction, service, scope) {
  const session = service.party.get(scope.guildId, scope.channelId);
  const ended = service.party.end(scope);

  if (!ended) {
    await respond(interaction, '🎲 Bu tur zaten bitmişti.', true);
    return;
  }

  const payload = session ? retiredPartyPayload(session) : { components: [] };
  await interaction.update({ ...payload, content: '⛔ Parti bitti. Yeni tur için `/parti`.' }).catch(() => {});
}

/** Acknowledges a component interaction, tolerating an expired token. */
async function respond(interaction, content, ephemeral) {
  const payload = ephemeral ? { content, flags: MessageFlags.Ephemeral } : { content };
  try {
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
    else await interaction.reply(payload);
  } catch {
    // Nothing useful left to do.
  }
}

export { buildPartyPayload };
