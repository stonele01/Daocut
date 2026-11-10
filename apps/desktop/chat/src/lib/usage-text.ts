import type { UsageSummary } from '../../../src/model-usage.mjs';

type T = (key: string) => string;
const fill = (text: string, values: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
const number = (value: number) => value.toLocaleString();
const money = (value: number) => value > 0 && value < 0.000001 ? '<0.000001' : value.toLocaleString(undefined, { maximumFractionDigits: 6 });

export function usageText(summary: UsageSummary, t: T): string {
  if (summary.calls === 0 && summary.missing === 0) return t('usage.noCalls');
  const tokens = summary.reported ? fill(t('usage.tokens'), { n: number(summary.total) }) : t('usage.unreported');
  // Show a cost only when every recorded call has complete usage and a usable price snapshot.
  // A partially priced amount is not this turn/conversation's total; keep its token report only.
  const costs = summary.unpriced === 0 && summary.missing === 0
    ? Object.entries(summary.costs).map(([currency, amount]) => `${currency} ${money(amount)}`).join(' + ') : '';
  return [tokens, summary.reported && summary.missing ? t('usage.partial') : null,
    costs ? fill(t('usage.estimate'), { amount: costs }) : null].filter(Boolean).join(' · ');
}

export function usageDetail(summary: UsageSummary, t: T): string {
  if (!summary.reported) return [t(summary.calls === 0 && summary.missing === 0 ? 'usage.noCalls' : 'usage.unreported'), t('usage.note')].join('\n');
  const known = (value: number, unknown: number) => unknown ? (value > 0 ? `≥${number(value)}` : t('usage.unreported')) : number(value);
  return [fill(t('usage.detail'), { input: number(summary.input + summary.cacheRead + summary.cacheWrite), output: number(summary.output),
    cached: known(summary.cacheRead, summary.unknownCacheRead), written: known(summary.cacheWrite, summary.unknownCacheWrite), calls: summary.calls }), t('usage.note')].join('\n');
}
