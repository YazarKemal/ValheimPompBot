import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAIClient } from '../src/ai/index.js';
import { AIProvider, normaliseRequest } from '../src/ai/provider.js';
import { createRegistry, ProviderRegistry } from '../src/ai/registry.js';
import { AIConfigurationError, AIProviderNotImplementedError } from '../src/ai/errors.js';
import { createCapturingLogger } from '../src/utils/logger.js';

const BASE = { provider: 'stub', apiKey: null, model: null, timeoutMs: 30000 };

/* -------------------------------------------------------------------------- */
/* Registry                                                                    */
/* -------------------------------------------------------------------------- */

test('every advertised provider is registered', () => {
  const registry = createRegistry();
  assert.deepEqual(registry.list(), ['deepseek', 'gemini', 'glm', 'openai', 'stub']);
});

test('an unknown provider is rejected with the available options', () => {
  const registry = createRegistry();

  assert.throws(
    () => registry.create('anthropic-claude', {}),
    (error) => {
      assert.equal(error.code, 'AI_CONFIGURATION_ERROR');
      assert.match(error.message, /Unknown AI provider/);
      assert.match(error.message, /stub/);
      return true;
    },
  );
});

test('double registration is refused unless explicitly replaced', () => {
  const registry = new ProviderRegistry();
  registry.register('custom', () => new AIProvider({ name: 'custom' }));

  assert.throws(() => registry.register('custom', () => {}), /already registered/);
  assert.doesNotThrow(() => registry.register('custom', () => {}, { replace: true }));
});

test('a non-function factory is refused', () => {
  assert.throws(() => new ProviderRegistry().register('x', 'not-a-factory'), AIConfigurationError);
});

test('registries are isolated from one another', () => {
  const a = new ProviderRegistry();
  const b = createRegistry();

  a.register('only-in-a', () => new AIProvider({ name: 'only-in-a' }));

  assert.equal(a.list().includes('only-in-a'), true);
  assert.equal(b.list().includes('only-in-a'), false);
});

/* -------------------------------------------------------------------------- */
/* Stub provider - the offline default                                         */
/* -------------------------------------------------------------------------- */

test('the stub provider is deterministic and offline', async () => {
  const client = createAIClient(BASE);

  const first = await client.complete({ messages: [{ role: 'user', content: 'Hello Valheim' }] });
  const second = await client.complete({ messages: [{ role: 'user', content: 'Hello Valheim' }] });

  assert.equal(first.text, second.text);
  assert.match(first.text, /Hello Valheim/);
  assert.equal(first.provider, 'stub');
  assert.equal(first.model, 'stub-echo-v1');
});

test('the stub provider reports a health check', async () => {
  const client = createAIClient(BASE);
  const health = await client.healthCheck();

  assert.equal(health.ok, true);
  assert.equal(health.provider, 'stub');
});

test('describe() exposes no credentials', () => {
  const client = createAIClient({ ...BASE, apiKey: 'sk-secret-value' });
  const description = JSON.stringify(client.describe());

  assert.ok(!description.includes('sk-secret-value'));
  assert.match(description, /stub/);
});

test('the raw provider payload is not forwarded to callers', async () => {
  const client = createAIClient(BASE);
  const response = await client.complete({ messages: [{ role: 'user', content: 'hi' }] });

  assert.equal(response.raw, undefined);
  assert.equal(typeof response.createdAt, 'string');
});

/* -------------------------------------------------------------------------- */
/* Unimplemented providers                                                     */
/* -------------------------------------------------------------------------- */

test('placeholder providers fail loudly and clearly', async () => {
  const registry = createRegistry();

  for (const name of ['openai', 'gemini', 'glm']) {
    const client = createAIClient({ ...BASE, provider: name, apiKey: 'placeholder' });

    await assert.rejects(
      () => client.complete({ messages: [{ role: 'user', content: 'hi' }] }),
      (error) => {
        assert.ok(error instanceof AIProviderNotImplementedError, `${name} threw ${error.name}`);
        assert.equal(error.code, 'AI_PROVIDER_NOT_IMPLEMENTED');
        assert.match(error.message, /Phase 2/);
        return true;
      },
    );

    const health = await client.healthCheck();
    assert.equal(health.ok, false, `${name} claimed to be healthy`);
  }
  assert.equal(registry.list().length, 5);
});

test('placeholder providers are reported as unconfigured', () => {
  const client = createAIClient({ ...BASE, provider: 'openai', apiKey: 'x' });
  assert.equal(client.describe().configured, false);
});

test('DeepSeek without a model refuses instead of picking a fallback', async () => {
  const client = createAIClient({ ...BASE, provider: 'deepseek', apiKey: 'sk-test' });

  assert.equal(client.describe().configured, false);
  await assert.rejects(
    () => client.complete({ messages: [{ role: 'user', content: 'hi' }] }),
    (error) => {
      assert.equal(error.code, 'AI_CONFIGURATION_ERROR');
      assert.match(error.message, /AI_MODEL/);
      return true;
    },
  );
});

test('a configured DeepSeek client reports itself as live and keeps its key secret', () => {
  const client = createAIClient({ ...BASE, provider: 'deepseek', apiKey: 'sk-deepseek-secret', model: 'deepseek-flash' });
  const description = client.describe();

  assert.equal(description.live, true);
  assert.equal(description.stub, false);
  assert.equal(description.model, 'deepseek-flash');
  assert.ok(!JSON.stringify(description).includes('sk-deepseek-secret'));
});

/* -------------------------------------------------------------------------- */
/* Request validation                                                          */
/* -------------------------------------------------------------------------- */

test('malformed requests are rejected before reaching a provider', async () => {
  const client = createAIClient(BASE);

  await assert.rejects(() => client.complete({}), AIConfigurationError);
  await assert.rejects(() => client.complete({ messages: [] }), AIConfigurationError);
  await assert.rejects(
    () => client.complete({ messages: [{ role: 'wizard', content: 'hi' }] }),
    AIConfigurationError,
  );
  await assert.rejects(() => client.complete({ messages: [{ role: 'user', content: '' }] }), AIConfigurationError);
});

test('normaliseRequest keeps optional fields and defaults the rest', () => {
  const normalised = normaliseRequest({
    messages: [{ role: 'user', content: 'hi' }],
    temperature: 0.5,
    maxTokens: 100,
  });

  assert.equal(normalised.temperature, 0.5);
  assert.equal(normalised.maxTokens, 100);
  assert.equal(normalised.model, null);
  assert.equal(normalised.system, null);
});

/* -------------------------------------------------------------------------- */
/* Provider contract                                                           */
/* -------------------------------------------------------------------------- */

test('the base provider refuses to complete', async () => {
  const provider = new AIProvider({ name: 'abstract' });
  await assert.rejects(() => provider.complete({}), /does not implement complete/);
});

test('a provider that does not extend AIProvider is rejected', () => {
  const registry = new ProviderRegistry().register('impostor', () => ({ complete: async () => ({}) }));

  assert.throws(() => createAIClient({ ...BASE, provider: 'impostor' }, { registry }), TypeError);
});

test('a custom provider can be added without touching command code', async () => {
  class EchoProvider extends AIProvider {
    async complete(request) {
      const { messages } = normaliseRequest(request);
      return this.buildResponse({
        text: `custom:${messages.at(-1).content}`,
        usage: { inputTokens: 1, outputTokens: 1 },
      });
    }
  }

  const registry = createRegistry().register('custom', (options) => new EchoProvider({ name: 'custom', ...options }), {
    replace: true,
  });
  const client = createAIClient({ ...BASE, provider: 'custom' }, { registry });
  const response = await client.complete({ messages: [{ role: 'user', content: 'ping' }] });

  assert.equal(response.text, 'custom:ping');
  assert.equal(response.provider, 'custom');
});

test('completions are debug-logged without leaking the prompt or key', async () => {
  const { logger, text } = createCapturingLogger({ level: 'debug' });
  const client = createAIClient({ ...BASE, apiKey: 'sk-must-not-appear' }, { logger });

  await client.complete({ messages: [{ role: 'user', content: 'top secret question' }] });

  assert.match(text(), /AI completion finished/);
  assert.ok(!text().includes('sk-must-not-appear'));
  assert.ok(!text().includes('top secret question'));
});
