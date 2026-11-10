import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { createSharedAnalysis } from '../src/shared-analysis.mjs';
import { createCompanyClient } from '../../desktop/src/company-client.mjs';

const testRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)), '.tmp/structure-plans-tests');
const user = { id: 'alice', username: 'alice', name: 'Synthetic Alice', role: 'user', enabled: true };
const catalog = { sourceIdentity: 'a'.repeat(64), action: 'structure-plans', scope: { startMs: 1000, endMs: 120000 }, count: 0, provenance: { kind: 'structure-plans-v1', inputRevision: 'public-analysis-v1' } };
const claim = { taskKey: 'b'.repeat(64), inputHash: 'c'.repeat(64), clientAttemptId: 'structure-first', catalog };

test('structure plans use the existing immutable shared task ledger without publishing private metadata', () => {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE user(id TEXT PRIMARY KEY); INSERT INTO user VALUES('alice'),('bob')");
  try {
    const ledger = createSharedAnalysis(db);
    const first = ledger.claim('alice', claim);
    assert.equal(first.acquired, true);
    assert.equal(ledger.claim('bob', { ...claim, clientAttemptId: 'follower' }).acquired, false);
    ledger.submitted('alice', { taskKey: claim.taskKey, attemptId: first.task.attemptId });
    const result = { path: 'results/structure/plans.json', sha256: 'd'.repeat(64), schema: 'daocut.shared-analysis.v1' };
    ledger.complete('alice', { taskKey: claim.taskKey, attemptId: first.task.attemptId, result });
    assert.equal(ledger.catalog('bob', { sourceIdentity: catalog.sourceIdentity }).results[0].catalog.action, 'structure-plans');
    assert.throws(() => ledger.complete('alice', { taskKey: claim.taskKey, attemptId: first.task.attemptId, result: { ...result, sha256: 'e'.repeat(64) } }), /不可覆盖/);
    assert.throws(() => ledger.claim('bob', { ...claim, taskKey: 'f'.repeat(64), clientAttemptId: 'private', catalog: { ...catalog, provenance: { ...catalog.provenance, privateSemantics: 'private edit' } } }), /私人|凭证/);
  } finally { db.close(); }
});

test('desktop transport admits structure-plan metadata and rejects private fields before transport', async t => {
  await mkdir(testRoot, { recursive: true });
  const dir = await mkdtemp(join(testRoot, 'desktop-catalog-'));
  t.after(async () => { assert.ok(resolve(dir).startsWith(testRoot + sep)); await rm(dir, { recursive: true, force: true }); });
  const calls = [];
  const client = createCompanyClient({ dataDir: dir, appVersion: 'test', request: async (_profile, endpoint, options) => {
    calls.push({ endpoint, options });
    if (endpoint === '/login') return { user, token: 'synthetic-local-token', expiresAt: '2099-01-01' };
    if (endpoint === '/session') return { user };
    return { acquired: true, task: { taskKey: options.body.taskKey } };
  } });
  client.configure({ name: 'Synthetic', serverUrl: 'https://company.invalid', caPem: '' });
  await client.login({ username: 'alice', password: 'synthetic' });
  assert.equal((await client.sharedAnalysis('claim', claim)).acquired, true);
  const count = calls.length;
  await assert.rejects(client.sharedAnalysis('claim', { ...claim, catalog: { ...catalog, provenance: { kind: 'structure-plans-v1', privateSemantics: 'private edit' } } }), /参数无效/);
  assert.equal(calls.length, count);
});
