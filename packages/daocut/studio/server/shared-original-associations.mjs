import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sharedHash } from './shared-analysis.mjs';

const ranges = a => [...a.intervals, ...(a.scopes ?? [])];
const sameBounds = (a, b) => a?.startMs === b?.startMs && a?.endMs === b?.endMs;
const recovered = p => /^已有话术（商品待核对）(?: \d+–\d+秒)?$|^已有拼结构 \d+–\d+秒$/.test(p?.name ?? '');

export async function readOriginalAnalysisReceipts(root, sourceId) {
  const directory = join(root, '.film/shared-analysis'), records = [];
  for (const name of await readdir(directory).catch(e => { if (e.code === 'ENOENT') return []; throw e; })) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const r = JSON.parse(await readFile(join(directory, name), 'utf8'));
    if (r.sourceId === sourceId && r.status === 'complete' && r.snapshot?.action === 'analysis'
      && sharedHash(r.snapshot) === r.result?.sha256 && r.snapshot.taskKey === r.descriptor?.taskKey
      && r.snapshot.sourceIdentity === r.descriptor?.sourceIdentity) records.push(r);
  }
  return records;
}

/** Local receipts and run identities establish affiliation; time equality only validates it. */
export function originalAnalysisScope(analysis, live, sourceId, records, sha, payload) {
  const receipts = records.filter(r => r.result.sha256 === sha);
  const runId = payload?.originalRunId ?? receipts[0]?.snapshot.payload?.originalRunId;
  const scope = payload?.scope ?? receipts[0]?.snapshot.scope;
  const matches = ranges(analysis).filter(r => r.sourceId === sourceId && !r.originalScopeId && !r.sharedLayoutHidden
    && r.origin !== 'shared-historical' && !r.joinedScopeIds?.length && sameBounds(r, scope)
    && (receipts.some(item => item.descriptor.localScope?.intervalId === r.id && item.descriptor.localScope?.productId === r.productId)
      || runId && (live?.analyses?.[r.id]?.currentRunId === runId
        || [...analysis.candidates, ...(analysis.archivedCandidates ?? [])].some(c => c.intervalId === r.id && c.runId === runId))));
  return matches.length === 1 ? matches[0] : undefined;
}

/** Add links to recovered copies, keeping every original ID, candidate and private reference. */
export function associateOriginalAnalyses(analysis, sourceId, live, records) {
  const next = structuredClone(analysis), all = ranges(next), byId = new Map(all.map(r => [r.id, r]));
  for (const r of all.filter(r => r.sourceId === sourceId && r.origin === 'shared-historical')) {
    if (!recovered(next.products.find(p => p.id === r.productId))) continue;
    const ref = live?.analyses?.[r.id]?.sharedRef ?? live?.analyses?.[r.id]?.historicalRef;
    const original = originalAnalysisScope(next, live, sourceId, records, ref?.sha256);
    if (original) r.originalScopeId = original.id;
  }
  for (const r of all.filter(r => r.sourceId === sourceId && r.origin === 'shared-composition')) {
    if (!recovered(next.products.find(p => p.id === r.productId))) continue;
    const parts = (r.joinedScopeIds ?? []).map(id => byId.get(id));
    if (parts.length !== 2 || parts.some(p => !p?.originalScopeId)) continue;
    const refs = parts.map(p => live?.analyses?.[p.id]?.sharedRef?.sha256);
    if (refs.some(ref => !ref) || sharedHash(refs) !== r.analysisRevision) continue;
    const originals = all.filter(o => o.id !== r.id && sameBounds(o, r) && o.sourceId === sourceId
      && o.joinedScopeIds?.length === 2 && o.joinedScopeIds.every((id, i) => id === parts[i].originalScopeId));
    if (originals.length === 1) r.originalScopeId = originals[0].id;
  }
  return next;
}
