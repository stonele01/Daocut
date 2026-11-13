import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readPrefs, sharedMediaLibrariesOf, writePrefs } from './prefs.mjs';
import { associateSharedLibrary } from './shared-media.mjs';
import { startStudio } from './server.mjs';

let scratch, folder, oldEnv;
const companyId = 'a'.repeat(64);
const coordinate = async (action, body) => {
  assert.equal(action, 'status', 'folder setup must only inspect coordinator identity');
  assert.match(body.taskKey, /^[a-f0-9]{64}$/);
  if (body.expectedCoordinatorId) assert.equal(body.expectedCoordinatorId, companyId);
  return { task: null, coordinationId: companyId };
};
const api = () => import('./shared-live-folder.mjs');
const manifestPath = () => join(folder, '.daocut-shared', 'manifest.json');
const useHome = name => { process.env.DAOCUT_STUDIO_HOME = join(scratch, name, 'home'); process.env.DAOCUT_LIBRARY = join(scratch, name, 'projects'); };

beforeEach(async () => {
  const base = resolve(process.env.DAOCUT_TEST_TMP || '.test-temp'); await mkdir(base, { recursive: true });
  scratch = await mkdtemp(join(base, 'live-folder-'));
  oldEnv = Object.fromEntries(['DAOCUT_STUDIO_HOME', 'DAOCUT_LIBRARY', 'DAOCUT_TRASH_DIR', 'DAOCUT_SHARED_HOME'].map(key => [key, process.env[key]]));
  process.env.DAOCUT_TRASH_DIR = join(scratch, 'trash'); process.env.DAOCUT_SHARED_HOME = join(scratch, 'shared-home');
  useHome('a'); folder = join(scratch, '直播 (1)'); await mkdir(folder);
  await writeFile(join(folder, '原视频.mp4'), 'synthetic bytes only');
});
afterEach(async () => {
  for (const [key, value] of Object.entries(oldEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  const base = resolve(process.env.DAOCUT_TEST_TMP || '.test-temp');
  assert.ok(resolve(scratch).startsWith(base + sep), 'cleanup stays inside the isolated test root');
  await rm(scratch, { recursive: true, force: true });
});

test('selecting a new live folder only describes initialization and never writes to it', async () => {
  const { inspectLiveFolder } = await api();
  const value = await inspectLiveFolder({ folder }, { coordinate });
  assert.equal(value.status, 'needs-initialization'); assert.equal(value.legacy, false);
  assert.deepEqual(value.videos.map(v => v.name), ['原视频.mp4']);
  assert.equal(existsSync(join(folder, '.daocut-shared')), false);
  assert.equal(readPrefs().sharedMediaLibraries.length, 0);
});

test('explicit initialization races settle on one persistent ID and preserve source bytes', async () => {
  const { inspectLiveFolder } = await api();
  const input = { folder, initialize: true };
  const values = await Promise.all(Array.from({ length: 8 }, () => inspectLiveFolder(input, { coordinate })));
  assert.ok(values.every(v => v.status === 'ready' && v.library.id === values[0].library.id));
  const manifest = JSON.parse(await readFile(manifestPath(), 'utf8'));
  assert.equal(manifest.libraryId, values[0].library.id); assert.equal(manifest.coordinationId, companyId);
  assert.equal(manifest.version, 1); assert.equal(manifest.resultPath, '.daocut-shared');
  assert.equal(await readFile(join(folder, '原视频.mp4'), 'utf8'), 'synthetic bytes only');
  assert.equal(readPrefs().sharedAnalysis.enabled, true);
  assert.equal(readPrefs().sharedAnalysis.resultRoots[0].coordinationId, companyId);
});

test('two independent processes initialize one scene ID while keeping separate local preferences', async () => {
  const moduleUrl = new URL('./shared-live-folder.mjs', import.meta.url).href;
  const program = `const { inspectLiveFolder } = await import(${JSON.stringify(moduleUrl)}); const value = await inspectLiveFolder({folder:process.env.TEST_LIVE_FOLDER,initialize:true},{coordinate:async()=>({task:null,coordinationId:'a'.repeat(64)})}); process.stdout.write(JSON.stringify({id:value.library.id}));`;
  const outputs = await Promise.all(['process-a', 'process-b'].map(name => promisify(execFile)(process.execPath, ['--input-type=module', '--eval', program], {
    cwd: scratch, windowsHide: true,
    env: { ...process.env, TEST_LIVE_FOLDER: folder, DAOCUT_STUDIO_HOME: join(scratch, name, 'home'), DAOCUT_LIBRARY: join(scratch, name, 'projects') },
  })));
  const ids = outputs.map(r => JSON.parse(r.stdout).id); assert.equal(ids[0], ids[1]);
  for (const name of ['process-a', 'process-b']) {
    const prefs = JSON.parse(await readFile(join(scratch, name, 'home', 'prefs.json'), 'utf8'));
    assert.equal(prefs.sharedMediaLibraries[0].id, ids[0]);
  }
});

test('a coworker discovers the same identity without writing the manifest or requiring write access', async () => {
  const { inspectLiveFolder } = await api();
  const first = await inspectLiveFolder({ folder, initialize: true }, { coordinate });
  const bytes = await readFile(manifestPath()); const stamp = (await stat(manifestPath())).mtimeMs;
  useHome('b');
  const second = await inspectLiveFolder({ folder }, { coordinate, openFile: async () => { throw Object.assign(Error('read only'), { code: 'EACCES' }); } });
  assert.equal(second.status, 'ready'); assert.equal(second.library.id, first.library.id);
  assert.equal(second.resultRoot, first.resultRoot); assert.deepEqual(await readFile(manifestPath()), bytes);
  assert.equal((await stat(manifestPath())).mtimeMs, stamp);
});

test('malformed or unsafe metadata is not replaced by another ID', async () => {
  const { inspectLiveFolder } = await api();
  await mkdir(join(folder, '.daocut-shared'));
  for (const text of ['{', JSON.stringify({ version: 1, libraryId: 'stable-live-01', name: 'Live', coordinationId: companyId, resultPath: '../outside' })]) {
    await writeFile(manifestPath(), text);
    await assert.rejects(inspectLiveFolder({ folder, initialize: true }, { coordinate }), /说明|格式|目录|完整/);
    assert.equal(await readFile(manifestPath(), 'utf8'), text);
  }
});

test('missing write permission fails initialization clearly before it can establish sharing', async () => {
  const { inspectLiveFolder } = await api();
  await assert.rejects(inspectLiveFolder({ folder, initialize: true }, { coordinate, openFile: async () => { throw Object.assign(Error('denied'), { code: 'EACCES' }); } }), /权限|写入/);
  assert.equal(readPrefs().sharedMediaLibraries.length, 0);
});

test('a legacy library keeps its ID, relative paths and external results without creating a sidecar', async () => {
  const { inspectLiveFolder } = await api();
  await associateSharedLibrary({ id: 'legacy-live-01', name: 'Old library', root: scratch });
  const results = join(scratch, 'old-results');
  writePrefs({ sharedAnalysis: { enabled: true, resultRoots: [{ libraryId: 'legacy-live-01', root: results }] } });
  const value = await inspectLiveFolder({ folder }, { coordinate });
  assert.equal(value.status, 'ready'); assert.equal(value.legacy, true); assert.equal(value.library.id, 'legacy-live-01');
  assert.equal(value.videos[0].path, '直播 (1)/原视频.mp4'); assert.equal(value.resultRoot, results);
  assert.equal(existsSync(join(folder, '.daocut-shared')), false);
});

test('legacy missing results gives a warning without a new identity or disabling existing preferences', async () => {
  const { inspectLiveFolder } = await api();
  await associateSharedLibrary({ id: 'legacy-live-02', name: 'Old library', root: folder });
  const value = await inspectLiveFolder({ folder, initialize: true }, { coordinate });
  assert.equal(value.library.id, 'legacy-live-02'); assert.equal(value.resultRoot, null);
  assert.ok(value.warnings.some(w => /共享结果/.test(w))); assert.equal(existsSync(manifestPath()), false);
});

test('two direct videos are listed independently; nested videos and result files are not candidates', async () => {
  const { inspectLiveFolder } = await api();
  await writeFile(join(folder, '第二条.mov'), 'second synthetic'); await mkdir(join(folder, 'nested'));
  await writeFile(join(folder, 'nested', 'hidden.mp4'), 'hidden');
  const value = await inspectLiveFolder({ folder, initialize: true }, { coordinate });
  assert.equal(value.videos.length, 2); assert.ok(value.videos.every(v => !v.path.includes('/')));
  assert.equal(value.moreVideos, false);
});

test('reopening a live video continues the private project without reimporting or modifying its documents', async () => {
  const { inspectLiveFolder, openLiveProject } = await api();
  const live = await inspectLiveFolder({ folder, initialize: true }, { coordinate });
  let imports = 0; const initialize = async () => { imports++; return { status: 'empty' }; };
  const first = await openLiveProject({ folder, videoPath: live.videos[0].path, requestId: 'open-first-001' }, { coordinate, initialize });
  assert.equal(first.status, 'opened'); assert.equal(first.reused, false);
  const film = join(first.project.path, 'film.html'); await writeFile(film, 'private edited film');
  const second = await openLiveProject({ folder, videoPath: live.videos[0].path, requestId: 'open-second-002' }, { coordinate, initialize });
  assert.equal(second.status, 'opened'); assert.equal(second.reused, true); assert.equal(second.project.id, first.project.id);
  assert.equal(imports, 1); assert.equal(await readFile(film, 'utf8'), 'private edited film');
});

test('reopening delegates an empty-project refresh without rerunning initialization', async () => {
  const { inspectLiveFolder, openLiveProject } = await api();
  const live = await inspectLiveFolder({ folder, initialize: true }, { coordinate });
  const args = { folder, videoPath: live.videos[0].path };
  const refreshed = { status: 'ready', message: '已有共享分析已读入' };
  let imports = 0; const refreshedRoots = [];
  const dependencies = { coordinate, initialize: async () => { imports++; return { status: 'empty' }; }, refresh: async root => { refreshedRoots.push(root); return refreshed; } };
  const first = await openLiveProject({ ...args, requestId: 'refresh-first-001' }, dependencies);
  assert.deepEqual(refreshedRoots, []);
  const second = await openLiveProject({ ...args, requestId: 'refresh-second-002' }, dependencies);
  assert.equal(imports, 1);
  assert.deepEqual(refreshedRoots, [first.project.path]);
  assert.deepEqual(second.sharedRead, refreshed);
});

test('opening the live folder resumes its parent when an edited structure draft is also recent', async () => {
  const { inspectLiveFolder, openLiveProject } = await api();
  const { openProject } = await import('./projects.mjs');
  const live = await inspectLiveFolder({ folder, initialize: true }, { coordinate });
  const args = { folder, videoPath: live.videos[0].path };
  const first = await openLiveProject({ ...args, requestId: 'draft-parent-001' }, { coordinate });
  const child = join(first.project.path, '.film/structure-drafts', 'a'.repeat(24));
  await mkdir(join(child, 'assets'), { recursive: true });
  await mkdir(join(child, '.film'), { recursive: true });
  await writeFile(join(child, 'film.html'), 'private edited structure');
  await writeFile(join(child, '.film/structure-draft.json'), JSON.stringify({ version: 1, parentProjectId: first.project.id }));
  await writeFile(join(child, 'assets/.daocut-source-media.json'), await readFile(join(first.project.path, 'assets/.daocut-source-media.json')));
  await openProject(child);
  const reopened = await openLiveProject({ ...args, requestId: 'draft-parent-002' }, { coordinate });
  assert.equal(reopened.status, 'opened');
  assert.equal(reopened.project.id, first.project.id);
  assert.equal(await readFile(join(child, 'film.html'), 'utf8'), 'private edited structure');
});

test('multiple personal projects require a choice; an unrelated project cannot be selected', async () => {
  const { inspectLiveFolder, openLiveProject } = await api();
  const live = await inspectLiveFolder({ folder, initialize: true }, { coordinate });
  const args = { folder, videoPath: live.videos[0].path };
  const one = await openLiveProject({ ...args, requestId: 'choice-first-001' }, { coordinate });
  const two = await openLiveProject({ ...args, requestId: 'choice-second-002', createNew: true }, { coordinate });
  const choice = await openLiveProject({ ...args, requestId: 'choice-third-003' }, { coordinate });
  assert.equal(choice.status, 'choose-project'); assert.equal(choice.projects.length, 2);
  const selected = await openLiveProject({ ...args, requestId: 'choice-fourth-004', projectId: one.project.id }, { coordinate });
  assert.equal(selected.project.id, one.project.id); assert.notEqual(one.project.id, two.project.id);
  await assert.rejects(openLiveProject({ ...args, requestId: 'choice-fifth-005', projectId: 'unrelated' }, { coordinate }), /工程|匹配/);
});

test('same filename with replaced contents does not reopen the prior private project or reuse its identity', async () => {
  const { inspectLiveFolder, openLiveProject } = await api();
  const live = await inspectLiveFolder({ folder, initialize: true }, { coordinate });
  const args = { folder, videoPath: live.videos[0].path };
  await openLiveProject({ ...args, requestId: 'replace-first-001' }, { coordinate });
  const original = join(folder, '原视频.mp4'), before = await stat(original);
  await writeFile(original, 'different same size!'); await utimes(original, before.atime, before.mtime);
  await assert.rejects(openLiveProject({ ...args, requestId: 'replace-second-002' }, { coordinate }), /变化|替换|核对/);
});

test('moving the entire folder keeps its ID and resumes its matching local project', async () => {
  const { inspectLiveFolder, openLiveProject } = await api();
  const live = await inspectLiveFolder({ folder, initialize: true }, { coordinate });
  const one = await openLiveProject({ folder, videoPath: live.videos[0].path, requestId: 'move-first-001' }, { coordinate });
  const moved = join(scratch, 'moved-live'); await rename(folder, moved); folder = moved;
  const remapped = await inspectLiveFolder({ folder }, { coordinate });
  assert.equal(remapped.library.id, live.library.id);
  const two = await openLiveProject({ folder, videoPath: live.videos[0].path, requestId: 'move-second-002' }, { coordinate });
  assert.equal(two.project.id, one.project.id); assert.equal(two.reused, true);
});

test('another coordinator cannot silently attach to an established live folder', async () => {
  const { inspectLiveFolder } = await api();
  await inspectLiveFolder({ folder, initialize: true }, { coordinate }); useHome('b');
  await assert.rejects(inspectLiveFolder({ folder }, { coordinate: async () => ({ task: null, coordinationId: 'b'.repeat(64) }) }), /公司|服务|身份/);
  assert.equal(readPrefs().sharedMediaLibraries.length, 0);
});

test('daily libraries and result mappings retain more than 100 scenes', () => {
  const libraries = Array.from({ length: 125 }, (_, n) => ({ id: `daily-live-${n}`, name: `Live ${n}`, root: join(scratch, `live-${n}`) }));
  assert.equal(sharedMediaLibrariesOf(libraries).length, 125);
  writePrefs({ sharedMediaLibraries: libraries, sharedAnalysis: { enabled: true, resultRoots: libraries.map(l => ({ libraryId: l.id, root: join(l.root, '.daocut-shared'), coordinationId: companyId })) } });
  assert.equal(readPrefs().sharedAnalysis.resultRoots.length, 125);
  assert.equal(readPrefs().sharedAnalysis.resultRoots[124].coordinationId, companyId);
});

test('an empty folder cannot be initialized into an unused shared library', async () => {
  const { inspectLiveFolder } = await api(); const empty = join(scratch, 'empty'); await mkdir(empty);
  await assert.rejects(inspectLiveFolder({ folder: empty, initialize: true }, { coordinate }), /没有.*视频/);
  assert.equal(existsSync(join(empty, '.daocut-shared')), false);
});

test('orphaned shared results without a manifest cannot receive a fresh competing ID', async () => {
  const { inspectLiveFolder } = await api();
  await mkdir(join(folder, '.daocut-shared', 'results'), { recursive: true });
  await writeFile(join(folder, '.daocut-shared', 'results', 'saved.json'), '{"previous":"result"}');
  await assert.rejects(inspectLiveFolder({ folder, initialize: true }, { coordinate }), /已有|说明|编号/);
  assert.equal(existsSync(manifestPath()), false);
});

test('removing a managed manifest cannot downgrade it to a legacy library', async () => {
  const { inspectLiveFolder } = await api();
  const live = await inspectLiveFolder({ folder, initialize: true }, { coordinate });
  await rm(manifestPath());
  await assert.rejects(inspectLiveFolder({ folder }, { coordinate }), /说明|丢失|编号/);
  assert.equal(readPrefs().sharedMediaLibraries.find(l => l.id === live.library.id).id, live.library.id);
});

test('an unrelated broken project manifest does not block this scene or get rewritten', async () => {
  const { inspectLiveFolder, openLiveProject } = await api();
  const live = await inspectLiveFolder({ folder, initialize: true }, { coordinate });
  const first = await openLiveProject({ folder, videoPath: live.videos[0].path, requestId: 'broken-first-001' }, { coordinate });
  const other = join(scratch, 'a', 'projects', 'unrelated'); await mkdir(join(other, 'assets'), { recursive: true });
  await writeFile(join(other, 'film.html'), 'unrelated film');
  const broken = join(other, 'assets', '.daocut-source-media.json'); await writeFile(broken, '{');
  const statePath = join(process.env.DAOCUT_STUDIO_HOME, 'studio.json'); const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.recent.push({ id: 'unrelated-id', path: other, openedAt: 1 }); await writeFile(statePath, JSON.stringify(state));
  const second = await openLiveProject({ folder, videoPath: live.videos[0].path, requestId: 'broken-second-002' }, { coordinate });
  assert.equal(second.project.id, first.project.id); assert.equal(await readFile(broken, 'utf8'), '{');
});

test('a copied scene ID cannot replace an existing reachable mapping', async () => {
  const { inspectLiveFolder } = await api();
  const original = await inspectLiveFolder({ folder, initialize: true }, { coordinate });
  const copy = join(scratch, 'copy'); await mkdir(join(copy, '.daocut-shared'), { recursive: true });
  await writeFile(join(copy, '原视频.mp4'), 'synthetic bytes only');
  await writeFile(join(copy, '.daocut-shared', 'manifest.json'), await readFile(manifestPath()));
  await assert.rejects(inspectLiveFolder({ folder: copy }, { coordinate }), /编号|复制/);
  assert.equal(readPrefs().sharedMediaLibraries.find(l => l.id === original.library.id).root, original.library.root);
});

test('actual HTTP entry initializes only on request and continues one private project without model calls', async () => {
  let modelCalls = 0;
  const coordinator = async (action, body) => action === 'catalog' ? { results: [], coordinationId: companyId } : coordinate(action, body);
  const studio = await startStudio({ port: 0, openBrowser: () => {},
    sharedAnalysis: { coordinate: coordinator },
    liveAnalysis: { probeSource: async () => ({ durationMs: 3000 }), modelClient: async () => { modelCalls++; throw Error('No model allowed'); } },
  });
  try {
    const post = async (name, body) => {
      const response = await fetch(`${studio.origin}/api/shared-media/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-studio-key': studio.key }, body: JSON.stringify(body) });
      const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
    };
    const inspect = await post('live-folder', { folder }); assert.equal(inspect.status, 'needs-initialization');
    assert.equal(existsSync(manifestPath()), false);
    const ready = await post('live-folder', { folder, initialize: true }); assert.equal(ready.status, 'ready');
    const one = await post('live-project', { folder, videoPath: ready.videos[0].path, requestId: 'http-open-first' });
    const two = await post('live-project', { folder, videoPath: ready.videos[0].path, requestId: 'http-open-second' });
    assert.equal(one.status, 'opened'); assert.equal(two.project.id, one.project.id); assert.equal(two.reused, true);
    assert.equal(modelCalls, 0);
  } finally { await studio.close(); }
});
