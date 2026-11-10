/** Only machine-local identities change after full source-byte verification by project-backup. */
import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AUDIO_SEGMENT_POLICY, planAudioSegments } from './transcription-segments.mjs';
import { ProjectBackupError } from './project-backup-error.mjs';
import { readReviewedTranscript, readCompletedSegmentTranscript } from './transcript-review.mjs';
import { parseVtt, transcriptPath } from './transcripts.mjs';
import { validateDiscoveryCues } from './product-discovery.mjs';

const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => [key, canonical(value[key])])) : value;
const discoveryHash = value => hash(JSON.stringify(canonical(value)));
const read = async path => { try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const save = (path, value) => writeFile(path, `${JSON.stringify(value)}\n`);
const previousFingerprintMatches = (value, source) => value?.sourceId === source.sourceId && value.assetPath === source.assetPath && ['size', 'mtimeMs', 'ctimeMs', 'path'].every(key => value.fingerprint?.[key] === source.fingerprint[key]);

export async function rebindRestoredProject(stage, target, sources, options = {}) {
  const warnings = [], fingerprints = new Map();
  for (const source of sources) {
    const external = source.libraryId && source.mode !== 'verified-copy';
    const input = external ? source.resolvedPath : join(stage, source.assetPath), info = await stat(input);
    const fingerprint = { size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, path: external ? source.resolvedPath : join(target, source.assetPath) };
    fingerprints.set(source.sourceId, { fingerprint, info });
    const cachePath = join(stage, '.film/product-transcripts', `${hash(source.sourceId)}.json`), cache = await read(cachePath);
    const bindingPath = `${cachePath}.vtt-binding.json`, binding = await read(bindingPath);
    for (const [path, value] of [[cachePath, cache], [bindingPath, binding]]) {
      if (!value) continue;
      if (!previousFingerprintMatches(value, source)) throw new ProjectBackupError('转写与备份素材身份不一致，不能安全恢复；原备份保持不变');
      value.restoreProvenance = { fingerprint: value.fingerprint, backupId: options.backupId }; value.fingerprint = fingerprint; await save(path, value);
    }
    const manifestPath = `${cachePath}.segments.json`, manifest = await read(manifestPath);
    if (manifest) {
      if (!cache || manifest.sourceId !== source.sourceId || manifest.durationMs !== source.durationMs) throw new ProjectBackupError('分段转写依赖缺失，不能安全恢复');
      const reviewPath = `${cachePath}.review.json`, review = await read(reviewPath), oldText = await readFile(manifestPath, 'utf8');
      const oldReviewIdentity = hash({ manifest: hash(oldText), sourceId: source.sourceId, assetPath: source.assetPath, fingerprint: source.fingerprint, durationMs: source.durationMs });
      if (review && review.identity !== oldReviewIdentity) throw new ProjectBackupError('接缝修改与备份来源不一致，不能安全恢复');
      const plan = planAudioSegments(source.durationMs);
      const oldIdentity = hash(JSON.stringify({ sourceId: source.sourceId, assetPath: source.assetPath, fingerprint: source.fingerprint, durationMs: source.durationMs, plan, policyVersion: AUDIO_SEGMENT_POLICY.version, model: 'volc.bigasr.auc_turbo', audio: 'mp3-16k-mono-32k' }));
      // Only rebind a recognized plan. An unknown incomplete plan cannot safely resume.
      if (manifest.identity !== oldIdentity && manifest.segments.some(segment => segment.status !== 'complete')) throw new ProjectBackupError('旧分段计划无法安全恢复，未重新请求任何分段');
      if (manifest.identity === oldIdentity) {
        manifest.restoreProvenance = { identity: manifest.identity, backupId: options.backupId };
        manifest.identity = hash(JSON.stringify({ sourceId: source.sourceId, assetPath: source.assetPath, fingerprint, durationMs: source.durationMs, plan, policyVersion: AUDIO_SEGMENT_POLICY.version, model: 'volc.bigasr.auc_turbo', audio: 'mp3-16k-mono-32k' }));
        await save(manifestPath, manifest);
      }
      if (review) { review.restoreProvenance = { identity: review.identity, backupId: options.backupId }; review.identity = hash({ manifest: hash(await readFile(manifestPath, 'utf8')), sourceId: source.sourceId, assetPath: source.assetPath, fingerprint, durationMs: source.durationMs }); await save(reviewPath, review); }
    }
    const discoveryPath = join(stage, '.film/product-discovery', `${discoveryHash(source.sourceId)}.json`), discovery = await read(discoveryPath);
    if (discovery) {
      const loc = { root: stage, dir: join(stage, '.film/product-transcripts'), path: cachePath, sourceId: source.sourceId, assetPath: source.assetPath, durationMs: source.durationMs, fingerprint };
      let transcript;
      try {
        transcript = await readReviewedTranscript(loc);
        if (!transcript && binding) transcript = { cues: parseVtt(await readFile(join(stage, transcriptPath(source.assetPath)), 'utf8')).lines };
        if (!transcript) transcript = cache?.status === 'complete' ? cache : await readCompletedSegmentTranscript(loc);
        if (transcript) {
          const cues = validateDiscoveryCues(transcript.cues, source.durationMs).map(({ index: ignored, ...cue }) => cue);
          const fp = (metadata, path, ino) => discoveryHash({ sourceId: source.sourceId, assetPath: source.assetPath, resolvedPath: path, size: metadata.size, mtimeMs: metadata.mtimeMs, ctimeMs: metadata.ctimeMs, ino, durationMs: source.durationMs });
          const oldFingerprint = fp(source.fingerprint, source.fingerprint.path, source.ino), nextFingerprint = fp(fingerprint, fingerprint.path, info.ino);
          const oldInput = discoveryHash({ fingerprint: oldFingerprint, durationMs: source.durationMs, cues }), nextInput = discoveryHash({ fingerprint: nextFingerprint, durationMs: source.durationMs, cues });
          for (const run of discovery.runs ?? []) if (run.inputHash === oldInput) {
            run.restoreProvenance = { inputHash: run.inputHash, fingerprint: run.fingerprint, backupId: options.backupId };
            run.inputHash = nextInput; run.fingerprint = nextFingerprint;
          }
          await save(discoveryPath, discovery);
        }
      } catch (error) {
        if (error.code !== 'ASR_BOUNDARY_REVIEW' && error.status !== 409) throw error;
        warnings.push('拆品原始结果已保留；当前字幕尚待接缝核对，未把旧结果重新标记为有效，也未重新分析。');
      }
    }
    // Preserve all prior structure results; without their original full model identity they must remain inspectable, not falsely current.
    const livePath = join(stage, '.film/live-analysis', `${hash(source.sourceId)}.json`), live = await read(livePath);
    if (live) {
      const oldFp = `${source.fingerprint.size}:${source.fingerprint.mtimeMs}:${source.fingerprint.ctimeMs}:${source.ino}`, newFp = `${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}`;
      if (live.transcription?.sourceFingerprint === oldFp) live.transcription.sourceFingerprint = newFp;
      for (const item of [live.analysis, ...Object.values(live.analyses ?? {}), ...Object.values(live.results ?? {})]) {
        if (!item || item.sourceFingerprint !== oldFp) continue;
        item.sourceFingerprint = newFp;
        if (item.sharedRef && item.transcriptHash) item.sharedSignature = hash({ fingerprint: newFp, transcript: item.transcriptHash, intervalId: item.intervalId, productId: item.productId, startMs: item.rangeStartMs, endMs: item.rangeEndMs });
      }
      await save(livePath, live);
      if (Object.values(live.analyses ?? {}).some(item => item.currentRunId && !item.sharedRef)) warnings.push('旧本机话术结果和人工修改已保留；原模型身份未完整保存的缓存需核对，不会自动重新分析。');
    }
  }
  const takesPath = join(stage, '.film/source-takes.json'), takes = await read(takesPath);
  if (takes) {
    for (const saved of takes.sources ?? []) {
      const current = fingerprints.get(saved.document?.sourceId); if (!current) throw new ProjectBackupError('个人取用缺少对应素材，无法完整恢复');
      const source = sources.find(source => source.sourceId === saved.document.sourceId);
      if (saved.document.assetPath !== source.assetPath || saved.sourceIdentity !== hash(JSON.stringify({ sourceId: source.sourceId, assetPath: source.assetPath, size: source.fingerprint.size, mtimeMs: source.fingerprint.mtimeMs }))) throw new ProjectBackupError('个人取用与备份素材身份不一致，不能把旧裁剪恢复为当前结果');
      saved.restoreProvenance = { sourceIdentity: saved.sourceIdentity, backupId: options.backupId };
      saved.sourceIdentity = hash(JSON.stringify({ sourceId: saved.document.sourceId, assetPath: saved.document.assetPath, size: current.info.size, mtimeMs: current.info.mtimeMs }));
    }
    await save(takesPath, takes);
  }
  const sharedDir = join(stage, '.film/shared-analysis');
  for (const name of await readdir(sharedDir).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
    if (!name.endsWith('.json')) continue;
    const path = join(sharedDir, name), saved = await read(path); if (!saved?.descriptor) continue;
    saved.restoreProvenance = { descriptor: structuredClone(saved.descriptor), backupId: options.backupId };
    saved.descriptor.root = target;
    const mapped = options.resultRoots.find(item => item.libraryId === saved.descriptor.libraryId)?.root;
    for (const historical of [saved.pendingAdoption, ...(saved.previousVersions ?? [])].filter(item => item?.descriptor)) {
      historical.restoreProvenance = { descriptor: structuredClone(historical.descriptor), backupId: options.backupId };
      historical.descriptor.root = target;
      if (mapped) historical.descriptor.resultRoot = mapped;
    }
    if (saved.outbox || ['claimed', 'claiming', 'submitted', 'uncertain'].includes(saved.status)) {
      let coordinated = false;
      if (mapped && options.coordinate && saved.coordinationId && saved.attemptId) {
        try {
          const response = await options.coordinate('status', { taskKey: saved.descriptor.taskKey, expectedCoordinatorId: saved.coordinationId });
          coordinated = response.coordinationId === saved.coordinationId && response.task?.attemptId === saved.attemptId;
        } catch { /* Keep the receipt, original attempt, and original destination. Never claim or submit on restore. */ }
      }
      if (coordinated) saved.descriptor.resultRoot = mapped;
      else { saved.restoreBlocked = true; warnings.push('已有待确认任务或待补保存结果已完整保留；请连接原公司服务并核对原任务，恢复不会重新请求或重复付费。'); }
    } else if (mapped) saved.descriptor.resultRoot = mapped;
    await save(path, saved);
  }
  return [...new Set(warnings)];
}
