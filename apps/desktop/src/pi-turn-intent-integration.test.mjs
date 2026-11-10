import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentSession } from './agents.mjs';

/* Actual Pi subprocess + ACP client + loopback model transport. Only synthetic inputs/keys; all files stay in the
   repository's ignored .release directory on D. No real provider request or user project is used. */
const tempRoot = fileURLToPath(new URL('../.release/turn-intent-integration/', import.meta.url));
mkdirSync(tempRoot, { recursive: true });
const text = value => [{ type: 'text', text: value }];
const call = (name, args, id = name) => ({ id, name, args });

async function service(reply) {
  const bodies = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const request = JSON.parse(body || '{}');
      bodies.push(request);
      if (bodies.length > 8) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Synthetic test request limit exceeded.' } }));
        return;
      }
      const result = reply(request, bodies.length);
      if (result.status) {
        res.writeHead(result.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Synthetic service unavailable' } }));
        return;
      }
      const model = request.model;
      if (req.url?.endsWith('/responses')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(responsesSse(result, model, bodies.length));
        return;
      }
      const chunk = (delta, finish_reason = null, usage) => 'data: ' + JSON.stringify({
        id: 'synthetic-' + bodies.length, object: 'chat.completion.chunk', created: 0, model,
        choices: [{ index: 0, delta, finish_reason }],
        ...(usage ? { usage } : {}),
      }) + '\n\n';
      const toolCalls = result.calls?.map(({ id, name, args }, index) => ({
        index, id: 'fixture-' + bodies.length + '-' + id, type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      }));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        chunk({ role: 'assistant', ...(result.text ? { content: result.text } : {}), ...(toolCalls ? { tool_calls: toolCalls } : {}) })
        + chunk({}, toolCalls?.length ? 'tool_calls' : 'stop', { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 })
        + 'data: [DONE]\n\n',
      );
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    bodies,
    url: 'http://127.0.0.1:' + server.address().port + '/v1',
    close() { server.closeAllConnections(); server.close(); },
  };
}


/** Minimal real Responses events, including completed tool arguments, as the installed Pi provider consumes them. */
function responsesSse(result, model, requestNumber) {
  let sequence = 0;
  const event = (type, data) => 'event: ' + type + '\ndata: ' + JSON.stringify({ type, sequence_number: sequence++, ...data }) + '\n\n';
  const response = { id: 'resp_fixture_' + requestNumber, object: 'response', created_at: 0, status: 'in_progress', model, output: [] };
  let wire = event('response.created', { response });
  const output = (result.calls ?? []).map(({ id, name, args }) => ({
    type: 'function_call', id: 'fc_' + requestNumber + '_' + id, call_id: 'call_' + requestNumber + '_' + id,
    name, arguments: JSON.stringify(args), status: 'completed',
  }));
  if (result.text) output.push({
    type: 'message', id: 'msg_' + requestNumber, role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: result.text, annotations: [] }],
  });
  output.forEach((item, output_index) => {
    wire += event('response.output_item.added', {
      output_index, item: { ...item, status: 'in_progress', ...(item.type === 'function_call' ? { arguments: '' } : { content: [] }) },
    });
    if (item.type === 'function_call') {
      wire += event('response.function_call_arguments.delta', { item_id: item.id, output_index, delta: item.arguments });
      wire += event('response.function_call_arguments.done', { item_id: item.id, output_index, arguments: item.arguments });
    } else {
      wire += event('response.output_text.delta', { item_id: item.id, output_index, content_index: 0, delta: result.text });
    }
    wire += event('response.output_item.done', { output_index, item });
  });
  return wire + event('response.completed', { response: {
    ...response, status: 'completed', output,
    usage: { input_tokens: 12, input_tokens_details: { cached_tokens: 0 }, output_tokens: 6, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 18 },
  } });
}
async function fixture(reply, { onQuestion, api = 'openai-completions' } = {}) {
  const root = mkdtempSync(join(tempRoot, 'case-'));
  const cwd = join(root, 'project');
  const home = join(root, 'agent-home');
  const scratch = join(root, 'temp');
  for (const path of [cwd, home, scratch]) mkdirSync(path);
  const svc = await service(reply);
  const updates = [];
  const permissions = [];
  const session = new AgentSession({
    agent: 'byok', cwd,
    env: { TEMP: scratch, TMP: scratch },
    harness: {
      home, model: 'synthetic',
      models: [{
        id: 'synthetic', name: 'Synthetic local fixture', api,
        baseUrl: svc.url, keyEnv: 'DAOCUT_BYOK_KEY_synthetic', model: 'synthetic',
        levels: ['auto'], effort: 'auto',
      }],
      env: { DAOCUT_BYOK_KEY_synthetic: 'synthetic-loopback-only', TEMP: scratch, TMP: scratch },
    },
    onUpdate: update => updates.push(update),
    onPermission: async params => { permissions.push(params); return null; },
    ...(onQuestion ? { onQuestion } : {}),
  });
  try { await session.start(); } catch (error) { session.close(); svc.close(); throw error; }
  return {
    session, svc, cwd, updates, permissions,
    close() { session.close(); svc.close(); },
  };
}

const replies = updates => updates.filter(update => update.sessionUpdate === 'agent_message_chunk');
const localReplies = updates => replies(updates).filter(update => update._meta?.['daocut/localReply'] === true);

function noToolsAdvertised(body) {
  assert.equal(body.tool_choice, 'none', 'the actual provider request disables tool selection');
  assert.equal(body.tools?.length ?? 0, 0, 'no tool schemas are sent for a text-only turn');
}

const productContext = () => '分析当前商品段结构，只根据以下文字，不读取其他文件。\n<product_structure_context>' + JSON.stringify({
  scope: { sourceId: 'fixture-source', productId: 'product-b', intervalId: 'range-b', productName: '商品 B', startMs: 600000, endMs: 620000 },
  transcriptVersion: 'fixture-transcript-v1',
  segments: [{ startMs: 601000, endMs: 609000, text: '当前 B 段独有的商品介绍' }],
}) + '</product_structure_context>';

test('selected-product analysis sends the supplied range as text with no file tools for both transports', { timeout: 120000 }, async () => {
  for (const api of ['openai-completions', 'openai-responses']) {
    const f = await fixture(() => ({ text: '601000–609000：卖点，当前 B 段独有的商品介绍。' }), { api });
    try {
      assert.equal(await f.session.prompt(text(productContext())), 'end_turn');
      assert.equal(f.svc.bodies.length, 1);
      noToolsAdvertised(f.svc.bodies[0]);
      const body = JSON.stringify(f.svc.bodies[0]);
      assert.match(body, /当前 B 段独有的商品介绍/);
      assert.match(body, /601000/);
      assert.doesNotMatch(body, /相邻 A 段不应发送的介绍/);
      assert.equal(f.updates.some(update => update.sessionUpdate === 'tool_call'), false);
      assert.equal(f.permissions.length, 0);
    } finally { f.close(); }
  }
});

test('selected-product analysis blocks an ignored read or write without issuing a continuation request', { timeout: 60000 }, async () => {
  const f = await fixture(() => ({ text: '我先查看其他原稿。', calls: [
    call('read', { path: 'all-transcript.txt' }),
    call('write', { path: 'film.html', content: 'must not change' }),
  ] }));
  try {
    await assert.rejects(f.session.prompt(text(productContext())), /本段结构分析未完成/);
    assert.equal(f.svc.bodies.length, 1);
    noToolsAdvertised(f.svc.bodies[0]);
    assert.equal(existsSync(join(f.cwd, 'film.html')), false);
    assert.equal(f.updates.some(update => update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update'), false);
    const local = localReplies(f.updates);
    assert.equal(local.length, 1);
    assert.match(local[0].content.text, /本段结构分析未完成，未自动重试/);
    assert.doesNotMatch(local[0].content.text, /你好/);
  } finally { f.close(); }
});

test('a failed scoped submission makes only one network request and an explicit next edit keeps normal tools', { timeout: 60000 }, async () => {
  const f = await fixture((_, n) => n === 1 ? { status: 503 }
    : n === 2 ? { calls: [call('write', { path: 'film.html', content: '<title>Explicit next edit</title>' })] }
      : { text: '完成用户新一轮操作。' });
  try {
    await assert.rejects(f.session.prompt(text(productContext())));
    assert.equal(f.svc.bodies.length, 1, 'neither Pi nor provider SDK may silently resend the scoped transcript');
    assert.equal(f.updates.some(update => update.sessionUpdate === 'notice' && /重试/.test(JSON.stringify(update))), false);
    await f.session.prompt(text('请创建 film.html，标题为 Explicit next edit'));
    assert.equal(f.svc.bodies.length, 3);
    normalToolsAdvertised(f.svc.bodies[1]);
    assert.match(readFileSync(join(f.cwd, 'film.html'), 'utf8'), /Explicit next edit/);
  } finally { f.close(); }
});

function normalToolsAdvertised(body) {
  assert.notEqual(body.tool_choice, 'none', 'a real editing request is not put in greeting mode');
  assert.ok(body.tools?.some(tool => (tool.function?.name ?? tool.name) === 'write'), 'the write tool remains available');
}

test('a complete greeting makes one normal model request with no tools and no extra reviewer', { timeout: 60000 }, async () => {
  const f = await fixture(() => ({ text: '你好，有什么需要帮忙的？' }));
  try {
    assert.equal(await f.session.prompt(text('你好！')), 'end_turn');
    assert.equal(f.svc.bodies.length, 1);
    noToolsAdvertised(f.svc.bodies[0]);
    assert.equal(f.updates.some(update => update.sessionUpdate === 'tool_call'), false);
    assert.equal(f.permissions.length, 0);
    assert.equal(replies(f.updates).map(update => update.content.text).join(''), '你好，有什么需要帮忙的？');
    assert.equal(localReplies(f.updates).length, 0, 'a normal model answer receives no duplicate host greeting');
  } finally { f.close(); }
});

test('a model ignoring tool_choice none cannot execute either write or bash on a greeting turn', { timeout: 60000 }, async () => {
  const f = await fixture((_, n) => n === 1 ? { calls: [
    call('write', { path: 'blocked-write.txt', content: 'unexpected write' }),
    call('bash', { command: 'printf unexpected > blocked-bash.txt' }),
  ] } : { text: 'This continuation must not be requested.' });
  try {
    await f.session.prompt(text('hello'), { turnId: 'local:greeting-block' });
    noToolsAdvertised(f.svc.bodies[0]);
    assert.equal(existsSync(join(f.cwd, 'blocked-write.txt')), false);
    assert.equal(existsSync(join(f.cwd, 'blocked-bash.txt')), false);
    assert.equal(f.svc.bodies.length, 1, 'the blocked tool attempt terminates without another model request');
    assert.equal(f.permissions.length, 0, 'a greeting never asks the person to approve an accidental tool');
    assert.equal(f.updates.some(update => update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update'), false, 'blocked attempts are not shown as executed tools');
    assert.equal(localReplies(f.updates).length, 1);
    assert.equal(localReplies(f.updates)[0].content.text, '你好，有什么需要我帮忙的？');
    const logPath = join(f.cwd, '.film', 'logs', 'local-greeting-block.model.jsonl');
    let logged = [];
    for (let attempt = 0; attempt < 100 && logged.length === 0; attempt += 1) {
      if (existsSync(logPath)) logged = readFileSync(logPath, 'utf8').trim().split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      if (logged.length === 0) await new Promise(resolve => setTimeout(resolve, 10));
    }
    const calls = logged.filter(entry => entry.kind === 'call');
    assert.equal(calls.length, 1, 'only the real model response is recorded for usage');
    assert.equal(calls[0].answer.usage.totalTokens, 18, 'local greeting does not invent model usage');
    assert.deepEqual(calls[0].tools, []);
    assert.ok(calls[0].messages.filter(message => message.role === 'system').every(message => !message.toolsAdded?.length), 'log reflects the actual sent declarations');
    assert.equal(calls[0].answer.content.some(block => block.type === 'text' && block.text.includes('有什么需要我')), false, 'host greeting is not attributed to the model');
    const historyDir = join(f.cwd, '.film', 'chat', 'agent');
    const history = readdirSync(historyDir).filter(name => name.endsWith('.jsonl')).map(name => readFileSync(join(historyDir, name), 'utf8')).join('\n');
    assert.match(history, /本轮只有问候/, 'the blocked tool result remains traceable in the Pi transcript');
    assert.match(history, /blocked-write/, 'the attempted input remains traceable');
  } finally { f.close(); }
});

test('a greeting stays tool-free after an earlier task and an actually skipped question', { timeout: 60000 }, async () => {
  let questions = 0;
  const f = await fixture((_, n) => n === 1 ? { calls: [call('ask', { questions: [{
    question: '片头选哪个样式？', header: '样式', options: [{ label: '简单' }, { label: '活泼' }],
  }] })] } : n === 2 ? { text: '已跳过，等你补充。' }
    : n === 3 ? { calls: [call('write', { path: 'old-task-resumed.txt', content: 'unexpected continuation' })] }
      : { text: 'Unexpected continuation.' }, { onQuestion: async () => { questions += 1; return null; } });
  try {
    await f.session.prompt(text('帮我做一个片头，先问我样式'));
    assert.equal(questions, 1);
    assert.equal(f.svc.bodies.length, 2);
    const toolResult = f.svc.bodies[1].messages.find(message => message.role === 'tool');
    assert.match(JSON.stringify(toolResult), /skipped/, 'the real ACP skip response is in model history');
    await f.session.prompt(text('您好'));
    assert.equal(f.svc.bodies.length, 3);
    noToolsAdvertised(f.svc.bodies[2]);
    assert.match(JSON.stringify(f.svc.bodies[2].messages), /帮我做一个片头/, 'the earlier task is retained, not deleted');
    assert.equal(existsSync(join(f.cwd, 'old-task-resumed.txt')), false);
  } finally { f.close(); }
});

test('the next explicit editing turn restores tools and executes the requested project write', { timeout: 60000 }, async () => {
  const f = await fixture((_, n) => n === 1 ? { calls: [call('write', { path: 'blocked.txt', content: 'not authorized' })] }
    : n === 2 ? { calls: [call('write', { path: 'film.html', content: '<!doctype html><title>Authorized fixture</title>' })] }
      : { text: '已按要求写好项目。' });
  try {
    await f.session.prompt(text('hi'));
    assert.equal(existsSync(join(f.cwd, 'blocked.txt')), false);
    assert.equal(localReplies(f.updates).length, 1);
    await f.session.prompt(text('帮我创建 film.html，写入标题 Authorized fixture，放到项目里'));
    assert.equal(f.svc.bodies.length, 3, 'one greeting request, then the usual tool-and-completion edit loop');
    normalToolsAdvertised(f.svc.bodies[1]);
    normalToolsAdvertised(f.svc.bodies[2]);
    assert.match(readFileSync(join(f.cwd, 'film.html'), 'utf8'), /Authorized fixture/);
    assert.equal(localReplies(f.updates).length, 1, 'host fallback state is not carried into the next turn');
    assert.equal(JSON.stringify(f.svc.bodies[1].messages).includes('你好，有什么需要我帮忙的？'), false, 'local fallback does not rewrite model history');
    assert.match(JSON.stringify(f.svc.bodies[1].messages), /本轮只有问候/, 'the real blocked result is retained');
    assert.equal(f.session.info.configOptions.find(option => option.id === 'model').currentValue, 'synthetic');
    assert.equal(f.permissions.length, 0);
    const completed = f.updates.filter(update => update.sessionUpdate === 'tool_call_update' && update.status === 'completed');
    assert.ok(completed.length >= 1, 'normal project editing still executes through the real tool');
  } finally { f.close(); }
});

test('a greeting followed by an editing request retains the ordinary automatic tool loop', { timeout: 60000 }, async () => {
  const f = await fixture((_, n) => n === 1
    ? { calls: [call('write', { path: 'film.html', content: '<!doctype html><title>Hello edit</title>' })] }
    : { text: '已完成。' });
  try {
    assert.equal(await f.session.prompt(text('你好，帮我剪好放到时间轴，先创建 film.html 项目')), 'end_turn');
    assert.equal(f.svc.bodies.length, 2, 'normal primary-model tool loop only; no reviewer call');
    normalToolsAdvertised(f.svc.bodies[0]);
    assert.match(readFileSync(join(f.cwd, 'film.html'), 'utf8'), /Hello edit/);
    assert.equal(f.permissions.length, 0);
  } finally { f.close(); }
});

test('Responses API enforces greeting tools-none and restores the next explicit editing turn', { timeout: 60000 }, async () => {
  const f = await fixture((_, n) => n === 1
    ? { calls: [call('write', { path: 'blocked-responses.txt', content: 'must not run' })] }
    : n === 2 ? { calls: [call('write', { path: 'film.html', content: '<!doctype html><title>Responses edit</title>' })] }
      : { text: '已完成 Responses 项目。' }, { api: 'openai-responses' });
  try {
    await f.session.prompt(text('你好'));
    assert.equal(f.svc.bodies.length, 1);
    noToolsAdvertised(f.svc.bodies[0]);
    assert.ok(Array.isArray(f.svc.bodies[0].input), 'the tested transport is actually Responses');
    assert.equal(existsSync(join(f.cwd, 'blocked-responses.txt')), false);
    assert.equal(localReplies(f.updates).length, 1);
    assert.equal(f.updates.some(update => update.sessionUpdate === 'tool_call'), false);
    await f.session.prompt(text('帮我创建 film.html，写入标题 Responses edit'));
    assert.equal(f.svc.bodies.length, 3, 'no additional review request for the allowed tool');
    normalToolsAdvertised(f.svc.bodies[1]);
    normalToolsAdvertised(f.svc.bodies[2]);
    assert.match(readFileSync(join(f.cwd, 'film.html'), 'utf8'), /Responses edit/);
    assert.equal(f.permissions.length, 0);
    assert.ok(f.updates.some(update => update.sessionUpdate === 'agent_message_chunk' && update.content?.text?.includes('已完成')));
  } finally { f.close(); }
});

test('a model greeting plus an ignored forbidden tool keeps its answer without a duplicate host reply', { timeout: 60000 }, async () => {
  const f = await fixture(() => ({ text: '你好，我在。', calls: [call('write', { path: 'blocked-with-text.txt', content: 'unexpected' })] }));
  try {
    await f.session.prompt(text('你好'));
    assert.equal(f.svc.bodies.length, 1);
    assert.equal(existsSync(join(f.cwd, 'blocked-with-text.txt')), false);
    assert.equal(replies(f.updates).map(update => update.content.text).join(''), '你好，我在。');
    assert.equal(localReplies(f.updates).length, 0);
    assert.equal(f.updates.some(update => update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update'), false);
  } finally { f.close(); }
});
