import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createSharedAnalysis } from './shared-analysis.mjs';
import { createLiveAnalysis } from './live-analysis.mjs';
import { createProductDiscovery } from './product-discovery-route.mjs';
import { createProductWorkflow } from './product-workflow.mjs';
import { readProductAnalysis, recordProductEdit, updateProductAnalysis } from './product-analysis.mjs';
import { readProductTranscript, transcriptionLocation } from './product-transcription.mjs';

const probe = async () => ({ duration: 20 });
const details = { subtypes: [], reason: 'synthetic evidence', evidence: ['ASR'], context: '', repetition: '', review: [] };

async function fixture(t, options = {}) {
  const base = resolve(import.meta.dirname, '../../../../.tmp/shared-folder-workflow-20261106');
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, 'case-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  t.mock.method(globalThis, 'fetch', () => { throw Error('External network is forbidden in this fixture'); });
  const company = 'a'.repeat(64), tasks = new Map(), calls = [];
  let asr = 0, text = 0, serial = 0, mappedCompany = company;
  const coordinate = async (op, body) => {
    calls.push({ op, body: structuredClone(body) });
    if (body.expectedCoordinatorId && body.expectedCoordinatorId !== company) throw Error('Company identity changed');
    if (op === 'catalog') return { coordinationId: company, results: [...tasks.values()].filter(row => row.status === 'complete' && row.catalog?.sourceIdentity === body.sourceIdentity).map(row => structuredClone(row)) };
    let task = tasks.get(body.taskKey);
    if (op === 'status') return { coordinationId: company, task: structuredClone(task ?? null) };
    if (op === 'claim') {
      if (task) return { coordinationId: company, acquired: false, task: structuredClone(task) };
      task = { taskKey: body.taskKey, inputHash: body.inputHash, attemptId: `attempt-${++serial}`, status: 'claimed', ...(body.catalog ? { catalog: body.catalog } : {}) };
      tasks.set(body.taskKey, task);
      return { coordinationId: company, acquired: true, task: structuredClone(task) };
    }
    assert.equal(task.attemptId, body.attemptId);
    if (op === 'submitted') { const sendAllowed = task.status === 'claimed'; task.status = 'submitted'; return { coordinationId: company, sendAllowed, task: structuredClone(task) }; }
    if (op === 'complete') { task.status = 'complete'; task.result = body.result; }
    if (op === 'fail') task.status = body.reason === 'needs-review' ? 'needs-review' : 'uncertain';
    return { coordinationId: company, task: structuredClone(task) };
  };
  const cues = ['A first', 'A second', 'B first', 'B second', 'A return', 'A end'].map((text, i) => ({ startMs: i * 2000, endMs: i * 2000 + 1500, text }));
  const service = { transcription: { enabled: true, provider: 'doubao', model: 'mock-asr' }, text: { enabled: true, provider: 'deepseek', model: 'mock-text' } };
  const modelClient = async ({ input }) => {
    text++;
    const value = JSON.parse(input);
    return value.intervalId ? { candidates: [{ firstCue: 0, lastCue: value.cues.length - 1, tags: ['卖点'], details }], issues: [] }
      : { products: [{ key: 'A', name: 'Product A', aliases: [], variant: '', evidence: [0] }, { key: 'B', name: 'Product B', aliases: [], variant: '', evidence: [2] }], ranges: [{ key: 'A', firstCue: 0, lastCue: 1, kind: 'lecture', reason: 'first', evidence: [0] }, { key: 'B', firstCue: 2, lastCue: 3, kind: 'lecture', reason: 'second', evidence: [2] }, { key: 'A', firstCue: 4, lastCue: 5, kind: 'lecture', reason: 'return', evidence: [4] }], issues: [] };
  };
  const transcribe = async (root, source) => {
    asr++;
    const loc = await transcriptionLocation(root, source);
    await mkdir(loc.dir, { recursive: true });
    if (options.seams) {
      const segments = [
        { id: 'left', startMs: 0, endMs: 11000, coreStartMs: 0, coreEndMs: 10000, status: 'complete', cues: [{ text: 'before', startMs: 1000, endMs: 2000 }, { text: 'one unfinished sentence', startMs: 9500, endMs: 10800 }], words: [] },
        { id: 'right', startMs: 9000, endMs: 20000, coreStartMs: 10000, coreEndMs: 20000, status: 'complete', cues: [{ text: 'different boundary sentence', startMs: 500, endMs: 1800 }, { text: 'after', startMs: 3000, endMs: 4000 }], words: [] },
      ];
      await writeFile(loc.path, JSON.stringify({ version: 1, status: 'pending', segmented: true, sourceId: source.id, assetPath: source.assetPath, fingerprint: loc.fingerprint, durationMs: source.durationMs }));
      await writeFile(`${loc.path}.segments.json`, JSON.stringify({ version: 1, identity: 'synthetic-segments', sourceId: source.id, durationMs: source.durationMs, segments }));
      throw Object.assign(Error('synthetic seam review required'), { code: 'ASR_BOUNDARY_REVIEW' });
    }
    await writeFile(loc.path, JSON.stringify({ version: 1, status: 'complete', sourceId: source.id, assetPath: source.assetPath, fingerprint: loc.fingerprint, durationMs: source.durationMs, cues, words: [] }));
    return { cues, words: [] };
  };
  const resultRoot = join(dir, options.unwritable ? 'result-file' : 'results');
  if (options.unwritable) await writeFile(resultRoot, 'existing non-directory; never replace');
  const settings = () => ({ enabled: true, resultRoots: [{ libraryId: 'shared-live-folder', root: resultRoot, coordinationId: mappedCompany }] });
  const liveAnalyses = [];
  const make = () => {
    const who = liveAnalyses.length;
    const liveAnalysis = createLiveAnalysis({ transcribe, modelClient, modelIdentity: async () => { await options.onModelIdentity?.(who); return service.text; }, probeSource: probe });
    liveAnalyses.push(liveAnalysis);
    const discovery = createProductDiscovery({ modelClient, modelIdentity: () => service.text, probeSource: probe });
    const sharedAnalysis = createSharedAnalysis({ coordinate, settings, readManifest: async () => ({ items: { 'assets/live.mp4': { libraryId: 'shared-live-folder', relativePath: 'live.mp4' } } }) });
    return createProductWorkflow({ liveAnalysis, discovery, sharedAnalysis, analysisServices: async () => service, probeSource: probe });
  };
  const roots = [join(dir, 'person-a'), join(dir, 'person-b')], ids = ['source-a', 'source-b'], workflows = [make(), make()];
  for (let i = 0; i < roots.length; i++) {
    await mkdir(join(roots[i], 'assets'), { recursive: true }); await mkdir(join(roots[i], '.film'));
    await writeFile(join(roots[i], 'assets/live.mp4'), 'identical synthetic video bytes');
    await writeFile(join(roots[i], 'film.html'), `private film ${i}`);
    await writeFile(join(roots[i], '.film/source-takes.json'), `private takes ${i}`);
    await writeFile(join(roots[i], '.film/product-analysis.json'), JSON.stringify({ version: 1, sources: [{ id: ids[i], assetPath: 'assets/live.mp4', durationMs: 20000 }], products: [], intervals: [], candidates: [] }));
  }
  const run = async (who, action, extra = {}) => {
    const plan = await workflows[who].plan(roots[who], { sourceId: ids[who], action, ...extra });
    await workflows[who].execute(roots[who], { confirmed: true, plan });
    await workflows[who].wait(roots[who], ids[who]);
    return plan;
  };
  const open = async who => workflows[who].openSharedProject(roots[who], { sourceId: ids[who], assetPath: 'assets/live.mp4', expectedAnalysis: (await readProductAnalysis(roots[who])).analysis });
  return { dir, roots, ids, workflows, liveAnalyses, run, open, calls, tasks, resultRoot, company, counts: () => ({ asr, text }), changeCompany: value => { mappedCompany = value; } };
}

test('normal paid-stage results are discovered by merely opening a colleague folder; no historical publication or extra model calls', async t => {
  const f = await fixture(t);
  await f.run(0, 'transcription'); await f.run(0, 'discovery');
  const first = (await readProductAnalysis(f.roots[0])).analysis;
  for (const range of first.intervals) await f.run(0, 'analysis', { productId: range.productId, intervalId: range.id });
  const before = f.counts(); assert.deepEqual(before, { asr: 1, text: 4 });
  const result = await f.open(1);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.imported, { transcription: 6, discovery: 3, analysis: 3 });
  const second = (await readProductAnalysis(f.roots[1])).analysis;
  assert.equal(second.products.length, 2); assert.equal(second.intervals.length, 3); assert.equal(second.candidates.length, 3);
  assert.ok(second.candidates.every(c => c.sourceId === f.ids[1] && second.intervals.some(i => i.id === c.intervalId && i.productId === c.productId)));
  assert.ok(second.products.every(p => !first.products.some(old => old.id === p.id)), 'local product UUIDs must not be copied');
  assert.deepEqual(f.counts(), before);
  for (let i = 0; i < 2; i++) {
    assert.equal(await readFile(join(f.roots[i], 'film.html'), 'utf8'), `private film ${i}`);
    assert.equal(await readFile(join(f.roots[i], '.film/source-takes.json'), 'utf8'), `private takes ${i}`);
    assert.equal(await readFile(join(f.roots[i], 'assets/live.mp4'), 'utf8'), 'identical synthetic video bytes');
  }
  const reopened = await f.open(1); assert.deepEqual(reopened, result); assert.deepEqual(f.counts(), before);
});

test('shared result directory write failure is rejected before task claim or provider call', async t => {
  const f = await fixture(t, { unwritable: true });
  await assert.rejects(f.run(0, 'transcription'), /目录|保存|写入|folder|directory/i);
  assert.deepEqual(f.counts(), { asr: 0, text: 0 });
  assert.equal(f.calls.filter(c => c.op === 'claim' || c.op === 'submitted').length, 0);
  assert.equal(await readFile(f.resultRoot, 'utf8'), 'existing non-directory; never replace');
});

test('folder-pinned company identity is checked before first task lookup and before model calls', async t => {
  const f = await fixture(t); f.changeCompany('b'.repeat(64));
  await assert.rejects(f.run(0, 'transcription'), /Company identity changed/);
  assert.deepEqual(f.counts(), { asr: 0, text: 0 });
  assert.equal(f.calls.filter(c => c.op === 'claim' || c.op === 'submitted').length, 0);
  assert.equal(f.calls.find(c => c.op === 'status').body.expectedCoordinatorId, 'b'.repeat(64));
});

test('completed original ASR segments are automatically shared while ambiguous seams stay private review work', async t => {
  const f = await fixture(t, { seams: true }); await f.run(0, 'transcription');
  const result = await f.open(1);
  assert.equal(result.status, 'review-required'); assert.equal(result.imported.transcription, 4);
  assert.match(result.warnings.join(' '), /接缝|核对/);
  const source = (await readProductAnalysis(f.roots[1])).analysis.sources[0];
  await assert.rejects(readProductTranscript(f.roots[1], source), error => error.code === 'ASR_BOUNDARY_REVIEW');
  const plan = await f.workflows[1].plan(f.roots[1], { sourceId: source.id, action: 'transcription', retry: true });
  assert.equal(plan.requestCount, 0); assert.deepEqual(f.counts(), { asr: 1, text: 0 });
  const saved = [...f.tasks.values()].find(task => task.status === 'complete');
  assert.ok(saved, 'the completed original segments have a durable shared reference');
  const artifact = JSON.parse(await readFile(join(f.resultRoot, saved.result.path), 'utf8'));
  assert.equal(artifact.payload.kind, 'original-asr-segments');
  assert.equal(artifact.payload.collectionStatus, 'complete');
  assert.equal(artifact.payload.segments.length, 2);
});

test('normal automatic phrase import rejects a personal edit made after the opening snapshot', async t => {
  const f = await fixture(t);
  await f.run(0, 'transcription'); await f.run(0, 'discovery');
  const a = (await readProductAnalysis(f.roots[0])).analysis.intervals[0];
  await f.run(0, 'analysis', { productId: a.productId, intervalId: a.id });
  await f.run(1, 'transcription'); await f.run(1, 'discovery');
  const expected = (await readProductAnalysis(f.roots[1])).analysis, range = expected.intervals[0];
  await updateProductAnalysis(f.roots[1], data => { const before = structuredClone(data); data.products[0].name = 'my private name'; return recordProductEdit(before, data); }, probe);
  const task = [...f.tasks.values()].find(task => task.catalog?.action === 'analysis');
  const { payload } = JSON.parse(await readFile(join(f.resultRoot, task.result.path), 'utf8'));
  await assert.rejects(f.liveAnalyses[1].importShared(f.roots[1], f.ids[1], { productId: range.productId, intervalId: range.id, startMs: range.startMs, endMs: range.endMs }, payload, task.result, { expectedAnalysis: expected }), /修改|变化/);
  const after = (await readProductAnalysis(f.roots[1])).analysis;
  assert.equal(after.products[0].name, 'my private name'); assert.equal(after.candidates.length, 0);
});

test('analysis of a privately corrected product range remains local and does not change a colleague baseline', async t => {
  const f = await fixture(t); await f.run(0, 'transcription'); await f.run(0, 'discovery');
  const savedTasks = JSON.stringify([...f.tasks.values()]);
  await updateProductAnalysis(f.roots[0], data => {
    const before = structuredClone(data); data.products[0].name = 'private product correction'; data.intervals[0].startMs = 2000;
    return recordProductEdit(before, data);
  }, probe);
  const range = (await readProductAnalysis(f.roots[0])).analysis.intervals[0];
  const plan = await f.run(0, 'analysis', { productId: range.productId, intervalId: range.id });
  assert.equal(plan.shared.mode, 'local-only'); assert.equal(JSON.stringify([...f.tasks.values()]), savedTasks);
  const beforeOpen = f.counts(), result = await f.open(1), b = (await readProductAnalysis(f.roots[1])).analysis;
  assert.equal(result.status, 'ready'); assert.equal(result.imported.analysis, 0);
  assert.equal(b.intervals[0].startMs, 0); assert.ok(!b.products.some(p => p.name === 'private product correction'));
  assert.deepEqual(f.counts(), beforeOpen);
  assert.equal((await readProductAnalysis(f.roots[0])).analysis.products[0].name, 'private product correction');
});

test('an unchanged empty colleague project refreshes completed results on reopen without another model request', async t => {
  const f = await fixture(t); assert.equal((await f.open(1)).status, 'empty');
  await f.run(0, 'transcription'); await f.run(0, 'discovery');
  const range = (await readProductAnalysis(f.roots[0])).analysis.intervals[0];
  await f.run(0, 'analysis', { productId: range.productId, intervalId: range.id });
  const before = f.counts();
  const result = await f.workflows[1].refreshSharedProject(f.roots[1]);
  assert.equal(result.status, 'ready'); assert.deepEqual(result.imported, { transcription: 6, discovery: 3, analysis: 1 });
  assert.deepEqual(f.counts(), before);
  assert.equal((await readProductAnalysis(f.roots[1])).analysis.candidates.length, 1);
  assert.deepEqual(await f.workflows[1].refreshSharedProject(f.roots[1]), result);
});

test('reopening a formerly empty project never imports over later private film or product changes', async t => {
  const f = await fixture(t); assert.equal((await f.open(1)).status, 'empty');
  await f.run(0, 'transcription'); await f.run(0, 'discovery');
  await writeFile(join(f.roots[1], 'film.html'), 'new private edit');
  await updateProductAnalysis(f.roots[1], data => { data.products.push({ id: 'private', name: 'my own product', sourceIds: [f.ids[1]] }); return data; }, probe);
  const before = JSON.stringify((await readProductAnalysis(f.roots[1])).analysis), counts = f.counts();
  await f.workflows[1].refreshSharedProject(f.roots[1]);
  assert.equal(JSON.stringify((await readProductAnalysis(f.roots[1])).analysis), before);
  assert.equal(await readFile(join(f.roots[1], 'film.html'), 'utf8'), 'new private edit');
  assert.deepEqual(f.counts(), counts);
});

test('legacy empty records without a private baseline never auto-import on reopen', async t => {
  const f = await fixture(t); const original = await f.open(1);
  const path = join(f.roots[1], '.film/shared-open.json'), saved = JSON.parse(await readFile(path, 'utf8'));
  delete saved.emptyBaseline; await writeFile(path, JSON.stringify(saved));
  await f.run(0, 'transcription'); await f.run(0, 'discovery');
  const calls = f.calls.length;
  assert.deepEqual(await f.workflows[1].refreshSharedProject(f.roots[1]), original);
  assert.equal((await readProductAnalysis(f.roots[1])).analysis.products.length, 0);
  assert.equal(f.calls.length, calls);
});

test('normal phrase import returns its committed snapshot instead of accepting a later private edit as the next baseline', async t => {
  let armed = false, edited = false;
  const f = await fixture(t, { onModelIdentity: async who => {
    if (who !== 1 || !armed || edited) return;
    edited = true;
    await updateProductAnalysis(f.roots[1], data => { data.products[0].name = 'edit after committed import'; return data; }, probe);
  } });
  await f.run(0, 'transcription'); await f.run(0, 'discovery');
  const a = (await readProductAnalysis(f.roots[0])).analysis.intervals[0];
  await f.run(0, 'analysis', { productId: a.productId, intervalId: a.id });
  await f.run(1, 'transcription'); await f.run(1, 'discovery');
  const expected = (await readProductAnalysis(f.roots[1])).analysis, range = expected.intervals[0];
  const task = [...f.tasks.values()].find(task => task.catalog?.action === 'analysis');
  const { payload } = JSON.parse(await readFile(join(f.resultRoot, task.result.path), 'utf8'));
  armed = true;
  const imported = await f.liveAnalyses[1].importShared(f.roots[1], f.ids[1], { productId: range.productId, intervalId: range.id, startMs: range.startMs, endMs: range.endMs }, payload, task.result, { expectedAnalysis: expected });
  assert.equal(edited, true);
  assert.equal(imported.committedAnalysis.products[0].name, expected.products[0].name);
  assert.equal(imported.committedAnalysis.candidates.length, 1);
  assert.equal((await readProductAnalysis(f.roots[1])).analysis.products[0].name, 'edit after committed import');
});

test('normal history preview derives its count from the completed artifact rather than the zero-at-claim catalog', async t => {
  const f = await fixture(t); await f.run(0, 'transcription');
  const task = [...f.tasks.values()][0]; assert.equal(task.catalog.count, 0);
  const query = new URLSearchParams({ sourceId: f.ids[1], taskKey: task.taskKey, resultSha: task.result.sha256 });
  let body;
  await f.workflows[1]({ method: 'GET', url: `/?${query}` }, { writeHead() {}, end(value) { body = JSON.parse(value); } }, f.roots[1], 'product-workflow/shared-history-preview');
  assert.equal(body.count, 6); assert.equal(body.requestCount, 0);
  assert.deepEqual(f.counts(), { asr: 1, text: 0 });
});
