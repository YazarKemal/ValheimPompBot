# ValheimPompBot

Discord bot foundation for the Valheim Pomp server.

**Phase 1 status: local foundation only.** The bot validates its configuration, loads
its modules and builds a server-setup plan - but it does **not** connect to Discord,
does **not** modify any server, and makes **no** paid AI calls.

---

## Requirements

- Node.js 20.11 or newer (developed against Node 24)
- npm 10 or newer

## Quick start

```bash
npm install
cp .env.example .env     # PowerShell: Copy-Item .env.example .env
npm run check            # offline validation, no Discord connection
npm test                 # run the test suite
npm start                # preflight only while BOT_CONNECT=false
```

`npm start` with the default `.env.example` values prints a preflight summary and exits
`0` without opening a gateway connection. That is the intended Phase 1 behaviour.

If required variables are missing, startup fails immediately with a readable list:

```
ConfigError [CONFIG_INVALID]: Configuration is invalid - 2 problem(s) found.
  - fields: DISCORD_TOKEN (is required but was not set), DISCORD_CLIENT_ID (is required but was not set)
```

Secret values are never printed - not in messages, not in logs, not in error details.

## Scripts

| Script | What it does |
| --- | --- |
| `npm start` | Boot the bot. Preflight only unless `BOT_CONNECT=true`. |
| `npm run dev` | Same, with `node --watch` for auto-restart. |
| `npm test` | Unit tests via Node's built-in test runner. No network. |
| `npm run check` | Offline validation: syntax, config, module loading, blueprints, AI wiring. |
| `npm run snapshot` | **Read-only.** Capture the live server state to JSON. |
| `npm run deploy:commands` | Register PompAI's slash commands with one guild. |
| `npm run setup:plan` | Print the setup plan. Add `--from-json <snapshot>` for a real diff. |
| `npm run setup:apply` | **Live apply.** Needs `DRY_RUN=false` **and** `--confirm`. |

## Architecture

```
src/
  index.js          Bot bootstrap: preflight, then (optionally) connect.
  config/
    schema.js       One declarative entry per environment variable.
    index.js        Parsing, coercion, validation, redacted config summary.
  commands/
    index.js        Slash command loader + validation.
    ping.js  help.js  ask.js
  events/
    index.js        Event loader + binder (injects a shared ctx object).
    ready.js  interactionCreate.js  error.js
  setup/
    constants.js    Blueprint primitives (EVERYONE, version, default name).
    blueprint.js    Validation + re-export of the blueprint registry.
    blueprints/     Server layouts: miningfools.js (default), valheim.js, index.js.
    snapshot.js     Read-only observation of a live guild, behind a write guard.
    snapshot-cli.js `npm run snapshot`.
    permissions.js  Expands readOnly/overwrites into concrete rules.
    state.js        Reads a live guild into a plain snapshot.
    planner.js      Pure diff: (blueprint, snapshot) -> actions.
    apply.js        Executes a plan. Dry-run by default.
    adapter.js      The only place that calls discord.js mutating APIs.
    render.js       Human-readable plan preview.
    cli.js          Offline plan preview.
    platform.js     Render detection + the runtime state inventory.
  ai/
    provider.js     AIProvider interface + request/response contracts.
    registry.js     Name -> factory registry.
    index.js        createAIClient(): the facade commands depend on.
    providers/      stub (offline) and deepseek (real); openai/gemini/glm placeholders.
  health/
    server.js       The HTTP health endpoint. Binds before Discord does.
  fun/
    db.js           node:sqlite open, versioned additive migrations, transactions.
    repository.js   Every SQL statement; all of it guild + user scoped.
    mining.js       /kaz rules: cooldown, draw, one atomic reward.
    daily.js        /gunluk rules: rolling window, streak.
    levels.js       XP curve, titles, number formatting (pure).
    loot.js         The weighted table, its validator and the item registry.
    profile.js      Profile and leaderboard reads.
    party.js        RAM party rounds, keyed guild + channel.
    passive-xp.js   Activity XP. Never reads message content.
    content/        Curated Turkish banks (party, nicknames, fortunes).
  utils/
    logger.js  redact.js  errors.js
tests/
  helpers/          Fake guild adapter and fake interactions.
  *.test.js
```

### Design rules

- **ESM everywhere.** `"type": "module"`, no CommonJS.
- **No singletons in commands.** Handlers receive a `ctx` object
  (`{ config, logger, commands, events, ai }`) instead of importing application state.
- **The planner is pure.** It imports nothing from discord.js, so the whole
  reconciliation policy is testable in milliseconds.
- **One network boundary per concern.** discord.js calls live in `setup/adapter.js`;
  AI vendor HTTP calls live only in `ai/providers/*` (today: `deepseek.js`).

## Environment variables

See `.env.example` for the annotated list. Summary:

| Variable | Default | Notes |
| --- | --- | --- |
| `DISCORD_TOKEN` | - | Required. Never logged or printed. |
| `DISCORD_CLIENT_ID` | - | Required. Application ID. |
| `DISCORD_GUILD_ID` | empty | Empty means global command registration. |
| `BOT_ENV` | `development` | `development` \| `production` |
| `LOG_LEVEL` | `info` | `error` \| `warn` \| `info` \| `debug` |
| `DRY_RUN` | `true` | Setup is planned but never written. |
| `BOT_CONNECT` | `false` | **Phase 1: keep false.** |
| `AI_PROVIDER` | `stub` | `stub` \| `openai` \| `gemini` \| `deepseek` \| `glm` |
| `AI_API_KEY` | empty | Not needed for `stub`. Never logged or printed. |
| `AI_MODEL` | empty | Required for `deepseek` (for example `deepseek-flash`). No fallback model. |
| `AI_TIMEOUT_MS` | `30000` | 1000-600000. Enforced with `AbortController`. |
| `AI_MAX_OUTPUT_TOKENS` | `1200` | 16-32768. Sent as `max_tokens`. |
| `AI_TEMPERATURE` | `0.7` | 0-2. |
| `AI_USER_COOLDOWN_SECONDS` | `10` | 0-3600. Per-user wait between `/ask` requests. |
| `AI_MAX_PROMPT_CHARS` | `6000` | 1-6000. Discord's string-option cap is 6000. |
| `FUN_MINE_COOLDOWN_SECONDS` | `300` | 0-86400. Wait between `/kaz` digs. |
| `FUN_DAILY_COOLDOWN_HOURS` | `20` | 1-168. Rolling window between `/gunluk` claims. |
| `FUN_MESSAGE_XP_ENABLED` | `true` | Needs `GuildMessages` only, never Message Content. |
| `FUN_MESSAGE_XP_COOLDOWN_SECONDS` | `60` | 5-3600. Inside the window, no database write. |
| `FUN_PARTY_TIMEOUT_MINUTES` | `30` | 1-1440. Idle `/parti` rounds are dropped. |
| `FUN_DB_FILE` | empty | Empty uses `data/pomp-fun.sqlite`. |
| `POMPMUSIC_BATTLE_SECONDS` | `60` | 10-600. How long a `/kapisma` vote stays open. |
| `PORT` | `10000` | Injected by Render. The health endpoint binds it on `0.0.0.0`. |
| `DEPLOY_PLATFORM` | `auto` | `auto` reads Render's own `RENDER` marker. |
| `PERSISTENT_STORAGE_PATH` | empty | Mount point of a disk; state under it is not ephemeral. |

## Server setup

The setup module reconciles a guild towards `src/setup/blueprint.js`.

Two blueprints ship today: `miningfools` (default) and `valheim`.

Preview the plan offline - no token, no connection:

```bash
npm run setup:plan
npm run setup:plan -- --blueprint valheim
npm run setup:plan -- --json
```

To diff against your real server, capture it first:

```bash
npm run snapshot                                   # read-only, writes snapshots/<id>.json
npm run setup:plan -- --from-json snapshots/<id>.json
```

`npm run snapshot` issues **GET requests only**. It wraps the guild and its
managers in a guard that throws `SNAPSHOT_READ_ONLY_VIOLATION` if any mutating
method is reached, and `npm run check` statically asserts the module contains no
mutating call. The output lands in `snapshots/`, which is git-ignored.

### Safety guarantees

These are enforced in code and asserted by tests:

1. **Nothing is ever deleted.** The planner has no delete action kind, and
   `applyPlan` refuses any plan containing one. Roles, channels and categories that
   exist but are not in the blueprint are reported as `keep` and left alone.
2. **Role permissions are additive.** A role never loses a permission it already
   holds; extra permissions are reported as drift instead of being stripped.
   Channel overwrites are set exactly for the roles the blueprint names (so a
   revoked permission stays revoked and setup converges), but an overwrite
   belonging to a role the blueprint does not mention is never rewritten.
3. **`DRY_RUN=true` writes nothing.** The apply path also defaults to dry-run when
   called without an explicit flag.
4. **Type conflicts are surfaced, not resolved.** If a channel exists with the right
   name but the wrong type, the planner emits a `WARN` and changes nothing, because
   converting it would require deleting it.
5. **Setup is idempotent.** Applying the plan and re-planning yields zero work; the
   test suite asserts this over three consecutive passes.

### Live apply

```bash
npm run setup:apply -- --confirm
```

Two independent opt-ins are required: `DRY_RUN=false` in `.env` **and** the
`--confirm` flag. Both are checked before the bot even connects, so a mistaken
invocation never opens a gateway connection.

The pipeline runs these gates in order, aborting before anything is written:

| # | Gate | Requirement |
|---|---|---|
| 1 | Confirmation | `--confirm` was passed |
| 2 | Dry run | `DRY_RUN` is `false` |
| 3 | Identity | `guild.id === DISCORD_GUILD_ID` **and** the name matches `DISCORD_EXPECTED_GUILD_NAME` |
| 4 | Fresh state | a **new** snapshot is taken now; the reviewed plan is never replayed |
| 5 | Plan safety | no deletes, no role mutations, no protected resource, no privileged permission, no unknown action |
| 6 | Preview | the final plan is printed immediately before mutating |

Then operations run **sequentially and fail-fast**: the first failure stops the run
and the outcome report lists exactly what landed and what did not. Nothing is rolled
back - setup is idempotent, so fixing the cause and re-running skips completed work.

Afterwards a second read-only snapshot verifies convergence: a fresh plan must
contain **zero** mutations. KEEP notes are allowed and expected.

Protected resources (`Genel` voice, `Metin Kanalları`, `Ses Kanalları`) are asserted
untouched by the safety gate, not merely omitted from the blueprint.

## PompAI commands

| Command | What it does |
| --- | --- |
| `/help` | Embed listing every command. |
| `/ping` | Round-trip and gateway latency. Ephemeral. |
| `/status` | Online status, uptime, Node version, AI provider, model and whether a live AI is configured. Ephemeral, secret-free. |
| `/ask` | Sends a prompt through the AI layer. Validates the prompt length, enforces a per-user cooldown and one in-flight request per user, then answers. **Always public**; long answers are split across follow-ups that inherit the same visibility. |
| `/clear` | Forgets your PompAI history in the current channel. Ephemeral. |
| `/ucretsiz` | Lists active Steam + Epic giveaways right now. Public in the giveaway channel, private elsewhere. |
| `/oyun` | Ask about any game. **Always public.** |
| `/oyun-temizle` | Forgets your history for one game. Ephemeral. |
| `/kaz` | Dig the mine. Cooldown-gated. **Always public.** |
| `/gunluk` | Open the daily chest and keep the streak alive. Public. |
| `/envanter` | Your ore, rarest first. Public. |
| `/profil [kullanici]` | Level, title, XP, coins and mining stats. Public. |
| `/liderlik` | Top 10 of **this guild only**. Public. |
| `/parti tur:<type>` | Truth, dare or "who's most likely to". Public, with buttons. |
| `/lakap [kullanici]` | A random mining nickname. Public. |
| `/fal` | A joke fortune. Public. |

`/ping`, `/status` and `/help` reply ephemerally, so a shared channel is not
filled with diagnostics. `/ask` is ephemeral too, since a prompt may be private.
Refusals in the fun layer (a cooldown, an unknown party type) are ephemeral as
well — they are about one person — while every *result* is public, because the
games are the point of a shared server.

### Visibility

**AI answers are public.** `/ask` and `/oyun` reply openly in every channel, and
every chunk of a long answer is public too. One shared policy
(`src/ai/visibility.js`) decides this, so a new AI command inherits the rule
rather than copying it; `AI_RESPONSE_VISIBILITY=ephemeral` restores private
replies without touching any command. An unrecognised value falls back to
**public**, so a typo cannot silently hide answers.

Visibility is fixed when the interaction is acknowledged and cannot change
afterwards, so a command picks its policy once, before `deferReply`.

**Public output is not shared memory.** Replies are visible to the channel; the
conversation behind them is not. `/ask` memory stays scoped to guild + channel +
user and `/oyun` to user + game, exactly as before — a public answer is still
built only from the asker's own history.

Pre-flight notices (cooldown, over-length prompt, request already in flight) stay
ephemeral: they are personal feedback about a request that was never sent, not an
answer. An AI *failure* is public, because it replaces a public answer.

### Context and memory

Every request sends a system prompt built from `src/ai/miningfools.js` — the
project brief (Unity, the core loop, the important systems) plus a focus hint for
the current channel from `src/ai/channel-context.js`. The prompt instructs the
model **not to invent project facts** and to say so when the context does not
cover something. The prompt contains no configuration and no credentials.

Conversation memory is **RAM only**:

- keyed by guild + channel + user, so nothing crosses between them;
- bounded per conversation (`AI_HISTORY_MESSAGES`, default 10) and in total
  (500 conversations, oldest evicted);
- stores only turns that passed through PompAI — Discord history is never read;
- a failed turn is not stored;
- **a restart starts empty.** That is the design, not a gap.

`/clear` forgets the caller's history in the current channel only. It cannot
reach another user's history or this user's history elsewhere.

### Registering

```bash
npm run deploy:commands             # register
npm run deploy:commands -- --dry-run
```

Registration is **guild-scoped only** - `DISCORD_GUILD_ID` is required and global
registration is deliberately unsupported. The deploy reads the current command
list first and **aborts if any registered command would be dropped**, rather than
letting Discord's bulk-overwrite silently remove it; `--allow-removals` overrides.

Discord decorates commands it returns with server-assigned fields and strips
defaults (a guild command comes back without `dm_permission: false` and without an
empty `options`). The diff projects onto the fields we manage, so a converged
deploy reports `unchanged` and performs no write.

## PompMusic

**PompMusic is a second Discord bot**, not a feature of PompAI. Two identities,
two tokens, two command registrations, two gateway connections.

| | PompAI | PompMusic |
| --- | --- | --- |
| Owns | `/ask`, `/oyun`, giveaways, project context | voice, search, queue, controls |
| Token | `DISCORD_TOKEN` | `POMPMUSIC_TOKEN` |
| Intents | `Guilds` | `Guilds`, `GuildVoiceStates`, `GuildMessages`, **`MessageContent`** |
| Commands | registered to `DISCORD_CLIENT_ID` | registered to `POMPMUSIC_CLIENT_ID` |

Neither owns the other's commands — `npm run check` asserts the sets are
disjoint, and that PompAI does **not** request the privileged Message Content
intent.

### Summon once, then it stays

```
/gel          # PompMusic joins your voice channel
```

Then type song names in **#muzik-istek**:

```
Müslüm Gürses Affet
```

No prefix, no `/play`, no URL. **A song request never summons the bot** — if it
is not connected, the channel is told to run `/gel`. Once summoned it stays: the
queue emptying, a track finishing and long silences are not reasons to leave.
`POMPMUSIC_STAY_CONNECTED=true` is the default; setting it false restores the
idle disconnect.

`/git` (or `/durdur-ve-git`) stops playback, clears the queue and disconnects.

`/gel` will not hijack a channel people are listening in. Moving PompMusic
requires either Manage Channels or an empty current channel; otherwise it names
the channel it is in. Only members **inside** the active voice channel may add
songs.

**The channel rule is strict.** Only `#muzik-istek` (configurable via
`POMPMUSIC_TEXT_CHANNEL`) interprets text as a song name. A message anywhere
else — `#genel`, `#maden`, `#kod`, `#pompai` — is dropped before anything looks
at it.

**Music never touches the AI layer.** A song name is a search query, not a
prompt. `npm run check` asserts no file under `src/music/` imports the AI layer
or calls a model, and that a music failure cannot reach the process crash
handler.

### Setup

```bash
POMPMUSIC_ENABLED=true
POMPMUSIC_TOKEN=...        # from the PompMusic application
POMPMUSIC_CLIENT_ID=...
```

Create a **second Discord application** for PompMusic and enable the
**Message Content** privileged intent on *that* application (PompAI no longer
needs it). Without it PompMusic's login is refused.

Existing `MUSIC_*` variables still work as aliases for the `POMPMUSIC_*` names
and are reported at startup so they can be renamed.

### Behaviour

The requester must be in a voice channel (`🎧 Önce bir ses kanalına katıl.`).
The bot joins *their* channel; if something is already playing the track is
queued. An active session stays in its own channel — a request from a different
room is refused rather than obeyed, so the bot never hops between channels.

When the queue empties the bot waits `MUSIC_IDLE_DISCONNECT_SECONDS` and then
leaves on its own.

### Search

Results are re-ranked locally, not taken in the provider's order. The scorer
prefers title/artist matches and official `- Topic` channels, and penalises
reactions, interviews, shorts, trailers, ten-hour loops and compilations, plus
durations under 30 s or over an hour.

**When the top result is not clearly ahead of the runner-up, PompAI shows a
selection menu instead of guessing** — playing the wrong song in a shared channel
is worse than one extra click. The candidates are held in a bounded RAM cache
keyed on **guild + channel + the id of the message that asked**, so one guild's
menu can never be used from another. Only the person who asked may choose from
it; a bystander gets an ephemeral refusal and does not consume the entry. The
chosen track comes from the cached list, never a second search, and the menu is
removed from the message once a choice is made. Entries expire after
`MUSIC_SELECTION_TIMEOUT_SECONDS` (60), are dropped when the voice session ends,
and are capped in number so a busy channel cannot grow the process.

A valid choice is **acknowledged with `deferUpdate` before any playback work**,
and the outcome is posted with `followUp`. That is not politeness: opening a
stream waits for yt-dlp's first audio byte (plus a bounded retry, plus the
player reaching Playing), and Discord drops an interaction that goes
unacknowledged for three seconds. The cache entry is still consumed before the
first `await`, so a double click cannot enqueue twice.

### Audio: yt-dlp, not play-dl

Search still uses play-dl. **Extraction does not** — play-dl 1.9.7 reads the
media URL out of YouTube's player response, and that format changed under it, so
every stream failed with `Invalid URL`. Audio now comes from **yt-dlp**:

```
track url -> spawn yt-dlp -> first audio byte -> stdout -> @discordjs/voice -> Playing
```

**A spawned process is not a playing track.** yt-dlp starts happily and then
finds out whether YouTube will actually serve it anything — which, from a
datacenter address, it may refuse to do. So playback is gated twice:

1. **yt-dlp must write a byte.** `openStream` resolves on the first byte of
   audio on stdout, never on spawn. A process that exits first, errors, or stays
   silent past `POMPMUSIC_YTDLP_FIRST_BYTE_TIMEOUT_MS` is a **failed track**:
   the process is killed and the track is skipped.
2. **The player must reach `Playing`.** Discord's player sits in `Buffering`
   until the WebM demuxer has a header and one Opus packet. Only then is the
   track announced — so the now-playing card cannot appear while the channel is
   silent.

Both stages are logged (`yt-dlp spawned`, `first audio byte`, `yt-dlp exited`,
and every `Audio player state changed` / `Voice connection state changed`), so a
track that produces no sound says where it stopped.

**Retries are bounded.** A failure *before* the first byte is retried up to
`POMPMUSIC_YTDLP_MAX_ATTEMPTS` times; a failure *after* it never is, because
restarting a track underneath its listeners is worse than letting it end.

**Install it yourself; nothing is downloaded automatically.**

```bash
winget install yt-dlp.yt-dlp     # Windows
brew install yt-dlp              # macOS
pipx install yt-dlp              # Linux
```

PompMusic probes for it once at startup, trying `YTDLP_PATH`, then `yt-dlp`,
then `yt-dlp.exe` on `PATH` — each by actually running `--version`, so a broken
shim is not mistaken for a working install. If none is found the bot still
starts and says so plainly; **only playback is unavailable.** There is no silent
fallback to the extractor that is known to be broken.

| Setting | Default | Purpose |
| --- | --- | --- |
| `POMPMUSIC_STREAM_BACKEND` | `ytdlp` | `none` disables playback entirely |
| `YTDLP_PATH` | *(empty)* | Explicit executable; empty means search `PATH` |
| `POMPMUSIC_YTDLP_FORMAT` | `bestaudio[acodec=opus]` | Must stay Opus — see below |
| `POMPMUSIC_YTDLP_STARTUP_TIMEOUT_MS` | `20000` | How long a spawn may take |
| `POMPMUSIC_YTDLP_FIRST_BYTE_TIMEOUT_MS` | `15000` | How long yt-dlp has to produce audio |
| `POMPMUSIC_YTDLP_MAX_ATTEMPTS` | `2` | Attempts per track; `1` disables retrying |
| `POMPMUSIC_YTDLP_RETRY_DELAY_MS` | `500` | Pause between those attempts |

**No ffmpeg, no transcoding.** The format selector asks for Opus specifically,
which YouTube serves inside WebM; Discord decodes that as-is, so the bytes go
straight through. The looser `bestaudio` can select m4a/AAC, which would need a
transcode step and is why the selector is not `bestaudio/best`.

**Each stream owns its process.** `spawn` is called with an argument **array**
and `shell: false`, so there is no command-injection surface: the only
user-influenced value is the track URL, already validated as an https YouTube
URL, and the search text never reaches the process at all. Nothing is written to
disk (`--no-cache-dir`, output to stdout). Skip, stop, a drained queue, `/git`
and a dropped voice connection all kill the child — one guild's skip can never
reach another guild's process. A track that fails to open is skipped rather than
wedging playback.

**When extraction fails, the log says why.** yt-dlp's stderr is carried on the
error and printed by both the retry line and the final failure line, so the
reason — `HTTP Error 403`, `Sign in to confirm you're not a bot`, `Requested
format is not available` — is visible in a Render log rather than only the fact
that a track failed. It is sanitized first (`utils/redact.js`): URLs lose their
query strings, credential assignments and cookie headers are masked, labels are
kept, and the excerpt is capped at 500 characters. A media URL's signature never
reaches a log.

### Controls

Buttons under the now-playing card: ⏯ Duraklat / Devam · ⏭ Geç · ⏹ Durdur ·
🔀 Karıştır · 🔁 Tekrar. Plus `/kuyruk`, `/gec`, `/durdur`, `/duraklat`,
`/devam`, `/karistir` as secondary commands.

Every control requires the member to be in the *active* voice channel. Skip and
the cosmetic controls are open to anyone there; **stop additionally requires the
requester, Manage Channels, or a configured DJ role.**

Limits: `MUSIC_MAX_QUEUE_SIZE` (50) and `MUSIC_MAX_TRACK_MINUTES` (20), plus a
`MUSIC_REQUEST_COOLDOWN_SECONDS` (3) window that drops the same user repeating
the same song.

## Fun and community

A persistent game layer: mining, a daily chest, XP with levels and titles,
party games, nicknames and fortunes.

**It makes zero AI calls.** Every outcome comes from a table in the code, so the
whole economy runs with `AI_PROVIDER=stub` and no API key — and `npm run check`
asserts that no file under `src/fun/` can reach a provider.

### Persistence

State lives in **`data/pomp-fun.sqlite`** (git-ignored), written through
`node:sqlite`, which ships with Node 24 — no native module, no compiler on the
host, nothing to keep patched. The file is created on first run; the directory
is created if missing.

`PRAGMA user_version` tracks the schema level. **Migrations are additive**: a
migration may create a table or add a column and nothing else — no drop, no
delete, no rewrite — and a database written by a *newer* build is refused rather
than silently downgraded. Losing someone's XP to a rollback is not a failure
mode worth accepting.

Everything is keyed by **`guild_id` + `user_id`**. Both tables carry that pair
as their primary key, no accessor takes a user id on its own, and every
statement that reads or writes user state filters on the guild. A check asserts
that last part on the SQL itself, so a new query cannot quietly forget it.

Writes that belong together commit together. One dig changes XP, coins, the
inventory, two counters and a timestamp inside a single transaction, so a crash
cannot leave a cooldown taken but no reward granted — and a double-clicked
button cannot claim twice, because the second call sees the timestamp the first
one wrote.

### Mining (`/kaz`)

One weighted table (`src/fun/loot.js`) holds every outcome, its rarity and its
reward range. Weights are per mille, so they total 1000 and read as odds:

| Weight | Outcome |
| --- | --- |
| 340 | 🪨 Taş |
| 250 | ⚫ Kömür |
| 180 | 🔩 Demir |
| 100 | 🪙 Altın |
| 55 | 💚 Zümrüt |
| 26 | 💀 Göçük — no ore, no coins, a little XP |
| 25 | 💎 Elmas |
| 14 | 🦴 Fosil |
| 6 | 🐀 Mağara Faresi |
| 4 | ✨ Efsanevi Nugget |

Rare means rare: the marked outcomes together are under 5%, and the top one is
**0.4%**. `validateLootTable()` checks the table's arithmetic, and both a test
and a static check run it — a typo in a weight is otherwise a silent change to
every drop rate.

The inventory accepts **only** keys that table defines, so it cannot grow
arbitrary user-supplied entries.

### Daily chest and streaks (`/gunluk`)

A **rolling** cooldown in elapsed hours, never a calendar day: a date reset
would need a timezone, and picking one means the reset lands at an arbitrary
hour for everyone else. `FUN_DAILY_COOLDOWN_HOURS=20` allows a claim roughly
once a day without anyone having to be online at midnight.

Claim again inside the window plus a day of grace and the streak grows; leave it
longer and it starts over at one. A clock that moves *backwards* keeps the
streak — an NTP correction should not cost anyone a week.

### XP, levels and titles

The curve is `60·(n−1) + 15·(n−1)·(n−2)` XP to reach level *n*, capped at 100.
Early levels arrive quickly, later ones are a long haul. Titles are cosmetic
badges on the profile — **this phase creates no Discord roles**.

| Level | Title |
| --- | --- |
| 1 | Çaylak Madenci |
| 5 | Kazmacı |
| 10 | Usta Kazmacı |
| 20 | Maden Ustası |
| 35 | Cevher Baronu |
| 50 | Yeraltı Lordu |

**Activity XP** comes from ordinary messages, and it works **without the Message
Content intent**. Discord delivers `messageCreate` to anyone holding
`GuildMessages` — which is not privileged — and withholds only the message text,
which is exactly the part this feature does not want. `src/fun/passive-xp.js`
never reads `message.content`; a test drives it with a message whose `content`
getter throws, and a static check greps for the property. Bots and webhooks earn
nothing, one person earns at most once per `FUN_MESSAGE_XP_COOLDOWN_SECONDS`,
and a message inside that window costs **a map lookup and no database write**, so
spam cannot hammer the file.

### Party games (`/parti`)

`dogruluk`, `cesaret` and `kim-daha-olasi`, drawn from curated Turkish banks in
`src/fun/content/`. No model is involved, and the dares are all doable from a
chair in Discord — a test scans the bank for anything involving alcohol, drugs,
driving, money, private information or physical risk, and fails the build if one
appears.

Rounds are RAM-only and keyed by **guild + channel**, so the same channel name in
two servers is two different games. A round expires after
`FUN_PARTY_TIMEOUT_MINUTES` of inactivity. The buttons carry an opaque session id
and nothing else — no reward, no count, no channel — and a button left on an old
message cannot advance a round that has since been replaced.

`/lakap` and `/fal` draw from the same kind of local bank. They touch no state
at all, which is why they need no guild to run.

### Song battles (`/kapisma`) — PompMusic

Belongs to the PompMusic application, alongside the playback commands. Two song
names in, two searched titles out, and a 60-second vote:

```
🎵 ŞARKI KAPIŞMASI
🅰️ Duman — Senden Daha Güzel
🅱️ maNga — Bir Kadın Çizeceksin
[🅰️ A] [🅱️ B]
```

One vote per person, changeable until the round closes, bots refused — twice,
at the button handler *and* in the store. A draw is announced as a draw rather
than resolved by inventing a winner. Battles are keyed by guild + battle id, so
a click in one server cannot reach another's round.

**Voting only: the winner is not played.** Nothing here touches the voice
session, the queue or the stream backend, and nothing calls a model.

The card is posted by PompMusic, so its buttons arrive on PompMusic's gateway —
which is why that bot routes them and not PompAI. A test drives the real handler
to prove it.

### Anti-abuse

Random and economic actions are **server-authoritative**. A command passes a
guild id, a user id and nothing else: no amount, no item and no outcome ever
arrives from the client. A check asserts that no fun module reads a number from
an interaction option, and the only component ids this layer issues are opaque
session ids.

Duplicate daily claims, duplicate digs inside the cooldown, double-clicked
reward buttons and replayed interaction rewards are all prevented by the
transaction boundary — the second attempt reads the first attempt's committed
timestamp. Cross-guild access is prevented structurally, by the key.

### The channel

The blueprint gains exactly **🎉 EĞLENCE / `#eglence`** — one category, one
channel, no roles and no permission overwrites. Every fun command also works in
any other channel.

## Free game alerts

A background monitor posts Epic and Steam giveaways to `#bedava-oyunlar`.
**It makes zero AI calls** — no provider, model or API key is reachable from the
alert path, and `npm run check` asserts that statically.

```bash
FREE_GAMES_ENABLED=true      # off by default: enabling starts outbound requests
FREE_GAMES_INTERVAL_MINUTES=30
```

Polling runs once at startup and then every interval. The floor is **15 minutes**
whatever the config says, cycles never overlap, every request has a timeout, and
a failing provider yields an empty list plus a log line rather than taking the
cycle — or the bot — down. There are no retries; a failed cycle waits for the
next interval rather than hammering a store.

`/ucretsiz` queries both stores on demand without waiting for the interval.

### What counts as a giveaway

| Store | Announced | Not announced |
| --- | --- | --- |
| Epic | Promotions with `discountPercentage: 0` (a temporary window) | Permanently free-to-play titles, ordinary discounts, upcoming promotions |
| Steam | Offers explicitly marked Free to Keep | Free Weekends, permanently free titles, anything ambiguous |

Steam has **no official endpoint that distinguishes Free to Keep from Free
Weekend**, so the vendor read is split into a replaceable `SteamDiscoverySource`
(fetch) and a pure `classifySteamOffer()` (judge). Price is never used to
*promote* an offer: a 100% discount with no stated kind is `unknown`, and
`unknown` is never announced.

Three sources are available, chosen by `STEAM_GIVEAWAY_SOURCE`:

| Value | Source | Status |
| --- | --- | --- |
| `itad` (default) | IsThereAnyDeal documented API | Works — needs `ITAD_API_KEY` |
| `steamdb` | SteamDB free-promotions page | Opt-in only. Cloudflare-blocked; kept for debugging |
| `none` | — | Steam discovery disabled |

The ITAD source calls `GET https://api.isthereanydeal.com/giveaways/v1` with the
key in the `ITAD-API-Key` header — never in the URL, a log line or an error. One
request per cycle, no retries, no browser automation. An entry is announced only
when it is an **active, direct Steam full-game giveaway**; Free Weekend, Play For
Free, trials, demos, betas, DLC-only, soundtrack-only, third-party key giveaways
and permanently free titles are all rejected. A permanently free title is
accepted only when the metadata explicitly says the game is kept.

ITAD's own URL is preserved verbatim (their terms require the link be kept
intact) and the embed carries a plain `Source: IsThereAnyDeal` field. No Steam
URL is fabricated when no Steam id is available.

If `ITAD_API_KEY` is unset the Steam provider is **not registered at all**, so
`/ucretsiz` never reports a missing key as an outage — only a real request
failure counts.

### Deduplication

Announced giveaways are recorded in `data/giveaways.json` (git-ignored), keyed by
`provider:productId`, so a restart never re-posts everything. Writes are atomic
(temp file + rename), and a missing or corrupt file is treated as empty rather
than fatal. Entries are pruned once their giveaway ended more than
`FREE_GAMES_RETENTION_DAYS` ago — so a repeat promotion months later is announced
again, while a currently-running one never is.

If a post fails, it is *not* recorded, so the next cycle retries it instead of
losing the announcement silently.

## Games assistant

`/oyun oyun:<game> soru:<question>` answers gameplay, mechanics, builds, lore,
strategy, recommendations, settings and troubleshooting questions using the same
DeepSeek `deepseek-flash` client — no fallback model, no retry, same cooldown and
length limits.

Its prompt (`src/ai/gaming.js`) tells the model it has **no live data access**,
must distinguish uncertain or outdated knowledge from fact, and must not invent
mechanics, numbers or patch details. `/oyun` is **always ephemeral** in this
phase, and it uses a **separate memory namespace** from `/ask`, so project
context never leaks into a game question or the reverse.

`/oyun-temizle oyun:<game>` clears that user's history for one game only.

## AI layer

Commands depend on `ctx.ai`, never on a provider, so switching backends is a
configuration change.

### DeepSeek (real, paid)

```bash
AI_PROVIDER=deepseek
AI_API_KEY=...            # secret - never commit, never logged
AI_MODEL=deepseek-flash   # no fallback model is ever substituted
AI_TIMEOUT_MS=30000
AI_MAX_OUTPUT_TOKENS=1200
AI_TEMPERATURE=0.7
```

`src/ai/providers/deepseek.js` POSTs to DeepSeek's official chat-completions
endpoint (`https://api.deepseek.com/chat/completions`) with `AI_MODEL`, the
configured token cap and temperature, and `thinking: { type: 'disabled' }`. It
makes **exactly one** HTTP request per `/ask` - there are no automatic retries,
so a failure can never duplicate a paid request - and aborts a slow request via
`AbortController`. HTTP failures (401/403, 429, 5xx, other) and malformed or
empty bodies are mapped onto the AI error classes in `src/ai/errors.js`, and the
API key is scrubbed from anything that could be logged or shown.

Debug logs expose only privacy-safe diagnostics: request id, prompt character
count, a SHA-256 prefix of the prompt, latency and success/failure. Raw prompt
content is never logged by default.

### Stub (offline)

`stub` is a deterministic offline provider used by the default configuration and by
the tests - it costs nothing and never touches the network.

### Remaining placeholders

`openai`, `gemini` and `glm` are registered placeholders. They validate their input
and then throw `AIProviderNotImplementedError`. To implement one, replace the body
of `complete()` in `src/ai/providers/<name>.js`; no command, registry or schema
change is required.

## Deployment (Render)

One web service, one process: PompAI, PompMusic, the giveaway monitor and the
fun economy all run together. `render.yaml` describes it; `docs/render-env.md`
lists every variable name.

```bash
npm run start:render   # the Render path, forced, for local verification
```

### Why a container

PompMusic shells out to **yt-dlp**. A buildpack has no supported way to install
a binary that has to track YouTube, and "install it in the shell once" is not a
deployment strategy — the machine is replaced and music stops working with no
change to this repository. The `Dockerfile` installs a pinned yt-dlp plus
`ca-certificates` (without which the TLS handshake to YouTube fails), on a
Node 24 base. ffmpeg is deliberately absent: the stream is Opus in WebM, which
Discord decodes as-is.

`.dockerignore` keeps `.env`, `data/` and `node_modules/` out of the image.

### The health endpoint

The process serves `GET /` and `GET /health` on `0.0.0.0:$PORT` (default 10000):

```json
{ "ok": true, "service": "PompBots", "pompAI": true, "pompMusic": false, "uptimeSeconds": 1234 }
```

It is built field by field from an explicit allowlist, so no token, key, guild
id, config value or database row is reachable from it. `npm run check` asserts
the key set.

**It binds before Discord is contacted.** A platform decides whether a service
is alive by probing this port, so a slow, refused or reconnecting gateway must
not look like a dead process — the per-bot flags report the truth instead. If
PompMusic fails, the endpoint stays up and says `pompMusic: false`: restarting
the container would not fix a bad token, so failing the health check over it
would only produce a restart loop.

A port that cannot be bound is a loud log line, not a dead bot. On a platform
the failed health check is the signal; locally the bots simply carry on.

### Shutdown

`SIGTERM` (what a platform sends before replacing a container) and `SIGINT`
both take the same path: stop answering, stop polling, tear down every voice
session — **which kills the yt-dlp child each one owns, so no extractor
outlives a redeploy** — unbind events, destroy the Discord clients, then close
the SQLite handle. A second signal forces an exit so a hung close cannot wedge
the process.

### The filesystem is ephemeral

Render's free filesystem is replaced on every deploy, and two files hold real
state: `data/pomp-fun.sqlite` and `data/giveaways.json`. The process says so at
startup rather than letting you find out:

```
WARN Render ephemeral filesystem detected: fun economy (SQLite) (data/pomp-fun.sqlite)
and giveaway state (JSON) (data/giveaways.json) may be lost on restart.
```

Attach a disk, then set `PERSISTENT_STORAGE_PATH`, `FUN_DB_FILE` and
`FREE_GAMES_STATE_FILE` to point at it and the warning becomes a confirmation.
A local run never sees this warning.

> **The free plan also spins a service down after ~15 minutes without traffic**,
> which drops the Discord gateway connection. A bot that must always be online
> needs a paid instance type — the health endpoint cannot prevent a spin-down.

## Testing

```bash
npm test        # unit + integration tests
npm run check   # static and structural assertions
```

Tests never make network calls. The setup apply tests run against
`tests/helpers/fake-guild.js`, an in-memory guild implementing the same adapter
contract as `src/setup/adapter.js`, which is what makes the idempotency guarantee
verifiable without touching Discord.

The fun-layer tests run against a **real in-memory SQLite database** rather than
a stubbed repository — the transaction and isolation guarantees are the point, so
they are exercised on the engine that actually provides them. `Math.random` is
never stubbed globally; every random source is injected, so a test pins an
outcome by supplying the roll.

## Roadmap

- **Phase 2** - gateway connection, slash command registration,
  a `/setup` command wrapping the planner.
- **Phase 3** - PompAI commands (`/help`, `/ping`, `/status`, `/ask`).
- **Phase 3B** - DeepSeek-backed `/ask` with cooldowns, in-flight protection and
  privacy-safe diagnostics. Still to come: moderation, welcome flows, Valheim
  server status integration.
- **Phase 4A** - the fun and community layer: `/kaz`, `/gunluk`, XP with levels
  and titles, party games, and `/kapisma` song battles on PompMusic. Not yet
  done, and deliberately out of scope: **spending coins**, level roles, and
  achievements. The economy currently has sources and no sinks, which is the
  first thing to design before the numbers mean anything.
