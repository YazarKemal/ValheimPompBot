import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';

/**
 * YouTube PO token provider.
 *
 * YouTube refuses anonymous extraction from datacenter addresses with "Sign in
 * to confirm you're not a bot". The supported answer is a proof-of-origin (PO)
 * token, not an account: yt-dlp asks a provider for a token, and a token says
 * "this request came from a real client session" without saying who the user
 * is. No cookies, no account, no credentials.
 *
 * The provider used here is bgutil-ytdlp-pot-provider, in SCRIPT mode: the
 * plugin (installed with pip, so yt-dlp loads it automatically) runs a Node
 * script that talks to Google's BotGuard endpoints. Script mode needs no
 * second process, no port, and no extra Render service - the Node runtime is
 * already in the image.
 *
 * Everything about the integration that could be silently wrong is verified at
 * startup (see `verifyPotProvider`). A provider that is configured but not
 * working does NOT fall back to plain yt-dlp: on a blocked address that fallback
 * is exactly the failure this exists to fix, and it would be invisible.
 */

export const POT_PROVIDER_NONE = 'none';
export const POT_PROVIDER_BGUTIL_SCRIPT = 'bgutil-script';

/** Where the Dockerfile builds the provider server. */
export const DEFAULT_POT_SERVER_HOME = '/opt/bgutil-ytdlp-pot-provider/server';

/**
 * The clients yt-dlp is asked to use, in the order it should try them.
 *
 * One client is not enough. A client can fail with LOGIN_REQUIRED *before* the
 * token flow is ever reached, in which case no token is generated and adding a
 * provider changes nothing - the other clients are what give the token flow a
 * chance to run at all. yt-dlp splits this on commas and tries each in turn.
 *
 * `mweb` needs a GVS PO token (without one its formats are skipped entirely),
 * which is why this argument is only applied together with a provider.
 */
export const DEFAULT_POT_PLAYER_CLIENT = 'mweb,tv,web_safari';

/** How long each startup probe may take. */
export const DEFAULT_POT_CHECK_TIMEOUT_MS = 20000;

/**
 * The script the plugin looks for, relative to `server_home`.
 *
 * Fixed by the plugin: `BgUtilScriptNodePTP._script_path_impl` joins
 * `server_home`, `build` and this basename, and refuses anything whose basename
 * differs.
 */
export const POT_SCRIPT_BASENAME = 'generate_once.js';

/** The pip-installed plugin module, as yt-dlp imports it. */
export const POT_PLUGIN_MODULE = 'yt_dlp_plugins.extractor.getpot_bgutil_script';

export const POT_UNAVAILABLE_CODE = 'MUSIC_POT_PROVIDER_UNAVAILABLE';

/**
 * The extractor arguments that turn the provider on.
 *
 * Both keys are yt-dlp's own, verified against its source rather than guessed:
 * the YouTube extractor reads `player_client` (hyphens are accepted by the
 * option parser too, but the canonical spelling is kept), and the plugin reads
 * `server_home`. Nothing here is invented, and nothing is added when the
 * provider is off.
 *
 * The two `youtube` settings share ONE argument, joined by `;`, and that is not
 * cosmetic. `--extractor-args` REPLACES the value stored for an extractor key
 * instead of merging into it - yt-dlp's option callback ends in
 * `out_dict[key] = val` (options.py, `_dict_from_options_callback`) - so a
 * second `youtube:` argument would silently discard the first. Two arguments
 * here would mean a client list that never reached yt-dlp, which is a bug that
 * looks exactly like the bot check it was meant to fix.
 *
 * @param {{ provider?: string, serverHome?: string, playerClient?: string, potTrace?: boolean }} options
 * @returns {string[]} zero, one or two `--extractor-args` values
 */
export function buildExtractorArgs({
  provider = POT_PROVIDER_NONE,
  serverHome = DEFAULT_POT_SERVER_HOME,
  playerClient = DEFAULT_POT_PLAYER_CLIENT,
  potTrace = true,
} = {}) {
  if (provider !== POT_PROVIDER_BGUTIL_SCRIPT) return [];

  const youtube = [`player_client=${playerClient}`];
  // `pot_trace=true` is what makes the token flow observable at all. yt-dlp
  // emits "PO Token response from ..." and "retrieved from cache" through
  // `logger.trace`, which only prints at TRACE - `--verbose` alone reaches
  // DEBUG and stops one level short (pot/_director.py: `log_level <= TRACE`).
  // Without it the success of a token is invisible, and a real IP block gets
  // misread as "no token was ever generated".
  if (potTrace) youtube.push('pot_trace=true');

  return [
    `youtube:${youtube.join(';')}`,
    `youtubepot-bgutilscript:server_home=${serverHome}`,
  ];
}

/* -------------------------------------------------------------------------- */
/* Watching one extraction                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What yt-dlp and the plugin print while a token is being obtained.
 *
 * Seeing the provider loaded proves nothing: the client can fail with
 * LOGIN_REQUIRED before the token flow is reached, and then no token is ever
 * requested. Only the messages below separate "no token was generated" from "a
 * token was generated and YouTube refused anyway" - which are the two very
 * different situations this diagnostic exists to tell apart.
 *
 * All of them are yt-dlp messages routed to stderr (with `-o -` yt-dlp sets
 * `logtostderr`, so every message goes there and nothing can corrupt the audio
 * on stdout):
 *
 *   [debug] [pot] PO Token Providers: bgutil:script-node-2.0.1 (external)
 *   [pot:bgutil:script-node] Generating a gvs PO Token for tv client via bgutil script
 *   [debug] [pot] TRACE: PO Token response from "bgutil:script-node" provider: ...
 *   [debug] [pot] TRACE: PO Token response retrieved from cache using "memory" provider: ...
 *
 * LEVELS ARE PART OF THE CONTRACT, and they are why `buildExtractorArgs` sets
 * `pot_trace=true`:
 *
 *   - the provider list is printed at DEBUG, so `--verbose` reaches it;
 *   - the two response lines are printed at TRACE, one level BELOW debug, and
 *     appear only when `pot_trace=true`. Without that argument a token can be
 *     generated perfectly and leave no trace in the output at all.
 *
 * NOTHING here is ever logged verbatim: the response lines contain the token,
 * and only the fact that they happened is kept.
 */
const POT_MARKERS = Object.freeze([
  {
    event: 'providerLoaded',
    // Anchored on `[pot]` exactly. The cache line uses `[pot:cache]`, which this
    // deliberately does not match - a registered cache provider is not a
    // registered token provider.
    pattern: /\[pot\]\s*PO Token Providers:([^\n]*)/i,
    // The line lists every registered provider, and reads "none" when there are
    // none, so it only counts when bgutil is among them.
    matches: (match) => /bgutil/i.test(match[1]),
  },
  {
    event: 'generationRequested',
    pattern: /Generating a \S+ PO Token for ([\w-]+) client via bgutil/i,
    detail: (match) => ({ client: match[1] }),
  },
  {
    event: 'tokenGenerated',
    // Anchored to the response form so the similar-sounding line printed just
    // before it - `Attempting to fetch PO Token response from "<provider>"
    // cache provider` - cannot be mistaken for a success.
    pattern: /PO Token response from "bgutil[^"]*" provider:/i,
  },
  {
    event: 'tokenFromCache',
    pattern: /PO Token response retrieved from cache using "[^"]+" provider:/i,
  },
]);

/** How much of the previous chunk is kept, so a marker split across two reads still matches. */
const MARKER_CARRY_CHARS = 120;

/** Fresh per-attempt state. Every field is a boolean fact, never a token. */
export function createPotDiagnostics() {
  return {
    providerLoaded: false,
    generationRequested: false,
    tokenGenerated: false,
    tokenFromCache: false,
    /** Which client the token was requested for, when one was. */
    client: null,
    carry: '',
  };
}

/**
 * Updates the state from a chunk of yt-dlp's output.
 *
 * @param {string} text
 * @param {object} state From `createPotDiagnostics`, mutated in place.
 * @returns {string[]} events seen for the FIRST time in this chunk, so a caller
 *   can log each one exactly once.
 */
export function scanPotDiagnostics(text, state) {
  if (typeof text !== 'string' || text === '') return [];

  // A marker can straddle two reads; scanning the tail of the previous chunk
  // with this one costs nothing and closes that gap.
  const window = `${state.carry ?? ''}${text}`;
  state.carry = window.slice(-MARKER_CARRY_CHARS);

  const seen = [];
  for (const marker of POT_MARKERS) {
    if (state[marker.event]) continue;
    const match = marker.pattern.exec(window);
    if (!match) continue;
    if (marker.matches && !marker.matches(match)) continue;

    state[marker.event] = true;
    if (marker.detail) Object.assign(state, marker.detail(match));
    seen.push(marker.event);
  }
  return seen;
}

/** True when a token was obtained, freshly generated or from the per-process cache. */
export function hasPotToken(state) {
  return Boolean(state?.tokenGenerated || state?.tokenFromCache);
}

/**
 * The facts worth logging, and nothing else.
 *
 * Deliberately not the lines that produced them: those carry the token.
 *
 * NAMING IS LOAD-BEARING. The logger redacts any value whose KEY looks like a
 * credential, so a field called `potTokenAvailable` is printed as
 * `[redacted]` - a diagnostic that hides itself. These names deliberately
 * avoid a standalone "token" segment; `potAvailable` says the same thing and
 * survives.
 *
 * @param {object} state
 * @returns {{ potProviderLoaded: boolean, potGenerationRequested: boolean, potAvailable: boolean, potClient: string|null }}
 */
export function potDiagnosticsSummary(state) {
  return {
    potProviderLoaded: Boolean(state?.providerLoaded),
    potGenerationRequested: Boolean(state?.generationRequested),
    potAvailable: hasPotToken(state),
    potClient: state?.client ?? null,
  };
}

/** Runs one probe command, bounded, and reports what happened. */
function run(command, args, { spawnImpl = spawn, timeoutMs = DEFAULT_POT_CHECK_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ ok: false, reason: `could not run ${command}: ${error?.message ?? 'unknown error'}`, stdout: '' });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      child.kill?.();
      finish({ ok: false, reason: `${command} did not answer within ${timeoutMs}ms`, stdout, stderr });
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', (chunk) => {
      // Bounded: a probe's output is a version string, not a report.
      if (stdout.length < 4096) stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 4096) stderr += String(chunk);
    });

    child.on('error', (error) => finish({ ok: false, reason: `${command}: ${error?.message ?? 'unknown error'}`, stdout, stderr }));
    child.on('close', (code) => {
      if (code === 0) finish({ ok: true, reason: null, stdout, stderr });
      else finish({ ok: false, reason: `${command} exited with code ${code}`, stdout, stderr });
    });
  });
}

/**
 * Verifies that the provider will actually work, before any track is attempted.
 *
 * Three independent things have to be true, and each is checked against the
 * artifact the plugin itself uses:
 *
 *   1. the script exists at `<server_home>/build/generate_once.js`
 *   2. it runs - `node <script> --version` - which is exactly the availability
 *      test the plugin performs (`is_available()`)
 *   3. the pip plugin is importable, which is how yt-dlp discovers it
 *
 * All three are offline. The one thing that cannot be checked without a real
 * extraction is whether YouTube accepts the token, and that surfaces per track
 * as MUSIC_YOUTUBE_BLOCKED.
 *
 * @param {object} options
 * @param {string} [options.provider]
 * @param {string} [options.serverHome]
 * @param {string} [options.nodePath] JS runtime, as the plugin resolves it.
 * @param {string} [options.pythonPath] Interpreter that owns the yt-dlp install.
 * @param {Function} [options.spawnImpl] Injected spawn (tests only).
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{ ok: boolean, enabled: boolean, code: string|null, reason: string|null, details: object }>}
 */
export async function verifyPotProvider({
  provider = POT_PROVIDER_NONE,
  serverHome = DEFAULT_POT_SERVER_HOME,
  nodePath = 'node',
  pythonPath = 'python3',
  spawnImpl = spawn,
  timeoutMs = DEFAULT_POT_CHECK_TIMEOUT_MS,
} = {}) {
  const details = {
    provider,
    mode: provider === POT_PROVIDER_BGUTIL_SCRIPT ? 'script' : null,
    serverHome,
    scriptPath: null,
    scriptVersion: null,
    pluginModule: POT_PLUGIN_MODULE,
    pluginPath: null,
  };

  if (provider === POT_PROVIDER_NONE) {
    return { ok: true, enabled: false, code: null, reason: null, details };
  }

  const scriptPath = path.join(serverHome, 'build', POT_SCRIPT_BASENAME);
  details.scriptPath = scriptPath;

  // 1. The file the plugin will look for.
  try {
    await access(scriptPath);
  } catch {
    return {
      ok: false,
      enabled: true,
      code: POT_UNAVAILABLE_CODE,
      reason: `the provider script is missing at ${scriptPath}`,
      details,
    };
  }

  // 2. The plugin's own availability probe.
  const script = await run(nodePath, [scriptPath, '--version'], { spawnImpl, timeoutMs });
  if (!script.ok) {
    return {
      ok: false,
      enabled: true,
      code: POT_UNAVAILABLE_CODE,
      reason: `the provider script did not run: ${script.reason}`,
      details,
    };
  }
  details.scriptVersion = script.stdout.trim().split('\n')[0] || null;

  // 3. The plugin yt-dlp has to load. Checked through the interpreter that owns
  //    yt-dlp, because that is the one that will import it.
  const probe = [
    '-c',
    `import importlib.util as u; s = u.find_spec(${JSON.stringify(POT_PLUGIN_MODULE)}); print(s.origin if s else '')`,
  ];
  const plugin = await run(pythonPath, probe, { spawnImpl, timeoutMs });
  const pluginPath = plugin.ok ? plugin.stdout.trim() : '';
  if (!plugin.ok || pluginPath === '') {
    return {
      ok: false,
      enabled: true,
      code: POT_UNAVAILABLE_CODE,
      reason: `the bgutil yt-dlp plugin is not importable (${plugin.reason ?? 'module not found'}); is bgutil-ytdlp-pot-provider installed for the interpreter that runs yt-dlp?`,
      details,
    };
  }
  details.pluginPath = pluginPath;

  return { ok: true, enabled: true, code: null, reason: null, details };
}
