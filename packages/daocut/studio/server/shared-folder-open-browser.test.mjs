// Real local folder/project routes; only the OS picker is simulated. No NAS or provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startStudio } from './server.mjs';
import { readFilmFile } from '../../src/film-doc.mjs';

test('live folder entry opens one video, asks for multiple and preserves cancellation/retry', { timeout: 120000 }, async t => {
  const base = resolve(import.meta.dirname, '../../../../.tmp/folder-flow-20261106/browser');
  await mkdir(base, { recursive: true });
  const scratch = await mkdtemp(join(base, 'folders-'));
  const keys = ['DAOCUT_STUDIO_HOME', 'DAOCUT_LIBRARY', 'DAOCUT_TRASH_DIR', 'DAOCUT_NO_UPDATE_CHECK'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys.slice(0, 3)) process.env[key] = join(scratch, key);
  process.env.DAOCUT_NO_UPDATE_CHECK = '1';
  await mkdir(process.env.DAOCUT_TRASH_DIR);
  let studio, browser, page, providerCalls = 0;
  const pageErrors = [];
  const creates = [];
  let pick = null, pendingPick, failOnce = false;
  const media = join(scratch, 'media'), single = join(media, 'single'), multiple = join(media, 'multiple');
  for (const dir of [single, multiple, join(single, 'nested'), join(media, 'empty')]) await mkdir(dir, { recursive: true });
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=5:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', join(single, 'one.mp4')], { windowsHide: true });
  for (const file of [join(multiple, 'one.mp4'), join(multiple, 'two.mp4'), join(single, 'nested', 'not-read.mp4')]) await copyFile(join(single, 'one.mp4'), file);
  try {
    studio = await startStudio({ port: 0, editorDir: process.env.DAOCUT_TEST_EDITOR_DIR ? resolve(process.env.DAOCUT_TEST_EDITOR_DIR) : undefined, openBrowser: () => {},
      liveAnalysis: { transcriber: async () => { providerCalls++; throw new Error('Unexpected provider'); }, modelClient: async () => { providerCalls++; throw new Error('Unexpected provider'); } },
      productDiscovery: { modelClient: async () => { providerCalls++; throw new Error('Unexpected provider'); } },
    });
    const api = async (path, method = 'GET', body) => {
      const response = await fetch(`${studio.origin}/api/${path}`, { method, headers: { 'x-studio-key': studio.key, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
    };
    await api('shared-media/libraries', 'POST', { id: 'folder-flow-library', name: '本机隔离测试', root: media });
    browser = await chromium.launch({ executablePath: process.env.DAOCUT_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, locale: 'zh-CN' });
    page.setDefaultTimeout(12000);
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('response', response => {
      if (response.status() >= 400 && ['document', 'script', 'stylesheet'].includes(response.request().resourceType())) {
        pageErrors.push(`Editor asset ${new URL(response.url()).pathname}: HTTP ${response.status()}`);
      }
    });
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (![studio.origin, studio.filmOrigin].includes(url.origin)) return route.abort();
      if (url.pathname === '/api/pick-folder') {
        const path = pick === 'pending' ? await new Promise(resolve => { pendingPick = resolve; }) : pick;
        return route.fulfill({ json: { path } });
      }
      if (url.pathname === '/api/shared-media/projects' && request.method() === 'POST') {
        creates.push(request.postDataJSON());
        if (failOnce) { failOnce = false; return route.fulfill({ status: 503, json: { error: '模拟读取失败，请重试' } }); }
      }
      return route.continue();
    });
    const open = async () => {
      const response = await page.goto(`${studio.origin}/?key=${studio.key}`);
      assert.equal(response?.status(), 200, 'editor document loads');
      const entry = page.getByRole('button', { name: '打开直播文件夹', exact: true });
      const projects = page.getByRole('button', { name: '项目', exact: true });
      try { await Promise.race([entry.waitFor(), projects.waitFor()]); }
      catch (error) { await page.screenshot({ path: join(scratch, 'entry-failed.png') }); console.error(await page.locator('body').innerText()); throw error; }
      if (!await entry.isVisible()) await projects.click();
      await entry.click();
      await page.getByRole('button', { name: '手动配置旧素材库', exact: true }).click();
      return page.getByRole('dialog', { name: '打开直播文件夹', exact: true });
    };
    await t.test('configured library hides internal IDs; single direct video opens automatically', async () => {
      const dialog = await open();
      await dialog.getByLabel('当前素材库 ID').waitFor({ state: 'attached' });
      assert.equal(await dialog.getByLabel('当前素材库 ID').isVisible(), false);
      await page.screenshot({ path: join(base, 'folder-entry.png'), animations: 'disabled' });
      pick = single;
      await dialog.getByRole('button', { name: '选择直播文件夹', exact: true }).click();
      await page.waitForURL(/\/projects\//);
      assert.equal(creates.length, 1); assert.equal(creates[0].videoPath, 'single/one.mp4');
      const projectId = new URL(page.url()).pathname.split('/').at(-1);
      const state = await api(`projects/${projectId}/product-analysis`);
      assert.equal(state.analysis.sources[0].durationMs, 3000);
      const projects = await api('projects');
      const project = projects.projects.find(project => project.id === projectId);
      assert.deepEqual(readFilmFile(await readFile(join(project.path, 'film.html'), 'utf8')).doc.tracks, []);
      assert.equal(providerCalls, 0);
    });
    await t.test('multiple videos require one selection and create only that source', async () => {
      const dialog = await open(); pick = multiple;
      await dialog.getByRole('button', { name: '选择直播文件夹', exact: true }).click();
      await dialog.getByRole('button', { name: 'two.mp4', exact: true }).waitFor();
      assert.equal(creates.length, 1);
      assert.equal(await dialog.getByRole('button', { name: '打开所选视频', exact: true }).isDisabled(), true);
      await dialog.getByRole('button', { name: 'two.mp4', exact: true }).click();
      await dialog.getByRole('button', { name: '打开所选视频', exact: true }).click();
      await page.waitForURL(/\/projects\//);
      assert.equal(creates.length, 2); assert.equal(creates[1].videoPath, 'multiple/two.mp4');
    });
    await t.test('cancelled and empty folders do not create projects', async () => {
      const dialog = await open(); pick = null;
      await dialog.getByRole('button', { name: '选择直播文件夹', exact: true }).click();
      await dialog.getByRole('button', { name: '选择直播文件夹', exact: true }).waitFor({ state: 'visible' });
      pick = join(media, 'empty');
      await dialog.getByRole('button', { name: '选择直播文件夹', exact: true }).click();
      await dialog.getByText('此文件夹没有可用视频。', { exact: true }).waitFor();
      assert.equal(creates.length, 2);
    });
    await t.test('late native picker cannot override typed folder and explicit retry keeps the request ID', async () => {
      const dialog = await open(); pick = 'pending';
      await dialog.getByRole('button', { name: '选择直播文件夹', exact: true }).click();
      await dialog.getByRole('button', { name: '改用粘贴路径', exact: true }).click();
      await dialog.getByText('粘贴文件夹路径', { exact: true }).click();
      await dialog.getByPlaceholder('直播文件夹完整路径', { exact: true }).fill(single);
      failOnce = true;
      await dialog.getByRole('button', { name: '使用路径', exact: true }).click();
      await dialog.getByRole('alert').waitFor();
      pendingPick(multiple);
      assert.equal(creates.length, 3);
      await dialog.getByRole('button', { name: '打开所选视频', exact: true }).click();
      await page.waitForURL(/\/projects\//);
      assert.equal(creates.length, 4); assert.deepEqual(creates[2], creates[3]);
      assert.equal(providerCalls, 0);
    });
    assert.deepEqual(pageErrors, []);
  } finally {
    pendingPick?.(null);
    await browser?.close(); await studio?.close();
    for (const key of keys) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key];
  }
});
