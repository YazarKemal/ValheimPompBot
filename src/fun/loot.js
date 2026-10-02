/**
 * The mining table.
 *
 * Every outcome, its rarity and its reward range live here, on the server. The
 * client never supplies an amount, an item key or a result - the only thing a
 * caller contributes is a random number, and a test can supply its own.
 *
 * Weights are per mille, so the table reads directly as odds and the sum is a
 * round 1000. Run `validateLootTable()` after editing.
 */

/** Coin and XP ranges are inclusive. `item: false` means nothing is collected. */
export const MINE_OUTCOMES = Object.freeze([
  { key: 'tas', emoji: '🪨', label: 'Taş', weight: 340, coins: [2, 6], xp: [3, 6], item: true, rare: false },
  { key: 'komur', emoji: '⚫', label: 'Kömür', weight: 250, coins: [6, 14], xp: [5, 9], item: true, rare: false },
  { key: 'demir', emoji: '🔩', label: 'Demir', weight: 180, coins: [14, 30], xp: [8, 14], item: true, rare: false },
  { key: 'altin', emoji: '🪙', label: 'Altın', weight: 100, coins: [30, 70], xp: [12, 20], item: true, rare: false },
  { key: 'zumrut', emoji: '💚', label: 'Zümrüt', weight: 55, coins: [60, 120], xp: [20, 32], item: true, rare: false },
  { key: 'elmas', emoji: '💎', label: 'Elmas', weight: 25, coins: [110, 220], xp: [35, 55], item: true, rare: true },
  { key: 'fosil', emoji: '🦴', label: 'Fosil', weight: 14, coins: [80, 160], xp: [30, 50], item: true, rare: true },
  // The one the whole table exists for: 0.4%. It should feel like an event.
  { key: 'nugget', emoji: '✨', label: 'Efsanevi Nugget', weight: 4, coins: [400, 800], xp: [120, 200], item: true, rare: true },
  // A cave-in costs the trip: no ore, no coins, a little XP for the trouble.
  { key: 'gocuk', emoji: '💀', label: 'Göçük', weight: 26, coins: [0, 0], xp: [1, 3], item: false, rare: false },
  { key: 'fare', emoji: '🐀', label: 'Mağara Faresi', weight: 6, coins: [1, 4], xp: [1, 2], item: true, rare: false },
]);

/** Outcomes counted as a "rare find" on the profile. */
export const RARE_ITEM_KEYS = Object.freeze(
  MINE_OUTCOMES.filter((outcome) => outcome.rare).map((outcome) => outcome.key),
);

const BY_KEY = new Map(MINE_OUTCOMES.map((outcome) => [outcome.key, outcome]));

const TOTAL_WEIGHT = MINE_OUTCOMES.reduce((total, outcome) => total + outcome.weight, 0);

/**
 * Whether a key is one the server defines.
 *
 * The inventory accepts nothing else, which is what stops it growing with
 * arbitrary user-supplied keys.
 *
 * @param {unknown} key
 */
export function isItemKey(key) {
  return typeof key === 'string' && BY_KEY.has(key);
}

/** The outcome definition for a key, or null. */
export function outcomeFor(key) {
  return BY_KEY.get(key) ?? null;
}

/** Human label for an inventory row. */
export function describeItem(key) {
  const outcome = BY_KEY.get(key);
  return outcome ? `${outcome.emoji} ${outcome.label}` : `❔ ${key}`;
}

export function totalWeight() {
  return TOTAL_WEIGHT;
}

/**
 * Draws one outcome from the weighted table.
 *
 * @param {() => number} [random] Injectable so tests are deterministic.
 */
export function pickOutcome(random = Math.random) {
  const roll = clampUnit(random()) * TOTAL_WEIGHT;

  let cumulative = 0;
  for (const outcome of MINE_OUTCOMES) {
    cumulative += outcome.weight;
    // Strictly less-than: a roll of exactly 0 must not fall through the first
    // bucket and a roll at the top must not run off the end.
    if (roll < cumulative) return outcome;
  }
  return MINE_OUTCOMES[MINE_OUTCOMES.length - 1];
}

/**
 * A whole number inside an inclusive range.
 *
 * @param {[number, number]} range
 * @param {() => number} [random]
 */
export function rollRange(range, random = Math.random) {
  const [min, max] = range;
  if (max <= min) return min;
  return min + Math.floor(clampUnit(random()) * (max - min + 1));
}

/** Keeps an injected random inside [0, 1) so index maths can never overflow. */
function clampUnit(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  if (number >= 1) return 1 - Number.EPSILON;
  return number;
}

/**
 * Checks the table is internally consistent.
 *
 * Exported so a build can assert it rather than trusting a hand-edited literal:
 * a typo in a weight is otherwise a silent change to the drop rates.
 *
 * @returns {string[]} problems, empty when the table is sound
 */
export function validateLootTable() {
  const problems = [];
  const seen = new Set();

  for (const outcome of MINE_OUTCOMES) {
    const where = `outcome "${outcome.key}"`;

    if (seen.has(outcome.key)) problems.push(`${where}: duplicate key`);
    seen.add(outcome.key);

    if (!Number.isFinite(outcome.weight) || outcome.weight <= 0) {
      problems.push(`${where}: weight must be a positive number`);
    }
    for (const field of ['coins', 'xp']) {
      const range = outcome[field];
      if (!Array.isArray(range) || range.length !== 2) {
        problems.push(`${where}: ${field} must be a [min, max] pair`);
        continue;
      }
      const [min, max] = range;
      if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < min) {
        problems.push(`${where}: ${field} range ${JSON.stringify(range)} is not a valid ascending pair`);
      }
    }
    if (!outcome.emoji || !outcome.label) problems.push(`${where}: missing emoji or label`);
  }

  if (TOTAL_WEIGHT !== 1000) {
    problems.push(`weights total ${TOTAL_WEIGHT}, expected 1000 (they are per mille)`);
  }

  const rareWeight = MINE_OUTCOMES.filter((outcome) => outcome.rare).reduce(
    (total, outcome) => total + outcome.weight,
    0,
  );
  if (rareWeight / TOTAL_WEIGHT > 0.05) {
    problems.push(`rare outcomes together are ${((rareWeight / TOTAL_WEIGHT) * 100).toFixed(1)}% - over the 5% ceiling`);
  }

  if (RARE_ITEM_KEYS.length === 0) problems.push('no outcome is marked rare');

  return problems;
}
