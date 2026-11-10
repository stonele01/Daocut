import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createSharedAnalysis } from './shared-analysis.mjs';

const base = resolve('../../.tmp/shared-v2-20261105/backend');
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

for (const failure of ['ENOSPC', 'partial-write', 'rename']) test(`${failure} preserves outbox and explicitly repairs only unpublished artifact`, async t => {
  const f = await fixture(t); let failed = false, calls = 0;
  const first = f.make({ publishFile: async (path, data) => {
    calls++;
    if (!failed) { failed = true; if (failure === 'partial-write') await writeFile(path, data.slice(0, 18)); throw Object.assign(Error(failure), { code: failure === 'ENOSPC' ? 'ENOSPC' : 'EIO' }); }
    await writeFile(path, data);
  } });
  const p = await first.prepare(f.roots[0], f.source, f.input), claim = await first.acquire(p);
  await assert.rejects(first.complete(f.roots[0], p, claim.attemptId, { immutable: 'first' }));
  assert.equal(f.coordinator.tasks.get(p.taskKey).status, 'submitted');
  const reopened = f.make(); assert.equal((await reopened.prepare(f.roots[0], f.source, f.input)).mode, 'publish-pending');
  await reopened.publish(f.roots[0], f.source.id, p.taskKey);
  assert.equal(f.coordinator.tasks.get(p.taskKey).status, 'complete'); assert.equal(f.coordinator.tasks.size, 1); assert.equal(calls, 1);
});

test('lost registration response after central completion recovers from outbox without overwriting immutable bytes', async t => {
  const f = await fixture(t); let lost = true, writes = 0;
  const options = { coordinate: async (op, body) => { const result = await f.options.coordinate(op, body); if (op === 'complete' && lost) { lost = false; throw Error('reply lost after commit'); } return result; }, publishFile: async (path, bytes) => { writes++; await writeFile(path, bytes); } };
  const first = f.make(options), p = await first.prepare(f.roots[0], f.source, f.input), claim = await first.acquire(p);
  await assert.rejects(first.complete(f.roots[0], p, claim.attemptId, { immutable: 'first' }));
  assert.equal(f.coordinator.tasks.get(p.taskKey).status, 'complete');
  await f.make(options).publish(f.roots[0], f.source.id, p.taskKey); assert.equal(writes, 1);
  const ref = f.coordinator.tasks.get(p.taskKey).result; assert.deepEqual(JSON.parse(await readFile(join(f.results, ref.path), 'utf8')).payload, { immutable: 'first' });
});
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
