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
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates python3 python3-pip \
 && rm -rf /var/lib/apt/lists/*

# Pinned so two builds of this file produce the same image.
#
# yt-dlp chases YouTube's changes, so an old pin eventually stops extracting
# anything. Bumping this line and rebuilding is the maintenance action; the bot
# reports a clear startup error rather than failing mysteriously in the
# meantime. Check https://pypi.org/project/yt-dlp/ for the current release.
ARG YTDLP_VERSION=2026.8.19
RUN python3 -m pip install --no-cache-dir --break-system-packages "yt-dlp==${YTDLP_VERSION}" \
 && yt-dlp --version

# ffmpeg is deliberately NOT installed. PompMusic asks yt-dlp for Opus inside
# WebM, which Discord decodes as-is, so no transcoding step exists that would
# need it - and adding one would only create a dependency to keep working.

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
