/**
 * Search ranking and confidence.
 *
 * A raw search returns whatever the provider thinks is relevant, which for a
 * song name is routinely a reaction video, a ten-hour loop or a trailer. This
 * module turns that list into an *ordered* list with a defensible reason, and
 * decides whether the top hit is trustworthy enough to play without asking.
 *
 * Pure functions over plain objects: no network, no Discord, no audio.
 *
 * Weights are deliberately explicit rather than learned, so a wrong result can
 * be traced to a rule and adjusted in one line.
 */

/** Phrases that mean the result is not the song itself. */
export const PENALTIES = Object.freeze([
  { pattern: /\breaction\b/i, weight: -35, label: 'reaction' },
  { pattern: /\binterview\b/i, weight: -35, label: 'interview' },
  { pattern: /\bpodcast\b/i, weight: -30, label: 'podcast' },
  { pattern: /\btrailer\b|\bteaser\b/i, weight: -45, label: 'trailer' },
  { pattern: /\breview\b/i, weight: -30, label: 'review' },
  { pattern: /\bgameplay\b/i, weight: -35, label: 'gameplay' },
  { pattern: /\btutorial\b|\bhow to\b/i, weight: -30, label: 'tutorial' },
  { pattern: /\bbehind the scenes\b/i, weight: -30, label: 'behind-the-scenes' },
  { pattern: /\bshorts?\b/i, weight: -40, label: 'shorts' },
  { pattern: /\b(1|2|3|4|8|10|12|24)\s*hours?\b/i, weight: -45, label: 'hours-long' },
  { pattern: /\bloop(ed)?\b/i, weight: -25, label: 'loop' },
  { pattern: /\bcompilation\b|\bmegamix\b|\bplaylist\b/i, weight: -20, label: 'compilation' },
  { pattern: /\bkaraoke\b/i, weight: -25, label: 'karaoke' },
  { pattern: /\bcover\b/i, weight: -12, label: 'cover' },
  { pattern: /\blyrics?\b/i, weight: -6, label: 'lyrics' },
]);

/** Bonuses for signals that this really is the track. */
export const BONUSES = Object.freeze([
  // YouTube's auto-generated artist channels are labelled "<Artist> - Topic"
  // and carry the official audio.
  { pattern: /-\s*topic$/i, weight: 30, label: 'official-artist' },
  { pattern: /\bofficial\b/i, weight: 15, label: 'official' },
  { pattern: /\baudio\b/i, weight: 10, label: 'audio' },
]);

const IDEAL_MIN_SECONDS = 45;
const IDEAL_MAX_SECONDS = 600;

/**
 * Splits a query into comparable tokens.
 *
 * Plain `toLowerCase`, not the Turkish locale: `tr` maps an ASCII "I" to the
 * dotless "ı", so a query typed in capitals would stop matching a title written
 * in sentence case.
 */
export function tokenise(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1);
}

/**
 * Scores one result against the query. Higher is better; the scale is
 * arbitrary but comparable between results.
 *
 * @param {object} result
 * @param {string} query
 * @returns {{ score: number, reasons: string[] }}
 */
export function scoreResult(result, query) {
  const reasons = [];
  let score = 0;

  const title = String(result?.title ?? '');
  const channel = String(result?.artist ?? result?.channelTitle ?? '');
  const haystack = `${title} ${channel}`;
  const tokens = tokenise(query);
  const titleTokens = new Set(tokenise(title));
  const channelTokens = new Set(tokenise(channel));

  // Relevance: how much of what was asked for appears in the title, then channel.
  if (tokens.length > 0) {
    const inTitle = tokens.filter((token) => titleTokens.has(token)).length;
    const inChannel = tokens.filter((token) => channelTokens.has(token)).length;
    score += (inTitle / tokens.length) * 50;
    score += (inChannel / tokens.length) * 20;
    if (inTitle === tokens.length) reasons.push('title-matches-query');
  }

  for (const rule of PENALTIES) {
    if (rule.pattern.test(haystack)) {
      score += rule.weight;
      reasons.push(`-${rule.label}`);
    }
  }
  for (const rule of BONUSES) {
    if (rule.pattern.test(channel) || (rule.label === 'audio' && rule.pattern.test(title))) {
      score += rule.weight;
      reasons.push(`+${rule.label}`);
    }
  }

  const duration = result?.durationSeconds;
  if (Number.isFinite(duration) && duration > 0) {
    if (duration < 30) {
      score -= 35;
      reasons.push('-too-short');
    } else if (duration >= IDEAL_MIN_SECONDS && duration <= IDEAL_MAX_SECONDS) {
      score += 12;
      reasons.push('+typical-length');
    } else if (duration > 3600) {
      score -= 60;
      reasons.push('-over-an-hour');
    }
  }

  return { score, reasons };
}

/**
 * Orders results best-first.
 *
 * @param {object[]} results
 * @param {string} query
 * @param {{ limit?: number }} [options]
 * @returns {Array<{track: object, score: number, reasons: string[]}>}
 */
export function rankResults(results, query, { limit = 5 } = {}) {
  return (Array.isArray(results) ? results : [])
    .map((track) => ({ track, ...scoreResult(track, query) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Tunables for when the top hit is trusted enough to play unasked. */
export const DEFAULT_CONFIDENCE = Object.freeze({
  /** Minimum score for the best result. */
  minScore: 40,
  /** How far ahead of the runner-up the best result must be. */
  minMargin: 8,
});

/**
 * Decides whether the best result can be played without asking.
 *
 * Ambiguity is not a failure: it means the bot should show the choices rather
 * than guess. Playing the wrong song in a shared channel is worse than a short
 * menu.
 *
 * @param {Array<{track: object, score: number}>} ranked
 * @param {{ minScore?: number, minMargin?: number }} [options]
 * @returns {{ confident: boolean, reason: string, top: object|null }}
 */
export function assessConfidence(ranked, options = {}) {
  const { minScore, minMargin } = { ...DEFAULT_CONFIDENCE, ...options };

  if (!Array.isArray(ranked) || ranked.length === 0) {
    return { confident: false, reason: 'no-results', top: null };
  }

  const [top, runnerUp] = ranked;
  if (top.score < minScore) {
    return { confident: false, reason: 'low-score', top };
  }
  if (runnerUp && top.score - runnerUp.score < minMargin) {
    return { confident: false, reason: 'too-close', top };
  }
  return { confident: true, reason: 'clear-winner', top };
}
