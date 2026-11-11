import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, utimes } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { createProductDiscovery } from './product-discovery-route.mjs';
import * as discoveryRules from './product-discovery.mjs';
import { DISCOVER_PRODUCTS_PROMPT } from './approved-prompts.mjs';
import { productAnalysisRoute, readProductAnalysis, recordProductEdit, updateProductAnalysis, writeProductAnalysis } from './product-analysis.mjs';

const base = resolve(import.meta.dirname, '../../../../.tmp/product-discovery-route');
const probe = async () => ({ duration: 30 });
const transcript = { cues: Array.from({ length: 12 }, (_, n) => ({ text: `${n}号虚构商品完整讲解` .repeat(4), startMs: n * 1000, endMs: n * 1000 + 900 })) };
const initial = { version: 1, sources: [{ id: 's', assetPath: 'assets/a.mp4', durationMs: 30000 }], products: [], intervals: [], candidates: [] };
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
function route(options = {}) { return createProductDiscovery({ modelIdentity: 'isolated-mock', readTranscript: async () => transcript, probeSource: probe, ...options }); }
async function request(route, root, method, rest, body) {
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []); req.method = method; req.url = `/api/projects/p/${rest}?sourceId=s`;
  let output; const res = { writeHead(status) { this.status = status; }, end(text) { output = JSON.parse(text); } };
  assert.equal(await route(req, res, root, rest), true); return output;
}
const get = (r, root) => request(r, root, 'GET', 'product-discovery');
const start = (r, root, extra = {}) => request(r, root, 'POST', 'product-discovery/discover', { sourceId: 's', confirmed: true, ...extra });
async function finish(r, root) { for (let n = 0; n < 200; n++) { const value = await get(r, root); if (value.status !== 'running') return value; await new Promise(resolve => setTimeout(resolve, 5)); } throw Error('mock did not finish'); }
const apply = (r, root, runId, expected, extra = {}) => request(r, root, 'POST', 'product-discovery/apply', { sourceId: 's', confirmed: true, runId, expected, ...extra });

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const discoveryContract = (prompt, { model = 'isolated-mock', maxBytes = 24000, contextCues = 3 } = {}) => hash({ publicModelHash: hash(model), promptHash: hash(prompt), algorithmVersion: discoveryRules.DISCOVERY_VERSION, windowPolicy: { maxBytes, contextCues, knownProductBytes: 8000 } });
async function savedRun(root) { const dir = join(root, '.film/product-discovery'), file = join(dir, (await readdir(dir))[0]); return { file, state: JSON.parse(await readFile(file, 'utf8')) }; }
async function previousPromptRecord(root, policy = {}) {
  // Represent an existing paid record in the pre-upgrade on-disk schema. The
  // synthetic model output is deliberately unchanged; no legacy model is called.
  const { file, state } = await savedRun(root);
  state.runs.at(-1).contractHash = discoveryContract(discoveryRules.PREVIOUS_DISCOVERY_PROMPT ?? discoveryRules.DISCOVERY_PROMPT, policy);
  delete state.runs.at(-1).promptHash;
  await writeFile(file, JSON.stringify(state));
  return { file, state };
}

test('approved discovery prompt is actually sent and receives a distinct current request contract', async t => {
  const root = await setup(t), systems = [];
  const r = route({ modelClient: async input => { systems.push(input.system); return response(input); } });
  await start(r, root); assert.equal((await finish(r, root)).status, 'complete');
  assert.deepEqual(systems, [DISCOVER_PRODUCTS_PROMPT]);
  const { state } = await savedRun(root), run = state.runs[0];
  assert.equal(run.contractHash, discoveryContract(DISCOVER_PRODUCTS_PROMPT));
  assert.notEqual(run.contractHash, discoveryContract(discoveryRules.PREVIOUS_DISCOVERY_PROMPT));
  assert.equal(run.promptHash, hash(DISCOVER_PRODUCTS_PROMPT));
  assert.equal((await r.sharedContract()).prompt, hash(DISCOVER_PRODUCTS_PROMPT));
});

test('completed previous-prompt discovery is reused and applied without rewriting its original contract', async t => {
  const root = await setup(t); let calls = 0;
  const options = { modelClient: async input => { calls++; return response(input); } };
  const first = route(options); await start(first, root); const complete = await finish(first, root);
  const legacy = await previousPromptRecord(root), before = await readFile(legacy.file, 'utf8');
  const reopened = route(options), view = await get(reopened, root);
  assert.equal(view.stale, false); assert.equal(view.runId, complete.runId);
  assert.equal((await reopened.plan(root, 's')).cached, true);
  await start(reopened, root); assert.equal(calls, 1);
  assert.equal(await readFile(legacy.file, 'utf8'), before, 'read/reuse must preserve the original paid record verbatim');
  const applied = await apply(reopened, root, complete.runId, initial);
  assert.equal(applied.analysis.products[0].name, '模拟甲');
  assert.equal((await get(reopened, root)).stale, false);
  assert.deepEqual((await savedRun(root)).state.runs, legacy.state.runs, 'applying adds application history without changing original prompt identity');
  assert.equal(await readFile(join(root, 'film.html'), 'utf8'), 'unchanged-film');
});

test('previous-prompt incomplete windows remain blocked until an explicitly new run and never mix rules', async t => {
  const root = await setup(t), systems = []; let calls = 0;
  const policy = { maxBytes: 500, contextCues: 1 };
  const first = route({ ...policy, modelClient: async input => { calls++; if (calls === 2) throw Error('uncertain'); return response(input); } });
  await start(first, root); const failed = await finish(first, root);
  assert.equal(failed.status, 'failed'); assert.equal(failed.runs[0].completedWindows, 1);
  const legacy = await previousPromptRecord(root, policy), before = await readFile(legacy.file, 'utf8');
  const reopened = route({ ...policy, modelClient: async input => { calls++; systems.push(input.system); return response(input); } });
  const view = await get(reopened, root), plan = await reopened.plan(root, 's', { retry: true });
  assert.equal(view.status, 'failed'); assert.equal(view.canRetry, false);
  assert.match(view.error, /旧提示词|规则.*变化/);
  assert.equal(plan.cached, false); assert.equal(plan.rerunRequired, true); assert.equal(plan.reusedRequests, 0);
  await assert.rejects(start(reopened, root), { status: 409 });
  await assert.rejects(start(reopened, root, { retry: true }), { status: 409 });
  assert.equal(calls, 2); assert.equal(await readFile(legacy.file, 'utf8'), before);
  await start(reopened, root, { rerun: true }); assert.equal((await finish(reopened, root)).status, 'complete');
  assert.ok(systems.length > 1); assert.ok(systems.every(system => system === DISCOVER_PRODUCTS_PROMPT));
  const saved = (await savedRun(root)).state;
  assert.deepEqual(saved.runs[0], legacy.state.runs[0], 'the old failed request and its paid windows must remain unchanged');
  assert.notEqual(saved.runs[1].contractHash, saved.runs[0].contractHash);
  assert.equal(saved.runs[1].completed.length, systems.length, 'new rules start their own windows rather than borrowing old paid output');
});

test('previous-prompt completed reuse still requires matching model, transcript and window policy', async t => {
  const root = await setup(t); let calls = 0;
  const client = async input => { calls++; return response(input); };
  const first = route({ modelClient: client }); await start(first, root); const complete = await finish(first, root);
  await previousPromptRecord(root);
  for (const options of [{ modelIdentity: 'other' }, { maxBytes: 23000 }, { contextCues: 2 }, { readTranscript: async () => ({ cues: transcript.cues.map((cue, index) => index ? cue : { ...cue, text: '已修改转写' }) }) }]) {
    const changed = route({ modelClient: client, ...options });
    assert.equal((await get(changed, root)).stale, true);
    assert.equal((await changed.plan(root, 's')).cached, false);
    await assert.rejects(start(changed, root), { status: 409 });
    await assert.rejects(apply(changed, root, complete.runId, initial), { status: 409 });
  }
  assert.equal(calls, 1);
});

test('output budget upgrade keeps a completed product split reusable without a new request', async t => {
  const root = await setup(t); let calls = 0;
  let identity = { provider: 'deepseek', endpoint: 'https://api.deepseek.com/responses', model: 'deepseek-flash', maxOutputTokens: 16384, reasoningEffort: 'low' };
  const options = { modelIdentity: () => identity, modelClient: async input => { calls++; return response(input); } };
  const first = route(options); await start(first, root); const completed = await finish(first, root);
  assert.equal(completed.status, 'complete'); const before = calls;
  identity = { ...identity, maxOutputTokens: 32768, outputFormat: 'json_object' };
  const reopened = route(options), state = await get(reopened, root);
  assert.equal(state.stale, false); assert.equal(state.runId, completed.runId);
  assert.equal((await reopened.plan(root, 's')).cached, true);
  await start(reopened, root); assert.equal(calls, before);
  assert.equal(await readFile(join(root, 'film.html'), 'utf8'), 'unchanged-film');
});

test('closed and unknown-identity services do not call a model or create task files', async t => {
  const root = await setup(t); let calls = 0;
  const locked = route(); assert.equal((await get(locked, root)).status, 'idle');
  await assert.rejects(start(locked, root), { status: 403 });
  const unknown = route({ modelIdentity: undefined, modelClient: async () => { calls++; } });
  await assert.rejects(start(unknown, root), { status: 409 }); assert.equal(calls, 0);
  await assert.rejects(readdir(join(root, '.film/product-discovery')), { code: 'ENOENT' });
});

test('legacy project rename with an expected snapshot records manual provenance before first discovery', async t => {
  const root = await setup(t);
  const before = { ...structuredClone(initial), products: [{ id: 'manual', name: '原商品名', sourceIds: ['s'] }] };
  await writeProductAnalysis(root, before, probe);
  const next = structuredClone(before); next.products[0].name = '人工首次改名';
  await request(productAnalysisRoute, root, 'PUT', 'product-analysis', { analysis: next, expected: before });
  const saved = (await readProductAnalysis(root)).analysis;
  assert.equal(saved.manualEdits.length, 1); assert.equal(saved.manualEdits[0].before.products[0].name, '原商品名');
  assert.equal(saved.manualEdits[0].after.products[0].name, '人工首次改名');
  assert.deepEqual(saved.manualEdits[0].sourceIds, ['s']);
});

test('proposal stays separate, explicit application persists, and reopen never reanalyzes', async t => {
  const root = await setup(t); let calls = 0;
  const options = { modelClient: async input => { calls++; return response(input); } }; const r = route(options);
  await start(r, root); const completed = await finish(r, root); assert.equal(completed.status, 'complete');
  assert.deepEqual((await readProductAnalysis(root)).analysis, initial);
  const result = await apply(r, root, completed.runId, initial);
  assert.equal(result.analysis.products[0].name, '模拟甲'); assert.equal(result.analysis.manualEdits[0].action, 'apply-proposal');
  const reopened = route(options); assert.equal((await get(reopened, root)).stale, false); await start(reopened, root); assert.equal(calls, 1);
  assert.equal(await readFile(join(root, 'film.html'), 'utf8'), 'unchanged-film'); assert.equal(await readFile(join(root, 'assets/a.mp4'), 'utf8'), 'synthetic');
});

test('manual rename and range edits survive rerun; applying replacement requires reviewed diff and current snapshot', async t => {
  const root = await setup(t); const r = route({ modelClient: async input => response(input) });
  await start(r, root); const first = await finish(r, root); await apply(r, root, first.runId, initial);
  const before = (await readProductAnalysis(root)).analysis, renamed = structuredClone(before); renamed.products[0].name = '人工改名';
  await request(productAnalysisRoute, root, 'PUT', 'product-analysis', { analysis: renamed, expected: before });
  let manual = (await readProductAnalysis(root)).analysis; assert.equal(manual.manualEdits.at(-1).action, 'manual-save');
  await updateProductAnalysis(root, current => { const next = structuredClone(current); next.intervals[0].startMs = 100; return recordProductEdit(current, next); }, probe);
  manual = (await readProductAnalysis(root)).analysis;
  await start(r, root, { rerun: true }); const second = await finish(r, root);
  assert.equal((await readProductAnalysis(root)).analysis.products[0].name, '人工改名'); assert.equal(second.difference.manualEdits, true);
  await assert.rejects(apply(r, root, second.runId, before, { replaceReviewed: true }), { status: 409 });
  await assert.rejects(apply(r, root, second.runId, manual), { status: 409 });
  const applied = await apply(r, root, second.runId, manual, { replaceReviewed: true });
  assert.equal(applied.analysis.manualEdits.at(-1).before.products[0].name, '人工改名');
  assert.equal(applied.analysis.manualEdits.at(-1).before.intervals[0].startMs, 100);
  assert.equal((await get(route({ modelClient: response }), root)).runs.length, 2);
});

test('same concurrent request deduplicates and conflicting rerun is rejected', async t => {
  const root = await setup(t); let calls = 0, release; const gate = new Promise(resolve => { release = resolve; });
  const r = route({ modelClient: async input => { calls++; await gate; return response(input); } });
  await Promise.all([start(r, root), start(r, root)]); assert.equal(calls, 1);
  await assert.rejects(start(r, root, { rerun: true }), { status: 409 }); release(); assert.equal((await finish(r, root)).status, 'complete');
});

test('applying a proposal reserves the source before asynchronous reads and rejects discover or apply races', async t => {
  const root = await setup(t); let calls = 0, block = false, entered, release;
  const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const r = route({ readTranscript: async () => { if (block) { entered(); await gate; } return transcript; }, modelClient: async input => { calls++; return response(input); } });
  await start(r, root); const completed = await finish(r, root);
  block = true; const saving = apply(r, root, completed.runId, initial); await ready;
  await assert.rejects(start(r, root, { rerun: true }), { status: 409 });
  await assert.rejects(apply(r, root, completed.runId, initial), { status: 409 });
  release(); const saved = await saving; assert.equal(saved.analysis.products.length, 1); assert.equal(calls, 1);
  const folder = join(root, '.film/product-discovery'), state = JSON.parse(await readFile(join(folder, (await readdir(folder))[0]), 'utf8'));
  assert.equal(state.runs.length, 1); assert.equal(state.applications.length, 1);
});

test('queued application rechecks public model and input identity before writing effective ranges', async t => {
  const root = await setup(t); let identity = 'before', entered, release;
  const r = route({ modelIdentity: () => identity, modelClient: async input => response(input) });
  await start(r, root); const completed = await finish(r, root);
  const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const blockedWrite = updateProductAnalysis(root, async data => { entered(); await gate; return data; }, probe);
  await ready;
  const saving = apply(r, root, completed.runId, initial);
  await new Promise(resolve => setTimeout(resolve, 20));
  identity = 'after'; release(); await blockedWrite;
  await assert.rejects(saving, { status: 409 });
  assert.deepEqual((await readProductAnalysis(root)).analysis, initial);
  assert.equal((await get(r, root)).stale, true);
});

test('failed multi-window task retries explicitly and reuses completed windows after reopening', async t => {
  const root = await setup(t); let calls = 0;
  const r = route({ maxBytes: 500, contextCues: 1, modelClient: async input => { calls++; if (calls === 2) throw Error('uncertain'); return response(input); } });
  await start(r, root); const failed = await finish(r, root); assert.equal(failed.status, 'failed'); assert.equal(failed.runs[0].completedWindows, 1);
  const reopened = route({ maxBytes: 500, contextCues: 1, modelClient: async input => { calls++; return response(input); } });
  await get(reopened, root); assert.equal(calls, 2); await assert.rejects(start(reopened, root), { status: 409 });
  await start(reopened, root, { retry: true }); const done = await finish(reopened, root); assert.equal(done.status, 'complete'); assert.equal(calls, done.proposal.windows + 1);
});

test('source, transcript, duration, model and window policy changes invalidate cached proposals without model calls on GET', async t => {
  const root = await setup(t); let calls = 0; const client = async input => { calls++; return response(input); };
  const r = route({ modelClient: client }); await start(r, root); const done = await finish(r, root); assert.equal(calls, 1);
  for (const options of [
    { modelIdentity: 'other-model' }, { maxBytes: 23000 }, { contextCues: 2 }, { probeSource: async () => ({ duration: 31 }) },
    { readTranscript: async () => ({ cues: transcript.cues.map((c, n) => n ? c : { ...c, text: '修改转写' }) }) },
  ]) { const changed = route({ modelClient: client, ...options }); assert.equal((await get(changed, root)).stale, true); await assert.rejects(start(changed, root), { status: 409 }); await assert.rejects(apply(changed, root, done.runId, initial), { status: 409 }); }
  await writeFile(join(root, 'assets/a.mp4'), 'changed-source'); assert.equal((await get(r, root)).stale, true);
  assert.equal(calls, 1);
});

test('input or public model identity changes during a request reject completed proposal', async t => {
  for (const kind of ['model', 'range']) {
    const root = await setup(t); let identity = 'before', release; const gate = new Promise(resolve => { release = resolve; });
    const r = route({ modelIdentity: () => identity, modelClient: async input => { await gate; return response(input); } });
    await start(r, root);
    if (kind === 'model') identity = 'after';
    else await updateProductAnalysis(root, data => { data.products.push({ id: 'manual', name: '人工新增', sourceIds: ['s'] }); return data; }, probe);
    release(); const result = await finish(r, root); assert.equal(result.status, 'failed'); assert.equal(result.proposal, undefined);
    assert.equal((await readProductAnalysis(root)).analysis.intervals.length, 0);
  }
});

test('same-size source replacement with restored mtime and old prompt identity are stale without paid calls', async t => {
  const root = await setup(t); let calls = 0;
  await utimes(join(root, 'assets/a.mp4'), 1700000000, 1700000000);
  const r = route({ modelClient: async input => { calls++; return response(input); } });
  await start(r, root); await finish(r, root);
  const dir = join(root, '.film/product-discovery'), file = join(dir, (await readdir(dir))[0]);
  const original = await readFile(file, 'utf8'); const old = JSON.parse(original); old.runs[0].contractHash = 'older-prompt-or-version';
  await writeFile(file, JSON.stringify(old)); assert.equal((await get(r, root)).stale, true); assert.equal(calls, 1);
  await writeFile(file, original);
  const { stat } = await import('node:fs/promises'); const source = join(root, 'assets/a.mp4'), before = await stat(source);
  await new Promise(resolve => setTimeout(resolve, 25)); await writeFile(source, 'replaced!'); await utimes(source, before.atime, before.mtime);
  const current = await stat(source); assert.equal(current.size, before.size); assert.equal(current.mtimeMs, before.mtimeMs);
  assert.equal((await get(r, root)).stale, true); assert.equal(calls, 1);
  assert.equal(await readFile(file, 'utf8'), original, 'GET performs no task-state write');
});

test('invalid model references remain failed with no effective products or proposal', async t => {
  const root = await setup(t); const r = route({ modelClient: async input => { const result = response(input); result.ranges[0].lastCue = 9000; return result; } });
  await start(r, root); const result = await finish(r, root); assert.equal(result.status, 'failed'); assert.equal(result.proposal, undefined); assert.deepEqual((await readProductAnalysis(root)).analysis, initial);
});
