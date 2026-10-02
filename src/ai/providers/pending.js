import { AIProvider, normaliseRequest } from '../provider.js';
import { AIProviderNotImplementedError } from '../errors.js';

/**
 * Factory for providers that are registered but not yet implemented.
 *
 * The point of these placeholders is to prove the extension path: adding a real
 * backend means replacing one `complete()` body, with no change to any Discord
 * command, the registry, or the config schema.
 *
 * To implement one in Phase 2:
 *   1. Add the vendor SDK (or use `fetch`) inside the provider's own module.
 *   2. Translate the normalised request into the vendor's payload shape.
 *   3. Return `this.buildResponse({ text, usage, raw })`.
 *   4. Honour `this.timeoutMs` and never log `this.apiKey`.
 *
 * @param {string} name
 * @param {(options: object) => AIProvider} [build] Optional real implementation.
 */
export function createPendingProviderFactory(name, build = null) {
  return function createProvider(options = {}) {
    if (typeof build === 'function') return build(options);
    return new PendingProvider(name, options);
  };
}

/** A provider that reports clearly that it is not wired up yet. */
export class PendingProvider extends AIProvider {
  constructor(name, options = {}) {
    super({ name, model: options.model ?? null, apiKey: options.apiKey ?? null, timeoutMs: options.timeoutMs });
  }

  isConfigured() {
    return false;
  }

  async complete(request) {
    // Validate first so callers still get useful shape errors, then refuse.
    normaliseRequest(request);
    throw new AIProviderNotImplementedError(this.name);
  }

  async healthCheck() {
    return {
      ok: false,
      provider: this.name,
      model: this.model,
      detail: 'registered placeholder - not implemented in Phase 1',
    };
  }
}
