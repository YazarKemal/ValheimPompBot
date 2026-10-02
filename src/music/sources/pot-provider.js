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
 * The client yt-dlp is asked to use.
 *
 * `mweb` needs a GVS PO token - without one yt-dlp skips its formats entirely -
 * which is why this argument is only applied together with a provider that can
 * supply one.
 */
export const DEFAULT_POT_PLAYER_CLIENT = 'mweb';

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
 * @param {{ provider?: string, serverHome?: string, playerClient?: string }} options
 * @returns {string[]} zero, one or two `--extractor-args` values
 */
export function buildExtractorArgs({
  provider = POT_PROVIDER_NONE,
  serverHome = DEFAULT_POT_SERVER_HOME,
  playerClient = DEFAULT_POT_PLAYER_CLIENT,
} = {}) {
  if (provider !== POT_PROVIDER_BGUTIL_SCRIPT) return [];
  return [
    `youtube:player_client=${playerClient}`,
    `youtubepot-bgutilscript:server_home=${serverHome}`,
  ];
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
