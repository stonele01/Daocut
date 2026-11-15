import * as React from 'react';
import { Play, Pause, X } from 'lucide-react';
import { previewClipOffset, previewPosition, structureClipSpeed, structureRole, structureSpeedLabel, type StructurePlan } from '@/lib/structure-workspace';
import { sourceTime } from '@/lib/product-analysis';
import { isTypingTarget } from './typing-target';

/** Two source decoders: prepare the next cut while the current one plays. No draft writes. */
export function StructurePlanPreview({ plan, folder, mediaVersion = 0, seekRequest, onClose }: { plan: StructurePlan; folder: string; mediaVersion?: number; seekRequest: { clipIndex: number; requestId: number }; onClose: () => void }) {
  const videos = React.useRef<Array<HTMLVideoElement | null>>([]);
  const control = React.useRef<{ seek: (ms: number, play?: boolean) => void; toggle: () => void; reload: () => void } | null>(null);
  const version = React.useRef(mediaVersion);
  const [clock, setClock] = React.useState(0), [playing, setPlaying] = React.useState(false), [waiting, setWaiting] = React.useState(false), [active, setActive] = React.useState(0), [error, setError] = React.useState('');
  const clip = plan.clips[previewPosition(plan, clock).index]!;
  React.useEffect(() => {
    // Ref callbacks are cleared before effect cleanup during unmount; retain the actual nodes.
    const elements = videos.current.slice() as HTMLVideoElement[];
    const prepared: Array<{ index: number; target: number; src: string; sought: boolean } | null> = [null, null];
    let slot = 0, index = 0, wantsPlay = false, pending: { slot: number; ms: number } | null = null;
    let stopped = false, starting = false, frame = 0, published = 0, position = 0;
    const start = () => {
      const video = elements[slot];
      if (!wantsPlay || pending || !video.paused || starting) return;
      starting = true;
      void video.play().catch(e => { if (!stopped && e.name !== 'AbortError') { wantsPlay = false; setPlaying(false); setError(String(e)); } }).finally(() => { starting = false; });
    };
    const prepare = (at: number, clipIndex: number, target = plan.clips[clipIndex]!.startMs / 1000) => {
      const video = elements[at], next = plan.clips[clipIndex]!;
      video.pause(); video.muted = true;
      const url = new URL(folder + (next.assetPath ?? '').split('/').map(encodeURIComponent).join('/'), window.location.href);
      if (version.current) url.searchParams.set('preview', String(version.current));
      const src = url.href;
      prepared[at] = { index: clipIndex, target, src, sought: false };
      if (video.src !== src) video.src = src;
      video.playbackRate = structureClipSpeed(plan, next);
    };
    const ready = (at: number) => {
      const video = elements[at], info = prepared[at];
      if (!info || video.currentSrc !== info.src || video.readyState < 1 || video.seeking) return false;
      if (!info.sought) {
        info.sought = true;
        if (Math.abs(video.currentTime - info.target) > 0.01) { video.currentTime = info.target; return false; }
      }
      return !video.seeking && video.readyState >= 2;
    };
    const activate = () => {
      if (!pending || !ready(pending.slot)) return;
      elements[slot].pause(); elements[slot].muted = true;
      slot = pending.slot; index = prepared[slot]!.index; position = pending.ms; pending = null;
      elements[slot].muted = false;
      elements[slot].playbackRate = structureClipSpeed(plan, plan.clips[index]!);
      setActive(slot); setClock(position); setWaiting(false);
      if (index + 1 < plan.clips.length) prepare(1 - slot, index + 1);
      start();
    };
    const seek = (ms: number, play = wantsPlay) => {
      const next = previewPosition(plan, ms);
      wantsPlay = play; position = ms;
      elements.forEach(video => { video.pause(); video.muted = true; });
      prepare(slot, next.index, next.sourceMs / 1000);
      pending = { slot, ms }; setClock(ms); setPlaying(play); setWaiting(true); setError('');
      activate();
    };
    const toggle = () => {
      if (wantsPlay) { wantsPlay = false; elements.forEach(video => video.pause()); setPlaying(false); }
      else if (position >= plan.durationMs) seek(0, true);
      else { wantsPlay = true; setPlaying(true); start(); }
    };
    control.current = { seek, toggle, reload: () => seek(position, wantsPlay) };
    const update = (now: number) => {
      if (stopped) return;
      if (pending) activate();
      else if (wantsPlay) {
        const video = elements[slot], current = plan.clips[index]!;
        if (video.currentTime * 1000 >= current.endMs - 15 || video.ended) {
          video.pause(); video.muted = true;
          if (index + 1 < plan.clips.length) {
            pending = { slot: 1 - slot, ms: previewClipOffset(plan, index + 1) };
            setWaiting(true); activate();
          } else { wantsPlay = false; position = plan.durationMs; setPlaying(false); setClock(position); }
        } else {
          position = previewClipOffset(plan, index) + Math.max(0, video.currentTime * 1000 - current.startMs) / structureClipSpeed(plan, current);
          if (now - published >= 100) { published = now; setClock(position); }
          start();
        }
      }
      if (!pending && index + 1 < plan.clips.length) ready(1 - slot);
    };
    const tick = (now: number) => { update(now); frame = requestAnimationFrame(tick); };
    // Background windows throttle animation frames; timeupdate still prevents playing beyond a cut.
    const onTimeUpdate = () => update(performance.now());
    elements.forEach(video => video.addEventListener('timeupdate', onTimeUpdate));
    frame = requestAnimationFrame(tick);
    return () => { stopped = true; cancelAnimationFrame(frame); control.current = null; elements.forEach(video => { video.removeEventListener('timeupdate', onTimeUpdate); video.pause(); video.removeAttribute('src'); video.load(); }); };
  }, [plan, folder]);
  React.useEffect(() => { if (version.current !== mediaVersion) { version.current = mediaVersion; control.current?.reload(); } }, [mediaVersion]);
  React.useEffect(() => { control.current?.seek(previewClipOffset(plan, seekRequest.clipIndex), false); }, [plan, folder, seekRequest.requestId, seekRequest.clipIndex]);
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isTypingTarget(event.target) || event.ctrlKey || event.metaKey || event.altKey || event.key !== ' ') return;
      if (event.target instanceof Element && event.target.closest('[role="dialog"], [role="menu"], [role="listbox"], button, a, input, [role="button"], [role="checkbox"], [role="radio"]')) return;
      event.preventDefault(); event.stopPropagation();
      if (!event.repeat) control.current?.toggle();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  return <div data-structure-preview={plan.id} className="absolute inset-x-0 bottom-0 top-8 z-30 flex flex-col bg-[var(--dock-pane)] p-3 animate-in fade-in duration-150">
    <div className="mb-2 flex items-center gap-2 text-[12px]"><span className="flex-1">方案预览 · {structureSpeedLabel(plan)} · 不改变下方草稿</span><button type="button" aria-label="关闭方案预览" onClick={onClose} className="rounded p-1 transition hover:bg-white/10 active:scale-95"><X size={16} /></button></div>
    <div className="relative min-h-0 flex-1">
      {[0, 1].map(at => <video key={at} ref={element => { videos.current[at] = element; }} data-plan-slot={at} aria-hidden={active !== at} tabIndex={-1} playsInline preload="auto" className="absolute inset-0 h-full w-full object-contain" style={{ visibility: active === at ? 'visible' : 'hidden' }} onError={() => setError('原片暂时无法播放，请检查来源连接；方案和草稿已保留')} />)}
    </div>
    {waiting && <p role="status" className="text-[12px] text-[var(--text-muted)]">正在准备片段…</p>}
    {error && <p role="alert" className="text-[12px] text-[var(--warn)]">{error}</p>}
    <p className="mt-2 truncate text-[12px]" title={clip.assetPath}>{clip.roles.map(structureRole).join(' / ')} · {clip.assetPath} · 原片 {sourceTime(clip.startMs)}–{sourceTime(clip.endMs)}</p>
    <p className="mt-1 max-h-16 overflow-auto text-[12px] text-[var(--text-muted)]">{clip.text}</p>
    <div className="mt-2 flex items-center gap-2"><button type="button" aria-label={playing ? '暂停方案' : '播放方案'} className="rounded p-2 transition hover:bg-white/10 active:scale-95" onClick={() => control.current?.toggle()}>{playing ? <Pause size={16} /> : <Play size={16} />}</button><input aria-label="方案播放位置" type="range" className="min-w-0 flex-1" min={0} max={plan.durationMs} step="any" value={clock} onChange={e => control.current?.seek(Number(e.target.value))} /><span className="text-[11px]">{(clock / 1000).toFixed(1)} / {(plan.durationMs / 1000).toFixed(1)} 秒</span></div>
  </div>;
}
