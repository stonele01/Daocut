import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SessionManager } from '@earendil-works/pi-coding-agent';
const { AgentSession } = await import(process.env.DAOCUT_TEST_PACKAGED_SRC
  ? pathToFileURL(join(process.env.DAOCUT_TEST_PACKAGED_SRC, 'agents.mjs')).href : './agents.mjs');
import { agentSessionsDir } from './chat-store.mjs';
import { summarizeUsage } from './model-usage.mjs';

/* Actual ACP + installed Pi SDK + loopback transports. Synthetic sessions and keys only; repository-local files. */
const tempRoot = fileURLToPath(new URL('../.release/manual-compaction-integration/', import.meta.url));
mkdirSync(tempRoot, { recursive: true });
const text = value => [{ type: 'text', text: value }];
const checkpoint = 'CHECKPOINT: goal product A; keep subtitles, no music; confirmed D:/assets/a.mp4 00:05.120 to 00:21.450; edit completed, export next after approval.';
const usage = { input: 45000, output: 60, cacheRead: 0, cacheWrite: 0, totalTokens: 45060, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = content => ({ role: 'assistant', content: typeof content === 'string' ? text(content) : content,
  api: 'openai-responses', provider: 'byok-fixture', model: 'fixture', stopReason: 'stop', usage, timestamp: Date.now() });
const statuses = updates => updates.flatMap(u => u._meta?.['daocut/compaction'] ? [u._meta['daocut/compaction']] : []);
const history = cwd => readdirSync(agentSessionsDir(cwd)).filter(f => f.endsWith('.jsonl')).flatMap(f => readFileSync(join(agentSessionsDir(cwd), f), 'utf8').trim().split('\n').map(JSON.parse));
const messages = cwd => history(cwd).filter(e => e.type === 'message');
async function until(check) {
  for (let i = 0; i < 500; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('Synthetic test condition did not settle');
}

function responsesSse(result, model, n) {
  let sequence = 0;
  const event = (type, data) => 'event: ' + type + '\ndata: ' + JSON.stringify({ type, sequence_number: sequence++, ...data }) + '\n\n';
  const response = { id: 'resp_compact_' + n, object: 'response', created_at: 0, status: 'in_progress', model, output: [] };
  let wire = event('response.created', { response });
  const output = result.tool ? [{ type: 'function_call', id: 'fc_' + n, call_id: 'call_' + n,
    name: 'write', arguments: JSON.stringify({ path: 'forbidden-summary-edit.txt', content: 'must not run' }), status: 'completed' }]
    : [{ type: 'message', id: 'msg_' + n, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: result.text ?? checkpoint, annotations: [] }] }];
  output.forEach((item, output_index) => {
    wire += event('response.output_item.added', { output_index, item: { ...item, status: 'in_progress', ...(item.type === 'function_call' ? { arguments: '' } : { content: [] }) } });
    if (item.type === 'function_call') {
      wire += event('response.function_call_arguments.delta', { item_id: item.id, output_index, delta: item.arguments });
      wire += event('response.function_call_arguments.done', { item_id: item.id, output_index, arguments: item.arguments });
    } else wire += event('response.output_text.delta', { item_id: item.id, output_index, content_index: 0, delta: item.content[0].text });
    wire += event('response.output_item.done', { output_index, item });
  });
  const limited = result.finish === 'length';
  return wire + event(limited ? 'response.incomplete' : 'response.completed', { response: { ...response,
    status: limited ? 'incomplete' : 'completed', ...(limited ? { incomplete_details: { reason: 'max_output_tokens' } } : {}), output,
    usage: { input_tokens: 45000, input_tokens_details: { cached_tokens: 0 }, output_tokens: limited ? 8000 : 60,
      output_tokens_details: { reasoning_tokens: 0 }, total_tokens: limited ? 53000 : 45060 },
  } });
}

async function fixture(reply = () => ({}), { seed = true, api = 'openai-responses', maxOutputTokens = 32000, onUpdate, quota } = {}) {
  const root = mkdtempSync(join(tempRoot, 'case-'));
  const cwd = join(root, 'project'), home = join(root, 'agent-home'), scratch = join(root, 'temp');
  for (const path of [cwd, home, scratch]) mkdirSync(path);
  let resume;
  if (seed) {
    const manager = SessionManager.create(cwd, agentSessionsDir(cwd));
    manager.appendMessage({ role: 'user', content: 'EARLY ORIGINAL: goal product A; keep subtitles; no music.', timestamp: 1 });
    manager.appendMessage(assistant('Confirmed edit D:/assets/a.mp4 00:05.120 to 00:21.450. Export needs approval. ' + 'Old checked history. '.repeat(6000)));
    manager.appendMessage({ role: 'user', content: 'RECENT RETAINED: timeline verified.', timestamp: 3 });
    manager.appendMessage(assistant('Recent project context. '.repeat(4200)));
    manager.appendMessage(assistant([{ type: 'toolCall', id: 'paired-read', name: 'read', arguments: { path: 'film.html' } }]));
    manager.appendMessage({ role: 'toolResult', toolCallId: 'paired-read', toolName: 'read', content: text('Checked timeline'), isError: false, timestamp: 5 });
    manager.appendMessage(assistant('Waiting for the next approved action.'));
    resume = manager.getSessionId();
  }
  const bodies = [], paths = [], updates = [], permissions = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const request = JSON.parse(body || '{}');
      bodies.push(request); paths.push(req.url);
      const result = reply(request, bodies.length);
      if (result.error) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: result.error } })); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (result.hold) { res.flushHeaders(); return; }
      if (req.url.endsWith('/responses')) { res.end(responsesSse(result, request.model, bodies.length)); return; }
      const chunk = (delta, finish_reason = null, usage) => 'data: ' + JSON.stringify({ id: 'compact-' + bodies.length, object: 'chat.completion.chunk', created: 0, model: request.model,
        choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) }) + '\n\n';
      res.end(chunk({ role: 'assistant', content: result.text ?? checkpoint }) + chunk({}, result.finish ?? 'stop', { prompt_tokens: 45000, completion_tokens: 60, total_tokens: 45060 }) + 'data: [DONE]\n\n');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const pricing = { currency: 'CNY', input: 2, output: 8 };
  const session = new AgentSession({ agent: 'byok', cwd, resume, quota, env: { TEMP: scratch, TMP: scratch },
    harness: { home, model: 'fixture', models: [{ id: 'fixture', name: 'Synthetic fixture', api,
      baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', keyEnv: 'DAOCUT_COMPACT_TEST_KEY', model: 'fixture', levels: ['auto'], effort: 'auto', pricing, maxOutputTokens }],
      env: { DAOCUT_COMPACT_TEST_KEY: 'synthetic-loopback-only', TEMP: scratch, TMP: scratch } },
    onUpdate: update => { updates.push(update); onUpdate?.(update, session); },
    onPermission: async request => { permissions.push(request); return null; },
  });
  const close = () => { session.close(); server.closeAllConnections(); server.close(); };
  try { await session.start(); } catch (error) { close(); throw error; }
  return { session, cwd, bodies, paths, updates, permissions, pricing, close };
}

for (const api of ['openai-responses', 'openai-completions']) {
  test('manual /compact uses native summary only, then next turn uses checkpoint and recent history: ' + api, { timeout: 60000 }, async () => {
    // Long assistant/tool history splits a turn; Pi makes a history summary and a prefix summary.
    const summaryCalls = 2;
    const f = await fixture((_, n) => ({ text: n <= summaryCalls ? checkpoint : 'Next task acknowledged.' }), { api });
    try {
      const original = messages(f.cwd);
      const logs = join(f.cwd, '.film', 'logs');
      mkdirSync(logs, { recursive: true });
      writeFileSync(join(logs, 'local-manual.jsonl'), JSON.stringify({ kind: 'prompt', agent: 'byok', t: Date.now() }) + '\n');
      assert.equal(await f.session.prompt(text(' /compact '), { turnId: 'local:manual' }), 'end_turn');
      assert.equal(f.bodies.length, summaryCalls, 'only Pi history/prefix summaries, no editing continuation');
      assert.equal(f.bodies[0].tools?.length ?? 0, 0, 'summary has no editing tools');
      assert.match(JSON.stringify(f.bodies[0]), /acceptance criteria/);
      assert.match(JSON.stringify(f.bodies[0]), /authorization boundaries/);
      assert.match(JSON.stringify(f.bodies[0]), /next tasks in order/);
      assert.ok(f.updates.some(u => u.sessionUpdate === 'available_commands_update' && u.availableCommands.some(c => c.name === 'compact')));
      assert.deepEqual(statuses(f.updates).map(s => s.status), ['in_progress', 'completed']);
      assert.ok(statuses(f.updates).at(-1).estimatedTokensAfter < statuses(f.updates).at(-1).tokensBefore);
      assert.ok(f.updates.some(u => u._meta?.['daocut/contextUsage'] === null), 'native unknown context is not replaced by the estimate');
      assert.equal(f.updates.some(u => u.sessionUpdate === 'tool_call'), false);
      assert.deepEqual(f.permissions, []);
      assert.deepEqual(messages(f.cwd), original, 'slash command and local status do not enter model history');
      const compactions = history(f.cwd).filter(e => e.type === 'compaction');
      assert.equal(compactions.length, 1);
      assert.match(compactions[0].summary, /CHECKPOINT/);
      const logPath = join(logs, 'local-manual.model.jsonl');
      await until(() => existsSync(logPath) && readFileSync(logPath, 'utf8').includes('"kind":"call"'));
      const calls = readFileSync(logPath, 'utf8').trim().split('\n').map(JSON.parse).filter(e => e.kind === 'call');
      assert.equal(calls.length, summaryCalls);
      assert.equal(calls[0].answer.usage.output, 60);
      assert.deepEqual(calls[0].pricing, f.pricing);
      const billed = summarizeUsage(calls); // same receipt aggregation used by UsageSummary/TurnLog
      assert.equal(billed.calls, summaryCalls);
      assert.equal(billed.total, 45060 * summaryCalls);
      assert.equal(billed.unpriced, 0);
      assert.ok(Math.abs(billed.costs.CNY - 0.09048 * summaryCalls) < 1e-10);
      assert.equal(JSON.stringify(calls).includes('synthetic-loopback-only'), false);
      assert.equal(await f.session.prompt(text('/compact')), 'end_turn');
      assert.equal(f.bodies.length, summaryCalls, 'repeat compaction has a local no-op reply');
      assert.equal(statuses(f.updates).at(-1).status, 'skipped');
      assert.equal(await f.session.prompt(text('Describe the next approved step.')), 'end_turn');
      assert.equal(f.bodies.length, summaryCalls + 1);
      const continued = JSON.stringify(f.bodies[summaryCalls]);
      assert.match(continued, /CHECKPOINT/);
      assert.match(continued, /RECENT RETAINED/);
      assert.equal(continued.includes('EARLY ORIGINAL'), true, 'original user constraints survive independently of model summary');
      assert.equal(continued.includes('Old checked history. '.repeat(100)), false, 'old assistant chronology is replaced in the projection, still archived locally');
      assert.ok(f.bodies[summaryCalls].tools.length > 0, 'ordinary tools are restored on the next explicit task');
      assert.ok(f.updates.some(u => u.sessionUpdate === 'usage_update' && u.used === 45060));
      assert.deepEqual(f.paths, Array(summaryCalls + 1).fill(api === 'openai-responses' ? '/v1/responses' : '/v1/chat/completions'));
    } finally { f.close(); }
  });
}

for (const [label, failure] of [
  ['incomplete output', { text: 'INCOMPLETE MUST NOT BE SAVED', finish: 'length' }],
  ['provider error', { error: 'Synthetic provider rejected the summary' }],
  ['tool call in summary', { tool: true }],
]) {
  test('manual compaction rejects ' + label + ' and keeps history for the next turn', { timeout: 60000 }, async () => {
    const failedAttempts = label === 'incomplete output' ? 2 : 1;
    const f = await fixture((_, n) => n <= failedAttempts ? failure : { text: 'Resumed original history.' }, { maxOutputTokens: 8000 });
    try {
      const original = messages(f.cwd);
      await assert.rejects(f.session.prompt(text('/compact')), /原对话内容已保留/);
      assert.deepEqual(messages(f.cwd), original);
      assert.equal(history(f.cwd).some(e => e.type === 'compaction'), false);
      assert.deepEqual(statuses(f.updates).map(s => s.status), ['in_progress', 'failed']);
      assert.equal(f.bodies.length, failedAttempts);
      assert.equal(existsSync(join(f.cwd, 'forbidden-summary-edit.txt')), false);
      assert.equal(f.updates.some(u => u.sessionUpdate === 'tool_call'), false);
      assert.equal(await f.session.prompt(text('Keep the original plan.')), 'end_turn');
      assert.match(JSON.stringify(f.bodies[failedAttempts]), /EARLY ORIGINAL/);
      assert.match(JSON.stringify(f.bodies[failedAttempts]), /RECENT RETAINED/);
      assert.equal(JSON.stringify(f.bodies[failedAttempts]).includes('INCOMPLETE MUST NOT BE SAVED'), false);
    } finally { f.close(); }
  });
}

test('ACP cancel aborts an in-flight manual summary, preserves history and allows the next turn', { timeout: 60000 }, async () => {
  const f = await fixture((_, n) => n === 1 ? { hold: true } : { text: 'Original task retained.' });
  try {
    const original = messages(f.cwd);
    const pending = f.session.prompt(text('/compact'));
    await until(() => f.bodies.length === 1);
    await f.session.cancel();
    assert.equal(await pending, 'cancelled');
    assert.deepEqual(statuses(f.updates).map(s => s.status), ['in_progress', 'cancelled']);
    assert.deepEqual(messages(f.cwd), original);
    assert.equal(history(f.cwd).some(e => e.type === 'compaction'), false);
    assert.equal(f.bodies.length, 1);
    assert.equal(await f.session.prompt(text('Continue only when I ask.')), 'end_turn');
    assert.match(JSON.stringify(f.bodies[1]), /EARLY ORIGINAL/);
  } finally { f.close(); }
});

test('empty conversation compaction is local; prose, arguments, multiple blocks and attachments are not slash commands', { timeout: 60000 }, async () => {
  const f = await fixture(() => ({ text: 'Ordinary response.' }), { seed: false });
  try {
    assert.equal(await f.session.prompt(text('/compact')), 'end_turn');
    assert.equal(f.bodies.length, 0);
    assert.equal(statuses(f.updates).at(-1).status, 'skipped');
    for (const blocks of [text('Please explain /compact'), text('/compact keep goals'), text('压缩一下上下文'),
      [...text('/compact'), ...text('quoted command')], [...text('/compact'), { type: 'resource_link', uri: 'file:///synthetic.txt', name: 'synthetic.txt' }]]) {
      assert.equal(await f.session.prompt(blocks), 'end_turn');
    }
    assert.equal(f.bodies.length, 5);
    assert.ok(f.bodies.every(body => body.tools?.length > 0));
    assert.deepEqual(statuses(f.updates).map(s => s.status), ['in_progress', 'skipped']);
  } finally { f.close(); }
});


test('company quota covers manual history, prefix and length recovery summaries with original model budgets', { timeout: 60000 }, async () => {
  const reservations = [], receipts = [];
  const quota = { capture: () => ({ userId: 'employee', epoch: 1 }), reserve: async input => { reservations.push(input); return { id: input.id, status: 'reserved' }; }, settle: async ({ event }) => { receipts.push(event); return {}; } };
  const f = await fixture((_, n) => n === 1 ? { finish: 'length', text: 'INCOMPLETE' } : { text: checkpoint }, { quota });
  try {
    const original = messages(f.cwd);
    assert.equal(await f.session.prompt(text('/compact'), { turnId: 'local:quota-summary' }), 'end_turn');
    assert.equal(f.bodies.length, 3); assert.equal(reservations.length, 3); assert.equal(receipts.length, 3);
    assert.equal(new Set(reservations.map(x => x.id)).size, 3);
    assert.deepEqual(receipts.map(x => x.id), reservations.map(x => x.id));
    assert.deepEqual(f.bodies.slice(0, 2).map(x => x.max_output_tokens), [13107, 26214], 'original native Responses summary cap and one recovery, no quota reduction');
    assert.deepEqual(messages(f.cwd), original);
    await until(() => existsSync(join(f.cwd, '.film/logs/local-quota-summary.model.jsonl')));
    await new Promise(resolve => setTimeout(resolve, 50));
    const calls = readFileSync(join(f.cwd, '.film/logs/local-quota-summary.model.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(x => x.kind === 'call');
    assert.deepEqual(calls.map(x => x.quotaRequestId), reservations.map(x => x.id));
  } finally { f.close(); }
});
