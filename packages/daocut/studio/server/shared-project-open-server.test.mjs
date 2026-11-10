import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { startStudio } from './server.mjs';
import { createSharedAnalysis } from './shared-analysis.mjs';
import { readExistingTranscriptArtifact } from './existing-transcript-artifact.mjs';
import { transcriptionLocation } from './product-transcription.mjs';
import { readTranscriptReview } from './transcript-review.mjs';
import { readFilmFile } from '../../src/film-doc.mjs';

test('creation API opens original ASR, AI products and all 40 historical candidates without models or shared writes', async t => {
  const base = resolve(import.meta.dirname, '../../../../.tmp/shared-open-20261106'); await mkdir(base, { recursive: true });
  const scratch = await mkdtemp(join(base, 'server-')); t.after(() => rm(scratch, { recursive: true, force: true }));
  const keys = ['DAOCUT_STUDIO_HOME', 'DAOCUT_LIBRARY'], old = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  process.env.DAOCUT_STUDIO_HOME = join(scratch, 'home'); process.env.DAOCUT_LIBRARY = join(scratch, 'projects');
  t.after(() => { for (const key of keys) old[key] === undefined ? delete process.env[key] : process.env[key] = old[key]; });
  const assetPath = 'assets/live.mp4', durationMs = 1404879, libraryId = 'shared-open-integration';
  const sourceRoot = join(scratch, 'source'), donor = join(scratch, 'donor');
  for (const root of [sourceRoot, join(donor, 'assets')]) await mkdir(root, { recursive: true });
  await writeFile(join(sourceRoot, 'live.mp4'), 'same isolated source'); await writeFile(join(donor, assetPath), 'same isolated source');
  const source = { id: 'original', assetPath, durationMs }, tasks = new Map(), ops = []; let serial = 0, requests = 0;
  const coordinate = async (op, body) => {
    ops.push(op); const task = tasks.get(body.taskKey);
    if (op === 'catalog') return { results: [...tasks.values()].filter(v => v.status === 'complete' && v.catalog.sourceIdentity === body.sourceIdentity), coordinationId: 'isolated' };
    if (op === 'status') return { task: task ?? null, coordinationId: 'isolated' };
    if (op === 'claim') { if (task) return { acquired: false, task }; const value = { taskKey: body.taskKey, inputHash: body.inputHash, catalog: body.catalog, attemptId: `a${++serial}`, status: 'claimed' }; tasks.set(body.taskKey, value); return { acquired: true, task: value, coordinationId: 'isolated' }; }
    assert.equal(task.attemptId, body.attemptId);
    if (op === 'submitted') { task.status = 'submitted'; return { task, sendAllowed: true }; }
    if (op === 'complete') { task.status = 'complete'; task.result = body.result; return { task }; }
    throw Error(`Unexpected ${op}`);
  };
  const sharedOptions = { coordinate, settings: () => ({ enabled: true, resultRoots: [{ libraryId, root: join(scratch, 'results') }] }), readManifest: async () => ({ items: { [assetPath]: { libraryId, relativePath: 'live.mp4' } } }) };
  const store = createSharedAnalysis(sharedOptions);
  const raw = await transcriptionLocation(donor, source); await mkdir(raw.dir, { recursive: true });
  const segments = [
    { id: 'a', startMs: 0, endMs: 700500, coreStartMs: 0, coreEndMs: 700000, cues: [{ text: '前文', startMs: 120, endMs: 1000 }, { text: '接缝第一种', startMs: 699800, endMs: 700300 }] },
    { id: 'b', startMs: 699500, endMs: durationMs, coreStartMs: 700000, coreEndMs: durationMs, cues: [{ text: '接缝另一种', startMs: 300, endMs: 800 }, { text: '后文', startMs: 2000, endMs: 3000 }] },
  ].map(s => ({ ...s, status: 'complete', words: [] }));
  await writeFile(raw.path, JSON.stringify({ version: 1, status: 'complete', sourceId: source.id, assetPath, durationMs, fingerprint: raw.fingerprint, cues: [{ text: '原话', startMs: 120, endMs: 1000 }], words: [], segmented: true }));
  await writeFile(raw.path + '.segments.json', JSON.stringify({ version: 1, sourceId: source.id, durationMs, identity: 'original', segments }));
  const asr = await readExistingTranscriptArtifact(donor, source);
  const proposal = { version: 1, sourceId: source.id, products: [{ id: 'shampoo', name: '洗发水', sourceIds: [source.id] }, { id: 'other', name: '另一商品', sourceIds: [source.id] }], intervals: [{ id: 'i1', productId: 'shampoo', sourceId: source.id, startMs: 107450, endMs: 466400 }, { id: 'i2', productId: 'other', sourceId: source.id, startMs: 466400, endMs: durationMs }], unassigned: [] };
  const candidates = Array.from({ length: 40 }, (_, i) => ({ startMs: i < 8 ? 120 + i * 13000 : 107450 + (i - 8) * 10000, endMs: (i < 8 ? 120 + i * 13000 : 107450 + (i - 8) * 10000) + 700, text: `原始话术${i}`, tags: ['卖点'], cueRange: [i, i] }));
  for (const artifact of [
    { action: 'transcription', count: 4, payload: asr.payload },
    { action: 'discovery', count: 2, payload: { version: 1, kind: 'historical-ai-discovery', proposal } },
    { action: 'analysis', count: 40, scope: { startMs: 120, endMs: 466400 }, payload: { version: 1, kind: 'historical-ai-structure', scope: { startMs: 120, endMs: 466400 }, candidates } },
  ]) { const descriptor = await store.prepareExisting(donor, source, artifact), claim = await store.acquire(descriptor); await store.complete(donor, descriptor, claim.attemptId, artifact.payload); }
  const resultFiles = [...tasks.values()].map(v => join(scratch, 'results', v.result.path));
  const sharedBefore = await Promise.all(resultFiles.map(async file => ({ file, bytes: await readFile(file, 'utf8'), mtime: (await stat(file)).mtimeMs })));
  ops.length = 0;
  const forbidden = async () => { requests++; throw Error('MODEL FORBIDDEN'); }, probeSource = async () => ({ duration: durationMs / 1000 });
  const studio = await startStudio({ port: 0, openBrowser() {}, sharedAnalysis: sharedOptions, liveAnalysis: { probeSource, modelClient: forbidden, transcriber: forbidden }, productDiscovery: { probeSource, modelClient: forbidden } });
  t.after(() => studio.close());
  const api = async (path, method = 'GET', body) => { const response = await fetch(`${studio.origin}/api/${path}`, { method, headers: { 'x-studio-key': studio.key, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value; };
  await api('shared-media/libraries', 'POST', { id: libraryId, name: 'isolated', root: sourceRoot });
  const input = { libraryId, videoPath: 'live.mp4', requestId: `open-${Date.now()}` };
  const [created, duplicate] = await Promise.all([api('shared-media/projects', 'POST', input), api('shared-media/projects', 'POST', input)]);
  assert.equal(created.project.id, duplicate.project.id); assert.equal(created.sharedRead.imported.analysis, 40); assert.equal(created.sharedRead.imported.discovery, 2); assert.equal(created.sharedRead.imported.transcription, 4);
  const project = created.project, data = (await api(`projects/${project.id}/product-analysis`)).analysis, localSource = data.sources[0];
  assert.equal(localSource.durationMs, durationMs); assert.equal(data.intervals.length, 2); assert.equal(data.intervals[0].startMs, 107450);
  assert.equal(data.candidates.length, 40); assert.equal(data.candidates.filter(c => c.startMs < 107450).length, 8);
  assert.equal(data.scopes.length, 1); assert.deepEqual([data.scopes[0].startMs, data.scopes[0].endMs], [120, 466400]);
  assert.equal(data.products.find(p => p.id === data.scopes[0].productId).name, '已有话术（商品待核对）');
  assert.equal((await readTranscriptReview(project.path, localSource.id)).pendingCount, 1);
  const live = await api(`projects/${project.id}/live-analysis?sourceId=${localSource.id}&intervalId=${data.scopes[0].id}&productId=${data.scopes[0].productId}`);
  assert.equal(live.analysis.historicalEditable, true); assert.equal(live.analysis.stale, true);
  assert.deepEqual(readFilmFile(await readFile(join(project.path, 'film.html'), 'utf8')).doc.tracks, []);
  const stateBefore = await readFile(join(project.path, '.film/product-analysis.json'), 'utf8');
  assert.deepEqual((await api(`projects/${project.id}/product-workflow/shared-open`)).sharedRead, created.sharedRead);
  await api(`projects/${project.id}/product-analysis`); await api('shared-media/projects', 'POST', input);
  assert.equal(await readFile(join(project.path, '.film/product-analysis.json'), 'utf8'), stateBefore);
  for (const before of sharedBefore) { assert.equal(await readFile(before.file, 'utf8'), before.bytes); assert.equal((await stat(before.file)).mtimeMs, before.mtime); }
  assert.ok(ops.every(op => op === 'catalog'), JSON.stringify(ops)); assert.equal(requests, 0);
});
