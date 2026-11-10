import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStudio } from './server.mjs';
import { createSharedAnalysis, sharedHash } from './shared-analysis.mjs';
import { importSharedProductTranscript } from './product-transcription.mjs';
import { ensureStructureDraft } from './structure-drafts.mjs';

const base = resolve(fileURLToPath(new URL('../../../..', import.meta.url)), '.tmp/structure-workspace-route-tests');
async function fixture(t, { semantics = true } = {}) {
  await mkdir(base, { recursive: true }); const dir = await mkdtemp(join(base, 'route-'));
  const previous = Object.fromEntries(['DAOCUT_STUDIO_HOME', 'DAOCUT_LIBRARY', 'DAOCUT_TRASH_DIR', 'DAOCUT_EXPORTS'].map(key => [key, process.env[key]]));
  Object.assign(process.env, { DAOCUT_STUDIO_HOME: join(dir, 'home'), DAOCUT_LIBRARY: join(dir, 'library'), DAOCUT_TRASH_DIR: join(dir, 'trash'), DAOCUT_EXPORTS: join(dir, 'exports') });
  let studio;
  t.after(async () => {
    await studio?.close();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    assert.ok(resolve(dir).startsWith(base + sep)); await rm(dir, { recursive: true, force: true });
  });
  const fetchLocal = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (url, options) => {
    if (!studio || new URL(url).origin !== studio.origin) throw Error('Only this isolated Studio may be requested; models and remote traffic are forbidden');
    return fetchLocal(url, options);
  });
  const tasks = new Map(); let serial = 0, claims = 0, failPublication = false;
  const coordinate = async (op, body) => {
    let task = tasks.get(body.taskKey);
    if (op === 'status') return { task: structuredClone(task ?? null) };
    if (op === 'claim') {
      claims++;
      if (task) return { acquired: false, task: structuredClone(task) };
      task = { taskKey: body.taskKey, inputHash: body.inputHash, attemptId: `claim-${++serial}`, status: 'claimed' }; tasks.set(body.taskKey, task);
      return { acquired: true, task: structuredClone(task) };
    }
    assert.equal(body.attemptId, task?.attemptId);
    if (op === 'submitted') { const sendAllowed = task.status === 'claimed'; task.status = 'submitted'; return { sendAllowed, task: structuredClone(task) }; }
    if (op === 'complete') { if (task.status === 'complete') assert.deepEqual(task.result, body.result); task.status = 'complete'; task.result = body.result; }
    else if (op === 'fail') task.status = 'uncertain';
    return { task: structuredClone(task) };
  };
  const sharedOptions = { coordinate, settings: () => ({ enabled: true, resultRoots: [{ libraryId: 'synthetic-route-library', root: join(dir, 'mock-shared-results') }] }), readManifest: async () => ({ items: { 'assets/live.mp4': { libraryId: 'synthetic-route-library', relativePath: 'live.mp4' } } }), resolveSource: async (root, asset) => join(root, asset), publishFile: async (path, bytes) => { if (failPublication) throw Error('synthetic destination unavailable'); await writeFile(path, bytes); } };
  const start = () => startStudio({ port: 0, openBrowser() {}, sharedAnalysis: sharedOptions, liveAnalysis: { transcribe() { throw Error('No transcription'); }, modelClient() { throw Error('No model'); } } });
  studio = await start();
  const api = async (path, method = 'GET', body, expected = 200) => {
    const response = await fetch(`${studio.origin}${path}`, { method, headers: { 'x-studio-key': studio.key, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
  };
  const project = (await api('/api/projects', 'POST', { path: join(dir, 'project') })).project, root = project.path;
  const source = { id: 'source', assetPath: 'assets/live.mp4', durationMs: 120000 };
  await mkdir(join(root, 'assets'), { recursive: true }); await writeFile(join(root, source.assetPath), 'synthetic source, not a real recording');
  const cues = [
    { startMs: 0, endMs: 8000, text: '第一段完整钩子' },
    { startMs: 8000, endMs: 13000, text: '第一段完整痛点' },
    { startMs: 13000, endMs: 28000, text: '第一段完整核心卖点' },
    { startMs: 28000, endMs: 40000, text: '第一段完整购买指令' },
    { startMs: 60000, endMs: 70000, text: '返场专属钩子' },
    { startMs: 70000, endMs: 85000, text: '返场专属卖点' },
    { startMs: 85000, endMs: 95000, text: '返场专属购买指令' },
  ];
  const roles = ['hook', 'pain', 'core', 'purchase', 'hook', 'core', 'purchase'];
  const tags = { hook: '钩子', pain: '痛点', core: '卖点', purchase: '行动指令' };
  const candidates = cues.map((cue, index) => ({ ...cue, id: `candidate-${index}`, sourceId: source.id, productId: 'product', intervalId: index < 4 ? 'lecture-first' : 'lecture-return', cueRange: [index, index], tags: [tags[roles[index]]], details: {}, origin: 'ai-text', version: 'text-structure-v2' }));
  const analysis = { version: 1, sources: [source], products: [{ id: 'product', name: '模拟商品', sourceIds: [source.id] }], intervals: [{ id: 'lecture-first', sourceId: source.id, productId: 'product', startMs: 0, endMs: 60000 }, { id: 'lecture-return', sourceId: source.id, productId: 'product', startMs: 60000, endMs: 120000 }], candidates };
  await writeFile(join(root, '.film/product-analysis.json'), JSON.stringify(analysis));
  await importSharedProductTranscript(root, source, { cues, words: [] }, { schema: 'synthetic-transcript-v1', sha256: sharedHash(cues) });
  const store = createSharedAnalysis(sharedOptions);
  for (const interval of analysis.intervals) {
    const selected = candidates.filter(c => c.intervalId === interval.id), cueIndices = selected.map(c => c.cueRange[0]);
    const scope = { sourceId: source.id, productId: interval.productId, intervalId: interval.id, startMs: interval.startMs, endMs: interval.endMs };
    const descriptor = await store.prepare(root, source, { action: 'analysis', scope, data: { cues: cueIndices.map(index => cues[index]), cueIndices } });
    const attempt = await store.acquire(descriptor);
    const semanticReview = { version: 1, entries: selected.map(candidate => ({ candidateId: candidate.id, status: 'confirmed', roles: [roles[candidate.cueRange[0]]], coreIds: roles[candidate.cueRange[0]] === 'core' ? ['primary-benefit'] : [], requires: [], excludes: [], conditions: {} })) };
    await store.complete(root, descriptor, attempt.attemptId, { version: 'text-structure-v2', candidates: selected.map(c => ({ ...(semantics ? { id: c.id } : {}), cueRange: c.cueRange, tags: c.tags, details: c.details })), ...(semantics ? { semanticReview } : {}) });
  }
  const request = { sourceId: source.id, productId: 'product', intervalId: 'lecture-first' }, endpoint = `/api/projects/${project.id}`;
  const planPath = request => `${endpoint}/structure-plans?${new URLSearchParams(request)}`;
  return { api, root, project, source, request, endpoint, planPath, claims: () => claims, failPublication: value => { failPublication = value; }, restart: async () => { await studio.close(); studio = await start(); } };
}

test('default Studio routes show missing semantic details without a model call or a generation claim', async t => {
  const f = await fixture(t, { semantics: false }), count = f.claims();
  const before = await f.api(f.planPath(f.request));
  assert.equal(before.status, 'unavailable'); assert.ok(before.issues.some(item => item.code === 'SEMANTICS_UNREVIEWED'));
  const after = await f.api(`${f.endpoint}/structure-plans/generate`, 'POST', f.request);
  assert.equal(after.status, 'unavailable'); assert.equal(f.claims(), count);
});

test('default Studio routes exhaust one lecture, reuse its public plans, and create only the selected independent draft', async t => {
  const f = await fixture(t), filmBefore = await readFile(join(f.root, 'film.html'), 'utf8');
  assert.equal((await f.api(f.planPath(f.request))).status, 'idle');
  const count = f.claims(); let state;
  do { state = await f.api(`${f.endpoint}/structure-plans/generate`, 'POST', f.request); } while (state.status === 'running');
  assert.equal(state.status, 'complete'); assert.equal(state.allValidCombinationsEnumerated, true); assert.ok(state.plans.length > 1);
  assert.equal(state.plans.length, state.stats.emitted); assert.equal(f.claims(), count + 1);
  assert.ok(state.plans.every(plan => plan.scope.intervalId === f.request.intervalId && plan.clips.every(c => c.endMs <= 60000 && !c.text.includes('返场'))));
  assert.deepEqual((await f.api(f.planPath(f.request))).plans, state.plans); assert.equal(f.claims(), count + 1);
  const request = { ...f.request, taskKey: state.taskKey, planId: 'does-not-exist' };
  await f.api(`${f.endpoint}/structure-drafts`, 'POST', request, 409);
  assert.equal((await f.api(`${f.endpoint}/structure-workspace`)).drafts.length, 0);
  const chosen = { ...request, planId: state.plans[0].id };
  const draft = await f.api(`${f.endpoint}/structure-drafts`, 'POST', chosen);
  assert.equal(draft.meta.planId, chosen.planId); assert.notEqual(draft.project.id, f.project.id);
  const draftFilm = await readFile(join(draft.project.path, 'film.html'), 'utf8'); assert.match(draftFilm, /data-structure-original-text/);
  await writeFile(join(draft.project.path, 'film.html'), `${draftFilm}\n<!-- private first-draft edit -->`);
  const reopened = await f.api(`${f.endpoint}/structure-drafts`, 'POST', chosen); assert.equal(reopened.project.id, draft.project.id);
  assert.match(await readFile(join(draft.project.path, 'film.html'), 'utf8'), /private first-draft edit/);
  const otherDraft = await f.api(`${f.endpoint}/structure-drafts`, 'POST', { ...chosen, planId: state.plans[1].id });
  assert.notEqual(otherDraft.project.id, draft.project.id);
  assert.doesNotMatch(await readFile(join(otherDraft.project.path, 'film.html'), 'utf8'), /private first-draft edit/);
  const workspace = await f.api(`${f.endpoint}/structure-workspace/select`, 'POST', { projectId: draft.project.id });
  assert.equal(workspace.activeProjectId, draft.project.id); assert.equal(workspace.drafts.length, 2);
  await f.restart();
  assert.equal((await f.api(`${f.endpoint}/structure-workspace`)).activeProjectId, draft.project.id);
  assert.match(await readFile(join(draft.project.path, 'film.html'), 'utf8'), /private first-draft edit/);
  assert.deepEqual((await f.api(f.planPath(f.request))).plans, state.plans); assert.equal(f.claims(), count + 1);
  const returnScope = { ...f.request, intervalId: 'lecture-return' };
  await f.api(`${f.endpoint}/structure-drafts`, 'POST', { ...returnScope, taskKey: state.taskKey, planId: chosen.planId }, 409);
  assert.equal(await readFile(join(f.root, 'film.html'), 'utf8'), filmBefore);
});

test('a result awaiting public publication cannot be opened through the draft API', async t => {
  const f = await fixture(t); f.failPublication(true);
  let state;
  do { state = await f.api(`${f.endpoint}/structure-plans/generate`, 'POST', f.request); } while (state.status === 'running');
  assert.equal(state.status, 'publish-pending'); assert.ok(state.plans.length);
  await f.api(`${f.endpoint}/structure-drafts`, 'POST', { ...f.request, taskKey: state.taskKey, planId: state.plans[0].id }, 409);
  assert.equal((await f.api(`${f.endpoint}/structure-workspace`)).drafts.length, 0);
});

for (const action of ['list', 'rename', 'delete', 'locate-child', 'locate-parent-target', 'analyze-child', 'execute-child']) {
  test(`independent structure children cannot escape their workspace through ${action}`, async t => {
    const f = await fixture(t); let state;
    do { state = await f.api(`${f.endpoint}/structure-plans/generate`, 'POST', f.request); } while (state.status === 'running');
    let child;
    if (action === 'locate-parent-target') {
      const unregistered = await ensureStructureDraft(f.root, { parentProjectId: f.project.id, plan: state.plans[0] });
      child = { path: unregistered.root, id: `sd-${unregistered.meta.draftId}` };
    } else child = (await f.api(`${f.endpoint}/structure-drafts`, 'POST', { ...f.request, taskKey: state.taskKey, planId: state.plans[0].id })).project;
    const before = { film: await readFile(join(child.path, 'film.html'), 'utf8'), id: await readFile(join(child.path, '.film/id'), 'utf8'), analysis: await readFile(join(f.root, '.film/product-analysis.json'), 'utf8'), claims: f.claims() };
    if (action === 'list') assert.ok(!(await f.api('/api/projects')).projects.some(project => project.id === child.id));
    if (action === 'rename') await f.api(`/api/projects/${child.id}`, 'PATCH', { name: 'renamed-child' }, 409);
    if (action === 'delete') await f.api(`/api/projects/${child.id}`, 'DELETE', undefined, 409);
    if (action === 'locate-child') await f.api(`/api/projects/${child.id}/locate`, 'POST', { path: child.path }, 409);
    if (action === 'locate-parent-target') await f.api(`${f.endpoint}/locate`, 'POST', { path: child.path }, 409);
    if (action === 'analyze-child') await f.api(`/api/projects/${child.id}/live-analysis/analyze`, 'POST', { ...f.request, startMs: 0, endMs: 60000 }, 409);
    if (action === 'execute-child') await f.api(`/api/projects/${child.id}/product-workflow/execute`, 'POST', { confirmed: true, plan: { action: 'analysis', scope: { ...f.request, startMs: 0, endMs: 60000 } } }, 409);
    assert.equal(await readFile(join(child.path, 'film.html'), 'utf8'), before.film);
    assert.equal(await readFile(join(child.path, '.film/id'), 'utf8'), before.id);
    assert.equal(await readFile(join(f.root, '.film/product-analysis.json'), 'utf8'), before.analysis);
    assert.equal(f.claims(), before.claims);
  });
}

test('provided old lecture bounds are rejected before a public generation is claimed', async t => {
  const f = await fixture(t), count = f.claims();
  const stale = { ...f.request, startMs: 0, endMs: 59999 };
  await f.api(f.planPath(stale), 'GET', undefined, 409);
  await f.api(`${f.endpoint}/structure-plans/generate`, 'POST', stale, 409);
  assert.equal(f.claims(), count);
  assert.equal((await f.api(f.planPath({ ...f.request, startMs: 0, endMs: 60000 }))).status, 'idle');
});
