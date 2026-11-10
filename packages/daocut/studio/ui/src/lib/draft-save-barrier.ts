/** Draft switching waits for both queued edits and debounced controls. A failed save keeps the editor mounted. */
const states = new Map<string, { pending: Set<Promise<unknown>>; errors: Map<string, unknown>; flush: Set<() => Promise<unknown>> }>();
const state = (id: string) => { let value = states.get(id); if (!value) { value = { pending: new Set(), errors: new Map(), flush: new Set() }; states.set(id, value); } return value; };
export function trackDraftWrite<T>(id: string, key: string, work: Promise<T>): Promise<T> {
  const current = state(id);
  const pending = work.then(value => { current.errors.delete(key); return value; }, error => { current.errors.set(key, error); throw error; });
  current.pending.add(pending);
  void pending.then(() => current.pending.delete(pending), () => current.pending.delete(pending));
  return pending;
}
export function registerDraftFlush(id: string, flush: () => Promise<unknown>) { const current = state(id); current.flush.add(flush); return () => { current.flush.delete(flush); }; }
export async function settleDraftWrites(id: string) {
  const current = state(id);
  try {
    for (const flush of current.flush) await flush();
    while (current.pending.size) await Promise.allSettled([...current.pending]);
    if (current.errors.size) throw [...current.errors.values()][0];
  } catch (error) { throw new Error(`修改未保存，暂不能切换草稿：${error instanceof Error ? error.message : String(error)}`); }
}
