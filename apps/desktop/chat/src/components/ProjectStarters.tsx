'use client';

/**
 * The conversation column of an empty project, before anything has been said.
 *
 * Offers complete livestream-editing requests. One click puts a sentence in the composer, Enter starts it,
 * nothing to fill in. "Shuffle" shows another group of three editing requests.
 *
 * The line below says files can simply be added: not only photos and videos, but audio, slides, PDFs, sheets, any
 * file. That is the one other way in besides typing.
 */
import React from 'react';
import {
  ArrowUpRight, Layers, RefreshCw, Scissors, ShoppingBag, Sparkles, Upload, type LucideIcon,
} from 'lucide-react';
import { useT } from '@/i18n';
import { BrandLogo } from './BrandLogo';

/**
 * Three choices at a time, starting with single-source clips, same-product mixed edits, and trimming an edit.
 */
const GROUPS = [
  ['s1', 's2', 's3'],
  ['s4', 's5', 's6'],
] as const;

/**
 * A line icon before each sentence, so it is recognized at a glance before it is read.
 * Same color as the text, no backing: a signpost should not outshine the sentence.
 */
const ICONS: Record<string, LucideIcon> = {
  s1: Scissors, s2: Layers, s3: Scissors,
  s4: Sparkles, s5: Scissors, s6: ShoppingBag,
};

export function ProjectStarters({
  onPick,
  onAttach,
}: {
  /** Puts the sentence in the composer (unsent) and focuses it; Enter starts it. */
  onPick: (text: string) => void;
  onAttach: () => void;
}) {
  const t = useT();
  const [group, setGroup] = React.useState(0);
  return (
    <div className="mx-auto w-full max-w-[400px] py-2">
      <BrandLogo size={26} />
      <h2 className="mt-4 text-[20px] font-semibold tracking-[-0.02em] text-[var(--text)]">{t('starter.title')}</h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--text-muted)]">{t('starter.hint')}</p>

      <div className="mt-5 flex items-center justify-between">
        <span className="text-[12px] text-[var(--text-faint)]">{t('starter.tryLabel')}</span>
        <button
          type="button"
          onClick={() => setGroup((g) => (g + 1) % GROUPS.length)}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] text-[var(--text-muted)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
        >
          <RefreshCw size={11} />
          {t('starter.shuffle')}
        </button>
      </div>
      {/* Both groups stack in one grid cell, only the current one visible, so the height is always the tallest
          group's. Otherwise lines wrapping differently per group would change the height, and the centered title and
          "Shuffle" would jump out from under the pointer. */}
      <div className="mt-2 grid">
        {GROUPS.map((ids, gi) => {
          const on = gi === group;
          return (
            <ul
              key={on ? `on-${gi}` : gi}
              aria-hidden={!on}
              inert={!on}
              className={`col-start-1 row-start-1 flex flex-col gap-1.5 ${on ? '' : 'invisible'}`}
              style={on ? { animation: 'daocut-rise 0.2s ease-out both' } : undefined}
            >
              {ids.map((id) => {
                const text = t(`starter.${id}`);
                const Icon = ICONS[id]!;
                return (
                  <li key={id}>
                    <button
                      type="button"
                      onClick={() => onPick(text)}
                      className="group flex w-full items-center gap-2.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-left text-[13.5px] leading-snug text-[var(--text)] transition hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)]"
                    >
                      <Icon aria-hidden size={15} strokeWidth={1.8} className="shrink-0" />
                      <span className="min-w-0 flex-1">{text}</span>
                      <ArrowUpRight size={14} className="shrink-0 text-[var(--text-faint)] transition group-hover:text-[var(--text)]" />
                    </button>
                  </li>
                );
              })}
            </ul>
          );
        })}
      </div>

      <button
        type="button"
        onClick={onAttach}
        className="mt-4 inline-flex items-center gap-1.5 rounded-lg px-1 py-1 text-[12.5px] text-[var(--text-muted)] transition hover:text-[var(--text)]"
      >
        <Upload size={14} />
        {t('starter.attach')}
      </button>
    </div>
  );
}
