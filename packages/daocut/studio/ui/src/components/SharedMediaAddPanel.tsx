import React from 'react';
import { FolderOpen, Loader2 } from 'lucide-react';
import { api, type SharedMediaFolder, type SharedMediaLibrary } from '@/api';
import { useT } from '@/i18n';

export function SharedMediaAddPanel({ projectId, onAdded }: { projectId: string; onAdded: (assets: string[]) => void }) {
  const t = useT();
  const [libraries, setLibraries] = React.useState<SharedMediaLibrary[] | null>(null);
  const [libraryId, setLibraryId] = React.useState('');
  const [folder, setFolder] = React.useState('');
  const [listedFolder, setListedFolder] = React.useState('');
  const [listing, setListing] = React.useState<SharedMediaFolder | null>(null);
  const [selected, setSelected] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState<'picker' | 'browse' | 'add' | null>(null);
  const [error, setError] = React.useState('');
  const generation = React.useRef(0);
  React.useEffect(() => {
    void api.prefs().then((prefs) => { setLibraries(prefs.sharedMediaLibraries); setLibraryId(prefs.sharedMediaLibraries[0]?.id ?? ''); }, (e: unknown) => setError(String(e)));
    return () => { generation.current++; };
  }, []);
  const library = libraries?.find((item) => item.id === libraryId);
  const browse = async (path: string) => {
    const id = ++generation.current;
    setBusy('browse'); setError(''); setListing(null); setSelected([]);
    try {
      const result = await api.sharedMediaBrowse(libraryId, path);
      if (generation.current === id) { setFolder(path); setListedFolder(path); setListing(result); }
    } catch (e) { if (generation.current === id) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (generation.current === id) setBusy(null); }
  };
  const pick = async () => {
    const id = ++generation.current;
    setBusy('picker'); setError('');
    try {
      const path = await api.pickFolder(t('projects.sharedPickProductFolder'), library?.root);
      if (generation.current === id && path) { await browse(path); return; }
    } catch (e) { if (generation.current === id) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (generation.current === id) setBusy(null); }
  };
  const add = async () => {
    setBusy('add'); setError('');
    try { const result = await api.sharedMediaAdd(projectId, libraryId, listedFolder, selected); setSelected([]); onAdded(result.assets); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };
  const inputClass = 'h-8 min-w-0 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 text-[12px] text-[var(--text)] outline-none focus:border-[var(--accent)] disabled:opacity-50';
  const buttonClass = 'inline-flex h-8 items-center gap-1 rounded-lg border border-[var(--border)] px-2.5 text-[12px] text-[var(--text-dim)] transition hover:bg-[var(--bg-hover)] active:scale-[0.98] disabled:opacity-50';
  return <div className="space-y-2 text-[12px]">
    {libraries === null ? <Loader2 size={14} className="animate-spin" /> : libraries.length === 0 ? <p className="text-[var(--text-muted)]">{t('projects.sharedAddNoLibraries')}</p> : <>
      <label className="block text-[var(--text-muted)]">{t('projects.sharedLibrary')}
        <select className={`${inputClass} mt-1 w-full`} value={libraryId} disabled={busy !== null} onChange={(event) => { setLibraryId(event.target.value); setListing(null); setSelected([]); setFolder(''); }}>
          {libraries.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>
      <label className="block text-[var(--text-muted)]">{t('projects.sharedProductFolder')}
        <div className="mt-1 flex gap-1">
          <input className={`${inputClass} flex-1`} value={folder} disabled={busy !== null} onChange={(event) => { setFolder(event.target.value); setListing(null); setSelected([]); }} placeholder={t('projects.sharedProductPath')} />
          <button type="button" className={buttonClass} disabled={!folder.trim() || busy !== null} onClick={() => void browse(folder.trim())}>{t('projects.sharedUseProductPath')}</button>
          <button type="button" className={buttonClass} disabled={busy !== null} onClick={() => void pick()} aria-label={t('projects.sharedChooseProductFolder')}><FolderOpen size={14} /></button>
        </div>
      </label>
      {busy === 'picker' && <button type="button" className={buttonClass} onClick={() => { generation.current++; setBusy(null); }}>{t('projects.sharedUsePathInstead')}</button>}
      {listing && <div>
        <p className="mb-1 text-[var(--text-muted)]">{t('projects.sharedAddChooseVideos')}</p>
        <div className="max-h-40 space-y-1 overflow-y-auto">{listing.videos.map((video) => <label key={video.path} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-[var(--text)] hover:bg-[var(--bg-hover)]">
          <input type="checkbox" checked={selected.includes(video.path)} disabled={busy !== null} onChange={(event) => setSelected((current) => event.target.checked ? [...current, video.path] : current.filter((path) => path !== video.path))} /><span className="truncate">{video.name}</span>
        </label>)}</div>
        {!listing.videos.length && <p className="text-[var(--text-muted)]">{t('projects.sharedNoVideos')}</p>}
        {listing.moreVideos && <p className="text-[var(--text-muted)]">{t('projects.sharedAddTruncated')}</p>}
      </div>}
      <button type="button" className={buttonClass} disabled={!selected.length || busy !== null} onClick={() => void add()}>{busy === 'add' && <Loader2 size={14} className="animate-spin" />}{t('projects.sharedAddButton').replace('{n}', String(selected.length))}</button>
    </>}
    {error && <p role="alert" className="text-[var(--danger,#e5484d)]">{error}</p>}
  </div>;
}
