import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCompanyService } from '../src/service.mjs';
import { createCompanyClient } from '../../desktop/src/company-client.mjs';
import { createDesktopTextService } from '../../desktop/src/desktop-analysis-service.mjs';
import { createDesktopAnalysisServices } from '../../../packages/daocut/studio/server/desktop-analysis-services.mjs';
import { createSharedAnalysis } from '../../../packages/daocut/studio/server/shared-analysis.mjs';

const testRoot = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)), '.tmp/shared-live-20261104/coordinator');

test('real isolated company HTTP and desktop bridge admit one shared analysis and another account reads its first result', async (t) => {
  await mkdir(testRoot, { recursive: true });
  const dir = await mkdtemp(path.join(testRoot, 'desktop-http-'));
  let service;
  t.after(async () => {
    await service?.close();
    if (!path.resolve(dir).startsWith(testRoot + path.sep)) throw new Error('Unsafe shared desktop test cleanup');
    await rm(dir, { recursive: true, force: true });
  });
  service = await createCompanyService({ dataDir: path.join(dir, 'company'), host: '127.0.0.1', port: 0, baseURL: 'http://127.0.0.1:4715' });
  await service.listen();
  const serverUrl = `http://127.0.0.1:${service.server.address().port}`;
  const credentials = [
    { username: 'shared.alice', name: 'Shared Alice', password: 'Synthetic-Desktop-Alice-42!' },
    { username: 'shared.bob', name: 'Shared Bob', password: 'Synthetic-Desktop-Bob-42!' },
  ];
  const request = async (route, body, token) => {
    const response = await fetch(`${serverUrl}/api/company/${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    assert.ok(response.ok); return response.json();
  };
  await request('setup', credentials[0]);
  const firstLogin = await request('login', credentials[0]);
  await request('users', credentials[1], firstLogin.token);
  const clients = credentials.map((_, index) => createCompanyClient({ dataDir: path.join(dir, `client-${index}`), appVersion: 'synthetic-shared-test', allowLoopbackHttp: true }));
  for (const [index, client] of clients.entries()) {
    client.configure({ name: 'Isolated test company', serverUrl, caPem: '' });
    assert.equal((await client.login(credentials[index])).status, 'signed-in');
  }
  // Company transport uses native local HTTP. Any accidental model fetch is forbidden.
  t.mock.method(globalThis, 'fetch', () => { throw Error('No real model or remote request allowed'); });
  let modelCalls = 0;
  const roots = [path.join(dir, 'alice-project'), path.join(dir, 'bob-project')], resultRoot = path.join(dir, 'mock-nas-results');
  const sources = roots.map((_, index) => ({ id: `personal-source-${index}`, assetPath: 'assets/live.mp4', durationMs: 20000 }));
  const stores = clients.map((client) => {
    const textBridge = createDesktopTextService({ company: () => client, roster: () => { throw Error('Model configuration must not be accessed for coordination'); }, fetch: () => { throw Error('Model transport must not run'); } });
    const services = createDesktopAnalysisServices({ textBridge });
    return createSharedAnalysis({
      coordinate: services.sharedAnalysis.coordinate,
      settings: () => ({ enabled: true, resultRoots: [{ libraryId: 'isolated-live-library', root: resultRoot }] }),
      readManifest: async () => ({ items: { 'assets/live.mp4': { libraryId: 'isolated-live-library', relativePath: 'show/live.mp4' } } }),
      resolveSource: async (root, assetPath) => path.join(root, assetPath),
    });
  });
  for (const root of roots) {
    await mkdir(path.join(root, 'assets'), { recursive: true });
    await writeFile(path.join(root, 'assets/live.mp4'), 'synthetic original video bytes');
    await writeFile(path.join(root, 'film.html'), 'private original film');
  }
  const input = { action: 'discovery', data: [{ startMs: 0, endMs: 1500, text: 'Synthetic product A' }], contract: { model: 'simulated-only', prompt: 'synthetic-v1' } };
  const plans = await Promise.all(stores.map((store, index) => store.prepare(roots[index], sources[index], input)));
  assert.equal(plans[0].taskKey, plans[1].taskKey);
  assert.match(plans[0].coordinationId, /^[a-f0-9]{64}$/);
  const attempts = await Promise.allSettled(stores.map((store, index) => store.acquire(plans[index])));
  assert.equal(attempts.filter((item) => item.status === 'fulfilled').length, 1);
  const winner = attempts.findIndex((item) => item.status === 'fulfilled'), follower = 1 - winner;
  const attempt = attempts[winner].value;
  const replay = await clients[winner].sharedAnalysis('submitted', { taskKey: plans[winner].taskKey, attemptId: attempt.attemptId, expectedCoordinatorId: plans[winner].coordinationId });
  assert.equal(replay.sendAllowed, false, 'HTTP acknowledgement replay cannot send a second request');
  const payload = await (async () => { modelCalls++; return { products: ['A', 'B'], ranges: [['A', 0, 4000], ['B', 4000, 8000], ['A', 8000, 12000]] }; })();
  await stores[winner].complete(roots[winner], plans[winner], attempt.attemptId, payload, { model: 'simulated-only' });
  const reused = await stores[follower].prepare(roots[follower], sources[follower], { ...input, contract: { model: 'simulated-new-default', prompt: 'synthetic-v2' } });
  assert.equal(reused.mode, 'reuse', 'model settings changes keep the saved first shared result');
  assert.deepEqual((await stores[follower].read(roots[follower], reused)).payload, payload);
  assert.equal(modelCalls, 1);
  const saved = await clients[follower].sharedAnalysis('status', { taskKey: reused.taskKey });
  assert.equal(saved.task.status, 'complete'); assert.equal(saved.task.ownerId, clients[winner].state().user.id);
  assert.deepEqual(saved.task.result, { path: reused.result.path, schema: reused.result.schema, sha256: reused.result.sha256 });
  for (const root of roots) {
    assert.equal(await readFile(path.join(root, 'film.html'), 'utf8'), 'private original film');
    assert.equal(await readFile(path.join(root, 'assets/live.mp4'), 'utf8'), 'synthetic original video bytes');
  }
  const sharedBytes = await readFile(path.join(resultRoot, saved.task.result.path), 'utf8');
  assert.equal(sharedBytes.includes(firstLogin.token), false);
  assert.equal(sharedBytes.includes(credentials[0].password), false);
  const bridge = createDesktopTextService({ company: () => clients[winner], roster: () => { throw Error('No model settings for seam status'); } });
  const reviewCoordinate = createDesktopAnalysisServices({ textBridge: bridge }).sharedAnalysis.coordinate;
  const reviewKey = 'e'.repeat(64), reviewHash = 'f'.repeat(64);
  const reviewTask = await reviewCoordinate('claim', { taskKey: reviewKey, inputHash: reviewHash, clientAttemptId: 'paid-audio-awaiting-review' });
  const reviewAttempt = { taskKey: reviewKey, attemptId: reviewTask.task.attemptId, expectedCoordinatorId: reviewTask.coordinationId };
  assert.equal((await reviewCoordinate('submitted', reviewAttempt)).sendAllowed, true);
  assert.equal((await reviewCoordinate('fail', { ...reviewAttempt, reason: 'needs-review' })).task.status, 'needs-review');
  await assert.rejects(reviewCoordinate('retry', { taskKey: reviewKey, inputHash: reviewHash, expectedAttemptId: reviewTask.task.attemptId, clientAttemptId: 'forbidden-paid-audio-retry', acknowledged: true }), error => error.status === 409 && error.code === 'SHARED_STATE_CONFLICT');
  assert.equal(modelCalls, 1, 'seam status registration and rejection never submit audio or a model request');
  const historical = { action: 'analysis', scope: { startMs: 120, endMs: 19000 }, count: 40, provenance: { kind: 'historical-ai-output', inputHashKind: 'whole-transcript-with-words-v1', inputStatus: 'historical-unverified', scopeInputHash: null, originalAsrMatch: null }, payload: { version: 1, kind: 'historical-ai-structure', candidates: Array.from({ length: 40 }, (_, n) => ({ text: `saved ${n}`, startMs: n * 400 + 120, endMs: n * 400 + 350 })) } };
  const historicalPlan = await stores[0].prepareExisting(roots[0], sources[0], historical), historicalClaim = await stores[0].acquire(historicalPlan);
  await stores[0].complete(roots[0], historicalPlan, historicalClaim.attemptId, historical.payload);
  const catalogue = await stores[1].history(roots[1], sources[1]);
  assert.deepEqual(catalogue.results.map(item => item.taskKey).sort(), [reused.taskKey, historicalPlan.taskKey].sort(), 'both completed discovery and historical analysis remain available');
  assert.equal(catalogue.results.find(item => item.taskKey === reused.taskKey)?.catalog.action, 'discovery');
  const item = catalogue.results.find(item => item.taskKey === historicalPlan.taskKey);
  assert.ok(item); assert.equal(item.catalog.action, 'analysis'); assert.equal(item.catalog.count, 40);
  const selected = await stores[1].historicalArtifact(roots[1], sources[1], item.taskKey, item.result.sha256); assert.equal(selected.snapshot.payload.candidates.length, 40); assert.equal(modelCalls, 1);
  await assert.rejects(clients[0].sharedAnalysis('claim', { taskKey: '8'.repeat(64), inputHash: '9'.repeat(64), clientAttemptId: 'bad-catalog', catalog: { ...item.catalog, provenance: { kind: { apiKey: 'forbidden-private-config' } } } }));
});
