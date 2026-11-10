import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, dirname, resolve } from 'node:path';
import { filmHtml, readFilmFile } from '../../src/film-doc.mjs';
import { moveFile } from './files.mjs';
import { readProductAnalysis, writeProductAnalysis } from './product-analysis.mjs';
import { readSourceTakes, writeSourceTakes } from './source-takes.mjs';
import { transcribeProductSource, readProductTranscript, confirmProductTranscript } from './product-transcription.mjs';
import { createLiveAnalysis } from './live-analysis.mjs';
import { createProductDiscovery } from './product-discovery-route.mjs';
import { readTranscriptReview, saveTranscriptReview } from './transcript-review.mjs';

const base = resolve(import.meta.dirname, '../../../../.tmp/source-safety-20261105/move/cases');
const hash = value => createHash('sha256').update(value).digest('hex');
const probe = async () => ({ duration: 10 });
const json = async path => JSON.parse(await fs.readFile(path, 'utf8'));
async function put(root, path, value) { await fs.mkdir(dirname(join(root, path)), { recursive: true }); await fs.writeFile(join(root, path), typeof value === 'string' ? value : JSON.stringify(value)); }
async function fixture(t, registered = true) {
  await fs.mkdir(base, { recursive: true }); const root = await fs.mkdtemp(join(base, 'case-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  t.mock.method(globalThis, 'fetch', () => { throw Error('real requests forbidden'); });
  const source = { id: registered ? 'source' : 'assets/day/a.mp4', assetPath: 'assets/day/a.mp4', durationMs: 10000 };
  await put(root, source.assetPath, 'isolated original bytes');
  await put(root, 'assets/day-two/other.mp4', 'other original');
  await put(root, 'film.html', filmHtml({ stage: { w: 320, h: 180 }, tracks: [{ clips: [{ id: 'film-clip', src: source.assetPath, time: [1, 4], at: 0 }] }] }));
  if (registered) await writeProductAnalysis(root, { version: 1, sources: [source], products: [{ id: 'p', name: '人工商品名', sourceIds: ['source'] }], intervals: [{ id: 'r', sourceId: 'source', productId: 'p', startMs: 0, endMs: 9000 }], candidates: [] }, probe);
  return { root, source };
}
async function saveTake(root, source) {
  const first = await readSourceTakes(root, source.id, source.assetPath);
  const document = { version: 1, sourceId: source.id, assetPath: source.assetPath, durationMs: 10000, signature: JSON.stringify([source.assetPath, 10000, []]), film: { tracks: [{ clips: [{ id: 'private-clip', src: source.assetPath, time: [2, 3], at: 2 }] }] } };
  if (source.id === source.assetPath) {
    // Same persisted shape as writeSourceTakes, without probing synthetic bytes as a video.
    await put(root, '.film/source-takes.json', { version: 1, sources: [{ revision: 3, sourceIdentity: first.sourceIdentity, document }] });
  } else await writeSourceTakes(root, source.id, { expectedRevision: 0, sourceIdentity: first.sourceIdentity, document });
}
async function saveTranscript(root, source) {
  return transcribeProductSource(root, source, { getKey: async () => 'isolated-mock', readAudio: async () => Buffer.from('mock audio'), runProvider: async () => ({ index: [{ text: '完整两句原话。接着说卖点。', words: [{ token: '完整两句原话。接着说卖点。', start: 1, end: 3 }], cues: [{ text: '完整两句原话。', startMs: 1000, endMs: 2000 }, { text: '接着说卖点。', startMs: 2000, endMs: 3000 }] }] }) });
}

for (const [from, to, assetPath] of [['assets/day/a.mp4', 'assets/new.mp4', 'assets/new.mp4'], ['assets/day', 'assets/renamed', 'assets/renamed/a.mp4']]) {
  test(`moving ${from} preserves product identity, manual take and transcript after reopen`, async t => {
    const { root, source } = await fixture(t); await saveTake(root, source); const transcript = await saveTranscript(root, source);
    const before = (await readProductAnalysis(root)).analysis;
    await moveFile(root, from, to);
    const after = (await readProductAnalysis(root)).analysis;
    assert.equal(after.sources[0].assetPath, assetPath); assert.equal(after.sources[0].id, source.id);
    assert.deepEqual(after.products, before.products); assert.deepEqual(after.intervals, before.intervals);
    assert.deepEqual((await readProductTranscript(root, after.sources[0])).cues, transcript.cues);
    const take = await readSourceTakes(root, source.id, assetPath);
    assert.equal(take.document.assetPath, assetPath); assert.equal(take.document.film.tracks[0].clips[0].src, assetPath);
    assert.deepEqual(take.document.film.tracks[0].clips[0].time, [2, 3]); assert.equal(JSON.parse(take.document.signature)[0], assetPath);
    assert.equal(readFilmFile(await fs.readFile(join(root, 'film.html'), 'utf8')).value.tracks[0].clips[0].src, assetPath);
    assert.equal(await fs.readFile(join(root, assetPath), 'utf8'), 'isolated original bytes');
    assert.equal(await fs.readFile(join(root, 'assets/day-two/other.mp4'), 'utf8'), 'other original');
  });
}

test('an unregistered personal take follows a normal media rename before product preparation', async t => {
  const { root, source } = await fixture(t, false); await saveTake(root, source);
  await moveFile(root, source.assetPath, 'assets/new.mp4');
  const saved = await readSourceTakes(root, 'assets/new.mp4', 'assets/new.mp4');
  assert.ok(saved.document); assert.equal(saved.document.sourceId, 'assets/new.mp4'); assert.equal(saved.revision, 3);
  assert.deepEqual(saved.document.film.tracks[0].clips[0].time, [2, 3]);
});

test('completed structure cache survives move and a fresh service without another mock call', async t => {
  const { root, source } = await fixture(t); await saveTranscript(root, source); let calls = 0;
  const options = { modelIdentity: 'isolated-mock', probeSource: probe, modelClient: async () => { calls++; return { candidates: [{ firstCue: 0, lastCue: 1, tags: ['卖点'], details: { subtypes: [], reason: 'mock', evidence: ['ASR'], context: '', repetition: '', review: [] } }], issues: [] }; } };
  const first = createLiveAnalysis(options);
  await first.startAnalysis(root, { sourceId: source.id, intervalId: 'r', productId: 'p' }); await first.wait(root, source.id);
  const before = await first.view(root, source.id, 'r', 'p'); assert.equal(before.analysis.status, 'complete');
  await moveFile(root, source.assetPath, 'assets/new.mp4');
  const reopened = createLiveAnalysis(options), after = await reopened.view(root, source.id, 'r', 'p');
  assert.equal(after.analysis.status, 'complete'); assert.equal(after.analysis.stale, false); assert.equal(after.analysis.currentRunId, before.analysis.currentRunId);
  await reopened.startAnalysis(root, { sourceId: source.id, intervalId: 'r', productId: 'p' }); await reopened.wait(root, source.id);
  assert.equal(calls, 1);
  const changedModel = createLiveAnalysis({ ...options, modelIdentity: 'different-mock' });
  assert.equal((await changedModel.view(root, source.id, 'r', 'p')).analysis.stale, true);
  await moveFile(root, 'assets/new.mp4', 'assets/again.mp4');
  assert.equal((await reopened.view(root, source.id, 'r', 'p')).analysis.stale, false);
  const movedFile = join(root, 'assets/again.mp4'), info = await fs.stat(movedFile);
  await fs.writeFile(movedFile, Buffer.alloc(info.size, 120)); await fs.utimes(movedFile, info.atime, info.mtime);
  assert.equal((await reopened.view(root, source.id, 'r', 'p')).analysis.stale, true); assert.equal(calls, 1);
});

test('broken product metadata refuses the move before changing media or film', async t => {
  const { root, source } = await fixture(t); await put(root, '.film/product-analysis.json', '{broken');
  const film = await fs.readFile(join(root, 'film.html'));
  await assert.rejects(moveFile(root, source.assetPath, 'assets/new.mp4'), /关联|product-analysis|读取/);
  assert.equal(await fs.readFile(join(root, source.assetPath), 'utf8'), 'isolated original bytes'); assert.deepEqual(await fs.readFile(join(root, 'film.html')), film);
});

test('metadata save failure rolls back the media path and saved associations', async t => {
  const { root, source } = await fixture(t); await saveTake(root, source); const transcript = await saveTranscript(root, source);
  const paths = ['film.html', '.film/product-analysis.json', '.film/source-takes.json'];
  const before = await Promise.all(paths.map(path => fs.readFile(join(root, path))));
  const originalRename = fs.rename; let failed = false;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (!failed && String(to) === join(root, '.film/source-takes.json')) { failed = true; throw Object.assign(Error('simulated disk full'), { code: 'ENOSPC' }); }
    return originalRename(from, to);
  }); syncBuiltinESMExports();
  try { await assert.rejects(moveFile(root, source.assetPath, 'assets/new.mp4'), /disk full|保存|关联/); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(failed, true); assert.equal(await fs.readFile(join(root, source.assetPath), 'utf8'), 'isolated original bytes');
  for (const [index, path] of paths.entries()) assert.deepEqual(await fs.readFile(join(root, path)), before[index]);
  assert.deepEqual((await readProductTranscript(root, source)).cues, transcript.cues);
});

test('completed discovery proposal remains reusable and unchanged after a folder move', async t => {
  const { root, source } = await fixture(t); await saveTranscript(root, source); let calls = 0;
  const options = { probeSource: probe, modelIdentity: 'isolated-mock', modelClient: async ({ input }) => {
    calls++; const value = JSON.parse(input), indices = value.cues.filter(c => c.index >= value.coreFirst && c.index <= value.coreLast).map(c => c.index);
    return { products: [{ key: 'a', name: '模拟甲', variant: '', aliases: [], evidence: [indices[0]] }], ranges: [{ key: 'a', firstCue: indices[0], lastCue: indices.at(-1), kind: 'lecture', reason: '模拟讲解', evidence: [indices[0]] }], issues: [] };
  } };
  const route = createProductDiscovery(options); await route.start(root, { sourceId: source.id }); await route.wait(root, source.id);
  const before = await route.view(root, source.id); assert.equal((await route.plan(root, source.id)).cached, true);
  await moveFile(root, 'assets/day', 'assets/renamed');
  const fresh = createProductDiscovery(options); assert.equal((await fresh.plan(root, source.id)).cached, true);
  assert.deepEqual((await fresh.view(root, source.id)).proposal, before.proposal);
  await fresh.start(root, { sourceId: source.id }); await fresh.wait(root, source.id); assert.equal(calls, 1);
});

test('reviewed segmented transcript follows rename while provider returns and seam edits remain intact', async t => {
  const { root, source } = await fixture(t); let calls = 0;
  const options = { getKey: async () => 'isolated-mock', audioPolicy: { targetMs: 5000, overlapMs: 1000 }, readAudio: async () => Buffer.from('mock'), runProvider: async (_verb, args, ctx) => {
    const cues = calls++ === 0 ? [{ text: '前文', startMs: 100, endMs: 900 }, { text: '跨接缝因为', startMs: 4800, endMs: 5490 }] : [{ text: '跨接缝', startMs: 300, endMs: 700 }, { text: '因为完整原话', startMs: 700, endMs: 1500 }, { text: '末句', startMs: 3000, endMs: 4000 }];
    const row = { text: cues.map(c => c.text).join(''), cues, words: cues.map(c => ({ token: c.text, start: c.startMs / 1000, end: c.endMs / 1000 })) };
    await ctx.onResponse({ provider: 'doubao', requestId: args.requestId, httpStatus: 200, serviceStatus: '20000000', body: { result: row } }); return { index: [row] };
  } };
  await assert.rejects(transcribeProductSource(root, source, options), error => error.code === 'ASR_BOUNDARY_REVIEW');
  let state = await readTranscriptReview(root, source.id); assert.equal(state.pendingCount, 1);
  state = await saveTranscriptReview(root, { sourceId: source.id, identity: state.identity, expectedRevision: state.revision, seamId: state.seams[0].id, cues: state.seams[0].right, confirmed: true, acknowledgeImpact: true });
  const before = await readProductTranscript(root, source), cache = join(root, `.film/product-transcripts/${hash(source.id)}.json`);
  const segments = await json(`${cache}.segments.json`), review = await json(`${cache}.review.json`);
  const receiptsDir = join(root, '.film/product-transcripts/raw-responses'), receipts = await fs.readdir(receiptsDir);
  const raw = await Promise.all(receipts.map(name => fs.readFile(join(receiptsDir, name))));
  await moveFile(root, source.assetPath, 'assets/new.mp4'); const next = (await readProductAnalysis(root)).analysis.sources[0];
  assert.deepEqual((await readProductTranscript(root, next)).cues, before.cues);
  assert.deepEqual((await json(`${cache}.segments.json`)).segments, segments.segments);
  assert.deepEqual((await json(`${cache}.review.json`)).resolutions, review.resolutions);
  assert.deepEqual((await json(`${cache}.review.json`)).history, review.history);
  for (const [index, name] of receipts.entries()) assert.deepEqual(await fs.readFile(join(receiptsDir, name)), raw[index]);
  await transcribeProductSource(root, next, options); assert.equal(calls, 2);
});

test('shared manifest changes only project asset keys, never its NAS identity (local stand-in fixture)', async t => {
  const { root, source } = await fixture(t, false);
  const entry = { libraryId: 'isolated-library', libraryName: '模拟库', relativePath: 'live/original.mp4', size: 23, mtimeMs: 1 };
  await put(root, 'assets/.daocut-source-media.json', { version: 1, items: { [source.assetPath]: entry, 'assets/day-two/other.mp4': { ...entry, relativePath: 'other.mp4' } } });
  await moveFile(root, 'assets/day', 'assets/renamed');
  const saved = await json(join(root, 'assets/.daocut-source-media.json'));
  assert.deepEqual(saved.items['assets/renamed/a.mp4'], entry); assert.equal(saved.items[source.assetPath], undefined);
  assert.equal(saved.items['assets/day-two/other.mp4'].relativePath, 'other.mp4');
});

test('destination conflicts preserve source, associated JSON and existing destination', async t => {
  const { root, source } = await fixture(t); await saveTake(root, source); await put(root, 'assets/new.mp4', 'keep destination');
  const before = await fs.readFile(join(root, '.film/product-analysis.json'));
  await assert.rejects(moveFile(root, source.assetPath, 'assets/new.mp4'), /already there/);
  assert.deepEqual(await fs.readFile(join(root, '.film/product-analysis.json')), before);
  assert.equal(await fs.readFile(join(root, source.assetPath), 'utf8'), 'isolated original bytes'); assert.equal(await fs.readFile(join(root, 'assets/new.mp4'), 'utf8'), 'keep destination');
});

test('a mocked file-link move keeps its project VTT and explicit subtitle binding (not a native NAS test)', async t => {
  const { root, source } = await fixture(t);
  await put(root, 'assets/day/a.vtt', 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n同源字幕\n');
  await confirmProductTranscript(root, source, { sourceConfirmed: true });
  const original = fsSync.lstatSync;
  t.mock.method(fsSync, 'lstatSync', (path, ...args) => {
    const info = original(path, ...args);
    if (String(path) !== join(root, source.assetPath) || !info) return info;
    info.isSymbolicLink = () => true; return info;
  }); syncBuiltinESMExports();
  try { await moveFile(root, source.assetPath, 'assets/new.mp4'); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  const next = (await readProductAnalysis(root)).analysis.sources[0];
  assert.deepEqual((await readProductTranscript(root, next)).cues.map(c => c.text), ['同源字幕']);
  assert.equal(await fs.readFile(join(root, 'assets/new.vtt'), 'utf8'), 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n同源字幕\n');
});
