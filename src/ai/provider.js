import { createNullLogger } from '../utils/logger.js';
import { AIConfigurationError, AIProviderError } from './errors.js';

/**
 * Provider interface.
 *
 * Every AI backend - the offline stub today, OpenAI/Gemini/DeepSeek/GLM in
 * Phase 2 - implements this shape. Discord command code only ever sees
 * `complete()`, so adding a provider never touches a command.
 *
 * Response contract (`AIResponse`):
 *   {
 *     text:      string,             // the assistant's reply
 *     provider:  string,             // provider name
 *     model:     string|null,        // resolved model id
 *     usage:     { inputTokens: number|null, outputTokens: number|null },
 *     raw:       unknown,            // untouched provider payload
 *     createdAt: string              // ISO timestamp
 *   }
 *
 * Request contract (`AIRequest`):
 *   {
 *     messages:    Array<{ role: 'system'|'user'|'assistant', content: string }>,
 *     model?:      string,
 *     system?:     string,
 *     temperature?: number,          // 0..2
 *     maxTokens?:  number
 *   }
 */
export class AIProvider {
  /**
   * @param {{
   *   name: string,
   *   model?: string|null,
   *   apiKey?: string|null,
   *   timeoutMs?: number,
   *   maxOutputTokens?: number|null,
   *   temperature?: number|null,
   *   logger?: object|null,
   * }} options
   */
  constructor({
    name,
    model = null,
    apiKey = null,
    timeoutMs = 30000,
    maxOutputTokens = null,
    temperature = null,
    logger = null,
  } = {}) {
    if (!name) throw new AIConfigurationError('An AI provider requires a name.');
    this.name = name;
    this.model = model ?? null;
    this.apiKey = apiKey ?? null;
    this.timeoutMs = timeoutMs;
    this.maxOutputTokens = maxOutputTokens ?? null;
    this.temperature = temperature ?? null;
    // Diagnostics only; providers must never log prompts or credentials.
    this.logger = logger ?? createNullLogger();
  }

  /**
   * Whether this provider has everything it needs to serve requests.
   * @returns {boolean}
   */
  isConfigured() {
    return true;
  }

  /**
   * True for the offline placeholder that ships in this phase.
   *
   * Commands use this to tell the user plainly that no real AI is wired up yet,
   * rather than passing off canned output as a model response.
   * @returns {boolean}
   */
  get isStub() {
    return false;
  }

  /**
   * Produces a completion.
   * @param {object} request
   * @returns {Promise<object>} AIResponse
   */
  // eslint-disable-next-line no-unused-vars -- interface method
  async complete(request) {
    throw new AIProviderError(`Provider "${this.name}" does not implement complete().`, {
      details: { provider: this.name },
    });
  }

  /**
   * Lightweight reachability/configuration probe. Must not throw.
   * @returns {Promise<{ ok: boolean, provider: string, model: string|null, detail: string }>}
   */
  async healthCheck() {
    return {
      ok: this.isConfigured(),
      provider: this.name,
      model: this.model,
      detail: this.isConfigured() ? 'configured' : 'missing credentials',
    };
  }

  /**
   * Builds a normalised response object.
   * @param {{ text: string, model?: string|null, usage?: object, raw?: unknown }} parts
   */
  buildResponse({ text, model = null, usage = {}, raw = null }) {
    return {
      text: String(text ?? ''),
      provider: this.name,
      model: model ?? this.model,
      usage: {
        inputTokens: usage.inputTokens ?? null,
        outputTokens: usage.outputTokens ?? null,
      },
      raw,
      createdAt: new Date().toISOString(),
    };
  }
}

/**
 * Validates and normalises a request before it reaches a provider.
 * @param {object} request
 * @returns {{ messages: Array<{role: string, content: string}>, model: string|null, system: string|null, temperature: number|null, maxTokens: number|null }}
 */
export function normaliseRequest(request = {}) {
  const messages = request.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new AIConfigurationError('An AI request requires a non-empty `messages` array.');
  }

  const normalised = messages.map((message, index) => {
    const role = message?.role;
    if (!['system', 'user', 'assistant'].includes(role)) {
      throw new AIConfigurationError(`messages[${index}].role must be system, user or assistant.`);
    }
    if (typeof message.content !== 'string' || message.content.length === 0) {
      throw new AIConfigurationError(`messages[${index}].content must be a non-empty string.`);
    }
    return { role, content: message.content };
  });

  return {
    messages: normalised,
    model: request.model ?? null,
    system: request.system ?? null,
    temperature: request.temperature ?? null,
    maxTokens: request.maxTokens ?? null,
  };
}
