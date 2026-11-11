import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { filmHtml } from '../../src/film-doc.mjs';
import { mediaContentHash, prepareMediaReferences } from '../../src/shared-media-reference.mjs';
import { readProjectFilm, editProjectFilm } from './film.mjs';
import { readable, inside } from './files.mjs';
import { sourceSubtitles, writeSourceSubtitles } from './subtitle-edits.mjs';
import { filmCaptions, readSubtitleStyle, writeSubtitleStyle } from './captions.mjs';
import { FILM_SUBTITLE_DEFAULT } from './film-subtitle.mjs';
import { patchProjectSettings, readProjectSettings } from './project-settings.mjs';
import { writeMarkers, readMarkers } from './markers.mjs';
import { resolveSharedMedia } from './shared-media.mjs';
import { assertExportSources } from './export-source-guard.mjs';
import { ensureStructureDraft, structureDraftContext, listStructureDrafts } from './structure-drafts.mjs';
import { createProjectBackup, inspectProjectBackup, restoreProjectBackup } from './project-backup.mjs';
import { openNewSharedProject } from './shared-project-open.mjs';

const workspace = resolve(import.meta.dirname, '../../../..');
async function fixture() {
  const base = join(workspace, '.tmp/structure-drafts'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'case-'));
  await mkdir(join(root, 'assets')); await mkdir(join(root, '.film'));
  await writeFile(join(root, '.film/id'), 'parent-project-1\n');
  await writeFile(join(root, 'assets/live.mp4'), 'isolated synthetic media bytes');
  await writeFile(join(root, 'assets/live.vtt'), 'WEBVTT\n\n00:00:01.000 --> 00:00:05.000\n原始完整钩子\n\n00:00:10.000 --> 00:00:20.000\n原始核心卖点\n\n00:00:25.000 --> 00:00:30.000\n原始完整逼单\n');
  await writeFile(join(root, 'film.html'), filmHtml({ stage: { w: 720, h: 1280 }, tracks: [{ clips: [{ id: 'parent-film', src: 'assets/live.mp4', time: [1, 3] }] }] }));
  await writeFile(join(root, '.film/product-analysis.json'), JSON.stringify({ version: 1, sources: [{ id: 's', assetPath: 'assets/live.mp4', durationMs: 60000 }], products: [{ id: 'p', name: '合成商品', sourceIds: ['s'] }], intervals: [{ id: 'i', productId: 'p', sourceId: 's', startMs: 0, endMs: 40000 }], candidates: [] }));
  await patchProjectSettings(root, { fps: 30 });
  await writeSubtitleStyle(root, { on: true });
  await writeMarkers(root, [{ id: 'parent-marker', t: 1, name: '父成片标记', color: '#123456' }]);
  const plan = id => ({ id, version: 'v1', scope: { sourceId: 's', productId: 'p', intervalId: 'i', startMs: 0, endMs: 40000 }, speed: 1, durationMs: 19000, clips: [
    { sourceId: 's', startMs: 1000, endMs: 5000, text: '原始完整钩子', roles: ['钩子'], coreIds: [] },
    { sourceId: 's', startMs: 10000, endMs: 20000, text: '原始核心卖点', roles: ['卖点'], coreIds: ['core1'] },
    { sourceId: 's', startMs: 25000, endMs: 30000, text: '原始完整逼单', roles: ['逼单'], coreIds: [] },
  ] });
  const make = id => ensureStructureDraft(root, { parentProjectId: 'parent-project-1', plan: plan(id) });
  return { root, make, plan };
}
const read = (root, path) => readFile(join(root, path), 'utf8');
test.beforeEach(t => { t.mock.method(globalThis, 'fetch', () => { throw new Error('No network or model calls are allowed in structure draft tests'); }); });

test('independent drafts preserve trim/order/subtitles/style/settings/markers across reopening and a new process', async () => {
  const f = await fixture();
  const protectedFiles = ['film.html', 'assets/live.mp4', 'assets/live.vtt', '.film/product-analysis.json', '.film/settings.json', '.film/subtitles.json', '.film/markers.json'];
  const before = await Promise.all(protectedFiles.map(path => read(f.root, path)));
  const a = await f.make('plan-a'), b = await f.make('plan-b');
  assert.notEqual(a.root, b.root); assert.notEqual(a.meta.draftId, b.meta.draftId);
  const bBefore = await Promise.all(['film.html', 'assets/live.vtt', '.film/settings.json', '.film/subtitles.json', '.film/markers.json'].map(path => read(b.root, path)));
  const value = await readProjectFilm(a.root), clips = value.value.tracks[0].clips;
  await editProjectFilm(a.root, value.rev, [{ op: 'set', clip: clips[0].id, field: 'time', value: [1.5, 4.5] }, { op: 'set', clip: clips[0].id, field: 'volume', value: 0.3 }, { op: 'stage', w: 1080, h: 1080 }, { op: 'move', clip: clips[1].id, at: 0, track: 0 }, { op: 'move', clip: clips[0].id, at: 10, track: 0 }]);
  const subtitles = await sourceSubtitles(a.root, 'assets/live.mp4');
  subtitles.cues[0] = { ...subtitles.cues[0], text: 'A 的字幕修正', startMs: 1200, endMs: 4500 };
  await writeSourceSubtitles(a.root, 'assets/live.mp4', subtitles.cues);
  await writeSubtitleStyle(a.root, { ...(await readSubtitleStyle(a.root)), on: false, pos: { x: 0.25, y: 0.75 } });
  await patchProjectSettings(a.root, { fps: 25 });
  await writeMarkers(a.root, [{ id: 'a-marker', t: 2, name: 'A 标记', color: '#654321' }]);
  assert.deepEqual(await f.make('plan-a'), a, 'opening an existing draft must not recreate it');
  assert.deepEqual(await Promise.all(protectedFiles.map(path => read(f.root, path))), before);
  assert.deepEqual(await Promise.all(['film.html', 'assets/live.vtt', '.film/settings.json', '.film/subtitles.json', '.film/markers.json'].map(path => read(b.root, path))), bBefore);
  const code = `import { structureDraftContext } from './studio/server/structure-drafts.mjs'; import { readProjectFilm } from './studio/server/film.mjs'; import { readProjectSettings } from './studio/server/project-settings.mjs'; import { sourceSubtitles } from './studio/server/subtitle-edits.mjs'; console.log(JSON.stringify({meta:await structureDraftContext(process.argv[1]),film:await readProjectFilm(process.argv[1]),settings:await readProjectSettings(process.argv[1]),subtitles:await sourceSubtitles(process.argv[1],'assets/live.mp4')}));`;
  const reopened = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code, a.root], { cwd: resolve(import.meta.dirname, '../..'), encoding: 'utf8', windowsHide: true }));
  assert.equal(reopened.meta.planId, 'plan-a'); assert.equal(reopened.settings.fps, 25);
  assert.equal(reopened.subtitles.cues[0].text, 'A 的字幕修正');
  assert.deepEqual(reopened.film.value, (await readProjectFilm(a.root)).value);
  assert.equal((await listStructureDrafts(f.root)).length, 2);
  assert.equal(await structureDraftContext(f.root), null);
});

test('draft media is a verified read-only parent reference, never a copy or a writable parent subtitle link', async () => {
  const f = await fixture(), a = await f.make('plan-a');
  await assert.rejects(stat(join(a.root, 'assets/live.mp4')), { code: 'ENOENT' });
  await prepareMediaReferences(a.root);
  assert.equal(readable(a.root, 'assets/live.mp4'), join(f.root, 'assets/live.mp4'));
  assert.equal((await resolveSharedMedia(a.root, 'assets/live.mp4')).path, join(f.root, 'assets/live.mp4'));
  assert.equal(inside(a.root, 'assets/live.vtt'), join(a.root, 'assets/live.vtt'));
  const check = await assertExportSources(a.root, { kind: 'video' }); await check();
  await writeFile(join(f.root, 'assets/live.mp4'), 'replaced source bytes');
  await assert.rejects(prepareMediaReferences(a.root), /changed|身份|原片/i);
  assert.equal(await read(a.root, 'assets/live.vtt'), await read(f.root, 'assets/live.vtt'));
});

test('parent identity, traversal and scope/speed mistakes are refused without rewriting existing drafts', async () => {
  const f = await fixture(), a = await f.make('plan-a');
  const before = await read(a.root, 'film.html');
  await assert.rejects(ensureStructureDraft(f.root, { parentProjectId: 'wrong-parent', plan: f.plan('plan-b') }));
  const fast = f.plan('fast'); fast.speed = 1.5; await assert.rejects(ensureStructureDraft(f.root, { parentProjectId: 'parent-project-1', plan: fast }));
  const outside = f.plan('outside'); outside.clips[0].endMs = 45000; await assert.rejects(ensureStructureDraft(f.root, { parentProjectId: 'parent-project-1', plan: outside }));
  const manifestPath = join(a.root, 'assets/.daocut-source-media.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.items['assets/live.mp4'].parentAssetPath = '../../outside.mp4';
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(prepareMediaReferences(a.root));
  assert.equal(await read(a.root, 'film.html'), before);
});

test('a parent reference cannot be redirected to another parent asset, even with identical bytes', async () => {
  const f = await fixture(), a = await f.make('plan-a');
  await writeFile(join(f.root, 'assets/other.mp4'), await read(f.root, 'assets/live.mp4'));
  const info = await stat(join(f.root, 'assets/other.mp4'));
  const path = join(a.root, 'assets/.daocut-source-media.json'), manifest = JSON.parse(await readFile(path, 'utf8'));
  Object.assign(manifest.items['assets/live.mp4'], { parentAssetPath: 'assets/other.mp4', mtimeMs: info.mtimeMs });
  await writeFile(path, JSON.stringify(manifest));
  await assert.rejects(prepareMediaReferences(a.root), /identity|身份/i);
});

test('a newer public plan version creates a separate draft and leaves the previous private film intact', async () => {
  const f = await fixture(), a = await f.make('plan-a'), before = await read(a.root, 'film.html');
  const plan = f.plan('plan-a'); plan.version = 'v2';
  const b = await ensureStructureDraft(f.root, { parentProjectId: 'parent-project-1', plan });
  assert.notEqual(a.root, b.root); assert.notEqual(await read(a.root, '.film/id'), await read(b.root, '.film/id'));
  assert.equal(await read(a.root, 'film.html'), before);
  assert.equal((await f.make('plan-a')).root, a.root);
});

test('v2 subranges create 1.3x private films with source-time subtitles and preserve old and edited drafts', async () => {
  const f = await fixture(), legacy = await f.make('plan-a');
  const protectedFiles = ['film.html', 'assets/live.mp4', 'assets/live.vtt', '.film/product-analysis.json', '.film/settings.json', '.film/subtitles.json'];
  const parentBefore = await Promise.all(protectedFiles.map(path => read(f.root, path)));
  const legacyBefore = await Promise.all(protectedFiles.map(path => read(legacy.root, path).catch(error => error.code)));
  const plan = { ...f.plan('plan-a'), version: 'ai-structure-plans-v2', speed: 1.3, durationMs: 11000 };
  const ranges = [[2400, 5000], [11000, 18800], [26000, 29900]];
  plan.clips = plan.clips.map((clip, index) => ({ ...clip, startMs: ranges[index][0], endMs: ranges[index][1], candidateId: `selected-${index}`, parentCandidateId: `mother-${index}`, cueRange: [index * 2, index * 2 + 1] }));
  const draft = await ensureStructureDraft(f.root, { parentProjectId: 'parent-project-1', plan });
  assert.notEqual(draft.root, legacy.root);
  const film = await readProjectFilm(draft.root), clips = film.value.tracks[0].clips;
  assert.deepEqual(clips.map(clip => clip.time), [[2.4, 5], [11, 18.8], [26, 29.9]]);
  assert.deepEqual(clips.map(clip => clip.speed), [1.3, 1.3, 1.3]);
  assert.deepEqual(clips.map(clip => clip.at ?? 0), [0, 2, 8]);
  assert.equal(draft.meta.durationMs, 11000);
  assert.deepEqual(draft.meta.plan.clips.map(clip => clip.parentCandidateId), ['mother-0', 'mother-1', 'mother-2']);
  assert.equal(await read(draft.root, 'assets/live.vtt'), await read(f.root, 'assets/live.vtt'), 'source subtitle timestamps must not be rewritten for speed');
  const captions = await filmCaptions(draft.root, { duration: async () => 60 });
  assert.deepEqual(clips.map(clip => {
    const cues = captions.cues.filter(cue => cue.clip === clip.id);
    return [Math.min(...cues.map(cue => cue.startMs)), Math.max(...cues.map(cue => cue.startMs + cue.durMs))];
  }), [[0, 2000], [2000, 8000], [8000, 11000]], 'caption splitting retains the speed-scaled bounds of each selected source range');
  const other = await ensureStructureDraft(f.root, { parentProjectId: 'parent-project-1', plan: { ...plan, id: 'plan-b' } });
  const otherBefore = await read(other.root, 'film.html');
  await editProjectFilm(draft.root, film.rev, [{ op: 'set', clip: clips[0].id, field: 'time', value: [2.4, 3.7] }, { op: 'set', clip: clips[0].id, field: 'speed', value: 1.5 }, { op: 'move', clip: clips[1].id, at: 4, track: 0 }]);
  await writeSubtitleStyle(draft.root, { on: false });
  await patchProjectSettings(draft.root, { fps: 25 });
  const saved = await read(draft.root, 'film.html');
  assert.equal((await ensureStructureDraft(f.root, { parentProjectId: 'parent-project-1', plan })).root, draft.root);
  const code = `import { readProjectFilm } from './studio/server/film.mjs'; import { readProjectSettings } from './studio/server/project-settings.mjs'; import { readSubtitleStyle } from './studio/server/captions.mjs'; console.log(JSON.stringify({film:await readProjectFilm(process.argv[1]),settings:await readProjectSettings(process.argv[1]),style:await readSubtitleStyle(process.argv[1])}));`;
  const reopened = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code, draft.root], { cwd: resolve(import.meta.dirname, '../..'), encoding: 'utf8', windowsHide: true }));
  assert.deepEqual(reopened.film.value, (await readProjectFilm(draft.root)).value);
  assert.equal(reopened.film.value.tracks[0].clips.find(clip => clip.id === clips[0].id).speed, 1.5);
  assert.equal(reopened.style.on, false); assert.equal(reopened.settings.fps, 25);
  assert.equal(await read(draft.root, 'film.html'), saved); assert.equal(await read(other.root, 'film.html'), otherBefore);
  assert.deepEqual(await Promise.all(protectedFiles.map(path => read(f.root, path))), parentBefore);
  assert.deepEqual(await Promise.all(protectedFiles.map(path => read(legacy.root, path).catch(error => error.code))), legacyBefore);
});

test('1.3x draft rejects source-length duration instead of creating a gapped film', async () => {
  const f = await fixture(), plan = { ...f.plan('bad-fast-duration'), version: 'ai-structure-plans-v2', speed: 1.3 };
  await assert.rejects(ensureStructureDraft(f.root, { parentProjectId: 'parent-project-1', plan }), /时长/);
  assert.equal((await listStructureDrafts(f.root)).length, 0);
});

test('draft creation does not impose a fixed clip-count limit on a valid current-lecture plan', async () => {
  const f = await fixture(), plan = f.plan('many-clips');
  plan.clips = Array.from({ length: 101 }, (_, index) => ({ sourceId: 's', startMs: index * 100, endMs: (index + 1) * 100, text: `合成完整原话 ${index + 1}`, roles: ['卖点'], coreIds: ['core1'] }));
  plan.durationMs = 10100;
  const draft = await ensureStructureDraft(f.root, { parentProjectId: 'parent-project-1', plan });
  assert.equal((await readProjectFilm(draft.root)).value.tracks[0].clips.length, 101);
});

test('drafts snapshot an explicit subtitle style even when the parent has never saved one', async () => {
  const f = await fixture(); await unlink(join(f.root, '.film/subtitles.json'));
  const a = await f.make('plan-a'), b = await f.make('plan-b');
  assert.deepEqual(await readSubtitleStyle(a.root), FILM_SUBTITLE_DEFAULT);
  assert.deepEqual(await readSubtitleStyle(b.root), FILM_SUBTITLE_DEFAULT);
  await writeSubtitleStyle(a.root, { ...FILM_SUBTITLE_DEFAULT, on: false });
  assert.deepEqual(await readSubtitleStyle(b.root), FILM_SUBTITLE_DEFAULT);
  await assert.rejects(stat(join(f.root, '.film/subtitles.json')), { code: 'ENOENT' });
});

test('shared logical footage reuses its existing isolated mapping without registering a library or copying media', async t => {
  const f = await fixture(), home = join(f.root, 'isolated-studio'), library = join(f.root, 'fake-library');
  const previous = process.env.DAOCUT_STUDIO_HOME; process.env.DAOCUT_STUDIO_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.DAOCUT_STUDIO_HOME; else process.env.DAOCUT_STUDIO_HOME = previous; });
  await mkdir(home); await mkdir(library); await rename(join(f.root, 'assets/live.mp4'), join(library, 'live.mp4'));
  const info = await stat(join(library, 'live.mp4'));
  const prefs = JSON.stringify({ sharedMediaLibraries: [{ id: 'isolated-library', name: '合成素材库', root: library }] });
  await writeFile(join(home, 'prefs.json'), prefs);
  await writeFile(join(f.root, 'assets/.daocut-source-media.json'), JSON.stringify({ version: 1, items: { 'assets/live.mp4': { libraryId: 'isolated-library', libraryName: '合成素材库', relativePath: 'live.mp4', mode: 'reference', size: info.size, mtimeMs: info.mtimeMs, sha256: await mediaContentHash(join(library, 'live.mp4')) } } }));
  const a = await f.make('shared-plan'); await prepareMediaReferences(a.root);
  assert.equal((await resolveSharedMedia(a.root, 'assets/live.mp4')).path, join(library, 'live.mp4'));
  await assert.rejects(stat(join(a.root, 'assets/live.mp4')), { code: 'ENOENT' });
  assert.equal(await readFile(join(home, 'prefs.json'), 'utf8'), prefs);
  const check = await assertExportSources(a.root, { kind: 'video' }); await check();
});

test('a private structure draft arriving during shared reading prevents automatic import', async () => {
  const f = await fixture(), seed = JSON.parse(await read(f.root, '.film/product-analysis.json'));
  seed.intervals = []; seed.products = []; await writeFile(join(f.root, '.film/product-analysis.json'), JSON.stringify(seed));
  const imports = [];
  const result = await openNewSharedProject(f.root, { assetPath: 'assets/live.mp4', sourceId: 's', expectedAnalysis: seed }, {
    registerSource: async () => ({ analysis: seed }),
    publication: { catalog: async () => {
      const dir = join(f.root, '.film/structure-drafts', 'a'.repeat(24)); await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'film.html'), 'private edit created during reading');
      return { results: [{ action: 'transcription', taskKey: 'fake', resultSha: 'fake', scope: null }] };
    }, importResult: async () => { imports.push('imported'); return {}; } }, discovery: {},
  });
  assert.equal(result.status, 'review-required'); assert.deepEqual(imports, []);
});

test('complete parent backup restores independent drafts and parent references without draft caches', async () => {
  const f = await fixture(), a = await f.make('plan-a');
  const captions = await sourceSubtitles(a.root, 'assets/live.mp4'); captions.cues[0].text = '备份中的私人字幕';
  await writeSourceSubtitles(a.root, 'assets/live.mp4', captions.cues);
  // Registration may assign a different project id after a folder is copied; do not derive it from draftId.
  await writeFile(join(a.root, '.film/id'), 'registered-draft-original-id\n');
  await writeFile(join(f.root, '.film/structure-workspace.json'), JSON.stringify({ version: 1, activeProjectId: 'registered-draft-original-id' }));
  await mkdir(join(a.root, '.film/cache'), { recursive: true }); await writeFile(join(a.root, '.film/cache/not-work.bin'), 'cache');
  const backup = `${f.root}-backup`, target = `${f.root}-restore`;
  await createProjectBackup(f.root, backup);
  assert.equal(await read(backup, `.film/structure-drafts/${a.meta.draftId}/assets/live.vtt`), await read(a.root, 'assets/live.vtt'));
  await assert.rejects(stat(join(backup, `.film/structure-drafts/${a.meta.draftId}/.film/cache/not-work.bin`)), { code: 'ENOENT' });
  const info = await inspectProjectBackup(backup);
  await restoreProjectBackup({ backupPath: backup, targetPath: target, expectedBackupId: info.backupId, confirmed: true });
  const restored = await listStructureDrafts(target); assert.equal(restored.length, 1);
  const selection = JSON.parse(await read(target, '.film/structure-workspace.json'));
  assert.equal(selection.activeProjectId, (await read(restored[0].root, '.film/id')).trim());
  assert.notEqual(selection.activeProjectId, 'registered-draft-original-id');
  await prepareMediaReferences(restored[0].root);
  assert.equal(readable(restored[0].root, 'assets/live.mp4'), join(target, 'assets/live.mp4'));
  assert.equal((await sourceSubtitles(restored[0].root, 'assets/live.mp4')).cues[0].text, '备份中的私人字幕');
  const parentProjectId = (await read(target, '.film/id')).trim();
  assert.equal((await ensureStructureDraft(target, { parentProjectId, plan: f.plan('plan-a') })).root, restored[0].root);
});
