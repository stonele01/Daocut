import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quotaStream, quotaReservationTokens } from './pi-quota.mjs';
import { QUOTA_RESERVE, QUOTA_SETTLE, QUOTA_RELEASE } from './company-quota.mjs';
const model = { id: 'synthetic', maxTokens: 16000 };
const context = { systemPrompt: 'system', messages: [{ role: 'user', content: 'private material path' }], tools: [{ name: 'write', parameters: { type: 'object' } }] };
const answer = (over = {}) => ({ role: 'assistant', model: model.id, stopReason: 'stop', content: [{ type: 'text', text: 'ok' }], usage: { input: 20, output: 10, cacheRead: 100, cacheWrite: 0, reasoning: 5 }, ...over });
const source = (final) => ({ result: async () => final, async *[Symbol.asyncIterator]() { yield { type: 'text_delta', delta: 'ok' }; yield { type: 'done', message: final }; } });

test('without company mode the actual stream function is unchanged', () => {
  const raw = () => {};
  assert.equal(quotaStream(raw, { enabled: false }), raw);
});

test('reserve precedes transport, streaming and parameters are unchanged, one real receipt settles', async () => {
  const calls = [], params = { maxTokens: 7000, reasoning: 'high', apiKey: 'synthetic-secret' }, result = answer();
  const client = { request: async (method, body) => { calls.push({ method, body }); return {}; } };
  const wrapped = quotaStream((m, c, options) => {
    assert.equal(calls[0].method, QUOTA_RESERVE); assert.equal(m, model); assert.equal(c, context); assert.equal(options, params);
    return source(result);
  }, { enabled: true, client });
  const stream = await wrapped(model, context, params);
  assert.deepEqual((await Array.fromAsync(stream)).map(e => e.type), ['text_delta', 'done']);
  assert.equal(await stream.result(), result);
  assert.equal(calls.length, 2); assert.equal(calls[1].method, QUOTA_SETTLE);
  assert.equal(calls[1].body.event.id, calls[0].body.id); assert.equal(calls[1].body.event.total, 130);
  assert.equal(calls[0].body.reservedTokens, quotaReservationTokens(model, context, params));
  assert.doesNotMatch(JSON.stringify(calls), /private material|synthetic-secret|parameters|reasoning.*high/);
});

test('denied and unavailable quota never reaches provider; each retry gets a separate request identity', async () => {
  let apiCalls = 0, allowed = false; const ids = [];
  const wrapped = quotaStream(() => { apiCalls++; return source(answer()); }, { enabled: true, client: { request: async (method, body) => {
    if (method === QUOTA_RESERVE) { ids.push(body.id); if (!allowed) throw new Error('额度不足'); }
  } } });
  await assert.rejects(wrapped(model, context, {}), /额度不足/); assert.equal(apiCalls, 0);
  allowed = true;
  await (await wrapped(model, context, {})).result(); await (await wrapped(model, context, {})).result();
  assert.equal(apiCalls, 2); assert.equal(new Set(ids).size, 3);
});

test('cancellation before transport releases only the confirmed unsent reservation', async () => {
  const controller = new AbortController(), methods = [];
  const wrapped = quotaStream(() => assert.fail('must not call provider'), { enabled: true, client: { request: async method => {
    methods.push(method); if (method === QUOTA_RESERVE) controller.abort();
  } } });
  await assert.rejects(wrapped(model, context, { signal: controller.signal }), /abort/i);
  assert.deepEqual(methods, [QUOTA_RESERVE, QUOTA_RELEASE]);
});

test('cancelled response with real usage settles; absent usage never releases uncertain spend', async () => {
  for (const final of [answer({ stopReason: 'aborted' }), answer({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })]) {
    const methods = [];
    const wrapped = quotaStream(() => source(final), { enabled: true, client: { request: async method => methods.push(method) } });
    assert.equal(await (await wrapped(model, context, {})).result(), final);
    assert.deepEqual(methods, final.stopReason === 'aborted' ? [QUOTA_RESERVE, QUOTA_SETTLE] : [QUOTA_RESERVE]);
  }
});
