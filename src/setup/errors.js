import { BotError } from '../utils/errors.js';

/**
 * Thrown when a safety gate refuses to let a live apply proceed.
 *
 * Every abort carries the gate that fired and the evidence behind it, so the
 * operator can see exactly why nothing was written.
 */
export class LiveApplyAbort extends BotError {
  /**
   * @param {string} message
   * @param {{ gate?: string, violations?: string[] }} [options]
   */
  constructor(message, { gate = 'unspecified', violations = [], ...rest } = {}) {
    super(message, {
      code: 'LIVE_APPLY_ABORTED',
      details: { gate, ...(violations.length > 0 ? { violations } : {}) },
      ...rest,
    });
    this.gate = gate;
    this.violations = violations;
  }
}
