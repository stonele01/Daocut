import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { confirmSampleInspectionScope, createLiveAnalysis as createRealLiveAnalysis } from './live-analysis.mjs';
import { readProductAnalysis, writeProductAnalysis } from './product-analysis.mjs';

const probe = async () => ({ duration: 10 });
const createLiveAnalysis = options => createRealLiveAnalysis({ modelIdentity: 'isolated-mock-v1', ...options });
const transcript = { cues: [{ text: '这个十元', startMs: 100, endMs: 2000 }] };
const fixture = { version: 1, sources: [{ id: 's', assetPath: 'assets/a.mp4', durationMs: 10000 }], products: [{ id: 'p', name: '商品', sourceIds: ['s'] }], intervals: [{ id: 'i', sourceId: 's', productId: 'p', startMs: 0, endMs: 10000 }], candidates: [] };
const candidate = { firstCue: 0, lastCue: 0, tags: ['价格锚点'], details: { subtypes: ['普通报价'], reason: '报价', evidence: ['ASR'], context: '', repetition: '', review: [] } };
async function setup() {
  const root = await mkdtemp(resolve('.test-temp/live-'));
  await mkdir(resolve(root, 'assets'));
  await writeFile(resolve(root, 'assets/a.mp4'), 'synthetic');
  await writeProductAnalysis(root, structuredClone(fixture), probe);
  return root;
}
async function request(route, root, method, rest, body) {
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
  req.method = method; req.url = `/api/projects/p/${rest}${method === 'GET' ? '?sourceId=s' : ''}`;
  let response;
  const res = { writeHead(status) { this.status = status; }, end(text) { response = JSON.parse(text); } };
  assert.equal(await route(req, res, root, rest), true);
  return response;
}
async function finished(route, root, type) {
  for (let i = 0; i < 100; i++) {
    const result = await request(route, root, 'GET', 'live-analysis');
    if (result[type].status !== 'running') return result;
    await new Promise(done => setTimeout(done, 10));
  }
  throw Error('task did not finish');
}
test('locked service rejects before writing and keeps existing transcript visible', async () => {
  const root = await setup();
  try {
    const route = createLiveAnalysis({ readTranscript: async () => transcript });
    await assert.rejects(request(route, root, 'POST', 'live-analysis/analyze', { sourceId: 's', confirmed: true }), /未启用/);
    await assert.rejects(stat(resolve(root, '.film/live-analysis')), { code: 'ENOENT' });
    const done = await request(route, root, 'GET', 'live-analysis');
    assert.equal(done.analysis.status, 'idle');
    assert.equal(done.transcription.segments[0].text, '这个十元');
    await assert.rejects(request(route, root, 'POST', 'live-analysis/analyze', { sourceId: 's' }), /确认/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('changed subtitles invalidate prior completed analysis', async () => {
  const root = await setup();
  try {
    let current = transcript;
    const route = createLiveAnalysis({ readTranscript: async () => current, probeSource: probe, modelClient: async () => ({ candidates: [], issues: [] }) });
    await request(route, root, 'POST', 'live-analysis/analyze', { sourceId: 's', confirmed: true });
    assert.equal((await finished(route, root, 'analysis')).analysis.status, 'complete');
    current = { cues: [{ text: '修改后的字幕', startMs: 100, endMs: 2000 }] };
    const state = await request(route, root, 'GET', 'live-analysis');
    assert.equal(state.analysis.status, 'idle');
    assert.match(state.analysis.error, /变化/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('changed source invalidates completed analysis even if captions are unchanged', async () => {
  const root = await setup();
  try {
    const route = createLiveAnalysis({ readTranscript: async () => transcript, probeSource: probe, modelClient: async () => ({ candidates: [], issues: [] }) });
    await request(route, root, 'POST', 'live-analysis/analyze', { sourceId: 's', confirmed: true });
    assert.equal((await finished(route, root, 'analysis')).analysis.status, 'complete');
    await writeFile(resolve(root, 'assets/a.mp4'), 'changed source');
    assert.equal((await request(route, root, 'GET', 'live-analysis')).analysis.status, 'idle');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('each analysis batch is identifiable and old candidates remain auditable after source changes', async () => {
  const root = await setup();
  try {
    let current = transcript;
    const route = createLiveAnalysis({ readTranscript: async () => current, probeSource: probe, modelClient: async () => ({ candidates: [candidate], issues: [] }) });
    await request(route, root, 'POST', 'live-analysis/analyze', { sourceId: 's', confirmed: true });
    const first = await finished(route, root, 'analysis');
    assert.equal(first.analysis.stale, false);
    const firstId = first.analysis.currentRunId;
    assert.ok(firstId);
    assert.equal((await readProductAnalysis(root)).analysis.candidates[0].runId, firstId);
    current = { cues: [{ text: '新的价格', startMs: 100, endMs: 2000 }] };
    assert.equal((await request(route, root, 'GET', 'live-analysis')).analysis.stale, true);
    const pending = await request(route, root, 'POST', 'live-analysis/analyze', { sourceId: 's', confirmed: true });
    assert.equal(pending.analysis.stale, true);
    const second = await finished(route, root, 'analysis');
    assert.equal(second.analysis.stale, false);
    assert.notEqual(second.analysis.currentRunId, firstId);
    const candidates = (await readProductAnalysis(root)).analysis.candidates;
    assert.deepEqual(candidates.map(c => c.runId), [firstId, second.analysis.currentRunId]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('uncertain transcription failure cannot be automatically retried', async () => {
  const root = await setup();
  try {
    let calls = 0;
    const route = createLiveAnalysis({ readTranscript: async () => null, transcribe: async () => { calls++; throw Error('uncertain'); } });
    await request(route, root, 'POST', 'live-analysis/transcribe', { sourceId: 's', confirmed: true });
    assert.equal((await finished(route, root, 'transcription')).transcription.status, 'failed');
    await assert.rejects(request(route, root, 'POST', 'live-analysis/transcribe', { sourceId: 's', confirmed: true }), /不能自动重试/);
    assert.equal(calls, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('uncertain transcription requires a confirmed explicit retry flag and concurrent retries deduplicate', async () => {
  const root = await setup(); let release;
  try {
    let calls = 0, stored = null;
    const options = { readTranscript: async () => stored, transcribe: async (_root, _source, retry) => {
      calls++;
      if (!retry.retryUncertain) throw Error('uncertain submitted request');
      await new Promise(resolve => { release = resolve; });
      stored = transcript; return stored;
    } };
    let route = createLiveAnalysis(options);
    await request(route, root, 'POST', 'live-analysis/transcribe', { sourceId: 's', confirmed: true });
    assert.equal((await finished(route, root, 'transcription')).transcription.retryBlocked, true);
    route = createLiveAnalysis(options);
    await request(route, root, 'GET', 'live-analysis');
    assert.equal(calls, 1);
    await assert.rejects(request(route, root, 'POST', 'live-analysis/transcribe', { sourceId: 's', confirmed: true }), /不能自动重试/);
    await assert.rejects(request(route, root, 'POST', 'live-analysis/transcribe', { sourceId: 's', retryUncertain: true }), /确认/);
    await assert.rejects(request(route, root, 'POST', 'live-analysis/analyze', { sourceId: 's', confirmed: true, retryUncertain: true }), /仅适用于转写/);
    const retry = { sourceId: 's', confirmed: true, retryUncertain: true };
    const results = await Promise.all(Array.from({ length: 5 }, () => request(route, root, 'POST', 'live-analysis/transcribe', retry)));
    assert.ok(results.every(result => result.transcription.status === 'running'));
    for (let n = 0; n < 100 && !release; n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(calls, 2);
    await assert.rejects(request(route, root, 'POST', 'live-analysis/transcribe', { sourceId: 's', confirmed: true }), error => error.status === 409);
    release(); release = null;
    assert.equal((await finished(route, root, 'transcription')).transcription.status, 'complete');
    await request(route, root, 'POST', 'live-analysis/transcribe', retry);
    assert.equal(calls, 2, 'complete transcription is reused even with the explicit retry flag');
  } finally { release?.(); await new Promise(resolve => setTimeout(resolve, 50)); await rm(root, { recursive: true, force: true }); }
});

test('legacy interrupted transcription remains blocked until an explicit uncertain retry', async () => {
  const root = await setup();
  try {
    const directory = resolve(root, '.film/live-analysis'); await mkdir(directory);
    const path = resolve(directory, `${createHash('sha256').update('s').digest('hex')}.json`);
    await writeFile(path, JSON.stringify({ version: 1, sourceId: 's', transcription: { status: 'running', segments: [] }, analysis: { status: 'idle' } }));
    let calls = 0, stored = null;
    const route = createLiveAnalysis({ readTranscript: async () => stored, transcribe: async (_root, _source, options) => { assert.equal(options.retryUncertain, true); calls++; stored = transcript; return stored; } });
    const before = await readFile(path, 'utf8');
    assert.equal((await request(route, root, 'GET', 'live-analysis')).transcription.status, 'failed');
    assert.equal((await request(route, root, 'POST', 'live-analysis/transcribe', { sourceId: 's', confirmed: true })).transcription.status, 'failed');
    assert.equal(calls, 0); assert.equal(await readFile(path, 'utf8'), before);
    await request(route, root, 'POST', 'live-analysis/transcribe', { sourceId: 's', confirmed: true, retryUncertain: true });
    assert.equal((await finished(route, root, 'transcription')).transcription.status, 'complete'); assert.equal(calls, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('mock analysis appends candidate and preserves intervening human edit', async () => {
  const root = await setup();
  try {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const route = createLiveAnalysis({ readTranscript: async () => transcript, probeSource: probe, modelClient: async () => { await gate; return { candidates: [candidate], issues: [] }; } });
    const started = await request(route, root, 'POST', 'live-analysis/analyze', { sourceId: 's', confirmed: true });
    assert.equal(started.analysis.status, 'running');
    const edited = (await readProductAnalysis(root)).analysis;
    edited.products[0].name = '人工修改';
    await writeProductAnalysis(root, edited, probe);
    release();
    assert.equal((await finished(route, root, 'analysis')).analysis.status, 'complete');
    const saved = (await readProductAnalysis(root)).analysis;
    assert.equal(saved.products[0].name, '人工修改');
    assert.equal(saved.candidates[0].text, '这个十元');
    assert.equal(saved.candidates[0].intervalId, 'i');
    assert.equal(saved.intervals.length, 1);
    const again = await request(route, root, 'POST', 'live-analysis/analyze', { sourceId: 's', confirmed: true });
    assert.equal(again.analysis.status, 'complete');
    assert.equal((await readProductAnalysis(root)).analysis.candidates.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('mock transcription persists completion and reopens without a second call', async () => {
  const root = await setup();
  try {
    let stored = null, calls = 0;
    const opts = { readTranscript: async () => stored, transcribe: async () => { calls++; stored = transcript; return stored; } };
    const route = createLiveAnalysis(opts);
    assert.equal((await request(route, root, 'POST', 'live-analysis/transcribe', { sourceId: 's', confirmed: true })).transcription.status, 'running');
    assert.equal((await finished(route, root, 'transcription')).transcription.status, 'complete');
    const reopened = createLiveAnalysis(opts);
    assert.equal((await request(reopened, root, 'GET', 'live-analysis')).transcription.segments[0].text, '这个十元');
    assert.equal((await request(reopened, root, 'POST', 'live-analysis/transcribe', { sourceId: 's', confirmed: true })).transcription.status, 'complete');
    assert.equal(calls, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('missing range rejects before model and never invents associations', async () => {
  const root = await setup();
  try {
    const data = (await readProductAnalysis(root)).analysis;
    data.intervals = [];
    await writeProductAnalysis(root, data, probe);
    let calls = 0;
    const route = createLiveAnalysis({ readTranscript: async () => transcript, modelClient: async () => { calls++; } });
    await assert.rejects(request(route, root, 'POST', 'live-analysis/analyze', { sourceId: 's', confirmed: true }), /明确指定有效/);
    assert.equal(calls, 0);
    assert.deepEqual((await readProductAnalysis(root)).analysis.intervals, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('model error diagnostics persist only allowlisted information', async () => {
  for (const [code, expected] of [['MODEL_TIMEOUT', '模型请求超时'], ['MODEL_HTTP', '模型服务返回 HTTP 错误 429'], ['MODEL_INCOMPLETE', '模型响应未完成或达到输出上限'], ['MODEL_INVALID_JSON', '模型输出 JSON 无效'], ['MODEL_INPUT_CHANGED', '本地授权输入已变化或不可读取'], ['MODEL_CONSTRAINT', '模型结果违反格式或来源约束']]) {
    const root = await setup();
    try {
      const route = createLiveAnalysis({ readTranscript: async () => transcript, modelClient: async () => { throw Object.assign(Error('synthetic-private'), { code, httpStatus: 429 }); } });
      await request(route, root, 'POST', 'live-analysis/analyze', { sourceId: 's', confirmed: true });
      const state = await finished(route, root, 'analysis');
      assert.equal(state.analysis.error, expected);
      assert.ok(!JSON.stringify(state.analysis).includes('synthetic-private'));
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
test('confirmed sample inspection scope is separate from lecture intervals and stable', async () => {
  const root = await setup();
  try {
    const data = (await readProductAnalysis(root)).analysis;
    data.sources[0].assetPath = 'assets/氨基酸2023.6.1.mp4';
    data.sources[0].durationMs = 132470;
    data.intervals = [];
    await writeProductAnalysis(root, data, async () => ({ duration: 132.47 }));
    const before = await readProductAnalysis(root);
    await confirmSampleInspectionScope(root, { sourceId: 's', productId: 'p', intervalId: 'scope-1' }, async () => ({ duration: 132.47 }));
    const after = await readProductAnalysis(root);
    assert.deepEqual(after.history, before.history);
    await confirmSampleInspectionScope(root, { sourceId: 's', productId: 'p', intervalId: 'scope-1' }, async () => ({ duration: 132.47 }));
    assert.deepEqual(await readProductAnalysis(root), after);
    const saved = after.analysis;
    assert.deepEqual(saved.intervals, []);
    assert.deepEqual(saved.scopes, [{ id: 'scope-1', sourceId: 's', productId: 'p', startMs: 0, endMs: 132470, kind: 'confirmed-inspection', confirmed: true }]);
    saved.scopes.push({ ...saved.scopes[0] });
    await assert.rejects(writeProductAnalysis(root, saved, async () => ({ duration: 132.47 })), /invalid inspection scope/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('concurrent confirmed requests for one source issue only one model call', async () => {
  const root = await setup();
  try {
    let calls = 0, release;
    const gate = new Promise(resolve => { release = resolve; });
    const route = createLiveAnalysis({ readTranscript: async () => transcript, probeSource: probe, modelClient: async () => { calls++; await gate; return { candidates: [candidate], issues: [] }; } });
    await assert.rejects(request(route, root, 'POST', 'live-analysis/analyze', { sourceId: 's' }), /确认/);
    await Promise.all(Array.from({ length: 5 }, () => request(route, root, 'POST', 'live-analysis/analyze', { sourceId: 's', intervalId: 'i', confirmed: true })));
    for (let i = 0; i < 100 && calls === 0; i++) await new Promise(done => setTimeout(done, 10));
    assert.equal(calls, 1);
    release();
    assert.equal((await finished(route, root, 'analysis')).analysis.status, 'complete');
    assert.equal((await readProductAnalysis(root)).analysis.candidates.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('explicit rerun appends a new batch without changing existing data', async () => {
  const root = await setup();
  try {
    let calls = 0;
    const route = createLiveAnalysis({ readTranscript: async () => transcript, probeSource: probe, modelClient: async () => { calls++; return { candidates: [candidate], issues: [] }; } });
    await request(route, root, 'POST', 'live-analysis/analyze', { sourceId: 's', confirmed: true });
    const first = await finished(route, root, 'analysis');
    await request(route, root, 'POST', 'live-analysis/analyze', { sourceId: 's', confirmed: true });
    assert.equal(calls, 1);
    await request(route, root, 'POST', 'live-analysis/analyze', { sourceId: 's', confirmed: true, rerun: true });
    const next = await finished(route, root, 'analysis');
    assert.notEqual(first.analysis.currentRunId, next.analysis.currentRunId);
    assert.equal(calls, 2);
    assert.equal((await readProductAnalysis(root)).analysis.candidates.length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('safe pre-upload failures explain manual retry and never invoke provider', async () => {
  const { transcribeProductSource } = await import('./product-transcription.mjs');
  for (const reason of ['configuration', 'audio']) {
    const root = await setup();
    try {
      let ready = false, uploads = 0;
      const options = {
        getKey: async () => reason === 'configuration' && !ready ? null : 'synthetic-key',
        readAudio: async () => { if (reason === 'audio' && !ready) throw Error('synthetic ffmpeg failure'); return Buffer.from('synthetic'); },
        runProvider: async () => { uploads++; return { index: [{ text: '示例。', words: [{ token: '示例', start: 0, end: 1 }], cues: [{ text: '示例。', startMs: 0, endMs: 1000 }] }] }; },
      };
      const route = createLiveAnalysis({ transcribe: (project, source) => transcribeProductSource(project, source, options) });
      await request(route, root, 'POST', 'live-analysis/transcribe', { sourceId: 's', confirmed: true });
      const failed = await finished(route, root, 'transcription');
      assert.equal(failed.transcription.status, 'failed');
      assert.equal(failed.transcription.retryBlocked, false);
      assert.match(failed.transcription.error, /音频未上传；处理后可手动重试/);
      assert.equal(uploads, 0);
      ready = true;
      await request(route, root, 'POST', 'live-analysis/transcribe', { sourceId: 's', confirmed: true });
      assert.equal((await finished(route, root, 'transcription')).transcription.status, 'complete');
      assert.equal(uploads, 1);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
