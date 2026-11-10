import { brandEnv, brandEnvironment } from 'daocut/brand-env';
/**
 * Which Daocut this process is. Two apps, each with its own name, bundle id, data folder and Studio home, so the
 * one run from this repository never shares a window, a lock or a Studio with the installed one. Projects are the
 * person's, so every app but the bench shares one library: the one ~/.daocut says (`sharedHome`; by default
 * ~/Movies/Daocut/Projects, or DAOCUT_LIBRARY):
 *
 *   · release — the packaged app. Its Studio is the machine's Studio (~/.daocut), the one `daocut open` finds.
 *   · preview — a packaged app built with `release --preview`, "Daocut Preview", to try a build in: its own data
 *               folder, Studio home and port, so it never meets an installed Daocut (its package says so:
 *               `daocutFlavor`).
 *   · dev     — `pnpm --filter @daocut/desktop start`: this repository's code, with its own Studio home.
 *   · bench   — `node bench/run.mjs`: this repository's code, everything (data, Studio home, projects) in the throwaway
 *               folder the benchmark names in DAOCUT_BENCH_DIR, so a run never touches a person's dev or installed app.
 *
 * Reads no Electron module, so `node --test` can use it.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packaged = Boolean(process.versions.electron) && !process.defaultApp;

export const DAOCUT_HOME = process.env.DAOCUT_HOME || (process.platform === 'win32' ? 'D:/Daocut' : join(homedir(), 'Daocut'));
const studioHome = join(DAOCUT_HOME, 'StudioData');
export const FLAVORS = Object.freeze({
  release: { productName: 'Daocut', bundleId: 'com.daotian.daocut', studioPort: 4847,
    studioHome, library: join(DAOCUT_HOME, 'Projects'), sharedHome: studioHome, userData: join(DAOCUT_HOME, 'AppData') },
  preview: { productName: 'Daocut Preview', bundleId: 'com.daotian.daocut.preview', studioPort: 4877,
    studioHome: join(DAOCUT_HOME, 'PreviewStudioData'), library: join(DAOCUT_HOME, 'Projects'), sharedHome: studioHome, userData: join(DAOCUT_HOME, 'PreviewAppData') },
  dev: { productName: 'Daocut Dev', bundleId: 'com.daotian.daocut.dev', studioPort: 4857,
    studioHome: join(DAOCUT_HOME, 'DevStudioData'), library: join(DAOCUT_HOME, 'Projects'), sharedHome: studioHome, userData: join(DAOCUT_HOME, 'DevAppData') },
});

const benchDir = brandEnv('BENCH_DIR') ?? '';
const BENCH = Object.freeze({
  productName: 'Daocut Bench', bundleId: 'com.daotian.daocut.bench', studioPort: 4867,
  studioHome: join(benchDir, 'home'), library: join(benchDir, 'projects'), sharedHome: null, userData: join(benchDir, 'data'),
});

/** What the app's package says it was built as (`release --preview` writes `daocutFlavor`). */
function builtFlavor() {
  try {
    return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).daocutFlavor ?? null;
  } catch { return null; }
}

export function flavorName(env = process.env, isPackaged = packaged, built = isPackaged ? builtFlavor() : null) {
  env = brandEnvironment(env);
  if (isPackaged) return built === 'preview' ? 'preview' : 'release';
  if (env.DAOCUT_DESKTOP_FLAVOR === 'dev') return 'dev';
  if (env.DAOCUT_DESKTOP_FLAVOR === 'bench' && env.DAOCUT_BENCH_DIR) return 'bench';
  return 'release';
}

export const FLAVOR = flavorName();
export const IDENTITY = FLAVOR === 'bench' ? BENCH : FLAVORS[FLAVOR];
export const PRODUCT_NAME = IDENTITY.productName;
