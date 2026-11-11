import * as React from 'react';
import { Play, Pause, X } from 'lucide-react';
import { previewClipDuration, previewClipOffset, previewPosition, structureClipSpeed, structureRole, structureSpeedLabel, type StructurePlan } from '@/lib/structure-workspace';
import { sourceTime } from '@/lib/product-analysis';
import { isTypingTarget } from './typing-target';

/** A read-only sequence player. It never writes film.html or enters the editing undo stack. */
export function StructurePlanPreview({ plan, folder, seekRequest, onClose }: { plan: StructurePlan; folder: string; seekRequest: { clipIndex: number; requestId: number }; onClose: () => void }) {
  const video = React.useRef<HTMLVideoElement>(null);
  const requestedTime = previewClipOffset(plan, seekRequest.clipIndex);
  const index = React.useRef(seekRequest.clipIndex), changing = React.useRef(false), wantsPlay = React.useRef(false);
  const [clock, setClock] = React.useState(requestedTime), [playing, setPlaying] = React.useState(false), [error, setError] = React.useState('');
  const clip = plan.clips[previewPosition(plan, clock).index]!;
  const source = plan.clips[0]?.assetPath;
  const seek = (ms: number, play = wantsPlay.current) => {
    const element = video.current; if (!element) return;
    const next = previewPosition(plan, ms); index.current = next.index; changing.current = true;
    wantsPlay.current = play; element.pause(); element.playbackRate = structureClipSpeed(plan, plan.clips[next.index]!); element.currentTime = next.sourceMs / 1000; setClock(ms);
  };
  const tick = () => {
    const element = video.current; if (!element || element.readyState < 1 || changing.current) return;
    const current = plan.clips[index.current]!;
    const offset = previewClipOffset(plan, index.current);
    if (element.currentTime * 1000 >= current.endMs - 15) {
      if (index.current + 1 < plan.clips.length) seek(offset + previewClipDuration(plan, current));
      else { wantsPlay.current = false; element.pause(); setClock(plan.durationMs); }
    } else setClock(offset + Math.max(0, element.currentTime * 1000 - current.startMs) / structureClipSpeed(plan, current));
  };
  // A card click uses sequence time; seek restores the matching original-source time.
  // Repeated clicks also seek, while metadata loading applies the latest request below.
  React.useEffect(() => {
    if (video.current && video.current.readyState >= 1) seek(requestedTime, false);
  }, [seekRequest.requestId, requestedTime]);
  const toggle = () => {
    if (wantsPlay.current) { wantsPlay.current = false; video.current?.pause(); }
    else if (clock >= plan.durationMs) seek(0, true);
    else { wantsPlay.current = true; void video.current?.play().catch(e => setError(String(e))); }
  };
  const keyHandler = React.useRef<(event: KeyboardEvent) => void>(() => {});
  keyHandler.current = event => {
    if (event.defaultPrevented || isTypingTarget(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target instanceof Element && event.target.closest('[role="dialog"], [role="menu"], [role="listbox"]')) return;
    if (event.key !== ' ') return;
    // Focused controls keep their native Space activation (close, edit, select).
    if (event.target instanceof Element && event.target.closest('button, a, input[type="checkbox"], input[type="radio"], [role="button"], [role="checkbox"], [role="radio"]')) return;
    event.preventDefault(); event.stopPropagation();
    if (event.repeat) return;
    toggle();
  };
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => keyHandler.current(event);
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  React.useEffect(() => {
    let frame = 0;
    const step = () => { tick(); frame = requestAnimationFrame(step); };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [plan]);
  return <div data-structure-preview={plan.id} className="absolute inset-x-0 bottom-0 top-8 z-30 flex flex-col bg-[var(--dock-pane)] p-3 animate-in fade-in duration-150">
    <div className="mb-2 flex items-center gap-2 text-[12px]"><span className="flex-1">方案预览 · {structureSpeedLabel(plan)} · 不改变下方草稿</span><button type="button" aria-label="关闭方案预览" onClick={onClose} className="rounded p-1 transition hover:bg-white/10 active:scale-95"><X size={16} /></button></div>
    <video ref={video} tabIndex={0} className="min-h-0 flex-1 bg-black object-contain" src={source ? `${folder}${source.split('/').map(encodeURIComponent).join('/')}` : undefined} preload="auto"
      onLoadedMetadata={() => seek(requestedTime, false)} onSeeked={() => { changing.current = false; if (wantsPlay.current) void video.current?.play().catch(e => setError(String(e))); }}
      onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={tick} onError={() => setError('原片暂时无法播放，请检查来源连接；方案和草稿已保留')} />
    {error && <p role="alert" className="text-[12px] text-[var(--warn)]">{error}</p>}
    <p className="mt-2 truncate text-[12px]" title={clip.assetPath}>{clip.roles.map(structureRole).join(' / ')} · {clip.assetPath} · 原片 {sourceTime(clip.startMs)}–{sourceTime(clip.endMs)}</p>
    <p className="mt-1 max-h-16 overflow-auto text-[12px] text-[var(--text-muted)]">{clip.text}</p>
    <div className="mt-2 flex items-center gap-2"><button type="button" aria-label={playing ? '暂停方案' : '播放方案'} className="rounded p-2 transition hover:bg-white/10 active:scale-95" onClick={toggle}>{playing ? <Pause size={16} /> : <Play size={16} />}</button><input aria-label="方案播放位置" type="range" className="min-w-0 flex-1" min={0} max={plan.durationMs} step="any" value={clock} onChange={e => seek(Number(e.target.value))} /><span className="text-[11px]">{(clock / 1000).toFixed(1)} / {(plan.durationMs / 1000).toFixed(1)} 秒</span></div>
  </div>;
}
