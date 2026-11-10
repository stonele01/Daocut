import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { createCompanyService } from '../src/service.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)), '.tmp/shared-live-20261104/coordinator');
const moduleUrl = new URL('../src/shared-analysis.mjs', import.meta.url).href;
const taskKey = 'a'.repeat(64), inputHash = 'b'.repeat(64);
const claimBody = (clientAttemptId = 'request-1', key = taskKey) => ({ taskKey: key, inputHash, clientAttemptId });
const result = { path: 'live/abc/results/products.json', sha256: 'c'.repeat(64), schema: 'daocut.shared-analysis.v1' };
const conflict = (code) => (error) => error.status === 409 && error.code === code;
async function fixture(t) {
  await mkdir(root, { recursive: true });
  const dataDir = await mkdtemp(path.join(root, 'state-'));
  const connections = [];
  t.after(async () => {
    for (const db of connections) if (db.open) db.close();
    if (!path.resolve(dataDir).startsWith(root + path.sep)) throw new Error('Unsafe shared analysis test cleanup');
    await rm(dataDir, { recursive: true, force: true });
  });
  const { createSharedAnalysis } = await import(moduleUrl);
  const dbPath = path.join(dataDir, 'company.sqlite');
  let now = Date.parse('2026-11-04T00:00:00Z');
  const open = () => {
    const db = new Database(dbPath); connections.push(db);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS user(id TEXT PRIMARY KEY); INSERT OR IGNORE INTO user VALUES (\'alice\'),(\'bob\');');
    return { db, state: createSharedAnalysis(db, { now: () => now }) };
  };
  return { ...open(), open, dbPath, advance: () => { now += 30 * 86400_000; } };
}
const attemptBody = (task) => ({ taskKey: task.taskKey, attemptId: task.attemptId });

test('first claimant wins across independent database connections and another live remains separate', async (t) => {
  const f = await fixture(t), second = f.open().state;
  assert.equal(f.state.status('alice', { taskKey }).task, null);
  const first = f.state.claim('alice', claimBody());
  const next = second.claim('bob', claimBody('bob-request'));
  assert.equal(first.acquired, true); assert.equal(next.acquired, false);
  assert.equal(next.task.ownerId, 'alice'); assert.equal(next.task.attemptId, first.task.attemptId);
  assert.equal(second.claim('bob', claimBody('other-live', 'd'.repeat(64))).acquired, true);
});

test('simultaneous independent workers atomically claim only one owner', async (t) => {
  const f = await fixture(t);
  const workers = ['alice', 'bob'].map((ownerId) => new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const Database = require(workerData.databaseModule);
    import(workerData.moduleUrl).then(({ createSharedAnalysis }) => {
      const db = new Database(workerData.dbPath); db.pragma('busy_timeout=5000');
      const state = createSharedAnalysis(db);
      parentPort.once('message', () => { try { parentPort.postMessage(state.claim(workerData.ownerId, workerData.body)); } catch (error) { parentPort.postMessage({ error: error.message }); } finally { db.close(); } });
      parentPort.postMessage('ready');
    }).catch(error => { throw error; });`, { eval: true, workerData: { ownerId, moduleUrl, dbPath: f.dbPath, databaseModule: require.resolve('better-sqlite3'), body: claimBody(ownerId) } }));
  t.after(async () => { await Promise.all(workers.map((worker) => worker.terminate())); });
  await Promise.all(workers.map((worker) => new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); })));
  const completed = workers.map((worker) => new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); }));
  workers.forEach((worker) => worker.postMessage('go'));
  const results = await Promise.all(completed);
  assert.equal(results.filter((item) => item.acquired).length, 1);
  assert.equal(results[0].task.attemptId, results[1].task.attemptId);
});

test('lost claim receipt is idempotent, mismatched intent and reused attempt token are rejected', async (t) => {
  const { state } = await fixture(t);
  const first = state.claim('alice', claimBody());
  assert.deepEqual(state.claim('alice', claimBody()), first);
  assert.throws(() => state.claim('alice', { ...claimBody(), inputHash: 'e'.repeat(64) }), conflict('SHARED_INPUT_CONFLICT'));
  assert.throws(() => state.claim('alice', claimBody('request-1', 'f'.repeat(64))), conflict('SHARED_REQUEST_CONFLICT'));
  assert.throws(() => state.status('bob', { taskKey, inputHash: 'e'.repeat(64) }), conflict('SHARED_INPUT_CONFLICT'));
});

test('submitted gate permits one send only, and restart or elapsed time never reacquires it', async (t) => {
  const f = await fixture(t), task = f.state.claim('alice', claimBody()).task;
  assert.equal(f.state.submitted('alice', attemptBody(task)).sendAllowed, true);
  assert.equal(f.state.submitted('alice', attemptBody(task)).sendAllowed, false);
  f.db.close(); f.advance(); const reopened = f.open().state;
  assert.equal(reopened.claim('alice', claimBody()).acquired, false);
  assert.equal(reopened.claim('bob', claimBody('bob')).acquired, false);
  assert.equal(reopened.status('bob', { taskKey }).task.status, 'submitted');
  assert.equal(reopened.submitted('alice', attemptBody(task)).sendAllowed, false);
});

test('completed first result survives reopen, replays same receipt, and cannot be replaced', async (t) => {
  const f = await fixture(t), task = f.state.claim('alice', claimBody()).task;
  f.state.submitted('alice', attemptBody(task));
  const body = { ...attemptBody(task), result };
  const saved = f.state.complete('alice', body);
  assert.deepEqual(f.state.complete('alice', body), saved);
  assert.throws(() => f.state.complete('alice', { ...body, result: { ...result, sha256: 'd'.repeat(64) } }), conflict('SHARED_RESULT_CONFLICT'));
  assert.throws(() => f.state.fail('alice', { ...attemptBody(task), reason: 'unknown' }), conflict('SHARED_STATE_CONFLICT'));
  assert.throws(() => f.state.retry('alice', { ...claimBody('retry'), expectedAttemptId: task.attemptId, acknowledged: true }), conflict('SHARED_STATE_CONFLICT'));
  f.db.close(); const reopened = f.open().state;
  assert.deepEqual(reopened.status('bob', { taskKey }).task.result, result);
  assert.equal(reopened.claim('bob', claimBody('bob')).acquired, false);
});

test('another account cannot submit, fail, complete, or take over an active attempt', async (t) => {
  const { state } = await fixture(t), task = state.claim('alice', claimBody()).task;
  for (const [method, body] of [['submitted', attemptBody(task)], ['complete', { ...attemptBody(task), result }], ['fail', { ...attemptBody(task), reason: 'unknown' }], ['retry', { ...claimBody('bob-retry'), expectedAttemptId: task.attemptId, acknowledged: true }]]) {
    assert.throws(() => state[method]('bob', body), (error) => error.status === 403);
  }
  assert.throws(() => state.complete('alice', { ...attemptBody(task), result }), conflict('SHARED_STATE_CONFLICT'));
});

test('uncertain delivery stays blocked until explicit retry; old attempts can never publish', async (t) => {
  const f = await fixture(t), task = f.state.claim('alice', claimBody()).task;
  f.state.submitted('alice', attemptBody(task));
  f.state.fail('alice', { ...attemptBody(task), reason: 'unknown' });
  f.db.close(); const state = f.open().state;
  assert.equal(state.claim('bob', claimBody('bob')).acquired, false);
  assert.equal(state.status('bob', { taskKey }).task.status, 'uncertain');
  assert.throws(() => state.retry('bob', { ...claimBody('retry'), expectedAttemptId: task.attemptId, acknowledged: false }), (error) => error.status === 400);
  const retryBody = { ...claimBody('retry'), expectedAttemptId: task.attemptId, acknowledged: true };
  const retry = state.retry('bob', retryBody);
  assert.equal(retry.acquired, true); assert.notEqual(retry.task.attemptId, task.attemptId);
  assert.deepEqual(state.retry('bob', retryBody), retry, 'lost retry receipt reuses its attempt');
  assert.throws(() => state.complete('alice', { ...attemptBody(task), result }), conflict('SHARED_STALE_ATTEMPT'));
  assert.throws(() => state.submitted('alice', attemptBody(task)), conflict('SHARED_STALE_ATTEMPT'));
  assert.equal(state.submitted('bob', attemptBody(retry.task)).sendAllowed, true);
  assert.equal(state.retry('bob', retryBody).acquired, false, 'replayed retry never resends after submission');
  assert.equal(state.complete('bob', { ...attemptBody(retry.task), result }).task.status, 'complete');
});

test('claimed interruptions require explicit owner recovery without lease expiry takeover', async (t) => {
  const f = await fixture(t), task = f.state.claim('alice', claimBody()).task;
  f.advance(); f.db.close(); const state = f.open().state;
  assert.equal(state.claim('bob', claimBody('bob')).acquired, false);
  const retried = state.retry('alice', { ...claimBody('recover'), expectedAttemptId: task.attemptId, acknowledged: true });
  assert.equal(retried.acquired, true);
  assert.throws(() => state.submitted('alice', attemptBody(task)), conflict('SHARED_STALE_ATTEMPT'));
});

test('known not-sent failure and provider failure are explicit and cannot downgrade uncertain billing', async (t) => {
  const { state } = await fixture(t), task = state.claim('alice', claimBody()).task;
  const failedBody = { ...attemptBody(task), reason: 'not-sent' };
  const failed = state.fail('alice', failedBody);
  assert.equal(failed.task.status, 'failed'); assert.deepEqual(state.fail('alice', failedBody), failed);
  const next = state.retry('bob', { ...claimBody('retry'), expectedAttemptId: task.attemptId, acknowledged: true }).task;
  state.submitted('bob', attemptBody(next));
  assert.throws(() => state.fail('bob', { ...attemptBody(next), reason: 'not-sent' }), conflict('SHARED_STATE_CONFLICT'));
  assert.equal(state.fail('bob', { ...attemptBody(next), reason: 'provider-failed' }).task.status, 'failed');
});

test('strict metadata validation rejects bodies, keys, unsafe paths and secret-bearing extras', async (t) => {
  const { state } = await fixture(t);
  for (const body of [null, [], {}, { ...claimBody(), ownerId: 'bob' }, { ...claimBody(), taskKey: '../live' }, { ...claimBody(), inputHash: 'B'.repeat(64) }, { ...claimBody(), clientAttemptId: '' }, { ...claimBody(), transcript: 'private' }]) {
    assert.throws(() => state.claim('alice', body), (error) => error.status === 400);
  }
  const task = state.claim('alice', claimBody()).task; state.submitted('alice', attemptBody(task));
  for (const badResult of [{ ...result, path: '../result.json' }, { ...result, path: '/result.json' }, { ...result, path: 'X:/result.json' }, { ...result, path: 'live\\result.json' }, { ...result, path: 'live//result.json' }, { ...result, path: 'live/%2e%2e/result.json' }, { ...result, sha256: 'hash' }, { ...result, schema: '' }, { ...result, apiKey: 'not-a-secret' }]) {
    assert.throws(() => state.complete('alice', { ...attemptBody(task), result: badResult }), (error) => error.status === 400);
  }
  assert.equal(state.status('alice', { taskKey }).task.status, 'submitted');
});

test('paid audio awaiting seam review persists as needs-review, refuses retries, and permits same-attempt publication', async (t) => {
  const f = await fixture(t), task = f.state.claim('alice', claimBody()).task;
  const review = { ...attemptBody(task), reason: 'needs-review' };
  assert.throws(() => f.state.fail('alice', review), conflict('SHARED_STATE_CONFLICT'));
  f.state.submitted('alice', attemptBody(task));
  f.state.fail('alice', { ...attemptBody(task), reason: 'unknown' });
  assert.equal(f.state.fail('alice', review).task.status, 'needs-review');
  assert.equal(f.state.fail('alice', review).task.failureReason, 'needs-review');
  f.db.close(); const reopened = f.open().state;
  assert.equal(reopened.status('bob', { taskKey }).task.status, 'needs-review');
  assert.equal(reopened.claim('bob', claimBody('bob')).acquired, false);
  assert.equal(reopened.submitted('alice', attemptBody(task)).sendAllowed, false);
  for (const actor of ['alice', 'bob']) assert.throws(() => reopened.retry(actor, { ...claimBody(`retry-${actor}`), expectedAttemptId: task.attemptId, acknowledged: true }), conflict('SHARED_STATE_CONFLICT'));
  assert.throws(() => reopened.fail('alice', { ...attemptBody(task), reason: 'unknown' }), conflict('SHARED_STATE_CONFLICT'));
  assert.equal(reopened.complete('alice', { ...attemptBody(task), result }).task.status, 'complete');
});

test('HTTP routes use authenticated owner, share status, and persist across isolated service restart', async (t) => {
  await mkdir(root, { recursive: true });
  const dataDir = await mkdtemp(path.join(root, 'http-'));
  let service, origin;
  const start = async () => { service = await createCompanyService({ dataDir, host: '127.0.0.1', port: 0, baseURL: 'http://127.0.0.1:4715' }); await service.listen(); origin = `http://127.0.0.1:${service.server.address().port}`; };
  t.after(async () => { await service?.close(); if (!path.resolve(dataDir).startsWith(root + path.sep)) throw new Error('Unsafe HTTP fixture cleanup'); await rm(dataDir, { recursive: true, force: true }); });
  await start();
  const request = async (route, body, token) => { const response = await fetch(origin + '/api/company' + route, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }); return { status: response.status, data: await response.json() }; };
  const admin = { username: 'shared.admin', name: 'Shared test admin', password: 'Synthetic-Shared-Admin-42!' };
  await request('/setup', admin); const logged = (await request('/login', admin)).data;
  const bob = { username: 'shared.bob', name: 'Shared test bob', password: 'Synthetic-Shared-Employee-42!' };
  await request('/users', bob, logged.token); const other = (await request('/login', bob)).data;
  const api = (name, body, token = logged.token) => request('/shared-analysis/' + name, body, token);
  assert.equal((await request('/shared-analysis/status', { taskKey })).status, 401);
  assert.equal((await api('claim', { ...claimBody(), ownerId: other.user.id })).status, 400);
  const claimed = await api('claim', claimBody()); assert.equal(claimed.status, 200); assert.equal(claimed.data.task.ownerId, logged.user.id);
  const task = claimed.data.task;
  assert.equal((await api('claim', claimBody('bob'), other.token)).data.acquired, false);
  assert.equal((await api('submitted', attemptBody(task), other.token)).status, 403);
  assert.equal((await api('submitted', attemptBody(task))).data.sendAllowed, true);
  assert.equal((await api('fail', { ...attemptBody(task), reason: 'needs-review' })).data.task.status, 'needs-review');
  assert.equal((await api('retry', { ...claimBody('review-retry'), expectedAttemptId: task.attemptId, acknowledged: true })).status, 409);
  assert.equal((await api('complete', { ...attemptBody(task), result })).status, 200);
  await service.close(); await start();
  assert.deepEqual((await api('status', { taskKey, inputHash }, other.token)).data.task.result, result);
  assert.equal((await api('claim', claimBody('bob'), other.token)).data.acquired, false);
});
