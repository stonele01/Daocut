/** Public structure plans reuse the shared result ledger. No model client or film writer is available here. */
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readProductAnalysis } from './product-analysis.mjs';
import { readProductTranscript } from './product-transcription.mjs';
import { productTranscriptRange } from './product-transcript-range.mjs';
import { sharedHash } from './shared-analysis.mjs';
import { writeAtomic } from './atomic.mjs';
import { HttpError } from './http.mjs';
import { inspectCompositionInput, enumerateStructureCompositions, STRUCTURE_COMPOSITION_VERSION } from './structure-composition.mjs';
import { mediaReviewCandidatesHash, validateProductMediaReview } from './product-media-review.mjs';
import { visualReviewCandidatesHash, validateProductVisualReview } from './product-visual-review.mjs';

const schema = 'daocut.structure-plans.v1';
const hex = /^[a-f0-9]{64}$/;
const issue = (code, message) => ({ code, message });
const read = async path => { try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw new HttpError(409, '结构方案记录无法读取，原文件已保留'); } };
const fileFor = (root, key) => { if (!hex.test(key)) throw new HttpError(400, '结构方案标识无效'); return join(root, '.film', 'structure-plans', `${key}.json`); };
const save = async (root, key, value) => { await mkdir(join(root, '.film', 'structure-plans'), { recursive: true }); await writeAtomic(fileFor(root, key), `${JSON.stringify(value)}\n`); };
const bounds = value => ({ startMs: value.startMs, endMs: value.endMs });
const joinText = lines => lines.reduce((text, line) => text + (/[A-Za-z]$/.test(text) && /^[A-Za-z]/.test(line.text) ? ' ' : '') + line.text, '');
const canonicalCandidate = candidate => ({ cueRange: candidate.cueRange, tags: [...candidate.tags].sort(), details: candidate.details ?? {}, composition: candidate.composition });

/** Reads only a fixed, hash-verified public baseline. A local semantic sidecar is never a publishing authority. */
export function createStructurePlanInputReader({ readAnalysis = readProductAnalysis, readTranscript = readProductTranscript } = {}) {
  return async (root, request) => {
    const { analysis } = await readAnalysis(root);
    const source = analysis.sources.find(item => item.id === request?.sourceId);
    if (!source) throw new HttpError(404, '找不到原片');
    const interval = analysis.intervals.find(item => item.id === request.intervalId && item.sourceId === source.id && item.productId === request.productId);
    const product = analysis.products.find(item => item.id === request.productId && item.sourceIds.includes(source.id));
    const context = { sourceId: source.id, productId: request.productId, intervalId: request.intervalId, ...(interval ? bounds(interval) : {}) };
    const unavailable = (code, message, visibility = 'unavailable') => ({ source, context, visibility, issues: [issue(code, message)] });
    if (!interval || !product || product.identityUncertain) return unavailable('UNCONFIRMED_PRODUCT_SCOPE', '需要已确认归属的单个商品讲解段，历史待核对话术不能按时间猜归属');
    if (['startMs', 'endMs'].some(key => Object.hasOwn(request, key) &&
      (!['number', 'string'].includes(typeof request[key]) || String(request[key]).trim() === '' || !Number.isFinite(Number(request[key])) || Number(request[key]) !== interval[key]))) {
      throw new HttpError(409, '商品讲解范围已变化，请刷新当前段；未继续旧范围生成');
    }
    const scope = { ...context, ...bounds(interval) };
    const candidates = analysis.candidates.filter(item => item.sourceId === source.id && item.productId === product.id && item.intervalId === interval.id);
    const live = await read(join(root, '.film', 'live-analysis', `${sharedHash(source.id)}.json`));
    const liveRef = live?.analyses?.[interval.id]?.sharedRef?.sha256;
    const dir = join(root, '.film', 'shared-analysis');
    const names = await readdir(dir).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    const matches = [];
    for (const name of names.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
      const saved = await read(join(dir, name)), snapshot = saved?.snapshot;
      if (saved?.sourceId !== source.id || saved.status !== 'complete' || snapshot?.action !== 'analysis' || snapshot.scope?.startMs !== scope.startMs || snapshot.scope?.endMs !== scope.endMs) continue;
      const ownScope = saved.descriptor?.localScope;
      if (!(liveRef === saved.result?.sha256 || ownScope?.intervalId === interval.id && ownScope?.productId === product.id)) continue;
      if (!saved.result || sharedHash(snapshot) !== saved.result.sha256 || snapshot.taskKey !== saved.descriptor?.taskKey || snapshot.sourceIdentity !== saved.descriptor?.sourceIdentity) return unavailable('PUBLIC_BASELINE_INVALID', '公共话术底稿校验失败，不能生成或覆盖已有结果');
      if (!matches.some(item => item.result.sha256 === saved.result.sha256)) matches.push(saved);
    }
    const pinned = liveRef ? matches.filter(item => item.result.sha256 === liveRef) : matches;
    if (pinned.length !== 1) return unavailable('PUBLIC_BASELINE_REQUIRED', pinned.length ? '此讲解段有多个公共版本，需先固定要使用的版本' : '此讲解段尚未绑定可核验的公共话术底稿');
    const baseline = pinned[0], snapshot = baseline.snapshot;
    let transcript, selected;
    try { transcript = await readTranscript(root, source); selected = productTranscriptRange(transcript, scope, source.durationMs); }
    catch { return unavailable('TRANSCRIPT_REQUIRED', '本段原始字幕或来源待核对，不能确认完整原话'); }
    if (transcript?.localReconciled) return unavailable('PRIVATE_TRANSCRIPT', '个人修正的字幕留在自己的工程，不能自动发布公共方案', 'private');
    if (sharedHash({ cues: selected.segments, cueIndices: selected.cueIndices }) !== snapshot.dataHash) return unavailable('PRIVATE_TRANSCRIPT', '当前字幕与固定公共底稿的输入不同，个人修改不会发布', 'private');
    const raw = snapshot.payload?.candidates;
    if (!Array.isArray(raw) || raw.length !== candidates.length) return unavailable('PRIVATE_CANDIDATES', '本机话术与公共底稿不同，个人增删不会发布', 'private');
    const candidateMap = new Map(), publicCandidates = [];
    for (const original of raw) {
      const found = candidates.filter(c => sharedHash(canonicalCandidate(c)) === sharedHash(canonicalCandidate(original)));
      if (found.length !== 1) return unavailable('PRIVATE_CANDIDATES', '本机话术标签或语义有修改，不能自动发布公共方案', 'private');
      const candidate = found[0], [first, last] = candidate.cueRange ?? [];
      const start = selected.cueIndices.indexOf(first), end = selected.cueIndices.indexOf(last);
      if (start < 0 || end < start) return unavailable('CUE_PROVENANCE_REQUIRED', '话术缺少可靠字幕范围，不能确认完整原话');
      const lines = selected.segments.slice(start, end + 1);
      if (candidate.text !== joinText(lines) || candidate.startMs !== Math.min(...lines.map(c => c.startMs)) || candidate.endMs !== Math.max(...lines.map(c => c.endMs))) return unavailable('PRIVATE_CANDIDATES', '话术原话或起止时间与公共底稿不同，个人修改不会发布', 'private');
      const publicId = `cue-${sharedHash([candidate.cueRange, candidate.startMs, candidate.endMs, candidate.text]).slice(0, 24)}`;
      candidateMap.set(candidate.id, publicId); if (original.id) candidateMap.set(original.id, publicId);
      publicCandidates.push({ id: publicId, sourceId: 'public-source', productId: 'public-product', intervalId: 'public-lecture', ...bounds(candidate), text: candidate.text, tags: candidate.tags, details: original.details ?? {}, cueRange: candidate.cueRange, origin: 'ai-text', version: snapshot.payload.version });
    }
    const originalReview = snapshot.payload.semanticReview ?? { version: 1, entries: raw.flatMap(c => {
      const composition = c.composition ?? c.details?.composition;
      return composition ? [{ ...composition, candidateId: c.id, cueRange: c.cueRange }] : [];
    }) };
    const entries = (originalReview.entries ?? []).map(entry => {
      const originalCandidate = entry.cueRange && raw.find(c => sharedHash(c.cueRange) === sharedHash(entry.cueRange));
      const publicId = candidateMap.get(entry.candidateId) ?? (originalCandidate && publicCandidates.find(c => sharedHash(c.cueRange) === sharedHash(originalCandidate.cueRange))?.id);
      return { ...entry, candidateId: publicId ?? entry.candidateId, requires: Array.isArray(entry.requires) ? entry.requires.map(id => candidateMap.get(id) ?? id) : entry.requires, excludes: Array.isArray(entry.excludes) ? entry.excludes.map(id => candidateMap.get(id) ?? id) : entry.excludes };
    });
    const semanticReview = { version: originalReview.version, entries, ...(originalReview.coreLabels ? { coreLabels: originalReview.coreLabels } : {}) };
    const semanticVersion = sharedHash(semanticReview);
    const completeSpeech = snapshot.payload.schema === 'complete-speech-v1' || entries.some(entry => entry.contract === 'complete-speech-v1');
    // Preserve incomplete-reading/ambiguity reports. The standard ASR-only notice
    // describes evidence, not whether enumeration of the supplied text is done.
    const analysisIssues = completeSpeech && Array.isArray(snapshot.payload.issues)
      ? snapshot.payload.issues.filter(value => typeof value === 'string' && value.trim() && value !== '未检查原音及画面') : [];
    const savedAnalysis = live?.analyses?.[interval.id];
    const localReview = savedAnalysis?.localMediaReview && savedAnalysis.mediaReviewForRun === savedAnalysis.currentRunId
      && savedAnalysis.mediaReviewCandidatesHash === mediaReviewCandidatesHash(candidates)
      && (!liveRef || liveRef === baseline.result.sha256) ? savedAnalysis.mediaReview : undefined;
    const checked = localReview ?? snapshot.payload.mediaReview;
    const mediaFields = checked ? { mediaReview: validateProductMediaReview(checked, scope), mediaReviewOrigin: localReview ? 'local' : 'shared' } : {};
    const localVisual = savedAnalysis?.localVisualReview && savedAnalysis.visualReviewForRun === savedAnalysis.currentRunId
      && (savedAnalysis.visualReviewCandidatesHash ?? savedAnalysis.visualReview?.candidatesHash) === visualReviewCandidatesHash(candidates)
      && (!liveRef || liveRef === baseline.result.sha256) ? savedAnalysis.visualReview : undefined;
    const visual = localVisual ?? snapshot.payload.visualReview;
    const visualFields = visual ? { visualReview: validateProductVisualReview(visual, scope), visualReviewOrigin: localVisual ? 'local' : 'shared', visualReviewStale: typeof visual.productName === 'string' && visual.productName !== product.name } : {};
    return { source, scope, context, ...mediaFields, ...visualFields, visibility: 'shared', analysisVersion: baseline.result.sha256, semanticVersion, baselineDescriptor: baseline.descriptor,
      engineInput: { sourceIdentity: snapshot.sourceIdentity, scope: { ...bounds(scope), sourceId: 'public-source', productId: 'public-product', intervalId: 'public-lecture' }, candidates: publicCandidates, cues: selected.segments, cueIndices: selected.cueIndices, semanticReview, ...(analysisIssues.length ? { analysisIssues } : {}) },
      localCandidateIds: Object.fromEntries(candidates.map(c => [candidateMap.get(c.id), c.id])), issues: [] };
  };
}

function localize(value, input) {
  if (Array.isArray(value)) return value.map(item => localize(item, input));
  if (!value || typeof value !== 'object') return value;
  const localized = Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    key === 'sourceId' ? input.source.id : key === 'productId' ? input.context.productId : key === 'intervalId' ? input.context.intervalId :
      key === 'candidateId' || key === 'id' ? input.localCandidateIds?.[item] ?? localize(item, input) :
        key === 'candidateIds' && Array.isArray(item) ? item.map(id => input.localCandidateIds?.[id] ?? id) : localize(item, input)]));
  if (typeof value.candidateId === 'string' && typeof value.sourceId === 'string' && Number.isFinite(value.startMs) && Number.isFinite(value.endMs)) localized.assetPath = input.source.assetPath;
  return localized;
}

export function createStructurePlans({ sharedAnalysis, readInput = createStructurePlanInputReader(), inspectInput = inspectCompositionInput, compose = enumerateStructureCompositions, rulesVersion = STRUCTURE_COMPOSITION_VERSION, pageSize = 50, stepBudget = 10000 } = {}) {
  const active = new Map();
  const payloadOf = saved => ({ schema, inputHash: saved.inputHash, plans: saved.plans, complete: true, materialComplete: saved.materialComplete === true, allValidCombinationsEnumerated: saved.allValidCombinationsEnumerated === true, issues: saved.issues, stats: saved.stats, analysisVersion: saved.analysisVersion, semanticVersion: saved.semanticVersion, rulesVersion: saved.rulesVersion });
  const contextOf = input => ({ ...input.context, visibility: input.visibility, analysisVersion: input.analysisVersion, semanticVersion: input.semanticVersion, rulesVersion });
  const view = (saved, input) => ({ status: saved.status, taskKey: saved.taskKey, plans: localize(saved.plans ?? [], input), complete: saved.complete === true, allValidCombinationsEnumerated: saved.allValidCombinationsEnumerated === true, materialComplete: input.inspected?.materialComplete === true, reviewItems: localize(input.inspected?.reviewItems ?? [], input), issues: saved.issues ?? [], stats: saved.stats ?? {}, context: contextOf(input), requestCount: 0,
    ...(input.mediaReview ? { mediaReview: input.mediaReview, mediaReviewOrigin: input.mediaReviewOrigin } : {}),
    ...(input.visualReview ? { visualReview: input.visualReview, visualReviewOrigin: input.visualReviewOrigin, visualReviewStale: input.visualReviewStale } : {}) });
  async function material(root, request) {
    const input = await readInput(root, request);
    if (input.visibility !== 'shared') return { input, blocked: { status: 'unavailable', complete: false, plans: [], issues: input.issues, context: contextOf(input), requestCount: 0 } };
    const inspected = inspectInput(input.engineInput);
    input.inspected = inspected;
    const issues = [...(input.issues ?? []), ...(inspected.issues ?? [])];
    if (inspected.ready === false) return { input, blocked: view({ status: 'unavailable', issues }, input) };
    if (!sharedAnalysis) return { input, blocked: { status: 'unavailable', complete: false, plans: [], issues: [...issues, issue('SHARING_REQUIRED', '公共方案协调服务尚未接通')], context: contextOf(input), requestCount: 0 } };
    const keyInput = { kind: schema, sourceIdentity: input.engineInput.sourceIdentity, scope: bounds(input.scope), analysisVersion: input.analysisVersion, semanticVersion: input.semanticVersion, rulesVersion, inputHash: inspected.inputHash };
    const localKey = sharedHash(keyInput), saved = await read(fileFor(root, localKey));
    if (saved && (saved.schema !== schema || saved.localKey !== localKey || saved.inputHash !== inspected.inputHash)) throw new HttpError(409, '结构方案输入身份变化，已保留旧方案');
    return { input, inspected, issues, keyInput, localKey, saved };
  }
  async function prepare(root, value) {
    const { input, keyInput } = value;
    await sharedAnalysis.validateSource(root, input.source, input.baselineDescriptor);
    return sharedAnalysis.prepareExisting(root, input.source, { action: 'structure-plans', scope: bounds(input.scope), count: 0, provenance: { kind: 'structure-plans-v1', inputRevision: input.analysisVersion }, payload: keyInput });
  }
  async function reuse(root, value, descriptor) {
    const snapshot = await sharedAnalysis.read(root, descriptor), payload = snapshot.payload;
    if (payload?.schema !== schema || payload.inputHash !== value.inspected.inputHash || payload.complete !== true || !Array.isArray(payload.plans)) throw new HttpError(409, '公共结构方案格式或输入不匹配，未重新生成');
    const saved = { ...payload, localKey: value.localKey, taskKey: descriptor.taskKey, status: 'complete', descriptor, sourceId: value.input.source.id };
    await save(root, value.localKey, saved);
    return view(saved, value.input);
  }
  async function status(root, request) {
    const value = await material(root, request);
    if (value.blocked) return value.blocked;
    if (value.saved) return view(value.saved, value.input);
    const descriptor = await prepare(root, value);
    if (descriptor.mode === 'reuse') return reuse(root, value, descriptor);
    return view({ taskKey: descriptor.taskKey, status: descriptor.mode === 'publish' ? 'idle' : descriptor.mode === 'publish-pending' ? 'publish-pending' : 'busy', issues: value.issues }, value.input);
  }
  async function generateOne(root, request) {
    const value = await material(root, request);
    if (value.blocked) return value.blocked;
    let saved = value.saved;
    if (saved && ['complete', 'publish-pending'].includes(saved.status)) return view(saved, value.input);
    const descriptor = await prepare(root, value);
    if (descriptor.mode === 'reuse') return reuse(root, value, descriptor);
    if (!saved) {
      if (descriptor.mode !== 'publish') return view({ taskKey: descriptor.taskKey, status: descriptor.mode === 'publish-pending' ? 'publish-pending' : 'busy', issues: value.issues }, value.input);
      let claim;
      try { claim = await sharedAnalysis.acquire(descriptor); }
      catch (error) {
        const current = await prepare(root, value);
        if (current.mode === 'reuse') return reuse(root, value, current);
        if (current.mode !== 'publish') return view({ taskKey: current.taskKey, status: 'busy', issues: value.issues }, value.input);
        throw error;
      }
      saved = { schema, localKey: value.localKey, taskKey: descriptor.taskKey, inputHash: value.inspected.inputHash, sourceId: value.input.source.id, analysisVersion: value.input.analysisVersion, semanticVersion: value.input.semanticVersion, rulesVersion, materialComplete: value.inspected.materialComplete === true, descriptor, attemptId: claim.attemptId, status: 'running', plans: [], cursor: null, complete: false, issues: value.issues, stats: {} };
      await save(root, value.localKey, saved);
    } else if (descriptor.mode !== 'publish-resume' || descriptor.attemptId !== saved.attemptId) {
      return view({ ...saved, status: 'busy', issues: [...saved.issues, issue('TASK_CHANGED', '公共任务状态已变化，未继续生成')] }, value.input);
    }
    let next = saved;
    if (!saved.complete) {
      const batch = await compose(value.input.engineInput, { cursor: saved.cursor, limit: pageSize, stepBudget });
      const known = new Set(saved.plans.map(plan => plan.id));
      next = { ...saved, plans: [...saved.plans, ...batch.plans.filter(plan => !known.has(plan.id))], cursor: batch.cursor, complete: batch.complete, allValidCombinationsEnumerated: batch.allValidCombinationsEnumerated === true, issues: batch.issues ?? saved.issues, stats: batch.stats ?? saved.stats };
      await save(root, value.localKey, next);
    }
    if (next.complete) {
      const payload = payloadOf(next);
      try { await sharedAnalysis.complete(root, next.descriptor, next.attemptId, payload); next.status = 'complete'; }
      catch { next.status = 'publish-pending'; }
      await save(root, value.localKey, next);
    }
    return view(next, value.input);
  }
  function generate(root, request) {
    const key = JSON.stringify([root, request?.sourceId, request?.productId, request?.intervalId]);
    if (active.has(key)) return active.get(key);
    const pending = generateOne(root, request).finally(() => active.delete(key)); active.set(key, pending); return pending;
  }
  async function publish(root, body) {
    if (body?.confirmed !== true || !hex.test(body.taskKey ?? '')) throw new HttpError(400, '请确认补保存已有公共方案');
    const dir = join(root, '.film', 'structure-plans');
    const names = await readdir(dir).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const name of names.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
      const saved = await read(join(dir, name));
      if (saved?.taskKey !== body.taskKey || saved.sourceId !== body.sourceId || saved.status !== 'publish-pending') continue;
      try { await sharedAnalysis.publish(root, body.sourceId, body.taskKey); }
      catch (error) {
        if (!saved.complete || !/没有可补保存的本机 AI 结果/.test(error.message)) throw error;
        // The completed cursor was saved before publication. Rebuild only its outbox, never the plans.
        await sharedAnalysis.complete(root, saved.descriptor, saved.attemptId, payloadOf(saved));
      }
      saved.status = 'complete'; await save(root, saved.localKey, saved);
      return { status: 'complete', taskKey: body.taskKey, complete: true, requestCount: 0 };
    }
    throw new HttpError(409, '没有可补保存的公共结构方案');
  }
  return { status, generate, publish };
}
