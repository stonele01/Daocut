import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createCompanyService } from '../../company-service/src/service.mjs';
import { createCompanyClient } from './company-client.mjs';
import { createCompanyUsageReporter } from './company-usage.mjs';
import { createCompanyQuota } from './company-quota.mjs';
import { AgentSession } from './agents.mjs';

const root = resolve(import.meta.dirname, '../../../.tmp/company-quota-http');
mkdirSync(root, { recursive: true });
test('actual company HTTP -> ACP -> Pi -> synthetic provider enforces quotas and settles replay once', { timeout: 60000 }, async t => {
  const dir = mkdtempSync(join(root, 'case-')), project = join(dir, 'project'), home = join(dir, 'agent-home');
  mkdirSync(project); mkdirSync(home);
  const service = await createCompanyService({ dataDir: join(dir, 'service'), host: '127.0.0.1', port: 0, baseURL: 'http://127.0.0.1:4715' });
  await service.listen();
  t.after(() => service.close());
  const origin = `http://127.0.0.1:${service.server.address().port}`;
  const req = async (path, body, token, method = body ? 'POST' : 'GET') => {
    const res = await fetch(origin + '/api/company' + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await res.json(); assert.equal(res.ok, true, JSON.stringify(data)); return data;
  };
  const admin = { username: 'quota.admin', name: '合成管理员', password: 'Synthetic-Quota-Admin-42!' };
  const employee = { username: 'quota.employee', name: '合成员工', password: 'Synthetic-Quota-Employee-42!' };
  await req('/setup', admin);
  const adminToken = (await req('/login', admin)).token;
  const user = (await req('/users', employee, adminToken)).user;
  const setQuota = limit => req(`/users/${user.id}/quota`, { dailyLimit: limit, monthlyLimit: 1000000 }, adminToken, 'PUT');
  await setQuota(200000);
  const client = createCompanyClient({ dataDir: join(dir, 'client'), appVersion: 'quota-test', allowLoopbackHttp: true });
  client.configure({ serverUrl: origin, name: 'Synthetic company', caPem: '' });
  assert.equal((await client.login(employee)).status, 'signed-in');
  const reporter = createCompanyUsageReporter({ dataDir: join(dir, 'client'), client, appVersion: 'quota-test', retryMs: 0, lateMs: 0 });
  t.after(() => reporter.stop());
  const quota = createCompanyQuota({ client, usageReporter: reporter });
  let apiCalls = 0;
  const provider = createServer((request, response) => {
    let body = ''; request.on('data', chunk => { body += chunk; }); request.on('end', () => {
      const data = JSON.parse(body); apiCalls++;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta, finish_reason, usage) => 'data: ' + JSON.stringify({ id: 'synthetic', object: 'chat.completion.chunk', model: data.model, choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) }) + '\n\n';
      response.end(chunk({ role: 'assistant', content: 'Synthetic answer.' }, null) + chunk({}, 'stop', { prompt_tokens: 150, completion_tokens: 20, total_tokens: 170, prompt_tokens_details: { cached_tokens: 50 } }) + 'data: [DONE]\n\n');
    });
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(() => { provider.closeAllConnections(); provider.close(); });
  const session = new AgentSession({ agent: 'byok', cwd: project, quota,
    harness: { home, model: 'fixture', models: [{ id: 'fixture', name: 'fixture', api: 'openai-completions', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, keyEnv: 'DAOCUT_QUOTA_TEST_KEY', model: 'fixture', levels: ['auto'], effort: 'auto' }], env: { DAOCUT_QUOTA_TEST_KEY: 'synthetic-local-only' } } });
  t.after(() => session.close()); await session.start();
  const run = async name => {
    const logs = join(project, '.film', 'logs'); mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, `local-${name}.jsonl`), JSON.stringify({ kind: 'prompt', agent: 'byok', t: Date.now() }) + '\n');
    const token = reporter.startTurn({ project, turnId: 'local:' + name, agent: 'byok' });
    const result = await session.prompt([{ type: 'text', text: 'Explain synthetic project ' + name }], { turnId: 'local:' + name });
    return { token, result };
  };
  const first = await run('first');
  assert.equal(first.result, 'end_turn');
  let state = (await client.quota(client.sessionBinding())).quota;
  assert.equal(state.daily.used, 170); assert.equal(state.daily.reserved, 0);
  await reporter.finishTurn(first.token);
  assert.equal((await client.quota(client.sessionBinding())).quota.daily.used, 170, 'direct settlement + log replay count once');

  const settle = client.settleQuota;
  client.settleQuota = async () => { throw new Error('synthetic lost settlement connection'); };
  const second = await run('second');
  assert.equal(reporter.state().pending, 1);
  state = (await client.quota(client.sessionBinding())).quota;
  assert.equal(state.daily.used, 170); assert.ok(state.daily.reserved > 0);
  client.settleQuota = settle;
  await reporter.finishTurn(second.token); await reporter.flush();
  state = (await client.quota(client.sessionBinding())).quota;
  assert.equal(state.daily.used, 340); assert.equal(state.daily.reserved, 0);
  assert.equal(reporter.state().pending, 0);

  await setQuota(0);
  await assert.rejects(session.prompt([{ type: 'text', text: 'This request is over quota.' }]), /额度|剩余/);
  assert.equal(apiCalls, 2); assert.equal(client.state().status, 'signed-in');
  await assert.rejects(quota.authorizeTask({ agent: 'claude' }), /其他智能体暂不支持/);
  assert.equal((await client.quota(client.sessionBinding())).quota.daily.used, 340);
});
