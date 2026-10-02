import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, describeConfig } from '../config/index.js';
import { createLogger } from '../utils/logger.js';
import { formatError } from '../utils/errors.js';
import { DEFAULT_BLUEPRINT } from './constants.js';
import { buildBlueprint } from './blueprints/index.js';
import { planSetup } from './planner.js';
import { renderPlan } from './render.js';
import { emptyGuildState } from './state.js';
import { liveApply, renderOutcome } from './live-apply.js';
import { createDiscordSession } from './session.js';

const USAGE = `PompBot server setup planner

Usage:
  node src/setup/cli.js [options]

Options:
  --blueprint <name>  Which server layout to plan. Default: miningfools
  --from-json <file>  Plan against a saved guild snapshot instead of an empty server.
  --json              Emit the raw plan as JSON (preview only).
  --apply             Run the live apply pipeline against the real guild.
  --confirm           Required alongside --apply. A second, deliberate opt-in.
  --help              Show this message.

Preview only (no connection, no writes):
  npm run setup:plan -- --blueprint miningfools

Capture the live server first (read-only):
  npm run snapshot

LIVE APPLY - writes to Discord. Requires DRY_RUN=false in .env AND --confirm:
  npm run setup:apply -- --confirm
`;

/**
 * @param {object} [io]
 * @param {string[]} [io.argv]
 * @param {NodeJS.WritableStream} [io.stdout]
 * @param {NodeJS.WritableStream} [io.stderr]
 * @param {Record<string, string|undefined>} [io.env] Environment source. Tests
 *   pass one so the real `.env` is never read.
 * @returns {Promise<number>} process exit code
 */
export async function runSetupCli({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
  env,
  createSession = createDiscordSession,
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
    // Planning works offline; a live apply needs the token and the guild id.
    const requireDiscord = Boolean(options.apply);
    config = loadConfig(
      env === undefined ? { requireDiscord } : { env, loadDotenv: false, requireDiscord },
    );
  } catch (error) {
    stderr.write(`${formatError(error)}\n`);
    return 1;
  }

  // In --json mode every log line goes to stderr so stdout stays parseable.
  const logger = createLogger({ level: config.logLevel, name: 'setup', stream: options.json ? stderr : null });

  let state = emptyGuildState();
  if (options.fromJson) {
    try {
      state = JSON.parse(await readFile(path.resolve(options.fromJson), 'utf8'));
    } catch (error) {
      stderr.write(`Could not read snapshot "${options.fromJson}": ${error.message}\n`);
      return 1;
    }
  }

  let blueprint;
  try {
    blueprint = buildBlueprint(options.blueprint);
  } catch (error) {
    stderr.write(`${formatError(error)}\n`);
    return 1;
  }
  if (options.apply) {
    return runLiveApply({ options, config, blueprint, stdout, stderr, logger, createSession });
  }

  if (options.json) {
    stdout.write(`${JSON.stringify(planSetup(blueprint, state), null, 2)}\n`);
    return 0;
  }

  const plan = planSetup(blueprint, state);
  stdout.write(`${renderPlan(plan)}\n`);
  stdout.write(`\nConfig: ${JSON.stringify(describeConfig(config))}\n`);
  logger.info(`Dry run only. ${plan.actions.length} action(s) planned, nothing was written.`);
  stdout.write('\nThis was a preview. To write to Discord:\n');
  stdout.write(`  npm run setup:apply -- --confirm\n`);

  return 0;
}

/**
 * The live apply path.
 *
 * The confirmation flags are checked *before* connecting, so a mistaken
 * invocation never even opens a gateway connection.
 */
async function runLiveApply({ options, config, blueprint, stdout, stderr, logger, createSession }) {
  if (!options.confirm) {
    stderr.write(
      'Refusing to apply: --confirm is required.\n' +
        'A live run writes to the real guild. Review the preview first:\n' +
        '  npm run setup:plan -- --blueprint ' +
        `${blueprint.key}\n` +
        'Then, if you are sure:\n' +
        `  npm run setup:apply -- --confirm\n`,
    );
    return 1;
  }

  if (config.dryRun) {
    stderr.write(
      'Refusing to apply: DRY_RUN is true in .env.\n' +
        'Set DRY_RUN=false to allow a live run, then re-run with --confirm.\n',
    );
    return 1;
  }

  if (!config.discord.guildId) {
    stderr.write('Refusing to apply: DISCORD_GUILD_ID must be set to the MiningFools guild id.\n');
    return 1;
  }

  let session;
  try {
    session = await createSession({
      token: config.discord.token,
      guildId: config.discord.guildId,
      logger,
    });
  } catch (error) {
    stderr.write(`${formatError(error)}\n`);
    return 1;
  }

  try {
    const result = await liveApply({
      config,
      session,
      blueprint,
      confirm: options.confirm,
      logger,
      print: (text) => stdout.write(text),
    });

    stdout.write(renderOutcome(result));
    return result.ok ? 0 : 1;
  } catch (error) {
    stderr.write(`${formatError(error)}\n`);
    if (error.violations?.length) {
      stderr.write('\nSafety violations:\n');
      for (const violation of error.violations) stderr.write(`  - ${violation}\n`);
      stderr.write('\nNothing was written.\n');
    }
    return 1;
  } finally {
    await session.close();
  }
}

/**
 * @param {string[]} argv
 * @returns {{ help?: boolean, json?: boolean, apply?: boolean, fromJson?: string|null, error?: string }}
 */
export function parseArgs(argv) {
  const options = {
    json: false,
    apply: false,
    confirm: false,
    fromJson: null,
    blueprint: DEFAULT_BLUEPRINT,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--apply') options.apply = true;
    else if (arg === '--confirm') options.confirm = true;
    else if (arg === '--from-json' || arg === '--blueprint') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) return { error: `${arg} requires a value.` };
      if (arg === '--from-json') options.fromJson = value;
      else options.blueprint = value;
      index += 1;
    } else {
      return { error: `Unknown argument: ${arg}` };
    }
  }
  return options;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = await runSetupCli();
}
