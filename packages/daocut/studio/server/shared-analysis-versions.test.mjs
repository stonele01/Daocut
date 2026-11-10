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
import { readProductAnalysis, updateProductAnalysis, recordProductEdit } from './product-analysis.mjs';

const probe = async () => ({ duration: 20 });
const details = { subtypes: [], reason: '模拟完整原话', evidence: ['ASR'], context: '', repetition: '', review: [] };
async function fixture(t) {
  const base = resolve('../../.tmp/shared-v2-20261105/backend'); await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, 'workflow-')); t.after(() => rm(dir, { recursive: true, force: true }));
  t.mock.method(globalThis, 'fetch', () => { throw Error('real network forbidden'); });
  const tasks = new Map(); let serial = 0, asr = 0, text = 0, gate, fail = false, asrError, revision = 1, offline = false;
  const coordinate = async (op, body) => {
    if (offline) throw Error('company offline');
    let task = tasks.get(body.taskKey);
    if (op === 'versions') return { versions: [...tasks.values()].filter(t => (t.familyKey ?? t.taskKey) === body.taskKey && t.status === 'complete').map(t => structuredClone(t)) };
    if (op === 'status') return { task: structuredClone(task ?? null) };
    if (op === 'claim' || op === 'retry') {
      if (task && op === 'claim') return { task: structuredClone(task), acquired: false };
      task = { familyKey: body.familyKey ?? task?.familyKey ?? body.taskKey, sequence: task?.sequence ?? ([...tasks.values()].filter(t => (t.familyKey ?? t.taskKey) === (body.familyKey ?? body.taskKey)).length + 1), createdAt: '2026-11-05T00:00:00.000Z', taskKey: body.taskKey, inputHash: body.inputHash, status: 'claimed', attemptId: `attempt-${++serial}` }; tasks.set(body.taskKey, task); return { task: structuredClone(task), acquired: true };
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
    return value.intervalId ? { candidates: [{ firstCue: 0, lastCue: value.cues.length - 1, tags: [revision === 1 ? '卖点' : '痛点'], details }], issues: [] }
      : { products: [{ key: 'A', name: revision === 1 ? '商品A' : '商品A新版', aliases: [], variant: '', evidence: [0] }, { key: 'B', name: '商品B', aliases: [], variant: '', evidence: [2] }], ranges: [{ key: 'A', firstCue: 0, lastCue: 1, kind: 'lecture', reason: '讲解证据', evidence: [0] }, { key: 'B', firstCue: 2, lastCue: 3, kind: 'lecture', reason: '讲解证据', evidence: [2] }, { key: 'A', firstCue: 4, lastCue: 5, kind: 'lecture', reason: '讲解证据', evidence: [4] }], issues: [] };
  };
  const transcribe = async (root, source) => {
    asr++; if (asrError) throw asrError; const loc = await transcriptionLocation(root, source); await mkdir(loc.dir, { recursive: true });
    await writeFile(loc.path, JSON.stringify({ version: 1, status: 'complete', sourceId: source.id, assetPath: source.assetPath, fingerprint: loc.fingerprint, durationMs: source.durationMs, cues, words: [] }));
    return { cues, words: [] };
  };
  const settings = () => ({ enabled: true, resultRoots: [{ libraryId: 'library-test', root: join(dir, 'shared') }] });
  const reviewed = new Map(), readTranscript = (root, source) => reviewed.get(root) ?? readProductTranscript(root, source);
  const stores = [];
  const make = extra => {
    const live = createLiveAnalysis({ transcribe, modelClient, modelIdentity: () => service.text, probeSource: probe, readTranscript });
    const discovery = createProductDiscovery({ modelClient, modelIdentity: () => service.text, probeSource: probe, readTranscript });
    const shared = createSharedAnalysis({ coordinate, settings, readManifest: async () => ({ items: { 'assets/live.mp4': { libraryId: 'library-test', relativePath: 'show/live.mp4' } } }), ...extra });
    stores.push(shared);
    return createProductWorkflow({ liveAnalysis: live, discovery, sharedAnalysis: shared, analysisServices: async () => service, probeSource: probe, readTranscript });
  };
  const roots = [join(dir, 'a'), join(dir, 'b')], workflows = [make(), make()];
  for (let i = 0; i < roots.length; i++) { await mkdir(join(roots[i], 'assets'), { recursive: true }); await writeFile(join(roots[i], 'assets/live.mp4'), 'synthetic live'); await writeFile(join(roots[i], 'film.html'), 'original film'); await mkdir(join(roots[i], '.film')); await writeFile(join(roots[i], '.film/source-takes.json'), 'private original takes'); await workflows[i].registerSource(roots[i], { assetPath: 'assets/live.mp4' }); }
  const run = async (person, action, extra = {}, ack = {}) => { const workflow = workflows[person], root = roots[person], plan = await workflow.plan(root, { sourceId: 'assets/live.mp4', action, ...extra }); await workflow.execute(root, { confirmed: true, plan, ...ack }); await workflow.wait(root, 'assets/live.mp4'); return plan; };
  return { roots, workflows, stores, coordinate, revision: value => { revision = value; }, offline: value => { offline = value; }, make, run, tasks, cues, service, counts: () => ({ asr, text }), setGate: value => { gate = value; }, fail: value => { fail = value; }, asrError: value => { asrError = value; }, review: person => reviewed.set(roots[person], { cues, words: [], localReconciled: true }) };
}

const sourceId = 'assets/live.mp4';
const group = async (f, person, action) => (await f.workflows[person].sharedVersions(f.roots[person], sourceId)).groups.find(g => g.action === action);
const adopt = async (f, person, g) => f.workflows[person].adoptShared(f.roots[person], { sourceId, action: g.action, ...g.scope, versionTaskKey: g.latestVersion.taskKey, expectedCurrentSha: g.currentVersion.sha256, confirmed: true });

test('new discovery is published without changing pinned local results; explicit adoption changes effective products', async t => {
  const f = await fixture(t); await f.run(0, 'transcription'); await f.run(0, 'discovery'); await f.run(1, 'transcription'); await f.run(1, 'discovery');
  const old = await group(f, 1, 'discovery'); f.revision(2);
  await f.run(0, 'discovery', { newVersion: true });
  for (const root of f.roots) assert.equal((await readProductAnalysis(root)).analysis.products[0].name, '商品A');
  f.workflows[1] = f.make(); const next = await group(f, 1, 'discovery');
  assert.equal(next.updateAvailable, true); assert.equal(next.currentVersion.sha256, old.currentVersion.sha256); assert.equal(next.versions.length, 2);
  const before = f.counts(); await adopt(f, 1, next);
  assert.equal((await readProductAnalysis(f.roots[1])).analysis.products[0].name, '商品A新版');
  assert.equal((await group(f, 1, 'discovery')).currentVersion.sha256, next.latestVersion.sha256); assert.deepEqual(f.counts(), before);
  const pin = JSON.parse(await readFile(join(f.roots[1], '.film/shared-analysis', `${next.familyKey}.json`), 'utf8'));
  await writeFile(join(pin.descriptor.resultRoot, pin.result.path), 'mock NAS result unreadable after adoption');
  f.workflows[1] = f.make(); await f.run(1, 'discovery'); assert.deepEqual(f.counts(), before);
  assert.equal(await readFile(join(f.roots[1], 'film.html'), 'utf8'), 'original film');
  assert.equal(await readFile(join(f.roots[1], '.film/source-takes.json'), 'utf8'), 'private original takes');
});

test('new structure stays a draft until adoption and preserves unrelated structure and personal takes', async t => {
  const f = await fixture(t); await f.run(0, 'transcription'); await f.run(0, 'discovery');
  const ranges = (await readProductAnalysis(f.roots[0])).analysis.intervals, scope = { intervalId: ranges[0].id, productId: ranges[0].productId };
  await f.run(0, 'analysis', scope); await f.run(0, 'analysis', { intervalId: ranges[1].id, productId: ranges[1].productId });
  f.revision(2); await f.run(0, 'analysis', { ...scope, newVersion: true });
  assert.ok((await readProductAnalysis(f.roots[0])).analysis.candidates.every(c => c.tags.includes('卖点')));
  const g = (await f.workflows[0].sharedVersions(f.roots[0], sourceId)).groups.find(g => g.intervalId === scope.intervalId);
  await adopt(f, 0, g); const data = (await readProductAnalysis(f.roots[0])).analysis;
  assert.ok(data.candidates.find(c => c.intervalId === scope.intervalId).tags.includes('痛点'));
  assert.ok(data.candidates.find(c => c.intervalId === ranges[1].id).tags.includes('卖点'));
  assert.equal((await group(f, 0, 'transcription')).canCreateVersion, false);
});

test('completed local cache without outbox recovers publication without another model call or new attempt', async t => {
  const f = await fixture(t); await f.run(0, 'transcription'); await f.run(0, 'discovery');
  const task = [...f.tasks.values()].find(t => t.familyKey === t.taskKey && t.result && t.sequence === 1 && t !== [...f.tasks.values()][0]);
  const path = join(f.roots[0], '.film/shared-analysis', `${task.taskKey}.json`), saved = JSON.parse(await readFile(path, 'utf8'));
  delete saved.snapshot; delete saved.result; saved.status = 'submitted'; task.status = 'submitted'; delete task.result; await writeFile(path, JSON.stringify(saved));
  f.workflows[0] = f.make(); const before = f.counts(), attempt = task.attemptId;
  const plan = await f.workflows[0].plan(f.roots[0], { sourceId, action: 'discovery' });
  assert.equal(plan.shared.mode, 'publish-pending'); assert.equal(plan.requestCount, 0);
  await f.workflows[0].execute(f.roots[0], { confirmed: true, plan });
  assert.equal(task.status, 'complete'); assert.equal(task.attemptId, attempt); assert.deepEqual(f.counts(), before);
});

test('catalog offline is a warning and never changes the pinned version', async t => {
  const f = await fixture(t); await f.run(0, 'transcription'); await f.run(0, 'discovery'); const before = await group(f, 0, 'discovery');
  f.offline(true); const result = await f.workflows[0].sharedVersions(f.roots[0], sourceId);
  assert.ok(result.warning); assert.equal(result.groups.find(g => g.action === 'discovery').currentVersion.sha256, before.currentVersion.sha256);
});

test('manual discovery remains unchanged until the existing difference-apply flow completes', async t => {
  const f = await fixture(t); await f.run(0, 'transcription'); await f.run(0, 'discovery'); await f.run(1, 'transcription'); await f.run(1, 'discovery');
  await updateProductAnalysis(f.roots[1], data => { const next = structuredClone(data); next.products[0].name = '私人名称'; return recordProductEdit(data, next); }, probe);
  f.revision(2); await f.run(0, 'discovery', { newVersion: true }); const g = await group(f, 1, 'discovery');
  const pending = await adopt(f, 1, g); assert.equal(pending.needsReview, true);
  assert.equal((await readProductAnalysis(f.roots[1])).analysis.products[0].name, '私人名称');
  assert.equal((await group(f, 1, 'discovery')).currentVersion.sha256, g.currentVersion.sha256);
  const discovery = createProductDiscovery({ modelIdentity: () => f.service.text, probeSource: probe });
  await discovery.apply(f.roots[1], { sourceId, runId: pending.runId, expected: (await readProductAnalysis(f.roots[1])).analysis, replaceReviewed: true });
  f.workflows[1] = f.make(); assert.equal((await group(f, 1, 'discovery')).currentVersion.sha256, g.latestVersion.sha256);
});

test('previously imported version can be selected again and parallel adopts cannot both replace a pin', async t => {
  const f = await fixture(t); await f.run(0, 'transcription'); await f.run(0, 'discovery'); await f.run(1, 'transcription'); await f.run(1, 'discovery');
  const first = await group(f, 1, 'discovery'); f.revision(2); await f.run(0, 'discovery', { newVersion: true }); const newer = await group(f, 1, 'discovery');
  const results = await Promise.allSettled([adopt(f, 1, newer), adopt(f, 1, newer)]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  await f.workflows[1].adoptShared(f.roots[1], { sourceId, action: 'discovery', versionTaskKey: first.currentVersion.taskKey, expectedCurrentSha: newer.latestVersion.sha256, confirmed: true });
  assert.equal((await readProductAnalysis(f.roots[1])).analysis.products[0].name, '商品A');
  assert.equal((await group(f, 1, 'discovery')).currentVersion.sha256, first.currentVersion.sha256);
});

for (const action of ['discovery', 'analysis']) test(`completed new ${action} draft with missing outbox reopens and publishes without a second model call`, async t => {
  const f = await fixture(t); await f.run(0, 'transcription'); await f.run(0, 'discovery');
  const range = (await readProductAnalysis(f.roots[0])).analysis.intervals[0], scope = action === 'analysis' ? { productId: range.productId, intervalId: range.id } : {};
  if (action === 'analysis') await f.run(0, action, scope);
  f.revision(2); await f.run(0, action, { ...scope, newVersion: true });
  const task = [...f.tasks.values()].find(t => t.sequence === 2), path = join(f.roots[0], '.film/shared-analysis', `${task.taskKey}.json`), saved = JSON.parse(await readFile(path, 'utf8'));
  delete saved.snapshot; delete saved.result; saved.status = 'submitted'; task.status = 'submitted'; delete task.result; await writeFile(path, JSON.stringify(saved));
  f.workflows[0] = f.make(); const before = f.counts(); const plan = await f.workflows[0].plan(f.roots[0], { sourceId, action, ...scope, newVersion: true });
  assert.equal((await f.workflows[0].status(f.roots[0], sourceId)).shared.mode, 'publish-pending');
  await f.workflows[0].publishShared(f.roots[0], { sourceId, taskKey: task.taskKey, confirmed: true });
  assert.equal(plan.shared.mode, 'publish-pending'); assert.deepEqual(f.counts(), before); assert.equal(task.status, 'complete');
});

test('new-version uncertain request requires explicit retry and one new-version claimant wins across clients', async t => {
  const f = await fixture(t); await f.run(0, 'transcription'); await f.run(0, 'discovery'); await f.run(1, 'transcription'); await f.run(1, 'discovery');
  f.fail(true); await f.run(0, 'discovery', { newVersion: true }); f.workflows[0] = f.make();
  const failed = await f.workflows[0].plan(f.roots[0], { sourceId, action: 'discovery', newVersion: true });
  await assert.rejects(f.workflows[0].execute(f.roots[0], { confirmed: true, plan: failed }));
  f.fail(false); await f.run(0, 'discovery', { newVersion: true, retry: true }, { retryAcknowledged: true });
  assert.equal(f.counts().text, 3); assert.equal((await group(f, 1, 'discovery')).versions.length, 2);
});

test('same-path replacement cannot adopt old shared transcription into a different source', async t => {
  const f = await fixture(t); await f.run(0, 'transcription'); const g = await group(f, 0, 'transcription'), before = f.counts();
  await writeFile(join(f.roots[0], sourceId), 'different original at same pathname');
  await assert.rejects(adopt(f, 0, g), /素材|原片|身份/);
  assert.deepEqual(f.counts(), before);
});

test('two clients plan the same next version but only one starts a model request', async t => {
  const f = await fixture(t); await f.run(0, 'transcription'); await f.run(0, 'discovery'); await f.run(1, 'transcription'); await f.run(1, 'discovery');
  let release; f.setGate(new Promise(resolve => { release = resolve; }));
  const plans = await Promise.all(f.workflows.map((w, i) => w.plan(f.roots[i], { sourceId, action: 'discovery', newVersion: true })));
  const results = await Promise.allSettled(f.workflows.map((w, i) => w.execute(f.roots[i], { confirmed: true, plan: plans[i] })));
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1); release();
  await Promise.all(f.workflows.map((w, i) => w.wait(f.roots[i], sourceId))); assert.equal(f.counts().text, 2);
});

for (const action of ['discovery', 'analysis']) test(`${action} effective result saved but pin commit interrupted reconciles on reopen`, async t => {
  const f = await fixture(t); await f.run(0, 'transcription'); await f.run(0, 'discovery');
  const range = (await readProductAnalysis(f.roots[0])).analysis.intervals[0], scope = action === 'analysis' ? { productId: range.productId, intervalId: range.id } : {};
  if (action === 'analysis') await f.run(0, action, scope);
  f.revision(2); await f.run(0, action, { ...scope, newVersion: true }); const g = await group(f, 0, action), before = f.counts();
  t.mock.method(f.stores[0], 'commitAdoption', async () => { throw Error('interruption after effective save'); });
  await assert.rejects(adopt(f, 0, g), /interruption/); f.workflows[0] = f.make();
  assert.equal((await group(f, 0, action)).currentVersion.sha256, g.latestVersion.sha256); assert.deepEqual(f.counts(), before);
});

test('existing complete ASR version is explicitly adopted; previous cache is preserved and changed text is effective', async t => {
  const f = await fixture(t); await f.run(0, 'transcription'); const g = await group(f, 0, 'transcription');
  const pin = JSON.parse(await readFile(join(f.roots[0], '.film/shared-analysis', `${g.familyKey}.json`), 'utf8'));
  const source = (await readProductAnalysis(f.roots[0])).analysis.sources[0], store = f.stores[0];
  const descriptor = await store.prepare(f.roots[0], source, { action: 'transcription', data: null, contract: pin.descriptor.contract, newVersion: true });
  const claimed = await store.acquire(descriptor), cues = structuredClone(f.cues); cues[0].text = '模拟另一完整转写版本。';
  await store.complete(f.roots[0], descriptor, claimed.attemptId, { cues, words: [] }, f.service.transcription);
  const before = f.counts(), next = await group(f, 0, 'transcription'); await adopt(f, 0, next);
  assert.equal((await readProductTranscript(f.roots[0], source)).cues[0].text, cues[0].text);
  assert.equal((await group(f, 0, 'transcription')).currentVersion.sha256, next.latestVersion.sha256); assert.deepEqual(f.counts(), before);
});

test('manual structure changes are preserved and not marked adopted', async t => {
  const f = await fixture(t); await f.run(0, 'transcription'); await f.run(0, 'discovery');
  const range = (await readProductAnalysis(f.roots[0])).analysis.intervals[0], scope = { productId: range.productId, intervalId: range.id };
  await f.run(0, 'analysis', scope); f.revision(2); await f.run(0, 'analysis', { ...scope, newVersion: true });
  await updateProductAnalysis(f.roots[0], data => { const next = structuredClone(data); next.candidates[0].tags = ['钩子']; return recordProductEdit(data, next); }, probe);
  const g = await group(f, 0, 'analysis'), result = await adopt(f, 0, g);
  assert.equal(result.needsReview, true); assert.equal((await group(f, 0, 'analysis')).currentVersion.sha256, g.currentVersion.sha256);
  assert.deepEqual((await readProductAnalysis(f.roots[0])).analysis.candidates[0].tags, ['钩子']);
});
