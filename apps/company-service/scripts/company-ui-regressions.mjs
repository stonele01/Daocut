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
const outputDir = path.join(root, '.release/company-features-20261024/company-ui-fixes');
const require = createRequire(path.join(root, 'packages/daocut/package.json'));
const { chromium } = require('playwright-core');
const browserPath = process.env.DAOCUT_TEST_BROWSER || 'D:/Daocut/App/resources/runtime/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-win64/chrome-headless-shell.exe';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const admin = { id: 'synthetic-admin', username: 'ui.admin', name: '合成管理员', role: 'admin', enabled: true };
const employee = { id: 'synthetic-employee', username: 'ui.employee', name: '合成员工', role: 'employee', enabled: true };
const feedback = { id: 'synthetic-feedback', title: '合成诊断回归', description: 'Synthetic feedback only', category: 'bug', status: 'new', userName: admin.name, createdAt: '2026-10-24T00:00:00Z', adminNote: '', hasDiagnostics: true, diagnostics: { report: 'SYNTHETIC PRIVATE DIAGNOSTIC', details: 'Synthetic failure detail' }, attachments: [{ id: 'synthetic-image', name: 'synthetic.png', mimeType: 'image/png' }] };
const usage = { totals: { total: 42, requests: 1, incompleteRequests: 0 }, employees: [], models: [], daily: [], availableModels: [], lastSyncedAt: '2026-10-24T00:00:00Z' };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const digest = (content) => createHash('sha256').update(content).digest('hex');
const results = [];
const externalRequests = [];
const unexpectedAPI = [];

test('company admin UI delayed responses and keyboard regressions', { timeout: 90_000 }, async (t) => {
  await mkdir(path.join(outputDir, 'tmp'), { recursive: true });
  // Keep the browser profile and temporary files on D:, beside the test evidence.
  process.env.TEMP = path.join(outputDir, 'tmp'); process.env.TMP = process.env.TEMP;
  const assets = new Map(await Promise.all([
    ['/admin', 'index.html', 'text/html'],
    ['/app.js', 'app.js', 'text/javascript'],
    ['/style.css', 'style.css', 'text/css'],
    ['/brand.svg', 'brand.svg', 'image/svg+xml'],
  ].map(async ([route, name, type]) => [route, { body: await readFile(path.join(publicDir, name)), type }])));
  const server = createServer((request, response) => {
    const asset = assets.get(new URL(request.url, 'http://localhost').pathname);
    response.writeHead(asset ? 200 : 404, { 'content-type': asset?.type || 'text/plain' });
    response.end(asset?.body || 'Not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  let browser;
  let browserVersion;
  const settle = async (page) => page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {})));
  });
  const fixture = async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const pageErrors = []; const gates = new Map();
    let user = admin;
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { externalRequests.push(url.origin); await route.abort(); return; }
      if (!url.pathname.startsWith('/api/company')) { await route.continue(); return; }
      const endpoint = url.pathname.slice('/api/company'.length);
      const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      const gate = gates.get(endpoint);
      if (gate) {
        gates.delete(endpoint); gate.requested.resolve();
        const result = await gate.response.promise;
        await json(result.body, result.status); return;
      }
      if (endpoint === '/health') return json({ setupRequired: false });
      if (endpoint === '/session') return json({ user });
      if (endpoint === '/logout') { user = null; return json({ ok: true }); }
      if (endpoint === '/login') {
        const username = route.request().postDataJSON().username;
        user = username === admin.username ? admin : username === employee.username ? employee : null;
        return json(user ? { user } : { error: { message: 'Unknown synthetic account' } }, user ? 200 : 401);
      }
      if (endpoint === '/feedback') { const { diagnostics, ...metadata } = feedback; return json({ feedback: user?.role === 'admin' ? [metadata] : [] }); }
      if (endpoint === '/users') return json({ users: [admin, employee] });
      if (endpoint === '/usage') return json(usage);
      if (endpoint === '/quotas') return json({ quotas: [], timeZone: 'Asia/Shanghai' });
      if (endpoint === '/quota') return json({ quota: { userId: user.id, daily: { period: '2026-10-24', limit: null, used: 0, reserved: 0, remaining: null }, monthly: { period: '2026-10', limit: null, used: 0, reserved: 0, remaining: null } }, timeZone: 'Asia/Shanghai' });
      if (endpoint === '/feedback/' + feedback.id) return json({ feedback });
      if (endpoint === '/feedback/' + feedback.id + '/attachments/synthetic-image') return route.fulfill({ contentType: 'image/png', body: png });
      unexpectedAPI.push(endpoint);
      return json({ error: { message: 'Unexpected test API' } }, 500);
    });
    await page.goto(origin + '/admin');
    await page.locator('[data-tab="users"]').waitFor(); await settle(page);
    return {
      page,
      async delay(endpoint) {
        const gate = { requested: deferred(), response: deferred() }; gates.set(endpoint, gate);
        return {
          requested: gate.requested.promise,
          async release(body, status = 200) {
            const received = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/company' + endpoint);
            gate.response.resolve({ body, status });
            await (await received).finished(); await settle(page);
          },
        };
      },
      async close() {
        for (const gate of gates.values()) gate.response.resolve({ body: {}, status: 200 });
        await context.close();
        assert.deepEqual(pageErrors, [], 'no uncaught browser errors');
      },
    };
  };
  const scenario = async (name, run) => t.test(name, async () => {
    const current = await fixture();
    try {
      await run(current);
      results.push({ name, status: 'passed' });
    } catch (error) {
      results.push({ name, status: 'failed', error: error.message });
      throw error;
    } finally { await current.close(); }
  });
  try {
    browser = await chromium.launch({ executablePath: browserPath, headless: true });
    browserVersion = browser.version();
    for (const account of [null, employee, admin]) {
      const label = account ? account === admin ? 'same-account sign-in' : 'different-account sign-in' : 'logout';
      await scenario('late diagnostic cannot reappear after ' + label, async ({ page, delay }) => {
        await page.locator('[data-tab="feedback"]').click();
        const pending = await delay('/feedback/' + feedback.id);
        await page.locator('[data-action="feedback-detail"]').click(); await pending.requested;
        await page.getByRole('button', { name: '退出', exact: true }).click();
        await page.locator('#username').waitFor();
        if (account) {
          await page.locator('#username').fill(account.username);
          await page.locator('#password').fill('Synthetic-Test-Only-42!');
          await page.getByRole('button', { name: '登录', exact: true }).click();
          await page.locator('.sidebar-foot strong').filter({ hasText: account.name }).waitFor(); await settle(page);
        }
        await pending.release({ feedback });
        assert.equal(await page.locator('.diagnostic-modal').count(), 0, 'old-session diagnostic must not be appended');
        assert.equal(await page.getByText('SYNTHETIC PRIVATE DIAGNOSTIC', { exact: true }).count(), 0);
      });
    }
    for (const status of [200, 503]) {
      await scenario('late usage ' + status + ' preserves an open feedback draft', async ({ page, delay }) => {
        const pending = await delay('/usage');
        await page.locator('[data-tab="usage"]').click(); await pending.requested;
        await page.locator('[data-tab="feedback"]').click();
        await page.locator('[data-action="triage"]').click();
        await page.locator('#status').selectOption('in_progress');
        await page.locator('#adminNote').fill('未提交的合成处理说明');
        await pending.release(status === 200 ? usage : { error: { message: 'Synthetic delayed usage failure' } }, status);
        assert.equal(await page.locator('[data-form="triage"]').count(), 1, 'the pending response must not remove the modal');
        assert.equal(await page.locator('#adminNote').inputValue(), '未提交的合成处理说明');
        assert.equal(await page.locator('#status').inputValue(), 'in_progress');
        // Re-entering usage still loads normally after an off-page completion.
        await page.locator('[data-action="close-modal"]').click();
        await page.locator('[data-tab="usage"]').click();
        await page.waitForFunction(() => document.querySelector('.stat strong')?.textContent === '42');
      });
    }
    await scenario('diagnostic details and screenshot are keyboard reachable', async ({ page }) => {
      await page.locator('[data-tab="feedback"]').click();
      await page.locator('[data-action="feedback-detail"]').click();
      await page.locator('.diagnostic-modal').waitFor();
      const close = page.locator('.diagnostic-modal [data-action="close-modal"]');
      const summary = page.locator('.diagnostic-modal summary');
      const link = page.locator('.feedback-images a');
      const focused = (locator) => locator.evaluate((element) => element === document.activeElement);
      assert.equal(await focused(close), true, 'dialog focuses close initially');
      await page.keyboard.press('Tab');
      assert.equal(await focused(summary), true, 'Tab wraps from close to diagnostic details');
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('.diagnostic-modal details').getAttribute('open'), '');
      await page.keyboard.press('Tab'); assert.equal(await focused(link), true, 'screenshot link is in the tab sequence');
      await page.keyboard.press('Tab'); assert.equal(await focused(close), true);
      await page.keyboard.press('Shift+Tab'); assert.equal(await focused(link), true);
      await page.keyboard.press('Shift+Tab'); assert.equal(await focused(summary), true);
      await page.keyboard.press('Shift+Tab'); assert.equal(await focused(close), true, 'reverse Tab wraps within the modal');
      await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
      const popupReady = page.waitForEvent('popup');
      await page.keyboard.press('Enter');
      const popup = await popupReady; await popup.waitForLoadState('domcontentloaded');
      assert.equal(new URL(popup.url()).pathname, '/api/company/feedback/' + feedback.id + '/attachments/synthetic-image');
      await popup.close();
      await page.screenshot({ path: path.join(outputDir, 'diagnostic-keyboard.png'), fullPage: true, animations: 'disabled' });
      await page.keyboard.press('Escape');
      await page.locator('.modal-layer').waitFor({ state: 'detached' });
    });
    assert.deepEqual(externalRequests, [], 'no external request attempted');
    assert.deepEqual(unexpectedAPI, [], 'only the documented synthetic API was used');
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
    const report = {
      ok: results.length === 6 && results.every((entry) => entry.status === 'passed'),
      browserVersion, browserPath, syntheticOnly: true,
      sourceSha256: digest(assets.get('/app.js').body),
      scriptSha256: digest(await readFile(fileURLToPath(import.meta.url))),
      externalRequests, unexpectedAPI, results,
    };
    await writeFile(path.join(outputDir, 'results.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('Evidence: ' + path.join(outputDir, 'results.json'));
  }
});
