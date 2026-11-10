/**
 * The small start flow for a personal project from one shared product folder.
 * It is deliberately a dialog inside Projects, not another library/home page:
 * choose a live folder; only ask for a video when it contains several.
 */
import React from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, FolderOpen, HardDrive, Loader2, Settings2, Video, X } from 'lucide-react';
import { api, type Project, type SharedMediaFolder, type SharedMediaLibrary } from '@/api';
import { useT } from '@/i18n';

const newId = () => (globalThis.crypto?.randomUUID?.() ?? `shared-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

export function LegacySharedMediaProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (project: Project) => void }) {
  const t = useT();
  const [libraries, setLibraries] = React.useState<SharedMediaLibrary[] | null>(null);
  const [libraryId, setLibraryId] = React.useState('');
  const [newName, setNewName] = React.useState(t('projects.sharedLibraryDefaultName'));
  const [existingId, setExistingId] = React.useState('');
  const [remapping, setRemapping] = React.useState(false);
  const [advanced, setAdvanced] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const [libraryRootPath, setLibraryRootPath] = React.useState('');
  const [productFolderPath, setProductFolderPath] = React.useState('');
  const [listing, setListing] = React.useState<SharedMediaFolder | null>(null);
  const [videoPath, setVideoPath] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<'library' | 'folder' | 'creating' | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const requestId = React.useRef(newId());
  /* A hidden Windows folder dialog may finish long after the person switches to a typed path. */
  const pickerGeneration = React.useRef(0);

  React.useEffect(() => {
    void api.prefs().then((prefs) => {
      setLibraries(prefs.sharedMediaLibraries);
      setLibraryId((current) => current || prefs.sharedMediaLibraries[0]?.id || '');
    }, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || busy) return;
      event.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [busy, onClose]);

  const selected = libraries?.find((library) => library.id === libraryId) ?? null;
  const configuring = !selected || remapping;
  const message = (e: unknown) => e instanceof Error ? e.message : String(e);
  const associateLibraryRoot = async (root: string) => {
    const id = remapping && selected ? selected.id : existingId.trim() || newId();
    if (!/^[a-z0-9][a-z0-9._-]{7,79}$/i.test(id)) throw new Error('素材库 ID 应为 8–80 位字母、数字、点、下划线或连字符。');
    const latest = await api.prefs();
    const known = latest.sharedMediaLibraries.find(library => library.id === id);
    if (known && !remapping) throw new Error('此素材库 ID 已在本机关联，请先选择该素材库，再更换本机目录。');
    if (remapping && known?.root !== selected?.root) throw new Error('此素材库映射已在别处修改，请关闭后重开并核对。');
    const library = await api.sharedMediaLibrary({ id, name: remapping && selected ? selected.name : newName.trim() || t('projects.sharedLibraryDefaultName'), root });
    setLibraries([...latest.sharedMediaLibraries.filter(item => item.id !== library.id), library]);
    setLibraryId(library.id);
    setExistingId(''); setRemapping(false); setCopied(false);
    setLibraryRootPath(''); setListing(null); setVideoPath(null); requestId.current = newId();
  };
  const chooseLibraryRoot = async () => {
    if (busy) return;
    const generation = ++pickerGeneration.current;
    setBusy('library'); setError(null);
    try {
      const root = await api.pickFolder(t('projects.sharedPickLibraryRoot'));
      if (pickerGeneration.current !== generation) return;
      if (!root) return;
      await associateLibraryRoot(root);
    } catch (e) { if (pickerGeneration.current === generation) setError(message(e)); }
    finally { if (pickerGeneration.current === generation) setBusy(null); }
  };
  const useLibraryRootPath = async () => {
    const root = libraryRootPath.trim();
    if (!root || busy) return;
    setBusy('library'); setError(null);
    try { await associateLibraryRoot(root); }
    catch (e) { setError(message(e)); }
    finally { setBusy(null); }
  };
  const createVideo = async (library: SharedMediaLibrary, path: string, id: string) => {
    setBusy('creating');
    const made = await api.sharedMediaProject(library.id, path, id);
    onCreated(made.project);
  };
  const browseProductFolder = async (folder: string, generation: number) => {
    if (!selected) return;
    const next = await api.sharedMediaBrowse(selected.id, folder);
    if (pickerGeneration.current !== generation) return;
    const id = newId();
    requestId.current = id;
    const onlyVideo = next.videos.length === 1 && !next.moreVideos ? next.videos[0] : null;
    setProductFolderPath(''); setListing(next); setVideoPath(onlyVideo?.path ?? null);
    if (onlyVideo) await createVideo(selected, onlyVideo.path, id);
  };
  const chooseProductFolder = async () => {
    if (!selected || busy) return;
    const generation = ++pickerGeneration.current;
    setBusy('folder'); setError(null);
    try {
      const folder = await api.pickFolder(t('projects.sharedPickProductFolder'), selected.root);
      if (pickerGeneration.current !== generation) return;
      if (!folder) return;
      await browseProductFolder(folder, generation);
    } catch (e) { if (pickerGeneration.current === generation) setError(message(e)); }
    finally { if (pickerGeneration.current === generation) setBusy(null); }
  };
  const useProductFolderPath = async () => {
    const folder = productFolderPath.trim();
    if (!selected || !folder || busy) return;
    const generation = ++pickerGeneration.current;
    setBusy('folder'); setError(null);
    try { await browseProductFolder(folder, generation); }
    catch (e) { if (pickerGeneration.current === generation) setError(message(e)); }
    finally { if (pickerGeneration.current === generation) setBusy(null); }
  };
  const usePastedPathInstead = () => {
    pickerGeneration.current++;
    setBusy(null); setError(null);
  };
  const create = async () => {
    if (!selected || !videoPath || busy) return;
    setBusy('creating'); setError(null);
    try {
      await createVideo(selected, videoPath, requestId.current);
    } catch (e) { setError(message(e)); setBusy(null); }
  };

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div role="dialog" aria-modal aria-label={t('projects.createFromShared')} className="fixed inset-0 z-[10100] flex items-center justify-center bg-black/35 p-4 backdrop-blur-[2px]"
      onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) onClose(); }}>
      <div className="flex max-h-[calc(100vh-48px)] w-full max-w-[620px] flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-lg)]"
        style={{ animation: 'daocut-pop 0.16s ease-out both' }}>
        <header className="flex items-start gap-3 px-5 pb-3 pt-5">
          <div className="min-w-0 flex-1">
            <p className="text-[15px] font-semibold text-[var(--text)]">{t('projects.createFromShared')}</p>
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-[var(--text-muted)]">{t('projects.createFromSharedNote')}</p>
          </div>
          <button type="button" onClick={onClose} disabled={Boolean(busy)} aria-label={t('confirm.cancel')}
            className="-mr-1.5 -mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text)] disabled:opacity-50"><X size={15} /></button>
        </header>

        <div className="min-h-0 space-y-4 overflow-y-auto px-5 pb-5">
          {libraries == null ? <div role="status" className="flex items-center gap-2 text-[12px] text-[var(--text-muted)]"><Loader2 size={14} className="animate-spin" />{t('projects.sharedLoading')}</div> : null}
          {libraries && (libraries.length > 1 || !selected) ? <select aria-label="日常素材库" value={libraryId} disabled={Boolean(busy)} onChange={event => { setLibraryId(event.target.value); setRemapping(false); setListing(null); setVideoPath(null); setError(null); requestId.current = newId(); }} className="h-9 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 text-[12.5px] text-[var(--text)]">
            {libraries.map(library => <option key={library.id} value={library.id}>{library.name}</option>)}
            {!selected && <option value="">请先配置素材库</option>}
          </select> : null}
          <details open={advanced || (libraries != null && !selected)} onToggle={event => setAdvanced(event.currentTarget.open)} className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3 transition-colors">
            <summary className="flex cursor-pointer items-center gap-2 text-[12px] text-[var(--text-muted)] transition hover:text-[var(--text)]"><Settings2 size={14} />素材库设置</summary>
            <section className="mt-3 animate-in fade-in duration-150">
            <div className="mb-2 flex items-center gap-2 text-[12.5px] font-medium text-[var(--text)]"><HardDrive size={15} className="text-[var(--accent)]" />{t('projects.sharedLibrary')}</div>
            {libraries == null ? <div className="flex items-center gap-2 py-1 text-[12px] text-[var(--text-muted)]"><Loader2 size={14} className="animate-spin" />{t('projects.sharedLoading')}</div> : libraries.length ? (
              <select aria-label="选择素材库" value={libraryId} disabled={Boolean(busy)} onChange={(event) => { setLibraryId(event.target.value); setRemapping(false); setCopied(false); setExistingId(''); setLibraryRootPath(''); setError(null); setListing(null); setVideoPath(null); requestId.current = newId(); }}
                className="h-9 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 text-[12.5px] text-[var(--text)] outline-none transition focus:border-[var(--accent)]">
                {libraries.map((library) => <option key={library.id} value={library.id}>{library.name}</option>)}
                <option value="">关联其他素材库</option>
              </select>
            ) : null}
            {selected && !remapping && <div className="mt-2 space-y-1 text-[11px] text-[var(--text-muted)]">
              <p aria-label="当前素材库 ID" className="break-all">素材库 ID：{selected.id}</p>
              <p className="break-all">本机目录：{selected.root}</p>
              <div className="flex gap-2">
                <button type="button" aria-label="复制素材库 ID" className="inline-flex items-center gap-1 rounded border border-[var(--border)] px-2 py-1 transition hover:bg-[var(--bg-hover)] active:scale-95" onClick={() => { void navigator.clipboard.writeText(selected.id).then(() => setCopied(true), () => setError('复制失败，请选中文字复制素材库 ID。')); }}><Copy size={12} />{copied ? '已复制' : '复制 ID'}</button>
                <button type="button" disabled={Boolean(busy)} className="rounded border border-[var(--border)] px-2 py-1 transition hover:bg-[var(--bg-hover)] active:scale-95 disabled:opacity-50" onClick={() => { setRemapping(true); setLibraryRootPath(selected.root); setListing(null); setVideoPath(null); setError(null); }}>更换本机目录</button>
              </div>
            </div>}
            {libraries != null && configuring && (
              <div className="mt-2 space-y-2 animate-in fade-in duration-150">
                {!remapping && <>
                <input value={newName} onChange={(event) => setNewName(event.target.value)} disabled={Boolean(busy)} maxLength={80} placeholder={t('projects.sharedLibraryName')}
                  className="h-9 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 text-[12.5px] text-[var(--text)] outline-none transition focus:border-[var(--accent)]" />
                <label className="block text-[11.5px] text-[var(--text-muted)]">已有素材库 ID（可选）
                  <input aria-label="已有素材库 ID（可选）" value={existingId} onChange={event => setExistingId(event.target.value)} disabled={Boolean(busy)} maxLength={80} placeholder="同事已有素材库时，粘贴相同 ID" className="mt-1 h-8 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 text-[12px] text-[var(--text)] outline-none transition focus:border-[var(--accent)]" />
                </label>
                <p className="text-[11px] text-[var(--text-faint)]">新素材库留空自动生成；同事使用同一个 ID，各自关联本机目录。</p>
                </>}
                {remapping && <p className="text-[11.5px] text-[var(--text-muted)]">保留素材库 ID {selected?.id}，只更换这台电脑的路径映射。</p>}
                <p className="text-[11.5px] leading-relaxed text-[var(--text-muted)]">{t('projects.sharedLibraryRootNote')}</p>
                <div className="flex gap-2">
                  <input value={libraryRootPath} onChange={(event) => setLibraryRootPath(event.target.value)} disabled={Boolean(busy)} placeholder={t('projects.sharedLibraryPath')}
                    className="h-8 min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 text-[12px] text-[var(--text)] outline-none transition focus:border-[var(--accent)]" />
                  <button type="button" onClick={() => void useLibraryRootPath()} disabled={!libraryRootPath.trim() || Boolean(busy)}
                    className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border border-[var(--border)] px-2.5 text-[12px] font-medium text-[var(--text-dim)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text)] disabled:opacity-50"><Check size={13} />{remapping ? '确认更换本机目录' : t('projects.sharedUseLibraryPath')}</button>
                </div>
                <p className="text-[11px] leading-relaxed text-[var(--text-faint)]">{t('projects.sharedPathFallback')}</p>
              </div>
            )}
            {libraries != null && configuring ? <button type="button" onClick={() => void chooseLibraryRoot()} disabled={Boolean(busy)}
              className="mt-2 inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 text-[12.5px] font-medium text-[var(--text-dim)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text)] disabled:opacity-50">
              {busy === 'library' ? <Loader2 size={14} className="animate-spin" /> : <FolderOpen size={14} />}{t('projects.sharedConfigureLibrary')}
            </button> : null}
            {busy === 'library' ? <button type="button" onClick={usePastedPathInstead}
              className="mt-2 inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 text-[12.5px] font-medium text-[var(--text-dim)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"><Check size={14} />{t('projects.sharedUsePathInstead')}</button> : null}
            </section>
          </details>

          <section className="rounded-xl border border-[var(--border)] p-3 transition-colors">
            <div className="mb-1 text-[12.5px] font-medium text-[var(--text)]">{t('projects.sharedProductFolder')}</div>
            <p className="mb-2 text-[11.5px] leading-relaxed text-[var(--text-muted)]">{t('projects.sharedProductFolderNote')}</p>
            <button type="button" onClick={() => void chooseProductFolder()} disabled={!selected || Boolean(busy)}
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-[var(--accent)] px-4 text-[13px] font-medium text-white transition hover:brightness-110 hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50">
              {busy === 'folder' ? <Loader2 size={14} className="animate-spin" /> : <FolderOpen size={14} />}{t('projects.sharedChooseProductFolder')}
            </button>
            {busy === 'folder' ? <button type="button" onClick={usePastedPathInstead} className="ml-2 inline-flex h-8 items-center gap-1 rounded-lg border border-[var(--border)] px-2 text-[12px] text-[var(--text-muted)] transition hover:bg-[var(--bg-hover)] active:scale-95">{t('projects.sharedUsePathInstead')}</button> : null}
            <details className="mt-3 text-[11.5px] text-[var(--text-muted)]"><summary className="cursor-pointer transition hover:text-[var(--text)]">粘贴文件夹路径</summary>
            <div className="mt-2 flex gap-2">
              <input value={productFolderPath} onChange={(event) => setProductFolderPath(event.target.value)} disabled={!selected || Boolean(busy)} placeholder={t('projects.sharedProductPath')}
                className="h-8 min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 text-[12px] text-[var(--text)] outline-none transition focus:border-[var(--accent)] disabled:opacity-50" />
              <button type="button" onClick={() => void useProductFolderPath()} disabled={!selected || !productFolderPath.trim() || Boolean(busy)}
                className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border border-[var(--border)] px-2.5 text-[12px] font-medium text-[var(--text-dim)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text)] disabled:opacity-50"><Check size={13} />{t('projects.sharedUseProductPath')}</button>
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-faint)]">{t('projects.sharedPathFallback')}</p>
            </details>
            {listing ? <p className="mt-2 truncate text-[11.5px] text-[var(--text-muted)]" title={listing.folder}>{listing.folder || selected?.name}</p> : null}
          </section>

          {busy === 'creating' ? <p role="status" className="flex items-center gap-2 text-[12px] text-[var(--text-muted)]"><Loader2 size={14} className="animate-spin" />正在打开原片并读取已有分析…</p> : null}
          {listing && busy !== 'creating' ? <section className="rounded-xl border border-[var(--border)] p-3 transition-colors">
            <div className="mb-2 flex items-center justify-between gap-2"><div className="text-[12.5px] font-medium text-[var(--text)]">{t('projects.sharedChooseVideo')}</div><span className="text-[11.5px] text-[var(--text-muted)]">{listing.videos.length}</span></div>
            {listing.videos.length ? <div className="max-h-48 space-y-1 overflow-y-auto pr-1">
              {listing.videos.map((video) => <button key={video.path} type="button" onClick={() => { setVideoPath(video.path); requestId.current = newId(); }}
                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12.5px] transition ${videoPath === video.path ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-dim)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]'}`}>
                {videoPath === video.path ? <Check size={14} /> : <Video size={14} className="text-[var(--text-faint)]" />}<span className="min-w-0 flex-1 truncate">{video.name}</span>
              </button>)}
            </div> : <p className="text-[12px] text-[var(--text-muted)]">{t('projects.sharedNoVideos')}</p>}
            {listing.moreVideos ? <p className="mt-2 text-[11.5px] text-[var(--text-muted)]">{t('projects.sharedAddTruncated')}</p> : null}
            <p className="mt-2 text-[11.5px] text-[var(--text-muted)]">{listing.transcripts.length ? t('projects.sharedTranscriptsFound').replace('{n}', String(listing.transcripts.length)) : t('projects.sharedNoTranscripts')}</p>
          </section> : null}

          {error ? <p role="alert" className="rounded-lg bg-[var(--danger,#e5484d)]/10 px-3 py-2 text-[12px] leading-relaxed text-[var(--danger,#e5484d)]">{error}</p> : null}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-[var(--border)] px-5 py-3">
          <button type="button" onClick={onClose} disabled={Boolean(busy)} className="h-8 rounded-lg px-3 text-[12.5px] text-[var(--text-muted)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text)] disabled:opacity-50">{t('confirm.cancel')}</button>
          {listing && <button type="button" onClick={() => void create()} disabled={!videoPath || Boolean(busy)} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3.5 text-[12.5px] font-medium text-white transition hover:brightness-95 active:scale-[0.98] disabled:opacity-45">
            {busy === 'creating' ? <Loader2 size={14} className="animate-spin" /> : <Video size={14} />}{t('projects.sharedCreateProject')}
          </button>}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
