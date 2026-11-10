import React from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { useT, useUiLocale } from '@/i18n';
import { contextPercent, type AgentContext } from '@/lib/agent-context';
import { Popover } from './Popover';
import { Tooltip } from './Tooltip';

/** Compact display only: the underlying current-context count is not a billing receipt. */
function compactTokens(tokens: number, locale: string) {
  const divisor = tokens >= 1_000_000 ? 1_000_000 : tokens >= 1_000 ? 1_000 : 1;
  const suffix = divisor === 1_000_000 ? 'M' : divisor === 1_000 ? 'K' : '';
  return (tokens / divisor).toLocaleString(locale, { maximumFractionDigits: divisor === 1 ? 0 : 1 }) + suffix;
}

/** Shared by the hover preview and the keyboard/click popover. No category is inferred from the total. */
export function AgentContextDetails({ context }: { context: AgentContext | null }) {
  const t = useT();
  const locale = useUiLocale();
  const percent = contextPercent(context);
  const label = percent === null ? t('context.unknown') : t('context.used').replace('{percent}', String(percent));
  const breakdown = context?.breakdown;
  const categories = breakdown ? [
    { key: 'system', color: '#9ca3af', value: breakdown.system },
    { key: 'tools', color: '#a78bfa', value: breakdown.tools },
    { key: 'messages', color: '#4f8cff', value: breakdown.messages },
  ] : [];

  return <div className="w-[284px] max-w-[calc(100vw-40px)] p-3 text-[12px] font-normal text-[var(--text)]">
    <div className="flex items-center justify-between gap-3">
      <span className="font-medium">{label}</span>
      {context ? <span className="shrink-0 tabular-nums text-[var(--text-dim)]" title={t('context.tokens').replace('{used}', context.used.toLocaleString(locale)).replace('{size}', context.size.toLocaleString(locale))}>
        ~{compactTokens(context.used, locale)} / {compactTokens(context.size, locale)}
      </span> : null}
    </div>
    {context ? <div className="my-3 h-1 overflow-hidden rounded-full bg-[var(--fill-tsp)]" aria-hidden="true">
      <div className="h-full rounded-full bg-[#4f8cff] transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${Math.min(100, Math.max(0, percent ?? 0))}%` }} />
    </div> : null}
    {breakdown ? <dl className="space-y-2">
      {categories.map(({ key, color, value }) => <div key={key} className="flex items-center justify-between gap-6">
        <dt className="flex items-center gap-2 text-[var(--text-dim)]"><span aria-hidden="true" className="h-2 w-2 rounded-[2px]" style={{ background: color }} />{t(`context.${key}`)}</dt>
        <dd className="m-0 tabular-nums" title={`~${value.toLocaleString(locale)} Token`}>~{compactTokens(value, locale)}</dd>
      </div>)}
    </dl> : null}
    <p className={`m-0 text-[11px] leading-relaxed text-[var(--text-muted)] ${context ? 'mt-3' : 'mt-2'}`}>
      {t(breakdown ? 'context.estimateNote' : context ? 'context.totalOnly' : 'context.waiting')}
    </p>
  </div>;
}

/** The selected conversation's current context, separate from cumulative token/cost receipts. */
export function AgentContextIndicator({ context }: { context: AgentContext | null }) {
  const t = useT();
  const reduceMotion = useReducedMotion();
  const locale = useUiLocale();
  const [open, setOpen] = React.useState(false);
  const [visible, setVisible] = React.useState(false);
  const panelId = React.useId();
  const percent = contextPercent(context);
  const label = percent === null ? t('context.unknown') : t('context.used').replace('{percent}', String(percent));
  const detail = context ? t('context.tokens').replace('{used}', context.used.toLocaleString(locale)).replace('{size}', context.size.toLocaleString(locale)) : '';
  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (next) setVisible(true);
  };
  return <Popover open={visible} onOpenChange={changeOpen} placement="top" align="end" bare trigger={
    <Tooltip label={visible ? undefined : label} content={<AgentContextDetails context={context} />}>
    <motion.button type="button" initial={{ opacity: 0, y: reduceMotion ? 0 : 2 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: reduceMotion ? 0 : 2 }} transition={{ duration: reduceMotion ? 0 : 0.15 }} aria-label={detail ? label + ' · ' + detail : label}
      aria-expanded={open} aria-controls={visible ? panelId : undefined} aria-haspopup="dialog"
      className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-[11px] tabular-nums text-[var(--text-faint)] transition-[color,background-color,transform] duration-200 hover:scale-105 hover:bg-[var(--bg-hover)] hover:text-[var(--text)] active:scale-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4f8cff] motion-reduce:transform-none motion-reduce:transition-none">
      <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" className="shrink-0 -rotate-90">
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.22" />
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" pathLength="100"
          strokeDasharray="100" strokeDashoffset={100 - Math.min(100, Math.max(0, percent ?? 0))}
          className="transition-[stroke-dashoffset,opacity] duration-300 motion-reduce:transition-none" opacity={percent === null ? 0 : 1} />
      </svg>
      <span>{percent === null ? '—' : percent + '%'}</span>
    </motion.button>
    </Tooltip>
  }>
    <motion.div id={panelId} role="dialog" aria-label={t('context.details')} initial={{ opacity: 0, y: reduceMotion ? 0 : 4 }} animate={{ opacity: open ? 1 : 0, y: open || reduceMotion ? 0 : 4 }}
      transition={{ duration: reduceMotion ? 0 : 0.12 }} onAnimationComplete={() => { if (!open) setVisible(false); }}
      className="rounded-xl border border-[var(--border-strong)] bg-[var(--tooltip-bg)] shadow-[var(--shadow-lg)]">
      <AgentContextDetails context={context} />
    </motion.div>
  </Popover>;
}
