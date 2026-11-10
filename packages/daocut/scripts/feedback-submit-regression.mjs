import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

// Runs the real React form in a disposable browser. All host/diagnostic operations are in-memory fixture calls.
const packageDir = fileURLToPath(new URL('../', import.meta.url));
const repoDir = path.resolve(packageDir, '../..');
const fixtureDir = fileURLToPath(new URL('./fixtures/feedback-submit/', import.meta.url));
const outputDir = path.join(repoDir, '.release/company-features-20261024/fixes/feedback-submit');
await mkdir(outputDir, { recursive: true });
const tempDir = path.join(outputDir, 'tmp');
await mkdir(tempDir, { recursive: true });
process.env.TEMP = tempDir; process.env.TMP = tempDir; process.env.TMPDIR = tempDir;
const server = await createServer({ configFile: path.join(packageDir, 'studio/ui/vite.config.ts'), root: fixtureDir,
  cacheDir: path.join(outputDir, 'vite-cache'), server: { host: '127.0.0.1', port: 0, fs: { allow: [repoDir] } } });
let browser;
const checks = [], errors = [], unexpectedRequests = [];
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.DAOCUT_TEST_BROWSER || 'D:/Daocut/App/resources/runtime/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-win64/chrome-headless-shell.exe', headless: true });
  const page = await browser.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin && !url.pathname.startsWith('/api/')) return route.continue();
    unexpectedRequests.push(url.origin + url.pathname); return route.abort();
  });
  const control = (action, args = []) => page.evaluate(([method, values]) => window.feedbackTest[method](...values), [action, args]);
  const state = () => control('inspect');
  const title = page.locator('form input[maxlength="120"]');
  const description = page.locator('form textarea');
  const status = page.locator('form p[role="status"], form p[role="alert"]');
  const fill = async (label) => {
    await title.fill(label); await description.fill(`Description for ${label}`);
    await page.locator('form input[type="file"]').setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVVkAAAAASUVORK5CYII=', 'base64') });
    await page.locator('form li').waitFor();
  };
  const fresh = async (label) => { await page.goto(origin); await title.waitFor(); await fill(label); };
  const send = async () => { await page.locator('form button[type="submit"]').click(); await page.waitForFunction(() => window.feedbackTest.inspect().pending); };
  const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  await fresh('Accepted while temporarily offline'); await send();
  await control('change', ['unavailable']);
  await settle();
  await page.waitForFunction(() => document.querySelector('form fieldset')?.disabled);
  await control('resolvePost');
  await page.waitForFunction(() => document.querySelector('form input[maxlength="120"]')?.value === '');
  assert.equal(await description.inputValue(), '');
  assert.equal(await page.locator('form li').count(), 0, 'accepted attachment cleared');
  assert.match(await status.textContent(), /sent/i);
  assert.equal((await state()).posts.length, 1);
  await control('change', ['signed-in']); await settle();
  assert.equal(await title.inputValue(), '', 'reconnect must not restore an already accepted draft');
  assert.equal(await page.locator('form button[type="submit"]').isDisabled(), true);
  checks.push('same owner: unavailable after POST still clears draft/screenshots and shows sent; reconnect cannot resend empty draft');

  await fresh('Failed request stays editable'); await send(); await control('rejectPost');
  await page.locator('form p[role="alert"]').waitFor();
  assert.equal(await title.inputValue(), 'Failed request stays editable');
  assert.equal(await description.inputValue(), 'Description for Failed request stays editable');
  assert.equal(await page.locator('form li').count(), 1);
  await send(); await control('resolvePost');
  await page.waitForFunction(() => document.querySelector('form input[maxlength="120"]')?.value === '');
  assert.equal((await state()).records.length, 1);
  checks.push('real rejection preserves draft/screenshots; explicit retry succeeds once');

  for (const target of ['signed-out', 'other-account', 'other-server', 'unmount']) {
    await fresh(`Old draft ${target}`); await send();
    if (target === 'unmount') await control('unmount');
    else if (target === 'other-account') await control('change', ['signed-in', 'employee-b']);
    else if (target === 'other-server') await control('change', ['signed-in', 'employee-a', 'https://other-company.invalid']);
    else await control('change', ['signed-out']);
    await settle();
    const newForm = target === 'other-account' || target === 'other-server';
    if (newForm) await fill('New owner draft');
    await control('resolvePost'); await settle();
    if (newForm) {
      assert.equal(await title.inputValue(), 'New owner draft');
      assert.equal(await description.inputValue(), 'Description for New owner draft');
      assert.equal(await page.locator('form li').count(), 1);
      assert.doesNotMatch(await status.textContent(), /sent/i);
      assert.equal(await page.getByRole('button', { name: new RegExp(`Old draft ${target}`) }).count(), 0);
    } else assert.equal(await page.locator('form').count(), 0);
    checks.push(`${target}: late response never updates or clears the new owner's UI`);
  }

  for (const target of ['unavailable', 'signed-out', 'other-account']) {
    await fresh(`Collecting ${target}`); await control('pauseCollection');
    await page.locator('form button[type="submit"]').click();
    await page.waitForFunction(() => window.feedbackTest.inspect().pendingReport);
    await control('change', target === 'other-account' ? ['signed-in', 'employee-b'] : [target]);
    await settle();
    if (target === 'other-account') await fill('New collecting owner');
    await control('releaseCollection'); await settle();
    assert.equal((await state()).posts.length, 0, 'no POST after collection loses active identity/connection');
    if (target === 'other-account') assert.equal(await title.inputValue(), 'New collecting owner');
    if (target === 'unavailable') assert.equal(await title.inputValue(), 'Collecting unavailable');
    checks.push(`collection interrupted by ${target}: zero submissions; appropriate draft preserved`);
  }
  assert.deepEqual(errors, [], 'no browser runtime errors');
  assert.deepEqual(unexpectedRequests, [], 'no external or application API requests');
  const result = { ok: true, checks, runtimeErrors: errors, unexpectedRequests, productionAPIRequests: 0 };
  await writeFile(path.join(outputDir, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally { await browser?.close(); await server.close(); }
