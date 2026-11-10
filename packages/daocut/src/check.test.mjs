import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const cli = fileURLToPath(new URL('../bin/daocut.mjs', import.meta.url));
const film = (clips) => `<meta name="viewport" content="width=1080, height=1920">\n<section>\n${clips}\n</section>\n`;
const snapshot = (dir) => readdirSync(dir, { recursive: true }).sort().map((name) => {
  const file = join(dir, name);
  return [name, statSync(file).isFile() ? readFileSync(file).toString('base64') : null];
});

function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'daocut-check-'));
  try {
    const project = join(dir, 'project 中文');
    mkdirSync(project);
    const guard = join(dir, 'no-runtime.mjs');
    writeFileSync(guard, `import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const blocked = () => { throw new Error('check must not start a runtime process or make a network request'); };
for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[key] = blocked;
syncBuiltinESMExports();
globalThis.fetch = blocked;
`);
    const env = { ...process.env, DAOCUT_NO_UPDATE_CHECK: '1', DAOCUT_STUDIO_HOME: join(dir, 'studio'), DAOCUT_SHARED_HOME: join(dir, 'studio'), PLAYWRIGHT_BROWSERS_PATH: join(dir, 'no-browser') };
    for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
    env.PATH = '';
    const run = (args = [], cwd = project) => spawnSync(process.execPath, ['--import', pathToFileURL(guard).href, cli, 'check', ...args], { cwd, env, encoding: 'utf8', windowsHide: true });
    fn({ dir, project, run });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('check accepts the real timeline schema without media tools, opening Studio, networking or modifying the project', () => fixture(({ dir, project, run }) => {
  // Missing media is deliberate: this command checks structure, not media readiness.
  writeFileSync(join(project, 'film.html'), film('<video id="a" src="assets/missing.mp4#t=8,12" at="0"></video>'));
  mkdirSync(join(project, 'notes'));
  const before = snapshot(project);
  for (const [args, cwd] of [[[], project], [[], join(project, 'notes')], [[join(project, 'film.html')], dir]]) {
    const result = run(args, cwd);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /1 clips, 1 tracks/);
    assert.match(result.stdout, /source duration, spoken cuts and visual output were not checked/);
  }
  assert.deepEqual(snapshot(project), before);
  assert.equal(existsSync(join(dir, 'studio')), false);
}));

test('check rejects reversed ranges, negative timeline positions and NaN without rendering or rewriting them', () => fixture(({ project, run }) => {
  const cases = [
    { clips: [
      '<video id="reversed" src="a.mp4#t=30,20"></video>',
      '<video id="negative" src="b.mp4#t=0,2" at="-924.23"></video>',
    ], errors: [/has to end after it starts/, /0 or more/] },
    { clips: ['<video id="nan" src="c.mp4#t=NaN,20" at="4"></video>'], errors: [/NaN/] },
  ];
  for (const { clips, errors } of cases) {
    writeFileSync(join(project, 'film.html'), film(clips.join('\n')));
    const before = snapshot(project);
    const result = run();
    assert.equal(result.status, 1, result.stderr + result.stdout);
    for (const error of errors) assert.match(result.stdout, error);
    assert.deepEqual(snapshot(project), before);
  }
}));
