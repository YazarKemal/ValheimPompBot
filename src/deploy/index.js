import { REST, Routes } from 'discord.js';
import { BotError } from '../utils/errors.js';
import { createNullLogger } from '../utils/logger.js';
import { toRegistrationPayload } from '../commands/index.js';

/**
 * Guild-scoped slash command registration.
 *
 * Global registration is deliberately not supported in this phase: global
 * commands can take an hour to propagate and would apply to every guild the bot
 * joins. Everything here targets exactly one guild.
 *
 * Registration uses Discord's bulk-overwrite endpoint, which is an upsert by
 * command name and therefore idempotent. The catch is that it also removes any
 * command of *this application* that is not in the payload. Rather than let that
 * happen silently, the current commands are read first and the deploy aborts if
 * anything would be dropped.
 */

export const DISCORD_API_VERSION = '10';

/** Registration is guild-scoped only. */
export function assertGuildScoped(guildId) {
  if (!guildId || typeof guildId !== 'string' || guildId.trim() === '') {
    throw new BotError(
      'Slash command registration is guild-scoped only, but DISCORD_GUILD_ID is not set. ' +
        'Global registration is intentionally not supported.',
      { code: 'DEPLOY_GUILD_REQUIRED' },
    );
  }
}

/**
 * Reads the commands currently registered to this application in this guild.
 * Read-only.
 *
 * @param {{ rest: object, clientId: string, guildId: string }} options
 */
export async function fetchExistingCommands({ rest, clientId, guildId }) {
  const commands = await rest.get(Routes.applicationGuildCommands(clientId, guildId));
  return Array.isArray(commands) ? commands : [];
}

/**
 * Projects a registered command onto the fields we actually manage.
 *
 * Discord decorates what it returns with server-assigned values (`id`,
 * `version`, `application_id`, `guild_id`) and strips defaults it considers
 * redundant - a guild command comes back without `dm_permission: false` and
 * without an empty `options` array. Comparing the raw objects would therefore
 * report every command as changed on every run, turning a no-op deploy into a
 * write and making the diff lie.
 *
 * Only keys present in the desired payload are compared; anything Discord adds
 * is ignored. A key Discord omitted is treated as matching when the desired
 * value is that key's "absent" equivalent (false, null, or an empty array).
 *
 * @param {unknown} actual Value returned by Discord.
 * @param {unknown} template Value from our registration payload.
 */
export function projectOnto(actual, template) {
  if (Array.isArray(template)) {
    const actualArray = Array.isArray(actual) ? actual : [];
    return template.map((item, index) => projectOnto(actualArray[index], item));
  }

  if (template !== null && typeof template === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(template)) {
      const present = actual !== null && typeof actual === 'object' && Object.hasOwn(actual, key);
      result[key] = present ? projectOnto(actual[key], value) : absentEquivalent(value);
    }
    return result;
  }

  return actual;
}

/** What a missing key is assumed to equal. `undefined` means a real difference. */
function absentEquivalent(templateValue) {
  if (templateValue === false || templateValue === null) return templateValue;
  if (Array.isArray(templateValue) && templateValue.length === 0) return templateValue;
  return undefined;
}

/** True when a registered command already matches the desired definition. */
export function commandsMatch(registered, desired) {
  return JSON.stringify(projectOnto(registered, desired)) === JSON.stringify(desired);
}

/**
 * Compares the desired command set with what is already registered.
 *
 * @param {Array<{name: string}>} existing
 * @param {Array<{name: string}>} desired
 * @returns {{ added: string[], updated: string[], removed: string[], unchanged: string[] }}
 */
export function diffCommands(existing, desired) {
  const existingByName = new Map(existing.map((command) => [command.name, command]));
  const desiredNames = new Set(desired.map((command) => command.name));

  const added = [];
  const updated = [];
  const unchanged = [];

  for (const command of desired) {
    const current = existingByName.get(command.name);
    if (!current) {
      added.push(command.name);
    } else if (commandsMatch(current, command)) {
      unchanged.push(command.name);
    } else {
      updated.push(command.name);
    }
  }

  const removed = existing.filter((command) => !desiredNames.has(command.name)).map((command) => command.name);

  return { added, updated, removed, unchanged };
}

/**
 * Registers the guild's slash commands.
 *
 * @param {object} options
 * @param {string} options.token Bot token. Never logged.
 * @param {string} options.clientId Application id.
 * @param {string} options.guildId Target guild. Required.
 * @param {Map<string, {data: object}>} options.commands
 * @param {object} [options.rest] Injected REST client (used by tests).
 * @param {object} [options.logger]
 * @param {boolean} [options.dryRun] Plan without writing.
 * @param {boolean} [options.allowRemovals] Permit dropping stale commands.
 * @returns {Promise<{ dryRun: boolean, diff: object, registered: string[] }>}
 */
export async function deployGuildCommands({
  token,
  clientId,
  guildId,
  commands,
  rest = null,
  logger = createNullLogger(),
  dryRun = false,
  allowRemovals = false,
}) {
  assertGuildScoped(guildId);

  const body = toRegistrationPayload(commands);
  if (body.length === 0) {
    throw new BotError('No commands to register.', { code: 'DEPLOY_EMPTY' });
  }

  const client = rest ?? new REST({ version: DISCORD_API_VERSION }).setToken(token);

  logger.debug('Reading currently registered guild commands.');
  const existing = await fetchExistingCommands({ rest: client, clientId, guildId });
  const diff = diffCommands(existing, body);

  logger.info('Command diff resolved.', {
    guild: guildId,
    added: diff.added,
    updated: diff.updated,
    unchanged: diff.unchanged,
    removed: diff.removed,
  });

  if (diff.removed.length > 0 && !allowRemovals) {
    throw new BotError(
      `Refusing to register: ${diff.removed.length} existing command(s) would be removed ` +
        `(${diff.removed.join(', ')}). Re-run with --allow-removals if that is intended.`,
      { code: 'DEPLOY_WOULD_REMOVE', details: { removed: diff.removed } },
    );
  }

  if (dryRun) {
    logger.info('Dry run: no commands were registered.');
    return { dryRun: true, diff, registered: [] };
  }

  const result = await client.put(Routes.applicationGuildCommands(clientId, guildId), { body });
  const registered = (Array.isArray(result) ? result : []).map((command) => command.name);
  logger.info('Guild commands registered.', { guild: guildId, registered });

  return { dryRun: false, diff, registered };
}
