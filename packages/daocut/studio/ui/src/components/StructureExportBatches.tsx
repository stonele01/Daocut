import * as React from 'react';
import { api } from '@/api';
import type { StructureExportBatch } from '@/lib/structure-export-selection';

const button = 'rounded border border-[var(--border)] px-2 py-1 text-[11px] transition duration-150 hover:bg-[var(--bg-hover)] active:scale-95 disabled:opacity-40';
const statusText = (status: string) => ({ preparing: '固定版本中', waiting: '排队中', running: '导出中', done: '已完成', complete: '已完成', failed: '有失败项', interrupted: '已中断', cancelled: '已取消' }[status] ?? status);

export function StructureExportBatches({ projectId, revision }: { projectId: string; revision: number }) {
  const [batches, setBatches] = React.useState<StructureExportBatch[]>([]);
  const [error, setError] = React.useState(''), [busy, setBusy] = React.useState(''), [copied, setCopied] = React.useState('');
  React.useEffect(() => {
    let alive = true, timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try { const value = await api.structureExports(projectId); if (alive) { setBatches(value.batches); setError(''); } }
      catch (e) { if (alive) setError(e instanceof Error ? e.message : String(e)); }
      finally { if (alive) timer = setTimeout(refresh, 1200); }
    };
    void refresh();
    return () => { alive = false; clearTimeout(timer); };
  }, [projectId, revision]);
  const act = async (batchId: string, action: 'retry' | 'cancel') => {
    setBusy(batchId);
    try {
      if (action === 'retry') await api.retryStructureExport(projectId, batchId); else await api.cancelStructureExport(projectId, batchId);
      setBatches((await api.structureExports(projectId)).batches); setError('');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(''); }
  };
  if (!batches.length && !error) return null;
  return <details className="shrink-0 border-t border-[var(--border)] px-3 py-2 text-[11px]" open>
    <summary className="cursor-pointer font-medium">剪映批量导出{batches.length ? ` · ${batches[0]!.completed}/${batches[0]!.total}` : ''}</summary>
    {error && <p role="alert" className="mt-1 text-[var(--warn)]">{error}</p>}
    <div className="mt-2 max-h-48 space-y-3 overflow-y-auto">
      {batches.map(batch => <details key={batch.id} className="border-t border-[var(--border)] pt-2" open={batch === batches[0]}>
        <summary className="cursor-pointer">{statusText(batch.status)} · 成功 {batch.completed}/{batch.total}{batch.failed ? ` · 失败 ${batch.failed}` : ''}</summary>
        <progress className="mt-1 w-full accent-[var(--accent)]" aria-label="批量导出进度" max={1} value={batch.progress} />
        <p className="break-all text-[var(--text-muted)]" title={batch.folder}>目录：{batch.folder}</p>
        <p className="mt-1 text-[var(--text-muted)]">{batch.destination === 'jianying' ? '目标为剪映草稿库，共用素材随库保留' : '草稿共用本批素材，请保留完整导出目录'}</p>
        <div className="my-2 flex flex-wrap gap-1">
          <button className={button} onClick={() => void api.revealStructureExport(projectId, batch.id).catch(e => setError(e instanceof Error ? e.message : String(e)))}>打开文件夹</button>
          <button className={button} onClick={() => void navigator.clipboard.writeText(batch.folder).then(() => setCopied(batch.id), e => setError(String(e)))}>{copied === batch.id ? '目录已复制' : '复制目录'}</button>
          {batch.items.some(item => item.retryable) && !['preparing', 'running'].includes(batch.status) && <button className={button} disabled={!!busy} onClick={() => void act(batch.id, 'retry')}>继续未完成项</button>}
          {['preparing', 'running'].includes(batch.status) && <button className={button} disabled={!!busy} onClick={() => void act(batch.id, 'cancel')}>取消剩余</button>}
        </div>
        {batch.items.map(item => <div key={item.id} className="mb-1.5">
          <p className="break-words">{item.exportName ?? item.label} · {item.status === 'failed' ? '失败' : statusText(item.status)}{item.status === 'running' ? ` ${Math.round(item.progress * 100)}%` : ''}{item.origin ? ` · ${item.origin === 'private' ? '个人草稿' : '公共方案'}` : ''}</p>
          {item.error && <p className="break-words text-[var(--warn)]">{item.error}</p>}
        </div>)}
      </details>)}
    </div>
  </details>;
}
