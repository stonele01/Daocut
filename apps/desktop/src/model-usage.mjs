/** Token receipts and fixed-rate estimates from model logs. Never infer a price from SDK zero defaults. */
/** @typedef {{ currency: string, input: number, output: number, cacheRead?: number, cacheWrite?: number, cacheWrite1h?: number }} ModelPricing */
/** @typedef {{ calls: number, reported: number, missing: number, input: number, output: number, cacheRead: number, cacheWrite: number, reasoning: number, total: number, unknownCacheRead: number, unknownCacheWrite: number, costs: Record<string, number>, unpriced: number }} UsageSummary */
const count = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/** A detached price snapshot; prices are currency units per million tokens. Missing cache prices stay unknown. */
export function modelPricing(value) {
  if (!value || typeof value !== 'object' || !/^[A-Z]{3}$/.test(value.currency ?? '')) return null;
  if (count(value.input) === null || count(value.output) === null) return null;
  /** @type {ModelPricing} */
  const pricing = { currency: value.currency, input: value.input, output: value.output };
  for (const key of ['cacheRead', 'cacheWrite', 'cacheWrite1h']) {
    if (value[key] == null) continue;
    if (count(value[key]) === null) return null;
    pricing[key] = value[key];
  }
  return pricing;
}

/** SDKs and old adapters default absent receipts to all zero: those are unknown, not free requests. */
export function reportedUsage(answer) {
  const u = answer?.usage;
  if (!u || count(u.input) === null || count(u.output) === null) return null;
  const input = u.input;
  const output = u.output;
  const unknownCacheRead = count(u.cacheRead) === null;
  const unknownCacheWrite = count(u.cacheWrite) === null;
  const cacheRead = count(u.cacheRead) ?? 0;
  const cacheWrite = count(u.cacheWrite) ?? 0;
  const total = input + output + cacheRead + cacheWrite;
  if (total === 0) return null;
  return { input, output, cacheRead, cacheWrite, unknownCacheRead, unknownCacheWrite, incomplete: unknownCacheRead || unknownCacheWrite, cacheWrite1h: Math.min(cacheWrite, count(u.cacheWrite1h) ?? 0), reasoning: count(u.reasoning) ?? 0, total };
}

/** Fixed rates only. A used cache category with no price makes this request's estimate unknown. */
export function estimateUsage(usage, snapshot) {
  const pricing = modelPricing(snapshot);
  if (!usage || usage.incomplete || !pricing) return null;
  let amount = 0;
  const parts = { input: usage.input, output: usage.output, cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite - (usage.cacheWrite1h ?? 0), cacheWrite1h: usage.cacheWrite1h ?? 0 };
  for (const [key, tokens] of Object.entries(parts)) {
    if (!tokens) continue;
    if (count(pricing[key]) === null) return null;
    amount += tokens * pricing[key] / 1_000_000;
  }
  return { currency: pricing.currency, amount };
}

/** @returns {UsageSummary} */
export function emptyUsage() {
  return { calls: 0, reported: 0, missing: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, unknownCacheRead: 0, unknownCacheWrite: 0, costs: {}, unpriced: 0 };
}

/** One receipt per request, including retries, failures and cancellations. Message context is never counted again. */
export function summarizeUsage(calls = []) {
  const summary = emptyUsage();
  for (const call of calls) {
    if (call?.kind && call.kind !== 'call') continue;
    summary.calls += 1;
    const usage = reportedUsage(call?.answer);
    if (!usage) { summary.missing += 1; summary.unpriced += 1; summary.unknownCacheRead += 1; summary.unknownCacheWrite += 1; continue; }
    summary.reported += 1;
    if (usage.incomplete) summary.missing += 1;
    if (usage.unknownCacheRead) summary.unknownCacheRead += 1;
    if (usage.unknownCacheWrite) summary.unknownCacheWrite += 1;
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'total']) summary[key] += usage[key];
    const cost = estimateUsage(usage, call.pricing);
    if (!cost) summary.unpriced += 1;
    else summary.costs[cost.currency] = (summary.costs[cost.currency] ?? 0) + cost.amount;
  }
  // A missing log or a log with no receipts is unreported, not a measured zero.
  if (!summary.calls) { summary.missing = 1; summary.unpriced = 1; summary.unknownCacheRead = 1; summary.unknownCacheWrite = 1; }
  return summary;
}

/** @param {UsageSummary[]} summaries @returns {UsageSummary} */
export function combineUsage(summaries) {
  const total = emptyUsage();
  for (const summary of summaries) {
    for (const key of ['calls', 'reported', 'missing', 'input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'total', 'unknownCacheRead', 'unknownCacheWrite', 'unpriced']) total[key] += summary[key];
    for (const [currency, amount] of Object.entries(summary.costs)) total.costs[currency] = (total.costs[currency] ?? 0) + amount;
  }
  return total;
}
