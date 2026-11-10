import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudioAnalysisBridge, studioAnalysisError } from './studio-analysis-bridge.mjs';

test('utility replies keep concurrent requests separate and preserve safe failure receipts', async () => {
  let receive; const sent = [];
  const bridge = createStudioAnalysisBridge({ send: message => sent.push(message), subscribe: fn => { receive = fn; } });
  const first = bridge({ operation: 'execute' }), second = bridge({ operation: 'public-config' });
  receive({ type: 'analysis-response', id: sent[1].id, ok: true, value: { model: 'synthetic' } });
  assert.deepEqual(await second, { model: 'synthetic' });
  receive({ type: 'analysis-response', id: sent[0].id, ok: false, code: 'MODEL_INCOMPLETE', error: 'incomplete', receipt: { requestId: 'synthetic-receipt' } });
  await assert.rejects(first, error => error.code === 'MODEL_INCOMPLETE' && error.receipt.requestId === 'synthetic-receipt');
});

test('utility timeout does not resend, including after a late reply', async () => {
  let receive; const sent = [];
  const bridge = createStudioAnalysisBridge({ send: message => sent.push(message), subscribe: fn => { receive = fn; }, timeoutMs: 5 });
  await assert.rejects(bridge({ operation: 'execute' }), { code: 'MODEL_TIMEOUT' });
  receive({ type: 'analysis-response', id: sent[0].id, ok: true, value: {} });
  assert.equal(sent.length, 1);
});

test('company switch and ownership errors remain actionable after the actual IPC error envelope', async () => {
  let receive; const sent = [];
  const bridge = createStudioAnalysisBridge({ send: message => sent.push(message), subscribe: fn => { receive = fn; } });
  for (const [code, expected] of [['SHARED_COORDINATOR_CHANGED', /公司服务/], ['SHARED_FORBIDDEN', /领取/], ['SHARED_COMPANY_UNAVAILABLE', /公司/], ['company-unconfigured', /公司/]]) {
    const pending = bridge({ operation: 'shared-coordinate' });
    receive({ type: 'analysis-response', id: sent.at(-1).id, ...studioAnalysisError({ code, message: 'synthetic-secret-must-not-leak' }) });
    await assert.rejects(pending, error => error.code === code && expected.test(error.message) && !error.message.includes('synthetic-secret'));
  }
  assert.equal(studioAnalysisError({ code: 'UNKNOWN', message: 'secret' }).error, '文字服务配置不可用');
});

test('visual bridge preserves partial output receipts and uses a separate bounded timeout without resending', async () => {
  let receive; const sent = [];
  const bridge = createStudioAnalysisBridge({ send: message => sent.push(message), subscribe: fn => { receive = fn; }, timeoutMs: 200, visualTimeoutMs: 5 });
  const first = bridge({ operation: 'execute-visual' });
  await assert.rejects(first, error => error.code === 'MODEL_TIMEOUT' && /画面/.test(error.message));
  receive({ type: 'analysis-response', id: sent[0].id, ok: true, value: { value: '{}' } });
  assert.equal(sent.length, 1);
  const second = bridge({ operation: 'execute-visual' });
  receive({ type: 'analysis-response', id: sent[1].id, ...studioAnalysisError({ code: 'MODEL_INCOMPLETE', message: '画面结果未完整', receipt: { rawText: '{"partial":', stopReason: 'length', usageKnown: true } }) });
  await assert.rejects(second, error => error.receipt.rawText === '{"partial":' && error.receipt.stopReason === 'length');
});
