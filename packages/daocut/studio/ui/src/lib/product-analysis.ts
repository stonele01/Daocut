export type ProductSource = { id: string; assetPath: string; durationMs: number | null };
export type ProductEvidence = string | { cue: number | string; text: string; startMs: number; endMs: number };
export type Product = { sharedLayoutHidden?: boolean; id: string; name: string; sourceIds: string[]; aliases?: { name: string; evidence: ProductEvidence[] }[]; evidence?: ProductEvidence[]; review?: string[]; origin?: string; discoveryRunId?: string; joinedInto?: string };
export type ProductInterval = { sharedLayoutHidden?: boolean; savedResultScopeId?: string; scopeStatus?: 'confirmed' | 'uncertain'; id: string; productId: string; sourceId: string; startMs: number; endMs: number; evidence?: ProductEvidence[]; review?: string[]; origin?: string; discoveryRunId?: string; kind?: 'confirmed-inspection' | 'historical-analysis'; joinedScopeIds?: string[]; joinedGapConfirmed?: boolean; shareJoinedPlans?: boolean };
export type ProductCandidate = ProductInterval & { intervalId: string; text: string; tags: string[]; origin: string; version: string | number; runId?: string; details?: { subtypes: string[]; reason: string; evidence: string[]; context: string; repetition: string; review: string[] } };
export type UnassignedProductRange = { id: string; sourceId: string; startMs: number; endMs: number; reason: string; kind: 'mixed' | 'mention' | 'uncertain' | 'transition'; evidence?: ProductEvidence[]; review?: string[]; origin?: string };
export type ProductManualEdit = { id: string; createdAt: string; action: string; sourceIds: string[]; before: { products: Product[]; intervals: ProductInterval[]; unassigned?: UnassignedProductRange[] }; after: { products: Product[]; intervals: ProductInterval[]; unassigned?: UnassignedProductRange[] } };
export type ProductAnalysis = { version: 1; sources: ProductSource[]; products: Product[]; intervals: ProductInterval[]; candidates: ProductCandidate[]; scopes?: (ProductInterval & { kind: 'confirmed-inspection' | 'historical-analysis'; confirmed: true })[]; unassigned?: UnassignedProductRange[]; manualEdits?: ProductManualEdit[]; archivedCandidates?: ProductCandidate[]; discoveryApplied?: { sourceId: string; runId: string }[] };
export type ProductAnalysisState = { sharingWarning?: string; analysis: ProductAnalysis; history: ProductAnalysis | null };

export const isRecoveredProduct = (product: Product) => /^已有话术（商品待核对） \d+–\d+秒$|^已有拼结构 \d+–\d+秒$/.test(product.name);

/** Keep original discovery records, but do not offer empty remnants as selectable products. */
export function visibleProducts(analysis: ProductAnalysis): Product[] {
  const owners = new Set([...analysis.intervals, ...(analysis.scopes ?? []), ...analysis.candidates].map(item => item.productId));
  const products = analysis.products.filter(product => !product.sharedLayoutHidden && !product.joinedInto && (product.origin !== 'ai-discovery' || owners.has(product.id)));
  const covered = new Set(products.filter(product => !isRecoveredProduct(product)).flatMap(product => productResultRanges(analysis, product.id).map(range => range.id)));
  return products.filter(product => {
    if (!isRecoveredProduct(product)) return true;
    const ranges = [...analysis.intervals, ...(analysis.scopes ?? [])].filter(range => range.productId === product.id);
    // Collapse only a generated recovery card whose entire material is already
    // reachable from a named product. Never delete or reassign saved records.
    return !ranges.length || ranges.some(range => !covered.has(range.id) || !['shared-historical', 'shared-composition'].includes(range.origin ?? ''))
      || analysis.candidates.some(candidate => candidate.productId === product.id && !covered.has(candidate.intervalId));
  });
}

/** Reuse the immutable analysis snapshot's joins across card counts, filters and selection. */
const resultIndexes = new WeakMap<ProductAnalysis, ReturnType<typeof buildResultIndex>>();
function buildResultIndex(analysis: ProductAnalysis) {
  const all = [...analysis.intervals, ...(analysis.scopes ?? [])];
  const byId = new Map(all.map(r => [r.id, r]));
  const occupied = new Set(analysis.candidates.map(c => `${c.sourceId}\0${c.intervalId}`));
  const byProduct = new Map<string, ProductInterval[]>();
  const exact = new Map<string, ProductInterval[]>();
  const key = (r: ProductInterval) => `${r.sourceId}\0${r.startMs}\0${r.endMs}`;
  for (const r of all) {
    const group = byProduct.get(r.productId) ?? []; group.push(r); byProduct.set(r.productId, group);
    if (r.kind === 'historical-analysis' && 'confirmed' in r && r.confirmed === true && ['shared-composition', 'shared-historical'].includes(r.origin ?? '')) {
      const group = exact.get(key(r)) ?? []; group.push(r); exact.set(key(r), group);
    }
  }
  const saved = (r: ProductInterval) => {
    const explicit = r.savedResultScopeId && byId.get(r.savedResultScopeId);
    if (explicit && key(explicit) === key(r)) return explicit;
    if (r.joinedScopeIds?.length || r.kind === 'historical-analysis' || occupied.has(`${r.sourceId}\0${r.id}`)) return r;
    const matches = exact.get(key(r));
    return matches?.length === 1 ? matches[0]! : r;
  };
  const ranges = new Map<string, ProductInterval[]>(), candidates = new Map<string, ProductCandidate[]>();
  for (const p of analysis.products) {
    const ids = new Set<string>();
    for (const r of byProduct.get(p.id) ?? []) for (const item of [r, saved(r)]) {
      ids.add(item.id);
      for (const child of item.joinedScopeIds ?? []) {
        ids.add(child); const part = byId.get(child); if (part) ids.add(saved(part).id);
      }
    }
    ranges.set(p.id, all.filter(r => ids.has(r.id)));
    candidates.set(p.id, analysis.candidates.filter(c => c.productId === p.id || ids.has(c.intervalId)));
  }
  return { saved, ranges, candidates, intervals: analysis.intervals, scopes: analysis.scopes, products: analysis.products, candidateArray: analysis.candidates,
    size: all.length + analysis.candidates.length + analysis.products.length };
}
function resultIndex(analysis: ProductAnalysis) {
  let index = resultIndexes.get(analysis);
  if (!index || index.intervals !== analysis.intervals || index.scopes !== analysis.scopes || index.products !== analysis.products || index.candidateArray !== analysis.candidates
    || index.size !== analysis.intervals.length + (analysis.scopes?.length ?? 0) + analysis.candidates.length + analysis.products.length) {
    index = buildResultIndex(analysis); resultIndexes.set(analysis, index);
  }
  return index;
}
export function savedStructureRange(analysis: ProductAnalysis, range: ProductInterval): ProductInterval { return resultIndex(analysis).saved(range); }
export function productResultRanges(analysis: ProductAnalysis, productId: string): ProductInterval[] { return resultIndex(analysis).ranges.get(productId) ?? []; }
export function productResultCandidates(analysis: ProductAnalysis, productId: string): ProductCandidate[] { return resultIndex(analysis).candidates.get(productId) ?? []; }

export const productId = () => globalThis.crypto.randomUUID();

async function request(projectId: string, analysis?: ProductAnalysis, expected?: ProductAnalysis): Promise<ProductAnalysisState> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/product-analysis`, analysis ? {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ analysis, expected }),
  } : undefined);
  const body = await response.json();
  if (response.status === 409) throw new ProductAnalysisConflict();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body as ProductAnalysisState;
}
export const readProductAnalysis = (id: string) => request(id);
export class ProductAnalysisConflict extends Error { constructor() { super('商品数据已变化，请读取最新数据后重新应用修改。'); } }
export const writeProductAnalysis = (id: string, analysis: ProductAnalysis, expected: ProductAnalysis) => request(id, analysis, expected);

export function parseSourceTime(value: string): number | null {
  const parts = value.trim().split(':');
  if (!parts.length || parts.length > 3 || parts.some((p) => !/^\d+(?:\.\d+)?$/.test(p))) return null;
  const seconds = parts.reduce((sum, part) => sum * 60 + Number(part), 0);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;
}
export function sourceTime(ms: number): string {
  const seconds = Math.floor(ms / 1000), h = Math.floor(seconds / 3600), m = Math.floor(seconds / 60) % 60, s = seconds % 60;
  return `${h ? `${h}:` : ''}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${ms % 1000 ? `.${String(ms % 1000).padStart(3, '0')}` : ''}`;
}

export const productEvidenceText = (evidence: ProductEvidence) => typeof evidence === 'string' ? evidence : `${sourceTime(evidence.startMs)} – ${sourceTime(evidence.endMs)} ${evidence.text}`;
