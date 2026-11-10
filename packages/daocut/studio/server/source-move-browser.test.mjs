// Real local UI and synthetic files; no real models or NAS are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startStudio } from './server.mjs';
import { readFilmFile } from '../../src/film-doc.mjs';

test('media-panel rename keeps selected product and personal take usable without reopening the browser', { timeout: 120000 }, async () => {
  const base = resolve(import.meta.dirname, '../../../../.tmp/source-safety-20261105/move-ui'); await mkdir(base, { recursive: true });
  const scratch = await mkdtemp(join(base, 'case-'));
  const names = ['DAOCUT_STUDIO_HOME', 'DAOCUT_LIBRARY', 'DAOCUT_TRASH_DIR'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) { process.env[name] = join(scratch, name); await mkdir(process.env[name]); }
  let studio, browser, page, projectPath, step = 'setup', calls = 0;
  const diagnostics = [];
  try {
    studio = await startStudio({ port: 0, openBrowser: () => {} });
    const api = async (path, method = 'GET', body) => {
      const response = await fetch(`${studio.origin}${path}`, { method, headers: { 'x-studio-key': studio.key, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const value = await response.json(); assert.equal(response.status, 200, `${path}: ${JSON.stringify(value)}`); return value;
    };
    const { project } = await api('/api/projects', 'POST', { path: join(scratch, 'project') });
    projectPath = project.path;
    const endpoint = `/api/projects/${project.id}`, assetPath = 'assets/before.mp4', movedPath = 'assets/after.mp4';
    await mkdir(join(project.path, 'assets'), { recursive: true });
    execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10:d=10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', join(project.path, assetPath)], { windowsHide: true });
    const sourceHash = createHash('sha256').update(await readFile(join(project.path, assetPath))).digest('hex');
    const analysis = { version: 1, sources: [{ id: 's', assetPath, durationMs: 10000 }], products: [{ id: 'p', name: '改名后仍可用的合成商品', sourceIds: ['s'] }], intervals: [{ id: 'i', productId: 'p', sourceId: 's', startMs: 0, endMs: 9000 }], candidates: [{ id: 'c', productId: 'p', sourceId: 's', intervalId: 'i', startMs: 1000, endMs: 5000, text: '合成完整话术', tags: ['卖点'], origin: 'synthetic-test', version: 1 }] };
    await api(`${endpoint}/product-analysis`, 'PUT', { analysis });
    const first = await api(`${endpoint}/source-takes?sourceId=s`);
    const document = { version: 1, sourceId: 's', assetPath, durationMs: 10000, signature: JSON.stringify([assetPath, 10000, [['c', 1000, 5000]]]), film: { tracks: [{ clips: [{ id: 'personal-c', src: assetPath, at: 3, time: [3, 5], attrs: { 'data-source-range': 'c', 'data-source-kind': 'candidate' } }] }] } };
    await api(`${endpoint}/source-takes?sourceId=s`, 'PUT', { document, sourceIdentity: first.sourceIdentity, expectedRevision: 0 });
    browser = await chromium.launch({ executablePath: process.env.DAOCUT_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1050 } });
    context.on('page', active => {
      active.on('pageerror', error => diagnostics.push({ pageError: String(error) }));
      active.on('console', entry => { if (entry.type() === 'error') diagnostics.push({ console: entry.text() }); });
      active.on('response', response => { if (response.url().includes('/source-takes')) void response.text().then(body => diagnostics.push({ url: response.url(), status: response.status(), body })); });
    });
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && /^https?:$/.test(url.protocol)) return route.abort();
      if (request.method() === 'POST' && /\/(?:live-analysis|product-discovery|product-preparation|transcribe)(?:[/?]|$)/.test(url.pathname)) calls++;
      return route.continue();
    });
    page = await context.newPage(); page.setDefaultTimeout(12000);
    const open = async () => { await page.goto(`${studio.origin}/projects/${project.id}?key=${studio.key}`); await page.getByRole('button', { name: '商品与结构', exact: true }).click(); };
    const adjusted = () => page.locator('[data-timeline-scope="source"] [data-source-candidate="c"][data-source-start="3000"][data-source-end="5000"]');
    await open(); await adjusted().waitFor();
    step = 'rename through existing media context menu';
    await page.getByRole('button', { name: '素材', exact: true }).click();
    await page.locator(`[data-media-path="${assetPath}"]`).click({ button: 'right' });
    await page.getByRole('menuitem', { name: /重命名|Rename/ }).click();
    const input = page.locator('input:focus'); await input.fill('after.mp4');
    const response = page.waitForResponse(r => r.request().method() === 'PATCH' && r.url().endsWith('/files'));
    await input.press('Enter'); assert.equal((await response).status(), 200);
    await page.locator(`[data-media-path="${movedPath}"]`).waitFor();
    step = 'same mounted project still locates the saved product and adjusted take';
    await page.getByRole('button', { name: '商品与结构', exact: true }).click();
    await adjusted().waitFor();
    const card = page.locator('[data-candidate-card="c"]');
    await card.getByRole('button', { name: '预览', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('video')].some(video => video.offsetWidth && video.readyState >= 2 && video.currentTime >= 3 && video.currentTime <= 5.2));
    await card.getByRole('button', { name: '加入成片', exact: true }).click();
    let clips;
    for (let i = 0; i < 80; i++) { clips = readFilmFile(await readFile(join(project.path, 'film.html'), 'utf8')).doc.tracks.flatMap(track => track.clips); if (clips.length) break; await page.waitForTimeout(100); }
    assert.equal(clips.length, 1); assert.equal(clips[0].src, movedPath); assert.deepEqual(clips[0].time, [3, 5]);
    step = 'fresh page keeps corrected paths and ranges';
    await page.close(); page = await context.newPage(); page.setDefaultTimeout(12000); await open(); await adjusted().waitFor();
    const saved = await api(`${endpoint}/source-takes?sourceId=s`);
    assert.equal(saved.document.assetPath, movedPath); assert.deepEqual(saved.document.film.tracks[0].clips[0].time, [3, 5]);
    assert.equal((await api(`${endpoint}/product-analysis`)).analysis.sources[0].assetPath, movedPath);
    assert.equal(createHash('sha256').update(await readFile(join(project.path, movedPath))).digest('hex'), sourceHash);
    assert.equal(calls, 0);
    await writeFile(join(base, 'result.json'), JSON.stringify({ synthetic: true, sourceHashUnchanged: true, samePageAndReopen: true, addedRange: [3, 5], modelPosts: calls }));
  } catch (error) {
    await page?.screenshot({ path: join(base, 'failure.png') }).catch(() => {});
    await writeFile(join(base, 'failure.txt'), `${step}\n${error.stack}`); throw error;
  } finally {
    const saved = {};
    if (projectPath) for (const file of ['.film/source-takes.json', '.film/product-analysis.json']) saved[file] = await readFile(join(projectPath, file), 'utf8').catch(() => null);
    await writeFile(join(base, 'diagnostics.json'), JSON.stringify({ diagnostics, saved }, null, 2));
    await browser?.close(); await studio?.close();
    for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; }
    await rm(scratch, { recursive: true, force: true });
  }
});
