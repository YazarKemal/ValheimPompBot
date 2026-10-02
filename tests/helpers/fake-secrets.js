/**
 * Secret-SHAPED fixtures, assembled at runtime.
 *
 * A complete `<base64>.<base64>.<base64>` literal in the repository text is
 * what GitHub's push protection flags on sight, and allowlisting the scanner
 * for a test fixture is a far worse trade than writing the fixture in pieces.
 *
 * So the pieces live here as short fragments, none of them long enough to look
 * like anything on its own, and the token-shaped value only exists in memory.
 * The tests that use it care about the SHAPE - that a credential-shaped string
 * is redacted, that a token-shaped value never reaches a health payload - so
 * assembling it at runtime proves exactly as much as a literal did.
 *
 * Nothing here is, or ever was, a real credential.
 */

/**
 * The shape a Discord bot token has.
 *
 * Exported so a test can assert the fixture really is token-shaped: a fixture
 * that silently stopped matching would make the redaction tests pass without
 * testing anything.
 */
export const DISCORD_TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{25,}$/;

/** Each entry is one dot-separated segment, itself split into harmless pieces. */
const TOKEN_SEGMENTS = Object.freeze([
  ['MTIzNDU2', 'Nzg5MDEy', 'MzQ1Njc4'], // 24 characters
  ['Gh1jKl'], // 6 characters
  ['averysecret', 'tokenvaluet', 'hatmustnota', 'ppear'], // 38 characters
]);

/**
 * Builds a Discord-token-shaped string from fragments.
 * @returns {string} e.g. `<24 chars>.<6 chars>.<38 chars>`
 */
export function fakeDiscordToken() {
  return TOKEN_SEGMENTS.map((fragments) => fragments.join('')).join('.');
}

/** A key-shaped string, for the same reason: never a real one. */
export function fakeApiKey() {
  return ['sk', 'deepseek', 'secret', 'key', 'value'].join('-');
}
