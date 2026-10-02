import { MessageFlags } from 'discord.js';

/**
 * Reply visibility policy for AI commands.
 *
 * One place decides whether an answer is public or ephemeral, so a new
 * AI-powered command inherits the product rule by construction rather than by
 * remembering to copy it.
 *
 * The current rule: **AI answers are public.** Everyone in the channel sees
 * them. `AI_RESPONSE_VISIBILITY=ephemeral` is the escape hatch that restores
 * private replies without touching any command.
 *
 * Discord fixes visibility when an interaction is acknowledged, and it cannot
 * be changed afterwards - nor can a public acknowledgement be followed by an
 * ephemeral reply. So a command picks a policy once, before `deferReply`, and
 * uses it for every chunk and for the error message.
 */

export const VISIBILITY = Object.freeze({
  PUBLIC: 'public',
  EPHEMERAL: 'ephemeral',
});

/** The product default. */
export const DEFAULT_VISIBILITY = VISIBILITY.PUBLIC;

/**
 * Coerces a configured value. Anything unrecognised falls back to public, so a
 * typo in .env cannot silently make every answer private.
 */
export function normaliseVisibility(value) {
  return value === VISIBILITY.EPHEMERAL ? VISIBILITY.EPHEMERAL : VISIBILITY.PUBLIC;
}

/**
 * Builds the option payloads a command needs.
 *
 * @param {string} [mode]
 * @returns {{ mode: string, ephemeral: boolean, replyOptions: Function, followUpOptions: Function, editOptions: Function }}
 */
export function createVisibilityPolicy(mode = DEFAULT_VISIBILITY) {
  const resolved = normaliseVisibility(mode);
  const ephemeral = resolved === VISIBILITY.EPHEMERAL;

  return {
    mode: resolved,
    ephemeral,

    /**
     * Options for `deferReply` / `reply`.
     *
     * Public replies pass an empty object rather than `flags: undefined`, so
     * the intent reads clearly and nothing accidentally sets a flag bit.
     */
    replyOptions(extra = {}) {
      return ephemeral ? { ...extra, flags: MessageFlags.Ephemeral } : { ...extra };
    },

    /** Options for one follow-up chunk of a long answer. */
    followUpOptions(content) {
      return ephemeral ? { content, flags: MessageFlags.Ephemeral } : { content };
    },

    /**
     * Options for `editReply` when the payload is a string. `editReply` takes a
     * plain string for a public reply, so no wrapping is needed.
     */
    editPayload(content) {
      return content;
    },
  };
}

/**
 * Resolves the policy from application config.
 *
 * @param {{ ai?: { responseVisibility?: string } }} [config]
 */
export function resolveAiVisibility(config) {
  return createVisibilityPolicy(config?.ai?.responseVisibility ?? DEFAULT_VISIBILITY);
}

/**
 * Channel-name comparison, used where visibility genuinely varies by channel.
 *
 * This is no longer how AI commands decide visibility - they are public
 * everywhere - but `/ucretsiz` still answers publicly only in the giveaway
 * channel.
 *
 * @param {string|null|undefined} channelName
 * @param {string|null|undefined} expected
 */
export function isChannel(channelName, expected) {
  if (typeof channelName !== 'string' || typeof expected !== 'string') return false;
  const actual = channelName.trim().toLowerCase();
  const wanted = expected.trim().toLowerCase();
  return actual !== '' && wanted !== '' && actual === wanted;
}
