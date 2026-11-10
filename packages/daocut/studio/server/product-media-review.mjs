// Local media evidence for one selected product lecture. No model or ASR client.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { look } from '../../src/look.mjs';
import { productSourcePath } from './product-transcription.mjs';
import { writeAtomic } from './atomic.mjs';

export const PRODUCT_MEDIA_REVIEW_VERSION = 'product-media-review-v1';
const TOOL_VERSION = 'look-media-technical-v1';
const pending = new Map();
const sha = value => createHash('sha256').update(value).digest('hex');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const range = value => record(value) && Number.isFinite(value.startMs) && Number.isFinite(value.endMs) && value.startMs >= 0 && value.startMs < value.endMs;
const within = (value, scope) => range(value) && value.startMs >= scope.startMs && value.endMs <= scope.endMs;
const invalid = () => { throw new Error('音画核查记录或讲解范围无效'); };
const boundaries = ({ startMs, endMs }) => ({ startMs, endMs });
export const mediaReviewCandidatesHash = candidates => sha(JSON.stringify(candidates.map(candidate => ({
  ...boundaries(candidate), ...(candidate.cueRange ? { cueRange: [...candidate.cueRange] } : {}),
})).sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || JSON.stringify(a).localeCompare(JSON.stringify(b)))));

/** Validate stored/shared evidence without reading media or invoking a tool. */
export function validateProductMediaReview(value, scope) {
  if (!range(scope) || !record(value) || value.version !== PRODUCT_MEDIA_REVIEW_VERSION || !['complete', 'failed'].includes(value.status) || (value.status === 'complete' && (!hex(value.key) || !hex(value.sourceSha))) || (value.key !== undefined && !hex(value.key)) || (value.sourceSha !== undefined && !hex(value.sourceSha)) || !range(value.scope) || value.scope.startMs !== scope.startMs || value.scope.endMs !== scope.endMs || value.speechVerified !== false || value.continuousActionVerified !== false || !strings(value.issues) || !Array.isArray(value.segments)) invalid();
  for (const segment of value.segments) {
    if (!within(segment, scope) || !strings(segment.issues) || !record(segment.visual) || !['sampled','unavailable'].includes(segment.visual.status) || !Array.isArray(segment.visual.sampleTimesMs) || segment.visual.sampleTimesMs.some(time => !Number.isFinite(time) || time < segment.startMs || time >= segment.endMs) || (segment.visual.status === 'sampled') !== (segment.visual.sampleTimesMs.length > 0) || (segment.visual.artifactSha256 !== undefined && !hex(segment.visual.artifactSha256))) invalid();
    if (segment.cueRange !== undefined && (!Array.isArray(segment.cueRange) || segment.cueRange.length !== 2 || !segment.cueRange.every(index => Number.isInteger(index) && index >= 0) || segment.cueRange[0] > segment.cueRange[1])) invalid();
    if (!record(segment.audio) || !['technical-checked','unavailable'].includes(segment.audio.status)) invalid();
    if (segment.audio.status === 'technical-checked' && (typeof segment.audio.hasAudio !== 'boolean' || !range(segment.audio.measurementRange) || segment.audio.measurementRange.startMs !== scope.startMs || segment.audio.measurementRange.endMs !== scope.endMs)) invalid();
    for (const key of ['peakDb','integratedLufs']) if (segment.audio[key] !== undefined && !Number.isFinite(segment.audio[key])) invalid();
    if (segment.audio.silent !== undefined && typeof segment.audio.silent !== 'boolean') invalid();
  }
  return value;
}

async function hashFile(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

async function cacheDirectory(root, parts) {
  const base = await realpath(root);
  let path = base;
  for (const part of parts) {
    path = join(path, part);
    await mkdir(path, { recursive: true });
    const local = relative(base, await realpath(path));
    if (!local || local === '..' || local.startsWith(`..${sep}`) || resolve(base, local) !== resolve(path)) throw new Error('音画核查缓存必须位于本人工程内');
  }
  return path;
}

async function inspectWithLook({ sourcePath, scope, outputDir, count }) {
  return look([sourcePath, `${scope.startMs / 1000}-${scope.endMs / 1000}`], { count, outputDir, technical: true });
}

/** inspectMedia is a local tool adapter, never a model client. */
export function createProductMediaReview({ inspectMedia = inspectWithLook } = {}) {
  if (typeof inspectMedia !== 'function') throw new Error('音画检查工具不可用');
  return async function review(root, source, scope, candidates = []) {
    if (!range(scope) || typeof source?.id !== 'string' || source.id !== scope.sourceId || typeof scope.productId !== 'string' || !scope.productId || typeof scope.intervalId !== 'string' || !scope.intervalId || !Array.isArray(candidates) || (Number.isFinite(source.durationMs) && scope.endMs > source.durationMs)) throw new Error('音画核查来源或讲解范围无效');
    if (candidates.some(candidate => !within(candidate, scope) || candidate.sourceId !== source.id || candidate.productId !== scope.productId || candidate.intervalId !== scope.intervalId)) throw new Error('音画核查候选不属于本次讲解范围');
    const sourcePath = await productSourcePath(root, source.assetPath);
    if (!(await stat(sourcePath)).isFile()) throw new Error('音画核查来源不是文件');
    const sourceSha = await hashFile(sourcePath);
    const ranges = candidates.map(candidate => ({ ...boundaries(candidate), ...(candidate.cueRange ? { cueRange: [...candidate.cueRange] } : {}) }));
    const key = sha(JSON.stringify({ sourceSha, scope: boundaries(scope), ranges, tool: TOOL_VERSION }));
    const queueKey = `${await realpath(root)}\0${key}`;
    if (pending.has(queueKey)) return structuredClone(await pending.get(queueKey));
    const work = (async () => {
      const records = await cacheDirectory(root, ['.film', 'media-review']);
      const file = join(records, `${key}.json`);
      let saved;
      try { saved = JSON.parse(await readFile(file, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw new Error('音画核查记录无法读取，原记录未覆盖'); }
      if (saved) {
        validateProductMediaReview(saved, scope);
        if (saved.key !== key || saved.sourceSha !== sourceSha) throw new Error('音画核查缓存身份不一致，原记录未覆盖');
        if (saved.status === 'complete') return saved;
      }
      const base = { version: PRODUCT_MEDIA_REVIEW_VERSION, key, sourceSha, scope: boundaries(scope), speechVerified: false, continuousActionVerified: false };
      let result;
      try {
        const outputDir = await cacheDirectory(root, ['.film', 'cache', 'product-media-review', key]);
        const inspected = await inspectMedia({ sourcePath, scope: { ...scope }, outputDir, count: 12 });
        const media = inspected?.media;
        if (inspected?.ok !== true || !record(media) || typeof media.hasVideo !== 'boolean' || typeof media.hasAudio !== 'boolean' || media.startMs !== scope.startMs || media.endMs !== scope.endMs || !Array.isArray(media.sampleTimesMs) || media.sampleTimesMs.some(time => !Number.isFinite(time) || time < scope.startMs || time >= scope.endMs) || !Array.isArray(inspected.files)) throw new Error('MEDIA_TOOL_RESULT_INVALID');
        if (await hashFile(sourcePath) !== sourceSha) throw new Error('MEDIA_SOURCE_CHANGED');
        let artifactSha256;
        if (inspected.files.length) {
          const artifact = await realpath(inspected.files[0]);
          const local = relative(await realpath(outputDir), artifact);
          if (!local || local === '..' || local.startsWith(`..${sep}`)) throw new Error('MEDIA_ARTIFACT_OUTSIDE_PROJECT');
          artifactSha256 = await hashFile(artifact);
        }
        if (media.hasVideo && media.sampleTimesMs.length && !artifactSha256) throw new Error('MEDIA_FRAME_ARTIFACT_MISSING');
        const audio = { status: 'technical-checked', hasAudio: media.hasAudio, measurementRange: boundaries(scope),
          ...(Number.isFinite(media.peakDb) ? { peakDb: media.peakDb } : {}), ...(Number.isFinite(media.integratedLufs) ? { integratedLufs: media.integratedLufs } : {}), ...(media.silent === true ? { silent: true } : {}) };
        const issues = ['画面仅作抽帧记录，未确认连续动作；原音语义、断字与气口未核听', ...(!media.hasVideo ? ['来源没有可抽取画面'] : []), ...(!media.hasAudio ? ['来源没有音轨'] : [])];
        const segments = (ranges.length ? ranges : [boundaries(scope)]).map(item => {
          const sampleTimesMs = media.hasVideo ? media.sampleTimesMs.filter(time => time >= item.startMs && time < item.endMs) : [];
          return { ...item, visual: { status: sampleTimesMs.length ? 'sampled' : 'unavailable', sampleTimesMs, ...(sampleTimesMs.length && artifactSha256 ? { artifactSha256 } : {}) }, audio: { ...audio }, issues: sampleTimesMs.length ? [] : ['该片段没有抽到画面，不能据此确认产品展示'] };
        });
        result = { ...base, status: 'complete', segments, issues };
      } catch {
        result = { ...base, status: 'failed', segments: [], issues: ['本地音画工具核查未完成；文字分析仍可复用，请检查素材或工具后恢复核查'] };
      }
      validateProductMediaReview(result, scope);
      await writeAtomic(file, `${JSON.stringify(result)}\n`);
      return result;
    })();
    pending.set(queueKey, work);
    try { return structuredClone(await work); }
    finally { pending.delete(queueKey); }
  };
}
