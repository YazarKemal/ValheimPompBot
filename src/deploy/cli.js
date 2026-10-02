import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config/index.js';
import { createLogger } from '../utils/logger.js';
import { formatError } from '../utils/errors.js';
import { loadCommands } from '../commands/index.js';
import { deployGuildCommands } from './index.js';

/**
 * `npm run deploy:commands` - register PompAI's slash commands with one guild.
 *
 * Guild-scoped only (DISCORD_GUILD_ID). Never prints the bot token.
 */

const USAGE = `Register PompAI slash commands with the MiningFools guild.

Usage:
  npm run deploy:commands -- [options]        # PompAI AI commands
  npm run deploy:music-commands -- [options]  # PompMusic music commands

Options:
  --owner <name>    pompai (default) or pompmusic. Each uses its own credentials.
  --dry-run         Show what would change without registering anything.
  --allow-removals  Permit dropping commands that are registered but no longer defined.
  --help            Show this message.

Registration is guild-scoped: DISCORD_GUILD_ID must be set. Global command
registration is intentionally not supported in this phase.
`;

/**
 * @param {object} [io]
 * @returns {Promise<number>} exit code
 */
export async function runDeployCli({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
  env,
  deploy = deployGuildCommands,
} = {}) {
  const options = parseArgs(argv);
  if (options.help) {
    stdout.write(USAGE);
    return 0;
  }
  if (options.error) {
    stderr.write(`${options.error}\n\n${USAGE}`);
    return 2;
  }

  let config;
  try {
    config = loadConfig(env === undefined ? {} : { env, loadDotenv: false });
  } catch (error) {
    stderr.write(`${formatError(error)}\n`);
    return 1;
  }

  const logger = createLogger({ level: config.logLevel, name: 'deploy' });

  if (!config.discord.guildId) {
    stderr.write(
      'DISCORD_GUILD_ID is not set. Slash command registration is guild-scoped only;\n' +
        'global registration is intentionally not supported.\n',
    );
    return 1;
  }

  // Each application registers only its own commands, with its own credentials.
  // Mixing them would put music commands on PompAI's application - the exact
  // mistake this split exists to prevent.
  const music = options.owner === 'pompmusic';
  const token = music ? config.pompMusic.token : config.discord.token;
  const clientId = music ? config.pompMusic.clientId : config.discord.clientId;

  if (!token || !clientId) {
    stderr.write(
      music
        ? 'POMPMUSIC_TOKEN and POMPMUSIC_CLIENT_ID must both be set to deploy music commands.\n'
        : 'DISCORD_TOKEN and DISCORD_CLIENT_ID must both be set to deploy AI commands.\n',
    );
    return 1;
  }

  let commands;
  try {
    commands = await loadCommands(undefined, { owner: options.owner });
  } catch (error) {
    stderr.write(`${formatError(error)}\n`);
    return 1;
  }

  try {
    const result = await deploy({
      token,
      clientId,
      guildId: config.discord.guildId,
      commands,
      logger,
      dryRun: options.dryRun,
      allowRemovals: options.allowRemovals,
    });

    stdout.write(`\nGuild: ${config.discord.guildId}\n`);
    stdout.write(`Commands: ${[...commands.keys()].sort().join(', ')}\n\n`);
    stdout.write(`  added:     ${result.diff.added.join(', ') || '(none)'}\n`);
    stdout.write(`  updated:   ${result.diff.updated.join(', ') || '(none)'}\n`);
    stdout.write(`  unchanged: ${result.diff.unchanged.join(', ') || '(none)'}\n`);
    stdout.write(`  removed:   ${result.diff.removed.join(', ') || '(none)'}\n\n`);

    if (result.dryRun) {
      stdout.write('Dry run: nothing was registered.\n');
      return 0;
    }

    stdout.write(`Registered ${result.registered.length} command(s): ${result.registered.join(', ')}\n`);
    stdout.write('They appear in Discord immediately as guild commands.\n');
    return 0;
  } catch (error) {
    stderr.write(`${formatError(error)}\n`);
    return 1;
  }
}

/**
 * @param {string[]} argv
 * @returns {{ dryRun?: boolean, allowRemovals?: boolean, help?: boolean, error?: string }}
 */
export function parseArgs(argv) {
  const options = { dryRun: false, allowRemovals: false, owner: 'pompai', help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--allow-removals') options.allowRemovals = true;
    else if (arg === '--owner') {
      const value = argv[index + 1];
      if (value !== 'pompai' && value !== 'pompmusic') {
        return { error: '--owner must be "pompai" or "pompmusic".' };
      }
      options.owner = value;
      index += 1;
    } else return { error: `Unknown argument: ${arg}` };
  }
  return options;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = await runDeployCli();
}
