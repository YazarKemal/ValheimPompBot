import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config/index.js';
import { createLogger } from '../utils/logger.js';
import { formatError } from '../utils/errors.js';
import { buildBlueprint } from './blueprints/index.js';
import { planSetup } from './planner.js';
import { captureGuildSnapshot } from './snapshot.js';

/**
 * `npm run snapshot` - capture the current guild state as JSON, read-only.
 *
 * Writes nothing to Discord. The output feeds `npm run setup:plan -- --from-json`.
 */

const USAGE = `Capture the current Discord server state (read-only).

Usage:
  npm run snapshot -- [options]

Options:
  --out <file>    Where to write the snapshot. Default: snapshots/<guild>.json
  --guild <id>    Guild to capture. Default: DISCORD_GUILD_ID, else the bot's first guild.
  --blueprint <n> Blueprint to preview against. Default: miningfools
  --help          Show this message.

This command only reads. It issues no create, edit or delete request.
`;

/**
 * @param {object} [io]
 * @returns {Promise<number>} exit code
 */
export async function runSnapshotCli({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
  env,
  capture = captureGuildSnapshot,
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

  // Resolve the blueprint before connecting, so a typo fails instantly.
  let blueprint;
  try {
    blueprint = buildBlueprint(options.blueprint);
  } catch (error) {
    stderr.write(`${formatError(error)}\n`);
    return 1;
  }

  const logger = createLogger({ level: config.logLevel, name: 'snapshot' });
  const guildId = options.guild ?? config.discord.guildId ?? null;

  let document;
  let client;
  try {
    ({ document, client } = await capture({ token: config.discord.token, guildId, logger }));
  } catch (error) {
    stderr.write(`${formatError(error)}\n`);
    return 1;
  } finally {
    // Always disconnect, whether or not the capture succeeded.
    await client?.destroy?.().catch(() => {});
  }

  const outPath = path.resolve(
    options.out ?? path.join('snapshots', `snapshot-${document.guild.id}.json`),
  );
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

  const plan = planSetup(blueprint, document);
  const mutating = plan.actions.filter((action) => action.kind !== 'skip' && action.kind !== 'keep');

  stdout.write(`\nSnapshot captured (READ-ONLY - nothing was written to Discord)\n`);
  stdout.write(`${'-'.repeat(60)}\n`);
  stdout.write(`  guild          ${document.guild.name} (${document.guild.id})\n`);
  stdout.write(`  categories     ${document.categories.length}\n`);
  stdout.write(`  channels       ${document.channels.length}\n`);
  stdout.write(`  roles          ${document.roles.length}\n`);
  stdout.write(
    `  bot roles      ${document.managedRoles.map((role) => role.name).join(', ') || '(none)'}\n`,
  );
  stdout.write(`  written to     ${outPath}\n`);
  stdout.write(`\nAgainst blueprint "${blueprint.key}": ${mutating.length} change(s) would be needed.\n`);
  stdout.write(`See the full plan with:\n`);
  stdout.write(`  npm run setup:plan -- --blueprint ${blueprint.key} --from-json "${outPath}"\n`);

  if (plan.notes.length > 0) {
    stdout.write('\n');
    for (const note of plan.notes) stdout.write(`  ! ${note}\n`);
  }
  stdout.write('\n');

  return 0;
}

/**
 * @param {string[]} argv
 * @returns {{ out?: string|null, guild?: string|null, blueprint?: string, help?: boolean, error?: string }}
 */
export function parseArgs(argv) {
  const options = { out: null, guild: null, blueprint: 'miningfools', help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--out' || arg === '--guild' || arg === '--blueprint') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) return { error: `${arg} requires a value.` };
      if (arg === '--out') options.out = value;
      else if (arg === '--guild') options.guild = value;
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
  process.exitCode = await runSnapshotCli();
}
