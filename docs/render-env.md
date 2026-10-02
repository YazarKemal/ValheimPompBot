# Render environment variables

**Variable names only. No values, ever.** The real values live in the Render
dashboard (or in a local `.env`, which is git-ignored). `render.yaml` carries
the non-secret defaults and marks every credential `sync: false`, which is how
Render knows to prompt for it rather than read it from the repository.

Defaults are shown for orientation only; the authoritative list is
`src/config/schema.js`, and `.env.example` is the annotated local copy.

## Discord / PompAI

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `DISCORD_TOKEN` | **yes — secret** | — | PompAI's bot token. |
| `DISCORD_CLIENT_ID` | **yes** | — | PompAI application id. |
| `DISCORD_GUILD_ID` | **yes on Render** | — | Commands are guild-scoped; empty means global registration, which this project does not support. |
| `DISCORD_EXPECTED_GUILD_NAME` | no | `MiningFools` | Safety gate for the live apply. |

## PompMusic

A **separate Discord application**. Never reuse PompAI's credentials.

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `POMPMUSIC_ENABLED` | yes on Render | `false` | Set to `true` in `render.yaml`. |
| `POMPMUSIC_TOKEN` | **yes — secret** | — | PompMusic's own token. |
| `POMPMUSIC_CLIENT_ID` | **yes** | — | PompMusic application id. |
| `POMPMUSIC_TEXT_CHANNEL` | no | `muzik-istek` | The only channel where a song name starts playback. |
| `POMPMUSIC_VOICE_CHANNEL` | no | `Müzik Odası` | |
| `POMPMUSIC_STAY_CONNECTED` | no | `true` | |
| `POMPMUSIC_STREAM_BACKEND` | no | `ytdlp` | Pinned to `ytdlp` in `render.yaml`; `none` disables playback. |
| `YTDLP_PATH` | no | empty | Empty finds `yt-dlp` on `PATH`, which is where the image puts it. |
| `POMPMUSIC_YTDLP_FORMAT` | no | `bestaudio[acodec=opus]` | Must stay Opus. |
| `POMPMUSIC_YTDLP_STARTUP_TIMEOUT_MS` | no | `20000` | Raise it if the container is slow to start a stream. |
| `POMPMUSIC_YTDLP_FIRST_BYTE_TIMEOUT_MS` | no | `15000` | How long yt-dlp has to produce audio. Silence past this is a failed track, not a playing one. |
| `POMPMUSIC_YTDLP_MAX_ATTEMPTS` | no | `2` | Attempts per track. Only failures before the first audio byte are retried. |
| `POMPMUSIC_YTDLP_RETRY_DELAY_MS` | no | `500` | Pause between those attempts. |
| `POMPMUSIC_MAX_QUEUE_SIZE` | no | `50` | |
| `POMPMUSIC_MAX_TRACK_MINUTES` | no | `20` | |
| `POMPMUSIC_REQUEST_COOLDOWN_SECONDS` | no | `3` | |
| `POMPMUSIC_IDLE_DISCONNECT_SECONDS` | no | `120` | Only used when stay-connected is false. |
| `POMPMUSIC_SELECTION_TIMEOUT_SECONDS` | no | `60` | |
| `POMPMUSIC_SEARCH_RESULTS` | no | `5` | |
| `POMPMUSIC_BATTLE_SECONDS` | no | `60` | How long a `/kapisma` vote stays open. |

## DeepSeek (AI)

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `AI_PROVIDER` | no | `stub` | `deepseek` enables real answers. `stub` is offline and free. |
| `AI_API_KEY` | **yes for deepseek — secret** | — | |
| `AI_MODEL` | yes for deepseek | — | For example `deepseek-flash`. No fallback model. |
| `AI_TIMEOUT_MS` | no | `30000` | |
| `AI_MAX_OUTPUT_TOKENS` | no | `1200` | |
| `AI_TEMPERATURE` | no | `0.7` | |
| `AI_USER_COOLDOWN_SECONDS` | no | `10` | |
| `AI_HISTORY_MESSAGES` | no | `10` | RAM-only conversation memory. |
| `AI_RESPONSE_VISIBILITY` | no | `public` | |
| `AI_MAX_PROMPT_CHARS` | no | `6000` | |

## ITAD / giveaways

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `FREE_GAMES_ENABLED` | no | `false` | Enabling starts outbound requests. |
| `FREE_GAMES_INTERVAL_MINUTES` | no | `30` | Floor of 15. |
| `FREE_GAMES_TIMEOUT_MS` | no | `15000` | |
| `FREE_GAMES_RETENTION_DAYS` | no | `60` | |
| `FREE_GAMES_STATE_FILE` | no | empty | Empty uses `data/giveaways.json`. **Ephemeral on Render.** |
| `STEAM_GIVEAWAY_SOURCE` | no | `itad` | |
| `ITAD_API_KEY` | yes for itad — **secret** | — | Never logged. Without it, Steam discovery is skipped. |
| `FREE_GAMES_USER_AGENT` | no | empty | |
| `FREE_GAMES_CHANNEL` | no | `bedava-oyunlar` | |

## Fun system

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `FUN_MINE_COOLDOWN_SECONDS` | no | `300` | |
| `FUN_DAILY_COOLDOWN_HOURS` | no | `20` | |
| `FUN_MESSAGE_XP_ENABLED` | no | `true` | Needs `GuildMessages` only, never Message Content. |
| `FUN_MESSAGE_XP_COOLDOWN_SECONDS` | no | `60` | |
| `FUN_PARTY_TIMEOUT_MINUTES` | no | `30` | |
| `FUN_DB_FILE` | no | empty | Empty uses `data/pomp-fun.sqlite`. **Ephemeral on Render.** |

## Deployment

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `PORT` | no | `10000` | Injected by Render. The health endpoint binds it on `0.0.0.0`. |
| `DEPLOY_PLATFORM` | no | `auto` | `auto` reads Render's own `RENDER` marker. Set in `render.yaml`. |
| `PERSISTENT_STORAGE_PATH` | no | empty | Mount point of a Render disk. State files under it are not warned about. |
| `BOT_CONNECT` | yes on Render | `false` | Must be `true` or the process configures itself and exits. |
| `DRY_RUN` | no | `true` | Leave `true`; server structure is applied by hand. |
| `LOG_LEVEL` | no | `info` | |
| `BOT_ENV` | no | `development` | |

Render also sets `RENDER`, `RENDER_SERVICE_ID`, `RENDER_EXTERNAL_HOSTNAME` and
friends itself. These are read for platform detection and never logged.

## Persisting state

Render's free filesystem is **ephemeral**: everything the process writes is lost
when the container is replaced, which happens on every deploy and on every
restart. Two files are affected — `data/pomp-fun.sqlite` (XP, coins, inventory,
daily streaks) and `data/giveaways.json` (which giveaways were announced).

The process says so at startup:

```
WARN Render ephemeral filesystem detected: fun economy (SQLite) (data/pomp-fun.sqlite)
and giveaway state (JSON) (data/giveaways.json) may be lost on restart.
```

To make them durable, attach a Render disk and point the files at it:

1. Add a disk to the service, mounted at, say, `/var/data`.
2. Set `PERSISTENT_STORAGE_PATH=/var/data`.
3. Set `FUN_DB_FILE=/var/data/pomp-fun.sqlite`.
4. Set `FREE_GAMES_STATE_FILE=/var/data/giveaways.json`.

With every state file under the mount point the warning is replaced by
`Runtime state is on the persistent disk.` A disk requires a paid instance type
on Render; on the free plan the state is expected to reset and the warning is
the honest answer rather than a bug.
