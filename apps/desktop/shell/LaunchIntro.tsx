import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { animate } from 'motion/mini';
import { studioHost } from 'daocut/studio-ui/lib/host.ts';
import daotianMark from '../../../assets/brand/daotian-mark.svg?url';
import './launch-intro.css';

// Shared across StrictMode's effect replay. Main grants this to just one view per app launch.
let coldStartClaim: Promise<boolean> | null = null;
let coldStartConsumed = false;
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Cosmetic only: Studio, sign-in and chat initialize underneath without awaiting this animation. */
export function LaunchIntro({ preview = false }: { preview?: boolean }) {
  const launch = studioHost?.launch;
  const eligible = preview || Boolean(launch?.introEligible && !coldStartConsumed);
  const [visible, setVisible] = useState(() => eligible && !reducedMotion());
  const [ready, setReady] = useState(preview);
  const surface = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (preview || !eligible || !launch) return;
    let alive = true;
    coldStartClaim ??= launch.claimIntro().catch(() => false);
    void coldStartClaim.then((granted) => {
      if (!alive) return;
      coldStartConsumed = true;
      if (!granted || reducedMotion()) setVisible(false);
      else setReady(true);
    });
    return () => { alive = false; };
    // Eligibility is captured on mount; a later native project tab cannot acquire it.
  }, [preview, launch]);

  useLayoutEffect(() => {
    if (!visible || !ready || !surface.current) return;
    const element = surface.current;
    const mark = element.querySelector<HTMLElement>('.launch-intro__mark')!;
    const word = element.querySelector<HTMLElement>('.launch-intro__word')!;
    const identity = element.querySelector<HTMLElement>('.launch-intro__identity')!;
    const rule = element.querySelector<HTMLElement>('.launch-intro__rule')!;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    let active = true;
    const finish = () => { if (active) setVisible(false); };
    if (media.matches) { finish(); return; }
    // Mini uses the native Web Animations API. Full transform values keep this on its small API.
    const controls = [
      animate(mark, { opacity: [0, 1], transform: ['translateY(8px) scale(0.97)', 'translateY(0px) scale(1)'] },
        { duration: 0.5, ease: [0.22, 1, 0.36, 1] }),
      animate(word, { opacity: [0, 1], transform: ['translateY(8px)', 'translateY(0px)'] },
        { duration: 0.5, delay: 0.06, ease: [0.22, 1, 0.36, 1] }),
      animate(rule, { opacity: [0, 0.8], transform: ['scaleX(0.3)', 'scaleX(1)'] },
        { duration: 0.58, delay: 0.12, ease: [0.22, 1, 0.36, 1] }),
      animate(identity, { opacity: [1, 0], transform: ['translateY(0px) scale(1)', 'translateY(-3px) scale(0.99)'] },
        { duration: 0.24, delay: 0.9, ease: 'easeInOut' }),
      animate(element, { opacity: [1, 0] }, { duration: 0.3, delay: 1.02, ease: 'easeInOut' }),
    ];
    void controls[4].then(finish);
    const preferenceChanged = () => { if (media.matches) finish(); };
    media.addEventListener('change', preferenceChanged);
    // A person's first interaction can reveal the already-running app immediately.
    window.addEventListener('pointerdown', finish, { once: true });
    window.addEventListener('keydown', finish, { once: true });
    return () => {
      active = false;
      window.removeEventListener('pointerdown', finish);
      window.removeEventListener('keydown', finish);
      media.removeEventListener('change', preferenceChanged);
      controls.forEach((control) => control.stop());
    };
  }, [visible, ready]);

  if (!visible) return null;
  return createPortal(
    <div ref={surface} className="launch-intro" aria-hidden="true" data-launch-intro>
      <div className="launch-intro__identity">
        <img className="launch-intro__mark" src={daotianMark} width="48" height="56" alt="" draggable={false} />
        <span className="launch-intro__word">Daocut</span>
        <span className="launch-intro__rule" />
      </div>
    </div>,
    document.body,
  );
}
