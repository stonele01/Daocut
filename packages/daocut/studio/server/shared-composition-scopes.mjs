import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sharedHash } from './shared-analysis.mjs';
import { updateProductAnalysis } from './product-analysis.mjs';
import { HttpError } from './http.mjs';

/** Recover an already-published composition's exact two original baselines.
 * Matching times alone never associates products or joins lectures. */
export function sharedCompositionScopes(analysis, sourceId, live, catalog) {
  const next = structuredClone(analysis);
  const ranges = [...analysis.intervals, ...(analysis.scopes ?? [])].filter(item => item.sourceId === sourceId && !item.joinedScopeIds?.length);
  // historicalRef names the legacy display-only archive format, whose dataHash
  // is not the original cue input hash and which lacks composition metadata.
  // Only a normal sharedRef can establish a published plan's exact baseline.
  const reference = range => live?.analyses?.[range.id]?.sharedRef?.sha256;
  const seen = new Set();
  for (const row of catalog) {
    const meta = row.catalog;
    if (meta?.action !== 'structure-plans' || !/^[a-f0-9]{64}$/.test(meta.provenance?.inputRevision ?? '')) continue;
    const revision = meta.provenance.inputRevision, scope = meta.scope;
    if (!scope || seen.has(revision)) continue;
    seen.add(revision);
    const matches = [];
    for (const first of ranges.filter(item => item.startMs === scope.startMs && reference(item))) {
      for (const second of ranges.filter(item => item.endMs === scope.endMs && item.startMs >= first.endMs && item.id !== first.id && reference(item))) {
        if (sharedHash([reference(first), reference(second)]) === revision) matches.push([first, second]);
      }
    }
    if (matches.length !== 1) continue;
    const parts = matches[0], id = `shared-composition-${sharedHash([sourceId, revision, scope])}`;
    if ([...next.intervals, ...(next.scopes ?? [])].some(item => item.id === id || item.joinedScopeIds?.length === 2 && item.joinedScopeIds.every((part, i) => part === parts[i].id))) continue;
    const productId = `${id}-product`;
    next.products.push({ id: productId, name: `已有拼结构 ${Math.floor(scope.startMs / 1000)}–${Math.ceil(scope.endMs / 1000)}秒`, sourceIds: [sourceId], origin: 'shared-composition' });
    next.scopes ??= [];
    next.scopes.push({ id, productId, sourceId, startMs: scope.startMs, endMs: scope.endMs, kind: 'historical-analysis', confirmed: true,
      origin: 'shared-composition', label: '已有拼结构的原分析范围', joinedScopeIds: parts.map(part => part.id), shareJoinedPlans: true, analysisRevision: revision });
  }
  return next;
}

export async function restoreSharedCompositionScopes(root, source, expected, shared) {
  const live = await readFile(join(root, '.film/live-analysis', `${sharedHash(source.id)}.json`), 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!live) return { analysis: expected };
  const history = await shared.history(root, source);
  return updateProductAnalysis(root, current => {
    if (sharedHash(current) !== sharedHash(expected)) throw new HttpError(409, '读取共享方案期间工程已修改，请刷新；未覆盖个人修改');
    return sharedCompositionScopes(current, source.id, live, history.results);
  }, undefined, { preserveHistory: true });
}
