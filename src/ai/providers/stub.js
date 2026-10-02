import { AIProvider, normaliseRequest } from '../provider.js';

/**
 * Deterministic offline provider.
 *
 * Used for local development and by the test suite. It performs no network
 * I/O, costs nothing, and always returns the same answer for the same input -
 * which makes downstream behaviour reproducible.
 */
export class StubProvider extends AIProvider {
  constructor(options = {}) {
    super({ name: 'stub', model: options.model ?? 'stub-echo-v1', timeoutMs: options.timeoutMs });
  }

  isConfigured() {
    return true;
  }

  get isStub() {
    return true;
  }

  async complete(request) {
    const { messages, system } = normaliseRequest(request);
    const lastUser = [...messages].reverse().find((message) => message.role === 'user');

    const text = [
      system ? `[system] ${system}` : null,
      `[stub] Received ${messages.length} message(s).`,
      lastUser ? `Echo: ${lastUser.content}` : 'Echo: (no user message)',
    ]
      .filter(Boolean)
      .join('\n');

    return this.buildResponse({
      text,
      usage: { inputTokens: countWords(messages), outputTokens: countWords([{ content: text }]) },
      raw: { stub: true },
    });
  }

  async healthCheck() {
    return { ok: true, provider: this.name, model: this.model, detail: 'offline stub, always available' };
  }
}

function countWords(messages) {
  return messages.reduce((total, message) => total + String(message.content ?? '').split(/\s+/).filter(Boolean).length, 0);
}

/** @param {object} options */
export function createStubProvider(options = {}) {
  return new StubProvider(options);
}
