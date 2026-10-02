import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Persistent record of what has already been announced.
 *
 * Without this, every restart would re-post every currently running giveaway -
 * the single most annoying possible bug in a feature like this.
 *
 * Design:
 *   - one small JSON file, written atomically (temp file + rename) so a crash
 *     mid-write cannot leave a truncated file that fails to parse;
 *   - keyed by `provider:productId`, so a repeat promotion months later is a
 *     new announcement once the old entry has been pruned;
 *   - a corrupt or missing file is treated as empty, never fatal.
 */

export const DEFAULT_RETENTION_DAYS = 60;

export class GiveawayStore {
  /**
   * @param {object} [options]
   * @param {string} options.filePath State file path.
   * @param {number} [options.retentionDays] How long an expired entry is kept.
   * @param {() => number} [options.now]
   */
  constructor({ filePath, retentionDays = DEFAULT_RETENTION_DAYS, now = () => Date.now() } = {}) {
    if (!filePath) throw new TypeError('GiveawayStore requires a filePath');
    this.filePath = filePath;
    this.retentionDays = retentionDays;
    this.now = now;
    /** @type {Map<string, {key: string, provider: string, id: string, title: string, announcedAt: string, endsAt: string|null}>} */
    this.entries = new Map();
    this.loaded = false;
  }

  /**
   * Reads the state file. A missing or unreadable file yields an empty store
   * rather than an exception: losing the file means one round of duplicate
   * posts, not a broken bot.
   */
  async load() {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
      this.entries = new Map(entries.filter((entry) => entry?.key).map((entry) => [entry.key, entry]));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // Corrupt state is survivable; do not take the bot down over it.
        this.entries = new Map();
        this.loadError = error;
      }
    }
    this.loaded = true;
    return this;
  }

  /** @param {string} key */
  has(key) {
    return this.entries.has(key);
  }

  get size() {
    return this.entries.size;
  }

  /**
   * Records a giveaway as announced and persists immediately.
   * @param {object} giveaway
   */
  async markAnnounced(giveaway) {
    this.entries.set(giveaway.key, {
      key: giveaway.key,
      provider: giveaway.provider,
      id: giveaway.id,
      title: giveaway.title,
      announcedAt: new Date(this.now()).toISOString(),
      endsAt: giveaway.endsAt ?? null,
    });
    await this.save();
  }

  /**
   * Drops entries whose giveaway ended longer ago than the retention window.
   *
   * Only entries with a known end date are pruned. An entry with no end date is
   * kept forever: the cost of remembering it is a few bytes, and the cost of
   * forgetting it is re-announcing the same giveaway.
   *
   * @returns {Promise<number>} how many entries were dropped
   */
  async prune() {
    const cutoff = this.now() - this.retentionDays * 24 * 60 * 60 * 1000;
    let dropped = 0;

    for (const [key, entry] of this.entries) {
      if (!entry.endsAt) continue;
      const endedAt = new Date(entry.endsAt).getTime();
      if (Number.isFinite(endedAt) && endedAt < cutoff) {
        this.entries.delete(key);
        dropped += 1;
      }
    }

    if (dropped > 0) await this.save();
    return dropped;
  }

  /**
   * Writes the state file atomically.
   *
   * The rename is the atomic step: a reader either sees the previous file or
   * the complete new one, never a half-written document.
   */
  async save() {
    const payload = {
      version: 1,
      updatedAt: new Date(this.now()).toISOString(),
      entries: [...this.entries.values()],
    };

    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await rename(temporary, this.filePath);
  }
}
