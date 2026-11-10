// Isolated UI acceptance. All 256 public plans and batch endpoints are simulated;
// personal drafts and their save barrier use the real local Studio routes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startStudio } from './server.mjs';
import { openProject } from './projects.mjs';
import { ensureStructureDraft } from './structure-drafts.mjs';
import { writeProjectFilm } from './film.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('batch UI exports only explicit checked plans and flushes private saves before the parent batch request', { timeout: 120000 }, async () => {
  const base = resolve(import.meta.dirname, '../../../../.tmp/structure-batch-20261109/browser');
  await mkdir(base, { recursive: true });
  const scratch = await mkdtemp(join(base, 'selection-'));
  const names = ['DAOCUT_STUDIO_HOME', 'DAOCUT_LIBRARY', 'DAOCUT_TRASH_DIR', 'DAOCUT_NO_UPDATE_CHECK', 'TEMP', 'TMP'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  Object.assign(process.env, { DAOCUT_STUDIO_HOME: join(scratch, 'home'), DAOCUT_LIBRARY: join(scratch, 'library'),
    DAOCUT_TRASH_DIR: join(scratch, 'trash'), DAOCUT_NO_UPDATE_CHECK: '1', TEMP: join(scratch, 'temp'), TMP: join(scratch, 'temp') });
  await mkdir(process.env.TEMP, { recursive: true });
  await mkdir(process.env.DAOCUT_TRASH_DIR, { recursive: true });
  let studio, browser;
  const pageErrors = [], forbidden = [], batchRequests = [], batchReads = [], revealedBatches = [], drafts = new Map();
  const batches = [];
  try {
    studio = await startStudio({ port: 0, editorDir: resolve(process.env.DAOCUT_STRUCTURE_UI ?? join(base, '../ui')), openBrowser() {},
      authorizeTask() { forbidden.push('server-authorize'); throw Error('No external tasks in isolated UI acceptance'); } });
    const api = async (path, method = 'GET', body) => {
      const response = await fetch(`${studio.origin}${path}`, { method, headers: { 'x-studio-key': studio.key,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const value = await response.json(); assert.equal(response.status, 200, `${path}: ${JSON.stringify(value)}`); return value;
    };
    const { project } = await api('/api/projects', 'POST', { path: join(scratch, 'synthetic-parent') });
    await mkdir(join(project.path, 'assets'), { recursive: true });
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=96x160:rate=10:duration=16', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=16',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', join(project.path, 'assets/synthetic-live.mp4')], { windowsHide: true });
    await writeFile(join(project.path, 'assets/synthetic-live.vtt'), 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n这是合成钩子\n\n00:00:04.000 --> 00:00:07.000\n这是合成核心购买理由\n\n00:00:12.000 --> 00:00:14.000\n需要的点击购买\n');
    const scope = { sourceId: 's', productId: 'p', intervalId: 'i', startMs: 0, endMs: 16000 };
    const clips = [
      { candidateId: 'hook', sourceId: 's', assetPath: 'assets/synthetic-live.mp4', startMs: 0, endMs: 2000, text: '这是合成钩子', roles: ['hook'], coreIds: [] },
      { candidateId: 'core', sourceId: 's', assetPath: 'assets/synthetic-live.mp4', startMs: 4000, endMs: 7000, text: '这是合成核心购买理由', roles: ['core'], coreIds: ['fixture-benefit'] },
      { candidateId: 'close', sourceId: 's', assetPath: 'assets/synthetic-live.mp4', startMs: 12000, endMs: 14000, text: '需要的点击购买', roles: ['purchase'], coreIds: [] },
    ];
    const plans = Array.from({ length: 256 }, (_, index) => ({ id: `batch-ui-plan-${index + 1}`, version: 'synthetic-v1', scope, speed: 1, durationMs: 7000,
      coreIds: ['fixture-benefit'], coreLabels: { 'fixture-benefit': '合成购买理由' }, clips: structuredClone(clips) }));
    const publicTask = 'synthetic-batch-ui-task';
    const analysis = { version: 1, sources: [{ id: 's', assetPath: 'assets/synthetic-live.mp4', durationMs: 16000 }],
      products: [{ id: 'p', name: '批量导出隔离商品', sourceIds: ['s'] }], intervals: [{ id: 'i', sourceId: 's', productId: 'p', startMs: 0, endMs: 16000 }],
      candidates: clips.map((clip, index) => ({ ...clip, id: clip.candidateId, productId: 'p', intervalId: 'i', cueRange: [index, index],
        tags: clip.roles.map(role => ({ hook: '钩子', core: '卖点', purchase: '行动指令' })[role]), origin: 'synthetic-test', version: 1 })) };
    await api(`/api/projects/${project.id}/product-analysis`, 'PUT', { analysis });
    await writeProjectFilm(project.path, { stage: { w: 96, h: 160 }, tracks: [{ clips: [{ id: 'existing-film', src: 'assets/synthetic-live.mp4', at: 0, time: [14, 15] }] }] });
    await api(`/api/projects/${project.id}/settings`, 'PATCH', { fps: 30 });
    await api(`/api/projects/${project.id}/subtitles`, 'PUT', { style: { on: true } });
    const protectedFiles = ['film.html', 'assets/synthetic-live.mp4', 'assets/synthetic-live.vtt', '.film/product-analysis.json', '.film/settings.json', '.film/subtitles.json'];
    const parentHashes = await Promise.all(protectedFiles.map(async path => sha(await readFile(join(project.path, path)))));

    browser = await chromium.launch({ executablePath: process.env.DAOCUT_TEST_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true,
      args: ['--autoplay-policy=no-user-gesture-required'] });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const ordinaryFolder = join(scratch, 'ordinary-export-saved');
    await page.addInitScript(folder => localStorage.setItem('daocut.exportCenter.v1', JSON.stringify({ folder })), ordinaryFolder);
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (![studio.origin, studio.filmOrigin].includes(url.origin)) return route.abort();
      if (request.method() !== 'GET' && /\/(?:live-analysis\/(?:analyze|transcribe)|product-workflow\/execute|subtitles\/(?:transcribe|translate)|turns|chat|exports)(?:\/|$)/.test(url.pathname)) {
        forbidden.push(url.pathname); return route.fulfill({ status: 409, json: { error: 'Models and actual exports forbidden in UI fixture' } });
      }
      return route.continue();
    });
    await page.route('**/live-analysis**', route => route.request().method() === 'GET'
      ? route.fulfill({ json: { transcription: { status: 'complete', segments: [] }, analysis: { status: 'complete', intervalId: 'i', productId: 'p', rangeStartMs: 0, rangeEndMs: 16000, stale: false } } })
      : route.fulfill({ status: 409, json: { error: 'No analysis allowed' } }));
    await page.route('**/structure-plans**', route => route.fulfill({ json: { status: 'complete', taskKey: publicTask, context: { ...scope, visibility: 'shared' },
      plans, complete: true, materialComplete: true, allValidCombinationsEnumerated: true, issues: [], requestCount: 0 } }));
    await page.route('**/structure-drafts', async route => {
      try {
        const plan = plans.find(p => p.id === route.request().postDataJSON().planId); assert.ok(plan);
        const draft = await ensureStructureDraft(project.path, { parentProjectId: project.id, plan });
        const child = await openProject(draft.root); drafts.set(plan.id, { ...draft, project: child });
        await route.fulfill({ json: { project: child, meta: draft.meta } });
      } catch (error) { pageErrors.push(error.message); await route.fulfill({ status: 500, json: { error: error.message } }); }
    });
    await page.route('**/structure-exports**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (request.method() === 'GET') { batchReads.push(path); return route.fulfill({ json: { batches, folder: join(scratch, 'exports'), jianyingFolder: join(scratch, 'mock-jianying-drafts') } }); }
      if (request.method() === 'POST' && path.endsWith('/reveal')) { revealedBatches.push(path); return route.fulfill({ json: { folder: batches[0].folder } }); }
      if (request.method() !== 'POST' || !path.endsWith('/structure-exports')) return route.fulfill({ status: 409, json: { error: 'Unexpected simulated batch operation' } });
      const body = request.postDataJSON(); batchRequests.push({ path, body });
      const batch = { id: `mock-batch-${batchRequests.length}`, createdAt: new Date().toISOString(), status: 'running',
        folder: join(scratch, 'mock-export-output'), total: body.planIds.length, completed: 0, failed: 0, progress: 0,
        items: body.planIds.map((id, index) => ({ id: String(index), planId: id, label: `方案 ${String(plans.findIndex(p => p.id === id) + 1).padStart(3, '0')}`,
          origin: drafts.has(id) ? 'private' : 'public', revision: 'frozen-test-revision', status: 'waiting', progress: 0, outputs: [], retryable: false })) };
      batches.unshift(batch); return route.fulfill({ json: batch });
    });
    let delayedExportInfo, delayNextExportInfo = false;
    await page.route('**/exports', async route => {
      if (route.request().method() === 'GET' && delayNextExportInfo && !delayedExportInfo) {
        delayedExportInfo = route;
        return;
      }
      return route.continue();
    });

    await page.goto(`${studio.origin}/projects/${project.id}?key=${studio.key}`);
    const productMode = page.getByRole('button', { name: '商品与结构', exact: true });
    if (await productMode.count()) await productMode.click();
    const product = page.locator('[data-product-card="p"]'); await product.waitFor();
    await product.getByRole('button', { name: '拼结构', exact: true }).click();
    const panel = page.getByRole('complementary', { name: '公共结构方案' });
    const virtualList = panel.locator('[data-virtual-list][aria-label="结构方案列表"]');
    const first = panel.locator('[data-structure-plan="batch-ui-plan-1"]');
    await first.waitFor();
    const exportButton = page.getByRole('button', { name: '导出', exact: true });
    assert.equal(await panel.getByRole('button', { name: /^批量导出剪映草稿/ }).count(), 0, 'only the original top export entry starts export');
    delayNextExportInfo = true;
    await exportButton.click();
    const dialog = page.getByRole('dialog', { name: '导出', exact: true });
    await dialog.waitFor();
    assert.equal(await dialog.getByText('已选 0 条方案', { exact: true }).count(), 0, 'no selection preserves the ordinary export dialog');
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    assert.equal(await panel.getByText('已选 0 条', { exact: true }).count(), 1);
    const initialRendered = await panel.locator('[data-structure-plan]').count();
    assert.ok(initialRendered > 0 && initialRendered < 30, `256 plans must virtualize; rendered ${initialRendered}`);
    assert.equal(batchRequests.length, 0);
    await panel.getByRole('button', { name: '全选全部方案', exact: true }).click();
    await panel.getByText('已选 256 条', { exact: true }).waitFor();
    assert.equal(batchRequests.length, 0, 'select-all alone must not export');
    await exportButton.click();
    await dialog.getByText('已选 256 条方案', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await panel.getByText('已选 256 条', { exact: true }).waitFor();
    assert.equal(batchRequests.length, 0, 'closing the dialog preserves selection without exporting');
    await panel.getByRole('button', { name: '清空选择', exact: true }).click();
    await panel.getByText('已选 0 条', { exact: true }).waitFor();

    await first.getByRole('checkbox', { name: '选择方案 1 导出', exact: true }).check();
    await first.getByRole('button', { name: '预览方案 1', exact: true }).click();
    await page.locator('[data-structure-preview="batch-ui-plan-1"]').waitFor();
    assert.equal(await first.getByRole('checkbox').isChecked(), true, 'preview keeps checked selection');
    await virtualList.evaluate(element => { element.scrollTop = element.scrollHeight; });
    const last = panel.locator('[data-structure-plan="batch-ui-plan-256"]'); await last.waitFor();
    await last.getByRole('checkbox', { name: '选择方案 256 导出', exact: true }).check();
    await panel.getByText('已选 2 条', { exact: true }).waitFor();
    assert.ok(await panel.locator('[data-structure-plan]').count() < 30);
    await exportButton.click();
    await dialog.getByText('已选 2 条方案', { exact: true }).waitFor();
    assert.ok(delayedExportInfo, 'ordinary export metadata request was sent');
    await delayedExportInfo.fulfill({ json: { exports: [], folder: join(scratch, 'late-ordinary-folder'), drafts: {}, subtitles: 0, can: {} } });
    await page.waitForTimeout(100);
    await dialog.getByText(join(scratch, 'mock-jianying-drafts'), { exact: true }).waitFor();
    await dialog.getByRole('button', { name: '指定文件夹', exact: true }).click();
    await dialog.getByText(join(scratch, 'exports'), { exact: true }).waitFor();
    await dialog.getByRole('button', { name: '剪映草稿库', exact: true }).click();
    assert.equal(batchRequests.length, 0, 'opening the original export dialog must not submit');
    const nameField = dialog.getByRole('textbox', { name: '名称', exact: true });
    await nameField.fill('随行杯测试');
    await dialog.getByText('随行杯测试_方案001', { exact: true }).waitFor();
    await dialog.getByText('随行杯测试_方案256', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: '批量导出 2 份剪映草稿', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('aside[aria-label="公共结构方案"] p')].some(x => x.textContent === '已选 0 条'));
    assert.equal(batchRequests.length, 1);
    assert.deepEqual(batchRequests[0].body.planIds, ['batch-ui-plan-1', 'batch-ui-plan-256']);
    assert.equal(batchRequests[0].path, `/api/projects/${project.id}/structure-exports`);
    assert.equal(batchRequests[0].body.taskKey, publicTask);
    assert.equal(batchRequests[0].body.name, '随行杯测试');
    assert.equal(batchRequests[0].body.folder, join(scratch, 'mock-jianying-drafts'));
    assert.equal(batchRequests[0].body.destination, 'jianying');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('daocut.exportCenter.v1')).folder), ordinaryFolder, 'batch export must not replace ordinary export settings');
    for (const [key, value] of Object.entries(scope)) assert.equal(batchRequests[0].body[key], value);
    assert.match(batchRequests[0].body.requestId, /^[a-f0-9-]{36}$/);

    await virtualList.evaluate(element => { element.scrollTop = 0; }); await first.waitFor();
    await first.getByRole('button', { name: '编辑副本', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-active-structure-draft]')?.getAttribute('data-active-structure-draft')?.startsWith('sd-'));
    const draft = drafts.get('batch-ui-plan-1'); assert.ok(draft);
    await first.getByRole('checkbox', { name: '选择方案 1 导出', exact: true }).check();
    await page.getByRole('button', { name: '字幕样式', exact: true }).last().click();
    const italic = page.locator('[data-subtitle-inspector]').getByRole('button', { name: '斜体', exact: true });
    await italic.scrollIntoViewIfNeeded();
    const expectedItalic = (await italic.getAttribute('aria-pressed')) !== 'true';
    let rejectStyleSave = true, rejectedSaves = 0;
    await page.route(`**/api/projects/${draft.project.id}/subtitles`, route => {
      if (route.request().method() === 'PUT' && rejectStyleSave) { rejectedSaves++; return route.fulfill({ status: 503, json: { error: '模拟批量导出前字幕保存失败' } }); }
      return route.continue();
    });
    await italic.click(); await exportButton.click();
    await dialog.getByRole('button', { name: '批量导出 1 份剪映草稿', exact: true }).click();
    await panel.getByRole('alert').filter({ hasText: /未保存|保存失败/ }).waitFor();
    assert.ok(rejectedSaves > 0);
    assert.equal(batchRequests.length, 1, 'failed draft save must not POST a batch');
    assert.equal(await page.locator('[data-active-structure-draft]').getAttribute('data-active-structure-draft'), draft.project.id);
    assert.equal(await first.getByRole('checkbox').isChecked(), true, 'selection survives a failed save');
    rejectStyleSave = false; await dialog.getByRole('button', { name: '批量导出 1 份剪映草稿', exact: true }).click();
    await panel.getByText('已选 0 条', { exact: true }).waitFor();
    assert.equal(batchRequests.length, 2); assert.deepEqual(batchRequests[1].body.planIds, ['batch-ui-plan-1']);
    assert.equal(batchRequests[1].path, `/api/projects/${project.id}/structure-exports`, 'private timeline still submits its parent batch');
    await panel.getByRole('button', { name: '打开文件夹', exact: true }).first().click();
    assert.deepEqual(revealedBatches, [`/api/projects/${project.id}/structure-exports/mock-batch-2/reveal`]);
    assert.equal((await api(`/api/projects/${draft.project.id}/subtitles`)).style.font.italic, expectedItalic);
    await panel.getByText('剪映批量导出 · 0/1', { exact: true }).waitFor();
    await panel.getByRole('combobox', { name: '我的独立草稿', exact: true }).selectOption(project.id);
    await page.waitForFunction(id => document.querySelector('[data-active-structure-draft]')?.getAttribute('data-active-structure-draft') === id, project.id);
    batches[0].progress = 0.75; batches[0].items[0].status = 'running'; batches[0].items[0].progress = 0.75;
    await page.waitForFunction(() => [...document.querySelectorAll('progress[aria-label="批量导出进度"]')].some(p => p.value === 0.75));
    assert.ok(batchReads.length > 1 && batchReads.every(path => path === `/api/projects/${project.id}/structure-exports`), 'progress remains attached to parent after switching drafts');
    assert.deepEqual(await Promise.all(protectedFiles.map(async path => sha(await readFile(join(project.path, path))))), parentHashes);
    assert.deepEqual(forbidden, []); assert.deepEqual(pageErrors, []);
    await page.screenshot({ path: join(scratch, 'batch-selection-and-progress.png') });
    await writeFile(join(scratch, 'result.json'), JSON.stringify({ passed: true, publicPlans: 256, initialRendered, selectedFirstBatch: batchRequests[0].body.planIds,
      batchPosts: batchRequests.length, failedSaveBlockedPost: true, progressProjectId: project.id, parentProtected: true, actualExports: 0, modelRequests: 0 }, null, 2));
  } finally {
    const currentPage = browser?.contexts()[0]?.pages()[0];
    if (currentPage) {
      await currentPage.screenshot({ path: join(scratch, 'last-screen.png') }).catch(() => {});
      await writeFile(join(scratch, 'last-dialog.txt'), await currentPage.locator('body').innerText().catch(() => '')).catch(() => {});
      await writeFile(join(scratch, 'page-errors.json'), JSON.stringify(pageErrors)).catch(() => {});
    }
    await browser?.close(); await studio?.close();
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});
