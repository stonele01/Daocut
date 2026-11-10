/** Existing AI artifacts only. No provider, task-start or generic workflow executor is available here. */
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { HttpError } from './http.mjs';
import { readProductAnalysis } from './product-analysis.mjs';
import { productSourcePath, readProductTranscript } from './product-transcription.mjs';
import { sharedHash } from './shared-analysis.mjs';
import { structureTranscriptHash } from './live-analysis.mjs';
import { readExistingTranscriptArtifact, readHistoricalTranscriptInput, extractOriginalTranscriptScope } from './existing-transcript-artifact.mjs';
const hashId = id => createHash('sha256').update(id).digest('hex');
const read = async path => { try { return JSON.parse(await readFile(path, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw new HttpError(409, '已有分析文件无法完整读取，没有重新分析'); } };
const noCache = () => new HttpError(409, '没有可发布的完整原始 AI 结果，没有重新分析');
const pick = (value, keys) => Object.fromEntries(keys.filter(k => value?.[k] !== undefined).map(k => [k, value[k]]));
const receipt = value => value ? pick(value, ['provider', 'model', 'requestId', 'httpStatus', 'status']) : undefined;
const details = value => pick(value, ['subtypes', 'reason', 'evidence', 'context', 'repetition', 'review']);
const evidence = values => (values ?? []).map(v => typeof v === 'string' ? v : pick(v, ['cue', 'text', 'startMs', 'endMs']));
function originalProposal(value) {
  const range = item => ({ ...pick(item, ['id', 'sourceId', 'productId', 'startMs', 'endMs', 'firstCue', 'lastCue', 'windowIndices', 'reason', 'review', 'origin', 'discoveryRunId', 'kind']), evidence: evidence(item.evidence) });
  return { ...pick(value, ['runId', 'sourceId', 'version', 'issues', 'windows']),
    products: value.products.map(p => ({ ...pick(p, ['id', 'key', 'name', 'variant', 'sourceIds', 'identityUncertain', 'review', 'origin', 'discoveryRunId']), evidence: evidence(p.evidence), aliases: (p.aliases ?? []).map(a => ({ ...pick(a, ['name', 'reason']), evidence: evidence(a.evidence) })), mergeEvidence: (p.mergeEvidence ?? []).map(a => ({ reason: a.reason, evidence: evidence(a.evidence) })) })),
    intervals: value.intervals.map(range), unassigned: (value.unassigned ?? []).map(range) };
}
const bounds = value => ({ startMs: value.startMs, endMs: value.endMs });
async function inputProvenance(root, source, saved, scope) {
  const output = { inputHashKind: 'whole-transcript-with-words-v1', inputStatus: 'historical-unverified' };
  try {
    const transcript = await readProductTranscript(root, source);
    if (!saved.transcriptHash || structureTranscriptHash(transcript) !== saved.transcriptHash) return output;
    const selected = await readHistoricalTranscriptInput(root, source, scope);
    Object.assign(output, { inputStatus: 'verified-local-snapshot', scopeInputHash: selected.hash, scopeInputOrigin: selected.origin });
    try { const raw = await readExistingTranscriptArtifact(root, source), original = extractOriginalTranscriptScope(raw.payload, scope); output.originalAsrMatch = original.hash === selected.hash; } catch { output.originalAsrMatch = null; }
  } catch { /* A historical result remains viewable without claiming its old input can be reconstructed. */ }
  return output;
}
export function createExistingAnalysisPublication({ sharedAnalysis: shared, liveAnalysis, discovery, importNormal } = {}) {
  async function sourceFor(root, id) { const { analysis } = await readProductAnalysis(root), source = analysis.sources.find(s => s.id === id); if (!source) throw new HttpError(404, '来源不存在'); return { source, analysis }; }
  const completedCount = (catalog, payload) => catalog?.provenance?.kind !== 'shared-workflow-v1' ? catalog?.count : Number.isSafeInteger(payload.count) && payload.count >= 0 ? payload.count : payload.cues?.length ?? payload.candidates?.length ?? payload.segments?.reduce((n, part) => n + (part.cues?.length ?? 0), 0) ?? 0;
  async function artifacts(root, source, warnings = []) {
    const results = [];
    const live = await read(join(root, '.film/live-analysis', `${hashId(source.id)}.json`));
    for (const [runId, attempt] of Object.entries(live?.attempts ?? {})) {
      const saved = [...Object.values(live.analyses ?? {}), ...Object.values(live.results ?? {})].find(s => s.attemptId === runId && s.status === 'complete');
      if (!saved || attempt.status !== 'complete' || !attempt.windows?.length || attempt.windows.some(w => w.status !== 'complete' || !Array.isArray(w.output?.candidates))) continue;
      const candidates = [], seen = new Set();
      for (const w of attempt.windows) for (const c of w.output.candidates) {
        if (!Number.isFinite(c.startMs) || !Number.isFinite(c.endMs) || c.startMs < saved.rangeStartMs || c.endMs > saved.rangeEndMs || c.endMs <= c.startMs || typeof c.text !== 'string' || !Array.isArray(c.tags)) throw noCache();
        const item = { startMs: c.startMs, endMs: c.endMs, text: c.text, tags: c.tags, details: details(c.details ?? {}), cueRange: c.cueRange }, key = sharedHash([item.cueRange ?? bounds(item), [...item.tags].sort()]);
        if (!seen.has(key)) { seen.add(key); candidates.push(item); }
      }
      const scope = { startMs: saved.rangeStartMs, endMs: saved.rangeEndMs };
      const provenance = { kind: 'historical-ai-output', rangeOrigin: 'original-analysis-input', model: receipt(attempt.windows.find(w => w.receipt)?.receipt)?.model ?? null, inputRevision: saved.transcriptHash ?? null, originalCacheIdentity: saved.cacheIdentity ?? null, ...(await inputProvenance(root, source, saved, scope)), warning: '原分析输入范围仅作为历史依据，不代表自动商品切点，不修改同事商品范围' };
      results.push({ action: 'analysis', runId, intervalId: saved.intervalId, scope, count: candidates.length, provenance, proof: saved.sourceFingerprint, payload: { version: 1, kind: 'historical-ai-structure', scope, candidates, issues: saved.issues ?? [], originalRunId: runId, provenance, receipts: attempt.windows.map(w => receipt(w.receipt)).filter(Boolean) } });
    }
    const discoveryDir = join(root, '.film/product-discovery');
    for (const name of await readdir(discoveryDir).catch(e => { if (e.code === 'ENOENT') return []; throw e; })) {
      if (!/^[a-f0-9]+\.json$/.test(name)) continue;
      const state = await read(join(discoveryDir, name)); if (state?.sourceId !== source.id) continue;
      for (const run of state.runs ?? []) if (run.status === 'complete' && run.proposal && Array.isArray(run.completed) && run.completed.length) {
        const provenance = { kind: 'original-ai-discovery', originalInputHash: run.inputHash ?? null, originalContractHash: run.contractHash ?? null, inputStatus: 'historical-unverified', warning: '这是当时保存的 AI 原始建议；原输入可能包含本机字幕核对，不声明与同事当前字幕一致' };
        results.push({ action: 'discovery', runId: run.id, scope: null, count: run.proposal.intervals?.length ?? 0, provenance, proof: run.fingerprint, payload: { version: 1, kind: 'historical-ai-discovery', proposal: originalProposal(run.proposal), originalRunId: run.id, provenance } });
      }
    }
    try {
      const value = await readExistingTranscriptArtifact(root, source);
      results.push({ action: 'transcription', runId: `asr-${value.identity}`, scope: null, count: value.summary.rawCueCount, provenance: value.provenance, payload: value.payload, proof: value.sourceFingerprint, transcriptIdentity: value.identity });
    } catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND' && !(e instanceof HttpError) && !/转写|字幕|分段|transcript|cache|ENOENT/i.test(e.message)) throw e; warnings.push('原始 ASR 分段记录缺失、不完整或来源未能核对，未列为可共享转写；已有字幕不冒充原始模型结果'); }
    return results;
  }
  async function inventory(root, sourceId) {
    const { source } = await sourceFor(root, sourceId);
    const warnings = [], values = await artifacts(root, source, warnings);
    return { source, warnings, results: values.map(({ payload, proof, transcriptIdentity, ...item }) => ({ ...item, canPublish: true, requestCount: 0 })) };
  }
  async function material(root, request) {
    if (!shared) throw new HttpError(409, '共享任务协调服务未接通，没有重新分析');
    const { source } = await sourceFor(root, request.sourceId);
    const item = (await artifacts(root, source)).find(a => a.action === request.action && a.runId === request.runId && (!request.intervalId || a.intervalId === request.intervalId));
    if (!item) throw noCache();
    const descriptor = await shared.prepareExisting(root, source, item);
    const restoration = await read(join(root, '.film/restore-provenance.json'));
    const provenance = await read(join(root, '.film/source-provenance.json'));
    const recordedSha = restoration?.sources?.find(s => s.sourceId === source.id)?.contentHash ?? ((provenance?.sourceId === source.id || provenance?.assetPath === source.assetPath) ? provenance.sha256 : undefined);
    const resolvedPath = await realpath(await productSourcePath(root, source.assetPath)), info = await stat(resolvedPath);
    const fingerprint = `${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}`;
    const discoveryFingerprint = sharedHash({ sourceId: source.id, assetPath: source.assetPath, resolvedPath, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, ino: info.ino, durationMs: source.durationMs });
    const proofMatches = typeof item.proof === 'string' ? item.proof === (item.action === 'discovery' ? discoveryFingerprint : fingerprint) : item.proof && item.proof.size === info.size && item.proof.mtimeMs === info.mtimeMs && item.proof.ctimeMs === info.ctimeMs;
    if (recordedSha ? recordedSha !== descriptor.source.sha256 : !proofMatches) throw new HttpError(409, '原分析与当前原片的身份依据不足或不一致，没有重新分析');
    const frozen = { source: { sourceId: source.id, assetPath: source.assetPath, durationMs: source.durationMs, sha256: descriptor.source.sha256 }, target: { root: descriptor.resultRoot, libraryId: descriptor.libraryId, companyId: descriptor.coordinationId ?? null }, action: item.action, runId: item.runId, intervalId: item.intervalId ?? null, scope: item.scope, count: item.count, canPublish: descriptor.mode !== 'busy', reason: descriptor.reason ?? null, warnings: ['仅发布已有原始结果，不发布私人取用、商品修改或成片'], provenance: item.provenance, requestCount: 0, payloadHash: sharedHash(item.payload), taskKey: descriptor.taskKey };
    return { source, item, descriptor, plan: { ...frozen, identity: sharedHash(frozen) } };
  }
  async function plan(root, request) { return (await material(root, request)).plan; }
  async function publish(root, body) {
    if (body?.confirmed !== true || !body.plan) throw new HttpError(400, '请确认发布已有结果');
    const current = await material(root, { ...body.plan, sourceId: body.plan.source?.sourceId });
    if (current.plan.identity !== body.plan.identity) throw new HttpError(409, '原片、原结果或共享目标已变化，没有发布也没有重新分析');
    if (!current.plan.canPublish) throw new HttpError(409, current.plan.reason);
    const { source, item, descriptor } = current;
    if (descriptor.mode === 'publish-pending') await shared.publish(root, source.id, descriptor.taskKey);
    else if (descriptor.mode === 'publish-resume') await shared.resumeExisting(root, descriptor, item.payload);
    else if (descriptor.mode !== 'reuse') { const claim = await shared.acquire(descriptor); await shared.complete(root, descriptor, claim.attemptId, item.payload); }
    return { published: true, requestCount: 0, taskKey: descriptor.taskKey };
  }
  async function catalog(root, sourceId) {
    const { source } = await sourceFor(root, sourceId); if (!shared) throw new HttpError(409, '共享协调服务未接通');
    const state = await shared.history(root, source);
    const results = [];
    for (const item of state.results) {
      if (item.catalog?.action === 'structure-plans') continue;
      const row = { taskKey: item.taskKey, resultSha: item.result.sha256, ...item.catalog, requestCount: 0 };
      if (row.provenance?.kind === 'shared-workflow-v1') {
        const { snapshot } = await shared.historicalArtifact(root, source, item.taskKey, item.result.sha256);
        row.count = completedCount(item.catalog, snapshot.payload);
      }
      results.push(row);
    }
    return { results };
  }
  async function selection(root, body) {
    const { source } = await sourceFor(root, body.sourceId); if (!shared) throw new HttpError(409, '共享协调服务未接通');
    const selected = await shared.historicalArtifact(root, source, body.taskKey, body.resultSha);
    if (selected.descriptor.action === 'structure-plans') throw new HttpError(409, '结构方案请从生成结构视频入口读取，不作为拆品或话术导入');
    return { source, ...selected };
  }
  async function preview(root, body) { const value = await selection(root, body), payload = value.snapshot.payload; return { taskKey: body.taskKey, resultSha: body.resultSha, action: value.descriptor.action, scope: value.descriptor.scope, count: completedCount(value.descriptor.catalog, payload), provenance: payload.provenance ?? value.descriptor.catalog?.provenance, candidates: payload.candidates, proposal: payload.proposal, transcript: payload.kind === 'original-asr-segments' ? payload : undefined, canImport: true, reason: null, requestCount: 0 }; }
  async function importResult(root, body) {
    if (body?.confirmed !== true) throw new HttpError(400, '请确认采用已有历史结果');
    const value = await selection(root, body), payload = value.snapshot.payload;
    if (value.descriptor.catalog?.provenance?.kind === 'shared-workflow-v1') {
      if (!importNormal) throw new HttpError(409, '普通共享结果导入尚未接通');
      const imported = await importNormal(root, value, body);
      await shared.pinHistorical(root, value.source, value);
      return { ...imported, requestCount: 0 };
    }
    if (value.descriptor.action === 'analysis') {
      if (!liveAnalysis?.importHistorical) throw new HttpError(409, '历史候选导入尚未接通');
      const imported = await liveAnalysis.importHistorical(root, value.source.id, payload, value.result, { productId: body.productId, productName: body.productName, sourceSha: value.descriptor.source.sha256, expectedSourceFingerprint: value.localSourceFingerprint, expectedAnalysis: body.expectedAnalysis });
      await shared.pinHistorical(root, value.source, value);
      return { ...imported, requestCount: 0 };
    } else if (value.descriptor.action === 'transcription') {
      const { importExistingTranscriptArtifact } = await import('./existing-transcript-artifact.mjs');
      const imported = await importExistingTranscriptArtifact(root, value.source, payload, value.result, { expectedSourceFingerprint: value.localSourceFingerprint });
      await shared.pinHistorical(root, value.source, value);
      return { ...imported, needsReview: imported.reviewRequired, requestCount: 0 };
    } else {
      if (!discovery?.importHistorical) throw new HttpError(409, '历史拆品建议导入尚未接通');
      const imported = await discovery.importHistorical(root, value.source.id, payload, value.result, { expectedSourceFingerprint: value.localSourceFingerprint });
      await shared.pinHistorical(root, value.source, value);
      return { imported: true, needsReview: true, runId: imported.runId, reason: '原始 AI 商品建议已保存，请在拆品建议中核对并明确采用；没有替换当前商品和人工范围', requestCount: 0 };
    }
  }
  return { inventory, plan, publish, catalog, preview, importResult };
}
