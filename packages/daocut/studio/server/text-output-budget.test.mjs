import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeepSeekTextClient } from './text-structure.mjs';
import { createDesktopAnalysisServices } from './desktop-analysis-services.mjs';

const publicConfig = { id: 'synthetic', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' };
test('a response exceeding the former ceiling completes in one request with JSON output and unchanged low reasoning', async t => {
  let calls = 0, body, receipt;
  const waits = [], schedule = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => { waits.push(delay); return schedule(callback, delay, ...args); });
  const client = createDeepSeekTextClient({ getPublicConfig: async () => publicConfig, getConfig: async () => ({ ...publicConfig, apiKey: 'synthetic' }), fetch: async (_url, options) => {
    calls++; body = JSON.parse(options.body);
    const completed = body.max_output_tokens >= 20000;
    return { ok: true, status: 200, json: async () => ({ status: completed ? 'completed' : 'incomplete', usage: { output_tokens: completed ? 20000 : 16384 },
      output: [{ content: [{ type: 'output_text', text: completed ? '{"candidates":[],"issues":[]}' : '{"candidates":[' }] }] }) };
  } });
  assert.deepEqual(await client({ system: 'Return synthetic JSON', input: '{}', onReceipt: value => { receipt = value; } }), { candidates: [], issues: [] });
  assert.equal(calls, 1);
  assert.equal(body.max_output_tokens, 32768);
  assert.deepEqual(body.reasoning, { effort: 'low' });
  assert.deepEqual(body.text, { format: { type: 'json_object' } });
  assert.equal(receipt.maxOutputTokens, 32768);
  assert.equal(receipt.outputFormat, 'json_object');
  assert.ok(waits.includes(300000), 'allow the larger response to finish within the declared timeout');
  const identity = await client.getCacheIdentity();
  const desktop = createDesktopAnalysisServices({ textBridge: async () => publicConfig });
  const { configurationId, ...bridgeIdentity } = await desktop.liveAnalysis.modelClient.getCacheIdentity();
  assert.equal(configurationId, publicConfig.id);
  assert.deepEqual(bridgeIdentity, identity, 'desktop confirmation and actual transport must agree');
});
