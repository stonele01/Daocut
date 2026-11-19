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
import { createStructureBatchExports } from './structure-batch-exports.mjs';
import { materializeCombinedExport } from './structure-export-combined.mjs';
import { probeSource } from './nle.mjs';

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

test('combined selected plans make one editable Jianying draft in plan order, with private captions, speed and restart receipts', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  t.mock.method(globalThis, 'fetch', () => { throw Error('No paid services or external network'); });
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=96x96:r=30:d=5', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(f.root, 'assets/live.mp4')], { windowsHide: true });
  await mkdir(join(f.root, '.film'));
  await writeFile(join(f.root, '.film/id'), f.project.id);
  const scope = { sourceId: 'source', productId: 'product', intervalId: 'lecture', startMs: 0, endMs: 5000 };
  const analysis = { version: 1, sources: [{ id: 'source', assetPath: 'assets/live.mp4', durationMs: 5000 }], products: [{ id: 'product', name: '商品' }], candidates: [],
    intervals: [{ id: 'lecture', ...scope, confirmed: true }] };
  await writeFile(join(f.root, '.film/product-analysis.json'), JSON.stringify(analysis));
  const original = filmHtml({ stage: { w: 96, h: 96 }, tracks: [{ clips: [{ id: 'original', src: 'assets/live.mp4', time: [0, 5] }] }] });
  await writeFile(join(f.root, 'film.html'), original);
  await writeFile(join(f.root, 'assets/live.vtt'), 'WEBVTT\n\n00:00:00.000 --> 00:00:01.300\n公共第一条\n\n00:00:02.600 --> 00:00:03.900\n公共第二条\n');
  const plans = [0, 1, 2].map(i => ({ id: `plan-${i + 1}`, version: 'v8', scope, speed: 1.3, durationMs: 1000,
    clips: [{ sourceId: 'source', startMs: i === 0 ? 0 : 2600, endMs: i === 0 ? 1300 : 3900, text: `公共${i}`, roles: ['hook'], coreIds: [] }] }));
  const privateDraft = await ensureStructureDraft(f.root, { parentProjectId: f.project.id, plan: plans[1] });
  const edited = filmHtml({ stage: { w: 96, h: 96 }, tracks: [{ clips: [{ id: 'personal', src: 'assets/live.mp4', at: 0, time: [2.6, 3.6], speed: 2, volume: 0.5 }] }] });
  await writeFile(join(privateDraft.root, 'film.html'), edited);
  await writeFile(join(privateDraft.root, 'assets/live.vtt'), 'WEBVTT\n\n00:00:02.600 --> 00:00:03.600\n个人第二条\n');
  const taskKey = 'saved-task', state = { status: 'complete', taskKey, context: { ...scope, visibility: 'local' }, plans };
  const queue = createExports({ drafts: () => { throw Error('Only the explicit export destination'); } });
  const options = { plans: { status: async () => state }, exports: queue, outputRoot: f.folder, pollMs: 5 };
  const batches = createStructureBatchExports(options);
  t.after(async () => { await batches.stop(); await queue.stopAll(); });
  const request = { ...scope, taskKey, requestId: 'combined-test-001', name: '组合测试', mode: 'combined', planIds: ['plan-2', 'plan-1'] };
  const batch = await batches.create(f.project, request);
  assert.equal(batch.total, 1); assert.equal(batch.planCount, 2); assert.equal(batch.items[0].origin, 'mixed');
  const done = await batches.wait(f.project, batch.id);
  assert.equal(done.status, 'complete', done.items[0].error);
  const jobs = queue.list(f.project.id); assert.equal(jobs.length, 1);
  const root = dirname(done.items[0].outputs[0]);
  const draft = JSON.parse(await readFile(join(root, 'draft_content.json'), 'utf8'));
  const clips = draft.tracks.filter(track => track.type === 'video').flatMap(track => track.segments);
  assert.deepEqual(clips.map(c => c.speed), [1.3, 2]);
  assert.deepEqual(clips.map(c => c.source_timerange.start), [0, 0]);
  assert.deepEqual(clips.map(c => c.target_timerange), [{ start: 0, duration: 1000000 }, { start: 2000000, duration: 500000 }]);
  assert.equal(draft.duration, 2500000);
  assert.deepEqual(draft.materials.texts.map(c => JSON.parse(c.content).text), ['公共第一条', '个人第二条']);
  const captions = draft.tracks.filter(track => track.type === 'text').flatMap(track => track.segments);
  assert.deepEqual(captions.map(c => c.target_timerange), [{ start: 0, duration: 1000000 }, { start: 2000000, duration: 500000 }]);
  assert.equal((await readdir(join(batch.storageFolder, '_media'))).filter(name => name.endsWith('.mp4')).length, 2);
  const ledger = JSON.parse(await readFile(join(f.root, '.film/structure-export-batches', `${batch.id}.json`), 'utf8'));
  const recovered = await materializeCombinedExport(ledger.items[0].snapshot, { materialize: materializeStructureExport, mediaRoot: join(batch.storageFolder, '_media'), mediaCache: new Map() });
  assert.deepEqual(recovered.cues.map(cue => cue.text), ['公共第一条', '个人第二条']);
  assert.equal(await readFile(join(f.root, 'film.html'), 'utf8'), original);
  assert.equal(await readFile(join(privateDraft.root, 'film.html'), 'utf8'), edited);
  assert.equal(await readFile(join(f.root, '.film/product-analysis.json'), 'utf8'), JSON.stringify(analysis));
  assert.equal((await batches.create(f.project, request)).id, batch.id);
  await assert.rejects(batches.create(f.project, { ...request, mode: 'separate' }), /同一次导出请求/);
  await batches.stop();
  const restored = createStructureBatchExports({ ...options, exports: { ...queue, list: () => [] } });
  t.after(() => restored.stop());
  assert.equal((await restored.retry(f.project, batch.id)).completed, 1);
  assert.equal(queue.list(f.project.id).length, 1, 'completed combined draft is never duplicated');
  // Explicit separate mode remains two ordinary drafts from the same selection.
  const normal = createStructureBatchExports(options); t.after(() => normal.stop());
  const separate = await normal.create(f.project, { ...request, requestId: 'separate-test-002', mode: 'separate' });
  const splitDone = await normal.wait(f.project, separate.id);
  assert.equal(splitDone.total, 2); assert.equal(splitDone.completed, 2, JSON.stringify(splitDone.items));
});

test('12 saved plans cut between transport-stream keyframes export one draft with both tracks and 11 gaps', { timeout: 90000 }, async t => {
  const f = await fixture(t), assetPath = 'assets/stream.mp4';
  // Livestream captures can have an MP4 extension and an MPEG-TS container with long GOPs.
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=96x96:r=30:d=42', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=42',
    '-c:v', 'libx264', '-g', '240', '-keyint_min', '240', '-sc_threshold', '0', '-c:a', 'aac', '-f', 'mpegts', join(f.root, assetPath)], { windowsHide: true });
  const scope = { sourceId: 's', productId: 'p', intervalId: 'lecture', startMs: 0, endMs: 42000 };
  await mkdir(join(f.root, '.film'));
  await writeFile(join(f.root, '.film/id'), f.project.id);
  await writeFile(join(f.root, '.film/product-analysis.json'), JSON.stringify({ version: 1, sources: [{ id: 's', assetPath, durationMs: 42000 }],
    products: [{ id: 'p', name: '合并验收' }], intervals: [{ ...scope, id: 'lecture' }], candidates: [] }));
  await writeFile(join(f.root, 'film.html'), filmHtml({ stage: { w: 96, h: 96 }, tracks: [] }));
  const plans = Array.from({ length: 12 }, (_, i) => {
    const startMs = 5300 + 3000 * i;
    return { id: `plan-${i + 1}`, version: 'v8', scope, speed: 1, durationMs: 1000,
      clips: [{ sourceId: 's', startMs, endMs: startMs + 1000, text: `片段 ${i + 1}`, roles: ['hook'], coreIds: [] }] };
  });
  const taskKey = 'transport-12', queue = createExports({ drafts: () => { throw Error('Only use the test folder'); } });
  const batches = createStructureBatchExports({ plans: { status: async () => ({ status: 'complete', context: { ...scope, visibility: 'local' }, taskKey, plans }) }, exports: queue, outputRoot: f.folder, pollMs: 5 });
  t.after(async () => { await batches.stop(); await queue.stopAll(); });
  const batch = await batches.create(f.project, { ...scope, taskKey, mode: 'combined', requestId: 'transport-12-plans', planIds: plans.map(p => p.id) });
  const done = await batches.wait(f.project, batch.id);
  assert.equal(done.status, 'complete', done.items[0].error);
  assert.equal(done.items.length, 1);
  const draft = JSON.parse(await readFile(join(dirname(done.items[0].outputs[0]), 'draft_content.json'), 'utf8'));
  const clips = draft.tracks.filter(t => t.type === 'video').flatMap(t => t.segments);
  assert.deepEqual(clips.map(c => c.target_timerange), plans.map((_, i) => ({ start: i * 2000000, duration: 1000000 })));
  assert.equal(draft.duration, 23000000);
  const media = join(batch.storageFolder, '_media');
  const files = (await readdir(media)).filter(n => n.endsWith('.mp4'));
  assert.equal(files.length, 12);
  for (const file of files) {
    const facts = await probeSource(join(media, file), true);
    assert.deepEqual(facts.trackTimes.map(t => t.kind), ['video', 'audio']);
    for (const track of facts.trackTimes) {
      assert.ok(Math.abs(track.start) < 0.08);
      assert.ok(Math.abs(track.start + track.duration - 1) < 0.08);
    }
  }
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
    const prepared = await materializeStructureExport(snapshot, { mediaRoot: join(f.folder, '_media'), mediaCache });
    const job = queue.startSnapshot({ ...f.project, path: prepared.exportRoot, name: privateEdit ? 'Private' : 'Public' }, { kind: 'nle', format: 'jianying', media: 'link', subtitles: true, fps: 30, folder: join(f.folder, 'drafts') });
    let current;
    do { await new Promise(r => setTimeout(r, 25)); current = queue.list(f.project.id).find(item => item.id === job.id); } while (['running', 'waiting'].includes(current.status));
    assert.equal(current.status, 'done', current.error);
    const draft = JSON.parse(await readFile(join(dirname(current.outputs[0]), 'draft_content.json'), 'utf8'));
    const clips = draft.tracks.filter(track => track.type === 'video').flatMap(track => track.segments);
    assert.deepEqual(clips.map(clip => clip.speed), privateEdit ? [2] : [1.3, 1.3]);
    assert.deepEqual(clips.map(clip => clip.source_timerange.start), privateEdit ? [0] : [0, 0]);
    assert.deepEqual(clips.map(clip => clip.target_timerange.duration), privateEdit ? [500000] : [1000000, 1000000]);
    const text = draft.materials.texts.map(item => JSON.parse(item.content).text);
    assert.deepEqual(text, privateEdit ? ['个人字幕'] : ['原开头', '原卖点']);
    if (edited) assert.equal(await readFile(join(snapshot.root, 'film.html'), 'utf8'), edited);
  }
  assert.equal((await readdir(join(f.folder, '_media'))).filter(name => name.endsWith('.mp4')).length, 3);
  assert.equal(await readFile(join(f.root, 'film.html'), 'utf8'), parentFilm);
  assert.equal(await readFile(join(f.root, '.film/product-analysis.json'), 'utf8'), JSON.stringify(analysis));
});
