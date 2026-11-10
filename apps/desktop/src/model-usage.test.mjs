import { test } from 'node:test';
import assert from 'node:assert/strict';
import { combineUsage, estimateUsage, modelPricing, reportedUsage, summarizeUsage } from './model-usage.mjs';

const pricing = { currency: 'USD', input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2.5 };
const call = (usage, extra = {}) => ({ kind: 'call', answer: { usage }, pricing, ...extra });

test('cache categories and reasoning are counted once; reasoning is already in output', () => {
  const result = summarizeUsage([call({ input: 100, cacheRead: 900, cacheWrite: 20, output: 50, reasoning: 30, totalTokens: 1070 })]);
  assert.equal(result.total, 1070);
  assert.equal(result.input, 100);
  assert.equal(result.reasoning, 30);
  assert.ok(Math.abs(result.costs.USD - 0.00083) < 1e-12);
  assert.equal(result.missing, 0);
});

test('missing and SDK default-zero receipts are unknown; SDK cost zero never implies free', () => {
  for (const usage of [undefined, {}, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }]) {
    const result = summarizeUsage([call(usage)]);
    assert.equal(result.reported, 0);
    assert.equal(result.missing, 1);
    assert.equal(result.unpriced, 1);
    assert.deepEqual(result.costs, {});
  }
  const measured = summarizeUsage([call({ input: 12, output: 8, cost: { total: 0 } }, { pricing: null })]);
  assert.equal(measured.total, 20);
  assert.equal(measured.unpriced, 1);
  assert.deepEqual(measured.costs, {});
  assert.equal(summarizeUsage([]).missing, 1);
  assert.equal(combineUsage([measured, summarizeUsage([])]).unknownCacheRead, 2, 'a missing turn cannot make its cache look measured');
});

test('reported failed and cancelled attempts count, missing attempts make a partial total; transport events do not count as calls', () => {
  const result = summarizeUsage([
    call(null), call(null, { answer: { stopReason: 'error', usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 } } }),
    { kind: 'network_error', message: 'synthetic transport error' },
    call(null, { answer: { stopReason: 'aborted', usage: { input: 20, output: 3, cacheRead: 0, cacheWrite: 0 } } }),
  ]);
  assert.deepEqual([result.calls, result.reported, result.missing, result.total], [3, 2, 1, 35]);
  assert.equal(result.unpriced, 1);
  assert.ok(result.costs.USD > 0);
});

test('missing cache rates are unknown only when that cache is used, including 1h writes', () => {
  const base = { currency: 'CNY', input: 1, output: 3 };
  const usage = reportedUsage({ usage: { input: 1, output: 1, cacheRead: 2, cacheWrite: 0 } });
  assert.equal(estimateUsage(usage, base), null);
  assert.ok(estimateUsage(reportedUsage({ usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }), base));
  const long = reportedUsage({ usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 5, cacheWrite1h: 3 } });
  assert.equal(estimateUsage(long, { ...base, cacheWrite: 2 }), null);
  assert.ok(Math.abs(estimateUsage(long, { ...base, cacheWrite: 2, cacheWrite1h: 4 }).amount - 0.000029) < 1e-12);
});

test('price snapshots detach from settings, historical rates stay fixed, and currencies never get combined', () => {
  const settings = { ...pricing };
  const snapshot = modelPricing(settings);
  settings.input = 200;
  const old = summarizeUsage([call({ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, { pricing: snapshot })]);
  const recent = summarizeUsage([call({ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, { pricing: modelPricing(settings) })]);
  const cny = summarizeUsage([call({ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, { pricing: { currency: 'CNY', input: 7, output: 0 } })]);
  assert.deepEqual(combineUsage([old, recent, cny]).costs, { USD: 202, CNY: 7 });
  assert.equal(old.costs.USD, 2);
});

test('actually omitted cache fields preserve partial reporting and never yield a complete estimate', () => {
  const result = summarizeUsage([call({ input: 50, output: 20 })]);
  assert.equal(result.total, 70, 'only known tokens');
  assert.deepEqual([result.reported, result.missing, result.unknownCacheRead, result.unknownCacheWrite], [1, 1, 1, 1]);
  assert.equal(result.unpriced, 1);
  assert.deepEqual(result.costs, {});
});

test('explicit zero prices are valid, invalid numbers are refused, and unset cache rates stay absent', () => {
  assert.deepEqual(modelPricing({ currency: 'USD', input: 0, output: 0 }), { currency: 'USD', input: 0, output: 0 });
  assert.deepEqual(summarizeUsage([call({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, { pricing: { currency: 'USD', input: 0, output: 0 } })]).costs, { USD: 0 });
  for (const input of [-1, NaN, Infinity, '2']) assert.equal(modelPricing({ currency: 'USD', input, output: 1 }), null);
  assert.equal(modelPricing({ currency: 'USD', input: 1, output: 1, cacheRead: -1 }), null);
});
