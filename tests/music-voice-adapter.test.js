import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { StreamType } from '@discordjs/voice';
import { createDiscordVoiceAdapter, PLAY_START_TIMEOUT_MS, VOICE_EVENTS } from '../src/music/voice.js';
import { createCapturingLogger, createNullLogger } from '../src/utils/logger.js';

/**
 * The Discord voice adapter's playback gate.
 *
 * A real AudioPlayer is used - it needs no gateway and no connection - so the
 * promise returned by `play()` is checked against the actual state machine
 * rather than against a simulation of it.
 *
 * `StreamType.Opus` is used because it needs no decoder: the resource's stream
 * is then the input stream itself, so "the player reached Playing" can be
 * triggered by writing a frame.
 */

const settle = () => new Promise((resolve) => setImmediate(resolve));

const OPUS_FRAME = Buffer.alloc(960);

function adapterWith(options = {}) {
  return createDiscordVoiceAdapter({
    guild: { id: 'g1' },
    logger: createNullLogger(),
    playStartTimeoutMs: 200,
    ...options,
  });
}

test('play stays pending until the player actually starts', async () => {
  const adapter = adapterWith();
  const stream = new PassThrough();

  const started = adapter.play(stream, { inputType: StreamType.Opus });
  let settled = false;
  void started.then(() => {
    settled = true;
  });

  await settle();
  await settle();
  assert.equal(settled, false, 'play resolved before the player started');

  stream.write(OPUS_FRAME);
  const outcome = await started;

  assert.equal(outcome.ok, true);
  assert.equal(outcome.status, 'playing');
  adapter.destroy();
});

test('play reports a stream that never becomes playable', async () => {
  const adapter = adapterWith();
  const stream = new PassThrough();

  const started = adapter.play(stream, { inputType: StreamType.Opus });
  stream.destroy();
  const outcome = await started;

  assert.equal(outcome.ok, false, 'an unplayable stream was reported as playing');
  assert.ok(outcome.reason, 'no reason was given for the failure');
  adapter.destroy();
});

test('play gives up when the player never leaves buffering', async () => {
  const adapter = adapterWith({ playStartTimeoutMs: 40 });
  const stream = new PassThrough();

  const outcome = await adapter.play(stream, { inputType: StreamType.Opus });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'start-timeout');
  adapter.destroy();
});

test('the default start timeout is a real bound, not zero', () => {
  assert.equal(PLAY_START_TIMEOUT_MS, 15000);
});

test('player state transitions are logged and emitted', async () => {
  const { logger, text } = createCapturingLogger({ level: 'debug' });
  const adapter = adapterWith({ logger });
  const transitions = [];
  adapter.on('playerState', (payload) => transitions.push(payload.to));

  const stream = new PassThrough();
  const started = adapter.play(stream, { inputType: StreamType.Opus, metadata: { trackId: 'abc' } });
  stream.write(OPUS_FRAME);
  await started;

  assert.ok(text().includes('Audio player state changed'), 'state transitions were not logged');
  assert.ok(text().includes('buffering'), 'the buffering state was not observed');
  assert.ok(transitions.includes('playing'), `no playing transition was emitted: ${transitions.join(', ')}`);
  adapter.destroy();
});

test('the documented event names include the state stream', () => {
  assert.deepEqual([...VOICE_EVENTS], ['idle', 'error', 'stateChange', 'playerState']);
});
