import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeepSeekTextClient, recoverDeepSeekTextResponse } from './text-structure.mjs';

const config = async () => ({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'synthetic-secret' });
const request = { system: 'synthetic rules', input: 'synthetic cues' };
const output = text => [{ type: 'message', content: [{ type: 'output_text', text }] }];
const invoke = async (body, onReceipt) => createDeepSeekTextClient({ getConfig: config, fetch: async () => ({ ok: true, status: 200, json: async () => body }) })({ ...request, onReceipt });

test('incomplete analysis saves returned text, stop reason and reasoning usage before reporting failure; never retries', async () => {
  let calls = 0, saved;
  const client = createDeepSeekTextClient({ getConfig: config, fetch: async (_url, options) => {
    calls++;
    const sent = JSON.parse(options.body);
    assert.equal(sent.max_output_tokens, 32768, 'use the declared finite output budget');
    assert.deepEqual(sent.reasoning, { effort: 'low' }, 'do not silently change the analysis mode');
    return { ok: true, status: 200, json: async () => ({ id: 'synthetic-limit', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens', private: 'do-not-copy' },
      usage: { input_tokens: 8213, output_tokens: 32768, output_tokens_details: { reasoning_tokens: 32740, private: 'do-not-copy' } },
      output: [{ type: 'reasoning', content: [{ type: 'reasoning_text', text: 'synthetic internal reasoning' }] }, ...output('{"candidates":[')] }) };
  } });
  await assert.rejects(client({ ...request, onReceipt: async receipt => { saved = structuredClone(receipt); } }), { code: 'MODEL_INCOMPLETE' });
  assert.equal(calls, 1);
  assert.equal(saved.incompleteReason, 'max_output_tokens');
  assert.equal(saved.rawText, '{"candidates":[');
  assert.equal(saved.maxOutputTokens, 32768);
  assert.equal(saved.usage.output_tokens_details.reasoning_tokens, 32740);
  assert.ok(!JSON.stringify(saved).includes('synthetic-secret'));
  assert.ok(!JSON.stringify(saved).includes('do-not-copy'));
  assert.ok(!JSON.stringify(saved).includes('synthetic internal reasoning'));
  assert.equal(recoverDeepSeekTextResponse(saved, request), undefined, 'partial text is never treated as a complete analysis');
});

test('completed saved response recovers only for the exact original input without credentials or network', async () => {
  let saved;
  const value = { schema: 'complete-speech-v1', candidates: [], issues: [] };
  await invoke({ id: 'synthetic-complete', status: 'completed', output: output(JSON.stringify(value)) }, receipt => { saved = receipt; });
  assert.equal(saved.rawText, JSON.stringify(value));
  assert.deepEqual(recoverDeepSeekTextResponse(saved, request), value);
  assert.throws(() => recoverDeepSeekTextResponse(saved, { ...request, input: 'different cues' }), { code: 'MODEL_INPUT_CHANGED' });
  assert.throws(() => recoverDeepSeekTextResponse({ ...saved, rawText: '{}' }, request), { code: 'MODEL_INPUT_CHANGED' });
  assert.equal(recoverDeepSeekTextResponse({ requestId: 'old-receipt', status: 'completed' }, request), undefined);
});

test('a complete but invalid JSON response stays saved and fails locally instead of becoming a fresh model request', async () => {
  let saved;
  await assert.rejects(invoke({ status: 'completed', output: output('{') }, receipt => { saved = receipt; }), { code: 'MODEL_INVALID_JSON' });
  assert.equal(saved.rawText, '{');
  assert.throws(() => recoverDeepSeekTextResponse(saved, request), { code: 'MODEL_INVALID_JSON' });
});

test('content filtering is distinct from output exhaustion and never yields a recovered partial result', async () => {
  let saved;
  await assert.rejects(invoke({ status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: output('{}') }, receipt => { saved = receipt; }), { code: 'MODEL_INCOMPLETE' });
  assert.equal(saved.incompleteReason, 'content_filter');
  assert.equal(recoverDeepSeekTextResponse(saved, request), undefined);
});
