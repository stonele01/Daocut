import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright-core';
import { createCompanyClient } from './company-client.mjs';
import { registerLocalAgentIpc } from './local-agents-ipc.mjs';
import { createDesktopTextService } from './desktop-analysis-service.mjs';

const require = createRequire(import.meta.url);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const base = join(repo, '.tmp/shared-v2-20261105/offline');

async function restoredOutage(dataDir) {
  const key = randomBytes(32);
  const encrypt = text => {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    const bytes = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
  };
  const decrypt = bytes => {
    const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
  };
  let offline = false;
  const options = { dataDir, appVersion: 'test', encrypt, decrypt, request: async (_profile, endpoint) => {
    if (offline) throw Error('simulated company outage');
    assert.equal(endpoint, '/login');
    return { user: { id: 'mock-user', username: 'mock', role: 'user' }, token: 'synthetic-persisted-session' };
  } };
  const first = createCompanyClient(options);
  first.configure({ name: '隔离测试公司', serverUrl: 'https://company.invalid', caPem: '' });
  assert.equal((await first.login({ username: 'mock', password: 'synthetic' })).status, 'signed-in');
  assert.equal((await readFile(join(dataDir, 'company-session.bin'))).includes(Buffer.from('synthetic-persisted-session')), false);
  offline = true;
  const restored = createCompanyClient(options);
  assert.equal(restored.state().status, 'checking');
  const state = await restored.refresh();
  assert.equal(state.status, 'unavailable'); assert.equal(state.configured, true);
  await assert.rejects(restored.assertSession());
  return state;
}

test('company gate permits explicit offline local editing without claiming company authorization', { timeout: 90000 }, async t => {
  await mkdir(base, { recursive: true });
  const scratch = await mkdtemp(join(base, 'gate-'));
  let browser, server;
  t.after(async () => {
    await browser?.close();
    if (server?.listening) await new Promise(done => server.close(done));
    assert.ok(scratch.startsWith(base + '\\') || scratch.startsWith(base + '/'));
    await rm(scratch, { recursive: true, force: true });
  });
  const host = join(scratch, 'host.ts'), logo = join(scratch, 'logo.tsx');
  const coldState = await restoredOutage(join(scratch, 'company-profile'));
  await writeFile(host, `
    const listeners = new Set();
    let state = ${JSON.stringify(coldState)};
    let nextRefresh = {configured: true, status: 'signed-in', user: {id: 'mock-user'}};
    const calls = [];
    export const studioHost = {company: {
      state: async () => state,
      onChange: callback => { listeners.add(callback); return () => listeners.delete(callback); },
      refresh: async () => { calls.push('refresh'); window.testCompany.emit(nextRefresh); return state; },
      login: async () => { calls.push('login'); return state; },
      importProfile: async () => state,
    }};
    window.testCompany = {
      calls,
      emit: value => { state = value; for (const listener of listeners) listener(state); },
      snapshot: () => state,
      setRefresh: value => { nextRefresh = value; },
    };
  `);
  await writeFile(logo, 'export function BrandLogo() { return <span>Daocut</span>; }');
  await writeFile(join(scratch, 'index.html'), '<!doctype html><html><body><div id="root"></div><script type="module" src="/entry.tsx"></script></body></html>');
  await writeFile(join(scratch, 'entry.tsx'), `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {CompanyGate} from ${JSON.stringify(join(repo, 'apps/desktop/shell/CompanyGate.tsx').replaceAll('\\', '/'))};
    function LocalProject() {
      const [value, setValue] = useState(localStorage.getItem('mock-project-name') || '已有测试工程');
      const [saved, setSaved] = useState('');
      return <main aria-label="隔离本机工程"><label>工程名称<input aria-label="工程名称" value={value} onChange={e => setValue(e.target.value)} /></label><button onClick={() => {localStorage.setItem('mock-project-name', value); setSaved(value);}}>保存本机工程</button><output>{saved}</output></main>;
    }
    createRoot(document.getElementById('root')).render(<><LocalProject/><CompanyGate/></>);
  `);
  await build({ configFile: false, root: scratch, cacheDir: join(scratch, 'vite-cache'), logLevel: 'silent',
    plugins: [react(), { name: 'isolated-company-deps', resolveId(source) {
      if (/^(react|react-dom|lucide-react)(\/|$)/.test(source)) return require.resolve(source);
    } }], resolve: { alias: [
      { find: 'daocut/studio-ui/lib/host.ts', replacement: host },
      { find: 'daocut/studio-ui/components/BrandLogo.tsx', replacement: logo },
    ] }, build: { outDir: join(scratch, 'dist'), emptyOutDir: true } });
  server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path.includes('..')) { res.writeHead(400); return res.end(); }
    try {
      const file = path === '/' ? '/index.html' : path;
      res.setHeader('content-type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(await readFile(join(scratch, 'dist', file)));
    } catch { res.writeHead(404); res.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launchPersistentContext(join(scratch, 'browser-profile'), {
    executablePath: process.env.DAOCUT_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true, env: { ...process.env, TEMP: scratch, TMP: scratch }, viewport: { width: 1400, height: 900 },
  });
  await browser.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await browser.newPage(); page.setDefaultTimeout(2500);
  const emit = async status => page.evaluate(status => window.testCompany.emit({ configured: true, status, ...(status === 'signed-in' ? { user: { id: 'mock-user' } } : {}) }), status);
  await t.test('cold launch during outage requires an explicit offline choice and preserves local edits after reopen', async () => {
    await page.goto(origin);
    await page.getByRole('dialog', { name: '登录你的创作空间' }).waitFor();
    assert.equal(await page.getByLabel('工程名称').evaluate(element => Boolean(element.closest('[inert]'))), true);
    await page.getByRole('button', { name: '离线打开本机工程', exact: true }).click();
    await page.getByRole('dialog', { name: '登录你的创作空间' }).waitFor({ state: 'hidden' });
    await page.getByText(/新 AI.*共享任务.*暂停/).waitFor();
    await page.getByLabel('工程名称').fill('离线人工修改');
    await page.getByRole('button', { name: '保存本机工程' }).click();
    assert.equal(await page.locator('output').textContent(), '离线人工修改');
    assert.equal((await page.evaluate(() => window.testCompany.snapshot())).status, 'unavailable');
    assert.deepEqual(await page.evaluate(() => window.testCompany.calls), []);
    await page.reload();
    await page.getByRole('button', { name: '离线打开本机工程', exact: true }).click();
    assert.equal(await page.getByLabel('工程名称').inputValue(), '离线人工修改');
  });
  await t.test('reconnecting does not discard local changes or require fake login state', async () => {
    await page.getByRole('button', { name: '重新连接', exact: true }).click();
    await page.waitForFunction(() => window.testCompany.snapshot().status === 'signed-in');
    assert.equal(await page.getByLabel('工程名称').inputValue(), '离线人工修改');
    assert.deepEqual(await page.evaluate(() => window.testCompany.calls), ['refresh']);
  });
  await t.test('an already-open project remains editable after losing service', async () => {
    await emit('unavailable');
    await page.getByText(/新 AI.*共享任务.*暂停/).waitFor();
    assert.equal(await page.getByLabel('工程名称').evaluate(element => Boolean(element.closest('[inert]'))), false);
    await page.getByLabel('工程名称').fill('断线后继续修改');
    await page.getByRole('button', { name: '保存本机工程' }).click();
    assert.equal(await page.locator('output').textContent(), '断线后继续修改');
  });
  await t.test('unconfigured and explicitly signed-out cold launches do not offer the outage-only entry', async () => {
    await page.reload();
    await emit('signed-out');
    await page.getByRole('dialog', { name: '登录你的创作空间' }).waitFor();
    assert.equal(await page.getByRole('button', { name: '离线打开本机工程', exact: true }).count(), 0);
    await page.evaluate(() => window.testCompany.emit({ configured: false, status: 'unconfigured' }));
    await page.getByRole('dialog', { name: '连接你的创作空间' }).waitFor();
    assert.equal(await page.getByRole('button', { name: '离线打开本机工程', exact: true }).count(), 0);
  });
});

test('offline UI does not authorize main-process AI or shared-task submission', async t => {
  await mkdir(base, { recursive: true }); const dir = await mkdtemp(join(base, 'authorization-'));
  t.after(async () => { assert.ok(dir.startsWith(base)); await rm(dir, { recursive: true, force: true }); });
  let offline = false, transportCalls = 0, modelCalls = 0;
  const user = { id: 'mock-user', username: 'mock', role: 'user' };
  const client = createCompanyClient({ dataDir: dir, appVersion: 'test', request: async (_profile, endpoint) => {
    if (endpoint === '/login') return { user, token: 'synthetic-only' };
    if (endpoint === '/session') { if (offline) throw Error('simulated company outage'); return { user }; }
    transportCalls++; return {};
  } });
  client.configure({ name: 'Isolated company', serverUrl: 'https://company.invalid', caPem: '' });
  await client.login({ username: 'mock', password: 'synthetic' }); offline = true;
  const handlers = new Map();
  registerLocalAgentIpc({ handle: (key, fn) => handlers.set(key, fn) }, { trusted: () => true, authorizeTask: () => client.assertSession() });
  for (const action of ['start', 'prompt', 'steer']) {
    const result = await handlers.get('desktop:local-agents:' + action)({}, {});
    assert.equal(result.ok, false);
  }
  const service = createDesktopTextService({ company: () => client, roster: () => { modelCalls++; return null; } });
  await assert.rejects(service({ operation: 'shared-coordinate', action: 'claim', body: { taskKey: 'a'.repeat(64), inputHash: 'b'.repeat(64), clientAttemptId: 'mock-attempt' } }));
  assert.equal(transportCalls, 0); assert.equal(modelCalls, 0);
});
