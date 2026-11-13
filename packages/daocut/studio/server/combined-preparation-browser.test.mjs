// Real workflow/controller and UI, with synthetic media and injected local ASR/model callbacks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { startStudio } from './server.mjs';

for (const productCount of [1, 2]) test(`one confirmation prepares ${productCount} actual products and reopening does not request again`, { timeout: 60000 }, async () => {
  const base = resolve(import.meta.dirname, '../../../../.tmp/p38/combined-browser');
  await mkdir(base, { recursive: true }); const root = await mkdtemp(join(base, 'case-'));
  const names = ['DAOCUT_STUDIO_HOME', 'DAOCUT_LIBRARY', 'DAOCUT_TRASH_DIR', 'DAOCUT_NO_UPDATE_CHECK', 'TEMP', 'TMP'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) { process.env[name] = name === 'DAOCUT_NO_UPDATE_CHECK' ? '1' : join(root, name); if (name !== 'DAOCUT_NO_UPDATE_CHECK') await mkdir(process.env[name], { recursive: true }); }
  let studio, browser, page;
  const calls = { asr: 0, discovery: 0, analysis: 0 }, posts = [], errors = [], transcripts = new Map();
  const cues = [{ text: '商品甲完整介绍', startMs: 200, endMs: 2500 }, { text: productCount === 1 ? '商品甲继续介绍' : '商品乙完整介绍', startMs: 3000, endMs: 5500 }];
  const identity = { provider: 'mock', model: 'mock-text', endpoint: 'local://mock' };
  const readTranscript = async root => transcripts.get(root) ?? null;
  try {
    studio = await startStudio({ port: 0, editorDir: process.env.DAOCUT_TRANSCRIPTION_UI ? resolve(process.env.DAOCUT_TRANSCRIPTION_UI) : undefined, openBrowser() {}, requireAnalysisPlan: true,
      analysisServices: async () => ({ transcription: { ...identity, enabled: true, model: 'mock-asr' }, text: { ...identity, enabled: true } }),
      liveAnalysis: { modelIdentity: identity, readTranscript, transcribe: async root => { calls.asr++; const transcript = { cues }; transcripts.set(root, transcript); return transcript; }, modelClient: async () => { calls.analysis++; throw Error('Analysis must be separately requested'); } },
      productDiscovery: { modelIdentity: identity, readTranscript, modelClient: async () => {
        calls.discovery++;
        return { products: [{ key: 'a', name: '商品甲', variant: '', aliases: [], evidence: [0] }, ...(productCount === 2 ? [{ key: 'b', name: '商品乙', variant: '', aliases: [], evidence: [1] }] : [])], ranges: [{ key: 'a', firstCue: 0, lastCue: productCount === 1 ? 1 : 0, kind: 'lecture', reason: '商品介绍', evidence: [0] }, ...(productCount === 2 ? [{ key: 'b', firstCue: 1, lastCue: 1, kind: 'lecture', reason: '商品介绍', evidence: [1] }] : [])], issues: [] };
      } },
    });
    const api = async (path, method = 'GET', body) => {
      const response = await fetch(studio.origin + path, { method, headers: { 'x-studio-key': studio.key, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
    };
    const { project } = await api('/api/projects', 'POST', { path: join(root, 'project') });
    await mkdir(join(project.path, 'assets'), { recursive: true });
    const video = join(project.path, 'assets/synthetic.mp4');
    execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=5:d=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', video], { windowsHide: true });
    await api(`/api/projects/${project.id}/product-analysis`, 'PUT', { analysis: { version: 1, sources: [{ id: 's', assetPath: 'assets/synthetic.mp4', durationMs: 6000 }], products: [{ id: 'placeholder', name: '新素材', sourceIds: ['s'] }], intervals: [], candidates: [] } });
    const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
    const originals = await Promise.all([video, join(project.path, 'film.html')].map(hash));
    browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    page = await browser.newPage({ viewport: { width: 1600, height: 1000 } }); page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/product-workflow/execute')) posts.push(request.postDataJSON()); });
    await page.route('**/*', route => [studio.origin, studio.filmOrigin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort());
    const response = await page.goto(`${studio.origin}/projects/${project.id}?key=${studio.key}`);
    assert.equal(response.status(), 200, await response.text());
    await page.getByRole('button', { name: '商品与结构', exact: true }).click();
    const videoPanel = page.getByRole('region', { name: '原视频转写', exact: true });
    await videoPanel.getByRole('button', { name: '转写并拆品 assets/synthetic.mp4', exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: '确认转写并拆品', exact: true });
    await confirmation.getByText(/只有一个品就生成一个品/).waitFor();
    assert.deepEqual(calls, { asr: 0, discovery: 0, analysis: 0 });
    await confirmation.getByRole('button', { name: '确认转写并拆品', exact: true }).click();
    await page.getByRole('button', { name: /^商品甲.*段讲解/ }).waitFor();
    if (productCount === 2) await page.getByRole('button', { name: /^商品乙.*段讲解/ }).waitFor();
    await page.getByRole('button', { name: /^分析 00:00/ }).waitFor();
    assert.deepEqual(calls, { asr: 1, discovery: 1, analysis: 0 });
    assert.equal(posts.length, 1); assert.equal(posts[0].plan.prepare, true);
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal(await page.locator('[data-product-card]').getByRole('button', { name: /转写/ }).count(), 0);
    const saved = await api(`/api/projects/${project.id}/product-analysis`);
    assert.equal(saved.analysis.products.length, productCount); assert.equal(saved.analysis.intervals.length, productCount);
    await page.reload(); await videoPanel.getByText('商品已准备好', { exact: true }).waitFor();
    assert.deepEqual(calls, { asr: 1, discovery: 1, analysis: 0 });
    assert.equal(posts.length, 1);
    assert.deepEqual(await Promise.all([video, join(project.path, 'film.html')].map(hash)), originals);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: join(root, 'verified.png'), fullPage: true });
  } catch (error) { await page?.screenshot({ path: join(root, 'failure.png'), fullPage: true }).catch(() => {}); if (page) await writeFile(join(root, 'failure.html'), await page.content()); console.error(root); throw error; }
  finally { await writeFile(join(root, 'result.json'), JSON.stringify({ calls, posts, errors }, null, 2)); await browser?.close(); await studio?.close(); for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; } }
});
