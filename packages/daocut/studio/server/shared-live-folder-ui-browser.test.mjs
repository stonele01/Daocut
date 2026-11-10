import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startStudio } from './server.mjs';

test('daily live-folder UI opens shared results without manual IDs and continues private projects', { timeout: 120000 }, async t => {
  const base = resolve(process.env.DAOCUT_TEST_TMP || '.tmp/live-folder-flow-20261106/ui');
  await mkdir(base, { recursive: true });
  const scratch = await mkdtemp(join(base, 'daily-'));
  const keys = ['DAOCUT_STUDIO_HOME', 'DAOCUT_LIBRARY', 'DAOCUT_TRASH_DIR'];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { DAOCUT_STUDIO_HOME: join(scratch, 'home'), DAOCUT_LIBRARY: join(scratch, 'projects'), DAOCUT_TRASH_DIR: join(scratch, 'trash') });
  let studio, browser, latePicker;
  const calls = [], folder = join(scratch, 'mock-live-folder');
  let mode = 'initialize', picked = folder;
  try {
    studio = await startStudio({ port: 0, openBrowser: () => {}, ...(process.env.DAOCUT_TEST_EDITOR_DIR ? { editorDir: resolve(process.env.DAOCUT_TEST_EDITOR_DIR) } : {}) });
    const api = async (path, method = 'GET', body) => {
      const response = await fetch(`${studio.origin}/api/${path}`, { method, headers: { 'x-studio-key': studio.key, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      assert.equal(response.status, 200); return response.json();
    };
    const a = (await api('projects', 'POST', { path: join(scratch, 'projects', 'private-a') })).project;
    const b = (await api('projects', 'POST', { path: join(scratch, 'projects', 'private-b') })).project;
    const library = { id: 'mock-live-identity', name: '模拟直播', root: folder };
    const video = name => ({ path: name, name, size: 100, mtimeMs: 1 });
    const ready = () => ({ status: 'ready', folder, name: library.name, resultRoot: join(folder, '.daocut-shared'), legacy: false, library, videos: mode === 'multiple' ? [video('一号.mp4'), video('二号.mp4')] : [video('原片.mp4')], transcripts: [], moreVideos: false, moreTranscripts: false, warnings: [] });
    browser = await chromium.launch({ executablePath: process.env.DAOCUT_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
    page.setDefaultTimeout(12000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (![studio.origin, studio.filmOrigin].includes(url.origin)) return route.abort();
      if (url.pathname === '/api/pick-folder') return route.fulfill({ json: { path: picked === 'pending' ? await new Promise(resolve => { latePicker = resolve; }) : picked } });
      if (url.pathname === '/api/shared-media/live-folder') {
        const body = req.postDataJSON(); calls.push({ type: 'folder', ...body });
        return route.fulfill({ json: mode === 'initialize' && !body.initialize ? { ...ready(), status: 'needs-initialization', library: undefined, folder: body.folder, resultRoot: join(body.folder, '.daocut-shared') } : { ...ready(), folder: body.folder } });
      }
      if (url.pathname === '/api/shared-media/live-project') {
        const body = req.postDataJSON(); calls.push({ type: 'project', ...body });
        if (mode === 'choices' && !body.projectId && !body.createNew) return route.fulfill({ json: { status: 'choose-project', projects: [a, b] } });
        return route.fulfill({ json: { status: 'opened', reused: true, project: body.projectId === b.id ? b : a, asset: 'assets/原片.mp4', source: { libraryId: library.id, relativePath: '原片.mp4' } } });
      }
      if (req.method() === 'POST' && /product-workflow\/execute|\/transcribe|\/discover/.test(url.pathname)) {
        calls.push({ type: 'forbidden-model' }); return route.abort();
      }
      return route.continue();
    });
    const open = async () => {
      await page.goto(`${studio.origin}/?key=${studio.key}`);
      const entry = page.getByRole('button', { name: '打开直播文件夹', exact: true });
      await page.getByRole('button', { name: /^(打开直播文件夹|项目)$/ }).first().waitFor({ state: 'visible' });
      if (!await entry.isVisible()) await page.getByRole('button', { name: '项目', exact: true }).click();
      await entry.click();
      return page.getByRole('dialog', { name: '打开直播文件夹', exact: true });
    };
    const opened = async (dialog, id) => { await dialog.waitFor({ state: 'detached' }); await page.waitForURL(`**/projects/${id}**`); };
    await t.test('new folder asks once before creating shared storage, with no ID fields', async () => {
      mode = 'initialize'; picked = folder;
      const dialog = await open();
      assert.equal(await dialog.getByRole('button', { name: '选择直播文件夹', exact: true }).isEnabled(), true, 'first use must not require manual library configuration');
      assert.equal(await dialog.getByLabel('已有素材库 ID（可选）').isVisible(), false);
      await dialog.getByRole('button', { name: '选择直播文件夹', exact: true }).click();
      await dialog.getByRole('button', { name: '创建共享结果目录并打开', exact: true }).waitFor();
      assert.equal(calls.filter(call => call.initialize === true).length, 0);
      assert.equal(calls.filter(call => call.type === 'project').length, 0);
      await dialog.getByRole('button', { name: '创建共享结果目录并打开', exact: true }).click();
      await opened(dialog, a.id);
      assert.equal(calls.filter(call => call.initialize === true).length, 1);
    });
    await t.test('existing folder continues the private project without initialization', async () => {
      calls.length = 0; mode = 'ready';
      const dialog = await open();
      await dialog.getByRole('button', { name: '选择直播文件夹', exact: true }).click();
      await opened(dialog, a.id);
      assert.equal(calls.some(call => call.initialize === true), false);
      assert.equal(calls.filter(call => call.type === 'project').length, 1);
      assert.equal(calls.find(call => call.type === 'project').createNew, undefined);
    });
    await t.test('multiple videos require explicit source selection', async () => {
      calls.length = 0; mode = 'multiple';
      const dialog = await open();
      await dialog.getByRole('button', { name: '选择直播文件夹', exact: true }).click();
      await dialog.getByRole('button', { name: '二号.mp4', exact: true }).waitFor();
      assert.equal(calls.filter(call => call.type === 'project').length, 0);
      await dialog.getByRole('button', { name: '二号.mp4', exact: true }).click();
      await dialog.getByRole('button', { name: '打开所选视频', exact: true }).click();
      await opened(dialog, a.id);
      assert.equal(calls.find(call => call.type === 'project').videoPath, '二号.mp4');
    });
    await t.test('multiple private projects are selected, never silently overwritten or recreated', async () => {
      calls.length = 0; mode = 'choices';
      const dialog = await open();
      await dialog.getByRole('button', { name: '选择直播文件夹', exact: true }).click();
      await dialog.getByRole('button', { name: `继续：${b.name}`, exact: true }).click();
      await opened(dialog, b.id);
      const selections = calls.filter(call => call.type === 'project');
      assert.equal(selections.length, 2); assert.equal(selections[1].projectId, b.id);
      assert.equal(selections[1].createNew, undefined);
    });
    await t.test('a late picker cannot replace the folder entered manually', async () => {
      calls.length = 0; mode = 'ready'; picked = 'pending';
      const dialog = await open();
      await dialog.getByRole('button', { name: '选择直播文件夹', exact: true }).click();
      await dialog.getByRole('button', { name: '改用粘贴路径', exact: true }).click();
      await dialog.getByPlaceholder('直播文件夹完整路径', { exact: true }).fill(folder);
      await dialog.getByRole('button', { name: '使用路径', exact: true }).click();
      await opened(dialog, a.id);
      latePicker(join(scratch, 'unwanted-folder'));
      await page.waitForTimeout(100);
      assert.equal(calls.filter(call => call.type === 'folder').length, 1);
      assert.equal(calls.find(call => call.type === 'folder').folder, folder);
    });
    assert.equal(calls.some(call => call.type === 'forbidden-model'), false);
    assert.deepEqual(errors, []);
  } finally {
    latePicker?.(null); await browser?.close(); await studio?.close();
    for (const key of keys) before[key] === undefined ? delete process.env[key] : process.env[key] = before[key];
  }
});

test('real local folder routes initialize once and reopen the same edited private project through the UI', { timeout: 90000 }, async () => {
  const base = resolve(process.env.DAOCUT_TEST_TMP || '.tmp/live-folder-flow-20261106/ui');
  await mkdir(base, { recursive: true });
  const scratch = await mkdtemp(join(base, 'integrated-')), media = join(scratch, '直播 (模拟)');
  await mkdir(media);
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=10:d=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', join(media, '原片 (1).mp4')], { windowsHide: true });
  const keys = ['DAOCUT_STUDIO_HOME', 'DAOCUT_LIBRARY', 'DAOCUT_TRASH_DIR', 'DAOCUT_NO_UPDATE_CHECK'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { DAOCUT_STUDIO_HOME: join(scratch, 'home'), DAOCUT_LIBRARY: join(scratch, 'projects'), DAOCUT_TRASH_DIR: join(scratch, 'trash'), DAOCUT_NO_UPDATE_CHECK: '1' });
  let studio, browser, modelCalls = 0;
  const forbid = async () => { modelCalls++; throw Error('Unexpected model request'); };
  try {
    studio = await startStudio({ port: 0, openBrowser: () => {}, editorDir: process.env.DAOCUT_TEST_EDITOR_DIR ? resolve(process.env.DAOCUT_TEST_EDITOR_DIR) : undefined,
      sharedAnalysis: { coordinate: async action => { assert.ok(['status', 'catalog'].includes(action)); return { coordinationId: 'e'.repeat(64), task: null, results: [] }; } },
      liveAnalysis: { transcriber: forbid, modelClient: forbid }, productDiscovery: { modelClient: forbid },
    });
    const api = async (path, method = 'GET', body) => {
      const response = await fetch(`${studio.origin}/api/${path}`, { method, headers: { 'x-studio-key': studio.key, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
    };
    browser = await chromium.launch({ executablePath: process.env.DAOCUT_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } }); page.setDefaultTimeout(15000);
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (![studio.origin, studio.filmOrigin].includes(url.origin)) return route.abort();
      if (url.pathname === '/api/pick-folder') return route.fulfill({ json: { path: media } });
      return route.continue();
    });
    const open = async () => {
      await page.goto(`${studio.origin}/?key=${studio.key}`);
      const entry = page.getByRole('button', { name: '打开直播文件夹', exact: true });
      await page.getByRole('button', { name: /^(打开直播文件夹|项目)$/ }).first().waitFor({ state: 'visible' });
      if (!await entry.isVisible()) await page.getByRole('button', { name: '项目', exact: true }).click();
      await entry.click();
      const dialog = page.getByRole('dialog', { name: '打开直播文件夹', exact: true });
      await dialog.getByRole('button', { name: '选择直播文件夹', exact: true }).click(); return dialog;
    };
    let dialog = await open();
    await dialog.getByRole('button', { name: '创建共享结果目录并打开', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    await page.waitForURL(/\/projects\//);
    const projectId = new URL(page.url()).pathname.split('/').at(-1);
    const split = page.getByRole('button', { name: '拆商品', exact: true });
    await split.waitFor({ state: 'visible' });
    const position = await split.boundingBox();
    assert.ok(position && position.y < 400, 'a new live folder must expose the next daily action above the product list');
    const state = await api(`projects/${projectId}/product-analysis`);
    assert.equal(state.analysis.sources[0].durationMs, 3000);
    state.analysis.products[0].name = '我的个人商品修改';
    await api(`projects/${projectId}/product-analysis`, 'PUT', { analysis: state.analysis });
    const project = (await api('projects')).projects.find(item => item.id === projectId);
    const original = await readFile(join(project.path, '.film', 'product-analysis.json'), 'utf8');
    const manifest = await readFile(join(media, '.daocut-shared', 'manifest.json'), 'utf8');
    dialog = await open(); await dialog.waitFor({ state: 'detached' });
    await page.waitForURL(`**/projects/${projectId}**`);
    assert.equal((await api('projects')).projects.length, 1);
    assert.equal(await readFile(join(project.path, '.film', 'product-analysis.json'), 'utf8'), original);
    assert.equal(await readFile(join(media, '.daocut-shared', 'manifest.json'), 'utf8'), manifest);
    assert.equal(modelCalls, 0);
    await page.screenshot({ path: join(base, 'daily-folder-private-project.png'), animations: 'disabled' });
  } finally {
    await browser?.close(); await studio?.close();
    for (const key of keys) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key];
  }
});
