import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const env = { ...process.env };
const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
env[pathKey] = `${path.join(os.homedir(), '.cargo', 'bin')}${path.delimiter}${env[pathKey]}`;
if (!env.TAURI_SIGNING_PRIVATE_KEY) {
  console.error(
    'Set TAURI_SIGNING_PRIVATE_KEY to your protected signing key, or use npm run tauri -- build --no-bundle for a local executable. Never commit this key.',
  );
  process.exit(1);
}
if (fs.existsSync(env.TAURI_SIGNING_PRIVATE_KEY))
  env.TAURI_SIGNING_PRIVATE_KEY = fs.readFileSync(env.TAURI_SIGNING_PRIVATE_KEY, 'utf8').trim();
const r = spawnSync(
  process.execPath,
  ['node_modules/@tauri-apps/cli/tauri.js', 'build', '--bundles', 'nsis'],
  { stdio: 'inherit', env },
);
process.exitCode = r.status ?? 1;
