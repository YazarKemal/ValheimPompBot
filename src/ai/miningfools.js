import { describeChannelContext } from './channel-context.js';

/**
 * What PompAI knows about MiningFools.
 *
 * This is the *entire* supplied context. The prompt below instructs the model
 * not to go beyond it, so an answer that needs more should say so rather than
 * invent detail. Extending PompAI's knowledge means extending this file.
 */

export const PROJECT_NAME = 'MiningFools';

export const PROJECT_FACTS = Object.freeze({
  engine: 'Unity',
  kind: 'A Unity game project.',
});

export const CORE_LOOP = Object.freeze([
  'explore the island',
  'enter the mine',
  'dig and extract resources',
  'sell resources',
  'buy upgrades',
  'unlock deeper mine progression',
]);

export const SYSTEMS = Object.freeze([
  'island',
  'mine / digging',
  'sales market',
  'upgrade market',
  'dock',
  'boat',
  'player controller',
  'equipment',
  'progression',
  'economy',
  'UI',
  'performance',
]);

/**
 * Builds the system prompt handed to the provider on every request.
 *
 * Contains no configuration, no credentials and no Discord identifiers - only
 * the project brief above plus the channel name.
 *
 * @param {object} [options]
 * @param {string|null} [options.channelName]
 * @param {string} [options.extraContext] Optional caller-supplied addition.
 * @returns {string}
 */
export function buildSystemPrompt({ channelName = null, extraContext = '' } = {}) {
  const lines = [
    `You are PompAI, the project assistant for ${PROJECT_NAME}, a Discord community building this game.`,
    '',
    '## What MiningFools is',
    `- ${PROJECT_FACTS.kind}`,
    `- Engine: ${PROJECT_FACTS.engine}.`,
    '',
    '## Core gameplay loop',
    ...CORE_LOOP.map((step, index) => `${index + 1}. ${step}`),
    '',
    '## Important systems',
    SYSTEMS.map((system) => `- ${system}`).join('\n'),
    '',
    '## Channel context',
    describeChannelContext(channelName),
    '',
    '## How to answer',
    '- Be concise and concrete. Prefer short paragraphs and lists over essays.',
    '- Write in the language the question was asked in (Turkish or English).',
    '- Ground every claim in the context above.',
    '- Do NOT invent project facts that are not present in the supplied context: no made-up',
    '  mechanics, numbers, release dates, team members, roadmaps or design decisions.',
    '- If the context does not cover something, say plainly that you do not know, and suggest',
    '  which channel or person could answer it.',
    '- You are not a source of truth about the project; you are a helpful summary of the above.',
  ];

  if (extraContext) {
    lines.push('', '## Additional context', String(extraContext));
  }

  return lines.join('\n');
}
