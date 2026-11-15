/** Local-only seam review. Provider manifests and the previous effective cache are never overwritten here. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inspectAudioSeams, resolveAudioSeams, validateSeamResolution } from './transcription-seams.mjs';
import { writeAtomic } from './atomic.mjs';
import { readProductAnalysis } from './product-analysis.mjs';
import { HttpError, json, readJson } from './http.mjs';

const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const same = (value, loc) => value?.sourceId === loc.sourceId && value.assetPath === loc.assetPath && ['size', 'mtimeMs', 'ctimeMs', 'path'].every(key => value.fingerprint?.[key] === loc.fingerprint[key]);
const overlap = (a, b) => a.startMs < b.endMs && a.endMs > b.startMs;
const writes = new Map();
const optional = async path => { try { return await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };

async function load(loc) {
  const manifestText = await optional(`${loc.path}.segments.json`);
  if (manifestText === null) return null;
  let manifest, cache;
  try { manifest = JSON.parse(manifestText); cache = JSON.parse(await readFile(loc.path, 'utf8')); }
  catch { throw new HttpError(409, '分段记录无法读取，原始结果未覆盖'); }
  if (!same(cache, loc) || cache.durationMs !== loc.durationMs || manifest.sourceId !== loc.sourceId || manifest.durationMs !== loc.durationMs) throw new HttpError(409, '来源视频或分段记录已变化，请重新核对；没有发送请求');
  if (!Array.isArray(manifest.segments) || manifest.version !== 1) throw new HttpError(409, '分段记录无效，原始结果未覆盖');
  if (!manifest.segments.every(segment => segment.status === 'complete')) return null;
  let inspection;
  try { inspection = inspectAudioSeams(manifest.segments, loc.durationMs); }
  catch { throw new HttpError(409, '分段时间或字幕记录无效，无法安全核对；没有重新发送请求'); }
  if (!inspection.seams.length) return null;
  const identity = hash({ manifest: hash(manifestText), sourceId: loc.sourceId, assetPath: loc.assetPath, fingerprint: loc.fingerprint, durationMs: loc.durationMs });
  const text = await optional(`${loc.path}.review.json`);
  let saved = { version: 1, identity, revision: 0, resolutions: {}, history: [] };
  if (text !== null) {
    try {
      saved = JSON.parse(text);
      if (saved.version !== 1 || saved.identity !== identity || !Number.isSafeInteger(saved.revision) || saved.revision < 1 || !saved.resolutions || typeof saved.resolutions !== 'object' || Array.isArray(saved.resolutions) || !Array.isArray(saved.history)) throw Error();
      for (const [id, resolution] of Object.entries(saved.resolutions)) {
        const seam = inspection.seams.find(item => item.id === id); if (!seam) throw Error();
        validateSeamResolution(seam, resolution.cues);
      }
    } catch { throw new HttpError(409, '接缝修订与原始记录不一致或无法读取，已保留原记录'); }
  }
  return { manifest, cache, inspection, identity, saved };
}

const status = (loc, data) => {
  if (!data) return { available: false, sourceId: loc.sourceId };
  const seams = data.inspection.seams.map(seam => ({ ...seam, ...(data.saved.resolutions[seam.id] ? { status: 'confirmed', resolved: data.saved.resolutions[seam.id].cues } : {}) }));
  const pendingCount = seams.filter(seam => seam.status === 'pending').length;
  return { available: true, sourceId: loc.sourceId, source: { assetPath: loc.assetPath, durationMs: loc.durationMs }, identity: data.identity, revision: data.saved.revision,
    pendingCount, complete: pendingCount === 0, seams,
    ...(data.cache.boundaryReview ? { legacyReview: String(data.cache.boundaryReview.kind ?? '既有离线复核记录') } : {}),
    activeTranscriptPreserved: data.cache.status === 'complete' && pendingCount > 0 };
};

async function sourceLocation(root, sourceId) {
  const { analysis } = await readProductAnalysis(root);
  const source = analysis.sources.find(item => item.id === sourceId);
  if (!source) throw new HttpError(404, '来源视频不存在');
  const { transcriptionLocation } = await import('./product-transcription.mjs');
  return { loc: await transcriptionLocation(root, source), analysis };
}
async function impact(root, analysis, sourceId) {
  let discoverySaved;
  try { discoverySaved = await optional(join(root, '.film/product-discovery', `${hash(JSON.stringify(sourceId))}.json`)) !== null; }
  catch { discoverySaved = true; } // An unreadable result is still potentially affected; do not hide the warning.
  return { discovery: discoverySaved || !!(analysis.discoveryApplied ?? []).some(item => item.sourceId === sourceId) || analysis.intervals.some(item => item.sourceId === sourceId),
    ranges: analysis.intervals.filter(item => item.sourceId === sourceId).map(item => ({ productId: item.productId, productName: analysis.products.find(p => p.id === item.productId)?.name ?? '未命名商品', intervalId: item.id, startMs: item.startMs, endMs: item.endMs })) };
}

export async function readTranscriptReview(root, sourceId) {
  const { loc, analysis } = await sourceLocation(root, sourceId), result = status(loc, await load(loc));
  return { ...result, ...(result.available ? { impact: await impact(root, analysis, sourceId) } : {}) };
}

/** Only confirmed local resolutions can change the effective transcript, once every ambiguous seam is resolved. */
export async function readReviewedTranscript(loc) {
  if (await optional(`${loc.path}.review.json`) === null) return null;
  const data = await load(loc);
  if (!data) throw new HttpError(409, '人工接缝修订依赖的完整原始分段缺失，未回退或覆盖旧字幕');
  const current = status(loc, data);
  if (!current.complete && data.cache.status === 'complete') return null;
  return materialize(loc, data, current);
}

export async function readCompletedSegmentTranscript(loc) {
  const data = await load(loc);
  if (!data || data.cache.status !== 'pending') return null;
  return materialize(loc, data, status(loc, data));
}

function materialize(loc, data, current) {
  const resolutions = Object.fromEntries(Object.entries(data.saved.resolutions).map(([id, value]) => [id, value.cues]));
  const cues = resolveAudioSeams(data.inspection, resolutions);
  const unalignedRanges = current.seams.filter(seam => seam.status === 'confirmed').map(({ startMs, endMs }) => ({ startMs, endMs }));
  const words = data.inspection.words.filter(word => !unalignedRanges.some(range => overlap(word, range)));
  return { sourceId: loc.sourceId, text: cues.map(cue => cue.text).join(' '), cues, words, unalignedRanges, cached: true, localReconciled: unalignedRanges.length > 0, reviewRevision: data.saved.revision };
}

export async function saveTranscriptReview(root, body) {
  if (body?.confirmed !== true || body.acknowledgeImpact !== true || typeof body.identity !== 'string' || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0 || typeof body.seamId !== 'string') throw new HttpError(400, '请核对接缝及下游影响后确认保存');
  const key = `${root}\0${body.sourceId}`, previous = writes.get(key) ?? Promise.resolve();
  const job = previous.catch(() => {}).then(async () => {
    const { loc } = await sourceLocation(root, body.sourceId), data = await load(loc);
    if (!data || data.identity !== body.identity) throw new HttpError(409, '来源或原始分段已变化，请重新读取接缝');
    const seam = data.inspection.seams.find(item => item.id === body.seamId);
    if (!seam) throw new HttpError(400, '接缝不存在');
    let cues;
    try { cues = validateSeamResolution(seam, body.cues); } catch (error) { throw new HttpError(400, error.message); }
    const current = data.saved.resolutions[seam.id];
    if (current && JSON.stringify(current.cues) === JSON.stringify(cues) && body.expectedRevision <= data.saved.revision) return readTranscriptReview(root, body.sourceId);
    if (data.saved.revision !== body.expectedRevision) throw new HttpError(409, '其他窗口已保存接缝修改，请重新读取后再保存');
    const next = structuredClone(data.saved), confirmedAt = new Date().toISOString();
    next.revision++; next.resolutions[seam.id] = { cues, confirmedAt };
    next.history.push({ seamId: seam.id, revision: next.revision, confirmedAt, before: current?.cues ?? null, after: cues });
    // Validate the completed transcript before publishing the authoritative review file.
    if (data.inspection.seams.every(item => item.status !== 'pending' || next.resolutions[item.id])) resolveAudioSeams(data.inspection, Object.fromEntries(Object.entries(next.resolutions).map(([id, value]) => [id, value.cues])));
    const fresh = await sourceLocation(root, body.sourceId), latest = await load(fresh.loc);
    if (!latest || latest.identity !== data.identity || latest.saved.revision !== data.saved.revision) throw new HttpError(409, '保存期间来源或修订已变化，请重新核对');
    await writeAtomic(`${loc.path}.review.json`, `${JSON.stringify(next)}\n`);
    return readTranscriptReview(root, body.sourceId);
  });
  writes.set(key, job); try { return await job; } finally { if (writes.get(key) === job) writes.delete(key); }
}

export async function transcriptReviewRoute(req, res, root, rest) {
  if (rest !== 'transcript-review') return false;
  if (req.method === 'GET') { json(res, 200, await readTranscriptReview(root, new URL(req.url, 'http://localhost').searchParams.get('sourceId'))); return true; }
  if (req.method === 'PUT') { json(res, 200, await saveTranscriptReview(root, await readJson(req))); return true; }
  return false;
}
