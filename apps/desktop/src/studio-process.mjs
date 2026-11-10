import { brandEnv } from 'daocut/brand-env';
/**
 * Studio, inside the app: an Electron utility process running the open-source Studio (the `daocut` package's
 * `startStudio`), serving the window's page (shell/) as its editor. It is the machine's Studio (`advertise`): an
 * agent's `daocut open` finds it and shows its project in the app's window, not in a browser.
 *
 * Talks to the main process over `process.parentPort`:
 *   → { type: 'ready', origin, filmOrigin, key }   listening
 *   → { type: 'failed', code, message }              could not start (code 'EADDRINUSE': the port is taken)
 *   → { type: 'browser', state: 'downloading' | 'ready' | 'failed', message? }   the headless browser pages draw in
 *   → { type: 'ffmpeg', found }                      whether ffmpeg and ffprobe are on the PATH (video pictures, sound, export)
 *   → { type: 'open', url }                          Studio wants something shown in the person's browser
 *   ← { type: 'quit' }                               stop (history is written first)
 *   ← { type: 'working', folders }                   the folders the chat's agents are working in now (not deletable)
 */
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { startStudio } from 'daocut/studio';
import { launch } from 'daocut/host';
import { createDesktopAnalysisServices } from 'daocut/analysis-services';
import { createStudioAnalysisBridge } from './studio-analysis-bridge.mjs';

const parent = process.parentPort;
const send = (message) => parent.postMessage(message);
const analysisServices = createDesktopAnalysisServices({ textBridge: createStudioAnalysisBridge({ send, subscribe: listen => parent.on('message', ({ data }) => listen(data)) }) });
let companyRequestId = 0;
const companyRequests = new Map();
/** Main validates each new task; the utility process never receives a bearer token. */
function authorizeTask() {
  return new Promise((resolve, reject) => {
    const id = String(++companyRequestId);
    const timer = setTimeout(() => { companyRequests.delete(id); reject(new Error('公司账号验证超时，请重试。')); }, 15000);
    companyRequests.set(id, { resolve, reject, timer });
    send({ type: 'company-authorize', id });
  });
}

let studio = null;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await studio?.close().catch(() => {});
  process.exit(0);
}
/** the folders the chat's agents are working in, as the main process last told */
let working = [];
parent.on('message', ({ data }) => {
  if (data?.type === 'company-authorized') {
    const pending = companyRequests.get(data.id);
    if (pending) {
      companyRequests.delete(data.id); clearTimeout(pending.timer);
      if (data.ok === true) pending.resolve();
      else pending.reject(Object.assign(new Error(data.error || '请先登录公司账号。'), { code: 'company-auth-required' }));
    }
  }
  if (data?.type === 'quit') void stop();
  if (data?.type === 'working' && Array.isArray(data.folders)) working = data.folders.filter((f) => typeof f === 'string');
});

const port = Number(brandEnv('STUDIO_PORT'));
try {
  studio = await startStudio({
    ...analysisServices,
    port: Number.isInteger(port) ? port : 0,
    advertise: true,
    authorizeTask,
    openBrowser: (url) => send({ type: 'open', url }),
    /* another app (or `daocut open`) asked this Studio to stop: the window still needs it, so it stays and says so */
    stays: true,
    working: () => working,
    /* the window's page, Studio's editor with the chat beside it (shell/), in place of the editor alone */
    ...(brandEnv('EDITOR_DIR') ? { editorDir: brandEnv('EDITOR_DIR') } : {}),
  });
  send({ type: 'ready', origin: studio.origin, filmOrigin: studio.filmOrigin, key: studio.key });
} catch (e) {
  send({ type: 'failed', code: e?.code ?? null, message: e?.message ?? String(e) });
  process.exit(1);
}

send({ type: 'ffmpeg', found: ['ffmpeg', 'ffprobe'].every((bin) => !spawnSync(bin, ['-version'], { stdio: 'ignore', windowsHide: true }).error) });

/* Studio draws pages' pictures in Playwright's headless browser: download it once, the first time (about 100 MB) */
try {
  await (await launch()).close();
  send({ type: 'browser', state: 'ready' });
} catch (e) {
  if (!/Executable doesn't exist/.test(e?.message ?? '')) send({ type: 'browser', state: 'failed', message: e?.message ?? String(e) });
  else {
    send({ type: 'browser', state: 'downloading' });
    const daocut = dirname(createRequire(import.meta.url).resolve('daocut/package.json'));
    const cli = join(dirname(createRequire(join(daocut, 'package.json')).resolve('playwright-core/package.json')), 'cli.js');
    const child = spawn(process.execPath, [cli, 'install', 'chromium-headless-shell'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore', windowsHide: true });
    child.once('exit', (code) => send(code === 0 ? { type: 'browser', state: 'ready' } : { type: 'browser', state: 'failed', message: `the download stopped (${code})` }));
    child.once('error', (error) => send({ type: 'browser', state: 'failed', message: error.message }));
  }
}
