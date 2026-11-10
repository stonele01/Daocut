// Isolated synthetic source media, local Studio and no external model requests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { filmHtml } from '../../src/film-doc.mjs';
import { startStudio } from './server.mjs';

test('dragging product boundaries saves lecture ranges without changing private takes, film or source', { timeout: 120000 }, async () => {
  const base = resolve(import.meta.dirname, '../../../../.tmp/product-boundary-20261103');
  await mkdir(base, { recursive: true });
  const scratch = await mkdtemp(join(base, 'browser-'));
  const names = ['DAOCUT_STUDIO_HOME', 'DAOCUT_LIBRARY', 'DAOCUT_TRASH_DIR', 'DAOCUT_NO_UPDATE_CHECK'];
  const old = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names.slice(0, 3)) process.env[name] = join(scratch, name);
  process.env.DAOCUT_NO_UPDATE_CHECK = '1';
  await mkdir(process.env.DAOCUT_TRASH_DIR);
  let studio, browser, step = 'setup';
  try {
    studio = await startStudio({ port: 0, openBrowser: () => {} });
    const api = async (path, method = 'GET', body) => {
      const response = await fetch(`${studio.origin}${path}`, { method, headers: { 'x-studio-key': studio.key, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      return result;
    };
    const { project } = await api('/api/projects', 'POST', { path: join(scratch, 'project') });
    await mkdir(join(project.path, 'assets'), { recursive: true });
    const assetPath = 'assets/synthetic.mp4', mediaPath = join(project.path, assetPath);
    execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=10:d=12', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', mediaPath], { windowsHide: true });
    const initial = {
      version: 1,
      sources: [{ id: 's', assetPath, durationMs: 12000 }],
      products: [{ id: 'a', name: '合成商品甲', sourceIds: ['s'] }, { id: 'b', name: '合成商品乙', sourceIds: ['s'] }],
      intervals: [{ id: 'a-range', productId: 'a', sourceId: 's', startMs: 2000, endMs: 5000 }, { id: 'b-range', productId: 'b', sourceId: 's', startMs: 8000, endMs: 10000 }],
      candidates: [],
    };
    await api(`/api/projects/${project.id}/product-analysis`, 'PUT', { analysis: initial });
    const analysisPath = join(project.path, '.film', 'product-analysis.json');
    const filmPath = join(project.path, 'film.html');
    await writeFile(filmPath, filmHtml({ stage: { w: 64, h: 64 }, tracks: [{ clips: [{ id: 'existing-film', src: assetPath, at: 0, time: [0, 1] }] }] }));
    const originalAIPath = join(project.path, '.film', 'product-discovery', 'original-ai-test-fixture.json');
    await mkdir(join(project.path, '.film', 'product-discovery'), { recursive: true });
    await writeFile(originalAIPath, JSON.stringify({ fixture: 'synthetic-original-ai', intervals: initial.intervals }));
    const protectedFiles = await Promise.all([mediaPath, filmPath, originalAIPath].map(async path => [path, await readFile(path)]));
    const privateKey = `daocut:source-film:${project.id}:s`;
    const privateValue = JSON.stringify({ signature: JSON.stringify([assetPath, 12000, []]), film: { tracks: [{ clips: [
      { id: 'private-left', src: assetPath, at: 0, time: [0, 6], attrs: { 'data-source-kind': 'context', 'data-source-range': '' } },
      { id: 'private-right', src: assetPath, at: 6, time: [6, 12], attrs: { 'data-source-kind': 'context', 'data-source-range': '' } },
    ] }] } });
    browser = await chromium.launch({ executablePath: process.env.DAOCUT_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
    page.setDefaultTimeout(15000);
    const localOrigins = new Set([studio.origin, studio.filmOrigin]);
    await page.route('**/*', route => localOrigins.has(new URL(route.request().url()).origin) ? route.continue() : route.abort());
    await page.addInitScript(({ key, value }) => {
      window.daocutHost = { onSelection: selection => { window.__chatSelection = selection; } };
      if (!localStorage.getItem(key)) localStorage.setItem(key, value);
      window.addEventListener('pointerdown', event => { window.__productDragPointerId = event.pointerId; }, true);
    }, { key: privateKey, value: privateValue });
    const writes = [], modelPosts = [];
    page.on('request', request => {
      if (request.method() === 'PUT' && request.url().endsWith('/product-analysis')) writes.push(request.postDataJSON());
      if (request.method() === 'POST' && /\/(?:live-analysis\/(?:analyze|transcribe)|product-discovery\/discover|product-preparation(?:\/start)?)$/.test(new URL(request.url()).pathname)) modelPosts.push(request.url());
    });
    const open = async () => {
      step = 'open project';
      await page.goto(`${studio.origin}/projects/${project.id}?key=${studio.key}`);
      step = 'open product panel';
      await page.getByRole('button', { name: '商品与结构', exact: true }).click();
      step = 'select product';
      await page.getByLabel('商品列表', { exact: true }).getByRole('button', { name: /^合成商品甲/ }).click();
      assert.equal(await page.getByRole('region', { name: '商品讲解范围', exact: true }).count(), 0, 'lecture boundaries are edited on the timeline without a duplicate left-side list');
      step = 'load source video';
      await page.waitForFunction(() => [...document.querySelectorAll('video')].some(video => video.currentSrc.includes('synthetic.mp4') && video.duration === 12));
      step = 'fit source timeline';
      const fit = page.locator('[data-source-axis]').getByRole('button', { name: '适应宽度', exact: true });
      await fit.waitFor();
      if (await fit.isEnabled()) await fit.click();
    };
    const axis = page.locator('[data-source-axis]');
    const marker = id => axis.locator(`[data-source-product-range="${id}"]`);
    const bounds = async id => {
      const analysis = (await api(`/api/projects/${project.id}/product-analysis`)).analysis;
      const range = analysis.intervals.find(range => range.id === id);
      return { startMs: range.startMs, endMs: range.endMs };
    };
    const readAnalysis = async () => JSON.parse(await readFile(analysisPath, 'utf8'));
    const privateUnchanged = async () => assert.equal(await page.evaluate(key => localStorage.getItem(key), privateKey), privateValue, 'lecture boundary edits must not change private source takes');
    const assertProtected = async () => {
      for (const [path, before] of protectedFiles) assert.deepEqual(await readFile(path), before, path);
      assert.deepEqual(await bounds('b-range'), { startMs: 8000, endMs: 10000 });
      await privateUnchanged();
      assert.deepEqual(modelPosts, []);
    };
    const drag = async (edge, targetMs, { cancel, fail = false } = {}) => {
      const handle = marker('a-range').locator(`[data-product-trim="${edge}"]`);
      await handle.scrollIntoViewIfNeeded();
      const box = await handle.boundingBox(), scaleBox = await marker('b-range').boundingBox();
      assert.ok(box && scaleBox, `missing ${edge} boundary handle`);
      const before = await bounds('a-range'), snapshot = await readFile(analysisPath), count = writes.length;
      const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      const dx = (targetMs - before[`${edge}Ms`]) * scaleBox.width / 2000;
      await page.mouse.move(start.x, start.y); await page.mouse.down();
      await page.mouse.move(start.x + dx, start.y, { steps: 12 });
      assert.equal(writes.length, count, 'pointer moves only preview; save happens on release');
      assert.deepEqual(await readFile(analysisPath), snapshot);
      if (cancel === 'escape') await page.keyboard.press('Escape');
      if (cancel === 'pointercancel') await handle.evaluate(element => element.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: window.__productDragPointerId, pointerType: 'mouse', isPrimary: true })));
      if (cancel) {
        await page.mouse.up();
        assert.equal(writes.length, count);
        assert.deepEqual(await bounds('a-range'), before);
        assert.equal(Number(await marker('a-range').getAttribute('data-product-start-ms')), before.startMs);
        assert.equal(Number(await marker('a-range').getAttribute('data-product-end-ms')), before.endMs);
        return before;
      }
      const response = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().endsWith('/product-analysis'));
      await page.mouse.up();
      assert.equal((await response).status(), fail ? 500 : 200);
      assert.equal(writes.length, count + 1, 'one release writes exactly once');
      const after = await bounds('a-range');
      await page.waitForFunction(bounds => {
        const selected = window.__chatSelection?.productRange;
        return selected?.intervalId === 'a-range' && selected.startMs === bounds.startMs && selected.endMs === bounds.endMs;
      }, after);
      if (fail) {
        assert.deepEqual(after, before);
        await page.waitForFunction(before => {
          const item = document.querySelector('[data-source-product-range="a-range"]');
          return Number(item?.getAttribute('data-product-start-ms')) === before.startMs && Number(item?.getAttribute('data-product-end-ms')) === before.endMs;
        }, before);
      }
      return after;
    };
    const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) <= 25, `expected ${expected} ms, got ${actual} ms`);
    await open();
    await marker('a-range').waitFor();
    await privateUnchanged();
    step = 'both boundaries extend and shrink';
    let changed = await drag('start', 1000); closeTo(changed.startMs, 1000); assert.equal(changed.endMs, 5000);
    changed = await drag('start', 2000); closeTo(changed.startMs, 2000);
    changed = await drag('end', 6000); closeTo(changed.endMs, 6000);
    changed = await drag('end', 5000); closeTo(changed.endMs, 5000);
    step = 'cancel gestures do not save';
    await drag('start', 1000, { cancel: 'escape' });
    await drag('end', 6000, { cancel: 'pointercancel' });
    step = 'failed save returns to stored boundary';
    const stored = await bounds('a-range');
    await page.route('**/product-analysis', async route => {
      if (route.request().method() !== 'PUT') return route.continue();
      await route.fulfill({ status: 500, json: { error: 'synthetic rejected boundary save' } });
    });
    await drag('end', 6000, { fail: true });
    await page.unroute('**/product-analysis');
    await axis.getByRole('alert').filter({ hasText: '商品讲解范围未保存' }).waitFor();
    assert.deepEqual(await bounds('a-range'), stored);
    step = 'source limits and positive minimum duration';
    changed = await drag('start', -500); assert.equal(changed.startMs, 0);
    changed = await drag('end', 12500); assert.equal(changed.endMs, 12000);
    changed = await drag('end', -500); assert.ok(changed.endMs > 0 && changed.endMs <= 100, `positive minimum: ${changed.endMs}`);
    assert.equal(changed.startMs, 0);
    step = 'timeline and reopening retain saved boundaries';
    const saved = await readAnalysis();
    const markerTime = await marker('a-range').getByRole('button', { name: /^定位商品讲解/ }).getAttribute('aria-label');
    assert.match(markerTime, /^定位商品讲解 合成商品甲 00:00 – 00:00\./);
    assert.equal(Number(await marker('a-range').getAttribute('data-product-start-ms')), changed.startMs);
    assert.equal(Number(await marker('a-range').getAttribute('data-product-end-ms')), changed.endMs);
    const cardTime = await page.locator('[data-product-card="a"]').getByRole('button', { name: /^分析 / }).getAttribute('aria-label');
    assert.match(cardTime, /^分析 00:00 – 00:00\./);
    await assertProtected();
    const count = writes.length;
    await open();
    await marker('a-range').waitFor();
    assert.deepEqual(await readAnalysis(), saved);
    assert.equal(await marker('a-range').getByRole('button', { name: /^定位商品讲解/ }).getAttribute('aria-label'), markerTime);
    assert.equal(Number(await marker('a-range').getAttribute('data-product-start-ms')), changed.startMs);
    assert.equal(Number(await marker('a-range').getAttribute('data-product-end-ms')), changed.endMs);
    assert.equal(await page.locator('[data-product-card="a"]').getByRole('button', { name: /^分析 / }).getAttribute('aria-label'), cardTime);
    assert.equal(writes.length, count, 'reopening must not save the same boundary again');
    await assertProtected();
  } catch (error) { throw new Error(`Product boundary test failed at ${step}: ${error.message}`, { cause: error }); }
  finally {
    await browser?.close(); await studio?.close();
    for (const name of names) { if (old[name] === undefined) delete process.env[name]; else process.env[name] = old[name]; }
    const child = relative(base, scratch);
    assert.ok(child && !child.startsWith('..') && !isAbsolute(child));
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
