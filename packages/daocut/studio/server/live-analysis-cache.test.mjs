import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { createLiveAnalysis } from './live-analysis.mjs';
import { readProductAnalysis, writeProductAnalysis } from './product-analysis.mjs';
import { createDeepSeekTextClient, TEXT_STRUCTURE_PROMPT, TEXT_STRUCTURE_VERSION } from './text-structure.mjs';

const probe = async () => ({ duration: 10 });
const details = { subtypes: [], reason: '原文功能', evidence: ['ASR'], context: '', repetition: '', review: [] };
const output = () => ({ candidates: [{ firstCue: 0, lastCue: 0, tags: ['卖点'], details }], issues: [] });
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'daocut-range-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'assets/a.mp4'), 'synthetic');
  await writeProductAnalysis(root, { version: 1, sources: [{ id: 's', assetPath: 'assets/a.mp4', durationMs: 10000 }], products: [{ id: 'a', name: '商品甲', sourceIds: ['s'] }, { id: 'b', name: '商品乙', sourceIds: ['s'] }], intervals: [
    { id: 'a1', sourceId: 's', productId: 'a', startMs: 0, endMs: 2000 },
    { id: 'b1', sourceId: 's', productId: 'b', startMs: 2000, endMs: 4000 },
    { id: 'a2', sourceId: 's', productId: 'a', startMs: 4000, endMs: 6000 },
  ], candidates: [] }, probe);
  let calls = 0;
  const context = { root, cues: [{ text: '甲开场', startMs: 100, endMs: 900 }, { text: '乙讲解', startMs: 2100, endMs: 2900 }, { text: '甲返场', startMs: 4100, endMs: 4900 }], identity: { provider: 'mock', model: 'mock-v1', endpoint: 'https://example.invalid', parameters: { temperature: 0 } } };
  context.options = { modelIdentity: () => context.identity, readTranscript: async () => ({ cues: context.cues }), probeSource: probe, modelClient: async () => { calls++; return output(); } };
  context.calls = () => calls;
  context.route = createLiveAnalysis(context.options);
  return context;
}
async function request(route, root, method = 'GET', intervalId, body = {}) {
  const req = Readable.from(method === 'POST' ? [Buffer.from(JSON.stringify({ sourceId: 's', intervalId, confirmed: true, ...body }))] : []);
  req.method = method; req.url = `/?sourceId=s${intervalId ? `&intervalId=${encodeURIComponent(intervalId)}` : ''}`;
  let result;
  await route(req, { writeHead() {}, end(text) { result = JSON.parse(text); } }, root, method === 'GET' ? 'live-analysis' : 'live-analysis/analyze');
  return result;
}
async function finish(route, root, intervalId) {
  for (let i = 0; i < 200; i++) {
    const result = await request(route, root, 'GET', intervalId);
    if (result.analysis.status !== 'running') return result;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('mock did not finish');
}
async function analyze(context, intervalId = 'a1', route = context.route, body) {
  await request(route, context.root, 'POST', intervalId, body);
  return finish(route, context.root, intervalId);
}

test('A → B → A independent ranges and input versions survive reopen without calls on GET or cached POST', async t => {
  const c = await setup(t);
  const ids = {};
  for (const interval of ['a1', 'b1', 'a2']) {
    const result = await analyze(c, interval);
    assert.equal(result.analysis.status, 'complete');
    ids[interval] = result.analysis.currentRunId;
  }
  assert.equal(c.calls(), 3);
  const reopened = createLiveAnalysis(c.options);
  for (const interval of ['a1', 'b1', 'a2', 'a1']) {
    const result = await request(reopened, c.root, 'GET', interval);
    assert.equal(result.analysis.currentRunId, ids[interval]);
    assert.equal(result.analysis.stale, false);
    for (const id of Object.keys(ids)) assert.equal(result.analyses[id].currentRunId, ids[id]);
    assert.equal((await request(reopened, c.root, 'POST', interval)).analysis.currentRunId, ids[interval]);
  }
  assert.equal(c.calls(), 3);
  const saved = (await readProductAnalysis(c.root)).analysis;
  assert.deepEqual(saved.intervals.map(x => [x.productId, x.startMs, x.endMs]), [['a', 0, 2000], ['b', 2000, 4000], ['a', 4000, 6000]]);
  assert.equal(saved.candidates.length, 3);
});

test('each cache identity component invalidates without making a model request', async t => {
  const mutations = {
    'asset path': async c => { await writeFile(join(c.root, 'assets/b.mp4'), 'synthetic'); const data = (await readProductAnalysis(c.root)).analysis; data.sources[0].assetPath = 'assets/b.mp4'; await writeProductAnalysis(c.root, data, probe); },
    'same size source with restored mtime': async c => { const path = join(c.root, 'assets/a.mp4'), before = await stat(path); await new Promise(r => setTimeout(r, 20)); await writeFile(path, 'different'); await utimes(path, before.atime, before.mtime); assert.equal((await stat(path)).size, before.size); },
    'source duration': async c => { const data = (await readProductAnalysis(c.root)).analysis; data.sources[0].durationMs = 12000; await writeProductAnalysis(c.root, data, async () => ({ duration: 12 })); },
    'range start': async c => { const data = (await readProductAnalysis(c.root)).analysis; data.intervals[0].startMs = 50; await writeProductAnalysis(c.root, data, probe); },
    'range end': async c => { const data = (await readProductAnalysis(c.root)).analysis; data.intervals[0].endMs = 1900; await writeProductAnalysis(c.root, data, probe); },
    'range product': async c => { const data = (await readProductAnalysis(c.root)).analysis; data.intervals[0].productId = 'b'; data.candidates[0].productId = 'b'; await writeProductAnalysis(c.root, data, probe); },
    'transcript outside selected range': async c => { c.cues[2].text = '修改返场原话'; },
    'actual prompt': async c => { c.route = createLiveAnalysis({ ...c.options, structurePrompt: `${TEXT_STRUCTURE_PROMPT}\n新规则` }); },
    'algorithm version': async c => { c.route = createLiveAnalysis({ ...c.options, structureVersion: `${TEXT_STRUCTURE_VERSION}-next` }); },
    'model': async c => { c.identity.model = 'mock-v2'; },
    'endpoint': async c => { c.identity.endpoint = 'https://other.invalid'; },
    'request parameters': async c => { c.identity.parameters.temperature = 1; },
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, async t => {
    const c = await setup(t);
    assert.equal((await analyze(c)).analysis.status, 'complete');
    await mutate(c);
    for (let i = 0; i < 2; i++) {
      const state = await request(c.route, c.root, 'GET', 'a1');
      assert.equal(state.analysis.status, 'idle'); assert.equal(state.analysis.stale, true);
    }
    assert.equal(c.calls(), 1, 'inspection must not resend stale input');
  });
});

test('multiple prompt versions remain separately reusable', async t => {
  const c = await setup(t), first = await analyze(c);
  const changed = createLiveAnalysis({ ...c.options, structurePrompt: `${TEXT_STRUCTURE_PROMPT}\n新规则` });
  const second = await analyze(c, 'a1', changed);
  assert.notEqual(second.analysis.currentRunId, first.analysis.currentRunId);
  assert.equal((await request(c.route, c.root, 'GET', 'a1')).analysis.currentRunId, first.analysis.currentRunId);
  await request(c.route, c.root, 'POST', 'a1');
  assert.equal(c.calls(), 2);
});

test('missing model identity and legacy state are readable but never treated as current', async t => {
  const c = await setup(t), first = await analyze(c);
  const unknown = createLiveAnalysis({ ...c.options, modelIdentity: undefined });
  assert.equal((await request(unknown, c.root, 'GET', 'a1')).analysis.stale, true);
  await assert.rejects(request(unknown, c.root, 'POST', 'a1'), /模型配置身份未确认/);
  const stateFile = join(c.root, '.film/live-analysis', `${createHash('sha256').update('s').digest('hex')}.json`);
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  delete state.analysis.cacheIdentity;
  await writeFile(stateFile, JSON.stringify({ version: 1, sourceId: 's', transcription: state.transcription, analysis: state.analysis }));
  const reopened = createLiveAnalysis(c.options), legacy = await request(reopened, c.root, 'GET', 'a1');
  assert.equal(legacy.analysis.currentRunId, first.analysis.currentRunId);
  assert.equal(legacy.analysis.stale, true); assert.equal(c.calls(), 1);
  assert.equal((await analyze(c, 'a1', reopened)).analysis.status, 'complete');
  assert.equal(c.calls(), 2);
});

test('a failed explicit rerun does not invalidate another completed range', async t => {
  const c = await setup(t);
  const first = await analyze(c, 'a1'), second = await analyze(c, 'b1');
  let failures = 0;
  const route = createLiveAnalysis({ ...c.options, modelClient: async () => { failures++; throw Object.assign(Error('private'), { code: 'MODEL_TIMEOUT' }); } });
  const result = await analyze(c, 'b1', route, { rerun: true });
  assert.equal(result.analysis.status, 'failed');
  assert.equal(result.analyses.a1.currentRunId, first.analysis.currentRunId);
  assert.equal(result.analyses.a1.stale, false);
  assert.equal((await request(route, c.root, 'GET', 'a1')).analysis.status, 'complete');
  assert.equal(failures, 1);
  assert.deepEqual((await readProductAnalysis(c.root)).analysis.candidates.map(x => x.runId), [first.analysis.currentRunId, second.analysis.currentRunId]);
});

test('configuration or input changed during execution cannot commit candidates', async t => {
  for (const kind of ['model', 'path', 'range', 'transcript']) await t.test(kind, async t => {
    const c = await setup(t); let release, entered;
    const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    const route = createLiveAnalysis({ ...c.options, modelClient: async () => { entered(); await gate; return output(); } });
    await request(route, c.root, 'POST', 'a1'); await started;
    if (kind === 'model') c.identity.model = 'changed';
    if (kind === 'transcript') c.cues[0].text = '已修改';
    if (kind === 'range' || kind === 'path') {
      const data = (await readProductAnalysis(c.root)).analysis;
      if (kind === 'range') data.intervals[0].endMs = 1900;
      else { await writeFile(join(c.root, 'assets/b.mp4'), 'synthetic'); data.sources[0].assetPath = 'assets/b.mp4'; }
      await writeProductAnalysis(c.root, data, probe);
    }
    release();
    assert.equal((await finish(route, c.root, 'a1')).analysis.status, 'failed');
    assert.equal((await readProductAnalysis(c.root)).analysis.candidates.length, 0);
  });
});

test('public model identity inspection never decrypts credentials or sends a request', async t => {
  const c = await setup(t); let credentialReads = 0, network = 0;
  const client = createDeepSeekTextClient({ getConfig: async () => { credentialReads++; throw Error('must not decrypt'); }, getPublicConfig: async () => ({ baseUrl: 'https://api.deepseek.com/v1', model: 'example-model', apiKey: 'must-not-be-returned' }), fetch: async () => { network++; } });
  const publicIdentity = await client.getCacheIdentity();
  assert.deepEqual(publicIdentity, { provider: 'deepseek', endpoint: 'https://api.deepseek.com/v1/responses', model: 'example-model', maxOutputTokens: 16384, reasoningEffort: 'low' });
  const route = createLiveAnalysis({ ...c.options, modelIdentity: undefined, modelClient: client });
  await request(route, c.root, 'GET', 'a1'); await request(route, c.root, 'GET', 'b1');
  assert.equal(credentialReads, 0); assert.equal(network, 0);
});

test('public model metadata must match the execution configuration before any request', async () => {
  let network = 0;
  const client = createDeepSeekTextClient({ getConfig: async () => ({ baseUrl: 'https://api.deepseek.com/v1', model: 'changed-model', apiKey: 'synthetic-key' }), getPublicConfig: async () => ({ baseUrl: 'https://api.deepseek.com/v1', model: 'original-model' }), fetch: async () => { network++; } });
  await assert.rejects(client({ system: 'synthetic', input: '{}' }), error => error.code === 'MODEL_INPUT_CHANGED');
  assert.equal(network, 0);
});
