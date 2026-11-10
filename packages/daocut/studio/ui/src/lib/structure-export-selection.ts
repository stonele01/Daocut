/** Selection belongs to public plan IDs, never virtual row positions or the active timeline. */
export function toggleStructurePlan(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}
export function selectedStructurePlanIds(plans: readonly { id: string }[], selected: ReadonlySet<string>): string[] {
  return plans.filter(plan => selected.has(plan.id)).map(plan => plan.id);
}
export interface StructureBatchExportSelection {
  projectId: string;
  title: string;
  ordinals: number[];
  onExport: (options: StructureBatchExportOptions) => Promise<void>;
}
export interface StructureBatchExportOptions { name: string; folder: string; destination: 'jianying' | 'folder' }
export interface StructureExportItem {
  id: string; planId: string; label: string; exportName?: string; origin?: 'private' | 'public'; revision?: string;
  status: 'preparing' | 'waiting' | 'running' | 'done' | 'failed' | 'interrupted' | 'cancelled';
  progress: number; error?: string; outputs: string[]; retryable: boolean;
}
export interface StructureExportBatch {
  id: string; createdAt: string; folder: string; name?: string; destination?: 'jianying' | 'folder'; storageFolder?: string;
  status: 'preparing' | 'running' | 'complete' | 'failed' | 'interrupted' | 'cancelled';
  total: number; completed: number; failed: number; progress: number; items: StructureExportItem[];
}
