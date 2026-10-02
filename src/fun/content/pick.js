/**
 * Chooses one entry from a bank.
 *
 * Every content bank draws through this, so all of them treat an injected
 * `random` the same way the loot table does: a value that is not a number in
 * [0, 1) is clamped rather than used as an index. That makes each picker total -
 * it always returns an entry from the bank, never `undefined` in a message.
 */
export function pickFrom(list, random = Math.random) {
  if (!Array.isArray(list) || list.length === 0) return null;

  const roll = Number(random());
  if (!Number.isFinite(roll) || roll <= 0) return list[0];
  if (roll >= 1) return list[list.length - 1];
  return list[Math.floor(roll * list.length)];
}
