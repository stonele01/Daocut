import { useSyncExternalStore } from 'react';
import { api, type Film, type SourceTakesDocument } from '@/api';
import type { SourceProductRange } from '@/components/SourcePreview';
import { sourceFilm, reconcileSourceFilm, resolveCandidateTake } from './source-timeline-model';

export type TakeSource = { projectId: string; sourceId: string; assetPath: string; durationMs: number; version?: number };
type Entry = {
  source: TakeSource; document: SourceTakesDocument | null; revision: number; sourceIdentity: string;
  load?: Promise<void>; queue: Promise<void>; saving: number; error: string | null; dirty: boolean;
  focusedClipId?: string; persisted: boolean; failedDocument?: SourceTakesDocument;
  moving?: boolean;
};
// Keep writes alive when switching sources or when analysis replaces the mounted source row.
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let version = 0;
const key = (projectId: string, sourceId: string) => JSON.stringify([projectId, sourceId]);
const publish = () => { version++; for (const notify of listeners) notify(); };
export function useSourceTakeVersion() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, () => version);
}
export const sourceTakeState = (projectId: string, sourceId: string) => entries.get(key(projectId, sourceId));
export const sourceTakeSignature = (source: TakeSource, ranges: readonly SourceProductRange[]) => {
  const previous = sourceTakeState(source.projectId, source.sourceId)?.source;
  const durationMs = previous?.assetPath === source.assetPath && Math.abs(previous.durationMs - source.durationMs) <= 1 ? previous.durationMs : source.durationMs;
  return JSON.stringify([source.assetPath, durationMs, ranges.filter(r => r.sourceId === source.sourceId && r.kind === 'candidate').map(r => [r.id, r.startMs, r.endMs])]);
};
function baseline(sourceId: string, signature: string) {
  const [src, duration, ranges] = JSON.parse(signature) as [string, number, [string, number, number][]];
  return sourceFilm(sourceId, src, duration, ranges.map(([id, startMs, endMs]) => ({ id, startMs, endMs, sourceId, productId: '', kind: 'candidate' })));
}
function migrate(source: TakeSource): SourceTakesDocument | null {
  const raw = localStorage.getItem(`daocut:source-film:${source.projectId}:${source.sourceId}`);
  if (!raw) return null;
  const saved = JSON.parse(raw);
  const [src, duration] = JSON.parse(saved.signature);
  if (src !== source.assetPath || !Number.isFinite(duration) || Math.abs(duration - source.durationMs) > 1) throw new Error('浏览器旧取用与当前素材不符，未覆盖工程');
  if (!Array.isArray(saved.film?.tracks)) throw new Error('浏览器旧取用无法读取，未覆盖工程');
  return { version: 1, sourceId: source.sourceId, assetPath: source.assetPath, durationMs: duration, signature: saved.signature, film: saved.film };
}
function enqueue(entry: Entry, document = structuredClone(entry.document!)) {
  entry.dirty = true; entry.saving++; publish();
  entry.queue = entry.queue.then(async () => {
    if (entry.error) return;
    try {
      const result = await api.putSourceTakes(entry.source.projectId, entry.source.sourceId, {
        expectedRevision: entry.revision, sourceIdentity: entry.sourceIdentity, document,
      });
      entry.revision = result.revision; entry.sourceIdentity = result.sourceIdentity; entry.persisted = true;
      entry.failedDocument = undefined;
      if (JSON.stringify(entry.document) === JSON.stringify(document)) entry.dirty = false;
    } catch (error) {
      entry.failedDocument = document;
      entry.error = `取用未保存到工程：${error instanceof Error ? error.message : String(error)}`;
    }
  }).finally(() => { entry.saving--; publish(); });
}
export async function prepareSourceTakes(source: TakeSource, ranges: readonly SourceProductRange[]) {
  if (!source.projectId || !source.assetPath || !(source.durationMs > 0)) throw new Error('等待原片时长，尚未读取取用');
  const id = key(source.projectId, source.sourceId);
  let entry = entries.get(id);
  if (entry?.moving) throw new Error('素材正在移动，请稍候');
  if (entry && (entry.source.assetPath !== source.assetPath || Math.abs(entry.source.durationMs - source.durationMs) > 1
    || (entry.source.version !== undefined && source.version !== undefined && entry.source.version !== source.version))) {
    entry.error = '素材已变化，已保存取用未覆盖，请重新打开工程'; publish();
    throw new Error(entry.error);
  }
  if (!entry) {
    entry = { source, document: null, revision: 0, sourceIdentity: '', queue: Promise.resolve(), saving: 0, error: null, dirty: false, persisted: false };
    entries.set(id, entry);
    const target = entry;
    target.load = (async () => {
      try {
        const result = await api.sourceTakes(source.projectId, source.sourceId, source.assetPath);
        target.revision = result.revision; target.sourceIdentity = result.sourceIdentity;
        target.persisted = !!result.document;
        target.document = result.document ?? migrate(source);
        if (target.document) {
          if (Math.abs(target.document.durationMs - source.durationMs) > 1) throw new Error('原片时长已改变，旧取用未复用');
          target.source = { ...source, durationMs: target.document.durationMs };
        }
        if (target.document && !result.document) enqueue(target);
      } catch (error) { target.error = `取用读取失败：${error instanceof Error ? error.message : String(error)}`; }
      finally { publish(); }
    })();
  }
  await entry.load;
  if (entry.error) throw new Error(entry.error);
  source = entry.source;
  const signature = sourceTakeSignature(source, ranges);
  if (!entry.document) {
    let oldTakes = {};
    try { const value = JSON.parse(localStorage.getItem(`daocut:source-takes:${source.projectId}`) ?? '{}'); if (value && typeof value === 'object' && !Array.isArray(value)) oldTakes = value; } catch { /* no legacy v0 takes */ }
    entry.document = { version: 1, sourceId: source.sourceId, assetPath: source.assetPath, durationMs: source.durationMs, signature, film: sourceFilm(source.sourceId, source.assetPath, source.durationMs, ranges, oldTakes) };
    if (Object.keys(oldTakes).length) enqueue(entry);
    publish();
  } else if (entry.document.signature !== signature) {
    const fresh = sourceFilm(source.sourceId, source.assetPath, source.durationMs, ranges);
    const film = reconcileSourceFilm(fresh, structuredClone(entry.document.film), baseline(source.sourceId, entry.document.signature));
    entry.document = { ...entry.document, signature, film };
    if (entry.persisted || entry.dirty) enqueue(entry);
    publish();
  }
  return entry;
}
export function editSourceTakes(projectId: string, sourceId: string, film: Film) {
  const entry = sourceTakeState(projectId, sourceId);
  if (!entry?.document) throw new Error('取用尚未读取');
  if (entry.moving) throw new Error('素材正在移动，请完成后再调整取用');
  if (entry.error) throw new Error(entry.error);
  entry.document = { ...entry.document, film };
  enqueue(entry);
}
export function focusSourceTake(projectId: string, sourceId: string, clipId?: string) {
  const entry = sourceTakeState(projectId, sourceId);
  if (entry) entry.focusedClipId = clipId;
}
export function candidateTake(projectId: string, sourceId: string, candidateId: string) {
  const entry = sourceTakeState(projectId, sourceId);
  return entry?.document ? resolveCandidateTake(entry.document.film, candidateId, entry.focusedClipId) : null;
}
export async function retrySourceTakeSave(projectId: string, sourceId: string) {
  const entry = sourceTakeState(projectId, sourceId);
  if (!entry) return;
  if (entry.moving) throw new Error('素材正在移动，请完成后重试保存');
  await entry.queue;
  if (!entry.document) { entries.delete(key(projectId, sourceId)); publish(); return; }
  // Recover a lost acknowledgement with the exact attempted write before submitting later edits.
  const attempted = entry.failedDocument;
  entry.error = null; enqueue(entry, attempted); await entry.queue;
  if (!entry.error && entry.dirty) { enqueue(entry); await entry.queue; }
}
/** A successful server move rewrites saved paths; reload them instead of treating it as replaced footage. */
export async function beginSourceTakeMove(projectId: string, from: string) {
  const affected = [...entries.entries()].filter(([, entry]) => entry.source.projectId === projectId
    && (entry.source.assetPath === from || entry.source.assetPath.startsWith(`${from}/`)));
  if (affected.some(([, entry]) => entry.moving)) throw new Error('素材正在移动，请稍候');
  for (const [, entry] of affected) entry.moving = true;
  const release = (committed: boolean) => {
    for (const [id, entry] of affected) {
      entry.moving = false;
      if (committed && entries.get(id) === entry) entries.delete(id);
    }
    publish();
  };
  try {
    for (const [, entry] of affected) {
      await entry.load; await entry.queue;
      if (entry.error || entry.dirty || entry.saving) throw new Error('取用修改尚未保存，请先完成保存再改名或移动');
    }
    return release;
  } catch (error) { release(false); throw error; }
}
// A failed write remains visible and in memory; never silently discard it on browser close/reload.
if (typeof window !== 'undefined') window.addEventListener('beforeunload', event => {
  if ([...entries.values()].some(entry => entry.dirty || entry.saving)) { event.preventDefault(); event.returnValue = ''; }
});
