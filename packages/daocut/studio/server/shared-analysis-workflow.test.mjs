import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createSharedAnalysis, sharedHash } from './shared-analysis.mjs';
import { createLiveAnalysis } from './live-analysis.mjs';
import { createProductDiscovery } from './product-discovery-route.mjs';
import { createProductWorkflow } from './product-workflow.mjs';
import { readProductTranscript, transcriptionLocation } from './product-transcription.mjs';
import { readProductAnalysis, updateProductAnalysis } from './product-analysis.mjs';
import { applyProductEdit } from '../ui/src/lib/product-manual.ts';
import { createStructurePlanInputReader, createStructurePlans } from './structure-plans.mjs';

const probe = async () => ({ duration: 20 });
const details = { subtypes: [], reason: '模拟完整原话', evidence: ['ASR'], context: '', repetition: '', review: [] };

test('first analysis of a manually selected range is shared and reused without publishing private product names', async t => {
  const f = await fixture(t);
  for (const index of [0, 1]) {
    await f.run(index, 'transcription');
    await updateProductAnalysis(f.roots[index], data => applyProductEdit(data, { type: 'range', id: 'manual-range', sourceId: 'assets/live.mp4', productId: 'manual-product', newProductName: `private-name-${index}`, startMs: 0, endMs: 3500 }), probe);
  }
  const scope = { productId: 'manual-product', intervalId: 'manual-range' };
  const first = await f.run(0, 'analysis', scope);
  assert.notEqual(first.shared.mode, 'local-only');
  const before = f.counts();
  const second = await f.run(1, 'analysis', scope);
  assert.equal(second.shared.mode, 'reuse');
  assert.deepEqual(f.counts(), before);
  const state = (await readProductAnalysis(f.roots[1])).analysis;
  assert.equal(state.products[0].name, 'private-name-1');
  assert.equal(state.candidates.length, 1);
});
async function fixture(t) {
  const base = resolve('../../.tmp/shared-live-20261104/backend'); await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, 'workflow-')); t.after(() => rm(dir, { recursive: true, force: true }));
  t.mock.method(globalThis, 'fetch', () => { throw Error('real network forbidden'); });
  const tasks = new Map(); let serial = 0, asr = 0, text = 0, gate, fail = false, asrError, nextModelResult;
  const coordinate = async (op, body) => {
    let task = tasks.get(body.taskKey);
    if (op === 'status') return { task: structuredClone(task ?? null) };
    if (op === 'claim' || op === 'retry') {
      if (task && op === 'claim') return { task: structuredClone(task), acquired: false };
      if (op === 'retry') assert.equal(body.inputHash, task.inputHash, 'match the company coordinator same-input requirement');
      task = { taskKey: body.taskKey, inputHash: body.inputHash, status: 'claimed', attemptId: `attempt-${++serial}` }; tasks.set(body.taskKey, task); return { task: structuredClone(task), acquired: true };
    }
    assert.equal(body.attemptId, task.attemptId);
    if (op === 'submitted') { const sendAllowed = task.status === 'claimed'; task.status = 'submitted'; return { task: structuredClone(task), sendAllowed }; }
    if (op === 'complete') { task.status = 'complete'; task.result = body.result; }
    if (op === 'fail') task.status = body.reason === 'needs-review' ? 'needs-review' : 'uncertain';
    return { task: structuredClone(task) };
  };
  const cues = ['商品A第一句。', '商品A第二句。', '商品B第一句。', '商品B第二句。', '商品A再次回来。', '商品A最后一句。'].map((text, i) => ({ startMs: i * 2000, endMs: i * 2000 + 1500, text }));
  const service = { transcription: { enabled: true, provider: 'doubao', model: 'mock-asr' }, text: { enabled: true, provider: 'deepseek', model: 'mock-text' } };
  const modelClient = async ({ input }) => {
    text++; if (gate) await gate; if (fail) throw Error('mock uncertain request');
    if (nextModelResult) { const result = nextModelResult; nextModelResult = undefined; return result; }
    const value = JSON.parse(input);
    return value.intervalId ? { candidates: [{ firstCue: 0, lastCue: value.cues.length - 1, tags: ['卖点'], details }], issues: [] }
      : { products: [{ key: 'A', name: '商品A', aliases: [], variant: '', evidence: [0] }, { key: 'B', name: '商品B', aliases: [], variant: '', evidence: [2] }], ranges: [{ key: 'A', firstCue: 0, lastCue: 1, kind: 'lecture', reason: '讲解证据', evidence: [0] }, { key: 'B', firstCue: 2, lastCue: 3, kind: 'lecture', reason: '讲解证据', evidence: [2] }, { key: 'A', firstCue: 4, lastCue: 5, kind: 'lecture', reason: '讲解证据', evidence: [4] }], issues: [] };
  };
  const transcribe = async (root, source) => {
    asr++; if (asrError) throw asrError; const loc = await transcriptionLocation(root, source); await mkdir(loc.dir, { recursive: true });
    await writeFile(loc.path, JSON.stringify({ version: 1, status: 'complete', sourceId: source.id, assetPath: source.assetPath, fingerprint: loc.fingerprint, durationMs: source.durationMs, cues, words: [] }));
    return { cues, words: [] };
  };
  const settings = () => ({ enabled: true, resultRoots: [{ libraryId: 'library-test', root: join(dir, 'shared') }] });
  const reviewed = new Map(), readTranscript = (root, source) => reviewed.get(root) ?? readProductTranscript(root, source);
  const make = extra => {
    const live = createLiveAnalysis({ transcribe, modelClient, modelIdentity: () => service.text, probeSource: probe, readTranscript });
    const discovery = createProductDiscovery({ modelClient, modelIdentity: () => service.text, probeSource: probe, readTranscript });
    const shared = createSharedAnalysis({ coordinate, settings, readManifest: async () => ({ items: { 'assets/live.mp4': { libraryId: 'library-test', relativePath: 'show/live.mp4' } } }), ...extra });
    return createProductWorkflow({ liveAnalysis: live, discovery, sharedAnalysis: shared, analysisServices: async () => service, probeSource: probe, readTranscript });
  };
  const roots = [join(dir, 'a'), join(dir, 'b')], workflows = [make(), make()];
  for (let i = 0; i < roots.length; i++) { await mkdir(join(roots[i], 'assets'), { recursive: true }); await writeFile(join(roots[i], 'assets/live.mp4'), 'synthetic live'); await writeFile(join(roots[i], 'film.html'), 'original film'); await mkdir(join(roots[i], '.film')); await writeFile(join(roots[i], '.film/source-takes.json'), 'private original takes'); await workflows[i].registerSource(roots[i], { assetPath: 'assets/live.mp4' }); }
  const run = async (person, action, extra = {}, ack = {}) => { const workflow = workflows[person], root = roots[person], plan = await workflow.plan(root, { sourceId: 'assets/live.mp4', action, ...extra }); await workflow.execute(root, { confirmed: true, plan, ...ack }); await workflow.wait(root, 'assets/live.mp4'); return plan; };
  const shared = () => createSharedAnalysis({ coordinate, settings, readManifest: async () => ({ items: { 'assets/live.mp4': { libraryId: 'library-test', relativePath: 'show/live.mp4' } } }) });
  return { roots, workflows, make, run, tasks, cues, service, shared, counts: () => ({ asr, text }), setGate: value => { gate = value; }, setModelResult: value => { nextModelResult = value; }, fail: value => { fail = value; }, asrError: value => { asrError = value; }, review: person => reviewed.set(roots[person], { cues, words: [], localReconciled: true }) };
}
test('output budget upgrade can explicitly recover a shared failure and colleagues reuse the completed result', async t => {
  for (const action of ['discovery', 'analysis']) await t.test(action, async t => {
    const f = await fixture(t);
    Object.assign(f.service.text, { endpoint: 'https://api.deepseek.com/responses', maxOutputTokens: 16384, reasoningEffort: 'low' });
    await f.run(0, 'transcription'); let scope = {};
    if (action === 'analysis') {
      await f.run(0, 'discovery');
      const { analysis } = await readProductAnalysis(f.roots[0]);
      scope = { productId: analysis.intervals[0].productId, intervalId: analysis.intervals[0].id };
    }
    f.fail(true); await f.run(0, action, scope); const before = f.counts();
    Object.assign(f.service.text, { maxOutputTokens: 32768, outputFormat: 'json_object' });
    f.workflows[0] = f.make();
    const plan = await f.workflows[0].plan(f.roots[0], { action, sourceId: 'assets/live.mp4', ...scope, retry: true });
    assert.equal(plan.shared.mode, 'retry-required'); assert.deepEqual(f.counts(), before);
    await assert.rejects(f.workflows[0].execute(f.roots[0], { confirmed: true, plan }));
    assert.deepEqual(f.counts(), before);
    f.fail(false); await f.run(0, action, { ...scope, retry: true }, { retryAcknowledged: true });
    assert.equal(f.counts().text, before.text + 1);
    await f.run(1, 'transcription'); assert.equal((await f.run(1, 'discovery')).shared.mode, 'reuse');
    if (action === 'analysis') {
      const { analysis } = await readProductAnalysis(f.roots[1]);
      const otherScope = { productId: analysis.intervals[0].productId, intervalId: analysis.intervals[0].id };
      assert.equal((await f.run(1, 'analysis', otherScope)).shared.mode, 'reuse');
    }
    assert.equal(f.counts().text, before.text + 1);
    for (const root of f.roots) assert.equal(await readFile(join(root, 'film.html'), 'utf8'), 'original film');
  });
});

test('combined preparation publishes both stages and a coworker reuses them without new service calls', async t => {
  const f = await fixture(t);
  await f.run(0, 'transcription', { prepare: true });
  assert.deepEqual(f.counts(), { asr: 1, text: 1 });
  await f.run(1, 'transcription', { prepare: true });
  assert.deepEqual(f.counts(), { asr: 1, text: 1 });
  for (const root of f.roots) {
    const analysis = (await readProductAnalysis(root)).analysis;
    assert.equal(analysis.products.length, 2); assert.equal(analysis.intervals.length, 3);
  }
});

test('ordinary three-stage workflow reuses shared first results across projects and preserves A-B-A and private edits', async t => {
  const f = await fixture(t);
  await f.run(0, 'transcription'); await f.run(0, 'discovery');
  const first = (await readProductAnalysis(f.roots[0])).analysis;
  assert.equal(first.products.length, 2); assert.equal(first.intervals.length, 3);
  const firstScope = { productId: first.intervals[0].productId, intervalId: first.intervals[0].id };
  await f.run(0, 'analysis', firstScope); assert.deepEqual(f.counts(), { asr: 1, text: 2 });
  assert.equal((await f.run(1, 'transcription')).shared.mode, 'reuse');
  assert.equal((await f.run(1, 'discovery')).shared.mode, 'reuse');
  const second = (await readProductAnalysis(f.roots[1])).analysis, scope = { productId: second.intervals[0].productId, intervalId: second.intervals[0].id };
  assert.equal(second.intervals.filter(i => i.productId === scope.productId).length, 2);
  assert.equal((await f.run(1, 'analysis', scope)).shared.mode, 'reuse');
  assert.deepEqual(f.counts(), { asr: 1, text: 2 });
  await updateProductAnalysis(f.roots[1], data => { data.products[0].name = '本机人工名字'; return data; }, probe);
  f.workflows[1] = f.make(); await f.run(1, 'analysis', scope);
  const saved = (await readProductAnalysis(f.roots[1])).analysis; assert.equal(saved.products[0].name, '本机人工名字'); assert.equal(saved.candidates.length, 1);
  assert.equal(saved.candidates[0].text, f.cues.slice(0, 2).map(c => c.text).join(''));
  assert.deepEqual(f.counts(), { asr: 1, text: 2 });
  for (const root of f.roots) { assert.equal(await readFile(join(root, 'film.html'), 'utf8'), 'original film'); assert.equal(await readFile(join(root, '.film/source-takes.json'), 'utf8'), 'private original takes'); }
});
test('two simulated computers analyze different segments concurrently and reuse both saved results', async t => {
  const f = await fixture(t);
  await f.run(0, 'transcription', { prepare: true });
  await f.run(1, 'transcription', { prepare: true });
  const scopes = await Promise.all(f.roots.map(async (root, index) => {
    const { analysis } = await readProductAnalysis(root);
    const interval = analysis.intervals[index];
    return { productId: interval.productId, intervalId: interval.id };
  }));
  const before = f.counts();
  let release;
  f.setGate(new Promise(resolve => { release = resolve; }));
  try {
    const running = f.workflows.map((workflow, index) => f.run(index, 'analysis', scopes[index]));
    for (let n = 0; n < 200 && f.counts().text < before.text + 2; n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.counts().text, before.text + 2, 'both distinct model requests are in flight together');
    release();
    await Promise.all(running);
    f.setGate(null);
    for (let index = 0; index < 2; index++) {
      const other = 1 - index;
      const { analysis } = await readProductAnalysis(f.roots[other]);
      const interval = analysis.intervals[index];
      const plan = await f.run(other, 'analysis', { productId: interval.productId, intervalId: interval.id });
      assert.equal(plan.shared.mode, 'reuse');
    }
    assert.equal(f.counts().text, before.text + 2, 'reusing either result makes no further model request');
    for (const root of f.roots) {
      const { analysis } = await readProductAnalysis(root);
      assert.equal(analysis.candidates.length, 2);
      assert.equal(await readFile(join(root, 'film.html'), 'utf8'), 'original film');
      assert.equal(await readFile(join(root, '.film/source-takes.json'), 'utf8'), 'private original takes');
    }
  } finally { release?.(); }
});

test('joining lectures preserves completed scope and only analyzes the remaining scope', async t => {
  const f = await fixture(t);
  await f.run(0, 'transcription', { prepare: true });
  const before = (await readProductAnalysis(f.roots[0])).analysis;
  const [first, second] = before.intervals;
  const firstIssue = '本窗口未出现当前实际成交价、上链接或改价指令，后续当前报价不在范围内';
  f.setModelResult({ schema: 'complete-speech-v1', candidates: [{ firstCue: 0, lastCue: 1, tags: ['卖点'], subject: { kind: 'self', evidence: [0] } }], issues: [firstIssue] });
  await f.run(0, 'analysis', { productId: first.productId, intervalId: first.id });
  const calls = f.counts().text;
  const oldCandidates = (await readProductAnalysis(f.roots[0])).analysis.candidates;
  await updateProductAnalysis(f.roots[0], data => {
    const merged = applyProductEdit(data, { type: 'merge', productId: second.productId, targetId: first.productId });
    return applyProductEdit(merged, { type: 'join-lecture', productId: first.productId, intervalIds: [first.id, second.id], newIntervalId: 'joined-test' });
  }, probe);
  const saved = (await readProductAnalysis(f.roots[0])).analysis;
  assert.deepEqual(saved.candidates, oldCandidates);
  await assert.rejects(f.workflows[0].plan(f.roots[0], { action: 'analysis', sourceId: 'assets/live.mp4', productId: first.productId, intervalId: 'joined-test' }), /避免重复提交/);
  const original = await f.workflows[0].plan(f.roots[0], { action: 'analysis', sourceId: 'assets/live.mp4', productId: first.productId, intervalId: first.id });
  assert.equal(original.requestCount, 0);
  assert.equal(f.counts().text, calls);
  f.setModelResult({ schema: 'complete-speech-v1', candidates: [{ firstCue: 0, lastCue: 1, tags: ['价格机制', '行动指令'], subject: { kind: 'self', evidence: [0] }, price: { kind: 'current', evidence: [0] } }], issues: [] });
  await f.run(0, 'analysis', { productId: first.productId, intervalId: second.id });
  assert.equal(f.counts().text, calls + 1);
  assert.equal((await readProductAnalysis(f.roots[0])).analysis.candidates.length, 2);
  const reader = createStructurePlanInputReader({ liveAnalysis: createLiveAnalysis({ modelIdentity: () => f.service.text, probeSource: probe }) });
  const input = await reader(f.roots[0], { sourceId: 'assets/live.mp4', productId: first.productId, intervalId: 'joined-test' });
  assert.equal(input.visibility, 'shared', JSON.stringify(input.issues));
  assert.equal(input.engineInput.candidates.length, 2);
  assert.equal(Object.keys(input.localCandidateIds).length, 2);
  assert.ok(input.compositionEvidence.segmentIssues.includes(firstIssue));
  assert.ok(!(input.engineInput.analysisIssues ?? []).includes(firstIssue), 'a price and purchase in the next saved scope resolve the window-local absence');
  assert.equal(f.counts().text, calls + 1, 'reading joined composition input never calls the model');
});

test('joined scope reuses a colleague shared result even after personal product merging', async t => {
  const f = await fixture(t);
  await f.run(0, 'transcription', { prepare: true });
  await f.run(1, 'transcription', { prepare: true });
  const a = (await readProductAnalysis(f.roots[0])).analysis, b = (await readProductAnalysis(f.roots[1])).analysis;
  const [first, second] = a.intervals, colleague = b.intervals[1];
  await f.run(1, 'analysis', { productId: colleague.productId, intervalId: colleague.id });
  const calls = f.counts().text;
  await updateProductAnalysis(f.roots[0], data => {
    const merged = applyProductEdit(data, { type: 'merge', productId: second.productId, targetId: first.productId });
    return applyProductEdit(merged, { type: 'join-lecture', productId: first.productId, intervalIds: [first.id, second.id], newIntervalId: 'joined-shared' });
  }, probe);
  const plan = await f.run(0, 'analysis', { productId: first.productId, intervalId: second.id });
  assert.equal(plan.shared.mode, 'reuse');
  assert.equal(f.counts().text, calls, 'joining never resubmits another client completed scope');
  const saved = (await readProductAnalysis(f.roots[0])).analysis;
  assert.equal(saved.candidates.filter(item => item.intervalId === second.id).length, 1);
});

test('joining separately analyzed products preserves both cached identities and structure inputs', async t => {
  const f = await fixture(t); await f.run(0, 'transcription', { prepare: true });
  await f.run(1, 'transcription', { prepare: true });
  const initial = (await readProductAnalysis(f.roots[0])).analysis, [first, second] = initial.intervals;
  await f.run(0, 'analysis', { productId: first.productId, intervalId: first.id });
  await f.run(0, 'analysis', { productId: second.productId, intervalId: second.id });
  const count = f.counts().text, before = (await readProductAnalysis(f.roots[0])).analysis;
  const live = createLiveAnalysis({ modelIdentity: () => f.service.text, probeSource: probe });
  const reader = createStructurePlanInputReader({ liveAnalysis: live });
  const original = await reader(f.roots[0], { sourceId: 'assets/live.mp4', productId: second.productId, intervalId: second.id });
  await updateProductAnalysis(f.roots[0], data => applyProductEdit(data, { type: 'join-lecture', productId: first.productId, intervalIds: [first.id, second.id], newIntervalId: 'joined-two-products' }), probe);
  const saved = (await readProductAnalysis(f.roots[0])).analysis;
  assert.deepEqual(saved.candidates, before.candidates);
  assert.equal(saved.products.find(p => p.id === second.productId).joinedInto, first.productId);
  for (const part of [first, second]) {
    const plan = await f.workflows[0].plan(f.roots[0], { action: 'analysis', sourceId: 'assets/live.mp4', productId: part.productId, intervalId: part.id });
    assert.equal(plan.requestCount, 0);
  }
  const restored = await reader(f.roots[0], { sourceId: 'assets/live.mp4', productId: second.productId, intervalId: second.id });
  assert.equal(restored.analysisVersion, original.analysisVersion, 'the second original public plan input remains addressable');
  const combined = await reader(f.roots[0], { sourceId: 'assets/live.mp4', productId: first.productId, intervalId: 'joined-two-products' });
  assert.equal(combined.visibility, 'shared', JSON.stringify(combined.issues));
  assert.equal(combined.engineInput.candidates.length, 2);
  await updateProductAnalysis(f.roots[0], data => {
    data.intervals.find(item => item.id === 'joined-two-products').shareJoinedPlans = true;
    return data;
  }, probe);
  const sharedCombined = await reader(f.roots[0], { sourceId: 'assets/live.mp4', productId: first.productId, intervalId: 'joined-two-products' });
  assert.equal(sharedCombined.visibility, 'shared');
  assert.equal(sharedCombined.baselineDescriptors.length, 2);
  assert.deepEqual(sharedCombined.engineInput, combined.engineInput);
  const colleague = (await readProductAnalysis(f.roots[1])).analysis;
  for (const part of colleague.intervals.slice(0, 2)) {
    const reused = await f.run(1, 'analysis', { productId: part.productId, intervalId: part.id });
    assert.equal(reused.shared.mode, 'reuse');
  }
  assert.equal((await readProductAnalysis(f.roots[1])).analysis.candidates.length, 2, 'another client can read both shared results');
  const [otherFirst, otherSecond] = colleague.intervals;
  await updateProductAnalysis(f.roots[1], data => {
    const joined = applyProductEdit(data, { type: 'join-lecture', productId: otherFirst.productId, intervalIds: [otherFirst.id, otherSecond.id], newIntervalId: 'colleague-joined' });
    joined.intervals.find(item => item.id === 'colleague-joined').shareJoinedPlans = true;
    return joined;
  }, probe);
  const colleagueCombined = await reader(f.roots[1], { sourceId: 'assets/live.mp4', productId: otherFirst.productId, intervalId: 'colleague-joined' });
  assert.equal(colleagueCombined.visibility, 'shared');
  assert.equal(colleagueCombined.analysisVersion, sharedCombined.analysisVersion);
  assert.deepEqual(colleagueCombined.engineInput, sharedCombined.engineInput);
  let composed = 0;
  const makePlans = () => createStructurePlans({ sharedAnalysis: f.shared(), readInput: reader,
    inspectInput: input => ({ ready: true, inputHash: sharedHash(input), issues: [] }),
    compose: async () => { composed++; return { plans: [{ id: 'shared-plan', segments: [] }], complete: true, issues: [] }; } });
  const firstPlans = await makePlans().generate(f.roots[0], { sourceId: 'assets/live.mp4', productId: first.productId, intervalId: 'joined-two-products' });
  assert.equal(firstPlans.status, 'complete');
  const otherPlans = await makePlans().status(f.roots[1], { sourceId: 'assets/live.mp4', productId: otherFirst.productId, intervalId: 'colleague-joined' });
  assert.equal(otherPlans.status, 'complete');
  assert.equal(otherPlans.plans.length, 1);
  assert.equal(composed, 1, 'the second client reuses the published joined plan');
  await updateProductAnalysis(f.roots[1], data => {
    data.candidates.find(item => item.intervalId === otherSecond.id).text += '本机个人修改';
    return data;
  }, probe);
  const privateCombined = await reader(f.roots[1], { sourceId: 'assets/live.mp4', productId: otherFirst.productId, intervalId: 'colleague-joined' });
  assert.equal(privateCombined.visibility, 'unavailable', 'a changed private input must not be shared');
  assert.equal(f.counts().text, count);
});

test('two ordinary projects cannot both submit the same new discovery task', async t => {
  const f = await fixture(t); await f.run(0, 'transcription'); await f.run(1, 'transcription');
  let release; f.setGate(new Promise(resolve => { release = resolve; }));
  const plans = await Promise.all(f.workflows.map((w, i) => w.plan(f.roots[i], { action: 'discovery', sourceId: 'assets/live.mp4' })));
  const attempts = await Promise.allSettled(f.workflows.map((w, i) => w.execute(f.roots[i], { confirmed: true, plan: plans[i] })));
  assert.equal(attempts.filter(x => x.status === 'fulfilled').length, 1); release();
  await Promise.all(f.workflows.map((w, i) => w.wait(f.roots[i], 'assets/live.mp4'))); assert.equal(f.counts().text, 1);
});
test('ordinary failed request requires explicit shared retry after reopen', async t => {
  const f = await fixture(t); await f.run(0, 'transcription'); f.fail(true); await f.run(0, 'discovery');
  f.workflows[0] = f.make(); const plan = await f.workflows[0].plan(f.roots[0], { action: 'discovery', sourceId: 'assets/live.mp4' });
  assert.equal(plan.shared.mode, 'retry-required'); assert.equal(f.counts().text, 1);
  await assert.rejects(f.workflows[0].execute(f.roots[0], { confirmed: true, plan }));
  f.fail(false); await f.run(0, 'discovery', { retry: true }, { retryAcknowledged: true }); assert.equal(f.counts().text, 2);
});
test('a project with a failed discovery can import another colleague successful first result', async t => {
  const f = await fixture(t); await f.run(0, 'transcription'); await f.run(1, 'transcription'); f.fail(true); await f.run(0, 'discovery');
  f.fail(false); await f.run(1, 'discovery', { retry: true }, { retryAcknowledged: true });
  f.workflows[0] = f.make(); const plan = await f.run(0, 'discovery');
  assert.equal(plan.shared.mode, 'reuse'); assert.equal((await readProductAnalysis(f.roots[0])).analysis.products.length, 2); assert.equal(f.counts().text, 2);
});
test('a pending local transcript can recover from another colleague shared success without another upload', async t => {
  const f = await fixture(t), root = f.roots[1], source = (await readProductAnalysis(root)).analysis.sources[0], loc = await transcriptionLocation(root, source);
  await mkdir(loc.dir, { recursive: true }); await writeFile(loc.path, JSON.stringify({ version: 1, status: 'pending', sourceId: source.id, assetPath: source.assetPath, fingerprint: loc.fingerprint }));
  await f.run(0, 'transcription'); assert.equal((await f.run(1, 'transcription')).shared.mode, 'reuse');
  assert.equal((await f.workflows[1].status(root, source.id)).transcription.status, 'complete'); assert.equal(f.counts().asr, 1);
});
test('shared structure export deduplicates overlap cues exactly as local results and retains first reason', async t => {
  const f = await fixture(t); await f.run(0, 'transcription'); await f.run(0, 'discovery');
  const first = (await readProductAnalysis(f.roots[0])).analysis, range = first.intervals[0], scope = { intervalId: range.id, productId: range.productId };
  await f.run(0, 'analysis', scope);
  const file = join(f.roots[0], '.film/live-analysis', `${createHash('sha256').update('assets/live.mp4').digest('hex')}.json`), saved = JSON.parse(await readFile(file, 'utf8'));
  const attempt = Object.values(saved.attempts)[0], duplicate = structuredClone(attempt.windows[0]);
  duplicate.output.candidates[0].details.reason = '重叠窗另一种依据'; duplicate.output.candidates[0].tags.reverse(); attempt.windows.push(duplicate); await writeFile(file, JSON.stringify(saved));
  const live = createLiveAnalysis({ probeSource: probe }); const payload = await live.exportShared(f.roots[0], 'assets/live.mp4', range.id);
  assert.equal(payload.candidates.length, first.candidates.length + 1); assert.equal(payload.candidates[0].details.reason, details.reason);
  await f.run(1, 'transcription'); await f.run(1, 'discovery');
  const local = (await readProductAnalysis(f.roots[1])).analysis.intervals[0];
  await live.importShared(f.roots[1], 'assets/live.mp4', { intervalId: local.id, productId: local.productId, startMs: local.startMs, endMs: local.endMs, lectureOnly: true }, payload, { sha256: 'a'.repeat(64) });
  assert.equal((await readProductAnalysis(f.roots[1])).analysis.candidates.length, 1);
});
test('completed segmented ASR awaiting seam review blocks another colleague paid retranscription', async t => {
  const f = await fixture(t); f.asrError(Object.assign(Error('segments completed, seam conflict'), { code: 'ASR_BOUNDARY_REVIEW' }));
  await f.run(0, 'transcription');
  assert.equal((await f.workflows[0].status(f.roots[0], 'assets/live.mp4')).shared.mode, 'local-review');
  assert.equal([...f.tasks.values()][0].status, 'needs-review'); assert.equal([...f.tasks.values()][0].result, undefined);
  const plan = await f.workflows[1].plan(f.roots[1], { action: 'transcription', sourceId: 'assets/live.mp4', retry: true });
  assert.equal(plan.shared.mode, 'local-review'); assert.equal(plan.enabled, false); assert.equal(plan.requestCount, 0);
  await assert.rejects(f.workflows[1].execute(f.roots[1], { confirmed: true, plan, retryAcknowledged: true })); assert.equal(f.counts().asr, 1);
  f.review(0);
  assert.equal((await f.workflows[0].status(f.roots[0], 'assets/live.mp4')).shared.mode, 'local-only');
  const discovery = await f.run(0, 'discovery'); assert.equal(discovery.shared.mode, 'local-only'); assert.equal(f.counts().text, 1); assert.equal(f.tasks.size, 1);
});
