import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startStudio } from './server.mjs';

test('existing result sharing previews a zero-request publication and keeps historical ranges separate', { timeout: 180000 }, async t => {
  const base = resolve(import.meta.dirname, '../../../../.tmp/shared-existing-20261105/ui');
  await mkdir(base, { recursive: true });
  const scratch = await mkdtemp(join(base, 'publication-'));
  const envKeys = ['DAOCUT_STUDIO_HOME', 'DAOCUT_LIBRARY', 'DAOCUT_TRASH_DIR', 'DAOCUT_NO_UPDATE_CHECK', 'TEMP', 'TMP'];
  const old = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));
  for (const key of envKeys) process.env[key] = key === 'DAOCUT_NO_UPDATE_CHECK' ? '1' : join(scratch, key);
  for (const key of envKeys.filter(k => k !== 'DAOCUT_NO_UPDATE_CHECK')) await mkdir(process.env[key], { recursive: true });
  let studio, browser, providerCalls = 0, executeCalls = 0;
  const publishes = [], imports = [], previews = [], bindings = [];
  let publishFailed = false;
  const source = { id: 'source', assetPath: 'assets/mock.mp4', durationMs: 12000 };
  const scope = { startMs: 120, endMs: 8000 };
  const result = { action: 'analysis', runId: 'mock-saved-run', intervalId: 'old-range', scope, count: 40, canPublish: true,
    provenance: { kind: 'original-ai', scopeOrigin: 'manual-selection', model: 'mock-historical' }, warnings: ['当时范围由人工选择，个人商品边界不共享'] };
  const shared = { taskKey: 'a'.repeat(64), resultSha: 'b'.repeat(64), action: 'analysis', scope, count: 40,
    provenance: result.provenance, warnings: result.warnings };
  const candidates = Array.from({ length: 40 }, (_, i) => ({ startMs: i < 8 ? 120 + i * 100 : 2200 + (i - 8) * 120,
    endMs: i < 8 ? 200 + i * 100 : 2300 + (i - 8) * 120, text: `模拟历史话术 ${i + 1}`, tags: ['卖点'] }));
  const forbiddenProvider = async () => { providerCalls++; throw Error('Provider execution is forbidden by this test'); };
  try {
    studio = await startStudio({ port: 0, openBrowser() {}, requireAnalysisPlan: true,
      editorDir: process.env.DAOCUT_TEST_EDITOR_DIR || resolve(base, 'studio-dist'),
      liveAnalysis: { modelClient: forbiddenProvider, transcriber: forbiddenProvider }, productDiscovery: { modelClient: forbiddenProvider } });
    const api = async (path, method = 'GET', body) => {
      const response = await fetch(`${studio.origin}/api/${path}`, { method, headers: { 'x-studio-key': studio.key, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
    };
    const { project } = await api('projects', 'POST', { path: join(scratch, 'project') });
    await mkdir(join(project.path, 'assets'), { recursive: true });
    execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=5:d=12', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(project.path, source.assetPath)], { windowsHide: true });
    const initial = { version: 1, sources: [source], products: [{ id: 'product', name: '本机个人商品名', sourceIds: ['source'] }],
      intervals: [{ id: 'lecture', productId: 'product', sourceId: 'source', startMs: 2000, endMs: 8000 }], candidates: [] };
    await api(`projects/${project.id}/product-analysis`, 'PUT', { analysis: initial });
    const filmBefore = await readFile(join(project.path, 'film.html'));
    browser = await chromium.launch({ executablePath: process.env.DAOCUT_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const page = await browser.newPage({ viewport: { width: 1700, height: 1300 } });
    page.setDefaultTimeout(7000);
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (![studio.origin, studio.filmOrigin].includes(url.origin)) return route.abort();
      const reply = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      const path = url.pathname;
      if (path.endsWith('/prefs') && request.method() === 'GET') return reply({ proxies: { on: false, height: 540 }, sharedMediaLibraries: [{ id: 'mock-library', name: '隔离素材库', root: 'D:/isolated-library' }], sharedAnalysis: { enabled: true, resultRoots: [] } });
      if (path.endsWith('/shared-media/bind-copy')) { bindings.push(request.postDataJSON()); return reply({ asset: source.assetPath, source: { mode: 'verified-copy', libraryId: 'mock-library', relativePath: '直播/mock.mp4' } }); }
      if (path.endsWith('/product-workflow/status')) return reply({ source, ready: true, phase: 'ready', transcription: { status: 'complete', segments: [] }, discovery: { sourceId: 'source', status: 'complete', runs: [] } });
      if (path.endsWith('/product-workflow/shared-versions')) return reply({ groups: [] });
      if (path.endsWith('/product-workflow/existing-results')) return reply({ results: [result], source, warnings: [] });
      if (path.endsWith('/product-workflow/existing-publication-plan')) return reply({ ...result, identity: 'frozen-existing-result', sourceId: source.id, source: { ...source, sha256: 'c'.repeat(64) }, target: { root: 'D:/isolated-shared-results', libraryId: 'mock-library' }, requestCount: 0 });
      if (path.endsWith('/product-workflow/publish-existing')) {
        publishes.push(request.postDataJSON());
        return publishFailed ? reply({ error: '共享文件保存失败；本机结果保留，请明确补保存' }, 409) : reply({ published: true, requestCount: 0 });
      }
      if (path.endsWith('/product-workflow/shared-history')) return reply({ results: [shared] });
      if (path.endsWith('/product-workflow/shared-history-preview')) { previews.push(Object.fromEntries(url.searchParams)); return reply({ ...shared, candidates, canImport: true }); }
      if (path.endsWith('/product-workflow/import-history')) {
        const body = request.postDataJSON(); imports.push(body);
        const previous = (await api(`projects/${project.id}/product-analysis`)).analysis;
        const intervalId = 'historical-scope';
        const analysis = { ...previous, scopes: [{ id: intervalId, sourceId: source.id, productId: body.productId, ...scope, kind: 'confirmed-inspection', confirmed: true, origin: 'shared-historical' }],
          candidates: candidates.map((c, i) => ({ ...c, id: `historical-${i}`, sourceId: source.id, productId: body.productId, intervalId, origin: 'ai-text', version: 'historical-mock', runId: 'historical-run' })) };
        await api(`projects/${project.id}/product-analysis`, 'PUT', { analysis, expected: previous });
        return reply({ imported: true, scopeId: intervalId, count: 40, requestCount: 0 });
      }
      if (path.endsWith('/product-workflow/execute') || /\/(transcribe|analyze|discover)$/.test(path)) { executeCalls++; return reply({ error: 'Unexpected model workflow invocation' }, 500); }
      return route.continue();
    });
    const openSharing = async () => {
      await page.goto(`${studio.origin}/projects/${project.id}?key=${studio.key}`);
      await page.getByRole('button', { name: '商品与结构', exact: true }).click();
      await page.locator('summary').filter({ hasText: '素材与拆品记录' }).click();
      await page.getByRole('button', { name: '发布已有分析结果', exact: true }).click();
    };
    await t.test('completed results are reachable and preview never publishes or analyzes', async () => {
      await openSharing();
      const section = page.getByLabel('已有分析结果共享', { exact: true });
      await section.getByRole('button', { name: '查看发布清单', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '确认发布已有结果' });
      await dialog.getByText('新增转写和模型请求：0 次', { exact: true }).waitFor();
      await dialog.getByText('D:/isolated-shared-results', { exact: true }).waitFor();
      assert.equal(publishes.length, 0); assert.equal(executeCalls, 0); assert.equal(providerCalls, 0);
      await dialog.getByRole('button', { name: '暂不发布', exact: true }).click();
    });
    await t.test('binding a saved local source requires explicit library and file confirmation', async () => {
      const section = page.getByLabel('已有分析结果共享', { exact: true });
      await section.getByText('关联已有本机视频与共享原片', { exact: true }).click();
      const commit = section.getByRole('button', { name: '核对内容并关联', exact: true });
      assert.equal(await commit.isDisabled(), true); assert.equal(bindings.length, 0);
      await section.getByLabel('原片所在素材库').selectOption('mock-library');
      await section.getByLabel('共享原片路径').fill('直播/mock.mp4');
      await commit.click();
      await section.getByText('原片内容一致，关联已保存在本机', { exact: true }).waitFor();
      assert.deepEqual(bindings[0], { assetPath: source.assetPath, libraryId: 'mock-library', videoPath: '直播/mock.mp4', confirmed: true });
      assert.deepEqual(await readFile(join(project.path, 'film.html')), filmBefore);
      assert.equal(executeCalls, 0); assert.equal(providerCalls, 0);
    });
    await t.test('failed publication has an explicit file-only retry and no automatic request', async () => {
      publishFailed = true;
      const section = page.getByLabel('已有分析结果共享', { exact: true });
      await section.getByRole('button', { name: '查看发布清单', exact: true }).click();
      await page.getByRole('dialog', { name: '确认发布已有结果' }).getByRole('button', { name: '确认发布', exact: true }).click();
      await section.getByText('共享文件保存失败；本机结果保留，请明确补保存', { exact: true }).waitFor();
      assert.equal(publishes.length, 1); assert.equal(executeCalls, 0);
      publishFailed = false;
      await section.getByRole('button', { name: '仅重试保存此结果', exact: true }).click();
      await section.getByText('已有结果已共享，未发送模型请求', { exact: true }).waitFor();
      assert.deepEqual(publishes[1], publishes[0]); assert.equal(providerCalls, 0);
    });
    await t.test('historical preview keeps all forty and imports only after explicit product selection', async () => {
      const section = page.getByLabel('已有分析结果共享', { exact: true });
      await section.getByRole('button', { name: '查看同事已有结果', exact: true }).click();
      await section.getByRole('button', { name: '查看历史结果', exact: true }).click();
      const preview = section.getByLabel('历史结果预览', { exact: true });
      await preview.getByText('模拟历史话术 1', { exact: true }).waitFor();
      await preview.getByText('模拟历史话术 40', { exact: true }).waitFor();
      assert.equal(imports.length, 0);
      assert.deepEqual((await api(`projects/${project.id}/product-analysis`)).analysis.intervals, initial.intervals);
      assert.deepEqual(await readFile(join(project.path, 'film.html')), filmBefore);
      const adopt = preview.getByRole('button', { name: '导入为历史分析范围', exact: true });
      assert.equal(await adopt.isDisabled(), true);
      await preview.getByLabel('关联本机商品').selectOption('product');
      await adopt.click();
      await section.getByText('历史结果已导入，商品讲解边界和成片未改变', { exact: true }).waitFor();
      const actual = (await api(`projects/${project.id}/product-analysis`)).analysis;
      assert.equal(actual.candidates.length, 40); assert.equal(actual.candidates.filter(c => c.startMs < 2000).length, 8);
      assert.deepEqual(actual.intervals, initial.intervals); assert.equal(actual.products[0].name, initial.products[0].name);
      assert.deepEqual(await readFile(join(project.path, 'film.html')), filmBefore);
      assert.equal(imports[0].confirmed, true); assert.equal(imports[0].productId, 'product');
      await page.reload();
      assert.equal((await api(`projects/${project.id}/product-analysis`)).analysis.candidates.length, 40);
      assert.equal(executeCalls, 0); assert.equal(providerCalls, 0);
    });
  } finally {
    await browser?.close(); await studio?.close();
    for (const key of envKeys) old[key] === undefined ? delete process.env[key] : process.env[key] = old[key];
  }
});
