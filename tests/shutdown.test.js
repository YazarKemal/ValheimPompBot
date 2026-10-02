import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createShutdownController, installCrashHandlers } from '../src/utils/shutdown.js';
import { createCapturingLogger } from '../src/utils/logger.js';

/** A stand-in for `process`: signal emitter plus exit/stderr capture. */
function makeProcess() {
  const emitter = new EventEmitter();
  const exits = [];
  emitter.exit = (code) => exits.push(code);
  emitter.exits = exits;
  return emitter;
}

/* -------------------------------------------------------------------------- */
/* Graceful shutdown                                                           */
/* -------------------------------------------------------------------------- */

test('SIGINT runs the shutdown routine once and resolves', async () => {
  const processRef = makeProcess();
  const { logger, text } = createCapturingLogger({ level: 'debug' });
  let closes = 0;

  const controller = createShutdownController({
    logger,
    processRef,
    onShutdown: async () => {
      closes += 1;
    },
  });

  processRef.emit('SIGINT');

  assert.equal(await controller.done, 'SIGINT');
  assert.equal(closes, 1);
  assert.match(text(), /Received SIGINT/);
  assert.match(text(), /Shutdown complete/);
});

test('SIGTERM is handled the same way', async () => {
  const processRef = makeProcess();
  let reason = null;

  const controller = createShutdownController({
    processRef,
    onShutdown: async (signal) => {
      reason = signal;
    },
  });

  processRef.emit('SIGTERM');
  await controller.done;

  assert.equal(reason, 'SIGTERM');
});

test('a repeated signal forces an exit instead of hanging', async () => {
  const processRef = makeProcess();
  const { logger, text } = createCapturingLogger({ level: 'debug' });
  let resolveShutdown;

  const controller = createShutdownController({
    logger,
    processRef,
    // A shutdown that never finishes, to model a wedged connection.
    onShutdown: () => new Promise((resolve) => { resolveShutdown = resolve; }),
  });

  processRef.emit('SIGINT');
  // onShutdown is invoked on a microtask; let it start before the second signal.
  await new Promise((resolve) => setImmediate(resolve));

  processRef.emit('SIGINT');

  assert.deepEqual(processRef.exits, [1], 'the second signal did not force an exit');
  assert.match(text(), /forcing exit/);

  resolveShutdown();
  await controller.done;
});

test('only one shutdown runs no matter how many signals arrive', async () => {
  const processRef = makeProcess();
  let closes = 0;

  const controller = createShutdownController({
    processRef,
    onShutdown: async () => {
      closes += 1;
    },
  });

  processRef.emit('SIGINT');
  await controller.done;
  processRef.emit('SIGTERM');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(closes, 1, 'shutdown ran more than once');
});

test('a failing shutdown is logged and still resolves', async () => {
  const processRef = makeProcess();
  const { logger, text } = createCapturingLogger({ level: 'debug' });

  const controller = createShutdownController({
    logger,
    processRef,
    onShutdown: async () => {
      throw new Error('close exploded');
    },
  });

  processRef.emit('SIGINT');

  assert.equal(await controller.done, 'SIGINT');
  assert.match(text(), /Error during shutdown/);
});

test('handlers are detached after shutdown', async () => {
  const processRef = makeProcess();
  const controller = createShutdownController({ processRef, onShutdown: async () => {} });

  assert.equal(processRef.listenerCount('SIGINT'), 1);
  processRef.emit('SIGINT');
  await controller.done;

  assert.equal(processRef.listenerCount('SIGINT'), 0);
  assert.equal(processRef.listenerCount('SIGTERM'), 0);
  assert.equal(controller.isShuttingDown(), true);
});

test('detach removes handlers without running shutdown', () => {
  const processRef = makeProcess();
  createShutdownController({ processRef, onShutdown: async () => {} }).detach();

  assert.equal(processRef.listenerCount('SIGINT'), 0);
  assert.equal(processRef.listenerCount('SIGTERM'), 0);
});

/* -------------------------------------------------------------------------- */
/* Crash handlers                                                              */
/* -------------------------------------------------------------------------- */

test('an unhandled rejection is logged and reported as fatal', async () => {
  const processRef = makeProcess();
  const { logger, text } = createCapturingLogger({ level: 'debug' });
  const fatal = [];

  const detach = installCrashHandlers({ logger, processRef, onFatal: (error) => fatal.push(error) });

  processRef.emit('unhandledRejection', new Error('nobody caught me'));
  processRef.emit('uncaughtException', new Error('boom'));

  assert.equal(fatal.length, 2);
  assert.match(text(), /Unhandled promise rejection/);
  assert.match(text(), /Uncaught exception/);

  detach();
  assert.equal(processRef.listenerCount('unhandledRejection'), 0);
  assert.equal(processRef.listenerCount('uncaughtException'), 0);
});

/* -------------------------------------------------------------------------- */
/* Startup logging                                                             */
/* -------------------------------------------------------------------------- */

test('startup logging never contains the token', async () => {
  const processRef = makeProcess();
  const { logger, text } = createCapturingLogger({ level: 'debug' });
  const secret = 'M'.repeat(24) + '.' + 'X'.repeat(6) + '.' + 'Y'.repeat(38);

  const controller = createShutdownController({
    logger,
    processRef,
    onShutdown: async () => {
      logger.info('closing the client that used the token', { token: secret });
    },
  });

  processRef.emit('SIGINT');
  await controller.done;

  assert.ok(!text().includes(secret), 'the token reached the log stream');
  assert.match(text(), /\[redacted\]/);
});
