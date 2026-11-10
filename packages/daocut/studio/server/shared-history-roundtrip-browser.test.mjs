import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, copyFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startStudio } from './server.mjs';
import { filmHtml, readFilmFile } from '../../src/film-doc.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');

test('embedded Studio shows all 40 historical candidates on the left after import and reopen; preview, add and drag keep lecture boundaries', { timeout: 180000 }, async () => {
  const base = resolve(import.meta.dirname, '../../../../.tmp/shared-existing-20261105/ui');
  await mkdir(base, { recursive: true }); const scratch = await mkdtemp(join(base, 'roundtrip-'));
  const keys = ['DAOCUT_STUDIO_HOME', 'DAOCUT_LIBRARY', 'DAOCUT_TRASH_DIR', 'DAOCUT_NO_UPDATE_CHECK', 'TEMP', 'TMP'];
  const old = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  for (const key of keys) { process.env[key] = key === 'DAOCUT_NO_UPDATE_CHECK' ? '1' : join(scratch, key); if (key !== 'DAOCUT_NO_UPDATE_CHECK') await mkdir(process.env[key], { recursive: true }); }
  let studio, browser, context, page, requests = 0, forbiddenPosts = 0, step = 'fixture';
  const pageErrors = [];
  const tasks = new Map(); let serial = 0;
  const coordinate = async (op, body) => {
    const task = tasks.get(body.taskKey);
    if (op === 'catalog') return { results: [...tasks.values()].filter(t => t.status === 'complete' && t.catalog?.sourceIdentity === body.sourceIdentity), coordinationId: 'isolated-company' };
    if (op === 'status') return { task: task ?? null, coordinationId: 'isolated-company' };
    if (op === 'claim') { if (task) return { acquired: false, task }; const value = { taskKey: body.taskKey, inputHash: body.inputHash, catalog: body.catalog, attemptId: `attempt-${++serial}`, status: 'claimed' }; tasks.set(body.taskKey, value); return { acquired: true, task: value, coordinationId: 'isolated-company' }; }
    if (op === 'versions') return { versions: task ? [task] : [], coordinationId: 'isolated-company' };
    assert.equal(task.attemptId, body.attemptId);
    if (op === 'submitted') { task.status = 'submitted'; return { task, sendAllowed: true }; }
    if (op === 'complete') { task.status = 'complete'; task.result = body.result; return { task }; }
    throw Error(`unexpected coordinator operation ${op}`);
  };
  const assetPath = 'assets/synthetic.mp4';
  const rejectProvider = async () => { requests++; throw Error('No real model or ASR permitted'); };
  try {
    studio = await startStudio({ port: 0, openBrowser() {}, requireAnalysisPlan: true,
      editorDir: process.env.DAOCUT_TEST_EDITOR_DIR || join(base, 'studio-dist'),
      liveAnalysis: { modelClient: rejectProvider, transcriber: rejectProvider }, productDiscovery: { modelClient: rejectProvider },
      sharedAnalysis: { coordinate, settings: () => ({ enabled: true, resultRoots: [{ libraryId: 'isolated', root: join(scratch, 'shared-results') }] }),
        readManifest: async () => ({ items: { [assetPath]: { libraryId: 'isolated', relativePath: 'same-live.mp4' } } }) } });
    const api = async (path, method = 'GET', body) => {
      const response = await fetch(`${studio.origin}/api/${path}`, { method, headers: { 'x-studio-key': studio.key, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const result = await response.json(); assert.equal(response.status, 200, `${path}: ${JSON.stringify(result)}`); return result;
    };
    const a = (await api('projects', 'POST', { path: join(scratch, 'A') })).project;
    const b = (await api('projects', 'POST', { path: join(scratch, 'B') })).project;
    for (const project of [a, b]) await mkdir(join(project.path, 'assets'), { recursive: true });
    execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=10:d=20', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(a.path, assetPath)], { windowsHide: true });
    await copyFile(join(a.path, assetPath), join(b.path, assetPath));
    for (const [project, sid, pid] of [[a, 'a-source', 'a-product'], [b, 'b-source', 'b-product']]) await api(`projects/${project.id}/product-analysis`, 'PUT', { analysis: { version: 1, sources: [{ id: sid, assetPath, durationMs: 20000 }], products: [{ id: pid, name: pid === 'b-product' ? 'B个人商品' : 'A个人商品', sourceIds: [sid] }], intervals: [{ id: `${sid}-lecture`, sourceId: sid, productId: pid, startMs: 3200, endMs: 20000 }], candidates: [] } });
    const candidates = Array.from({ length: 40 }, (_, i) => ({ startMs: i * 400, endMs: i * 400 + 350, text: `隔离历史原话 ${i + 1}`, tags: ['卖点'], cueRange: [i, i] }));
    const info = await stat(join(a.path, assetPath));
    const saved = { status: 'complete', currentRunId: 'saved-run', attemptId: 'saved-run', intervalId: 'a-source-lecture', productId: 'a-product', rangeStartMs: 0, rangeEndMs: 20000, sourceFingerprint: `${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}`, candidateCount: 40, cacheIdentity: 'historical-input' };
    await mkdir(join(a.path, '.film/live-analysis'), { recursive: true });
    await writeFile(join(a.path, '.film/live-analysis', `${hash('a-source')}.json`), JSON.stringify({ version: 2, sourceId: 'a-source', transcription: { status: 'idle' }, analysis: saved, analyses: { 'a-source-lecture': saved }, results: { 'historical-input': saved }, attempts: { 'saved-run': { id: 'saved-run', status: 'complete', windows: [{ status: 'complete', output: { candidates }, receipt: { model: 'mock-past-model' } }] } } }));
    const bFilm = join(b.path, 'film.html'); await writeFile(bFilm, filmHtml({ stage: { w: 320, h: 180 }, tracks: [{ clips: [{ id: 'seed', src: assetPath, time: [0, 1] }] }] }));
    const bInitial = (await api(`projects/${b.id}/product-analysis`)).analysis;
    const originalFilm = await readFile(bFilm), aFilm = await readFile(join(a.path, 'film.html'));
    const plan = await api(`projects/${a.id}/product-workflow/existing-publication-plan`, 'POST', { sourceId: 'a-source', action: 'analysis', runId: 'saved-run', intervalId: 'a-source-lecture' });
    await api(`projects/${a.id}/product-workflow/publish-existing`, 'POST', { plan, confirmed: true });
    assert.equal(tasks.size, 1);
    browser = await chromium.launch({ executablePath: process.env.DAOCUT_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const open = async () => {
      context = await browser.newContext({ viewport: { width: 1700, height: 1200 } });
      await context.addInitScript(() => {
        let changed;
        const panel = { label: 'AI 对话', open: true, width: 300,
          setOpen(open) { panel.open = open; changed?.({ open, width: panel.width }); },
          setWidth(width) { panel.width = width; changed?.({ open: panel.open, width }); },
          onChange(listener) { changed = listener; },
        };
        window.daocutHost = { version: 1, name: '隔离桌面宿主', panel };
        document.addEventListener('DOMContentLoaded', () => {
          const chat = document.createElement('aside');
          chat.setAttribute('data-studio-host-panel', ''); chat.setAttribute('aria-label', '隔离 AI 对话');
          chat.textContent = '隔离 AI 对话';
          Object.assign(chat.style, { position: 'fixed', right: '0', top: '32px', bottom: '0', width: '300px', background: '#151515', color: '#eee' });
          document.body.append(chat);
        });
      });
      await context.route('**/*', route => {
        const req = route.request(), url = new URL(req.url());
        if (![studio.origin, studio.filmOrigin].includes(url.origin)) return route.abort();
        if (req.method() === 'POST' && (/\/product-workflow\/execute$/.test(url.pathname) || /\/(transcribe|analyze|discover)$/.test(url.pathname))) { forbiddenPosts++; return route.abort(); }
        return route.continue();
      });
      page = await context.newPage(); page.setDefaultTimeout(10000);
      page.on('pageerror', error => pageErrors.push(error.message));
      await page.goto(`${studio.origin}/projects/${b.id}?key=${studio.key}`);
      await page.locator('[data-product-card="b-product"]').waitFor();
      const products = await page.locator('[data-product-card="b-product"]').boundingBox();
      const viewer = await page.locator('[data-viewer-pane]').boundingBox();
      const chat = await page.getByLabel('隔离 AI 对话', { exact: true }).boundingBox();
      assert.ok(products && viewer && chat);
      assert.ok(products.x + products.width <= viewer.x, 'product cards stay in the left column');
      assert.ok(viewer.x + viewer.width <= chat.x, 'viewer leaves the right column for AI chat');
      assert.equal(await page.evaluate(() => 'setAssetsOpen' in window.daocutHost.panel || 'assets' in window.daocutHost.panel), false);
    };
    await open(); step = 'real history import';
    await page.locator('summary').filter({ hasText: '素材与拆品记录' }).click();
    await page.getByRole('button', { name: '发布已有分析结果', exact: true }).click();
    const sharing = page.getByLabel('已有分析结果共享', { exact: true });
    await sharing.getByRole('button', { name: '查看同事已有结果', exact: true }).click();
    await sharing.getByRole('button', { name: '查看历史结果', exact: true }).click();
    await sharing.getByText('隔离历史原话 40', { exact: true }).waitFor();
    assert.deepEqual(await readFile(bFilm), originalFilm);
    await sharing.getByLabel('关联本机商品').selectOption('b-product');
    await sharing.getByRole('button', { name: '导入为历史分析范围', exact: true }).click();
    await sharing.getByText('历史结果已导入，商品讲解边界和成片未改变', { exact: true }).waitFor();
    const imported = (await api(`projects/${b.id}/product-analysis`)).analysis;
    assert.equal(imported.candidates.length, 40); assert.equal(imported.candidates.filter(c => c.startMs < 3200).length, 8);
    assert.deepEqual(imported.intervals, bInitial.intervals); assert.deepEqual(imported.products, bInitial.products); assert.deepEqual(await readFile(bFilm), originalFilm);
    await page.locator('summary').filter({ hasText: '素材与拆品记录' }).click();
    const scope = imported.scopes[0], candidate = imported.candidates[0];
    step = 'historical candidates show without selecting a hidden range';
    await page.getByRole('button', { name: /^全部\s+40$/ }).waitFor();
    assert.equal(await page.getByRole('button', { name: '该商品全部讲解', exact: true }).getAttribute('aria-pressed'), 'true');
    await page.getByRole('button', { name: '当前段', exact: true }).click();
    await page.getByRole('button', { name: /^全部\s+0$/ }).waitFor();
    await page.getByRole('button', { name: '该商品全部讲解', exact: true }).click();
    await page.getByRole('button', { name: /^全部\s+40$/ }).waitFor();
    assert.deepEqual(await readFile(bFilm), originalFilm, 'candidate filters do not edit the film');
    step = 'historical add and drag';
    const card = () => page.locator(`[data-candidate-card="${candidate.id}"]`);
    await card().waitFor();
    const add = card().getByRole('button', { name: '加入成片', exact: true });
    for (let i = 0; i < 100 && !await add.isEnabled(); i++) await page.waitForTimeout(50);
    assert.equal(await add.isEnabled(), true); assert.equal(await card().getAttribute('draggable'), 'true');
    await card().getByRole('button', { name: '预览', exact: true }).click();
    assert.deepEqual(await readFile(bFilm), originalFilm, 'preview does not edit the film');
    assert.deepEqual((await api(`projects/${b.id}/product-analysis`)).analysis.intervals, bInitial.intervals);
    const state = await api(`projects/${b.id}/live-analysis?sourceId=b-source&intervalId=${scope.id}&productId=b-product`);
    assert.equal(state.analysis.historicalEditable, true); assert.equal(state.analysis.stale, true); assert.notEqual(state.analysis.status, 'complete');
    const filmClips = async () => readFilmFile(await readFile(bFilm, 'utf8')).doc.tracks.flatMap(track => track.clips);
    const waitCount = async n => { for (let i = 0; i < 100; i++) { if ((await filmClips()).length === n) return; await page.waitForTimeout(100); } assert.fail(`Expected ${n} film clips`); };
    await add.click(); await waitCount(2);
    assert.deepEqual((await filmClips())[1].time, [0, 0.35]);
    const main = page.locator('[data-timeline-scope="main"]');
    await main.getByRole('button', { name: '适应宽度', exact: true }).click();
    await card().scrollIntoViewIfNeeded(); await page.waitForTimeout(200);
    const from = await card().boundingBox(), last = await main.locator('[data-block-kind="video"]').last().boundingBox(), viewport = await main.locator('.tl-scroll').boundingBox();
    assert.ok(from && last && viewport);
    await page.mouse.move(from.x + 4, from.y + 4); await page.mouse.down();
    await page.mouse.move(Math.min(viewport.x + viewport.width - 24, last.x + last.width + 60), last.y + last.height / 2, { steps: 30 });
    await page.waitForTimeout(200); await page.mouse.up(); await waitCount(3);
    assert.equal((await filmClips()).filter(c => JSON.stringify(c.time) === '[0,0.35]').length, 2);
    step = 'fresh browser reopen'; await context.close(); await open(); await card().waitFor();
    await page.getByRole('button', { name: /^全部\s+40$/ }).waitFor();
    assert.equal(await page.getByRole('button', { name: '该商品全部讲解', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await card().getByRole('button', { name: '加入成片', exact: true }).isEnabled(), true);
    assert.equal((await api(`projects/${b.id}/product-analysis`)).analysis.candidates.length, 40); assert.equal((await filmClips()).length, 3);
    step = 'fresh project selection prefers available history after two empty products';
    await context.close();
    const beforeSelection = (await api(`projects/${b.id}/product-analysis`)).analysis;
    const editedFilm = await readFile(bFilm);
    await api(`projects/${b.id}/product-analysis`, 'PUT', { analysis: { ...beforeSelection, products: [
      { id: 'first-unanalysed', name: '第一个商品 尚无话术', sourceIds: ['b-source'] },
      { id: 'second-unanalysed', name: '第二个商品 尚无话术', sourceIds: ['b-source'] },
      ...beforeSelection.products,
    ] } });
    await open();
    await page.locator('[data-product-card="b-product"] button[aria-pressed="true"]').waitFor();
    await page.getByRole('button', { name: /^全部\s+40$/ }).waitFor();
    await card().waitFor();
    const readyAdd = card().getByRole('button', { name: '加入成片', exact: true });
    for (let i = 0; i < 100 && !await readyAdd.isEnabled(); i++) await page.waitForTimeout(50);
    assert.equal(await readyAdd.isEnabled(), true);
    assert.equal(await card().getAttribute('draggable'), 'true');
    await card().getByRole('button', { name: '预览', exact: true }).click();
    await page.locator('[data-source-timeline-dock]').waitFor();
    const afterSelection = (await api(`projects/${b.id}/product-analysis`)).analysis;
    assert.deepEqual(afterSelection.intervals, beforeSelection.intervals);
    assert.deepEqual(afterSelection.scopes, beforeSelection.scopes);
    assert.deepEqual(afterSelection.candidates, beforeSelection.candidates);
    assert.deepEqual(await readFile(bFilm), editedFilm);
    assert.deepEqual(await readFile(join(a.path, 'film.html')), aFilm); assert.equal(requests, 0); assert.equal(forbiddenPosts, 0); assert.deepEqual(pageErrors, []);
    await page.screenshot({ path: join(base, 'roundtrip.png') });
  } catch (e) { await page?.screenshot({ path: join(base, 'roundtrip-failure.png') }).catch(() => {}); throw Error(`${step}: ${e.message}${pageErrors.length ? `\nPage errors: ${pageErrors.join('; ')}` : ''}`, { cause: e }); }
  finally { await context?.close(); await browser?.close(); await studio?.close(); for (const key of keys) old[key] === undefined ? delete process.env[key] : process.env[key] = old[key]; }
});
