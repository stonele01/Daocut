import test from 'node:test';
import assert from 'node:assert/strict';
import { createProductVisionClient } from './product-vision-client.mjs';

const config = { id: 'visual1', name: 'Existing image model', api: 'openai-completions', baseUrl: 'https://mock.invalid/v1', model: 'mock-vision', levels: ['auto'], effort: 'auto', context: 32768, maxOutputTokens: 1024 };
const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB' };
const request = { system: 'Read only the selected lecture pictures', input: 'cue 1: original words', images: [image], expectedConfig: config };
const answer = (extra = {}) => ({ role: 'assistant', model: config.model, responseId: 'mock-receipt', content: [{ type: 'text', text: '{"visual":"product shown"}' }], stopReason: 'stop', usage: { input: 40, output: 12, cacheRead: 2, cacheWrite: 0 }, ...extra });
const streamOf = value => ({ result: async () => value, async *[Symbol.asyncIterator]() { yield { type: 'done', message: value }; } });
const setup = extra => createProductVisionClient({ getPublicConfig: async () => config, getConfig: async () => ({ ...config, apiKey: 'synthetic-secret' }), ...extra });

test('single visual request reuses model config and sends text plus images without tools; raw output and receipt survive', async () => {
  let calls = 0;
  const client = setup({ stream: (model, context, options) => {
    calls++;
    assert.equal(model.id, config.model); assert.equal(model.api, config.api); assert.equal(model.contextWindow, config.context);
    assert.equal(options.maxTokens, 1024); assert.equal(options.maxRetries, 0); assert.equal(options.toolChoice, 'none');
    assert.equal(context.systemPrompt, request.system); assert.deepEqual(context.tools, []);
    assert.deepEqual(context.messages[0].content, [{ type: 'text', text: request.input }, image]);
    return streamOf(answer({ content: [{ type: 'text', text: 'not JSON yet' }] }));
  } });
  const result = await client({ ...request, expectedConfig: Object.fromEntries(Object.entries(config).reverse()) });
  assert.equal(calls, 1); assert.equal(result.value, 'not JSON yet'); assert.equal(result.receipt.requestId, 'mock-receipt');
  assert.equal(result.receipt.stopReason, 'stop'); assert.equal(result.receipt.usage.input, 40);
  assert.ok(!JSON.stringify(result).includes('synthetic-secret'));
});

test('changed selection and invalid images reject before credentials or SDK calls', async () => {
  let keys = 0, calls = 0;
  const client = setup({ getConfig: async () => { keys++; return { ...config, apiKey: 'synthetic-secret' }; }, stream: () => { calls++; return streamOf(answer()); } });
  await assert.rejects(client({ ...request, expectedConfig: { ...config, model: 'changed' } }), { code: 'MODEL_INPUT_CHANGED' });
  await assert.rejects(client({ ...request, images: [] }), { code: 'MODEL_INVALID_INPUT' });
  await assert.rejects(client({ ...request, images: [{ ...image, mimeType: 'text/html' }] }), { code: 'MODEL_INVALID_INPUT' });
  assert.equal(keys, 0); assert.equal(calls, 0);
});

test('incomplete response preserves raw text and usage, with no automatic retry', async () => {
  let calls = 0;
  const client = setup({ stream: () => { calls++; return streamOf(answer({ stopReason: 'length', content: [{ type: 'text', text: '{"partial":' }] })); } });
  await assert.rejects(client(request), error => error.code === 'MODEL_INCOMPLETE' && error.receipt.rawText === '{"partial":' && error.receipt.usage.output === 12);
  assert.equal(calls, 1);
});

test('company quota wraps the same single SDK request and settles the original account with usage', async () => {
  const events = [], identity = { userId: 'mock-user', serverUrl: 'https://company.invalid', epoch: 1 };
  const quota = { capture: () => identity, reserve: async (body, captured) => { assert.equal(captured, identity); events.push(['reserve', body]); },
    settle: async (body, captured) => { assert.equal(captured, identity); events.push(['settle', body]); }, release: async () => assert.fail('sent request must not be released') };
  const client = setup({ quota: () => quota, stream: () => { events.push(['stream']); return streamOf(answer()); } });
  const result = await client(request);
  assert.deepEqual(events.map(e => e[0]), ['reserve', 'stream', 'settle']);
  assert.equal(events[1].length, 1); assert.ok(events[0][1].reservedTokens >= 1024);
  assert.equal(result.receipt.quotaRequestId, events[0][1].id); assert.equal(events[2][1].event.id, events[0][1].id);
});

test('SDK retry attempts cannot send a second request; ambiguous failures retain receipt without secrets', async () => {
  let sends = 0;
  const client = setup({ fetch: async () => { sends++; throw Error('synthetic-secret provider failure'); }, stream: async (model, context, options) => {
    await assert.rejects(options.fetch('https://mock.invalid/v1', {}));
    await assert.rejects(options.fetch('https://mock.invalid/v1', {}));
    return streamOf(answer({ stopReason: 'error', errorMessage: 'synthetic-secret', content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }));
  } });
  await assert.rejects(client(request), error => {
    assert.equal(error.code, 'MODEL_NETWORK'); assert.equal(error.receipt.submitted, true); assert.equal(error.receipt.usageKnown, false);
    assert.ok(!JSON.stringify(error.receipt).includes('synthetic-secret')); assert.ok(!error.message.includes('synthetic-secret')); return true;
  });
  assert.equal(sends, 1);
});

test('real Pi SDK serializes image/auth through mock fetch and accepts streamed response without network', async () => {
  let sends = 0;
  const client = setup({ fetch: async (url, options) => {
    sends++; assert.equal(String(url), 'https://mock.invalid/v1/chat/completions');
    const headers = new Headers(options.headers); assert.equal(headers.get('authorization'), 'Bearer synthetic-secret');
    const body = JSON.parse(options.body);
    assert.equal(body.model, config.model); assert.equal(body.max_tokens ?? body.max_completion_tokens, 1024);
    const content = body.messages.find(message => message.role === 'user').content;
    assert.equal(content.find(block => block.type === 'image_url').image_url.url, `data:image/png;base64,${image.data}`);
    assert.ok(!body.tools?.length);
    const chunks = [
      { id: 'mock-sdk-response', object: 'chat.completion.chunk', model: config.model, choices: [{ index: 0, delta: { role: 'assistant', content: '{"visual":"shown"}' }, finish_reason: null }] },
      { id: 'mock-sdk-response', object: 'chat.completion.chunk', model: config.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 22, completion_tokens: 6, total_tokens: 28 } },
    ];
    return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } });
  const result = await client(request);
  assert.equal(result.value, '{"visual":"shown"}'); assert.equal(sends, 1); assert.equal(result.receipt.requestId, 'mock-sdk-response'); assert.equal(result.receipt.usage.input, 22);
});

for (const api of ['openai-completions', 'openai-responses', 'anthropic-messages']) {
  test(`real Pi SDK ${api} sends image once and cannot retry a mocked server failure`, async () => {
    const selected = { ...config, api }; let sends = 0;
    const client = createProductVisionClient({ getPublicConfig: async () => selected, getConfig: async () => ({ ...selected, apiKey: 'synthetic-secret' }), fetch: async (_url, options) => {
      sends++; const body = JSON.parse(options.body); assert.equal(body.model, config.model);
      assert.ok(JSON.stringify(body).includes(image.data), 'SDK wire must contain the selected image');
      assert.ok(!body.tools?.length);
      return new Response(JSON.stringify({ error: { message: 'synthetic-secret server error', type: 'server_error' } }), { status: 500, headers: { 'content-type': 'application/json' } });
    } });
    await assert.rejects(client({ ...request, expectedConfig: selected }), error => error.code === 'MODEL_NETWORK' && error.receipt.submitted && !error.receipt.usageKnown && !JSON.stringify(error.receipt).includes('synthetic-secret'));
    assert.equal(sends, 1);
  });
}

test('company quota rejection prevents every SDK/provider submission', async () => {
  let calls = 0;
  const client = setup({ quota: () => ({ capture: () => ({}), reserve: async () => { throw Object.assign(Error('额度不足'), { code: 'company-quota' }); } }), stream: () => { calls++; assert.fail('blocked quota cannot submit'); } });
  await assert.rejects(client(request), error => error.code === 'company-quota' && error.receipt.submitted === false);
  assert.equal(calls, 0);
});
