import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createSharedAnalysis } from './shared-analysis.mjs';
import { createLiveAnalysis, structureTranscriptHash } from './live-analysis.mjs';
import { createExistingAnalysisPublication } from './existing-analysis-publication.mjs';
import { createProductDiscovery } from './product-discovery-route.mjs';
import { createSharedAnalysis as createLedger } from '../../../../apps/company-service/src/shared-analysis.mjs';
import { transcriptionLocation } from './product-transcription.mjs';
import { sharedHash } from './shared-analysis.mjs';
import { readTranscriptReview } from './transcript-review.mjs';
import { applyProductEdit } from '../ui/src/lib/product-manual.ts';
import { updateProductAnalysis } from './product-analysis.mjs';
const Database = createRequire(new URL('../../../../apps/company-service/package.json', import.meta.url))('better-sqlite3');
const sha = value => createHash('sha256').update(value).digest('hex');
const base = resolve('../../.tmp/shared-existing-20261105/publication');
test('structure-plan results never enter legacy discovery or analysis import routes', async t => {
  const f = await fixture(t), service = f.make();
  const descriptor = await service.shared.prepareExisting(f.roots[0], f.source, { action: 'structure-plans', scope: { startMs: 0, endMs: 20000 }, count: 0, provenance: { kind: 'structure-plans-v1' }, payload: { input: 'synthetic' } });
  const claim = await service.shared.acquire(descriptor);
  await service.shared.complete(f.roots[0], descriptor, claim.attemptId, { schema: 'daocut.structure-plans.v1', plans: [] });
  assert.deepEqual((await service.publication.catalog(f.roots[0], f.source.id)).results, []);
  const task = f.tasks.get(descriptor.taskKey), request = { sourceId: f.source.id, taskKey: descriptor.taskKey, resultSha: task.result.sha256, confirmed: true };
  await assert.rejects(service.publication.preview(f.roots[0], request), /结构方案/);
  await assert.rejects(service.publication.importResult(f.roots[0], request), /结构方案/);
  assert.equal(await readFile(join(f.roots[0], 'film.html'), 'utf8'), 'private film');
});
async function fixture(t, extra = {}) {
  await mkdir(base, { recursive: true }); const dir = await mkdtemp(join(base, 'case-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let calls = 0; t.mock.method(globalThis, 'fetch', () => { calls++; throw Error('NO MODEL NETWORK'); });
  const roots = [join(dir, 'a'), join(dir, 'b')], tasks = new Map(); let serial = 0;
  const coordinate = async (op, body) => {
    const task = tasks.get(body.taskKey);
    if (op === 'catalog') return { results: [...tasks.values()].filter(x => x.status === 'complete' && x.catalog?.sourceIdentity === body.sourceIdentity).map(x => structuredClone(x)), coordinationId: 'test-company' };
    if (op === 'status') return { task: structuredClone(task ?? null), coordinationId: 'test-company' };
    if (op === 'claim') { if (task) return { acquired: false, task }; const value = { taskKey: body.taskKey, inputHash: body.inputHash, catalog: body.catalog, attemptId: `a-${++serial}`, status: 'claimed' }; tasks.set(body.taskKey, value); return { acquired: true, task: value, coordinationId: 'test-company' }; }
    assert.equal(task.attemptId, body.attemptId);
    if (op === 'submitted') { const sendAllowed = task.status === 'claimed'; task.status = 'submitted'; return { task, sendAllowed }; }
    if (op === 'complete') { task.status = 'complete'; task.result = body.result; return { task }; }
    throw Error(`unexpected operation ${op}`);
  };
  const source = { id: 'source-a', assetPath: 'assets/live.mp4', durationMs: 20000 };
  const range = { id: 'old-range', productId: 'product-a', sourceId: source.id, startMs: 0, endMs: 20000 };
  const candidates = Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, sourceId: source.id, productId: range.productId, intervalId: range.id, startMs: i * 400, endMs: i * 400 + 350, text: `模型原话${i}`, tags: ['卖点'], origin: 'ai-text', version: 'text-structure-v2', runId: 'run-original', cueRange: [i, i], details: { reason: '模拟模型原结果', evidence: ['ASR'], subtypes: [], context: '', repetition: '', review: [] } }));
  for (let i = 0; i < roots.length; i++) {
    const root = roots[i]; await mkdir(join(root, 'assets'), { recursive: true }); await mkdir(join(root, '.film/live-analysis'), { recursive: true }); await writeFile(join(root, source.assetPath), 'same synthetic source');
    await writeFile(join(root, 'film.html'), 'private film'); await writeFile(join(root, '.film/source-takes.json'), 'private takes');
    await writeFile(join(root, '.film/product-analysis.json'), JSON.stringify({ version: 1, sources: [{ ...source, id: i ? 'source-b' : source.id }], products: [{ id: i ? 'product-b' : 'product-a', name: i ? 'B本机商品' : 'A人工名字', sourceIds: [i ? 'source-b' : source.id] }], intervals: [{ ...range, id: i ? 'b-range' : range.id, sourceId: i ? 'source-b' : source.id, productId: i ? 'product-b' : 'product-a', startMs: i ? 5000 : 0 }], candidates: i ? [] : candidates }));
  }
  const info = await stat(join(roots[0], source.assetPath));
  const saved = { status: 'complete', currentRunId: 'run-original', attemptId: 'run-original', intervalId: range.id, productId: range.productId, rangeStartMs: 0, rangeEndMs: 20000, sourceFingerprint: `${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}`, candidateCount: 40, cacheIdentity: 'old-config-cache' };
  const raw = { version: 2, sourceId: source.id, transcription: { status: 'idle' }, analysis: saved, analyses: { [range.id]: saved }, results: { 'old-config-cache': saved }, attempts: { 'run-original': { id: 'run-original', status: 'complete', cacheIdentity: 'old-config-cache', windows: [{ status: 'complete', output: { candidates }, receipt: { provider: 'mock', model: 'old-model', status: 'completed' } }] } } };
  const statePath = join(roots[0], '.film/live-analysis', `${sha(source.id)}.json`); await writeFile(statePath, JSON.stringify(raw));
  const settings = () => ({ enabled: true, resultRoots: [{ libraryId: 'test-library', root: join(dir, 'mock-nas') }] });
  const storeOptions = { coordinate, settings, readManifest: async () => ({ items: { [source.assetPath]: { libraryId: 'test-library', relativePath: 'shows/live.mp4' } } }), ...extra };
  const make = () => { const shared = createSharedAnalysis(storeOptions), live = createLiveAnalysis({ modelClient: () => { calls++; throw Error('MODEL FORBIDDEN'); }, probeSource: async () => ({ duration: 20 }) }); return { shared, live, publication: createExistingAnalysisPublication({ sharedAnalysis: shared, liveAnalysis: live, probeSource: async () => ({ duration: 20 }) }) }; };
  return { roots, tasks, source, range, raw, statePath, make, calls: () => calls };
}
test('publish-only exports original 40 candidates despite current model configuration and imports without changing B lecture ranges', async t => {
  const f = await fixture(t), a = f.make(), b = f.make();
  const plan = await a.publication.plan(f.roots[0], { sourceId: f.source.id, action: 'analysis', runId: 'run-original', intervalId: 'old-range' });
  assert.equal(plan.requestCount, 0); assert.equal(plan.count, 40);
  await a.publication.publish(f.roots[0], { plan, confirmed: true });
  const catalog = await b.publication.catalog(f.roots[1], 'source-b'); assert.equal(catalog.results.length, 1);
  const result = catalog.results[0], request = { sourceId: 'source-b', taskKey: result.taskKey, resultSha: result.resultSha };
  const preview = await b.publication.preview(f.roots[1], request); assert.equal(preview.candidates.length, 40);
  await b.publication.importResult(f.roots[1], { ...request, productId: 'product-b', confirmed: true });
  const data = JSON.parse(await readFile(join(f.roots[1], '.film/product-analysis.json')));
  assert.equal(data.intervals[0].startMs, 5000); assert.equal(data.scopes.length, 1); assert.equal(data.scopes[0].startMs, 0); assert.equal(data.candidates.length, 40);
  const reopened = await f.make().publication.catalog(f.roots[1], 'source-b'); assert.equal(reopened.results.length, 1);
  const state = await b.live.view(f.roots[1], 'source-b', data.scopes[0].id, 'product-b'); assert.equal(state.analysis.historicalEditable, true); assert.equal(state.analysis.stale, true);
  await assert.rejects(b.live.startAnalysis(f.roots[1], { sourceId: 'source-b', intervalId: data.scopes[0].id, productId: 'product-b', startMs: 0, endMs: 20000, rerun: true }), /历史结果范围/);
  assert.equal(await readFile(join(f.roots[1], 'film.html'), 'utf8'), 'private film'); assert.equal(await readFile(join(f.roots[1], '.film/source-takes.json'), 'utf8'), 'private takes'); assert.equal(f.calls(), 0);
});
test('missing cache and changed plan refuse publication with zero model calls and no coordinator claim', async t => {
  const f = await fixture(t), a = f.make();
  await assert.rejects(a.publication.plan(f.roots[0], { sourceId: f.source.id, action: 'analysis', runId: 'missing' }));
  const plan = await a.publication.plan(f.roots[0], { sourceId: f.source.id, action: 'analysis', runId: 'run-original', intervalId: 'old-range' });
  f.raw.attempts['run-original'].windows[0].output.candidates[0].text = 'changed'; await writeFile(f.statePath, JSON.stringify(f.raw));
  await assert.rejects(a.publication.publish(f.roots[0], { plan, confirmed: true })); assert.equal(f.tasks.size, 0); assert.equal(f.calls(), 0);
});
test('simultaneous existing-result publication registers one task and preserves immutable first result', async t => {
  const f = await fixture(t), a = f.make(), a2 = f.make();
  const request = { sourceId: f.source.id, action: 'analysis', runId: 'run-original', intervalId: 'old-range' };
  const [p, q] = await Promise.all([a.publication.plan(f.roots[0], request), a2.publication.plan(f.roots[0], request)]);
  const settled = await Promise.allSettled([a.publication.publish(f.roots[0], { plan: p, confirmed: true }), a2.publication.publish(f.roots[0], { plan: q, confirmed: true })]);
  assert.ok(settled.some(x => x.status === 'fulfilled')); assert.equal(f.tasks.size, 1); assert.equal([...f.tasks.values()][0].status, 'complete'); assert.equal(f.calls(), 0);
});
test('NAS failure retains the exact outbox and explicit publish retry calls no model', async t => {
  let fail = true; const f = await fixture(t, { publishFile: async (path, data) => { if (fail) throw Object.assign(Error('isolated disk full'), { code: 'ENOSPC' }); await writeFile(path, data); } }), a = f.make();
  const plan = await a.publication.plan(f.roots[0], { sourceId: f.source.id, action: 'analysis', runId: 'run-original', intervalId: 'old-range' });
  await assert.rejects(a.publication.publish(f.roots[0], { plan, confirmed: true })); fail = false;
  const reopened = f.make(), retry = await reopened.publication.plan(f.roots[0], { sourceId: f.source.id, action: 'analysis', runId: 'run-original', intervalId: 'old-range' });
  await reopened.publication.publish(f.roots[0], { plan: retry, confirmed: true }); assert.equal(f.tasks.size, 1); assert.equal([...f.tasks.values()][0].status, 'complete'); assert.equal(f.calls(), 0);
});
test('historical import requires an explicit local product and supports a new personal product without a lecture interval', async t => {
  const f = await fixture(t), a = f.make(), b = f.make(); const plan = await a.publication.plan(f.roots[0], { sourceId: f.source.id, action: 'analysis', runId: 'run-original', intervalId: 'old-range' }); await a.publication.publish(f.roots[0], { plan, confirmed: true });
  const [item] = (await b.publication.catalog(f.roots[1], 'source-b')).results, req = { sourceId: 'source-b', taskKey: item.taskKey, resultSha: item.resultSha, confirmed: true };
  await assert.rejects(b.publication.importResult(f.roots[1], req));
  await b.publication.importResult(f.roots[1], { ...req, productName: '我确认的本机关联' });
  const data = JSON.parse(await readFile(join(f.roots[1], '.film/product-analysis.json'))); assert.equal(data.products.length, 2); assert.equal(data.intervals.length, 1); assert.equal(data.candidates.length, 40); assert.equal(f.calls(), 0);
});
test('historical discovery is a real saved proposal with remapped IDs and explicit apply, independent of modified subtitles', async t => {
  const f = await fixture(t), root = f.roots[1];
  const discovery = createProductDiscovery({ readTranscript: async () => { throw Error('pending private seam review'); }, modelClient: () => { throw Error('NO MODEL'); }, probeSource: async () => ({ duration: 20 }) });
  const payload = { version: 1, kind: 'historical-ai-discovery', originalRunId: 'ai-split', proposal: { version: 1, sourceId: 'source-a', products: [{ id: 'p-original', name: 'AI原商品', sourceIds: ['source-a'] }], intervals: [{ id: 'i-original', sourceId: 'source-a', productId: 'p-original', startMs: 8000, endMs: 19000 }], unassigned: [] } };
  const before = JSON.parse(await readFile(join(root, '.film/product-analysis.json')));
  const result = await discovery.importHistorical(root, 'source-b', payload, { sha256: 'a'.repeat(64) });
  assert.equal(result.proposal.products[0].sourceIds[0], 'source-b'); assert.notEqual(result.proposal.products[0].id, 'p-original');
  assert.deepEqual(JSON.parse(await readFile(join(root, '.film/product-analysis.json'))), before);
  await assert.rejects(discovery.apply(root, { sourceId: 'source-b', runId: result.runId, expected: before }));
  await discovery.apply(root, { sourceId: 'source-b', runId: result.runId, expected: before, replaceReviewed: true });
  const after = JSON.parse(await readFile(join(root, '.film/product-analysis.json'))); assert.equal(after.intervals[0].startMs, 8000); assert.equal(after.products[0].name, 'AI原商品'); assert.equal(f.calls(), 0);
});
test('replacing source during historical import never grants editable status to old candidates', async t => {
  const f = await fixture(t), a = f.make(), b = f.make(), root = f.roots[1];
  const plan = await a.publication.plan(f.roots[0], { sourceId: f.source.id, action: 'analysis', runId: 'run-original' }); await a.publication.publish(f.roots[0], { plan, confirmed: true });
  const [row] = (await b.publication.catalog(root, 'source-b')).results;
  const live = createLiveAnalysis({ probeSource: async () => { await writeFile(join(root, 'assets/live.mp4'), 'replacement content'); return { duration: 20 }; } });
  const publication = createExistingAnalysisPublication({ sharedAnalysis: b.shared, liveAnalysis: live });
  await assert.rejects(publication.importResult(root, { ...row, sourceId: 'source-b', productId: 'product-b', confirmed: true }));
  const state = await live.view(root, 'source-b'); assert.ok(Object.values(state.analyses).every(v => !v.historicalEditable)); assert.equal(f.calls(), 0);
});
test('two isolated clients publish and reuse all three historical artifacts through the real SQLite company ledger', async t => {
  const db = new Database(':memory:'); t.after(() => db.close()); db.exec("CREATE TABLE user(id TEXT PRIMARY KEY); INSERT INTO user VALUES('alice'),('bob')");
  let actor = 'alice'; const ledger = createLedger(db), coordinate = async (op, { expectedCoordinatorId, ...body }) => { if (expectedCoordinatorId) assert.equal(expectedCoordinatorId, 'test-company'); return { ...ledger[op](actor, body), coordinationId: 'test-company' }; };
  const f = await fixture(t, { coordinate }), [root, other] = f.roots, a = f.make(), b = f.make(), loc = await transcriptionLocation(root, f.source);
  await mkdir(loc.dir, { recursive: true });
  const c = (text, startMs, endMs) => ({ text, startMs, endMs });
  const segments = [
    { id: 'part1', startMs: 0, endMs: 11000, coreStartMs: 0, coreEndMs: 10000, status: 'complete', cues: [c('原始前文', 0, 9000), c('交界截断因为', 9500, 10900)], words: [] },
    { id: 'part2', startMs: 9000, endMs: 20000, coreStartMs: 10000, coreEndMs: 20000, status: 'complete', cues: [c('交界不同后文', 500, 2500), c('完整后文', 3000, 10000)], words: [] },
  ];
  await writeFile(loc.path, JSON.stringify({ version: 1, sourceId: f.source.id, assetPath: f.source.assetPath, durationMs: 20000, fingerprint: loc.fingerprint, status: 'complete', cues: [c('PRIVATE EDIT DO NOT SHARE', 0, 19900)], words: [], boundaryReview: { kind: 'agent-local-boundary-review', secret: 'PRIVATE-SECRET' } }));
  await writeFile(loc.path + '.segments.json', JSON.stringify({ version: 1, sourceId: f.source.id, durationMs: 20000, segments }));
  const info = await stat(join(root, f.source.assetPath)), discoveryFingerprint = sharedHash({ sourceId: f.source.id, assetPath: f.source.assetPath, resolvedPath: join(root, f.source.assetPath).replaceAll('/', '\\'), size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, ino: info.ino, durationMs: 20000 });
  const proposal = { version: 1, sourceId: f.source.id, products: [{ id: 'original-p', name: '原AI商品', sourceIds: [f.source.id] }], intervals: [{ id: 'original-i', sourceId: f.source.id, productId: 'original-p', startMs: 5000, endMs: 19900 }], unassigned: [] };
  await mkdir(join(root, '.film/product-discovery')); await writeFile(join(root, '.film/product-discovery', sharedHash(f.source.id) + '.json'), JSON.stringify({ version: 1, sourceId: f.source.id, runs: [{ id: 'original-split', status: 'complete', fingerprint: discoveryFingerprint, completed: [{ untrustedExtra: 'PRIVATE-SECRET' }], proposal }] }));
  f.raw.attempts['run-original'].windows[0].receipt.endpoint = 'https://example.invalid?api_key=PRIVATE-SECRET'; f.raw.attempts['run-original'].windows[0].output.candidates[0].details.config = { token: 'PRIVATE-SECRET' }; await writeFile(f.statePath, JSON.stringify(f.raw));
  const inventory = await a.publication.inventory(root, f.source.id); assert.equal(inventory.results.length, 3);
  for (const item of inventory.results) { const plan = await a.publication.plan(root, { ...item, sourceId: f.source.id }); await a.publication.publish(root, { plan, confirmed: true }); }
  assert.equal(db.prepare("SELECT count(*) n FROM company_shared_analysis WHERE status='complete'").get().n, 3);
  actor = 'bob'; const rows = (await b.publication.catalog(other, 'source-b')).results; assert.equal(rows.length, 3);
  const discovery = createProductDiscovery({ probeSource: async () => ({ duration: 20 }) }), publication = createExistingAnalysisPublication({ sharedAnalysis: b.shared, liveAnalysis: b.live, discovery });
  for (const row of rows) {
    const req = { ...row, sourceId: 'source-b', confirmed: true, ...(row.action === 'analysis' ? { productId: 'product-b' } : {}) };
    const preview = await publication.preview(other, req); assert.doesNotMatch(JSON.stringify(preview), /PRIVATE-SECRET|PRIVATE EDIT DO NOT SHARE/); assert.equal(preview.canImport, true);
    const result = await publication.importResult(other, req); if (row.action === 'transcription') assert.equal(result.needsReview, true);
  }
  assert.equal((await readTranscriptReview(other, 'source-b')).pendingCount, 1);
  const data = JSON.parse(await readFile(join(other, '.film/product-analysis.json'))); assert.equal(data.candidates.length, 40); assert.equal(data.intervals[0].startMs, 5000);
  assert.equal((await discovery.view(other, 'source-b')).proposal.products[0].name, '原AI商品'); assert.equal(f.calls(), 0);
  assert.equal((await b.shared.versions(other, 'source-b')).groups.length, 0);
});
test('an interruption after coordinator admission resumes publishing exact local bytes without a new task', async t => {
  const f = await fixture(t), a = f.make();
  const plan = await a.publication.plan(f.roots[0], { sourceId: f.source.id, action: 'analysis', runId: 'run-original' });
  t.mock.method(a.shared, 'complete', async () => { throw Error('isolated process interruption before outbox'); });
  await assert.rejects(a.publication.publish(f.roots[0], { plan, confirmed: true }));
  const reopened = f.make(), retry = await reopened.publication.plan(f.roots[0], { sourceId: f.source.id, action: 'analysis', runId: 'run-original' });
  await reopened.publication.publish(f.roots[0], { plan: retry, confirmed: true }); assert.equal(f.tasks.size, 1); assert.equal([...f.tasks.values()][0].status, 'complete'); assert.equal(f.calls(), 0);
});
test('source replacement after shared selection is refused before writing historical candidates', async t => {
  const f = await fixture(t), a = f.make(), b = f.make(), root = f.roots[1];
  const plan = await a.publication.plan(f.roots[0], { sourceId: f.source.id, action: 'analysis', runId: 'run-original' }); await a.publication.publish(f.roots[0], { plan, confirmed: true });
  const [row] = (await b.publication.catalog(root, 'source-b')).results, before = await readFile(join(root, '.film/product-analysis.json'), 'utf8');
  const select = b.shared.historicalArtifact; b.shared.historicalArtifact = async (...args) => { const value = await select(...args); await writeFile(join(root, 'assets/live.mp4'), 'replacement between verification and import'); return value; };
  await assert.rejects(b.publication.importResult(root, { ...row, sourceId: 'source-b', productId: 'product-b', confirmed: true })); assert.equal(await readFile(join(root, '.film/product-analysis.json'), 'utf8'), before); assert.equal(f.calls(), 0);
});
test('lost claim acknowledgement recovers the original client attempt, never entering paid retry workflow', async t => {
  const db = new Database(':memory:'); t.after(() => db.close()); db.exec("CREATE TABLE user(id TEXT PRIMARY KEY); INSERT INTO user VALUES('alice')"); const ledger = createLedger(db); let lost = true;
  const coordinate = async (op, { expectedCoordinatorId, ...body }) => { const result = ledger[op]('alice', body); if (op === 'claim' && lost) { lost = false; throw Error('claim response lost'); } return { ...result, coordinationId: 'test-company' }; };
  const f = await fixture(t, { coordinate }), a = f.make(); const req = { sourceId: f.source.id, action: 'analysis', runId: 'run-original' };
  const plan = await a.publication.plan(f.roots[0], req); await assert.rejects(a.publication.publish(f.roots[0], { plan, confirmed: true }));
  assert.equal(await a.shared.status(f.roots[0], f.source.id), undefined);
  const reopened = f.make(), retry = await reopened.publication.plan(f.roots[0], req); await reopened.publication.publish(f.roots[0], { plan: retry, confirmed: true });
  assert.equal(db.prepare('SELECT count(*) n FROM company_shared_analysis_attempt').get().n, 1); assert.equal(db.prepare('SELECT status FROM company_shared_analysis').get().status, 'complete'); assert.equal(f.calls(), 0);
});
test('scope provenance is verified only when the original whole-transcript identity still matches', async t => {
  const f = await fixture(t), a = f.make(), root = f.roots[0], loc = await transcriptionLocation(root, f.source);
  const cues = f.raw.attempts['run-original'].windows[0].output.candidates.map(({ text, startMs, endMs }) => ({ text, startMs, endMs }));
  const cache = { version: 1, sourceId: f.source.id, assetPath: f.source.assetPath, durationMs: 20000, fingerprint: loc.fingerprint, status: 'complete', cues, words: [] };
  await mkdir(loc.dir, { recursive: true }); await writeFile(loc.path, JSON.stringify(cache)); await writeFile(loc.path + '.segments.json', JSON.stringify({ version: 1, sourceId: f.source.id, durationMs: 20000, segments: [{ id: 'whole', startMs: 0, endMs: 20000, coreStartMs: 0, coreEndMs: 20000, status: 'complete', cues, words: [] }] }));
  for (const saved of [f.raw.analysis, ...Object.values(f.raw.analyses), ...Object.values(f.raw.results)]) saved.transcriptHash = structureTranscriptHash(cache);
  await writeFile(f.statePath, JSON.stringify(f.raw));
  const req = { sourceId: f.source.id, action: 'analysis', runId: 'run-original' }, checked = await a.publication.plan(root, req);
  assert.equal(checked.provenance.inputHashKind, 'whole-transcript-with-words-v1'); assert.equal(checked.provenance.inputStatus, 'verified-local-snapshot'); assert.equal(checked.provenance.originalAsrMatch, true); assert.match(checked.provenance.scopeInputHash, /^[a-f0-9]{64}$/);
  cache.cues[0].text = '私人后改'; await writeFile(loc.path, JSON.stringify(cache)); const changed = await a.publication.plan(root, req);
  assert.equal(changed.provenance.inputStatus, 'historical-unverified'); assert.equal(changed.provenance.scopeInputHash, undefined); assert.equal(f.calls(), 0);
});
test('merging a personal product keeps imported historical candidates editable and leaves shared AI unchanged', async t => {
  const f = await fixture(t), a = f.make(), b = f.make(), root = f.roots[1]; const plan = await a.publication.plan(f.roots[0], { sourceId: f.source.id, action: 'analysis', runId: 'run-original' }); await a.publication.publish(f.roots[0], { plan, confirmed: true });
  const [row] = (await b.publication.catalog(root, 'source-b')).results, req = { ...row, sourceId: 'source-b', productId: 'product-b', confirmed: true };
  await b.publication.importResult(root, req); const beforeShared = await b.publication.preview(root, req);
  await updateProductAnalysis(root, data => { data.products.push({ id: 'merge-target', name: '本机合并商品', sourceIds: ['source-b'] }); return applyProductEdit(data, { type: 'merge', productId: 'product-b', targetId: 'merge-target' }); }, async () => ({ duration: 20 }));
  const data = JSON.parse(await readFile(join(root, '.film/product-analysis.json'))), scope = data.scopes[0], state = await f.make().live.view(root, 'source-b', scope.id, 'merge-target');
  assert.equal(data.candidates.length, 40); assert.ok(data.candidates.every(c => c.productId === 'merge-target')); assert.equal(state.analysis.historicalEditable, true); assert.equal(state.analysis.productId, 'merge-target'); assert.equal(state.analysis.stale, true);
  assert.deepEqual(await b.publication.preview(root, req), beforeShared); assert.equal(f.calls(), 0);
});
