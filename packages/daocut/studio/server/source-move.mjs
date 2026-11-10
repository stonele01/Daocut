/** Rebind local source references after a user moves the same file inside a project. No media bytes or AI output are rewritten. */
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { writeAtomic } from './atomic.mjs';
import { HttpError } from './http.mjs';
import { readProductAnalysis } from './product-analysis.mjs';
import { productSourcePath, readProductTranscript } from './product-transcription.mjs';
import { readSourceTakes } from './source-takes.mjs';
import { AUDIO_SEGMENT_POLICY } from './transcription-segments.mjs';
import { validateDiscoveryCues } from './product-discovery.mjs';

const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => [key, canonical(value[key])])) : value;
const discoveryHash = value => hash(JSON.stringify(canonical(value)));
const fail = message => { throw new HttpError(409, `素材关联：${message}，未接受新的关联。`); };
const fp = (info, path) => ({ size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, path });
const liveFp = info => `${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}`;
const effectiveHash = data => discoveryHash({ sources: data.sources, products: data.products, intervals: data.intervals, scopes: data.scopes ?? [], unassigned: data.unassigned ?? [] });

export async function prepareSourceMove(root, from, to) {
  const where = path => path === from ? to : path?.startsWith(`${from}/`) ? to + path.slice(from.length) : path;
  const files = new Map();
  async function load(path) {
    let text; try { text = await readFile(join(root, path), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    let value; try { value = JSON.parse(text); } catch { fail(`${path} 无法读取，请先恢复该记录`); }
    files.set(path, { text, value, changed: false }); return value;
  }
  let product = await load('.film/product-analysis.json');
  if (product) await readProductAnalysis(root); // Validate both current data and the saved undo snapshot before moving.
  let takes = await load('.film/source-takes.json');
  if (takes && (takes.version !== 1 || !Array.isArray(takes.sources))) fail('取用记录无法读取');
  const manifest = await load('assets/.daocut-source-media.json');
  if (manifest && (manifest.version !== 1 || !manifest.items || typeof manifest.items !== 'object' || Array.isArray(manifest.items))) fail('共享来源清单无法读取');
  const sources = (product?.sources ?? []).filter(source => where(source.assetPath) !== source.assetPath).map(source => ({ ...source, registered: true }));
  for (const saved of takes?.sources ?? []) {
    const doc = saved.document;
    if (!doc || typeof doc.assetPath !== 'string') fail('取用记录无法读取');
    if (where(doc.assetPath) === doc.assetPath) continue;
    await readSourceTakes(root, doc.sourceId, doc.assetPath); // Refuse a stale take instead of laundering it into a new source.
    if (!sources.some(source => source.id === doc.sourceId)) sources.push({ id: doc.sourceId, assetPath: doc.assetPath, durationMs: doc.durationMs, registered: false });
  }
  const records = [];
  for (const source of sources) {
    const path = await realpath(await productSourcePath(root, source.assetPath)), info = await stat(path);
    const record = { source, path, info, fingerprint: fp(info, path), nextAsset: where(source.assetPath), cachePath: `.film/product-transcripts/${hash(source.id)}.json` };
    record.cache = await load(record.cachePath);
    record.binding = await load(`${record.cachePath}.vtt-binding.json`);
    record.segments = await load(`${record.cachePath}.segments.json`);
    record.review = await load(`${record.cachePath}.review.json`);
    record.livePath = `.film/live-analysis/${hash(source.id)}.json`; record.live = await load(record.livePath);
    record.discoveryPath = `.film/product-discovery/${discoveryHash(source.id)}.json`; record.discovery = await load(record.discoveryPath);
    for (const value of [record.cache, record.binding].filter(Boolean)) {
      if (value.sourceId !== source.id || value.assetPath !== source.assetPath || !['size', 'mtimeMs', 'ctimeMs', 'path'].every(key => value.fingerprint?.[key] === record.fingerprint[key])) fail('已有转写与原片不一致，请先核对');
    }
    if (record.cache?.status === 'pending' && !record.segments?.segments?.every(segment => segment.status === 'complete')) fail('转写可能仍在执行或提交不明，请先核对任务');
    if (record.live && (record.live.analysis?.status === 'running' || record.live.transcription?.status === 'running' || Object.values(record.live.analyses ?? {}).some(item => item.status === 'running'))) fail('分析任务尚未结束，请先核对任务');
    if (record.discovery && (!Array.isArray(record.discovery.runs) || record.discovery.runs.some(run => run.status === 'running'))) fail('拆品任务尚未结束或记录无效');
    if (record.segments) {
      const segments = record.segments;
      if (segments.version !== 1 || segments.sourceId !== source.id || !Array.isArray(segments.segments)) fail('分段记录无效');
      record.plan = segments.segments.map(({ id, coreStartMs, coreEndMs, startMs, endMs }) => ({ id, coreStartMs, coreEndMs, startMs, endMs }));
      record.segmentIdentity = (assetPath, fingerprint) => hash(JSON.stringify({ sourceId: source.id, assetPath, fingerprint, durationMs: source.durationMs, plan: record.plan, policyVersion: AUDIO_SEGMENT_POLICY.version, model: 'volc.bigasr.auc_turbo', audio: 'mp3-16k-mono-32k' }));
      if (segments.identity !== record.segmentIdentity(source.assetPath, record.fingerprint)) fail('旧分段身份无法安全迁移，请先核对');
    }
    if (record.review) {
      const previous = hash({ manifest: hash(files.get(`${record.cachePath}.segments.json`)?.text ?? ''), sourceId: source.id, assetPath: source.assetPath, fingerprint: record.fingerprint, durationMs: source.durationMs });
      if (record.review.identity !== previous) fail('接缝修正与分段来源不一致');
    }
    if (record.discovery) {
      try { record.transcript = await readProductTranscript(root, source); }
      catch (error) { if (error.code !== 'ASR_BOUNDARY_REVIEW' && error.status !== 409) throw error; }
    }
    records.push(record);
  }
  // Only project asset keys change. The NAS library ID and relative path continue to identify the original file.
  if (manifest) {
    const next = {};
    for (const [asset, entry] of Object.entries(manifest.items)) {
      const target = where(asset);
      if (Object.hasOwn(next, target)) fail('目标已有不同共享来源');
      next[target] = entry;
    }
    if (JSON.stringify(next) !== JSON.stringify(manifest.items)) { manifest.items = next; files.get('assets/.daocut-source-media.json').changed = true; }
  }
  const oldBase = product ? effectiveHash(product) : null;
  if (product) {
    for (const data of [product, product.history].filter(Boolean)) for (const source of data.sources ?? []) source.assetPath = where(source.assetPath);
    if (JSON.stringify(product) !== JSON.stringify(JSON.parse(files.get('.film/product-analysis.json').text))) files.get('.film/product-analysis.json').changed = true;
  }
  let newBase = product ? effectiveHash(product) : null;
  const written = [];
  const unchanged = async () => {
    for (const [path, saved] of files) if (await readFile(join(root, path), 'utf8') !== saved.text) fail('移动期间其他操作已更新工程，请重试');
  };
  const transaction = {
    check: unchanged,
    async commit() {
      await unchanged();
      // Local media resolve at the new project path; managed links retain their original external target.
      for (const item of records) {
        const { source, cachePath, cache, binding, segments, review, live, discovery } = item;
        const path = await realpath(join(root, item.nextAsset)), info = await stat(path), fingerprint = fp(info, path);
        if (info.size !== item.info.size || info.mtimeMs !== item.info.mtimeMs || info.ino !== item.info.ino) fail('原片在移动期间发生变化');
        for (const [name, value] of [[cachePath, cache], [`${cachePath}.vtt-binding.json`, binding]]) if (value) { value.assetPath = item.nextAsset; value.fingerprint = fingerprint; files.get(name).changed = true; }
        if (segments) { segments.identity = item.segmentIdentity(item.nextAsset, fingerprint); files.get(`${cachePath}.segments.json`).changed = true; }
        if (review) {
          const saved = files.get(`${cachePath}.segments.json`);
          const manifestText = JSON.stringify(saved.value) !== JSON.stringify(JSON.parse(saved.text)) ? `${JSON.stringify(segments)}\n` : saved.text;
          review.identity = hash({ manifest: hash(manifestText), sourceId: source.id, assetPath: item.nextAsset, fingerprint, durationMs: source.durationMs }); files.get(`${cachePath}.review.json`).changed = true;
        }
        if (live) {
          const before = { assetPath: source.assetPath, path: item.path, fingerprint: liveFp(item.info) }, after = { assetPath: item.nextAsset, path, fingerprint: liveFp(info) };
          const previous = live.movedSource;
          const original = previous && JSON.stringify(previous.current) === JSON.stringify(before) ? previous.original : before;
          live.movedSource = { original, current: after };
          if (live.transcription?.sourceFingerprint === before.fingerprint) live.transcription.sourceFingerprint = after.fingerprint;
          for (const state of [live.analysis, ...Object.values(live.analyses ?? {}), ...Object.values(live.results ?? {})]) if (state?.sourceFingerprint === before.fingerprint) {
            state.sourceFingerprint = after.fingerprint;
            if (state.sharedRef && state.transcriptHash) state.sharedSignature = hash({ fingerprint: after.fingerprint, transcript: state.transcriptHash, intervalId: state.intervalId, productId: state.productId, startMs: state.rangeStartMs, endMs: state.rangeEndMs });
          }
          files.get(item.livePath).changed = true;
        }
        if (discovery) {
          if (item.transcript) {
            const cues = validateDiscoveryCues(item.transcript.cues, source.durationMs).map(({ index: ignored, ...cue }) => cue);
            const make = (assetPath, resolvedPath, metadata) => discoveryHash({ sourceId: source.id, assetPath, resolvedPath, size: metadata.size, mtimeMs: metadata.mtimeMs, ctimeMs: metadata.ctimeMs, ino: metadata.ino, durationMs: source.durationMs });
            const oldFingerprint = make(source.assetPath, item.path, item.info), nextFingerprint = make(item.nextAsset, path, info);
            const oldInput = discoveryHash({ fingerprint: oldFingerprint, durationMs: source.durationMs, cues }), nextInput = discoveryHash({ fingerprint: nextFingerprint, durationMs: source.durationMs, cues });
            for (const run of discovery.runs) if (run.inputHash === oldInput) { run.inputHash = nextInput; run.fingerprint = nextFingerprint; if (run.baseHash === oldBase) run.baseHash = newBase; }
          }
          files.get(item.discoveryPath).changed = true;
        }
        for (const saved of takes?.sources ?? []) if (saved.document.sourceId === source.id) {
          const doc = saved.document; doc.assetPath = item.nextAsset;
          if (!source.registered && doc.sourceId === source.assetPath) doc.sourceId = item.nextAsset;
          const signature = JSON.parse(doc.signature); signature[0] = item.nextAsset; doc.signature = JSON.stringify(signature);
          for (const track of doc.film.tracks) for (const clip of track.clips) clip.src = item.nextAsset;
          saved.sourceIdentity = hash(JSON.stringify({ sourceId: doc.sourceId, assetPath: item.nextAsset, size: info.size, mtimeMs: info.mtimeMs }));
          files.get('.film/source-takes.json').changed = true;
        }
      }
      for (const [path, saved] of files) if (saved.changed && JSON.stringify(saved.value) !== JSON.stringify(JSON.parse(saved.text))) { await writeAtomic(join(root, path), `${JSON.stringify(saved.value)}\n`); written.push(path); }
    },
    async rollback() {
      for (const path of [...written].reverse()) await writeAtomic(join(root, path), files.get(path).text);
      written.length = 0;
      // Rename back can change ctime even though the original file's bytes and location are restored.
      // Rebind only those machine-local fingerprints, so a failed move cannot discard already-paid work.
      for (const saved of files.values()) { saved.value = JSON.parse(saved.text); saved.changed = false; }
      product = files.get('.film/product-analysis.json')?.value;
      takes = files.get('.film/source-takes.json')?.value;
      newBase = oldBase;
      for (const item of records) {
        item.nextAsset = item.source.assetPath;
        item.cache = files.get(item.cachePath)?.value;
        item.binding = files.get(`${item.cachePath}.vtt-binding.json`)?.value;
        item.segments = files.get(`${item.cachePath}.segments.json`)?.value;
        item.review = files.get(`${item.cachePath}.review.json`)?.value;
        item.live = files.get(item.livePath)?.value;
        item.discovery = files.get(item.discoveryPath)?.value;
      }
      await transaction.commit();
    },
  };
  return transaction;
}
