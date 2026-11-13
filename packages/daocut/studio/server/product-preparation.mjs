import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { writeAtomic } from './atomic.mjs';
import { HttpError, json, readJson } from './http.mjs';
import { readProductAnalysis } from './product-analysis.mjs';

const fileFor = (root, id) => join(root, '.film', 'product-preparation', `${createHash('sha256').update(id).digest('hex')}.json`);

export async function readProductPreparationState(root, sourceId) {
  try { return JSON.parse(await readFile(fileFor(root, sourceId), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new HttpError(409, '素材准备状态无法读取，未覆盖已有记录'); }
}
export async function writeProductPreparationState(root, state) {
  const file = fileFor(root, state.sourceId);
  await mkdir(dirname(file), { recursive: true });
  await writeAtomic(file, `${JSON.stringify(state)}\n`);
}

// A name-only import placeholder is not a reviewed product split. Everything
// else must stay intact until the existing difference/replacement flow is used.
export function hasSavedProductResult(analysis, sourceId) {
  return analysis.intervals.some(item => item.sourceId === sourceId)
    || (analysis.unassigned ?? []).some(item => item.sourceId === sourceId)
    || (analysis.manualEdits ?? []).some(item => item.sourceIds.includes(sourceId))
    || analysis.products.some(item => item.sourceIds.includes(sourceId) && (item.origin || item.discoveryRunId || item.evidence?.length || item.aliases?.length || item.review?.length))
    || [...analysis.candidates, ...(analysis.scopes ?? []), ...(analysis.archivedCandidates ?? [])].some(item => item.sourceId === sourceId)
    || (analysis.discoveryApplied ?? []).some(item => item.sourceId === sourceId);
}

/** One explicitly confirmed material preparation, using existing task ledgers.
 * GET, reopening a project and switching products never start this workflow.
 * The caller cannot inject clients or opt into a disabled real service.
 */
export function createProductPreparation({ liveAnalysis, discovery }) {
  const starting = new Map(), running = new Map();
  async function load(root, sourceId) {
    try {
      const state = JSON.parse(await readFile(fileFor(root, sourceId), 'utf8'));
      if (state.version !== 1 || state.sourceId !== sourceId || !['running', 'complete', 'failed'].includes(state.status)) throw Error();
      return state;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new HttpError(409, '素材准备状态无法读取，未覆盖已有记录');
    }
  }
  async function save(root, state) {
    const file = fileFor(root, state.sourceId);
    await mkdir(dirname(file), { recursive: true });
    await writeAtomic(file, `${JSON.stringify(state)}\n`);
  }
  async function view(root, sourceId) {
    if (typeof sourceId !== 'string' || !sourceId) throw new HttpError(400, '请选择来源');
    const { analysis } = await readProductAnalysis(root);
    if (!analysis.sources.some(source => source.id === sourceId)) throw new HttpError(404, '来源不存在');
    const [state, live, split, available] = await Promise.all([
      load(root, sourceId), liveAnalysis.view(root, sourceId), discovery.view(root, sourceId), discovery.available(),
    ]);
    const key = `${root}\0${sourceId}`;
    const interrupted = state?.status === 'running' && !running.has(key);
    const needsTranscription = live.transcription.status !== 'complete';
    const ready = analysis.intervals.some(item => item.sourceId === sourceId);
    const needsReview = !ready && hasSavedProductResult(analysis, sourceId);
    const savedProposal = split.status === 'complete' && split.stale === false;
    const existingFailure = live.transcription.status === 'failed' || split.status === 'failed';
    const status = ready ? 'complete' : needsReview ? 'idle' : interrupted ? 'failed'
      : state?.status === 'running' ? 'running' : state?.status === 'failed' || existingFailure ? 'failed' : 'idle';
    return {
      sourceId, status, phase: ready ? 'ready' : needsReview ? 'apply' : state?.phase === 'ready' ? 'discovery' : state?.phase ?? (needsTranscription ? 'transcription' : 'discovery'),
      enabled: !needsReview && (ready || (savedProposal || available) && (!needsTranscription || liveAnalysis.canTranscribe)),
      needsReview,
      needsTranscription, canRetry: status === 'failed',
      retryUncertainRequired: needsTranscription && live.transcription.status === 'failed' && live.transcription.retryBlocked !== false,
      ...(state?.id ? { runId: state.id } : {}),
      ...(needsReview ? { error: '已有人工修改或待归属内容，但尚无商品段；请在拆品记录中核对后处理' }
        : status === 'failed' ? { error: interrupted ? '素材准备已中断；核查后显式重试，已完成结果会复用' : state?.error || live.transcription.error || split.error } : {}),
      transcription: { status: live.transcription.status, error: live.transcription.error, retryBlocked: live.transcription.retryBlocked },
      discovery: split,
    };
  }
  async function startInner(root, sourceId, body) {
    const before = await view(root, sourceId);
    if (before.status === 'complete') return before;
    if (before.needsReview) throw new HttpError(409, before.error);
    if (!before.enabled) throw new HttpError(403, '素材准备服务未启用或缺少配置，未发送音频或转写');
    if (before.status === 'failed' && body.retry !== true) throw new HttpError(409, '上次素材准备未完成，请核查后显式重试');
    if (before.retryUncertainRequired && body.retryUncertain !== true) throw new HttpError(409, '转写提交状态不确定，请核查服务记录后明确重试');
    // Do not attach a new workflow to an unrelated task that was started by a
    // different action. Its caller has not authorized the next paid stage.
    if (before.transcription.status === 'running' || before.discovery.status === 'running') throw new HttpError(409, '此来源已有任务，请等待完成后再准备素材');
    if (before.discovery.status === 'failed' && body.retry !== true) throw new HttpError(409, '已有拆品任务未完成，请核查后显式重试');
    const key = `${root}\0${sourceId}`;
    const state = { version: 1, id: randomUUID(), sourceId, createdAt: new Date().toISOString(), status: 'running', phase: before.needsTranscription ? 'transcription' : 'discovery' };
    await save(root, state);
    const completion = (async () => {
      try {
        if (before.needsTranscription) {
          await liveAnalysis.startTranscription(root, sourceId, body.retryUncertain === true);
          await liveAnalysis.wait(root, sourceId);
          const live = await liveAnalysis.view(root, sourceId);
          if (live.transcription.status !== 'complete') throw new HttpError(409, live.transcription.error || '转写未完成，自动拆品未启动');
        }
        const latest = (await readProductAnalysis(root)).analysis;
        if (hasSavedProductResult(latest, sourceId)) throw new HttpError(409, '已有商品范围或人工修正，自动拆品已停止');
        state.phase = 'discovery'; await save(root, state);
        const existing = await discovery.view(root, sourceId);
        // A completed proposal can be applied locally even when the model is
        // disabled. It is never silently regenerated after an input change.
        if (existing.status !== 'complete' || existing.stale !== false) {
          await discovery.start(root, { sourceId, retry: body.retry === true && existing.status === 'failed' });
          await discovery.wait(root, sourceId);
        }
        const split = await discovery.view(root, sourceId);
        if (split.status !== 'complete' || split.stale !== false || !split.proposal) throw new HttpError(409, split.error || '拆品未完成，已有结果保留');
        const expected = (await readProductAnalysis(root)).analysis;
        if (hasSavedProductResult(expected, sourceId)) throw new HttpError(409, '已有商品范围或人工修正，新切点待核对');
        state.phase = 'apply'; await save(root, state);
        await discovery.apply(root, { sourceId, runId: split.runId, expected, replaceReviewed: false });
        state.status = 'complete'; state.phase = 'ready';
      } catch (error) {
        state.status = 'failed';
        state.error = error instanceof HttpError ? error.message : '素材准备未完成；已完成结果保留，核查后可显式重试';
      }
      state.finishedAt = new Date().toISOString();
      try { await save(root, state); } finally { running.delete(key); }
    })().catch(() => running.delete(key));
    running.set(key, { identity: JSON.stringify([body.retry === true, body.retryUncertain === true]), promise: completion });
    return view(root, sourceId);
  }
  function start(root, body) {
    const sourceId = body.sourceId, key = `${root}\0${sourceId}`;
    const identity = JSON.stringify([body.retry === true, body.retryUncertain === true]);
    const pending = starting.get(key);
    if (pending) {
      if (pending.identity !== identity) throw new HttpError(409, '此来源已有不同的素材准备请求');
      return pending.promise;
    }
    const active = running.get(key);
    if (active) {
      if (active.identity !== identity) throw new HttpError(409, '此来源已有不同的素材准备请求');
      return view(root, sourceId);
    }
    const promise = startInner(root, sourceId, body).finally(() => starting.delete(key));
    starting.set(key, { identity, promise });
    return promise;
  }
  const route = async function route(req, res, root, rest) {
    if (rest !== 'product-preparation') return false;
    if (req.method === 'GET') {
      json(res, 200, await view(root, new URL(req.url, 'http://localhost').searchParams.get('sourceId'))); return true;
    }
    if (req.method === 'POST') {
      const body = await readJson(req);
      if (body?.confirmed !== true || typeof body.sourceId !== 'string' || !body.sourceId) throw new HttpError(400, '请先确认素材准备及服务请求');
      json(res, 200, await start(root, body)); return true;
    }
    return false;
  };
  return Object.assign(route, {
    busy: root => [...starting.keys(), ...running.keys()].some(key => key.startsWith(`${root}\0`)),
    wait: async (root, sourceId) => { const key = `${root}\0${sourceId}`; await starting.get(key)?.promise; await running.get(key)?.promise; },
  });
}
