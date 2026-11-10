import type { ProductSource, ProductCandidate } from './product-analysis';

export type ExistingResult = {
  action: 'transcription' | 'discovery' | 'analysis'; runId: string; intervalId?: string;
  scope?: { startMs: number; endMs: number }; count?: number; canPublish: boolean; reason?: string;
  provenance: { kind?: string; scopeOrigin?: string; model?: string | null; transcriptKind?: string; warning?: string; inputStatus?: string }; warnings?: string[];
};
export type ExistingPublicationPlan = ExistingResult & {
  identity: string; sourceId?: string; source: Omit<ProductSource, 'id'> & { sourceId: string; sha256: string };
  target: { root: string; libraryId: string }; requestCount: 0;
};
export type SharedHistoricalResult = Omit<ExistingResult, 'runId' | 'canPublish'> & {
  taskKey: string; resultSha: string; createdAt?: string;
};
export type SharedHistoricalPreview = SharedHistoricalResult & {
  candidates?: Pick<ProductCandidate, 'text' | 'startMs' | 'endMs' | 'tags'>[];
  canImport: boolean; reason?: string;
  proposal?: { products: { name: string }[]; intervals: { startMs: number; endMs: number }[] };
};
