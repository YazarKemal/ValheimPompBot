import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, describeConfig, loadConfig, parseEnv } from '../src/config/index.js';
import { ENV_SCHEMA } from '../src/config/schema.js';

const VALID_TOKEN = 'A'.repeat(30) + '.' + 'B'.repeat(6) + '.' + 'C'.repeat(30);
const VALID_ENV = {
  DISCORD_TOKEN: VALID_TOKEN,
  DISCORD_CLIENT_ID: '123456789012345678',
  DISCORD_GUILD_ID: '987654321098765432',
};

test('parseEnv reports every missing required variable at once', () => {
  const { config, issues } = parseEnv({});

  assert.equal(config, null);
  const keys = issues.map((issue) => issue.key);
  assert.ok(keys.includes('DISCORD_TOKEN'));
  assert.ok(keys.includes('DISCORD_CLIENT_ID'));
});

test('parseEnv accepts a complete environment and applies defaults', () => {
  const { config, issues } = parseEnv(VALID_ENV);

  assert.deepEqual(issues, []);
  assert.equal(config.discord.token, VALID_TOKEN);
  assert.equal(config.discord.clientId, '123456789012345678');
  assert.equal(config.discord.guildId, '987654321098765432');
  assert.equal(config.env, 'development');
  assert.equal(config.logLevel, 'info');
  assert.equal(config.dryRun, true);
  assert.equal(config.connect, false);
  assert.equal(config.ai.provider, 'stub');
  assert.equal(config.ai.timeoutMs, 30000);
});

test('the returned config is frozen', () => {
  const { config } = parseEnv(VALID_ENV);
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.discord));
  assert.ok(Object.isFrozen(config.ai));
});

test('booleans accept common spellings and reject nonsense', () => {
  for (const truthy of ['true', 'TRUE', '1', 'yes', 'on']) {
    const { config } = parseEnv({ ...VALID_ENV, DRY_RUN: truthy });
    assert.equal(config.dryRun, true, `"${truthy}" should be true`);
  }
  for (const falsy of ['false', 'FALSE', '0', 'no', 'off']) {
    const { config } = parseEnv({ ...VALID_ENV, DRY_RUN: falsy });
    assert.equal(config.dryRun, false, `"${falsy}" should be false`);
  }

  const { config, issues } = parseEnv({ ...VALID_ENV, DRY_RUN: 'maybe' });
  assert.equal(config, null);
  assert.equal(issues[0].key, 'DRY_RUN');
});

test('enum and numeric validation catch bad values', () => {
  assert.equal(parseEnv({ ...VALID_ENV, LOG_LEVEL: 'verbose' }).issues[0].key, 'LOG_LEVEL');
  assert.equal(parseEnv({ ...VALID_ENV, AI_PROVIDER: 'gpt5' }).issues[0].key, 'AI_PROVIDER');
  assert.equal(parseEnv({ ...VALID_ENV, AI_TIMEOUT_MS: '10' }).issues[0].key, 'AI_TIMEOUT_MS');
  assert.equal(parseEnv({ ...VALID_ENV, AI_TIMEOUT_MS: 'soon' }).issues[0].key, 'AI_TIMEOUT_MS');
});

test('a placeholder token is rejected with a helpful problem', () => {
  const { config, issues } = parseEnv({ ...VALID_ENV, DISCORD_TOKEN: 'your-bot-token-here' });

  assert.equal(config, null);
  const issue = issues.find((entry) => entry.key === 'DISCORD_TOKEN');
  assert.match(issue.problem, /placeholder/);
});

test('snowflake fields are validated', () => {
  assert.equal(parseEnv({ ...VALID_ENV, DISCORD_CLIENT_ID: 'not-a-snowflake' }).issues[0].key, 'DISCORD_CLIENT_ID');
  assert.equal(parseEnv({ ...VALID_ENV, DISCORD_GUILD_ID: '123' }).issues[0].key, 'DISCORD_GUILD_ID');
});

test('an empty guild id means global registration, not an error', () => {
  const { config, issues } = parseEnv({ ...VALID_ENV, DISCORD_GUILD_ID: '' });

  assert.deepEqual(issues, []);
  assert.equal(config.discord.guildId, null);
});

test('requireDiscord:false lets setup run fully offline', () => {
  const { config, issues } = parseEnv({}, { requireDiscord: false });

  assert.deepEqual(issues, []);
  assert.equal(config.discord.token, null);
  assert.equal(config.discord.clientId, null);
});

test('loadConfig throws a ConfigError listing the problems', () => {
  assert.throws(
    () => loadConfig({ env: {}, loadDotenv: false }),
    (error) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.code, 'CONFIG_INVALID');
      assert.match(error.message, /Configuration is invalid/);
      assert.ok(error.issues.some((issue) => issue.key === 'DISCORD_TOKEN'));
      return true;
    },
  );
});

test('error messages never contain the secret value', () => {
  const secret = 'SuperSecretTokenValueThatMustNotLeak1234567890';
  let thrown;

  try {
    loadConfig({ env: { DISCORD_TOKEN: secret, DISCORD_CLIENT_ID: 'nope' }, loadDotenv: false });
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof ConfigError);
  const serialised = `${thrown.message}${JSON.stringify(thrown.details)}${thrown.stack}`;
  assert.ok(!serialised.includes(secret), 'the token leaked into the error output');
});

test('describeConfig redacts secrets but keeps the shape', () => {
  const { config } = parseEnv({ ...VALID_ENV, AI_API_KEY: 'sk-should-not-appear' });
  const description = describeConfig(config);
  const serialised = JSON.stringify(description);

  assert.ok(!serialised.includes(VALID_TOKEN));
  assert.ok(!serialised.includes('sk-should-not-appear'));
  assert.equal(description.discord.token, '[redacted]');
  assert.equal(description.ai.apiKey, '[redacted]');
  assert.equal(description.discord.clientId, '123456789012345678');
});

test('a real environment variable overrides the .env file', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');

  const directory = await mkdtemp(path.join(tmpdir(), 'pompbot-env-'));
  const dotenvPath = path.join(directory, '.env');
  await writeFile(dotenvPath, 'BOT_CONNECT=true\nLOG_LEVEL=debug\n', 'utf8');

  const config = loadConfig({
    env: { BOT_CONNECT: 'false' },
    loadDotenv: true,
    dotenvPath,
    requireDiscord: false,
  });

  // The explicit env wins; the file supplies everything else.
  assert.equal(config.connect, false, '.env overrode a real environment variable');
  assert.equal(config.logLevel, 'debug', 'the file value was not used as a fallback');
});

test('every schema entry documents itself', () => {
  for (const field of ENV_SCHEMA) {
    assert.equal(typeof field.key, 'string');
    assert.equal(typeof field.description, 'string');
    assert.ok(field.description.length > 0, `${field.key} has no description`);
  }
});
