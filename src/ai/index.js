import { createNullLogger } from '../utils/logger.js';
import { AIProvider, normaliseRequest } from './provider.js';
import { defaultRegistry, createRegistry, ProviderRegistry } from './registry.js';

export { AIProvider, normaliseRequest } from './provider.js';
export { ProviderRegistry, createRegistry, defaultRegistry } from './registry.js';
export * from './errors.js';

/**
 * Application-facing AI facade.
 *
 * Commands depend on this object, never on a concrete provider. Switching from
 * the offline stub to a paid backend is a configuration change:
 *
 *   AI_PROVIDER=openai
 *   AI_API_KEY=...
 *   AI_MODEL=gpt-...
 *
 * @param {{ provider: string, apiKey?: string|null, model?: string|null, timeoutMs?: number }} aiConfig
 * @param {{ registry?: ProviderRegistry, logger?: object }} [options]
 * @returns {{ complete: Function, healthCheck: Function, provider: object, describe: Function }}
 */
export function createAIClient(aiConfig, { registry = defaultRegistry, logger = createNullLogger() } = {}) {
  const provider = registry.create(aiConfig.provider, {
    apiKey: aiConfig.apiKey ?? null,
    model: aiConfig.model ?? null,
    timeoutMs: aiConfig.timeoutMs,
    maxOutputTokens: aiConfig.maxOutputTokens ?? null,
    temperature: aiConfig.temperature ?? null,
    // The provider logs privacy-safe diagnostics only (never prompt content).
    logger,
  });

  if (!(provider instanceof AIProvider)) {
    throw new TypeError(`AI provider "${aiConfig.provider}" does not extend AIProvider.`);
  }

  return {
    provider,

    /**
     * @param {object} request
     * @returns {Promise<object>} normalised AIResponse
     */
    async complete(request) {
      const normalised = normaliseRequest(request);
      const startedAt = Date.now();
      const response = await provider.complete(normalised);
      logger.debug('AI completion finished.', {
        provider: response.provider,
        model: response.model,
        durationMs: Date.now() - startedAt,
      });
      // `raw` can be large and may contain provider-specific metadata.
      return { ...response, raw: undefined };
    },

    async healthCheck() {
      return provider.healthCheck();
    },

    /**
     * Safe, secret-free summary for logging and the /status command.
     * Never includes `apiKey`.
     */
    describe() {
      const configured = provider.isConfigured();
      return {
        provider: provider.name,
        model: provider.model,
        configured,
        // `live` means a real model will answer. The stub does not count.
        live: configured && !provider.isStub,
        stub: provider.isStub,
        timeoutMs: provider.timeoutMs,
      };
    },
  };
}
