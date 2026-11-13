/** Shared AI baselines only. Personal edits and film documents never enter this store. */
import { createHash, randomUUID } from 'node:crypto';
import { mediaContentHash } from '../../src/shared-media-reference.mjs';
import { mkdir, readFile, readdir, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { writeAtomic } from './atomic.mjs';
import { sharedMediaManifest } from './shared-media.mjs';
import { productSourcePath } from './product-transcription.mjs';
import { readPrefs } from './prefs.mjs';
import { HttpError } from './http.mjs';

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => [k, canonical(value[k])])) : value;
export const sharedHash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(canonical(value))).digest('hex');
const schema = 'daocut.shared-analysis.v1';
const hex = /^[a-f0-9]{64}$/;
const fileFor = (root, taskKey) => { if (!hex.test(taskKey)) throw new HttpError(400, '共享任务身份无效'); return join(root, '.film', 'shared-analysis', `${taskKey}.json`); };
const inside = (root, path) => { const part = relative(root, path); return !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`); };
const readJson = async path => { try { return JSON.parse(await readFile(path, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw new HttpError(409, '共享结果记录无法读取，已保留原文件'); } };
const saveLocal = async (root, key, value) => { const path = fileFor(root, key); await mkdir(dirname(path), { recursive: true }); await writeAtomic(path, `${JSON.stringify(value)}\n`); };
const guardCoordinator = value => value ? { expectedCoordinatorId: value } : {};
const localReview = { mode: 'local-review', status: 'review-required', reason: '分段音频已完成，接缝需原分析者在本机核对；不会重新上传。跨电脑接缝原始结果导入暂未接通' };

/** Probe only before a new paid shared task or explicit folder initialization, never while reusing results. */
export async function probeSharedResultWritable(root) {
  let probe, created = false;
  try {
    await mkdir(root, { recursive: true });
    const actual = await realpath(root);
    probe = join(actual, `.daocut-write-check-${randomUUID()}.tmp`);
    const value = randomUUID();
    await writeFile(probe, value, { flag: 'wx' }); created = true;
    if (await readFile(probe, 'utf8') !== value) throw Error('write verification failed');
    await unlink(probe); created = false;
  } catch {
    throw new HttpError(409, '共享结果目录无法写入或校验；未提交分析，请核对目录和权限');
  } finally { if (created) await unlink(probe).catch(() => {}); }
}

export function createSharedAnalysis({ coordinate, settings = () => readPrefs().sharedAnalysis, readManifest = sharedMediaManifest, resolveSource = productSourcePath, publishFile = writeAtomic } = {}) {
  const active = new Set();
  async function mapping(libraryId) {
    const config = await settings();
    const root = config?.enabled && config.resultRoots?.find(item => item.libraryId === libraryId)?.root;
    return typeof root === 'string' && isAbsolute(root) ? resolve(root) : null;
  }
  async function coordinatorFor(libraryId, known) {
    const config = await settings(), mapped = config?.resultRoots?.find(item => item.libraryId === libraryId)?.coordinationId;
    if (mapped && known && mapped !== known) throw new HttpError(409, '直播文件夹与工程绑定的公司服务不同，未发送请求');
    return known || mapped;
  }
  async function sourceIdentity(root, source) {
    if (!(await settings())?.enabled) return null;
    const record = (await readManifest(root)).items[source.assetPath];
    if (!record) return { localOnly: true };
    if (!await mapping(record.libraryId)) throw new HttpError(409, '已启用共享，请先为此素材库配置共享结果目录；未改成本机付费分析');
    if (typeof coordinate !== 'function') throw new HttpError(409, '共享任务协调服务未接通，未发起本机付费分析');
    const path = await realpath(await resolveSource(root, source.assetPath)), before = await stat(path);
    // Opening, playback and shared results use the same verified identity and in-flight read.
    const digest = await mediaContentHash(path), after = await stat(path);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.ino !== after.ino) throw new HttpError(409, '素材在校验期间发生变化，未发送请求');
    return { libraryId: record.libraryId, relativePath: record.relativePath, sha256: digest, size: before.size, durationMs: source.durationMs };
  }
  function verify(envelope, descriptor, ref) {
    if (!envelope || envelope.schema !== schema || envelope.taskKey !== descriptor.taskKey || envelope.sourceIdentity !== descriptor.sourceIdentity || envelope.action !== descriptor.action || sharedHash(envelope) !== ref.sha256) throw new HttpError(409, '共享结果身份或完整性校验失败，未导入也未重新请求');
    return envelope;
  }
  async function artifact(root, descriptor, ref) {
    if (!ref || ref.schema !== schema || !hex.test(ref.sha256) || ref.path !== `results/${descriptor.taskKey}/${ref.sha256}.json`) throw new HttpError(409, '共享结果路径或版本无效');
    const saved = await readJson(fileFor(root, descriptor.taskKey));
    if (saved?.snapshot && saved.result?.sha256 === ref.sha256) return verify(saved.snapshot, descriptor, ref);
    if (descriptor.familyKey && descriptor.familyKey !== descriptor.taskKey) {
      const pin = await readJson(fileFor(root, descriptor.familyKey));
      if (pin?.snapshot && pin.result?.sha256 === ref.sha256) return verify(pin.snapshot, descriptor, ref);
    }
    const resultRoot = await mapping(descriptor.libraryId);
    if (!resultRoot) throw new HttpError(409, '共享结果目录未配置，已有本机修改保留');
    let bytes;
    try {
      const base = await realpath(resultRoot), path = await realpath(join(base, ref.path));
      if (!inside(base, path)) throw Error();
      bytes = await readFile(path, 'utf8');
    } catch { throw new HttpError(409, '共享结果暂时无法读取；不会自动重新分析，请恢复目录连接'); }
    let value; try { value = JSON.parse(bytes); } catch { throw new HttpError(409, '共享结果完整性校验失败'); }
    return verify(value, descriptor, ref);
  }
  async function prepare(root, source, { action, scope, data = null, contract = null, localOnly, newVersion = false } = {}) {
    const identity = await sourceIdentity(root, source);
    if (!identity) return null;
    if (identity.localOnly) return { mode: 'local-only', reason: '当前素材未关联共享素材库，本次分析仅保存在本机' };
    const sourceId = sharedHash(identity), range = scope ? { startMs: scope.startMs, endMs: scope.endMs } : null;
    const descriptor = { root, sourceId: source.id, libraryId: identity.libraryId, resultRoot: await mapping(identity.libraryId), sourceIdentity: sourceId, source: identity, action, scope: range, ...(scope ? { localScope: scope } : {}), dataHash: sharedHash(data), inputHash: sharedHash({ source: identity, action, scope: range, data, contract }), taskKey: sharedHash({ source: identity, action, scope: range }), contract };
    descriptor.catalog = { sourceIdentity: sourceId, action, scope: range, count: 0, provenance: { kind: 'shared-workflow-v1' } };
    descriptor.familyKey = descriptor.taskKey;
    if (localOnly) return { ...descriptor, mode: 'local-only', reason: localOnly };
    let saved = await readJson(fileFor(root, descriptor.familyKey));
    descriptor.coordinationId = await coordinatorFor(identity.libraryId, saved?.coordinationId ?? saved?.descriptor?.coordinationId);
    if (newVersion) {
      if (!saved?.snapshot || !saved.result) throw new HttpError(409, '请先读取并绑定已有共享版本，再明确生成新版');
      if (saved.snapshot.dataHash !== descriptor.dataHash) throw new HttpError(409, '本机转写或范围与共享底稿不同；人工修改不能发布为共享 AI 新版');
      descriptor.baseResultSha256 = saved.result.sha256;
      descriptor.taskKey = sharedHash([descriptor.familyKey, descriptor.inputHash, saved.result.sha256]);
      descriptor.newVersion = true;
      saved = await readJson(fileFor(root, descriptor.taskKey));
    } else if (saved?.snapshot) {
      descriptor.taskKey = saved.snapshot.taskKey;
    }
    if (saved?.outbox) return { ...descriptor, mode: 'publish-pending', status: 'submitted', reason: '分析已完成并保存在本机，补保存只上传结果文件，不会重新分析' };
    if (saved?.status === 'needs-review') return { ...descriptor, ...localReview };
    if (saved?.snapshot && saved.result) {
      const value = verify(saved.snapshot, descriptor, saved.result);
      if (value.dataHash !== descriptor.dataHash) return { ...descriptor, mode: 'local-only', reason: '当前转写与本机绑定的共享首版不同，新分析仅保存本机' };
      return { ...descriptor, coordinationId: saved.coordinationId ?? saved.descriptor.coordinationId, mode: 'reuse', status: 'complete', result: { ...saved.result, service: value.service }, reason: '复用工程已绑定的共享版本，不自动更新' };
    }
    const response = await coordinate('status', { taskKey: descriptor.taskKey, ...guardCoordinator(saved?.coordinationId ?? saved?.descriptor?.coordinationId ?? descriptor.coordinationId) });
    const task = response.task;
    descriptor.coordinationId = response.coordinationId ?? descriptor.coordinationId;
    if (!task) return { ...descriptor, mode: 'publish', status: 'idle' };
    if (task.status === 'needs-review') return { ...descriptor, ...localReview };
    if (task.status === 'complete') {
      const value = await artifact(root, descriptor, task.result);
      if (value.dataHash !== descriptor.dataHash) return { ...descriptor, mode: 'local-only', reason: '当前转写或范围与共享首版不同；新分析仅保存在本机，不覆盖共享结果' };
      return { ...descriptor, mode: 'reuse', status: 'complete', result: { ...task.result, service: value.service }, reason: '复用首次保存的共享 AI 结果；人工修改仍只保存在本机' };
    }
    const interrupted = saved && !active.has(descriptor.taskKey) && (saved.attemptId === task.attemptId || saved.status === 'claiming');
    const retry = ['uncertain', 'failed'].includes(task.status) || interrupted;
    return { ...descriptor, attemptId: task.attemptId, mode: retry ? 'retry-required' : 'busy', status: task.status, reason: retry ? '共享任务未完成，核查后才能明确重试，可能再次计费' : '已有同事正在处理，等待共享结果；不会再次提交请求' };
  }
  async function prepareExisting(root, source, artifact) {
    const identity = await sourceIdentity(root, source);
    if (!identity || identity.localOnly) throw new HttpError(409, '请先把此素材关联共享素材库并配置结果目录；没有重新分析');
    const sourceIdentityHash = sharedHash(identity), payloadHash = sharedHash(artifact.payload);
    const catalog = { sourceIdentity: sourceIdentityHash, action: artifact.action, scope: artifact.scope ?? null, count: artifact.count, provenance: artifact.provenance };
    const taskKey = sharedHash({ namespace: 'existing-ai-v1', sourceIdentity: sourceIdentityHash, action: artifact.action, scope: artifact.scope ?? null, payloadHash });
    const descriptor = { root, sourceId: source.id, libraryId: identity.libraryId, resultRoot: await mapping(identity.libraryId), sourceIdentity: sourceIdentityHash, source: identity, action: artifact.action, scope: artifact.scope ?? null, dataHash: payloadHash, inputHash: sharedHash({ payloadHash, catalog }), taskKey, familyKey: taskKey, contract: { kind: 'existing-ai-v1' }, catalog };
    const saved = await readJson(fileFor(root, taskKey));
    const response = await coordinate('status', { taskKey, ...guardCoordinator(await coordinatorFor(identity.libraryId, saved?.coordinationId)) });
    descriptor.coordinationId = response.coordinationId ?? saved?.coordinationId;
    if (saved?.outbox) return { ...descriptor, mode: 'publish-pending' };
    if (response.task?.status === 'complete') return { ...descriptor, mode: 'reuse', result: response.task.result };
    if (saved?.attemptId === response.task?.attemptId && saved?.descriptor?.inputHash === descriptor.inputHash && ['claimed', 'submitted'].includes(response.task?.status)) return { ...descriptor, mode: 'publish-resume', attemptId: saved.attemptId };
    if (saved?.status === 'claiming' && saved.clientAttemptId && saved.descriptor?.inputHash === descriptor.inputHash && response.task?.status === 'claimed') return { ...descriptor, mode: 'publish-resume', attemptId: response.task.attemptId };
    if (response.task) return { ...descriptor, mode: 'busy', reason: '共享保存尚未完成，请检查原发布记录；不会请求模型' };
    return { ...descriptor, mode: 'publish' };
  }
  async function resumeExisting(root, descriptor, payload) {
    if (descriptor.contract?.kind !== 'existing-ai-v1' || descriptor.mode !== 'publish-resume' || sharedHash(payload) !== descriptor.dataHash) throw new HttpError(409, '已有结果补保存身份不匹配');
    let saved = await readJson(fileFor(root, descriptor.taskKey));
    if (!saved?.attemptId && saved?.status === 'claiming' && saved.clientAttemptId && saved.descriptor?.inputHash === descriptor.inputHash) {
      const replay = await coordinate('claim', { taskKey: descriptor.taskKey, inputHash: descriptor.inputHash, clientAttemptId: saved.clientAttemptId, catalog: descriptor.catalog, ...guardCoordinator(descriptor.coordinationId) });
      if (!replay.acquired || replay.task.attemptId !== descriptor.attemptId) throw new HttpError(409, '原发布登记不能恢复为本机任务，未新增任务');
      saved = { ...saved, attemptId: replay.task.attemptId, status: 'claimed' }; await saveLocal(root, descriptor.taskKey, saved);
    }
    if (saved?.attemptId !== descriptor.attemptId || saved?.descriptor?.inputHash !== descriptor.inputHash) throw new HttpError(409, '已有结果发布记录已变化');
    const current = await coordinate('status', { taskKey: descriptor.taskKey, ...guardCoordinator(descriptor.coordinationId) });
    if (current.task?.attemptId !== descriptor.attemptId || !['claimed', 'submitted'].includes(current.task?.status)) throw new HttpError(409, '原发布任务已变化，请重新核对');
    if (current.task.status === 'claimed') await coordinate('submitted', { taskKey: descriptor.taskKey, attemptId: descriptor.attemptId, ...guardCoordinator(descriptor.coordinationId) });
    return complete(root, descriptor, descriptor.attemptId, payload);
  }
  async function history(root, source) {
    const identity = await sourceIdentity(root, source);
    if (!identity) throw new HttpError(409, '本机尚未启用共享分析，请在共享分析设置中启用后读取已有结果');
    if (identity.localOnly) throw new HttpError(409, '当前素材尚未关联共享素材库');
    const response = await coordinate('catalog', { sourceIdentity: sharedHash(identity), ...guardCoordinator(await coordinatorFor(identity.libraryId)) });
    return { results: response.results ?? [], source: identity, coordinationId: response.coordinationId };
  }
  async function historicalArtifact(root, source, taskKey, resultSha) {
    if (!hex.test(taskKey) || !hex.test(resultSha)) throw new HttpError(400, '历史结果标识无效');
    const fingerprint = async () => { const info = await stat(await resolveSource(root, source.assetPath)); return `${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}`; };
    const localSourceFingerprint = await fingerprint();
    const identity = await sourceIdentity(root, source);
    if (!identity) throw new HttpError(409, '本机尚未启用共享分析，请在共享分析设置中启用后读取已有结果');
    if (identity.localOnly) throw new HttpError(409, '当前素材尚未关联共享素材库');
    const saved = await readJson(fileFor(root, taskKey));
    await coordinatorFor(identity.libraryId, saved?.coordinationId ?? saved?.descriptor?.coordinationId);
    let result = saved?.result, descriptor = saved?.descriptor;
    if (!saved?.snapshot || result?.sha256 !== resultSha) {
      const catalog = await history(root, source), item = catalog.results.find(item => item.taskKey === taskKey && item.result?.sha256 === resultSha);
      if (!item) throw new HttpError(409, '找不到已完整保存且匹配此原片的历史结果');
      descriptor = { root, sourceId: source.id, libraryId: identity.libraryId, resultRoot: await mapping(identity.libraryId), sourceIdentity: sharedHash(identity), source: identity, action: item.catalog.action, scope: item.catalog.scope, taskKey, familyKey: taskKey, coordinationId: catalog.coordinationId, catalog: item.catalog };
      result = item.result;
    }
    if (descriptor.sourceIdentity !== sharedHash(identity)) throw new HttpError(409, '原片内容与历史结果不一致');
    const snapshot = await artifact(root, descriptor, result);
    if (await fingerprint() !== localSourceFingerprint) throw new HttpError(409, '原片在核对共享结果期间变化，未导入');
    return { descriptor: { ...descriptor, sourceId: source.id, dataHash: snapshot.dataHash, inputHash: snapshot.inputHash, contract: snapshot.contract }, snapshot, result, localSourceFingerprint };
  }
  async function pinHistorical(root, source, selection) {
    await validateSource(root, source, selection.descriptor);
    await saveLocal(root, selection.descriptor.taskKey, { sourceId: source.id, descriptor: selection.descriptor, coordinationId: selection.descriptor.coordinationId, result: selection.result, snapshot: selection.snapshot, status: 'complete' });
  }
  async function acquire(descriptor, { retryAcknowledged = false } = {}) {
    if (!descriptor || !['publish', 'retry-required'].includes(descriptor.mode)) throw new HttpError(409, descriptor?.reason || '当前共享任务不能提交');
    if (descriptor.mode === 'retry-required' && !retryAcknowledged) throw new HttpError(409, '请明确确认重试共享任务');
    descriptor.coordinationId = await coordinatorFor(descriptor.libraryId, descriptor.coordinationId);
    if (await mapping(descriptor.libraryId) !== descriptor.resultRoot) throw new HttpError(409, '共享结果目录已变化，未提交分析');
    await probeSharedResultWritable(descriptor.resultRoot);
    // A retry keeps the catalog and version association recorded by the original claim.
    const body = { taskKey: descriptor.taskKey, inputHash: descriptor.inputHash, clientAttemptId: randomUUID(), ...(descriptor.catalog && descriptor.mode === 'publish' ? { catalog: descriptor.catalog } : {}), ...(descriptor.newVersion && descriptor.mode === 'publish' ? { familyKey: descriptor.familyKey, baseResultSha256: descriptor.baseResultSha256 } : {}), ...guardCoordinator(descriptor.coordinationId) };
    await saveLocal(descriptor.root, descriptor.taskKey, { sourceId: descriptor.sourceId, descriptor, clientAttemptId: body.clientAttemptId, coordinationId: descriptor.coordinationId, status: 'claiming' });
    const response = await coordinate(descriptor.mode === 'retry-required' ? 'retry' : 'claim', { ...body, ...(descriptor.mode === 'retry-required' ? { expectedAttemptId: descriptor.attemptId, acknowledged: true } : {}) });
    if (!response.acquired) throw new HttpError(409, '此直播已有共享任务或结果，请刷新后复用，不会重复发送');
    const attemptId = response.task.attemptId, coordinationId = response.coordinationId ?? descriptor.coordinationId;
    descriptor.coordinationId = coordinationId;
    await saveLocal(descriptor.root, descriptor.taskKey, { sourceId: descriptor.sourceId, descriptor, attemptId, coordinationId, status: 'claimed' });
    const gate = await coordinate('submitted', { taskKey: descriptor.taskKey, attemptId, ...guardCoordinator(coordinationId) });
    if (!gate.sendAllowed) throw new HttpError(409, '请求已经登记提交，不会重复发送；请核查状态');
    await saveLocal(descriptor.root, descriptor.taskKey, { sourceId: descriptor.sourceId, descriptor, attemptId, coordinationId, status: 'submitted' });
    active.add(descriptor.taskKey);
    return { attemptId, coordinationId };
  }
  async function read(root, descriptor) {
    const task = descriptor.result ? { result: descriptor.result } : (await coordinate('status', { taskKey: descriptor.taskKey })).task;
    const snapshot = await artifact(root, descriptor, task?.result);
    if (snapshot.dataHash !== descriptor.dataHash) throw new HttpError(409, '共享结果的输入与当前转写或范围不一致');
    const previous = await readJson(fileFor(root, descriptor.taskKey));
    await saveLocal(root, descriptor.taskKey, { ...previous, sourceId: descriptor.sourceId, descriptor, result: task.result, snapshot, status: 'complete' });
    return snapshot;
  }
  async function publish(root, sourceId, taskKey) {
    const saved = await readJson(fileFor(root, taskKey));
    if (!saved?.outbox || saved.sourceId !== sourceId) throw new HttpError(409, '没有可补保存的本机 AI 结果');
    const { descriptor, outbox, result, attemptId, coordinationId } = saved;
    await coordinatorFor(descriptor.libraryId, coordinationId ?? descriptor.coordinationId);
    verify(outbox, descriptor, result);
    const resultRoot = await mapping(descriptor.libraryId);
    if (!resultRoot) throw new HttpError(409, '请先配置共享结果目录');
    if (resultRoot !== descriptor.resultRoot) throw new HttpError(409, '共享结果目录已变化，请恢复原目录后补保存；没有写入新目录');
    const path = join(resultRoot, result.path);
    try {
      // Check the coordinator before exposing any result bytes to a configured destination.
      const current = await coordinate('status', { taskKey, ...guardCoordinator(coordinationId) });
      if (current.task?.attemptId !== attemptId || !['submitted', 'uncertain', 'complete'].includes(current.task?.status)) throw Error('shared attempt changed');
      await mkdir(resultRoot, { recursive: true });
      const actualRoot = await realpath(resultRoot);
      let parent = actualRoot;
      for (const part of ['results', taskKey]) {
        const next = join(parent, part);
        const actual = await realpath(next).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
        if (actual && !inside(actualRoot, actual)) throw Error('unsafe result directory');
        if (!actual) await mkdir(next);
        parent = await realpath(next);
        if (!inside(actualRoot, parent)) throw Error('unsafe result directory');
      }
      const previous = await readFile(path, 'utf8').catch(e => { if (e.code === 'ENOENT') return null; throw e; });
      let matches = false;
      if (previous !== null) { try { matches = sharedHash(JSON.parse(previous)) === result.sha256; } catch { /* An incomplete unpublished file is repairable from the verified outbox. */ } }
      if (!matches) {
        // Complete central records are immutable. Only the original attempt may
        // repair an incomplete, unpublished file from its verified local outbox.
        if (current.task.status === 'complete') throw Error('immutable result conflict');
        await publishFile(path, `${JSON.stringify(outbox)}\n`);
      }
      if (sharedHash(JSON.parse(await readFile(path, 'utf8'))) !== result.sha256) throw Error('publication verification failed');
      await coordinate('complete', { taskKey, attemptId, result, ...guardCoordinator(coordinationId) });
    } catch { throw new HttpError(409, '共享保存未完成，结果已保存在本机；请明确补保存，不要重新分析'); }
    const next = { ...saved, snapshot: outbox, status: 'complete' }; delete next.outbox;
    await saveLocal(root, taskKey, next);
    active.delete(taskKey);
    return { mode: 'reuse', taskKey, status: 'complete', result };
  }
  async function complete(root, descriptor, attemptId, payload, service) {
    const outbox = { schema, taskKey: descriptor.taskKey, sourceIdentity: descriptor.sourceIdentity, source: descriptor.source, action: descriptor.action, scope: descriptor.scope, dataHash: descriptor.dataHash, inputHash: descriptor.inputHash, contract: descriptor.contract, ...(service ? { service } : {}), payload };
    const sha256 = sharedHash(outbox), result = { path: `results/${descriptor.taskKey}/${sha256}.json`, sha256, schema };
    await saveLocal(root, descriptor.taskKey, { sourceId: descriptor.sourceId, descriptor, attemptId, coordinationId: descriptor.coordinationId, status: 'publish-pending', result, outbox });
    return publish(root, descriptor.sourceId, descriptor.taskKey);
  }
  async function fail(descriptor, attemptId) {
    try {
      const saved = await readJson(fileFor(descriptor.root, descriptor.taskKey));
      if (saved && !saved.outbox) await saveLocal(descriptor.root, descriptor.taskKey, { ...saved, status: 'uncertain' });
      await coordinate('fail', { taskKey: descriptor.taskKey, attemptId, reason: 'unknown', ...guardCoordinator(descriptor.coordinationId) });
    } finally { active.delete(descriptor.taskKey); }
  }
  async function markReview(descriptor, attemptId) {
    try {
      const saved = await readJson(fileFor(descriptor.root, descriptor.taskKey));
      await saveLocal(descriptor.root, descriptor.taskKey, { ...saved, sourceId: descriptor.sourceId, descriptor, attemptId, status: 'needs-review' });
      await coordinate('fail', { taskKey: descriptor.taskKey, attemptId, reason: 'needs-review', ...guardCoordinator(descriptor.coordinationId) });
    } finally { active.delete(descriptor.taskKey); }
  }
  async function records(root, sourceId) {
    const dir = join(root, '.film', 'shared-analysis'), names = await readdir(dir).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
    return (await Promise.all(names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(async name => ({ key: name.slice(0, -5), value: await readJson(join(dir, name)) })))).filter(item => item.value?.sourceId === sourceId);
  }
  const versionView = (task, snapshot) => ({ taskKey: task.taskKey, sha256: task.result.sha256, sequence: task.sequence ?? 1, createdAt: task.createdAt ?? null, ...(snapshot?.service?.model ? { model: snapshot.service.model } : {}) });
  async function versions(root, sourceId) {
    const all = await records(root, sourceId), groups = []; let warning;
    for (const { key, value: saved } of all) {
      if (saved.descriptor?.contract?.kind === 'existing-ai-v1' || saved.snapshot?.contract?.kind === 'existing-ai-v1') continue;
      const familyKey = saved.descriptor.familyKey ?? key;
      if (key !== familyKey || !saved.snapshot || !saved.result) continue;
      const local = versionView({ taskKey: saved.snapshot.taskKey, result: saved.result, sequence: saved.sequence, createdAt: saved.createdAt }, saved.snapshot);
      let available;
      try { available = (await coordinate('versions', { taskKey: familyKey, ...guardCoordinator(saved.coordinationId ?? saved.descriptor.coordinationId) })).versions.map(task => versionView(task)); }
      catch { available = [local]; warning = '公司服务暂时不可用，当前工程继续使用已保存版本；未检查新版，也不会自动请求模型'; }
      const current = { ...(available.find(v => v.taskKey === local.taskKey) ?? local), ...(local.model ? { model: local.model } : {}) }, latest = available.at(-1) ?? current;
      groups.push({ action: saved.descriptor.action, ...(saved.descriptor.localScope ? { scope: saved.descriptor.localScope, productId: saved.descriptor.localScope.productId, intervalId: saved.descriptor.localScope.intervalId } : {}), familyKey, currentVersion: current, versions: available, latestVersion: latest, updateAvailable: latest.sha256 !== current.sha256, canCreateVersion: saved.descriptor.action !== 'transcription', ...(saved.pendingAdoption ? { needsReview: true, runId: saved.pendingAdoption.runId, reason: '新版建议待核对，当前工程仍固定旧版本' } : {}) });
    }
    return { groups, ...(warning ? { warning } : {}) };
  }
  async function adoption(root, sourceId, familyKey, taskKey, expectedCurrentSha) {
    const saved = await readJson(fileFor(root, familyKey));
    if (!saved?.snapshot || saved.sourceId !== sourceId || saved.result.sha256 !== expectedCurrentSha) throw new HttpError(409, '工程绑定版本已变化，请刷新后核对');
    const catalog = await coordinate('versions', { taskKey: familyKey, ...guardCoordinator(saved.coordinationId ?? saved.descriptor.coordinationId) });
    const task = catalog.versions.find(item => item.taskKey === taskKey);
    if (!task) throw new HttpError(409, '目标版本尚未完整发布或不属于此直播');
    const descriptor = { ...saved.descriptor, root, familyKey, taskKey, newVersion: false, result: task.result };
    const snapshot = await artifact(root, descriptor, task.result);
    return { descriptor, snapshot, currentSnapshot: saved.snapshot, result: task.result, sequence: task.sequence, createdAt: task.createdAt, expectedCurrentSha };
  }
  async function validateSource(root, source, descriptor) {
    const current = await sourceIdentity(root, source);
    if (!current || current.localOnly || sharedHash(current) !== descriptor.sourceIdentity) throw new HttpError(409, '原片身份已变化，旧直播的共享结果没有导入当前素材');
  }
  async function pendingAdoption(root, selection, runId) {
    const key = selection.descriptor.familyKey, saved = await readJson(fileFor(root, key));
    if (saved.result.sha256 !== selection.expectedCurrentSha) throw new HttpError(409, '工程绑定版本已变化');
    await saveLocal(root, key, { ...saved, pendingAdoption: { ...selection, runId } });
  }
  async function commitAdoption(root, selection) {
    const key = selection.descriptor.familyKey, saved = await readJson(fileFor(root, key));
    if (saved.result.sha256 !== selection.expectedCurrentSha) throw new HttpError(409, '工程绑定版本已变化；新版没有覆盖当前绑定');
    const previousVersions = [...(saved.previousVersions ?? []), { descriptor: saved.descriptor, result: saved.result, snapshot: saved.snapshot, sequence: saved.sequence, createdAt: saved.createdAt }];
    await saveLocal(root, key, { sourceId: saved.sourceId, coordinationId: saved.coordinationId, descriptor: selection.descriptor, result: selection.result, snapshot: selection.snapshot, sequence: selection.sequence, createdAt: selection.createdAt, previousVersions, status: 'complete' });
  }
  async function reconcileAdoptions(root, sourceId, applied, source) {
    for (const { value } of await records(root, sourceId)) {
      const pending = value.pendingAdoption;
      if (pending?.runId && applied.some(item => item.sourceId === sourceId && item.runId === pending.runId)) {
        try { await validateSource(root, source, pending.descriptor); } catch { continue; }
        await commitAdoption(root, pending);
      }
    }
  }
  async function pendingAdoptions(root, sourceId) {
    return (await records(root, sourceId)).map(item => item.value.pendingAdoption).filter(Boolean);
  }
  async function recoverable(root, descriptor) {
    const saved = await readJson(fileFor(root, descriptor.taskKey));
    return !!(saved?.attemptId && !saved.outbox && ['submitted', 'uncertain'].includes(saved.status) && saved.descriptor.inputHash === descriptor.inputHash && saved.descriptor.dataHash === descriptor.dataHash && saved.attemptId === descriptor.attemptId);
  }
  async function recover(root, descriptor, payload, service) {
    if (!await recoverable(root, descriptor)) throw new HttpError(409, '已完成本机缓存无法关联原共享提交，未重新请求模型');
    const saved = await readJson(fileFor(root, descriptor.taskKey));
    descriptor.coordinationId = saved.coordinationId ?? saved.descriptor.coordinationId;
    const current = await coordinate('status', { taskKey: descriptor.taskKey, ...guardCoordinator(descriptor.coordinationId) });
    if (current.task?.attemptId !== saved.attemptId || !['submitted', 'uncertain'].includes(current.task.status)) throw new HttpError(409, '原共享任务已变化，不能补保存到其他任务');
    return complete(root, descriptor, saved.attemptId, payload, service);
  }
  async function status(root, sourceId) {
    const dir = join(root, '.film', 'shared-analysis'), names = await readdir(dir).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
    const saved = (await Promise.all(names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => readJson(join(dir, name))))).filter(item => item?.sourceId === sourceId && item.descriptor?.contract?.kind !== 'existing-ai-v1' && item.snapshot?.contract?.kind !== 'existing-ai-v1');
    const review = saved.find(item => item.status === 'needs-review');
    if (review) return { ...localReview, taskKey: review.descriptor.taskKey, action: 'transcription' };
    const pending = saved.find(item => item.outbox) ?? saved.find(item => ['claiming', 'claimed', 'submitted', 'uncertain'].includes(item.status));
    return pending ? { mode: pending.outbox ? 'publish-pending' : pending.status === 'uncertain' || !active.has(pending.descriptor.taskKey) ? 'retry-required' : 'busy', taskKey: pending.descriptor.taskKey, action: pending.descriptor.action, ...(pending.descriptor.newVersion ? { newVersion: true } : {}), ...(pending.descriptor.localScope ? { scope: pending.descriptor.localScope } : {}), status: pending.status, reason: pending.outbox ? '结果已在本机，补保存不会重新分析' : '共享任务未完成，请核查记录；不会自动重发请求' } : undefined;
  }
  return { prepare, prepareExisting, resumeExisting, history, historicalArtifact, pinHistorical, acquire, read, complete, publish, fail, markReview, status, versions, adoption, validateSource, pendingAdoption, pendingAdoptions, commitAdoption, reconcileAdoptions, recoverable, recover };
}
