import assert from 'node:assert/strict';
import test from 'node:test';
import { feedbackReport } from './feedback-report.ts';

test('feedback report keeps the latest 20 problems and explains the omitted remainder', () => {
  const text = feedbackReport('report', Array.from({ length: 500 }, (_, i) => ({ t: '2026-10-24', area: 'export', what: `problem-${i}-end` })));
  assert.match(text, /problem-19-end/);
  assert.doesNotMatch(text, /problem-20-end/);
  assert.match(text, /complete list/);
});
test('feedback report remains within the server UTF-8 limit for Chinese and emoji', () => {
  const text = feedbackReport('中文位置🙂'.repeat(15000), []);
  assert.ok(new TextEncoder().encode(text).byteLength <= 64 * 1024);
  assert.match(text, /已截短/);
  assert.doesNotMatch(text, /\uFFFD/);
});
test('short basic report retains the source and problem information', () => {
  const text = feedbackReport('runtime info', [{ t: 'today', area: 'agent', agent: 'byok', step: 'prompt', what: 'connection failed' }]);
  assert.match(text, /runtime info/);
  assert.match(text, /today · byok \/ prompt\nconnection failed/);
  assert.doesNotMatch(text, /Truncated/);
});
