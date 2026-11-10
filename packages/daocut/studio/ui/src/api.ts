import './lib/storage-migration.ts';
/**
 * Studio's API, as the editor calls it (studio/server/server.mjs). Same origin, so the launch key travels as the
 * cookie `/open` set; writes are refused from any other origin.
 */
import type { ExportJob } from '@/lib/export-jobs';
import type { ExistingResult, ExistingPublicationPlan, SharedHistoricalResult, SharedHistoricalPreview } from '@/lib/existing-analysis-types';
import type { ProductAnalysis, Product, ProductInterval, UnassignedProductRange } from '@/lib/product-analysis';
import { studioHost } from '@/lib/host';
import { watchStudioVersion } from '@/lib/studio-version';
import { trackDraftWrite } from '@/lib/draft-save-barrier';
import type { StructureScope, StructurePlansState, StructureWorkspaceState } from '@/lib/structure-workspace';
import type { StructureExportBatch } from '@/lib/structure-export-selection';
import type { ProductMediaReview } from '@/lib/product-media-review';
import type { ProductVisualReview, ProductVisualPlan } from '@/lib/product-visual-review';

/** `working`: an agent of the app's chat is working in it right now (it cannot be deleted meanwhile). */
/** GET /api/version: this Studio's, and npm's latest (null when never learnt; `checking` false: never asked). */
export interface StudioVersion { version: string; latest: string | null; newer: boolean; checkedAt: number | null; checking: boolean; source: boolean;
  /** the update Studio runs from the top bar (lib/web-update), or one that failed */
  update?: { status: 'updating' | 'failed'; version: string; error?: string } }

/** `cover`: when the person set a cover of its own (studio/server/cover.mjs), absent when it has none. */
export type Project = { id: string; path: string; name: string; openedAt: number; missing: boolean; working?: boolean; cover?: number };
export type Clip = { src: string; id: string; at?: number; time?: [number] | [number, number];
  box?: { x: number; y: number; w?: number; h?: number; r?: number }; volume?: number; speed?: number; overrides?: unknown[];
  /** a page that sets no size of its own: the px it is laid out at (the stage's without it) */
  size?: { w: number; h: number };
  /** a video's sound alone (an <audio> of its file) */
  sound?: true;
  /** its look: class names for the film's styles, and its own CSS */
  class?: string; style?: string; attrs?: Record<string, string> };
export type Track = { clips: Clip[]; locked?: boolean; hidden?: boolean; muted?: boolean; attrs?: Record<string, string> };
export type Film = { stage?: { w: number; h: number }; tracks: Track[] };
/** Private source edits: independent of product/lecture boundaries and of film.html. */
export type SourceTakesDocument = { version: 1; sourceId: string; assetPath: string; durationMs: number; signature: string; film: Film };
export type SourceTakesState = { revision: number; sourceIdentity: string; document: SourceTakesDocument | null };
/** `value`: film.html as read, every clip named (a clip with no id takes its file's name, as the server and preview do). */
export type ProjectFilm = { project: Project; folder: string; text: string; rev: string; value: Film | null; doc: Film | null; problems: string[] };
export type MediaFile = { path: string; kind: 'video' | 'image' | 'audio' | 'page' | 'other'; size: number; mtime: number; added?: number };
/** Project metadata for a shared source; the physical library root stays local to each computer. */
export type SharedMediaSource = {
  libraryId: string; libraryName: string; relativePath: string; size: number; mtimeMs: number;
  status: 'available' | 'unconfigured' | 'offline' | 'needs-confirmation';
};
export type MediaLink = { to: string; missing?: boolean; source?: SharedMediaSource };
/** A project's editor settings (studio/server/project-settings.mjs). */
export type ProjectSettings = { fps?: number; trackNames?: { name: string; index: number; clips: string[] }[]; trackHeights?: { height: number; index: number; clips: string[] }[] };
export type Listing = { files: MediaFile[]; folders: string[]; pages: { path: string; size: number; mtime: number }[]; links?: Record<string, MediaLink>; made?: string[] };
export type Op =
  | { op: 'set'; clip: string; field: string; value?: unknown }
  | { op: 'move'; clip: string; at: number; track?: number; newTrack?: number }
  | { op: 'insert'; clip?: Partial<Clip> & { src: string }; from?: string; at?: number; after?: string; track?: number | { insert: number }; newTrack?: number; link?: string | null }
  | { op: 'remove'; clip: string }
  | { op: 'split'; clip: string; at: number; time: [number, number]; restTime: [number, number] }
  | { op: 'split'; clip: string; left: Record<string, PropValue>; right: Record<string, PropValue>; rightId?: string }
  | { op: 'track'; track: number; field: 'locked' | 'hidden' | 'muted'; value: boolean }
  | { op: 'reorder'; from: number; to: number }
  | { op: 'props'; edits: PropEdit[] }
  | { op: 'stage'; w: number; h: number }
  | { op: 'fields'; clip: string; fields: Record<string, unknown> };

/** A value a clip's property takes (null removes it). */
export type PropValue = number | string | boolean | readonly number[] | Record<string, unknown> | null;
/** One property of one clip, by the clip's id (see studio/server/ops.mjs). */
export type PropEdit = { clip: string; prop: string; value: PropValue };

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: Record<string, unknown>) {
    super(message);
  }
}

/** Writes on their way (edits, renames…): a reload for a new Studio waits for them (studioVersion). */
let writing = 0;

function call<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const projectId = /^projects\/([^/]+)/.exec(path)?.[1];
  const work = performCall<T>(path, init);
  return projectId && (init.method ?? 'GET') !== 'GET' && !/\/structure-|\/product-workflow|\/live-analysis|\/exports/.test(path)
    ? trackDraftWrite(projectId, path.split('?')[0]!, work) : work;
}
async function performCall<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const write = (rest.method ?? 'GET') !== 'GET';
  if (write) writing += 1;
  try {
    const res = await fetch(`/api/${path}`, {
      ...rest,
      headers: json === undefined ? rest.headers : { 'content-type': 'application/json', ...rest.headers },
      body: json === undefined ? rest.body : JSON.stringify(json),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) markLocked();
    if (!res.ok) throw new ApiError(String(body.error ?? `Studio answered ${res.status}`), res.status, body);
    return body as T;
  } finally {
    if (write) writing -= 1;
  }
}

const p = (id: string) => `projects/${encodeURIComponent(id)}`;

export type LiveTask = { status: 'idle' | 'running' | 'complete' | 'failed'; error?: string; model?: string };
export type LiveRangeAnalysis = LiveTask & { intervalId?: string; productId?: string; rangeStartMs?: number; rangeEndMs?: number; stale?: boolean; legacyEditable?: boolean; historicalEditable?: boolean; currentRunId?: string; coverage?: { sourceId: string; intervalId: string; asrRanges: [number, number][]; audioRanges: [number, number][]; videoRanges: [number, number][] }[]; issues?: string[]; mediaReview?: ProductMediaReview; mediaReviewStale?: boolean; visualReview?: ProductVisualReview; localVisualReview?: boolean; visualReviewStale?: boolean; progress?: { totalWindows: number; completedWindows: number; resumedWindows: number; currentWindow: number; requestAttempts: number; elapsedMs: number } };
export type LiveAnalysisState = { transcription: LiveTask & { retryBlocked?: boolean; segments: { startMs: number; endMs: number; text: string }[] }; analysis: LiveRangeAnalysis; analyses?: Record<string, LiveRangeAnalysis>; canReviewMedia?: boolean };
export type ProductDiscoveryState = {
  sourceId: string; status: 'idle' | 'running' | 'complete' | 'failed'; error?: string; modelIdentity?: string; runId?: string; canRetry: boolean; enabled?: boolean; stale?: boolean;
  proposal?: { runId: string; sourceId: string; products: Product[]; intervals: ProductInterval[]; unassigned: UnassignedProductRange[]; issues: string[]; windows: number };
  difference?: { addedProducts: number; removedProducts: number; renamedProducts: number; addedIntervals: number; removedIntervals: number; changedIntervals: number; manualEdits: boolean };
  runs: { id: string; status: string; createdAt: string; modelIdentity?: string; windows?: number; completedWindows?: number; error?: string }[];
};
export type ProductPreparationState = {
  sourceId: string; status: 'idle' | 'running' | 'complete' | 'failed'; phase: 'transcription' | 'discovery' | 'apply' | 'ready';
  enabled: boolean; needsTranscription: boolean; canRetry: boolean; retryUncertainRequired: boolean; needsReview?: boolean; error?: string; runId?: string;
  transcription: LiveTask & { retryBlocked?: boolean }; discovery: ProductDiscoveryState;
};

/** Studio's own preferences, the same for every project (studio/server/prefs.mjs). */
export interface StudioPrefs {
  proxies: { on: boolean; height: 540 | 720 | 1080 };
  seenVersion: string | null;
  projectsFolder: string | null;
  /** the keyboard shortcuts: the scheme in use and the custom ones (lib/keymap `KeyPrefs`, checked there) */
  keys?: unknown;
  /** The physical roots this computer uses for portable shared-media library ids. */
  sharedMediaLibraries: SharedMediaLibrary[];
  sharedAnalysis: { enabled: boolean; resultRoots: { libraryId: string; root: string; coordinationId?: string }[] };
}
export interface SharedMediaLibrary { id: string; name: string; root: string; managedFolder?: true }
export interface SharedMediaFile { path: string; name: string; size: number; mtimeMs: number }
export interface SharedMediaFolder {
  library: Pick<SharedMediaLibrary, 'id' | 'name'>;
  folder: string;
  videos: SharedMediaFile[];
  transcripts: SharedMediaFile[];
  moreVideos: boolean;
  moreTranscripts: boolean;
}
export interface SharedProjectOpen {
  status: 'ready' | 'empty' | 'unavailable' | 'review-required';
  imported: { transcription: number; discovery: number; analysis: number };
  warnings: string[];
  requestCount: 0;
}
export interface SharedLiveFolder {
  status: 'ready' | 'needs-initialization';
  folder: string;
  name: string;
  resultRoot: string | null;
  legacy: boolean;
  library?: SharedMediaLibrary;
  videos: SharedMediaFile[];
  transcripts: SharedMediaFile[];
  moreVideos: boolean;
  moreTranscripts: boolean;
  warnings: string[];
}
export type SharedLiveProject = {
  status: 'opened'; reused: boolean; project: Project; asset: string;
  source: Omit<SharedMediaSource, 'status'>; sharedRead?: SharedProjectOpen;
} | { status: 'choose-project'; projects: Project[] };
/** Where the projects library is (src/locations.mjs): the folder, its default, whether the person chose it, the free space on its disk, how many projects are in it. */
export interface StudioLocation { path: string; default: string; chosen: boolean; free: number | null; count: number }
export interface StudioLocations { projects: StudioLocation }
/** Said on the window when they change, for what plays by them (the preview's proxies). */
export const PREFS_EVENT = 'daocut:prefs';
/** Said on the window when the library moved, for the Projects list. */
export const LIBRARY_EVENT = 'daocut:library';

/** A problem as Studio keeps it (src/problems.mjs): when, what it was about, what it said. */
export interface StudioProblem {
  t: string;
  area: string;
  what: string;
  agent?: string;
  step?: string;
}

import type { ProductWorkflowPlan, ProductWorkflowRequest, SharedAnalysisState, SharedVersionsState, SharedVersionAdoption } from './lib/product-workflow-types';
import type { ProjectBackupInspection, ProjectBackupRestoreInput } from './lib/project-backup-types';
export type { ProductWorkflowPlan, ProductWorkflowRequest } from './lib/product-workflow-types';
export type ProductWorkflowStatus = {
  source: ProductAnalysis['sources'][number]; phase: 'transcription' | 'discovery' | 'ready'; ready: boolean; busy?: boolean; needsReview?: boolean;
  transcription: LiveAnalysisState['transcription'] & { code?: string; boundaryReview?: boolean };
  discovery: ProductDiscoveryState;
  binding?: { kind: 'vtt' | 'cache'; identity: string; assetPath: string; durationMs: number; cueCount: number; coverage: [number, number][] };
  shared?: SharedAnalysisState;
};

export type TranscriptCue = { text: string; startMs: number; endMs: number };
export type TranscriptSeam = {
  id: string; startMs: number; endMs: number; boundaryMs: number;
  status: 'pending' | 'automatic' | 'confirmed'; reason: string;
  left: TranscriptCue[]; right: TranscriptCue[]; proposed: TranscriptCue[]; resolved?: TranscriptCue[];
};
export type TranscriptReviewState = { available: false; sourceId: string } | {
  available: true; sourceId: string; source: { assetPath: string; durationMs: number };
  identity: string; revision: number; pendingCount: number; complete: boolean; seams: TranscriptSeam[];
  impact: { discovery: boolean; ranges: { productId: string; productName: string; intervalId: string; startMs: number; endMs: number }[] };
  legacyReview?: string;
};

export const api = {
  structureExports: (id: string) => call<{ batches: StructureExportBatch[]; folder: string; jianyingFolder?: string | null }>(`${p(id)}/structure-exports`),
  exportStructurePlans: (id: string, scope: StructureScope, taskKey: string, planIds: string[], requestId: string, options?: { name: string; folder: string; destination: 'jianying' | 'folder' }) => call<StructureExportBatch>(`${p(id)}/structure-exports`, { method: 'POST', json: { ...scope, taskKey, planIds, requestId, ...options } }),
  revealStructureExport: (id: string, batchId: string) => call<object>(`${p(id)}/structure-exports/${encodeURIComponent(batchId)}/reveal`, { method: 'POST', json: {} }),
  retryStructureExport: (id: string, batchId: string) => call<StructureExportBatch>(`${p(id)}/structure-exports/${encodeURIComponent(batchId)}/retry`, { method: 'POST', json: {} }),
  cancelStructureExport: (id: string, batchId: string) => call<StructureExportBatch>(`${p(id)}/structure-exports/${encodeURIComponent(batchId)}/cancel`, { method: 'POST', json: {} }),
  structureWorkspace: (id: string) => call<StructureWorkspaceState>(`${p(id)}/structure-workspace`),
  selectStructureDraft: (id: string, projectId: string | null) => call<StructureWorkspaceState>(`${p(id)}/structure-workspace/select`, { method: 'POST', json: { projectId } }),
  reviewProductMedia: (id: string, scope: StructureScope) => call<LiveAnalysisState>(`${p(id)}/live-analysis/review-media`, { method: 'POST', json: { ...scope, confirmed: true } }),
  productVisualPlan: (id: string, scope: StructureScope) => call<ProductVisualPlan>(`${p(id)}/live-analysis/visual-plan?${new URLSearchParams(Object.entries(scope).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]))}`),
  reviewProductVisual: (id: string, plan: ProductVisualPlan, retryAcknowledged = false) => call<LiveAnalysisState>(`${p(id)}/live-analysis/review-visual`, { method: 'POST', json: { confirmed: true, plan, retryAcknowledged } }),
  structurePlans: (id: string, scope: StructureScope) => call<StructurePlansState>(`${p(id)}/structure-plans?${new URLSearchParams({ sourceId: scope.sourceId, productId: scope.productId, intervalId: scope.intervalId, ...(scope.startMs != null ? { startMs: String(scope.startMs), endMs: String(scope.endMs) } : {}) })}`),
  generateStructurePlans: (id: string, scope: StructureScope) => call<StructurePlansState>(`${p(id)}/structure-plans/generate`, { method: 'POST', json: scope }),
  publishStructurePlans: (id: string, sourceId: string, taskKey: string) => call<StructurePlansState>(`${p(id)}/structure-plans/publish`, { method: 'POST', json: { sourceId, taskKey, confirmed: true } }),
  editStructurePlan: (id: string, scope: StructureScope, taskKey: string, planId: string) => call<{ project: Project }>(`${p(id)}/structure-drafts`, { method: 'POST', json: { ...scope, taskKey, planId } }),
  bindSharedMediaCopy: (id: string, input: { assetPath: string; libraryId: string; videoPath: string; confirmed: true }) => call<{ asset: string; source: SharedMediaSource }>(`${p(id)}/shared-media/bind-copy`, { method: 'POST', json: input }),
  existingAnalysisResults: (id: string, sourceId: string) => call<{ results: ExistingResult[]; warnings?: string[] }>(`${p(id)}/product-workflow/existing-results?${new URLSearchParams({ sourceId })}`),
  existingPublicationPlan: (id: string, input: { sourceId: string; action: string; runId: string; intervalId?: string }) => call<ExistingPublicationPlan>(`${p(id)}/product-workflow/existing-publication-plan`, { method: 'POST', json: input }),
  publishExistingAnalysis: (id: string, plan: ExistingPublicationPlan) => call<{ published?: boolean; requestCount: number }>(`${p(id)}/product-workflow/publish-existing`, { method: 'POST', json: { plan, confirmed: true } }),
  sharedAnalysisHistory: (id: string, sourceId: string) => call<{ results: SharedHistoricalResult[]; warnings?: string[] }>(`${p(id)}/product-workflow/shared-history?${new URLSearchParams({ sourceId })}`),
  previewSharedHistory: (id: string, input: { sourceId: string; taskKey: string; resultSha: string }) => call<SharedHistoricalPreview>(`${p(id)}/product-workflow/shared-history-preview?${new URLSearchParams(input)}`),
  importSharedHistory: (id: string, input: { sourceId: string; taskKey: string; resultSha: string; productId?: string; productName?: string; confirmed: true }) => call<{ imported?: boolean; needsReview?: boolean; reason?: string; scopeId?: string; count?: number; requestCount: number }>(`${p(id)}/product-workflow/import-history`, { method: 'POST', json: input }),
  inspectProjectBackup: (path: string) => call<ProjectBackupInspection>('project-backups/inspect', { method: 'POST', json: { path } }),
  restoreProjectBackup: (input: ProjectBackupRestoreInput) => call<{ project: Project; warnings: string[] }>('project-backups/restore', { method: 'POST', json: input }),
  transcriptReview: (id: string, sourceId: string) => call<TranscriptReviewState>(`${p(id)}/transcript-review?sourceId=${encodeURIComponent(sourceId)}`),
  saveTranscriptSeam: (id: string, input: { sourceId: string; identity: string; expectedRevision: number; seamId: string; cues: TranscriptCue[]; confirmed: true; acknowledgeImpact: boolean }) => call<TranscriptReviewState>(`${p(id)}/transcript-review`, { method: 'PUT', json: input }),
  registerProductSource: (id: string, assetPath: string) => call<{ analysis: ProductAnalysis; history: ProductAnalysis | null; source: ProductAnalysis['sources'][number] }>(`${p(id)}/product-workflow/source`, { method: 'POST', json: { assetPath } }),
  productWorkflowStatus: (id: string, sourceId: string) => call<ProductWorkflowStatus>(`${p(id)}/product-workflow/status?sourceId=${encodeURIComponent(sourceId)}`),
  productWorkflowPlan: (id: string, request: ProductWorkflowRequest) => call<ProductWorkflowPlan>(`${p(id)}/product-workflow/plan?${new URLSearchParams(Object.entries(request).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]))}`),
  executeProductWorkflow: (id: string, plan: ProductWorkflowPlan, retryAcknowledged = false) => call<unknown>(`${p(id)}/product-workflow/execute`, { method: 'POST', json: { confirmed: true, plan, retryAcknowledged } }),
  publishSharedAnalysis: (id: string, sourceId: string, taskKey: string) => call<unknown>(`${p(id)}/product-workflow/publish-shared`, { method: 'POST', json: { sourceId, taskKey, confirmed: true } }),
  sharedAnalysisVersions: (id: string, sourceId: string) => call<SharedVersionsState>(`${p(id)}/product-workflow/shared-versions?sourceId=${encodeURIComponent(sourceId)}`),
  adoptSharedAnalysis: (id: string, input: SharedVersionAdoption) => call<{ adopted?: boolean; needsReview?: boolean; reason?: string; warning?: string; runId?: string }>(`${p(id)}/product-workflow/adopt-shared`, { method: 'POST', json: input }),
  bindProductTranscript: (id: string, sourceId: string, kind: 'vtt' | 'cache', identity: string) => call<unknown>(`${p(id)}/product-workflow/bind-transcript`, { method: 'POST', json: { sourceId, kind, identity, sourceConfirmed: true } }),
  liveAnalysis: (id: string, sourceId: string, scope?: { productId: string; intervalId: string }) => call<LiveAnalysisState>(`${p(id)}/live-analysis?sourceId=${encodeURIComponent(sourceId)}${scope ? `&productId=${encodeURIComponent(scope.productId)}&intervalId=${encodeURIComponent(scope.intervalId)}` : ''}`),
  startLiveAnalysis: (id: string, sourceId: string, stage: 'transcribe' | 'analyze', rerun = false, scope?: { productId: string; intervalId: string }, retryUncertain = false) => call<LiveAnalysisState>(`${p(id)}/live-analysis/${stage}`, { method: 'POST', json: { sourceId, ...(stage === 'analyze' ? scope : {}), confirmed: true, ...(stage === 'analyze' && rerun ? { rerun: true } : {}), ...(stage === 'transcribe' && retryUncertain ? { retryUncertain: true } : {}) } }),
  productDiscovery: (id: string, sourceId: string) => call<ProductDiscoveryState>(`${p(id)}/product-discovery?sourceId=${encodeURIComponent(sourceId)}`),
  productPreparation: (id: string, sourceId: string) => call<ProductPreparationState>(`${p(id)}/product-preparation?sourceId=${encodeURIComponent(sourceId)}`),
  prepareProducts: (id: string, sourceId: string, retry = false, retryUncertain = false) => call<ProductPreparationState>(`${p(id)}/product-preparation`, { method: 'POST', json: { sourceId, confirmed: true, ...(retry ? { retry: true } : {}), ...(retryUncertain ? { retryUncertain: true } : {}) } }),
  discoverProducts: (id: string, sourceId: string, rerun = false, retry = false) => call<ProductDiscoveryState>(`${p(id)}/product-discovery/discover`, { method: 'POST', json: { sourceId, confirmed: true, ...(rerun ? { rerun: true } : {}), ...(retry ? { retry: true } : {}) } }),
  applyProductDiscovery: (id: string, sourceId: string, runId: string, expected: ProductAnalysis, replaceReviewed: boolean) => call<ProductDiscoveryState>(`${p(id)}/product-discovery/apply`, { method: 'POST', json: { sourceId, runId, confirmed: true, expected, ...(replaceReviewed ? { replaceReviewed: true } : {}) } }),
  /** this Studio's version and the latest daocut on npm; `check`: ask npm now */
  version: (check = false) => call<StudioVersion>(`version${check ? '?check=1' : ''}`),
  /** the newest daocut, run in the background (`daocut update`): Studio starts again on it; refused (ApiError, `body.code`) while busy */
  update: () => call<{ update: NonNullable<StudioVersion['update']> }>('update', { method: 'POST', json: {} }),
  /** `daocut doctor`, run by this Studio: the report to paste into an issue (src/doctor.mjs) */
  doctor: () => call<{ ok: boolean; text: string }>('doctor'),
  /** what went wrong in the last two weeks, newest first (src/problems.mjs) */
  problems: () => call<{ problems: StudioProblem[] }>('diagnostics/problems').then((r) => r.problems),
  feedbackDiagnostics: (conversations: boolean) => call<{ details: string }>('diagnostics/feedback', { method: 'POST', json: { conversations } }),
  /** the diagnostic file (server/diagnostics.mjs): `report` and the rest, zipped into the exports folder and shown there */
  exportDiagnostics: (report: string, conversations: boolean) => call<{ path: string; files: string[]; conversations: boolean }>('diagnostics/export', { method: 'POST', json: { report, conversations } }),
  projects: () => call<{ projects: Project[] }>('projects').then((r) => r.projects),
  prefs: () => call<StudioPrefs>('prefs'),
  /** where new projects and exports go, and the free space there */
  locations: () => call<StudioLocations>('locations'),
  /** move the library to `path` (null: the default); with `move`, its projects go too (those that could not are in `failed`) */
  moveLibrary: (path: string | null, move: boolean) => call<{ moved: number; failed: { name: string; error: string }[]; locations: StudioLocations }>('locations/projects', { method: 'PUT', json: { path, move } }).then((done) => {
    window.dispatchEvent(new Event(LIBRARY_EVENT));
    return done;
  }),
  /** a project's folder, shown in the system's file manager */
  revealProject: (id: string) => call<object>(`projects/${encodeURIComponent(id)}/reveal`, { method: 'POST', json: {} }),
  /** one of them in the system's file manager */
  openLocation: (which: keyof StudioLocations) => call<{ ok: true }>(`locations/${which}`, { method: 'POST', json: {} }),
  setPrefs: (patch: { proxies?: Partial<StudioPrefs['proxies']>; seenVersion?: string; projectsFolder?: string | null; keys?: unknown; sharedMediaLibraries?: SharedMediaLibrary[]; sharedAnalysis?: StudioPrefs['sharedAnalysis'] }) => call<StudioPrefs>('prefs', { method: 'PATCH', json: patch }).then((prefs) => {
    window.dispatchEvent(new Event(PREFS_EVENT));
    return prefs;
  }),
  /** the system's folder dialog, opened by Studio (a page in a browser cannot learn a path): the folder, or null when
      cancelled; throws (501) where this system has none */
  pickFolder: (title: string, at?: string) => call<{ path: string | null }>('pick-folder', { method: 'POST', json: { title, ...(at ? { at } : {}) } }).then((r) => r.path),
  newProject: (name?: string) => call<{ project: Project }>('projects', { method: 'POST', json: { name } }).then((r) => r.project),
  /** A local-only product/structure demo with generated colour clips and clearly synthetic analysis data. */
  productAnalysisDemo: () => call<{ project: Project }>('projects/product-analysis-demo', { method: 'POST', json: {} }).then((r) => r.project),
  sourceTakes: (id: string, sourceId: string, assetPath?: string) => call<SourceTakesState>(`${p(id)}/source-takes?sourceId=${encodeURIComponent(sourceId)}${assetPath === undefined ? '' : `&assetPath=${encodeURIComponent(assetPath)}`}`),
  putSourceTakes: (id: string, sourceId: string, input: { expectedRevision: number; sourceIdentity: string; document: SourceTakesDocument }) => call<SourceTakesState>(`${p(id)}/source-takes?sourceId=${encodeURIComponent(sourceId)}`, { method: 'PUT', json: input }),
  /** open a folder (its full path) as a project: made one when it is not yet */
  openFolder: (path: string) => call<{ project: Project }>('projects', { method: 'POST', json: { path } }).then((r) => r.project),
  /** Shared footage is read from one chosen product folder and linked into a new local project. */
  sharedMediaLibrary: (library: SharedMediaLibrary) => call<{ library: SharedMediaLibrary }>('shared-media/libraries', { method: 'POST', json: library }).then((r) => r.library),
  sharedLiveFolder: (folder: string, initialize = false) => call<SharedLiveFolder>('shared-media/live-folder', { method: 'POST', json: { folder, initialize } }),
  sharedLiveProject: (input: { folder: string; videoPath: string; requestId: string; projectId?: string; createNew?: boolean }) => call<SharedLiveProject>('shared-media/live-project', { method: 'POST', json: input }),
  sharedMediaBrowse: (libraryId: string, folder: string) => call<SharedMediaFolder>('shared-media/browse', { method: 'POST', json: { libraryId, folder } }),
  sharedMediaProject: (libraryId: string, videoPath: string, requestId: string) => call<{ project: Project; asset: string; source: Omit<SharedMediaSource, 'status'>; sharedRead?: SharedProjectOpen }>('shared-media/projects', { method: 'POST', json: { libraryId, videoPath, requestId } }),
  sharedProjectOpen: (projectId: string) => call<{ sharedRead: SharedProjectOpen | null }>(`${p(projectId)}/product-workflow/shared-open`),
  sharedMediaAdd: (projectId: string, libraryId: string, folder: string, videoPaths: string[]) => call<{ assets: string[] }>(`${p(projectId)}/shared-media/add`, { method: 'POST', json: { libraryId, folder, videoPaths } }),
  associateSharedMediaLibrary: (projectId: string, libraryId: string, root: string) => call<{ library: SharedMediaLibrary }>(`${p(projectId)}/shared-media/associate`, { method: 'POST', json: { libraryId, root } }).then((r) => r.library),
  rename: (id: string, name: string) => call<{ project: Project }>(p(id), { method: 'PATCH', json: { name } }).then((r) => {
    studioHost?.projectChanged?.(r.project);
    return r.project;
  }),
  forget: (id: string) => call<object>(p(id), { method: 'DELETE' }),
  film: (id: string) => call<ProjectFilm>(p(id)),
  /** the person opened it here: the one `daocut open` alone comes back to */
  opened: (id: string) => call<{ project: Project }>(`${p(id)}/opened`, { method: 'POST' }),
  edit: (id: string, base: string | null, ops: Op[]) => call<{ text: string; rev: string; value: Film; doc: Film; rebased: boolean }>(`${p(id)}/edit`, { method: 'POST', json: { base, ops } }),
  files: (id: string) => call<Listing>(`${p(id)}/files`),
  /** the editor's settings of the project (`.film/settings.json`): its frame rate, its tracks' names */
  settings: (id: string) => call<{ settings: ProjectSettings }>(`${p(id)}/settings`).then((r) => r.settings),
  /** change some of them (null takes one away); answers them all as kept */
  patchSettings: (id: string, patch: { fps?: number | null; trackNames?: ProjectSettings['trackNames'] | null; trackHeights?: ProjectSettings['trackHeights'] | null }) => (
    call<{ settings: ProjectSettings }>(`${p(id)}/settings`, { method: 'PATCH', json: patch }).then((r) => r.settings)
  ),
  /** its markers (`.film/markers.json`, lib/markers): the whole list, read and written */
  markers: (id: string) => call<{ markers: unknown }>(`${p(id)}/markers`).then((r) => r.markers),
  putMarkers: (id: string, markers: unknown[]) => call<{ markers: unknown }>(`${p(id)}/markers`, { method: 'PUT', json: { markers } }).then((r) => r.markers),
  /** the loudness of a part of a file's sound (its own seconds): integrated LUFS (null: silent) and true peak */
  loudness: (id: string, path: string, from: number, to: number) => call<{ lufs: number | null; peak: number | null }>(
    `${p(id)}/media?what=loudness&path=${encodeURIComponent(path)}&from=${from}&to=${to}`,
  ),
  /** a video's frame (`ms` of its own time) made a still beside it; answers its path */
  freezeFrame: (id: string, path: string, ms: number) => call<{ path: string }>(`${p(id)}/files/still`, { method: 'POST', json: { path, ms } }).then((r) => r.path),
  /** The project's own cover for its card (studio/server/cover.mjs): a picture from this computer, a picture of the project,
      the film at `ms`, or none (null: its film's poster again). Each answers when it was set. */
  setCover: (id: string, from: { file: Blob } | { path: string } | { ms: number }) => call<{ cover: number | null }>(`${p(id)}/cover`,
    'file' in from ? { method: 'PUT', body: from.file, headers: { 'content-type': 'application/octet-stream' } } : { method: 'POST', json: from }).then((r) => r.cover),
  clearCover: (id: string) => call<{ cover: null }>(`${p(id)}/cover`, { method: 'DELETE' }).then(() => null),
  answerAsk: (askId: string, allow: boolean) => call<{ answered: boolean }>(`get/asks/${encodeURIComponent(askId)}`, { method: 'POST', json: { allow } }),
  /** the provider's own page for its balance, opened in the person's browser */
  openBilling: (providerId: string) => call<Record<string, never>>(`providers/${encodeURIComponent(providerId)}/billing`, { method: 'POST' }),
  /** clips (by id), clips together (a group) and files (by path) of a project put in Saved (studio/server/saved.mjs):
      each one's place there */
  save: (id: string, what: { clips?: SavedAsk[]; groups?: Array<SavedAsk & { ids: string[] }>; files?: Array<SavedAsk & { path: string }>; into?: string }) => (
    call<{ paths: string[] }>(`${p(id)}/saved`, { method: 'POST', json: what }).then((r) => r.paths)
  ),
  /** a thing of Saved (its `saved/` path) used in the project: a file imported (its place), or a bundle's files brought in
      and the clip, a group's clips or the page to put on the timeline */
  takeSaved: (id: string, path: string) => call<{ clip: Record<string, unknown> & { src: string } } | { clips: SavedGroupClip[] } | { path: string }>(
    `${p(id)}/saved/take`, { method: 'POST', json: { path } },
  ),
};

/** A clip of a saved group: its track counted from the group's top one, its time in seconds from the group's start. */
export type SavedGroupClip = { track: number; at: number; clip: Record<string, unknown> & { src: string } };

/** What is said of a thing put in Saved: a clip's id (a file's path beside it), a name, and how long and big it is. */
export type SavedAsk = { id?: string; name?: string; durationMs?: number; w?: number; h?: number };

/** What an agent's `daocut get` asks the person before it spends (studio/server/get.mjs). */
export type SpendAsk = {
  id: string; kind: 'video'; provider: string; model?: string; seconds?: number; prompt?: string;
};

/** What the person is told without a question (studio/server/get.mjs): a provider with no balance left for a run. */
export type StudioNotice = { id: string; kind: 'balance'; provider: string; providerId: string };

export type FolderEvent = { type: 'film'; rev: string } | { type: 'files'; paths?: string[] } | { type: 'history' } | { type: 'export'; job: ExportJob } | { type: 'open'; to: string }
  | { type: 'history-progress'; op: string; phase: string; done: number; total: number }
  | { type: 'ask'; ask: SpendAsk } | { type: 'asked'; id: string } | { type: 'notice'; notice: StudioNotice } | { type: 'project'; project: Project }
  /* the project was deleted, or its folder is not there any more: its pages leave it */
  | { type: 'gone' };

/**
 * Listen to a stream of events (a WebSocket: a browser's six HTTP connections to Studio stay free for the page's
 * requests, however many pages are open); returns a function that stops listening. It reconnects on its own;
 * `onBack` runs when it does (Studio stopped and started again: what changed meanwhile was not told). `watch`: this
 * stream says whether Studio answers (studioConnection), and reloads the page when Studio comes back as another
 * version (lib/studio-version); the page's own one does. It also tells Studio whether the page is in sight, so
 * `daocut open` opens a browser when no page is (a tab behind others, a minimized window).
 */
export function listen(path: string, on: (event: FolderEvent) => void, { onBack, watch = false, gone }: { onBack?: () => void; watch?: boolean; gone?: () => Promise<boolean> } = {}): () => void {
  const inSight = () => document.visibilityState === 'visible';
  const url = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/${path}${watch ? `?visible=${inSight() ? 1 : 0}` : ''}`;
  const tell = () => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ visible: inSight() })); };
  if (watch) document.addEventListener('visibilitychange', tell);
  let socket: WebSocket | null = null;
  let stopped = false, lost = false, tries = 0;
  let again: ReturnType<typeof setTimeout> | null = null;
  const watcher = watch ? watchConnection() : null;
  if (watch) studioVersion ??= watchStudioVersion({
    version: () => fetch('/api/health', { cache: 'no-store' }).then((r) => r.json()).then((h) => (typeof h?.version === 'string' ? h.version : null)),
    idle: () => writing === 0,
    reload: () => location.reload(),
    storage: (() => { try { return sessionStorage; } catch { return null; } })(),
  });
  const connect = () => {
    const s = new WebSocket(url());
    socket = s;
    s.onopen = () => {
      tries = 0;
      watcher?.up();
      if (lost) {
        lost = false;
        onBack?.();
        /* back as another version (a newer daocut, or the desktop app's): this page's code is reloaded to match */
        if (watch) void studioVersion?.back();
      }
    };
    s.onmessage = (e) => { try { on(JSON.parse(String(e.data)) as FolderEvent); } catch { /* not ours */ } };
    s.onclose = () => {
      if (stopped) return;
      lost = true;
      watcher?.down();
      /* refused, not gone: Studio is there but this browser has no key (the stream says no reason, a request does) */
      if (watch && tries === 0) void fetch('/api/version', { cache: 'no-store' }).then((r) => { if (r.status === 401) markLocked(); }, () => {});
      /* soon at first, then every second: Studio restarting (`daocut open` starts it afresh) is back within one
         or two, and waits a few for the pages before it */
      again = setTimeout(connect, Math.min(1000, 250 * 2 ** tries++));
      /* refused again and again while Studio answers: what it streams may be gone (a project deleted, its folder
         moved away), which reconnecting can't change; asked, and if so said once and left */
      if (gone && (tries === 3 || tries % 20 === 0)) {
        void gone().then((yes) => {
          if (!yes || stopped) return;
          stopped = true;
          if (again) clearTimeout(again);
          on({ type: 'gone' });
        }, () => {});
      }
    };
  };
  connect();
  return () => { stopped = true; if (again) clearTimeout(again); if (watch) document.removeEventListener('visibilitychange', tell); watcher?.stop(); socket?.close(); };
}

/** Which version of Studio served this page (see listen's `watch`). */
let studioVersion: ReturnType<typeof watchStudioVersion> | null = null;

/**
 * Whether Studio answers, for the notice when it does not: 'up', 'lost' (stopped a moment ago, reconnecting), 'gone'
 * (still not back), or 'locked': Studio answers but not this browser, which was never let in (its address was typed
 * or pasted without the key `daocut open` prints, or its key is another launch's). Waiting does not fix that one.
 */
export type Connection = 'up' | 'lost' | 'gone' | 'locked';
let connection: Connection = 'up';
const connectionListeners = new Set<() => void>();
export const studioConnection = {
  get: () => connection,
  subscribe(fn: () => void) { connectionListeners.add(fn); return () => { connectionListeners.delete(fn); }; },
};
/** Studio answered this page 401: it was never let in (see Connection). */
export function markLocked() { setConnection('locked'); }
function setConnection(next: Connection) {
  if (next === connection || (connection === 'locked' && next !== 'up')) return;
  connection = next;
  for (const fn of [...connectionListeners]) fn();
}
/** A moment without Studio is said, a long one more plainly. */
function watchConnection() {
  let timers: ReturnType<typeof setTimeout>[] = [];
  const clear = () => { for (const timer of timers) clearTimeout(timer); timers = []; };
  return {
    down() {
      if (timers.length || connection !== 'up') return;
      /* a blip (the computer woke, the stream was cut and came straight back) is not worth a notice */
      timers = [setTimeout(() => setConnection('lost'), 2000), setTimeout(() => setConnection('gone'), 20_000)];
    },
    up() { clear(); setConnection('up'); },
    stop: clear,
  };
}
/* One stream per project, shared by everyone listening on the page. */
const streams = new Map<string, { stop: () => void; listeners: Set<(event: FolderEvent) => void> }>();
export function projectEvents(id: string, on: (event: FolderEvent) => void): () => void {
  let stream = streams.get(id);
  if (!stream) {
    const listeners = new Set<(event: FolderEvent) => void>();
    const tell = (event: FolderEvent) => {
      if (listeners.size && event.type === 'project') studioHost?.projectChanged?.(event.project);
      for (const fn of [...listeners]) fn(event);
    };
    /* back after Studio was away: the film, the files and the history may all have changed meanwhile */
    const stop = listen(`${p(id)}/events`, tell, {
      onBack: () => { tell({ type: 'film', rev: '' }); tell({ type: 'files' }); tell({ type: 'history' }); },
      /* the project off the list, or its folder missing: gone (a list that can't be read says nothing) */
      gone: () => call<ProjectFilm>(p(id)).then((result) => Boolean(result.project.missing), (error: unknown) => {
        if (error instanceof ApiError && (error.status === 404 || error.status === 410)) return true;
        throw error;
      }),
    });
    stream = { stop, listeners };
    streams.set(id, stream);
  }
  stream.listeners.add(on);
  const mine = stream;
  return () => {
    mine.listeners.delete(on);
    if (!mine.listeners.size && streams.get(id) === mine) { mine.stop(); streams.delete(id); }
  };
}
