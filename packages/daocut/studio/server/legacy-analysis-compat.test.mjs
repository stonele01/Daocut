import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createLiveAnalysis } from './live-analysis.mjs';
import { writeProductAnalysis } from './product-analysis.mjs';

async function fixture(t) {
  await mkdir(resolve('.test-temp'), { recursive: true });
  const root = await mkdtemp(resolve('.test-temp/legacy-edit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, 'assets'));
  const media = resolve(root, 'assets/synthetic.mp4');
  await writeFile(media, 'isolated synthetic media');
  const info = await stat(media);
  const product = { version: 1, sources: [{ id: 's', assetPath: 'assets/synthetic.mp4', durationMs: 30000 }], products: [{ id: 'p', name: '隔离商品', sourceIds: ['s'] }], intervals: [], scopes: [{ id: 'i', sourceId: 's', productId: 'p', startMs: 0, endMs: 29000, kind: 'confirmed-inspection', confirmed: true }], candidates: Array.from({ length: 13 }, (_, n) => ({ id: `c${n}`, sourceId: 's', productId: 'p', intervalId: 'i', startMs: 1000 + n * 2000, endMs: 2000 + n * 2000, text: `隔离原话${n}`, tags: ['卖点'], origin: 'ai-text', version: 'text-structure-v1', runId: 'legacy-run' })) };
  await writeProductAnalysis(root, product, async () => ({ duration: 30 }));
  const saved = { version: 1, sourceId: 's', transcription: { status: 'idle', segments: [] }, analysis: { status: 'complete', sourceFingerprint: `${info.size}:${info.mtimeMs}`, transcriptHash: 'historical-transcript', currentRunId: 'legacy-run', intervalId: 'i', productId: 'p', rangeStartMs: 0, rangeEndMs: 29000 } };
  const path = resolve(root, '.film/live-analysis', `${createHash('sha256').update('s').digest('hex')}.json`);
  await mkdir(resolve(root, '.film/live-analysis'));
  const save = () => writeFile(path, JSON.stringify(saved));
  await save();
  let calls = 0;
  const options = { readTranscript: async () => null, transcribe: async () => { calls++; throw Error('must not call'); }, modelClient: async () => { calls++; throw Error('must not call'); } };
  const view = () => createLiveAnalysis(options).view(root, 's', 'i');
  return { root, media, path, product, saved, save, view, info, options, calls: () => calls };
}

test('13 legacy candidates remain editable on read/reopen without becoming a current cache or calling a service', async t => {
  const f = await fixture(t), before = await readFile(f.path, 'utf8');
  const productBefore = await readFile(resolve(f.root, '.film/product-analysis.json'), 'utf8');
  for (let reopen = 0; reopen < 2; reopen++) {
    const result = await f.view();
    assert.equal(result.analysis.legacyEditable, true);
    assert.equal(result.analysis.stale, true);
    assert.equal(result.analysis.status, 'idle');
    assert.equal(result.analysis.currentRunId, 'legacy-run');
    assert.equal(result.analysis.cacheIdentity, undefined);
  }
  assert.equal(f.calls(), 0);
  assert.equal(await readFile(f.path, 'utf8'), before);
  assert.equal(await readFile(resolve(f.root, '.film/product-analysis.json'), 'utf8'), productBefore);
});

test('legacy entry remains editable after its container was saved as v2 for another range', async t => {
  const f = await fixture(t);
  f.saved.version = 2; f.saved.analyses = { i: f.saved.analysis }; f.saved.results = {}; f.saved.analysis = { status: 'idle', intervalId: 'another' };
  await f.save();
  assert.equal((await f.view()).analysis.legacyEditable, true);
  assert.equal(f.calls(), 0);
});

test('unreadable current transcript does not discard a verified historical editing result', async t => {
  const f = await fixture(t);
  f.options.readTranscript = async () => { throw Error('isolated transcript unavailable'); };
  const result = await f.view();
  assert.equal(result.analysis.legacyEditable, true);
  assert.equal(result.analysis.stale, true);
  assert.equal(result.transcription.status, 'failed');
  assert.equal(f.calls(), 0);
});

test('legacy editing tolerates copy/restore rounding of source mtime to milliseconds', async t => {
  const f = await fixture(t), milliseconds = 1718933494791;
  await utimes(f.media, new Date(milliseconds), new Date(milliseconds));
  f.saved.analysis.sourceFingerprint = `${f.info.size}:1718933494790.7617`;
  await f.save();
  assert.equal((await f.view()).analysis.legacyEditable, true);
  f.saved.analysis.sourceFingerprint = `${f.info.size}:1718933494792`;
  await f.save();
  assert.notEqual((await f.view()).analysis.legacyEditable, true);
});

test('legacy editing rejects changed or missing media without submitting requests', async t => {
  const f = await fixture(t);
  await writeFile(f.media, 'a different isolated source');
  assert.notEqual((await f.view()).analysis.legacyEditable, true);
  await rm(f.media);
  assert.notEqual((await f.view()).analysis.legacyEditable, true);
  assert.equal(f.calls(), 0);
});

test('legacy editing requires a completed run with matching product, range and source metadata', async t => {
  const f = await fixture(t), original = structuredClone(f.saved.analysis);
  for (const patch of [{ status: 'running' }, { status: 'failed' }, { currentRunId: '' }, { productId: 'other' }, { rangeStartMs: 1 }, { rangeEndMs: 30000 }, { sourceFingerprint: `${f.info.size}:${f.info.mtimeMs + 1}` }, { sourceFingerprint: ':NaN' }, { sourceFingerprint: '-1:1' }]) {
    f.saved.analysis = { ...original, ...patch }; await f.save();
    assert.notEqual((await f.view()).analysis.legacyEditable, true, JSON.stringify(patch));
  }
  assert.equal(f.calls(), 0);
});

test('modern stale entries cannot use legacy editing even when their model identity is missing', async t => {
  const f = await fixture(t);
  f.saved.analysis.sourceFingerprint = `${f.info.size}:${f.info.mtimeMs}:${f.info.ctimeMs}:${f.info.ino}`;
  await f.save();
  assert.notEqual((await f.view()).analysis.legacyEditable, true);
  f.saved.analysis.sourceFingerprint = `${f.info.size}:${f.info.mtimeMs}`;
  f.saved.analysis.cacheIdentity = 'outdated-modern-cache';
  await f.save();
  assert.notEqual((await f.view()).analysis.legacyEditable, true);
  assert.equal(f.calls(), 0);
});
