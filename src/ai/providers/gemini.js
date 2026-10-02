import { createPendingProviderFactory } from './pending.js';

/**
 * Google Gemini provider - registered, not implemented (Phase 2).
 *
 * Configuration it will consume: `AI_API_KEY`, `AI_MODEL`, `AI_TIMEOUT_MS`.
 */
export const createGeminiProvider = createPendingProviderFactory('gemini');
