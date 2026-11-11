import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { writeAtomic } from './atomic.mjs';
import { inside, readable } from './files.mjs';
import { parseVtt, transcriptPath } from './transcripts.mjs';
import { AUDIO_SEGMENT_POLICY, planAudioSegments, mergeAudioSegments, validateTranscriptCues } from './transcription-segments.mjs';
import { resolveSharedMedia, sharedMediaManifest } from './shared-media.mjs';
import doubao, { doubaoResult } from './providers/doubao.mjs';
import { probe } from './derived.mjs';
import { readReviewedTranscript, readCompletedSegmentTranscript } from './transcript-review.mjs';

const running = new Map();
const notSubmitted = (reason) => Object.assign(new Error('Transcription did not upload audio.'), { code: 'ASR_NOT_SUBMITTED', reason });
const digest = id => createHash('sha256').update(id).digest('hex');

// Match the provider's existing 150ms tail tolerance. Only an end inside this
// small tail is bounded; starting outside the source or larger overruns fail.
function boundedResult(row, durationMs) {
  const timingAdjustments = [];
  const endAt = (kind, index, startMs, endMs) => {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || startMs >= durationMs || endMs < startMs || endMs > durationMs + 150) throw new Error(kind === 'sentence' ? 'Transcription has invalid timestamps; sentence-level location is unavailable.' : 'Transcription returned invalid timestamps. Check the saved response before retrying.');
    if (endMs > durationMs) {
      timingAdjustments.push({ kind, index, originalEndMs: endMs, endMs: durationMs });
      return durationMs;
    }
    return endMs;
  };
  if (typeof row?.text !== 'string' || !Array.isArray(row.words) || !row.words.length || row.words.some(w => typeof w?.token !== 'string' || !Number.isFinite(w.start) || !Number.isFinite(w.end))) throw new Error('Transcription returned invalid timestamps.');
  const words = row.words.map((w, i) => ({ ...w, end: endAt('word', i, w.start * 1000, w.end * 1000) / 1000 }));
  validateTranscriptCues(row.cues);
  const cues = row.cues.map((c, i) => ({ ...c, endMs: endAt('sentence', i, c.startMs, c.endMs) }));
  validateTranscriptCues(cues, durationMs);
  return { ...row, words, cues, ...(timingAdjustments.length ? { timingAdjustments } : {}) };
}

/** Pure recovery from a matching saved provider success. Does not read media,
 * credentials or the network, and cannot replace an already completed cache. */
export function restoreProductTranscriptCache(previous, response) {
  if (previous?.status !== 'pending' || previous.segmented) throw new Error('Only a pending single-response transcript can be recovered.');
  const requestId = previous.requestId;
  if (!/^[a-f0-9-]{36}$/i.test(requestId ?? '') || response?.requestId !== requestId || !previous.attempts?.some(a => a.requestId === requestId)
    || response.provider !== 'doubao' || response.model !== 'volc.bigasr.auc_turbo' || response.httpStatus !== 200 || response.serviceStatus !== '20000000'
    || response.sourceId !== previous.sourceId || response.assetPath !== previous.assetPath || !previous.fingerprint
    || !['size', 'mtimeMs', 'ctimeMs', 'path'].every(key => previous.fingerprint[key] !== undefined && previous.fingerprint[key] === response.sourceFingerprint?.[key])
    || !Number.isFinite(previous.durationMs) || previous.durationMs <= 0) throw new Error('Saved response does not match this pending source and request.');
  const row = boundedResult(doubaoResult(response.body, response.serviceStatus), previous.durationMs);
  return { ...previous, status: 'complete', text: row.text, cues: row.cues,
    words: row.words.map(w => ({ text: w.token, startMs: Math.round(w.start * 1000), endMs: Math.round(w.end * 1000) })), rawWords: row.rawWords,
    ...(row.timingAdjustments ? { timingAdjustments: row.timingAdjustments } : {}),
    attempts: previous.attempts.map(a => a.requestId === requestId ? { ...a, status: 'complete', recoveredFromResponse: true } : a),
    recovery: { kind: 'saved-provider-response', requestId, responseSha256: digest(JSON.stringify(response)) } };
}

async function savedResponse(loc, previous) {
  if (previous?.status !== 'pending' || previous.segmented || !same(previous, loc) || previous.durationMs !== loc.durationMs || !/^[a-f0-9-]{36}$/i.test(previous.requestId ?? '')) return null;
  const dir = join(loc.dir, 'raw-responses');
  await checkCachePath(loc.root, dir);
  let response;
  try {
    const path = join(dir, `${previous.requestId}.json`);
    await checkCachePath(loc.root, path);
    response = JSON.parse(await readFile(path, 'utf8'));
  }
  catch { return null; }
  try { return restoreProductTranscriptCache(previous, response); } catch { return null; }
}

export async function productSourcePath(root, assetPath) {
  const manifest = await sharedMediaManifest(root);
  if (Object.hasOwn(manifest.items, assetPath)) return (await resolveSharedMedia(root, assetPath)).path;
  return readable(root, assetPath);
}

export async function transcriptionLocation(root, source) {
  if (!source || typeof source.id !== 'string' || !source.id || typeof source.assetPath !== 'string' || !source.assetPath) throw new Error('Invalid transcription source.');
  const input = await productSourcePath(root, source.assetPath);
  const info = await stat(input);
  if (!info.isFile()) throw new Error('Source is not a file.');
  const base = await realpath(root);
  const dir = join(base, '.film', 'product-transcripts');
  await checkCachePath(base, dir);
  return { input, root: base, dir, path: join(dir, `${digest(source.id)}.json`), durationMs: source.durationMs, fingerprint: { size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, path: await realpath(input) }, sourceId: source.id, assetPath: source.assetPath };
}
const location = transcriptionLocation;

async function checkCachePath(base, dir) {
  for (const part of [join(base, '.film'), dir]) {
    let actual;
    try { actual = await realpath(part); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    const rel = relative(base, actual);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Transcript cache must be inside the project.');
  }

}

async function load(loc) {
  let value;
  try { value = JSON.parse(await readFile(loc.path, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw new Error('Transcript cache cannot be read; it was not overwritten.'); }
  if (value?.version !== 1 || value.sourceId !== loc.sourceId || !['pending', 'complete'].includes(value.status)) throw new Error('Transcript cache is invalid; it was not overwritten.');
  return value;
}
async function guardPartialSharedImport(loc, cache) {
  if (cache) return;
  let text;
  try { text = await readFile(`${loc.path}.segments.json`, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  if (JSON.parse(text)?.importedTranscriptArtifactHash) throw Object.assign(new Error('共享原始分段已经保存，但本机导入尚未完成；请恢复导入，不会重新发送音频'), { code: 'EXISTING_ASR_IMPORT_INCOMPLETE' });
}
const same = (value, loc) => value.assetPath === loc.assetPath && ['size', 'mtimeMs', 'ctimeMs', 'path'].every(field => value.fingerprint?.[field] === loc.fingerprint[field]);
function legacyProvenance(value, loc) {
  if (value?.status === 'complete' && value.fingerprint?.size === loc.fingerprint.size && value.fingerprint?.mtimeMs === loc.fingerprint.mtimeMs && (value.fingerprint.ctimeMs === undefined || value.fingerprint.path === undefined)) {
    view(value, loc.durationMs);
    throw new Error('Existing transcript provenance needs explicit confirmation; it was preserved and no audio was uploaded.');
  }
}
const save = async (loc, data) => {
  await checkCachePath(loc.root, loc.dir);
  await mkdir(join(loc.root, '.film'), { recursive: true });
  await checkCachePath(loc.root, loc.dir);
  await mkdir(loc.dir, { recursive: true });
  await checkCachePath(loc.root, loc.dir);
  await writeAtomic(loc.path, `${JSON.stringify(data)}\n`);
};
const view = (value, durationMs = value.durationMs) => {
  validateTranscriptCues(value.cues, Number.isFinite(durationMs) ? durationMs : Infinity);
  return { sourceId: value.sourceId, text: value.text, words: value.words, ...(value.rawWords ? { rawWords: value.rawWords } : {}), cues: value.cues, cached: true, ...(value.recovery?.kind === 'saved-provider-response' ? { recoveredFromResponse: true } : {}), ...transcriptProvenance(value) };
};

function transcriptProvenance(value) {
  if (value?.boundaryReview) return { localReconciled: true, provenance: { kind: String(value.boundaryReview.kind ?? 'unknown-local-review'), humanConfirmed: false } };
  return value?.provenance?.kind === 'original-provider-segments' ? { provenance: { kind: 'original-provider-segments' } } : {};
}

async function existingTranscript(root, source, loc) {
  let vtt;
  try { vtt = inside(root, transcriptPath(source.assetPath)); } catch { return null; }
  const info = await stat(vtt).catch(() => null);
  if (!info?.isFile()) return null;
  const body = await readFile(await readable(root, transcriptPath(source.assetPath)), 'utf8');
  let binding;
  try { binding = JSON.parse(await readFile(`${loc.path}.vtt-binding.json`, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  // Copying a video can make its mtime newer than an already-existing subtitle.
  // An explicit fingerprint/hash binding remains the authority for that case.
  if (info.mtimeMs < loc.fingerprint.mtimeMs && (!binding || !same(binding, loc))) return null;
  if (!binding || !same(binding, loc) || binding.sourceId !== source.id || binding.vttHash !== digest(body) || !Number.isFinite(binding.durationMs) || (Number.isFinite(source.durationMs) && source.durationMs !== binding.durationMs)) throw new Error('Existing VTT needs explicit source, duration and coverage confirmation before reuse; no audio was uploaded.');
  const cues = strictVtt(body, binding.durationMs);
  // A sidecar does not erase the origin of the effective transcript from which it was made.
  const cache = await load(loc);
  return { sourceId: source.id, text: cues.map(line => line.text).join(' '), words: [], cues, cached: true, ...transcriptProvenance(same(cache ?? {}, loc) ? cache : null) };
}

function strictVtt(body, durationMs) {
  const stamp = value => value.trim().split(':').reduce((sum, part) => sum * 60 + Number(part), 0) * 1000;
  const times = [...body.matchAll(/^([^\r\n]+?)\s+-->\s+(\S+)/gm)];
  if (!times.length || times.some(([, a, b]) => !Number.isFinite(stamp(a)) || !Number.isFinite(stamp(b)) || stamp(a) < 0 || stamp(a) >= stamp(b) || stamp(b) > durationMs)) throw new Error('VTT has invalid or out-of-range timestamps; it was not repaired or reused.');
  const cues = validateTranscriptCues(parseVtt(body).lines, durationMs);
  if (cues.length !== times.length) throw new Error('VTT contains unreadable cues; it was not partially reused.');
  return cues;
}

/** Trusted importer records a person's source confirmation; never inferred from a matching filename. */
export async function confirmProductTranscript(root, source, { durationMs = source.durationMs, sourceConfirmed = false } = {}) {
  if (!sourceConfirmed || !Number.isFinite(durationMs) || durationMs <= 0) throw new Error('Source and video duration must be explicitly confirmed.');
  if (Number.isFinite(source.durationMs) && source.durationMs !== durationMs) throw new Error('Confirmed duration does not match the source; the existing binding was preserved.');
  const loc = await location(root, source);
  const body = await readFile(await readable(root, transcriptPath(source.assetPath)), 'utf8');
  const cues = strictVtt(body, durationMs);
  await checkCachePath(loc.root, loc.dir);
  await mkdir(loc.dir, { recursive: true });
  await writeAtomic(`${loc.path}.vtt-binding.json`, JSON.stringify({ sourceId: source.id, assetPath: source.assetPath, fingerprint: loc.fingerprint, durationMs, vttHash: digest(body), coverage: cues.map(c => [c.startMs, c.endMs]) }));
  return existingTranscript(root, source, loc);
}

/** Upgrade a legacy local cache only after the user has checked its source and timing. */
export async function confirmCachedProductTranscript(root, source, { durationMs = source.durationMs, sourceConfirmed = false } = {}) {
  if (!sourceConfirmed || !Number.isFinite(durationMs) || durationMs <= 0) throw new Error('Source and video duration must be explicitly confirmed.');
  if (Number.isFinite(source.durationMs) && source.durationMs !== durationMs) throw new Error('Confirmed duration does not match the source; the existing transcript was preserved.');
  const loc = await location(root, source), previous = await load(loc);
  if (previous?.status !== 'complete' || previous.assetPath !== source.assetPath || previous.fingerprint?.size !== loc.fingerprint.size || previous.fingerprint?.mtimeMs !== loc.fingerprint.mtimeMs) throw new Error('The saved transcript does not match this source; it was not rebound.');
  validateTranscriptCues(previous.cues, durationMs);
  const next = { ...previous, durationMs, fingerprint: loc.fingerprint, sourceConfirmedAt: new Date().toISOString() };
  await save(loc, next);
  return view(next);
}

export async function readProductTranscript(root, source) {
  const loc = await location(root, source);
  const reviewed = await readReviewedTranscript(loc);
  if (reviewed) return reviewed;
  const existing = await existingTranscript(root, source, loc);
  if (existing) return existing;
  const value = await load(loc);
  await guardPartialSharedImport(loc, value);
  if (!value) return null;
  if (value.status === 'pending') {
    if (value.segmented) { const completed = await readCompletedSegmentTranscript(loc); if (completed) return completed; }
    const recovered = await savedResponse(loc, value);
    if (recovered) return view(recovered);
    throw new Error('The previous transcription may have been submitted. Check the service before retrying.');
  }
  legacyProvenance(value, loc);
  return same(value, loc) ? view(value, source.durationMs) : null;
}

/** Verified shared baseline import; never overwrites an existing local transcript/review. */
export async function importSharedProductTranscript(root, source, payload, sharedRef, { adopt = false } = {}) {
  const loc = await location(root, source);
  let existing, pending;
  try { existing = await readProductTranscript(root, source); }
  catch (error) {
    // Keep an uncertain upload record before adopting a different completed baseline.
    // A seam review or damaged cache is not a pending upload and is never bypassed.
    const old = await load(loc);
    if (old?.status !== 'pending' || old.segmented || !same(old, loc) || error.code === 'ASR_BOUNDARY_REVIEW') throw error;
    pending = old;
  }
  if (existing && !adopt) return existing;
  if (adopt) {
    if (existing?.localReconciled || await existingTranscript(root, source, loc)) throw new Error('人工核对字幕或已关联字幕保持原样；尚不支持自动替换这些字幕来源');
    const previous = await load(loc);
    await guardPartialSharedImport(loc, previous);
    if (previous) {
      await checkCachePath(loc.root, loc.dir);
      await writeAtomic(`${loc.path}.shared-previous-${digest(JSON.stringify(previous))}.json`, `${JSON.stringify(previous)}\n`);
    }
  }
  const cues = validateTranscriptCues(payload?.cues, source.durationMs);
  const words = payload?.words ?? [];
  if (words.length) validateTranscriptCues(words, source.durationMs);
  await save(loc, { version: 1, status: 'complete', sourceId: source.id, assetPath: source.assetPath, durationMs: source.durationMs, fingerprint: loc.fingerprint, cues, words, text: cues.map(c => c.text).join(' '), sharedRef, ...(pending ? { preservedPendingAttempt: pending } : {}) });
  return readProductTranscript(root, source);
}

function extractAudio(input, signal, range) {
  const trim = range ? ['-ss', String(range.startMs / 1000), '-t', String((range.endMs - range.startMs) / 1000)] : [];
  return new Promise((resolve, reject) => execFile('ffmpeg', ['-nostdin', '-v', 'error', '-i', input, ...trim, '-vn', '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-af', 'aresample=async=1:first_pts=0', '-c:a', 'libmp3lame', '-b:a', '32k', '-f', 'mp3', 'pipe:1'], { signal, windowsHide: true, encoding: 'buffer', maxBuffer: 48 << 20 }, (error, out) => error ? reject(new Error('Could not prepare audio. No audio was uploaded.')) : resolve(out)));
}

/** The provider calls this before parsing/validating the response; no request headers or audio are stored. */
function rawResponseWriter(loc, requestId) {
  return async response => {
    try {
      const dir = join(loc.dir, 'raw-responses');
      await checkCachePath(loc.root, dir); await mkdir(dir, { recursive: true }); await checkCachePath(loc.root, dir);
      const path = join(dir, `${requestId}.json`), data = JSON.stringify({ ...response, requestId, sourceId: loc.sourceId, assetPath: loc.assetPath, sourceFingerprint: loc.fingerprint });
      let previous;
      try { previous = await readFile(path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (previous !== undefined) { if (previous !== data) throw Error('Original response already exists'); return; }
      await writeAtomic(path, data);
    } catch { throw Object.assign(new Error('服务回包未能保存到本机，不能自动重发；请核对本地存储和服务记录。'), { code: 'ASR_RESPONSE_SAVE_FAILED' }); }
  };
}

export async function transcribeProductSource(root, source, { getKey, signal = new AbortController().signal, retryUncertain = false, runProvider = doubao.run.bind(doubao), readAudio = extractAudio, audioPolicy = AUDIO_SEGMENT_POLICY, probeSource = probe } = {}) {
  const key = `${root}\0${source?.id}`;
  if (running.has(key)) return running.get(key);
  const job = (async () => {
    const loc = await location(root, source);
    const reviewed = await readReviewedTranscript(loc);
    if (reviewed) return reviewed;
    const existing = await existingTranscript(root, source, loc);
    if (existing) return existing;
    const previous = await load(loc);
    await guardPartialSharedImport(loc, previous);
    legacyProvenance(previous, loc);
    if (previous?.status === 'complete' && same(previous, loc)) return view(previous, source.durationMs);
    if (previous?.importedTranscriptArtifactHash) {
      if (!same(previous, loc)) throw new Error('共享原始转写的来源已变化；请核对来源，未重新发送音频');
      const completed = await readCompletedSegmentTranscript(loc);
      if (completed) return completed;
      throw Object.assign(new Error('共享原始分段已完成，请核对本机接缝；不会重复上传音频'), { code: 'ASR_BOUNDARY_REVIEW' });
    }
    const recovered = await savedResponse(loc, previous);
    if (recovered) { await save(loc, recovered); return view(recovered); }
    if (previous?.status === 'pending' && !previous.segmented && !retryUncertain) throw new Error('The previous transcription may have been submitted. Check the service before retrying.');
    if (!Number.isFinite(source.durationMs) || source.durationMs <= 0) {
      let durationMs;
      try { durationMs = Math.floor((await probeSource(root, source.assetPath)).duration * 1000); } catch { throw notSubmitted('source'); }
      if (!Number.isFinite(durationMs) || durationMs <= 0) throw notSubmitted('source');
      source = { ...source, durationMs }; loc.durationMs = durationMs;
    }
    if (Number.isFinite(source.durationMs) && source.durationMs > audioPolicy.targetMs) return transcribeSegments(root, source, loc, { getKey, signal, retryUncertain, runProvider, readAudio, audioPolicy });
    if (previous?.status === 'pending' && !retryUncertain) throw new Error('The previous transcription may have been submitted. Check the service before retrying.');
    if (typeof getKey !== 'function') throw notSubmitted('configuration');
    let credential;
    try { credential = await getKey(); } catch { throw notSubmitted('configuration'); }
    if (typeof credential !== 'string' || !credential.trim()) throw notSubmitted('configuration');
    let audio;
    try { audio = await readAudio(loc.input, signal); } catch { throw notSubmitted('audio'); }
    if (!audio?.length || audio.length > (48 << 20)) throw notSubmitted('audio');
    let now;
    try { now = await stat(loc.input); } catch { throw notSubmitted('source'); }
    if (now.size !== loc.fingerprint.size || now.mtimeMs !== loc.fingerprint.mtimeMs || now.ctimeMs !== loc.fingerprint.ctimeMs) throw notSubmitted('source');
    const requestId = randomUUID();
    const state = { version: 1, status: 'pending', sourceId: loc.sourceId, assetPath: loc.assetPath, durationMs: source.durationMs, fingerprint: loc.fingerprint, requestId, attempts: [...(same(previous ?? {}, loc) ? previous?.attempts ?? [] : []), { requestId, startedAt: new Date().toISOString(), status: 'submitted' }] };
    await save(loc, state);
    let result;
    try { result = await runProvider('asr', { src: source.assetPath, requestId: state.requestId }, { key: credential, signal, read: async () => audio, say: () => {}, root, onResponse: rawResponseWriter(loc, state.requestId) }); }
    catch (error) { if (error.code === 'ASR_RESPONSE_SAVE_FAILED') throw error; throw new Error('Transcription failed or was interrupted after submission may have begun. Check the service before retrying.'); }
    const row = boundedResult(result?.index?.[0], source.durationMs);
    const latest = await stat(loc.input);
    if (latest.size !== loc.fingerprint.size || latest.mtimeMs !== loc.fingerprint.mtimeMs || latest.ctimeMs !== loc.fingerprint.ctimeMs || await realpath(loc.input) !== loc.fingerprint.path) throw new Error('Source changed during transcription; the result was not accepted. Check the service before retrying.');
    state.attempts.at(-1).status = 'complete';
    state.attempts.at(-1).completedAt = new Date().toISOString();
    const completed = { ...state, status: 'complete', requestId: result.receipt?.requestId ?? state.requestId, text: row.text, words: row.words.map(w => ({ text: w.token, startMs: Math.round(w.start * 1000), endMs: Math.round(w.end * 1000) })), ...(Array.isArray(row.rawWords) ? { rawWords: row.rawWords } : {}), cues: row.cues, ...(row.timingAdjustments ? { timingAdjustments: row.timingAdjustments } : {}) };
    await save(loc, completed);
    return { ...view(completed), cached: false };
  })();
  running.set(key, job);
  try { return await job; } finally { if (running.get(key) === job) running.delete(key); }
}

async function transcribeSegments(root, source, loc, { getKey, signal, retryUncertain, runProvider, readAudio, audioPolicy }) {
  const plan = planAudioSegments(source.durationMs, audioPolicy);
  const identity = digest(JSON.stringify({ sourceId: source.id, assetPath: source.assetPath, fingerprint: loc.fingerprint, durationMs: source.durationMs, plan, policyVersion: AUDIO_SEGMENT_POLICY.version, model: 'volc.bigasr.auc_turbo', audio: 'mp3-16k-mono-32k' }));
  const manifestPath = `${loc.path}.segments.json`;
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw new Error('Audio segment state cannot be read; it was not overwritten.'); }
  if (manifest && (manifest.version !== 1 || !Array.isArray(manifest.segments))) throw new Error('Invalid audio segment state; it was not overwritten.');
  if (manifest?.identity === identity && (manifest.segments.length !== plan.length || manifest.segments.some((s, i) => !['idle', 'pending', 'complete'].includes(s.status) || ['id', 'startMs', 'endMs', 'coreStartMs', 'coreEndMs'].some(field => s[field] !== plan[i][field])))) throw new Error('Audio segment plan does not match the source; it was not overwritten.');
  if (manifest?.segments.some(s => s.status === 'pending') && (!retryUncertain || manifest.identity !== identity)) throw new Error('The previous transcription may have been submitted. Check the service before retrying.');
  if (!manifest || manifest.identity !== identity) manifest = { version: 1, identity, sourceId: source.id, durationMs: source.durationMs, segments: plan.map(range => ({ ...range, status: 'idle' })) };
  const persist = async () => { await checkCachePath(loc.root, loc.dir); await mkdir(loc.dir, { recursive: true }); await writeAtomic(manifestPath, JSON.stringify(manifest)); };
  const state = { version: 1, status: 'pending', sourceId: source.id, assetPath: source.assetPath, durationMs: source.durationMs, fingerprint: loc.fingerprint, segmented: true };
  for (const segment of manifest.segments) {
    if (segment.status === 'complete') continue;
    if (signal.aborted) throw notSubmitted('audio');
    let credential, audio;
    try { credential = await getKey?.(); } catch { throw notSubmitted('configuration'); }
    if (typeof credential !== 'string' || !credential.trim()) throw notSubmitted('configuration');
    try { audio = await readAudio(loc.input, signal, segment); } catch { throw notSubmitted('audio'); }
    if (!audio?.length || audio.length > (48 << 20)) throw notSubmitted('audio');
    const now = await stat(loc.input);
    if (now.size !== loc.fingerprint.size || now.mtimeMs !== loc.fingerprint.mtimeMs || now.ctimeMs !== loc.fingerprint.ctimeMs) throw notSubmitted('source');
    segment.status = 'pending'; segment.requestId = randomUUID(); segment.startedAt = new Date().toISOString();
    segment.attempts ??= []; segment.attempts.push({ requestId: segment.requestId, startedAt: segment.startedAt, status: 'submitted' });
    await persist(); await save(loc, state);
    let result;
    try { result = await runProvider('asr', { src: source.assetPath, requestId: segment.requestId }, { key: credential, signal, read: async () => audio, say: () => {}, root, onResponse: rawResponseWriter(loc, segment.requestId) }); }
    catch (error) { if (error.code === 'ASR_RESPONSE_SAVE_FAILED') throw error; throw new Error('Transcription failed or was interrupted after submission may have begun. Check the service before retrying.'); }
    const row = boundedResult(result?.index?.[0], segment.endMs - segment.startMs);
    segment.cues = validateTranscriptCues(row?.cues, segment.endMs - segment.startMs);
    segment.words = row.words; segment.rawWords = row.rawWords; segment.text = row.text;
    if (row.timingAdjustments) segment.timingAdjustments = row.timingAdjustments;
    segment.requestId = result.receipt?.requestId ?? segment.requestId;
    segment.status = 'complete'; segment.completedAt = new Date().toISOString();
    Object.assign(segment.attempts.at(-1), { status: 'complete', completedAt: segment.completedAt });
    await persist();
  }
  const latest = await stat(loc.input);
  if (latest.size !== loc.fingerprint.size || latest.mtimeMs !== loc.fingerprint.mtimeMs || latest.ctimeMs !== loc.fingerprint.ctimeMs) throw new Error('Source changed during transcription; completed segments were preserved for inspection.');
  const cues = mergeAudioSegments(manifest.segments, source.durationMs);
  const words = manifest.segments.flatMap(s => s.words.map(w => ({ text: w.token, startMs: Math.round(w.start * 1000) + s.startMs, endMs: Math.round(w.end * 1000) + s.startMs })).filter(w => (w.startMs + w.endMs) / 2 >= s.coreStartMs && (w.startMs + w.endMs) / 2 < s.coreEndMs));
  const completed = { ...state, status: 'complete', text: cues.map(c => c.text).join(' '), cues, words, segments: manifest.segments.map(({ cues, words, rawWords, text, ...metadata }) => metadata) };
  await save(loc, completed);
  return { ...view(completed), cached: false };
}



