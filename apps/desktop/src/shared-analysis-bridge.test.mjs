import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createCompanyClient, companyRequest } from './company-client.mjs';
import { createDesktopTextService } from './desktop-analysis-service.mjs';
import { createDesktopAnalysisServices } from '../../../packages/daocut/studio/server/desktop-analysis-services.mjs';

const taskKey = 'a'.repeat(64), inputHash = 'b'.repeat(64);
const user = { id: 'mock-employee', username: 'mock', role: 'user', enabled: true };
const profile = { name: 'Isolated company', serverUrl: 'https://company.invalid', caPem: '' };
async function fixture(t) {
  const base = resolve('.tmp/shared-v2-20261105/desktop'); mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'bridge-'));
  t.after(() => { assert.ok(dir.startsWith(base)); rmSync(dir, { recursive: true, force: true }); });
  const calls = []; let response = { task: null };
  const client = createCompanyClient({ dataDir: dir, appVersion: 'test', request: async (_profile, endpoint, options) => {
    if (endpoint === '/login') return { user, token: 'synthetic-auth-only-main' };
    if (endpoint === '/session') return { user };
    calls.push({ endpoint, options });
    if (response instanceof Error) throw response;
    return response;
  } });
  client.configure(profile); await client.login({ username: 'mock', password: 'synthetic' });
  return { client, calls, reply: value => { response = value; } };
}

test('normal desktop exposes metadata coordination without using audio, model configuration or model fetch', async t => {
  const f = await fixture(t); let models = 0;
  const bridge = createDesktopTextService({ company: () => f.client, roster: () => { models++; throw Error('model must not be read'); }, fetch: () => { throw Error('no model request'); } });
  const services = createDesktopAnalysisServices({ textBridge: bridge });
  assert.equal(typeof services.sharedAnalysis?.coordinate, 'function');
  const result = await services.sharedAnalysis.coordinate('status', { taskKey });
  assert.equal(result.task, null); assert.equal(models, 0);
  assert.deepEqual(f.calls.map(call => [call.endpoint, call.options.body]), [['/shared-analysis/status', { taskKey }]]);
  assert.equal(JSON.stringify(result).includes('synthetic-auth-only-main'), false);
});

test('shared task mutations are forwarded once with main-process authorization and a stable coordinator identity', async t => {
  const f = await fixture(t);
  const claim = { taskKey, inputHash, clientAttemptId: 'mock-attempt' };
  const value = await f.client.sharedAnalysis('claim', claim);
  assert.equal(value.coordinationId, createHash('sha256').update(JSON.stringify({ serverUrl: profile.serverUrl, caPem: profile.caPem })).digest('hex'));
  assert.equal(f.calls[0].options.token, 'synthetic-auth-only-main');
  await f.client.sharedAnalysis('submitted', { taskKey, attemptId: 'mock-attempt', expectedCoordinatorId: value.coordinationId });
  assert.deepEqual(f.calls[1].options.body, { taskKey, attemptId: 'mock-attempt' });
  assert.equal(f.calls.length, 2);
});

test('the metadata bridge rejects unknown actions, transcript bodies and unsafe result paths before transport', async t => {
  const f = await fixture(t);
  for (const [action, body] of [
    ['../session', { taskKey }], ['status', { taskKey, transcript: 'must stay local' }],
    ['claim', { taskKey, inputHash, clientAttemptId: 'mock', ownerId: 'forged' }],
    ['status', { taskKey: 'must not send transcript as a task ID' }], ['claim', { taskKey }], ['status', {}],
    ['fail', { taskKey, attemptId: 'mock', reason: 'must not send transcript as a reason' }],
    ['claim', { taskKey, inputHash, clientAttemptId: 'must not send transcript as an attempt' }],
    ['complete', { taskKey, attemptId: 'mock', result: { path: '../escape.json', sha256: inputHash, schema: 'daocut.shared-analysis.v1' } }],
    ['complete', { taskKey, attemptId: 'mock', result: { path: 'objects/a.json', sha256: inputHash, schema: 'daocut.shared-analysis.v1', transcript: 'secret' } }],
  ]) await assert.rejects(async () => f.client.sharedAnalysis(action, body));
  assert.equal(f.calls.length, 0);
});

test('production company transport allows only the shared metadata endpoints including version discovery', async t => {
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    calls.push({ path: req.url, token: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) });
    res.setHeader('content-type', 'application/json'); res.end('{"task":null}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(done => server.close(done)));
  const local = { ...profile, serverUrl: `http://127.0.0.1:${server.address().port}` };
  for (const action of ['status', 'claim', 'submitted', 'complete', 'fail', 'retry', 'versions']) {
    await companyRequest(local, '/shared-analysis/' + action, { allowLoopbackHttp: true, method: 'POST', token: 'synthetic', body: { taskKey } });
  }
  await assert.rejects(companyRequest(local, '/shared-analysis/delete', { allowLoopbackHttp: true }));
  assert.equal(calls.length, 7); assert.ok(calls.every(call => call.token === 'Bearer synthetic'));
});

test('coordinator change is blocked and ownership rejection does not log out an otherwise valid account', async t => {
  const f = await fixture(t);
  await assert.rejects(async () => f.client.sharedAnalysis('submitted', { taskKey, attemptId: 'mock', expectedCoordinatorId: 'c'.repeat(64) }), /公司服务/);
  assert.equal(f.calls.length, 0);
  f.reply(Object.assign(new Error('另一个账号的任务'), { code: 'SHARED_NOT_OWNER', status: 403 }));
  await assert.rejects(f.client.sharedAnalysis('submitted', { taskKey, attemptId: 'mock' }), /另一个账号/);
  assert.equal(f.client.state().status, 'signed-in');
});

test('lost coordinator response is not retried and unavailable company service cannot fall through to a model', async t => {
  const f = await fixture(t); f.reply(Object.assign(new Error('mock timeout'), { status: 0 }));
  await assert.rejects(f.client.sharedAnalysis('submitted', { taskKey, attemptId: 'mock' }), /mock timeout/);
  assert.equal(f.calls.length, 1);
  const bridge = createDesktopTextService({ company: () => null, roster: () => null, fetch: () => { throw Error('no request'); } });
  await assert.rejects(bridge({ operation: 'shared-coordinate', action: 'claim', body: { taskKey, inputHash, clientAttemptId: 'mock' } }), /公司/);
});

test('already transcribed segments can be marked for review without resending audio or transcript bodies', async t => {
  const f = await fixture(t);
  f.reply({ task: { status: 'needs-review' } });
  const result = await f.client.sharedAnalysis('fail', { taskKey, attemptId: 'mock', reason: 'needs-review' });
  assert.equal(result.task.status, 'needs-review');
  assert.deepEqual(f.calls[0].options.body, { taskKey, attemptId: 'mock', reason: 'needs-review' });
  assert.equal(f.calls.length, 1);
});

test('desktop version inspection and new version claims send only stable metadata and never execute a model', async t => {
  const f = await fixture(t);
  f.reply({ versions: [{ taskKey, sequence: 1, status: 'complete', result: { path: 'results/test.json', sha256: inputHash, schema: 'daocut.shared-analysis.v1' } }] });
  const bridge = createDesktopTextService({ company: () => f.client, roster: () => { throw Error('version read must not load model'); }, fetch: () => { throw Error('no model'); } });
  const services = createDesktopAnalysisServices({ textBridge: bridge });
  const found = await services.sharedAnalysis.coordinate('versions', { taskKey });
  assert.equal(found.versions.length, 1);
  await services.sharedAnalysis.coordinate('claim', { taskKey: 'c'.repeat(64), familyKey: taskKey, baseResultSha256: inputHash, inputHash, clientAttemptId: 'new-version-1' });
  assert.deepEqual(f.calls.map(call => call.options.body), [{ taskKey }, { taskKey: 'c'.repeat(64), familyKey: taskKey, baseResultSha256: inputHash, inputHash, clientAttemptId: 'new-version-1' }]);
  await assert.rejects(f.client.sharedAnalysis('versions', { taskKey, transcript: 'do not send' }));
  await assert.rejects(f.client.sharedAnalysis('claim', { taskKey, familyKey: taskKey, inputHash, clientAttemptId: 'missing-base' }));
  await assert.rejects(f.client.sharedAnalysis('claim', { taskKey, familyKey: 'not a hash', inputHash, clientAttemptId: 'bad-family' }));
  assert.equal(f.calls.length, 2);
});
