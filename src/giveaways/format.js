/**
 * Turkish-facing formatting for giveaway announcements.
 *
 * Dates are always rendered in Europe/Istanbul, whatever the host's clock is
 * set to: the audience is Turkish and a giveaway ending at "23:00 UTC" is not
 * useful information to them.
 */

export const DISPLAY_TIME_ZONE = 'Europe/Istanbul';
export const DISPLAY_LOCALE = 'tr-TR';

/** Turkish label for the time zone, shown next to every time. */
export const TIME_ZONE_LABEL = 'TSİ';

const DATE_TIME_FORMAT = new Intl.DateTimeFormat(DISPLAY_LOCALE, {
  timeZone: DISPLAY_TIME_ZONE,
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/**
 * Renders an instant as e.g. `5 Ekim 2026 17:00 TSİ`.
 *
 * @param {string|Date|null|undefined} value
 * @returns {string|null} null when there is nothing usable to show
 */
export function formatDateTime(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${DATE_TIME_FORMAT.format(date)} ${TIME_ZONE_LABEL}`;
}

/**
 * Renders a price.
 *
 * The store's own formatted string is preferred when present - it already uses
 * the right symbol and separators for its region. `Intl` is the fallback, and a
 * bare number is the last resort.
 *
 * @param {{amount: number|null, currency: string|null, formatted: string|null}|null} price
 * @returns {string|null}
 */
export function formatPrice(price) {
  if (!price) return null;
  if (price.formatted) return price.formatted;
  if (!Number.isFinite(price.amount)) return null;

  if (price.currency) {
    try {
      return new Intl.NumberFormat(DISPLAY_LOCALE, {
        style: 'currency',
        currency: price.currency,
        maximumFractionDigits: 2,
      }).format(price.amount);
    } catch {
      // Unknown currency code; fall through to the plain form.
    }
  }
  return `${price.amount} ${price.currency ?? ''}`.trim();
}

/**
 * Remaining time in words, for the "ends soon" case.
 * @param {string|null} endsAt
 * @param {number} [now]
 * @returns {string|null}
 */
export function formatRemaining(endsAt, now = Date.now()) {
  if (!endsAt) return null;
  const remainingMs = new Date(endsAt).getTime() - now;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return null;

  const hours = Math.floor(remainingMs / 3_600_000);
  if (hours >= 48) return `${Math.floor(hours / 24)} gün kaldı`;
  if (hours >= 1) return `${hours} saat kaldı`;
  return `${Math.max(1, Math.floor(remainingMs / 60_000))} dakika kaldı`;
}
