import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outputTokenLimit } from '../../../../../../apps/desktop/src/pi-config.mjs';
import { parseContextLength, parseMaxOutputTokens } from './context-length.ts';

test('a context length as typed: empty is none, a whole number from 32K to 10M holds, anything else does not', () => {
  assert.deepEqual(parseContextLength(''), {});
  assert.deepEqual(parseContextLength('  '), {});
  assert.deepEqual(parseContextLength('200000'), { context: 200_000 });
  assert.deepEqual(parseContextLength(' 1,000,000 '), { context: 1_000_000 }, 'thousands separators');
  assert.deepEqual(parseContextLength('128.000'), { context: 128_000 }, 'a thousands point');
  assert.deepEqual(parseContextLength('32000'), { context: 32_000 });
  assert.deepEqual(parseContextLength('10000000'), { context: 10_000_000 });
  assert.deepEqual(parseContextLength('200 000'), { context: 200_000 });
  for (const bad of ['31999', '4000', '10000001', '128K', '-8000', '1e6', 'abc', '128000.5', '40000,5', '1,0000']) assert.equal(parseContextLength(bad), null, bad);
});

test('maximum output is optional and accepts only positive integer tokens up to the selected context', () => {
  for (const text of ['', '  ']) assert.deepEqual(parseMaxOutputTokens(text), {});
  for (const text of ['1', '60,000', '60.000', '60 000', "60'000", '60’000', '65536']) {
    const parsed = parseMaxOutputTokens(text, 65_536);
    assert.ok(parsed?.maxOutputTokens);
    assert.equal(outputTokenLimit(parsed.maxOutputTokens, 65_536), parsed.maxOutputTokens, 'a front-end value is accepted unchanged by the backend');
  }
  assert.deepEqual(parseMaxOutputTokens('128000'), { maxOutputTokens: 128_000 });
  for (const text of ['0', '-1', '1.5', '1e3', '16K', 'NaN', 'Infinity', 'true', '1,0000', '65537', '999999999999999999999']) {
    assert.equal(parseMaxOutputTokens(text, 65_536), null, text);
  }
  assert.equal(parseMaxOutputTokens('128001'), null, 'empty context means 128K');
  assert.equal(parseMaxOutputTokens('60000', 32_000), null, 'lowering context invalidates a larger cap');
});
