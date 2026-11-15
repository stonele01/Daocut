export type ProductSource = { id: string; assetPath: string; durationMs: number | null };
export type ProductEvidence = string | { cue: number | string; text: string; startMs: number; endMs: number };
export type Product = { id: string; name: string; sourceIds: string[]; aliases?: { name: string; evidence: ProductEvidence[] }[]; evidence?: ProductEvidence[]; review?: string[]; origin?: string; discoveryRunId?: string };
export type ProductInterval = { scopeStatus?: 'confirmed' | 'uncertain'; id: string; productId: string; sourceId: string; startMs: number; endMs: number; evidence?: ProductEvidence[]; review?: string[]; origin?: string; discoveryRunId?: string; kind?: 'confirmed-inspection' | 'historical-analysis' };
export type ProductCandidate = ProductInterval & { intervalId: string; text: string; tags: string[]; origin: string; version: string | number; runId?: string; details?: { subtypes: string[]; reason: string; evidence: string[]; context: string; repetition: string; review: string[] } };
export type UnassignedProductRange = { id: string; sourceId: string; startMs: number; endMs: number; reason: string; kind: 'mixed' | 'mention' | 'uncertain' | 'transition'; evidence?: ProductEvidence[]; review?: string[]; origin?: string };
export type ProductManualEdit = { id: string; createdAt: string; action: string; sourceIds: string[]; before: { products: Product[]; intervals: ProductInterval[]; unassigned?: UnassignedProductRange[] }; after: { products: Product[]; intervals: ProductInterval[]; unassigned?: UnassignedProductRange[] } };
export type ProductAnalysis = { version: 1; sources: ProductSource[]; products: Product[]; intervals: ProductInterval[]; candidates: ProductCandidate[]; scopes?: (ProductInterval & { kind: 'confirmed-inspection' | 'historical-analysis'; confirmed: true })[]; unassigned?: UnassignedProductRange[]; manualEdits?: ProductManualEdit[]; archivedCandidates?: ProductCandidate[]; discoveryApplied?: { sourceId: string; runId: string }[] };
export type ProductAnalysisState = { analysis: ProductAnalysis; history: ProductAnalysis | null };

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
