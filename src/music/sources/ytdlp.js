import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { StreamType } from '@discordjs/voice';
import { BotError, safeErrorDetails } from '../../utils/errors.js';
import { sanitizeStderr } from '../../utils/redact.js';
import { buildExtractorArgs, verifyPotProvider } from './pot-provider.js';

/**
 * yt-dlp streaming backend.
 *
 * Replaces play-dl for YouTube audio extraction, which broke when YouTube
 * changed its player response: play-dl 1.9.7 could no longer read a media URL
 * out of the format list.
 *
 * Shape of the work:
 *
 *   track.url (canonical) -> spawn yt-dlp -> first audio byte -> stdout -> @discordjs/voice
 *
 * The first-byte gate:
 *
 *   A spawned process is NOT a playing track. yt-dlp starts, then decides
 *   whether YouTube will serve it anything - and on a datacenter address it may
 *   well not. `openStream` therefore does not resolve on 'spawn': it resolves
 *   only once a byte of audio has actually reached stdout, and rejects when the
 *   process exits, errors, or stays silent past `firstByteTimeoutMs`. A track
 *   that produces nothing is reported as a failed track before any caller says
 *   "now playing", which is exactly the lie this gate exists to prevent.
 *
 * Safety boundaries held here:
 *   - `spawn` with an argument ARRAY, never a shell. There is no command
 *     injection surface: the only user-influenced value is the track URL, and
 *     by this point it has been validated as an https YouTube URL.
 *   - the search text never reaches this module; only the normalized URL does.
 *   - audio goes to stdout. Nothing is written to disk, and `--no-cache-dir`
 *     stops yt-dlp writing a cache of its own.
 *   - each stream owns its own child process, so killing one guild's playback
 *     cannot touch another's.
 *   - stderr is captured into a bounded buffer purely for diagnostics.
 */

export const YTDLP_BACKEND_NAME = 'ytdlp';

/**
 * Opus inside WebM, which @discordjs/voice accepts directly.
 *
 * Asking for Opus specifically is what lets Discord play the bytes as they
 * arrive. The looser `bestaudio` can select an m4a/AAC stream, which Discord
 * cannot decode - it would need transcoding, and a transcoding step is a
 * dependency and a failure mode this path does not need.
 */
export const DEFAULT_FORMAT = 'bestaudio[acodec=opus]';

/** @discordjs/voice stream type matching DEFAULT_FORMAT. */
export const DEFAULT_STREAM_TYPE = StreamType.WebmOpus;

/** Captured stderr is truncated to this many bytes. */
export const MAX_STDERR_BYTES = 4096;

export const DEFAULT_STARTUP_TIMEOUT_MS = 20000;

/**
 * How long the process has to produce its FIRST audio byte.
 *
 * Separate from the spawn timeout, and deliberately longer: spawning yt-dlp is
 * fast, while extracting a URL from YouTube on a cold container is not. A
 * process that spawns and then says nothing is the failure mode being measured.
 */
export const DEFAULT_FIRST_BYTE_TIMEOUT_MS = 15000;

/** Attempts per track, including the first. Only pre-audio failures are retried. */
export const DEFAULT_MAX_ATTEMPTS = 2;

/** Pause between attempts. */
export const DEFAULT_RETRY_DELAY_MS = 500;

/** Exit codes and messages that mean "no usable audio", not a crash. */
const NO_AUDIO_PATTERNS = [/requested format not available/i, /no video formats found/i, /requested format is not/i];

/**
 * Messages that mean YouTube refused the request, not that the track is bad.
 *
 * These are the ones a PO token provider exists to fix, so they get their own
 * code: "the extraction failed" and "YouTube is blocking this address" need
 * different responses, and only the second one is worth a token.
 */
const YOUTUBE_BLOCKED_PATTERNS = [
  /sign in to confirm you'?re not a bot/i,
  /confirm you'?re not a bot/i,
  /sign in to confirm your age/i,
  /bot check/i,
];

/** True when stderr describes YouTube refusing the request itself. */
export function isYoutubeBlocked(stderr) {
  const text = String(stderr ?? '');
  return YOUTUBE_BLOCKED_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Failures worth another attempt.
 *
 * All of them happen BEFORE any audio byte - once audio has flowed nothing is
 * retried, so a track is never restarted underneath a listener. A missing
 * executable is deliberately absent: it is deterministic, and respawning it
 * only doubles the wait before the same answer.
 */
const RETRYABLE_CODES = new Set([
  'MUSIC_YTDLP_TIMEOUT',
  'MUSIC_YTDLP_FIRST_BYTE_TIMEOUT',
  'MUSIC_YTDLP_EXITED',
  'MUSIC_YTDLP_NO_AUDIO',
]);

/** True when an error is a pre-audio failure that another attempt might clear. */
export function isRetryableStreamError(error) {
  return Boolean(error) && RETRYABLE_CODES.has(error.code);
}

/** Hostname of a URL, or null. Never the full URL: those can be signed. */
function hostOf(value) {
  try {
    return new URL(String(value)).hostname;
  } catch {
    return null;
  }
}

/** Waits between attempts. Not unref'd: a retry in flight must be able to finish. */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Candidate executables, in resolution order after an explicit path. */
export const EXECUTABLE_CANDIDATES = Object.freeze(['yt-dlp', 'yt-dlp.exe']);

/**
 * Locates a usable yt-dlp.
 *
 * Order: the configured path, then `yt-dlp`, then `yt-dlp.exe` on Windows. Each
 * candidate is probed by actually running `--version`, so a name that resolves
 * to a broken shim is not mistaken for a working install.
 *
 * Nothing is downloaded. If none is found the caller reports a clear
 * unavailable state rather than falling back to the backend that is known to
 * be broken.
 *
 * @param {object} [options]
 * @param {string|null} [options.configuredPath]
 * @param {Function} [options.spawnImpl] Injected spawn (tests only).
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{available: boolean, path: string|null, version: string|null, source: string, reason: string|null}>}
 */
export async function detectYtDlp({
  configuredPath = null,
  spawnImpl = spawn,
  timeoutMs = 10000,
} = {}) {
  const candidates = configuredPath
    ? [{ label: configuredPath, source: 'configured' }]
    : EXECUTABLE_CANDIDATES.map((label) => ({ label, source: label.includes('.exe') ? 'path-windows' : 'path' }));

  let lastReason = 'yt-dlp was not found on PATH.';

  for (const candidate of candidates) {
    const result = await probe(candidate.label, { spawnImpl, timeoutMs });
    if (result.ok) {
      return {
        available: true,
        path: candidate.label,
        version: result.version,
        source: candidate.source,
        reason: null,
      };
    }
    lastReason = result.reason;
  }

  return { available: false, path: null, version: null, source: 'none', reason: lastReason };
}

/** Runs `<candidate> --version` and reports what happened. */
function probe(executable, { spawnImpl, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(executable, ['--version'], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ ok: false, reason: `Could not run ${executable}: ${error?.message ?? 'unknown error'}` });
      return;
    }

    let out = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      child.kill?.();
      finish({ ok: false, reason: `${executable} did not answer --version within ${timeoutMs}ms` });
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', (chunk) => {
      out += String(chunk);
    });
    child.on('error', (error) => finish({ ok: false, reason: `${executable}: ${error?.message ?? 'unknown error'}` }));
    child.on('close', (code) => {
      const version = out.trim().split('\n')[0] ?? '';
      if (code === 0 && version !== '') finish({ ok: true, version });
      else finish({ ok: false, reason: `${executable} --version exited with code ${code}` });
    });
  });
}

/**
 * Builds the argument list.
 *
 * Every flag is fixed by this module. Nothing from a user or a message is
 * interpolated, and the URL is a single array element.
 *
 * @param {{ url: string, format?: string }} options
 * @returns {string[]}
 */
export function buildArguments({ url, format = DEFAULT_FORMAT, extractorArgs = [] }) {
  return [
    // Ignore any user-level config, so behaviour does not vary by machine.
    '--ignore-config',
    // Nothing on disk, not even a cache.
    '--no-cache-dir',
    '--no-playlist',
    '--no-progress',
    '--no-warnings',
    // Audio to stdout. `-` is yt-dlp's stdout convention.
    '--output',
    '-',
    '--format',
    format,
    // Provider configuration, when one is enabled. Each entry is one
    // `extractor:key=value` string, exactly as yt-dlp documents it. Nothing is
    // added here by default: a plain yt-dlp run is unchanged.
    ...extractorArgs.flatMap((value) => ['--extractor-args', value]),
    url,
  ];
}

export class YtDlpStreamBackend {
  /**
   * @param {object} options
   * @param {string} options.executable
   * @param {string} [options.version]
   * @param {string} [options.format]
   * @param {unknown} [options.streamType]
   * @param {Function} [options.spawnImpl]
   * @param {number} [options.startupTimeoutMs]
   * @param {number} [options.firstByteTimeoutMs]
   * @param {number} [options.maxAttempts]
   * @param {number} [options.retryDelayMs]
   * @param {object} [options.logger]
   */
  constructor({
    executable,
    version = null,
    format = DEFAULT_FORMAT,
    streamType = DEFAULT_STREAM_TYPE,
    spawnImpl = spawn,
    startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
    firstByteTimeoutMs = DEFAULT_FIRST_BYTE_TIMEOUT_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    extractorArgs = [],
    logger = null,
  }) {
    this.name = YTDLP_BACKEND_NAME;
    this.executable = executable;
    this.version = version;
    this.format = format;
    this.streamType = streamType;
    this.spawnImpl = spawnImpl;
    this.startupTimeoutMs = startupTimeoutMs;
    this.firstByteTimeoutMs = firstByteTimeoutMs;
    this.maxAttempts = maxAttempts;
    this.retryDelayMs = retryDelayMs;
    /** Provider arguments, fixed at construction. Empty means a plain run. */
    this.extractorArgs = Object.freeze([...extractorArgs]);
    this.logger = logger;
  }

  /**
   * Opens one audio stream, retrying a bounded number of times.
   *
   * Resolves only once yt-dlp has actually written audio to stdout - never on
   * spawn. Anything that goes wrong before that first byte is retried up to
   * `maxAttempts` times, because the common causes (a cold container, a slow
   * YouTube handshake, one bad format negotiation) are transient. A failure
   * after the first byte is never retried: the track is already playing, and
   * restarting it underneath a listener would be worse than letting it end.
   *
   * @param {string} url Canonical, already validated.
   * @returns {Promise<{ stream: import('node:stream').Readable, inputType: unknown, kill: Function, meta: object }>}
   * @throws {BotError} MUSIC_YTDLP_NOT_FOUND | MUSIC_YTDLP_TIMEOUT |
   *   MUSIC_YTDLP_FIRST_BYTE_TIMEOUT | MUSIC_YTDLP_NO_AUDIO | MUSIC_YTDLP_EXITED
   */
  async openStream(url) {
    const startedAt = Date.now();
    const attempts = Number.isInteger(this.maxAttempts) && this.maxAttempts > 0 ? this.maxAttempts : 1;
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.#openAttempt(url, { startedAt, attempt, attempts });
      } catch (error) {
        lastError = error;
        if (!isRetryableStreamError(error) || attempt >= attempts) throw error;

        // The diagnostics travel with the log, not just the message: on a
        // machine you cannot open a shell on, stderr is the only evidence of
        // *why* yt-dlp produced nothing.
        this.logger?.warn?.('yt-dlp produced no audio; retrying.', {
          attempt,
          attempts,
          code: error?.code ?? null,
          reason: error?.message,
          urlHost: hostOf(url),
          retryInMs: this.retryDelayMs,
          ...safeErrorDetails(error),
        });
        await delay(this.retryDelayMs);
      }
    }

    // Unreachable: the loop either returns or throws. Kept so the contract is
    // explicit rather than implied by the loop bounds.
    throw lastError;
  }

  /**
   * One spawn-to-first-byte attempt.
   *
   * @param {string} url
   * @param {{ startedAt: number, attempt: number, attempts: number }} context
   */
  async #openAttempt(url, { startedAt, attempt, attempts }) {
    const args = buildArguments({ url, format: this.format, extractorArgs: this.extractorArgs });

    let child;
    try {
      child = this.spawnImpl(this.executable, args, {
        // No shell: the URL is one argument among fixed flags, never syntax.
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw new BotError(`Could not start yt-dlp: ${error?.message ?? 'unknown error'}`, {
        code: 'MUSIC_YTDLP_NOT_FOUND',
        cause: error,
      });
    }

    const audio = new PassThrough();
    const diagnostics = {
      attempt,
      attempts,
      bytes: 0,
      stderr: '',
      truncated: false,
      exited: false,
      code: null,
      signal: null,
      spawnMs: null,
      firstByteMs: null,
      exitedMs: null,
    };

    const gate = createDeferred();
    // The spawn-failure path rejects this first, and the rejection may never be
    // awaited. Marking it handled here keeps that from surfacing as an
    // unhandled rejection; `await gate.promise` below still sees the rejection.
    gate.promise.catch(() => {});

    let killed = false;
    const kill = () => {
      if (diagnostics.exited || killed) return false;
      killed = true;
      try {
        // Terminates the process; on Windows this maps to TerminateProcess.
        child.kill('SIGKILL');
        return true;
      } catch {
        return false;
      }
    };

    // The pipe is attached BEFORE the gate's own listener, so the byte that
    // satisfies the gate is the same byte that reaches the player. Attaching a
    // 'data' listener first would resume the stream and drop that first chunk
    // on the floor, which is precisely the failure this gate exists to catch.
    child.stdout?.pipe(audio);
    child.stdout?.on('data', (chunk) => {
      if (diagnostics.bytes === 0 && chunk.length > 0) {
        diagnostics.firstByteMs = Date.now() - startedAt;
        gate.resolve();
      }
      diagnostics.bytes += chunk.length;
    });

    child.stderr?.on('data', (chunk) => {
      const room = MAX_STDERR_BYTES - diagnostics.stderr.length;
      if (room <= 0) {
        diagnostics.truncated = true;
        return;
      }
      const text = String(chunk);
      if (text.length > room) diagnostics.truncated = true;
      diagnostics.stderr += text.slice(0, room);
    });

    // Pre-first-byte failures feed the gate. Once it has settled these are
    // no-ops, and the post-gate handlers below take over.
    child.on('error', (error) => {
      gate.reject(
        new BotError(`Could not start yt-dlp: ${error?.message ?? 'unknown error'}`, {
          code: error?.code === 'ENOENT' ? 'MUSIC_YTDLP_NOT_FOUND' : 'MUSIC_YTDLP_EXITED',
          cause: error,
        }),
      );
    });

    child.on('close', (code, signal) => {
      diagnostics.exited = true;
      diagnostics.code = code;
      diagnostics.signal = signal ?? null;
      diagnostics.exitedMs = Date.now() - startedAt;

      if (diagnostics.bytes > 0) {
        this.logger?.info?.('yt-dlp exited.', {
          attempt,
          attempts,
          exitCode: code,
          signal: signal ?? null,
          bytes: diagnostics.bytes,
          playedMs: diagnostics.exitedMs,
        });
        return;
      }

      // Nothing ever reached stdout. That is a failed attempt whatever the exit
      // code says - including code 0, which is the silent case that used to
      // look like a track that ended immediately.
      gate.reject(this.#noAudioError(diagnostics));
    });

    await this.#waitForSpawn(child, diagnostics, startedAt);

    this.logger?.info?.('yt-dlp spawned.', {
      attempt,
      attempts,
      pid: child.pid ?? null,
      spawnMs: diagnostics.spawnMs,
      format: this.format,
      urlHost: hostOf(url),
    });

    const timer = setTimeout(() => {
      kill();
      gate.reject(
        new BotError(`yt-dlp produced no audio within ${this.firstByteTimeoutMs}ms.`, {
          code: 'MUSIC_YTDLP_FIRST_BYTE_TIMEOUT',
          details: { timeoutMs: this.firstByteTimeoutMs, ...this.#stderrDetails(diagnostics) },
        }),
      );
    }, this.firstByteTimeoutMs);
    timer.unref?.();

    try {
      await gate.promise;
    } catch (error) {
      // Nothing will consume this stream, and it may already hold buffered
      // audio. Killing covers the one path where the child is still alive: an
      // 'error' after a successful spawn, which rejects the gate without
      // necessarily ending the process.
      kill();
      audio.destroy();
      throw error;
    } finally {
      clearTimeout(timer);
    }

    this.logger?.info?.('yt-dlp produced its first audio byte.', {
      attempt,
      attempts,
      firstByteMs: diagnostics.firstByteMs,
      bytes: diagnostics.bytes,
      format: this.format,
    });

    // Past the gate, an error is the end of a track that was playing: it is
    // reported on the stream and never retried.
    child.on('error', (error) => {
      audio.destroy(
        new BotError(`yt-dlp failed: ${error?.message ?? 'unknown error'}`, { code: 'MUSIC_YTDLP_EXITED', cause: error }),
      );
    });

    // If the child dies without ever being killed, the stream is already being
    // torn down by the close handler above.
    audio.once('close', () => {
      if (!diagnostics.exited) kill();
    });

    return {
      stream: audio,
      inputType: this.streamType,
      kill,
      meta: {
        backend: YTDLP_BACKEND_NAME,
        format: this.format,
        streamType: this.streamType,
        // Time to openStream resolving: spawn + first audio byte.
        startupMs: Date.now() - startedAt,
        firstByteMs: diagnostics.firstByteMs,
        attempt,
        attempts,
        diagnostics,
      },
    };
  }

  /**
   * The stderr context that travels with a failure.
   *
   * One shape for every failure, so a reader does not have to know which error
   * code carries what. `stderr` is sanitized HERE, at the point of capture:
   * yt-dlp prints media URLs with their signatures, and raw output must not
   * escape this module.
   */
  #stderrDetails(diagnostics) {
    return {
      exitCode: diagnostics.code,
      signal: diagnostics.signal,
      bytes: diagnostics.bytes,
      stderrBytes: diagnostics.stderr.length,
      stderrTruncated: diagnostics.truncated,
      // Bounded and sanitized: error text survives, signed URLs do not.
      stderr: sanitizeStderr(diagnostics.stderr),
    };
  }

  /** Builds the failure for an attempt that exited without ever writing audio. */
  #noAudioError(diagnostics) {
    const stderr = diagnostics.stderr.trim();
    const patternMatch = NO_AUDIO_PATTERNS.some((pattern) => pattern.test(stderr));
    // A clean exit with an empty stdout means yt-dlp finished the job and had
    // nothing to hand over: "no audio", not "crashed".
    const noAudio = patternMatch || diagnostics.code === 0;

    // Checked first, and deliberately: "YouTube refused this request" is not
    // the same failure as "this track has no audio", and only one of them is
    // answered by a PO token.
    const blocked = isYoutubeBlocked(stderr);

    const message = blocked
      ? 'YouTube refused the extraction (bot check). A PO token provider is required for this address.'
      : noAudio
        ? 'yt-dlp produced no playable audio for this track.'
        : 'yt-dlp exited before producing any audio.';

    return new BotError(message, {
      code: blocked ? 'MUSIC_YOUTUBE_BLOCKED' : noAudio ? 'MUSIC_YTDLP_NO_AUDIO' : 'MUSIC_YTDLP_EXITED',
      details: this.#stderrDetails(diagnostics),
    });
  }

  /** Resolves on 'spawn', rejects on 'error' or a timeout. */
  #waitForSpawn(child, diagnostics, startedAt) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };

      const timer = setTimeout(() => {
        child.kill?.();
        finish(
          reject,
          new BotError(`yt-dlp did not start within ${this.startupTimeoutMs}ms.`, {
            code: 'MUSIC_YTDLP_TIMEOUT',
            details: {
              timeoutMs: this.startupTimeoutMs,
              ...(diagnostics ? this.#stderrDetails(diagnostics) : {}),
            },
          }),
        );
      }, this.startupTimeoutMs);
      timer.unref?.();

      child.on('spawn', () => {
        if (diagnostics) diagnostics.spawnMs = Date.now() - startedAt;
        finish(resolve, undefined);
      });
      child.on('error', (error) =>
        finish(
          reject,
          new BotError(`Could not start yt-dlp: ${error?.message ?? 'unknown error'}`, {
            code: error?.code === 'ENOENT' ? 'MUSIC_YTDLP_NOT_FOUND' : 'MUSIC_YTDLP_EXITED',
            details: diagnostics ? this.#stderrDetails(diagnostics) : null,
            cause: error,
          }),
        ),
      );
    });
  }
}

/** A promise plus its settle functions, which no-op once settled. */
function createDeferred() {
  let resolve;
  let reject;
  let settled = false;
  const promise = new Promise((res, rej) => {
    resolve = (value) => {
      if (settled) return;
      settled = true;
      res(value);
    };
    reject = (error) => {
      if (settled) return;
      settled = true;
      rej(error);
    };
  });
  return { promise, resolve, reject };
}

/**
 * Builds the backend for the configured settings, or null when streaming is
 * disabled.
 *
 * @param {object} options
 * @param {object} options.settings PompMusic config.
 * @param {object} [options.logger]
 * @param {Function} [options.spawnImpl]
 * @returns {Promise<{backend: YtDlpStreamBackend|null, detection: object}>}
 */
export async function createStreamBackend({ settings = {}, logger = null, spawnImpl = spawn } = {}) {
  if (settings.streamBackend === 'none') {
    return {
      backend: null,
      detection: { available: false, path: null, version: null, source: 'disabled', reason: 'streaming is disabled' },
    };
  }

  const detection = await detectYtDlp({
    configuredPath: settings.ytdlpPath ?? null,
    spawnImpl,
  });

  if (!detection.available) {
    return { backend: null, detection };
  }

  // A configured PO token provider is verified before anything else, and a
  // provider that does not work disables streaming outright. Falling back to
  // plain yt-dlp here is exactly the silent failure this feature exists to
  // remove: on a blocked address the fallback cannot play anything, and the
  // only difference the operator would see is that it stopped working.
  const pot = await verifyPotProvider({
    provider: settings.potProvider,
    serverHome: settings.potServerHome,
    pythonPath: settings.potPython,
    spawnImpl,
    timeoutMs: settings.potCheckTimeoutMs,
  });

  detection.potProvider = pot;

  if (!pot.ok) {
    logger?.error?.('PO token provider unavailable: ' + pot.reason, {
      code: pot.code,
      // `provider` and `mode` name the provider itself, so the same two values
      // appear whether it worked or not; the raw setting is kept separately.
      provider: 'bgutil',
      mode: pot.details.mode,
      configuredAs: pot.details.provider,
      serverHome: pot.details.serverHome,
      pluginModule: pot.details.pluginModule,
    });
    return {
      backend: null,
      detection: { ...detection, available: false, code: pot.code, reason: pot.reason },
    };
  }

  if (pot.enabled) {
    logger?.info?.('PO token provider ready.', {
      provider: 'bgutil',
      mode: pot.details.mode,
      serverHome: pot.details.serverHome,
      scriptVersion: pot.details.scriptVersion,
      pluginModule: pot.details.pluginModule,
      playerClient: settings.potPlayerClient,
    });
  }

  return {
    backend: new YtDlpStreamBackend({
      executable: detection.path,
      version: detection.version,
      format: settings.ytdlpFormat,
      spawnImpl,
      startupTimeoutMs: settings.ytdlpStartupTimeoutMs,
      firstByteTimeoutMs: settings.ytdlpFirstByteTimeoutMs,
      maxAttempts: settings.ytdlpMaxAttempts,
      retryDelayMs: settings.ytdlpRetryDelayMs,
      extractorArgs: buildExtractorArgs({
        provider: settings.potProvider,
        serverHome: settings.potServerHome,
        playerClient: settings.potPlayerClient,
      }),
      logger,
    }),
    detection,
  };
}
