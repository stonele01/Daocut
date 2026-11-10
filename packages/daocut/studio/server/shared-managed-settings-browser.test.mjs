// Only isolated synthetic media, local HTTP and browser fixtures; no external requests or NAS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startStudio } from './server.mjs';

test('managed result paths cannot drift and saving settings retains the company identity', { timeout: 60000 }, async () => {
  const base = resolve(import.meta.dirname, '../../../../.tmp/live-folder-auto-20261106/browser'); await mkdir(base, { recursive: true });
  const scratch = await mkdtemp(join(base, 'settings-'));
  const names = ['DAOCUT_STUDIO_HOME', 'DAOCUT_LIBRARY', 'DAOCUT_TRASH_DIR', 'DAOCUT_SHARED_HOME', 'DAOCUT_NO_UPDATE_CHECK'];
  const old = Object.fromEntries(names.map(n => [n, process.env[n]]));
  for (const n of names.slice(0, 4)) process.env[n] = join(scratch, n); process.env.DAOCUT_NO_UPDATE_CHECK = '1';
  let studio, browser;
  try {
    studio = await startStudio({ port: 0, editorDir: resolve(process.env.DAOCUT_TEST_EDITOR_DIR), openBrowser: () => {}, requireAnalysisPlan: true });
    const request = async (path, method = 'GET', body) => {
      const response = await fetch(`${studio.origin}/api/${path}`, { method, headers: { 'x-studio-key': studio.key, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
    };
    const { project } = await request('projects', 'POST', { path: join(scratch, 'project') }); await mkdir(join(project.path, 'assets'), { recursive: true });
    execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=5:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', join(project.path, 'assets', 'synthetic.mp4')], { windowsHide: true });
    const source = { id: 'source', assetPath: 'assets/synthetic.mp4', durationMs: 2000 };
    await request(`projects/${project.id}/product-analysis`, 'PUT', { analysis: { version: 1, sources: [source], products: [{ id: 'product', name: '合成直播', sourceIds: ['source'] }], intervals: [], candidates: [] } });
    const root = join(scratch, 'media'), resultRoot = join(root, '.daocut-shared'), coordinationId = 'a'.repeat(64);
    await request('prefs', 'PATCH', { sharedMediaLibraries: [{ id: 'managed-library', name: '自动直播', root, managedFolder: true }], sharedAnalysis: { enabled: true, resultRoots: [{ libraryId: 'managed-library', root: resultRoot, coordinationId }] } });
    browser = await chromium.launch({ executablePath: process.env.DAOCUT_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (![studio.origin, studio.filmOrigin].includes(url.origin)) return route.abort();
      if (url.pathname.endsWith('/product-workflow/status')) return route.fulfill({ json: { source, ready: false, phase: 'transcription', transcription: { status: 'idle', segments: [] }, discovery: { sourceId: source.id, status: 'idle', runs: [] } } });
      if (/\/product-workflow\/(execute|publish-shared)$/.test(url.pathname)) return route.abort();
      return route.continue();
    });
    await page.goto(`${studio.origin}/projects/${project.id}?key=${studio.key}`);
    await page.getByRole('button', { name: '商品与结构', exact: true }).click();
    await page.getByLabel('素材与共享设置', { exact: true }).locator('summary').first().click();
    const settings = page.getByLabel('共享分析设置', { exact: true }); await settings.locator('summary').click();
    const input = settings.getByLabel('共享结果目录', { exact: true }); await input.waitFor();
    assert.equal(await input.isDisabled(), true, 'managed folder result root must not be manually changed');
    await settings.getByRole('button', { name: '保存共享设置', exact: true }).click();
    await settings.getByText('共享设置已保存在本机', { exact: true }).waitFor();
    const saved = await request('prefs');
    assert.deepEqual(saved.sharedAnalysis.resultRoots, [{ libraryId: 'managed-library', root: resultRoot, coordinationId }]);
  } finally {
    await browser?.close(); await studio?.close();
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
