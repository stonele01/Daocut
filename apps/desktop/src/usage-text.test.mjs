import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeUsage, combineUsage, emptyUsage } from './model-usage.mjs';
import { usageText, usageDetail } from '../chat/src/lib/usage-text.ts';
import { enUS } from '../chat/src/i18n/locales/en-US.ts';
import { zhCN } from '../chat/src/i18n/locales/zh-CN.ts';
import { ja } from '../chat/src/i18n/locales/ja.ts';
import { ko } from '../chat/src/i18n/locales/ko.ts';
import { es } from '../chat/src/i18n/locales/es.ts';

const get = (table, path) => path.split('.').reduce((value, key) => value?.[key], table);
const translate = (table) => (path) => get(table, path) ?? get(enUS, path) ?? path;
const pricing = { currency: 'CNY', input: 2, output: 8, cacheRead: 0.2 };
const call = (price = pricing, usage = { input: 100, output: 50, cacheRead: 900, cacheWrite: 0 }) => ({ kind: 'call', answer: { usage }, pricing: price });

for (const [language, table] of Object.entries({ en: enUS, 'zh-CN': zhCN, ja, ko, es })) {
  test(language + ': no price, partial price or missing usage shows tokens without any cost claim', () => {
    const t = translate(table);
    for (const summary of [
      summarizeUsage([call(null)]),
      summarizeUsage([call(), call(null)]),
      summarizeUsage([call(), call(pricing, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })]),
      summarizeUsage([call({ currency: 'CNY', input: 2, output: 8 })]),
      summarizeUsage([call(pricing, { input: 100, output: 50 })]),
    ]) {
      const text = usageText(summary, t);
      assert.ok(text.includes(String(summary.total.toLocaleString())), 'known token count remains');
      assert.ok(!text.includes(t('usage.costUnknown')), 'no unknown cost label');
      assert.ok(!text.includes(t('usage.costPartial')), 'no partial amount label');
      assert.ok(!text.includes('CNY') && !text.includes('USD'), 'no partial or invented amount');
      assert.equal(text.includes(t('usage.partial')), summary.missing > 0, 'usage completeness remains visible');
    }
  });
}

test('fully priced turns and conversations show their complete estimates, with currencies kept separate', () => {
  const t = translate(zhCN);
  const one = summarizeUsage([call()]);
  assert.match(usageText(one, t), /估算 CNY 0.00078/);
  const usd = summarizeUsage([call({ ...pricing, currency: 'USD' })]);
  assert.ok(usageText(combineUsage([one, usd]), t).endsWith('估算 CNY 0.00078 + USD 0.00078'));
  assert.ok(!usageText(combineUsage([one, summarizeUsage([call(null)])]), t).includes('估算'), 'incomplete conversation hides the aggregate amount');
});

test('explicit zero rates still show a measured zero estimate; empty receipts do not claim a cost', () => {
  const t = translate(zhCN);
  const free = summarizeUsage([call({ currency: 'CNY', input: 0, output: 0, cacheRead: 0 })]);
  assert.match(usageText(free, t), /估算 CNY 0/);
  assert.equal(usageText(summarizeUsage([]), t), t('usage.unreported'));
});

test('detailed token receipts stay available even when the cost is hidden', () => {
  const summary = summarizeUsage([call(null)]);
  const detail = usageDetail(summary, translate(zhCN));
  assert.match(detail, /1 次调用/);
  assert.match(detail, /1,000/);
  assert.match(detail, /缓存读取 900/);
  assert.match(detail, /输出 50/);
});


test('known local zero-request operations say no model request and preserve complete conversation costs', () => {
  const noRequest = emptyUsage();
  for (const table of [enUS, zhCN]) {
    const t = translate(table);
    assert.equal(usageText(noRequest, t), t('usage.noCalls'));
    assert.ok(usageDetail(noRequest, t).startsWith(t('usage.noCalls')));
    assert.ok(!usageText(noRequest, t).includes('0'), 'no invented zero cost or token receipt');
    assert.equal(usageText(summarizeUsage([]), t), t('usage.unreported'), 'an absent receipt remains unknown');
    assert.ok(usageDetail(summarizeUsage([]), t).startsWith(t('usage.unreported')));
    const paid = summarizeUsage([call()]);
    assert.equal(usageText(combineUsage([paid, noRequest]), t), usageText(paid, t));
  }
});
