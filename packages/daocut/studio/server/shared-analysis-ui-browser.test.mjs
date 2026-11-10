// Isolated project, local HTTP, mocked workflow only. No NAS or real provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startStudio } from './server.mjs';

test('shared results UI configures local mappings and separates reuse, wait and file recovery from model requests', { timeout: 120000 }, async t => {
  const base = resolve(import.meta.dirname, '../../../../.tmp/shared-live-20261104/ui');
  await mkdir(base, { recursive: true });
  const scratch = await mkdtemp(join(base, 'browser-'));
  const env = ['DAOCUT_STUDIO_HOME', 'DAOCUT_LIBRARY', 'DAOCUT_TRASH_DIR', 'DAOCUT_NO_UPDATE_CHECK'];
  const old = Object.fromEntries(env.map(k => [k, process.env[k]]));
  for (const k of env.slice(0, 3)) process.env[k] = join(scratch, k);
  process.env.DAOCUT_NO_UPDATE_CHECK = '1';
  await mkdir(process.env.DAOCUT_TRASH_DIR);
  let studio, browser;
  const executions = [], publishes = [], plans = [];
  const taskKey = 'a'.repeat(64);
  let shared;
  let transcriptionComplete = false;
  let planMode = 'reuse';
  try {
    studio = await startStudio({ port: 0, editorDir: process.env.DAOCUT_TEST_EDITOR_DIR ? resolve(process.env.DAOCUT_TEST_EDITOR_DIR) : undefined, openBrowser: () => {}, requireAnalysisPlan: true });
    const api = async (path, method = 'GET', body) => {
      const response = await fetch(`${studio.origin}/api/${path}`, { method, headers: { 'x-studio-key': studio.key, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
    };
    const { project } = await api('projects', 'POST', { path: join(scratch, 'project') });
    await mkdir(join(project.path, 'assets'), { recursive: true });
    const sourceFile = join(project.path, 'assets', 'synthetic.mp4');
    execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=5:d=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', sourceFile], { windowsHide: true });
    const source = { id: 's', assetPath: 'assets/synthetic.mp4', durationMs: 6000 };
    await api(`projects/${project.id}/product-analysis`, 'PUT', { analysis: { version: 1, sources: [source], products: [{ id: 'placeholder', name: '模拟直播', sourceIds: ['s'] }], intervals: [], candidates: [] } });
    await api('prefs', 'PATCH', { sharedMediaLibraries: [{ id: 'library-one', name: '隔离模拟素材库', root: join(scratch, 'media') }] });
    const protectedFiles = [sourceFile, join(project.path, 'film.html')];
    const hashes = await Promise.all(protectedFiles.map(async p => createHash('sha256').update(await readFile(p)).digest('hex')));
    browser = await chromium.launch({ executablePath: process.env.DAOCUT_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
    page.setDefaultTimeout(10000);
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (![studio.origin, studio.filmOrigin].includes(url.origin)) return route.abort();
      const reply = value => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
      if (url.pathname.endsWith('/product-workflow/status')) return reply({ source, ready: false, phase: 'transcription', transcription: { status: transcriptionComplete ? 'complete' : 'idle', segments: [] }, discovery: { sourceId: 's', status: 'idle', canRetry: false, runs: [] }, ...(shared ? { shared } : {}) });
      if (url.pathname.endsWith('/product-workflow/plan')) { plans.push(Object.fromEntries(url.searchParams)); return reply({ sourceId: 's', action: url.searchParams.get('action'), identity: 'plan', source, service: { enabled: false, provider: 'synthetic', model: 'saved-mock-model', endpoint: 'local://mock' }, enabled: ['retry-required', 'local-only'].includes(planMode), cached: planMode === 'reuse', requestCount: planMode === 'retry-required' ? 1 : 0, totalRequests: 1, reusedRequests: planMode === 'reuse' ? 1 : 0, transcriptSegments: 3, cost: { estimate: 0, uncertain: false, basis: '模拟服务，无实际费用' }, retryRequired: planMode === 'retry-required', retry: planMode === 'retry-required', shared: { mode: planMode, taskKey, result: { sha256: 'b'.repeat(64), service: { provider: 'synthetic', model: 'first-shared-model', endpoint: 'local://first-mock' } }, reason: planMode === 'busy' ? '同事正在分析，请稍后复用' : undefined } }); }
      if (url.pathname.endsWith('/product-workflow/execute')) { executions.push(request.postDataJSON()); return reply({}); }
      if (url.pathname.endsWith('/product-workflow/publish-shared')) { publishes.push(request.postDataJSON()); shared = { mode: 'reuse', taskKey }; return reply({}); }
      return route.continue();
    });
    const open = async () => { await page.goto(`${studio.origin}/projects/${project.id}?key=${studio.key}`); await page.getByRole('button', { name: '商品与结构', exact: true }).click(); };
    await open();

    await t.test('mapping settings persist locally without analysis', async () => {
      await page.getByLabel('素材与共享设置', { exact: true }).locator('summary').first().click();
      const settings = page.getByLabel('共享分析设置', { exact: true });
      await settings.locator('summary').click();
      await settings.getByLabel('启用共享分析').check();
      await settings.getByLabel('共享结果目录').fill(join(scratch, 'results-not-created'));
      await settings.getByRole('button', { name: '保存共享设置', exact: true }).click();
      await settings.getByText('共享设置已保存在本机', { exact: true }).waitFor();
      const prefs = await api('prefs');
      assert.deepEqual(prefs.sharedAnalysis, { enabled: true, resultRoots: [{ libraryId: 'library-one', root: join(scratch, 'results-not-created') }] });
      assert.deepEqual([executions.length, publishes.length], [0, 0]);
      await open(); await page.getByLabel('素材与共享设置', { exact: true }).locator('summary').first().click(); await settings.locator('summary').click();
      assert.equal(await settings.getByLabel('启用共享分析').isChecked(), true);
      assert.equal(await settings.getByLabel('共享结果目录').inputValue(), join(scratch, 'results-not-created'));
    });
    await t.test('first shared result is explicitly reused even without configured provider', async () => {
      await page.getByRole('button', { name: '拆商品', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '确认转写' });
      await dialog.getByText(/共享版本/).first().waitFor();
      await dialog.getByText('服务：synthetic · first-shared-model', { exact: true }).waitFor();
      await dialog.getByRole('button', { name: '使用共享版本', exact: true }).click();
      assert.equal(executions.length, 1); assert.equal(executions[0].plan.shared.mode, 'reuse');
    });
    await t.test('another owner in progress cannot start a duplicate request', async () => {
      planMode = 'busy';
      await page.getByRole('button', { name: '拆商品', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '确认转写' });
      await dialog.getByText('同事正在分析，请稍后复用', { exact: true }).waitFor();
      assert.equal(await dialog.getByRole('button', { name: '等待共享结果', exact: true }).isDisabled(), true);
      assert.equal(executions.length, 1);
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
    });
    await t.test('uncertain retry requires explicit checkbox and freezes acknowledged plan', async () => {
      planMode = 'retry-required';
      await page.getByRole('button', { name: '拆商品', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '确认转写' });
      const confirm = dialog.getByRole('button', { name: '确认转写', exact: true });
      await dialog.getByLabel('已核查服务记录，确认显式重试').waitFor();
      assert.equal(await confirm.isDisabled(), true);
      await dialog.getByLabel('已核查服务记录，确认显式重试').check();
      await confirm.click();
      assert.equal(executions.length, 2); assert.equal(executions[1].retryAcknowledged, true);
    });
    await t.test('pending publication resends only saved result, never the model task', async () => {
      shared = { mode: 'publish-pending', taskKey, reason: '模拟共享保存失败' };
      await open();
      await page.getByRole('button', { name: '仅重试保存共享结果', exact: true }).click();
      await page.getByText('共享结果已保存', { exact: true }).waitFor();
      assert.deepEqual(publishes, [{ sourceId: 's', taskKey, confirmed: true }]);
      assert.equal(executions.length, 2);
      for (let i = 0; i < protectedFiles.length; i++) assert.equal(createHash('sha256').update(await readFile(protectedFiles[i])).digest('hex'), hashes[i]);
    });
    await t.test('coworker library ID is entered once; duplicate new IDs cannot silently replace a mapping', async () => {
      const firstRoot = join(scratch, 'mapping-a'), secondRoot = join(scratch, 'mapping-b');
      await mkdir(firstRoot); await mkdir(secondRoot);
      await api('prefs', 'PATCH', { sharedMediaLibraries: [] });
      await page.goto(`${studio.origin}/?key=${studio.key}`);
      await page.getByRole('button', { name: '项目', exact: true }).click();
      await page.getByRole('button', { name: '导入自', exact: true }).click();
      await page.getByRole('menuitem', { name: '打开直播文件夹', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '打开直播文件夹', exact: true });
      await dialog.getByRole('button', { name: '手动配置旧素材库', exact: true }).click();
      await dialog.getByLabel('已有素材库 ID（可选）').fill('shared-coworker-library');
      await dialog.getByPlaceholder('共享素材库根目录路径', { exact: true }).fill(firstRoot);
      await dialog.getByRole('button', { name: '使用路径', exact: true }).first().click();
      await dialog.getByLabel('当前素材库 ID').waitFor();
      assert.equal((await api('prefs')).sharedMediaLibraries[0].id, 'shared-coworker-library');
      await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.__copiedLibraryId = value; } } }); });
      await dialog.getByRole('button', { name: '复制素材库 ID', exact: true }).click();
      assert.equal(await page.evaluate(() => window.__copiedLibraryId), 'shared-coworker-library');
      await dialog.getByLabel('选择素材库').selectOption('');
      await dialog.getByLabel('已有素材库 ID（可选）').fill('shared-coworker-library');
      await dialog.getByPlaceholder('共享素材库根目录路径', { exact: true }).fill(secondRoot);
      await dialog.getByRole('button', { name: '使用路径', exact: true }).first().click();
      await dialog.getByText('此素材库 ID 已在本机关联，请先选择该素材库，再更换本机目录。', { exact: true }).waitFor();
      assert.equal((await api('prefs')).sharedMediaLibraries[0].root, firstRoot);
      await dialog.getByLabel('选择素材库').selectOption('shared-coworker-library');
      await dialog.getByRole('button', { name: '更换本机目录', exact: true }).click();
      await dialog.getByPlaceholder('共享素材库根目录路径', { exact: true }).fill(secondRoot);
      await dialog.getByRole('button', { name: '确认更换本机目录', exact: true }).click();
      await dialog.getByLabel('当前素材库 ID').waitFor();
      assert.equal((await api('prefs')).sharedMediaLibraries[0].root, secondRoot);
      assert.equal((await api('prefs')).sharedMediaLibraries[0].id, 'shared-coworker-library');
      assert.deepEqual([executions.length, publishes.length], [2, 1]);
    });
    await t.test('interrupted shared structure opens retry for its saved product interval without submitting it', async () => {
      shared = { mode: 'retry-required', taskKey, action: 'analysis', newVersion: true, scope: { sourceId: 's', productId: 'saved-product', intervalId: 'saved-interval', startMs: 1000, endMs: 5000 } };
      planMode = 'retry-required';
      await open();
      await page.getByRole('button', { name: '核查并重试共享话术分析', exact: true }).click();
      await page.getByRole('dialog', { name: '确认分析' }).getByLabel('已核查服务记录，确认显式重试').waitFor();
      assert.deepEqual(plans.at(-1), { sourceId: 's', action: 'analysis', retry: 'true', newVersion: 'true', productId: 'saved-product', intervalId: 'saved-interval' });
      assert.equal(executions.length, 2, 'opening recovery only reads the exact saved scope plan');
    });
    await t.test('paid segments awaiting seam review cannot be transcribed again from status or confirmation', async () => {
      shared = { mode: 'local-review', taskKey, action: 'transcription', status: 'needs-review', reason: '分段音频已完成，接缝需原分析者本机核对；不会重新上传，跨电脑接缝原始包暂未接通' };
      await open();
      const preparation = page.getByRole('region', { name: '素材准备', exact: true });
      await preparation.getByText('分段已完成，接缝待原分析者核对', { exact: true }).first().waitFor();
      assert.equal(await preparation.getByRole('button', { name: /^拆商品$|继续拆商品|开始转写|重试转写|重试共享转写/ }).count(), 0);
      shared = undefined; planMode = 'local-review';
      await open();
      await preparation.getByRole('button', { name: '拆商品', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '确认转写' });
      await dialog.getByText(/分段音频已经处理完成/).waitFor();
      assert.equal(await dialog.getByRole('button', { name: '等待接缝核对', exact: true }).isDisabled(), true);
      assert.equal(executions.length, 2);
    });
    await t.test('locally reviewed transcript can proceed to separately confirmed discovery while shared seam review stays pending', async () => {
      shared = { mode: 'local-review', taskKey, action: 'transcription', status: 'needs-review' };
      transcriptionComplete = true; planMode = 'local-only';
      await open();
      const preparation = page.getByRole('region', { name: '素材准备', exact: true });
      await preparation.getByRole('button', { name: '继续拆商品', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '确认拆品' });
      await dialog.getByText(/仅发送转写文字/).waitFor();
      assert.equal(await dialog.getByRole('button', { name: '确认拆品', exact: true }).isEnabled(), true);
      assert.equal(plans.at(-1).action, 'discovery');
      assert.equal(executions.length, 2, 'review completion does not authorize discovery');
      assert.equal(await preparation.getByRole('button', { name: /^拆商品$|开始转写|重试转写/ }).count(), 0);
    });
  } finally {
    await browser?.close(); await studio?.close();
    for (const k of env) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; }
  }
});
