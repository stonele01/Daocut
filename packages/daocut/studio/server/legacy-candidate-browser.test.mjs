// Synthetic legacy v1 results in an isolated project. No real media or service is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startStudio } from './server.mjs';
import { filmHtml, readFilmFile } from '../../src/film-doc.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');

test('13 saved legacy AI candidates remain editable without inventing a current model cache; add and drag use persisted personal takes', { timeout: 150000 }, async () => {
  const base = resolve(import.meta.dirname, '../../../../.tmp/legacy-candidate-20261105');
  await mkdir(base, { recursive: true });
  const scratch = await mkdtemp(join(base, 'browser-'));
  const env = ['DAOCUT_STUDIO_HOME', 'DAOCUT_LIBRARY', 'DAOCUT_TRASH_DIR'];
  const previous = Object.fromEntries(env.map(key => [key, process.env[key]]));
  for (const key of env) { process.env[key] = join(scratch, key); await mkdir(process.env[key]); }
  let studio, browser, context, page, step = 'setup', modelCalls = 0, paidPosts = 0;
  const diagnostics = [];
  try {
    const cues = Array.from({ length: 13 }, (_, index) => ({ startMs: 1000 + index * 2000, endMs: 3000 + index * 2000, text: `合成旧话术 ${index + 1}。第二句话保留在同一完整片段。` }));
    const mockRequest = async () => { modelCalls += 1; throw Error('This compatibility test must not invoke a model or transcription service.'); };
    studio = await startStudio({ port: 0, openBrowser: () => {}, liveAnalysis: { readTranscript: async () => ({ cues, words: [] }), transcribe: mockRequest, modelClient: mockRequest } });
    const api = async (path, method = 'GET', body) => {
      const response = await fetch(`${studio.origin}${path}`, { method, headers: { 'x-studio-key': studio.key, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const value = await response.json();
      assert.equal(response.status, 200, `${method} ${path}: ${JSON.stringify(value)}`);
      return value;
    };
    const { project } = await api('/api/projects', 'POST', { path: join(scratch, 'synthetic-legacy-project') });
    const endpoint = `/api/projects/${project.id}`, assetPath = 'assets/synthetic-legacy.mp4';
    const mediaPath = join(project.path, assetPath), filmPath = join(project.path, 'film.html');
    await mkdir(join(project.path, 'assets'), { recursive: true });
    execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=10:d=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', mediaPath], { windowsHide: true });
    const candidates = cues.map((cue, index) => ({ id: `c${index}`, sourceId: 's', productId: 'p', intervalId: 'sc', ...cue, tags: ['钩子'], origin: 'ai-text', version: 'text-structure-v1', runId: 'legacy-run' }));
    const analysis = { version: 1, sources: [{ id: 's', assetPath, durationMs: 30000 }], products: [{ id: 'p', name: '旧话术兼容合成商品', sourceIds: ['s'] }], intervals: [], scopes: [{ id: 'sc', sourceId: 's', productId: 'p', startMs: 0, endMs: 29000, kind: 'confirmed-inspection', confirmed: true }], candidates };
    await api(`${endpoint}/product-analysis`, 'PUT', { analysis });
    const info = await stat(mediaPath), sourceFingerprint = `${info.size}:${info.mtimeMs}`, transcriptHash = digest(JSON.stringify(cues));
    const legacy = { version: 1, sourceId: 's', transcription: { status: 'complete', sourceFingerprint, transcriptHash, segments: cues }, analysis: { status: 'complete', currentRunId: 'legacy-run', intervalId: 'sc', productId: 'p', rangeStartMs: 0, rangeEndMs: 29000, sourceFingerprint, transcriptHash } };
    const cachePath = join(project.path, '.film', 'live-analysis', `${digest('s')}.json`);
    await mkdir(join(project.path, '.film', 'live-analysis'), { recursive: true });
    await writeFile(cachePath, `${JSON.stringify(legacy, null, 2)}\n`);
    const firstTake = await api(`${endpoint}/source-takes?sourceId=s`);
    const adjusted = [1.5, 2.5];
    const document = { version: 1, sourceId: 's', assetPath, durationMs: 30000, signature: JSON.stringify([assetPath, 30000, candidates.map(item => [item.id, item.startMs, item.endMs])]), film: { tracks: [{ clips: candidates.map((item, index) => ({ id: `personal-${item.id}`, src: assetPath, at: index === 0 ? adjusted[0] : item.startMs / 1000, time: index === 0 ? adjusted : [item.startMs / 1000, item.endMs / 1000], attrs: { 'data-source-range': item.id, 'data-source-kind': 'candidate' } })) }] } };
    await api(`${endpoint}/source-takes?sourceId=s`, 'PUT', { document, sourceIdentity: firstTake.sourceIdentity, expectedRevision: 0 });
    await writeFile(filmPath, filmHtml({ stage: { w: 320, h: 180 }, tracks: [{ clips: [{ id: 'seed', src: assetPath, at: 0, time: [0, 1] }] }] }));
    const analysisPath = join(project.path, '.film', 'product-analysis.json');
    const originalAnalysis = await readFile(analysisPath, 'utf8'), originalCache = await readFile(cachePath, 'utf8'), originalMediaHash = digest(await readFile(mediaPath));
    browser = await chromium.launch({ executablePath: process.env.DAOCUT_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const openFresh = async () => {
      context = await browser.newContext({ viewport: { width: 1680, height: 1050 } });
      await context.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && /^https?:$/.test(url.protocol)) return route.abort();
        if (request.method() === 'POST' && /\/(?:live-analysis|product-discovery|product-preparation|transcribe)(?:[/?]|$)/.test(url.pathname)) { paidPosts += 1; return route.abort(); }
        return route.continue();
      });
      page = await context.newPage(); page.setDefaultTimeout(15000);
      await page.addInitScript(() => {
        window.__legacyDragEvents = [];
        for (const type of ['dragstart', 'drop', 'dragend']) document.addEventListener(type, event => {
          setTimeout(() => window.__legacyDragEvents.push({ type, target: event.target?.outerHTML?.slice(0, 300), types: [...(event.dataTransfer?.types ?? [])], prevented: event.defaultPrevented, x: event.clientX, y: event.clientY }), 0);
        });
      });
      page.on('pageerror', error => diagnostics.push({ pageError: String(error) }));
      await page.goto(`${studio.origin}/projects/${project.id}?key=${studio.key}`);
      await page.getByRole('button', { name: '商品与结构', exact: true }).click();
      await page.locator('[data-candidate-card="c0"]').waitFor();
      await page.locator('[data-timeline-scope="source"] [data-source-candidate="c0"][data-source-start="1500"][data-source-end="2500"]').waitFor();
    };
    const card = () => page.locator('[data-candidate-card="c0"]');
    const sourceBlock = () => page.locator('[data-timeline-scope="source"] [data-source-candidate="c0"]').first();
    const filmClips = async () => readFilmFile(await readFile(filmPath, 'utf8')).doc.tracks.flatMap(track => track.clips);
    const waitFilmCount = async count => {
      for (let n = 0; n < 100; n += 1) { const clips = await filmClips(); if (clips.length === count) return clips; await page.waitForTimeout(100); }
      assert.fail(`film did not contain ${count} clips`);
    };
    const assertOriginals = async () => {
      assert.equal(await readFile(analysisPath, 'utf8'), originalAnalysis, 'AI origins, run IDs, text and bounds are not rewritten by editing');
      assert.equal(await readFile(cachePath, 'utf8'), originalCache, 'legacy cache is neither rewritten nor promoted to a current cache');
      const state = await api(`${endpoint}/live-analysis?sourceId=s&intervalId=sc`);
      assert.equal(state.analysis.stale, true, 'editing old clips does not assert current model cache identity');
      assert.equal(state.analysis.currentRunId, 'legacy-run');
      assert.equal(state.analysis.cacheIdentity, undefined);
      assert.equal(state.analysis.modelIdentity, undefined);
      assert.equal(digest(await readFile(mediaPath)), originalMediaHash, 'synthetic source is unchanged');
      assert.equal(modelCalls, 0); assert.equal(paidPosts, 0);
    };
    await openFresh();
    step = 'legacy candidate preview uses the saved private range';
    assert.equal((await api(`${endpoint}/product-analysis`)).analysis.candidates.length, 13);
    await card().getByRole('button', { name: '预览', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('video')].some(video => video.offsetWidth && video.readyState >= 2 && !video.seeking && video.currentTime >= 1.5 && video.currentTime <= 2.6));
    await assertOriginals();
    step = 'saved legacy results allow both button and timeline drag without a fresh model cache';
    const availability = { previewWorked: true, addEnabled: await card().getByRole('button', { name: '加入成片', exact: true }).isEnabled(), cardDraggable: await card().getAttribute('draggable'), timelineDraggable: await sourceBlock().getAttribute('draggable') };
    await writeFile(join(base, 'browser-availability.json'), `${JSON.stringify(availability, null, 2)}\n`);
    assert.equal(availability.addEnabled, true, 'saved legacy AI clip must remain usable without falsely claiming current model cache identity');
    assert.equal(availability.cardDraggable, 'true');
    assert.equal((await api(`${endpoint}/live-analysis?sourceId=s&intervalId=sc`)).analysis.legacyEditable, true, 'legacy editing permission is separate from current paid-cache reuse');
    const seenCandidates = new Set(), candidateList = page.locator('[data-virtual-list][aria-label="结构候选列表"]');
    for (let pass = 0; pass < 25 && seenCandidates.size < candidates.length; pass += 1) {
      for (const item of await page.locator('[data-candidate-card]').all()) {
        const id = await item.getAttribute('data-candidate-card');
        assert.equal(await item.getByRole('button', { name: '加入成片', exact: true }).isEnabled(), true, `${id} should be usable`);
        seenCandidates.add(id);
      }
      await candidateList.evaluate(element => { element.scrollTop += 250; });
      await page.waitForTimeout(75);
    }
    assert.equal(seenCandidates.size, 13, 'all saved candidates are reachable through the virtual list');
    await candidateList.evaluate(element => { element.scrollTop = 0; });
    await card().waitFor();
    step = 'button inserts the adjusted range';
    await card().getByRole('button', { name: '加入成片', exact: true }).click();
    let clips = await waitFilmCount(2);
    assert.deepEqual(clips[1].time, adjusted); assert.equal(clips[1].src, assetPath);
    step = 'source timeline drag inserts the same adjusted range';
    const dragIntoFilm = async (locator, cardEdge = false) => {
      const main = page.locator('[data-timeline-scope="main"]');
      const fit = main.getByRole('button', { name: '适应宽度', exact: true });
      if (await fit.isEnabled()) await fit.click();
      await page.waitForTimeout(200);
      await locator.scrollIntoViewIfNeeded();
      const from = await locator.boundingBox();
      const last = await main.locator('[data-block-kind="video"]').last().boundingBox(), viewport = await main.locator('.tl-scroll').boundingBox();
      assert.ok(from && last && viewport, 'source and destination timeline blocks are visible');
      await page.mouse.move(from.x + (cardEdge ? 4 : from.width / 2), from.y + (cardEdge ? 4 : Math.min(18, from.height / 2)));
      await page.mouse.down();
      await page.mouse.move(Math.min(viewport.x + viewport.width - 24, last.x + last.width + 60), last.y + last.height / 2, { steps: 30 });
      await page.waitForTimeout(200); await page.mouse.up();
    };
    await dragIntoFilm(sourceBlock());
    clips = await waitFilmCount(3);
    assert.equal(clips.filter(item => JSON.stringify(item.time) === JSON.stringify(adjusted) && item.src === assetPath).length, 2, 'button and drag use identical adjusted bounds');
    step = 'candidate card drag uses the same adjusted range';
    await dragIntoFilm(card(), true);
    clips = await waitFilmCount(4);
    assert.equal(clips.filter(item => JSON.stringify(item.time) === JSON.stringify(adjusted) && item.src === assetPath).length, 3, 'button, source drag and candidate-card drag use identical adjusted bounds');
    const savedTakes = await api(`${endpoint}/source-takes?sourceId=s`);
    step = 'a clean browser reopens saved takes and film without model requests';
    await context.close(); await openFresh();
    assert.deepEqual(await api(`${endpoint}/source-takes?sourceId=s`), savedTakes);
    assert.equal((await filmClips()).length, 4);
    assert.equal(await card().getByRole('button', { name: '加入成片', exact: true }).isEnabled(), true);
    await assertOriginals();
    await page.screenshot({ path: join(base, 'legacy-candidate-browser.png') });
    const savedFilm = await readFile(filmPath, 'utf8');
    // Deliberate mutations below are confined to this disposable synthetic fixture.
    // A valid historical range does not authorize a different run or out-of-range candidate.
    for (const kind of ['wrong-run', 'outside-range']) {
      step = `${kind} synthetic candidate remains blocked while another valid old candidate is usable`;
      const modified = structuredClone(analysis);
      if (kind === 'wrong-run') modified.candidates[0].runId = 'unrelated-run';
      else {
        // Lecture intervals may contain an older candidate beyond their current bounds;
        // unlike confirmed-inspection scopes this is valid persisted project data.
        modified.intervals = [{ id: 'sc', sourceId: 's', productId: 'p', startMs: 0, endMs: 29000 }];
        modified.scopes = [];
        modified.candidates[0].startMs = 29000; modified.candidates[0].endMs = 29500;
      }
      await api(`${endpoint}/product-analysis`, 'PUT', { analysis: modified });
      await context.close(); await openFresh();
      const validButton = page.locator('[data-candidate-card="c1"]').getByRole('button', { name: '加入成片', exact: true });
      for (let attempt = 0; attempt < 50 && !await validButton.isEnabled(); attempt += 1) await page.waitForTimeout(50);
      assert.equal(await validButton.isEnabled(), true, 'control candidate remains usable; the whole feature was not disabled');
      assert.equal(await card().getByRole('button', { name: '加入成片', exact: true }).isEnabled(), false, kind);
      assert.equal(await card().getAttribute('draggable'), 'false', kind);
      await dragIntoFilm(sourceBlock());
      await page.waitForTimeout(250);
      assert.equal(await readFile(filmPath, 'utf8'), savedFilm, `${kind} cannot change the film through source drag`);
      assert.equal(await readFile(cachePath, 'utf8'), originalCache);
      assert.equal((await api(`${endpoint}/live-analysis?sourceId=s&intervalId=sc`)).analysis.stale, true);
    }
    assert.equal(digest(await readFile(mediaPath)), originalMediaHash); assert.equal(modelCalls, 0); assert.equal(paidPosts, 0);
    await writeFile(join(base, 'browser-result.json'), `${JSON.stringify({ synthetic: true, candidates: 13, legacyVersion: 1, adjustedRangeSeconds: adjusted, preview: true, addAndSourceAndCardDrag: true, freshBrowserReopen: true, preservedAnalysisAndCacheDuringEditing: true, currentModelCacheStale: true, wrongRunBlocked: true, outsideRangeBlocked: true, modelCalls, paidPosts }, null, 2)}\n`);
  } catch (error) {
    if (page) diagnostics.push({ dragEvents: await page.evaluate(() => window.__legacyDragEvents).catch(() => []) });
    await page?.screenshot({ path: join(base, 'legacy-candidate-browser-failure.png') }).catch(() => {});
    await writeFile(join(base, 'browser-failure.txt'), `${step}\n${error.stack}`);
    throw new Error(`Legacy candidate browser test failed at: ${step}: ${error.message}`, { cause: error });
  } finally {
    await writeFile(join(base, 'browser-diagnostics.json'), JSON.stringify({ step, diagnostics, modelCalls, paidPosts }, null, 2));
    await context?.close(); await browser?.close(); await studio?.close();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    assert.ok(scratch.startsWith(`${base}\\`) || scratch.startsWith(`${base}/`), 'cleanup stays in the isolated test directory');
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
