import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSharedAnalysis } from '../src/shared-analysis.mjs';
import { createCompanyClient } from '../../desktop/src/company-client.mjs';
import { createSharedAnalysis as createStudioStore } from '../../../packages/daocut/studio/server/shared-analysis.mjs';

async function fixture(t) {
  const base = fileURLToPath(new URL('../../../.tmp/shared-retry-contract/', import.meta.url));
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, 'case-'));
  const db = new Database(join(dir, 'company.sqlite'));
  db.exec("CREATE TABLE user (id TEXT PRIMARY KEY); INSERT INTO user VALUES ('alice'),('bob')");
  t.after(async () => {
    db.close();
    assert.ok(resolve(dir).startsWith(resolve(base) + sep));
    await rm(dir, { recursive: true, force: true });
  });
  t.mock.method(globalThis, 'fetch', () => { throw Error('Real network forbidden'); });
  let coordinator = createSharedAnalysis(db);
  const calls = [], user = { id: 'alice', username: 'alice', role: 'user', enabled: true };
  const client = createCompanyClient({ dataDir: join(dir, 'desktop'), appVersion: 'test', request: async (_profile, endpoint, options) => {
    if (endpoint === '/login') return { user, token: 'synthetic-auth' };
    if (endpoint === '/session') return { user };
    assert.match(endpoint, /^\/shared-analysis\/[a-z]+$/);
    const action = endpoint.split('/').at(-1);
    calls.push({ action, body: structuredClone(options.body) });
    return coordinator[action]('alice', options.body);
  } });
  client.configure({ name: 'Isolated test', serverUrl: 'https://company.invalid', caPem: '' });
  await client.login({ username: 'alice', password: 'synthetic' });
  const root = join(dir, 'personal'), resultRoot = join(dir, 'shared-results');
  await mkdir(join(root, 'assets'), { recursive: true });
  await writeFile(join(root, 'assets/live.mp4'), 'synthetic source only');
  await writeFile(join(root, 'film.html'), 'existing personal film');
  const options = {
    coordinate: (action, body) => client.sharedAnalysis(action, body),
    settings: () => ({ enabled: true, resultRoots: [{ libraryId: 'test', root: resultRoot }] }),
    readManifest: async () => ({ items: { 'assets/live.mp4': { libraryId: 'test', relativePath: 'live.mp4' } } }),
    resolveSource: async () => join(root, 'assets/live.mp4'),
  };
  const source = { id: 'source', assetPath: 'assets/live.mp4', durationMs: 20000 };
  const input = { action: 'analysis', scope: { startMs: 5000, endMs: 15000 }, data: ['synthetic lecture'], contract: { model: 'mock' } };
  return { root, db, calls, source, input,
    make: extra => createStudioStore({ ...options, ...extra }),
    reopen: () => { coordinator = createSharedAnalysis(db); return createStudioStore(options); },
    state: () => coordinator,
  };
}

for (const newVersion of [false, true]) {
  test(`${newVersion ? 'new-version' : 'first-result'} explicit retry passes desktop and SQLite contracts without replacing catalog`, async t => {
    const f = await fixture(t);
    let store = f.make(), first;
    if (newVersion) {
      first = await store.prepare(f.root, f.source, f.input);
      const claim = await store.acquire(first);
      await store.complete(f.root, first, claim.attemptId, { text: 'original completed result' });
    }
    const input = { ...f.input, newVersion };
    const plan = await store.prepare(f.root, f.source, input), attempt = await store.acquire(plan);
    const catalogBefore = f.db.prepare('SELECT * FROM company_shared_analysis_catalog WHERE taskKey=?').get(plan.taskKey);
    const versionBefore = f.db.prepare('SELECT * FROM company_shared_analysis_version WHERE taskKey=?').get(plan.taskKey);
    const firstResult = first && f.state().status('bob', { taskKey: first.taskKey }).task.result;
    assert.deepEqual(f.calls.filter(c => c.action === 'claim').at(-1).body.catalog, plan.catalog);
    await store.fail(plan, attempt.attemptId);
    store = f.reopen();
    const retryPlan = await store.prepare(f.root, f.source, input);
    assert.equal(retryPlan.mode, 'retry-required');
    assert.equal(f.state().status('alice', { taskKey: plan.taskKey }).task.status, 'uncertain');
    const before = f.calls.length;
    await assert.rejects(store.acquire(retryPlan), /明确确认/);
    assert.equal(f.calls.length, before, 'unknown result never automatically resubmits');
    const retry = await store.acquire(retryPlan, { retryAcknowledged: true });
    assert.notEqual(retry.attemptId, attempt.attemptId);
    const request = f.calls.find(c => c.action === 'retry').body;
    assert.deepEqual(Object.keys(request).sort(), ['acknowledged', 'clientAttemptId', 'expectedAttemptId', 'inputHash', 'taskKey']);
    assert.equal(request.expectedAttemptId, attempt.attemptId);
    assert.equal(request.inputHash, plan.inputHash);
    assert.equal(request.taskKey, plan.taskKey);
    assert.equal(request.acknowledged, true);
    assert.deepEqual(f.db.prepare('SELECT * FROM company_shared_analysis_catalog WHERE taskKey=?').get(plan.taskKey), catalogBefore);
    assert.deepEqual(f.db.prepare('SELECT * FROM company_shared_analysis_version WHERE taskKey=?').get(plan.taskKey), versionBefore);
    await store.complete(f.root, retryPlan, retry.attemptId, { text: 'completed synthetic result' });
    const history = f.state().catalog('bob', { sourceIdentity: plan.sourceIdentity }).results;
    assert.deepEqual(history.find(item => item.taskKey === plan.taskKey).catalog, plan.catalog);
    assert.equal(f.state().versions('bob', { taskKey: plan.familyKey }).versions.length, newVersion ? 2 : 1);
    store = f.reopen();
    const reused = await store.prepare(f.root, f.source, input);
    assert.equal(reused.mode, 'reuse');
    const after = f.calls.length;
    await assert.rejects(store.acquire(reused, { retryAcknowledged: true }));
    assert.equal(f.calls.length, after, 'completed results cannot be retried');
    if (first) assert.deepEqual(f.state().status('bob', { taskKey: first.taskKey }).task.result, firstResult);
    assert.equal(await readFile(join(f.root, 'film.html'), 'utf8'), 'existing personal film');
  });
}

test('publication failure recovers saved output after reopen without claim or retry', async t => {
  const f = await fixture(t);
  let store = f.make({ publishFile: async () => { throw Error('synthetic shared-folder offline'); } });
  const plan = await store.prepare(f.root, f.source, f.input), attempt = await store.acquire(plan);
  await assert.rejects(store.complete(f.root, plan, attempt.attemptId, { text: 'already calculated' }), /保存|publish/i);
  const originalClaims = f.calls.filter(c => c.action === 'claim').length;
  store = f.reopen();
  assert.equal((await store.prepare(f.root, f.source, f.input)).mode, 'publish-pending');
  await store.publish(f.root, f.source.id, plan.taskKey);
  assert.equal(f.calls.filter(c => c.action === 'claim').length, originalClaims);
  assert.equal(f.calls.filter(c => c.action === 'retry').length, 0);
  const completed = f.state().status('bob', { taskKey: plan.taskKey }).task;
  assert.equal(completed.attemptId, attempt.attemptId);
  assert.equal(completed.status, 'complete');
  const reused = await store.prepare(f.root, f.source, f.input);
  assert.deepEqual((await store.read(f.root, reused)).payload, { text: 'already calculated' });
  assert.equal(await readFile(join(f.root, 'film.html'), 'utf8'), 'existing personal film');
});
