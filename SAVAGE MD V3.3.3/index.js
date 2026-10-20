// SAVAGE MD BOT — entry point.
//
// Every application module (WhatsApp, Telegram, database, plugins,
// commands, handlers, services/workers, middleware, config) now lives in
// ./bot.js, produced by bundling the original multi-file project into one
// file. This file is intentionally tiny: it's here only because the
// deployment tooling (Dockerfile CMD, ecosystem.config.js, `npm start`)
// points at index.js, and because a first-run dependency preflight has to
// run before bot.js's own top-level `require()`s of npm packages execute.

const { execFileSync } = require('child_process');

// --- First-run dependency bootstrap (moved here from the old
// scripts/ensure-dependencies.js, which no longer exists as a separate
// file) ---
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
  console.error(`[SAVAGE] Node.js ${process.versions.node} is too old.`);
  console.error('[SAVAGE] Use Node.js 22.5+ (Node 24+ recommended).');
  process.exit(1);
}

const REQUIRED_PACKAGES = [
  'telegraf',
  'express',
  'dotenv',
  'winston',
  'winston-daily-rotate-file',
  'pino',
  'qrcode',
  '@whiskeysockets/baileys',
  'link-preview-js',
];

function missingPackages() {
  return REQUIRED_PACKAGES.filter((name) => {
    try {
      require.resolve(name);
      return false;
    } catch (_) {
      return true;
    }
  });
}

let missing = missingPackages();
if (missing.length) {
  console.log(`[SAVAGE] First-run dependency bootstrap: ${missing.join(', ')}`);
  try {
    execFileSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['install', '--omit=dev', '--no-audit', '--no-fund', '--prefer-online', '--legacy-peer-deps'],
      { stdio: 'inherit' }
    );
  } catch (err) {
    console.error('[SAVAGE] npm dependency installation failed.');
    console.error('[SAVAGE] Check network access and run: npm install --omit=dev --legacy-peer-deps');
    process.exit(err.status || 1);
  }
  missing = missingPackages();
}
if (missing.length) {
  console.error(`[SAVAGE] Dependencies still missing: ${missing.join(', ')}`);
  process.exit(1);
}

// --- Boot the actual bot ---
require('./bot.js');
