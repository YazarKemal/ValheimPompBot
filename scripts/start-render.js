/**
 * `npm run start:render` - the Render start path.
 *
 * The deployment runs `node src/index.js`; this script exists so the Render
 * *behaviour* can be reproduced on a laptop without editing `.env`. It forces
 * the platform detection, which is what turns on the ephemeral-filesystem
 * warning, and then starts exactly the same application process.
 *
 * An explicit DEPLOY_PLATFORM already in the environment is respected, so this
 * can also be used to verify the local path.
 */

process.env.DEPLOY_PLATFORM ??= 'render';

const { main } = await import('../src/index.js');

const { exitCode } = await main();
if (exitCode !== 0) process.exitCode = exitCode;
