import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { createLiveAnalysis } from './live-analysis.mjs';
import { readProductAnalysis, writeProductAnalysis } from './product-analysis.mjs';

const probe = async () => ({ duration: 20 });
const details = { subtypes: [], reason: '隔离模拟原话', evidence: ['ASR'], context: '', repetition: '', review: [] };
const scope = { sourceId: 's', productId: 'a', intervalId: 'a1', startMs: 1500, endMs: 3500, lectureOnly: true };
async function fixture(t) {
  const base = resolve(import.meta.dirname, '../../../../.tmp/long-live-implementation-20261103/chat/fixtures');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'task-'));
  t.after(() => {
    const child = relative(base, root);
    assert.ok(child && !child.startsWith('..') && !isAbsolute(child));
    return rm(root, { recursive: true, force: true });
  });
  t.mock.method(globalThis, 'fetch', () => { throw Error('isolated mock: network forbidden'); });
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'assets/synthetic.mp4'), 'synthetic');
  await writeFile(join(root, 'film.html'), 'unchanged film');
  const analysis = { version: 1, sources: [{ id: 's', assetPath: 'assets/synthetic.mp4', durationMs: 20000 }], products: [{ id: 'a', name: '商品 A', sourceIds: ['s'] }, { id: 'b', name: '商品 B', sourceIds: ['s'] }], intervals: [
    { id: 'a1', sourceId: 's', productId: 'a', startMs: 1500, endMs: 3500 },
    { id: 'b1', sourceId: 's', productId: 'b', startMs: 6000, endMs: 10000 },
    { id: 'a2', sourceId: 's', productId: 'a', startMs: 12000, endMs: 16000 },
  ], scopes: [{ id: 'inspection', sourceId: 's', productId: 'a', startMs: 0, endMs: 1000, kind: 'confirmed-inspection', confirmed: true }], candidates: [] };
  await writeProductAnalysis(root, analysis, probe);
  const transcript = { cues: [
    { startMs: 0, endMs: 5000, text: '前品 切左 本品 切右 后品' },
    { startMs: 6100, endMs: 9000, text: '商品 B 讲解' },
    { startMs: 12100, endMs: 15000, text: '商品 A 返场' },
  ], words: [
    { startMs: 0, endMs: 1000, text: '前品' }, { startMs: 1000, endMs: 2000, text: '切左' },
    { startMs: 2000, endMs: 3000, text: '本品' }, { startMs: 3000, endMs: 4000, text: '切右' }, { startMs: 4000, endMs: 5000, text: '后品' },
  ] };
  const calls = [];
  const options = { readTranscript: async () => transcript, probeSource: probe, modelIdentity: 'isolated-chat-card-v1', modelClient: async ({ input }) => { calls.push(JSON.parse(input)); return { candidates: [{ firstCue: 0, lastCue: 0, tags: ['卖点'], details }], issues: [] }; } };
  return { root, analysis, transcript, options, calls, route: createLiveAnalysis(options) };
}
async function request(route, root, method = 'GET', selection = scope, options = {}) {
  const body = { ...selection, confirmed: true, ...options };
  const req = Readable.from(method === 'POST' ? [Buffer.from(JSON.stringify(body))] : []);
  req.method = method; req.url = '/?' + new URLSearchParams(Object.entries(selection).map(([key, value]) => [key, String(value)]));
  let result;
  await route(req, { writeHead() {}, end(text) { result = JSON.parse(text); } }, root, method === 'GET' ? 'live-analysis' : 'live-analysis/analyze');
  return result;
}
async function analyze(f, selection = scope, options = {}) {
  await request(f.route, f.root, 'POST', selection, options);
  await f.route.wait(f.root, 's');
  return request(f.route, f.root, 'GET', selection);
}

test('card and chat share clipped words, absolute candidates and persisted cache across A → B → A', async t => {
  const f = await fixture(t);
  const first = await analyze(f, { sourceId: 's', productId: 'a', intervalId: 'a1' });
  assert.equal(first.analysis.status, 'complete');
  const cached = await request(f.route, f.root);
  assert.equal(cached.analysis.currentRunId, first.analysis.currentRunId);
  assert.equal(cached.analysis.omittedBoundaryWords, 2);
  assert.deepEqual(cached.transcription.segments, [], 'chat task status never includes the full transcript');
  assert.deepEqual(f.calls[0].cues, [{ startMs: 2000, endMs: 3000, text: '本品' }]);
  await analyze(f, { ...scope, productId: 'b', intervalId: 'b1', startMs: 6000, endMs: 10000 });
  await analyze(f, { ...scope, intervalId: 'a2', startMs: 12000, endMs: 16000 });
  f.route = createLiveAnalysis(f.options);
  assert.equal((await analyze(f)).analysis.currentRunId, first.analysis.currentRunId);
  assert.equal(f.calls.length, 3);
  const saved = (await readProductAnalysis(f.root)).analysis;
  assert.deepEqual(saved.candidates.map(candidate => [candidate.intervalId, candidate.startMs, candidate.endMs, candidate.cueRange]), [['a1', 2000, 3000, [0, 0]], ['b1', 6100, 9000, [1, 1]], ['a2', 12100, 15000, [2, 2]]]);
  assert.equal(await readFile(join(f.root, 'film.html'), 'utf8'), 'unchanged film');
});

test('strict chat requests reject changed edges, product IDs and private/inspection ranges before model calls', async t => {
  const f = await fixture(t);
  for (const patch of [{ startMs: 1501 }, { endMs: 3499 }, { productId: 'b' }, { intervalId: 'private' }, { intervalId: 'inspection', startMs: 0, endMs: 1000 }]) {
    for (const method of ['GET', 'POST']) await assert.rejects(request(f.route, f.root, method, { ...scope, ...patch }), { status: 409 });
  }
  await assert.rejects(request(f.route, f.root, 'POST', { ...scope, startMs: -1 }), { status: 400 });
  assert.equal(f.calls.length, 0);
});

test('changed word alignment invalidates cache, but does not call a model until another explicit task', async t => {
  const f = await fixture(t);
  assert.equal((await analyze(f)).analysis.status, 'complete');
  f.transcript.words[2].startMs = 2100;
  assert.equal((await request(f.route, f.root)).analysis.status, 'idle');
  assert.equal(f.calls.length, 1);
  await analyze(f);
  assert.equal(f.calls[1].cues[0].startMs, 2100);
});

test('missing word alignment fails before a model request and plain repeat cannot retry a failed task', async t => {
  const f = await fixture(t);
  f.transcript.words = [];
  const failed = await analyze(f);
  assert.equal(failed.analysis.status, 'failed');
  assert.match(failed.analysis.error, /可靠的逐词时间/);
  await assert.rejects(request(f.route, f.root, 'POST'), /不会自动重试/);
  assert.equal(f.calls.length, 0);
});

test('uncertain model failure needs explicit retry; a rerun preserves manual candidate changes', async t => {
  const f = await fixture(t);
  let failures = 0;
  f.route = createLiveAnalysis({ ...f.options, modelClient: async () => { failures++; throw Object.assign(Error('isolated timeout'), { code: 'MODEL_TIMEOUT' }); } });
  assert.equal((await analyze(f)).analysis.status, 'failed');
  await assert.rejects(request(f.route, f.root, 'POST'), /不会自动重试/);
  assert.equal(failures, 1);
  f.route = createLiveAnalysis(f.options);
  assert.equal((await analyze(f, scope, { retryFailed: true })).analysis.status, 'complete');
  const saved = (await readProductAnalysis(f.root)).analysis;
  saved.candidates[0].tags = ['痛点'];
  await writeProductAnalysis(f.root, saved, probe);
  assert.equal((await analyze(f, scope, { rerun: true })).analysis.status, 'complete');
  const after = (await readProductAnalysis(f.root)).analysis;
  assert.equal(after.candidates.length, 2);
  assert.deepEqual(after.candidates[0].tags, ['痛点']);
});

test('unconfigured real services remain unavailable even with a selected lecture and confirmed request', async t => {
  const f = await fixture(t);
  const route = createLiveAnalysis({ readTranscript: f.options.readTranscript, probeSource: probe });
  await assert.rejects(request(route, f.root, 'POST'), { status: 403 });
  assert.equal(f.calls.length, 0);
});

test('request review counts the selected text windows and rejects input changed after confirmation', async t => {
  const f = await fixture(t);
  const before = await request(f.route, f.root);
  assert.equal(before.analysisPlan.enabled, true);
  assert.equal(before.analysisPlan.model, 'isolated-chat-card-v1');
  assert.equal(before.analysisPlan.requestCount, 1);
  assert.equal(before.analysisPlan.transcriptSegments, 1);
  assert.match(before.analysisPlan.inputIdentity, /^[a-f0-9]{64}$/);
  f.transcript.words[2].text = '已改原话';
  await assert.rejects(request(f.route, f.root, 'POST', scope, { expectedInputIdentity: before.analysisPlan.inputIdentity }), /确认期间发生变化/);
  assert.equal(f.calls.length, 0);
});

test('approved input changing after running state is saved fails before the first model request', async t => {
  for (const change of ['transcript', 'model']) {
    const f = await fixture(t);
    let reads = 0, model = 'isolated-confirmed-v1';
    f.route = createLiveAnalysis({ ...f.options, modelIdentity: () => model, readTranscript: async () => {
      reads++;
      // Read 1 is preflight; read 2 is the pre-write approval check. Read 3
      // occurs in view() after running state has been saved but before work starts.
      if (reads === 3) {
        if (change === 'transcript') f.transcript.words[2].text = '确认后已变更的原话';
        else model = 'different-model-after-confirmation';
      }
      return f.transcript;
    } });
    const approved = await request(f.route, f.root);
    const result = await analyze(f, scope, { expectedInputIdentity: approved.analysisPlan.inputIdentity });
    assert.ok(reads >= 4, 'exercise the task read after the first approval check');
    assert.equal(result.analysis.status, 'failed', change);
    assert.match(result.analysis.error, /本地授权输入已变化/);
    assert.equal(f.calls.length, 0, change);
    assert.equal((await readProductAnalysis(f.root)).analysis.candidates.length, 0, change);
  }
});

test('cropping can omit an overlapping cue without shifting later original cue indices', async t => {
  const f = await fixture(t);
  f.analysis.intervals[0].startMs = 500; f.analysis.intervals[0].endMs = 2000;
  await writeProductAnalysis(f.root, f.analysis, probe);
  f.transcript.cues = [{ startMs: 500, endMs: 1000, text: '保留第一句' }, { startMs: 600, endMs: 3000, text: '跨界字幕' }, { startMs: 700, endMs: 800, text: '保留第三句' }];
  f.transcript.words = [{ startMs: 2500, endMs: 2600, text: '范围外完整词' }];
  f.route = createLiveAnalysis({ ...f.options, modelClient: async ({ input }) => {
    const sent = JSON.parse(input); assert.deepEqual(sent.cues.map(cue => cue.text), ['保留第一句', '保留第三句']);
    return { candidates: [{ firstCue: 1, lastCue: 1, tags: ['卖点'], details }], issues: [] };
  } });
  assert.equal((await analyze(f, { ...scope, startMs: 500, endMs: 2000 })).analysis.status, 'complete');
  assert.deepEqual((await readProductAnalysis(f.root)).analysis.candidates[0].cueRange, [2, 2]);
});
