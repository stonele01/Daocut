import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Readable } from 'node:stream';
import { createLiveAnalysis } from './live-analysis.mjs';
import { createProductDiscovery } from './product-discovery-route.mjs';
import { createProductPreparation } from './product-preparation.mjs';
import { readProductAnalysis, writeProductAnalysis, recordProductEdit, updateProductAnalysis } from './product-analysis.mjs';

const base = resolve(import.meta.dirname, '../../../../.tmp/product-preparation');
const probe = async () => ({ duration: 10 });
const transcript = { cues: [{ text: '这是模拟甲的完整讲解', startMs: 100, endMs: 2000 }, { text: '模拟甲今天十元', startMs: 2100, endMs: 4000 }] };
const initial = { version: 1, sources: [{ id: 's', assetPath: 'assets/a.mp4', durationMs: 10000 }], products: [{ id: 'placeholder', name: '导入的视频', sourceIds: ['s'] }], intervals: [], candidates: [] };
const response = ({ input }) => {
  const value = JSON.parse(input), indices = value.cues.filter(c => c.index >= value.coreFirst && c.index <= value.coreLast).map(c => c.index);
  return { products: [{ key: 'a', name: '模拟甲', variant: '', aliases: [], evidence: [indices[0]] }], ranges: [{ key: 'a', firstCue: indices[0], lastCue: indices.at(-1), kind: 'lecture', reason: '模拟完整讲解', evidence: [indices[0]] }], issues: [] };
};
async function setup(t) {
  await mkdir(base, { recursive: true }); const root = await mkdtemp(join(base, 'case-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'assets')); await writeFile(join(root, 'assets/a.mp4'), 'synthetic'); await writeFile(join(root, 'film.html'), 'unchanged-film');
  await writeProductAnalysis(root, structuredClone(initial), probe); return root;
}
function controllers(options = {}) {
  const memory = options.memory ?? { transcript: null, audio: 0, text: 0 };
  const live = createLiveAnalysis({ probeSource: probe, readTranscript: async () => memory.transcript, transcribe: async () => { memory.audio++; memory.transcript = transcript; return transcript; }, ...options.live });
  const discovery = createProductDiscovery({ probeSource: probe, readTranscript: async () => memory.transcript, modelIdentity: 'isolated-preparation-v1', modelClient: async input => { memory.text++; return response(input); }, ...options.discovery });
  return { memory, live, discovery, route: createProductPreparation({ liveAnalysis: live, discovery }) };
}
async function request(route, root, method, body) {
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []); req.method = method; req.url = '/api/projects/p/product-preparation?sourceId=s';
  let output; const res = { writeHead() {}, end(text) { output = JSON.parse(text); } };
  assert.equal(await route(req, res, root, 'product-preparation'), true); return output;
}
const get = (r, root) => request(r, root, 'GET');
const start = (r, root, extra = {}) => request(r, root, 'POST', { sourceId: 's', confirmed: true, ...extra });
async function finish(r, root) {
  for (let n = 0; n < 300; n++) { const state = await get(r, root); if (state.status !== 'running') return state; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw Error('mock preparation did not finish');
}

test('one confirmed preparation transcribes, automatically discovers and saves first ranges', async t => {
  const root = await setup(t), c = controllers();
  assert.equal((await get(c.route, root)).status, 'idle'); assert.equal(c.memory.audio + c.memory.text, 0);
  await start(c.route, root); const done = await finish(c.route, root);
  assert.equal(done.status, 'complete'); assert.equal(done.phase, 'ready');
  assert.equal(c.memory.audio, 1); assert.equal(c.memory.text, 1);
  const saved = (await readProductAnalysis(root)).analysis;
  assert.equal(saved.products[0].name, '模拟甲'); assert.equal(saved.intervals.length, 1);
  assert.equal(saved.intervals[0].startMs, 100); assert.equal(saved.intervals[0].endMs, 4000);
  assert.equal(await readFile(join(root, 'assets/a.mp4'), 'utf8'), 'synthetic');
  assert.equal(await readFile(join(root, 'film.html'), 'utf8'), 'unchanged-film');
});

test('saved transcript is reused and reopening or selecting does not send again', async t => {
  const root = await setup(t), memory = { transcript, audio: 0, text: 0 }, c = controllers({ memory });
  assert.equal((await get(c.route, root)).needsTranscription, false);
  await start(c.route, root); assert.equal((await finish(c.route, root)).status, 'complete');
  const reopened = controllers({ memory });
  await get(reopened.route, root); await get(reopened.route, root); await start(reopened.route, root);
  assert.equal(memory.audio, 0); assert.equal(memory.text, 1);
});

test('missing discovery permission or identity rejects before any audio work', async t => {
  const root = await setup(t);
  for (const discovery of [{ modelClient: undefined }, { modelIdentity: undefined }]) {
    const c = controllers({ discovery });
    assert.equal((await get(c.route, root)).enabled, false);
    await assert.rejects(start(c.route, root), { status: 403 });
    assert.equal(c.memory.audio + c.memory.text, 0);
  }
  const c = controllers({ live: { transcribe: undefined } });
  assert.equal((await get(c.route, root)).enabled, false);
  await assert.rejects(start(c.route, root), { status: 403 });
  await assert.rejects(request(c.route, root, 'POST', { sourceId: 's' }), { status: 400 });
});

test('saved manual ranges are ready and never replaced by preparation', async t => {
  const root = await setup(t), c = controllers();
  await updateProductAnalysis(root, data => { const next = structuredClone(data); next.products[0].name = '人工名'; next.intervals.push({ id: 'manual', sourceId: 's', productId: 'placeholder', startMs: 1000, endMs: 3000 }); return recordProductEdit(data, next); }, probe);
  const before = await readFile(join(root, '.film/product-analysis.json'));
  assert.equal((await start(c.route, root)).status, 'complete');
  assert.equal(c.memory.audio + c.memory.text, 0);
  assert.deepEqual(await readFile(join(root, '.film/product-analysis.json')), before);
});

test('same concurrent preparation is deduplicated', async t => {
  const root = await setup(t); let release, enter; const gate = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { enter = resolve; });
  const memory = { transcript: null, audio: 0, text: 0 };
  const c = controllers({ memory, live: { transcribe: async () => { memory.audio++; enter(); await gate; memory.transcript = transcript; return transcript; } } });
  await Promise.all([start(c.route, root), start(c.route, root), start(c.route, root)]);
  await entered;
  assert.equal(memory.audio, 1); assert.equal(memory.text, 0);
  await assert.rejects(start(c.route, root, { retry: true }), { status: 409 });
  release(); assert.equal((await finish(c.route, root)).status, 'complete');
  assert.equal(memory.audio, 1); assert.equal(memory.text, 1);
});

test('uncertain transcription stops the chain and requires an explicit checked retry', async t => {
  const root = await setup(t), memory = { transcript: null, audio: 0, text: 0 };
  const c = controllers({ memory, live: { transcribe: async (root, source, { retryUncertain }) => { memory.audio++; if (!retryUncertain) throw Error('uncertain submission'); memory.transcript = transcript; return transcript; } } });
  await start(c.route, root); const failed = await finish(c.route, root);
  assert.equal(failed.status, 'failed'); assert.equal(failed.phase, 'transcription'); assert.equal(failed.retryUncertainRequired, true);
  assert.equal(memory.text, 0);
  await assert.rejects(start(c.route, root), { status: 409 });
  await assert.rejects(start(c.route, root, { retry: true }), { status: 409 });
  assert.equal(memory.audio, 1);
  await start(c.route, root, { retry: true, retryUncertain: true }); assert.equal((await finish(c.route, root)).status, 'complete');
  assert.equal(memory.audio, 2); assert.equal(memory.text, 1);
});

test('discovery failure keeps transcript and retries only after explicit action', async t => {
  const root = await setup(t), memory = { transcript, audio: 0, text: 0 };
  const c = controllers({ memory, discovery: { modelClient: async input => { memory.text++; if (memory.text === 1) throw Error('uncertain'); return response(input); } } });
  await start(c.route, root); assert.equal((await finish(c.route, root)).status, 'failed');
  const reopened = controllers({ memory });
  assert.equal((await get(reopened.route, root)).status, 'failed'); assert.equal(memory.text, 1);
  await assert.rejects(start(reopened.route, root), { status: 409 });
  await start(reopened.route, root, { retry: true }); assert.equal((await finish(reopened.route, root)).status, 'complete');
  assert.equal(memory.audio, 0); assert.equal(memory.text, 2);
});

test('interrupted preparation is read as failed and never auto-resumes after restart', async t => {
  const root = await setup(t), c = controllers({ memory: { transcript, audio: 0, text: 0 } });
  const dir = join(root, '.film/product-preparation'); await mkdir(dir);
  await writeFile(join(dir, `${createHash('sha256').update('s').digest('hex')}.json`), JSON.stringify({ version: 1, id: 'interrupted', sourceId: 's', status: 'running', phase: 'discovery' }));
  const state = await get(c.route, root);
  assert.equal(state.status, 'failed'); assert.equal(state.canRetry, true); assert.equal(c.memory.text, 0);
  await assert.rejects(start(c.route, root), { status: 409 });
  await start(c.route, root, { retry: true }); assert.equal((await finish(c.route, root)).status, 'complete');
  assert.equal(c.memory.text, 1);
});

test('a completed proposal applies locally without a new enabled model', async t => {
  const root = await setup(t), memory = { transcript, audio: 0, text: 0 }, c = controllers({ memory });
  await c.discovery.start(root, { sourceId: 's' }); await c.discovery.wait(root, 's');
  const reopened = controllers({ memory, discovery: { modelClient: undefined } });
  assert.equal((await get(reopened.route, root)).enabled, true);
  await start(reopened.route, root); assert.equal((await finish(reopened.route, root)).status, 'complete');
  assert.equal(memory.text, 1); assert.equal(memory.audio, 0);
});

test('manual edit during transcription prevents the downstream model request', async t => {
  const root = await setup(t); let release; const gate = new Promise(resolve => { release = resolve; });
  const memory = { transcript: null, audio: 0, text: 0 };
  const c = controllers({ memory, live: { transcribe: async () => { memory.audio++; await gate; memory.transcript = transcript; return transcript; } } });
  await start(c.route, root);
  await updateProductAnalysis(root, data => { const next = structuredClone(data); next.products[0].name = '人工编辑'; return recordProductEdit(data, next); }, probe);
  release(); await c.route.wait(root, 's');
  // A saved manual result is ready for the user even though preparation stops.
  await finish(c.route, root);
  assert.equal(memory.text, 0); assert.equal((await readProductAnalysis(root)).analysis.products[0].name, '人工编辑');
});

test('manual name-only edits require review rather than claiming nonexistent ranges are ready', async t => {
  const root = await setup(t), c = controllers();
  await updateProductAnalysis(root, data => { const next = structuredClone(data); next.products[0].name = '人工命名'; return recordProductEdit(data, next); }, probe);
  const state = await get(c.route, root);
  assert.notEqual(state.status, 'complete'); assert.equal(state.needsReview, true); assert.equal(state.enabled, false);
  await assert.rejects(start(c.route, root), { status: 409 });
  assert.equal(c.memory.audio + c.memory.text, 0);
});

test('a failed standalone discovery can be explicitly retried through preparation', async t => {
  const root = await setup(t), memory = { transcript, audio: 0, text: 0 };
  const c = controllers({ memory, discovery: { modelClient: async () => { memory.text++; throw Error('uncertain'); } } });
  await c.discovery.start(root, { sourceId: 's' }); await c.discovery.wait(root, 's');
  const resumed = controllers({ memory });
  const state = await get(resumed.route, root);
  assert.equal(state.status, 'failed'); assert.equal(state.canRetry, true);
  await assert.rejects(start(resumed.route, root), { status: 409 });
  await start(resumed.route, root, { retry: true }); assert.equal((await finish(resumed.route, root)).status, 'complete');
  assert.equal(memory.text, 2); assert.equal(memory.audio, 0);
});

test('an old complete preparation does not claim ranges are ready after they were removed', async t => {
  const root = await setup(t), c = controllers({ memory: { transcript, audio: 0, text: 0 } });
  await start(c.route, root); await c.route.wait(root, 's');
  await updateProductAnalysis(root, data => { const next = structuredClone(data); next.intervals = []; return recordProductEdit(data, next); }, probe);
  const state = await get(c.route, root);
  assert.notEqual(state.status, 'complete'); assert.equal(state.needsReview, true);
  assert.equal(c.memory.text, 1);
});
