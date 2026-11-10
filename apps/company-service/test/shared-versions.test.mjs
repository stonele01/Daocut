import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createSharedAnalysis } from '../src/shared-analysis.mjs';
import { createSharedAnalysis as createStudioStore } from '../../../packages/daocut/studio/server/shared-analysis.mjs';
const familyKey = 'a'.repeat(64), inputHash = 'b'.repeat(64), firstSha = 'c'.repeat(64);
const versionKey = (input, base) => createHash('sha256').update(JSON.stringify([familyKey, input, base])).digest('hex');
async function fixture(t) {
  const base = resolve('.tmp/shared-v2-20261105/coordinator'); await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, 'versions-')); const db = new Database(join(dir, 'test.sqlite'));
  db.exec('CREATE TABLE user (id TEXT PRIMARY KEY); INSERT INTO user VALUES (\'alice\'),(\'bob\')');
  t.after(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, db, state: createSharedAnalysis(db) };
}
function finish(state, key, who, token, hash, extras = {}) {
  const claimed = state.claim(who, { taskKey: key, inputHash: hash, clientAttemptId: token, ...extras });
  const attempt = { taskKey: key, attemptId: claimed.task.attemptId };
  state.submitted(who, attempt);
  state.complete(who, { ...attempt, result: { path: `results/${key}/${hash}.json`, sha256: hash, schema: 'daocut.shared-analysis.v1' } });
}
test('versions append completed immutable artifacts while unfinished versions are not available', async t => {
  const { state } = await fixture(t); finish(state, familyKey, 'alice', 'first', firstSha);
  const taskKey = versionKey(inputHash, firstSha), extra = { familyKey, baseResultSha256: firstSha };
  const claim = state.claim('alice', { taskKey, inputHash, clientAttemptId: 'second', ...extra });
  assert.equal(state.versions('bob', { taskKey: familyKey }).versions.length, 1);
  assert.equal(state.claim('bob', { taskKey, inputHash, clientAttemptId: 'competing', ...extra }).acquired, false);
  state.submitted('alice', { taskKey, attemptId: claim.task.attemptId });
  state.complete('alice', { taskKey, attemptId: claim.task.attemptId, result: { path: 'results/v2.json', sha256: inputHash, schema: 'daocut.shared-analysis.v1' } });
  const versions = state.versions('bob', { taskKey: familyKey });
  assert.deepEqual(versions.versions.map(item => item.sequence), [1, 2]);
  assert.equal(versions.latest.result.sha256, inputHash);
  assert.equal(state.status('alice', { taskKey: familyKey }).task.result.sha256, firstSha);
});
test('version claims require an existing completed base and cannot attach a task to another family', async t => {
  const { state } = await fixture(t);
  assert.throws(() => state.claim('alice', { taskKey: versionKey(inputHash, firstSha), inputHash, clientAttemptId: 'no-base', familyKey, baseResultSha256: firstSha }));
  finish(state, familyKey, 'alice', 'first', firstSha);
  assert.throws(() => state.claim('alice', { taskKey: 'd'.repeat(64), inputHash, clientAttemptId: 'wrong-key', familyKey, baseResultSha256: firstSha }));
  assert.throws(() => state.claim('alice', { taskKey: familyKey, inputHash: firstSha, clientAttemptId: 'rebind', familyKey: 'e'.repeat(64), baseResultSha256: firstSha }));
});
test('version catalog is reconstructed for existing first-version ledgers without replacing their result', async t => {
  const { db, state } = await fixture(t); finish(state, familyKey, 'alice', 'first', firstSha);
  db.exec('DELETE FROM company_shared_analysis_version');
  const reopened = createSharedAnalysis(db);
  assert.equal(reopened.versions('bob', { taskKey: familyKey }).latest.result.sha256, firstSha);
  assert.equal(reopened.versions('bob', { taskKey: familyKey }).latest.sequence, 1);
});

test('Studio new-version failure and explicit retry cross the strict SQLite coordinator after reopen', async t => {
  const { dir, db, state } = await fixture(t); t.mock.method(globalThis, 'fetch', () => { throw Error('network forbidden'); });
  const root = join(dir, 'personal'), resultRoot = join(dir, 'mock-nas'); await mkdir(join(root, 'assets'), { recursive: true }); await writeFile(join(root, 'assets/live.mp4'), 'synthetic');
  let coordinator = state;
  const options = { coordinate: async (op, { expectedCoordinatorId, ...body }) => ({ ...coordinator[op]('alice', body), coordinationId: 'isolated-company' }), settings: () => ({ enabled: true, resultRoots: [{ libraryId: 'test', root: resultRoot }] }), readManifest: async () => ({ items: { 'assets/live.mp4': { libraryId: 'test', relativePath: 'live.mp4' } } }), resolveSource: async () => join(root, 'assets/live.mp4') };
  const source = { id: 's', assetPath: 'assets/live.mp4', durationMs: 1000 }, input = { action: 'discovery', data: ['synthetic transcript'], contract: { model: 'mock' } };
  let store = createStudioStore(options), first = await store.prepare(root, source, input), claim = await store.acquire(first);
  await store.complete(root, first, claim.attemptId, { result: 'first' });
  const next = await store.prepare(root, source, { ...input, newVersion: true }), attempt = await store.acquire(next); await store.fail(next, attempt.attemptId);
  coordinator = createSharedAnalysis(db); store = createStudioStore(options);
  const reopened = await store.prepare(root, source, { ...input, newVersion: true }); assert.equal(reopened.mode, 'retry-required'); await assert.rejects(store.acquire(reopened));
  const retry = await store.acquire(reopened, { retryAcknowledged: true }); await store.complete(root, reopened, retry.attemptId, { result: 'second' });
  assert.equal(state.versions('bob', { taskKey: first.taskKey }).versions.length, 2);
  assert.equal((await store.prepare(root, source, input)).result.sha256, state.status('bob', { taskKey: first.taskKey }).task.result.sha256);
});
