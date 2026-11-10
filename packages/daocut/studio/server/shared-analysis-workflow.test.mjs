import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createSharedAnalysis } from './shared-analysis.mjs';
import { createLiveAnalysis } from './live-analysis.mjs';
import { createProductDiscovery } from './product-discovery-route.mjs';
import { createProductWorkflow } from './product-workflow.mjs';
import { readProductTranscript, transcriptionLocation } from './product-transcription.mjs';
import { readProductAnalysis, updateProductAnalysis } from './product-analysis.mjs';

const probe = async () => ({ duration: 20 });
const details = { subtypes: [], reason: '模拟完整原话', evidence: ['ASR'], context: '', repetition: '', review: [] };
async function fixture(t) {
  const base = resolve('../../.tmp/shared-live-20261104/backend'); await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, 'workflow-')); t.after(() => rm(dir, { recursive: true, force: true }));
  t.mock.method(globalThis, 'fetch', () => { throw Error('real network forbidden'); });
  const tasks = new Map(); let serial = 0, asr = 0, text = 0, gate, fail = false, asrError;
  const coordinate = async (op, body) => {
    let task = tasks.get(body.taskKey);
    if (op === 'status') return { task: structuredClone(task ?? null) };
    if (op === 'claim' || op === 'retry') {
      if (task && op === 'claim') return { task: structuredClone(task), acquired: false };
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
  return { roots, workflows, make, run, tasks, cues, service, counts: () => ({ asr, text }), setGate: value => { gate = value; }, fail: value => { fail = value; }, asrError: value => { asrError = value; }, review: person => reviewed.set(roots[person], { cues, words: [], localReconciled: true }) };
}
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
