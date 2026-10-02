import path from 'node:path';

/**
 * Where the process is running, and what that means for its files.
 *
 * The fun economy is a SQLite file and the giveaway ledger is a JSON file. Both
 * are real, durable state, and both live on the local filesystem - which is
 * exactly the thing a container platform does not keep. Losing them is not
 * catastrophic (a giveaway could be announced twice, XP could reset) but it is
 * not something to discover by surprise either.
 *
 * This module answers that question honestly and does not act on it. Nothing is
 * migrated, moved or disabled here: it reports, and the caller warns.
 */

export const PLATFORMS = Object.freeze({
  RENDER: 'render',
  LOCAL: 'local',
});

export const PLATFORM_SETTING = Object.freeze({
  AUTO: 'auto',
  RENDER: 'render',
  LOCAL: 'local',
});

/**
 * Detects the platform.
 *
 * An explicit `DEPLOY_PLATFORM` always wins, so the behaviour can be forced for
 * a test or reproduced locally. Otherwise Render's own marker is used: it sets
 * `RENDER=true` in every service, with the service id as a second signal.
 *
 * @param {Record<string, string|undefined>} [env]
 * @param {string} [configured] The `DEPLOY_PLATFORM` value.
 * @returns {'render'|'local'}
 */
export function detectPlatform(env = {}, configured = PLATFORM_SETTING.AUTO) {
  if (configured === PLATFORM_SETTING.RENDER) return PLATFORMS.RENDER;
  if (configured === PLATFORM_SETTING.LOCAL) return PLATFORMS.LOCAL;

  if (isTruthy(env.RENDER)) return PLATFORMS.RENDER;
  // Belt and braces: these are set by Render even if RENDER itself is renamed.
  if (env.RENDER_SERVICE_ID || env.RENDER_EXTERNAL_HOSTNAME || env.RENDER_SERVICE_NAME) {
    return PLATFORMS.RENDER;
  }
  return PLATFORMS.LOCAL;
}

function isTruthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

/**
 * The runtime state this process writes, and where it goes.
 *
 * Both entries are files the bot creates and updates while it runs. They are
 * listed here rather than discovered so that adding a third one is a deliberate
 * act with a place to put it.
 *
 * @param {object} options
 * @param {string} options.funDbFile
 * @param {string} options.giveawayStateFile
 * @param {string} [options.root] Project root, used for display paths.
 */
export function stateInventory({ funDbFile, giveawayStateFile, root = null }) {
  const entries = [
    { key: 'fun', label: 'fun economy (SQLite)', path: funDbFile, kind: 'sqlite' },
    { key: 'giveaways', label: 'giveaway state (JSON)', path: giveawayStateFile, kind: 'json' },
  ];

  return entries.map((entry) => ({
    ...entry,
    displayPath: root ? relativeDisplayPath(entry.path, root) : entry.path,
  }));
}

/** A repo-relative path for logs, always with forward slashes. */
function relativeDisplayPath(file, root) {
  const relative = path.relative(root, file);
  if (!relative) return file;
  // Windows produces backslashes; a log line should read the same everywhere.
  return relative.split(path.sep).join('/');
}

/** Whether `file` sits inside `directory`. */
export function isInside(file, directory) {
  if (!file || !directory) return false;
  const relative = path.relative(path.resolve(directory), path.resolve(file));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Describes persistence for the current platform.
 *
 * A platform is only "ephemeral" when the files are NOT on a mounted disk. If
 * every state file sits under `PERSISTENT_STORAGE_PATH`, the operator has done
 * the one thing that makes them durable and there is nothing to warn about.
 *
 * @param {object} options
 * @param {'render'|'local'} options.platform
 * @param {object[]} options.entries From `stateInventory`.
 * @param {string|null} [options.diskPath] The mounted persistent path, if any.
 * @returns {{ platform: string, ephemeral: boolean, diskPath: string|null, entries: object[], warning: string|null, note: string|null }}
 */
export function describePersistence({ platform, entries = [], diskPath = null }) {
  const resolvedDisk = diskPath && String(diskPath).trim() !== '' ? path.resolve(String(diskPath).trim()) : null;

  const annotated = entries.map((entry) => ({
    ...entry,
    onPersistentDisk: resolvedDisk ? isInside(entry.path, resolvedDisk) : false,
  }));

  const durable = resolvedDisk !== null && annotated.length > 0 && annotated.every((entry) => entry.onPersistentDisk);
  const ephemeral = platform === PLATFORMS.RENDER && !durable;

  if (!ephemeral) {
    return {
      platform,
      ephemeral: false,
      diskPath: resolvedDisk,
      entries: annotated,
      warning: null,
      note: durable ? 'Runtime state is on the persistent disk.' : null,
    };
  }

  const names = annotated.map((entry) => `${entry.label} (${entry.displayPath})`).join(' and ');
  return {
    platform,
    ephemeral: true,
    diskPath: resolvedDisk,
    entries: annotated,
    warning:
      `Render ephemeral filesystem detected: ${names} may be lost on restart. ` +
      'XP, coins, inventories, daily streaks and announced giveaways all live in those files. ' +
      'Attach a Render disk and point FUN_DB_FILE, FREE_GAMES_STATE_FILE and PERSISTENT_STORAGE_PATH at it.',
    note: null,
  };
}
