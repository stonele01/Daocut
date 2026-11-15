import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { writeAtomic } from './atomic.mjs';
import { HttpError, json, readJson } from './http.mjs';
import { readProductAnalysis, updateProductAnalysis } from './product-analysis.mjs';
import { productSourcePath, readProductTranscript } from './product-transcription.mjs';
import { productTranscriptRange } from './product-transcript-range.mjs';
import { mediaReviewCandidatesHash, validateProductMediaReview } from './product-media-review.mjs';
import { validateProductVisualReview, visualReviewCandidatesHash } from './product-visual-review.mjs';
import { analyzeTextStructure, combineTextStructureWindows, recoverDeepSeekTextResponse, textResponseIncompleteMessage, textResultCacheIdentity, textStructureCachePrompt, textStructureWindowPolicy, textStructureWindows, TEXT_CUE_ENCODING, LEGACY_TEXT_CUE_ENCODING, TEXT_STRUCTURE_PROMPT, PREVIOUS_CONTEXT_TEXT_STRUCTURE_PROMPT, PREVIOUS_ATTRIBUTED_TEXT_STRUCTURE_PROMPT, PREVIOUS_CURATED_TEXT_STRUCTURE_PROMPT, PREVIOUS_SENTENCE_TEXT_STRUCTURE_PROMPT, PREVIOUS_FULL_TEXT_STRUCTURE_PROMPT, PREVIOUS_TEXT_STRUCTURE_PROMPT, LEGACY_TEXT_STRUCTURE_PROMPT, TEXT_STRUCTURE_VERSION, COMPLETE_SPEECH_SCHEMA } from './text-structure.mjs';

const idle = () => ({ transcription: { status: 'idle', segments: [] }, analysis: { status: 'idle' } });
const file = (root, id) => join(root, '.film', 'live-analysis', `${createHash('sha256').update(id).digest('hex')}.json`);
const segmentsOf = transcript => (transcript?.cues?.length ? transcript.cues : transcript?.words ?? []).map(({ startMs, endMs, text }) => ({ startMs, endMs, text }));
const transcriptHash = transcript => createHash('sha256').update(JSON.stringify({ cues: segmentsOf(transcript), words: transcript?.words ?? [], ...(transcript?.unalignedRanges?.length ? { unalignedRanges: transcript.unalignedRanges } : {}), selection: 'whole-words-v1' })).digest('hex');
export { transcriptHash as structureTranscriptHash };
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

/** Keep superseded, unchanged AI output in history rather than mixing runs in the active catalogue. */
export function archivePreviousTextRuns(data, state, { sourceId, productId, intervalId }, currentRunId) {
  const originals = new Map();
  for (const attempt of Object.values(state.attempts ?? {})) {
    if (attempt.id === currentRunId || attempt.status !== 'complete' || !attempt.windows?.every(window => window.output)) continue;
    const merged = combineTextStructureWindows({ outputs: attempt.windows.map(window => window.output), sourceId, intervalId, cues: [] });
    for (const candidate of merged.candidates) if (candidate.sourceId === sourceId && candidate.productId === productId && candidate.intervalId === intervalId) {
      originals.set(`${attempt.id}:${candidate.id}`, { ...candidate, runId: attempt.id });
    }
  }
  data.candidates = data.candidates.filter(candidate => {
    const original = originals.get(`${candidate.runId}:${candidate.id}`);
    if (!original || hash(canonical(candidate)) !== hash(canonical(original))) return true;
    data.archivedCandidates ??= [];
    if (!data.archivedCandidates.some(item => item.id === candidate.id && item.runId === candidate.runId)) data.archivedCandidates.push(candidate);
    return false;
  });
  return data;
}
const rangesOf = data => [...data.intervals, ...(data.scopes ?? [])];
function expectedSelection(value) {
  if (value.lectureOnly !== true && value.startMs === undefined && value.endMs === undefined) return undefined;
  if (!Number.isFinite(value.startMs) || !Number.isFinite(value.endMs) || value.startMs < 0 || value.endMs <= value.startMs) throw new HttpError(400, '商品段起止时间无效。');
  return { startMs: value.startMs, endMs: value.endMs, lectureOnly: value.lectureOnly === true, retryFailed: value.retryFailed === true, ...(typeof value.draftKey === 'string' && /^[a-f0-9]{64}$/.test(value.draftKey) ? { draftKey: value.draftKey } : {}), ...(typeof value.expectedInputIdentity === 'string' ? { inputIdentity: value.expectedInputIdentity } : {}), ...(record(value.expectedVisualIdentity) ? { visualIdentity: structuredClone(value.expectedVisualIdentity) } : {}) };
}
function frozenScope(source, analysis, intervalId, productId, expected) {
  if (!expected) return undefined;
  const interval = (expected.lectureOnly ? analysis.intervals : rangesOf(analysis)).find(item => item.id === intervalId && item.sourceId === source.id && item.productId === productId);
  const product = analysis.products.find(item => item.id === productId && item.sourceIds.includes(source.id));
  if (!interval || !product) throw new HttpError(409, '所选商品讲解段已不存在或归属已改变，请重新选择。');
  if (interval.startMs !== expected.startMs || interval.endMs !== expected.endMs) throw new HttpError(409, '商品段边界尚未保存或已经改变，请保存并重新选择后再分析。');
  if (!Number.isFinite(source.durationMs) || source.durationMs <= 0 || interval.endMs > source.durationMs) throw new HttpError(409, '原片时长尚未确认，无法验证商品段范围。');
  return { sourceId: source.id, productId, intervalId, productName: product.name, startMs: interval.startMs, endMs: interval.endMs };
}
async function sourceFingerprint(root, source) {
  const info = await stat(await productSourcePath(root, source.assetPath));
  return `${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}`;
}

// Old completed entries have only size:mtime, even after their container is
// saved as v2. This permits using saved cuts, never reusing them as a current
// model cache. Do not manufacture missing prompt/model/transcript identities.
function legacyEditable(saved, range, source, fingerprint) {
  const parts = typeof saved.sourceFingerprint === 'string' ? saved.sourceFingerprint.split(':') : [];
  const current = fingerprint?.split(':');
  return saved.status === 'complete' && !Object.hasOwn(saved, 'cacheIdentity')
    && typeof saved.currentRunId === 'string' && !!saved.currentRunId.trim()
    && parts.length === 2 && parts.every(part => part.trim() !== '' && Number.isFinite(Number(part)) && Number(part) >= 0)
    // Date-based copy/restore preserves mtime at millisecond precision.
    && Number.isSafeInteger(Number(parts[0])) && parts[0] === current?.[0] && Math.round(Number(parts[1])) === Math.round(Number(current?.[1]))
    && !!range && range.sourceId === source.id && saved.intervalId === range.id && saved.productId === range.productId
    && Number.isFinite(source.durationMs) && source.durationMs > 0 && range.startMs >= 0 && range.endMs <= source.durationMs
    && range.endMs > range.startMs && saved.rangeStartMs === range.startMs && saved.rangeEndMs === range.endMs;
}

/** Record the explicitly approved sample inspection range, without claiming it is a product lecture. */
export async function confirmSampleInspectionScope(root, { sourceId, productId, intervalId }, probeSource) {
  if (![sourceId, productId, intervalId].every(x => typeof x === 'string' && x)) throw new Error('缺少检查范围身份');
  return updateProductAnalysis(root, data => {
    const source = data.sources.find(s => s.id === sourceId);
    if (!source || basename(source.assetPath) !== '氨基酸2023.6.1.mp4' || !data.products.some(p => p.id === productId && p.sourceIds.includes(sourceId))) throw new Error('未确认样片或商品关联');
    data.scopes ??= [];
    const existing = data.scopes.find(s => s.id === intervalId);
    if (existing) {
      if (existing.sourceId !== sourceId || existing.productId !== productId || existing.startMs !== 0 || existing.endMs !== 132470 || existing.kind !== 'confirmed-inspection') throw new Error('检查范围 ID 冲突');
      return data;
    }
    data.scopes.push({ id: intervalId, sourceId, productId, startMs: 0, endMs: 132470, kind: 'confirmed-inspection', confirmed: true });
    return data;
  }, probeSource, { preserveHistory: true });
}

/** Real services are unavailable unless callbacks are explicitly supplied by trusted server code. */
export function createLiveAnalysis({ transcribe, modelClient, modelIdentity, readTranscript = readProductTranscript, probeSource, structurePrompt = TEXT_STRUCTURE_PROMPT, structureVersion = TEXT_STRUCTURE_VERSION, structureWindowPolicy, structureCueEncoding, mediaReview, visualReview } = {}) {
  const windowPolicy = textStructureWindowPolicy(structureWindowPolicy);
  const cueEncoding = structureCueEncoding ?? ([PREVIOUS_FULL_TEXT_STRUCTURE_PROMPT, PREVIOUS_TEXT_STRUCTURE_PROMPT, LEGACY_TEXT_STRUCTURE_PROMPT].includes(structurePrompt) ? LEGACY_TEXT_CUE_ENCODING : TEXT_CUE_ENCODING);
  if (![TEXT_CUE_ENCODING, LEGACY_TEXT_CUE_ENCODING].includes(cueEncoding)) throw new Error('未知字幕编号格式');
  const encodingIdentity = encoding => encoding === LEGACY_TEXT_CUE_ENCODING ? {} : { cueEncoding: encoding };
  const running = new Map();
  const starting = new Map();
  const completions = new Map();
  const mediaRunning = new Map();
  async function visualDescription() {
    let identity = null;
    try { identity = typeof visualReview?.identity === 'function' ? await visualReview.identity() : null; } catch { /* Inspecting configuration never sends a request. */ }
    const enabled = record(identity) && typeof visualReview?.review === 'function';
    return { enabled, identity: enabled ? structuredClone(identity) : null, requestCount: enabled ? 1 : 0, maxImages: 1,
      ...(enabled ? { name: identity.name ?? '画面理解', model: identity.model, provider: identity.provider ?? identity.api, endpoint: identity.endpoint ?? identity.baseUrl } : { error: '尚未配置可用的画面理解模型，已有文字结果保留' }) };
  }
  async function inspectVisual(root, source, scope, candidates, technical, expectedIdentity, retryAcknowledged = false) {
    const base = { version: 'product-visual-review-v1', scope: { startMs: scope.startMs, endMs: scope.endMs }, candidatesHash: visualReviewCandidatesHash(candidates), entries: [], speechVerified: false, continuousActionVerified: false };
    if (!expectedIdentity || typeof visualReview?.review !== 'function' || technical?.status !== 'complete' || !technical.segments?.some(item => item.visual?.sampleTimesMs?.length)) {
      return { ...base, status: 'unavailable', issues: ['没有已确认的视觉模型或可用抽帧，未发送图片请求'] };
    }
    try {
      const value = await visualReview.review(root, source, scope, structuredClone(candidates), technical, { expectedIdentity, retryAcknowledged });
      validateProductVisualReview(value, scope);
      if (value.status === 'complete' && value.candidatesHash !== base.candidatesHash) throw Error('VISUAL_INPUT_CHANGED');
      return value;
    } catch {
      // A response or receipt may already exist in the visual service journal.
      // Keep text complete, and never turn this into another text/image request.
      return { ...base, status: 'uncertain', issues: ['画面理解未完整保存或结果状态不明；文字结果已保留，请先核查原请求记录'] };
    }
  }
  async function inspectMedia(root, source, scope, candidates) {
    try {
      const value = await mediaReview(root, source, scope, structuredClone(candidates));
      return validateProductMediaReview(value, scope);
    } catch {
      // Media tooling must not turn a completed paid text request into a failed
      // analysis or cause its provider windows to be submitted again.
      return { version: 'product-media-review-v1', status: 'failed', scope: { startMs: scope.startMs, endMs: scope.endMs },
        segments: [], issues: ['音画工具检查失败，文字结果已保留；可只重试音画检查'], speechVerified: false, continuousActionVerified: false };
    }
  }
  async function sourceFor(root, id) {
    if (typeof id !== 'string' || !id) throw new HttpError(400, '请选择来源');
    const { analysis } = await readProductAnalysis(root);
    const source = analysis.sources.find(s => s.id === id);
    if (!source) throw new HttpError(404, '来源不存在');
    return { source, analysis };
  }
  async function load(root, id) {
    try {
      const data = JSON.parse(await readFile(file(root, id), 'utf8'));
      if (![1, 2].includes(data.version) || data.sourceId !== id || !record(data.transcription) || !record(data.analysis)) throw Error();
      if (data.version === 2 && (!record(data.analyses) || !record(data.results))) throw Error();
      // Legacy successes stay readable, but no complete input identity is invented.
      data.analyses = Object.assign(Object.create(null), data.analyses ?? (data.analysis.intervalId ? { [data.analysis.intervalId]: data.analysis } : {}));
      data.results ??= {};
      data.attempts ??= {};
      if (!record(data.attempts)) throw Error();
      return data;
    } catch (e) {
      if (e.code === 'ENOENT') return { version: 2, sourceId: id, ...idle(), analyses: Object.create(null), results: {}, attempts: {} };
      throw new HttpError(409, '分析状态无法读取，未覆盖原文件');
    }
  }
  async function save(root, id, state) {
    const path = file(root, id);
    await mkdir(join(root, '.film', 'live-analysis'), { recursive: true });
    await writeAtomic(path, `${JSON.stringify({ ...state, version: 2 })}\n`);
  }
  async function publicModelIdentity() {
    try {
      // These are trusted, explicitly non-secret identity providers. Never fall
      // back to getConfig or function source text to guess model configuration.
      let value = typeof modelIdentity === 'function' ? await modelIdentity() : modelIdentity;
      if (value === undefined) value = typeof modelClient?.getCacheIdentity === 'function' ? await modelClient.getCacheIdentity() : modelClient?.cacheIdentity;
      if (!((typeof value === 'string' && value.trim()) || (record(value) && Object.keys(value).length))) return null;
      return value;
    } catch { return null; }
  }
  async function modelIdentityHash() {
    const value = await publicModelIdentity();
    return value ? hash(canonical(textResultCacheIdentity(value))) : null;
  }
  async function sourceInputIdentity(root, source, transcript, identityHash) {
    if (!transcript || !identityHash) return null;
    const path = await realpath(await productSourcePath(root, source.assetPath));
    const current = { assetPath: source.assetPath, path, fingerprint: await sourceFingerprint(root, source) };
    const moved = (await load(root, source.id)).movedSource;
    // Only a successful move of this exact source can reuse its old cache identity. Other input fields stay current.
    const reference = moved && JSON.stringify(moved.current) === JSON.stringify(current) ? moved.original : current;
    return { version: 2, sourceId: source.id, ...reference, durationMs: source.durationMs, transcript: transcriptHash(transcript), prompt: hash(textStructureCachePrompt(structurePrompt)), algorithm: structureVersion, windows: windowPolicy, model: identityHash };
  }
  async function inputIdentity(root, source, range, transcript, identityHash, sourceInput, prompt = structurePrompt, encoding = cueEncoding) {
    if (!range) return null;
    const common = sourceInput ?? await sourceInputIdentity(root, source, transcript, identityHash);
    return common ? hash({ ...common, prompt: hash(textStructureCachePrompt(prompt)), productId: range.productId, intervalId: range.id, startMs: range.startMs, endMs: range.endMs, ...encodingIdentity(encoding) }) : null;
  }
  // The approved fuller rules have a new identity. A verified previous result
  // remains reusable under its original identity, never rewritten as a new run.
  async function inputVersions(root, source, range, transcript, identityHash, sourceInput) {
    const common = sourceInput ?? await sourceInputIdentity(root, source, transcript, identityHash);
    const prompts = structurePrompt === TEXT_STRUCTURE_PROMPT ? [structurePrompt, PREVIOUS_CONTEXT_TEXT_STRUCTURE_PROMPT, PREVIOUS_ATTRIBUTED_TEXT_STRUCTURE_PROMPT, PREVIOUS_CURATED_TEXT_STRUCTURE_PROMPT, PREVIOUS_SENTENCE_TEXT_STRUCTURE_PROMPT, PREVIOUS_FULL_TEXT_STRUCTURE_PROMPT, PREVIOUS_TEXT_STRUCTURE_PROMPT] : [structurePrompt];
    const versions = prompts.flatMap((prompt, index) => (index === 0 && cueEncoding !== LEGACY_TEXT_CUE_ENCODING) || [PREVIOUS_CONTEXT_TEXT_STRUCTURE_PROMPT, PREVIOUS_ATTRIBUTED_TEXT_STRUCTURE_PROMPT, PREVIOUS_CURATED_TEXT_STRUCTURE_PROMPT, PREVIOUS_SENTENCE_TEXT_STRUCTURE_PROMPT].includes(prompt)
      ? [{ prompt, cueEncoding: index === 0 ? cueEncoding : TEXT_CUE_ENCODING }, { prompt, cueEncoding: LEGACY_TEXT_CUE_ENCODING }]
      : [{ prompt, cueEncoding: LEGACY_TEXT_CUE_ENCODING }]);
    return Promise.all(versions.map(async version => ({ ...version, cacheIdentity: await inputIdentity(root, source, range, transcript, identityHash, common, version.prompt, version.cueEncoding) })));
  }
  function resumeVersion(attempt, versions) {
    if (!attempt || attempt.status === 'complete') return null;
    const version = versions.find(item => item.cacheIdentity && item.cacheIdentity === attempt.cacheIdentity);
    if (!version) return null;
    if ((attempt.cueEncoding ?? LEGACY_TEXT_CUE_ENCODING) !== version.cueEncoding) return null;
    const known = structurePrompt === TEXT_STRUCTURE_PROMPT ? [structurePrompt, PREVIOUS_CONTEXT_TEXT_STRUCTURE_PROMPT, PREVIOUS_ATTRIBUTED_TEXT_STRUCTURE_PROMPT, PREVIOUS_CURATED_TEXT_STRUCTURE_PROMPT, PREVIOUS_SENTENCE_TEXT_STRUCTURE_PROMPT, PREVIOUS_FULL_TEXT_STRUCTURE_PROMPT, PREVIOUS_TEXT_STRUCTURE_PROMPT, LEGACY_TEXT_STRUCTURE_PROMPT] : [structurePrompt];
    const prompt = known.includes(attempt.prompt) && textStructureCachePrompt(attempt.prompt) === textStructureCachePrompt(version.prompt) ? attempt.prompt : version.prompt;
    return { ...version, prompt };
  }
  async function view(root, id, requestedIntervalId, requestedProductId, expected) {
    const { source, analysis: storedAnalysis } = await sourceFor(root, id);
    const scope = frozenScope(source, storedAnalysis, requestedIntervalId, requestedProductId, expected);
    const state = await load(root, id);
    const active = running.has(`${root}\0${id}`);
    const transcription = { ...state.transcription, segments: [] };
    const ranges = rangesOf(storedAnalysis).filter(range => range.sourceId === id);
    if (requestedIntervalId !== undefined && !ranges.some(range => range.id === requestedIntervalId && (requestedProductId === undefined || range.productId === requestedProductId))) throw new HttpError(400, '请先明确指定有效的商品讲解或已确认检查范围');
    const analyses = Object.create(null);
    let transcript, fingerprint, identityHash, identityValue, sourceInput;
    let readable = false;
    try {
      fingerprint = await sourceFingerprint(root, source);
      transcript = await readTranscript(root, source);
      identityValue = await publicModelIdentity();
      identityHash = identityValue ? hash(canonical(textResultCacheIdentity(identityValue))) : null;
      sourceInput = await sourceInputIdentity(root, source, transcript, identityHash);
      readable = true;
      if (transcription.status === 'complete' && (!transcript || state.transcription.sourceFingerprint !== fingerprint || state.transcription.transcriptHash !== transcriptHash(transcript))) Object.assign(transcription, { status: 'idle', error: '素材或字幕已变化，请重新检查转写' });
      if (transcript) {
        // The chat task only needs status; do not send the full source transcript to it.
        transcription.segments = scope ? [] : segmentsOf(transcript);
        if (transcription.status === 'idle' || ((transcript.localReconciled || transcript.recoveredFromResponse) && state.transcription.status !== 'running')) {
          transcription.status = 'complete';
          delete transcription.code; delete transcription.error; delete transcription.localReviewRequired; delete transcription.retryBlocked;
        }
      }
    } catch (error) {
      if (error.code === 'ASR_BOUNDARY_REVIEW') Object.assign(transcription, { status: 'failed', code: 'ASR_BOUNDARY_REVIEW', localReviewRequired: true, retryBlocked: false, error: '分段转写已保存，接缝待核对；无需重新上传音频' });
      else if (transcription.status !== 'running' && transcription.code !== 'ASR_BOUNDARY_REVIEW') Object.assign(transcription, { status: 'failed', error: '转写不可读取或上次提交状态不确定' });
    }
    if (!active && transcription.status === 'running') Object.assign(transcription, { status: 'failed', error: '任务中断，提交状态不确定，请先核查后再操作' });
    const ids = new Set(scope ? [scope.intervalId] : [...Object.keys(state.analyses), ...ranges.map(range => range.id)]);
    for (const rangeId of ids) {
      const range = ranges.find(item => item.id === rangeId);
      const saved = state.analyses[rangeId] ?? { status: 'idle', intervalId: rangeId, productId: range?.productId };
      let versions = [];
      try { if (readable && range && sourceInput) versions = await inputVersions(root, source, range, transcript, identityHash, sourceInput); } catch { /* unreadable sources only invalidate; never retry */ }
      const cached = versions.map(version => state.results[version.cacheIdentity]).find(Boolean);
      // An explicit running/failed rerun remains visible. Otherwise the exact
      // previously completed input version can be reused independently per range.
      // Product affiliation is personal. A merge may move an intact historical
      // scope and its candidates without changing the shared AI input or times.
      const historicalEditable = saved.status === 'complete' && /^[a-f0-9]{64}$/.test(saved.historicalRef?.sha256 ?? '') && saved.currentRunId === `historical-${saved.historicalRef.sha256}` && range?.kind === 'historical-analysis' && saved.sourceFingerprint === fingerprint && saved.rangeStartMs === range.startMs && saved.rangeEndMs === range.endMs;
      const item = { ...(cached && !['running', 'failed'].includes(saved.status) ? cached : saved), ...(historicalEditable ? { productId: range.productId } : {}), stale: true, legacyEditable: legacyEditable(saved, range, source, fingerprint), historicalEditable };
      if (item.status === 'running' && (!active || state.analysis.intervalId !== rangeId)) Object.assign(item, { status: 'failed', error: '任务中断，提交状态不确定，请先核查后再操作' });
      if (item.status === 'failed') {
        const failedWindow = state.attempts[item.attemptId]?.windows?.find(window => window.status === 'failed');
        if (failedWindow?.error === 'MODEL_INCOMPLETE') item.error = textResponseIncompleteMessage(failedWindow.receipt);
      }
      if (item.status === 'complete') {
        item.stale = !versions.some(version => version.cacheIdentity && item.cacheIdentity === version.cacheIdentity) || !item.currentRunId || item.productId !== range?.productId;
        if (item.sharedRef && range && readable && item.sharedSignature === hash({ fingerprint, transcript: transcriptHash(transcript), intervalId: range.id, productId: range.productId, startMs: range.startMs, endMs: range.endMs })) item.stale = false;
        if (item.stale) Object.assign(item, { status: 'idle', error: !identityHash ? '模型配置身份未确认，已有结果仅供核对；不会自动重新分析' : '素材、字幕、范围或分析配置已变化，已有结果仅供核对；不会自动重新分析' });
        if (item.legacyEditable) item.error = '历史分析结果可继续剪辑；未按当前配置重新分析，不作为最新分析缓存';
        if (item.historicalEditable) Object.assign(item, { status: 'idle', stale: true, error: '已导入的历史 AI 原话可继续选材；保留原分析范围，不代表当前字幕或商品边界已重新分析' });
      }
      if (item.mediaReview) item.mediaReviewStale = item.mediaReviewCandidatesHash !== mediaReviewCandidatesHash(storedAnalysis.candidates.filter(candidate => candidate.sourceId === id && candidate.intervalId === rangeId && candidate.productId === range?.productId));
      if (item.visualReview) item.visualReviewStale = item.visualReview.candidatesHash !== visualReviewCandidatesHash(storedAnalysis.candidates.filter(candidate => candidate.sourceId === id && candidate.intervalId === rangeId && candidate.productId === range?.productId))
        || (item.visualReview.productName !== undefined && item.visualReview.productName !== storedAnalysis.products.find(product => product.id === range?.productId)?.name);
      analyses[rangeId] = item;
    }
    const matching = requestedProductId === undefined ? ranges : ranges.filter(range => range.productId === requestedProductId);
    const selectedId = requestedIntervalId ?? (requestedProductId !== undefined ? (matching.length === 1 ? matching[0].id : matching.find(range => range.id === state.analysis.intervalId)?.id) : state.analysis.intervalId);
    const analysis = selectedId && analyses[selectedId] ? analyses[selectedId] : { status: 'idle', stale: true };
    let analysisPlan;
    if (scope && analysis.status !== 'running') {
      const model = typeof identityValue === 'string' ? identityValue : [identityValue?.provider, identityValue?.model, identityValue?.endpoint].filter(value => typeof value === 'string' && value).join(' · ') || null;
      const versions = sourceInput ? await inputVersions(root, source, { ...scope, id: scope.intervalId }, transcript, identityHash, sourceInput) : [];
      const version = analysis.status === 'failed' ? resumeVersion(state.attempts[analysis.attemptId], versions) ?? versions[0] : versions[0];
      analysisPlan = { enabled: typeof modelClient === 'function' && !!identityHash, model, requestCount: null, transcriptSegments: null, inputIdentity: version?.cacheIdentity ?? null };
      if (visualReview) analysisPlan.visual = await visualDescription();
      try {
        const { segments: cues } = productTranscriptRange(transcript, scope, source.durationMs);
        const windows = textStructureWindows({ sourceId: id, productId: scope.productId, intervalId: scope.intervalId, cues, rangeStartMs: scope.startMs, rangeEndMs: scope.endMs, prompt: version?.prompt ?? structurePrompt, cueEncoding: version?.cueEncoding ?? cueEncoding, ...windowPolicy });
        Object.assign(analysisPlan, { requestCount: windows.length, transcriptSegments: cues.length });
      } catch (error) {
        analysisPlan.error = error instanceof HttpError ? error.message : '本段转写无法按当前文字窗口预算分析，未发起请求。';
      }
    }
    return { transcription, analysis, analyses, canReviewMedia: typeof mediaReview === 'function', canReviewVisual: typeof visualReview?.review === 'function', ...(scope ? { scope, analysisPlan } : {}) };
  }
  async function startInner(root, id, type, requestedIntervalId, rerun, requestedProductId, retryUncertain, expected) {
    const { source, analysis: current } = await sourceFor(root, id);
    if (type === 'analysis') frozenScope(source, current, requestedIntervalId, requestedProductId, expected);
    // Reject an invalid or ambiguous scope even when a previous result is cached.
    const ranges = rangesOf(current).filter(i => i.sourceId === id && (requestedIntervalId === undefined || i.id === requestedIntervalId) && (requestedProductId === undefined || i.productId === requestedProductId));
    if (type === 'analysis' && ranges.length !== 1) throw new HttpError(400, '请先明确指定有效的商品讲解或已确认检查范围');
    const selected = ranges[0];
    if (type === 'analysis' && selected?.kind === 'historical-analysis') throw new HttpError(409, '历史结果范围仅用于复用已有候选；如需新分析，请明确选择当前商品讲解段');
    const key = `${root}\0${id}`;
    if (mediaRunning.has(key)) throw new HttpError(409, '本段音画工具检查正在进行，请等待完成');
    if (running.has(key)) return view(root, id, type === 'analysis' ? selected.id : undefined, requestedProductId, type === 'analysis' ? expected : undefined);
    const state = await load(root, id);
    if (type === 'transcription' && state[type].status === 'running' && !retryUncertain) return view(root, id);
    const existing = await view(root, id, type === 'analysis' ? selected.id : undefined, requestedProductId, type === 'analysis' ? expected : undefined);
    if (existing[type].status === 'complete' && !(type === 'analysis' && rerun)) return existing;
    if (type === 'analysis' && expected?.visualIdentity && hash(canonical(expected.visualIdentity)) !== hash(canonical((await visualDescription()).identity))) throw new HttpError(409, '画面理解模型在确认期间变化，请重新核对本次请求');
    if (type === 'analysis' && expected?.inputIdentity && expected.inputIdentity !== existing.analysisPlan?.inputIdentity) throw new HttpError(409, '商品段、转写或模型配置在确认期间发生变化，请重新核对请求。');
    if (type === 'analysis' && expected && existing.analysis.status === 'failed' && !expected.retryFailed && !rerun) throw new HttpError(409, '上次结构分析失败或提交状态不确定；不会自动重试。核查后请明确重试本段结构。');
    if (type === 'transcription' && state[type].retryBlocked && !retryUncertain) throw new HttpError(409, '上次转写可能已提交，不能自动重试，请先核查服务状态');
    if (type === 'transcription') {
      if (existing.transcription.status === 'complete') return existing;
    }
    if (type === 'transcription' && typeof transcribe !== 'function') throw new HttpError(403, '转写服务未启用或缺少配置');
    if (type === 'analysis' && typeof modelClient !== 'function') throw new HttpError(403, '文字分析服务未启用或缺少配置');
    if (type === 'analysis' && !await modelIdentityHash()) throw new HttpError(409, '模型配置身份未确认，不能开始新的文字分析');
    const draftKey = type === 'analysis' ? expected?.draftKey : null, activeAnalysis = state.analysis;
    const persist = async () => {
      if (draftKey) await save(root, id, { ...state, analysis: activeAnalysis, sharedDrafts: { ...state.sharedDrafts, [draftKey]: state.analysis } });
      else await save(root, id, state);
    };
    const previousAnalysis = type === 'analysis' ? (draftKey ? state.sharedDrafts?.[draftKey] : state.analyses[selected.id]) : null;
    const confirmationId = randomUUID();
    state[type] = { status: 'running', confirmationId, ...(type === 'transcription' ? { segments: [], retryUncertain } : { intervalId: selected.id, productId: selected.productId }) };
    if (type === 'analysis' && !draftKey) state.analyses[selected.id] = state.analysis;
    // Reserve before the first write so duplicate requests cannot schedule two jobs.
    running.set(key, JSON.stringify([type, requestedIntervalId, rerun, requestedProductId, retryUncertain, expected]));
    let result;
    try { await persist(); result = await view(root, id, type === 'analysis' ? selected.id : undefined, requestedProductId, type === 'analysis' ? expected : undefined); } catch (e) { running.delete(key); throw e; }
    const completion = (async () => {
      try {
        if (type === 'transcription') {
          if (typeof transcribe !== 'function') throw new Error('转写服务未启用或缺少配置');
          if (expected?.fingerprint && await sourceFingerprint(root, source) !== expected.fingerprint) throw Object.assign(new Error('素材已变化，音频未发送'), { code: 'ASR_NOT_SUBMITTED', reason: 'source' });
          // Only an explicitly confirmed retry passes this authority through to
          // the trusted transcriber; GET/reopen never reach this callback.
          const transcript = await transcribe(root, source, { retryUncertain, ...(expected?.service ? { expectedService: expected.service } : {}) });
          if (!segmentsOf(transcript).length) throw new Error('转写没有可用的时间段');
          state.transcription = { status: 'complete', confirmationId, segments: [], sourceFingerprint: await sourceFingerprint(root, source), transcriptHash: transcriptHash(transcript) };
        } else {
          if (typeof modelClient !== 'function') throw new Error('文字分析服务未启用或缺少配置');
          const transcript = await readTranscript(root, source);
          const { segments: cues, cueIndices, omittedBoundaryWords } = productTranscriptRange(transcript, selected, source.durationMs);
          const fingerprint = await sourceFingerprint(root, source);
          const transcriptDigest = transcriptHash(transcript);
          const expectedIdentity = structuredClone(await publicModelIdentity());
          const versions = await inputVersions(root, source, selected, transcript, expectedIdentity ? hash(canonical(textResultCacheIdentity(expectedIdentity))) : null);
          const previousAttempt = previousAnalysis?.attemptId && state.attempts[previousAnalysis.attemptId];
          const resumedVersion = !rerun && resumeVersion(previousAttempt, versions);
          const execution = resumedVersion || versions[0], cacheIdentity = execution?.cacheIdentity;
          if (!cacheIdentity || (expected?.inputIdentity && !versions.some(version => version.cacheIdentity === expected.inputIdentity))) throw Object.assign(new Error(), { code: 'MODEL_INPUT_CHANGED' });
          const productId = selected.productId;
          const intervalId = selected.id;
          const baseArgs = { sourceId: id, productId, intervalId, cues, rangeStartMs: selected.startMs, rangeEndMs: selected.endMs, prompt: execution.prompt, cueEncoding: execution.cueEncoding, version: structureVersion };
          const windows = textStructureWindows({ ...baseArgs, ...windowPolicy });
          const attempt = resumedVersion ? previousAttempt : {
            id: randomUUID(), cacheIdentity, prompt: execution.prompt, cueEncoding: execution.cueEncoding, createdAt: new Date().toISOString(), elapsedMs: 0,
            windows: windows.map(({ index, firstCue, lastCue, bytes }) => ({ index, firstCue, lastCue, bytes, status: 'idle', requests: 0 })),
          };
          if (!Array.isArray(attempt.windows) || attempt.windows.length !== windows.length || attempt.windows.some((window, index) => window.index !== index || window.firstCue !== windows[index].firstCue || window.lastCue !== windows[index].lastCue)) throw Object.assign(new Error(), { code: 'MODEL_CONSTRAINT' });
          attempt.status = 'running';
          state.attempts[attempt.id] = attempt;
          const resumedWindows = attempt.windows.filter(window => window.status === 'complete').length;
          const progress = () => ({ totalWindows: windows.length, completedWindows: attempt.windows.filter(window => window.status === 'complete').length, resumedWindows, currentWindow: attempt.windows.findIndex(window => window.status === 'running'), requestAttempts: attempt.windows.reduce((sum, window) => sum + window.requests, 0), elapsedMs: attempt.elapsedMs });
          const saveProgress = async () => {
            state.analysis = { ...state.analysis, attemptId: attempt.id, cacheIdentity, progress: progress() };
            if (!draftKey) state.analyses[intervalId] = state.analysis;
            await persist();
          };
          const assertInputCurrent = async () => {
            const { source: currentSource, analysis } = await sourceFor(root, id);
            const currentRange = rangesOf(analysis).find(range => range.id === intervalId && range.sourceId === id && range.productId === productId);
            if (await inputIdentity(root, currentSource, currentRange, await readTranscript(root, currentSource), await modelIdentityHash(), undefined, execution.prompt, execution.cueEncoding) !== cacheIdentity) throw Object.assign(new Error(), { code: 'MODEL_INPUT_CHANGED' });
          };
          await saveProgress();
          const outputs = [];
          for (const window of windows) {
            await assertInputCurrent();
            const entry = attempt.windows[window.index];
            const windowCueIndices = cueIndices.slice(window.firstCue, window.lastCue + 1);
            const args = { ...baseArgs, cues: window.cues };
            if (resumedVersion && !attempt.prompt && structurePrompt === TEXT_STRUCTURE_PROMPT) {
              // Pre-upgrade journals stored transmitted bytes, but not the
              // prompt text. Identify only an exact known wording/byte match;
              // a paid window must not silently become a new-prompt request.
              const input = JSON.stringify({ sourceId: id, productId, intervalId, rangeStartMs: selected.startMs, rangeEndMs: selected.endMs, cues: window.cues });
              const originalPrompt = [execution.prompt, PREVIOUS_TEXT_STRUCTURE_PROMPT, LEGACY_TEXT_STRUCTURE_PROMPT].find(prompt => textStructureCachePrompt(prompt) === textStructureCachePrompt(execution.prompt) && Buffer.byteLength(prompt + input, 'utf8') === entry.bytes);
              if (!originalPrompt) throw Object.assign(new Error(), { code: 'MODEL_INPUT_CHANGED' });
              args.prompt = originalPrompt;
            }
            const withSourceIndices = output => {
              for (const candidate of output.candidates) candidate.cueRange = candidate.cueRange.map(index => windowCueIndices[index]);
              return output;
            };
            if (entry.status === 'complete') {
              // Revalidate saved outputs against the same original cues before
              // accepting a resumed window. This callback cannot send a request.
              // Nonempty normalized candidates use the legacy revalidation path
              // so their stored conditions/review survive. Empty output needs
              // its explicit contract marker because there is no candidate.
              const output = withSourceIndices(await analyzeTextStructure({ ...args, client: async () => ({ ...(!entry.output.candidates.length && entry.output.schema ? { schema: entry.output.schema } : {}), candidates: entry.output.candidates.map(candidate => ({ firstCue: windowCueIndices.indexOf(candidate.cueRange[0]), lastCue: windowCueIndices.indexOf(candidate.cueRange[1]), tags: candidate.tags, details: candidate.details })), issues: entry.output.issues }) }));
              output.candidates.forEach((candidate, index) => { candidate.id = entry.output.candidates[index].id; });
              outputs.push(output);
              continue;
            }
            // Transport completion does not guarantee valid JSON or cue references.
            // Only an explicitly approved retry replaces a previously rejected reply.
            const replaceInvalidReply = expected?.retryFailed === true && ['MODEL_INVALID_JSON', 'MODEL_CONSTRAINT'].includes(entry.error);
            entry.bytes = Buffer.byteLength(args.prompt, 'utf8') + window.bytes - Buffer.byteLength(baseArgs.prompt, 'utf8');
            entry.status = 'running'; delete entry.error;
            entry.startedAt = new Date().toISOString();
            await saveProgress();
            const startedAt = Date.now();
            try {
              const output = withSourceIndices(await analyzeTextStructure({ ...args, client: async request => {
                const recovered = replaceInvalidReply ? undefined : recoverDeepSeekTextResponse(entry.receipt, request);
                if (recovered !== undefined) { entry.recoveredFromResponse = true; return recovered; }
                if (entry.receipt) {
                  entry.previousReceipts ??= [];
                  entry.previousReceipts.push(entry.receipt);
                  delete entry.receipt;
                }
                entry.requests++;
                await saveProgress();
                return modelClient({ ...request, expectedIdentity, onReceipt: async receipt => { entry.receipt = receipt; await saveProgress(); } });
              } }));
              await assertInputCurrent();
              entry.output = output; entry.status = 'complete'; entry.completedAt = new Date().toISOString();
              outputs.push(output);
            } catch (error) {
              entry.status = 'failed'; entry.error = ['MODEL_TIMEOUT', 'MODEL_NETWORK', 'MODEL_HTTP', 'MODEL_INCOMPLETE', 'MODEL_INVALID_JSON', 'MODEL_CONSTRAINT', 'MODEL_INPUT_CHANGED'].includes(error?.code) ? error.code : 'MODEL_FAILED';
              attempt.status = 'failed';
              throw error;
            } finally {
              attempt.elapsedMs += Date.now() - startedAt;
              await saveProgress();
            }
          }
          const output = combineTextStructureWindows({ outputs, sourceId: id, intervalId, cues, version: structureVersion });
          const mediaScope = { sourceId: id, productId, intervalId, productName: current.products.find(item => item.id === productId)?.name ?? '', startMs: selected.startMs, endMs: selected.endMs };
          const checkedMedia = typeof mediaReview === 'function' ? await inspectMedia(root, source, mediaScope, output.candidates) : undefined;
          await assertInputCurrent();
          const checkedVisual = expected?.visualIdentity ? await inspectVisual(root, source, mediaScope, output.candidates, checkedMedia, expected.visualIdentity) : undefined;
          const latest = await readTranscript(root, source);
          if (!latest || await inputIdentity(root, source, selected, latest, await modelIdentityHash(), undefined, execution.prompt, execution.cueEncoding) !== cacheIdentity) throw Object.assign(new Error(), { code: 'MODEL_INPUT_CHANGED' });
          const runId = attempt.id;
          if (!draftKey) await updateProductAnalysis(root, async data => {
            if (!data.sources.some(s => s.id === id) || !data.products.some(p => p.id === productId && p.sourceIds.includes(id))) throw new Error('来源或商品已变更');
            const latestRange = [...data.intervals, ...(data.scopes ?? [])].find(i => i.id === intervalId);
            if (!latestRange || latestRange.sourceId !== id || latestRange.productId !== productId || latestRange.startMs !== selected.startMs || latestRange.endMs !== selected.endMs) throw new Error('检查范围已变更');
            const latestSource = data.sources.find(s => s.id === id);
            if (await inputIdentity(root, latestSource, latestRange, await readTranscript(root, latestSource), await modelIdentityHash(), undefined, execution.prompt, execution.cueEncoding) !== cacheIdentity) throw Object.assign(new Error(), { code: 'MODEL_INPUT_CHANGED' });
            archivePreviousTextRuns(data, state, { sourceId: id, productId, intervalId }, runId);
            for (const candidate of output.candidates) {
              candidate.runId = runId;
              // A crash after the candidate commit but before state completion
              // must not append the same batch again during an explicit retry.
              if (!data.candidates.some(existing => existing.id === candidate.id && existing.runId === runId)) data.candidates.push(candidate);
            }
            return data;
          }, probeSource);
          attempt.status = 'complete'; attempt.completedAt = new Date().toISOString();
          state.analysis = { ...(output.schema ? { schema: output.schema } : {}), ...(checkedMedia ? { mediaReview: checkedMedia, mediaReviewCandidatesHash: mediaReviewCandidatesHash(output.candidates) } : {}), ...(checkedVisual ? { visualReview: checkedVisual } : {}), status: 'complete', confirmationId, sourceFingerprint: fingerprint, transcriptHash: transcriptDigest, cacheIdentity, currentRunId: runId, attemptId: attempt.id, progress: progress(), intervalId, productId, rangeStartMs: selected.startMs, rangeEndMs: selected.endMs, coverage: output.coverage, issues: output.issues, candidateCount: output.candidates.length, omittedBoundaryWords };
          if (!draftKey) state.results[cacheIdentity] = state.analysis;
        }
      } catch (error) {
        if (type === 'analysis' && state.analysis.attemptId && state.attempts[state.analysis.attemptId]) state.attempts[state.analysis.attemptId].status = 'failed';
        const known = ['转写服务未启用或缺少配置', '文字分析服务未启用或缺少配置', '请先完成转写', '该来源需要明确关联一个商品', '转写没有可用的时间段', '来源或商品已变更', '素材或字幕在分析中发生变化'];
        const safe = type === 'transcription' && error?.code === 'ASR_NOT_SUBMITTED';
        const boundaryReview = type === 'transcription' && error?.code === 'ASR_BOUNDARY_REVIEW';
        const reason = error?.reason === 'configuration' ? '转写配置不可用' : error?.reason === 'audio' ? '音频提取失败或音频不符合要求' : '素材读取失败或发生变化';
        const status = Number.isInteger(error?.httpStatus) && error.httpStatus >= 400 && error.httpStatus <= 599 ? ` ${error.httpStatus}` : '';
        const modelErrors = { MODEL_TIMEOUT: '模型请求超时', MODEL_NETWORK: '模型网络请求失败', MODEL_HTTP: `模型服务返回 HTTP 错误${status}`, MODEL_INCOMPLETE: '模型响应未完成或达到输出上限', MODEL_INVALID_JSON: '模型输出 JSON 无效', MODEL_CONSTRAINT: '模型结果违反格式或来源约束', MODEL_INPUT_CHANGED: '本地授权输入已变化或不可读取', MODEL_INPUT_TOO_LARGE: '单条字幕或提示词超出文字窗口预算，请检查字幕边界' };
        const failedReceipt = type === 'analysis' ? state.attempts[state.analysis.attemptId]?.windows?.find(window => window.status === 'failed')?.receipt : undefined;
        const analysisError = error?.code === 'MODEL_INCOMPLETE' ? textResponseIncompleteMessage(failedReceipt) : error?.code === 'MODEL_CONSTRAINT' && error?.cueIssue ? error.message : Object.hasOwn(modelErrors, error?.code) ? modelErrors[error.code] : error instanceof HttpError || known.includes(error?.message) ? error.message : '任务失败，请检查配置与素材';
        state[type] = { ...(type === 'analysis' ? state.analysis : {}), status: 'failed', confirmationId, error: type === 'transcription' ? (boundaryReview ? '分段转写已保存，交界处待核对；无需重新付费转写，未自动重传音频' : safe ? `${reason}，音频未上传；处理后可手动重试` : '转写失败或提交状态不确定，不能自动重试，请先核查服务状态') : analysisError, ...(type === 'transcription' ? { segments: [], retryBlocked: !safe && !boundaryReview, ...(boundaryReview ? { code: 'ASR_BOUNDARY_REVIEW', localReviewRequired: true } : {}) } : { intervalId: selected.id, productId: selected.productId }) };
      }
      if (type === 'analysis' && !draftKey) state.analyses[selected.id] = state.analysis;
      try { await persist(); } finally { running.delete(key); }
    })().catch(() => running.delete(key));
    completions.set(key, completion);
    void completion.finally(() => completions.delete(key));
    return result;
  }
  function start(root, id, type, intervalId, rerun, productId, retryUncertain, expected) {
    const key = `${root}\0${id}`;
    const identity = JSON.stringify([type, intervalId, rerun, productId, retryUncertain, expected]);
    const pending = starting.get(key);
    if (pending) {
      if (pending.identity !== identity) throw new HttpError(409, '该来源已有任务正在处理');
      return pending.promise;
    }
    if (running.has(key) && running.get(key) !== identity) throw new HttpError(409, '该来源已有任务正在处理');
    const promise = startInner(root, id, type, intervalId, rerun, productId, retryUncertain, expected).finally(() => starting.delete(key));
    starting.set(key, { identity, promise });
    return promise;
  }
  async function reviewMedia(root, body) {
    if (body?.confirmed !== true) throw new HttpError(400, '请确认本次本地音画检查');
    if (typeof mediaReview !== 'function') throw new HttpError(409, '此环境未启用本地音画检查');
    const key = `${root}\0${body.sourceId}`, identity = JSON.stringify([body.sourceId, body.productId, body.intervalId, body.startMs, body.endMs]);
    if (mediaRunning.has(key)) {
      const pending = mediaRunning.get(key);
      if (pending.identity !== identity) throw new HttpError(409, '该来源的另一次音画检查正在进行');
      return pending.promise;
    }
    if (starting.has(key) || running.has(key)) throw new HttpError(409, '请等当前分析保存完成再检查音画');
    const promise = (async () => {
      const { source, analysis } = await sourceFor(root, body.sourceId);
      const expected = expectedSelection({ ...body, lectureOnly: true });
      const scope = frozenScope(source, analysis, body.intervalId, body.productId, expected);
      const current = await view(root, source.id, scope.intervalId, scope.productId, expected);
      if (current.analysis.status !== 'complete' || current.analysis.stale !== false) throw new HttpError(409, '先核对本次讲解的已有话术结果；音画检查不会重新请求文字分析');
      if (current.analysis.mediaReview?.status === 'complete' && !current.analysis.mediaReviewStale) return current;
      const candidates = analysis.candidates.filter(c => c.sourceId === source.id && c.productId === scope.productId && c.intervalId === scope.intervalId);
      const before = hash(canonical({ source, scope, candidates })), fingerprint = await sourceFingerprint(root, source);
      const checked = await inspectMedia(root, source, scope, candidates);
      const latest = await sourceFor(root, source.id);
      const latestScope = frozenScope(latest.source, latest.analysis, scope.intervalId, scope.productId, expected);
      const latestCandidates = latest.analysis.candidates.filter(c => c.sourceId === source.id && c.productId === scope.productId && c.intervalId === scope.intervalId);
      if (hash(canonical({ source: latest.source, scope: latestScope, candidates: latestCandidates })) !== before || await sourceFingerprint(root, latest.source) !== fingerprint) throw new HttpError(409, '核查期间素材或话术已变化，原结果保留，请重新选择');
      const state = await load(root, source.id), saved = state.analyses[scope.intervalId];
      if (!saved || saved.currentRunId !== current.analysis.currentRunId) throw new HttpError(409, '核查期间分析版本变化，未覆盖旧记录');
      // Supplemental checks belong to this project. They never patch an immutable
      // public snapshot, its candidate text, or any private editing draft.
      saved.mediaReview = checked; saved.localMediaReview = true;
      saved.mediaReviewCandidatesHash = mediaReviewCandidatesHash(candidates);
      saved.mediaReviewForRun = saved.currentRunId;
      if (state.analysis.intervalId === scope.intervalId) state.analysis = saved;
      if (saved.cacheIdentity) state.results[saved.cacheIdentity] = saved;
      await save(root, source.id, state);
      return view(root, source.id, scope.intervalId, scope.productId, expected);
    })().finally(() => mediaRunning.delete(key));
    mediaRunning.set(key, { identity, promise });
    return promise;
  }
  async function visualPlan(root, request) {
    const { source, analysis } = await sourceFor(root, request?.sourceId);
    const expected = expectedSelection({ ...request, lectureOnly: true });
    const scope = frozenScope(source, analysis, request.intervalId, request.productId, expected);
    const current = await view(root, source.id, scope.intervalId, scope.productId, expected);
    if (current.analysis.status !== 'complete' || current.analysis.stale !== false) throw new HttpError(409, '请先核对本次讲解的已有话术；看图核查不会重新分析文字');
    const candidates = analysis.candidates.filter(candidate => candidate.sourceId === source.id && candidate.productId === scope.productId && candidate.intervalId === scope.intervalId);
    const candidatesHash = visualReviewCandidatesHash(candidates), configured = await visualDescription();
    const cached = current.analysis.visualReview?.status === 'complete' && current.analysis.visualReview.candidatesHash === candidatesHash && !current.analysis.visualReviewStale;
    const incomplete = !cached && ['uncertain', 'failed'].includes(current.analysis.visualReview?.status);
    let recoverable = false;
    if (incomplete && configured.enabled && typeof visualReview?.recovery === 'function' && current.analysis.mediaReview?.status === 'complete' && !current.analysis.mediaReviewStale) {
      try { recoverable = (await visualReview.recovery(root, source, scope, candidates, current.analysis.mediaReview, { expectedIdentity: configured.identity }))?.recoverable === true; }
      catch { /* Unreadable journal remains an explicit review/retry, never a new request. */ }
    }
    const retryRequired = incomplete && !recoverable;
    const inputIdentity = hash(canonical({ source, fingerprint: await sourceFingerprint(root, source), scope, candidatesHash, runId: current.analysis.currentRunId }));
    const visual = { ...configured, requestCount: cached || recoverable ? 0 : configured.requestCount };
    const service = Object.fromEntries(['enabled', 'name', 'model', 'provider', 'endpoint', 'error'].filter(field => configured[field] !== undefined).map(field => [field, configured[field]]));
    return { identity: hash(canonical({ inputIdentity, visual: configured.identity, recoverable, status: current.analysis.visualReview?.status ?? null, reviewKey: current.analysis.visualReview?.key ?? null })),
      sourceId: source.id, productId: scope.productId, intervalId: scope.intervalId, startMs: scope.startMs, endMs: scope.endMs, scope,
      source: { assetPath: source.assetPath, durationMs: source.durationMs }, service, visual, inputIdentity, candidatesHash,
      enabled: cached || configured.enabled, cached, recoverable, requestCount: visual.requestCount, retryRequired, maxImages: 1,
      cost: { estimate: cached || recoverable ? 0 : null, uncertain: !(cached || recoverable), basis: cached ? '复用已保存画面理解结果，不发送请求' : recoverable ? '原始图片模型返回已保存，本次只恢复本地记录，不重新发送图片' : '最多发送本次讲解的一张抽帧拼图及对应话术，预计 1 次图文请求；以实际服务账单为准' } };
  }
  async function reviewVisual(root, body) {
    if (body?.confirmed !== true || !record(body.plan) || typeof body.plan.identity !== 'string') throw new HttpError(400, '请确认本次画面理解模型、图片范围及请求计划');
    const key = `${root}\0${body.plan.sourceId}`, identity = `visual:${body.plan.identity}`;
    if (mediaRunning.has(key)) {
      const pending = mediaRunning.get(key);
      if (pending.identity !== identity) throw new HttpError(409, '该来源已有核查正在进行，请等待保存完成');
      return pending.promise;
    }
    if (starting.has(key) || running.has(key)) throw new HttpError(409, '请等当前分析保存完成再核查画面');
    const promise = (async () => {
      const plan = await visualPlan(root, body.plan);
      if (plan.identity !== body.plan.identity) throw new HttpError(409, '素材、话术或视觉模型配置已变化，请重新核对看图请求');
      if (plan.cached) return view(root, plan.sourceId, plan.intervalId, plan.productId, plan.scope);
      if (!plan.enabled) throw new HttpError(409, plan.visual.error ?? '画面理解模型不可用');
      if (plan.retryRequired && body.retryAcknowledged !== true) throw new HttpError(409, '上次画面请求结果或费用不确定，请核查记录后明确重试');
      const { source, analysis } = await sourceFor(root, plan.sourceId), scope = frozenScope(source, analysis, plan.intervalId, plan.productId, { ...plan.scope, lectureOnly: true });
      const current = await view(root, source.id, scope.intervalId, scope.productId, scope);
      const candidates = analysis.candidates.filter(candidate => candidate.sourceId === source.id && candidate.productId === scope.productId && candidate.intervalId === scope.intervalId);
      const technical = current.analysis.mediaReview?.status === 'complete' && !current.analysis.mediaReviewStale ? current.analysis.mediaReview
        : typeof mediaReview === 'function' ? await inspectMedia(root, source, scope, candidates) : undefined;
      // Recheck after local extraction and before any external image request.
      if ((await visualPlan(root, plan)).identity !== plan.identity) throw new HttpError(409, '抽帧期间素材、话术或模型已变化，未发送图片');
      const checked = await inspectVisual(root, source, scope, candidates, technical, plan.visual.identity, body.retryAcknowledged === true);
      const after = await visualPlan(root, plan);
      // The journal has legitimately advanced during this call. Only immutable
      // inputs/model identity must stay fixed; recovery availability may change.
      if (after.inputIdentity !== plan.inputIdentity || hash(canonical(after.visual.identity)) !== hash(canonical(plan.visual.identity))) throw new HttpError(409, '画面核查期间输入发生变化，原结果保留；请重新选择');
      const state = await load(root, source.id), saved = state.analyses[scope.intervalId];
      if (!saved || saved.currentRunId !== current.analysis.currentRunId) throw new HttpError(409, '分析版本变化，未覆盖旧核查记录');
      saved.visualReview = checked; saved.localVisualReview = true; saved.visualReviewForRun = saved.currentRunId;
      if (technical && technical !== current.analysis.mediaReview) {
        saved.mediaReview = technical; saved.localMediaReview = true; saved.mediaReviewForRun = saved.currentRunId; saved.mediaReviewCandidatesHash = mediaReviewCandidatesHash(candidates);
      }
      if (state.analysis.intervalId === scope.intervalId) state.analysis = saved;
      if (saved.cacheIdentity) state.results[saved.cacheIdentity] = saved;
      await save(root, source.id, state);
      return view(root, source.id, scope.intervalId, scope.productId, scope);
    })().finally(() => mediaRunning.delete(key));
    mediaRunning.set(key, { identity, promise }); return promise;
  }
  const route = async function route(req, res, root, rest) {
    if (rest === 'live-analysis/visual-plan' && req.method === 'GET') {
      const params = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
      json(res, 200, await visualPlan(root, { ...params, startMs: Number(params.startMs), endMs: Number(params.endMs) })); return true;
    }
    if (rest === 'live-analysis/review-visual' && req.method === 'POST') {
      json(res, 200, await reviewVisual(root, await readJson(req))); return true;
    }
    if (rest === 'live-analysis' && req.method === 'GET') {
      const params = new URL(req.url, 'http://localhost').searchParams;
      const expected = expectedSelection({ lectureOnly: params.get('lectureOnly') === 'true', ...(params.has('startMs') ? { startMs: Number(params.get('startMs')) } : {}), ...(params.has('endMs') ? { endMs: Number(params.get('endMs')) } : {}) });
      json(res, 200, await view(root, params.get('sourceId'), params.get('intervalId') ?? undefined, params.get('productId') ?? undefined, expected)); return true;
    }
    if (rest === 'live-analysis/review-media' && req.method === 'POST') {
      json(res, 200, await reviewMedia(root, await readJson(req))); return true;
    }
    const type = rest === 'live-analysis/transcribe' ? 'transcription' : rest === 'live-analysis/analyze' ? 'analysis' : null;
    if (type && req.method === 'POST') {
      const body = await readJson(req);
      if (body.confirmed !== true) throw new HttpError(400, '请先确认操作');
      if (body.retryUncertain === true && type !== 'transcription') throw new HttpError(400, '不确定提交重试仅适用于转写');
      json(res, 200, await start(root, body.sourceId, type, body.intervalId, body.rerun === true, body.productId, body.retryUncertain === true, type === 'analysis' ? expectedSelection(body) : undefined)); return true;
    }
    return false;
  };
  // The material preparation route uses the same task/cache/retry machinery.
  // These methods are local server controls, never caller-supplied callbacks.
  return Object.assign(route, {
    busy: root => [...starting.keys(), ...running.keys(), ...mediaRunning.keys()].some(key => key.startsWith(`${root}\0`)),
    view,
    reviewMedia,
    visualPlan,
    reviewVisual,
    sharedContract: async () => ({ model: textResultCacheIdentity(await publicModelIdentity()), prompt: hash(textStructureCachePrompt(structurePrompt)), version: structureVersion, windowPolicy, ...encodingIdentity(cueEncoding) }),
    existingSharedContract: async (root, sourceId, scope) => {
      const state = await load(root, sourceId), saved = state.analyses[scope?.intervalId];
      if (!saved || saved.sharedRef || saved.historicalRef || saved.status === 'idle') return null;
      const { source, analysis } = await sourceFor(root, sourceId);
      const range = analysis.intervals.find(item => item.id === scope?.intervalId && item.productId === scope?.productId && item.sourceId === sourceId);
      const model = await publicModelIdentity();
      const versions = await inputVersions(root, source, range, await readTranscript(root, source), model ? hash(canonical(textResultCacheIdentity(model))) : null);
      const version = versions.find(item => item.cacheIdentity && item.cacheIdentity === saved.cacheIdentity);
      if (!version) throw new HttpError(409, '已有话术分析的原始请求身份无法确认，未改用新版提示词补存或重新请求');
      return { model: textResultCacheIdentity(model), prompt: hash(textStructureCachePrompt(version.prompt)), version: structureVersion, windowPolicy, ...encodingIdentity(version.cueEncoding) };
    },
    importHistorical: async (root, sourceId, payload, sharedRef, { productId, productName, sourceSha, expectedSourceFingerprint, expectedAnalysis } = {}) => {
      if (payload?.version !== 1 || payload.kind !== 'historical-ai-structure' || !Array.isArray(payload.candidates) || !/^[a-f0-9]{64}$/.test(sharedRef?.sha256 ?? '')) throw new HttpError(409, '历史话术格式不兼容');
      if ((typeof productId === 'string' && !!productId) === (typeof productName === 'string' && !!productName.trim())) throw new HttpError(400, '请明确关联一个本机商品，或输入新本机商品名');
      const { source, analysis } = await sourceFor(root, sourceId), expectedHash = hash(canonical(analysis));
      if (expectedAnalysis && hash(canonical(expectedAnalysis)) !== expectedHash) throw new HttpError(409, '本机商品在导入前已修改，请核对已有结果；未覆盖修改');
      const frozenFingerprint = await sourceFingerprint(root, source);
      if (expectedSourceFingerprint && frozenFingerprint !== expectedSourceFingerprint) throw new HttpError(409, '原片在核对后已变化，历史候选未导入');
      const scopeId = `history-${hash([sharedRef.sha256, sourceId])}`, existing = analysis.scopes?.find(s => s.id === scopeId);
      if (productId && !analysis.products.some(p => p.id === productId && p.sourceIds.includes(sourceId))) throw new HttpError(400, '本机商品不存在');
      if (existing && productId && existing.productId !== productId) throw new HttpError(409, '历史结果已关联其他本机商品，未覆盖关联');
      const localProductId = existing?.productId ?? productId ?? randomUUID(), scope = payload.scope;
      if (!Number.isFinite(scope?.startMs) || !Number.isFinite(scope?.endMs) || scope.startMs < 0 || scope.endMs <= scope.startMs || scope.endMs > source.durationMs) throw new HttpError(409, '历史范围不在原片内');
      const runId = `historical-${sharedRef.sha256}`;
      const candidates = payload.candidates.map((c, i) => ({ id: `historical-${hash([sharedRef.sha256, sourceId, i])}`, sourceId, productId: localProductId, intervalId: scopeId, startMs: c.startMs, endMs: c.endMs, text: c.text, tags: c.tags, details: c.details, cueRange: c.cueRange, origin: 'ai-text', version: 'historical-structure-v1', runId }));
      const committed = await updateProductAnalysis(root, data => {
        if (hash(canonical(data)) !== expectedHash) throw new HttpError(409, '本机商品在导入期间已修改，请重试；未覆盖修改');
        if (existing) return data;
        if (!productId) data.products.push({ id: localProductId, name: productName.trim(), sourceIds: [sourceId] });
        data.scopes ??= [];
        data.scopes.push({ id: scopeId, sourceId, productId: localProductId, ...scope, kind: 'historical-analysis', origin: 'shared-historical', confirmed: true, label: '历史话术原始分析范围' });
        data.candidates.push(...candidates); return data;
      }, probeSource, { preserveHistory: true });
      if (await sourceFingerprint(root, source) !== frozenFingerprint) throw new HttpError(409, '原片在导入期间变化，历史候选未启用，请核对素材');
      const state = await load(root, sourceId), saved = { status: 'complete', intervalId: scopeId, productId: localProductId, rangeStartMs: scope.startMs, rangeEndMs: scope.endMs, sourceFingerprint: frozenFingerprint, currentRunId: runId, candidateCount: candidates.length, historicalRef: sharedRef, sourceSha };
      state.analyses[scopeId] = saved; state.analysis = saved; await save(root, sourceId, state);
      return { imported: true, intervalId: scopeId, productId: localProductId, count: candidates.length, analysis: committed.analysis };
    },
    exportShared: async (root, sourceId, intervalId, draftKey) => {
      const state = await load(root, sourceId), saved = draftKey ? state.sharedDrafts?.[draftKey] : state.analyses[intervalId], attempt = saved?.attemptId && state.attempts[saved.attemptId];
      if (saved?.status !== 'complete' || !attempt || attempt.status !== 'complete' || saved.sharedRef) throw new HttpError(409, '没有可共享的原始 AI 结构结果');
      // Reuse the same merge as the local result: a duplicate window must not
      // erase unresolved context or conflicting conditions during publication.
      const merged = combineTextStructureWindows({ outputs: attempt.windows.map(window => window.output), sourceId, intervalId, cues: [], version: structureVersion });
      const candidates = merged.candidates.map(candidate => ({ cueRange: candidate.cueRange, tags: candidate.tags, details: candidate.details }));
      const media = saved.mediaReview && validateProductMediaReview(saved.mediaReview, { startMs: saved.rangeStartMs, endMs: saved.rangeEndMs });
      const visual = saved.visualReview && validateProductVisualReview(saved.visualReview, { startMs: saved.rangeStartMs, endMs: saved.rangeEndMs });
      return { ...(merged.schema ? { schema: merged.schema } : {}), ...(media ? { mediaReview: media } : {}), ...(visual ? { visualReview: visual } : {}), candidates, issues: saved.issues ?? [], version: structureVersion };
    },
    importShared: async (root, sourceId, scope, payload, sharedRef, { adopt = false, expectedAnalysis } = {}) => {
      const { source, analysis } = await sourceFor(root, sourceId);
      if (expectedAnalysis && hash(canonical(analysis)) !== hash(canonical(expectedAnalysis))) throw new HttpError(409, '商品或结构已被修改，未自动导入共享话术');
      if (adopt && (analysis.manualEdits ?? []).some(edit => edit.action === 'manual-save' && edit.sourceIds.includes(sourceId))) throw new HttpError(409, '人工修改已变化，未用新版结构覆盖');
      const selected = frozenScope(source, analysis, scope.intervalId, scope.productId, { ...scope, lectureOnly: true });
      const state = await load(root, sourceId), runId = `shared-${sharedRef.sha256}`;
      const importedView = async committedAnalysis => ({ ...await view(root, sourceId, scope.intervalId, scope.productId, scope), committedAnalysis });
      if (state.analyses[scope.intervalId]?.currentRunId === runId) return importedView(analysis);
      if (!adopt && analysis.candidates.some(c => c.intervalId === scope.intervalId)) return importedView(analysis);
      if (payload?.version !== structureVersion || (payload.schema !== undefined && payload.schema !== COMPLETE_SPEECH_SCHEMA) || !Array.isArray(payload.candidates)) throw new HttpError(409, '共享结构格式不兼容');
      const importedMedia = payload.mediaReview === undefined ? undefined : validateProductMediaReview(payload.mediaReview, scope);
      const importedVisual = payload.visualReview === undefined ? undefined : validateProductVisualReview(payload.visualReview, scope);
      const transcript = await readTranscript(root, source), { segments: cues, cueIndices } = productTranscriptRange(transcript, selected, source.durationMs);
      const response = { ...(!payload.candidates.length && payload.schema ? { schema: payload.schema } : {}), candidates: payload.candidates.map(c => ({ firstCue: cueIndices.indexOf(c.cueRange?.[0]), lastCue: cueIndices.indexOf(c.cueRange?.[1]), tags: c.tags, details: c.details })), issues: payload.issues };
      const output = await analyzeTextStructure({ sourceId, productId: scope.productId, intervalId: scope.intervalId, cues, rangeStartMs: scope.startMs, rangeEndMs: scope.endMs, client: async () => response, version: structureVersion });
      output.candidates.forEach((c, i) => { c.id = `shared-${hash([sharedRef.sha256, sourceId, scope.intervalId, i])}`; c.runId = runId; c.cueRange = c.cueRange.map(index => cueIndices[index]); });
      if (importedVisual?.status === 'complete' && importedVisual.candidatesHash !== visualReviewCandidatesHash(output.candidates)) throw new HttpError(409, '共享画面核查对应的话术范围不匹配，未覆盖当前结果');
      const committed = await updateProductAnalysis(root, data => {
        if (expectedAnalysis && hash(canonical(data)) !== hash(canonical(expectedAnalysis))) throw new HttpError(409, '商品或结构在导入期间被修改，未覆盖最新修改');
        if (adopt && hash(canonical(data)) !== hash(canonical(analysis))) throw new HttpError(409, '商品或结构在采用期间已被修改，未覆盖最新修改');
        const range = data.intervals.find(i => i.id === scope.intervalId && i.productId === scope.productId && i.sourceId === sourceId);
        if (!range || range.startMs !== scope.startMs || range.endMs !== scope.endMs) throw new HttpError(409, '本机范围已变化，共享结构未应用');
        if (adopt) {
          const previous = data.candidates.filter(c => c.intervalId === scope.intervalId);
          data.archivedCandidates ??= [];
          for (const item of previous) if (!data.archivedCandidates.some(c => c.id === item.id)) data.archivedCandidates.push(item);
          data.candidates = data.candidates.filter(c => c.intervalId !== scope.intervalId);
        }
        if (!data.candidates.some(c => c.intervalId === scope.intervalId)) data.candidates.push(...output.candidates);
        return data;
      }, probeSource);
      const fingerprint = await sourceFingerprint(root, source), digest = transcriptHash(transcript), cacheIdentity = await inputIdentity(root, source, { ...scope, id: scope.intervalId }, transcript, await modelIdentityHash());
      const saved = { ...(output.schema ? { schema: output.schema } : {}), ...(importedMedia ? { mediaReview: importedMedia, mediaReviewCandidatesHash: mediaReviewCandidatesHash(output.candidates) } : {}), ...(importedVisual ? { visualReview: importedVisual } : {}), status: 'complete', currentRunId: runId, intervalId: scope.intervalId, productId: scope.productId, sourceFingerprint: fingerprint, transcriptHash: digest, cacheIdentity, rangeStartMs: scope.startMs, rangeEndMs: scope.endMs, candidateCount: output.candidates.length, coverage: output.coverage, issues: output.issues, sharedRef, sharedSignature: hash({ fingerprint, transcript: digest, intervalId: scope.intervalId, productId: scope.productId, startMs: scope.startMs, endMs: scope.endMs }) };
      state.analyses[scope.intervalId] = saved; state.analysis = saved; if (cacheIdentity) state.results[cacheIdentity] = saved;
      await save(root, sourceId, state); return importedView(committed.analysis);
    },
    canTranscribe: typeof transcribe === 'function',
    startTranscription: (root, id, retryUncertain = false, expectedService, fingerprint) => start(root, id, 'transcription', undefined, false, undefined, retryUncertain, expectedService || fingerprint ? { service: expectedService, fingerprint } : undefined),
    startAnalysis: (root, body) => start(root, body.sourceId, 'analysis', body.intervalId, body.rerun === true, body.productId, false, expectedSelection(body)),
    wait: async (root, id) => { const key = `${root}\0${id}`; await starting.get(key)?.promise; await completions.get(key); },
  });
}
