// Full Studio UI with synthetic local media. Only the completed shared-open response
// is controlled here; the analysis read/write route and private editing UI are real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startStudio } from './server.mjs';

test('reopening the current empty project refreshes imported results without a reload or losing a private draft', { timeout: 60000 }, async () => {
  const base = resolve(import.meta.dirname, '../../../../.tmp/live-folder-auto-20261106/reopen-ui');
  await mkdir(base, { recursive: true });
  const scratch = await mkdtemp(join(base, 'current-project-'));
  const names = ['DAOCUT_STUDIO_HOME', 'DAOCUT_LIBRARY', 'DAOCUT_TRASH_DIR', 'DAOCUT_SHARED_HOME', 'DAOCUT_NO_UPDATE_CHECK'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names.slice(0, 4)) process.env[name] = join(scratch, name);
  process.env.DAOCUT_NO_UPDATE_CHECK = '1';
  let studio, browser;
  try {
    studio = await startStudio({ port: 0, editorDir: resolve(process.env.DAOCUT_TEST_EDITOR_DIR), openBrowser: () => {} });
    const api = async (path, method = 'GET', body) => {
      const response = await fetch(`${studio.origin}/api/${path}`, { method, headers: { 'x-studio-key': studio.key, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
    };
    const { project } = await api('projects', 'POST', { path: join(scratch, 'private-project') });
    await mkdir(join(project.path, 'assets'), { recursive: true });
    const assetPath = 'assets/synthetic.mp4';
    execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=96x64:r=5:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', join(project.path, assetPath)], { windowsHide: true });
    const source = { id: 'source', assetPath, durationMs: 3000 };
    const initial = { version: 1, sources: [source], products: [{ id: 'product', name: '直播待拆', sourceIds: [source.id] }], intervals: [], candidates: [] };
    await api(`projects/${project.id}/product-analysis`, 'PUT', { analysis: initial });
    const filmBefore = await readFile(join(project.path, 'film.html'));
    const imported = { ...initial, intervals: [{ id: 'interval', productId: 'product', sourceId: source.id, startMs: 0, endMs: 3000 }], candidates: [{ id: 'candidate', productId: 'product', sourceId: source.id, intervalId: 'interval', startMs: 0, endMs: 1500, text: '同事刚完成的共享话术', tags: ['卖点'], origin: 'demo-data', version: 'reopen-synthetic-v1' }] };
    let report = { status: 'empty', imported: { transcription: 0, discovery: 0, analysis: 0 }, warnings: [], requestCount: 0 };
    const folder = join(scratch, 'synthetic-live'), folderCalls = [], projectCalls = [], forbidden = [], errors = [];
    browser = await chromium.launch({ executablePath: process.env.DAOCUT_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const page = await browser.newPage({ viewport: { width: 1500, height: 1050 } }); page.setDefaultTimeout(8000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (![studio.origin, studio.filmOrigin].includes(url.origin)) return route.abort();
      if (url.pathname === '/api/pick-folder') return route.fulfill({ json: { path: folder } });
      if (url.pathname === '/api/shared-media/live-folder') {
        folderCalls.push(request.postDataJSON());
        return route.fulfill({ json: { status: 'ready', folder, name: '合成直播', resultRoot: join(folder, '.daocut-shared'), legacy: false, library: { id: 'synthetic-library', name: '合成直播', root: folder }, videos: [{ path: 'synthetic.mp4', name: 'synthetic.mp4', size: 1, mtimeMs: 1 }], transcripts: [], moreVideos: false, moreTranscripts: false, warnings: [] } });
      }
      if (url.pathname === '/api/shared-media/live-project') {
        projectCalls.push(request.postDataJSON());
        await api(`projects/${project.id}/product-analysis`, 'PUT', { analysis: imported });
        report = { ...report, status: 'ready', imported: { transcription: 0, discovery: 0, analysis: 1 } };
        return route.fulfill({ json: { status: 'opened', reused: true, project, asset: assetPath, sharedRead: report } });
      }
      if (url.pathname.endsWith('/product-workflow/shared-open')) return route.fulfill({ json: { sharedRead: report } });
      if (url.pathname.endsWith('/product-workflow/status')) return route.fulfill({ json: { source, ready: false, phase: 'transcription', transcription: { status: 'idle', segments: [] }, discovery: { sourceId: source.id, status: 'idle', runs: [] } } });
      if (request.method() !== 'GET' && (/\/product-workflow\/(execute|publish-shared)$/.test(url.pathname) || /\/product-(?:discovery|preparation)\//.test(url.pathname) || url.pathname === '/api/projects' || url.pathname.endsWith('/product-analysis'))) { forbidden.push(url.pathname); return route.abort(); }
      return route.continue();
    });
    await page.goto(`${studio.origin}/projects/${project.id}?key=${studio.key}`);
    await page.getByRole('button', { name: '商品与结构', exact: true }).click();
    await page.getByRole('button', { name: '编辑商品名称：直播待拆', exact: true }).click();
    const draft = page.getByLabel('商品名称', { exact: true }); await draft.fill('我的未保存商品名称');
    await page.getByLabel('已有分析读取状态', { exact: true }).getByText('当前视频尚无已保存的共享分析', { exact: true }).waitFor();
    await page.evaluate(() => { window.__reopenDraftPage = 'preserve-this-page'; });
    await page.getByRole('button', { name: '项目', exact: true }).click();
    await page.getByRole('button', { name: '打开直播文件夹', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '打开直播文件夹', exact: true });
    await dialog.getByRole('button', { name: '选择直播文件夹', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    await page.getByLabel('候选片段', { exact: true }).getByText('同事刚完成的共享话术', { exact: true }).waitFor();
    await page.getByLabel('已有分析读取状态', { exact: true }).getByText('已读取已有分析，可直接预览和选材', { exact: true }).waitFor();
    assert.equal(await draft.inputValue(), '我的未保存商品名称');
    assert.equal(await page.evaluate(() => window.__reopenDraftPage), 'preserve-this-page');
    assert.equal(new URL(page.url()).pathname, `/projects/${project.id}`);
    assert.deepEqual(await readFile(join(project.path, 'film.html')), filmBefore);
    assert.equal((await api('projects')).projects.length, 1);
    assert.equal(folderCalls.length, 1); assert.equal(folderCalls[0].initialize, false);
    assert.equal(projectCalls.length, 1); assert.equal(projectCalls[0].createNew, undefined);
    assert.deepEqual(forbidden, []); assert.deepEqual(errors, []);
  } finally {
    await browser?.close(); await studio?.close();
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});
