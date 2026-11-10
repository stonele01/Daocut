/** Prepare the Windows runtime from the same pinned downloads used by the upstream release builder. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchFfmpeg } from '../src/ffmpeg-runtime.mjs';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(desktop, 'package.json'));
const option = (name) => process.argv.find((arg) => arg.startsWith('--' + name + '='))?.slice(name.length + 3);
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Prepare this runtime on Windows x64.');
const runtime = resolve(option('runtime') || join(desktop, '.release/runtime/win-x64'));
if (existsSync(runtime)) throw new Error('Runtime output already exists: ' + runtime + '. Reuse it with build-daocut.mjs --runtime, or prepare a new folder with --runtime.');
mkdirSync(runtime, { recursive: true });
await fetchFfmpeg(join(runtime, 'ffmpeg'), { platform: 'win32', arch: 'x64', license: true });
const playwright = dirname(require.resolve('playwright-core/package.json'));
execFileSync(process.execPath, [join(playwright, 'cli.js'), 'install', 'chromium-headless-shell'], {
  stdio: 'inherit', windowsHide: true,
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: join(runtime, 'ms-playwright'), PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: 'win64' },
});
console.log('Runtime ready: ' + runtime);
