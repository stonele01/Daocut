import React from 'react';
import { createPortal } from 'react-dom';
import { FolderOpen, Loader2, X } from 'lucide-react';
import { api, type Project } from '@/api';
import type { ProjectBackupInspection } from '@/lib/project-backup-types';

/** Uses the existing project library; restoring always creates a new personal directory. */
export function ProjectBackupRestoreDialog({ onClose, onRestored }: { onClose: () => void; onRestored: (project: Project) => void }) {
  const [backupPath, setBackupPath] = React.useState('');
  const [targetPath, setTargetPath] = React.useState('');
  const [inspection, setInspection] = React.useState<ProjectBackupInspection | null>(null);
  const [mappings, setMappings] = React.useState<Record<string, string>>({});
  const [resultRoots, setResultRoots] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [restored, setRestored] = React.useState<{ project: Project; warnings: string[] } | null>(null);
  const field = 'w-full rounded border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] transition focus:border-blue-500 focus:outline-none';
  const button = 'rounded border border-[var(--border)] px-3 py-2 text-sm transition hover:bg-[var(--bg-hover)] active:scale-[.98] disabled:opacity-40';
  async function inspect() {
    setBusy(true); setError(''); setInspection(null);
    try { setInspection(await api.inspectProjectBackup(backupPath)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  async function restore() {
    if (!inspection) return;
    setBusy(true); setError('');
    try {
      const result = await api.restoreProjectBackup({ backupPath, targetPath, expectedBackupId: inspection.backupId, confirmed: true,
        mappings: inspection.libraries.map(library => ({ libraryId: library.id, root: mappings[library.id] ?? '' })),
        resultRoots: Object.entries(resultRoots).filter(([, root]) => root.trim()).map(([libraryId, root]) => ({ libraryId, root })) });
      setRestored(result);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  React.useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopImmediatePropagation(); if (!busy) onClose(); } };
    window.addEventListener('keydown', close, true); return () => window.removeEventListener('keydown', close, true);
  }, [busy, onClose]);
  return createPortal(<div className="fixed inset-0 z-[10120] flex items-center justify-center bg-black/50 p-6 animate-in fade-in duration-150" role="presentation">
    <section role="dialog" aria-modal="true" aria-labelledby="restore-backup-title" className="max-h-[85vh] w-full max-w-xl overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--bg-panel)] p-5 text-[var(--text)] shadow-xl transition-all">
      <div className="mb-4 flex items-center gap-2"><FolderOpen size={18} /><h2 id="restore-backup-title" className="flex-1 font-medium">恢复个人工程备份</h2><button aria-label="关闭" className={button} disabled={busy} onClick={onClose}><X size={16} /></button></div>
      <p className="mb-4 text-sm text-[var(--text-muted)]">恢复到新目录。商品修正、取用和成片属于你自己；保留原共享版本，不发送分析请求。</p>
      {!restored ? <div className="space-y-4">
        <label className="block space-y-1 text-sm"><span>完整备份文件夹</span><input className={field} value={backupPath} disabled={busy} onChange={event => { setBackupPath(event.target.value); setInspection(null); }} placeholder="D:\备份\直播工程 - backup" /></label>
        <button className={button} disabled={busy || !backupPath.trim()} onClick={() => void inspect()}>检查备份</button>
        {inspection && <div className="space-y-4 border-t border-[var(--border)] pt-3">
          <p className="text-sm">{inspection.name} · {inspection.fileCount} 个文件 · {inspection.sources.length} 个来源，校验通过</p>
          <label className="block space-y-1 text-sm"><span>新个人工程目录（必须尚不存在）</span><input className={field} disabled={busy} value={targetPath} onChange={event => setTargetPath(event.target.value)} placeholder="D:\DaocutProjects\恢复的直播工程" /></label>
          {inspection.libraries.map(library => <div key={library.id} className="space-y-3 rounded border border-[var(--border)] p-3 text-sm">
            <p>{library.name} <span className="text-[var(--text-muted)]">{library.id}</span></p>
            <label className="block space-y-1"><span>这台电脑上的素材库目录</span><input className={field} disabled={busy} value={mappings[library.id] ?? ''} onChange={event => setMappings(value => ({ ...value, [library.id]: event.target.value }))} /></label>
            <label className="block space-y-1"><span>共享结果目录（可暂不填写）</span><input className={field} disabled={busy} value={resultRoots[library.id] ?? ''} onChange={event => setResultRoots(value => ({ ...value, [library.id]: event.target.value }))} /></label>
          </div>)}
          <p className="text-xs text-[var(--text-muted)]">会核对原片完整内容，四小时视频可能需要较长时间。共享原片只创建链接，不复制。密钥需在这台电脑单独配置。</p>
          {inspection.hasPendingResults && <p className="text-sm">备份包含待补保存结果。恢复会保留原回包；公司服务或原任务未确认时保持待确认，不重新发送模型请求。</p>}
          <button className={button} disabled={busy || !targetPath.trim() || inspection.libraries.some(library => !mappings[library.id]?.trim())} onClick={() => void restore()}>确认恢复到新工程</button>
        </div>}
      </div> : <div className="space-y-3"><p>个人工程已恢复。</p>{restored.warnings.map((warning, index) => <p key={index} className="text-sm text-[var(--text-muted)]">{warning}</p>)}<button className={button} onClick={() => onRestored(restored.project)}>打开恢复的工程</button></div>}
      {busy && <p role="status" className="mt-3 flex items-center gap-2 text-sm"><Loader2 size={15} className="animate-spin" />正在校验和保存，请稍候</p>}
      {error && <p role="alert" className="mt-3 text-sm text-red-500">{error}</p>}
    </section>
  </div>, document.body);
}
