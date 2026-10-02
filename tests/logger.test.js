import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCapturingLogger, createLogger, createNullLogger } from '../src/utils/logger.js';
import { isSecretKey, redact } from '../src/utils/redact.js';

const FIXED_TIME = () => new Date('2026-01-02T03:04:05.000Z');

test('redact masks credential-shaped keys', () => {
  for (const key of ['token', 'DISCORD_TOKEN', 'apiKey', 'api_key', 'password', 'authorization', 'clientSecret']) {
    assert.equal(isSecretKey(key), true, `${key} should be treated as a secret`);
  }
  for (const key of ['maxTokens', 'model', 'author', 'clientId', 'timeoutMs', 'name']) {
    assert.equal(isSecretKey(key), false, `${key} should not be treated as a secret`);
  }
});

test('redact masks Discord-token-shaped strings anywhere', () => {
  const token = `${'M'.repeat(24)}.${'X'.repeat(6)}.${'Y'.repeat(38)}`;
  assert.ok(!redact(`login failed for ${token}`).includes(token));
  assert.ok(!redact({ message: token }).message.includes(token));
});

test('redact walks nested structures', () => {
  const input = {
    discord: { token: 'abc', clientId: '123' },
    ai: { apiKey: 'k', model: 'm' },
    list: [{ secret: 'x' }],
  };
  const output = redact(input);

  assert.equal(output.discord.token, '[redacted]');
  assert.equal(output.discord.clientId, '123');
  assert.equal(output.ai.apiKey, '[redacted]');
  assert.equal(output.ai.model, 'm');
  assert.equal(output.list[0].secret, '[redacted]');
});

test('redact handles errors and cycles without throwing', () => {
  const error = new Error('boom');
  error.code = 'E_BOOM';
  assert.deepEqual(redact(error), { name: 'Error', message: 'boom', code: 'E_BOOM' });

  const cyclic = { name: 'root' };
  cyclic.self = cyclic;
  assert.doesNotThrow(() => redact(cyclic));
});

test('logger respects the configured level', () => {
  const { logger, lines } = createCapturingLogger({ level: 'warn', now: FIXED_TIME });

  logger.debug('d');
  logger.info('i');
  logger.warn('w');
  logger.error('e');

  assert.equal(lines.length, 2);
  assert.match(lines[0], /WARN\s+bot: w/);
  assert.match(lines[1], /ERROR\s+bot: e/);
});

test('logger formats a stable, greppable line', () => {
  const { logger, lines } = createCapturingLogger({ level: 'debug', name: 'pompbot', now: FIXED_TIME });

  logger.info('Preflight complete.', { commands: 3 });

  assert.match(lines[0], /^\[2026-01-02T03:04:05\.000Z\] INFO {2}pompbot: Preflight complete\./);
  assert.match(lines[0], /commands: 3/);
});

test('logger redacts bindings and metadata', () => {
  const { logger, text } = createCapturingLogger({
    level: 'debug',
    bindings: { token: 'super-secret-value' },
    now: FIXED_TIME,
  });

  logger.info('hello', { apiKey: 'another-secret' });

  assert.ok(!text().includes('super-secret-value'));
  assert.ok(!text().includes('another-secret'));
  assert.ok(text().includes('[redacted]'));
});

test('child loggers extend bindings without mutating the parent', () => {
  const { logger, text } = createCapturingLogger({ level: 'debug', bindings: { a: 1 }, now: FIXED_TIME });
  const child = logger.child({ b: 2 }, 'sub');

  child.info('from child');

  assert.match(text(), /bot:sub: from child/);
  assert.match(text(), /a: 1/);
  assert.match(text(), /b: 2/);
});

test('a default logger can be used without configuring one', () => {
  const logger = createNullLogger();
  assert.doesNotThrow(() => {
    logger.info('nobody hears this');
    logger.child({ x: 1 }).error('nor this');
  });
});

test('logger writes to the injected stream only', () => {
  const chunks = [];
  const logger = createLogger({
    level: 'info',
    stream: { write: (chunk) => chunks.push(chunk) },
    now: FIXED_TIME,
  });

  logger.info('captured');

  assert.equal(chunks.length, 1);
  assert.match(chunks[0], /captured/);
});
