import React from 'react';
import { createPortal } from 'react-dom';
import { Check, FolderOpen, Loader2, Settings2, Video, X } from 'lucide-react';
import { api, type Project, type SharedLiveFolder } from '@/api';
import { LegacySharedMediaProjectDialog } from './LegacySharedMediaProjectDialog';

const newId = () => crypto.randomUUID();
const button = 'inline-flex items-center justify-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2 text-[12px] transition hover:bg-[var(--bg-hover)] active:scale-[0.98] disabled:opacity-50';

/** One folder is the normal entry. Manual mappings remain available for older libraries. */
export function DailyLiveFolderDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (project: Project) => void }) {
  const [advanced, setAdvanced] = React.useState(false);
  const [typedPath, setTypedPath] = React.useState('');
  const [showPath, setShowPath] = React.useState(false);
  const [folder, setFolder] = React.useState<SharedLiveFolder | null>(null);
  const [videoPath, setVideoPath] = React.useState<string | null>(null);
  const [projects, setProjects] = React.useState<Project[]>([]);
  const [busy, setBusy] = React.useState<'picker' | 'folder' | 'initialize' | 'project' | null>(null);
  const [error, setError] = React.useState('');
  const generation = React.useRef(0);
  const requestId = React.useRef(newId());
  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current++; };
  }, []);
  const current = (id: number) => mounted.current && generation.current === id;
  const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);
  const openProject = async (value: SharedLiveFolder, path: string, id: number, choice?: { projectId?: string; createNew?: boolean }) => {
    setBusy('project'); setError('');
    try {
      const result = await api.sharedLiveProject({ folder: value.folder, videoPath: path, requestId: requestId.current, ...choice });
      if (!current(id)) return;
      if (result.status === 'choose-project') setProjects(result.projects);
      else {
        if (result.reused && result.sharedRead && Object.values(result.sharedRead.imported).some(count => count > 0)) {
          window.dispatchEvent(new CustomEvent('refresh-product-analysis', { detail: { type: 'refresh-product-analysis', projectId: result.project.id } }));
        }
        onCreated(result.project);
      }
    } catch (reason) { if (current(id)) setError(message(reason)); }
    finally { if (current(id)) setBusy(null); }
  };
  const readFolder = async (path: string, id: number, initialize = false) => {
    if (!path.trim()) return;
    setBusy(initialize ? 'initialize' : 'folder'); setError(''); setProjects([]);
    try {
      const value = await api.sharedLiveFolder(path.trim(), initialize);
      if (!current(id)) return;
      setFolder(value);
      const only = value.videos.length === 1 && !value.moreVideos ? value.videos[0].path : null;
      setVideoPath(only);
      if (value.status === 'ready' && only) await openProject(value, only, id);
    } catch (reason) { if (current(id)) setError(message(reason)); }
    finally { if (current(id)) setBusy(null); }
  };
  const pickFolder = async () => {
    const id = ++generation.current;
    requestId.current = newId(); setFolder(null); setProjects([]); setVideoPath(null); setBusy('picker'); setError('');
    try {
      const path = await api.pickFolder('选择直播文件夹');
      if (!current(id)) return;
      if (path) await readFolder(path, id);
    } catch (reason) { if (current(id)) setError(message(reason)); }
    finally { if (current(id)) setBusy(null); }
  };
  const usePath = () => {
    const id = ++generation.current;
    requestId.current = newId(); setFolder(null); setProjects([]); setVideoPath(null);
    void readFolder(typedPath, id);
  };
  const cancelPicker = () => { generation.current++; setBusy(null); setShowPath(true); setError(''); };
  React.useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || busy || advanced) return;
      event.stopImmediatePropagation(); onClose();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [busy, advanced, onClose]);
  if (advanced) return <LegacySharedMediaProjectDialog onClose={() => setAdvanced(false)} onCreated={onCreated} />;
  if (typeof document === 'undefined') return null;
  return createPortal(<div role="dialog" aria-modal aria-label="打开直播文件夹" className="fixed inset-0 z-[10100] flex items-center justify-center bg-black/35 p-4 backdrop-blur-[2px]" onMouseDown={event => { if (!busy && event.target === event.currentTarget) onClose(); }}>
    <div className="flex max-h-[calc(100vh-48px)] w-full max-w-[620px] flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-lg)]" style={{ animation: 'daocut-pop 0.16s ease-out both' }}>
      <header className="flex items-start gap-3 px-5 pb-3 pt-5">
        <div className="min-w-0 flex-1"><p className="text-[15px] font-semibold">打开直播文件夹</p><p className="mt-1 text-[12px] leading-relaxed text-[var(--text-muted)]">选择存放原视频的文件夹，自动识别已有分析并继续你自己的工程。</p></div>
        <button type="button" className={button} aria-label="取消" disabled={!!busy} onClick={onClose}><X size={15} /></button>
      </header>
      <div className="space-y-4 overflow-y-auto px-5 pb-5">
        <section className="space-y-3 rounded-xl border border-[var(--border)] p-3 transition-colors">
          <button type="button" disabled={!!busy} onClick={() => void pickFolder()} className="inline-flex h-10 items-center gap-2 rounded-lg bg-[var(--accent)] px-4 text-[13px] font-medium text-white transition hover:brightness-110 hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50"><FolderOpen size={15} />选择直播文件夹</button>
          {busy === 'picker' && <button type="button" className={`${button} ml-2`} onClick={cancelPicker}>改用粘贴路径</button>}
          <details open={showPath} onToggle={event => setShowPath(event.currentTarget.open)} className="text-[12px] text-[var(--text-muted)]">
            <summary className="cursor-pointer transition hover:text-[var(--text)]">粘贴文件夹路径</summary>
            <div className="mt-2 flex gap-2"><input value={typedPath} onChange={event => setTypedPath(event.target.value)} placeholder="直播文件夹完整路径" disabled={!!busy} className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 outline-none transition focus:border-[var(--accent)]" /><button type="button" disabled={!!busy || !typedPath.trim()} className={button} onClick={usePath}><Check size={14} />使用路径</button></div>
          </details>
        </section>
        {folder && <div className="space-y-2 text-[12px] animate-in fade-in duration-150"><p className="break-all text-[var(--text-muted)]">{folder.folder}</p>{folder.warnings.map(warning => <p key={warning} className="text-[var(--warn)]">{warning}</p>)}</div>}
        {folder?.status === 'needs-initialization' && folder.videos.length > 0 && <section className="space-y-2 rounded-xl border border-[var(--border)] p-3 text-[12px] animate-in fade-in duration-150"><p>这场直播首次使用 Daocut。将在下面位置保存共享分析结果，编号由软件管理。</p><p className="break-all text-[var(--text-muted)]">{folder.resultRoot}</p><p className="text-[var(--text-muted)]">个人商品修正、选材和成片保存在本机工程。</p><button type="button" className={button} disabled={!!busy} onClick={() => void readFolder(folder.folder, generation.current, true)}>创建共享结果目录并打开</button></section>}
        {folder && !folder.videos.length && <p className="text-[12px] text-[var(--text-muted)]">此文件夹没有可用视频。</p>}
        {folder?.status === 'ready' && (folder.videos.length > 1 || folder.moreVideos) && <section className="space-y-2 rounded-xl border border-[var(--border)] p-3 animate-in fade-in duration-150"><p className="text-[12px] text-[var(--text-muted)]">选择这次要打开的视频；每个视频分别保存分析结果。</p>{folder.videos.map(video => <button type="button" key={video.path} disabled={!!busy} className={`${button} w-full justify-start ${videoPath === video.path ? 'border-[var(--accent)] text-[var(--accent)]' : ''}`} onClick={() => { setVideoPath(video.path); setProjects([]); requestId.current = newId(); }}><Video size={14} /><span className="truncate">{video.name}</span></button>)}{folder.moreVideos && <p className="text-[12px] text-[var(--warn)]">视频较多，当前只显示部分列表。</p>}<button type="button" className={button} disabled={!videoPath || !!busy} onClick={() => { if (videoPath) void openProject(folder, videoPath, generation.current); }}>打开所选视频</button></section>}
        {projects.length > 0 && folder && videoPath && <section className="space-y-2 rounded-xl border border-[var(--border)] p-3 animate-in fade-in duration-150"><p className="text-[12px]">本机有多个使用此视频的工程，请选择继续哪一个。</p>{projects.map(project => <button type="button" key={project.id} className={`${button} w-full justify-start`} disabled={!!busy} onClick={() => void openProject(folder, videoPath, generation.current, { projectId: project.id })}>继续：{project.name}</button>)}<button type="button" className={button} disabled={!!busy} onClick={() => void openProject(folder, videoPath, generation.current, { createNew: true })}>另外新建个人工程</button></section>}
        {busy && <p role="status" className="flex items-center gap-2 text-[12px] text-[var(--text-muted)]"><Loader2 size={14} className="animate-spin" />{busy === 'project' ? '正在打开自己的工程并读取已有分析…' : busy === 'initialize' ? '正在创建共享结果目录…' : busy === 'picker' ? '请选择直播文件夹…' : '正在识别直播文件夹…'}</p>}
        {error && <div role="alert" className="space-y-2 text-[12px] text-red-400"><p>{error}</p>{folder?.status === 'ready' && videoPath && !projects.length && <button type="button" className={button} disabled={!!busy} onClick={() => void openProject(folder, videoPath, generation.current)}>重试打开</button>}</div>}
        <button type="button" disabled={!!busy} onClick={() => setAdvanced(true)} className="inline-flex items-center gap-1.5 text-[11.5px] text-[var(--text-muted)] transition hover:text-[var(--text)] active:scale-[0.98]"><Settings2 size={13} />手动配置旧素材库</button>
      </div>
    </div>
  </div>, document.body);
}
