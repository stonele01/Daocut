import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const publicDir = path.join(root, 'apps/company-service/public');
const outputDir = path.join(root, '.release/token-quota-20261026/ui');
const require = createRequire(path.join(root, 'packages/daocut/package.json'));
const { chromium } = require('playwright-core');
const browserPath = process.env.DAOCUT_TEST_BROWSER || 'D:/Daocut/App/resources/runtime/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-win64/chrome-headless-shell.exe';
const admin = { id: 'synthetic-admin', username: 'ui.admin', name: '合成管理员', role: 'admin', enabled: true };
const employee = { id: 'synthetic-employee', username: 'ui.employee', name: '合成员工', role: 'employee', enabled: true };
const usage = { totals: { total: 42, requests: 1, incompleteRequests: 0 }, employees: [], models: [], daily: [], availableModels: [], lastSyncedAt: '2026-10-26T00:00:00Z' };
const period = (type, limit = null) => ({ period: type === 'daily' ? '2026-10-26' : '2026-10', limit, used: 1200, reserved: 300, remaining: limit === null ? null : Math.max(0, limit - 1500), resetAt: type === 'daily' ? '2026-10-26T16:00:00Z' : '2026-10-31T16:00:00Z' });
const quotaOf = (user) => ({ userId: user.id, name: user.name, username: user.username, enabled: user.enabled, limited: false, daily: period('daily'), monthly: period('monthly') });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const results = []; const externalRequests = []; const unexpectedAPI = [];

test('company Token quota UI synthetic acceptance', { timeout: 150_000 }, async (t) => {
  await mkdir(path.join(outputDir, 'tmp'), { recursive: true });
  process.env.TEMP = path.join(outputDir, 'tmp'); process.env.TMP = process.env.TEMP;
  const assets = new Map(await Promise.all([
    ['/admin', 'index.html', 'text/html'], ['/app.js', 'app.js', 'text/javascript'],
    ['/style.css', 'style.css', 'text/css'], ['/brand.svg', 'brand.svg', 'image/svg+xml'],
  ].map(async ([route, name, type]) => [route, { body: await readFile(path.join(publicDir, name)), type }])));
  const server = createServer((request, response) => {
    const asset = assets.get(new URL(request.url, 'http://localhost').pathname);
    response.writeHead(asset ? 200 : 404, { 'content-type': asset?.type || 'text/plain' }); response.end(asset?.body || 'Not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  let browser;
  const settle = async (page) => page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {})));
  });
  const fixture = async (initialUser = admin) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' });
    const page = await context.newPage(); const pageErrors = []; const requests = []; const gates = new Map();
    let user = initialUser; let failedPut = false; let failedGet = false;
    const quotas = [quotaOf(admin), quotaOf(employee)];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { externalRequests.push(url.origin); await route.abort(); return; }
      if (!url.pathname.startsWith('/api/company')) { await route.continue(); return; }
      const endpoint = url.pathname.slice('/api/company'.length); const method = route.request().method();
      requests.push({ endpoint, method, body: route.request().postDataJSON() });
      const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      const gate = gates.get(endpoint);
      if (gate) { gates.delete(endpoint); gate.requested.resolve(); const result = await gate.response.promise; await json(result.body, result.status); return; }
      if (endpoint === '/health') return json({ setupRequired: false });
      if (endpoint === '/session') return json({ user });
      if (endpoint === '/logout') { user = null; return json({ ok: true }); }
      if (endpoint === '/login') { user = route.request().postDataJSON().username === admin.username ? admin : employee; return json({ user }); }
      if (endpoint === '/feedback') return json({ feedback: [] });
      if (endpoint === '/users') return json({ users: [admin, employee] });
      if (endpoint === '/usage') return json(usage);
      if (endpoint === '/quotas' || endpoint === '/quota') {
        if (failedGet) return json({ error: { message: '合成额度连接失败' } }, 503);
        if (endpoint === '/quotas') return json({ quotas, timeZone: 'Asia/Shanghai' });
        return json({ quota: quotas.find((entry) => entry.userId === user.id), timeZone: 'Asia/Shanghai' });
      }
      if (/^\/users\/[^/]+\/quota$/.test(endpoint) && method === 'PUT') {
        if (failedPut) return json({ error: { message: '合成保存失败' } }, 503);
        const quota = quotas.find((entry) => entry.userId === endpoint.split('/')[2]);
        const body = route.request().postDataJSON();
        quota.daily = period('daily', body.dailyLimit); quota.monthly = period('monthly', body.monthlyLimit);
        quota.limited = body.dailyLimit !== null || body.monthlyLimit !== null;
        return json({ quota, timeZone: 'Asia/Shanghai' });
      }
      unexpectedAPI.push({ endpoint, method }); return json({ error: { message: 'Unexpected synthetic API' } }, 500);
    });
    await page.goto(origin + '/admin'); await page.locator('[data-tab="usage"]').waitFor(); await settle(page);
    return {
      page, requests, quotas,
      failPut(value) { failedPut = value; }, failGet(value) { failedGet = value; },
      async usage() { await page.locator('[data-tab="usage"]').click(); await page.waitForFunction(() => document.querySelector('.stat strong')?.textContent === '42'); await settle(page); },
      async open() { await page.locator('[data-action="quota"][data-id="synthetic-employee"]').click(); await page.locator('[data-form="quota"]').waitFor(); },
      async save() { await page.locator('[data-form="quota"] button[type="submit"]').click(); await page.locator('.modal-layer').waitFor({ state: 'detached' }); await settle(page); },
      async delay(endpoint) {
        const gate = { requested: deferred(), response: deferred() }; gates.set(endpoint, gate);
        return { requested: gate.requested.promise, async release(body, status = 200) {
          const received = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/company' + endpoint);
          gate.response.resolve({ body, status }); await (await received).finished(); await settle(page);
        } };
      },
      async close() { for (const gate of gates.values()) gate.response.resolve({ body: {}, status: 200 }); await context.close(); assert.deepEqual(pageErrors, []); },
    };
  };
  const scenario = async (name, run, user = admin) => t.test(name, async () => {
    const f = await fixture(user);
    try { await run(f); results.push({ name, status: 'passed' }); }
    catch (error) { results.push({ name, status: 'failed', error: error.message }); throw error; }
    finally { await f.close(); }
  });
  try {
    browser = await chromium.launch({ executablePath: browserPath, headless: true });
    await scenario('admin sets daily and monthly limits from employee row', async (f) => {
      await f.open(); assert.equal(await f.page.locator('#quota-daily').inputValue(), '');
      await f.page.locator('#quota-daily').fill('500000'); await f.page.locator('#quota-monthly').fill('2000000'); await f.save();
      assert.deepEqual(f.requests.find((r) => r.method === 'PUT').body, { dailyLimit: 500000, monthlyLimit: 2000000 });
      await f.usage(); const row = f.page.locator('.quota-table tr').filter({ hasText: employee.username });
      assert.match(await row.textContent(), /498,500/); assert.match(await row.textContent(), /1,998,500/); assert.match(await row.textContent(), /预占 300/);
      await f.page.screenshot({ path: path.join(outputDir, 'admin-quotas.png'), fullPage: true, animations: 'disabled' });
    });
    await scenario('freshly added account in quota response is editable without re-login', async (f) => {
      const added = { id: 'synthetic-late-user', name: '新建合成员工', username: 'ui.new', enabled: true };
      f.quotas.push(quotaOf(added)); await f.usage();
      await f.page.locator('[data-action="quota"][data-id="synthetic-late-user"]').click();
      await f.page.locator('[data-form="quota"]').waitFor();
      assert.match(await f.page.locator('#dialog-title').textContent(), /新建合成员工/);
      await f.page.locator('#quota-daily').fill('7500'); await f.save();
      assert.equal(f.requests.find((r) => r.method === 'PUT').endpoint, '/users/synthetic-late-user/quota');
    });
    await scenario('blank is unlimited and zero pauses new requests', async (f) => {
      await f.open(); await f.page.locator('#quota-daily').fill('0'); await f.page.locator('#quota-monthly').fill(''); await f.save();
      assert.deepEqual(f.requests.find((r) => r.method === 'PUT').body, { dailyLimit: 0, monthlyLimit: null });
      await f.usage(); const row = f.page.locator('.quota-table tr').filter({ hasText: employee.username });
      assert.equal(await row.locator('.quota-remaining.exhausted').textContent(), '0'); assert.match(await row.textContent(), /不限/);
      await f.open(); assert.equal(await f.page.locator('#quota-daily').inputValue(), '0'); assert.equal(await f.page.locator('#quota-monthly').inputValue(), '');
      await f.page.screenshot({ path: path.join(outputDir, 'quota-editor.png'), fullPage: true, animations: 'disabled' });
    });
    await scenario('invalid fractional limit is not sent and save failure preserves edit', async (f) => {
      await f.open(); await f.page.locator('#quota-daily').fill('1.5'); await f.page.locator('[data-form="quota"] button[type="submit"]').click();
      assert.equal(await f.page.locator('#quota-daily').evaluate((element) => element.validity.valid), false);
      assert.equal(f.requests.some((r) => r.method === 'PUT'), false);
      await f.page.locator('#quota-daily').fill('8000'); f.failPut(true); await f.page.locator('[data-form="quota"] button[type="submit"]').click();
      await f.page.getByRole('alert').filter({ hasText: '合成保存失败' }).waitFor(); assert.equal(await f.page.locator('#quota-daily').inputValue(), '8000');
    });
    await scenario('quota lookup failure does not invent unlimited balance or hide usage', async (f) => {
      f.failGet(true); await f.usage(); await f.page.getByRole('alert').filter({ hasText: '合成额度连接失败' }).waitFor();
      assert.equal(await f.page.locator('.quota-remaining').count(), 0); assert.equal(await f.page.locator('.stat strong').first().textContent(), '42');
    });
    await scenario('current quota period is independent of historical usage filters', async (f) => {
      await f.usage(); await f.page.locator('#usage-from').fill('2024-01-01'); await f.page.locator('#usage-to').fill('2024-01-31');
      await f.page.getByRole('button', { name: '查询', exact: true }).click(); await f.page.waitForFunction(() => document.querySelector('.stat strong')?.textContent === '42');
      assert.match(await f.page.locator('.quota-table thead').textContent(), /2026-10-26/); assert.match(await f.page.locator('.quota-panel').textContent(), /不受下方/);
    });
    await scenario('employee sees only own read-only quota and mobile remains contained', async (f) => {
      await f.usage(); assert.equal(f.requests.some((r) => r.endpoint === '/quotas'), false);
      assert.equal(await f.page.locator('[data-action="quota"]').count(), 0); assert.equal(await f.page.locator('.quota-card').count(), 2);
      assert.equal(await f.page.locator('#usage-user').count(), 0); assert.equal(await f.page.locator('[data-tab="users"]').count(), 0);
      assert.match(await f.page.locator('.quota-panel .note').textContent(), /旧版 Daocut 和其他软件不受此额度限制/);
      await f.page.setViewportSize({ width: 390, height: 844 }); await settle(f.page);
      assert.ok(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await f.page.screenshot({ path: path.join(outputDir, 'employee-quota-mobile.png'), fullPage: true, animations: 'disabled' });
    }, employee);
    await scenario('late admin quota does not leak into next employee session', async (f) => {
      const pending = await f.delay('/quotas'); await f.page.locator('[data-tab="usage"]').click(); await pending.requested;
      await f.page.getByRole('button', { name: '退出', exact: true }).click(); await f.page.locator('#username').waitFor();
      await f.page.locator('#username').fill(employee.username); await f.page.locator('#password').fill('Synthetic-Only-42!');
      await f.page.getByRole('button', { name: '登录', exact: true }).click(); await f.page.locator('.sidebar-foot strong').filter({ hasText: employee.name }).waitFor();
      await pending.release({ quotas: f.quotas, timeZone: 'Asia/Shanghai' }); await f.usage();
      assert.equal(await f.page.locator('.quota-table').count(), 0); assert.equal(await f.page.locator('.quota-card').count(), 2); assert.equal(await f.page.locator('[data-action="quota"]').count(), 0);
    });
    await scenario('late quota response preserves feedback draft after leaving usage', async (f) => {
      const pending = await f.delay('/quotas'); await f.page.locator('[data-tab="usage"]').click(); await pending.requested;
      await f.page.locator('[data-tab="feedback"]').click(); await f.page.locator('[data-action="feedback"]').click();
      await f.page.locator('#title').fill('未提交的合成反馈'); await pending.release({ quotas: f.quotas, timeZone: 'Asia/Shanghai' });
      assert.equal(await f.page.locator('#title').inputValue(), '未提交的合成反馈'); assert.equal(await f.page.locator('[data-form="feedback"]').count(), 1);
    });
    assert.deepEqual(externalRequests, []); assert.deepEqual(unexpectedAPI, []);
  } finally {
    await browser?.close(); await new Promise((resolve) => server.close(resolve));
    const report = { ok: results.length === 9 && results.every((entry) => entry.status === 'passed'), syntheticOnly: true, browserPath, sourceSha256: createHash('sha256').update(assets.get('/app.js').body).digest('hex'), results, externalRequests, unexpectedAPI };
    await writeFile(path.join(outputDir, 'results.json'), JSON.stringify(report, null, 2) + '\n'); console.log('Evidence: ' + path.join(outputDir, 'results.json'));
  }
});
