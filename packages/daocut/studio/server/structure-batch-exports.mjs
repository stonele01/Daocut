/** Selected structure plans become immutable export snapshots; only one is handed to the existing queue at a time. */
import { createHash } from 'node:crypto';
import { isSavedStructurePlanUsable } from './structure-plan-availability.mjs';
import { mkdir, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { HttpError } from './http.mjs';
import { writeAtomic } from './atomic.mjs';
import { exportDirectory, exportBaseName } from './exports.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validId = id => typeof id === 'string' && /^[a-f0-9]{24}$/.test(id);
const pending = status => ['preparing', 'waiting', 'running'].includes(status);
const terminal = status => ['done', 'failed', 'cancelled'].includes(status);
const within = (root, path) => { const part = relative(root, path); return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`)); };
const pause = ms => new Promise(done => setTimeout(done, ms));
const captureDefault = async (...args) => (await import('./structure-export-snapshot.mjs')).captureStructureExport(...args);
const materializeDefault = async (...args) => (await import('./structure-export-snapshot.mjs')).materializeStructureExport(...args);
const readJson = async path => {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new HttpError(409, '批量导出记录无法读取，原记录已保留'); }
};
const receiptName = '.daocut-structure-export.json';
const draftFiles = ['draft_info.json', 'draft_content.json', 'draft_meta_info.json'];
const draftsFolderOf = batch => batch.draftsFolder ?? batch.folder;
const storageFolderOf = (root, id, destination) => destination === 'jianying' ? join(root, '.daocut-structure-batches', id) : join(root, `结构视频-${id}`);

// Read only this batch's direct output directories. A receipt is committed together
// with its draft, so a completed output can survive a lost batch-ledger write.
async function completionReceipts(batch) {
  const output = draftsFolderOf(batch);
  const directories = await readdir(output, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const found = [];
  for (const entry of directories.filter(entry => entry.isDirectory() && !['_media', '_snapshots', '.daocut-structure-batches'].includes(entry.name) && !/^\..+\.partial-\d+-[a-f0-9]{12}$/.test(entry.name))) {
    const folder = join(output, entry.name);
    let receipt;
    try { receipt = JSON.parse(await readFile(join(folder, receiptName), 'utf8')); }
    catch { continue; }
    if (receipt?.batchId !== batch.id) continue;
    let valid = receipt.version === 1;
    try {
      if (!within(await realpath(output), await realpath(folder))) valid = false;
      for (const name of draftFiles) {
        const bytes = await readFile(join(folder, name));
        if (createHash('sha256').update(bytes).digest('hex') !== receipt.files?.[name]) valid = false;
        JSON.parse(bytes.toString('utf8'));
      }
    } catch { valid = false; }
    found.push({ receipt, valid, outputs: draftFiles.map(name => join(folder, name)) });
  }
  return found;
}

function totals(batch) {
  batch.total = batch.items.length;
  batch.completed = batch.items.filter(item => item.status === 'done').length;
  batch.failed = batch.items.filter(item => item.status === 'failed').length;
  batch.progress = batch.total ? batch.items.reduce((sum, item) => sum + (terminal(item.status) ? 1 : item.progress || 0), 0) / batch.total : 0;
  if (batch.cancelRequested) batch.status = 'cancelled';
  else if (batch.items.some(item => item.status === 'interrupted')) batch.status = 'interrupted';
  else if (batch.items.some(item => item.status === 'preparing')) batch.status = 'preparing';
  else if (batch.items.some(item => pending(item.status))) batch.status = 'running';
  else batch.status = batch.completed === batch.total ? 'complete' : 'failed';
  return batch;
}

function view(batch) {
  totals(batch);
  return structuredClone({ id: batch.id, createdAt: batch.createdAt, status: batch.status, folder: draftsFolderOf(batch), storageFolder: batch.folder, destination: batch.destination ?? 'folder', name: batch.name,
    total: batch.total, completed: batch.completed, failed: batch.failed, progress: batch.progress,
    items: batch.items.map(({ id, planId, label, exportName, origin, revision, sourceProjectId, status, progress, error, outputs, retryable, jobId }) =>
      ({ id, planId, label, exportName, origin, revision, sourceProjectId, status, progress, error, outputs, retryable, jobId })) });
}

export function createStructureBatchExports({ plans, exports, outputRoot, capture = captureDefault, materialize = materializeDefault, pollMs = 250, revealFolder, draftsRoot = () => null }) {
  const cached = new Map(), active = new Map(), creating = new Map(), writes = new Map();
  let closed = false, tail = Promise.resolve();
  const keyOf = (project, id) => `${resolve(project.path)}:${id}`;
  const dirOf = project => join(project.path, '.film/structure-export-batches');
  const pathOf = (project, id) => { if (!validId(id)) throw new HttpError(400, '批量导出编号无效'); return join(dirOf(project), `${id}.json`); };
  const defaultFolder = async () => exportDirectory(typeof outputRoot === 'function' ? await outputRoot() : outputRoot);
  const existingDraftsFolder = async (folder) => {
    try { if (folder && (await stat(folder)).isDirectory()) return exportDirectory(folder); }
    catch { /* A missing or invalid configured target is not an export-folder fallback. */ }
    throw new HttpError(409, '剪映草稿目录不存在或无法访问，请检查剪映保存位置后重新打开导出');
  };
  const configuredDraftsFolder = async (required = false) => {
    try { return await existingDraftsFolder(await draftsRoot()); }
    catch (error) { if (required) throw error; return null; }
  };

  async function checkProject(project) {
    if (!project?.id || typeof project.path !== 'string') throw new HttpError(400, '请先打开原工程');
    if ((await readFile(join(project.path, '.film/id'), 'utf8')).trim() !== project.id) throw new HttpError(409, '工程身份已变化，未导出');
    if (await readJson(join(project.path, '.film/structure-draft.json'))) throw new HttpError(409, '请从原工程勾选公共方案');
  }

  async function persist(project, batch) {
    totals(batch);
    const key = keyOf(project, batch.id), bytes = JSON.stringify(batch);
    const next = (writes.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      await mkdir(dirOf(project), { recursive: true });
      if (!within(await realpath(project.path), await realpath(dirOf(project)))) throw new HttpError(409, '批量导出记录目录不能指向工程外');
      await writeAtomic(pathOf(project, batch.id), `${bytes}\n`);
    });
    writes.set(key, next);
    try { await next; } finally { if (writes.get(key) === next) writes.delete(key); }
  }

  function reconcile(project, batch, item, receipts) {
    const job = item.jobId && exports.list(project.id).find(job => job.id === item.jobId);
    if (job?.status === 'done') {
      Object.assign(item, { status: 'done', progress: 1, outputs: [...(job.outputs ?? [])], retryable: false }); delete item.error;
      return;
    }
    if (job && ['waiting', 'running'].includes(job.status)) {
      item.status = 'interrupted'; item.error = '原任务仍在导出，正在等待已有结果；未重复加入队列'; item.retryable = true;
      return;
    }
    if (receipts) {
      const matches = receipts.filter(record => record.receipt.itemId === item.id);
      if (matches.length === 1 && matches[0].valid && matches[0].receipt.revision === item.revision) {
        Object.assign(item, { status: 'done', progress: 1, outputs: matches[0].outputs, retryable: false }); delete item.error;
        return;
      }
      if (matches.length || (item.attempted === true || (item.attempted === undefined && item.jobId)) && !['failed', 'cancelled'].includes(job?.status)) {
        item.status = 'interrupted'; item.error = '上次导出结果尚不能确认，请核对本批导出目录；未自动重复导出'; item.retryable = false;
        return;
      }
    }
    if (job && ['failed', 'cancelled'].includes(job.status)) item.attempted = false;
    if (pending(item.status) || item.status === 'interrupted') {
      item.status = 'interrupted'; item.error = item.snapshot ? '上次导出已中断，可继续使用已固定版本' : '上次尚未完成版本保存，请重新勾选导出';
      item.retryable = Boolean(item.snapshot);
    }
  }

  async function load(project, id) {
    const key = keyOf(project, id);
    let batch = cached.get(key);
    const restored = !batch;
    if (!batch) {
      batch = await readJson(pathOf(project, id));
      if (!batch) return null;
      if (batch.version !== 1 || batch.id !== id || batch.projectId !== project.id || !Array.isArray(batch.items)
        || !['folder', 'jianying'].includes(batch.destination ?? 'folder')
        || typeof batch.outputBase !== 'string' || batch.folder !== storageFolderOf(batch.outputBase, id, batch.destination)
        || (batch.destination === 'jianying' ? batch.draftsFolder !== batch.outputBase : batch.draftsFolder && batch.draftsFolder !== batch.folder)
        || batch.items.some(item => typeof item.id !== 'string' || !/^\d+$/.test(item.id) || (item.snapshot && resolve(item.snapshot.root) !== resolve(batch.folder, '_snapshots', item.id)))) {
        throw new HttpError(409, '批量导出记录身份不匹配，未恢复导出');
      }
      cached.set(key, batch);
    }
    if (!active.has(key) && !creating.has(key)) {
      const candidates = batch.items.filter(item => pending(item.status) || item.status === 'interrupted' || restored && item.status === 'failed');
      if (candidates.length) {
        const before = JSON.stringify(candidates), receipts = restored ? await completionReceipts(batch) : undefined;
        for (const item of candidates) {
          // In-memory completion can arrive after an earlier recovery poll. Keep the
          // saved job ID, and do not turn an unknown disk result into a retryable one.
          if (!restored && item.status === 'interrupted' && !item.retryable) {
            const job = item.jobId && exports.list(project.id).find(job => job.id === item.jobId);
            if (job?.status !== 'done') continue;
          }
          reconcile(project, batch, item, receipts);
        }
        if (JSON.stringify(candidates) !== before) await persist(project, batch);
      }
    }
    return batch;
  }

  async function list(project) {
    await checkProject(project);
    const names = await readdir(dirOf(project)).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    const batches = [];
    for (const name of names.filter(name => /^[a-f0-9]{24}\.json$/.test(name))) {
      const batch = await load(project, name.slice(0, -5));
      if (batch) batches.push(view(batch));
    }
    return { batches: batches.sort((a, b) => b.createdAt.localeCompare(a.createdAt)), folder: await defaultFolder(), jianyingFolder: await configuredDraftsFolder() };
  }

  async function interrupt(project, batch) {
    for (const item of batch.items.filter(item => pending(item.status))) {
      const job = item.jobId && exports.list(project.id).find(job => job.id === item.jobId);
      if (job?.status === 'done') { reconcile(project, batch, item); continue; }
      if (job && ['failed', 'cancelled'].includes(job.status)) item.attempted = false;
      item.status = batch.cancelRequested ? 'cancelled' : 'interrupted';
      item.retryable = !batch.cancelRequested && Boolean(item.snapshot);
      item.error = batch.cancelRequested ? '已取消' : '导出中断，未自动重新执行';
    }
    await persist(project, batch);
  }

  async function run(project, batch) {
    const mediaCache = new Map();
    for (const item of batch.items) {
      if (closed || batch.cancelRequested) { await interrupt(project, batch); return; }
      if (item.status !== 'waiting' || !item.snapshot) continue;
      item.status = 'running'; item.progress = 0; delete item.error;
      await persist(project, batch);
      try {
        if (batch.destination === 'jianying') await existingDraftsFolder(batch.draftsFolder);
        await materialize(item.snapshot, { mediaRoot: join(batch.folder, '_media'), mediaCache });
        if (closed || batch.cancelRequested) { await interrupt(project, batch); return; }
        // Persist intent before dispatch: after a crash, a missing job/receipt is
        // an unknown result, not evidence that submitting again is harmless.
        item.attempted = true; await persist(project, batch);
        const exportName = item.exportName ?? `${project.name} ${item.label}`;
        const job = exports.startSnapshot({ id: project.id, name: exportName, path: item.snapshot.root },
          { kind: 'nle', format: 'jianying', media: 'link', ...(item.exportName ? { name: exportName } : {}), subtitles: true, fps: item.snapshot.fps ?? 30, folder: draftsFolderOf(batch),
            receipt: { batchId: batch.id, itemId: item.id, revision: item.revision } });
        item.jobId = job.id;
        await persist(project, batch);
        for (;;) {
          if (closed || batch.cancelRequested) {
            exports.cancel(job.id);
            await interrupt(project, batch); return;
          }
          const current = exports.list(project.id).find(value => value.id === job.id);
          if (!current) throw new Error('导出任务已中断，已固定版本仍然保留');
          if (current.status === 'done') { item.status = 'done'; item.progress = 1; item.outputs = [...(current.outputs ?? [])]; item.retryable = false; break; }
          if (current.status === 'failed') throw new Error(current.error || '剪映草稿导出失败');
          if (current.status === 'cancelled') { item.status = 'cancelled'; item.error = '已取消'; item.retryable = false; break; }
          const progress = Math.max(0, Math.min(1, current.progress || 0));
          if (Math.abs(progress - item.progress) >= 0.02 || item.status !== current.status) {
            const statusChanged = item.status !== current.status;
            item.status = current.status === 'waiting' ? 'waiting' : 'running'; item.progress = progress;
            // The UI reads live progress from memory. Persist lifecycle changes, not a full 256-item ledger per frame.
            if (statusChanged) await persist(project, batch);
          }
          await pause(pollMs);
        }
      } catch (error) {
        item.status = 'failed'; item.error = error instanceof Error ? error.message : String(error); item.outputs = [];
        item.retryable = Boolean(item.snapshot);
        const job = item.jobId && exports.list(project.id).find(job => job.id === item.jobId);
        if (job && ['failed', 'cancelled'].includes(job.status)) item.attempted = false;
      }
      await persist(project, batch);
    }
    await persist(project, batch);
  }

  function schedule(project, batch) {
    const key = keyOf(project, batch.id);
    if (active.has(key)) return active.get(key).promise;
    const task = { project, batch, promise: null };
    const promise = tail.catch(() => {}).then(() => run(project, batch)).catch(async error => {
      for (const item of batch.items.filter(item => pending(item.status))) {
        item.status = 'interrupted'; item.error = `批次暂停：${error instanceof Error ? error.message : String(error)}`; item.retryable = Boolean(item.snapshot);
      }
      await persist(project, batch).catch(() => {});
    }).finally(() => active.delete(key));
    task.promise = promise; active.set(key, task); tail = promise;
    return promise;
  }

  function create(project, request) {
    if (closed) return Promise.reject(new HttpError(409, '服务正在关闭，未开始批量导出'));
    if (!request || typeof request.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(request.requestId)
      || !Array.isArray(request.planIds) || !request.planIds.length || request.planIds.some(id => typeof id !== 'string' || !id || id.length > 300)
      || new Set(request.planIds).size !== request.planIds.length) return Promise.reject(new HttpError(400, '请勾选要导出的方案，每条只能选择一次'));
    if (request.name !== undefined && (typeof request.name !== 'string' || request.name.length > 120)) return Promise.reject(new HttpError(400, '名称需为不超过 120 字的文字'));
    const destination = request.destination ?? 'folder';
    if (!['folder', 'jianying'].includes(destination)) return Promise.reject(new HttpError(400, '请选择剪映草稿库或指定文件夹'));
    let chosenFolder;
    try { if (request.folder !== undefined && request.folder !== null && request.folder !== '') chosenFolder = exportDirectory(request.folder); }
    catch (error) { return Promise.reject(new HttpError(400, error.message)); }
    const chosenName = request.name?.trim() || undefined;
    const id = hash([project.id, request.requestId]).slice(0, 24), key = keyOf(project, id);
    const scope = Object.fromEntries(['sourceId', 'productId', 'intervalId', 'startMs', 'endMs'].map(k => [k, request[k]]));
    // Preserve the signature of requests from older clients, so replaying them cannot create another batch.
    const inputs = [scope, request.taskKey, [...request.planIds].sort()];
    if (chosenName || chosenFolder || destination === 'jianying') inputs.push({ name: chosenName, folder: chosenFolder, ...(destination === 'jianying' ? { destination } : {}) });
    const inputHash = hash(inputs);
    if (creating.has(key)) return creating.get(key).then(batch => {
      if (cached.get(key).inputHash !== inputHash) throw new HttpError(409, '同一次导出请求不能更换方案、名称或目录');
      return batch;
    });
    const operation = (async () => {
      await checkProject(project);
      const previous = await load(project, id);
      if (previous) {
        if (previous.inputHash !== inputHash) throw new HttpError(409, '同一次导出请求不能更换方案、名称或目录');
        return view(previous);
      }
      const state = await plans.status(project.path, { ...scope, taskKey: request.taskKey });
      if (!['shared', 'local'].includes(state.context?.visibility) || state.taskKey !== request.taskKey
        || request.planIds.some(id => !isSavedStructurePlanUsable(state, id))) throw new HttpError(409, '所选方案不属于当前已保存版本，请重新读取方案列表');
      const selected = state.plans.map((plan, index) => ({ plan, ordinal: index + 1 })).filter(item => request.planIds.includes(item.plan.id));
      const outputBase = destination === 'jianying' ? await configuredDraftsFolder(true) : chosenFolder ?? await defaultFolder();
      if (destination === 'jianying' && chosenFolder && chosenFolder !== outputBase) throw new HttpError(409, '剪映草稿目录已变化，请重新打开导出核对保存位置');
      const folder = storageFolderOf(outputBase, id, destination);
      if (destination === 'folder') await mkdir(outputBase, { recursive: true });
      await mkdir(folder, { recursive: true });
      if (!within(await realpath(outputBase), await realpath(folder))) throw new HttpError(409, '批量导出目录不能指向输出目录之外');
      const name = chosenName ?? project.name;
      const batch = { version: 1, id, projectId: project.id, requestId: request.requestId, inputHash, taskKey: request.taskKey, name,
        createdAt: new Date().toISOString(), outputBase, folder, destination, draftsFolder: destination === 'jianying' ? outputBase : folder, cancelRequested: false,
        items: selected.map(({ plan, ordinal }) => {
          const suffix = `_方案${String(ordinal).padStart(3, '0')}`;
          return { id: String(ordinal).padStart(3, '0'), planId: plan.id, label: `方案 ${String(ordinal).padStart(3, '0')}`,
            exportName: `${exportBaseName(name).slice(0, 80 - suffix.length).trimEnd()}${suffix}`,
            status: 'preparing', progress: 0, outputs: [], retryable: false };
        }) };
      cached.set(key, batch); await persist(project, batch);
      for (let index = 0; index < selected.length; index++) {
        const item = batch.items[index];
        if (closed || batch.cancelRequested) break;
        try {
          const snapshot = await capture(project, { plan: selected[index].plan, itemRoot: join(folder, '_snapshots', item.id) });
          if (resolve(snapshot.root) !== resolve(folder, '_snapshots', item.id) || !snapshot.revision) throw new Error('导出快照身份无效');
          Object.assign(item, { snapshot, revision: snapshot.revision, origin: snapshot.origin, sourceProjectId: snapshot.sourceProjectId, status: 'waiting', retryable: true });
        } catch (error) { item.status = 'failed'; item.error = error instanceof Error ? error.message : String(error); item.retryable = false; }
        await persist(project, batch);
      }
      if (closed || batch.cancelRequested) await interrupt(project, batch);
      else schedule(project, batch);
      return view(batch);
    })().finally(() => creating.delete(key));
    creating.set(key, operation);
    return operation;
  }

  async function retry(project, id) {
    if (closed) throw new HttpError(409, '服务正在关闭，未恢复批量导出');
    await checkProject(project);
    const batch = await load(project, id);
    if (!batch) throw new HttpError(404, '找不到这次批量导出');
    if (active.has(keyOf(project, id)) || creating.has(keyOf(project, id)) || batch.cancelRequested) return view(batch);
    const receipts = await completionReceipts(batch);
    for (const item of batch.items.filter(item => ['failed', 'interrupted'].includes(item.status) && item.snapshot)) reconcile(project, batch, item, receipts);
    const items = [];
    for (const item of batch.items.filter(item => ['failed', 'interrupted'].includes(item.status) && item.retryable && item.snapshot)) {
      const previousJob = item.jobId && exports.list(project.id).find(job => job.id === item.jobId);
      if (previousJob?.status === 'done') {
        Object.assign(item, { status: 'done', progress: 1, outputs: [...(previousJob.outputs ?? [])], retryable: false }); delete item.error;
      } else if (previousJob && ['waiting', 'running'].includes(previousJob.status)) {
        throw new HttpError(409, '这条任务仍在导出，未重复加入队列');
      } else items.push(item);
    }
    await persist(project, batch);
    if (!items.length) return view(batch);
    for (const item of items) { item.status = 'waiting'; item.progress = 0; item.outputs = []; delete item.error; delete item.jobId; }
    await persist(project, batch); schedule(project, batch);
    return view(batch);
  }

  async function cancel(project, id) {
    await checkProject(project);
    const batch = await load(project, id);
    if (!batch) throw new HttpError(404, '找不到这次批量导出');
    if (batch.items.every(item => terminal(item.status))) return view(batch);
    batch.cancelRequested = true;
    for (const item of batch.items) if (pending(item.status) && item.jobId) exports.cancel(item.jobId);
    await interrupt(project, batch);
    return view(batch);
  }

  async function wait(project, id) {
    await creating.get(keyOf(project, id)); await active.get(keyOf(project, id))?.promise;
    const batch = await load(project, id); return batch ? view(batch) : null;
  }
  async function reveal(project, id) {
    await checkProject(project);
    const batch = await load(project, id);
    if (!batch) throw new HttpError(404, '找不到这次批量导出');
    const folder = draftsFolderOf(batch);
    try {
      if (!(await stat(folder)).isDirectory() || !within(await realpath(batch.outputBase), await realpath(folder))) throw Error('outside output');
    } catch { throw new HttpError(404, '导出目录不存在或已移动，请核对保存位置'); }
    if (!revealFolder) throw new HttpError(501, '当前环境无法打开文件夹，请复制目录');
    await revealFolder(folder);
    return { folder };
  }
  async function stop() {
    closed = true;
    for (const { batch } of active.values()) for (const item of batch.items) if (pending(item.status) && item.jobId) exports.cancel(item.jobId);
    await Promise.allSettled([...creating.values(), ...[...active.values()].map(task => task.promise)]);
  }
  return { list, create, retry, cancel, reveal, wait, stop };
}
