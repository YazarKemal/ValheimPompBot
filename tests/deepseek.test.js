import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createAIClient } from '../src/ai/index.js';
import { createRegistry } from '../src/ai/registry.js';
import { DeepSeekProvider, DEEPSEEK_API_URL } from '../src/ai/providers/deepseek.js';
import { createCapturingLogger } from '../src/utils/logger.js';

/**
 * Every test here runs against an injected fetch. The suite installs a guard
 * over globalThis.fetch so an unmocked call fails loudly instead of reaching
 * the real (paid) DeepSeek API.
 */

const REAL_FETCH = globalThis.fetch;

before(() => {
  globalThis.fetch = () => {
    throw new Error('A test attempted a real network call.');
  };
});

after(() => {
  globalThis.fetch = REAL_FETCH;
});

const API_KEY = 'sk-test-key-that-must-stay-secret';
const MODEL = 'deepseek-flash';
const BASE = {
  provider: 'deepseek',
  apiKey: API_KEY,
  model: MODEL,
  timeoutMs: 5000,
  maxOutputTokens: 1200,
  temperature: 0.7,
};

const PROMPT = 'Valheim dünyasında en iyi madencilik yöntemi nedir?';

/** Installs a recording fetch double for the duration of one test. */
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init, calls.length);
  };
  return {
    calls,
    body(index = 0) {
      return JSON.parse(calls[index].init.body);
    },
    signal(index = 0) {
      return calls[index].init.signal;
    },
    restore() {
      globalThis.fetch = () => {
        throw new Error('A test attempted a real network call.');
      };
    },
  };
}

function okResponse(content = 'Cevap', overrides = {}) {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-test-1',
      object: 'chat.completion',
      model: MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 7 },
      ...overrides,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function errorResponse(status, headers = {}) {
  return new Response(JSON.stringify({ error: { message: 'vendor detail' } }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/* -------------------------------------------------------------------------- */
/* Happy path and request contract                                             */
/* -------------------------------------------------------------------------- */

test('a successful call returns the answer, model and usage', async () => {
  const mock = stubFetch(() => okResponse('Merhaba madenci!'));
  try {
    const client = createAIClient(BASE);
    const response = await client.complete({ messages: [{ role: 'user', content: PROMPT }] });

    assert.equal(response.text, 'Merhaba madenci!');
    assert.equal(response.provider, 'deepseek');
    assert.equal(response.model, MODEL);
    assert.deepEqual(response.usage, { inputTokens: 12, outputTokens: 7 });
    // `raw` is stripped by the client facade before commands see it.
    assert.equal(response.raw, undefined);
    assert.equal(mock.calls.length, 1);
  } finally {
    mock.restore();
  }
});

test('the request body matches the DeepSeek chat-completions contract', async () => {
  const mock = stubFetch(() => okResponse());
  try {
    const client = createAIClient(BASE);
    await client.complete({
      messages: [{ role: 'user', content: PROMPT }],
      system: 'You are PompAI.',
    });

    const [call] = mock.calls;
    assert.equal(call.url, DEEPSEEK_API_URL);
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers['content-type'], 'application/json');
    assert.equal(call.init.headers.authorization, `Bearer ${API_KEY}`);

    const body = mock.body();
    assert.equal(body.model, MODEL);
    assert.equal(body.stream, false);
    assert.equal(body.max_tokens, 1200);
    assert.equal(body.temperature, 0.7);
    assert.deepEqual(body.thinking, { type: 'disabled' }, 'thinking must stay off on the Flash path');
    assert.deepEqual(body.messages, [
      { role: 'system', content: 'You are PompAI.' },
      { role: 'user', content: PROMPT },
    ]);
    assert.ok(!JSON.stringify(body).includes('deepseek-v4-pro'), 'a fallback model is referenced');
  } finally {
    mock.restore();
  }
});

test('a request-level temperature and token cap override the provider defaults', async () => {
  const mock = stubFetch(() => okResponse());
  try {
    const client = createAIClient(BASE);
    await client.complete({ messages: [{ role: 'user', content: PROMPT }], temperature: 0.2, maxTokens: 64 });

    const body = mock.body();
    assert.equal(body.temperature, 0.2);
    assert.equal(body.max_tokens, 64);
  } finally {
    mock.restore();
  }
});

test('the default endpoint is the official DeepSeek chat-completions URL', () => {
  const provider = new DeepSeekProvider({ apiKey: API_KEY, model: MODEL });
  assert.equal(provider.apiUrl, 'https://api.deepseek.com/chat/completions');
  assert.equal(DEEPSEEK_API_URL, 'https://api.deepseek.com/chat/completions');
});

test('the registry wires the real DeepSeek provider', () => {
  const provider = createRegistry().create('deepseek', { apiKey: API_KEY, model: MODEL });
  assert.ok(provider instanceof DeepSeekProvider);
});

/* -------------------------------------------------------------------------- */
/* Credentials                                                                 */
/* -------------------------------------------------------------------------- */

test('the API key travels only in the Authorization header', async () => {
  const mock = stubFetch(() => okResponse());
  try {
    await createAIClient(BASE).complete({ messages: [{ role: 'user', content: PROMPT }] });

    const serialisedHeaders = JSON.stringify(mock.calls[0].init.headers);
    assert.ok(serialisedHeaders.includes(API_KEY), 'the key never reached the Authorization header');
    assert.ok(!mock.calls[0].url.includes(API_KEY), 'the key leaked into the URL');
    assert.ok(!mock.calls[0].init.body.includes(API_KEY), 'the key leaked into the request body');
  } finally {
    mock.restore();
  }
});

test('the API key never appears in descriptions, logs or errors', async () => {
  const { logger, text } = createCapturingLogger({ level: 'debug' });
  const mock = stubFetch(() => errorResponse(401));
  try {
    const client = createAIClient(BASE, { logger });

    assert.ok(!JSON.stringify(client.describe()).includes(API_KEY), 'describe() leaked the key');

    let thrown;
    try {
      await client.complete({ messages: [{ role: 'user', content: PROMPT }] });
    } catch (error) {
      thrown = error;
    }

    assert.ok(thrown, 'a 401 did not throw');
    const serialised = `${thrown.message}${JSON.stringify(thrown.details)}${thrown.stack}`;
    assert.ok(!serialised.includes(API_KEY), 'the key leaked into the error');
    assert.ok(!text().includes(API_KEY), 'the key leaked into the debug log');
    assert.ok(!text().includes(PROMPT), 'the prompt leaked into the debug log');
  } finally {
    mock.restore();
  }
});

test('vendor text that echoes the key is scrubbed before it reaches an error', async () => {
  const mock = stubFetch(() => {
    // A hostile/buggy proxy could echo the Authorization header back.
    throw new Error(`upstream refused for Bearer ${API_KEY}`);
  });
  try {
    let thrown;
    try {
      await createAIClient(BASE).complete({ messages: [{ role: 'user', content: PROMPT }] });
    } catch (error) {
      thrown = error;
    }

    assert.ok(thrown);
    assert.equal(thrown.code, 'AI_PROVIDER_ERROR');
    assert.ok(!thrown.message.includes(API_KEY), 'the key survived scrubbing');
    assert.match(thrown.message, /\[redacted\]/);
  } finally {
    mock.restore();
  }
});

/* -------------------------------------------------------------------------- */
/* Timeout and aborts                                                          */
/* -------------------------------------------------------------------------- */

test('a slow provider is aborted and reported as a timeout', async () => {
  const mock = stubFetch(
    (url, init) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
        });
      }),
  );
  try {
    const client = createAIClient({ ...BASE, timeoutMs: 30 });
    const startedAt = Date.now();

    await assert.rejects(
      () => client.complete({ messages: [{ role: 'user', content: PROMPT }] }),
      (error) => {
        assert.equal(error.code, 'AI_REQUEST_TIMEOUT');
        assert.equal(error.details.timeoutMs, 30);
        return true;
      },
    );

    assert.ok(Date.now() - startedAt < 3000, 'the timeout did not fire promptly');
    assert.equal(mock.signal().aborted, true, 'the AbortController never fired');
    assert.equal(mock.calls.length, 1, 'a timeout must not be retried');
  } finally {
    mock.restore();
  }
});

test('a completed request clears its abort timer', async () => {
  const mock = stubFetch(() => okResponse());
  try {
    await createAIClient(BASE).complete({ messages: [{ role: 'user', content: PROMPT }] });
    assert.equal(mock.signal().aborted, false, 'a finished request left its signal aborted');
  } finally {
    mock.restore();
  }
});

/* -------------------------------------------------------------------------- */
/* HTTP failures                                                               */
/* -------------------------------------------------------------------------- */

test('HTTP failures map onto the AI error abstraction without retrying', async () => {
  const cases = [
    [401, 'AI_AUTH_ERROR'],
    [403, 'AI_AUTH_ERROR'],
    [429, 'AI_RATE_LIMIT'],
    [500, 'AI_PROVIDER_UNAVAILABLE'],
    [503, 'AI_PROVIDER_UNAVAILABLE'],
    [400, 'AI_PROVIDER_ERROR'],
  ];

  for (const [status, code] of cases) {
    const mock = stubFetch(() => errorResponse(status, status === 429 ? { 'retry-after': '7' } : {}));
    try {
      await assert.rejects(
        () => createAIClient(BASE).complete({ messages: [{ role: 'user', content: PROMPT }] }),
        (error) => {
          assert.equal(error.code, code, `HTTP ${status} produced ${error.code}`);
          assert.equal(error.details.status, status);
          assert.ok(!JSON.stringify(error.details).includes(API_KEY));
          return true;
        },
      );
      assert.equal(mock.calls.length, 1, `HTTP ${status} was retried`);
    } finally {
      mock.restore();
    }
  }
});

test('a 429 surfaces the Retry-After hint when the vendor sends one', async () => {
  const mock = stubFetch(() => errorResponse(429, { 'retry-after': '7' }));
  try {
    await assert.rejects(
      () => createAIClient(BASE).complete({ messages: [{ role: 'user', content: PROMPT }] }),
      (error) => {
        assert.equal(error.details.retryAfterSeconds, 7);
        return true;
      },
    );
  } finally {
    mock.restore();
  }
});

/* -------------------------------------------------------------------------- */
/* Malformed and empty responses                                               */
/* -------------------------------------------------------------------------- */

test('invalid JSON is rejected as an unusable response', async () => {
  const mock = stubFetch(() => new Response('<html>gateway</html>', { status: 200 }));
  try {
    await assert.rejects(
      () => createAIClient(BASE).complete({ messages: [{ role: 'user', content: PROMPT }] }),
      (error) => {
        assert.equal(error.code, 'AI_RESPONSE_INVALID');
        return true;
      },
    );
  } finally {
    mock.restore();
  }
});

test('a response without choices is rejected', async () => {
  const mock = stubFetch(() => new Response(JSON.stringify({ id: 'x', usage: {} }), { status: 200 }));
  try {
    await assert.rejects(
      () => createAIClient(BASE).complete({ messages: [{ role: 'user', content: PROMPT }] }),
      (error) => {
        assert.equal(error.code, 'AI_RESPONSE_INVALID');
        return true;
      },
    );
  } finally {
    mock.restore();
  }
});

test('an empty answer is rejected rather than shown to a user', async () => {
  for (const content of ['', '   ', null]) {
    const mock = stubFetch(() => okResponse(content));
    try {
      await assert.rejects(
        () => createAIClient(BASE).complete({ messages: [{ role: 'user', content: PROMPT }] }),
        (error) => {
          assert.equal(error.code, 'AI_RESPONSE_INVALID');
          return true;
        },
      );
    } finally {
      mock.restore();
    }
  }
});

/* -------------------------------------------------------------------------- */
/* Configuration safety                                                        */
/* -------------------------------------------------------------------------- */

test('an unconfigured provider refuses without touching the network', async () => {
  const cases = [
    { apiKey: null, model: MODEL },
    { apiKey: API_KEY, model: null },
    { apiKey: null, model: null },
  ];

  for (const overrides of cases) {
    await assert.rejects(
      () => createAIClient({ ...BASE, ...overrides }).complete({ messages: [{ role: 'user', content: PROMPT }] }),
      (error) => {
        assert.equal(error.code, 'AI_CONFIGURATION_ERROR');
        return true;
      },
    );
  }
  // The guard fetch throws if anything reached it; reaching here proves it did not.
});

test('the process never falls back to a different model', async () => {
  const mock = stubFetch(() => okResponse());
  try {
    await createAIClient({ ...BASE, model: 'deepseek-flash' }).complete({
      messages: [{ role: 'user', content: PROMPT }],
    });
    assert.equal(mock.body().model, 'deepseek-flash');

    const provider = new DeepSeekProvider({ apiKey: API_KEY, model: null });
    assert.equal(provider.isConfigured(), false);
    assert.match(provider.configurationProblem(), /AI_MODEL/);
  } finally {
    mock.restore();
  }
});

/* -------------------------------------------------------------------------- */
/* Diagnostics                                                                 */
/* -------------------------------------------------------------------------- */

test('success diagnostics carry ids, sizes and timing but never the prompt', async () => {
  const { logger, text } = createCapturingLogger({ level: 'debug' });
  const mock = stubFetch(() => okResponse());
  try {
    await createAIClient(BASE, { logger }).complete({ messages: [{ role: 'user', content: PROMPT }] });

    const expectedHash = createHash('sha256').update(PROMPT).digest('hex').slice(0, 12);
    assert.match(text(), /DeepSeek request diagnostics/);
    assert.match(text(), new RegExp(expectedHash), 'the prompt hash prefix is missing');
    assert.match(text(), /promptChars: \d+/);
    assert.match(text(), /latencyMs: \d+/);
    assert.match(text(), /ok: true/);
    assert.ok(!text().includes(PROMPT), 'raw prompt content was logged');
    assert.ok(!text().includes(API_KEY), 'the API key was logged');
  } finally {
    mock.restore();
  }
});

test('failure diagnostics report the code and still never the prompt', async () => {
  const { logger, text } = createCapturingLogger({ level: 'debug' });
  const mock = stubFetch(() => errorResponse(503));
  try {
    await assert.rejects(() =>
      createAIClient(BASE, { logger }).complete({ messages: [{ role: 'user', content: PROMPT }] }),
    );

    assert.match(text(), /ok: false/);
    assert.match(text(), /AI_PROVIDER_UNAVAILABLE/);
    assert.ok(!text().includes(PROMPT), 'raw prompt content was logged on failure');
  } finally {
    mock.restore();
  }
});
