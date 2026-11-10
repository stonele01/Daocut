import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = fileURLToPath(new URL('../../../../.tmp/structure-batch-tests/', import.meta.url));
const scope = { sourceId: 'source', productId: 'product', intervalId: 'lecture', startMs: 0, endMs: 120000 };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const tick = () => new Promise(done => setTimeout(done, 1));

async function fixture(t, { count = 8, hold = false, captureFailure } = {}) {
  const { createStructureBatchExports } = await import('./structure-batch-exports.mjs');
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, 'case-')), root = join(dir, 'project'), output = join(dir, 'output');
  await mkdir(join(root, '.film'), { recursive: true });
  await writeFile(join(root, '.film/id'), 'parent-id');
  await writeFile(join(root, 'film.html'), 'existing parent film');
  t.mock.method(globalThis, 'fetch', () => { throw Error('No external network'); });
  const project = { id: 'parent-id', name: '模拟商品', path: root };
  const planList = Array.from({ length: count }, (_, i) => ({ id: `plan-${i + 1}`, version: 1, scope, durationMs: 40000, clips: [] }));
  const state = { status: 'complete', taskKey: hash(scope), context: { ...scope, visibility: 'shared' }, plans: planList };
  const current = new Map(planList.map((p, i) => [p.id, { text: `private edit ${i + 1}`, fps: 30 }]));
  const captured = [], materialized = [], sent = [], jobs = [], revealed = [], failures = new Set();
  let paused = hold, inFlight = 0, maximum = 0, serial = 0;
  const complete = job => {
    if (job.status !== 'running') return;
    inFlight--;
    if (failures.has(job.planId)) { job.status = 'failed'; job.error = 'synthetic disk unavailable'; }
    else { job.status = 'done'; job.progress = 1; job.outputs = [join(output, `made-${job.id}`)]; }
  };
  const exports = {
    startSnapshot(projectArg, ask) {
      const snapshot = captured.find(c => c.root === projectArg.path);
      assert.ok(snapshot, 'only a captured project may be exported');
      assert.equal(ask.kind, 'nle'); assert.equal(ask.format, 'jianying'); assert.equal(ask.media, 'link');
      const job = { id: `job-${++serial}`, project: projectArg.id, planId: snapshot.planId, status: 'running', progress: 0.25, outputs: [] };
      jobs.push(job); sent.push({ project: projectArg, ask, snapshot: structuredClone(snapshot) });
      inFlight++; maximum = Math.max(maximum, inFlight);
      if (!paused) queueMicrotask(() => complete(job));
      return { ...job };
    },
    list: projectId => jobs.filter(j => j.project === projectId).map(j => ({ ...j })),
    cancel(id) { const job = jobs.find(j => j.id === id); if (job?.status === 'running') { inFlight--; job.status = 'cancelled'; } },
  };
  const capture = async (_project, { plan, itemRoot }) => {
    if (plan.id === captureFailure) throw Error('synthetic private draft cannot be read');
    await mkdir(itemRoot, { recursive: true });
    const value = structuredClone(current.get(plan.id));
    await writeFile(join(itemRoot, 'film.html'), value.text);
    const snapshot = { root: itemRoot, revision: hash(value), origin: 'private', sourceProjectId: `draft-${plan.id}`, planId: plan.id, fps: value.fps, media: [] };
    captured.push(snapshot); return snapshot;
  };
  const materialize = async (snapshot, { mediaRoot, mediaCache }) => {
    assert.ok(mediaRoot.startsWith(dir + sep)); assert.ok(mediaCache instanceof Map);
    materialized.push(snapshot.planId);
  };
  let configuredDrafts = null;
  const options = { plans: { status: async () => structuredClone(state) }, exports, outputRoot: () => output, capture, materialize, pollMs: 1, revealFolder: async folder => { revealed.push(folder); }, draftsRoot: () => configuredDrafts };
  const managers = [];
  const make = () => { const value = createStructureBatchExports(options); managers.push(value); return value; };
  t.after(async () => { await Promise.all(managers.map(m => m.stop())); assert.ok(resolve(dir).startsWith(resolve(base) + sep)); await rm(dir, { recursive: true, force: true }); });
  const request = ids => ({ ...scope, taskKey: state.taskKey, planIds: ids, requestId: randomUUID() });
  return { project, root, output, current, captured, materialized, sent, jobs, failures, state, make, request, revealed, setDrafts: folder => { configuredDrafts = folder; },
    resume: () => { paused = false; jobs.forEach(complete); }, max: () => maximum,
  };
}

test('only checked plans are frozen and exported, in original plan order, without changing the parent film', async t => {
  const f = await fixture(t, { count: 256 }), m = f.make();
  const batch = await m.create(f.project, f.request(['plan-256', 'plan-2', 'plan-65']));
  assert.equal(batch.total, 3); assert.deepEqual(batch.items.map(x => x.label), ['方案 002', '方案 065', '方案 256']);
  await m.wait(f.project, batch.id);
  assert.deepEqual(f.captured.map(x => x.planId), ['plan-2', 'plan-65', 'plan-256']);
  assert.deepEqual(f.sent.map(x => x.snapshot.planId), ['plan-2', 'plan-65', 'plan-256']);
  assert.equal(f.max(), 1);
  const saved = (await m.list(f.project)).batches[0];
  assert.equal(saved.status, 'complete'); assert.equal(saved.completed, 3); assert.equal(saved.progress, 1);
  assert.ok(saved.items.every(x => x.origin === 'private' && x.revision && !Object.hasOwn(x, 'snapshot')));
  assert.equal(await readFile(join(f.root, 'film.html'), 'utf8'), 'existing parent film');
});

test('Jianying destination outputs direct drafts with persistent media under its configured root', async t => {
  const f = await fixture(t), m = f.make(), drafts = join(f.output, 'configured-jianying');
  await mkdir(drafts, { recursive: true }); f.setDrafts(drafts);
  assert.equal((await m.list(f.project)).jianyingFolder, drafts);
  const request = { ...f.request(['plan-2', 'plan-1']), destination: 'jianying', folder: drafts, name: '正式入口模拟' };
  const batch = await m.create(f.project, request); await m.wait(f.project, batch.id);
  assert.equal(batch.destination, 'jianying'); assert.equal(batch.folder, drafts);
  assert.equal(batch.storageFolder, join(drafts, '.daocut-structure-batches', batch.id));
  assert.ok(f.captured.every(item => item.root.startsWith(batch.storageFolder + sep)));
  assert.ok(f.sent.every(item => item.ask.folder === drafts));
  assert.deepEqual(f.sent.map(item => item.project.name), ['正式入口模拟_方案001', '正式入口模拟_方案002']);
  assert.deepEqual(await m.reveal(f.project, batch.id), { folder: drafts });
  assert.deepEqual(f.revealed, [drafts]);
  assert.equal((await m.create(f.project, request)).id, batch.id);
  await assert.rejects(m.create(f.project, { ...request, destination: 'folder' }), /同一次导出/);
});

test('Jianying target must exist and match the shown path; invalid targets never fall back to exports', async t => {
  const f = await fixture(t), m = f.make();
  assert.equal((await m.list(f.project)).jianyingFolder, null);
  await assert.rejects(m.create(f.project, { ...f.request(['plan-1']), destination: 'jianying' }), /剪映草稿目录/);
  f.setDrafts(join(f.output, 'gone'));
  await assert.rejects(m.create(f.project, { ...f.request(['plan-1']), destination: 'jianying' }), /剪映草稿目录/);
  const drafts = join(f.output, 'configured-jianying'); await mkdir(drafts, { recursive: true }); f.setDrafts(drafts);
  await assert.rejects(m.create(f.project, { ...f.request(['plan-1']), destination: 'jianying', folder: join(f.output, 'another') }), /目录.*变化|目录.*不一致/);
  await assert.rejects(m.create(f.project, { ...f.request(['plan-1']), destination: 'unknown' }));
  assert.equal(f.captured.length, 0); assert.equal(f.sent.length, 0);
  assert.equal((await m.list(f.project)).batches.length, 0);
});

test('Jianying retry uses frozen root and names even when configured root changes after reopen', async t => {
  const f = await fixture(t), m = f.make(), first = join(f.output, 'first-drafts'), second = join(f.output, 'second-drafts');
  await mkdir(first, { recursive: true }); await mkdir(second, { recursive: true }); f.setDrafts(first); f.failures.add('plan-2');
  const request = { ...f.request(['plan-1', 'plan-2']), destination: 'jianying', folder: first, name: '冻结名称' };
  const batch = await m.create(f.project, request); await m.wait(f.project, batch.id); await m.stop();
  f.setDrafts(second); f.failures.clear(); f.jobs.length = 0;
  const reopened = f.make();
  assert.equal((await reopened.list(f.project)).jianyingFolder, second);
  assert.equal((await reopened.create(f.project, request)).id, batch.id);
  await reopened.retry(f.project, batch.id); await reopened.wait(f.project, batch.id);
  assert.equal(f.sent.at(-1).ask.folder, first); assert.equal(f.sent.at(-1).project.name, '冻结名称_方案002');
  assert.equal((await reopened.list(f.project)).batches[0].completed, 2);
});

test('chosen names and output folder are frozen, visible, and reused by the existing export queue after reopen', async t => {
  const f = await fixture(t), m = f.make(); f.failures.add('plan-2');
  const request = { ...f.request(['plan-2', 'plan-1']), name: '随行杯', folder: join(f.output, '用户选定目录') };
  assert.equal((await m.list(f.project)).folder, f.output);
  const batch = await m.create(f.project, request); await m.wait(f.project, batch.id);
  assert.equal(batch.folder, join(request.folder, `结构视频-${batch.id}`));
  assert.equal(batch.name, '随行杯');
  assert.deepEqual(batch.items.map(item => item.exportName), ['随行杯_方案001', '随行杯_方案002']);
  assert.deepEqual(f.sent.map(item => item.project.name), ['随行杯_方案001', '随行杯_方案002']);
  assert.deepEqual(f.sent.map(item => item.ask.name), ['随行杯_方案001', '随行杯_方案002']);
  assert.ok(f.sent.every(item => item.ask.folder === batch.folder));
  await assert.rejects(m.create(f.project, { ...request, name: '另一个名称' }), /同一次导出/);
  await assert.rejects(m.create(f.project, { ...request, folder: join(f.output, '另一个目录') }), /同一次导出/);
  assert.equal((await m.create(f.project, request)).id, batch.id);
  await m.stop(); f.jobs.length = 0; f.failures.clear(); f.project.name = '工程后来改名';
  const reopened = f.make(); await reopened.retry(f.project, batch.id); await reopened.wait(f.project, batch.id);
  assert.equal(f.sent.at(-1).project.name, '随行杯_方案002');
  assert.equal(f.sent.at(-1).ask.folder, batch.folder);
  assert.equal((await reopened.list(f.project)).batches[0].completed, 2);
});

test('batch names retain original plan ordinals and reject invalid name/folder inputs before capture', async t => {
  const f = await fixture(t), m = f.make();
  const file = join(f.output, 'not-a-folder'); await mkdir(f.output); await writeFile(file, 'keep');
  for (const options of [{ name: 42 }, { name: 'a'.repeat(121) }, { folder: 'relative/path' }, { folder: 42 }, { folder: file }]) {
    await assert.rejects(m.create(f.project, { ...f.request(['plan-1']), ...options }));
  }
  assert.equal(f.captured.length, 0);
  const batch = await m.create(f.project, { ...f.request(['plan-2']), name: 'a'.repeat(100) }); await m.wait(f.project, batch.id);
  assert.ok(batch.items[0].exportName.endsWith('_方案002'));
  assert.equal(batch.items[0].exportName.length, 80);
});

test('opening batch output only reveals this parent saved existing batch directory', async t => {
  const f = await fixture(t), m = f.make();
  const batch = await m.create(f.project, { ...f.request(['plan-1']), name: '打开测试' }); await m.wait(f.project, batch.id);
  assert.deepEqual(await m.reveal(f.project, batch.id), { folder: batch.folder });
  assert.deepEqual(f.revealed, [batch.folder]);
  await assert.rejects(m.reveal(f.project, '../other'));
  await assert.rejects(m.reveal(f.project, '0'.repeat(24)), /找不到/);
  await assert.rejects(m.reveal({ ...f.project, id: 'different-parent' }, batch.id), /工程身份/);
  await rm(batch.folder, { recursive: true, force: true });
  await assert.rejects(m.reveal(f.project, batch.id), /导出目录/);
  assert.equal(f.revealed.length, 1);
});

test('older records without names reopen and replay the original request without creating another batch', async t => {
  const f = await fixture(t), m = f.make(); f.failures.add('plan-1');
  const request = f.request(['plan-1']);
  const batch = await m.create(f.project, request); await m.wait(f.project, batch.id); await m.stop();
  const path = join(f.root, '.film/structure-export-batches', `${batch.id}.json`), saved = JSON.parse(await readFile(path, 'utf8'));
  delete saved.name; delete saved.items[0].exportName; await writeFile(path, JSON.stringify(saved));
  f.jobs.length = 0; f.failures.clear();
  const reopened = f.make();
  assert.equal((await reopened.create(f.project, request)).id, batch.id);
  assert.equal(f.sent.length, 1);
  await reopened.retry(f.project, batch.id); await reopened.wait(f.project, batch.id);
  assert.equal(f.sent.at(-1).project.name, '模拟商品 方案 001');
  assert.equal(f.sent.at(-1).ask.folder, batch.folder);
  assert.equal((await reopened.list(f.project)).batches[0].completed, 1);
});

test('256 selected plans complete serially with bounded active jobs', async t => {
  const f = await fixture(t, { count: 256 }), m = f.make();
  const batch = await m.create(f.project, f.request(f.state.plans.map(p => p.id)));
  await m.wait(f.project, batch.id);
  const saved = (await m.list(f.project)).batches[0];
  assert.equal(f.sent.length, 256); assert.equal(f.max(), 1); assert.equal(saved.completed, 256);
});

test('selection and public version are validated before capturing any draft', async t => {
  const f = await fixture(t), m = f.make();
  for (const ids of [[], ['plan-1', 'unknown'], ['plan-1', 'plan-1']]) await assert.rejects(m.create(f.project, f.request(ids)));
  await assert.rejects(m.create(f.project, { ...f.request(['plan-1']), taskKey: 'different' }));
  f.state.status = 'running'; await assert.rejects(m.create(f.project, f.request(['plan-1'])));
  f.state.status = 'complete'; f.state.context.visibility = 'private'; await assert.rejects(m.create(f.project, f.request(['plan-1'])));
  assert.equal(f.captured.length, 0); assert.equal(f.sent.length, 0);
});

test('all selected edits are frozen before create returns and a duplicate request cannot duplicate exports', async t => {
  const f = await fixture(t, { hold: true }), m = f.make(), request = f.request(['plan-1', 'plan-2']);
  const [batch, replay] = await Promise.all([m.create(f.project, request), m.create(f.project, request)]);
  assert.equal(batch.id, replay.id); assert.equal(f.captured.length, 2);
  f.current.set('plan-2', { text: 'later user edit', fps: 60 });
  f.resume(); await m.wait(f.project, batch.id);
  const second = f.sent.find(s => s.snapshot.planId === 'plan-2');
  assert.equal(await readFile(join(second.snapshot.root, 'film.html'), 'utf8'), 'private edit 2');
  assert.equal(second.ask.fps, 30);
  assert.equal((await m.create(f.project, request)).id, batch.id); assert.equal(f.sent.length, 2);
  await assert.rejects(m.create(f.project, { ...request, planIds: ['plan-3'] }));
});

test('one export failure leaves others running and retry reuses the saved snapshot without repeating completed items', async t => {
  const f = await fixture(t), m = f.make(); f.failures.add('plan-2');
  const batch = await m.create(f.project, f.request(['plan-1', 'plan-2', 'plan-3'])); await m.wait(f.project, batch.id);
  const failed = (await m.list(f.project)).batches[0];
  assert.equal(failed.status, 'failed'); assert.equal(failed.completed, 2); assert.equal(failed.failed, 1);
  assert.match(failed.items[1].error, /synthetic disk/); assert.equal(failed.items[1].retryable, true);
  f.current.set('plan-2', { text: 'must not replace frozen version', fps: 60 }); f.failures.clear();
  await m.retry(f.project, batch.id); await m.wait(f.project, batch.id);
  assert.deepEqual(f.sent.map(s => s.snapshot.planId), ['plan-1', 'plan-2', 'plan-3', 'plan-2']);
  assert.equal(f.captured.length, 3); assert.equal(f.sent.at(-1).snapshot.revision, f.sent[1].snapshot.revision);
});

test('reopen preserves finished results and never automatically resends interrupted tasks', async t => {
  const f = await fixture(t, { hold: true }), m = f.make();
  const batch = await m.create(f.project, f.request(['plan-1', 'plan-2']));
  while (!f.sent.length) await tick();
  await m.stop();
  const reopened = f.make(), read = (await reopened.list(f.project)).batches[0];
  assert.equal(read.status, 'interrupted'); assert.equal(f.sent.length, 1);
  assert.ok(read.items.every(i => i.status === 'interrupted' && i.retryable));
  f.resume(); await reopened.retry(f.project, batch.id); await reopened.wait(f.project, batch.id);
  assert.equal((await reopened.list(f.project)).batches[0].completed, 2);
  assert.equal(f.captured.length, 2);
  const another = f.make(); assert.equal((await another.list(f.project)).batches[0].status, 'complete');
  await another.retry(f.project, batch.id); assert.equal(f.sent.length, 3);
});

test('cancel stops only this batch and queued items stay cancelled after reopen', async t => {
  const f = await fixture(t, { hold: true }), m = f.make();
  f.jobs.push({ id: 'ordinary-job', project: f.project.id, status: 'running', progress: 0 });
  const batch = await m.create(f.project, f.request(['plan-1', 'plan-2']));
  while (!f.sent.length) await tick();
  await m.cancel(f.project, batch.id); await m.wait(f.project, batch.id);
  assert.equal(f.jobs.find(j => j.id === 'ordinary-job').status, 'running');
  const reopened = f.make(), read = (await reopened.list(f.project)).batches[0];
  assert.equal(read.status, 'cancelled'); assert.ok(read.items.every(i => i.status === 'cancelled'));
  await reopened.retry(f.project, batch.id); assert.equal(f.sent.length, 1);
});

test('capture failure is reported per item and cannot be retried as a different current edit', async t => {
  const f = await fixture(t, { captureFailure: 'plan-2' }), m = f.make();
  const batch = await m.create(f.project, f.request(['plan-1', 'plan-2', 'plan-3'])); await m.wait(f.project, batch.id);
  const read = (await m.list(f.project)).batches[0];
  assert.equal(read.completed, 2); assert.equal(read.items[1].status, 'failed'); assert.equal(read.items[1].retryable, false);
  await m.retry(f.project, batch.id); assert.equal(f.sent.length, 2);
  assert.ok((await readdir(join(f.root, '.film/structure-export-batches'))).some(x => x.endsWith('.json')));
});

async function completedButUnrecorded(f, { keepJob = false, corruptReceipt = false, receipt = true, folderName = 'completed-draft', destination = 'folder' } = {}) {
  if (destination === 'jianying') { const drafts = join(f.output, 'configured-jianying'); await mkdir(drafts, { recursive: true }); f.setDrafts(drafts); }
  const manager = f.make();
  const created = await manager.create(f.project, { ...f.request(['plan-1']), destination }); await manager.wait(f.project, created.id); await manager.stop();
  const file = join(f.root, '.film/structure-export-batches', `${created.id}.json`);
  const saved = JSON.parse(await readFile(file, 'utf8')), item = saved.items[0];
  const folder = join(saved.draftsFolder ?? saved.folder, folderName);
  if (receipt) {
    await mkdir(folder, { recursive: true });
    const files = {};
    for (const name of ['draft_info.json', 'draft_content.json', 'draft_meta_info.json']) {
      const bytes = JSON.stringify({ id: 'same-completed-draft', name });
      await writeFile(join(folder, name), bytes); files[name] = createHash('sha256').update(bytes).digest('hex');
    }
    await writeFile(join(folder, '.daocut-structure-export.json'), JSON.stringify({ version: 1, batchId: saved.id, itemId: item.id, revision: item.revision, files }));
    if (corruptReceipt) await writeFile(join(folder, 'draft_info.json'), 'changed after export');
  }
  item.status = 'running'; item.progress = 0.98; item.outputs = []; item.attempted = true;
  await writeFile(file, JSON.stringify(saved));
  if (!keepJob) f.jobs.length = 0;
  return { id: saved.id, item, folder };
}

test('reopen reconciles a completed in-memory job without discarding its identity or duplicating it', async t => {
  const f = await fixture(t), saved = await completedButUnrecorded(f, { keepJob: true, receipt: false }), reopened = f.make();
  const read = (await reopened.list(f.project)).batches[0];
  assert.equal(read.items[0].jobId, saved.item.jobId);
  assert.equal(read.items[0].status, 'done');
  await reopened.retry(f.project, saved.id); await reopened.wait(f.project, saved.id);
  assert.equal(f.sent.length, 1);
});

test('reopen keeps a live job identity and refuses to submit a second copy', async t => {
  const f = await fixture(t), saved = await completedButUnrecorded(f, { keepJob: true, receipt: false }), reopened = f.make();
  f.jobs[0].status = 'running'; f.jobs[0].outputs = [];
  const read = (await reopened.list(f.project)).batches[0];
  assert.equal(read.items[0].jobId, saved.item.jobId);
  await assert.rejects(reopened.retry(f.project, saved.id), /仍在导出/);
  assert.equal(f.sent.length, 1);
  f.jobs[0].status = 'done'; f.jobs[0].outputs = [join(f.output, 'already-made')];
  assert.equal((await reopened.list(f.project)).batches[0].items[0].status, 'done', 'later polling must reconcile the same existing job');
  await reopened.retry(f.project, saved.id); assert.equal(f.sent.length, 1);
});

test('reopen verifies the atomically published completion receipt and repairs a lost done record', async t => {
  const f = await fixture(t), saved = await completedButUnrecorded(f), reopened = f.make();
  const read = (await reopened.list(f.project)).batches[0];
  assert.equal(read.status, 'complete');
  assert.equal(read.items[0].outputs[0], join(saved.folder, 'draft_info.json'));
  await reopened.retry(f.project, saved.id); await reopened.wait(f.project, saved.id);
  assert.equal(f.sent.length, 1);
});

test('Jianying direct-root receipts repair lost completion without repeating or touching unrelated drafts', async t => {
  const f = await fixture(t), saved = await completedButUnrecorded(f, { destination: 'jianying' });
  const other = join(f.output, 'configured-jianying', 'colleague-draft');
  await mkdir(other); await writeFile(join(other, 'draft_info.json'), 'other draft unchanged');
  const reopened = f.make(), read = (await reopened.list(f.project)).batches[0];
  assert.equal(read.status, 'complete'); assert.equal(read.items[0].outputs[0], join(saved.folder, 'draft_info.json'));
  await reopened.retry(f.project, saved.id); assert.equal(f.sent.length, 1);
  assert.equal(await readFile(join(other, 'draft_info.json'), 'utf8'), 'other draft unchanged');
});

for (const variant of [{ receipt: false }, { corruptReceipt: true }]) {
  test(`unknown or damaged completed output requires inspection instead of another export ${JSON.stringify(variant)}`, async t => {
    const f = await fixture(t), saved = await completedButUnrecorded(f, variant), reopened = f.make();
    const read = (await reopened.list(f.project)).batches[0];
    assert.equal(read.items[0].retryable, false);
    assert.match(read.items[0].error, /核对/);
    assert.equal((await reopened.list(f.project)).batches[0].items[0].retryable, false, 'polling must not re-enable an unknown result');
    await reopened.retry(f.project, saved.id); await reopened.wait(f.project, saved.id);
    assert.equal(f.sent.length, 1);
  });
}

for (const folderName of ['_模拟商品', '.模拟商品']) {
  test(`completion receipt is recovered for a legitimate draft directory ${folderName}`, async t => {
    const f = await fixture(t), saved = await completedButUnrecorded(f, { folderName }), reopened = f.make();
    const read = (await reopened.list(f.project)).batches[0];
    assert.equal(read.status, 'complete');
    assert.equal(read.items[0].outputs[0], join(saved.folder, 'draft_info.json'));
    await reopened.retry(f.project, saved.id); assert.equal(f.sent.length, 1);
  });
}

test('a known failure remains retryable after the volatile export queue has gone away', async t => {
  const f = await fixture(t), manager = f.make(); f.failures.add('plan-1');
  const batch = await manager.create(f.project, f.request(['plan-1'])); await manager.wait(f.project, batch.id); await manager.stop();
  f.jobs.length = 0; f.failures.clear();
  const reopened = f.make(), read = (await reopened.list(f.project)).batches[0];
  assert.equal(read.items[0].retryable, true);
  await reopened.retry(f.project, batch.id); await reopened.wait(f.project, batch.id);
  assert.equal((await reopened.list(f.project)).batches[0].status, 'complete'); assert.equal(f.sent.length, 2);
});
