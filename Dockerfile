# syntax=docker/dockerfile:1

# PompBots: PompAI + PompMusic in one process.
#
# A container rather than a native runtime because PompMusic shells out to
# yt-dlp. A buildpack has no supported way to install a binary that has to be
# current with YouTube, and "install it in the shell once" is not a deployment
# strategy - a machine that gets replaced loses it silently, and music stops
# working with no change to this repository.
#
# Nothing here contains a secret. Every credential arrives as a runtime
# environment variable (see docs/render-env.md).

# Node 24 is the floor, not a preference: `node:sqlite` - which the whole fun
# economy is built on - is only available WITHOUT a flag from Node 24. Node 22
# needs --experimental-sqlite and Node 20 has no node:sqlite at all.
FROM node:24-bookworm-slim

# yt-dlp is a Python program, so the runtime has to be here.
#
# ca-certificates is not optional: without it the TLS handshake with YouTube
# fails, and every track reports "no playable audio" instead. `--break-system-
# packages` is required because Debian 12 marks the system interpreter as
# externally managed; this container has no other Python consumer to protect.
#
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates python3 python3-pip \
 && rm -rf /var/lib/apt/lists/*

# Pinned so two builds of this file produce the same image.
#
# yt-dlp chases YouTube's changes, so an old pin eventually stops extracting
# anything. Bumping this line and rebuilding is the maintenance action; the bot
# reports a clear startup error rather than failing mysteriously in the
# meantime. Check https://pypi.org/project/yt-dlp/ for the current release.
#
# bgutil-ytdlp-pot-provider is the yt-dlp PLUGIN half of the PO token provider:
# a pip install is all yt-dlp needs to discover it. Pinned to the same version
# as the server built below, which is what the project asks for.
ARG YTDLP_VERSION=2026.8.19
ARG BGUTIL_POT_VERSION=2.0.1
RUN python3 -m pip install --no-cache-dir --break-system-packages \
      "yt-dlp==${YTDLP_VERSION}" \
      "bgutil-ytdlp-pot-provider==${BGUTIL_POT_VERSION}" \
 && yt-dlp --version

# ffmpeg is deliberately NOT installed. PompMusic asks yt-dlp for Opus inside
# WebM, which Discord decodes as-is, so no transcoding step exists that would
# need it - and adding one would only create a dependency to keep working.

# The PO token provider SERVER, built from source at build time.
#
# YouTube answers a datacenter address with "Sign in to confirm you're not a
# bot". The fix is a proof-of-origin token, not an account: the pip plugin above
# asks this server for one, and the server talks to Google's BotGuard endpoints.
# Script mode is used rather than the HTTP server because it needs no second
# process, no port and no second Render service - only the Node runtime that is
# already here.
#
# The path is not arbitrary: the plugin joins server_home + build +
# generate_once.js, and runs it with `node`, so build/ and node_modules/ must
# both survive into the runtime image. `npm prune --omit=dev` afterwards keeps
# the compiler and linters out of it.
#
# Nothing is downloaded at runtime, and no secret of any kind is involved:
# a PO token is generated per request from a session this container creates.
#
# git is needed only for this clone, and is purged in the same layer that
# installs it, so it costs the finished image nothing. BGUTIL_POT_VERSION comes
# from the pip install above: one pin, both halves of the provider.
ARG BGUTIL_POT_HOME=/opt/bgutil-ytdlp-pot-provider
RUN apt-get update \
 && apt-get install -y --no-install-recommends git \
 && git clone --depth 1 --branch "${BGUTIL_POT_VERSION}" \
      https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git "${BGUTIL_POT_HOME}" \
 && cd "${BGUTIL_POT_HOME}/server" \
 && npm ci --no-audit --no-fund \
 && npx tsc \
 && npm prune --omit=dev --no-audit --no-fund \
 && node build/generate_once.js --version \
 && rm -rf "${BGUTIL_POT_HOME}/.git" \
 && apt-get purge -y git \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

# What the plugin runs. The build above fails if the script is ever missing.
ENV POMPMUSIC_POT_SERVER_HOME=${BGUTIL_POT_HOME}/server

# PO tokens are required for playback from this address, so the provider is on
# by default in the image. It is verified at startup: if it is not working,
# PompMusic reports why and refuses to stream rather than falling back to the
# plain yt-dlp path YouTube is already blocking here.
ENV POMPMUSIC_POT_PROVIDER=bgutil-script

WORKDIR /app

# Dependencies first, so this layer survives a source-only change.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production

# Render injects PORT at runtime; 10000 matches the documented default.
ENV PORT=10000

# Play-dl extraction is not a fallback, in the image or anywhere else.
ENV POMPMUSIC_STREAM_BACKEND=ytdlp

EXPOSE 10000

# The same entrypoint as `npm start`. The process serves /health on $PORT and
# handles SIGTERM itself, so no init wrapper or signal proxy is needed.
CMD ["node", "src/index.js"]
