import React from 'react';
import { app } from '../app-bridge';
import { combineUsage, summarizeUsage, type UsageSummary } from '../../../src/model-usage.mjs';
import { ChatProjectContext } from '@/lib/developer';
import { isPendingAssetId } from '@/lib/asset-lists';
import { usageText, usageDetail } from '@/lib/usage-text';
import { useT } from '@/i18n';
import { TurnLogButton } from './TurnLog';

const UsageContext = React.createContext<{ turns: Record<string, UsageSummary>; ids: string[] } | null>(null);

/** Fetch scalar receipts once on switching conversations; only the active turn is polled. */
export function ConversationUsageProvider({ turnIds, activeId, children }: { turnIds: string[]; activeId: string | null; children: React.ReactNode }) {
  const project = React.useContext(ChatProjectContext);
  const [state, setState] = React.useState<{ project: string | null; turns: Record<string, UsageSummary> }>({ project: null, turns: {} });
  const idsKey = turnIds.filter((id) => !isPendingAssetId(id)).join('\n');
  const ids = React.useMemo(() => idsKey ? idsKey.split('\n') : [], [idsKey]);
  React.useEffect(() => {
    if (!project || !app.chat.usage) return;
    let alive = true;
    let reading = false;
    const read = async (requested: string[]) => {
      if (reading || !requested.length) return;
      reading = true;
      try {
        const turns = await app.chat.usage!(project, requested);
        if (alive) setState((old) => ({ project, turns: { ...(old.project === project ? old.turns : {}), ...turns } }));
      } catch {
        if (alive) setState((old) => ({ project, turns: { ...(old.project === project ? old.turns : {}),
          ...Object.fromEntries(requested.map((id) => [id, summarizeUsage([])])) } }));
      } finally { reading = false; }
    };
    void read(ids);
    const running = activeId && ids.includes(activeId) ? activeId : null;
    const timer = running ? window.setInterval(() => void read([running]), 1500) : null;
    // External agents can flush their final receipt a few seconds after the turn ends.
    const finalRead = window.setTimeout(() => void read(running ? [running] : ids), 6000);
    return () => { alive = false; if (timer !== null) window.clearInterval(timer); window.clearTimeout(finalRead); };
  }, [project, idsKey, activeId]);
  const turns = state.project === project ? state.turns : {};
  const value = React.useMemo(() => project && app.chat.usage ? { turns, ids } : null, [project, turns, ids]);
  return <UsageContext.Provider value={value}>{children}</UsageContext.Provider>;
}

export function SessionUsageSummary() {
  const state = React.useContext(UsageContext);
  const t = useT();
  if (!state?.ids.length) return null;
  const loaded = state.ids.every((id) => state.turns[id]);
  const summary = combineUsage(state.ids.map((id) => state.turns[id] ?? summarizeUsage([])));
  return <div className="text-[11.5px] leading-relaxed tabular-nums text-[var(--chat-hint)]" title={usageDetail(summary, t)}>
    {t('usage.session')} · {loaded ? usageText(summary, t) : t('usage.loading')}
  </div>;
}

export function TurnUsageSummary({ turnId, live }: { turnId: string; live: boolean }) {
  const state = React.useContext(UsageContext);
  const project = React.useContext(ChatProjectContext);
  const t = useT();
  if (!state || !project || isPendingAssetId(turnId)) return null;
  const summary = state.turns[turnId];
  return <div className="text-[11.5px] leading-relaxed tabular-nums text-[var(--chat-hint)]" title={summary ? usageDetail(summary, t) : undefined}>
    <TurnLogButton project={project} turnId={turnId} live={live}
      label={<span>{t('usage.turn')} · {summary ? usageText(summary, t) : t('usage.loading')}</span>} />
  </div>;
}
