/**
 * Graceful shutdown handling.
 *
 * Wires SIGINT/SIGTERM to a single, idempotent shutdown routine:
 *
 *   - the first signal runs `onShutdown` once, then resolves `done`
 *   - a second signal (or the timeout) forces an exit, so a hung close cannot
 *     leave the process wedged in a terminal
 *   - handlers are detached afterwards, so a test or an embedder is not left
 *     with listeners attached
 *
 * `processRef` is injectable, which is what makes the whole thing testable.
 */

export const DEFAULT_SIGNALS = Object.freeze(['SIGINT', 'SIGTERM']);

/**
 * @param {object} options
 * @param {(reason: string) => unknown | Promise<unknown>} options.onShutdown
 * @param {object} [options.logger]
 * @param {string[]} [options.signals]
 * @param {object} [options.processRef] Defaults to `process`.
 * @param {number} [options.timeoutMs] Force an exit if closing hangs.
 * @returns {{ shutdown: (reason: string) => void, isShuttingDown: () => boolean, done: Promise<string|null>, detach: () => void }}
 */
export function createShutdownController({
  onShutdown,
  logger = null,
  signals = DEFAULT_SIGNALS,
  processRef = process,
  timeoutMs = 15000,
}) {
  let shuttingDown = false;
  let settled = false;
  let timer = null;

  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  /** @type {Array<{ signal: string, listener: (received?: unknown) => void }>} */
  const listeners = [];

  const detach = () => {
    for (const { signal, listener } of listeners) {
      processRef.off?.(signal, listener);
    }
    listeners.length = 0;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const finish = (reason) => {
    if (settled) return;
    settled = true;
    detach();
    resolveDone(reason);
  };

  const handleSignal = (signal) => {
    if (shuttingDown) {
      // Second Ctrl+C: the operator wants out now.
      logger?.warn?.(`Received ${signal} again while shutting down - forcing exit.`);
      processRef.exit?.(1);
      finish(signal);
      return;
    }

    shuttingDown = true;
    logger?.info?.(`Received ${signal}. Shutting down gracefully.`);

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        logger?.warn?.(`Shutdown did not finish within ${timeoutMs}ms - forcing exit.`);
        processRef.exit?.(1);
        finish(signal);
      }, timeoutMs);
      // Do not hold the event loop open purely for the watchdog.
      timer.unref?.();
    }

    Promise.resolve()
      .then(() => onShutdown(signal))
      .then(() => logger?.info?.('Shutdown complete.'))
      .catch((error) => logger?.error?.('Error during shutdown.', error))
      .finally(() => finish(signal));
  };

  for (const signal of signals) {
    // Node passes the signal name to the listener; a bare EventEmitter used in
    // tests does not. Fall back to the name we registered under.
    const listener = (received) => handleSignal(typeof received === 'string' ? received : signal);
    listeners.push({ signal, listener });
    processRef.on(signal, listener);
  }

  return {
    shutdown: handleSignal,
    isShuttingDown: () => shuttingDown,
    done,
    detach,
  };
}

/**
 * Last-resort handlers so an unexpected throw is logged rather than printed as
 * a raw stack trace and then silently swallowed.
 *
 * @param {{ logger: object, onFatal?: (error: unknown) => void, processRef?: object }} options
 * @returns {() => void} detach function
 */
export function installCrashHandlers({ logger, onFatal, processRef = process }) {
  const onUnhandled = (reason) => {
    logger.error('Unhandled promise rejection.', reason);
    onFatal?.(reason);
  };
  const onUncaught = (error) => {
    logger.error('Uncaught exception.', error);
    onFatal?.(error);
  };

  processRef.on('unhandledRejection', onUnhandled);
  processRef.on('uncaughtException', onUncaught);

  return () => {
    processRef.off?.('unhandledRejection', onUnhandled);
    processRef.off?.('uncaughtException', onUncaught);
  };
}
