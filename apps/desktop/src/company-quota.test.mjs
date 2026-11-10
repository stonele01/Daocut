import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCompanyQuota, parseQuotaReserve, parseQuotaSettle, quotaProbeFetch } from './company-quota.mjs';
const id = '00000000-0000-4000-8000-000000000001';
const event = { id, at: '2026-10-26T00:00:00Z', model: 'synthetic', input: 10, output: 20, cacheRead: 30, cacheWrite: 0, reasoning: 5, total: 60 };
function fixture() {
  let binding = { serverUrl: 'https://company.example', userId: 'employee', epoch: 1 }, limited = false;
  const operations = [];
  const client = { sessionBinding: () => binding, assertSession: async () => {}, quota: async () => ({ quota: { limited } }),
    reserveQuota: async input => { operations.push('reserve'); return { id: input.id, status: 'reserved' }; },
    settleQuota: async () => { operations.push('settle'); return { settled: true }; } };
  const usageReporter = { recordRequest: () => operations.push('persist'), acknowledgeRequest: () => operations.push('ack') };
  return { quota: createCompanyQuota({ client, usageReporter }), operations, client, usageReporter,
    changeEpoch: () => { binding = { ...binding, epoch: binding.epoch + 1 }; }, limit: () => { limited = true; } };
}
test('company endpoint params allow only IDs and numeric receipts', () => {
  assert.deepEqual(parseQuotaReserve({ id, model: 'test', reservedTokens: 100, key: 'secret' }), { id, model: 'test', reservedTokens: 100 });
  const parsed = parseQuotaSettle({ event: { ...event, total: 100000, prompt: 'private', key: 'secret' } });
  assert.equal(parsed.event.total, 60); assert.doesNotMatch(JSON.stringify(parsed), /private|secret/);
  assert.throws(() => parseQuotaReserve({ id, model: 'test', reservedTokens: -1 }));
});
test('settlement persists in the existing outbox before network; account switching cannot relabel it', async () => {
  const f = fixture(), identity = f.quota.capture();
  await f.quota.reserve({ id, model: 'test', reservedTokens: 100 }, identity);
  await f.quota.settle({ event }, identity);
  assert.deepEqual(f.operations, ['reserve', 'persist', 'settle', 'ack']);
  f.changeEpoch();
  await assert.rejects(f.quota.reserve({ id, model: 'test', reservedTokens: 100 }, identity), /登录状态已改变/);
  assert.deepEqual(await f.quota.settle({ event }, identity), { settled: false, queued: true });
  assert.equal(f.operations.at(-1), 'persist');
});
test('quota network failure leaves a durable receipt; failed persistence is not claimed as queued', async () => {
  const f = fixture(); f.client.settleQuota = async () => { throw new Error('offline'); };
  assert.deepEqual(await f.quota.settle({ event }, f.quota.capture()), { settled: false, queued: true });
  f.usageReporter.recordRequest = () => { throw new Error('disk full'); };
  await assert.rejects(f.quota.settle({ event }, f.quota.capture()), /disk full/);
});
test('limited accounts cannot bypass via native agents; unlimited and BYOK stay available', async () => {
  const f = fixture();
  await f.quota.authorizeTask({ agent: 'claude' });
  f.limit(); await f.quota.authorizeTask({ agent: 'byok' });
  await assert.rejects(f.quota.authorizeTask({ agent: 'claude' }), /其他智能体暂不支持/);
});


test('partial settlement does not claim a completed quota reconciliation; numeric prices survive parsing', async () => {
  const f = fixture(); f.client.settleQuota = async () => ({ settled: false });
  assert.deepEqual(await f.quota.settle({ event: { ...event, incomplete: true } }, f.quota.capture()), { settled: false });
  const safe = parseQuotaSettle({ event: { ...event, costs: { CNY: 0.05, USD: Infinity, private: 'secret' } } }).event;
  assert.deepEqual(safe.costs, { CNY: 0.05 });
  assert.throws(() => parseQuotaSettle({ event: { ...event, model: {} } }));
});

test('vision probe preserves request, result and parameters while applying the same reservation and receipt path', async () => {
  for (const [url, response, expected] of [
    ['https://model.test/chat/completions', { usage: { prompt_tokens: 100, completion_tokens: 16, prompt_tokens_details: { cached_tokens: 60 } } }, 116],
    ['https://model.test/responses', { usage: { input_tokens: 100, output_tokens: 16, input_tokens_details: { cached_tokens: 60 } } }, 116],
    ['https://model.test/v1/messages', { usage: { input_tokens: 100, output_tokens: 16, cache_read_input_tokens: 60, cache_creation_input_tokens: 10 } }, 186],
  ]) {
    const actions = [], identity = { userId: 'synthetic', epoch: 1 };
    const quota = { capture: () => identity, reserve: async input => actions.push(['reserve', input]), settle: async ({ event }) => actions.push(['settle', event]) };
    const options = { body: JSON.stringify({ model: 'fixture', max_tokens: 16, messages: [{ role: 'user', content: [{ type: 'text', text: 'probe' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,test' } }] }] }), headers: { authorization: 'synthetic-secret' } };
    const raw = new Response(JSON.stringify(response), { status: 200 });
    const wrapped = quotaProbeFetch(async (actualUrl, actualOptions) => { assert.equal(actualUrl, url); assert.equal(actualOptions, options); assert.equal(actions[0][0], 'reserve'); return raw; }, quota);
    assert.equal(await wrapped(url, options), raw); assert.deepEqual(await raw.json(), response);
    assert.equal(actions[1][0], 'settle'); assert.equal(actions[1][1].total, expected); assert.equal(actions[0][1].id, actions[1][1].id);
    assert.doesNotMatch(JSON.stringify(actions), /synthetic-secret|data:image/);
  }
});
