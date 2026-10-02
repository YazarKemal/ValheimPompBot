#!/usr/bin/env node
/**
 * `npm run check` - offline pre-flight validation.
 *
 * Verifies syntax, configuration handling, module loadability, blueprint
 * integrity and AI provider wiring without connecting to Discord and without
 * making a single network request.
 */

import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const results = [];
let currentGroup = 'general';

function group(name) {
  currentGroup = name;
  process.stdout.write(`\n${name}\n${'-'.repeat(name.length)}\n`);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ group: currentGroup, name, ok: true, detail });
    process.stdout.write(`  PASS  ${name}${detail ? ` - ${detail}` : ''}\n`);
  } catch (error) {
    results.push({ group: currentGroup, name, ok: false, detail: error.message });
    process.stdout.write(`  FAIL  ${name}\n        ${error.message}\n`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function listJsFiles(relativeDir) {
  const files = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  }
  await walk(path.join(ROOT, relativeDir));
  return files;
}

/* -------------------------------------------------------------------------- */

group('Repository hygiene');

await check('.env is git-ignored', () => {
  const result = spawnSync('git', ['check-ignore', '--quiet', '.env'], { cwd: ROOT });
  if (result.error) return 'git unavailable, skipped';
  assert(result.status === 0, '.env is NOT ignored by git - secrets could be committed');
  return 'confirmed';
});

await check('.env is not tracked by git', () => {
  const result = spawnSync('git', ['ls-files', '--error-unmatch', '.env'], { cwd: ROOT });
  if (result.error) return 'git unavailable, skipped';
  assert(result.status !== 0, '.env is tracked by git - remove it from the index');
  return 'confirmed';
});

await check('.env.example contains placeholders only', async () => {
  const contents = await readFile(path.join(ROOT, '.env.example'), 'utf8');
  const tokenLine = contents.split('\n').find((line) => line.startsWith('DISCORD_TOKEN='));
  assert(tokenLine !== undefined, '.env.example does not define DISCORD_TOKEN');
  const value = tokenLine.slice('DISCORD_TOKEN='.length).trim();
  assert(value === 'your-bot-token-here', `unexpected DISCORD_TOKEN placeholder: "${value}"`);
  assert(!/^[A-Za-z0-9_-]{20,}\./.test(value), 'DISCORD_TOKEN looks like a real token');
  return 'no real credentials';
});

/* -------------------------------------------------------------------------- */

group('Syntax');

const sourceFiles = [...(await listJsFiles('src')), ...(await listJsFiles('scripts')), ...(await listJsFiles('tests'))];

await check(`node --check on ${sourceFiles.length} file(s)`, () => {
  const failures = [];
  for (const file of sourceFiles) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) {
      failures.push(`${path.relative(ROOT, file)}: ${(result.stderr || '').split('\n')[0]}`);
    }
  }
  assert(failures.length === 0, `syntax errors:\n        ${failures.join('\n        ')}`);
  return 'all parse';
});

await check('every src module imports cleanly', async () => {
  const modules = sourceFiles.filter((file) => file.startsWith(path.join(ROOT, 'src')));
  for (const file of modules) {
    // Dynamic import is safer than a parse-only pass: it also catches bad
    // specifiers and module-level crashes.
    await import(pathToFileURL(file).href);
  }
  return `${modules.length} module(s)`;
});

await check('no direct network usage outside the vendor adapters', async () => {
  // Vendor HTTP belongs in the adapters and nowhere else. There are exactly two
  // such places: the AI providers, and the free-game store readers.
  const adapters = [path.join(ROOT, 'src', 'ai', 'providers'), path.join(ROOT, 'src', 'giveaways', 'providers')];
  const offenders = [];
  const adaptersWithNetwork = [];
  for (const file of sourceFiles.filter((f) => f.startsWith(path.join(ROOT, 'src')))) {
    const contents = await readFile(file, 'utf8');
    const code = contents.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // A global fetch() call, or a reference to globalThis.fetch for injection.
    // `guild.fetch()` is a discord.js API call and does not match either.
    const reachesNetwork = /(?<![.\w$])fetch\s*\(/.test(code) || /\bglobalThis\.fetch\b/.test(code);
    if (!reachesNetwork) continue;
    if (adapters.some((adapter) => file.startsWith(adapter))) adaptersWithNetwork.push(path.relative(ROOT, file));
    else offenders.push(path.relative(ROOT, file));
  }
  assert(offenders.length === 0, `unexpected network access in: ${offenders.join(', ')}`);

  const expected = [
    path.join('src', 'ai', 'providers', 'deepseek.js'),
    path.join('src', 'giveaways', 'providers', 'epic.js'),
    path.join('src', 'giveaways', 'providers', 'steam.js'),
    path.join('src', 'giveaways', 'providers', 'steamdb', 'index.js'),
    path.join('src', 'giveaways', 'providers', 'itad', 'index.js'),
  ];
  assert(
    adaptersWithNetwork.slice().sort().join('|') === expected.slice().sort().join('|'),
    `expected exactly ${expected.join(', ')}, found: ${adaptersWithNetwork.join(', ') || '(none)'}`,
  );
  return `${adaptersWithNetwork.length} adapters`;
});

/* -------------------------------------------------------------------------- */

group('Configuration');

const config = await import(pathToFileURL(path.join(ROOT, 'src/config/index.js')).href);

await check('missing variables are reported, not thrown as a crash', () => {
  const { config: parsed, issues } = config.parseEnv({});
  assert(parsed === null, 'parseEnv returned a config for an empty environment');
  const keys = issues.map((issue) => issue.key);
  assert(keys.includes('DISCORD_TOKEN'), 'DISCORD_TOKEN was not reported as missing');
  assert(keys.includes('DISCORD_CLIENT_ID'), 'DISCORD_CLIENT_ID was not reported as missing');
  return `${issues.length} issue(s) collected`;
});

await check('error details never contain secret values', () => {
  const secret = 'SUPERSECRETVALUE1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let thrown = null;
  try {
    config.loadConfig({ env: { DISCORD_TOKEN: secret }, loadDotenv: false });
  } catch (error) {
    thrown = error;
  }
  assert(thrown !== null, 'expected an error for an invalid token');
  assert(!JSON.stringify(thrown.details ?? {}).includes(secret), 'the offending token leaked into the error');
  assert(!thrown.message.includes(secret), 'the offending token leaked into the message');
  return 'redacted';
});

await check('.env.example values parse successfully', async () => {
  const contents = await readFile(path.join(ROOT, '.env.example'), 'utf8');
  const env = {};
  for (const line of contents.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) env[match[1]] = match[2];
  }
  // The placeholder token is intentionally too short to be valid.
  env.DISCORD_TOKEN = 'x'.repeat(60);
  const { config: parsed, issues } = config.parseEnv(env, { requireDiscord: true });
  assert(issues.length === 0, `issues: ${issues.map((i) => `${i.key} ${i.problem}`).join('; ')}`);
  assert(parsed.dryRun === true, 'DRY_RUN should default to true');
  assert(parsed.connect === false, 'BOT_CONNECT should default to false');
  assert(parsed.ai.provider === 'stub', 'AI_PROVIDER should default to stub');
  return 'valid';
});

await check('discord credentials are optional for offline setup', () => {
  const { config: parsed, issues } = config.parseEnv({}, { requireDiscord: false });
  assert(issues.length === 0, `issues: ${issues.map((i) => i.key).join(', ')}`);
  assert(parsed.discord.token === null, 'token should be null when not required');
  return 'planned offline';
});

await check('describeConfig redacts the token', () => {
  const description = JSON.stringify(config.describeConfig({ ...config.parseEnv({ DISCORD_TOKEN: 'a'.repeat(60), DISCORD_CLIENT_ID: '1'.repeat(18) }).config }));
  assert(!description.includes('a'.repeat(60)), 'the token appeared in the config summary');
  return 'redacted';
});

/* -------------------------------------------------------------------------- */

group('Commands and events');

const { loadCommands } = await import(pathToFileURL(path.join(ROOT, 'src/commands/index.js')).href);
const { loadEvents, validateEventModule } = await import(pathToFileURL(path.join(ROOT, 'src/events/index.js')).href);
const { validateBlueprint, buildBlueprint, listBlueprints, DEFAULT_BLUEPRINT } = await import(
  pathToFileURL(path.join(ROOT, 'src/setup/blueprint.js')).href
);
const { createMiningFoolsBlueprint } = await import(
  pathToFileURL(path.join(ROOT, 'src/setup/blueprints/miningfools.js')).href
);
const { planSetup, assertNoDestructiveActions, countMutations, ACTION_KINDS } = await import(
  pathToFileURL(path.join(ROOT, 'src/setup/planner.js')).href
);
const { emptyGuildState } = await import(pathToFileURL(path.join(ROOT, 'src/setup/state.js')).href);
const { createRegistry } = await import(pathToFileURL(path.join(ROOT, 'src/ai/registry.js')).href);

const commands = await loadCommands(undefined, { owner: 'pompai' });
const musicCommands = await loadCommands(undefined, { owner: 'pompmusic' });

await check('slash commands load', () => {
  assert(commands.size > 0, 'no commands were loaded');
  return `${commands.size}: ${[...commands.keys()].sort().join(', ')}`;
});

await check('command payloads are JSON-serialisable', () => {
  for (const command of commands.values()) {
    const json = JSON.parse(JSON.stringify(command.data));
    assert(typeof json.name === 'string' && json.name.length > 0, `${command.name} has no name`);
    assert(typeof json.description === 'string' && json.description.length > 0, `${command.name} has no description`);
    assert(json.name === json.name.toLowerCase(), `${command.name} is not lowercase`);
  }
  return 'valid';
});

await check('event handlers load and are well-formed', async () => {
  const events = await loadEvents();
  assert(events.length > 0, 'no events were loaded');
  for (const event of events) {
    assert(validateEventModule({ name: event.name, execute: event.execute, once: event.once }).length === 0, 'invalid');
  }
  return `${events.length}: ${events.map((e) => e.name).join(', ')}`;
});

await check('a malformed event module is rejected', () => {
  const problems = validateEventModule({ name: 'ready', execute: 'not-a-function' }, 'bad.js');
  assert(problems.length > 0, 'a malformed event module was accepted');
  return 'rejected';
});

/* -------------------------------------------------------------------------- */

group('Server setup');

await check('every registered blueprint is structurally valid', () => {
  const names = listBlueprints();
  assert(names.includes(DEFAULT_BLUEPRINT), `the default blueprint "${DEFAULT_BLUEPRINT}" is not registered`);
  for (const name of names) {
    const problems = validateBlueprint(buildBlueprint(name));
    assert(problems.length === 0, `${name}: ${problems.join('; ')}`);
  }
  return names.join(', ');
});

await check('the MiningFools blueprint matches the Phase 2B spec', () => {
  const miningFools = buildBlueprint('miningfools');
  assert(miningFools.categories.length === 9, `expected 9 categories, found ${miningFools.categories.length}`);
  assert(miningFools.channels.length === 27, `expected 27 channels, found ${miningFools.channels.length}`);
  assert(
    miningFools.channels.some((channel) => channel.name === 'pompai'),
    '#pompai is missing from the blueprint',
  );
  assert(
    miningFools.channels.some((channel) => channel.name === 'bedava-oyunlar'),
    '#bedava-oyunlar is missing from the blueprint',
  );
  const plan = planSetup(miningFools, emptyGuildState());
  assert(countMutations(plan) === 36, `expected 36 changes, found ${countMutations(plan)}`);
  return '9 categories, 27 channels, 36 changes';
});

await check('the snapshot module contains no mutating call', async () => {
  const files = [
    path.join(ROOT, 'src/setup/snapshot.js'),
    path.join(ROOT, 'src/setup/snapshot-cli.js'),
  ];
  const offenders = [];
  for (const file of files) {
    const contents = await readFile(file, 'utf8');
    const code = contents
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      // The guard itself names the methods it blocks; that is the one place
      // they are allowed to appear.
      .replace(/export const MUTATING_METHODS[\s\S]*?\];/, '');
    for (const verb of [/\bcreate\s*\(/, /\bedit\s*\(/, /\bdelete\s*\(/, /\bsetName\s*\(/, /\bbulkDelete\s*\(/]) {
      if (verb.test(code)) offenders.push(`${path.relative(ROOT, file)} matches ${verb}`);
    }
  }
  assert(offenders.length === 0, offenders.join('; '));
  return 'read-only';
});

group('Live apply safety');

const safety = await import(pathToFileURL(path.join(ROOT, 'src/setup/safety.js')).href);
const { planSetup: planFor, ACTION_KINDS: KINDS, countMutations: countM } = await import(
  pathToFileURL(path.join(ROOT, 'src/setup/planner.js')).href
);

await check('the adapter exposes no delete method', async () => {
  const { createDiscordGuildAdapter } = await import(
    pathToFileURL(path.join(ROOT, 'src/setup/adapter.js')).href
  );
  const source = await readFile(path.join(ROOT, 'src/setup/adapter.js'), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert(!/\bdelete\b/.test(code), 'the adapter mentions delete; deletion must be structurally impossible');
  assert(!/\b(delete|bulkDelete)\s*\(/.test(code), 'the adapter can delete');
  assert(typeof createDiscordGuildAdapter === 'function');
  return 'create/update only';
});

await check('a clean MiningFools plan passes every safety gate', () => {
  // assertPlanIsSafe returns undefined on success and throws on failure.
  safety.assertPlanIsSafe(planFor(buildBlueprint('miningfools'), emptyGuildState()));
  return 'approved';
});

await check('the safety gate rejects destructive, role and unknown actions', () => {
  const rejected = [
    [{ kind: 'channel.delete', name: 'x' }, /destructive/],
    [{ kind: KINDS.ROLE_CREATE, name: 'x' }, /role mutation/],
    [{ kind: KINDS.ROLE_UPDATE, name: 'x' }, /role mutation/],
    [{ kind: 'channel.explode', name: 'x' }, /unexpected action type/],
  ];
  for (const [action, pattern] of rejected) {
    let thrown = null;
    try {
      safety.assertPlanIsSafe({ actions: [action] });
    } catch (error) {
      thrown = error;
    }
    assert(thrown !== null, `${action.kind} was accepted`);
    assert(thrown.code === 'LIVE_APPLY_ABORTED', `${action.kind} threw ${thrown.code}`);
    assert(pattern.test(thrown.violations.join(' ')), `${action.kind}: unexpected reason`);
  }
  return '4 action kinds refused';
});

await check('the safety gate refuses privileged permissions', () => {
  let thrown = null;
  try {
    safety.assertPlanIsSafe({
      actions: [
        {
          kind: KINDS.CHANNEL_UPDATE,
          id: 'c1',
          name: 'genel',
          changes: { overwriteEdits: [{ role: '@everyone', allow: ['Administrator'], deny: [] }] },
        },
      ],
    });
  } catch (error) {
    thrown = error;
  }
  assert(thrown !== null, 'an Administrator grant was accepted');
  assert(/privileged permission/.test(thrown.violations.join(' ')));
  return 'Administrator refused';
});

await check('the guild identity gate requires both id and name', () => {
  safety.assertGuildMatches({ id: 'g', name: 'MiningFools' }, { guildId: 'g', expectedName: 'MiningFools' });
  for (const guild of [{ id: 'other', name: 'MiningFools' }, { id: 'g', name: 'Something Else' }]) {
    let thrown = null;
    try {
      safety.assertGuildMatches(guild, { guildId: 'g', expectedName: 'MiningFools' });
    } catch (error) {
      thrown = error;
    }
    assert(thrown !== null, `guild ${guild.id}/${guild.name} was accepted`);
    assert(thrown.gate === 'guild-identity');
  }
  return 'id and name enforced';
});

await check('the live apply requires both opt-ins', async () => {
  const { liveApply } = await import(pathToFileURL(path.join(ROOT, 'src/setup/live-apply.js')).href);
  const config = {
    dryRun: false,
    discord: { guildId: 'g', expectedGuildName: 'MiningFools' },
  };
  const session = { guild: { id: 'g', name: 'MiningFools' }, adapter: {}, refresh: async () => emptyGuildState() };

  for (const [overrides, gate] of [
    [{ confirm: false }, 'confirmation'],
    [{ confirm: true, config: { ...config, dryRun: true } }, 'dry-run'],
  ]) {
    let thrown = null;
    try {
      await liveApply({ config, session, blueprint: buildBlueprint('miningfools'), confirm: true, ...overrides });
    } catch (error) {
      thrown = error;
    }
    assert(thrown !== null, `${gate} gate did not fire`);
    assert(thrown.gate === gate, `expected gate ${gate}, got ${thrown.gate}`);
  }
  return 'confirmation + DRY_RUN';
});

await check('a failed live apply never claims convergence', async () => {
  const { liveApply } = await import(pathToFileURL(path.join(ROOT, 'src/setup/live-apply.js')).href);
  const { createFakeSession, miningFoolsSeed } = await import(
    pathToFileURL(path.join(ROOT, 'tests/helpers/fake-session.js')).href
  );

  const session = createFakeSession({ id: '111111111111111111', seed: miningFoolsSeed() });
  session.fake.failOnce('createChannel');

  const result = await liveApply({
    config: {
      dryRun: false,
      discord: { guildId: '111111111111111111', expectedGuildName: 'MiningFools' },
    },
    session,
    blueprint: buildBlueprint('miningfools'),
    confirm: true,
  });

  assert(result.ok === false, 'a failed apply reported success');
  assert(result.verification === null, 'a failed apply reported a convergence result');
  assert(result.failure !== null, 'the failure was not reported');
  return 'fail-fast verified';
});

await check('a live apply converges and deletes nothing', async () => {
  const { liveApply } = await import(pathToFileURL(path.join(ROOT, 'src/setup/live-apply.js')).href);
  const { createFakeSession, miningFoolsSeed } = await import(
    pathToFileURL(path.join(ROOT, 'tests/helpers/fake-session.js')).href
  );

  const seed = miningFoolsSeed();
  const session = createFakeSession({ id: '111111111111111111', seed });
  const beforeIds = new Set([...seed.categories.map((c) => c.id), ...seed.channels.map((c) => c.id)]);

  const result = await liveApply({
    config: { dryRun: false, discord: { guildId: '111111111111111111', expectedGuildName: 'MiningFools' } },
    session,
    blueprint: buildBlueprint('miningfools'),
    confirm: true,
  });

  assert(result.ok, 'the apply did not converge');
  assert(result.verification.remaining === 0, 'a second plan still wants changes');
  assert(countM(planFor(buildBlueprint('miningfools'), session.state())) === 0, 'not idempotent');

  const after = session.state();
  for (const id of beforeIds) {
    const present = [...after.categories, ...after.channels].some((item) => item.id === id);
    assert(present, `resource ${id} was removed`);
  }
  assert(after.roles.length === 0, 'roles were created');
  return '0 mutations on re-plan, nothing removed';
});

const blueprint = buildBlueprint('valheim');
const freshPlan = planSetup(blueprint, emptyGuildState());

await check('planning against an empty server produces work', () => {
  assert(freshPlan.actions.length > 0, 'no actions were planned for an empty server');
  assert(countMutations(freshPlan) > 0, 'no mutations were planned');
  return `${countMutations(freshPlan)} change(s)`;
});

await check('plan contains no destructive action', () => {
  const problems = assertNoDestructiveActions(freshPlan);
  assert(problems.length === 0, problems.join('; '));
  const kinds = new Set(freshPlan.actions.map((a) => a.kind));
  assert(![...kinds].some((kind) => /delete|remove|destroy/i.test(kind)), 'a destructive kind is present');
  return 'non-destructive';
});

await check('roles are planned before channels that reference them', () => {
  const kinds = freshPlan.actions.map((a) => a.kind);
  const lastRole = Math.max(kinds.lastIndexOf(ACTION_KINDS.ROLE_CREATE), kinds.lastIndexOf(ACTION_KINDS.ROLE_UPDATE));
  const firstChannel = kinds.indexOf(ACTION_KINDS.CHANNEL_CREATE);
  if (firstChannel !== -1) {
    assert(lastRole < firstChannel, 'channels are planned before the roles they depend on');
  }
  const lastCategory = kinds.lastIndexOf(ACTION_KINDS.CATEGORY_CREATE);
  if (firstChannel !== -1 && lastCategory !== -1) {
    assert(lastCategory < firstChannel, 'channels are planned before their categories exist');
  }
  return 'ordering is safe';
});

await check('every planned channel targets a known category', () => {
  const categoryNames = new Set(blueprint.categories.map((c) => c.name));
  for (const action of freshPlan.actions) {
    if (action.kind !== ACTION_KINDS.CHANNEL_CREATE) continue;
    assert(categoryNames.has(action.parentName), `"${action.name}" targets unknown category "${action.parentName}"`);
  }
  return 'resolved';
});

/* -------------------------------------------------------------------------- */

group('PompAI commands');

await check('the command set is exactly as expected', () => {
  const names = [...commands.keys()].sort();
  assert(
    names.join(',') ===
      'ask,clear,envanter,fal,gunluk,help,kaz,lakap,liderlik,oyun,oyun-temizle,parti,ping,profil,status,ucretsiz',
    `unexpected set: ${names.join(',')}`,
  );
  return names.join(', ');
});

await check('every command is guild-scoped, never global', () => {
  for (const command of commands.values()) {
    assert(command.data.dm_permission === false, `${command.name} is usable in DMs`);
  }
  return 'guild-only';
});

await check('deploy modules are not parsed as slash commands', () => {
  assert(!commands.has('deploy'), 'src/deploy leaked into the command registry');
  return 'isolated';
});

await check('command registration refuses to run without a guild id', async () => {
  const { assertGuildScoped, deployGuildCommands } = await import(
    pathToFileURL(path.join(ROOT, 'src/deploy/index.js')).href
  );
  for (const guildId of [null, '', '  ']) {
    let thrown = null;
    try {
      assertGuildScoped(guildId);
    } catch (error) {
      thrown = error;
    }
    assert(thrown !== null, `guild id ${JSON.stringify(guildId)} was accepted`);
    assert(thrown.code === 'DEPLOY_GUILD_REQUIRED');
  }

  // And the full deploy path refuses too, before touching the API.
  let deployThrew = null;
  try {
    await deployGuildCommands({ token: 'x', clientId: '1', guildId: null, commands });
  } catch (error) {
    deployThrew = error;
  }
  assert(deployThrew !== null && deployThrew.code === 'DEPLOY_GUILD_REQUIRED', 'deploy accepted a missing guild');
  return 'guild-scoped only';
});

await check('registration only ever targets a guild route', async () => {
  const source = await readFile(path.join(ROOT, 'src/deploy/index.js'), 'utf8');
  assert(
    /Routes\.applicationGuildCommands\(/.test(source),
    'the guild command route is not used',
  );
  assert(
    !/Routes\.applicationCommands\(/.test(source),
    'the global command route is referenced; global registration is not supported',
  );
  return 'Routes.applicationGuildCommands';
});

await check('the /status payload contains no secrets', async () => {
  const { createAIClient } = await import(pathToFileURL(path.join(ROOT, 'src/ai/index.js')).href);
  const client = createAIClient({ provider: 'stub', apiKey: 'sk-secret', model: null, timeoutMs: 1000 });
  const described = JSON.stringify(client.describe());

  assert(!described.includes('sk-secret'), 'the AI API key is exposed by describe()');
  assert(client.describe().live === false, 'the stub provider reports itself as live');
  assert(client.describe().stub === true, 'the stub provider is not flagged as a stub');
  return 'no credentials in describe()';
});

/* -------------------------------------------------------------------------- */

group('Music');

await check('the two bots own disjoint command sets', () => {
  const ai = [...commands.keys()].sort();
  const music = [...musicCommands.keys()].sort();

  const overlap = ai.filter((name) => music.includes(name));
  assert(overlap.length === 0, `registered to both applications: ${overlap.join(', ')}`);
  assert(music.includes('gel'), 'PompMusic is missing /gel');
  assert(music.includes('git'), 'PompMusic is missing /git');
  assert(music.includes('durdur-ve-git'), 'PompMusic is missing /durdur-ve-git');
  assert(music.includes('kapisma'), 'PompMusic is missing /kapisma - song battles belong to it');
  assert(ai.includes('ask') && ai.includes('oyun'), 'PompAI lost an AI command');

  // The fun layer is PompAI's, and must not leak into the music application.
  const funCommands = ['kaz', 'gunluk', 'envanter', 'profil', 'liderlik', 'parti', 'lakap', 'fal'];
  for (const name of funCommands) {
    assert(ai.includes(name), `PompAI is missing /${name}`);
    assert(!music.includes(name), `/${name} is registered to PompMusic`);
  }
  assert(!ai.includes('kapisma'), '/kapisma is registered to PompAI');
  return `PompAI ${ai.length}, PompMusic ${music.length}`;
});

await check('PompMusic uses its own credentials, never PompAI\'s', async () => {
  const source = await readFile(path.join(ROOT, 'src', 'music', 'bot.js'), 'utf8');
  assert(/POMPMUSIC_TOKEN|settings\.token/.test(source), 'PompMusic does not read its own token');
  assert(!/discord\.token/.test(source), 'PompMusic reaches for PompAI\'s token');

  const deploy = await readFile(path.join(ROOT, 'src', 'deploy', 'cli.js'), 'utf8');
  assert(/pompMusic\.token/.test(deploy) && /pompMusic\.clientId/.test(deploy), 'music commands are not deployed with PompMusic credentials');
  assert(/--owner/.test(deploy), 'the deploy CLI cannot select an owner');
  return 'separate token and client id';
});

await check('PompAI does not request the privileged Message Content intent', async () => {
  const code = (await readFile(path.join(ROOT, 'src', 'index.js'), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  assert(!/MessageContent/.test(code), 'PompAI asks for Message Content');
  assert(!/GuildVoiceStates/.test(code), 'PompAI asks for voice states');

  const musicBot = await readFile(path.join(ROOT, 'src', 'music', 'bot.js'), 'utf8');
  assert(/MessageContent/.test(musicBot), 'PompMusic does not ask for Message Content');
  return 'intent scoped to PompMusic';
});

await check('voice state is read through one shared resolver', async () => {
  const files = await listJsFiles('src/music');
  const offenders = [];

  for (const file of files) {
    if (path.basename(file) === 'voice-state.js') continue;
    const code = (await readFile(file, 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    if (/\.voice\?\.channelId|\.voice\.channelId/.test(code)) offenders.push(path.relative(ROOT, file));
  }
  assert(offenders.length === 0, `voice state read outside the resolver in: ${offenders.join(', ')}`);
  return `${files.length} file(s), one resolver`;
});

await check('the resolver handles the raw API member shape', async () => {
  const { resolveMemberVoiceChannel } = await import(
    pathToFileURL(path.join(ROOT, 'src/music/voice-state.js')).href
  );
  const guild = {
    id: 'g',
    voiceStates: { cache: new Map([['u1', { channelId: 'vc1' }]]) },
    members: { cache: new Map() },
  };
  // The raw API member has no `voice` property at all - the shape that broke
  // the live /gel.
  const rawMember = { id: 'u1', deaf: false, mute: false };

  assert(!('voice' in rawMember), 'the fixture is not a raw member');
  assert(resolveMemberVoiceChannel({ guild, userId: 'u1', member: rawMember }) === 'vc1', 'raw member not resolved');
  assert(resolveMemberVoiceChannel({ guild, userId: 'u1', member: null }) === 'vc1', 'null member not resolved');
  assert(resolveMemberVoiceChannel({ guild: { id: 'g' }, userId: 'u2' }) === null, 'a disconnected user resolved');
  return 'cache first, member as fallback';
});

await check('a request never summons PompMusic', async () => {
  const { handleMusicRequest } = await import(
    pathToFileURL(path.join(ROOT, 'src/music/listener.js')).href
  );
  const { createSessionManager } = await import(pathToFileURL(path.join(ROOT, 'src/music/session.js')).href);

  const sessions = createSessionManager();
  let searchRan = false;
  const deps = {
    source: {
      async search() {
        searchRan = true;
        return [];
      },
    },
    sessions,
    selections: null,
    guard: { check: () => ({ ok: true }) },
    logger: { warn() {}, info() {}, debug() {}, error() {} },
    config: {},
  };

  const message = {
    id: '900000000000000001',
    content: 'Müslüm Gürses Affet',
    guildId: 'g',
    channelId: 'c',
    author: { id: 'u', bot: false },
    member: { id: 'u', voice: { channelId: 'vc' } },
    guild: { id: 'g' },
    channel: { name: 'muzik-istek', async send() {} },
  };

  const result = await handleMusicRequest(message, deps);
  assert(result.reason === 'no-session', `expected no-session, got ${result.reason}`);
  assert(sessions.size === 0, 'a plain song name created a session');
  assert(searchRan === false, 'a search ran before PompMusic was summoned');
  return 'must be summoned with /gel';
});

await check('a bare video id is never passed to the provider', async () => {
  const { canonicalYoutubeUrl, resolveStreamUrl, isYoutubeUrl } = await import(
    pathToFileURL(path.join(ROOT, 'src/music/sources/youtube.js')).href
  );
  const id = 'ktTkTFHic';
  const url = `https://www.youtube.com/watch?v=${id}`;

  assert(canonicalYoutubeUrl(id) === url, 'a bare id was not canonicalised');
  assert(resolveStreamUrl({ id, url: null }) === url, 'a missing url was not rebuilt from the id');
  assert(resolveStreamUrl({ id, url: id }) === url, 'a bare id in the url field was passed through');
  assert(resolveStreamUrl({ id, url }) === url, 'a full url was altered');
  assert(isYoutubeUrl(id) === false, 'a bare id was accepted as a url');

  let thrown = null;
  try {
    resolveStreamUrl({ id: null, url: null });
  } catch (error) {
    thrown = error;
  }
  assert(thrown !== null && thrown.code === 'MUSIC_TRACK_INVALID', 'an unusable track was not rejected');
  return 'url always, id never';
});

await check('audio extraction goes through yt-dlp, never play-dl', async () => {
  const files = await listJsFiles('src/music');
  const offenders = [];
  // play-dl's extractors read a media URL out of the player response, which is
  // what broke. Only its search is still used, so any of these reappearing
  // means the broken path is back.
  const forbidden = [/stream_from_info/, /\bplay\.stream\s*\(/, /\bplaydl\.stream\s*\(/, /\bytdl\.stream\s*\(/];

  for (const file of files) {
    const code = (await readFile(file, 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    if (forbidden.some((pattern) => pattern.test(code))) offenders.push(path.relative(ROOT, file));
  }
  assert(offenders.length === 0, `play-dl extraction still present in: ${offenders.join(', ')}`);

  const youtube = (await readFile(path.join(ROOT, 'src', 'music', 'sources', 'youtube.js'), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert(/streamBackend\.openStream\(/.test(youtube), 'the source does not open streams through the backend');

  const session = (await readFile(path.join(ROOT, 'src', 'music', 'session.js'), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert(/\.kill\(\)/.test(session), 'the session does not terminate stream processes');
  return 'yt-dlp backend only';
});

await check('the audio subprocess is spawned without a shell', async () => {
  const { buildArguments, DEFAULT_FORMAT, DEFAULT_STREAM_TYPE, createStreamBackend } = await import(
    pathToFileURL(path.join(ROOT, 'src/music', 'sources', 'ytdlp.js')).href
  );

  const code = (await readFile(path.join(ROOT, 'src', 'music', 'sources', 'ytdlp.js'), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert(!/\bexec(Sync)?\s*\(/.test(code), 'the backend uses exec, which builds a shell string');
  assert(!/shell:\s*true/.test(code), 'the backend asks for a shell');

  const url = 'https://www.youtube.com/watch?v=ktTkTFHic';
  const args = buildArguments({ url });
  assert(Array.isArray(args), 'the arguments are not an array');
  assert(args.at(-1) === url, 'the url is not the last argument');
  assert(args.filter((arg) => arg === url).length === 1, 'the url appears more than once');
  assert(args.includes('--no-cache-dir'), 'yt-dlp may write to disk');
  assert(args.includes('--no-playlist'), 'a playlist url could start a download');

  // The format selector and the stream type must agree: Opus in WebM is what
  // Discord decodes, so no transcoding step is needed.
  assert(DEFAULT_FORMAT.includes('acodec=opus'), 'the default format is not Opus');
  assert(DEFAULT_STREAM_TYPE === 'webm/opus', 'the stream type does not match the format');

  // Nothing is downloaded when no executable is present.
  const { backend } = await createStreamBackend({ settings: { streamBackend: 'none' } });
  assert(backend === null, 'a backend was built while streaming was disabled');
  return 'array arguments, shell: false';
});

await check('the music subsystem cannot reach the AI layer', async () => {
  const files = await listJsFiles('src/music');
  const offenders = [];

  for (const file of files) {
    const code = (await readFile(file, 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    if (/from\s+['"][^'"]*\/ai\//.test(code)) offenders.push(`${path.relative(ROOT, file)} imports AI`);
    if (/\.complete\s*\(/.test(code)) offenders.push(`${path.relative(ROOT, file)} calls a model`);
  }

  assert(offenders.length === 0, offenders.join('; '));
  return `${files.length} file(s), zero AI`;
});

await check('music state is separate from AI memory and giveaway state', async () => {
  const { createMusicService } = await import(pathToFileURL(path.join(ROOT, 'src/music/index.js')).href);
  const config = {
    music: { enabled: true, textChannel: 'muzik-istek', maxQueueSize: 50, maxTrackMinutes: 20 },
    ai: { responseVisibility: 'public' },
  };
  const service = createMusicService({ client: { guilds: { cache: new Map() } }, config });

  assert(service.sessions && typeof service.sessions.get === 'function', 'no session manager');
  assert(!('memory' in service), 'the music service exposes AI memory');
  assert(!('giveaways' in service), 'the music service exposes giveaway state');
  const bleeding = Object.keys(service).filter((key) => /ai|memory|giveaway/i.test(key));
  assert(bleeding.length === 0, `music exposes shared state: ${bleeding.join(', ')}`);
  return 'sessions only';
});

await check('only the music channel can start playback', async () => {
  const { shouldHandle } = await import(pathToFileURL(path.join(ROOT, 'src/music/listener.js')).href);
  const make = (channelName) => ({
    content: 'Vida Loca',
    guildId: 'g',
    system: false,
    author: { id: 'u', bot: false },
    channel: { name: channelName },
  });

  assert(shouldHandle(make('muzik-istek'), { musicChannelName: 'muzik-istek' }) === true);
  for (const channel of ['genel', 'maden', 'kod', 'pompai', 'ada', 'unity', 'buglar']) {
    assert(
      shouldHandle(make(channel), { musicChannelName: 'muzik-istek' }) === false,
      `#${channel} would start playback`,
    );
  }
  return '1 channel in, 7 out';
});

await check('the music blueprint adds only the three requested resources', () => {
  const blueprint = buildBlueprint('miningfools');
  const category = blueprint.categories.find((entry) => entry.name === '🎵 MÜZİK');
  const text = blueprint.channels.find((entry) => entry.name === 'muzik-istek');
  const voice = blueprint.channels.find((entry) => entry.name === 'Müzik Odası');

  assert(category, 'the 🎵 MÜZİK category is missing');
  assert(text && text.type === 'text' && text.category === 'muzik', '#muzik-istek is wrong');
  assert(voice && voice.type === 'voice' && voice.category === 'muzik', 'Müzik Odası is wrong');
  assert((text.overwrites ?? []).length === 0, '#muzik-istek must be public');
  assert(blueprint.roles.length === 0, 'the music change must not add roles');
  return '1 category, 1 text, 1 voice';
});

await check('a selection is keyed on guild, channel and request id', async () => {
  const { selectionKey, createSelectionCache } = await import(
    pathToFileURL(path.join(ROOT, 'src/music/selection-cache.js')).href
  );

  assert(selectionKey({ guildId: 'g', channelId: 'c', requestId: 'r' }) === 'g:c:r', 'the key is not composite');
  for (const partial of [{ guildId: 'g' }, { channelId: 'c' }, { requestId: 'r' }, {}]) {
    assert(selectionKey(partial) === null, `an incomplete identity produced a key: ${JSON.stringify(partial)}`);
  }

  const cache = createSelectionCache({ timeoutSeconds: 60, maxEntries: 2 });
  for (let index = 0; index < 6; index += 1) {
    cache.put({ guildId: 'g', channelId: 'c', requestId: `r${index}` }, { userId: 'u', ranked: [] });
  }
  assert(cache.size() <= 2, 'the selection cache is unbounded');
  return 'composite key, bounded';
});

await check('a pending selection is scoped to one guild and channel', async () => {
  const { createSelectionCache } = await import(
    pathToFileURL(path.join(ROOT, 'src/music/selection-cache.js')).href
  );
  const cache = createSelectionCache({ timeoutSeconds: 60 });
  cache.put({ guildId: 'g1', channelId: 'c1', requestId: 'r' }, { userId: 'u', ranked: [] });

  assert(cache.get({ guildId: 'g1', channelId: 'c1', requestId: 'r' }) !== null, 'the entry is unreachable');
  assert(cache.get({ guildId: 'g2', channelId: 'c1', requestId: 'r' }) === null, 'reachable from another guild');
  assert(cache.get({ guildId: 'g1', channelId: 'c2', requestId: 'r' }) === null, 'reachable from another channel');
  return 'guild and channel bound';
});

await check('a pending selection expires and is removed', async () => {
  const { createSelectionCache } = await import(
    pathToFileURL(path.join(ROOT, 'src/music/selection-cache.js')).href
  );
  let clock = 0;
  const cache = createSelectionCache({ timeoutSeconds: 60, now: () => clock });
  const identity = { guildId: 'g', channelId: 'c', requestId: 'r' };
  cache.put(identity, { userId: 'u', ranked: [] });

  clock = 59_000;
  assert(cache.get(identity) !== null, 'expired too early');
  clock = 61_000;
  assert(cache.get(identity) === null, 'survived its deadline');
  assert(cache.size() === 0, 'the expired entry was left behind');
  return 'expires at 60s';
});

await check('music limits are enforced by the queue', async () => {
  const { GuildQueue } = await import(pathToFileURL(path.join(ROOT, 'src/music/queue.js')).href);
  const queue = new GuildQueue({ maxSize: 2, maxTrackSeconds: 1200 });
  const item = (id, durationSeconds) => ({ id, title: id, durationSeconds });

  assert(queue.add(item('a', 100), { id: 'u', name: 'U' }).ok);
  assert(queue.add(item('b', 100), { id: 'u', name: 'U' }).ok);
  assert(queue.add(item('c', 100), { id: 'u', name: 'U' }).reason === 'queue-full', 'the size limit is not enforced');
  assert(queue.add(item('d', 3600), { id: 'u', name: 'U' }).reason === 'too-long', 'the duration limit is not enforced');
  return 'size and duration caps held';
});

/* -------------------------------------------------------------------------- */

group('AI answer visibility');

await check('the default AI visibility is public', async () => {
  const { DEFAULT_VISIBILITY, createVisibilityPolicy, resolveAiVisibility } = await import(
    pathToFileURL(path.join(ROOT, 'src/ai/visibility.js')).href
  );

  assert(DEFAULT_VISIBILITY === 'public', `default is ${DEFAULT_VISIBILITY}`);
  assert(createVisibilityPolicy().ephemeral === false, 'the default policy is private');
  assert(resolveAiVisibility({}).ephemeral === false, 'an empty config resolved to private');
  assert(resolveAiVisibility({ ai: { responseVisibility: 'nonsense' } }).ephemeral === false, 'a typo hid answers');
  return 'public by default';
});

await check('public policies emit flag-free payloads', async () => {
  const { createVisibilityPolicy, VISIBILITY } = await import(
    pathToFileURL(path.join(ROOT, 'src/ai/visibility.js')).href
  );
  const policy = createVisibilityPolicy(VISIBILITY.PUBLIC);

  assert(!Object.hasOwn(policy.replyOptions(), 'flags'), 'a public reply carries a flags key');
  assert(!Object.hasOwn(policy.followUpOptions('x'), 'flags'), 'a public follow-up carries a flags key');
  assert(policy.followUpOptions('x').content === 'x');
  return 'no flags on public payloads';
});

await check('AI commands use the shared policy, not their own copy', async () => {
  for (const file of ['ask.js', 'oyun.js']) {
    const source = await readFile(path.join(ROOT, 'src', 'commands', file), 'utf8');
    assert(/resolveAiVisibility/.test(source), `${file} does not use the shared policy`);
    const deferLines = source.split('\n').filter((line) => line.includes('deferReply'));
    for (const line of deferLines) {
      assert(
        !/MessageFlags\.Ephemeral/.test(line),
        `${file} hard-codes an ephemeral defer: ${line.trim()}`,
      );
    }
  }
  return 'ask + oyun';
});

await check('state-management commands stay ephemeral', async () => {
  for (const file of ['clear.js', 'oyun-temizle.js']) {
    const source = await readFile(path.join(ROOT, 'src', 'commands', file), 'utf8');
    assert(
      /MessageFlags\.Ephemeral/.test(source),
      `${file} is not ephemeral; personal state commands must stay private`,
    );
  }
  return 'clear + oyun-temizle';
});

await check('the giveaway channel is public and announcements mention nobody', async () => {
  const { createVisibilityPolicy, isChannel, VISIBILITY } = await import(
    pathToFileURL(path.join(ROOT, 'src/ai/visibility.js')).href
  );
  const { buildGiveawayEmbed } = await import(pathToFileURL(path.join(ROOT, 'src/giveaways/embed.js')).href);
  const { normaliseGiveaway, GIVEAWAY_KINDS } = await import(
    pathToFileURL(path.join(ROOT, 'src/giveaways/provider.js')).href
  );

  assert(isChannel('bedava-oyunlar', 'bedava-oyunlar'), 'the giveaway channel did not match');
  assert(createVisibilityPolicy(VISIBILITY.PUBLIC).ephemeral === false);

  const embed = buildGiveawayEmbed(
    normaliseGiveaway({
      provider: 'epic',
      id: '1',
      title: 'Game',
      platform: 'Epic Games',
      kind: GIVEAWAY_KINDS.EPIC_GIVEAWAY,
    }),
  ).toJSON();
  assert(!/@everyone|@here|<@&/.test(JSON.stringify(embed)), 'an announcement carries a mention');
  return 'public, no mentions';
});

/* -------------------------------------------------------------------------- */

group('Free game alerts');

await check('the giveaway alert path cannot reach an AI provider', async () => {
  const files = [...(await listJsFiles('src/giveaways')), path.join(ROOT, 'src/commands/ucretsiz.js')];
  const offenders = [];

  for (const file of files) {
    const contents = await readFile(file, 'utf8');
    // `src/ai/visibility.js` is a pure reply-formatting helper with no provider
    // dependency, so importing it costs nothing. What must never be reachable
    // is anything that can actually issue a paid completion.
    if (/from\s+['"][^'"]*\/ai\/(index|registry|provider|providers\/)/.test(contents)) {
      offenders.push(path.relative(ROOT, file));
    }
  }

  assert(offenders.length === 0, `polling code can reach an AI provider via: ${offenders.join(', ')}`);
  return `${files.length} file(s), no provider reachable`;
});

await check('no provider, model or api key is referenced by the alert path', async () => {
  const files = await listJsFiles('src/giveaways');
  const offenders = [];
  for (const file of files) {
    const code = (await readFile(file, 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    if (/\.complete\s*\(|deepseek|AI_API_KEY|chat\/completions/i.test(code)) {
      offenders.push(path.relative(ROOT, file));
    }
  }
  assert(offenders.length === 0, `an AI reference reached the alert path: ${offenders.join(', ')}`);
  return 'zero AI calls';
});

await check('Epic giveaways are detected and permanent F2P is excluded', async () => {
  const { parseEpicGiveaways } = await import(
    pathToFileURL(path.join(ROOT, 'src/giveaways/providers/epic.js')).href
  );
  const now = Date.parse('2026-10-03T12:00:00.000Z');
  const promotion = (id, title, percentage) => ({
    id,
    title,
    price: { totalPrice: { discountPrice: 0, originalPrice: 9999, currencyCode: 'TRY' } },
    promotions: { promotionalOffers: [{ promotionalOffers: [{ discountSetting: { discountPercentage: percentage } }] }] },
  });
  const payload = {
    data: {
      Catalog: {
        searchStore: {
          elements: [
            promotion('giveaway', 'Weekly Free', 0),
            promotion('sale', 'Discounted', 50),
            { id: 'f2p', title: 'Always Free', price: { totalPrice: { discountPrice: 0 } }, promotions: { promotionalOffers: [] } },
          ],
        },
      },
    },
  };

  const found = parseEpicGiveaways(payload, { now });
  assert(found.length === 1, `expected 1 giveaway, found ${found.length}`);
  assert(found[0].id === 'giveaway', 'the wrong element was selected');
  return '1 giveaway, F2P and discounts excluded';
});

await check('Steam announces only Free to Keep', async () => {
  const { parseSteamGiveaways, classifySteamOffer, STEAM_OFFER_KINDS } = await import(
    pathToFileURL(path.join(ROOT, 'src/giveaways/providers/steam.js')).href
  );
  const now = Date.parse('2026-10-03T12:00:00.000Z');
  const offers = [
    { id: 1, name: 'Keep', discount_percent: 100, final_price: 0, promotion_kind: STEAM_OFFER_KINDS.FREE_TO_KEEP },
    { id: 2, name: 'Weekend', discount_percent: 100, final_price: 0, promotion_kind: STEAM_OFFER_KINDS.FREE_WEEKEND },
    { id: 3, name: 'F2P', is_free: true, discount_percent: 0, final_price: 0 },
    { id: 4, name: 'Ambiguous', discount_percent: 100, final_price: 0 },
  ];

  const found = parseSteamGiveaways({ offers }, { now });
  assert(found.length === 1 && found[0].id === '1', 'a non-Free-to-Keep offer survived');
  assert(classifySteamOffer(offers[1]) === STEAM_OFFER_KINDS.FREE_WEEKEND, 'Free Weekend misclassified');
  assert(classifySteamOffer(offers[2]) === STEAM_OFFER_KINDS.PERMANENTLY_FREE, 'F2P misclassified');
  return 'only Free to Keep announced';
});

await check('a giveaway is announced once and survives a restart', async () => {
  const { GiveawayStore } = await import(pathToFileURL(path.join(ROOT, 'src/giveaways/store.js')).href);
  const { createGiveawayMonitor } = await import(
    pathToFileURL(path.join(ROOT, 'src/giveaways/monitor.js')).href
  );
  const { normaliseGiveaway, GIVEAWAY_KINDS } = await import(
    pathToFileURL(path.join(ROOT, 'src/giveaways/provider.js')).href
  );

  const directory = await mkdtemp(path.join(tmpdir(), 'pompbot-check-'));
  const filePath = path.join(directory, 'giveaways.json');
  const item = normaliseGiveaway({
    provider: 'epic',
    id: 'x',
    title: 'Game',
    platform: 'Epic Games',
    kind: GIVEAWAY_KINDS.EPIC_GIVEAWAY,
  });
  const source = { name: 'epic', label: 'Epic', fetchGiveaways: async () => [item] };
  const sink = { posted: [], async announce(entry) { sink.posted.push(entry.key); return true; } };

  await createGiveawayMonitor({ providers: [source], store: new GiveawayStore({ filePath }), notifier: sink }).checkNow();
  assert(sink.posted.length === 1, 'the first cycle did not announce');

  // Restart: brand new store, same file.
  const reopened = new GiveawayStore({ filePath });
  const afterRestart = createGiveawayMonitor({ providers: [source], store: reopened, notifier: sink });
  await afterRestart.checkNow();

  assert(sink.posted.length === 1, 'the giveaway was re-announced after a restart');
  return 'announced once across a restart';
});

await check('a failing provider does not take the cycle down', async () => {
  const { createGiveawayMonitor } = await import(
    pathToFileURL(path.join(ROOT, 'src/giveaways/monitor.js')).href
  );
  const broken = { name: 'epic', label: 'Epic', fetchGiveaways: async () => { throw new Error('down'); } };
  const monitor = createGiveawayMonitor({ providers: [broken], timeoutMs: 1000 });

  const result = await monitor.checkNow();
  assert(result.failures.length === 1, 'the failure was not reported');
  assert(result.skipped === false, 'the cycle aborted');
  return 'isolated';
});

await check('the poll interval floor is 15 minutes', async () => {
  const { MIN_INTERVAL_MINUTES, createGiveawayMonitor } = await import(
    pathToFileURL(path.join(ROOT, 'src/giveaways/monitor.js')).href
  );
  assert(MIN_INTERVAL_MINUTES === 15, `floor is ${MIN_INTERVAL_MINUTES}`);
  assert(
    createGiveawayMonitor({ providers: [], intervalMinutes: 1 }).status().intervalMinutes === 15,
    'a sub-15-minute interval was accepted',
  );
  return 'never faster than every 15 minutes';
});

await check('the SteamDB parser accepts only explicit Free to Keep', async () => {
  const { parseSteamDbFree } = await import(
    pathToFileURL(path.join(ROOT, 'src/giveaways/providers/steamdb/parse.js')).href
  );
  const build = (appId, title, label) =>
    `<table><tr><td><a href="/app/${appId}/">${title}</a></td><td><span>${label}</span></td></tr></table>`;

  assert(parseSteamDbFree(build('1', 'Keep', 'Free to Keep')).length === 1, 'Free to Keep was not accepted');
  for (const label of ['Free Weekend', 'Play For Free', 'Free to Play', 'Upcoming', 'Discount']) {
    assert(parseSteamDbFree(build('2', 'Nope', label)).length === 0, `"${label}" was accepted`);
  }
  return 'accepts 1, rejects 5 labels';
});

await check('the SteamDB parser fails closed on unusable markup', async () => {
  const { parseSteamDbFree } = await import(
    pathToFileURL(path.join(ROOT, 'src/giveaways/providers/steamdb/parse.js')).href
  );
  for (const html of ['', 'not html', '<table><tr><td>unclosed', '<div>redesigned</div>', null]) {
    assert(parseSteamDbFree(html).length === 0, `unexpected offer from ${JSON.stringify(html)}`);
  }
  return 'empty, never wrong';
});

await check('the SteamDB source uses no browser automation or bypass', async () => {
  const file = path.join(ROOT, 'src/giveaways/providers/steamdb/index.js');
  const code = (await readFile(file, 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  for (const forbidden of ['puppeteer', 'playwright', 'selenium', 'headless', 'cloudscraper', 'cf_clearance']) {
    assert(!code.includes(forbidden), `the source references ${forbidden}`);
  }
  assert(/user-agent/i.test(code), 'no User-Agent is set');
  assert(/STEAMDB_BLOCKED|SteamDbBlockedError/.test(code), 'blocking is not surfaced as an error');
  return 'plain GET, descriptive UA, fail closed';
});

await check('a SteamDB giveaway keeps the official Steam link, not the SteamDB one', async () => {
  const { parseSteamDbFree } = await import(
    pathToFileURL(path.join(ROOT, 'src/giveaways/providers/steamdb/parse.js')).href
  );
  const html = '<table><tr><td><a href="/app/1245620/">Game</a></td><td><span>Free to Keep</span></td></tr></table>';
  const [offer] = parseSteamDbFree(html);

  assert(offer.store_url === 'https://store.steampowered.com/app/1245620/', `wrong url: ${offer.store_url}`);
  assert(!offer.store_url.includes('steamdb'), 'SteamDB was used as the redemption link');
  return offer.store_url;
});

await check('ITAD accepts only direct active Steam full-game giveaways', async () => {
  const { classifyItadGiveaway, REJECTION } = await import(
    pathToFileURL(path.join(ROOT, 'src/giveaways/providers/itad/classify.js')).href
  );
  const now = Date.parse('2026-10-03T12:00:00.000Z');
  const base = {
    id: 1,
    title: 'Game - Free on Steam',
    shop: { id: 61, name: 'Steam' },
    url: 'https://isthereanydeal.com/giveaway/x/',
    publish: '2026-10-01T00:00:00Z',
    expiry: '2026-10-08T00:00:00Z',
    note: null,
    games: [{ id: 'u', slug: 'g', title: 'Game', type: 'game', assets: {}, keys: [], platforms: [] }],
  };

  assert(classifyItadGiveaway(base, { now }).accepted, 'a valid Steam giveaway was rejected');

  const cases = [
    [{ shop: { id: 35, name: 'GOG' } }, REJECTION.NOT_STEAM],
    [{ title: 'Game - Free Weekend' }, REJECTION.TEMPORARY_ACCESS],
    [{ title: 'Game - Play For Free' }, REJECTION.TEMPORARY_ACCESS],
    [{ games: [{ ...base.games[0], type: 'dlc' }] }, REJECTION.NO_FULL_GAME],
    [{ expiry: '2026-09-01T00:00:00Z' }, REJECTION.EXPIRED],
    [{ title: 'Game - Free to Play' }, REJECTION.PERMANENTLY_FREE],
  ];
  for (const [overrides, expected] of cases) {
    const verdict = classifyItadGiveaway({ ...base, ...overrides }, { now });
    assert(!verdict.accepted, `accepted ${JSON.stringify(overrides)}`);
    assert(verdict.reason === expected, `expected ${expected}, got ${verdict.reason}`);
  }
  return `1 accepted, ${cases.length} rejection rules verified`;
});

await check('the ITAD source keeps the key out of URLs, logs and errors', async () => {
  const file = path.join(ROOT, 'src/giveaways/providers/itad/index.js');
  const code = await readFile(file, 'utf8');

  assert(/ITAD-API-Key/.test(code), 'the documented auth header is not used');
  assert(!/\?key=|&key=/.test(code), 'the key is passed as a query parameter');
  assert(/ITAD_AUTH_ERROR/.test(code), '401/403 is not surfaced distinctly');
  assert(!/logger[^\n]*apiKey/.test(code), 'the key is passed to a logger');
  return 'header only, redacted errors';
});

await check('SteamDB is not used unless explicitly configured', async () => {
  const { createGiveawayProviders } = await import(
    pathToFileURL(path.join(ROOT, 'src/giveaways/index.js')).href
  );
  const names = createGiveawayProviders({ itadApiKey: 'k' }).map((provider) => provider.name);

  assert(names.join(',') === 'epic,steam', `unexpected providers: ${names.join(',')}`);
  const steam = createGiveawayProviders({ itadApiKey: 'k' }).find((p) => p.name === 'steam');
  assert(
    steam.source?.constructor?.name === 'ItadGiveawaySource',
    `the default Steam source is ${steam.source?.constructor?.name}`,
  );
  return 'ITAD by default, SteamDB opt-in';
});

await check('an unconfigured ITAD source is not reported as an outage', async () => {
  const { createGiveawayProviders } = await import(
    pathToFileURL(path.join(ROOT, 'src/giveaways/index.js')).href
  );
  const names = createGiveawayProviders({ itadApiKey: null }).map((provider) => provider.name);

  assert(names.join(',') === 'epic', `a broken Steam provider was registered: ${names.join(',')}`);
  return 'provider omitted, not failing';
});

await check('the giveaway blueprint adds one category and one channel', () => {
  const blueprint = buildBlueprint('miningfools');
  const category = blueprint.categories.find((entry) => entry.name === '🎁 FIRSATLAR');
  const channel = blueprint.channels.find((entry) => entry.name === 'bedava-oyunlar');

  assert(category, 'the 🎁 FIRSATLAR category is missing');
  assert(channel, '#bedava-oyunlar is missing');
  assert(channel.category === category.key, '#bedava-oyunlar is not under the FIRSATLAR category');
  assert(channel.readOnly === undefined && (channel.overwrites ?? []).length === 0, '#bedava-oyunlar must be public');
  return '🎁 FIRSATLAR / #bedava-oyunlar';
});

/* -------------------------------------------------------------------------- */

group('PompAI context and memory');

await check('the system prompt carries the MiningFools brief', async () => {
  const { buildSystemPrompt, CORE_LOOP, SYSTEMS } = await import(
    pathToFileURL(path.join(ROOT, 'src/ai/miningfools.js')).href
  );
  const prompt = buildSystemPrompt({ channelName: 'maden' });

  assert(/Unity/.test(prompt), 'the engine is missing');
  for (const step of CORE_LOOP) assert(prompt.includes(step), `core loop step missing: ${step}`);
  for (const system of SYSTEMS) assert(prompt.includes(system), `system missing: ${system}`);
  assert(/Do NOT invent project facts/.test(prompt), 'the no-invention rule is missing');
  assert(/#maden/.test(prompt), 'the channel name is missing');
  return `${SYSTEMS.length} systems, ${CORE_LOOP.length} loop steps`;
});

await check('the system prompt contains no credentials', async () => {
  const { buildSystemPrompt } = await import(pathToFileURL(path.join(ROOT, 'src/ai/miningfools.js')).href);
  const prompt = buildSystemPrompt({ channelName: 'pompai' });
  for (const pattern of [/sk-[A-Za-z0-9]/, /Bearer\s/, /DISCORD_TOKEN/, /AI_API_KEY/]) {
    assert(!pattern.test(prompt), `the prompt matches ${pattern}`);
  }
  return 'clean';
});

await check('every text channel has a channel focus hint', async () => {
  const { CHANNEL_FOCUS } = await import(
    pathToFileURL(path.join(ROOT, 'src/ai/channel-context.js')).href
  );
  const blueprint = buildBlueprint('miningfools');
  for (const channel of blueprint.channels.filter((entry) => entry.type !== 'voice')) {
    assert(Object.hasOwn(CHANNEL_FOCUS, channel.name), `#${channel.name} has no focus hint`);
  }
  return `${Object.keys(CHANNEL_FOCUS).length} hints`;
});

await check('conversation memory isolates users, channels and guilds', async () => {
  const { ConversationMemory } = await import(pathToFileURL(path.join(ROOT, 'src/ai/memory.js')).href);
  const memory = new ConversationMemory({ maxMessages: 10 });

  memory.append({ guildId: 'g1', channelId: 'c1', userId: 'a' }, { role: 'user', content: 'a-c1' });
  memory.append({ guildId: 'g1', channelId: 'c2', userId: 'a' }, { role: 'user', content: 'a-c2' });
  memory.append({ guildId: 'g1', channelId: 'c1', userId: 'b' }, { role: 'user', content: 'b-c1' });
  memory.append({ guildId: 'g2', channelId: 'c1', userId: 'a' }, { role: 'user', content: 'g2-a-c1' });

  const cases = [
    [{ guildId: 'g1', channelId: 'c1', userId: 'a' }, 'a-c1'],
    [{ guildId: 'g1', channelId: 'c2', userId: 'a' }, 'a-c2'],
    [{ guildId: 'g1', channelId: 'c1', userId: 'b' }, 'b-c1'],
    [{ guildId: 'g2', channelId: 'c1', userId: 'a' }, 'g2-a-c1'],
  ];
  for (const [scope, expected] of cases) {
    const history = memory.history(scope);
    assert(history.length === 1 && history[0].content === expected, `scope ${JSON.stringify(scope)} leaked`);
  }
  return '4 scopes isolated';
});

await check('conversation memory is bounded and clearable', async () => {
  const { ConversationMemory } = await import(pathToFileURL(path.join(ROOT, 'src/ai/memory.js')).href);
  const memory = new ConversationMemory({ maxMessages: 4, maxConversations: 2 });
  const scope = { guildId: 'g', channelId: 'c', userId: 'u' };

  for (let index = 0; index < 20; index += 1) memory.append(scope, { role: 'user', content: `m${index}` });
  assert(memory.history(scope).length === 4, 'history is not bounded');

  for (let index = 0; index < 10; index += 1) {
    memory.append({ guildId: 'g', channelId: 'c', userId: `u${index}` }, { role: 'user', content: 'x' });
  }
  assert(memory.size <= 2, 'conversation count is not bounded');

  memory.clear(scope);
  assert(memory.history(scope).length === 0, 'clear did not work');
  return `max 4 messages, max 2 conversations`;
});

/* -------------------------------------------------------------------------- */

group('Fun and community');

await check('the fun layer cannot reach the AI layer', async () => {
  const files = await listJsFiles('src/fun');
  const offenders = [];

  for (const file of files) {
    const code = (await readFile(file, 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    // A provider import, a completion call, or a key reaching for an env var
    // would all mean a game outcome could depend on a paid API.
    if (/from\s+['"][^'"]*ai\//.test(code)) offenders.push(`${path.relative(ROOT, file)}: imports the AI layer`);
    if (/\.complete\s*\(|createAIClient|AI_API_KEY|apiKey/.test(code)) {
      offenders.push(`${path.relative(ROOT, file)}: reaches for a model`);
    }
  }
  assert(offenders.length === 0, offenders.join('; '));
  return `${files.length} file(s), zero AI`;
});

await check('song battles cannot reach the AI layer either', async () => {
  for (const name of ['battle.js', 'battle-command.js']) {
    const code = (await readFile(path.join(ROOT, 'src', 'music', name), 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert(!/from\s+['"][^'"]*ai\//.test(code), `${name} imports the AI layer`);
    assert(!/\.complete\s*\(|createAIClient/.test(code), `${name} reaches for a model`);
  }
  return 'zero AI';
});

await check('every mining reward comes from the server-side table', async () => {
  const { MINE_OUTCOMES, validateLootTable, pickOutcome, totalWeight } = await import(
    pathToFileURL(path.join(ROOT, 'src', 'fun', 'loot.js')).href
  );

  const problems = validateLootTable();
  assert(problems.length === 0, problems.join('; '));
  assert(totalWeight() === 1000, `weights total ${totalWeight()}`);

  // Rare must mean rare: the marked outcomes together stay under 5%.
  const rare = MINE_OUTCOMES.filter((outcome) => outcome.rare);
  const rareWeight = rare.reduce((total, outcome) => total + outcome.weight, 0);
  assert(rare.length >= 2, 'fewer than two rare outcomes');
  assert(rareWeight / totalWeight() <= 0.05, `rare outcomes are ${((rareWeight / totalWeight()) * 100).toFixed(1)}%`);

  // The draw is a pure function of the injected random, and every outcome has
  // a coin and XP range the server owns.
  for (const sample of [0, 0.5, 0.999999]) {
    const picked = pickOutcome(() => sample);
    assert(MINE_OUTCOMES.includes(picked), `pickOutcome(${sample}) returned something outside the table`);
  }
  for (const outcome of MINE_OUTCOMES) {
    assert(Array.isArray(outcome.coins) && Array.isArray(outcome.xp), `${outcome.key} has no reward range`);
  }
  return `${MINE_OUTCOMES.length} outcomes, rarest ${((Math.min(...MINE_OUTCOMES.map((o) => o.weight)) / 10)).toFixed(1)}%`;
});

await check('no fun command accepts a reward from the client', async () => {
  const offenders = [];
  for (const file of await listJsFiles('src/fun')) {
    const code = (await readFile(file, 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    // An integer/string option whose value is used as an amount, or a component
    // id carrying a number, would be a client-supplied reward.
    if (/getInteger\s*\(|getNumber\s*\(/.test(code)) offenders.push(path.relative(ROOT, file));
  }
  assert(offenders.length === 0, `a command reads a number from the client: ${offenders.join(', ')}`);

  // The only component ids the fun layer issues carry an opaque session id.
  const { partyComponentId, parsePartyComponentId } = await import(
    pathToFileURL(path.join(ROOT, 'src', 'fun', 'party.js')).href
  );
  const id = partyComponentId('new', 'abc12345');
  assert(id === 'party:new:abc12345', `unexpected component id: ${id}`);
  assert(parsePartyComponentId(id)?.sessionId === 'abc12345', 'a party id does not round-trip');
  for (const bad of ['party:new:', 'party:new:abc:1', 'party:give:abc12345', 'party:new:a b', '']) {
    assert(parsePartyComponentId(bad) === null, `${JSON.stringify(bad)} was accepted as a party id`);
  }
  return 'opaque ids only';
});

await check('activity XP never reads message content', async () => {
  const code = (await readFile(path.join(ROOT, 'src', 'fun', 'passive-xp.js'), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert(!/\.content\b/.test(code), 'the activity XP path reads message content');

  // And PompAI still does not ask for the privileged intent that would supply it.
  const bootstrap = await readFile(path.join(ROOT, 'src', 'index.js'), 'utf8');
  assert(/GuildMessages/.test(bootstrap), 'PompAI does not request GuildMessages, so no message events arrive');
  assert(!/GatewayIntentBits\.MessageContent/.test(bootstrap), 'PompAI requests the privileged Message Content intent');
  return 'GuildMessages only, no content';
});

await check('every fun row is addressed by guild AND user', async () => {
  const source = await readFile(path.join(ROOT, 'src', 'fun', 'repository.js'), 'utf8');
  const { MIGRATIONS } = await import(pathToFileURL(path.join(ROOT, 'src', 'fun', 'db.js')).href);

  // Both tables are keyed by the pair, so a row cannot exist without a guild.
  const ddl = MIGRATIONS.flatMap((migration) => migration.statements).join('\n');
  assert(/PRIMARY KEY \(guild_id, user_id\)/.test(ddl), 'guild_users is not keyed by guild and user');
  assert(
    /PRIMARY KEY \(guild_id, user_id, item_key\)/.test(ddl),
    'inventory is not keyed by guild, user and item',
  );

  // A statement that READS or CHANGES user state must filter on the guild. An
  // INSERT has no WHERE clause, so for those the guild must be one of the
  // columns being written instead.
  const statements = source.match(/`[\s\S]*?`/g) ?? [];
  let checked = 0;
  for (const statement of statements) {
    if (!/guild_users|inventory/.test(statement)) continue;
    checked += 1;
    const label = statement.trim().replace(/\s+/g, ' ').slice(0, 60);

    // Not anchored: the matched span still carries its surrounding backticks.
    if (/\bINSERT\b/i.test(statement)) {
      assert(
        /\(guild_id,\s*user_id/.test(statement.replace(/\s+/g, ' ')),
        `an insert does not write the guild: ${label}`,
      );
      continue;
    }
    assert(/guild_id\s*=\s*\?/.test(statement), `a statement is not guild-scoped: ${label}`);
  }
  assert(checked >= 6, `only ${checked} statements were inspected; the matcher has drifted`);
  return `${checked} statements, guild_id + user_id everywhere`;
});

await check('migrations are additive and versioned', async () => {
  const { MIGRATIONS, SCHEMA_VERSION, migrate, openFunDatabase, readSchemaVersion } = await import(
    pathToFileURL(path.join(ROOT, 'src', 'fun', 'db.js')).href
  );

  assert(MIGRATIONS.length === SCHEMA_VERSION, 'SCHEMA_VERSION does not match the migration list');
  const versions = MIGRATIONS.map((migration) => migration.version);
  assert(
    versions.every((version, index) => version === index + 1),
    `migration versions are not 1..N: ${versions.join(', ')}`,
  );

  const destructive = /\b(DROP\s+TABLE|DROP\s+COLUMN|DELETE\s+FROM|TRUNCATE)\b/i;
  for (const migration of MIGRATIONS) {
    for (const statement of migration.statements) {
      assert(!destructive.test(statement), `migration ${migration.version} destroys data: ${statement.trim().slice(0, 60)}`);
    }
  }

  // Fresh database reaches the current version, and re-running changes nothing.
  const db = openFunDatabase({ file: ':memory:' });
  assert(readSchemaVersion(db) === SCHEMA_VERSION, 'a fresh database is not at SCHEMA_VERSION');
  assert(migrate(db).length === 0, 'migrating an up-to-date database applied something');
  db.close();
  return `v${SCHEMA_VERSION}, additive only`;
});

await check('the fun database is git-ignored', () => {
  for (const file of ['data/pomp-fun.sqlite', 'data/pomp-fun.sqlite-wal', 'data/pomp-fun.sqlite-shm']) {
    const result = spawnSync('git', ['check-ignore', '--quiet', file], { cwd: ROOT });
    if (result.error) return 'git unavailable, skipped';
    assert(result.status === 0, `${file} is NOT ignored - a user's economy could be committed`);
  }
  return 'data/ ignored';
});

await check('the blueprint adds only the fun category and channel', () => {
  const blueprint = buildBlueprint('miningfools');
  const category = blueprint.categories.find((entry) => entry.name === '🎉 EĞLENCE');
  const channel = blueprint.channels.find((entry) => entry.name === 'eglence');

  assert(category, 'the 🎉 EĞLENCE category is missing');
  assert(channel, '#eglence is missing');
  assert(channel.type === 'text', '#eglence is not a text channel');
  assert(channel.category === category.key, '#eglence is not inside 🎉 EĞLENCE');
  assert(!channel.readOnly, 'the fun channel must not be read-only');
  assert(blueprint.roles.length === 0, 'the fun change must not add roles');

  const funChannels = blueprint.channels.filter((entry) => entry.category === category.key);
  assert(funChannels.length === 1, `the fun category holds ${funChannels.length} channels, expected 1`);
  return '🎉 EĞLENCE / #eglence, no roles';
});

await check('the game tables work without any AI provider', async () => {
  const { openFunDatabase, createFunService } = await import(
    pathToFileURL(path.join(ROOT, 'src', 'fun', 'index.js')).href
  );
  const db = openFunDatabase({ file: ':memory:' });
  // No config, no AI client, no network: the whole loop must still run.
  const service = createFunService({ database: db, config: {}, random: () => 0.5 });

  const who = { guildId: 'g1', userId: 'u1' };
  const first = service.mine(who);
  assert(first.ok === true, 'a dig failed with no AI configured');
  assert(service.mine(who).ok === false, 'the mining cooldown did not hold');
  assert(service.claimDaily(who).ok === true, 'the daily chest failed with no AI configured');
  assert(service.claimDaily(who).ok === false, 'the daily cooldown did not hold');

  // Guild isolation, straight through the service.
  assert(service.profile({ guildId: 'g2', userId: 'u1' }).xp === 0, 'state leaked across guilds');
  assert(service.profile({ guildId: 'g1', userId: 'u2' }).xp === 0, 'state leaked across users');

  db.close();
  return 'offline economy';
});

/* -------------------------------------------------------------------------- */

group('AI layer');

const registry = createRegistry();

await check('all providers are registered', () => {
  const names = registry.list();
  for (const expected of ['stub', 'openai', 'gemini', 'deepseek', 'glm']) {
    assert(names.includes(expected), `provider "${expected}" is not registered`);
  }
  return names.join(', ');
});

await check('stub provider completes without network access', async () => {
  const provider = registry.create('stub', {});
  const response = await provider.complete({ messages: [{ role: 'user', content: 'hello' }] });
  assert(typeof response.text === 'string' && response.text.includes('hello'), 'stub did not echo the prompt');
  assert(response.provider === 'stub', 'wrong provider name');
  return 'ok';
});

await check('unimplemented providers fail with a clear message', async () => {
  for (const name of ['openai', 'gemini', 'glm']) {
    const provider = registry.create(name, { apiKey: 'placeholder' });
    let thrown = null;
    try {
      await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });
    } catch (error) {
      thrown = error;
    }
    assert(thrown !== null, `"${name}" did not throw`);
    assert(thrown.code === 'AI_PROVIDER_NOT_IMPLEMENTED', `"${name}" threw "${thrown.code}"`);
  }
  return '3 placeholders';
});

await check('the DeepSeek provider is real, configured from env and offline by default', async () => {
  const { createDeepSeekProvider, DEEPSEEK_API_URL } = await import(
    pathToFileURL(path.join(ROOT, 'src/ai/providers/deepseek.js')).href
  );

  // No key / no model means "not configured" - never a silent fallback model.
  const bare = createDeepSeekProvider({ apiKey: null, model: null });
  assert(bare.isConfigured() === false, 'DeepSeek claimed to be configured without credentials');
  assert(bare.healthCheck !== undefined);
  let thrown = null;
  try {
    await bare.complete({ messages: [{ role: 'user', content: 'hi' }] });
  } catch (error) {
    thrown = error;
  }
  assert(thrown !== null && thrown.code === 'AI_CONFIGURATION_ERROR', 'unconfigured DeepSeek did not refuse');
  assert(!/deepseek-v4-pro/i.test(JSON.stringify(thrown.details ?? {})), 'a fallback model leaked in');

  const configured = createDeepSeekProvider({ apiKey: 'placeholder', model: 'deepseek-flash' });
  assert(configured.isConfigured() === true, 'a key + model did not count as configured');
  assert(configured.apiUrl === DEEPSEEK_API_URL, 'unexpected default endpoint');

  // Building the body must never perform I/O.
  const body = configured.buildRequestBody({
    messages: [{ role: 'user', content: 'merhaba' }],
    system: null,
    maxTokens: null,
    temperature: null,
  });
  assert(body.model === 'deepseek-flash', `wrong model in body: ${body.model}`);
  assert(body.thinking.type === 'disabled', 'thinking was not disabled for the Flash path');
  assert(!JSON.stringify(body).includes('deepseek-v4-pro'), 'a fallback model is referenced');
  return 'configured, no fallback, thinking off';
});

await check('unknown provider names are rejected', () => {
  let thrown = null;
  try {
    registry.create('definitely-not-real', {});
  } catch (error) {
    thrown = error;
  }
  assert(thrown !== null && thrown.code === 'AI_CONFIGURATION_ERROR', 'unknown provider was accepted');
  return 'rejected';
});

await check('commands never import a concrete AI provider', async () => {
  const offenders = [];
  for (const file of await listJsFiles('src/commands')) {
    const contents = await readFile(file, 'utf8');
    if (/from\s+['"].*ai\/providers/.test(contents)) offenders.push(path.relative(ROOT, file));
  }
  assert(offenders.length === 0, `command imports a concrete provider: ${offenders.join(', ')}`);
  return 'provider-agnostic';
});

/* -------------------------------------------------------------------------- */

group('Deployment');

await check('the health endpoint exposes no secret', async () => {
  const { buildHealthPayload, DEFAULT_HOST, DEFAULT_PORT, HEALTH_PATHS } = await import(
    pathToFileURL(path.join(ROOT, 'src', 'health', 'server.js')).href
  );

  // A payload built with everything a leak would need planted in the process.
  const payload = buildHealthPayload({ status: { pompAI: true, pompMusic: true }, startedAt: 0, now: () => 1000 });
  const body = JSON.stringify(payload);
  const allowed = ['ok', 'service', 'pompAI', 'pompMusic', 'uptimeSeconds'];

  assert(
    Object.keys(payload).every((key) => allowed.includes(key)),
    `the payload has unexpected keys: ${Object.keys(payload).join(', ')}`,
  );
  assert(!/token|secret|key|guild|env|config|sqlite|database/i.test(body), 'the payload mentions something private');

  assert(DEFAULT_HOST === '0.0.0.0', `the default host is ${DEFAULT_HOST}`);
  assert(DEFAULT_PORT === 10000, `the default port is ${DEFAULT_PORT}`);
  assert(HEALTH_PATHS.includes('/health'), '/health is not served');

  // The module must not be able to read a credential even by accident.
  const code = (await readFile(path.join(ROOT, 'src', 'health', 'server.js'), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert(!/discord/i.test(code), 'the health server references discord');
  assert(!/process\.env\./.test(code), 'the health server reads an environment value directly');
  return `${HEALTH_PATHS.join(' + ')}, ${allowed.length} fields`;
});

await check('the deployment files contain no secret', async () => {
  const forbidden = [
    /MT[A-Za-z0-9]{20,}\./,
    /sk-[A-Za-z0-9]{16,}/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\b\d{17,20}:[A-Za-z0-9_-]{30,}\b/,
  ];

  for (const name of ['render.yaml', 'Dockerfile', '.dockerignore', 'docs/render-env.md']) {
    const contents = await readFile(path.join(ROOT, name), 'utf8');
    for (const pattern of forbidden) {
      assert(!pattern.test(contents), `${name} contains what looks like a real credential`);
    }
  }

  // Every credential in the blueprint must be dashboard-supplied.
  const yaml = await readFile(path.join(ROOT, 'render.yaml'), 'utf8');
  for (const key of ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'POMPMUSIC_TOKEN', 'POMPMUSIC_CLIENT_ID', 'AI_API_KEY', 'ITAD_API_KEY']) {
    assert(new RegExp(`- key: ${key}\\n\\s+sync: false`).test(yaml), `${key} is not marked sync: false`);
  }
  return 'blueprint + docs + Dockerfile clean';
});

await check('the image installs yt-dlp and keeps play-dl out of extraction', async () => {
  const dockerfile = await readFile(path.join(ROOT, 'Dockerfile'), 'utf8');

  assert(/FROM node:24/.test(dockerfile), 'the base image is not Node 24');
  assert(/ca-certificates/.test(dockerfile), 'CA certificates are missing');
  assert(/ARG YTDLP_VERSION=\d{4}\.\d{1,2}\.\d{1,2}/.test(dockerfile), 'yt-dlp is not pinned to a release');
  assert(/yt-dlp==\$\{YTDLP_VERSION\}/.test(dockerfile), 'the pin is not the version that gets installed');
  assert(/POMPMUSIC_STREAM_BACKEND=ytdlp/.test(dockerfile), 'the stream backend is not pinned in the image');
  assert(/npm ci/.test(dockerfile), 'dependencies are not installed from the lockfile');
  assert(!/POMPMUSIC_STREAM_BACKEND=none/.test(dockerfile), 'the image disables streaming');

  const source = await readFile(path.join(ROOT, 'src', 'music', 'sources', 'youtube.js'), 'utf8');
  assert(!/stream_from_info|play\.stream/.test(source), 'the play-dl extraction path is back');
  return 'Node 24 + pinned yt-dlp + CA certificates';
});

await check('secrets and local state are excluded from the image build', async () => {
  const ignore = (await readFile(path.join(ROOT, '.dockerignore'), 'utf8'))
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

  for (const pattern of ['.env', 'data/', 'node_modules/', '.git/']) {
    assert(ignore.includes(pattern), `${pattern} is not excluded from the build context`);
  }
  assert(!ignore.includes('!.env'), 'the ignore file re-includes .env');

  const result = spawnSync('git', ['check-ignore', '--quiet', '.env'], { cwd: ROOT });
  if (!result.error) {
    assert(result.status === 0, '.env is no longer git-ignored');
  }
  return '.env, data/ and node_modules/ excluded';
});

await check('the running Node supports node:sqlite without a flag', async () => {
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const range = manifest.engines?.node ?? '';
  const major = Number(process.versions.node.split('.')[0]);

  assert(/^>=\s*24/.test(range), `engines.node is "${range}", which may predate node:sqlite`);
  assert(major >= 24, `running Node ${process.versions.node}, below the supported floor`);

  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t (a INTEGER)');
  db.close();
  return `Node ${process.versions.node} >= ${range}`;
});

await check('a Render deployment warns about ephemeral state', async () => {
  const { detectPlatform, describePersistence, stateInventory } = await import(
    pathToFileURL(path.join(ROOT, 'src', 'deploy', 'platform.js')).href
  );

  assert(detectPlatform({ RENDER: 'true' }) === 'render', 'Render is not detected from its own marker');
  assert(detectPlatform({}) === 'local', 'a local run was detected as Render');

  const entries = stateInventory({ funDbFile: '/app/data/pomp-fun.sqlite', giveawayStateFile: '/app/data/giveaways.json' });
  const onRender = describePersistence({ platform: 'render', entries });
  assert(onRender.ephemeral === true, 'a Render run with local files was treated as durable');
  assert(/Render ephemeral filesystem detected/.test(onRender.warning), 'the warning does not say what happened');
  assert(/FUN_DB_FILE/.test(onRender.warning), 'the warning does not say how to fix it');

  const local = describePersistence({ platform: 'local', entries });
  assert(local.ephemeral === false && local.warning === null, 'a local run produced a Render warning');
  return 'detected, warned, and silent locally';
});

/* -------------------------------------------------------------------------- */

const failures = results.filter((result) => !result.ok);
process.stdout.write(`\n${'='.repeat(60)}\n`);
process.stdout.write(`${results.length - failures.length}/${results.length} checks passed\n`);

if (failures.length > 0) {
  process.stdout.write(`\nFailed:\n${failures.map((f) => `  - [${f.group}] ${f.name}: ${f.detail}`).join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('All checks passed.\n');
}
