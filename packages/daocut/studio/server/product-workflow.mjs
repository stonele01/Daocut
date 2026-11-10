/** Ordinary-project entry points. Planning is local; each external stage needs its own matching confirmation. */
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { HttpError, json, readJson } from './http.mjs';
import { probe } from './derived.mjs';
import { readProductAnalysis, updateProductAnalysis } from './product-analysis.mjs';
import { hasSavedProductResult } from './product-preparation.mjs';
import { confirmCachedProductTranscript, confirmProductTranscript, importSharedProductTranscript, productSourcePath, readProductTranscript } from './product-transcription.mjs';
import { productTranscriptRange } from './product-transcript-range.mjs';
import { AUDIO_SEGMENT_POLICY, planAudioSegments, validateTranscriptCues } from './transcription-segments.mjs';
import { parseVtt, transcriptPath } from './transcripts.mjs';
import { readable } from './files.mjs';
import { analyzeTextStructure } from './text-structure.mjs';
import { createExistingAnalysisPublication } from './existing-analysis-publication.mjs';
import { openNewSharedProject, readSharedProjectOpen, refreshEmptySharedProject } from './shared-project-open.mjs';
import { importExistingTranscriptArtifact, readExistingTranscriptArtifact } from './existing-transcript-artifact.mjs';

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const sourceHash = value => createHash('sha256').update(value).digest('hex');
const actions = ['transcription', 'discovery', 'analysis'];
const cleanService = value => ({ enabled: value?.enabled === true, provider: String(value?.provider ?? ''), name: String(value?.name ?? value?.provider ?? '尚未配置'), model: String(value?.model ?? ''), endpoint: String(value?.endpoint ?? ''), ...(value?.error ? { error: String(value.error) } : {}) });
const serviceIdentity = value => ({ provider: value.provider, model: value.model, endpoint: value.endpoint });
const noCost = basis => ({ estimate: null, currency: null, uncertain: true, basis });

export function createProductWorkflow({ liveAnalysis, discovery, sharedAnalysis, analysisServices = async () => ({}), readTranscript = readProductTranscript, probeSource = probe, audioPolicy = AUDIO_SEGMENT_POLICY, authorizeTask = async () => {} } = {}) {
  const starting = new Map(), running = new Map(), adopting = new Set();
  const existingPublication = createExistingAnalysisPublication({ liveAnalysis, discovery, sharedAnalysis, importNormal: importDiscoveredShared });
  async function sourceFor(root, sourceId) {
    const { analysis } = await readProductAnalysis(root);
    const source = analysis.sources.find(item => item.id === sourceId);
    if (!source) throw new HttpError(404, '请选择工程中的直播视频');
    return { source, analysis };
  }
  async function fingerprint(root, source) {
    const path = await realpath(await productSourcePath(root, source.assetPath)), info = await stat(path);
    return { sourceId: source.id, assetPath: source.assetPath, durationMs: source.durationMs, path, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, ino: info.ino };
  }
  async function registerSource(root, body) {
    if (typeof body?.assetPath !== 'string' || !body.assetPath || body.assetPath.includes('\\')) throw new HttpError(400, '请选择工程中的视频文件');
    const assetPath = posix.normalize(body.assetPath);
    await productSourcePath(root, assetPath);
    const durationMs = Math.floor((await probeSource(root, assetPath)).duration * 1000);
    if (!Number.isFinite(durationMs) || durationMs <= 0) throw new HttpError(400, '无法读取视频时长');
    const result = await updateProductAnalysis(root, analysis => {
      const existing = analysis.sources.find(item => item.assetPath === assetPath);
      if (existing) {
        if (existing.durationMs === null) existing.durationMs = durationMs;
        else if (Math.abs(existing.durationMs - durationMs) > 1) throw new HttpError(409, '视频时长已变化，保留原工程结果，请先核对素材关联');
      } else {
        if (analysis.sources.some(item => item.id === assetPath)) throw new HttpError(409, '素材身份与已有来源冲突，保留原工程记录，请先核对素材');
        // A plain video already uses its asset path as the source-take identity.
        // Registering analysis metadata must not hide those saved private edits.
        analysis.sources.push({ id: assetPath, assetPath, durationMs });
      }
      return analysis;
    }, probeSource, { preserveHistory: true });
    return { ...result, source: result.analysis.sources.find(item => item.assetPath === assetPath) };
  }
  async function bindingFor(root, source) {
    try {
      const vttPath = transcriptPath(source.assetPath), body = await readFile(await readable(root, vttPath), 'utf8');
      const cues = validateTranscriptCues(parseVtt(body).lines, source.durationMs);
      return { kind: 'vtt', assetPath: source.assetPath, transcriptPath: vttPath, durationMs: source.durationMs, cueCount: cues.length, coverage: cues.map(cue => [cue.startMs, cue.endMs]), identity: hash({ source: await fingerprint(root, source), body }) };
    } catch { /* No valid local sidecar to associate. */ }
    try {
      const value = JSON.parse(await readFile(join(root, '.film', 'product-transcripts', `${sourceHash(source.id)}.json`), 'utf8'));
      const current = await fingerprint(root, source);
      if (value.status !== 'complete' || value.assetPath !== source.assetPath || value.fingerprint?.size !== current.size || value.fingerprint?.mtimeMs !== current.mtimeMs) return undefined;
      const cues = validateTranscriptCues(value.cues, source.durationMs);
      return { kind: 'cache', assetPath: source.assetPath, durationMs: source.durationMs, cueCount: cues.length, coverage: cues.map(cue => [cue.startMs, cue.endMs]), identity: hash({ source: current, value }) };
    } catch { return undefined; }
  }
  async function status(root, sourceId) {
    const { source, analysis } = await sourceFor(root, sourceId);
    const [live, split] = await Promise.all([liveAnalysis.view(root, sourceId), discovery.view(root, sourceId)]);
    const ready = analysis.intervals.some(item => item.sourceId === sourceId);
    const unapplied = split.status === 'complete' && split.proposal && !(analysis.discoveryApplied ?? []).some(item => item.sourceId === sourceId && item.runId === split.runId);
    const needsReview = hasSavedProductResult(analysis, sourceId) && (!ready || !!unapplied);
    const binding = live.transcription.status !== 'complete' ? await bindingFor(root, source) : undefined;
    let shared = await sharedAnalysis?.status(root, sourceId);
    if (shared?.mode === 'retry-required') {
      try {
        const recovery = await plan(root, { sourceId, action: shared.action, ...shared.scope, newVersion: shared.newVersion === true });
        if (recovery.shared?.taskKey === shared.taskKey && recovery.shared.recoverCached) shared = { ...shared, ...recovery.shared };
      } catch { /* Leave the durable uncertain status visible until input and company can be verified. */ }
    }
    if (shared?.mode === 'local-review' && live.transcription.status === 'complete') shared = { ...shared, mode: 'local-only', reason: '本机转写已核对，可继续本机拆品；人工接缝修正不共享，其他同事的转写仍需核对' };
    return { source, ready, needsReview, busy: starting.has(`${root}\0${sourceId}`) || running.has(`${root}\0${sourceId}`), phase: ready ? 'ready' : live.transcription.status === 'complete' ? 'discovery' : 'transcription', transcription: live.transcription, discovery: split, ...(binding ? { binding } : {}), ...(shared ? { shared } : {}) };
  }
  const sharedPublic = descriptor => descriptor ? Object.fromEntries(['mode', 'taskKey', 'status', 'reason', 'result', 'coordinationId', 'familyKey', 'newVersion', 'recoverCached'].filter(k => descriptor[k] !== undefined).map(k => [k, descriptor[k]])) : undefined;
  async function sharedFor(root, source, analysis, action, scope, rerun, newVersion = false) {
    if (!sharedAnalysis) return null;
    let transcript = null;
    try { transcript = await readTranscript(root, source); } catch (error) { if (action !== 'transcription') throw error; }
    const manual = (analysis.manualEdits ?? []).filter(edit => edit.action === 'manual-save' && edit.sourceIds.includes(source.id));
    const adjustedRange = scope && manual.some(edit => {
      const before = edit.before.intervals.find(i => i.id === scope.intervalId), after = edit.after.intervals.find(i => i.id === scope.intervalId);
      return (!before || !after || before.startMs !== after.startMs || before.endMs !== after.endMs || before.productId !== after.productId);
    });
    const localOnly = rerun ? '明确重新分析仅生成本机新版本，共享首版不变' : transcript?.localReconciled ? '人工确认或修改的转写仅用于本机分析，不上传共享底稿' : adjustedRange || (action === 'discovery' && manual.length) ? '人工修改只保存在本机，新分析不会覆盖共享首版' : undefined;
    const selectedTranscript = action === 'analysis' ? productTranscriptRange(transcript, scope, source.durationMs) : null;
    const data = action === 'transcription' ? null : selectedTranscript ? { cues: selectedTranscript.segments, cueIndices: selectedTranscript.cueIndices } : transcript?.cues;
    const contract = action === 'transcription' ? { service: serviceIdentity(cleanService((await analysisServices()).transcription)), audioPolicy, audio: 'mp3-16k-mono-32k' } : action === 'analysis' ? await liveAnalysis.sharedContract() : await discovery.sharedContract();
    return sharedAnalysis.prepare(root, source, { action, scope, data, contract, localOnly, newVersion });
  }
  async function applyFirstDiscovery(root, sourceId, before) {
    const result = await discovery.view(root, sourceId);
    if (result.status !== 'complete' || result.stale !== false || hasSavedProductResult(before, sourceId)) return;
    const latest = (await readProductAnalysis(root)).analysis;
    if (!hasSavedProductResult(latest, sourceId)) await discovery.apply(root, { sourceId, runId: result.runId, expected: latest, replaceReviewed: false });
  }
  async function importShared(root, source, descriptor, scope) {
    const saved = await sharedAnalysis.read(root, descriptor), ref = descriptor.result;
    if (descriptor.action === 'transcription') {
      if (saved.payload.kind === 'original-asr-segments') await importExistingTranscriptArtifact(root, source, saved.payload, ref);
      else await importSharedProductTranscript(root, source, saved.payload, ref);
    }
    else if (descriptor.action === 'discovery') {
      const before = (await readProductAnalysis(root)).analysis;
      await discovery.importShared(root, source.id, saved.payload, ref);
      await applyFirstDiscovery(root, source.id, before);
    } else await liveAnalysis.importShared(root, source.id, scope, saved.payload, ref);
  }
  /** Read a completed normal result through the existing importers, with no provider entry point. */
  async function importDiscoveredShared(root, selection, body) {
    const { source, snapshot, result } = selection, payload = snapshot.payload;
    if (snapshot.action === 'transcription') {
      if (payload.kind === 'original-asr-segments') {
        const imported = await importExistingTranscriptArtifact(root, source, payload, result, { expectedSourceFingerprint: selection.localSourceFingerprint });
        return { ...imported, needsReview: imported.reviewRequired };
      }
      await importSharedProductTranscript(root, source, payload, result);
      return { imported: true };
    }
    const transcript = await readTranscript(root, source);
    if (snapshot.action === 'discovery') {
      if (hash(transcript?.cues) !== snapshot.dataHash) throw new HttpError(409, '共享拆品输入与当前字幕不同，已有修改保留');
      const imported = await discovery.importShared(root, source.id, payload, result);
      return { imported: true, runId: imported.runId, count: imported.proposal?.intervals.length ?? 0 };
    }
    const reference = payload.association;
    const { analysis } = await readProductAnalysis(root), split = await discovery.view(root, source.id);
    if (!reference || split.runId !== `shared-${reference.discoverySha}` || !(analysis.discoveryApplied ?? []).some(item => item.sourceId === source.id && item.runId === split.runId)) throw new HttpError(409, '话术缺少已采用的原商品拆分依据，请在已有结果中核对；未按时间重叠猜测商品');
    const products = analysis.products.filter(p => p.key === reference.productKey && p.sourceIds.includes(source.id));
    const ranges = analysis.intervals.filter(i => i.sourceId === source.id && products.some(p => p.id === i.productId) && i.firstCue === reference.firstCue && i.lastCue === reference.lastCue && i.startMs === snapshot.scope?.startMs && i.endMs === snapshot.scope?.endMs);
    if (ranges.length !== 1) throw new HttpError(409, '话术对应商品段有歧义或已修改，未自动归属');
    const range = ranges[0], scope = { intervalId: range.id, productId: range.productId, startMs: range.startMs, endMs: range.endMs, lectureOnly: true };
    const selected = productTranscriptRange(transcript, scope, source.durationMs);
    if (hash({ cues: selected.segments, cueIndices: selected.cueIndices }) !== snapshot.dataHash) throw new HttpError(409, '共享话术输入与当前字幕不同，已有修改保留');
    const imported = await liveAnalysis.importShared(root, source.id, scope, payload, result, { expectedAnalysis: body.expectedAnalysis });
    return { imported: true, count: payload.candidates.length, analysis: imported.committedAnalysis };
  }
  async function sharedScopeAssociation(root, source, analysis, scope) {
    const split = await discovery.view(root, source.id);
    const range = split.proposal?.intervals.find(i => i.id === scope.intervalId && i.productId === scope.productId && i.startMs === scope.startMs && i.endMs === scope.endMs);
    if (!range || !(analysis.discoveryApplied ?? []).some(item => item.sourceId === source.id && item.runId === split.runId)) return undefined;
    const descriptor = await sharedFor(root, source, analysis, 'discovery', null, false);
    if (descriptor?.mode !== 'reuse') return undefined;
    const saved = await sharedAnalysis.read(root, descriptor);
    if (split.runId !== `shared-${descriptor.result.sha256}`) {
      const original = await discovery.exportShared(root, source.id);
      const fields = value => ({ completed: value.completed, maxBytes: value.maxBytes, contextCues: value.contextCues, version: value.version });
      if (hash(fields(original)) !== hash(fields(saved.payload))) return undefined;
    }
    const product = split.proposal.products.find(p => p.id === range.productId);
    return { discoverySha: descriptor.result.sha256, productKey: product.key, firstCue: range.firstCue, lastCue: range.lastCue };
  }
  async function publishResult(root, source, current, descriptor, attemptId, recover = false) {
    const latest = await sharedFor(root, source, (await readProductAnalysis(root)).analysis, current.action, current.scope, false, current.newVersion);
    if (!latest || latest.sourceIdentity !== descriptor.sourceIdentity || latest.dataHash !== descriptor.dataHash || latest.inputHash !== descriptor.inputHash) throw new HttpError(409, '素材、转写、范围或服务配置已变化，结果不会发布成旧直播的共享底稿');
    let payload;
    if (current.action === 'transcription') {
      const transcript = await readTranscript(root, source);
      if (!transcript || transcript.localReconciled) throw new HttpError(409, '人工转写不能作为共享 AI 原始底稿');
      payload = { cues: transcript.cues, words: transcript.words ?? [] };
    } else payload = await (current.action === 'analysis' ? liveAnalysis.exportShared(root, source.id, current.intervalId, current.newVersion ? descriptor.taskKey : undefined) : discovery.exportShared(root, source.id, current.newVersion ? descriptor.taskKey : undefined));
    if (current.action === 'analysis') payload.association = await sharedScopeAssociation(root, source, (await readProductAnalysis(root)).analysis, current.scope);
    payload.count = current.action === 'transcription' ? payload.cues.length : current.action === 'analysis' ? payload.candidates.length : (await discovery.view(root, source.id)).proposal?.intervals.length ?? 0;
    if (recover) await sharedAnalysis.recover(root, descriptor, payload, current.service);
    else await sharedAnalysis.complete(root, descriptor, attemptId, payload, current.service);
  }
  async function plan(root, request) {
    const { action, sourceId } = request;
    if (!actions.includes(action)) throw new HttpError(400, '请选择转写、商品拆分或单段结构分析');
    const { source, analysis } = await sourceFor(root, sourceId);
    const newVersion = request.newVersion === true || request.newVersion === 'true';
    const rerun = request.rerun === true || request.rerun === 'true';
    const retry = !rerun && (request.retry === true || request.retry === 'true');
    const publicServices = await analysisServices();
    const service = cleanService(action === 'transcription' ? publicServices.transcription : publicServices.text);
    const sourceInput = await fingerprint(root, source);
    let cached = false, totalRequests = 0, reusedRequests = 0, transcriptSegments = 0, retryRequired = false, inputIdentity, generation, scope, audioSegments, windows, visual, error, localReviewRequired = false;
    if (action === 'transcription') {
      const live = await liveAnalysis.view(root, sourceId);
      generation = { id: live.transcription.confirmationId ?? null, status: live.transcription.status };
      cached = live.transcription.status === 'complete';
      retryRequired = live.transcription.status === 'failed' || live.transcription.status === 'running';
      localReviewRequired = live.transcription.code === 'ASR_BOUNDARY_REVIEW';
      const binding = !cached && await bindingFor(root, source);
      if (binding) error = '检测到待关联的同源字幕，请先核对来源后复用；未发送音频';
      if (localReviewRequired) error = live.transcription.error;
      audioSegments = planAudioSegments(source.durationMs, audioPolicy);
      totalRequests = audioSegments.length;
      reusedRequests = cached ? totalRequests : 0;
      if (!cached) {
        try {
          const saved = JSON.parse(await readFile(join(root, '.film', 'product-transcripts', `${sourceHash(source.id)}.json.segments.json`), 'utf8'));
          const old = JSON.parse(await readFile(join(root, '.film', 'product-transcripts', `${sourceHash(source.id)}.json`), 'utf8'));
          if (old.sourceId === source.id && old.assetPath === source.assetPath && ['size', 'mtimeMs', 'ctimeMs', 'path'].every(field => old.fingerprint?.[field] === sourceInput[field]) && Array.isArray(saved.segments) && saved.segments.length === audioSegments.length && saved.segments.every((item, index) => ['id', 'startMs', 'endMs', 'coreStartMs', 'coreEndMs'].every(key => item[key] === audioSegments[index][key]))) reusedRequests = saved.segments.filter(item => item.status === 'complete').length;
        } catch { /* No completed segmented upload to reuse. */ }
      }
      inputIdentity = hash({ sourceInput, policy: audioPolicy, audio: 'mp3-16k-mono-32k' });
    } else if (action === 'discovery') {
      const prepared = await discovery.plan(root, sourceId, { retry, rerun: rerun || newVersion });
      ({ cached, totalRequests, reusedRequests, transcriptSegments, retryRequired, inputIdentity, generation, windows } = prepared);
      if (prepared.rerunRequired && !rerun && !newVersion) error = '来源或配置已变化，请明确重新拆品';
    } else {
      const interval = analysis.intervals.find(item => item.id === request.intervalId && item.productId === request.productId && item.sourceId === sourceId);
      if (!interval) throw new HttpError(409, '请先选择一个有效商品讲解段');
      scope = { sourceId, productId: interval.productId, intervalId: interval.id, startMs: interval.startMs, endMs: interval.endMs, lectureOnly: true };
      const live = await liveAnalysis.view(root, sourceId, interval.id, interval.productId, scope);
      generation = { id: live.analysis.confirmationId ?? live.analysis.attemptId ?? null, status: live.analysis.status };
      inputIdentity = live.analysisPlan?.inputIdentity;
      totalRequests = live.analysisPlan?.requestCount ?? 0; transcriptSegments = live.analysisPlan?.transcriptSegments ?? 0;
      visual = live.analysisPlan?.visual;
      totalRequests += visual?.requestCount ?? 0;
      cached = live.analysis.status === 'complete' && live.analysis.stale === false && !rerun && !newVersion;
      retryRequired = live.analysis.status === 'failed' || live.analysis.status === 'running';
      reusedRequests = cached ? totalRequests : retry && live.analysis.cacheIdentity === inputIdentity ? live.analysis.progress?.completedWindows ?? 0 : 0;
      error = live.analysisPlan?.error;
      if (!inputIdentity) error ??= '当前商品段转写或模型配置不可用';
    }
    const sharedDescriptor = await sharedFor(root, source, analysis, action, scope, rerun, newVersion);
    if (newVersion && sharedDescriptor?.mode === 'retry-required' && await sharedAnalysis.recoverable(root, sharedDescriptor)) {
      try {
        if (action === 'analysis') await liveAnalysis.exportShared(root, sourceId, scope.intervalId, sharedDescriptor.taskKey);
        else if (action === 'discovery') await discovery.exportShared(root, sourceId, sharedDescriptor.taskKey);
        else throw Error('ASR new version unavailable');
        cached = true;
      } catch { /* No completed draft for this exact version; keep explicit retry. */ }
    }
    if (cached && sharedDescriptor?.mode === 'retry-required' && await sharedAnalysis.recoverable(root, sharedDescriptor)) Object.assign(sharedDescriptor, { mode: 'publish-pending', recoverCached: true, reason: '本机分析已完成，补保存原任务不会重新请求模型' });
    const shared = sharedPublic(sharedDescriptor);
    if (newVersion && (action === 'transcription' || !sharedDescriptor || sharedDescriptor.mode === 'local-only')) error = action === 'transcription' ? '当前支持复用与采用已有完整转写版本，尚未接通强制生成新转写' : '本机人工输入不能发布共享新版，请使用未修改的共享底稿';
    if (shared?.mode === 'reuse') { cached = true; reusedRequests = totalRequests; retryRequired = false; error = undefined; }
    if (shared?.mode === 'busy') error = shared.reason;
    if (shared?.mode === 'retry-required') retryRequired = true;
    if (shared?.mode === 'publish-pending') { cached = true; reusedRequests = totalRequests; retryRequired = false; error = undefined; }
    if (shared?.mode === 'local-review') { reusedRequests = totalRequests; localReviewRequired = true; error = shared.reason; }
    if (visual && cached) visual = { ...visual, requestCount: 0 };
    const requestCount = Math.max(0, totalRequests - reusedRequests);
    const cost = cached ? { estimate: 0, currency: null, uncertain: false, basis: shared?.mode === 'reuse' ? '复用首次共享结果，不发起新模型请求' : '复用工程内已有结果，不发起新服务请求' }
      : noCost(action === 'transcription' ? `按本次实际上传音频时长计费；音频采用 MP3、16kHz、单声道。未取得当前账号有效单价，无法可靠估价。含重叠的计划音频共 ${audioSegments.reduce((sum, item) => sum + item.endMs - item.startMs, 0) / 1000} 秒，已完成分段不重传。` : '按实际输入与输出 token 计费；当前没有可核验的账号有效单价与最终输出长度，无法可靠估价。请求次数按现有分窗计划计算。');
    if (!cached && visual?.requestCount) cost.basis += ` 另含 ${visual.requestCount} 次画面理解请求，最多发送 ${visual.maxImages} 张本次讲解抽帧拼图。`;
    return { identity: hash({ action, sourceId, inputIdentity, generation, service: serviceIdentity(service), retry, rerun, newVersion, shared, ...(visual ? { visual } : {}) }), action, sourceId, source: { assetPath: source.assetPath, durationMs: source.durationMs }, ...(scope ? { scope, productId: scope.productId, intervalId: scope.intervalId } : {}), retry, rerun, newVersion, service, enabled: (cached || service.enabled) && !error && !localReviewRequired, cached, requestCount, totalRequests, reusedRequests, transcriptSegments, retryRequired, inputIdentity, ...(shared ? { shared } : {}), ...(audioSegments ? { audioSegments } : {}), ...(windows ? { windows } : {}), ...(visual ? { visual } : {}), cost, ...(error ? { error } : {}), ...(localReviewRequired ? { localReviewRequired } : {}) };
  }
  async function executeInner(root, body) {
    if (body?.confirmed !== true || !body.plan || typeof body.plan.identity !== 'string') throw new HttpError(400, '请确认本次服务、发送内容及请求费用');
    const requested = body.plan;
    const current = await plan(root, requested);
    if (current.identity !== requested.identity) throw new HttpError(409, '素材、转写、范围或服务配置已变化，请重新核对本次请求');
    if (!current.enabled) throw new HttpError(403, current.error || current.service.error || '服务尚未配置，未发送请求');
    if (current.retryRequired && (!(current.retry || current.rerun) || body.retryAcknowledged !== true)) throw new HttpError(409, '上次请求失败或提交状态不确定，请核查记录并明确重试或重新分析');
    const { sourceId, action } = current;
    const { source, analysis } = await sourceFor(root, sourceId);
    const descriptor = await sharedFor(root, source, analysis, action, current.scope, current.rerun, current.newVersion);
    if (current.shared?.recoverCached) { await publishResult(root, source, current, descriptor, descriptor.attemptId, true); return { plan: current, state: await status(root, sourceId) }; }
    if (descriptor?.mode === 'publish-pending') return { plan: current, state: await publishShared(root, { sourceId, taskKey: descriptor.taskKey, confirmed: true }) };
    if (descriptor?.mode === 'reuse') {
      if (!current.newVersion) await importShared(root, source, descriptor, current.scope);
      return { plan: current, state: await status(root, sourceId) };
    }
    if (current.cached && descriptor?.mode !== 'publish') return { plan: current, state: await status(root, sourceId) };
    await authorizeTask();
    if ((await plan(root, requested)).identity !== current.identity) throw new HttpError(409, '素材或服务在确认后发生变化，未发送请求');
    const key = `${root}\0${sourceId}`;
    const sharedAttempt = descriptor && ['publish', 'retry-required'].includes(descriptor.mode) ? await sharedAnalysis.acquire(descriptor, { retryAcknowledged: body.retryAcknowledged === true }) : null;
    if (current.cached) {
      await publishResult(root, source, current, descriptor, sharedAttempt.attemptId);
      return { plan: current, state: await status(root, sourceId) };
    }
    let completion;
    try {
    if (sharedAttempt) {
      const latest = await sharedFor(root, source, (await readProductAnalysis(root)).analysis, action, current.scope, false, current.newVersion);
      if (!latest || latest.sourceIdentity !== descriptor.sourceIdentity || latest.dataHash !== descriptor.dataHash || latest.inputHash !== descriptor.inputHash) throw new HttpError(409, '共享领取后输入发生变化，未发送模型请求');
    }
    if (action === 'transcription') {
      const source = (await sourceFor(root, sourceId)).source;
      const input = await fingerprint(root, source);
      await liveAnalysis.startTranscription(root, sourceId, current.retry && body.retryAcknowledged === true, serviceIdentity(current.service), `${input.size}:${input.mtimeMs}:${input.ctimeMs}:${input.ino}`);
      completion = liveAnalysis.wait(root, sourceId);
    } else if (action === 'analysis') {
      await liveAnalysis.startAnalysis(root, { ...current.scope, sourceId, rerun: current.rerun || current.newVersion, ...(current.newVersion ? { draftKey: descriptor.taskKey } : {}), retryFailed: current.retry, expectedInputIdentity: current.inputIdentity, ...(current.visual?.enabled && current.visual.requestCount ? { expectedVisualIdentity: current.visual.identity } : {}) });
      completion = liveAnalysis.wait(root, sourceId);
    } else {
      const before = (await readProductAnalysis(root)).analysis;
      const localRetry = current.retry && ['failed', 'running'].includes((await discovery.view(root, sourceId)).status);
      await discovery.start(root, { sourceId, retry: localRetry, rerun: current.rerun || current.newVersion, ...(current.newVersion ? { draftKey: descriptor.taskKey } : {}), expectedInputIdentity: current.inputIdentity });
      completion = (async () => {
        await discovery.wait(root, sourceId);
        if (!current.newVersion) await applyFirstDiscovery(root, sourceId, before);
      })();
    }
    } catch (error) { if (sharedAttempt) await sharedAnalysis.fail(descriptor, sharedAttempt.attemptId).catch(() => {}); throw error; }
    if (sharedAttempt) completion = Promise.resolve(completion).then(async () => {
      try {
        const reviewRequired = action === 'transcription' && (await liveAnalysis.view(root, sourceId)).transcription.code === 'ASR_BOUNDARY_REVIEW';
        if (reviewRequired) {
          let artifact;
          try { artifact = await readExistingTranscriptArtifact(root, source); } catch { /* Preserve the existing review lock when raw segments are not complete/verified. */ }
          if (artifact) await sharedAnalysis.complete(root, descriptor, sharedAttempt.attemptId, { ...artifact.payload, count: artifact.summary.rawCueCount }, current.service);
          else await sharedAnalysis.markReview(descriptor, sharedAttempt.attemptId);
        }
        else await publishResult(root, source, current, descriptor, sharedAttempt.attemptId);
      }
      catch { if (!['publish-pending', 'local-review'].includes((await sharedAnalysis.status(root, sourceId))?.mode)) await sharedAnalysis.fail(descriptor, sharedAttempt.attemptId); }
    });
    const settled = Promise.resolve(completion).catch(() => {}).finally(() => { if (running.get(key)?.promise === settled) running.delete(key); });
    running.set(key, { identity: current.identity, promise: settled });
    return { plan: current, state: await status(root, sourceId) };
  }
  async function execute(root, body) {
    if (body?.confirmed !== true || !actions.includes(body.plan?.action) || typeof body.plan?.sourceId !== 'string') throw new HttpError(400, '请先确认本阶段请求');
    const key = `${root}\0${body.plan.sourceId}`, identity = body.plan.identity;
    if (adopting.has(key)) throw new HttpError(409, '当前正在采用共享版本，请等待保存完成');
    const pending = starting.get(key);
    if (pending) { if (pending.identity !== identity) throw new HttpError(409, '此素材已有其他任务'); return pending.promise; }
    const active = running.get(key);
    if (active) { if (active.identity !== identity) throw new HttpError(409, '此素材已有其他任务'); return { state: await status(root, body.plan.sourceId) }; }
    const promise = executeInner(root, body).finally(() => starting.delete(key));
    starting.set(key, { identity, promise }); return promise;
  }
  async function bindTranscript(root, body) {
    if (body?.sourceConfirmed !== true || !['vtt', 'cache'].includes(body.kind)) throw new HttpError(400, '请先核对字幕来源、时长和覆盖范围');
    const { source } = await sourceFor(root, body.sourceId), binding = await bindingFor(root, source);
    if (!binding || binding.kind !== body.kind || binding.identity !== body.identity) throw new HttpError(409, '素材或字幕已变化，请重新核对');
    await (body.kind === 'vtt' ? confirmProductTranscript : confirmCachedProductTranscript)(root, source, { sourceConfirmed: true, durationMs: source.durationMs });
    return status(root, source.id);
  }
  async function publishShared(root, body) {
    if (body?.confirmed !== true || !sharedAnalysis) throw new HttpError(400, '请确认补保存共享结果');
    const { source, analysis } = await sourceFor(root, body.sourceId);
    const pending = await sharedAnalysis.status(root, body.sourceId);
    if (pending?.taskKey === body.taskKey && pending.mode === 'retry-required') {
      const recovery = await plan(root, { sourceId: source.id, action: pending.action, ...pending.scope, newVersion: pending.newVersion === true });
      if (recovery.shared?.recoverCached) {
        const descriptor = await sharedFor(root, source, analysis, recovery.action, recovery.scope, false, recovery.newVersion);
        await publishResult(root, source, recovery, descriptor, descriptor.attemptId, true);
        return status(root, source.id);
      }
    }
    await sharedAnalysis.publish(root, body.sourceId, body.taskKey);
    return status(root, body.sourceId);
  }
  async function sharedVersions(root, sourceId) {
    const { source, analysis } = await sourceFor(root, sourceId);
    if (!sharedAnalysis) return { groups: [] };
    const applied = [...(analysis.discoveryApplied ?? [])];
    for (const pending of await sharedAnalysis.pendingAdoptions(root, sourceId)) {
      try {
        if (pending.descriptor.action === 'analysis') {
          const scope = pending.descriptor.localScope, live = await liveAnalysis.view(root, sourceId, scope.intervalId, scope.productId, scope);
          if (live.analysis.currentRunId === pending.runId) applied.push({ sourceId, runId: pending.runId });
        } else if (pending.descriptor.action === 'transcription') {
          const transcript = await readTranscript(root, source);
          if (!transcript?.localReconciled && hash({ cues: transcript?.cues, words: transcript?.words ?? [] }) === hash(pending.snapshot.payload)) applied.push({ sourceId, runId: pending.runId });
        }
      } catch { /* A pending adoption stays pinned until its effective results can be verified. */ }
    }
    await sharedAnalysis.reconcileAdoptions(root, sourceId, applied, source);
    return sharedAnalysis.versions(root, sourceId);
  }
  async function adoptShared(root, body) {
    const key = `${root}\0${body?.sourceId}`;
    if (adopting.has(key) || starting.has(key) || running.has(key)) throw new HttpError(409, '当前直播正在保存或分析，请稍后采用新版');
    adopting.add(key);
    try { return await adoptSharedReserved(root, body); } finally { adopting.delete(key); }
  }
  async function adoptSharedReserved(root, body) {
    if (body?.confirmed !== true || !sharedAnalysis || !actions.includes(body.action)) throw new HttpError(400, '请明确确认采用共享版本');
    const key = `${root}\0${body.sourceId}`;
    if (starting.has(key) || running.has(key)) throw new HttpError(409, '当前直播任务未结束，请稍后采用新版');
    const { source, analysis } = await sourceFor(root, body.sourceId);
    const catalog = await sharedVersions(root, source.id);
    const group = catalog.groups.find(g => g.action === body.action && (g.intervalId ?? null) === (body.intervalId ?? null));
    if (!group) throw new HttpError(409, '此直播或商品段没有可采用的共享版本');
    const selection = await sharedAnalysis.adoption(root, source.id, group.familyKey, body.versionTaskKey, body.expectedCurrentSha);
    await sharedAnalysis.validateSource(root, source, selection.descriptor);
    const transcript = body.action !== 'transcription' ? await readTranscript(root, source) : null;
    const selected = body.action === 'analysis' ? productTranscriptRange(transcript, group.scope, source.durationMs) : null;
    const data = body.action === 'transcription' ? null : selected ? { cues: selected.segments, cueIndices: selected.cueIndices } : transcript.cues;
    if (hash(data) !== selection.snapshot.dataHash) throw new HttpError(409, '新版输入与当前转写或商品范围不同；请保留人工修改并先核对');
    const manual = (analysis.manualEdits ?? []).some(edit => edit.action === 'manual-save' && edit.sourceIds.includes(source.id));
    if (body.action === 'discovery') {
      const imported = await discovery.importShared(root, source.id, selection.snapshot.payload, selection.result, { adopt: true });
      if (manual) {
        await sharedAnalysis.pendingAdoption(root, selection, imported.runId);
        return { needsReview: true, runId: imported.runId, reason: '新版拆品建议待核对；人工修改和旧绑定保留，请核对差异后明确应用', state: await status(root, source.id) };
      }
      await sharedAnalysis.pendingAdoption(root, selection, imported.runId);
      await discovery.apply(root, { sourceId: source.id, runId: imported.runId, expected: analysis, replaceReviewed: true });
    } else if (body.action === 'analysis') {
      const baselinePayload = selection.currentSnapshot.payload;
      const baseline = await analyzeTextStructure({ sourceId: source.id, productId: group.productId, intervalId: group.intervalId, cues: selected.segments, rangeStartMs: group.scope.startMs, rangeEndMs: group.scope.endMs, version: baselinePayload.version, client: async () => ({ candidates: baselinePayload.candidates.map(c => ({ firstCue: selected.cueIndices.indexOf(c.cueRange[0]), lastCue: selected.cueIndices.indexOf(c.cueRange[1]), tags: c.tags, details: c.details })), issues: baselinePayload.issues }) });
      for (const candidate of baseline.candidates) candidate.cueRange = candidate.cueRange.map(index => selected.cueIndices[index]);
      const structure = candidates => candidates.map(c => ({ cueRange: c.cueRange, tags: [...c.tags].sort(), details: c.details, text: c.text, startMs: c.startMs, endMs: c.endMs })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      const localStructureChanged = hash(structure(analysis.candidates.filter(c => c.intervalId === group.intervalId))) !== hash(structure(baseline.candidates));
      if (manual || localStructureChanged) return { needsReview: true, reason: '本直播存在人工商品或结构修改，暂不自动合并新版结构；旧结果和修改已保留' };
      await sharedAnalysis.pendingAdoption(root, selection, `shared-${selection.result.sha256}`);
      await liveAnalysis.importShared(root, source.id, group.scope, selection.snapshot.payload, selection.result, { adopt: true });
    } else {
      const existing = await readTranscript(root, source);
      if (existing?.localReconciled) return { needsReview: true, reason: '字幕有人工接缝修正，不能用共享转写静默覆盖；当前版本保留' };
      await sharedAnalysis.pendingAdoption(root, selection, `transcript-${selection.result.sha256}`);
      await importSharedProductTranscript(root, source, selection.snapshot.payload, selection.result, { adopt: true });
    }
    await sharedAnalysis.commitAdoption(root, selection);
    return { adopted: true, state: await status(root, source.id), ...(body.action === 'transcription' ? { warning: '转写已变化，现有拆品和结构可能需要核对或明确重新分析；未自动请求模型' } : {}) };
  }
  const route = async (req, res, root, rest) => {
    if (!rest.startsWith('product-workflow/')) return false;
    const params = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
    if (req.method === 'GET' && rest === 'product-workflow/shared-open') { json(res, 200, { sharedRead: await readSharedProjectOpen(root) }); return true; }
    if (req.method === 'GET' && rest === 'product-workflow/existing-results') { json(res, 200, await existingPublication.inventory(root, params.sourceId)); return true; }
    if (req.method === 'GET' && rest === 'product-workflow/shared-history') { json(res, 200, await existingPublication.catalog(root, params.sourceId)); return true; }
    if (req.method === 'GET' && rest === 'product-workflow/shared-history-preview') { json(res, 200, await existingPublication.preview(root, params)); return true; }
    if (req.method === 'POST' && ['existing-publication-plan', 'publish-existing', 'import-history'].some(suffix => rest === `product-workflow/${suffix}`)) {
      const body = await readJson(req), operation = rest.endsWith('/existing-publication-plan') ? existingPublication.plan : rest.endsWith('/publish-existing') ? existingPublication.publish : existingPublication.importResult;
      json(res, 200, await operation(root, body)); return true;
    }
    if (req.method === 'GET' && rest === 'product-workflow/status') { json(res, 200, await status(root, params.sourceId)); return true; }
    if (req.method === 'GET' && rest === 'product-workflow/plan') { json(res, 200, await plan(root, params)); return true; }
    if (req.method === 'GET' && rest === 'product-workflow/shared-versions') { json(res, 200, await sharedVersions(root, params.sourceId)); return true; }
    if (req.method === 'POST' && rest === 'product-workflow/adopt-shared') { json(res, 200, await adoptShared(root, await readJson(req))); return true; }
    if (req.method === 'POST' && rest === 'product-workflow/publish-shared') { json(res, 200, await publishShared(root, await readJson(req))); return true; }
    if (req.method === 'POST' && ['product-workflow/source', 'product-workflow/execute', 'product-workflow/bind-transcript'].includes(rest)) {
      const body = await readJson(req);
      json(res, 200, await (rest.endsWith('/source') ? registerSource : rest.endsWith('/execute') ? execute : bindTranscript)(root, body)); return true;
    }
    return false;
  };
  return Object.assign(route, { openSharedProject: (root, input) => openNewSharedProject(root, input, { registerSource, publication: existingPublication, discovery }), refreshSharedProject: root => refreshEmptySharedProject(root, { registerSource, publication: existingPublication, discovery }), registerSource, status, plan, execute, bindTranscript, publishShared, sharedVersions, adoptShared, busy: root => [...starting.keys(), ...running.keys()].some(key => key.startsWith(`${root}\0`)), wait: async (root, sourceId) => { const key = `${root}\0${sourceId}`; await starting.get(key)?.promise; await running.get(key)?.promise; } });
}
