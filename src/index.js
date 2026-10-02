import { pathToFileURL } from 'node:url';
import { Client, GatewayIntentBits } from 'discord.js';
import { PROJECT_ROOT, loadConfig } from './config/index.js';
import { createLogger } from './utils/logger.js';
import { formatError } from './utils/errors.js';
import { createShutdownController, installCrashHandlers } from './utils/shutdown.js';
import { loadCommands } from './commands/index.js';
import { loadEvents, registerEvents } from './events/index.js';
import { createAIClient } from './ai/index.js';
import { ConversationMemory } from './ai/memory.js';
import { DEFAULT_STATE_FILE, createGiveawayMonitorFromConfig } from './giveaways/index.js';
import { createChannelNotifier } from './giveaways/notifier.js';
import { createFunService, resolveDatabasePath } from './fun/index.js';
import { createHealthServer } from './health/server.js';
import { describePersistence, detectPlatform, stateInventory } from './deploy/platform.js';
import { startPompMusic } from './music/bot.js';

/**
 * Bot bootstrap.
 *
 * Startup happens in two clearly separated halves:
 *
 *   1. preflight() - read config, load commands and events, construct the
 *      client. Entirely offline. Fails fast with a readable message.
 *   2. main()      - with BOT_CONNECT=true, log in and stay running until
 *      SIGINT/SIGTERM; otherwise report the preflight result and exit.
 *
 * Nothing logged here contains the Discord token: config summaries pass through
 * `describeConfig`, and login failures log only the error message and code.
 */

/** Intents are kept minimal: slash commands need no privileged intents. */
const BASE_INTENTS = [
  GatewayIntentBits.Guilds,
  // Activity XP needs to know that a message was sent, not what it said.
  // GuildMessages is NOT privileged; MessageContent is, and PompAI still does
  // not ask for it. Without it Discord delivers the event with an empty body,
  // which is exactly the part the XP feature ignores.
  GatewayIntentBits.GuildMessages,
];

/**
 * PompAI asks for `Guilds` and `GuildMessages`, and no privileged intent.
 *
 * Music moved to its own application (see `src/music/bot.js`), and with it the
 * `MessageContent` privileged intent. Nothing on PompAI reads message content,
 * so it never needs the portal toggle - which keeps its permission surface as
 * small as the features actually require.
 */

/**
 * @param {object} [options]
 * @param {Record<string, string|undefined>} [options.env]
 * @param {object} [options.logger]
 * @returns {Promise<{ config: object, logger: object, client: object, commands: Map<string, object>, events: object[], ai: object, ctx: object, startedAt: number }>}
 */
export async function preflight({
  env,
  logger: suppliedLogger = null,
  startedAt = Date.now(),
  clientFactory = null,
} = {}) {
  const config = loadConfig(env === undefined ? {} : { env, loadDotenv: false });
  const logger = suppliedLogger ?? createLogger({ level: config.logLevel, name: 'pompai' });

  const [commands, events] = await Promise.all([loadCommands(), loadEvents()]);
  const ai = createAIClient(config.ai, { logger });

  // Injectable so a test can drive the real startup and shutdown sequence
  // without a gateway connection.
  const client = clientFactory ? clientFactory({ intents: BASE_INTENTS }) : new Client({ intents: BASE_INTENTS });


  // In RAM only. A restart constructs a new store, so every conversation
  // starts empty - which is the documented behaviour, not an oversight.
  const memory = new ConversationMemory({ maxMessages: config.ai.historyMessages });

  // Free game alerts. Constructed unconditionally so the on-demand /ucretsiz
  // command works even when background polling is switched off. No AI client is
  // passed in, so polling cannot make a paid call.
  const notifier = createChannelNotifier({
    client,
    channelName: config.giveaways.channelName,
    logger: logger.child({}, 'giveaways'),
  });
  const giveaways = createGiveawayMonitorFromConfig({
    config,
    notifier,
    logger: logger.child({}, 'giveaways'),
  });

  // The fun economy. It owns a SQLite file and no AI client at all, which is
  // what makes every game outcome free and offline.
  const fun = createFunService({ config, logger: logger.child({}, 'fun') });

  const ctx = { config, logger, commands, events, ai, memory, giveaways, fun, startedAt };
  ctx.unbindEvents = registerEvents(client, events, ctx);

  logger.debug('Preflight finished.', {
    commands: commands.size,
    events: events.length,
    historyMessages: config.ai.historyMessages,
    giveawaysEnabled: config.giveaways.enabled,
    funDatabase: config.fun.dbFile ?? '(default)',
  });
  return { config, logger, client, commands, events, ai, memory, giveaways, fun, ctx, startedAt };
}

/**
 * Reports where the runtime state is being written, and whether that survives
 * a restart.
 *
 * A container platform gives the process a fresh filesystem on every deploy.
 * The economy and the giveaway ledger are real files on that filesystem, so
 * they are lost - which is acceptable, but not something to find out by
 * surprise. Nothing is migrated or redirected here: this only says so.
 *
 * @returns {object} the persistence description, for tests and for the caller
 */
export function warnAboutPersistence({ config, logger, env = {} }) {
  const platform = detectPlatform(env, config.platform);
  const persistence = describePersistence({
    platform,
    diskPath: config.persistentStoragePath,
    entries: stateInventory({
      funDbFile: resolveDatabasePath(config.fun.dbFile),
      giveawayStateFile: config.giveaways.stateFile ?? DEFAULT_STATE_FILE,
      root: PROJECT_ROOT,
    }),
  });

  if (persistence.warning) logger.warn(persistence.warning, { platform });
  else if (persistence.note) logger.info(persistence.note, { platform, diskPath: persistence.diskPath });

  logger.debug('Runtime state inventory.', {
    platform,
    entries: persistence.entries.map((entry) => ({
      key: entry.key,
      path: entry.displayPath,
      persistent: entry.onPersistentDisk,
    })),
  });
  return persistence;
}

/**
 * Renders the startup banner. Safe to print: no token, no API key.
 */
function logStartup({ config, logger, commands, ai, startedAt }) {
  const description = ai.describe();

  logger.info('PompAI is starting.', {
    node: process.version,
    env: config.env,
    platform: config.platform,
    mode: config.connect ? 'live' : 'dry-run',
    guild: config.discord.guildId ?? '(global)',
    expectedGuildName: config.discord.expectedGuildName ?? '(not checked)',
    commands: [...commands.keys()].sort(),
    ai: {
      provider: description.provider,
      model: description.model ?? '(provider default)',
      live: description.live,
    },
    durationMs: Date.now() - startedAt,
  });

  if (!description.live) {
    logger.warn(
      'No real AI provider is configured - /ask will answer from the offline stub. ' +
        'Set AI_PROVIDER and AI_API_KEY to enable real answers.',
    );
  }
}

/**
 * @param {object} [options]
 * @param {boolean} [options.waitForShutdown] Set false to return as soon as the
 *   client is connected (used by tests).
 * @param {object} [options.processRef]
 * @returns {Promise<{ exitCode: number }>}
 */
export async function main(options = {}) {
  const startedAt = Date.now();
  const { waitForShutdown = true, processRef = process, env, ...preflightOptions } = options;
  const runtimeEnv = env ?? process.env;

  let bootstrapped;
  try {
    // `env` is only forwarded when the caller supplied one: passing
    // `process.env` explicitly would stop preflight reading `.env` from disk,
    // which is a behaviour change no caller asked for.
    const args = { ...preflightOptions, startedAt };
    if (env !== undefined) args.env = env;
    bootstrapped = await preflight(args);
  } catch (error) {
    // Configuration problems are the common case and must read cleanly.
    processRef.stderr.write(`${formatError(error)}\n`);
    return { exitCode: 1 };
  }

  const { config, logger, client, commands, ai, giveaways, fun, ctx } = bootstrapped;
  logStartup({ config, logger, commands, ai, startedAt });
  warnAboutPersistence({ config, logger, env: runtimeEnv });

  // The HTTP endpoint is opened BEFORE the gateway login. A platform decides
  // whether the service is alive by probing this port, and a slow or refused
  // Discord connection must not be mistaken for a dead process. Each bot's real
  // state is reported in the payload, so the check can pass while a bot is still
  // connecting - which is the honest answer, not a false one.
  const botStatus = { pompAI: false, pompMusic: false };
  const health = createHealthServer({
    logger: logger.child({}, 'health'),
    status: botStatus,
    startedAt,
    env: runtimeEnv,
  });
  await health.start();

  if (!config.connect) {
    logger.info(
      'BOT_CONNECT is false - no gateway connection was opened. ' +
        'Set BOT_CONNECT=true to run PompAI as a long-running bot.',
    );
    // Nothing is going to keep the process alive, and a listening socket would
    // do exactly that.
    await health.stop();
    fun.close();
    return { exitCode: 0 };
  }

  try {
    await client.login(config.discord.token);
    botStatus.pompAI = true;
  } catch (error) {
    // discord.js errors can echo the token; log only the message and code.
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Failed to connect to Discord.', { message, code: error?.code ?? null });

    // A privileged intent that has not been switched on in the Developer Portal
    // is the single most likely cause of a refused login, and the raw error does
    // not say which toggle to flip.
    if (/disallowed intent|privileged intent/i.test(message)) {
      logger.error(
        'The Message Content intent is not enabled for this application. ' +
          'Turn it on at Developer Portal -> Applications -> Bot -> Privileged Gateway Intents, ' +
          'or set MUSIC_ENABLED=false to run without the music system.',
      );
    }
    // The socket has to go before returning, or a listening server keeps the
    // event loop alive and the process never actually exits with this code.
    await health.stop();
    fun.close();
    return { exitCode: 1 };
  }

  logger.info('PompAI is online.', { user: client.user?.tag ?? null, guilds: client.guilds.cache.size });

  /* -- PompMusic: a separate application, isolated from the above --------- */

  // Started after PompAI and wrapped in its own try/catch. A missing token, a
  // refused privileged intent or a bad login must not stop the AI bot, and a
  // music failure later must not either: the two share a process but nothing
  // else.
  let pompMusic = null;
  if (config.pompMusic.enabled) {
    try {
      pompMusic = await startPompMusic({ config, logger });
    } catch (error) {
      logger.error('PompMusic failed to start. PompAI continues without it.', {
        message: error instanceof Error ? error.message : String(error),
        code: error?.code ?? null,
      });
    }
  } else {
    logger.info('PompMusic is disabled. Set POMPMUSIC_ENABLED=true to run it alongside PompAI.');
  }
  botStatus.pompMusic = pompMusic !== null;

  // Background polling is opt-in. `npm start` with FREE_GAMES_ENABLED=false
  // makes no outbound request to any store.
  if (config.giveaways.enabled) {
    giveaways.start();
  } else {
    logger.info('Free game polling is disabled. Set FREE_GAMES_ENABLED=true to enable it.', {
      channel: config.giveaways.channelName,
    });
  }

  // SIGTERM is what a platform sends before it replaces the container, so this
  // is the path a redeploy takes. Everything that owns an OS resource is
  // released here, in the order that stops new work arriving before the
  // machinery underneath it is dismantled.
  const controller = createShutdownController({
    logger,
    processRef,
    onShutdown: async () => {
      // First: stop answering, so nothing new arrives while we tear down.
      await health.stop().catch(() => {});
      giveaways.stop();
      // PompMusic's teardown destroys every voice session, and a session's
      // destroy kills the yt-dlp child it owns - so no extractor outlives the
      // process that started it. A redeploy must not leave orphans behind.
      await pompMusic?.destroy().catch(() => {});
      ctx.unbindEvents?.();
      await client.destroy();
      // Last: a write in flight from a command must finish before the handle
      // goes away. Every economy change is already committed by the time its
      // command returns, so this only releases the file.
      fun.close();
    },
  });

  const detachCrashHandlers = installCrashHandlers({
    logger,
    processRef,
    onFatal: () => controller.shutdown('fatal'),
  });

  if (!waitForShutdown) {
    controller.detach();
    detachCrashHandlers();
    // Nothing else will call the shutdown path, so the resources it would have
    // released are released here. A listening socket or an open database left
    // behind keeps the event loop alive and stops the process exiting, so this
    // waits for `done` rather than for `shutdown`, which only starts the work.
    controller.shutdown('return');
    await controller.done;
    return { exitCode: 0 };
  }

  await controller.done;
  detachCrashHandlers();
  return { exitCode: 0 };
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const { exitCode } = await main();
  if (exitCode !== 0) process.exitCode = exitCode;
}
