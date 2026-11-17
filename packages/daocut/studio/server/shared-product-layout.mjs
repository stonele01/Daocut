/** Share confirmed product topology separately from immutable AI results.
 * Recovery scopes and candidate IDs stay intact for existing private drafts. */
import { mkdir, readFile, readdir, rmdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { sharedHash } from './shared-analysis.mjs';
import { readProductAnalysis, updateProductAnalysis, validateProductAnalysis } from './product-analysis.mjs';
import { writeAtomic } from './atomic.mjs';
import { HttpError } from './http.mjs';

const read = async path => { try { return JSON.parse(await readFile(path, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const ranges = a => [...a.intervals, ...(a.scopes ?? [])];
const failure = message => new HttpError(409, `商品关联同步：${message}；已有结果保留，没有重新分析`);
const identity = (root, sourceId) => sharedHash([resolve(root), sourceId]);
const clean = item => Object.fromEntries(Object.entries(item).filter(([key]) => !['sharedLayoutHidden', 'sharedOriginalId', 'savedResultScopeId'].includes(key)));

export async function exportProductLayout(root, sourceId, analysis) {
  const source = analysis.sources.find(s => s.id === sourceId);
  const live = await read(join(root, '.film/live-analysis', `${sharedHash(sourceId)}.json`));
  const records = [];
  for (const name of await readdir(join(root, '.film/shared-analysis')).catch(e => { if (e.code === 'ENOENT') return []; throw e; })) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const r = await read(join(root, '.film/shared-analysis', name));
    if (r?.sourceId === sourceId && r.status === 'complete' && r.snapshot?.action === 'analysis' && sharedHash(r.snapshot) === r.result?.sha256) records.push(r);
  }
  const selected = ranges(analysis).filter(r => r.sourceId === sourceId && !r.sharedLayoutHidden);
  const ids = new Map([...analysis.products, ...selected].map(r => [r.id, r.sharedOriginalId ?? r.id]));
  const products = analysis.products.filter(p => p.sourceIds.includes(sourceId) && !p.sharedLayoutHidden).map(p => ({ ...clean(p), id: ids.get(p.id), sourceIds: ['public-source'], ...(p.joinedInto ? { joinedInto: ids.get(p.joinedInto) } : {}) }));
  const links = {};
  for (const range of selected) {
    const actual = range.savedResultScopeId ? ranges(analysis).find(r => r.id === range.savedResultScopeId) : range;
    const saved = live?.analyses?.[actual?.id];
    const refs = records.filter(r => r.result.sha256 === (saved?.sharedRef?.sha256 ?? saved?.historicalRef?.sha256)
      || r.descriptor?.localScope?.intervalId === actual?.id
      || r.snapshot.payload?.originalRunId && r.snapshot.payload.originalRunId === saved?.currentRunId);
    const exact = [...new Set(refs.filter(r => r.snapshot.scope?.startMs === range.startMs && r.snapshot.scope?.endMs === range.endMs).map(r => r.result.sha256))];
    if (exact.length === 1) links[ids.get(range.id)] = exact[0];
    else if (analysis.candidates.some(c => c.intervalId === actual?.id)) throw failure(`范围 ${range.id} 的原始结果尚未完整共享`);
  }
  const convert = r => ({ ...clean(r), id: ids.get(r.id), productId: ids.get(r.productId), sourceId: 'public-source', ...(r.joinedScopeIds ? { joinedScopeIds: r.joinedScopeIds.map(id => ids.get(id)) } : {}) });
  const layout = { version: 1, sources: [{ ...source, id: 'public-source', assetPath: 'assets/shared-video' }], products,
    intervals: analysis.intervals.filter(r => selected.includes(r)).map(convert), scopes: (analysis.scopes ?? []).filter(r => selected.includes(r)).map(convert),
    unassigned: (analysis.unassigned ?? []).filter(r => r.sourceId === sourceId).map(r => ({ ...clean(r), id: r.sharedOriginalId ?? r.id, sourceId: 'public-source' })), candidates: [] };
  validateProductAnalysis(layout);
  return { layout, links };
}

export function applyProductLayout(analysis, sourceId, document, live) {
  validateProductAnalysis(document.layout);
  const next = structuredClone(analysis);
  const prefix = id => `layout-${sharedHash([sourceId, document.revision, id])}`;
  const all = ranges(next);
  const target = new Map();
  for (const [id, sha] of Object.entries(document.links)) {
    const matches = all.filter(r => r.sourceId === sourceId && [live?.analyses?.[r.id]?.sharedRef?.sha256, live?.analyses?.[r.id]?.historicalRef?.sha256].includes(sha));
    const original = ranges(document.layout).find(r => r.id === id);
    if (matches.length !== 1 || !original || matches[0].startMs !== original.startMs || matches[0].endMs !== original.endMs) throw failure(`原分析 ${id} 尚未完整读取`);
    target.set(id, matches[0].id);
  }
  // Retain every old scope and its owner; private drafts continue referencing them.
  // Keep earlier display IDs too: a private composed draft can reference a
  // joined display range even when that range has no candidates of its own.
  next.scopes ??= [];
  const retained = next.intervals.filter(r => r.sourceId === sourceId);
  next.intervals = next.intervals.filter(r => r.sourceId !== sourceId);
  for (const r of retained) {
    next.scopes.push({ ...r, kind: 'historical-analysis', confirmed: true,
      ...(r.joinedScopeIds?.length ? { origin: 'shared-composition', analysisRevision: r.analysisRevision ?? sharedHash(r.joinedScopeIds.map(id => {
        const part = all.find(p => p.id === id);
        return live?.analyses?.[part?.savedResultScopeId ?? id]?.sharedRef?.sha256;
      })) } : {}), sharedLayoutHidden: true });
  }
  for (const p of next.products) if (p.sourceIds.length === 1 && p.sourceIds[0] === sourceId) p.sharedLayoutHidden = true;
  for (const r of next.scopes) if (r.sourceId === sourceId) r.sharedLayoutHidden = true;
  const convert = r => ({ ...r, id: prefix(r.id), sharedOriginalId: r.id, productId: prefix(r.productId), sourceId,
    ...(r.joinedScopeIds ? { joinedScopeIds: r.joinedScopeIds.map(prefix) } : {}), ...(target.has(r.id) ? { savedResultScopeId: target.get(r.id) } : {}) });
  const incoming = document.layout;
  const incomingProducts = new Set(incoming.products.map(p => prefix(p.id)));
  const incomingRanges = new Set(ranges(incoming).map(r => prefix(r.id)));
  // Returning to a previously published layout reuses its stable references.
  next.products = next.products.filter(p => !incomingProducts.has(p.id));
  next.scopes = next.scopes.filter(r => !incomingRanges.has(r.id));
  next.products.push(...incoming.products.map(p => ({ ...p, id: prefix(p.id), sharedOriginalId: p.id, sourceIds: [sourceId], ...(p.joinedInto ? { joinedInto: prefix(p.joinedInto) } : {}) })));
  next.intervals.push(...incoming.intervals.map(convert));
  next.scopes.push(...(incoming.scopes ?? []).map(convert));
  // Bind joined entries to the existing composition, identified by ordered result hashes.
  for (const r of ranges(next).filter(r => !r.sharedLayoutHidden && r.sharedOriginalId && r.joinedScopeIds?.length)) {
    const parts = r.joinedScopeIds.map(id => ranges(next).find(p => p.id === id)?.savedResultScopeId);
    const matches = all.filter(p => p.sourceId === sourceId && p.joinedScopeIds?.length === 2 && p.joinedScopeIds.every((id, i) => id === parts[i]));
    if (matches.length === 1) r.savedResultScopeId = matches[0].id;
  }
  next.unassigned = [...(next.unassigned ?? []).filter(r => r.sourceId !== sourceId), ...(incoming.unassigned ?? []).map(r => ({ ...r, id: prefix(r.id), sharedOriginalId: r.id, sourceId }))];
  next.sharedLayouts = { ...next.sharedLayouts, [sourceId]: { revision: document.revision, productIds: incoming.products.map(p => prefix(p.id)), rangeIds: ranges(incoming).map(r => prefix(r.id)) } };
  validateProductAnalysis(next);
  return next;
}

export function createSharedProductLayout({ shared, probeSource } = {}) {
  const active = new Map();
  async function operation(root, sourceId, { publish = false } = {}) {
    const { analysis } = await readProductAnalysis(root), source = analysis.sources.find(s => s.id === sourceId);
    if (!source || !shared?.layoutLocation) return { analysis };
    const location = await shared.layoutLocation(root, source);
    if (!location) return { analysis };
    const file = join(location.directory, 'current.json'), current = await read(file);
    if (current && (current.version !== 1 || current.sourceIdentity !== location.sourceIdentity || current.revision !== sharedHash({ layout: current.layout, links: current.links }))) throw failure('共享关联校验失败');
    if (publish) {
      if (!analysis.products.some(p => p.sourceIds.includes(sourceId))) return { analysis };
      const payload = await exportProductLayout(root, sourceId, analysis), revision = sharedHash(payload);
      if (revision === current?.revision) return { analysis, revision };
      const localRevision = analysis.sharedLayouts?.[sourceId]?.revision;
      if (current && current.author !== identity(root, sourceId) && localRevision !== current.revision) throw failure('共享关联已有更新，请先读取最新工程');
      await mkdir(location.directory, { recursive: true });
      const lock = join(location.directory, 'write-lock');
      try { await mkdir(lock); } catch (e) { if (e.code === 'EEXIST') throw failure('另一台正在保存关联，请稍后补存'); throw e; }
      try {
        if ((await read(file))?.revision !== current?.revision) throw failure('共享关联在保存期间已更新');
        const document = { version: 1, sourceIdentity: location.sourceIdentity, author: identity(root, sourceId), revision, ...payload };
        await writeAtomic(join(location.directory, `${revision}.json`), JSON.stringify(document));
        await writeAtomic(file, JSON.stringify(document));
      } finally { await rmdir(lock); }
      if (analysis.sharedLayouts?.[sourceId]) {
        const saved = await updateProductAnalysis(root, a => {
          if (sharedHash(a) !== sharedHash(analysis)) throw failure('保存期间本机工程发生变化');
          a.sharedLayouts[sourceId].revision = revision;
          return a;
        }, probeSource, { preserveHistory: true });
        return { ...saved, revision };
      }
      return { analysis, revision };
    }
    if (!current || current.author === identity(root, sourceId) || analysis.sharedLayouts?.[sourceId]?.revision === current.revision) return { analysis, revision: current?.revision };
    const receipt = await read(join(root, '.film', `shared-layout-${sharedHash(sourceId)}.json`));
    const previousRevision = analysis.sharedLayouts?.[sourceId]?.revision ?? receipt?.revision;
    if (previousRevision && sharedHash(await exportProductLayout(root, sourceId, analysis)) !== previousRevision) throw failure('本机有关联修改尚未共享，保留当前修改');
    const live = await read(join(root, '.film/live-analysis', `${sharedHash(sourceId)}.json`)) ?? { analyses: {} };
    // Original publishers have local-scope receipts rather than imported live refs.
    const own = await exportProductLayout(root, sourceId, analysis);
    for (const r of ranges(analysis).filter(r => r.sourceId === sourceId)) {
      const sha = own.links[r.sharedOriginalId ?? r.id];
      if (sha && !r.savedResultScopeId && !live.analyses?.[r.id]?.sharedRef && !live.analyses?.[r.id]?.historicalRef) {
        live.analyses ??= {}; live.analyses[r.id] = { ...live.analyses[r.id], sharedRef: { sha256: sha } };
      }
    }
    return updateProductAnalysis(root, a => {
      if (sharedHash(a) !== sharedHash(analysis)) throw failure('读取期间工程已修改');
      return applyProductLayout(a, sourceId, current, live);
    }, probeSource, { preserveHistory: true });
  }
  function sync(root, sourceId, options) {
    const key = `${root}\0${sourceId}`, previous = active.get(key) ?? Promise.resolve();
    const statusFile = join(root, '.film', `shared-layout-${sharedHash(sourceId)}.json`);
    const work = previous.catch(() => {}).then(async () => {
      const pending = await read(statusFile), publish = options?.publish || pending?.pending === true;
      try {
        const result = await operation(root, sourceId, { publish });
        if (publish) await writeAtomic(statusFile, JSON.stringify({ pending: false, revision: result.revision }));
        return result;
      } catch (error) {
        if (publish) await writeAtomic(statusFile, JSON.stringify({ pending: true, error: error.message }));
        throw error;
      }
    }).finally(() => { if (active.get(key) === work) active.delete(key); });
    active.set(key, work); return work;
  }
  return { sync };
}
