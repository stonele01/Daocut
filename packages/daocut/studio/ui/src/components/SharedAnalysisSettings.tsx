import React from 'react';
import { api, type StudioPrefs } from '@/api';

const button = 'rounded border border-[var(--border)] px-2 py-1 text-[11px] transition duration-150 hover:bg-[var(--bg-hover)] active:scale-95 disabled:opacity-40';

/** These are per-computer directory mappings. Saving does not start a task or write shared data. */
export function SharedAnalysisSettings({ onChanged }: { onChanged: () => void }) {
  const [open, setOpen] = React.useState(false);
  const [prefs, setPrefs] = React.useState<StudioPrefs | null>(null);
  const [enabled, setEnabled] = React.useState(false);
  const [roots, setRoots] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [saved, setSaved] = React.useState('');
  React.useEffect(() => {
    if (!open) return;
    let active = true;
    void api.prefs().then(value => {
      if (!active) return;
      setPrefs(value); setEnabled(value.sharedAnalysis?.enabled ?? false);
      setRoots(Object.fromEntries((value.sharedAnalysis?.resultRoots ?? []).map(item => [item.libraryId, item.root])));
    }, reason => { if (active) setError(String(reason.message ?? reason)); });
    return () => { active = false; };
  }, [open]);
  const save = async () => {
    if (!prefs || busy) return;
    const resultRoots = Object.entries(roots).filter(([, root]) => root.trim()).map(([libraryId, root]) => {
      const previous = prefs.sharedAnalysis?.resultRoots.find(item => item.libraryId === libraryId);
      const managed = prefs.sharedMediaLibraries.find(library => library.id === libraryId)?.managedFolder;
      return { ...previous, libraryId, root: managed && previous ? previous.root : root.trim() };
    });
    if (enabled && !resultRoots.length) { setError('请先填写一个共享结果目录'); return; }
    if (resultRoots.some(({ root }) => !/^(?:[a-z]:[\\/]|\\\\[^\\]+\\|\/)/i.test(root))) { setError('请填写完整的本机盘符路径或 NAS 共享路径'); return; }
    setBusy(true); setError(''); setSaved('');
    try {
      const next = await api.setPrefs({ sharedAnalysis: { enabled, resultRoots } });
      setPrefs(next); setSaved('共享设置已保存在本机'); onChanged();
    } catch (reason) { setError(String((reason as Error).message ?? reason)); }
    finally { setBusy(false); }
  };
  return <details open={open} onToggle={event => setOpen(event.currentTarget.open)} aria-label="共享分析设置" className="mt-2 rounded border border-[var(--border)] p-2 text-[11px] transition-all duration-150">
    <summary className="cursor-pointer text-[var(--text-muted)] transition hover:text-[var(--accent)]">共享分析设置</summary>
    {open && <div className="mt-2 space-y-2 animate-in fade-in duration-150">
      <p>同一直播先分析的人保存 AI 首版，同事直接复用。改名、字幕修正、取用和成片只留在各自工程。</p>
      <label className="flex items-center gap-2"><input type="checkbox" aria-label="启用共享分析" checked={enabled} disabled={busy || !prefs} onChange={event => { setEnabled(event.target.checked); setSaved(''); }} />启用共享分析</label>
      {prefs?.sharedMediaLibraries.map(library => <label key={library.id} className="block space-y-1">
        <span>{library.name}</span><span className="block break-all text-[var(--text-muted)]">素材库 ID：{library.id}</span>
        <input aria-label={prefs.sharedMediaLibraries.length === 1 ? '共享结果目录' : `${library.name}共享结果目录`} value={roots[library.id] ?? ''} disabled={busy || library.managedFolder} onChange={event => { setRoots(current => ({ ...current, [library.id]: event.target.value })); setSaved(''); }} placeholder="粘贴独立的分析结果文件夹路径" className="w-full min-w-0 rounded border border-[var(--border)] bg-[var(--dock-pane)] px-2 py-1 transition focus:border-[var(--accent)] focus:outline-none" />
        {library.managedFolder && <span className="block text-[var(--text-muted)]">此目录随直播文件夹自动管理。移动整场直播后，请重新选择直播文件夹。</span>}
      </label>)}
      {prefs && !prefs.sharedMediaLibraries.length && <p>请先在共享素材入口关联素材库；同事需使用相同素材库 ID。</p>}
      <p className="text-[var(--text-muted)]">这里只保存本机路径映射。转写、拆品、话术新请求仍分别确认；结果文件夹在保存分析结果时才写入。</p>
      <button type="button" className={button} disabled={!prefs || busy} onClick={() => void save()}>保存共享设置</button>
      {saved && <p role="status">{saved}</p>}
      {error && <p role="alert" className="text-red-400">{error}</p>}
    </div>}
  </details>;
}
