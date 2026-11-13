import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createSharedAnalysis } from './shared-analysis.mjs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mediaContentHash } from '../../src/shared-media-reference.mjs';

const base = resolve('../../.tmp/shared-live-20261104/backend');
export function mockCoordinator() {
  const tasks = new Map(); let serial = 0;
  return { tasks, coordinate: async (op, body) => {
    let task = tasks.get(body.taskKey);
    if (op === 'status') return { task: structuredClone(task ?? null) };
    if (op === 'claim' || op === 'retry') {
      if (task && op === 'claim') return { task: structuredClone(task), acquired: false };
      if (op === 'retry' && (!body.acknowledged || task?.attemptId !== body.expectedAttemptId)) throw Error('retry must be explicit');
      task = { taskKey: body.taskKey, inputHash: body.inputHash, attemptId: `attempt-${++serial}`, status: 'claimed' }; tasks.set(body.taskKey, task);
      return { task: structuredClone(task), acquired: true };
    }
    assert.equal(body.attemptId, task.attemptId);
    if (op === 'submitted') { const sendAllowed = task.status === 'claimed'; if (sendAllowed) task.status = 'submitted'; return { task: structuredClone(task), sendAllowed }; }
    if (op === 'complete') { task.status = 'complete'; task.result = body.result; }
    if (op === 'fail') { task.status = body.reason === 'unknown' ? 'uncertain' : 'failed'; }
    return { task: structuredClone(task) };
  } };
}
async function fixture(t) {
  await mkdir(base, { recursive: true }); const dir = await mkdtemp(join(base, 'shared-')); t.after(() => rm(dir, { recursive: true, force: true }));
  t.mock.method(globalThis, 'fetch', () => { throw Error('No real requests'); });
  const roots = [join(dir, 'person-a'), join(dir, 'person-b')], results = join(dir, 'shared-results');
  for (const root of roots) { await mkdir(join(root, 'assets'), { recursive: true }); await writeFile(join(root, 'assets/live.mp4'), 'synthetic same live'); }
  const coordinator = mockCoordinator();
  const options = { coordinate: coordinator.coordinate, settings: () => ({ enabled: true, resultRoots: [{ libraryId: 'library-test', root: results }] }), readManifest: async () => ({ items: { 'assets/live.mp4': { libraryId: 'library-test', relativePath: 'show/live.mp4' } } }), resolveSource: async (root, asset) => join(root, asset) };
  const source = { id: 'personal-id', assetPath: 'assets/live.mp4', durationMs: 20000 };
  const input = { action: 'discovery', data: { transcript: [{ startMs: 0, endMs: 1000, text: '商品A' }] }, contract: { model: 'mock-v1' } };
  return { roots, results, options, source, input, coordinator, make: extra => createSharedAnalysis({ ...options, ...extra }) };
}
test('same library content on two computers shares identity; other content never does', async t => {
  const f = await fixture(t), a = f.make(), b = f.make();
  const p = await a.prepare(f.roots[0], f.source, f.input), q = await b.prepare(f.roots[1], { ...f.source, id: 'other-local-id' }, f.input);
  assert.equal(p.taskKey, q.taskKey); assert.equal(p.sourceIdentity, q.sourceIdentity);
  await writeFile(join(f.roots[1], 'assets/live.mp4'), 'different live same filename');
  assert.notEqual((await b.prepare(f.roots[1], f.source, f.input)).taskKey, p.taskKey);
});

test('shared results reuse the full identity already verified while opening the video', async t => {
  const f = await fixture(t), path = join(f.roots[0], f.source.assetPath);
  const expected = await mediaContentHash(path);
  const stream = t.mock.method(fs, 'createReadStream', () => { throw Error('duplicate full-media read'); });
  syncBuiltinESMExports();
  try {
    const plan = await f.make().prepare(f.roots[0], f.source, f.input);
    assert.equal(plan.source.sha256, expected);
    assert.equal(stream.mock.callCount(), 0);
    await writeFile(path, 'changed original');
    await assert.rejects(f.make().prepare(f.roots[0], f.source, f.input), /duplicate full-media read/);
  } finally { stream.mock.restore(); syncBuiltinESMExports(); }
});
test('one claimant publishes immutable first result; another reuses with no acquisition', async t => {
  const f = await fixture(t), a = f.make(), b = f.make(), p = await a.prepare(f.roots[0], f.source, f.input), q = await b.prepare(f.roots[1], f.source, f.input);
  const claims = await Promise.allSettled([a.acquire(p), b.acquire(q)]); assert.equal(claims.filter(x => x.status === 'fulfilled').length, 1);
  const winner = claims.find(x => x.status === 'fulfilled').value;
  const payload = { products: ['A', 'B'], intervals: [['A', 0, 5], ['B', 5, 10], ['A', 10, 20]] };
  await a.complete(f.roots[0], p, winner.attemptId, payload, { model: 'mock-v1' });
  const reused = await b.prepare(f.roots[1], f.source, { ...f.input, contract: { model: 'mock-v2' } });
  assert.equal(reused.mode, 'reuse'); assert.deepEqual((await b.read(f.roots[1], reused)).payload, payload);
  assert.equal(f.coordinator.tasks.size, 1); assert.equal(f.coordinator.tasks.get(p.taskKey).result.sha256.length, 64);
});
test('failed NAS publication leaves local outbox; explicit publication never reruns analysis', async t => {
  const f = await fixture(t); let failing = true, publications = 0;
  const a = f.make({ publishFile: async (path, data) => { publications++; if (failing) throw Error('simulated NAS offline'); await writeFile(path, data); } });
  const p = await a.prepare(f.roots[0], f.source, f.input), claim = await a.acquire(p);
  await assert.rejects(a.complete(f.roots[0], p, claim.attemptId, { products: ['A'] }), /保存|publish/i);
  assert.equal((await a.prepare(f.roots[0], f.source, f.input)).mode, 'publish-pending');
  assert.equal(f.coordinator.tasks.get(p.taskKey).status, 'submitted'); failing = false;
  await a.publish(f.roots[0], f.source.id, p.taskKey);
  assert.equal(publications, 2); assert.equal(f.coordinator.tasks.get(p.taskKey).status, 'complete');
});
test('saved snapshot reopens while shared folder is unavailable; corruption is rejected on first import', async t => {
  const f = await fixture(t), a = f.make(), p = await a.prepare(f.roots[0], f.source, f.input), claim = await a.acquire(p);
  await a.complete(f.roots[0], p, claim.attemptId, { products: ['A'] });
  const b = f.make(), q = await b.prepare(f.roots[1], f.source, f.input); await b.read(f.roots[1], q);
  const ref = f.coordinator.tasks.get(p.taskKey).result; await writeFile(join(f.results, ref.path), 'corrupt');
  assert.deepEqual((await f.make().read(f.roots[1], q)).payload, { products: ['A'] });
  await rm(join(f.roots[0], '.film', 'shared-analysis'), { recursive: true, force: true });
  await assert.rejects(a.read(f.roots[0], p), /校验|integrity/i);
});
test('uncertain submission survives reopen and only explicit retry can acquire again', async t => {
  const f = await fixture(t), a = f.make(), p = await a.prepare(f.roots[0], f.source, f.input), claim = await a.acquire(p);
  await a.fail(p, claim.attemptId);
  const reopened = f.make(), q = await reopened.prepare(f.roots[0], f.source, f.input);
  assert.equal(q.mode, 'retry-required'); await assert.rejects(reopened.acquire(q));
  assert.notEqual((await reopened.acquire(q, { retryAcknowledged: true })).attemptId, claim.attemptId);
});
test('different input or local human edits do not overwrite first shared baseline', async t => {
  const f = await fixture(t), a = f.make(), p = await a.prepare(f.roots[0], f.source, f.input), claim = await a.acquire(p);
  await a.complete(f.roots[0], p, claim.attemptId, { products: ['A'] });
  const q = await a.prepare(f.roots[0], f.source, { ...f.input, data: { transcript: ['human correction'] } });
  assert.equal(q.mode, 'local-only');
  assert.equal((await a.prepare(f.roots[0], f.source, { ...f.input, localOnly: '人工修正只留本机' })).mode, 'local-only');
  await assert.rejects(a.acquire(q)); assert.equal(f.coordinator.tasks.size, 1);
});
test('first plan binds company identity before claiming; switching company sends no claim', async t => {
  const f = await fixture(t); let company = 'company-a', claims = 0;
  const a = f.make({ coordinate: async (op, body) => {
    if (body.expectedCoordinatorId && body.expectedCoordinatorId !== company) throw Error('company changed');
    if (op === 'claim') claims++;
    return { ...await f.options.coordinate(op, body), coordinationId: company };
  } });
  const p = await a.prepare(f.roots[0], f.source, f.input); company = 'company-b';
  await assert.rejects(a.acquire(p), /company changed/); assert.equal(claims, 0);
});
test('interrupted submitted attempt can explicitly recover on reopen without automatic resubmission', async t => {
  const f = await fixture(t), a = f.make(), p = await a.prepare(f.roots[0], f.source, f.input), claim = await a.acquire(p);
  assert.equal((await a.prepare(f.roots[0], f.source, f.input)).mode, 'busy');
  const reopened = f.make(), q = await reopened.prepare(f.roots[0], f.source, f.input);
  assert.equal(q.mode, 'retry-required'); await assert.rejects(reopened.acquire(q));
  assert.notEqual((await reopened.acquire(q, { retryAcknowledged: true })).attemptId, claim.attemptId);
});
test('company or result mapping change cannot publish outbox into another destination', async t => {
  const f = await fixture(t); let company = 'company-a', writes = 0;
  const coordinate = async (op, body) => {
    if (body.expectedCoordinatorId && body.expectedCoordinatorId !== company) throw Error('company changed');
    return { ...await f.options.coordinate(op, body), coordinationId: company };
  };
  const a = f.make({ coordinate, publishFile: async () => { writes++; throw Error('offline'); } });
  const p = await a.prepare(f.roots[0], f.source, f.input), claim = await a.acquire(p);
  await assert.rejects(a.complete(f.roots[0], p, claim.attemptId, { products: ['A'] }));
  company = 'company-b'; await assert.rejects(a.publish(f.roots[0], f.source.id, p.taskKey)); assert.equal(writes, 1);
  company = 'company-a'; const moved = f.make({ coordinate, settings: () => ({ enabled: true, resultRoots: [{ libraryId: 'library-test', root: join(f.results, 'changed') }] }), publishFile: async () => { writes++; } });
  await assert.rejects(moved.publish(f.roots[0], f.source.id, p.taskKey)); assert.equal(writes, 1);
});
test('coordinator failure when reporting a failed model does not leave a live local lock', async t => {
  const f = await fixture(t); let unavailable = false;
  const a = f.make({ coordinate: async (op, body) => { if (unavailable && op === 'fail') throw Error('company offline'); return f.options.coordinate(op, body); } });
  const p = await a.prepare(f.roots[0], f.source, f.input), claim = await a.acquire(p); unavailable = true;
  await assert.rejects(a.fail(p, claim.attemptId)); unavailable = false;
  assert.equal((await a.prepare(f.roots[0], f.source, f.input)).mode, 'retry-required');
});
test('enabled sharing with a missing result mapping cannot silently fall back to paid local analysis', async t => {
  const f = await fixture(t), a = f.make({ settings: () => ({ enabled: true, resultRoots: [] }) });
  await assert.rejects(a.prepare(f.roots[0], f.source, f.input), /共享结果目录/);
  const privateSource = f.make({ readManifest: async () => ({ items: {} }) });
  assert.equal((await privateSource.prepare(f.roots[0], f.source, f.input)).mode, 'local-only');
});
