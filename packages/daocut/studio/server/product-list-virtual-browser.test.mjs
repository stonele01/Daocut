import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startStudio } from './server.mjs';

test('large product lists keep current-range candidates, bounded rows, and editing state', { timeout: 120000 }, async () => {
  const output = resolve('../../.tmp/long-live-implementation-20261103/lists');
  await mkdir(output, { recursive: true });
  const scratch = await mkdtemp(join(output, 'fixture-'));
  const names = ['DAOCUT_STUDIO_HOME', 'DAOCUT_LIBRARY', 'DAOCUT_TRASH_DIR'];
  const old = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) { process.env[name] = join(scratch, name); await mkdir(process.env[name]); }
  let studio, browser, step = 'setup';
  const posts = [];
  try {
    studio = await startStudio({ port: 0, openBrowser: () => {} });
    const api = async (path, method = 'GET', body) => {
      const response = await fetch(`${studio.origin}${path}`, { method, headers: { 'x-studio-key': studio.key, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data)); return data;
    };
    const { project } = await api('/api/projects', 'POST', { path: join(scratch, 'project') });
    await mkdir(join(project.path, 'assets'));
    const media = join(project.path, 'assets', 'synthetic.mp4');
    execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=32x32:r=1:d=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', media], { windowsHide: true });
    const sourceHash = createHash('sha256').update(await readFile(media)).digest('hex');
    const products = Array.from({ length: 300 }, (_, i) => ({ id: `p${i}`, name: `合成商品 ${String(i).padStart(3, '0')}`, sourceIds: ['s'] }));
    const analysis = { version: 1, sources: [{ id: 's', assetPath: 'assets/synthetic.mp4', durationMs: 30000 }], products,
      intervals: [
        { id: 'first', productId: 'p0', sourceId: 's', startMs: 0, endMs: 10000 },
        { id: 'return', productId: 'p0', sourceId: 's', startMs: 10000, endMs: 20000 },
        { id: 'last', productId: 'p299', sourceId: 's', startMs: 20000, endMs: 30000 },
      ], candidates: [
        ...Array.from({ length: 1000 }, (_, i) => ({ id: `c${i}`, productId: 'p0', intervalId: 'first', sourceId: 's', startMs: i * 9, endMs: i * 9 + 5, text: `合成候选 ${i}${i % 7 === 0 ? '：这里是用于验证长文换行和动态行高的演示话术，缩放列表宽度后内容也不能互相遮挡。' : ''}`, tags: [i % 2 === 0 ? '钩子' : '卖点'], origin: 'demo-data', version: 'synthetic-list-v1' })),
        { id: 'return-candidate', productId: 'p0', intervalId: 'return', sourceId: 's', startMs: 11000, endMs: 12000, text: '合成返场候选', tags: ['痛点'], origin: 'demo-data', version: 'synthetic-list-v1' },
        { id: 'last-candidate', productId: 'p299', intervalId: 'last', sourceId: 's', startMs: 21000, endMs: 22000, text: '末尾商品候选', tags: ['卖点'], origin: 'demo-data', version: 'synthetic-list-v1' },
      ] };
    await api(`/api/projects/${project.id}/product-analysis`, 'PUT', { analysis });
    const filmPath = join(project.path, 'film.html'), analysisPath = join(project.path, '.film/product-analysis.json');
    const beforeFilm = await readFile(filmPath, 'utf8'), beforeAnalysis = await readFile(analysisPath, 'utf8');
    browser = await chromium.launch({ executablePath: process.env.DAOCUT_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
    page.setDefaultTimeout(12000);
    const local = new Set([studio.origin, studio.filmOrigin]);
    await page.route('**/*', route => local.has(new URL(route.request().url()).origin) ? route.continue() : route.abort());
    // This test targets card layout; avoid launching a thumbnail extraction per tiny fixture cue.
    await page.route('**/media?**', async route => {
      const what = new URL(route.request().url()).searchParams.get('what');
      if (what === 'frame') return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') });
      if (what === 'wave') return route.fulfill({ json: { duration: 30, peaks: [0] } });
      return route.continue();
    });
    page.on('request', request => { if (request.method() === 'POST' && /live-analysis|product-preparation|product-discovery/.test(request.url())) posts.push(request.url()); });
    const started = performance.now();
    await page.goto(`${studio.origin}/projects/${project.id}?key=${studio.key}`);
    await page.getByRole('button', { name: '商品与结构', exact: true }).click();
    const cards = page.getByLabel('商品列表', { exact: true });
    const candidates = page.getByLabel('结构候选列表', { exact: true });
    const section = page.getByLabel('候选片段', { exact: true });
    const visibleRange = page.getByLabel('候选显示范围', { exact: true });
    await cards.locator('[data-product-card="p0"]').waitFor();
    await candidates.locator('[data-candidate-card="c0"]').waitFor();
    step = 'current range and mounted row bound';
    assert.equal(await visibleRange.getByRole('button', { name: '当前段', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.ok(await section.getByText('1000 / 1000', { exact: true }).isVisible());
    assert.equal(await section.getByText('合成返场候选', { exact: true }).count(), 0);
    assert.ok(await cards.locator('[data-product-card]').count() < 16, '300 products do not create 300 cards');
    assert.ok(await candidates.locator('article').count() < 20, '1000 candidates do not create 1000 cards');
    const settleBottom = async list => {
      for (let i = 0; i < 6; i++) {
        await list.evaluate(element => { element.scrollTop = element.scrollHeight; });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      }
    };
    step = 'scroll reaches final candidate';
    await settleBottom(candidates);
    await candidates.locator('[data-candidate-card="c999"]').waitFor();
    assert.ok(await candidates.locator('article').count() < 20);
    step = 'all lectures is explicit, then current return range';
    await visibleRange.getByRole('button', { name: '该商品全部讲解', exact: true }).click();
    assert.ok(await section.getByText('1001 / 1001', { exact: true }).isVisible());
    await settleBottom(candidates);
    await candidates.getByText('合成返场候选', { exact: true }).waitFor();
    await visibleRange.getByRole('button', { name: '当前段', exact: true }).click();
    await page.locator('[data-source-product-range="return"]').getByRole('button', { name: /^定位商品讲解/ }).click();
    await candidates.getByText('合成返场候选', { exact: true }).waitFor();
    assert.ok(await section.getByText('1 / 1', { exact: true }).isVisible());
    assert.equal(await candidates.locator('[data-candidate-card="c0"]').count(), 0);
    assert.equal(await readFile(filmPath, 'utf8'), beforeFilm);
    assert.equal(await readFile(analysisPath, 'utf8'), beforeAnalysis);
    step = 'last product is reachable and editing survives scrolling';
    await settleBottom(cards);
    await cards.locator('[data-product-card="p299"]').getByRole('button', { name: /^合成商品 299/ }).click();
    const lastCard = cards.locator('[data-product-card="p299"]');
    await lastCard.getByRole('button', { name: '编辑商品名称：合成商品 299', exact: true }).click();
    const input = cards.getByRole('textbox', { name: '商品名称', exact: true });
    await input.fill('合成末尾商品已改名');
    await cards.evaluate(element => { element.scrollTop = 0; });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    assert.equal(await input.inputValue(), '合成末尾商品已改名', 'editing card stays mounted outside the viewport');
    assert.ok(await cards.locator('[data-product-card]').count() < 16);
    await lastCard.getByRole('button', { name: '保存', exact: true }).click();
    await cards.getByRole('button', { name: /^合成末尾商品已改名/ }).waitFor();
    await page.reload();
    await page.getByRole('button', { name: '商品与结构', exact: true }).click();
    await cards.locator('[data-product-card]').first().waitFor();
    await settleBottom(cards);
    await cards.getByRole('button', { name: /^合成末尾商品已改名/ }).waitFor();
    const saved = JSON.parse(await readFile(analysisPath, 'utf8'));
    assert.equal(saved.products.find(product => product.id === 'p299').name, '合成末尾商品已改名');
    assert.deepEqual(saved.intervals, analysis.intervals, 'list navigation and renaming do not change lecture ranges');
    assert.deepEqual(saved.candidates, analysis.candidates);
    assert.equal(await readFile(filmPath, 'utf8'), beforeFilm);
    assert.equal(createHash('sha256').update(await readFile(media)).digest('hex'), sourceHash);
    assert.equal(posts.length, 0, 'filtering, scrolling, selecting and renaming do not start models');
    await page.screenshot({ path: join(output, 'product-list-ready.png') });
    await writeFile(join(output, 'metrics.json'), JSON.stringify({ synthetic: true, products: 300, candidates: 1002, mountedProductCards: await cards.locator('[data-product-card]').count(), modelPosts: posts.length, elapsedMs: Math.round(performance.now() - started) }, null, 2));
  } catch (error) { throw new Error(`Product list test failed at ${step}: ${error.message}`, { cause: error }); }
  finally {
    await browser?.close(); await studio?.close();
    for (const [name, value] of Object.entries(old)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
