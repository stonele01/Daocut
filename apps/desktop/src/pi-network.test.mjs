import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { Agent, fetch as undiciFetch } from 'undici';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { createModelDispatcher, networkFetch } from './pi-network.mjs';
import { AgentSession } from './agents.mjs';
import { logsDir } from './chat-store.mjs';

// Synthetic errors and a loopback server only: no remote model or real API key.
test('fetch failure preserves its original identity and logs nested transport fields without secrets', async () => {
  const secret = 'sk-private-test-secret';
  const first = Object.assign(new Error(secret), { code: 'ECONNRESET', errno: -4077, syscall: 'read', headers: { authorization: secret } });
  const second = Object.assign(new Error(secret), { code: 'ETIMEDOUT', syscall: 'connect', body: secret });
  const error = new TypeError(secret, { cause: new AggregateError([first, second], secret) });
  first.cause = error;
  const records = [];
  const input = `https://user:${secret}@service.test/v1/chat/completions?api_key=${secret}#${secret}`;
  const init = { method: 'POST', headers: { authorization: secret }, body: secret };
  const fetch = networkFetch(async (sent, options) => {
    assert.equal(sent, input);
    assert.equal(options, init);
    throw error;
  }, (record) => records.push(record));
  await assert.rejects(fetch(input, init), (caught) => caught === error);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].request, { origin: 'https://service.test', pathname: '/v1/chat/completions', method: 'POST' });
  assert.deepEqual(records[0].error, { name: 'TypeError', cause: { name: 'AggregateError', errors: [
    { name: 'Error', code: 'ECONNRESET', errno: -4077, syscall: 'read' },
    { name: 'Error', code: 'ETIMEDOUT', syscall: 'connect' },
  ] } });
  assert.ok(records[0].ms >= 0);
  assert.ok(records[0].startedAt > 0);
  assert.ok(!JSON.stringify(records).includes(secret));
});

test('HTTP responses and failed log writes do not change fetch behavior', async () => {
  const response = new Response('unchanged', { status: 503 });
  const records = [];
  const input = new Request('https://service.test/v1', { method: 'POST' });
  const fetch = networkFetch(async (sent, init) => { assert.equal(sent, input); assert.equal(init, undefined); return response; }, (record) => records.push(record));
  assert.equal(await fetch(input), response);
  assert.equal(await response.text(), 'unchanged');
  assert.deepEqual(records, []);
  const error = new TypeError('original');
  const failed = networkFetch(async () => { throw error; }, () => { throw new Error('log failed'); });
  await assert.rejects(failed(input), (caught) => caught === error);
});

test('malformed URLs and non-Error rejections are not copied into diagnostics', async () => {
  const secret = 'sk-private-test-secret';
  const records = [];
  const fetch = networkFetch(async () => { throw secret; }, (record) => records.push(record));
  await assert.rejects(fetch(secret, { method: secret }), (caught) => caught === secret);
  assert.deepEqual(records[0].request, {});
  assert.deepEqual(records[0].error, {});
  assert.ok(!JSON.stringify(records).includes(secret));
});

async function modelRecords(cwd, turnId, expectedCalls) {
  const file = join(logsDir(cwd), `${turnId.replace(/:/g, '-')}.model.jsonl`);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const records = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      if (records.filter((r) => r.kind === 'call').length === expectedCalls) return records;
    } catch { /* The child's log stream may still be flushing. */ }
    await new Promise((done) => setTimeout(done, 20));
  }
  assert.fail(`The model log did not finish: ${turnId}`);
}

test('the real Pi SDK forwards options.fetch, logs causes per turn and preserves its single retry', { timeout: 60_000 }, async () => {
  const tempRoot = resolve(import.meta.dirname, '../../../.test-temp');
  mkdirSync(tempRoot, { recursive: true });
  const dir = mkdtempSync(join(tempRoot, 'pi-network-'));
  const cwd = join(dir, 'project');
  mkdirSync(cwd);
  let mode = 'fail';
  let requests = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      requests += 1;
      if (mode === 'fail' || (mode === 'recover' && requests === 1)) { req.socket.destroy(); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta, finish_reason) => `data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 0, model: 'local', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      res.end(chunk({ role: 'assistant', content: 'ok' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n');
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  const updates = [];
  const session = new AgentSession({
    agent: 'byok', cwd,
    harness: { home: join(dir, 'home'), models: [{ id: 'local', name: 'local', api: 'openai-completions', baseUrl: url, keyEnv: 'DAOCUT_BYOK_NETWORK_TEST', model: 'local', levels: ['auto'], effort: 'auto' }], model: 'local', env: { DAOCUT_BYOK_NETWORK_TEST: 'sk-local-test-only' } },
    onUpdate: (update) => updates.push(update),
  });
  try {
    await session.start();
    await assert.rejects(session.prompt([{ type: 'text', text: 'hi' }], { turnId: 'local:networkfail' }), /Connection error/);
    assert.equal(requests, 2, 'one initial attempt and one retry');
    assert.equal(updates.filter((u) => u.sessionUpdate === 'notice').length, 1);
    const failed = await modelRecords(cwd, 'local:networkfail', 2);
    const failures = failed.filter((r) => r.kind === 'network_error');
    assert.equal(failures.length, 2, 'the SDK reached the injected fetch wrapper on both attempts');
    for (const record of failures) {
      assert.equal(record.error.name, 'TypeError');
      assert.equal(record.error.cause.code, 'UND_ERR_SOCKET');
      assert.deepEqual(record.request, { origin: url.replace('/v1', ''), pathname: '/v1/chat/completions', method: 'POST' });
      assert.ok(!JSON.stringify(record).includes('sk-local-test-only'));
      assert.ok(!JSON.stringify(record).includes('message'));
    }
    mode = 'recover'; requests = 0; updates.length = 0;
    assert.equal(await session.prompt([{ type: 'text', text: 'try again' }], { turnId: 'local:networkrecover' }), 'end_turn');
    assert.equal(requests, 2);
    assert.equal(updates.filter((u) => u.sessionUpdate === 'notice').length, 1);
    const recovered = await modelRecords(cwd, 'local:networkrecover', 2);
    assert.equal(recovered.filter((r) => r.kind === 'network_error').length, 1);
    mode = 'success'; requests = 0;
    assert.equal(await session.prompt([{ type: 'text', text: 'go on' }], { turnId: 'local:networksuccess' }), 'end_turn');
    assert.equal(requests, 1);
    assert.equal((await modelRecords(cwd, 'local:networksuccess', 1)).filter((r) => r.kind === 'network_error').length, 0);
    assert.deepEqual(await modelRecords(cwd, 'local:networkfail', 2), failed, 'a later turn does not alter the earlier failure log');
  } finally {
    const exited = session.child && session.child.exitCode === null ? new Promise((done) => session.child.once('exit', done)) : Promise.resolve();
    session.close();
    await exited;
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    // Delete only this test's freshly created directory within the project test root.
    assert.ok(resolve(dir).startsWith(`${tempRoot}${sep}`));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the Responses API also forwards fetch and settles after two connection failures', { timeout: 60_000 }, async () => {
  const tempRoot = resolve(import.meta.dirname, '../../../.test-temp');
  mkdirSync(tempRoot, { recursive: true });
  const dir = mkdtempSync(join(tempRoot, 'pi-network-responses-'));
  const cwd = join(dir, 'project');
  mkdirSync(cwd);
  const paths = [];
  const server = createServer((req) => {
    req.resume();
    req.on('end', () => { paths.push(req.url); req.socket.destroy(); });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const updates = [];
  const session = new AgentSession({
    agent: 'byok', cwd,
    harness: { home: join(dir, 'home'), models: [{ id: 'responses', name: 'responses', api: 'openai-responses', baseUrl: `${origin}/v1`, keyEnv: 'DAOCUT_BYOK_NETWORK_TEST', model: 'responses', levels: ['auto'], effort: 'auto' }], model: 'responses', env: { DAOCUT_BYOK_NETWORK_TEST: 'sk-local-test-only' } },
    onUpdate: (update) => updates.push(update),
  });
  try {
    await session.start();
    await assert.rejects(session.prompt([{ type: 'text', text: 'hi' }], { turnId: 'local:networkresponses' }), /Connection error/);
    assert.deepEqual(paths, ['/v1/responses', '/v1/responses'], 'one initial request and one retry through the actual Responses API');
    assert.equal(updates.filter((u) => u.sessionUpdate === 'notice').length, 1);
    const failures = (await modelRecords(cwd, 'local:networkresponses', 2)).filter((r) => r.kind === 'network_error');
    assert.equal(failures.length, 2);
    for (const record of failures) {
      assert.equal(record.error.name, 'TypeError');
      assert.equal(record.error.cause.code, 'UND_ERR_SOCKET');
      assert.deepEqual(record.request, { origin, pathname: '/v1/responses', method: 'POST' });
    }
  } finally {
    const exited = session.child && session.child.exitCode === null ? new Promise((done) => session.child.once('exit', done)) : Promise.resolve();
    session.close();
    await exited;
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    assert.ok(resolve(dir).startsWith(`${tempRoot}${sep}`));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('only the official DeepSeek HTTPS origin gets TLS 1.2; other transport and certificate defaults stay unchanged', async (t) => {
  const calls = [];
  const connectionError = Object.assign(new Error('synthetic connection failure'), { code: 'ECONNREFUSED' });
  const connect = (transport) => (options) => {
    calls.push({ transport, options });
    const socket = new net.Socket();
    queueMicrotask(() => socket.destroy(connectionError));
    return socket;
  };
  // Exercise the actual Agent -> Pool -> connector without opening any network connection.
  t.mock.method(tls, 'connect', connect('tls'));
  t.mock.method(net, 'connect', connect('tcp'));
  const waitMs = 15 * 60_000;
  const baseline = new Agent({ headersTimeout: waitMs, bodyTimeout: waitMs });
  const dispatcher = createModelDispatcher(waitMs);
  const connectionFor = async (url, selected) => {
    const before = calls.length;
    await assert.rejects(undiciFetch(url, { dispatcher: selected }), (error) => error.cause === connectionError);
    assert.equal(calls.length, before + 1);
    return calls.at(-1);
  };
  try {
    for (const url of [
      'https://api.deepseek.com/v1/responses',
      'https://API.DEEPSEEK.COM:443/v1/chat/completions',
    ]) {
      const expected = await connectionFor(url, baseline);
      const actual = await connectionFor(url, dispatcher);
      assert.deepEqual(actual, { ...expected, options: { ...expected.options, maxVersion: 'TLSv1.2' } }, url);
      assert.notEqual(actual.options.rejectUnauthorized, false, 'certificate verification remains enabled');
      assert.deepEqual(actual.options.ALPNProtocols, expected.options.ALPNProtocols, 'HTTP/2 negotiation stays at the existing default');
    }
    for (const url of [
      'https://api.deepseek.com:8443/v1/responses',
      'http://api.deepseek.com/v1/responses',
      'http://api.deepseek.com:443/v1/responses',
      'https://api.deepseek.com.proxy.test/v1/responses',
      'https://proxy.api.deepseek.com/v1/responses',
      'https://api.deepseek.com./v1/responses',
      'https://gateway.test/deepseek/v1/responses',
      'https://api.openai.com/v1/responses',
    ]) {
      const expected = await connectionFor(url, baseline);
      assert.deepEqual(await connectionFor(url, dispatcher), expected, url);
    }
  } finally {
    await Promise.all([baseline.destroy(), dispatcher.destroy()]);
  }
});
