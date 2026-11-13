import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { filmHtml } from '../../src/film-doc.mjs';
import { createStructureWorkspace } from './structure-workspace.mjs';
import { createStructureBatchExports } from './structure-batch-exports.mjs';
import { isSavedStructurePlanUsable } from './structure-plan-availability.mjs';

const V4 = 'ai-structure-plans-v4';
const base = resolve(import.meta.dirname, '../../../../.tmp/structure-saved-plan-availability');
async function fixture(t) {
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, 'case-')), root = join(dir, 'project');
  await mkdir(join(root, '.film'), { recursive: true }); await mkdir(join(root, 'assets'));
  await writeFile(join(root, '.film/id'), 'saved-plan-parent');
  await writeFile(join(root, 'assets/live.mp4'), 'isolated synthetic media');
  const original = filmHtml({ stage: { w: 720, h: 1280 }, tracks: [{ clips: [{ id: 'parent', src: 'assets/live.mp4', time: [0, 1] }] }] });
  await writeFile(join(root, 'film.html'), original);
  const scope = { sourceId: 's', productId: 'p', intervalId: 'i', startMs: 0, endMs: 60000 };
  await writeFile(join(root, '.film/product-analysis.json'), JSON.stringify({ version: 1, sources: [{ id: 's', assetPath: 'assets/live.mp4', durationMs: 60000 }], products: [{ id: 'p', name: '隔离商品', sourceIds: ['s'] }], intervals: [{ id: 'i', ...scope }], candidates: [] }));
  const plan = id => ({ id, version: V4, scope, speed: 1.3, durationMs: 40000, coreIds: ['c'], clips: [{ sourceId: 's', assetPath: 'assets/live.mp4', startMs: 0, endMs: 52000, text: '已保存完整话术', roles: ['core'], coreIds: ['c'] }] });
  const state = { version: V4, status: 'failed', taskKey: 'saved-task', context: { ...scope, visibility: 'shared' }, plans: [plan('saved-plan'), plan('unpublished-plan')], usablePlanIds: ['saved-plan'] };
  const project = { id: 'saved-plan-parent', name: '隔离商品', path: root }, plans = { status: async () => structuredClone(state) };
  const workspace = createStructureWorkspace({ plans, register: async path => ({ id: (await readFile(join(path, '.film/id'), 'utf8')).trim(), path }) });
  const captured = [], jobs = [];
  const batches = createStructureBatchExports({ plans, outputRoot: () => join(dir, 'output'), pollMs: 1,
    capture: async (_project, { plan, itemRoot }) => { captured.push(plan.id); await mkdir(itemRoot, { recursive: true }); await writeFile(join(itemRoot, 'film.html'), original); return { root: itemRoot, revision: 'saved-revision', origin: 'public', sourceProjectId: project.id, planId: plan.id, fps: 30, media: [] }; },
    materialize: async () => {}, exports: { startSnapshot: snapshot => { const job = { id: randomUUID(), project: snapshot.id, status: 'done', progress: 1, outputs: [] }; jobs.push(job); return job; }, list: projectId => jobs.filter(job => job.project === projectId), cancel() {} } });
  t.mock.method(globalThis, 'fetch', () => { throw Error('No external network or model calls'); });
  t.after(async () => { await batches.stop(); assert.equal(await readFile(join(root, 'film.html'), 'utf8'), original); assert.ok(resolve(dir).startsWith(base + sep)); await rm(dir, { recursive: true, force: true }); });
  const edit = id => workspace.edit(project, { ...scope, taskKey: state.taskKey, planId: id });
  const exportPlans = ids => batches.create(project, { ...scope, taskKey: state.taskKey, planIds: ids, requestId: randomUUID() });
  return { state, project, batches, captured, edit, exportPlans };
}

test('v4 completed earlier rounds remain editable and exportable when a later batch fails or awaits publication', async t => {
  const f = await fixture(t);
  for (const status of ['failed', 'publish-pending']) {
    f.state.status = status;
    assert.equal(isSavedStructurePlanUsable(f.state, 'saved-plan'), true);
    assert.equal((await f.edit('saved-plan')).meta.planId, 'saved-plan');
    const batch = await f.exportPlans(['saved-plan']); await f.batches.wait(f.project, batch.id);
    assert.equal(batch.total, 1);
  }
  assert.deepEqual(f.captured, ['saved-plan', 'saved-plan']);
});

test('v4 unpublished, unavailable and unknown plans cannot draft or export alongside an earlier saved plan', async t => {
  const f = await fixture(t);
  for (const [status, id] of [['publish-pending', 'unpublished-plan'], ['failed', 'unknown-plan'], ['unavailable', 'saved-plan']]) {
    f.state.status = status;
    assert.equal(isSavedStructurePlanUsable(f.state, id), false);
    await assert.rejects(f.edit(id), /已保存的方案/);
    await assert.rejects(f.exportPlans(id === 'saved-plan' ? [id] : ['saved-plan', id]), /当前已保存版本/);
  }
  assert.deepEqual(f.captured, []);
});

test('legacy failed and unpublished plans remain blocked even if a usable ID list is present', async t => {
  const f = await fixture(t); f.state.version = 'ai-structure-plans-v3';
  for (const status of ['failed', 'publish-pending']) {
    f.state.status = status;
    assert.equal(isSavedStructurePlanUsable(f.state, 'saved-plan'), false);
    await assert.rejects(f.edit('saved-plan'), /已保存的方案/); await assert.rejects(f.exportPlans(['saved-plan']), /当前已保存版本/);
  }
  assert.deepEqual(f.captured, []);
});
