/** Portable original ASR segments. Local resolutions and effective edited text are never part of this payload. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { transcriptionLocation, readProductTranscript } from './product-transcription.mjs';
import { inspectAudioSeams, resolveAudioSeams } from './transcription-seams.mjs';
import { validateTranscriptCues } from './transcription-segments.mjs';
import { productTranscriptRange } from './product-transcript-range.mjs';
import { transcriptPath } from './transcripts.mjs';
import { inside } from './files.mjs';
import { writeAtomic } from './atomic.mjs';

const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const plain = ({ text, startMs, endMs }) => ({ text, startMs, endMs });
export const transcriptInputHash = cues => hash(cues.map(plain));
const error = (message, code = 'EXISTING_ASR_INVALID') => Object.assign(new Error(message), { code });
const overlap = (a, b) => a.startMs < b.endMs && a.endMs > b.startMs;
const sameSource = (value, loc) => value?.sourceId === loc.sourceId && value.assetPath === loc.assetPath && value.durationMs === loc.durationMs && ['size', 'mtimeMs', 'ctimeMs', 'path'].every(k => value.fingerprint?.[k] === loc.fingerprint[k]);
const optional = async path => { try { return await readFile(path, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const imports = new Map();

function validWords(words, startMs, endMs) {
  if (!Array.isArray(words) || words.some((w, i) => !w || typeof w.text !== 'string' || !w.text.trim() || !Number.isFinite(w.startMs) || !Number.isFinite(w.endMs) || w.startMs < startMs || w.endMs < w.startMs || w.endMs > endMs || (i && w.startMs < words[i - 1].startMs))) throw error('原始逐词时间无效，未发布或导入');
  return words.map(plain);
}
function normalizePayload(payload) {
  if (payload?.kind !== 'original-asr-segments' || payload.version !== 1 || payload.collectionStatus !== 'complete' || !Number.isFinite(payload.durationMs) || payload.durationMs <= 0 || !Array.isArray(payload.segments) || !payload.segments.length) throw error('原始分段尚未完整或格式不兼容');
  const segments = payload.segments.map(s => {
    if (!s || typeof s.id !== 'string' || !s.id || ![s.startMs, s.endMs, s.coreStartMs, s.coreEndMs].every(Number.isFinite)) throw error('原始分段范围无效');
    const cues = validateTranscriptCues(s.cues, s.endMs).map(plain);
    if (cues.some(c => c.startMs < s.startMs)) throw error('字幕超出原始音频分段');
    const words = validWords(s.words ?? [], s.startMs, s.endMs);
    return { id: s.id, startMs: s.startMs, endMs: s.endMs, coreStartMs: s.coreStartMs, coreEndMs: s.coreEndMs, cues, words,
      ...(typeof s.requestId === 'string' && s.requestId ? { requestId: s.requestId } : {}), ...(typeof s.completedAt === 'string' && s.completedAt ? { completedAt: s.completedAt } : {}) };
  });
  if (segments[0].coreStartMs !== 0 || segments.at(-1).coreEndMs !== payload.durationMs) throw error('原始分段没有覆盖完整视频，未当成完整转写');
  const value = { version: 1, kind: 'original-asr-segments', durationMs: payload.durationMs, collectionStatus: 'complete', segments };
  inspectAudioSeams(localSegments(value), payload.durationMs);
  return value;
}
function localSegments(payload) {
  return payload.segments.map(s => ({ id: s.id, startMs: s.startMs, endMs: s.endMs, coreStartMs: s.coreStartMs, coreEndMs: s.coreEndMs, status: 'complete',
    cues: s.cues.map(c => ({ text: c.text, startMs: c.startMs - s.startMs, endMs: c.endMs - s.startMs })),
    words: s.words.map(w => ({ token: w.text, start: (w.startMs - s.startMs) / 1000, end: (w.endMs - s.startMs) / 1000 })),
    ...(s.requestId ? { requestId: s.requestId } : {}), ...(s.completedAt ? { completedAt: s.completedAt } : {}) }));
}
function payloadFromManifest(manifest) {
  if (!Array.isArray(manifest?.segments) || !manifest.segments.every(s => s.status === 'complete')) throw error('原始转写分段尚未完成');
  return normalizePayload({ version: 1, kind: 'original-asr-segments', durationMs: manifest.durationMs, collectionStatus: 'complete', segments: manifest.segments.map(s => ({ ...s,
    cues: s.cues.map(c => ({ text: c.text, startMs: c.startMs + s.startMs, endMs: c.endMs + s.startMs })),
    words: (s.words ?? []).map(w => ({ text: w.token, startMs: Math.round(w.start * 1000) + s.startMs, endMs: Math.round(w.end * 1000) + s.startMs })) })) });
}
function originOf(transcript) {
  if (transcript?.provenance?.kind) return transcript.provenance.kind;
  return transcript?.localReconciled ? 'local-seam-review' : 'unknown';
}

/** Local inspection only. Callers must never put this effective input into the original-ASR payload. */
export async function readHistoricalTranscriptInput(root, source, scope) {
  const transcript = await readProductTranscript(root, source);
  if (!transcript) throw error('历史分析输入缺失，不能推测当时字幕', 'EXISTING_TRANSCRIPT_INPUT_UNAVAILABLE');
  let cues, cueIndices, words;
  if (scope) {
    if (!Number.isFinite(scope.startMs) || !Number.isFinite(scope.endMs) || scope.startMs < 0 || scope.endMs <= scope.startMs || scope.endMs > source.durationMs) throw error('历史分析范围无效');
    const selected = productTranscriptRange(transcript, scope, source.durationMs); cues = selected.segments.map(plain); cueIndices = selected.cueIndices;
    words = (transcript.words ?? []).filter(w => w.startMs >= scope.startMs && w.endMs <= scope.endMs).map(plain);
  } else {
    cues = validateTranscriptCues(transcript.cues, source.durationMs).map(plain); cueIndices = cues.map((_, i) => i); words = (transcript.words ?? []).map(plain);
  }
  return { cues, words, cueIndices, origin: originOf(transcript), hash: transcriptInputHash(cues) };
}

export async function readExistingTranscriptArtifact(root, source) {
  const loc = await transcriptionLocation(root, source), cacheText = await optional(loc.path), rawText = await optional(`${loc.path}.segments.json`);
  if (!rawText) throw error('没有原始 AI 分段记录；不会把已有字幕假称原始模型结果', 'EXISTING_ASR_RAW_MISSING');
  let cache, manifest;
  try { cache = JSON.parse(cacheText); manifest = JSON.parse(rawText); } catch { throw error('原始转写记录无法读取，已保留原文件'); }
  if (!sameSource(cache, loc) || manifest.version !== 1 || manifest.sourceId !== source.id || manifest.durationMs !== source.durationMs || !Array.isArray(manifest.segments) || !manifest.segments.every(s => s.status === 'complete')) throw error('原始转写来源不匹配或分段尚未完成');
  const payload = payloadFromManifest(manifest);
  const inspection = inspectAudioSeams(localSegments(payload), source.durationMs);
  let effectiveInput;
  try {
    const input = await readHistoricalTranscriptInput(root, source);
    effectiveInput = { status: 'available', origin: input.origin, hash: input.hash, cueCount: input.cues.length };
  } catch (e) {
    if (e.code !== 'ASR_BOUNDARY_REVIEW' && e.code !== 'EXISTING_TRANSCRIPT_INPUT_UNAVAILABLE') throw e;
    effectiveInput = { status: 'unavailable', origin: 'unknown', code: e.code };
  }
  return { payload, identity: hash(payload), sourceFingerprint: { size: loc.fingerprint.size, mtimeMs: loc.fingerprint.mtimeMs, ctimeMs: loc.fingerprint.ctimeMs }, provenance: { kind: 'original-provider-segments', rawManifestHash: hash(rawText),
    ...(cache.boundaryReview ? { legacyReview: String(cache.boundaryReview.kind ?? 'unknown-local-review') } : {}), effectiveInput },
    summary: { segmentCount: payload.segments.length, rawCueCount: payload.segments.reduce((sum, s) => sum + s.cues.length, 0), pendingSeams: inspection.pendingCount } };
}

/** A scoped original input is usable only when no ambiguous seam or cue truncation intersects it. */
export function extractOriginalTranscriptScope(value, scope) {
  const payload = normalizePayload(value);
  if (!scope || !Number.isFinite(scope.startMs) || !Number.isFinite(scope.endMs) || scope.startMs < 0 || scope.endMs <= scope.startMs || scope.endMs > payload.durationMs) throw error('分析范围无效');
  const inspection = inspectAudioSeams(localSegments(payload), payload.durationMs);
  if (inspection.seams.some(s => s.status === 'pending' && overlap(s, scope))) throw error('所选范围涉及未核对接缝，不能作为无修订的 AI 输入', 'ASR_BOUNDARY_REVIEW');
  const available = [...inspection.outside, ...inspection.seams.filter(s => s.status === 'automatic').flatMap(s => s.proposed)].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const intersecting = available.filter(c => overlap(c, scope));
  if (!intersecting.length || intersecting.some(c => c.startMs < scope.startMs || c.endMs > scope.endMs)) throw error('原始字幕不完整覆盖所选句边界，不能猜测历史输入');
  const cues = validateTranscriptCues(intersecting, payload.durationMs).map(plain);
  const words = payload.segments.flatMap(s => s.words.filter(w => (w.startMs + w.endMs) / 2 >= s.coreStartMs && (w.startMs + w.endMs) / 2 < s.coreEndMs))
    .filter(w => w.startMs >= scope.startMs && w.endMs <= scope.endMs).map(plain);
  return { cues, words, origin: 'original-provider-segments', hash: transcriptInputHash(cues) };
}

/** Import into a new local transcript. A partial save can be retried, never submitted to ASR. */
export async function importExistingTranscriptArtifact(root, source, value, sharedRef, { write = writeAtomic, expectedSourceFingerprint } = {}) {
  const key = `${root}\0${source?.id}`, previousJob = imports.get(key) ?? Promise.resolve();
  const job = previousJob.catch(() => {}).then(async () => {
    const payload = normalizePayload(value);
    if (payload.durationMs !== source.durationMs) throw error('共享原始转写时长与本机来源不一致');
    const loc = await transcriptionLocation(root, source), identity = hash(payload), previousText = await optional(loc.path);
    if (expectedSourceFingerprint !== undefined) {
      const info = await stat(loc.input);
      if (expectedSourceFingerprint !== `${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}` || ['size', 'mtimeMs', 'ctimeMs'].some(key => info[key] !== loc.fingerprint[key])) throw error('选定共享结果后来源已经变化，未导入旧转写');
    }
    if (previousText !== null) {
      const previous = JSON.parse(previousText);
      if (!sameSource(previous, loc) || previous.importedTranscriptArtifactHash !== identity) throw error('本机已有转写，未覆盖已有结果或人工修改');
      const manifest = JSON.parse(await readFile(`${loc.path}.segments.json`, 'utf8'));
      if (manifest.importedTranscriptArtifactHash !== identity || manifest.sourceId !== source.id || hash(payloadFromManifest(manifest)) !== identity) throw error('共享原始分段记录不一致，保留现有文件');
      let reviewRequired = false;
      try { await readProductTranscript(root, source); } catch (e) { if (e.code !== 'ASR_BOUNDARY_REVIEW') throw e; reviewRequired = true; }
      return { imported: false, reused: true, collectionStatus: 'complete', reviewRequired, identity };
    }
    if (await stat(inside(root, transcriptPath(source.assetPath))).catch(e => { if (e.code === 'ENOENT') return null; throw e; }) || await optional(`${loc.path}.review.json`) !== null) throw error('本机已有字幕或接缝修订，未覆盖');
    const segments = localSegments(payload), inspection = inspectAudioSeams(segments, source.durationMs);
    const manifest = { version: 1, identity: hash({ imported: identity, sourceId: source.id, fingerprint: loc.fingerprint }), sourceId: source.id, durationMs: source.durationMs, importedTranscriptArtifactHash: identity, segments };
    const manifestText = JSON.stringify(manifest), priorManifest = await optional(`${loc.path}.segments.json`);
    if (priorManifest !== null && priorManifest !== manifestText) throw error('已有不同的原始分段记录，未覆盖');
    const state = { version: 1, status: inspection.pendingCount ? 'pending' : 'complete', sourceId: source.id, assetPath: source.assetPath, durationMs: source.durationMs, fingerprint: loc.fingerprint,
      segmented: true, collectionStatus: 'complete', importedTranscriptArtifactHash: identity, sharedRef, provenance: { kind: 'original-provider-segments' } };
    if (!inspection.pendingCount) {
      const cues = resolveAudioSeams(inspection, {}), words = inspection.words;
      Object.assign(state, { cues, words, text: cues.map(c => c.text).join(' ') });
    }
    await mkdir(loc.dir, { recursive: true });
    if (priorManifest === null) await write(`${loc.path}.segments.json`, manifestText);
    const fresh = await transcriptionLocation(root, source);
    if (JSON.stringify(fresh.fingerprint) !== JSON.stringify(loc.fingerprint)) throw error('导入期间来源已经变化，未把旧转写保存为新原片结果');
    // Only the cache commit makes a whole imported artifact usable. A failed write leaves the immutable segments for explicit retry.
    await write(loc.path, JSON.stringify(state));
    return { imported: true, collectionStatus: 'complete', reviewRequired: inspection.pendingCount > 0, identity };
  });
  imports.set(key, job); try { return await job; } finally { if (imports.get(key) === job) imports.delete(key); }
}
