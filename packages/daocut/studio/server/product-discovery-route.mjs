import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { writeAtomic } from './atomic.mjs';
import { probe } from './derived.mjs';
import { HttpError, json, readJson } from './http.mjs';
import { readProductAnalysis, recordProductEdit, updateProductAnalysis, validateProductAnalysis } from './product-analysis.mjs';
import { productSourcePath, readProductTranscript } from './product-transcription.mjs';
import { DISCOVERY_PROMPT, PREVIOUS_DISCOVERY_PROMPT, DISCOVERY_VERSION, discoverProducts, discoveryWindows, validateDiscoveryCues } from './product-discovery.mjs';
import { textResultCacheIdentity } from './text-structure.mjs';

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const pathFor = (root, sourceId) => join(root, '.film', 'product-discovery', `${hash(sourceId)}.json`);
const effectiveHash = analysis => hash({ sources: analysis.sources, products: analysis.products, intervals: analysis.intervals, scopes: analysis.scopes ?? [], unassigned: analysis.unassigned ?? [] });
const currentFor = (analysis, sourceId) => ({ products: analysis.products.filter(p => p.sourceIds.includes(sourceId)), intervals: analysis.intervals.filter(i => i.sourceId === sourceId) });
const hasLocalResults = (analysis, sourceId) => analysis.intervals.some(i => i.sourceId === sourceId) || (analysis.manualEdits ?? []).some(edit => edit.action === 'manual-save' && edit.sourceIds.includes(sourceId));
// Reuse completed, known older judgments without pretending that a new paid
// request uses the same rules. Incomplete windows never cross prompt versions.
const savedInputMatches = (run, input) => Boolean(run && run.inputHash === input.inputHash && (run.sharedRef || (input.contractHash && (run.contractHash === input.contractHash || (run.status === 'complete' && run.contractHash === input.previousContractHash)))));

export function discoveryDifference(analysis, proposal) {
  const before = currentFor(analysis, proposal.sourceId);
  const compare = (old, next, fields) => ({ added: next.filter(item => !old.some(p => p.id === item.id)).length, removed: old.filter(item => !next.some(p => p.id === item.id)).length, changed: next.filter(item => old.some(p => p.id === item.id && fields.some(key => p[key] !== item[key]))).length });
  const products = compare(before.products, proposal.products, ['name']), intervals = compare(before.intervals, proposal.intervals, ['productId', 'startMs', 'endMs']);
  return { addedProducts: products.added, removedProducts: products.removed, renamedProducts: products.changed, addedIntervals: intervals.added, removedIntervals: intervals.removed, changedIntervals: intervals.changed, manualEdits: (analysis.manualEdits ?? []).some(edit => edit.action === 'manual-save' && edit.sourceIds.includes(proposal.sourceId)) };
}

// Callbacks are trusted startup dependencies. The HTTP client cannot enable a real service.
export function createProductDiscovery({ modelClient, modelIdentity, readTranscript = readProductTranscript, probeSource = probe, maxBytes = 24000, contextCues = 3 } = {}) {
  const running = new Map(), starting = new Map(), applying = new Set(), completions = new Map();
  async function publicConfiguration() {
    try {
      const configured = modelIdentity ?? modelClient?.getCacheIdentity ?? modelClient?.cacheIdentity;
      const value = typeof configured === 'function' ? await configured() : configured;
      if (value == null || value === '' || value === 'unconfigured' || value === 'unknown' || !['string', 'object'].includes(typeof value) || (typeof value === 'object' && (!Object.keys(value).length || Array.isArray(value)))) return null;
      return structuredClone(value);
    } catch { return null; }
  }
  async function publicIdentity() { const value = await publicConfiguration(); return value ? hash(value) : null; }
  async function load(root, sourceId) {
    try {
      const value = JSON.parse(await readFile(pathFor(root, sourceId), 'utf8'));
      if (value.version !== 1 || value.sourceId !== sourceId || !Array.isArray(value.runs)) throw Error();
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, sourceId, runs: [] };
      throw new HttpError(409, '拆品任务文件无法读取，未覆盖已有结果');
    }
  }
  async function save(root, state) { const file = pathFor(root, state.sourceId); await mkdir(dirname(file), { recursive: true }); await writeAtomic(file, `${JSON.stringify(state)}\n`); }
  async function historicalFingerprint(root, sourceId) {
    const { analysis } = await readProductAnalysis(root), source = analysis.sources.find(s => s.id === sourceId);
    if (!source) throw new HttpError(404, '来源不存在');
    const resolvedPath = await realpath(await productSourcePath(root, source.assetPath)), info = await stat(resolvedPath);
    return hash({ sourceId, assetPath: source.assetPath, resolvedPath, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, ino: info.ino, durationMs: source.durationMs });
  }
  async function validateRunInput(root, sourceId, run) {
    if (run.historicalRef) {
      if (await historicalFingerprint(root, sourceId) !== run.fingerprint) throw new HttpError(409, '原片已经变化，历史建议未应用');
      return;
    }
    const input = await inputFor(root, sourceId);
    if (!savedInputMatches(run, input)) throw new HttpError(409, '来源、转写、模型或分析规则已变化，旧建议不能应用');
  }
  async function inputFor(root, sourceId) {
    const { analysis } = await readProductAnalysis(root);
    const source = analysis.sources.find(source => source.id === sourceId);
    if (!source) throw new HttpError(404, '来源不存在');
    const resolvedPath = await realpath(await productSourcePath(root, source.assetPath));
    const info = await stat(resolvedPath);
    const durationMs = Math.floor((await probeSource(root, source.assetPath)).duration * 1000);
    const transcript = await readTranscript(root, source);
    const cues = validateDiscoveryCues(transcript?.cues, durationMs).map(({ index: ignored, ...cue }) => cue);
    const fingerprint = hash({ sourceId, assetPath: source.assetPath, resolvedPath, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, ino: info.ino, durationMs });
    const modelConfiguration = await publicConfiguration();
    const publicModelHash = modelConfiguration ? hash(modelConfiguration) : null;
    const contract = prompt => publicModelHash ? hash({ publicModelHash: hash(textResultCacheIdentity(modelConfiguration)), promptHash: hash(prompt), algorithmVersion: DISCOVERY_VERSION, windowPolicy: { maxBytes, contextCues, knownProductBytes: 8000 } }) : null;
    const contractHash = contract(DISCOVERY_PROMPT), previousContractHash = contract(PREVIOUS_DISCOVERY_PROMPT);
    return { analysis, source, durationMs, cues, fingerprint, modelConfiguration, publicModelHash, contractHash, previousContractHash, inputHash: hash({ fingerprint, durationMs, cues }) };
  }
  async function view(root, sourceId) {
    const { analysis } = await readProductAnalysis(root);
    if (!analysis.sources.some(source => source.id === sourceId)) throw new HttpError(404, '来源不存在');
    const state = await load(root, sourceId), run = state.runs.at(-1);
    const active = running.has(`${root}\0${sourceId}`);
    const interrupted = run?.status === 'running' && !active;
    let inputsMatch = false, previousIncomplete = false;
    if (run) try { if (run.historicalRef) inputsMatch = await historicalFingerprint(root, sourceId) === run.fingerprint; else { const current = await inputFor(root, sourceId); inputsMatch = savedInputMatches(run, current); previousIncomplete = run.status !== 'complete' && Boolean(current.previousContractHash && run.contractHash === current.previousContractHash && run.contractHash !== current.contractHash); } } catch { /* Existing results remain inspectable while the source is unavailable. */ }
    const stale = Boolean(run && (!inputsMatch || (run.baseHash !== effectiveHash(analysis) && !state.applications?.some(a => a.runId === run.id && a.afterHash === effectiveHash(analysis)))));
    return { sourceId, status: interrupted ? 'failed' : run?.status ?? 'idle', modelIdentity: run?.modelIdentity ?? null, enabled: typeof modelClient === 'function', runId: run?.id, error: previousIncomplete ? '旧提示词下的拆品任务未完成；已完成窗口和原请求记录保留，不能混用新规则继续，请核查后明确发起新的拆品' : interrupted ? '任务已中断；已完成窗口保留，核查后可显式重试，重试可能计费' : run?.error, stale, canRetry: Boolean(run && !previousIncomplete && (run.status === 'failed' || interrupted)), proposal: run?.status === 'complete' ? run.proposal : undefined, difference: run?.proposal ? discoveryDifference(analysis, run.proposal) : undefined, runs: state.runs.map(({ id, status, createdAt, modelIdentity, windows, completed, error }) => ({ id, status, createdAt, modelIdentity, windows, completedWindows: completed?.length ?? 0, error })) };
  }
  async function startInner(root, body) {
    const input = await inputFor(root, body.sourceId);
    if (body.expectedInputIdentity && body.expectedInputIdentity !== hash({ inputHash: input.inputHash, contractHash: input.contractHash, baseHash: effectiveHash(input.analysis) })) throw new HttpError(409, '来源、转写或拆品配置在确认后变化，请重新核对请求');
    const state = await load(root, body.sourceId);
    let run = state.runs.at(-1);
    if (run?.status === 'complete' && savedInputMatches(run, input) && !body.rerun) return view(root, body.sourceId);
    if (typeof modelClient !== 'function') throw new HttpError(403, '商品识别服务未启用；不会发送转写');
    if (!input.contractHash) throw new HttpError(409, '缺少可核验的模型公开配置身份，未发送转写');
    if (run?.status === 'complete' && !body.rerun) throw new HttpError(409, '来源、转写、模型或分析规则已变化，请明确重新分析');
    const incomplete = run && ['running', 'failed'].includes(run.status);
    if (incomplete && !body.retry && !body.rerun) throw new HttpError(409, '上次任务未完成，需核查后显式重试');
    const resume = incomplete && body.retry && run.inputHash === input.inputHash && run.baseHash === effectiveHash(input.analysis) && run.contractHash === input.contractHash;
    if (body.retry && !resume) throw new HttpError(409, '来源、商品范围或分析设置已变化，不能继续旧任务；请明确重新分析');
    if (!resume) {
      run = { id: randomUUID(), createdAt: new Date().toISOString(), status: 'running', sourceId: body.sourceId, inputHash: input.inputHash, fingerprint: input.fingerprint, baseHash: effectiveHash(input.analysis), modelIdentity: input.publicModelHash, contractHash: input.contractHash, promptHash: hash(DISCOVERY_PROMPT), maxBytes, contextCues, windows: discoveryWindows(validateDiscoveryCues(input.cues, input.durationMs), { maxBytes, contextCues }).length, completed: [] };
      if (typeof body.draftKey === 'string' && /^[a-f0-9]{64}$/.test(body.draftKey)) run.draftKey = body.draftKey;
      state.runs.push(run);
    }
    run.status = 'running'; run.confirmationId = randomUUID(); delete run.error;
    const key = `${root}\0${body.sourceId}`;
    running.set(key, JSON.stringify([Boolean(body.rerun), Boolean(body.retry)]));
    try { await save(root, state); } catch (error) { running.delete(key); throw error; }
    const completion = (async () => {
      try {
        const guardedClient = async request => {
          const current = await inputFor(root, body.sourceId);
          if (current.inputHash !== input.inputHash || current.contractHash !== input.contractHash || effectiveHash(current.analysis) !== run.baseHash) throw Object.assign(new Error(), { code: 'DISCOVERY_INPUT_CHANGED' });
          return modelClient({ ...request, expectedIdentity: input.modelConfiguration, onReceipt: async receipt => { run.receipts ??= []; run.receipts.push(receipt); await save(root, state); } });
        };
        const proposal = await discoverProducts({ sourceId: body.sourceId, runId: run.id, durationMs: input.durationMs, cues: input.cues, client: guardedClient, maxBytes, contextCues, completed: run.completed, onWindow: async ({ results }) => { run.completed = results; await save(root, state); } });
        const latest = await inputFor(root, body.sourceId);
        if (latest.inputHash !== input.inputHash || latest.contractHash !== input.contractHash || effectiveHash(latest.analysis) !== run.baseHash) throw Object.assign(new Error(), { code: 'DISCOVERY_INPUT_CHANGED' });
        run.proposal = proposal; run.status = 'complete';
      } catch (error) {
        run.status = 'failed';
        run.error = error?.code === 'DISCOVERY_INPUT_CHANGED' ? '来源、转写或商品范围已变化，结果未应用，请重新检查' : error?.code === 'DISCOVERY_INVALID_RESULT' ? '模型结果违反商品、证据或时间约束，未生成有效候选' : '商品识别失败或提交状态不确定；已完成窗口保留，核查后显式重试可能计费';
      }
      try { await save(root, state); } finally { running.delete(key); }
    })().catch(() => running.delete(key));
    completions.set(key, completion);
    void completion.finally(() => completions.delete(key));
    return view(root, body.sourceId);
  }
  function start(root, body) {
    const key = `${root}\0${body.sourceId}`, identity = JSON.stringify([Boolean(body.rerun), Boolean(body.retry)]);
    if (applying.has(key)) throw new HttpError(409, '该来源正在应用拆品建议，请等待保存完成');
    const pending = starting.get(key);
    if (pending) { if (pending.identity !== identity) throw new HttpError(409, '该来源已有不同的拆品任务'); return pending.promise; }
    if (running.has(key)) { if (running.get(key) !== identity) throw new HttpError(409, '该来源已有不同的拆品任务'); return view(root, body.sourceId); }
    const promise = startInner(root, body).finally(() => starting.delete(key));
    starting.set(key, { identity, promise });
    return promise;
  }
  async function apply(root, body) {
    if (!body.expected || typeof body.runId !== 'string') throw new HttpError(400, '请提供待应用批次及当前商品快照');
    const key = `${root}\0${body.sourceId}`;
    if (running.has(key) || starting.has(key) || applying.has(key)) throw new HttpError(409, '拆品任务或建议保存仍在运行');
    applying.add(key);
    try { return await applyReserved(root, body); } finally { applying.delete(key); }
  }
  async function applyReserved(root, body) {
    const state = await load(root, body.sourceId), run = state.runs.find(run => run.id === body.runId);
    if (!run || run.status !== 'complete' || !run.proposal) throw new HttpError(400, '没有可应用的拆品建议');
    await validateRunInput(root, body.sourceId, run);
    const result = await updateProductAnalysis(root, async analysis => {
      if (hash(analysis) !== hash(body.expected)) throw new HttpError(409, '商品已被修改，请重新检查差异');
      await validateRunInput(root, body.sourceId, run);
      if ((analysis.discoveryApplied ?? []).some(item => item.sourceId === body.sourceId && item.runId === body.runId)) return analysis;
      const before = structuredClone(analysis);
      const oldRanges = analysis.intervals.filter(interval => interval.sourceId === body.sourceId);
      if ((oldRanges.length || (analysis.manualEdits ?? []).some(edit => edit.sourceIds.includes(body.sourceId))) && body.replaceReviewed !== true) throw new HttpError(409, '已有商品范围或人工修正，请核对差异后明确应用替换');
      const oldIds = new Set(oldRanges.map(interval => interval.id));
      const archived = analysis.candidates.filter(candidate => oldIds.has(candidate.intervalId));
      analysis.archivedCandidates = [...(analysis.archivedCandidates ?? []), ...archived];
      analysis.candidates = analysis.candidates.filter(candidate => !oldIds.has(candidate.intervalId));
      analysis.intervals = [...analysis.intervals.filter(interval => interval.sourceId !== body.sourceId), ...structuredClone(run.proposal.intervals)];
      analysis.unassigned = [...(analysis.unassigned ?? []).filter(interval => interval.sourceId !== body.sourceId), ...structuredClone(run.proposal.unassigned)];
      const neededOld = new Set([...(analysis.scopes ?? []), ...analysis.candidates].filter(item => item.sourceId === body.sourceId).map(item => item.productId));
      analysis.products = analysis.products.map(product => ({ ...product, sourceIds: product.sourceIds.filter(id => id !== body.sourceId || neededOld.has(product.id)) })).filter(product => product.sourceIds.length);
      for (const proposed of run.proposal.products) {
        const existing = analysis.products.find(product => product.id === proposed.id);
        if (existing) { existing.sourceIds = [...new Set([...existing.sourceIds, body.sourceId])]; existing.name = proposed.name; }
        else analysis.products.push(structuredClone(proposed));
      }
      analysis.discoveryApplied = [...(analysis.discoveryApplied ?? []).filter(item => item.sourceId !== body.sourceId), { sourceId: body.sourceId, runId: run.id }];
      return recordProductEdit(before, analysis, 'apply-proposal');
    }, probeSource);
    state.applications ??= [];
    state.applications.push({ runId: run.id, appliedAt: new Date().toISOString(), afterHash: effectiveHash(result.analysis) });
    await save(root, state);
    return { ...result, discovery: await view(root, body.sourceId) };
  }
  const route = async function route(req, res, root, rest) {
    if (rest === 'product-discovery' && req.method === 'GET') { const id = new URL(req.url, 'http://localhost').searchParams.get('sourceId'); json(res, 200, await view(root, id)); return true; }
    if (['product-discovery/discover', 'product-discovery/apply'].includes(rest) && req.method === 'POST') {
      const body = await readJson(req);
      if (body?.confirmed !== true || typeof body.sourceId !== 'string' || !body.sourceId) throw new HttpError(400, '请先确认来源与操作');
      json(res, 200, rest.endsWith('/apply') ? await apply(root, body) : await start(root, body)); return true;
    }
    return false;
  };
  return Object.assign(route, {
    busy: root => [...starting.keys(), ...running.keys(), ...applying].some(key => key.startsWith(`${root}\0`)),
    view, start, apply,
    importHistorical: async (root, sourceId, payload, sharedRef, { expectedSourceFingerprint } = {}) => {
      if (payload?.version !== 1 || payload.kind !== 'historical-ai-discovery' || !payload.proposal || !/^[a-f0-9]{64}$/.test(sharedRef?.sha256 ?? '')) throw new HttpError(409, '历史拆品格式不兼容');
      const { analysis } = await readProductAnalysis(root), source = analysis.sources.find(s => s.id === sourceId), state = await load(root, sourceId), id = `historical-${sharedRef.sha256}`;
      if (!source) throw new HttpError(404, '来源不存在');
      const info = await stat(await productSourcePath(root, source.assetPath)), localFingerprint = `${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}`;
      if (expectedSourceFingerprint && expectedSourceFingerprint !== localFingerprint) throw new HttpError(409, '原片在核对后已变化，历史拆品未导入');
      const frozenFingerprint = await historicalFingerprint(root, sourceId);
      const existing = state.runs.find(run => run.id === id);
      if (existing) return { runId: id, proposal: existing.proposal };
      const productIds = new Map(payload.proposal.products.map(p => [p.id, `historical-${hash([sharedRef.sha256, sourceId, p.id])}`]));
      const proposal = { ...structuredClone(payload.proposal), sourceId, runId: id,
        products: payload.proposal.products.map(p => ({ ...p, id: productIds.get(p.id), sourceIds: [sourceId] })),
        intervals: payload.proposal.intervals.map(i => ({ ...i, id: `historical-${hash([sharedRef.sha256, sourceId, i.id])}`, sourceId, productId: productIds.get(i.productId) })),
        unassigned: (payload.proposal.unassigned ?? []).map(i => ({ ...i, id: `historical-${hash([sharedRef.sha256, sourceId, i.id])}`, sourceId })) };
      validateProductAnalysis({ version: 1, sources: [source], products: proposal.products, intervals: proposal.intervals, unassigned: proposal.unassigned, candidates: [] });
      const after = await stat(await productSourcePath(root, source.assetPath));
      if (`${after.size}:${after.mtimeMs}:${after.ctimeMs}:${after.ino}` !== localFingerprint) throw new HttpError(409, '原片在导入期间变化，历史拆品未导入');
      state.runs.push({ id, sourceId, status: 'complete', createdAt: new Date().toISOString(), fingerprint: frozenFingerprint, baseHash: effectiveHash(analysis), historicalRef: sharedRef, proposal, windows: 0, completed: [], error: '历史 AI 拆品建议；原分析输入可能含当时本机字幕核对，未声称匹配当前字幕，请核对后采用' });
      await save(root, state); return { runId: id, proposal };
    },
    existingSharedContract: async (root, sourceId) => {
      const state = await load(root, sourceId), run = state.runs.at(-1);
      // Imported public/history records are already tied to their published
      // artifact. They are never exported as a fresh local AI judgment.
      if (!run || run.sharedRef || run.historicalRef) return null;
      const input = await inputFor(root, sourceId);
      const prompt = input.contractHash && run.contractHash === input.contractHash ? DISCOVERY_PROMPT
        : input.previousContractHash && run.contractHash === input.previousContractHash ? PREVIOUS_DISCOVERY_PROMPT : null;
      if (!prompt || input.inputHash !== run.inputHash) throw new HttpError(409, '原拆品请求的提示词契约、来源或转写无法确认；已有结果保留，请核查后再补存，不会重新请求模型');
      return { model: textResultCacheIdentity(input.modelConfiguration), prompt: hash(prompt), version: DISCOVERY_VERSION, maxBytes, contextCues };
    },
    sharedContract: async () => ({ model: textResultCacheIdentity(await publicConfiguration()), prompt: hash(DISCOVERY_PROMPT), version: DISCOVERY_VERSION, maxBytes, contextCues }),
    exportShared: async (root, sourceId, draftKey) => {
      const state = await load(root, sourceId), run = draftKey ? state.runs.findLast(run => run.draftKey === draftKey) : state.runs.at(-1);
      if (run?.status !== 'complete' || !run.proposal || run.sharedRef) throw new HttpError(409, '没有可共享的原始 AI 拆品结果');
      return { completed: structuredClone(run.completed), maxBytes: run.maxBytes, contextCues: run.contextCues, version: run.proposal.version };
    },
    importShared: async (root, sourceId, payload, sharedRef, { adopt = false } = {}) => {
      const input = await inputFor(root, sourceId), state = await load(root, sourceId), id = `shared-${sharedRef.sha256}`;
      const prior = state.runs.find(run => run.id === id);
      if (prior) {
        if (adopt) { prior.baseHash = effectiveHash(input.analysis); state.runs = [...state.runs.filter(run => run.id !== id), prior]; await save(root, state); }
        return view(root, sourceId);
      }
      if (!adopt && (state.runs.some(run => run.status === 'complete') || hasLocalResults(input.analysis, sourceId))) return view(root, sourceId);
      if (payload.version !== DISCOVERY_VERSION || !Array.isArray(payload.completed)) throw new HttpError(409, '共享拆品格式不兼容，已有结果未改动');
      const windows = discoveryWindows(validateDiscoveryCues(input.cues, input.durationMs), { maxBytes: payload.maxBytes, contextCues: payload.contextCues });
      if (windows.length !== payload.completed.length) throw new HttpError(409, '共享拆品窗口不完整');
      const proposal = await discoverProducts({ sourceId, runId: id, durationMs: input.durationMs, cues: input.cues, completed: payload.completed, maxBytes: payload.maxBytes, contextCues: payload.contextCues, client: async () => { throw Error('Shared import cannot call a model'); } });
      state.runs.push({ id, status: 'complete', sourceId, createdAt: new Date().toISOString(), inputHash: input.inputHash, contractHash: input.contractHash, baseHash: effectiveHash(input.analysis), modelIdentity: input.publicModelHash, windows: windows.length, completed: payload.completed, proposal, sharedRef });
      await save(root, state); return view(root, sourceId);
    },
    plan: async (root, sourceId, { retry = false, rerun = false } = {}) => {
      const input = await inputFor(root, sourceId), state = await load(root, sourceId), run = state.runs.at(-1);
      const matches = savedInputMatches(run, input);
      const cached = matches && run?.status === 'complete' && !rerun;
      const totalRequests = discoveryWindows(validateDiscoveryCues(input.cues, input.durationMs), { maxBytes, contextCues }).length;
      const reusedRequests = cached ? totalRequests : retry && matches && run?.baseHash === effectiveHash(input.analysis) ? run.completed.length : 0;
      return { generation: run ? { id: run.confirmationId ?? run.id, status: run.status } : null, inputIdentity: hash({ inputHash: input.inputHash, contractHash: input.contractHash, baseHash: effectiveHash(input.analysis) }), cached, totalRequests, reusedRequests, transcriptSegments: input.cues.length, windows: discoveryWindows(validateDiscoveryCues(input.cues, input.durationMs), { maxBytes, contextCues }).map(({ index, firstCue, lastCue, coreFirst, coreLast, bytes }) => ({ index, firstCue, lastCue, coreFirst, coreLast, bytes })), retryRequired: !!run && ['running', 'failed'].includes(run.status), rerunRequired: !!run && !matches, status: run?.status ?? 'idle' };
    },
    available: async () => typeof modelClient === 'function' && Boolean(await publicIdentity()),
    wait: async (root, sourceId) => { const key = `${root}\0${sourceId}`; await starting.get(key)?.promise; await completions.get(key); },
  });
}
