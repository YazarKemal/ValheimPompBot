import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import { createNullLogger } from '../utils/logger.js';
import { BotError } from '../utils/errors.js';
import { loadCommands } from '../commands/index.js';
import { createMusicService } from './index.js';
import { createStreamBackend } from './sources/ytdlp.js';
import { handleMusicRequest, shouldHandle } from './listener.js';
import { handleMusicInteraction } from './interactions.js';
import { handleBattleInteraction } from './battle-command.js';

/**
 * PompMusic - a second Discord application.
 *
 * PompMusic is its own bot identity with its own token and its own client. It
 * shares a Node process with PompAI but nothing else: a separate gateway
 * connection, a separate command registration, a separate set of intents, and
 * no dependency on the AI layer at all.
 *
 * Isolation properties this module is responsible for:
 *
 *   - SEPARATE CLIENT. PompAI never receives a message or interaction event
 *     from PompMusic's gateway. There is no routing between them to get wrong.
 *   - PRIVILEGED INTENT, SCOPED. Message Content is requested here only, so
 *     PompAI can run without it and never gains music message processing.
 *   - NO AI. Nothing in this tree can reach a model.
 *   - FAILURE CONTAINMENT. Every handler catches; a playback or search failure
 *     is logged and the gateway stays up. Losing music must not disturb PompAI.
 */

const INTENTS = [
  GatewayIntentBits.Guilds,
  // Needed to see who is in which voice channel.
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.GuildMessages,
  // Privileged: must be enabled for the PompMusic application in the portal.
  GatewayIntentBits.MessageContent,
];

/**
 * @param {object} options
 * @param {object} options.config Full application config.
 * @param {object} [options.logger]
 * @param {object} [options.source] Injected MusicSource (tests).
 * @param {Function} [options.clientFactory] Injected Client constructor (tests).
 * @returns {Promise<{client: object, service: object, commands: Map, destroy: Function}|null>}
 */
export async function startPompMusic({
  config,
  logger = createNullLogger(),
  source = null,
  clientFactory = null,
  providedBackend = null,
  spawnImpl = null,
} = {}) {
  const settings = config?.pompMusic ?? {};
  if (!settings.enabled) return null;

  // A missing token is a configuration mistake, phrased so the fix is obvious.
  if (!settings.token) {
    throw new BotError(
      'POMPMUSIC_ENABLED is true but POMPMUSIC_TOKEN is not set. ' +
        'PompMusic is a separate Discord application and does not use DISCORD_TOKEN.',
      { code: 'POMPMUSIC_NOT_CONFIGURED' },
    );
  }

  const musicLogger = logger.child?.({}, 'pompmusic') ?? logger;
  const createClient = clientFactory ?? ((options) => new Client(options));
  const client = createClient({ intents: INTENTS });

  // The service reads `config.music`, so PompMusic's settings are handed over
  // under that key. No PompAI setting is reachable from here.
  // The audio backend is resolved ONCE, at startup. If yt-dlp is missing we say
  // so plainly and run without streaming - never silently falling back to the
  // play-dl extraction that is known to be broken.
  const { backend: streamBackend, detection } = providedBackend
    ? { backend: providedBackend, detection: { available: true, path: providedBackend.executable ?? null, version: providedBackend.version ?? null, source: 'injected', reason: null } }
    : await createStreamBackend({ settings, logger: musicLogger, spawnImpl: spawnImpl ?? undefined });

  if (streamBackend) {
    musicLogger.info('Music stream backend ready.', {
      backend: streamBackend.name,
      version: detection.version,
      // The path category, not a full filesystem path.
      source: detection.source,
      format: streamBackend.format,
    });
  } else {
    musicLogger.error(
      'Music stream backend unavailable: ' +
        (detection.reason ?? 'unknown reason') +
        ' Install yt-dlp and put it on PATH, or set YTDLP_PATH. ' +
        'PompMusic will run without playback; PompAI is unaffected.',
      { backend: settings.streamBackend ?? 'ytdlp', source: detection.source },
    );
  }

  const service = createMusicService({
    client,
    config: { music: settings },
    logger: musicLogger,
    source,
    providedBackend: streamBackend,
  });
  const commands = await loadCommands(undefined, { owner: 'pompmusic' });

  const ctx = { config, logger: musicLogger, music: service, commands };

  let musicChannelId = null;

  client.once(Events.ClientReady, async (readyClient) => {
    // Resolved once: the channel is created by the setup blueprint and does not
    // move. A failure here is not fatal - it just means text requests are off.
    try {
      const channel = await service.resolveTextChannel();
      musicChannelId = channel?.id ?? null;
      if (!musicChannelId) {
        musicLogger.warn('Music text channel not found; plain-text requests are disabled.', {
          channel: settings.textChannel,
        });
      }
    } catch (error) {
      musicLogger.warn('Could not resolve the music channel.', { reason: error?.message });
    }

    musicLogger.info('PompMusic is online.', {
      user: readyClient.user?.tag ?? null,
      guilds: readyClient.guilds.cache.size,
      commands: [...commands.keys()].sort(),
      textChannel: settings.textChannel,
      stayConnected: settings.stayConnected,
    });
  });

  /* -- Plain-text song requests ------------------------------------------ */

  client.on(Events.MessageCreate, (message) => {
    // Everything is caught. A malformed search result or a dead YouTube stream
    // must not become an unhandled rejection that reaches PompAI's crash
    // handler and takes the whole process down.
    void (async () => {
      try {
        if (!shouldHandle(message, { musicChannelName: settings.textChannel, musicChannelId })) return;
        await handleMusicRequest(message, service.listenerDeps());
      } catch (error) {
        musicLogger.error('Music request failed.', error);
      }
    })();
  });

  /* -- Commands, buttons and menus --------------------------------------- */

  client.on(Events.InteractionCreate, (interaction) => {
    void (async () => {
      try {
        if (interaction.isButton?.() || interaction.isStringSelectMenu?.()) {
          // The voting card for /kapisma is posted by THIS bot, so its clicks
          // arrive here and nowhere else. Each handler claims a component by its
          // own prefix, so the order is not load-bearing.
          if (await handleBattleInteraction(interaction, ctx)) return;
          await handleMusicInteraction(interaction, ctx);
          return;
        }
        if (!interaction.isChatInputCommand?.()) return;

        const command = commands.get(interaction.commandName);
        if (!command) {
          await replySafely(interaction, 'Bu komut bu botta yüklü değil.');
          return;
        }
        await command.execute(interaction, ctx);
      } catch (error) {
        musicLogger.error('Music interaction failed.', error);
        await replySafely(interaction, '🔇 Bu komut şu anda çalışmıyor.');
      }
    })();
  });

  client.on(Events.Error, (error) => musicLogger.error('PompMusic client error.', error));

  await client.login(settings.token);

  return {
    client,
    service,
    commands,
    ctx,
    /** Null when no usable audio backend was found at startup. */
    streamBackend,
    backendDetection: detection,
    get canStream() {
      return streamBackend !== null;
    },
    get musicChannelId() {
      return musicChannelId;
    },
    async destroy() {
      service.destroy();
      await client.destroy().catch(() => {});
    },
  };
}

/** Best-effort reply, tolerating an interaction that was already answered. */
async function replySafely(interaction, content) {
  try {
    const payload = { content, flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
    else await interaction.reply(payload);
  } catch {
    // Nothing useful left to do.
  }
}
