import { AIConfigurationError } from './errors.js';
import { createStubProvider } from './providers/stub.js';
import { createOpenAIProvider } from './providers/openai.js';
import { createGeminiProvider } from './providers/gemini.js';
import { createDeepSeekProvider } from './providers/deepseek.js';
import { createGLMProvider } from './providers/glm.js';

/**
 * Provider registry.
 *
 * A registry instance is just a name -> factory map. The default instance is
 * populated with every provider the project knows about; tests build their own
 * isolated instance so registration never leaks between cases.
 */
export class ProviderRegistry {
  constructor() {
    /** @type {Map<string, (options: object) => object>} */
    this.factories = new Map();
  }

  /**
   * @param {string} name
   * @param {(options: object) => object} factory
   * @param {{ replace?: boolean }} [options]
   */
  register(name, factory, { replace = false } = {}) {
    if (typeof factory !== 'function') {
      throw new AIConfigurationError(`Factory for AI provider "${name}" must be a function.`);
    }
    if (this.factories.has(name) && !replace) {
      throw new AIConfigurationError(`AI provider "${name}" is already registered.`, {
        details: { provider: name },
      });
    }
    this.factories.set(name, factory);
    return this;
  }

  /** @param {string} name */
  has(name) {
    return this.factories.has(name);
  }

  /** @returns {string[]} registered provider names, sorted */
  list() {
    return [...this.factories.keys()].sort();
  }

  /**
   * Instantiates a provider.
   * @param {string} name
   * @param {object} [options]
   */
  create(name, options = {}) {
    const factory = this.factories.get(name);
    if (!factory) {
      throw new AIConfigurationError(
        `Unknown AI provider "${name}". Available: ${this.list().join(', ') || '(none)'}.`,
        { details: { provider: name, available: this.list() } },
      );
    }
    return factory(options);
  }
}

/** Registers every built-in provider on the given registry. */
export function registerBuiltinProviders(registry) {
  return registry
    .register('stub', createStubProvider)
    .register('openai', createOpenAIProvider)
    .register('gemini', createGeminiProvider)
    .register('deepseek', createDeepSeekProvider)
    .register('glm', createGLMProvider);
}

/** @returns {ProviderRegistry} */
export function createRegistry() {
  return registerBuiltinProviders(new ProviderRegistry());
}

/** Shared registry used by the application. */
export const defaultRegistry = createRegistry();
