import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createSharedAnalysis } from '../src/shared-analysis.mjs';
test('existing-result catalog lists only complete versions for the exact source and never private content', () => {
  const db = new Database(':memory:'); db.exec("CREATE TABLE user(id TEXT PRIMARY KEY); INSERT INTO user VALUES('alice'),('bob')");
  try {
    const service = createSharedAnalysis(db), taskKey = 'a'.repeat(64), sourceIdentity = 'b'.repeat(64), inputHash = 'c'.repeat(64);
    const catalog = { sourceIdentity, action: 'analysis', scope: { startMs: 120, endMs: 466400 }, count: 40, provenance: { kind: 'historical-ai-output', model: 'mock' } };
    const claim = service.claim('alice', { taskKey, inputHash, clientAttemptId: 'first', catalog });
    assert.deepEqual(service.catalog('bob', { sourceIdentity }).results, []);
    assert.equal(service.claim('bob', { taskKey, inputHash, clientAttemptId: 'race', catalog }).acquired, false);
    service.submitted('alice', { taskKey, attemptId: claim.task.attemptId });
    service.complete('alice', { taskKey, attemptId: claim.task.attemptId, result: { path: 'results/test.json', sha256: 'd'.repeat(64), schema: 'daocut.shared-analysis.v1' } });
    assert.equal(service.catalog('bob', { sourceIdentity }).results.length, 1);
    assert.deepEqual(service.catalog('bob', { sourceIdentity: 'e'.repeat(64) }).results, []);
    assert.throws(() => service.claim('bob', { taskKey: 'f'.repeat(64), inputHash, clientAttemptId: 'bad', catalog: { ...catalog, film: '<html>' } }));
    assert.equal(createSharedAnalysis(db).catalog('bob', { sourceIdentity }).results[0].catalog.count, 40);
  } finally { db.close(); }
});
