import { LOG_LEVEL_NAMES } from '../utils/logger.js';

/**
 * Declarative description of every environment variable the bot understands.
 *
 * Adding a variable means adding one entry here - parsing, type coercion,
 * defaulting and validation are all driven by this list. Validators return a
 * human-readable problem string, or `null` when the value is acceptable.
 *
 * Validators must NOT echo the offending value: environment files hold secrets.
 */

const SNOWFLAKE = /^\d{17,20}$/;

/** @type {ReadonlyArray<object>} */
export const ENV_SCHEMA = Object.freeze([
  {
    key: 'DISCORD_TOKEN',
    group: 'discord',
    type: 'string',
    required: true,
    secret: true,
    description: 'Discord bot token from the Developer Portal.',
    validate: (value) =>
      value.length >= 50 ? null : 'looks like a placeholder (a real bot token is much longer)',
  },
  {
    key: 'DISCORD_CLIENT_ID',
    group: 'discord',
    type: 'string',
    required: true,
    description: 'Discord application (client) ID.',
    validate: (value) => (SNOWFLAKE.test(value) ? null : 'must be a 17-20 digit Discord snowflake'),
  },
  {
    key: 'DISCORD_GUILD_ID',
    group: 'discord',
    type: 'string',
    required: false,
    description: 'Guild to register commands in. Empty means global registration.',
    validate: (value) => (SNOWFLAKE.test(value) ? null : 'must be a 17-20 digit Discord snowflake'),
  },
  {
    key: 'DISCORD_EXPECTED_GUILD_NAME',
    group: 'discord',
    type: 'string',
    required: false,
    default: 'MiningFools',
    description: 'Safety gate: the live apply aborts unless the target guild has this name.',
  },
  {
    key: 'BOT_ENV',
    group: 'runtime',
    type: 'enum',
    values: ['development', 'production'],
    default: 'development',
    description: 'Deployment environment.',
  },
  {
    key: 'LOG_LEVEL',
    group: 'runtime',
    type: 'enum',
    values: LOG_LEVEL_NAMES,
    default: 'info',
    description: 'Minimum log severity that is emitted.',
  },
  {
    key: 'DRY_RUN',
    group: 'runtime',
    type: 'boolean',
    default: 'true',
    description: 'When true, server setup is planned and logged but never written.',
  },
  {
    key: 'BOT_CONNECT',
    group: 'runtime',
    type: 'boolean',
    default: 'false',
    description: 'When true, the bot opens a gateway connection to Discord.',
  },
  {
    key: 'AI_PROVIDER',
    group: 'ai',
    type: 'enum',
    values: ['stub', 'openai', 'gemini', 'deepseek', 'glm'],
    default: 'stub',
    description: 'Which AI provider implementation to load.',
  },
  {
    key: 'AI_API_KEY',
    group: 'ai',
    type: 'string',
    required: false,
    secret: true,
    description: 'API key for the selected AI provider. Not needed for `stub`.',
  },
  {
    key: 'AI_MODEL',
    group: 'ai',
    type: 'string',
    required: false,
    default: '',
    description: 'Model identifier. Empty means "provider default".',
  },
  {
    key: 'AI_TIMEOUT_MS',
    group: 'ai',
    type: 'number',
    default: '30000',
    description: 'Per-request timeout for AI provider calls.',
    validate: (value) =>
      Number.isFinite(value) && value >= 1000 && value <= 600000
        ? null
        : 'must be a number between 1000 and 600000',
  },
  {
    key: 'AI_MAX_OUTPUT_TOKENS',
    group: 'ai',
    type: 'number',
    default: '1200',
    description: 'Upper bound on tokens the provider may generate per answer.',
    validate: (value) =>
      Number.isInteger(value) && value >= 16 && value <= 32768
        ? null
        : 'must be an integer between 16 and 32768',
  },
  {
    key: 'AI_TEMPERATURE',
    group: 'ai',
    type: 'number',
    default: '0.7',
    description: 'Sampling temperature sent to the provider (0 = deterministic).',
    validate: (value) =>
      Number.isFinite(value) && value >= 0 && value <= 2 ? null : 'must be a number between 0 and 2',
  },
  {
    key: 'AI_USER_COOLDOWN_SECONDS',
    group: 'ai',
    type: 'number',
    default: '10',
    description: 'Per-user cooldown between /ask requests. 0 disables the cooldown.',
    validate: (value) =>
      Number.isInteger(value) && value >= 0 && value <= 3600
        ? null
        : 'must be an integer between 0 and 3600',
  },
  {
    key: 'AI_HISTORY_MESSAGES',
    group: 'ai',
    type: 'number',
    default: '10',
    description: 'Recent conversation messages PompAI keeps per user and channel. 0 disables memory.',
    validate: (value) =>
      Number.isInteger(value) && value >= 0 && value <= 100
        ? null
        : 'must be an integer between 0 and 100',
  },
  {
    key: 'AI_RESPONSE_VISIBILITY',
    group: 'ai',
    type: 'enum',
    values: ['public', 'ephemeral'],
    default: 'public',
    description: 'Whether AI answers are visible to the channel. Product default is public.',
  },
  {
    key: 'AI_MAX_PROMPT_CHARS',
    group: 'ai',
    type: 'number',
    default: '6000',
    description: 'Maximum accepted /ask prompt length. Discord caps string options at 6000.',
    validate: (value) =>
      Number.isInteger(value) && value >= 1 && value <= 6000
        ? null
        : 'must be an integer between 1 and 6000',
  },
  {
    key: 'FREE_GAMES_ENABLED',
    group: 'giveaways',
    type: 'boolean',
    default: 'false',
    description: 'Run the background free-game monitor. Off by default: it makes outbound requests.',
  },
  {
    key: 'FREE_GAMES_INTERVAL_MINUTES',
    group: 'giveaways',
    type: 'number',
    default: '30',
    description: 'Minutes between free-game polls. Values below the floor are raised to it.',
    validate: (value) =>
      Number.isFinite(value) && value >= 15 && value <= 1440
        ? null
        : 'must be a number between 15 and 1440 (never poll faster than every 15 minutes)',
  },
  {
    key: 'FREE_GAMES_TIMEOUT_MS',
    group: 'giveaways',
    type: 'number',
    default: '15000',
    description: 'Per-request timeout for free-game sources.',
    validate: (value) =>
      Number.isFinite(value) && value >= 1000 && value <= 120000
        ? null
        : 'must be a number between 1000 and 120000',
  },
  {
    key: 'FREE_GAMES_RETENTION_DAYS',
    group: 'giveaways',
    type: 'number',
    default: '60',
    description: 'How long an ended giveaway is remembered, so it is never announced twice.',
    validate: (value) =>
      Number.isInteger(value) && value >= 1 && value <= 3650
        ? null
        : 'must be an integer between 1 and 3650',
  },
  {
    key: 'FREE_GAMES_STATE_FILE',
    group: 'giveaways',
    type: 'string',
    required: false,
    default: '',
    description: 'Where announced giveaways are recorded. Empty uses data/giveaways.json.',
  },
  /* --- PompMusic: a separate Discord application ------------------------- */

  {
    key: 'POMPMUSIC_ENABLED',
    group: 'pompMusic',
    type: 'boolean',
    default: 'false',
    aliases: ['MUSIC_ENABLED'],
    description: 'Start the PompMusic bot. Requires its own token and the privileged Message Content intent.',
  },
  {
    key: 'POMPMUSIC_TOKEN',
    group: 'pompMusic',
    type: 'string',
    required: false,
    secret: true,
    description: 'PompMusic bot token. Deliberately NOT DISCORD_TOKEN: the two are separate applications.',
    validate: (value) =>
      value.length >= 50 ? null : 'looks like a placeholder (a real bot token is much longer)',
  },
  {
    key: 'POMPMUSIC_CLIENT_ID',
    group: 'pompMusic',
    type: 'string',
    required: false,
    description: 'PompMusic application id. Music commands are registered against this, never PompAI.',
    validate: (value) =>
      /^\d{17,20}$/.test(value) ? null : 'must be a 17-20 digit Discord snowflake',
  },
  {
    key: 'POMPMUSIC_TEXT_CHANNEL',
    group: 'pompMusic',
    type: 'string',
    default: 'muzik-istek',
    aliases: ['MUSIC_TEXT_CHANNEL'],
    description: 'The only channel where a plain song name starts playback.',
  },
  {
    key: 'POMPMUSIC_VOICE_CHANNEL',
    group: 'pompMusic',
    type: 'string',
    default: 'Müzik Odası',
    aliases: ['MUSIC_VOICE_CHANNEL'],
    description: 'Voice channel the blueprint creates for music.',
  },
  {
    key: 'POMPMUSIC_STAY_CONNECTED',
    group: 'pompMusic',
    type: 'boolean',
    default: 'true',
    description: 'Keep PompMusic in voice when the queue empties. It waits for the next request instead.',
  },
  {
    key: 'POMPMUSIC_REQUEST_COOLDOWN_SECONDS',
    group: 'pompMusic',
    type: 'number',
    default: '3',
    aliases: ['MUSIC_REQUEST_COOLDOWN_SECONDS'],
    description: 'Window in which the same user repeating the same song is ignored.',
    validate: (value) =>
      Number.isFinite(value) && value >= 0 && value <= 300 ? null : 'must be a number between 0 and 300',
  },
  {
    key: 'POMPMUSIC_MAX_QUEUE_SIZE',
    group: 'pompMusic',
    type: 'number',
    default: '50',
    aliases: ['MUSIC_MAX_QUEUE_SIZE'],
    description: 'Maximum number of tracks waiting in a guild queue.',
    validate: (value) =>
      Number.isInteger(value) && value >= 1 && value <= 500 ? null : 'must be an integer between 1 and 500',
  },
  {
    key: 'POMPMUSIC_MAX_TRACK_MINUTES',
    group: 'pompMusic',
    type: 'number',
    default: '20',
    aliases: ['MUSIC_MAX_TRACK_MINUTES'],
    description: 'Longest accepted track, in minutes.',
    validate: (value) =>
      Number.isFinite(value) && value >= 1 && value <= 600 ? null : 'must be a number between 1 and 600',
  },
  {
    key: 'POMPMUSIC_IDLE_DISCONNECT_SECONDS',
    group: 'pompMusic',
    type: 'number',
    default: '120',
    aliases: ['MUSIC_IDLE_DISCONNECT_SECONDS'],
    description: 'Only used when POMPMUSIC_STAY_CONNECTED=false. 0 disables the idle disconnect entirely.',
    validate: (value) =>
      Number.isFinite(value) && value >= 0 && value <= 3600 ? null : 'must be a number between 0 and 3600',
  },
  {
    key: 'POMPMUSIC_SELECTION_TIMEOUT_SECONDS',
    group: 'pompMusic',
    type: 'number',
    default: '60',
    aliases: ['MUSIC_SELECTION_TIMEOUT_SECONDS'],
    description: 'How long a disambiguation menu stays usable before the search expires.',
    validate: (value) =>
      Number.isFinite(value) && value >= 5 && value <= 900 ? null : 'must be a number between 5 and 900',
  },
  {
    key: 'POMPMUSIC_STREAM_BACKEND',
    group: 'pompMusic',
    type: 'enum',
    values: ['ytdlp', 'none'],
    default: 'ytdlp',
    description: 'Audio extraction backend. play-dl is no longer used for extraction.',
  },
  {
    key: 'YTDLP_PATH',
    group: 'pompMusic',
    type: 'string',
    required: false,
    default: '',
    description: 'Explicit yt-dlp executable. Empty searches yt-dlp then yt-dlp.exe on PATH.',
  },
  {
    key: 'POMPMUSIC_YTDLP_FORMAT',
    group: 'pompMusic',
    type: 'string',
    default: 'bestaudio[acodec=opus]',
    description: 'yt-dlp format selector. Opus is chosen so Discord can play it without transcoding.',
  },
  {
    key: 'POMPMUSIC_YTDLP_STARTUP_TIMEOUT_MS',
    group: 'pompMusic',
    type: 'number',
    default: '20000',
    description: 'How long yt-dlp has to spawn before the track is abandoned.',
    validate: (value) =>
      Number.isFinite(value) && value >= 1000 && value <= 120000 ? null : 'must be a number between 1000 and 120000',
  },
  {
    key: 'POMPMUSIC_SEARCH_RESULTS',
    group: 'pompMusic',
    type: 'number',
    default: '5',
    aliases: ['MUSIC_SEARCH_RESULTS'],
    description: 'How many ranked results are considered, and offered when ambiguous.',
    validate: (value) =>
      Number.isInteger(value) && value >= 1 && value <= 25 ? null : 'must be an integer between 1 and 25',
  },
  /* --- Deployment --------------------------------------------------------- */

  {
    key: 'DEPLOY_PLATFORM',
    group: 'runtime',
    type: 'enum',
    values: ['auto', 'render', 'local'],
    default: 'auto',
    description: 'Forces the platform detection. `auto` reads Render\'s own RENDER marker.',
  },
  {
    key: 'PERSISTENT_STORAGE_PATH',
    group: 'runtime',
    type: 'string',
    required: false,
    default: '',
    description: 'Mount point of a persistent disk. State files under it are not treated as ephemeral.',
  },

  /* --- Fun and community ------------------------------------------------- */

  {
    key: 'FUN_MINE_COOLDOWN_SECONDS',
    group: 'fun',
    type: 'number',
    default: '300',
    description: 'Wait between /kaz attempts. 0 disables the cooldown (testing only).',
    validate: (value) =>
      Number.isFinite(value) && value >= 0 && value <= 86400 ? null : 'must be a number between 0 and 86400',
  },
  {
    key: 'FUN_DAILY_COOLDOWN_HOURS',
    group: 'fun',
    type: 'number',
    default: '20',
    description: 'Rolling window between /gunluk claims. 20h means "once a day" without a calendar or a timezone.',
    validate: (value) =>
      Number.isFinite(value) && value >= 1 && value <= 168 ? null : 'must be a number between 1 and 168',
  },
  {
    key: 'FUN_MESSAGE_XP_ENABLED',
    group: 'fun',
    type: 'boolean',
    default: 'true',
    description: 'Award a little XP for chatting. Needs GuildMessages only - never Message Content.',
  },
  {
    key: 'FUN_MESSAGE_XP_COOLDOWN_SECONDS',
    group: 'fun',
    type: 'number',
    default: '60',
    description: 'How often one user may earn message XP. Inside the window a message costs no database write.',
    validate: (value) =>
      Number.isFinite(value) && value >= 5 && value <= 3600 ? null : 'must be a number between 5 and 3600',
  },
  {
    key: 'FUN_PARTY_TIMEOUT_MINUTES',
    group: 'fun',
    type: 'number',
    default: '30',
    description: 'How long an idle /parti round stays alive before it is dropped.',
    validate: (value) =>
      Number.isFinite(value) && value >= 1 && value <= 1440 ? null : 'must be a number between 1 and 1440',
  },
  {
    key: 'FUN_DB_FILE',
    group: 'fun',
    type: 'string',
    required: false,
    default: '',
    description: 'Where the fun economy is stored. Empty uses data/pomp-fun.sqlite.',
  },
  {
    key: 'POMPMUSIC_BATTLE_SECONDS',
    group: 'pompMusic',
    type: 'number',
    default: '60',
    description: 'How long a /kapisma vote stays open.',
    validate: (value) =>
      Number.isFinite(value) && value >= 10 && value <= 600 ? null : 'must be a number between 10 and 600',
  },
  {
    key: 'STEAM_GIVEAWAY_SOURCE',
    group: 'giveaways',
    type: 'enum',
    values: ['itad', 'steamdb', 'none'],
    default: 'itad',
    description: 'How Steam giveaways are discovered. `steamdb` is opt-in only; it is blocked by Cloudflare.',
  },
  {
    key: 'ITAD_API_KEY',
    group: 'giveaways',
    type: 'string',
    required: false,
    secret: true,
    description: 'IsThereAnyDeal API key. Required when STEAM_GIVEAWAY_SOURCE=itad. Never logged.',
  },
  {
    key: 'FREE_GAMES_USER_AGENT',
    group: 'giveaways',
    type: 'string',
    required: false,
    default: '',
    description: 'User-Agent sent to store sources. Empty uses the built-in descriptive default.',
  },
  {
    key: 'FREE_GAMES_CHANNEL',
    group: 'giveaways',
    type: 'string',
    default: 'bedava-oyunlar',
    description: 'Channel that receives giveaway announcements.',
  },
]);

/** Groups whose required fields are skipped when `requireDiscord` is false. */
export const DISCORD_GROUP = 'discord';
