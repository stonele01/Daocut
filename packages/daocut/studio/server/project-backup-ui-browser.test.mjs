import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startStudio } from './server.mjs';
import { createProjectBackup } from './project-backup.mjs';

test('ordinary Projects UI inspects and explicitly restores a complete personal backup', { timeout: 60000 }, async () => {
  const base = resolve(import.meta.dirname, '../../../../.tmp/shared-v2-20261105/backup/ui');
  await mkdir(base, { recursive: true }); const scratch = await mkdtemp(join(base, 'case-'));
  const names = ['DAOCUT_STUDIO_HOME', 'DAOCUT_LIBRARY', 'DAOCUT_TRASH_DIR', 'DAOCUT_NO_UPDATE_CHECK'];
  const old = Object.fromEntries(names.map(key => [key, process.env[key]]));
  for (const key of names.slice(0, 3)) process.env[key] = join(scratch, key);
  process.env.DAOCUT_NO_UPDATE_CHECK = '1';
  const original = join(scratch, 'original'), backup = join(scratch, 'backup'), target = join(scratch, 'restored');
  await mkdir(join(original, '.film'), { recursive: true });
  await writeFile(join(original, 'film.html'), '<!DOCTYPE html><html><body><main data-film data-width="1280" data-height="720"></main></body></html>');
  await writeFile(join(original, '.film/product-analysis.json'), JSON.stringify({ version: 1, sources: [], products: [], intervals: [], candidates: [], privateNote: 'isolated-personal-note' }));
  await createProjectBackup(original, backup);
  let studio, browser, requests = 0, models = 0;
  try {
    studio = await startStudio({ port: 0, openBrowser() {}, authorizeTask: async () => { models++; throw Error('models forbidden'); } });
    browser = await chromium.launch({ executablePath: process.env.DAOCUT_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } }); page.setDefaultTimeout(8000);
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (![studio.origin, studio.filmOrigin].includes(url.origin)) return route.abort();
      if (url.pathname === '/api/project-backups/restore') requests++;
      return route.continue();
    });
    await page.goto(`${studio.origin}/?key=${studio.key}`);
    await page.getByRole('button', { name: '导入自', exact: true }).click();
    await page.getByText('恢复工程备份', { exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '恢复个人工程备份' });
    await dialog.getByLabel('完整备份文件夹').fill(backup);
    await dialog.getByRole('button', { name: '检查备份', exact: true }).click();
    await dialog.getByText(/校验通过/).waitFor(); assert.equal(requests, 0);
    await dialog.getByLabel('新个人工程目录（必须尚不存在）').fill(target);
    await dialog.getByRole('button', { name: '确认恢复到新工程', exact: true }).click();
    await dialog.getByText('个人工程已恢复。', { exact: true }).waitFor(); assert.equal(requests, 1);
    await dialog.getByRole('button', { name: '打开恢复的工程', exact: true }).click();
    await page.waitForURL(/\/projects\/[\w-]+/);
    assert.match(await readFile(join(target, '.film/product-analysis.json'), 'utf8'), /isolated-personal-note/);
    assert.deepEqual(await readFile(join(original, 'film.html')), await readFile(join(target, 'film.html')));
    assert.equal(models, 0);
  } finally {
    await browser?.close(); await studio?.close();
    for (const name of names) old[name] === undefined ? delete process.env[name] : process.env[name] = old[name];
  }
});
