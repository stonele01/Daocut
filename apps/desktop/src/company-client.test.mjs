import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import vm from 'node:vm';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createCompanyClient, validateCompanyProfile, companyRequest } from './company-client.mjs';
import { registerCompanyIpc } from './company-ipc.mjs';
import { registerLocalAgentIpc } from './local-agents-ipc.mjs';

const tempRoot = resolve('.test-temp');
mkdirSync(tempRoot, { recursive: true });
function temp(t) {
  const path = mkdtempSync(join(tempRoot, 'company-client-'));
  t.after(() => { assert.ok(path.startsWith(tempRoot + '/') || path.startsWith(tempRoot + '\\')); rmSync(path, { recursive: true, force: true }); });
  return path;
}
const user = { id: 'employee-1', username: 'tester', name: 'Test Employee', role: 'user', enabled: true };
const profile = { name: 'Test Company', serverUrl: 'https://company.invalid', caPem: '' };
function cipher() {
  const key = randomBytes(32);
  return {
    encrypt(text) {
      const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([c.update(text, 'utf8'), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), data]);
    },
    decrypt(bytes) {
      const c = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      c.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([c.update(bytes.subarray(28)), c.final()]).toString('utf8');
    },
  };
}
test('profiles accept only a bare HTTPS origin and a valid optional CA', () => {
  assert.equal(validateCompanyProfile(profile).serverUrl, profile.serverUrl);
  for (const serverUrl of ['http://192.168.1.1:4715', 'http://localhost:4715', 'https://u:p@company.invalid', 'https://company.invalid/admin', 'https://company.invalid/?token=bad', 'file:///secret']) {
    assert.throws(() => validateCompanyProfile({ ...profile, serverUrl }));
  }
  assert.throws(() => validateCompanyProfile({ ...profile, caPem: '-----BEGIN CERTIFICATE-----invalid' }));
  assert.equal(validateCompanyProfile({ ...profile, serverUrl: 'http://127.0.0.1:1234' }, { allowLoopbackHttp: true }).serverUrl, 'http://127.0.0.1:1234');
});

test('real loopback contract: state contains no token, encrypted persistence, fresh authorization, feedback allowlist and revocation', async (t) => {
  const calls = [];
  let enabled = true;
  const token = 'synthetic-company-secret-only';
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    calls.push({ path: req.url, auth: req.headers.authorization, body });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/company/login') return res.end(JSON.stringify({ user, token, expiresAt: '2099-01-01' }));
    if (!enabled) { res.statusCode = 403; return res.end(JSON.stringify({ error: { code: 'DISABLED', message: '账号已停用' } })); }
    assert.equal(req.headers.authorization, 'Bearer ' + token);
    res.end(JSON.stringify(req.url === '/api/company/feedback' ? { feedback: { id: 'f1', ...body } } : { user }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise((done) => server.close(done)));
  const dataDir = temp(t), secrets = cipher();
  const configured = { ...profile, serverUrl: 'http://127.0.0.1:' + server.address().port };
  const client = createCompanyClient({ dataDir, appVersion: 'test-version', platform: 'test-os', ...secrets, allowLoopbackHttp: true });
  client.configure(configured);
  assert.equal((await client.login({ username: 'tester', password: 'synthetic-only' })).status, 'signed-in');
  assert.equal(JSON.stringify(client.state()).includes(token), false);
  assert.equal(readFileSync(join(dataDir, 'company-session.bin')).includes(Buffer.from(token)), false);
  const restored = createCompanyClient({ dataDir, appVersion: 'test-version', ...secrets, allowLoopbackHttp: true });
  assert.equal(restored.state().status, 'checking');
  await restored.assertSession();
  await client.assertSession(); await client.assertSession();
  assert.equal(calls.filter((c) => c.path.endsWith('/session')).length, 3);
  await client.submitFeedback({ category: 'bug', title: 'Title', description: 'Employee typed description', token: 'extra-secret', logs: 'full model logs', platform: 'renderer-value' });
  const posted = calls.find((c) => c.path.endsWith('/feedback')).body;
  assert.deepEqual(Object.keys(posted).sort(), ['appVersion', 'category', 'description', 'platform', 'title']);
  assert.equal(posted.platform, 'test-os');
  enabled = false;
  await assert.rejects(client.assertSession(), /账号已停用/);
  assert.equal(client.state().status, 'signed-out');
  assert.equal(existsSync(join(dataDir, 'company-session.bin')), false);
});

test('late refresh and login cannot restore a logged-out or replaced session', async (t) => {
  let finishSession, finishLogin;
  const request = async (_p, endpoint) => {
    if (endpoint === '/login') return finishLogin ? new Promise((done) => { finishLogin = done; }) : { user, token: 'test' };
    if (endpoint === '/session') return new Promise((done) => { finishSession = done; });
    return {};
  };
  const client = createCompanyClient({ dataDir: temp(t), appVersion: 'test', request });
  client.configure(profile); await client.login({ username: 'tester', password: 'test' });
  const checking = client.refresh();
  await client.logout();
  finishSession({ user });
  assert.equal((await checking).status, 'signed-out');
  finishLogin = true;
  const logging = client.login({ username: 'tester', password: 'test' });
  client.configure({ ...profile, serverUrl: 'https://other.invalid' });
  finishLogin({ user, token: 'late-token' });
  assert.equal((await logging).serverUrl, 'https://other.invalid');
  assert.equal(client.state().status, 'signed-out');
});

test('unavailable encryption keeps the session in memory; IPC never accepts arbitrary feedback metadata', async (t) => {
  const dataDir = temp(t);
  const client = createCompanyClient({ dataDir, appVersion: 'test', encrypt: () => { throw Error('no keychain'); },
    request: async () => ({ user, token: 'synthetic' }) });
  client.configure(profile); await client.login({ username: 'tester', password: 'test' });
  assert.equal(existsSync(join(dataDir, 'company-session.bin')), false);
  const handlers = new Map();
  let feedback;
  registerCompanyIpc({ handle: (k, fn) => handlers.set(k, fn) }, { trusted: (e) => e.trusted, client: { ...client, submitFeedback: (input) => { feedback = input; } }, pickProfile: async () => null, openExternal: async () => {} });
  assert.throws(() => handlers.get('desktop:company:state')({ trusted: false }));
  handlers.get('desktop:company:feedback-submit')({ trusted: true }, { category: 'bug', title: 'A', description: 'B', logs: 'secret' });
  assert.deepEqual(feedback, { category: 'bug', title: 'A', description: 'B' });
  assert.deepEqual(await handlers.get('desktop:company:import-profile')({ trusted: true }), client.state());
});

test('new agent task paths check authorization, cancellation and persistence remain available', async () => {
  const handlers = new Map();
  let checked = 0;
  registerLocalAgentIpc({ handle: (k, fn) => handlers.set(k, fn) }, { trusted: () => true,
    authorizeTask: async () => { checked++; throw Error('Company sign-in required'); } });
  for (const action of ['start', 'prompt', 'steer']) {
    const result = await handlers.get('desktop:local-agents:' + action)({}, {});
    assert.equal(result.ok, false); assert.match(result.error, /Company sign-in/);
  }
  assert.equal(checked, 3);
  assert.equal((await handlers.get('desktop:local-agents:cancel')({}, { key: 'none' })).ok, true);
  assert.equal((await handlers.get('desktop:local-agents:ack')({}, { key: 'none' })).ok, true);
  assert.equal(checked, 3);
});

test('feedback extras are explicit and redacted; usage stays bound to its original account', async (t) => {
  const posted = [];
  let actor = user;
  const client = createCompanyClient({ dataDir: temp(t), appVersion: 'test', request: async (_profile, endpoint, options) => {
    if (endpoint === '/login') return { user: actor, token: 'synthetic' };
    if (endpoint === '/session') return { user: actor };
    posted.push({ endpoint, body: options?.body });
    return { feedback: { id: 'f1' }, accepted: 1 };
  } });
  client.configure(profile); await client.login({ username: 'tester', password: 'test' });
  await client.submitFeedback({ category: 'bug', title: 'Test', description: 'Explicit feedback',
    diagnostics: { report: 'api_key=sk-syntheticSecret0123456789012345', details: 'Bearer syntheticToken0123456789' },
    attachments: [{ name: 'screenshot.png', mimeType: 'image/png', data: 'iVBORw0KGgo=' }], logs: 'must not pass' });
  assert.doesNotMatch(JSON.stringify(posted[0]), /syntheticSecret|syntheticToken|must not pass/);
  assert.equal(posted[0].body.attachments.length, 1);
  const identity = { userId: user.id, serverUrl: profile.serverUrl };
  await client.submitUsage({ events: [{ id: 'receipt-1', total: 12, prompt: 'must not pass' }] }, identity);
  assert.equal(posted[1].endpoint, '/usage');
  assert.deepEqual(posted[1].body, { events: [{ id: 'receipt-1', total: 12 }] });
  actor = { ...user, id: 'employee-2' };
  await assert.rejects(client.submitUsage({ events: [{ id: 'receipt-1', total: 12 }] }, identity), /另一个公司账号/);
  await assert.rejects(client.submitFeedback({ category: 'bug', title: 'Old account', description: 'Should stay local', identity }), /公司账号已切换/);
  assert.equal(posted.length, 2);
  await client.feedbackDetails('f1');
  assert.equal(posted[2].endpoint, '/feedback/f1');
  assert.throws(() => client.feedbackDetails('../session'), /反馈编号/);
  await assert.rejects(client.submitFeedback({ category: 'bug', title: 'T', description: 'D',
    attachments: [{ name: 'bad.svg', mimeType: 'image/svg+xml', data: 'AAAA' }] }), /PNG/);
});


test('preload exposes company methods only to company-mode windows', async () => {
  const source = readFileSync(new URL('./preload.cjs', import.meta.url), 'utf8');
  for (const enabled of [false, true]) {
    let bridge;
    const calls = [];
    vm.runInNewContext(source, {
      process: { platform: 'win32', argv: enabled ? ['--daocut-company'] : [] },
      require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
        ipcRenderer: { invoke: (channel, body) => { calls.push({ channel, body }); return Promise.resolve({}); }, on() {}, removeListener() {} } }),
    });
    assert.equal(Boolean(bridge.company), enabled);
    if (enabled) {
      await bridge.company.state();
      assert.equal(calls[0].channel, 'desktop:company:state');
      assert.equal(Object.hasOwn(bridge.company, 'transportProfile'), false);
    }
  }
});


test('quota denial retains login, and a fresh login to the same employee invalidates the old generation', async t => {
  const posted = [];
  let denied = true;
  const client = createCompanyClient({ dataDir: temp(t), appVersion: 'test', request: async (_profile, endpoint, options) => {
    if (endpoint === '/login') return { user, token: 'synthetic' };
    if (endpoint === '/session') return { user };
    if (endpoint === '/quota/reserve') {
      if (denied) throw Object.assign(new Error('今日额度不足'), { code: 'QUOTA_EXCEEDED', status: 403 });
      posted.push(options.body); return { id: options.body.id, status: 'reserved' };
    }
    return {};
  } });
  client.configure(profile); await client.login({ username: 'tester', password: 'synthetic' });
  const old = client.sessionBinding();
  await assert.rejects(client.reserveQuota({ id: 'test', model: 'model', reservedTokens: 100 }, old), /额度不足/);
  assert.equal(client.state().status, 'signed-in');
  denied = false;
  await client.logout(); await client.login({ username: 'tester', password: 'synthetic' });
  await assert.rejects(client.reserveQuota({ id: 'test', model: 'model', reservedTokens: 100 }, old), /登录状态已改变/);
  assert.equal(posted.length, 0);
  await client.reserveQuota({ id: 'test', model: 'model', reservedTokens: 100, key: 'must not pass' }, client.sessionBinding());
  assert.deepEqual(posted, [{ id: 'test', model: 'model', reservedTokens: 100, appVersion: 'test' }]);
});
