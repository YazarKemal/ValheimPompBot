import { createHash, randomUUID } from 'node:crypto';
import { AIProvider, normaliseRequest } from '../provider.js';
import {
  AIConfigurationError,
  AIProviderError,
  AIRequestTimeoutError,
  AIResponseError,
  AIAuthenticationError,
  AIRateLimitError,
  AIProviderUnavailableError,
} from '../errors.js';

/**
 * DeepSeek provider - the first real (paid) backend.
 *
 * Uses DeepSeek's official OpenAI-compatible chat-completions endpoint:
 *   POST https://api.deepseek.com/chat/completions
 *
 * Configuration it consumes: `AI_API_KEY`, `AI_MODEL`, `AI_TIMEOUT_MS`,
 * `AI_MAX_OUTPUT_TOKENS`, `AI_TEMPERATURE` (see src/config/schema.js).
 *
 * Safety properties that must not be relaxed:
 *   - the model comes from AI_MODEL only; there is no fallback model;
 *   - exactly one HTTP request per complete() call - no retries that could
 *     duplicate a paid request;
 *   - a timeout aborts the request via AbortController;
 *   - apiKey is never logged, never included in errors, never echoed back.
 */

export const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';
export const DEEPSEEK_PROVIDER_NAME = 'deepseek';

/** Diagnostic hash prefix length. Enough to correlate, useless to reverse. */
const PROMPT_HASH_CHARS = 12;

export class DeepSeekProvider extends AIProvider {
  /**
   * @param {object} [options]
   * @param {string|null} [options.apiKey]
   * @param {string|null} [options.model]      From AI_MODEL; required.
   * @param {number} [options.timeoutMs]
   * @param {number|null} [options.maxOutputTokens]
   * @param {number|null} [options.temperature]
   * @param {string} [options.apiUrl]          Override for tests and proxies.
   * @param {boolean} [options.thinking]       Reserved for a future feature.
   *   Defaults to false, and false is sent explicitly so the Flash path can
   *   never silently start paying for reasoning tokens.
   * @param {Function} [options.fetchImpl]     Injected transport (tests only).
   * @param {object} [options.logger]
   */
  constructor(options = {}) {
    super({
      name: DEEPSEEK_PROVIDER_NAME,
      model: options.model ?? null,
      apiKey: options.apiKey ?? null,
      timeoutMs: options.timeoutMs,
      maxOutputTokens: options.maxOutputTokens ?? null,
      temperature: options.temperature ?? null,
      logger: options.logger,
    });
    this.apiUrl = options.apiUrl ?? DEEPSEEK_API_URL;
    this.thinking = options.thinking === true;
    this.fetchImpl = options.fetchImpl ?? null;
  }

  isConfigured() {
    return Boolean(this.apiKey) && Boolean(this.model);
  }

  /** Reports why the provider cannot serve requests, or null when it can. */
  configurationProblem() {
    if (!this.apiKey) return 'AI_API_KEY is not set';
    if (!this.model) return 'AI_MODEL is not set (for example: deepseek-flash)';
    return null;
  }

  /**
   * Builds the chat-completions payload. Exported shape is asserted by tests,
   * so changes here are deliberate and reviewable.
   */
  buildRequestBody(normalised) {
    const body = {
      model: this.model,
      messages: [
        ...(normalised.system ? [{ role: 'system', content: normalised.system }] : []),
        ...normalised.messages.map((message) => ({ role: message.role, content: message.content })),
      ],
      stream: false,
      // The default Flash path is non-thinking. A future feature may opt in,
      // but nothing does today, so this stays 'disabled'.
      thinking: { type: this.thinking ? 'enabled' : 'disabled' },
    };

    const maxTokens = normalised.maxTokens ?? this.maxOutputTokens;
    if (Number.isFinite(maxTokens)) body.max_tokens = maxTokens;

    const temperature = normalised.temperature ?? this.temperature;
    if (Number.isFinite(temperature)) body.temperature = temperature;

    return body;
  }

  /**
   * Produces one completion. Never retries and never falls back to another
   * model: a failure surfaces to the caller.
   */
  async complete(request) {
    const normalised = normaliseRequest(request);
    const problem = this.configurationProblem();
    if (problem) {
      throw new AIConfigurationError(`The DeepSeek provider is not configured: ${problem}.`, {
        details: { provider: this.name },
      });
    }

    const diagnostics = this.#startDiagnostics(normalised);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;

    try {
      const doFetch = this.fetchImpl ?? globalThis.fetch;
      if (typeof doFetch !== 'function') {
        throw new AIConfigurationError('No fetch implementation is available for the DeepSeek provider.');
      }

      response = await doFetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(this.buildRequestBody(normalised)),
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw this.#fail(
          diagnostics,
          new AIRequestTimeoutError(
            `DeepSeek did not answer within ${this.timeoutMs}ms.`,
            { details: { provider: this.name, timeoutMs: this.timeoutMs } },
          ),
        );
      }
      throw this.#fail(
        diagnostics,
        new AIProviderError(`The DeepSeek request failed: ${this.#scrub(error?.message) ?? 'unknown error'}`, {
          details: { provider: this.name },
          cause: error,
        }),
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw this.#fail(diagnostics, this.#errorForStatus(response.status, response.headers));
    }

    const data = await this.#parseJson(response, diagnostics);
    const choice = Array.isArray(data?.choices) ? data.choices[0] : null;
    const content = choice?.message?.content;

    if (typeof content !== 'string' || content.trim() === '') {
      throw this.#fail(
        diagnostics,
        new AIResponseError('DeepSeek returned an empty or malformed answer.', {
          details: { provider: this.name, status: response.status },
        }),
      );
    }

    const result = this.buildResponse({
      text: content,
      model: typeof data.model === 'string' && data.model.length > 0 ? data.model : this.model,
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? null,
        outputTokens: data.usage?.completion_tokens ?? null,
      },
      raw: { id: data.id ?? null, finishReason: choice.finish_reason ?? null },
    });

    this.#logDiagnostics(diagnostics, { ok: true });
    return result;
  }

  async healthCheck() {
    const problem = this.configurationProblem();
    return {
      ok: problem === null,
      provider: this.name,
      model: this.model,
      detail: problem ?? 'configured - a real API call is made only on /ask',
    };
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                           */
  /* ------------------------------------------------------------------ */

  /** Maps an HTTP status onto the AI error abstraction. No body, no headers. */
  #errorForStatus(status, headers) {
    const retryAfterSeconds = Number(headers?.get?.('retry-after'));
    const details = {
      provider: this.name,
      status,
      ...(Number.isFinite(retryAfterSeconds) ? { retryAfterSeconds } : {}),
    };

    if (status === 401 || status === 403) {
      return new AIAuthenticationError('DeepSeek rejected the configured API key.', { details });
    }
    if (status === 429) {
      return new AIRateLimitError('DeepSeek is rate-limiting this key.', { details });
    }
    if (status >= 500) {
      return new AIProviderUnavailableError(`DeepSeek is unavailable (HTTP ${status}).`, { details });
    }
    return new AIProviderError(`DeepSeek rejected the request (HTTP ${status}).`, { details });
  }

  async #parseJson(response, diagnostics) {
    try {
      return await response.json();
    } catch {
      throw this.#fail(
        diagnostics,
        new AIResponseError('DeepSeek returned a response that was not valid JSON.', {
          details: { provider: this.name, status: response.status },
        }),
      );
    }
  }

  #startDiagnostics(normalised) {
    const promptText = normalised.messages.map((message) => message.content).join('\n');
    return {
      requestId: randomUUID(),
      promptChars: promptText.length,
      promptSha256Prefix: createHash('sha256').update(promptText).digest('hex').slice(0, PROMPT_HASH_CHARS),
      startedAt: Date.now(),
    };
  }

  /**
   * Privacy-safe diagnostics only: identifiers, sizes and timing - never the
   * prompt, the answer or the API key.
   */
  #logDiagnostics(diagnostics, { ok, errorCode = null }) {
    this.logger?.debug?.('DeepSeek request diagnostics.', {
      provider: this.name,
      requestId: diagnostics.requestId,
      promptChars: diagnostics.promptChars,
      promptSha256Prefix: diagnostics.promptSha256Prefix,
      latencyMs: Date.now() - diagnostics.startedAt,
      ok,
      ...(errorCode ? { errorCode } : {}),
    });
  }

  /** Logs the failure and returns the error so callers can `throw this.#fail(...)`. */
  #fail(diagnostics, error) {
    this.#logDiagnostics(diagnostics, { ok: false, errorCode: error.code ?? 'AI_ERROR' });
    return error;
  }

  /** Removes the API key from any vendor text before it can reach a log or error. */
  #scrub(text) {
    const value = typeof text === 'string' ? text : null;
    if (value === null) return null;
    if (!this.apiKey) return value.slice(0, 300);
    return value.split(this.apiKey).join('[redacted]').slice(0, 300);
  }
}

/** @param {object} options */
export function createDeepSeekProvider(options = {}) {
  return new DeepSeekProvider(options);
}
