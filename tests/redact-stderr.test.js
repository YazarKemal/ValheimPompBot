import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeStderr, MAX_STDERR_CHARS } from '../src/utils/redact.js';
import { safeErrorDetails, BotError } from '../src/utils/errors.js';
import { fakeDiscordToken, DISCORD_TOKEN_SHAPE } from './helpers/fake-secrets.js';

/**
 * The free-text sanitizer for third-party output.
 *
 * The point of logging yt-dlp's stderr is to find out why extraction failed, so
 * the useful error text must survive. The point of sanitizing it is that the
 * same output routinely contains media URLs whose query strings are signed
 * credentials. Both halves are asserted here.
 */

/* -------------------------------------------------------------------------- */
/* What must survive                                                           */
/* -------------------------------------------------------------------------- */

test('ordinary yt-dlp errors are preserved verbatim', () => {
  const cases = [
    'ERROR: unable to download video data: HTTP Error 403: Forbidden',
    "ERROR: [youtube] abc: Sign in to confirm you're not a bot. Use --cookies-from-browser",
    'ERROR: [youtube] PO Token not provided; some formats may be missing',
    'ERROR: Requested format is not available. Use --list-formats for a list of available formats',
    'ERROR: Video unavailable',
  ];

  for (const text of cases) {
    assert.equal(sanitizeStderr(text), text, `the message was altered: ${text}`);
  }
});

test('the diagnosis is still readable after the URLs are stripped', () => {
  const output = sanitizeStderr(
    'ERROR: unable to download video data: HTTP Error 403: Forbidden\n' +
      '  url: https://rr3---sn-abc.googlevideo.com/videoplayback?expire=1&sig=SECRET',
  );

  assert.match(output, /HTTP Error 403/);
  assert.match(output, /rr3---sn-abc\.googlevideo\.com/, 'the host is what says who refused');
  assert.ok(!output.includes('SECRET'), 'the signature survived');
});

/* -------------------------------------------------------------------------- */
/* What must not                                                               */
/* -------------------------------------------------------------------------- */

test('a URL keeps its host and loses its query string', () => {
  const output = sanitizeStderr('url: https://www.youtube.com/watch?v=abc123&list=PL1&t=30');

  assert.match(output, /https:\/\/www\.youtube\.com\/watch/);
  assert.ok(!output.includes('abc123'), 'the query survived');
  assert.ok(!output.includes('PL1'));
  assert.match(output, /\?\[redacted\]/, 'the removal is not visible');
});

test('a URL with no query is left alone', () => {
  assert.equal(sanitizeStderr('see https://github.com/yt-dlp/yt-dlp/wiki/FAQ'), 'see https://github.com/yt-dlp/yt-dlp/wiki/FAQ');
});

test('trailing punctuation after a URL is not eaten', () => {
  const output = sanitizeStderr('failed at https://example.com/a?sig=x.');
  assert.match(output, /\.$/, 'the sentence-ending period was consumed by the URL');
});

test('signature, token and expiry parameters never survive', () => {
  const signed =
    'https://rr3---sn-abc.googlevideo.com/videoplayback?expire=1759000000&ei=x&ip=1.2.3.4' +
    '&id=o-AB&itag=251&source=youtube&requiressl=yes&sig=SECRETSIG&lsparams=x&token=SECRETTOKEN';

  const output = sanitizeStderr(`url: ${signed}`);

  for (const secret of ['SECRETSIG', 'SECRETTOKEN', 'expire=1759000000', '1.2.3.4', 'o-AB']) {
    assert.ok(!output.includes(secret), `${secret} survived sanitization`);
  }
});

test('a whole cookie header is masked, not just its first pair', () => {
  const output = sanitizeStderr('cookie: SID=abc123; HSID=def456; __Secure-1PSID=xyz789');

  assert.match(output, /cookie: \[redacted\]/);
  assert.ok(!output.includes('def456'), 'the second cookie pair survived');
  assert.ok(!output.includes('xyz789'), 'the third cookie pair survived');
});

test('assigned credentials are masked but keep their label', () => {
  const cases = [
    ['token=abc123', /token=\[redacted\]/],
    ['sig=zzz999', /sig=\[redacted\]/],
    ['api_key: KEY123', /api_key: \[redacted\]/],
    ['Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def', /Authorization: Bearer \[redacted\]/],
    ['session_id=SESS123', /session_id=\[redacted\]/],
  ];

  for (const [input, pattern] of cases) {
    const output = sanitizeStderr(input);
    assert.match(output, pattern, `not masked as expected: ${output}`);
  }
});

test('a PO Token label survives even when its value does not', () => {
  const output = sanitizeStderr('PO Token: eyJhbGciOiJIUzI1NiJ9.long.value');

  assert.match(output, /PO Token/, 'the failure is unrecognisable without the label');
  assert.ok(!output.includes('eyJhbGciOiJIUzI1NiJ9.long.value'));
});

test('a PO token is masked in every shape yt-dlp prints it', () => {
  // A PO token is a credential - it is the whole reason this project does not
  // use cookies - and yt-dlp's own debug output prints it in full.
  const cases = [
    "PoTokenResponse(po_token='eyJhbGciOiJIUzI1NiJ9.payload.sig', expires_at=1)",
    'po_token=eyJhbGciOiJIUzI1NiJ9.payload.sig',
    'po-token: eyJhbGciOiJIUzI1NiJ9.payload.sig',
    'PO Token = "eyJhbGciOiJIUzI1NiJ9.payload.sig"',
  ];

  for (const input of cases) {
    const output = sanitizeStderr(input);
    assert.ok(!output.includes('eyJhbGciOiJIUzI1NiJ9'), `the token survived: ${output}`);
    assert.match(output, /\[redacted\]/);
  }
});

test('a PO token label with nothing after it is left alone', () => {
  // The word is a diagnosis - "PO Token not provided" is exactly what a log
  // needs to say - so only a value is removed.
  assert.equal(
    sanitizeStderr('ERROR: [youtube] PO Token not provided; some formats may be missing'),
    'ERROR: [youtube] PO Token not provided; some formats may be missing',
  );
});

test('a Discord-shaped token is masked wherever it appears', () => {
  // Assembled at runtime - see tests/helpers/fake-secrets.js for why.
  const token = fakeDiscordToken();

  // Without this the test could pass by sanitizing something that was never
  // token-shaped to begin with.
  assert.match(token, DISCORD_TOKEN_SHAPE, 'the fixture is no longer token-shaped');

  const output = sanitizeStderr(`failed with ${token}`);

  assert.ok(!output.includes(token), 'a bot token survived sanitization');
  assert.match(output, /\[redacted\]/);
});

/* -------------------------------------------------------------------------- */
/* Shape                                                                       */
/* -------------------------------------------------------------------------- */

test('the result is bounded, and the bound includes the marker', () => {
  const output = sanitizeStderr('x'.repeat(5000));

  assert.equal(output.length, MAX_STDERR_CHARS);
  assert.match(output, /…\[truncated\]$/);
});

test('a short message is not marked as truncated', () => {
  assert.ok(!sanitizeStderr('ERROR: Video unavailable').includes('truncated'));
});

test('sanitizing twice changes nothing', () => {
  const once = sanitizeStderr(
    'ERROR: unable to download https://x.example.com/v?a=1&sig=S\ncookie: SID=abc; HSID=def',
  );
  assert.equal(sanitizeStderr(once), once);
});

test('nothing to show is reported as nothing', () => {
  assert.equal(sanitizeStderr(''), null);
  assert.equal(sanitizeStderr('   \n  '), null);
  assert.equal(sanitizeStderr(null), null);
  assert.equal(sanitizeStderr(undefined), null);
  assert.equal(sanitizeStderr({ stderr: 'x' }), null);
});

test('windows line endings are normalised', () => {
  assert.equal(sanitizeStderr('ERROR: one\r\nERROR: two'), 'ERROR: one\nERROR: two');
});

/* -------------------------------------------------------------------------- */
/* safeErrorDetails                                                            */
/* -------------------------------------------------------------------------- */

test('safeErrorDetails copies the diagnostic fields and sanitizes the text', () => {
  const error = new BotError('yt-dlp exited before producing any audio.', {
    code: 'MUSIC_YTDLP_EXITED',
    details: {
      exitCode: 1,
      signal: null,
      bytes: 0,
      stderrBytes: 120,
      stderrTruncated: false,
      stderr: 'ERROR: HTTP Error 403: Forbidden\nurl: https://x.example.com/v?sig=SECRET',
    },
  });

  const safe = safeErrorDetails(error);

  assert.equal(safe.exitCode, 1);
  assert.equal(safe.bytes, 0);
  assert.equal(safe.stderrBytes, 120);
  assert.equal(safe.stderrTruncated, false);
  assert.match(safe.sanitizedStderr, /HTTP Error 403/);
  assert.ok(!safe.sanitizedStderr.includes('SECRET'));
  assert.ok(!('stderr' in safe), 'raw stderr must not travel');
});

test('safeErrorDetails drops anything not on the allow-list', () => {
  const error = new BotError('nope', {
    code: 'MUSIC_YTDLP_EXITED',
    details: { exitCode: 1, cookies: 'SID=abc', authorization: 'Bearer x', headers: { a: 1 } },
  });

  const safe = safeErrorDetails(error);

  assert.deepEqual(Object.keys(safe), ['exitCode'], 'an unexpected field was passed through');
});

test('safeErrorDetails tolerates errors without details', () => {
  assert.deepEqual(safeErrorDetails(new Error('plain')), {});
  assert.deepEqual(safeErrorDetails(null), {});
  assert.deepEqual(safeErrorDetails({}), {});
});
