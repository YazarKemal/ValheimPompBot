/**
 * XP, levels and titles.
 *
 * All pure arithmetic: given an XP total, the level, the title and the progress
 * towards the next level are fully determined. Nothing here reads a database or
 * a clock, which is what makes the curve testable and impossible to drift
 * between the two places that display it.
 */

/** Levels stop here, so the curve cannot run away at the top end. */
export const MAX_LEVEL = 100;

/** XP for the step from level 1 to 2. */
const XP_BASE = 60;

/** Extra XP each subsequent step costs, per step already taken. */
const XP_GROWTH = 15;

/**
 * Titles by minimum level.
 *
 * Cosmetic only. This phase deliberately creates no Discord roles: a role per
 * level would need permissions thought through, and a badge in a profile embed
 * needs none.
 */
export const TITLES = Object.freeze([
  Object.freeze({ level: 1, title: 'Çaylak Madenci' }),
  Object.freeze({ level: 5, title: 'Kazmacı' }),
  Object.freeze({ level: 10, title: 'Usta Kazmacı' }),
  Object.freeze({ level: 20, title: 'Maden Ustası' }),
  Object.freeze({ level: 35, title: 'Cevher Baronu' }),
  Object.freeze({ level: 50, title: 'Yeraltı Lordu' }),
]);

/**
 * Total XP needed to have reached `level`.
 *
 * Quadratic and monotonic: each level costs `XP_GROWTH` more than the last, so
 * early levels arrive quickly and later ones are a long haul.
 *
 * @param {number} level
 * @returns {number}
 */
export function xpToReach(level) {
  const steps = clampLevel(level) - 1;
  return XP_BASE * steps + XP_GROWTH * steps * (steps - 1);
}

/** Clamps any value into the valid level range. */
export function clampLevel(level) {
  const value = Math.floor(Number(level));
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_LEVEL, Math.max(1, value));
}

/**
 * The level an XP total corresponds to.
 *
 * @param {number} xp
 * @returns {number}
 */
export function levelFromXp(xp) {
  const value = Number.isFinite(Number(xp)) && Number(xp) > 0 ? Math.floor(Number(xp)) : 0;

  // Binary search: xpToReach is strictly increasing over the valid range.
  let low = 1;
  let high = MAX_LEVEL;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (xpToReach(mid) <= value) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** The title for a level: the highest threshold it has reached. */
export function titleForLevel(level) {
  const value = clampLevel(level);
  let title = TITLES[0].title;
  for (const entry of TITLES) {
    if (value >= entry.level) title = entry.title;
  }
  return title;
}

/**
 * Everything the profile and the level-up announcement need.
 *
 * @param {number} xp
 * @returns {{ level: number, title: string, xp: number, intoLevel: number, levelSpan: number, toNextLevel: number, ratio: number, maxed: boolean }}
 */
export function levelProgress(xp) {
  const total = Number.isFinite(Number(xp)) && Number(xp) > 0 ? Math.floor(Number(xp)) : 0;
  const level = levelFromXp(total);
  const floor = xpToReach(level);
  const ceiling = xpToReach(level + 1);
  const maxed = level >= MAX_LEVEL;
  const levelSpan = maxed ? 0 : ceiling - floor;

  return {
    level,
    title: titleForLevel(level),
    xp: total,
    intoLevel: total - floor,
    levelSpan,
    toNextLevel: maxed ? 0 : ceiling - total,
    ratio: maxed || levelSpan === 0 ? 1 : (total - floor) / levelSpan,
    maxed,
  };
}

/**
 * Formats a whole number with comma thousands separators.
 *
 * Written out rather than taken from `toLocaleString`, which would follow the
 * host locale and print `2.430` here and `2,430` elsewhere. The same XP total
 * must read identically in every profile embed.
 *
 * @param {number} value
 */
export function formatNumber(value) {
  const rounded = Math.trunc(Number(value) || 0);
  const sign = rounded < 0 ? '-' : '';
  return sign + String(Math.abs(rounded)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
