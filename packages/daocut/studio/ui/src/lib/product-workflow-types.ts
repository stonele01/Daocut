/** Public request metadata only. No credentials or browser-only imports. */
export type ProductWorkflowRequest = { sourceId: string; action: 'transcription' | 'discovery' | 'analysis'; productId?: string; intervalId?: string; retry?: boolean; rerun?: boolean; newVersion?: boolean };
export type SharedResultVersion = {
  taskKey: string; sha256: string; sequence: number; createdAt?: string; model?: string;
};
export type SharedVersionGroup = {
  sourceId?: string; action: ProductWorkflowRequest['action']; familyKey: string;
  productId?: string; intervalId?: string; scope?: { startMs: number; endMs: number };
  currentVersion?: SharedResultVersion; latestVersion?: SharedResultVersion; versions: SharedResultVersion[];
  updateAvailable: boolean; canCreateVersion?: boolean; reason?: string; warning?: string;
};
export type SharedVersionsState = { groups: SharedVersionGroup[]; warning?: string };
export type SharedVersionAdoption = Pick<ProductWorkflowRequest, 'sourceId' | 'action' | 'productId' | 'intervalId'> & {
  versionTaskKey: string; expectedCurrentSha: string; confirmed: true;
};
export type SharedAnalysisState = {
  mode: 'publish' | 'reuse' | 'busy' | 'retry-required' | 'publish-pending' | 'local-only' | 'local-review';
  taskKey: string; status?: string; reason?: string;
  action?: ProductWorkflowRequest['action']; newVersion?: boolean;
  scope?: { sourceId?: string; productId: string; intervalId: string; startMs: number; endMs: number };
  result?: { path?: string; sha256: string; schema?: string; service?: { provider?: string; model?: string; name?: string; endpoint?: string } };
};
export type ProductWorkflowPlan = ProductWorkflowRequest & {
  identity: string; source: { assetPath: string; durationMs: number }; scope?: { sourceId?: string; productId: string; intervalId: string; startMs: number; endMs: number };
  service: { enabled: boolean; provider: string; name?: string; model: string; endpoint: string; error?: string };
  enabled: boolean; cached: boolean; requestCount: number | null; totalRequests: number | null; reusedRequests: number;
  transcriptSegments: number | null; audioSegments?: { startMs: number; endMs: number; coreStartMs?: number; coreEndMs?: number }[];
  cost: { estimate: number | null; basis: string; uncertain: boolean }; retryRequired: boolean; error?: string;
  shared?: SharedAnalysisState;
  visual?: { enabled: boolean; identity: unknown; requestCount: number; maxImages: number; name?: string; model?: string; provider?: string; endpoint?: string; error?: string };
};
