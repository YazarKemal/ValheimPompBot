import { createFakeGuild } from './fake-guild.js';

/**
 * A live session backed by an in-memory guild.
 *
 * Mirrors the session contract from `src/setup/session.js` (guild / adapter /
 * refresh / close) so the whole live-apply pipeline - including the fresh
 * pre-apply snapshot and the post-apply convergence check - can be exercised
 * without a gateway connection.
 */
export function createFakeSession({
  id = 'guild-123456789012345678',
  name = 'MiningFools',
  seed = {},
} = {}) {
  const fake = createFakeGuild(seed);

  return {
    /** Identity only; the planner never reads a live guild directly. */
    guild: { id, name },

    adapter: fake.adapter,

    /** Fresh read of the underlying state, as a real refresh would produce. */
    async refresh() {
      return fake.snapshot();
    },

    async close() {
      this.closed = true;
    },

    closed: false,

    /** Test handles. */
    fake,
    state: () => fake.snapshot(),
    mutationCount: () => fake.mutationCount(),
  };
}

/**
 * A guild state resembling the real MiningFools server before the migration:
 * an existing #genel text channel, a "Genel" voice channel, and the two
 * pre-existing categories that must survive.
 */
export function miningFoolsSeed() {
  return {
    categories: [
      { id: 'cat-metin', name: 'Metin Kanalları' },
      { id: 'cat-ses', name: 'Ses Kanalları' },
    ],
    channels: [
      {
        id: 'chan-genel',
        name: 'genel',
        type: 'text',
        topic: 'Genel sohbet',
        parentName: 'Metin Kanalları',
        overwrites: [],
      },
      {
        id: 'chan-ses-genel',
        name: 'Genel',
        type: 'voice',
        topic: null,
        parentName: 'Ses Kanalları',
        overwrites: [],
      },
    ],
  };
}
