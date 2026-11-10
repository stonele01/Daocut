import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AgentSession, ownAgentPrompt } from './agents.mjs';
import { modelsJson, providerOf, THINKING } from './pi-config.mjs';

const root = fileURLToPath(new URL('../.release/deepseek-prompt-compat/', import.meta.url));
const require = createRequire(import.meta.url);
const undiciUrl = pathToFileURL(require.resolve('undici')).href;
const own = (baseUrl, api = 'openai-responses') => ({
  id: 'fixture', name: 'Local test only', api, baseUrl, keyEnv: 'DAOCUT_FAKE_DEEPSEEK_KEY',
  model: 'deepseek-flash', levels: ['auto', 'max'], effort: 'max',
});

function sse(result, model, n) {
  let sequence = 0;
  const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`;
  const response = { id: `resp_${n}`, object: 'response', created_at: 0, status: 'in_progress', model, output: [] };
  let wire = event('response.created', { response });
  const output = result.call ? [{ type: 'function_call', id: `fc_${n}`, call_id: `call_${n}`,
    name: result.call.name, arguments: JSON.stringify(result.call.args), status: 'completed' }]
    : [{ type: 'message', id: `msg_${n}`, role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: '已完成局部修改。', annotations: [] }] }];
  for (const [output_index, item] of output.entries()) {
    wire += event('response.output_item.added', { output_index,
      item: { ...item, status: 'in_progress', ...(result.call ? { arguments: '' } : { content: [] }) } });
    if (result.call) {
      wire += event('response.function_call_arguments.delta', { item_id: item.id, output_index, delta: item.arguments });
      wire += event('response.function_call_arguments.done', { item_id: item.id, output_index, arguments: item.arguments });
    } else wire += event('response.output_text.delta', { item_id: item.id, output_index, content_index: 0, delta: item.content[0].text });
    wire += event('response.output_item.done', { output_index, item });
  }
  return wire + event('response.completed', { response: { ...response, status: 'completed', output,
    usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens: 8,
      output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 108 } } });
}

// Actual Pi subprocess, ACP and Responses serialization. Only Undici's last dispatch is redirected:
// configured provider URLs remain real-shaped so compatibility selection is exercised. Every attempted
// origin is checked; no request can reach a real provider and the only credential is the fixed fake below.
async function fixture(baseUrl) {
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'case-'));
  const cwd = join(dir, 'project');
  const scratch = join(dir, 'tmp');
  mkdirSync(cwd); mkdirSync(scratch);
  writeFileSync(join(cwd, 'film.html'), '<!doctype html><title>before</title>');
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const request = JSON.parse(body);
      requests.push({ path: req.url, request });
      if (requests.length > 3) { res.writeHead(400); res.end('fixture call limit'); return; }
      const result = requests.length === 1 ? { call: { name: 'read', args: { path: 'film.html' } } }
        : requests.length === 2 ? { call: { name: 'edit', args: { path: 'film.html', edits: [{ oldText: '<title>before</title>', newText: '<title>after</title>' }] } } } : {};
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse(result, request.model, requests.length));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const localOrigin = `http://127.0.0.1:${server.address().port}`;
  const preload = join(dir, 'loopback-only.mjs');
  writeFileSync(preload, `import { Agent } from ${JSON.stringify(undiciUrl)};\n` +
    `const original = Agent.prototype.dispatch;\nAgent.prototype.dispatch = function (options, handler) {\n` +
    `  if (new URL(options.origin).origin !== ${JSON.stringify(new URL(baseUrl).origin)}) throw new Error('Network disabled by test fixture');\n` +
    `  return original.call(this, { ...options, origin: ${JSON.stringify(localOrigin)} }, handler);\n};\n`);
  const permissions = [];
  const session = new AgentSession({ agent: 'byok', cwd,
    harness: { home: join(dir, 'home'), models: [own(baseUrl)], model: 'fixture', env: {
      DAOCUT_FAKE_DEEPSEEK_KEY: 'sk-synthetic-no-provider-access',
      NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, TEMP: scratch, TMP: scratch,
    } },
    onPermission: async p => { permissions.push(p); return null; },
  });
  try { await session.start(); } catch (error) { session.close(); server.closeAllConnections(); server.close(); throw error; }
  return { session, requests, permissions, cwd,
    close() { session.close(); server.closeAllConnections(); server.close(); } };
}

for (const [baseUrl, role] of [
  ['https://api.deepseek.com/v1', 'system'],
  ['https://gateway.example.test/v1', 'developer'],
]) test(`max reasoning Responses sends the prompt as ${role} for ${new URL(baseUrl).hostname}`, { timeout: 60_000 }, async () => {
  const f = await fixture(baseUrl);
  try {
    await f.session.prompt([{ type: 'text', text: '把 film.html 中的标题 before 改成 after，其他不改。' }]);
    assert.equal(f.requests.length, 3, 'normal read/edit/final sequence without an extra reviewer request');
    for (const { path, request } of f.requests) {
      assert.equal(path, '/v1/responses');
      assert.equal(request.model, 'deepseek-flash');
      assert.equal(request.reasoning.effort, 'max');
      const instruction = request.input.find(item => typeof item.content === 'string' && item.content.includes(ownAgentPrompt()));
      assert.equal(instruction?.role, role, 'actual serialized system prompt uses the provider-supported role');
      assert.equal(instruction.content.split(ownAgentPrompt()).length - 1, 1);
      assert.ok(!instruction.content.includes('<manual>'));
      assert.deepEqual(request.tools.map(tool => tool.name).sort(), ['ask', 'bash', 'edit', 'read', 'write']);
      assert.ok(request.tools.every(tool => tool.type === 'function'));
      assert.ok(request.tools.find(tool => tool.name === 'read').parameters.required.includes('path'));
      assert.ok(request.tools.find(tool => tool.name === 'edit').parameters.required.includes('edits'));
    }
    assert.ok(f.requests[1].request.input.some(item => item.type === 'function_call_output' && item.call_id === 'call_1'));
    assert.match(readFileSync(join(f.cwd, 'film.html'), 'utf8'), /<title>after<\/title>/);
    assert.equal(f.permissions.length, 0);
  } finally { f.close(); }
});

test('DeepSeek role compatibility is limited to its official HTTPS Responses endpoint', () => {
  for (const baseUrl of ['https://api.deepseek.com', 'https://api.deepseek.com/v1/', 'https://API.DEEPSEEK.COM:443/v1']) {
    const config = modelsJson([own(baseUrl)]);
    for (const provider of [providerOf('fixture'), THINKING(providerOf('fixture'))])
      assert.equal(config.providers[provider].models[0].compat?.supportsDeveloperRole, false);
  }
  for (const baseUrl of ['https://api.deepseek.com.evil.test/v1', 'https://proxy.api.deepseek.com/v1',
    'https://api.deepseek.com:8443/v1', 'http://api.deepseek.com/v1', 'https://api.openai.com/v1', 'invalid']) {
    const config = modelsJson([own(baseUrl)]);
    assert.equal(config.providers[THINKING(providerOf('fixture'))].models[0].compat, undefined);
  }
  for (const api of ['openai-completions', 'anthropic-messages']) {
    const config = modelsJson([own('https://api.deepseek.com/v1', api)]);
    assert.equal(config.providers[THINKING(providerOf('fixture'))].models[0].compat, undefined);
  }
});
