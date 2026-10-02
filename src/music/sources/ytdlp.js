import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { StreamType } from '@discordjs/voice';
import { BotError } from '../../utils/errors.js';

/**
 * yt-dlp streaming backend.
 *
 * Replaces play-dl for YouTube audio extraction, which broke when YouTube
 * changed its player response: play-dl 1.9.7 could no longer read a media URL
 * out of the format list.
 *
 * Shape of the work:
 *
 *   track.url (canonical) -> spawn yt-dlp -> stdout -> @discordjs/voice
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

/** Exit codes and messages that mean "no usable audio", not a crash. */
const NO_AUDIO_PATTERNS = [/requested format not available/i, /no video formats found/i, /requested format is not/i];

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
export function buildArguments({ url, format = DEFAULT_FORMAT }) {
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
   * @param {object} [options.logger]
   */
  constructor({
    executable,
    version = null,
    format = DEFAULT_FORMAT,
    streamType = DEFAULT_STREAM_TYPE,
    spawnImpl = spawn,
    startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
    logger = null,
  }) {
    this.name = YTDLP_BACKEND_NAME;
    this.executable = executable;
    this.version = version;
    this.format = format;
    this.streamType = streamType;
    this.spawnImpl = spawnImpl;
    this.startupTimeoutMs = startupTimeoutMs;
    this.logger = logger;
  }

  /**
   * Opens one audio stream.
   *
   * Resolves once the child has actually spawned, so a missing or unrunnable
   * executable is reported as a startup failure rather than as a broken audio
   * stream later. A non-zero exit with no audio surfaces as an error on the
   * returned stream, which @discordjs/voice forwards to the session's error
   * path - the track is skipped, playback continues.
   *
   * @param {string} url Canonical, already validated.
   * @returns {Promise<{ stream: import('node:stream').Readable, inputType: unknown, kill: Function, meta: object }>}
   */
  async openStream(url) {
    const startedAt = Date.now();
    const args = buildArguments({ url, format: this.format });

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

    await this.#waitForSpawn(child);

    const audio = new PassThrough();
    const diagnostics = { stderr: '', truncated: false, bytes: 0, exited: false, code: null, signal: null };

    child.stdout?.on('data', (chunk) => {
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

    child.stdout?.pipe(audio);

    child.on('error', (error) => {
      audio.destroy(
        new BotError(`yt-dlp failed: ${error?.message ?? 'unknown error'}`, { code: 'MUSIC_YTDLP_EXITED', cause: error }),
      );
    });

    child.on('close', (code, signal) => {
      diagnostics.exited = true;
      diagnostics.code = code;
      diagnostics.signal = signal ?? null;

      if (code === 0) return;

      // A non-zero exit before any audio is a failed track. After audio has
      // flowed it just means the stream ended; nothing to report.
      if (diagnostics.bytes > 0) return;

      const reason = diagnostics.stderr.trim();
      const noAudio = NO_AUDIO_PATTERNS.some((pattern) => pattern.test(reason));

      audio.destroy(
        new BotError(
          noAudio ? 'yt-dlp found no playable audio for this track.' : 'yt-dlp exited before producing audio.',
          {
            code: noAudio ? 'MUSIC_YTDLP_NO_AUDIO' : 'MUSIC_YTDLP_EXITED',
            details: {
              // Bounded, and stderr only - never a signed media URL.
              exitCode: code,
              signal: signal ?? null,
              stderr: reason.slice(0, 500) || null,
            },
          },
        ),
      );
    });

    const kill = () => {
      if (diagnostics.exited) return false;
      try {
        // Terminates the process; on Windows this maps to TerminateProcess.
        child.kill('SIGKILL');
        return true;
      } catch {
        return false;
      }
    };

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
        startupMs: Date.now() - startedAt,
        diagnostics,
      },
    };
  }

  /** Resolves on 'spawn', rejects on 'error' or a timeout. */
  #waitForSpawn(child) {
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
          new BotError(`yt-dlp did not start within ${this.startupTimeoutMs}ms.`, { code: 'MUSIC_YTDLP_TIMEOUT' }),
        );
      }, this.startupTimeoutMs);
      timer.unref?.();

      child.on('spawn', () => finish(resolve, undefined));
      child.on('error', (error) =>
        finish(
          reject,
          new BotError(`Could not start yt-dlp: ${error?.message ?? 'unknown error'}`, {
            code: error?.code === 'ENOENT' ? 'MUSIC_YTDLP_NOT_FOUND' : 'MUSIC_YTDLP_EXITED',
            cause: error,
          }),
        ),
      );
    });
  }
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

  return {
    backend: new YtDlpStreamBackend({
      executable: detection.path,
      version: detection.version,
      format: settings.ytdlpFormat,
      spawnImpl,
      startupTimeoutMs: settings.ytdlpStartupTimeoutMs,
      logger,
    }),
    detection,
  };
}
