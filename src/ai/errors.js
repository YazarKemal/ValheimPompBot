import { BotError } from '../utils/errors.js';

/** Base class for every AI-layer failure. */
export class AIError extends BotError {
  constructor(message, options = {}) {
    super(message, { code: 'AI_ERROR', ...options });
  }
}

/** The request or configuration is wrong before any provider work begins. */
export class AIConfigurationError extends AIError {
  constructor(message, options = {}) {
    super(message, { code: 'AI_CONFIGURATION_ERROR', ...options });
  }
}

/** A provider failed while producing a response. */
export class AIProviderError extends AIError {
  constructor(message, options = {}) {
    super(message, { code: 'AI_PROVIDER_ERROR', ...options });
  }
}

/**
 * Every subclass below is still an AIProviderError, so generic handling keeps
 * working while commands can branch on a precise `code`.
 */

/** The provider did not answer within the configured timeout. */
export class AIRequestTimeoutError extends AIProviderError {
  constructor(message, options = {}) {
    super(message, { code: 'AI_REQUEST_TIMEOUT', ...options });
  }
}

/** The provider answered with something that cannot be used (bad JSON, empty answer). */
export class AIResponseError extends AIProviderError {
  constructor(message, options = {}) {
    super(message, { code: 'AI_RESPONSE_INVALID', ...options });
  }
}

/** The provider rejected the configured credentials (HTTP 401/403). */
export class AIAuthenticationError extends AIProviderError {
  constructor(message, options = {}) {
    super(message, { code: 'AI_AUTH_ERROR', ...options });
  }
}

/** The provider is rate-limiting us (HTTP 429). */
export class AIRateLimitError extends AIProviderError {
  constructor(message, options = {}) {
    super(message, { code: 'AI_RATE_LIMIT', ...options });
  }
}

/** The provider is reachable but unhealthy (HTTP 5xx). */
export class AIProviderUnavailableError extends AIProviderError {
  constructor(message, options = {}) {
    super(message, { code: 'AI_PROVIDER_UNAVAILABLE', ...options });
  }
}

/**
 * Thrown by providers that are registered but not yet implemented.
 * Carries a `provider` field so callers can report which one is missing.
 */
export class AIProviderNotImplementedError extends AIError {
  constructor(provider, options = {}) {
    super(
      `The "${provider}" AI provider is registered but not implemented yet (planned for Phase 2). ` +
        'Set AI_PROVIDER=stub to run locally without a paid API.',
      { code: 'AI_PROVIDER_NOT_IMPLEMENTED', details: { provider }, ...options },
    );
    this.provider = provider;
  }
}
