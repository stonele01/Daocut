import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, sep } from 'node:path';
import { createExports } from './exports.mjs';
import { filmHtml } from '../../src/film-doc.mjs';
import { captureStructureExport, materializeStructureExport } from './structure-export-snapshot.mjs';
import { ensureStructureDraft } from './structure-drafts.mjs';

const base = fileURLToPath(new URL('../../../../.tmp/batch-export-tests/', import.meta.url));
async function fixture(t) {
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, 'snapshot-'));
  const root = join(dir, 'snapshot'), folder = join(dir, 'batch');
  await mkdir(join(root, 'assets'), { recursive: true });
  const queue = createExports({ drafts: () => { throw Error('Must not consult the installed Jianying folder'); }, captions: async () => ({ cues: [], style: {} }) });
  t.after(async () => { await queue.stopAll(); assert.ok(resolve(dir).startsWith(resolve(base) + sep)); await rm(dir, { recursive: true, force: true }); });
  return { root, folder, queue, project: { id: 'isolated-batch', name: '方案 001', path: root } };
}

test('frozen export entry only accepts an explicit Jianying link export destination', async t => {
  const f = await fixture(t);
  assert.equal(typeof f.queue.startSnapshot, 'function');
  for (const ask of [{ kind: 'video' }, { kind: 'nle', format: 'jianying', media: 'copy', folder: f.folder }, { kind: 'nle', format: 'jianying', media: 'link' }]) {
    assert.throws(() => f.queue.startSnapshot(f.project, ask));
  }
  assert.equal(f.queue.list(f.project.id).length, 0);
});

test('frozen Jianying export uses its batch folder and references one snapshot source', { timeout: 60000 }, async t => {
  const f = await fixture(t), source = join(f.root, 'assets/live.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=96x96:r=10', '-t', '0.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source], { windowsHide: true });
  const text = filmHtml({ stage: { w: 96, h: 96 }, tracks: [{ clips: [{ id: 'frozen-clip', src: 'assets/live.mp4', at: 0, time: [0, 0.4] }] }] });
  await writeFile(join(f.root, 'film.html'), text);
  const receipt = { batchId: 'a'.repeat(24), itemId: '001', revision: 'b'.repeat(64) };
  const job = f.queue.startSnapshot(f.project, { kind: 'nle', format: 'jianying', media: 'link', subtitles: false, folder: f.folder, receipt });
  let current;
  do { await new Promise(r => setTimeout(r, 50)); current = f.queue.list(f.project.id).find(item => item.id === job.id); } while (['running', 'waiting'].includes(current.status));
  assert.equal(current.status, 'done', current.error);
  assert.ok(resolve(current.outputs[0]).startsWith(resolve(f.folder) + sep));
  const draftRoot = dirname(current.outputs[0]);
  const savedReceipt = JSON.parse(await readFile(join(draftRoot, '.daocut-structure-export.json'), 'utf8'));
  assert.deepEqual({ batchId: savedReceipt.batchId, itemId: savedReceipt.itemId, revision: savedReceipt.revision }, receipt);
  for (const name of ['draft_info.json', 'draft_content.json', 'draft_meta_info.json']) assert.equal(savedReceipt.files[name], createHash('sha256').update(await readFile(join(draftRoot, name))).digest('hex'));
  assert.ok(current.outputs.every(path => !path.endsWith('.daocut-structure-export.json')), 'internal receipt must not appear as an exported user file');
  const draft = JSON.parse(await readFile(join(draftRoot, 'draft_content.json'), 'utf8'));
  assert.equal(draft.materials.videos.length, 1);
  assert.equal(resolve(draft.materials.videos[0].path), resolve(source));
  const media = await readdir(join(draftRoot, 'media')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  assert.equal(media.filter(name => name.endsWith('.mp4')).length, 0);
  assert.equal(await readFile(join(f.root, 'film.html'), 'utf8'), text);
});

test('shared historical public plans and private edits export real Jianying drafts with original ranges, speed and subtitles', { timeout: 60000 }, async t => {
  const f = await fixture(t), source = join(f.root, 'assets/live.mp4');
  t.mock.method(globalThis, 'fetch', () => { throw Error('No model or external network'); });
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=96x96:r=30:d=5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source], { windowsHide: true });
  await mkdir(join(f.root, '.film'));
  await writeFile(join(f.root, '.film/id'), f.project.id);
  const scope = { sourceId: 'source', productId: 'original-product', intervalId: 'historical-lecture', startMs: 0, endMs: 5000 };
  const analysis = { version: 1, sources: [{ id: 'source', assetPath: 'assets/live.mp4', durationMs: 5000 }], products: [], candidates: [],
    intervals: [{ id: 'display-lecture', sourceId: 'source', productId: 'display-product', startMs: 0, endMs: 5000, savedResultScopeId: scope.intervalId }],
    scopes: [{ id: scope.intervalId, sourceId: scope.sourceId, productId: scope.productId, startMs: 0, endMs: 5000, kind: 'historical-analysis', confirmed: true }] };
  const plan = { id: 'saved-public', version: 'v8', scope, speed: 1.3, durationMs: 2000, clips: [
    { sourceId: 'source', startMs: 0, endMs: 1300, text: '原开头', roles: ['hook'], coreIds: [] },
    { sourceId: 'source', startMs: 2600, endMs: 3900, text: '原卖点', roles: ['core'], coreIds: ['core'] },
  ] };
  const parentFilm = filmHtml({ stage: { w: 96, h: 96 }, tracks: [{ clips: [{ id: 'parent', src: 'assets/live.mp4', time: [4, 5] }] }] });
  await writeFile(join(f.root, 'film.html'), parentFilm);
  await writeFile(join(f.root, '.film/product-analysis.json'), JSON.stringify(analysis));
  await writeFile(join(f.root, 'assets/live.vtt'), 'WEBVTT\n\n00:00:00.000 --> 00:00:01.300\n原开头\n\n00:00:02.600 --> 00:00:03.900\n原卖点\n');
  const queue = createExports({ drafts: () => { throw Error('Do not use installed draft library'); } });
  t.after(() => queue.stopAll());
  const mediaCache = new Map();
  for (const privateEdit of [false, true]) {
    let edited;
    if (privateEdit) {
      const draft = await ensureStructureDraft(f.root, { parentProjectId: f.project.id, plan });
      edited = filmHtml({ stage: { w: 96, h: 96 }, tracks: [{ clips: [{ id: 'personal', src: 'assets/live.mp4', at: 0, time: [2.6, 3.6], speed: 2 }] }] });
      await writeFile(join(draft.root, 'film.html'), edited);
      await writeFile(join(draft.root, 'assets/live.vtt'), 'WEBVTT\n\n00:00:02.600 --> 00:00:03.600\n个人字幕\n');
    }
    const snapshot = await captureStructureExport(f.project, { plan, itemRoot: join(f.folder, privateEdit ? 'private-snapshot' : 'public-snapshot') });
    assert.equal(snapshot.origin, privateEdit ? 'private' : 'public');
    await materializeStructureExport(snapshot, { mediaRoot: join(f.folder, '_media'), mediaCache });
    const job = queue.startSnapshot({ ...f.project, path: snapshot.root, name: privateEdit ? 'Private' : 'Public' }, { kind: 'nle', format: 'jianying', media: 'link', subtitles: true, fps: 30, folder: join(f.folder, 'drafts') });
    let current;
    do { await new Promise(r => setTimeout(r, 25)); current = queue.list(f.project.id).find(item => item.id === job.id); } while (['running', 'waiting'].includes(current.status));
    assert.equal(current.status, 'done', current.error);
    const draft = JSON.parse(await readFile(join(dirname(current.outputs[0]), 'draft_content.json'), 'utf8'));
    const clips = draft.tracks.filter(track => track.type === 'video').flatMap(track => track.segments);
    assert.deepEqual(clips.map(clip => clip.speed), privateEdit ? [2] : [1.3, 1.3]);
    assert.deepEqual(clips.map(clip => clip.source_timerange.start), privateEdit ? [2600000] : [0, 2600000]);
    assert.deepEqual(clips.map(clip => clip.target_timerange.duration), privateEdit ? [500000] : [1000000, 1000000]);
    const text = draft.materials.texts.map(item => JSON.parse(item.content).text);
    assert.deepEqual(text, privateEdit ? ['个人字幕'] : ['原开头', '原卖点']);
    if (edited) assert.equal(await readFile(join(snapshot.root, 'film.html'), 'utf8'), edited);
  }
  assert.equal((await readdir(join(f.folder, '_media'))).length, 1);
  assert.equal(await readFile(join(f.root, 'film.html'), 'utf8'), parentFilm);
  assert.equal(await readFile(join(f.root, '.film/product-analysis.json'), 'utf8'), JSON.stringify(analysis));
});
