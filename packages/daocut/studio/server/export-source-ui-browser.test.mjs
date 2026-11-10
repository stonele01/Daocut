import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startStudio } from './server.mjs';
import { filmHtml } from '../../src/film-doc.mjs';

test('export dialog blocks a changed shared source while preserving the existing film', { timeout: 60000 }, async () => {
  const base = resolve(import.meta.dirname, '../../../../.tmp/source-safety-20261105/ui');
  await mkdir(base, { recursive: true });
  const scratch = await mkdtemp(join(base, 'browser-'));
  const keys = ['DAOCUT_STUDIO_HOME', 'DAOCUT_LIBRARY', 'DAOCUT_TRASH_DIR', 'DAOCUT_EXPORTS', 'DAOCUT_NO_UPDATE_CHECK', 'TEMP', 'TMP'];
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) { process.env[key] = key === 'DAOCUT_NO_UPDATE_CHECK' ? '1' : join(scratch, key); if (key !== 'DAOCUT_NO_UPDATE_CHECK') await mkdir(process.env[key]); }
  let studio, browser, modelCalls = 0, exportPosts = 0;
  try {
    studio = await startStudio({ port: 0, openBrowser() {}, authorizeTask: async () => { modelCalls++; throw Error('models forbidden'); } });
    const created = await fetch(`${studio.origin}/api/projects`, { method: 'POST', headers: { 'x-studio-key': studio.key, 'content-type': 'application/json' }, body: JSON.stringify({ path: join(scratch, 'project') }) });
    assert.equal(created.status, 200); const { project } = await created.json();
    const media = join(project.path, 'assets/synthetic.mp4'); await mkdir(join(project.path, 'assets'), { recursive: true });
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=96x64:r=5:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', media], { windowsHide: true });
    const film = filmHtml({ stage: { w: 96, h: 64 }, tracks: [{ clips: [{ id: 'test-clip', src: 'assets/synthetic.mp4', time: [0, 2] }] }] });
    await writeFile(join(project.path, 'film.html'), film);
    const originalMedia = await readFile(media);
    browser = await chromium.launch({ executablePath: process.env.DAOCUT_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const page = await browser.newPage({ viewport: { width: 1450, height: 1000 } }); page.setDefaultTimeout(8000);
    await page.addInitScript(() => localStorage.setItem('daocut.language', 'zh-CN'));
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (![studio.origin, studio.filmOrigin].includes(url.origin)) return route.abort();
      if (url.pathname.endsWith('/exports') && request.method() === 'POST') { exportPosts++; return route.fulfill({ status: 500, json: { error: 'unexpected export' } }); }
      if (url.pathname === `/api/projects/${project.id}/files` && request.method() === 'GET') {
        const response = await route.fetch(), data = await response.json();
        // Only the metadata state is simulated; the video, project, server and UI are real isolated fixtures.
        data.links = { ...data.links, 'assets/synthetic.mp4': { to: media, source: { libraryId: 'isolated', libraryName: '合成测试库', relativePath: 'synthetic.mp4', size: originalMedia.length, mtimeMs: 1, status: 'needs-confirmation' } } };
        return route.fulfill({ response, json: data });
      }
      return route.continue();
    });
    await page.goto(`${studio.origin}/projects/${project.id}?key=${studio.key}`);
    await page.locator('[data-timeline-scope="main"] [data-block-kind="video"]').waitFor();
    const dialog = page.getByRole('dialog', { name: '导出', exact: true });
    for (let n = 0; n < 40 && !await dialog.isVisible(); n++) {
      await page.getByRole('button', { name: '导出', exact: true }).first().click();
      await page.waitForTimeout(100);
    }
    try { await dialog.waitFor(); } catch (error) { console.log((await page.locator('body').innerText()).slice(-5000)); throw error; }
    assert.equal(await dialog.getByRole('button', { name: '导出', exact: true }).isDisabled(), true, 'changed shared source must block export before submission');
    await dialog.getByText(/共享原片.*变化/).waitFor();
    assert.match(await dialog.innerText(), /synthetic\.mp4/);
    assert.equal(exportPosts, 0); assert.equal(modelCalls, 0);
    assert.equal(await readFile(join(project.path, 'film.html'), 'utf8'), film);
    assert.deepEqual(await readFile(media), originalMedia);
  } finally {
    await browser?.close(); await studio?.close();
    for (const key of keys) old[key] === undefined ? delete process.env[key] : process.env[key] = old[key];
  }
});
