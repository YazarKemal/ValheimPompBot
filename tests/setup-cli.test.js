import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs, runSetupCli } from '../src/setup/cli.js';
import { applyPlan } from '../src/setup/apply.js';
import { buildBlueprint } from '../src/setup/blueprint.js';
import { planSetup } from '../src/setup/planner.js';
import { createNullLogger } from '../src/utils/logger.js';
import { createFakeGuild } from './helpers/fake-guild.js';
import { createFakeSession, miningFoolsSeed } from './helpers/fake-session.js';

function capture() {
  const chunks = [];
  return {
    stream: { write: (chunk) => chunks.push(String(chunk)) },
    text: () => chunks.join(''),
  };
}

/** Runs the CLI with captured output and a hermetic environment. */
async function run(argv, extra = {}) {
  const out = capture();
  const err = capture();
  const exitCode = await runSetupCli({
    argv,
    stdout: out.stream,
    stderr: err.stream,
    env: { LOG_LEVEL: 'info' },
    ...extra,
  });
  return { exitCode, stdout: out.text(), stderr: err.text() };
}

/** Guild id used by the live-apply CLI tests. Must be a valid snowflake. */
const LIVE_GUILD_ID = '111111111111111111';

/** Environment for a live-apply invocation: Discord credentials present. */
function liveEnv(overrides = {}) {
  return {
    LOG_LEVEL: 'info',
    DRY_RUN: 'false',
    DISCORD_TOKEN: 'x'.repeat(60),
    DISCORD_CLIENT_ID: '123456789012345678',
    DISCORD_GUILD_ID: LIVE_GUILD_ID,
    DISCORD_EXPECTED_GUILD_NAME: 'MiningFools',
    ...overrides,
  };
}

/** A snapshot of a guild that already matches the blueprint exactly. */
async function convergedSnapshot() {
  const guild = createFakeGuild();
  await applyPlan(planSetup(buildBlueprint('valheim'), guild.snapshot()), {
    adapter: guild.adapter,
    dryRun: false,
    logger: createNullLogger(),
  });
  return guild.snapshot();
}

/* -------------------------------------------------------------------------- */

test('parseArgs reads flags and rejects unknown ones', () => {
  assert.deepEqual(parseArgs([]), {
    json: false,
    apply: false,
    confirm: false,
    fromJson: null,
    blueprint: 'miningfools',
    help: false,
  });
  assert.equal(parseArgs(['--json']).json, true);
  assert.equal(parseArgs(['--apply']).apply, true);
  assert.equal(parseArgs(['--apply', '--confirm']).confirm, true);
  assert.equal(parseArgs(['--from-json', 'a.json']).fromJson, 'a.json');
  assert.equal(parseArgs(['--blueprint', 'valheim']).blueprint, 'valheim');
  assert.equal(parseArgs(['-h']).help, true);
  assert.match(parseArgs(['--nope']).error, /Unknown argument/);
  assert.match(parseArgs(['--from-json']).error, /requires a value/);
  assert.match(parseArgs(['--blueprint']).error, /requires a value/);
});

test('--help prints usage and succeeds', async () => {
  const { exitCode, stdout } = await run(['--help']);

  assert.equal(exitCode, 0);
  assert.match(stdout, /PompBot server setup planner/);
  assert.match(stdout, /--from-json/);
});

test('an unknown argument fails with usage on stderr', async () => {
  const { exitCode, stdout, stderr } = await run(['--wat']);

  assert.equal(exitCode, 2);
  assert.equal(stdout, '');
  assert.match(stderr, /Unknown argument/);
});

test('a missing snapshot file fails readably', async () => {
  const { exitCode, stderr } = await run(['--from-json', 'does-not-exist.json']);

  assert.equal(exitCode, 1);
  assert.match(stderr, /Could not read snapshot/);
  assert.match(stderr, /does-not-exist\.json/);
});

test('planning against an empty server lists every resource', async () => {
  const { exitCode, stdout } = await run(['--blueprint', 'valheim']);

  assert.equal(exitCode, 0);
  assert.match(stdout, /Setup plan \(blueprint v1\)/);
  assert.match(stdout, /CREATE ROLE {6}"Chieftain"/);
  assert.match(stdout, /CREATE CATEGORY {2}"STAFF"/);
  assert.match(stdout, /CREATE CHANNEL {3}text "staff-chat"/);
});

test('--blueprint selects a different layout', async () => {
  const { exitCode, stdout } = await run(['--blueprint', 'miningfools']);

  assert.equal(exitCode, 0);
  assert.match(stdout, /CREATE CATEGORY {2}"⛏️ MININGFOOLS"/);
  assert.match(stdout, /CREATE CHANNEL {3}voice "Geliştirme Odası" in "🔊 SES"/);
  assert.ok(!stdout.includes('Chieftain'), 'the valheim blueprint leaked into the miningfools plan');
});

test('an unknown blueprint fails readably', async () => {
  const { exitCode, stderr } = await run(['--blueprint', 'nope']);

  assert.equal(exitCode, 1);
  assert.match(stderr, /Unknown blueprint/);
  assert.match(stderr, /miningfools/);
});

test('planning against a converged snapshot reports nothing to do', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pompbot-'));
  const snapshotPath = path.join(directory, 'snapshot.json');
  await writeFile(snapshotPath, JSON.stringify(await convergedSnapshot()), 'utf8');

  const { exitCode, stdout } = await run(['--blueprint', 'valheim', '--from-json', snapshotPath]);

  assert.equal(exitCode, 0);
  assert.match(stdout, /Everything already matches the blueprint/);
  assert.ok(!stdout.includes('CREATE ROLE'), 'a converged server still wanted changes');
});

test('--json emits parseable JSON and writes nothing to stdout but JSON', async () => {
  const { exitCode, stdout } = await run(['--json']);

  assert.equal(exitCode, 0);
  // Regression guard: a log line on stdout would make this throw.
  const plan = JSON.parse(stdout);
  assert.equal(typeof plan.version, 'number');
  assert.ok(Array.isArray(plan.actions));
  assert.ok(plan.actions.length > 0);
});

test('a preview tells the operator how to apply for real', async () => {
  const { stdout } = await run([]);
  assert.match(stdout, /npm run setup:apply -- --confirm/);
});

/* -------------------------------------------------------------------------- */
/* Live apply CLI gates                                                        */
/* -------------------------------------------------------------------------- */

test('--apply without --confirm is refused before connecting', async () => {
  let connected = false;
  const { exitCode, stderr } = await run(['--apply'], {
    env: liveEnv(),
    createSession: async () => {
      connected = true;
      throw new Error('should not connect');
    },
  });

  assert.equal(exitCode, 1);
  assert.match(stderr, /--confirm is required/);
  assert.equal(connected, false, 'the CLI connected despite a missing confirmation');
});

test('--apply --confirm is refused while DRY_RUN is true, before connecting', async () => {
  let connected = false;
  const { exitCode, stderr } = await run(['--apply', '--confirm'], {
    env: liveEnv({ DRY_RUN: 'true' }),
    createSession: async () => {
      connected = true;
      throw new Error('should not connect');
    },
  });

  assert.equal(exitCode, 1);
  assert.match(stderr, /DRY_RUN is true/);
  assert.equal(connected, false, 'the CLI connected despite DRY_RUN=true');
});

test('--apply --confirm is refused when DISCORD_GUILD_ID is missing', async () => {
  let connected = false;
  const { exitCode, stderr } = await run(['--apply', '--confirm'], {
    env: liveEnv({ DISCORD_GUILD_ID: '' }),
    createSession: async () => {
      connected = true;
      throw new Error('should not connect');
    },
  });

  assert.equal(exitCode, 1);
  assert.match(stderr, /DISCORD_GUILD_ID must be set/);
  // Pins the gate order: DRY_RUN is already false here, so the guild-id gate
  // must be the one that fired.
  assert.ok(!/DRY_RUN/.test(stderr), 'the DRY_RUN gate fired before the guild-id gate');
  assert.equal(connected, false);
});

test('the gates fire in a fixed order: confirm, then DRY_RUN, then guild id', async () => {
  const neverConnects = async () => {
    throw new Error('should not connect');
  };

  // All three unsatisfied -> the first gate wins.
  const all = await run(['--apply'], {
    env: liveEnv({ DRY_RUN: 'true', DISCORD_GUILD_ID: '' }),
    createSession: neverConnects,
  });
  assert.match(all.stderr, /--confirm is required/);

  // Confirm satisfied, DRY_RUN still true -> the second gate wins.
  const dryRun = await run(['--apply', '--confirm'], {
    env: liveEnv({ DRY_RUN: 'true', DISCORD_GUILD_ID: '' }),
    createSession: neverConnects,
  });
  assert.match(dryRun.stderr, /DRY_RUN is true/);
  assert.ok(!/--confirm is required/.test(dryRun.stderr));

  // Confirm and DRY_RUN satisfied -> the third gate wins.
  const guildId = await run(['--apply', '--confirm'], {
    env: liveEnv({ DRY_RUN: 'false', DISCORD_GUILD_ID: '' }),
    createSession: neverConnects,
  });
  assert.match(guildId.stderr, /DISCORD_GUILD_ID must be set/);
  assert.ok(!/DRY_RUN is true/.test(guildId.stderr));
});

test('--apply --confirm runs the pipeline and reports convergence', async () => {
  const session = createFakeSession({
    id: LIVE_GUILD_ID,
    seed: miningFoolsSeed(),
  });

  const { exitCode, stdout } = await run(['--apply', '--confirm'], {
    env: liveEnv(),
    createSession: async () => session,
  });

  assert.equal(exitCode, 0);
  assert.match(stdout, /Setup plan \(blueprint v1\)/);
  assert.match(stdout, /APPLY COMPLETE/);
  assert.match(stdout, /status: CONVERGED/);
  assert.equal(session.closed, true, 'the session was not closed');
});

test('a safety-gate abort exits non-zero and lists the violations', async () => {
  const session = createFakeSession({
    id: LIVE_GUILD_ID,
    name: 'Valheim Pomp',
    seed: miningFoolsSeed(),
  });

  const { exitCode, stderr } = await run(['--apply', '--confirm'], {
    env: liveEnv(),
    createSession: async () => session,
  });

  assert.equal(exitCode, 1);
  assert.match(stderr, /not the configured MiningFools guild/);
  assert.match(stderr, /Safety violations:/);
  assert.match(stderr, /Nothing was written/);
});
