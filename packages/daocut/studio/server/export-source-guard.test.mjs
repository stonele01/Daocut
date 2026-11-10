import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { createExports } from './exports.mjs';
import { writePrefs } from './prefs.mjs';
import { filmHtml } from '../../src/film-doc.mjs';
import { parseFilmSubtitleStyle } from './film-subtitle.mjs';
import { assertExportSources } from './export-source-guard.mjs';

const base = resolve(import.meta.dirname, '../../../../.tmp/source-safety-20261105/export');
const hash = data => createHash('sha256').update(data).digest('hex');
const finished = async (manager, project, job) => {
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    const current = manager.list(project.id).find(item => item.id === job.id);
    if (['done', 'failed', 'cancelled'].includes(current.status)) return current;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error('isolated export did not finish');
};

async function fixture(t, { used = true, mapped = true, link = false, sha = false, nested = false } = {}) {
  await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(join(base, 'case-')), root = join(dir, 'project'), library = join(dir, 'library');
  const target = join(library, 'live.mp4'), alias = join(root, 'assets/live.mp4');
  const env = ['DAOCUT_STUDIO_HOME', 'DAOCUT_LIBRARY', 'DAOCUT_EXPORTS'];
  const previous = Object.fromEntries(env.map(key => [key, process.env[key]]));
  process.env.DAOCUT_STUDIO_HOME = join(dir, 'home'); process.env.DAOCUT_LIBRARY = join(dir, 'projects'); process.env.DAOCUT_EXPORTS = join(dir, 'exports');
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); for (const key of env) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key]; });
  t.mock.method(globalThis, 'fetch', () => { throw Error('real requests forbidden'); });
  let rendererCalls = 0;
  t.mock.method(childProcess, 'fork', () => { rendererCalls++; throw Error('TEST_RENDERER_WAS_CALLED'); });
  for (const path of [library, join(root, 'assets'), join(root, '.film/shared-analysis')]) await fs.mkdir(path, { recursive: true });
  await fs.writeFile(target, 'ORIGINAL'); await fs.copyFile(target, alias);
  const original = await fs.stat(target), originalBytes = await fs.readFile(target);
  const manifest = { version: 1, items: { 'assets/live.mp4': { libraryId: 'library-isolated', libraryName: 'Isolated library', relativePath: 'live.mp4', size: original.size, mtimeMs: original.mtimeMs } } };
  await fs.writeFile(join(root, 'assets/.daocut-source-media.json'), JSON.stringify(manifest));
  await fs.writeFile(join(root, 'scene.html'), '<video src="assets/live.mp4"></video><script>window.film={duration:1,width:320,height:180,frame(){}}</script>');
  await fs.writeFile(join(root, 'film.html'), filmHtml({ stage: { w: 320, h: 180 }, tracks: [{ clips: used ? [{ id: 'clip', src: nested ? 'scene.html' : 'assets/live.mp4', time: [0, 1] }] : [] }] }));
  await fs.writeFile(join(root, '.film/product-analysis.json'), JSON.stringify({ version: 1, sources: [{ id: 'source', assetPath: 'assets/live.mp4', durationMs: 1000 }], products: [], intervals: [], candidates: [] }));
  if (sha) await fs.writeFile(join(root, '.film/shared-analysis', `${'a'.repeat(64)}.json`), JSON.stringify({ sourceId: 'source', status: 'complete', descriptor: { source: { libraryId: 'library-isolated', relativePath: 'live.mp4', sha256: hash(originalBytes), size: original.size } } }));
  writePrefs({ sharedMediaLibraries: mapped ? [{ id: 'library-isolated', name: 'Isolated library', root: library }] : [] });
  if (link) {
    // Exact link metadata is mocked; both target and project bytes are real isolated files, not a NAS/symlink test.
    const lstat = fs.lstat, realpath = fs.realpath;
    t.mock.method(fs, 'lstat', async (path, ...args) => resolve(String(path)) === alias ? { ...(await lstat(alias)), isSymbolicLink: () => true } : lstat(path, ...args));
    t.mock.method(fs, 'realpath', async (path, ...args) => resolve(String(path)) === alias ? realpath(target, ...args) : realpath(path, ...args));
  }
  syncBuiltinESMExports();
  const project = { id: 'isolated', name: 'Shared source', path: root };
  const exportWith = async (ask, options = {}) => { const manager = createExports(options); return finished(manager, project, manager.start(project, ask)); };
  return { root, dir, target, alias, project, original, originalBytes, exportWith, rendererCalls: () => rendererCalls };
}

test('used shared source changed in place fails before video renderer or output creation', async t => {
  const f = await fixture(t); await fs.writeFile(f.target, 'REPLACEMENT LONGER THAN ORIGINAL');
  const done = await f.exportWith({ kind: 'video', hardware: false });
  assert.equal(done.status, 'failed'); assert.match(done.error, /原片|共享素材/); assert.match(done.error, /变化|确认/);
  assert.equal(f.rendererCalls(), 0); assert.deepEqual(done.outputs, []);
  assert.equal(await fs.readFile(f.target, 'utf8'), 'REPLACEMENT LONGER THAN ORIGINAL');
});

test('unconfigured and offline used shared sources cannot bypass export through direct calls', async t => {
  for (const state of ['unconfigured', 'offline']) await t.test(state, async t => {
    const f = await fixture(t, { mapped: state !== 'unconfigured' }); if (state === 'offline') await fs.unlink(f.target);
    const done = await f.exportWith({ kind: 'video', hardware: false });
    assert.equal(done.status, 'failed'); assert.match(done.error, /原片|共享素材/); assert.equal(f.rendererCalls(), 0); assert.deepEqual(done.outputs, []);
  });
});

test('ordinary project folder and ZIP exports refuse changed shared bytes', async t => {
  const f = await fixture(t, { used: false }); await fs.writeFile(f.target, 'changed external original');
  for (const as of ['folder', 'zip']) {
    const done = await f.exportWith({ kind: 'project', as });
    assert.equal(done.status, 'failed'); assert.match(done.error, /变化|确认/); assert.deepEqual(done.outputs, []);
  }
});

test('saved SHA rejects same-size replacement with preserved mtime', async t => {
  const f = await fixture(t, { link: true, sha: true });
  await fs.writeFile(f.target, 'REPLACED'); await fs.utimes(f.target, f.original.atime, f.original.mtime);
  const done = await f.exportWith({ kind: 'video', hardware: false });
  assert.equal(done.status, 'failed'); assert.match(done.error, /内容|身份/); assert.equal(f.rendererCalls(), 0); assert.deepEqual(done.outputs, []);
});

test('nested scene dependencies are checked for shared source replacement', async t => {
  const f = await fixture(t, { nested: true }); await fs.writeFile(f.target, 'changed external original');
  const done = await f.exportWith({ kind: 'video', hardware: false });
  assert.equal(done.status, 'failed'); assert.match(done.error, /变化|确认/); assert.equal(f.rendererCalls(), 0);
});

test('an unused unavailable shared asset does not prevent standalone subtitle export', async t => {
  const f = await fixture(t, { used: false, mapped: false });
  const done = await f.exportWith({ kind: 'subtitles', format: 'vtt' }, { captions: async () => ({ cues: [{ startMs: 0, durMs: 1000, text: 'local saved words' }], style: parseFilmSubtitleStyle(null) }) });
  assert.equal(done.status, 'done', done.error); assert.match(await fs.readFile(done.out, 'utf8'), /local saved words/); assert.equal(f.rendererCalls(), 0);
});

test('unchanged mocked shared file link allows actual ordinary folder and ZIP exports', async t => {
  const f = await fixture(t, { link: true, sha: true });
  for (const as of ['folder', 'zip']) {
    const done = await f.exportWith({ kind: 'project', as }); assert.equal(done.status, 'done', done.error);
    if (as === 'folder') assert.deepEqual(await fs.readFile(join(done.out, 'assets/live.mp4')), f.originalBytes);
    else assert.ok((await fs.readFile(done.out)).includes(f.originalBytes));
  }
  assert.deepEqual(await fs.readFile(f.target), f.originalBytes);
});

test('queued export rechecks the shared source after an earlier job finishes', async t => {
  const f = await fixture(t, { link: true }); let release, entered;
  const blocked = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { entered = resolve; });
  const manager = createExports({ captions: async () => { entered(); await blocked; return { cues: [{ startMs: 0, durMs: 1000, text: 'saved' }], style: parseFilmSubtitleStyle(null) }; } });
  const first = manager.start(f.project, { kind: 'subtitles' }); await ready;
  const queued = manager.start(f.project, { kind: 'video', hardware: false });
  assert.equal(queued.status, 'waiting'); await fs.writeFile(f.target, 'changed while export waits'); release();
  assert.equal((await finished(manager, f.project, first)).status, 'done');
  const done = await finished(manager, f.project, queued);
  assert.equal(done.status, 'failed'); assert.match(done.error, /变化|确认/); assert.equal(f.rendererCalls(), 0); assert.deepEqual(done.outputs, []);
});

test('a changed unused shared asset does not block a film using only ordinary local material', async t => {
  const f = await fixture(t, { used: false, mapped: false });
  await fs.writeFile(join(f.root, 'film.html'), filmHtml({ stage: { w: 320, h: 180 }, tracks: [{ clips: [{ id: 'local', src: 'assets/local.mp4', time: [0, 1] }] }] }));
  await fs.writeFile(join(f.root, 'assets/local.mp4'), 'local synthetic media');
  await fs.writeFile(f.target, 'different unused source');
  await (await assertExportSources(f.root, { kind: 'video' }))();
});

test('a source changed while a folder export copies leaves no successful-looking output', async t => {
  const f = await fixture(t, { link: true }); const copy = fs.copyFile;
  t.mock.method(fs, 'copyFile', async (from, to, ...args) => {
    await copy(from, to, ...args);
    if (resolve(String(from)) === f.alias) await fs.writeFile(f.target, 'changed during copying');
  }); syncBuiltinESMExports();
  const done = await f.exportWith({ kind: 'project', as: 'folder' });
  assert.equal(done.status, 'failed'); assert.match(done.error, /变化/); assert.deepEqual(done.outputs, []);
  assert.deepEqual(await fs.readdir(join(f.dir, 'exports')), []);
});

test('a batch twin is checked before copying the first rendered output', async t => {
  const f = await fixture(t, { link: true }); let renders = 0, changed = false;
  t.mock.method(childProcess, 'fork', () => {
    renders++; const child = new EventEmitter(); child.stderr = new EventEmitter(); child.connected = true;
    child.send = ({ opts }) => { fs.writeFile(opts.out, 'mock-render-output').then(() => child.emit('message', { type: 'done', result: { out: opts.out, lines: [], encoder: 'mock' } })); };
    return child;
  }); syncBuiltinESMExports();
  const manager = createExports({ onChange: job => { if (!changed && job.status === 'done') { changed = true; writeFileSync(f.target, 'changed before queued clone'); } } });
  const jobs = manager.startAll(f.project, { jobs: [{ kind: 'video', hardware: false, label: 'first' }, { kind: 'video', hardware: false, label: 'twin' }] });
  const first = await finished(manager, f.project, jobs[0]), second = await finished(manager, f.project, jobs[1]);
  assert.equal(first.status, 'done', first.error); assert.equal(second.status, 'failed'); assert.match(second.error, /变化|确认/);
  assert.equal(renders, 1); assert.deepEqual(second.outputs, []); assert.equal((await fs.readdir(join(f.dir, 'exports'))).length, 1);
  assert.equal(await fs.readFile(first.out, 'utf8'), 'mock-render-output');
});

test('single clip export does not re-add a different unselected shared clip', async t => {
  const f = await fixture(t, { mapped: false });
  await fs.writeFile(join(f.root, 'film.html'), filmHtml({ stage: { w: 320, h: 180 }, tracks: [{ clips: [{ id: 'shared', src: 'assets/live.mp4', time: [0, 1] }, { id: 'local', src: 'assets/local.mp4', at: 1, time: [0, 1] }] }] }));
  await fs.writeFile(join(f.root, 'assets/local.mp4'), 'local synthetic media');
  await (await assertExportSources(f.root, { kind: 'video', clip: 'local' }))();
});

test('script-created scene media cannot evade shared original checks', async t => {
  const f = await fixture(t, { nested: true }); await fs.writeFile(f.target, 'changed external source');
  for (const script of ["const video=document.createElement('video');video.src='assets/live.mp4';", "const sound=new Audio('assets/live.mp4');"]) {
    await fs.writeFile(join(f.root, 'scene.html'), `<script>${script}window.film={duration:1,width:320,height:180,frame(){}}</script>`);
    await assert.rejects(assertExportSources(f.root, { kind: 'video' }), /变化|确认/);
  }
});

test('an unreadable or null shared manifest is not treated as a project with no shared originals', async t => {
  const f = await fixture(t);
  for (const data of ['null', '{']) {
    await fs.writeFile(join(f.root, 'assets/.daocut-source-media.json'), data);
    await assert.rejects(assertExportSources(f.root, { kind: 'video' }), /记录|清单/);
  }
});

test('cancelling during source verification never starts an export afterward', async t => {
  const f = await fixture(t, { link: true }); const lstat = fs.lstat; let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), hold = new Promise(resolve => { release = resolve; });
  t.mock.method(fs, 'lstat', async (path, ...args) => {
    if (resolve(String(path)) === f.alias) { enter(); await hold; }
    return lstat(path, ...args);
  }); syncBuiltinESMExports();
  const manager = createExports(), job = manager.start(f.project, { kind: 'project', as: 'folder' });
  await entered; manager.cancel(job.id); const stopped = manager.stopAll(); release(); await stopped;
  const done = manager.list(f.project.id).find(item => item.id === job.id);
  assert.equal(done.status, 'cancelled'); assert.deepEqual(done.outputs, []);
  assert.deepEqual(await fs.readdir(join(f.dir, 'exports')).catch(error => { if (error.code === 'ENOENT') return []; throw error; }), []);
});

test('cancelling during the final source check removes only this export and remains cancelled', async t => {
  const f = await fixture(t, { link: true }); const lstat = fs.lstat; let enter, release, calls = 0;
  const entered = new Promise(resolve => { enter = resolve; }), hold = new Promise(resolve => { release = resolve; });
  await fs.mkdir(join(f.dir, 'exports')); await fs.writeFile(join(f.dir, 'exports/existing.txt'), 'keep');
  t.mock.method(fs, 'lstat', async (path, ...args) => {
    if (resolve(String(path)) === f.alias && ++calls === 2) { enter(); await hold; }
    return lstat(path, ...args);
  }); syncBuiltinESMExports();
  const manager = createExports(), job = manager.start(f.project, { kind: 'project', as: 'folder' });
  await entered; manager.cancel(job.id); const stopped = manager.stopAll(); release(); await stopped;
  const done = manager.list(f.project.id).find(item => item.id === job.id);
  assert.equal(done.status, 'cancelled'); assert.deepEqual(done.outputs, []);
  assert.deepEqual(await fs.readdir(join(f.dir, 'exports')), ['existing.txt']);
  assert.equal(await fs.readFile(join(f.dir, 'exports/existing.txt'), 'utf8'), 'keep');
});
