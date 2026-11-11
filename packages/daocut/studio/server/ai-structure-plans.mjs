import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeAtomic } from './atomic.mjs';
import { sharedHash } from './shared-analysis.mjs';
import { HttpError } from './http.mjs';
import { createStructurePlanInputReader, localize } from './structure-plans.mjs';
import { inspectAiCompositionInput } from './structure-composition.mjs';
import { inspectAiRangeInput } from './ai-structure-ranges.mjs';
import { recoverDeepSeekTextResponse } from './text-structure.mjs';
import { AI_STRUCTURE_VERSION, AI_STRUCTURE_PROMPT, PREVIOUS_AI_STRUCTURE_VERSION, PREVIOUS_AI_STRUCTURE_PROMPT, createAiStructureRequest, validateAiStructureResponse } from './ai-structure.mjs';

const directory = root => join(root, '.film', 'ai-structure-plans');
const read = async file => { try { return JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw new HttpError(409, 'AI 方案记录无法读取，原记录保留'); } };
const save = async (root, key, data) => { await mkdir(directory(root), { recursive: true }); await writeAtomic(join(directory(root), `${key}.json`), JSON.stringify(data)); };
const publicModel = m => m ? { model: typeof m === 'string' ? m : m.model, provider: m.provider, endpoint: m.endpoint } : null;
const errorIssue = message => ({ code: 'AI_STRUCTURE_FAILED', message });

/** One explicitly confirmed AI request per round. Reuse/recovery never sends it again. */
export function createAiStructurePlans({ readInput = createStructurePlanInputReader(), modelClient, modelIdentity, sharedAnalysis, saveRecord = save } = {}) {
  const starts = new Map(), jobs = new Map(), storageErrors = new Map();
  const persist = saveRecord;
  const identity = async () => typeof modelIdentity === 'function' ? modelIdentity() : modelIdentity ?? await modelClient?.getCacheIdentity?.();
  const lockKey = (root, request) => JSON.stringify([root, request.sourceId, request.productId, request.intervalId]);
  async function versionedMaterial(root, input, version) {
    const legacy = version === PREVIOUS_AI_STRUCTURE_VERSION;
    const inspected = input.engineInput && (legacy ? inspectAiCompositionInput : inspectAiRangeInput)(input.engineInput);
    const issues = [...(input.issues ?? []), ...(inspected?.issues ?? [])];
    const blocked = !['local', 'shared'].includes(input.visibility) || !inspected?.ready;
    const key = sharedHash({ kind: version, prompt: legacy ? PREVIOUS_AI_STRUCTURE_PROMPT : AI_STRUCTURE_PROMPT, analysis: input.analysisVersion,
      semantic: input.semanticVersion, input: inspected?.inputHash, visibility: input.visibility });
    let saved = null, readError;
    try {
      saved = blocked ? null : await read(join(directory(root), `${key}.json`));
      if (saved && (saved.version !== version || saved.key !== key || saved.sourceId !== input.source.id)) throw new HttpError(409, 'AI 方案身份不匹配，未覆盖旧记录');
    } catch (error) { saved = null; readError = error.message; }
    return { root, input, inspected, issues, blocked, key, version, saved, readError };
  }
  async function material(root, request) {
    if (request.rulesVersion !== undefined && ![AI_STRUCTURE_VERSION, PREVIOUS_AI_STRUCTURE_VERSION].includes(request.rulesVersion)) throw new HttpError(409, '拼结构规则版本无效，未生成或替换已有结果');
    const input = await readInput(root, request);
    const current = await versionedMaterial(root, input, AI_STRUCTURE_VERSION);
    const legacy = await versionedMaterial(root, input, PREVIOUS_AI_STRUCTURE_VERSION);
    const versions = [legacy, current];
    const keyed = request.taskKey === undefined ? null : versions.find(item => item.key === request.taskKey);
    if (request.taskKey !== undefined && (!keyed || request.rulesVersion !== undefined && request.rulesVersion !== keyed.version)) throw new HttpError(409, '方案标识不属于当前讲解和规则版本，请重新读取；未使用其他输入的结果');
    const explicit = keyed ?? versions.find(item => item.version === request.rulesVersion);
    const selected = explicit ?? (current.saved || current.readError ? current : legacy.saved || legacy.readError ? legacy : current);
    const attach = m => ({ ...m, versions });
    const blockedUpgrade = (message, status = legacy.saved?.rounds?.at(-1)?.status ?? 'unknown') => ({ ...attach(current), blocked: true,
      blockedBy: { version: legacy.version, taskKey: legacy.key, status },
      issues: [...current.issues, { code: 'AI_STRUCTURE_LEGACY_UNAVAILABLE', message: `${message}；请先恢复或补存已有结果，未发起新版模型请求` }] });
    const absentLegacy = () => ({ ...attach(legacy), blocked: true, issues: [...legacy.issues, { code: 'AI_STRUCTURE_LEGACY_READ_ONLY', message: '没有已保存的旧版方案；旧版仅供查看、恢复及已有轮次续跑，新建请使用当前规则' }] });
    // Listing another version never changes its bytes, and an unreadable unrelated
    // historical record must not hide a saved current result or its recovery.
    if (selected.readError) return { ...attach(selected), blocked: true, issues: [...selected.issues, errorIssue(selected.readError)] };
    if (selected.saved || selected.blocked) return attach(selected);
    if (explicit === current && input.visibility === 'shared') {
      // Reusing a colleague's v2 is not a new paid upgrade, even if old recovery is pending.
      try {
        current.prepared = await nextRound(current);
        if (current.prepared.descriptor?.mode !== 'publish') { current.publicExists = true; return attach(current); }
      } catch (error) { return { ...attach(current), blocked: true, issues: [...current.issues, errorIssue(error.message)] }; }
    }
    if (selected === current && legacy.readError) return blockedUpgrade(`旧方案结果无法读取：${legacy.readError}`);
    if (selected === current && legacy.saved) {
      const last = legacy.saved.rounds?.at(-1);
      if (last?.status !== 'complete' || !last.result) return blockedUpgrade('旧拼结构任务未完成，结果或费用状态仍不明确');
      return attach(current);
    }
    // A colleague may have no local record. Read the exact old public identity
    // before offering a paid upgrade; preparing does not claim or send a request.
    if (input.visibility === 'shared' && !legacy.blocked) {
      try {
        legacy.prepared = await nextRound(legacy);
        if (legacy.prepared.descriptor?.mode !== 'publish') {
          legacy.publicExists = true;
          if (explicit !== current) return attach(legacy);
          if (legacy.prepared.descriptor?.mode !== 'reuse') return blockedUpgrade('旧公共任务已有提交但尚未完整保存', legacy.prepared.descriptor.status ?? legacy.prepared.descriptor.mode);
          // Verify the completed prior result, without creating or rewriting its AI record.
          await publicResult(legacy, legacy.prepared);
        }
      } catch (error) {
        return explicit === legacy
          ? { ...attach(legacy), blocked: true, issues: [...legacy.issues, errorIssue(`旧公共方案状态无法核查：${error.message}`)] }
          : blockedUpgrade(`旧公共方案状态无法核查：${error.message}`);
      }
    }
    return explicit === legacy ? absentLegacy() : attach(current);
  }
  const allPlans = saved => (saved?.rounds ?? []).flatMap(r => r.result?.plans ?? []);
  const previous = saved => (saved?.rounds ?? []).flatMap(r => r.result?.sequences ?? []);
  async function nextRound(m) {
    if (m.prepared) return m.prepared;
    const request = createAiStructureRequest(m.input, { previous: previous(m.saved), version: m.version });
    let descriptor;
    if (m.input.visibility === 'shared') {
      if (!sharedAnalysis) throw new HttpError(409, '共享协调服务未接通，未发起本机付费请求');
      await sharedAnalysis.validateSource(m.root, m.input.source, m.input.baselineDescriptor);
      descriptor = await sharedAnalysis.prepareExisting(m.root, m.input.source, { action: 'structure-plans', scope: { startMs: m.input.scope.startMs, endMs: m.input.scope.endMs }, count: 0,
        provenance: { kind: 'structure-plans-v1', inputRevision: m.input.analysisVersion }, payload: { kind: m.version, key: m.key, requestHash: sharedHash(request) } });
    }
    return { request, descriptor };
  }
  function view(m, status, extra = {}) {
    const rounds = m.saved?.rounds ?? [], last = rounds.at(-1);
    const plans = [...new Map(allPlans(m.saved).map(p => [p.id, p])).values()];
    const savedVersions = [...new Map([...(m.versions ?? []).filter(item => item.saved || item.readError || item.publicExists), ...(m.saved ? [m] : [])].map(item => [item.version, { version: item.version, taskKey: item.key }])).values()];
    return { status, taskKey: m.key, version: m.version, currentRulesVersion: AI_STRUCTURE_VERSION, savedVersions, ...(m.blockedBy ? { blockedBy: m.blockedBy } : {}), generationMethod: 'ai', plans: localize(plans, m.input), complete: status === 'complete', allValidCombinationsEnumerated: false,
      materialComplete: m.inspected?.materialComplete === true, context: { ...m.input.context, visibility: m.input.visibility },
      issues: [...m.issues, ...rounds.flatMap(r => r.result?.issues ?? []), ...(last?.error ? [errorIssue(last.error)] : [])],
      canContinue: status === 'complete' && last?.result?.modelComplete === false,
      recoverable: status === 'failed' && !!(last?.response || last?.receipt?.status === 'completed'),
      requestCount: rounds.filter(r => r.submitted).length, mediaReview: m.input.mediaReview, mediaReviewOrigin: m.input.mediaReviewOrigin,
      visualReview: m.input.visualReview, visualReviewOrigin: m.input.visualReviewOrigin, visualReviewStale: m.input.visualReviewStale, ...extra };
  }
  async function publicResult(m, prepared) {
    const snapshot = await sharedAnalysis.read(m.root, prepared.descriptor), value = snapshot.payload;
    if (value?.schema !== m.version || value.requestHash !== sharedHash(prepared.request)) throw new HttpError(409, '公共 AI 方案输入不匹配，未重新生成');
    const result = validateAiStructureResponse(m.input, value.response, { expectedVersion: m.version });
    return { response: value.response, result };
  }
  async function imported(m, prepared) {
    const { response, result } = await publicResult(m, prepared);
    m.saved ??= { version: m.version, key: m.key, sourceId: m.input.source.id, rounds: [] };
    m.saved.rounds.push({ status: 'complete', request: prepared.request, descriptor: prepared.descriptor, response, result });
    await persist(m.root, m.key, m.saved);
  }
  async function reuse(m, prepared) {
    const fallback = m.saved?.rounds.length ? 'complete' : 'unavailable';
    try { await imported(m, prepared); return view(m, 'complete'); }
    catch (error) { return view(m, fallback, { issues: [...m.issues, errorIssue(`已有公共方案无法读取或补存：${error.message}；原记录保留，未重新请求模型`)] }); }
  }
  async function confirmation(m, prepared, model = undefined) {
    model ??= await identity();
    if (!model || typeof modelClient !== 'function') return { enabled: false, rulesVersion: m.version, message: '请先配置拼结构使用的文字模型；已有分析和草稿保留' };
    return { enabled: true, id: sharedHash({ key: m.key, request: prepared.request, model }), rulesVersion: m.version, service: publicModel(model), requestCount: 1,
      candidateCount: m.input.engineInput.candidates.length, transcriptSegments: m.input.engineInput.cues.length,
      continuation: !!m.saved?.rounds.length, visibility: m.input.visibility };
  }
  async function status(root, request) {
    const m = await material(root, request);
    if (m.blocked) return view(m, 'unavailable');
    const last = m.saved?.rounds.at(-1);
    if (m.saved && (!last || last.status === 'complete' && !last.result)) return view(m, 'failed', { issues: [...m.issues, errorIssue('已有方案记录缺少完整请求或结果，状态不明；请恢复或核对原记录，不会重新发送')] });
    if (last && last.status !== 'complete') return view(m, last.status === 'running' && !jobs.has(lockKey(root, request)) || !['running', 'failed', 'publish-pending'].includes(last.status) ? 'failed' : last.status,
      last.status === 'running' && !jobs.has(lockKey(root, request)) ? { issues: [...m.issues, errorIssue(storageErrors.get(lockKey(root, request)) ?? '上次拼结构中断，结果或费用尚不明确；请恢复保存的返回，不会自动重发')] } : {});
    if (last?.result.modelComplete) return view(m, 'complete');
    if (jobs.has(lockKey(root, request))) return view(m, 'busy', { issues: [...m.issues, errorIssue('当前这次讲解已有拼结构请求执行中，请等待已有任务完成，未启动另一个版本')] });
    let prepared;
    try { prepared = await nextRound(m); } catch (e) { return view(m, last ? 'complete' : 'unavailable', { issues: [...m.issues, errorIssue(e.message)] }); }
    if (prepared.descriptor?.mode === 'reuse') return reuse(m, prepared);
    if (prepared.descriptor && prepared.descriptor.mode !== 'publish') return view(m, last ? 'complete' : 'busy', { issues: [...m.issues, errorIssue('此公共任务已有提交，请等待或恢复已有结果；未重复请求')] });
    return view(m, last ? 'complete' : 'idle', { confirmation: await confirmation(m, prepared) });
  }
  async function finish(m, round, response) {
    round.response = response; await persist(m.root, m.key, m.saved);
    round.result = validateAiStructureResponse(m.input, response, { expectedVersion: m.version });
    round.status = m.input.visibility === 'shared' ? 'publish-pending' : 'complete'; delete round.error;
    await persist(m.root, m.key, m.saved);
    if (round.status === 'publish-pending') {
      await sharedAnalysis.complete(m.root, round.descriptor, round.attemptId, { schema: m.version, requestHash: sharedHash(round.request), response });
      round.status = 'complete'; await persist(m.root, m.key, m.saved);
    }
  }
  async function generateOne(root, request) {
    const m = await material(root, request);
    if (m.blocked) return view(m, 'unavailable');
    if (jobs.has(lockKey(root, request))) return view(m, 'busy', { issues: [...m.issues, errorIssue('当前这次讲解已有拼结构请求执行中，请等待已有任务完成，未启动另一个版本')] });
    const last = m.saved?.rounds.at(-1);
    if (m.saved && (!last || !last.result || last.status !== 'complete' || last.result.modelComplete || request.continue !== true)) return status(root, request);
    const prepared = await nextRound(m);
    if (prepared.descriptor?.mode === 'reuse') return reuse(m, prepared);
    if (prepared.descriptor && prepared.descriptor.mode !== 'publish') return view(m, 'busy');
    const model = await identity(), plan = await confirmation(m, prepared, model);
    if (!plan.enabled || request.confirmed !== true || request.confirmationId !== plan.id) throw new HttpError(409, '请确认本次 AI 拼结构请求；素材、范围或模型可能已变化，未发送');
    let claim;
    if (prepared.descriptor) claim = await sharedAnalysis.acquire(prepared.descriptor);
    m.saved ??= { version: m.version, key: m.key, sourceId: m.input.source.id, rounds: [] };
    const round = { status: 'running', request: prepared.request, descriptor: prepared.descriptor, attemptId: claim?.attemptId, model, submitted: true };
    m.saved.rounds.push(round); await persist(root, m.key, m.saved);
    const key = lockKey(root, request);
    const job = Promise.resolve().then(async () => {
      try {
        const response = await modelClient({ ...round.request, expectedIdentity: model,
          onReceipt: async receipt => { round.receipt = receipt; await persist(root, m.key, m.saved); } });
        await finish(m, round, response);
      } catch (e) {
        if (round.status !== 'publish-pending') {
          round.status = 'failed'; round.error = `AI 拼结构未完成：${e.message}；已有分析和原返回保留，不会自动重发`;
          if (round.descriptor) await sharedAnalysis?.fail?.(round.descriptor, round.attemptId).catch(() => {});
        } else round.error = `公共保存未完成：${e.message}；本机 AI 返回已保留，请补存`;
        await persist(root, m.key, m.saved);
      }
    }).catch(error => { storageErrors.set(key, `AI 请求后的记录保存失败：${error.message}；请恢复已保存返回，不会重发模型`); }).finally(() => jobs.delete(key));
    jobs.set(key, job);
    return view(m, 'running');
  }
  function generate(root, request) {
    const key = lockKey(root, request);
    const selector = JSON.stringify([request.rulesVersion ?? null, request.taskKey ?? null, request.continue === true]);
    const starting = starts.get(key);
    if (starting) return starting.selector === selector ? starting.pending : starting.pending.then(() => generate(root, request), () => generate(root, request));
    const pending = generateOne(root, request).finally(() => starts.delete(key)); starts.set(key, { selector, pending }); return pending;
  }
  async function recover(root, request) {
    const m = await material(root, request), round = m.saved?.rounds.at(-1);
    if (!round || m.blocked || jobs.has(lockKey(root, request)) || round.status === 'complete') return status(root, request);
    try {
      const response = round.response ?? recoverDeepSeekTextResponse(round.receipt, round.request);
      if (response === undefined) return view(m, 'failed', { issues: [...m.issues, errorIssue('没有完整且匹配输入的已保存返回，请核查请求记录；不会重发模型')] });
      await finish(m, round, response);
      storageErrors.delete(lockKey(root, request));
    } catch (e) { round.error = e.message; await persist(root, m.key, m.saved); }
    return view(m, round.status === 'running' ? 'failed' : round.status);
  }
  async function publish(root, request) {
    if (request.confirmed !== true || !/^[a-f0-9]{64}$/.test(request.taskKey ?? '')) throw new HttpError(400, '请确认补存已有 AI 方案');
    const saved = await read(join(directory(root), `${request.taskKey}.json`)), round = saved?.rounds.at(-1);
    if (saved?.sourceId !== request.sourceId || ![AI_STRUCTURE_VERSION, PREVIOUS_AI_STRUCTURE_VERSION].includes(saved?.version) || round?.status !== 'publish-pending' || !round.descriptor) throw new HttpError(409, '没有可补保存的公共 AI 方案');
    await sharedAnalysis.complete(root, round.descriptor, round.attemptId, { schema: saved.version, requestHash: sharedHash(round.request), response: round.response });
    round.status = 'complete'; delete round.error; await persist(root, saved.key, saved);
    return { status: 'complete', taskKey: saved.key, requestCount: 0 };
  }
  return { status, generate, recover, publish, wait: async () => { await Promise.all([...starts.values()].map(item => item.pending)); await Promise.all([...jobs.values()]); } };
}
