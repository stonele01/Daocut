import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startStudio } from './server.mjs';

test('shared version UI only notifies, adopts explicitly, and separates new analysis confirmation', { timeout: 120000 }, async t => {
  const base = resolve(import.meta.dirname, '../../../../.tmp/shared-v2-20261105/ui');
  await mkdir(base, { recursive: true }); const scratch = await mkdtemp(join(base, 'versions-'));
  const names = ['DAOCUT_STUDIO_HOME', 'DAOCUT_LIBRARY', 'DAOCUT_TRASH_DIR', 'DAOCUT_NO_UPDATE_CHECK'];
  const old = Object.fromEntries(names.map(k => [k, process.env[k]]));
  for (const k of names.slice(0, 3)) process.env[k] = join(scratch, k);
  process.env.DAOCUT_NO_UPDATE_CHECK = '1'; await mkdir(process.env.DAOCUT_TRASH_DIR);
  let studio, browser; const adopted = [], executed = [], plans = [];
  const v1 = { taskKey: 'a'.repeat(64), sequence: 1, createdAt: '2026-11-04T00:00:00Z', sha256: 'b'.repeat(64), model: 'mock-v1' };
  const v2 = { taskKey: 'c'.repeat(64), sequence: 2, createdAt: '2026-11-05T00:00:00Z', sha256: 'd'.repeat(64), model: 'mock-v2' };
  let current = v1, rejectAdopt = false, pending = false, offline = false;
  try {
    studio = await startStudio({ port: 0, openBrowser: () => {}, requireAnalysisPlan: true });
    const api = async (path, method = 'GET', body) => {
      const response = await fetch(`${studio.origin}/api/${path}`, { method, headers: { 'x-studio-key': studio.key, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
    };
    const { project } = await api('projects', 'POST', { path: join(scratch, 'project') });
    await mkdir(join(project.path, 'assets'), { recursive: true });
    execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=5:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', join(project.path, 'assets/mock.mp4')], { windowsHide: true });
    const source = { id: 's', assetPath: 'assets/mock.mp4', durationMs: 4000 };
    await api(`projects/${project.id}/product-analysis`, 'PUT', { analysis: { version: 1, sources: [source], products: [{ id: 'p', name: '保留的个人名字', sourceIds: ['s'] }], intervals: [], candidates: [] } });
    const film = await readFile(join(project.path, 'film.html'));
    browser = await chromium.launch({ executablePath: process.env.DAOCUT_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } }); page.setDefaultTimeout(7000);
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (![studio.origin, studio.filmOrigin].includes(url.origin)) return route.abort();
      const reply = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
      if (url.pathname.endsWith('/product-workflow/status')) return reply({ source, ready: false, phase: 'discovery', transcription: { status: 'complete', segments: [] }, discovery: { sourceId: 's', status: 'idle', runs: [] } });
      if (url.pathname.endsWith('/product-workflow/shared-versions')) return reply({ groups: [{ sourceId: 's', action: 'discovery', familyKey: v1.taskKey, currentVersion: current, latestVersion: offline ? current : v2, versions: offline ? [current] : [v1, v2], updateAvailable: !offline && current.sequence === 1, canCreateVersion: true }], ...(offline ? { warning: '公司服务不可用，继续使用本机固定版本' } : {}) });
      if (url.pathname.endsWith('/product-workflow/adopt-shared')) {
        adopted.push(request.postDataJSON());
        if (rejectAdopt) return reply({ error: '当前版本已变化，请刷新后核对' }, 409);
        if (pending) return reply({ needsReview: true, reason: '新版建议待核对，当前版本和人工修改保留' });
        current = v2; return reply({ adopted: true, warning: '已有下游分析需要核对；不会自动重新分析' });
      }
      if (url.pathname.endsWith('/product-workflow/plan')) {
        plans.push(Object.fromEntries(url.searchParams));
        return reply({ sourceId: 's', action: 'discovery', newVersion: true, identity: 'mock-plan', source, enabled: true, cached: false, requestCount: 1, totalRequests: 1, reusedRequests: 0, transcriptSegments: 2, retryRequired: false, service: { enabled: true, provider: 'mock', model: 'mock-v3', endpoint: 'local://mock' }, cost: { estimate: null, uncertain: true, basis: '隔离模拟服务；不发生实际费用' } });
      }
      if (url.pathname.endsWith('/product-workflow/execute')) { executed.push(request.postDataJSON()); return reply({}); }
      return route.continue();
    });
    const open = async () => { await page.goto(`${studio.origin}/projects/${project.id}?key=${studio.key}`); await page.getByRole('button', { name: '商品与结构', exact: true }).click(); };
    await open(); const versions = page.getByLabel('共享分析版本', { exact: true });
    await t.test('opening and checking a newer version leave current results unchanged', async () => {
      await versions.getByText('当前 V1', { exact: true }).waitFor();
      await versions.getByText('发现 V2', { exact: true }).waitFor();
      await versions.getByRole('button', { name: '检查新版', exact: true }).click();
      assert.deepEqual([adopted.length, executed.length, plans.length], [0, 0, 0]);
    });
    const choose = async () => { await versions.getByRole('button', { name: '查看可用版本', exact: true }).click(); await versions.getByLabel('选择共享版本').selectOption(v2.taskKey); await versions.getByRole('button', { name: '采用所选版本', exact: true }).click(); };
    await t.test('stale adoption fails without replacing the original version or issuing a model request', async () => {
      rejectAdopt = true; await choose();
      await page.getByRole('dialog', { name: '确认采用共享版本' }).getByRole('button', { name: '确认采用', exact: true }).click();
      await versions.getByText('当前版本已变化，请刷新后核对', { exact: true }).waitFor();
      assert.equal(current.sequence, 1); assert.equal(adopted[0].expectedCurrentSha, v1.sha256); assert.equal(adopted[0].versionTaskKey, v2.taskKey); assert.equal(executed.length, 0);
      await open(); rejectAdopt = false;
    });
    await t.test('manual differences remain pending rather than claiming adoption succeeded', async () => {
      pending = true; await choose();
      await page.getByRole('dialog', { name: '确认采用共享版本' }).getByRole('button', { name: '确认采用', exact: true }).click();
      await versions.getByText('新版建议待核对，当前版本和人工修改保留', { exact: true }).waitFor();
      assert.equal(current.sequence, 1); assert.equal(executed.length, 0); pending = false; await open();
    });
    await t.test('explicit adoption persists and reopens without analysis', async () => {
      await choose(); await page.getByRole('dialog', { name: '确认采用共享版本' }).getByRole('button', { name: '确认采用', exact: true }).click();
      await versions.getByText('当前 V2', { exact: true }).waitFor();
      await versions.getByText(/已有下游分析需要核对/).waitFor();
      await open(); await versions.getByText('当前 V2', { exact: true }).waitFor();
      assert.equal(executed.length, 0);
      assert.deepEqual(await readFile(join(project.path, 'film.html')), film);
      assert.equal((await api(`projects/${project.id}/product-analysis`)).analysis.products[0].name, '保留的个人名字');
    });
    await t.test('new shared analysis uses the existing paid request plan and never starts on version inspection', async () => {
      await versions.getByRole('button', { name: '生成共享新版', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '确认拆品' }); await dialog.getByText(/生成新的共享版本/).waitFor();
      assert.equal(plans.at(-1).newVersion, 'true'); assert.equal(executed.length, 0);
      await dialog.getByRole('button', { name: '确认拆品', exact: true }).click(); assert.equal(executed.length, 1); assert.equal(executed[0].plan.newVersion, true);
    });
    await t.test('unavailable company service keeps the pinned local version visible', async () => {
      offline = true; await open(); await versions.getByText('当前 V2', { exact: true }).waitFor();
      await versions.getByText('公司服务不可用，继续使用本机固定版本', { exact: true }).waitFor(); assert.equal(executed.length, 1);
    });
  } finally {
    await browser?.close(); await studio?.close();
    for (const key of names) old[key] === undefined ? delete process.env[key] : process.env[key] = old[key];
  }
});
