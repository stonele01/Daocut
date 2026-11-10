// Four-hour generated video/audio. This fixture never touches a real project or provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startStudio } from './server.mjs';

test('four-hour source focuses lectures in absolute time with bounded visible work', { timeout: 240000 }, async () => {
  const output = resolve('../../.tmp/long-live-implementation-20261103/root');
  await mkdir(output, { recursive: true });
  const scratch = await mkdtemp(join(output, 'four-hour-ui-'));
  const names = ['DAOCUT_STUDIO_HOME', 'DAOCUT_LIBRARY', 'DAOCUT_TRASH_DIR', 'DAOCUT_NO_UPDATE_CHECK'];
  const old = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names.slice(0, 3)) { process.env[name] = join(scratch, name); await mkdir(process.env[name]); }
  process.env.DAOCUT_NO_UPDATE_CHECK = '1';
  let studio, browser, step = 'setup';
  const posts = [], frames = new Set(), errors = [];
  const report = { synthetic: true, durationSeconds: 14400, lectureCount: 48, productCount: 24, candidateCount: 1440, realModelRequests: 0 };
  try {
    studio = await startStudio({ port: 0, openBrowser: () => {} });
    const api = async (path, method = 'GET', body) => {
      const response = await fetch(`${studio.origin}${path}`, { method, headers: { 'x-studio-key': studio.key, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data)); return data;
    };
    const { project } = await api('/api/projects', 'POST', { path: join(scratch, 'project') });
    await mkdir(join(project.path, 'assets'));
    const assetPath = 'assets/four-hours.mp4', media = join(project.path, assetPath);
    execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=96x64:r=1:d=14400', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=8000:duration=14400', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '10', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '8k', '-shortest', '-y', media], { windowsHide: true, timeout: 90000 });
    const sourceHash = createHash('sha256').update(await readFile(media)).digest('hex');
    const intervals = Array.from({ length: 48 }, (_, i) => ({ id: `r${i}`, productId: `p${i % 24}`, sourceId: 's', startMs: i * 300000, endMs: (i + 1) * 300000 }));
    const initial = { version: 1, sources: [{ id: 's', assetPath, durationMs: 14400000 }],
      products: Array.from({ length: 24 }, (_, i) => ({ id: `p${i}`, name: `四小时合成商品 ${i}`, sourceIds: ['s'] })), intervals,
      candidates: intervals.flatMap(range => Array.from({ length: 30 }, (_, i) => ({ ...range, id: `${range.id}-c${i}`, intervalId: range.id, startMs: range.startMs + i * 10000, endMs: range.startMs + i * 10000 + 5000, text: `${range.id} 合成结构 ${i}`, tags: [i % 2 ? '卖点' : '钩子'], origin: 'demo-data', version: 'synthetic-four-hours-v1' }))) };
    await api(`/api/projects/${project.id}/product-analysis`, 'PUT', { analysis: initial });
    const filmPath = join(project.path, 'film.html'), analysisPath = join(project.path, '.film/product-analysis.json');
    const beforeFilm = await readFile(filmPath), beforeAnalysis = await readFile(analysisPath);
    browser = await chromium.launch({ executablePath: process.env.DAOCUT_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
    page.setDefaultTimeout(20000);
    const local = new Set([studio.origin, studio.filmOrigin]);
    await page.route('**/*', route => local.has(new URL(route.request().url()).origin) ? route.continue() : route.abort());
    await page.addInitScript(() => { window.daocutHost = { onCommand: handler => { window.__studioCommand = handler; }, onSelection: selection => { window.__chatSelection = selection; } }; });
    page.on('pageerror', error => errors.push(String(error)));
    page.on('request', request => {
      const url = new URL(request.url());
      if (request.method() === 'POST' && /live-analysis|product-preparation|product-discovery/.test(url.pathname)) posts.push(url.pathname);
      if (url.searchParams.get('what') === 'frame') frames.add(url.href);
    });
    const axis = page.locator('[data-source-axis]');
    const cards = page.getByLabel('商品列表', { exact: true });
    const waitFocus = async (start, end) => {
      await page.waitForFunction(({ start, end }) => {
        const axis = document.querySelector('[data-source-axis]');
        const from = Number(axis?.getAttribute('data-source-view-start')), to = Number(axis?.getAttribute('data-source-view-end'));
        return from <= start + 1000 && from > start - 60000 && to >= end - 1000 && to < end + 60000;
      }, { start, end });
    };
    step = 'cold open and first lecture focus';
    const cold = performance.now();
    await page.goto(`${studio.origin}/projects/${project.id}?key=${studio.key}`);
    await page.getByRole('button', { name: '商品与结构', exact: true }).click();
    await cards.locator('[data-product-card="p0"]').getByRole('button', { name: /^四小时合成商品 0/ }).click();
    await waitFocus(0, 300000);
    await page.waitForFunction(() => [...document.querySelectorAll('video')].some(video => video.currentSrc.includes('four-hours.mp4') && Math.abs(video.duration - 14400) < 1));
    report.coldOpenMs = Math.round(performance.now() - cold);
    report.focusedMarkerCount = await axis.locator('[data-source-product-range]').count();
    assert.ok(report.focusedMarkerCount < 6);
    assert.ok(await page.getByLabel('候选片段', { exact: true }).getByText('30 / 30', { exact: true }).isVisible());
    step = 'full source overview and far-end return';
    await axis.getByRole('button', { name: '查看全场原片' }).click();
    await page.waitForFunction(() => Number(document.querySelector('[data-source-axis]')?.getAttribute('data-source-view-end')) >= 14400000);
    assert.equal(await axis.locator('[data-source-product-range]').count(), 48);
    const jump = performance.now();
    await axis.locator('[data-source-product-range="r47"]').getByRole('button', { name: /^定位商品讲解/ }).click();
    await waitFocus(14100000, 14400000);
    await page.waitForFunction(() => window.__chatSelection?.productRange?.intervalId === 'r47' && window.__chatSelection.productRange.startMs === 14100000);
    await page.waitForFunction(() => [...document.querySelectorAll('video')].some(video => video.currentSrc.includes('four-hours.mp4') && Math.abs(video.currentTime - 14100) < 2));
    report.farEndFocusMs = Math.round(performance.now() - jump);
    assert.ok(await axis.locator('[data-source-product-range]').count() < 6);
    assert.ok(await page.getByLabel('结构候选列表', { exact: true }).getByText('r47 合成结构 0', { exact: true }).isVisible());
    step = 'full source and current lecture controls preserve absolute time';
    await axis.getByRole('button', { name: '查看全场原片' }).click();
    await axis.getByRole('button', { name: '聚焦当前商品段' }).click();
    await waitFocus(14100000, 14400000);
    assert.equal((await api(`/api/projects/${project.id}/product-analysis`)).analysis.intervals.length, 48);
    step = 'same card refocus';
    await cards.locator('[data-product-card="p23"]').getByRole('button', { name: /^四小时合成商品 23/ }).click();
    await waitFocus(6900000, 7200000);
    await axis.getByRole('button', { name: '查看全场原片' }).click();
    await cards.locator('[data-product-card="p23"]').getByRole('button', { name: /^四小时合成商品 23/ }).click();
    await waitFocus(6900000, 7200000);
    assert.deepEqual(await readFile(filmPath), beforeFilm);
    assert.deepEqual(await readFile(analysisPath), beforeAnalysis);
    step = 'drag outside focused view stays fixed and cancel preserves data';
    for (const edge of ['start', 'end']) {
      const before = await axis.getAttribute('data-source-view-start');
      const box = await axis.locator(`[data-source-product-range="r23"] [data-product-trim="${edge}"]`).boundingBox();
      assert.ok(box);
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      await page.mouse.move(x, y); await page.mouse.down();
      await page.mouse.move(x + (edge === 'start' ? -110 : 110), y, { steps: 10 });
      await page.waitForTimeout(220); // onViewChange is throttled by 150 ms.
      assert.equal(await axis.getAttribute('data-source-view-start'), before, 'preview seek must not page the timeline during a boundary drag');
      await page.keyboard.press('Escape'); await page.mouse.up();
      assert.deepEqual(await readFile(analysisPath), beforeAnalysis);
    }
    step = 'chat completion refresh keeps current selection';
    const changed = structuredClone(initial); changed.candidates[0].text = '模拟对话完成后更新';
    await api(`/api/projects/${project.id}/product-analysis`, 'PUT', { analysis: changed, expected: initial });
    await page.evaluate(projectId => window.__studioCommand({ type: 'refresh-product-analysis', projectId }), project.id);
    await page.waitForFunction(() => window.__chatSelection?.productRange?.intervalId === 'r23');
    await cards.evaluate(element => { element.scrollTop = 0; });
    await cards.locator('[data-product-card="p0"]').getByRole('button', { name: /^四小时合成商品 0/ }).click();
    await page.getByLabel('结构候选列表', { exact: true }).getByText('模拟对话完成后更新', { exact: true }).waitFor();
    step = 'reopen without paid work';
    const reopen = performance.now();
    await page.reload();
    await page.getByRole('button', { name: '商品与结构', exact: true }).click();
    await cards.locator('[data-product-card="p0"]').getByRole('button', { name: /^四小时合成商品 0/ }).click();
    await waitFocus(0, 300000);
    report.reopenMs = Math.round(performance.now() - reopen);
    const cdp = await page.context().newCDPSession(page); await cdp.send('Performance.enable');
    const metrics = await cdp.send('Performance.getMetrics');
    report.browserJsHeapBytes = metrics.metrics.find(item => item.name === 'JSHeapUsedSize')?.value;
    report.domElements = await page.locator('*').count();
    report.uniqueFrameRequests = frames.size;
    assert.ok(frames.size < 180, `visible-window requests, not 1440 cue thumbnails: ${frames.size}`);
    assert.deepEqual(posts, []); assert.deepEqual(errors, []);
    assert.deepEqual(await readFile(filmPath), beforeFilm);
    assert.equal(createHash('sha256').update(await readFile(media)).digest('hex'), sourceHash);
    await page.screenshot({ path: join(output, 'four-hour-ui.png'), fullPage: true });
    Object.assign(report, { passed: true, sourceBytes: (await readFile(media)).length, projectRoot: project.path });
  } catch (error) { Object.assign(report, { passed: false, failedStep: step, error: String(error) }); throw error; }
  finally {
    await writeFile(join(output, 'four-hour-ui-result.json'), JSON.stringify(report, null, 2));
    await browser?.close(); await studio?.close();
    for (const name of names) { if (old[name] === undefined) delete process.env[name]; else process.env[name] = old[name]; }
  }
});
