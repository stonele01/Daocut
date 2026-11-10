/** Skill discovery reuses the existing community entry point; example browsing is no longer offered. */
import React from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, X } from 'lucide-react';
import { useT } from '@/i18n';
import { studioHost, type CommunityItem } from '@/lib/host';
import { seenSkills, watchSkills, type SkillEntry } from '@/lib/project-sources';
import { SkillsLibrary } from './SkillsLibrary';

function SkillsGallery({ projectId, initial, onClose }: {
  projectId: string;
  initial?: CommunityItem;
  onClose: () => void;
}) {
  const t = useT();
  const [skills, setSkills] = React.useState<SkillEntry[]>(() => seenSkills(projectId) ?? []);
  const [opened, setOpened] = React.useState<SkillEntry | null>(null);
  const pending = React.useRef(initial?.kind === 'skill' ? initial.name : undefined);
  React.useEffect(() => watchSkills(projectId, setSkills), [projectId]);
  React.useEffect(() => {
    if (!pending.current) return;
    const skill = skills.find((item) => item.name === pending.current);
    if (skill) { pending.current = undefined; setOpened(skill); }
  }, [skills]);

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      if (opened) setOpened(null);
      else onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [opened, onClose]);

  /* A skill page opens at the top; Back restores the list's scroll position. */
  const scroller = React.useRef<HTMLDivElement>(null);
  const listTop = React.useRef(0);
  const wasOpen = React.useRef(false);
  React.useLayoutEffect(() => {
    const element = scroller.current;
    const open = opened != null;
    if (!element || open === wasOpen.current) return;
    if (open) { listTop.current = element.scrollTop; element.scrollTop = 0; }
    else element.scrollTop = listTop.current;
    wasOpen.current = open;
  }, [opened]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-col px-6 pb-4 pt-5">
        <div className="flex min-h-8 items-center gap-1">
          {opened ? (
            <button type="button" onClick={() => setOpened(null)} className="mr-auto flex h-8 items-center gap-1.5 rounded-lg pl-1 pr-2.5 text-[13.5px] font-medium text-[var(--text-muted)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text)] active:scale-[0.98]">
              <ArrowLeft size={16} strokeWidth={1.75} />{t('gallery.back')}
            </button>
          ) : <h1 className="mr-auto text-[17px] font-semibold tracking-[-0.01em] text-[var(--text)]">{t('gallery.skills')}</h1>}
          <button type="button" onClick={onClose} aria-label={t('project.close')}
            className="ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--text-faint)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text)] active:scale-[0.96]">
            <X size={16} strokeWidth={1.75} />
          </button>
        </div>
      </header>
      <div ref={scroller} className="min-h-0 min-w-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        <SkillsLibrary skills={skills} setSkills={setSkills} projectId={projectId} opened={opened}
          onOpen={setOpened} onBack={() => setOpened(null)}
          onTry={(skill) => { studioHost?.useSkill?.({ name: skill.name, description: skill.description, newConversation: true }); onClose(); }} />
      </div>
    </div>
  );
}

/** Keep the host's existing command and old reference links compatible; both now lead to skills only. */
export function ExamplesDialog({ projectId, open, onClose }: { projectId: string; open?: CommunityItem; onClose: () => void }) {
  const t = useT();
  return createPortal(
    <>
      <div className="fixed inset-0 z-[10040] bg-black/60" onMouseDown={onClose} />
      <div role="dialog" aria-modal="true" aria-label={t('gallery.skills')}
        className="fixed left-1/2 top-1/2 z-[10050] flex -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-[var(--border-strong)] bg-[var(--app-content-bg)] shadow-[0_24px_64px_rgba(0,0,0,0.35)]"
        style={{ width: 'min(1200px, calc(100vw - 64px))', height: 'min(800px, calc(100vh - 80px))' }}>
        <SkillsGallery projectId={projectId} initial={open} onClose={onClose} />
      </div>
    </>,
    document.body,
  );
}
