// Fixture for tests/commands.test.js: a deliberately malformed command module.
// It exports `data` but forgets `execute`, so the loader must reject the directory.
export const data = {
  name: 'oops',
  description: 'This command is intentionally broken.',
};
