import * as React from 'react';
import { Play, Pause, X } from 'lucide-react';
import { previewPosition, structureRole, type StructurePlan } from '@/lib/structure-workspace';
import { sourceTime } from '@/lib/product-analysis';

/** A read-only sequence player. It never writes film.html or enters the editing undo stack. */
export function StructurePlanPreview({ plan, folder, onClose }: { plan: StructurePlan; folder: string; onClose: () => void }) {
  const video = React.useRef<HTMLVideoElement>(null);
  const index = React.useRef(0), changing = React.useRef(false), wantsPlay = React.useRef(false);
  const [clock, setClock] = React.useState(0), [playing, setPlaying] = React.useState(false), [error, setError] = React.useState('');
  const clip = plan.clips[previewPosition(plan, clock).index]!;
  const source = plan.clips[0]?.assetPath;
  const seek = (ms: number, play = wantsPlay.current) => {
    const element = video.current; if (!element) return;
    const next = previewPosition(plan, ms); index.current = next.index; changing.current = true;
    wantsPlay.current = play; element.pause(); element.playbackRate = 1; element.currentTime = next.sourceMs / 1000; setClock(ms);
  };
  const tick = () => {
    const element = video.current; if (!element || changing.current) return;
    const current = plan.clips[index.current]!;
    const offset = plan.clips.slice(0, index.current).reduce((sum, part) => sum + part.endMs - part.startMs, 0);
    if (element.currentTime * 1000 >= current.endMs - 15) {
      if (index.current + 1 < plan.clips.length) seek(offset + current.endMs - current.startMs);
      else { wantsPlay.current = false; element.pause(); setClock(plan.durationMs); }
    } else setClock(offset + Math.max(0, element.currentTime * 1000 - current.startMs));
  };
  React.useEffect(() => {
    let frame = 0;
    const step = () => { tick(); frame = requestAnimationFrame(step); };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [plan]);
  return <div data-structure-preview={plan.id} className="absolute inset-x-0 bottom-0 top-8 z-30 flex flex-col bg-[var(--dock-pane)] p-3 animate-in fade-in duration-150">
    <div className="mb-2 flex items-center gap-2 text-[12px]"><span className="flex-1">方案预览 · 原速 · 不改变下方草稿</span><button type="button" aria-label="关闭方案预览" onClick={onClose} className="rounded p-1 transition hover:bg-white/10 active:scale-95"><X size={16} /></button></div>
    <video ref={video} className="min-h-0 flex-1 bg-black object-contain" src={source ? `${folder}${source.split('/').map(encodeURIComponent).join('/')}` : undefined} preload="auto"
      onLoadedMetadata={() => seek(0, false)} onSeeked={() => { changing.current = false; if (wantsPlay.current) void video.current?.play().catch(e => setError(String(e))); }}
      onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={tick} onError={() => setError('原片暂时无法播放，请检查来源连接；方案和草稿已保留')} />
    {error && <p role="alert" className="text-[12px] text-[var(--warn)]">{error}</p>}
    <p className="mt-2 truncate text-[12px]" title={clip.assetPath}>{clip.roles.map(structureRole).join(' / ')} · {clip.assetPath} · 原片 {sourceTime(clip.startMs)}–{sourceTime(clip.endMs)}</p>
    <p className="mt-1 max-h-16 overflow-auto text-[12px] text-[var(--text-muted)]">{clip.text}</p>
    <div className="mt-2 flex items-center gap-2"><button type="button" aria-label={playing ? '暂停方案' : '播放方案'} className="rounded p-2 transition hover:bg-white/10 active:scale-95" onClick={() => {
      if (playing) { wantsPlay.current = false; video.current?.pause(); }
      else if (clock >= plan.durationMs) seek(0, true);
      else { wantsPlay.current = true; void video.current?.play().catch(e => setError(String(e))); }
    }}>{playing ? <Pause size={16} /> : <Play size={16} />}</button><input aria-label="方案播放位置" type="range" className="min-w-0 flex-1" min={0} max={plan.durationMs} step={20} value={clock} onChange={e => seek(Number(e.target.value))} /><span className="text-[11px]">{(clock / 1000).toFixed(1)} / {(plan.durationMs / 1000).toFixed(1)} 秒</span></div>
  </div>;
}
