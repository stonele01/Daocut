import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startStudio } from './server.mjs';
import { filmHtml, readFilmFile } from '../../src/film-doc.mjs';

// This fixture never connects a transcriber/model client. Reanalysis below changes
// only synthetic candidate data, through the same persisted analysis API as the UI.
test('personal source takes survive a fresh browser, server restart and new analysis; add and drag use the same take', { timeout: 180000 }, async () => {
  const base = resolve('../../.tmp/source-takes-project-20261104');
  await mkdir(base, { recursive: true });
  const scratch = await mkdtemp(join(base, 'browser-'));
  const env = ['DAOCUT_STUDIO_HOME', 'DAOCUT_LIBRARY', 'DAOCUT_TRASH_DIR'];
  const previous = Object.fromEntries(env.map(key => [key, process.env[key]]));
  process.env.DAOCUT_STUDIO_HOME = join(scratch, 'home');
  process.env.DAOCUT_LIBRARY = join(scratch, 'library');
  process.env.DAOCUT_TRASH_DIR = join(scratch, 'trash');
  await mkdir(process.env.DAOCUT_TRASH_DIR);
  let studio, browser, context, page, step = 'setup';
  let modelPosts = 0;
  try {
    studio = await startStudio({ port: 0, openBrowser: () => {} });
    const api = async (path, method = 'GET', body) => {
      const response = await fetch(`${studio.origin}${path}`, { method, headers: { 'x-studio-key': studio.key, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const value = await response.json();
      assert.equal(response.status, 200, `${method} ${path}: ${JSON.stringify(value)}`);
      return value;
    };
    const { project } = await api('/api/projects', 'POST', { path: join(scratch, 'synthetic-project') });
    const endpoint = `/api/projects/${project.id}`;
    await mkdir(join(project.path, 'assets'), { recursive: true });
    for (const name of ['a', 'b']) execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${name === 'a' ? 'blue' : 'green'}:s=320x180:r=10:d=30`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', join(project.path, 'assets', `synthetic-${name}.mp4`)], { windowsHide: true });
    const candidate = (id, sourceId, startMs, endMs, tag) => ({ id, productId: 'p', intervalId: sourceId === 'a' ? 'ia' : 'ib', sourceId, startMs, endMs, text: `合成取用 ${id}`, tags: [tag], origin: 'synthetic-test', version: 1 });
    const analysis = { version: 1, sources: ['a', 'b'].map(id => ({ id, assetPath: `assets/synthetic-${id}.mp4`, durationMs: null })), products: [{ id: 'p', name: '取用保存合成商品', sourceIds: ['a', 'b'] }], intervals: ['a', 'b'].map(id => ({ id: `i${id}`, productId: 'p', sourceId: id, startMs: 0, endMs: 29000 })), candidates: [candidate('trim', 'a', 2000, 7000, '钩子'), candidate('delete', 'a', 9000, 12000, '痛点'), candidate('split', 'a', 14000, 20000, '卖点'), candidate('refresh', 'a', 23000, 25000, '行动指令'), candidate('other', 'b', 3000, 7000, '价格锚点')] };
    await api(`${endpoint}/product-analysis`, 'PUT', { analysis });
    const filmPath = join(project.path, 'film.html');
    const analysisPath = join(project.path, '.film', 'product-analysis.json');
    // ffprobe metadata and browser duration can round differently by one ms.
    // Keep this discrepancy across loading, card use and later analysis saves.
    const fixtureAnalysis = JSON.parse(await readFile(analysisPath, 'utf8'));
    fixtureAnalysis.sources.find(source => source.id === 'a').durationMs = 29999;
    await writeFile(analysisPath, `${JSON.stringify(fixtureAnalysis, null, 2)}\n`);
    await writeFile(filmPath, filmHtml({ stage: { w: 320, h: 180 }, tracks: [{ clips: [{ id: 'seed', src: 'assets/synthetic-a.mp4', at: 0, time: [0, 1] }] }] }));
    const initialFilm = await readFile(filmPath, 'utf8');
    const initialAnalysis = await readFile(analysisPath, 'utf8');
    const hashes = async () => Promise.all(['a', 'b'].map(async name => createHash('sha256').update(await readFile(join(project.path, 'assets', `synthetic-${name}.mp4`))).digest('hex')));
    const initialHashes = await hashes();
    browser = await chromium.launch({ executablePath: process.env.DAOCUT_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const open = async () => {
      context = await browser.newContext({ viewport: { width: 1680, height: 1050 } });
      await context.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        // Studio serves project media on a second local origin.
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && /^https?:$/.test(url.protocol)) return route.abort();
        if (request.method() === 'POST' && /\/(?:live-analysis|product-discovery|product-preparation|transcribe)(?:[/?]|$)/.test(url.pathname)) modelPosts += 1;
        return route.continue();
      });
      page = await context.newPage();
      await page.goto(`${studio.origin}/projects/${project.id}?key=${studio.key}`);
      await page.getByRole('button', { name: '商品与结构', exact: true }).click();
      await page.locator('[data-source-candidate="trim"]').first().waitFor();
      await page.waitForFunction(() => [...document.querySelectorAll('video')].some(video => video.offsetWidth && video.readyState >= 2 && !video.seeking && video.duration >= 29));
      await stableBox(page.locator('[data-source-candidate="trim"]').first());
    };
    const source = () => page.locator('[data-timeline-scope="source"]');
    const main = () => page.locator('[data-timeline-scope="main"]');
    const block = id => source().locator(`[data-source-candidate="${id}"]`);
    const bounds = async locator => ({ startMs: Number(await locator.getAttribute('data-source-start')), endMs: Number(await locator.getAttribute('data-source-end')) });
    const sourceClips = document => document?.film?.tracks.flatMap(track => track.clips) ?? [];
    const saved = async id => api(`${endpoint}/source-takes?sourceId=${id}`);
    const waitSaved = async (id, predicate) => {
      for (let n = 0; n < 100; n += 1) {
        const value = await saved(id);
        if (value.document && predicate(sourceClips(value.document), value.document)) return value;
        await page.waitForTimeout(100);
      }
      assert.fail(`source ${id} did not save the expected private edit`);
    };
    const equals = (clip, range) => clip.time?.[0] === range.startMs / 1000 && clip.time?.[1] === range.endMs / 1000;
    const stableBox = async locator => {
      let last, stable = 0;
      for (let n = 0; n < 40; n += 1) {
        const next = await locator.boundingBox();
        if (next && last && ['x', 'y', 'width', 'height'].every(key => Math.abs(next[key] - last[key]) < 0.5)) stable += 1;
        else stable = 0;
        if (stable >= 3) return next;
        last = next;
        await page.waitForTimeout(50);
      }
      assert.fail('source block layout did not settle');
    };
    const trim = async (locator, edge, delta) => {
      await stableBox(locator);
      await locator.click();
      await page.waitForFunction(() => [...document.querySelectorAll('video')].some(video => video.offsetWidth && !video.seeking));
      const handle = await stableBox(locator.locator(`[data-trim="${edge}"]`));
      assert.ok(handle, 'visible trim handle');
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
      await page.mouse.down();
      await page.mouse.move(handle.x + handle.width / 2 + delta, handle.y + handle.height / 2, { steps: 14 });
      await page.mouse.up();
    };
    const card = id => page.locator(`[data-candidate-card="${id}"]`);
    const showTag = async tag => page.getByRole('button', { name: new RegExp(`^${tag}\\s+\\d+$`) }).click();
    const filmClips = async () => readFilmFile(await readFile(filmPath, 'utf8')).doc.tracks.flatMap(track => track.clips);
    const waitFilmCount = async count => {
      for (let n = 0; n < 100; n += 1) { const clips = await filmClips(); if (clips.length === count) return clips; await page.waitForTimeout(100); }
      assert.fail(`film did not contain ${count} clips`);
    };
    const dragIntoFilm = async locator => {
      await locator.scrollIntoViewIfNeeded();
      const from = await locator.boundingBox();
      const last = await main().locator('[data-block-kind="video"]').last().boundingBox();
      const viewport = await main().locator('.tl-scroll').boundingBox();
      assert.ok(from && last && viewport);
      await page.mouse.move(from.x + from.width / 2, from.y + Math.min(18, from.height / 2));
      await page.mouse.down();
      await page.mouse.move(Math.min(viewport.x + viewport.width - 24, last.x + last.width + 60), last.y + last.height / 2, { steps: 30 });
      await page.waitForTimeout(200);
      await page.mouse.up();
    };

    await open();
    step = 'trim candidate and gray take through the actual source timeline';
    await trim(block('trim').first(), 'start', 40);
    const adjusted = await bounds(block('trim').first());
    assert.ok(adjusted.startMs > 2000 && adjusted.endMs === 7000, JSON.stringify(adjusted));
    const beforeFailedSave = await waitSaved('a', items => items.some(clip => clip.attrs?.['data-source-range'] === 'trim' && equals(clip, adjusted)));
    const takesUrl = url => url.pathname.endsWith('/source-takes') && url.searchParams.get('sourceId') === 'a';
    let failedSavePosts = 0;
    const failSave = route => {
      if (route.request().method() === 'PUT') {
        failedSavePosts += 1;
        if (failedSavePosts === 1) return route.fulfill({ status: 503, json: { error: '合成保存失败：模拟磁盘暂时不可写' } });
      }
      return route.continue();
    };
    await page.route(takesUrl, failSave);
    const gray = source().locator('[data-source-context][data-source-start="25000"]').first();
    const grayId = await gray.getAttribute('data-source-context');
    const initialGrayRange = await bounds(gray);
    await trim(gray, 'start', 40);
    const grayRange = await bounds(source().locator(`[data-source-context="${grayId}"]`).first());
    assert.ok(grayRange.startMs > 25000 && grayRange.endMs === initialGrayRange.endMs, JSON.stringify(grayRange));
    step = 'failed project save is visible and retries only on the explicit retry button';
    await page.locator('[data-source-take-save-state="error"]').waitFor();
    assert.deepEqual(await saved('a'), beforeFailedSave, 'failed write does not replace the saved document');
    await page.waitForTimeout(300);
    assert.equal(failedSavePosts, 1, 'failed save was not silently retried');
    await page.getByRole('button', { name: '重试保存取用', exact: true }).click();
    await waitSaved('a', clips => clips.some(clip => clip.attrs?.['data-source-range'] === 'trim' && equals(clip, adjusted)) && clips.some(clip => clip.id === grayId && equals(clip, grayRange)));
    assert.equal(failedSavePosts, 2);
    await page.unroute(takesUrl, failSave);

    step = 'lost acknowledgement with a later queued edit recovers both revisions on explicit retry';
    let commitSeen, releaseAcknowledgement;
    const committed = new Promise(resolveCommit => { commitSeen = resolveCommit; });
    const acknowledgement = new Promise(resolveRelease => { releaseAcknowledgement = resolveRelease; });
    let acknowledgementWrites = 0;
    const loseAcknowledgement = async route => {
      if (route.request().method() !== 'PUT') return route.continue();
      acknowledgementWrites += 1;
      if (acknowledgementWrites !== 1) return route.continue();
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      commitSeen(await response.json());
      await acknowledgement;
      return route.abort('failed');
    };
    await page.route(takesUrl, loseAcknowledgement);
    await trim(block('refresh').first(), 'end', -18);
    const firstCommitted = await committed;
    await trim(block('refresh').first(), 'start', 18);
    const queuedRange = await bounds(block('refresh').first());
    assert.ok(queuedRange.startMs > 23000 && queuedRange.endMs < 25000, JSON.stringify(queuedRange));
    assert.equal(acknowledgementWrites, 1, 'later edit waits behind the first write');
    releaseAcknowledgement();
    await page.locator('[data-source-take-save-state="error"]').waitFor();
    assert.deepEqual(await saved('a'), firstCommitted, 'first write exists on disk despite its lost response');
    assert.equal(acknowledgementWrites, 1, 'uncertain write is not automatically repeated');
    await page.getByRole('button', { name: '重试保存取用', exact: true }).click();
    await waitSaved('a', items => items.some(clip => clip.attrs?.['data-source-range'] === 'refresh' && equals(clip, queuedRange)));
    assert.equal(acknowledgementWrites, 3, 'retry recovers the committed revision, then saves the later edit');
    await page.unroute(takesUrl, loseAcknowledgement);

    step = 'deleting a candidate is a persisted private removal';
    await block('delete').first().click();
    await page.keyboard.press('Delete');
    await block('delete').waitFor({ state: 'detached' });
    await waitSaved('a', clips => !clips.some(clip => clip.attrs?.['data-source-range'] === 'delete'));
    assert.equal(await readFile(filmPath, 'utf8'), initialFilm);
    assert.equal(await readFile(analysisPath, 'utf8'), initialAnalysis);

    step = 'candidate button and source drag both use the adjusted range';
    await showTag('钩子');
    await card('trim').getByRole('button', { name: '加入成片', exact: true }).click();
    let clips = await waitFilmCount(2);
    assert.ok(clips.some(clip => equals(clip, adjusted)), 'button uses adjusted bounds');
    await dragIntoFilm(block('trim').first());
    clips = await waitFilmCount(3);
    assert.equal(clips.filter(clip => equals(clip, adjusted)).length, 2, 'drag matches button source bounds');
    step = 'deleted candidate cannot silently add its original range';
    await showTag('痛点');
    const removedButton = card('delete').getByRole('button', { name: '加入成片', exact: true });
    if (await removedButton.isEnabled()) await removedButton.click();
    await page.waitForTimeout(300);
    assert.equal((await filmClips()).length, 3);

    step = 'split take uses the focused half for both button and drag';
    await source().getByRole('button', { name: /^分割/ }).first().click();
    await block('split').first().click();
    await page.waitForFunction(() => document.querySelectorAll('[data-timeline-scope="source"] [data-source-candidate="split"]').length === 2);
    await source().getByRole('button', { name: /^选择/ }).first().click();
    const rightHalf = block('split').nth(1);
    await rightHalf.click();
    const splitRange = await bounds(rightHalf);
    assert.ok(splitRange.startMs > 14000 && splitRange.endMs === 20000);
    await waitSaved('a', items => items.filter(clip => clip.attrs?.['data-source-range'] === 'split').length === 2);
    await showTag('卖点');
    await card('split').getByRole('button', { name: '加入成片', exact: true }).click();
    clips = await waitFilmCount(4);
    assert.ok(clips.some(clip => equals(clip, splitRange)), 'button uses the focused split half');
    await dragIntoFilm(rightHalf);
    clips = await waitFilmCount(5);
    assert.equal(clips.filter(clip => equals(clip, splitRange)).length, 2);

    step = 'independent source B edit does not replace source A';
    await page.getByLabel('候选显示范围', { exact: true }).getByRole('button', { name: '该商品全部讲解', exact: true }).click();
    await showTag('价格锚点');
    await card('other').getByText('合成取用 other', { exact: true }).click();
    await block('other').first().waitFor();
    await trim(block('other').first(), 'end', -40);
    const otherRange = await bounds(block('other').first());
    assert.ok(otherRange.endMs < 7000 && otherRange.startMs === 3000);
    await waitSaved('b', items => items.some(clip => equals(clip, otherRange)));
    assert.ok(sourceClips((await saved('a')).document).some(clip => equals(clip, adjusted)));

    step = 'restart service and open a clean browser context on a different origin';
    const beforeRestart = { a: await saved('a'), b: await saved('b') };
    await context.close(); context = undefined;
    const oldOrigin = studio.origin;
    await studio.close();
    studio = await startStudio({ port: 0, openBrowser: () => {} });
    assert.notEqual(studio.origin, oldOrigin, 'new local origin excludes browser storage reuse');
    await open();
    assert.equal(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('daocut:source-film:')).length), 0, 'fresh context has no legacy source film storage');
    assert.deepEqual(await bounds(block('trim').first()), adjusted);
    assert.equal(await block('delete').count(), 0);
    assert.equal(await block('split').count(), 2);
    assert.deepEqual(await bounds(block('split').nth(1)), splitRange);
    assert.deepEqual(await bounds(block('refresh').first()), queuedRange);
    assert.deepEqual(await bounds(source().locator(`[data-source-context="${grayId}"]`).first()), grayRange);
    assert.deepEqual(await saved('b'), beforeRestart.b);

    step = 'synthetic reanalysis changes candidate boundaries without replacing manual takes';
    const previousAnalysis = (await api(`${endpoint}/product-analysis`)).analysis;
    const updatedAnalysis = structuredClone(previousAnalysis);
    const updatedTrim = updatedAnalysis.candidates.find(item => item.id === 'trim');
    updatedTrim.startMs = 1000; updatedTrim.endMs = 8000; updatedTrim.version = 2;
    updatedAnalysis.candidates = updatedAnalysis.candidates.filter(item => item.id !== 'refresh');
    updatedAnalysis.candidates.push(candidate('new', 'a', 24000, 26000, '行动指令'));
    await api(`${endpoint}/product-analysis`, 'PUT', { analysis: updatedAnalysis, expected: previousAnalysis });
    await page.reload();
    await page.getByRole('button', { name: '商品与结构', exact: true }).click();
    await block('trim').first().waitFor();
    assert.deepEqual(await bounds(block('trim').first()), adjusted, 'manual trim survives new model boundaries');
    assert.equal(await block('delete').count(), 0, 'removed take is not recreated');
    assert.equal(await block('split').count(), 2, 'split remains split after reanalysis');
    assert.deepEqual(await bounds(block('split').nth(1)), splitRange);
    assert.deepEqual(await bounds(source().locator(`[data-source-context="${grayId}"]`).first()), grayRange, 'gray trim survives reanalysis');
    await block('new').first().waitFor();
    await waitSaved('a', items => items.some(clip => equals(clip, adjusted)) && items.some(clip => clip.attrs?.['data-source-range'] === 'new') && items.some(clip => clip.attrs?.['data-source-origin-range'] === 'refresh' && equals(clip, queuedRange)));
    assert.equal(await source().locator(`[data-source-context][data-source-start="${queuedRange.startMs}"][data-source-end="${queuedRange.endMs}"]`).count(), 1, 'manual take survives replacement of its AI identity');
    await showTag('钩子');
    await card('trim').getByRole('button', { name: '加入成片', exact: true }).click();
    clips = await waitFilmCount(6);
    assert.equal(clips.filter(clip => equals(clip, adjusted)).length, 3);
    assert.deepEqual(await hashes(), initialHashes);
    assert.equal(modelPosts, 0, 'no transcription or model requests were made');
    await page.screenshot({ path: join(base, 'source-takes-project.png') });
    await writeFile(join(base, 'browser-result.json'), `${JSON.stringify({ synthetic: true, modelPosts, adjusted, grayRange, otherRange, splitRange, queuedRange, cleanBrowserRestart: true, newServerOrigin: true, preservedAfterReanalysis: true, buttonDragParity: true, focusedSplitParity: true, failedSaveExplicitRetry: true, lostAcknowledgementQueuedEdit: true, metadataDurationOffsetMs: -1 }, null, 2)}\n`);
  } catch (error) {
    await page?.screenshot({ path: join(base, 'source-takes-project-failure.png') }).catch(() => {});
    throw new Error(`Source takes project test failed at: ${step}: ${error.message}`, { cause: error });
  } finally {
    await context?.close(); await browser?.close(); await studio?.close();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('legacy browser takes migrate once into the project and never overwrite an existing project document', { timeout: 60000 }, async () => {
  const base = resolve('../../.tmp/source-takes-project-20261104');
  await mkdir(base, { recursive: true });
  const scratch = await mkdtemp(join(base, 'migration-'));
  const env = ['DAOCUT_STUDIO_HOME', 'DAOCUT_LIBRARY', 'DAOCUT_TRASH_DIR'];
  const previous = Object.fromEntries(env.map(key => [key, process.env[key]]));
  process.env.DAOCUT_STUDIO_HOME = join(scratch, 'home');
  process.env.DAOCUT_LIBRARY = join(scratch, 'library');
  process.env.DAOCUT_TRASH_DIR = join(scratch, 'trash');
  await mkdir(process.env.DAOCUT_TRASH_DIR);
  let studio, browser, page, step = 'setup';
  let modelPosts = 0;
  try {
    studio = await startStudio({ port: 0, openBrowser: () => {} });
    const api = async (path, method = 'GET', body) => {
      const response = await fetch(`${studio.origin}${path}`, { method, headers: { 'x-studio-key': studio.key, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
    };
    const { project } = await api('/api/projects', 'POST', { path: join(scratch, 'synthetic-migration') });
    const endpoint = `/api/projects/${project.id}`;
    await mkdir(join(project.path, 'assets'), { recursive: true });
    const assetPath = 'assets/legacy.mp4', mediaPath = join(project.path, 'assets', 'legacy.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10:d=20', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', mediaPath], { windowsHide: true });
    const analysis = { version: 1, sources: [{ id: 'legacy', assetPath, durationMs: null }], products: [{ id: 'p', name: '旧取用迁移合成商品', sourceIds: ['legacy'] }], intervals: [{ id: 'i', sourceId: 'legacy', productId: 'p', startMs: 0, endMs: 19000 }], candidates: [['trim', 2000, 6000], ['deleted', 8000, 10000], ['untouched', 12000, 15000]].map(([id, startMs, endMs]) => ({ id, sourceId: 'legacy', productId: 'p', intervalId: 'i', startMs, endMs, text: `合成旧取用 ${id}`, tags: ['钩子'], origin: 'synthetic-test', version: 1 })) };
    await api(`${endpoint}/product-analysis`, 'PUT', { analysis });
    // A legacy browser rounded duration while persisted probe metadata rounded down.
    const migrationAnalysisPath = join(project.path, '.film', 'product-analysis.json');
    const migrationAnalysis = JSON.parse(await readFile(migrationAnalysisPath, 'utf8'));
    migrationAnalysis.sources[0].durationMs = 19999;
    await writeFile(migrationAnalysisPath, JSON.stringify(migrationAnalysis));
    const analysisBefore = await readFile(join(project.path, '.film', 'product-analysis.json'), 'utf8');
    const filmBefore = await readFile(join(project.path, 'film.html'), 'utf8');
    const mediaHashBefore = createHash('sha256').update(await readFile(mediaPath)).digest('hex');
    const signature = JSON.stringify([assetPath, 20000, analysis.candidates.map(candidate => [candidate.id, candidate.startMs, candidate.endMs])]);
    const legacyClip = (id, from, to, candidateId = '') => ({ id, src: assetPath, at: from, time: [from, to], attrs: { 'data-source-range': candidateId, 'data-source-kind': candidateId ? 'candidate' : 'context' } });
    // Old source-film snapshots had no origin metadata. Keep the missing deleted
    // candidate and the deliberately shortened gray take exactly as the user left them.
    const legacyFilm = { tracks: [{ clips: [legacyClip('source-0', 0, 1.5), legacyClip('source-1', 3, 5, 'trim'), legacyClip('source-2', 6, 8), legacyClip('source-4', 10, 12), legacyClip('source-5', 12, 15, 'untouched'), legacyClip('source-6', 15, 20)] }] };
    const storageKey = `daocut:source-film:${project.id}:legacy`;
    browser = await chromium.launch({ executablePath: process.env.DAOCUT_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && /^https?:$/.test(url.protocol)) return route.abort();
      if (request.method() === 'POST' && /\/(?:live-analysis|product-discovery|product-preparation|transcribe)(?:[/?]|$)/.test(url.pathname)) modelPosts += 1;
      return route.continue();
    });
    await context.addInitScript(({ key, value }) => { if (!localStorage.getItem(key)) localStorage.setItem(key, value); }, { key: storageKey, value: JSON.stringify({ signature, film: legacyFilm }) });
    page = await context.newPage();
    step = 'load compatible browser takes and save them into the project';
    await page.goto(`${studio.origin}/projects/${project.id}?key=${studio.key}`);
    await page.getByRole('button', { name: '商品与结构', exact: true }).click();
    const source = page.locator('[data-timeline-scope="source"]');
    await source.locator('[data-source-candidate="trim"][data-source-start="3000"][data-source-end="5000"]').waitFor();
    await page.locator('[data-source-take-save-state="saved"]').waitFor();
    const migrated = await api(`${endpoint}/source-takes?sourceId=legacy`);
    assert.equal(migrated.revision, 1);
    assert.deepEqual(migrated.document.film, legacyFilm);
    assert.equal(await source.locator('[data-source-candidate="deleted"]').count(), 0);
    const disk = JSON.parse(await readFile(join(project.path, '.film', 'source-takes.json'), 'utf8'));
    assert.deepEqual(disk.sources[0].document.film, legacyFilm, 'migration is on disk, not just a successful GET');

    step = 'conflicting legacy browser data cannot replace the already saved project';
    const conflictingFilm = structuredClone(legacyFilm);
    conflictingFilm.tracks[0].clips[1] = legacyClip('source-1', 4, 6, 'trim');
    conflictingFilm.tracks[0].clips.push(legacyClip('source-3', 8, 10, 'deleted'));
    await page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: storageKey, value: JSON.stringify({ signature, film: conflictingFilm }) });
    await page.reload();
    await page.getByRole('button', { name: '商品与结构', exact: true }).click();
    await source.locator('[data-source-candidate="trim"][data-source-start="3000"][data-source-end="5000"]').waitFor();
    await page.locator('[data-source-take-save-state="saved"]').waitFor();
    assert.equal(await source.locator('[data-source-candidate="deleted"]').count(), 0);
    assert.deepEqual(await api(`${endpoint}/source-takes?sourceId=legacy`), migrated, 'project document wins without another migration write');
    assert.equal(await readFile(join(project.path, '.film', 'product-analysis.json'), 'utf8'), analysisBefore);
    assert.equal(await readFile(join(project.path, 'film.html'), 'utf8'), filmBefore);
    assert.equal(createHash('sha256').update(await readFile(mediaPath)).digest('hex'), mediaHashBefore);
    assert.equal(modelPosts, 0);
    await writeFile(join(base, 'migration-result.json'), `${JSON.stringify({ synthetic: true, modelPosts, migratedRevision: migrated.revision, legacyTrim: [3000, 5000], legacyDeletionPreserved: true, projectWinsOverConflictingBrowser: true }, null, 2)}\n`);
  } catch (error) {
    await page?.screenshot({ path: join(base, 'source-takes-migration-failure.png') }).catch(() => {});
    throw new Error(`Source takes migration test failed at: ${step}: ${error.message}`, { cause: error });
  } finally {
    await browser?.close(); await studio?.close();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
