// Synthetic local source and injected callbacks only. No real ASR/model request.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startStudio } from './server.mjs';

test('material preparation confirms audio and text separately, saves cuts, and keeps analysis on product cards', { timeout: 120000 }, async t => {
  const base = resolve(import.meta.dirname, '../../../../.tmp/product-simple-flow-20261103');
  await mkdir(base, { recursive: true });
  const scratch = await mkdtemp(join(base, 'browser-'));
  const names = ['DAOCUT_STUDIO_HOME', 'DAOCUT_LIBRARY', 'DAOCUT_TRASH_DIR', 'DAOCUT_NO_UPDATE_CHECK'];
  const old = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names.slice(0, 3)) process.env[name] = join(scratch, name);
  process.env.DAOCUT_NO_UPDATE_CHECK = '1';
  await mkdir(process.env.DAOCUT_TRASH_DIR);
  let studio, browser, releaseDiscovery;
  let asrCalls = 0, discoveryCalls = 0, structureCalls = 0, discoveryGate;
  const transcripts = new Map();
  const cues = [
    { startMs: 100, endMs: 1900, text: '合成商品甲的第一段介绍' },
    { startMs: 2100, endMs: 3900, text: '换到合成商品乙的完整介绍' },
    { startMs: 4100, endMs: 5900, text: '回到合成商品甲继续讲解' },
  ];
  const readTranscript = async root => transcripts.get(resolve(root)) ?? null;
  try {
    studio = await startStudio({ port: 0, editorDir: process.env.DAOCUT_TEST_EDITOR_DIR ? resolve(process.env.DAOCUT_TEST_EDITOR_DIR) : undefined, openBrowser: () => {}, requireAnalysisPlan: true,
      analysisServices: async () => ({
        transcription: { enabled: true, provider: 'synthetic', name: '合成转写', endpoint: 'local://mock/asr', model: 'synthetic-asr-v1' },
        text: { enabled: true, provider: 'synthetic', name: '合成文字分析', endpoint: 'local://mock/text', model: 'synthetic-text-v1' },
      }),
      liveAnalysis: {
        modelIdentity: 'synthetic-structure-v1', readTranscript,
        transcribe: async root => { asrCalls++; const transcript = { cues }; transcripts.set(resolve(root), transcript); return transcript; },
        modelClient: async () => { structureCalls++; return { candidates: [], issues: [] }; },
      },
      productDiscovery: {
        modelIdentity: 'synthetic-discovery-v1', readTranscript,
        modelClient: async () => {
          discoveryCalls++;
          if (discoveryGate) await discoveryGate;
          return { products: [
            { key: 'a', name: '合成商品甲', variant: '', aliases: [], evidence: [0, 2] },
            { key: 'b', name: '合成商品乙', variant: '', aliases: [], evidence: [1] },
          ], ranges: [
            { key: 'a', firstCue: 0, lastCue: 0, kind: 'lecture', reason: '甲第一次讲解', evidence: [0] },
            { key: 'b', firstCue: 1, lastCue: 1, kind: 'lecture', reason: '乙完整讲解', evidence: [1] },
            { key: 'a', firstCue: 2, lastCue: 2, kind: 'lecture', reason: '甲返场', evidence: [2] },
          ], issues: [] };
        },
      },
    });
    const api = async (path, method = 'GET', body) => {
      const response = await fetch(`${studio.origin}${path}`, { method, headers: { 'x-studio-key': studio.key, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
    };
    const fixture = async (name, savedTranscript) => {
      const { project } = await api('/api/projects', 'POST', { path: join(scratch, name) });
      await mkdir(join(project.path, 'assets'), { recursive: true });
      const mediaPath = join(project.path, 'assets', 'synthetic.mp4');
      execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=5:d=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', mediaPath], { windowsHide: true });
      const analysis = { version: 1, sources: [{ id: 's', assetPath: 'assets/synthetic.mp4', durationMs: 6000 }], products: [{ id: 'placeholder', name: '合成测试待准备素材', sourceIds: ['s'] }], intervals: [], candidates: [] };
      await api(`/api/projects/${project.id}/product-analysis`, 'PUT', { analysis });
      if (savedTranscript) transcripts.set(resolve(project.path), { cues });
      const protectedFiles = await Promise.all([mediaPath, join(project.path, 'film.html')].map(async path => [path, createHash('sha256').update(await readFile(path)).digest('hex')]));
      return { project, analysis, protectedFiles };
    };
    const readAnalysis = async f => (await api(`/api/projects/${f.project.id}/product-analysis`)).analysis;
    const unchanged = async f => {
      for (const [path, hash] of f.protectedFiles) assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), hash, path);
    };
    browser = await chromium.launch({ executablePath: process.env.DAOCUT_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const open = async f => {
      const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
      page.setDefaultTimeout(15000);
      const localOrigins = new Set([studio.origin, studio.filmOrigin]);
      await page.route('**/*', route => localOrigins.has(new URL(route.request().url()).origin) ? route.continue() : route.abort());
      const posts = [];
      page.on('request', request => { if (request.method() === 'POST' && /\/(?:product-workflow\/execute|product-preparation|product-discovery\/(?:discover|apply)|live-analysis\/(?:transcribe|analyze))$/.test(new URL(request.url()).pathname)) posts.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() }); });
      await page.goto(`${studio.origin}/projects/${f.project.id}?key=${studio.key}`);
      await page.getByRole('button', { name: '商品与结构', exact: true }).click();
      return { page, posts };
    };
    const prepared = async (page, f) => {
      const products = page.getByLabel('商品列表', { exact: true });
      await products.getByRole('button', { name: /^合成商品甲/ }).waitFor();
      await products.getByRole('button', { name: /^合成商品乙/ }).waitFor();
      const analysis = await readAnalysis(f);
      assert.equal(analysis.products.length, 2);
      assert.equal(analysis.intervals.length, 3);
      const a = analysis.products.find(product => product.name === '合成商品甲');
      assert.deepEqual(analysis.intervals.filter(range => range.productId === a.id).map(range => [range.startMs, range.endMs]), [[100, 1900], [4100, 5900]]);
      assert.equal(await page.getByRole('dialog').count(), 0, 'completed cuts do not need another application dialogue');
      await products.getByRole('button', { name: /^合成商品甲/ }).click();
      const card = products.locator(`[data-product-card="${a.id}"]`);
      await card.getByRole('button', { name: /^分析 / }).waitFor();
      await page.waitForFunction(id => [...document.querySelectorAll(`[data-product-card="${id}"] button`)].some(button => button.textContent === '分析' && !button.disabled), a.id);
      const details = page.locator('details').filter({ has: page.locator('summary').filter({ hasText: /^分析详情$/ }) });
      assert.equal(await details.evaluate(element => element.open), false);
      assert.equal(await page.getByText('分析当前商品段', { exact: true }).count(), 0);
      assert.equal(await page.getByRole('region', { name: '商品讲解范围', exact: true }).count(), 0, 'prepared products do not add a duplicate left-side range panel');
      const returningRange = analysis.intervals.find(range => range.productId === a.id && range.startMs === 4100);
      await page.locator('[data-source-axis]').getByRole('button', { name: '查看全场原片', exact: true }).click();
      await page.locator(`[data-source-axis] [data-source-product-range="${returningRange.id}"]`).getByRole('button', { name: /^定位商品讲解/ }).click();
      await card.getByRole('button', { name: '分析 00:04.100 – 00:05.900', exact: true }).waitFor();
      const firstRange = analysis.intervals.find(range => range.productId === a.id && range.startMs === 100);
      await page.locator('[data-source-axis]').getByRole('button', { name: '查看全场原片', exact: true }).click();
      await page.locator(`[data-source-axis] [data-source-product-range="${firstRange.id}"]`).getByRole('button', { name: /^定位商品讲解/ }).click();
      await card.getByRole('button', { name: '分析 00:00.100 – 00:01.900', exact: true }).waitFor();
      assert.equal(structureCalls, 0, 'material preparation never starts structure analysis');
      return analysis;
    };

    await t.test('separately confirmed discovery continues after its panel closes and saves A/B/A automatically', async () => {
      const f = await fixture('missing-transcript', false);
      const { page, posts } = await open(f);
      const preparation = page.getByRole('region', { name: '素材准备', exact: true });
      await preparation.getByRole('button', { name: '拆商品', exact: true }).waitFor();
      assert.deepEqual([asrCalls, discoveryCalls, structureCalls, posts.length], [0, 0, 0, 0]);
      await preparation.getByRole('button', { name: '拆商品', exact: true }).click();
      const confirm = page.getByRole('dialog', { name: '确认转写' });
      await confirm.getByText(/预计新增请求/).waitFor();
      assert.match(await confirm.innerText(), /转写.*等待单独确认文字拆品/);
      assert.deepEqual([asrCalls, discoveryCalls, posts.length], [0, 0, 0]);
      await confirm.getByRole('button', { name: '确认转写', exact: true }).click();
      await preparation.getByRole('button', { name: '继续拆商品', exact: true }).waitFor();
      assert.deepEqual([asrCalls, discoveryCalls, posts.length], [1, 0, 1], 'audio confirmation never authorizes discovery');
      discoveryGate = new Promise(resolve => { releaseDiscovery = resolve; });
      await preparation.getByRole('button', { name: '继续拆商品', exact: true }).click();
      await page.getByRole('dialog', { name: '确认拆品' }).getByRole('button', { name: '确认拆品', exact: true }).click();
      await preparation.getByText('正在拆商品', { exact: true }).waitFor();
      const outer = page.getByLabel('直播拆品设置', { exact: true });
      await outer.locator('summary').first().click();
      assert.equal(await outer.evaluate(element => element.open), false);
      releaseDiscovery(); discoveryGate = undefined;
      const saved = await prepared(page, f);
      assert.deepEqual([asrCalls, discoveryCalls, structureCalls], [1, 1, 0]);
      assert.deepEqual(posts.map(post => post.path.split('/').at(-1)), ['execute', 'execute']);
      assert.deepEqual(posts.map(post => [post.body.plan.action, post.body.plan.sourceId, post.body.confirmed]), [['transcription', 's', true], ['discovery', 's', true]]);
      await unchanged(f);
      // The visible screenshot is explicitly labelled synthetic and has no real footage.
      await page.evaluate(() => {
        const label = document.createElement('div'); label.textContent = '合成测试 · 选商品段后直接点击商品卡片上的分析';
        label.style.cssText = 'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:999999;background:#103c70;color:white;padding:8px 14px;font:14px sans-serif;border-radius:4px;pointer-events:none';
        document.body.append(label);
      });
      await page.screenshot({ path: join(base, 'synthetic-direct-analysis.png'), fullPage: false });
      await page.getByLabel('商品列表', { exact: true }).getByRole('button', { name: /^合成商品乙/ }).click();
      const b = saved.products.find(product => product.name === '合成商品乙');
      await page.locator(`[data-product-card="${b.id}"]`).getByRole('button', { name: /^分析 / }).waitFor();
      await page.reload();
      await page.getByRole('button', { name: '商品与结构', exact: true }).click();
      await prepared(page, f);
      assert.deepEqual(await readAnalysis(f), saved, 'reopening reads the same saved product cuts');
      assert.deepEqual([asrCalls, discoveryCalls, structureCalls, posts.length], [1, 1, 0, 2]);
      await unchanged(f);
      await page.close();
    });

    await t.test('existing transcript is reused without ASR and a single click sequence prepares cuts', async () => {
      const f = await fixture('saved-transcript', true), before = [asrCalls, discoveryCalls];
      const { page, posts } = await open(f);
      const preparation = page.getByRole('region', { name: '素材准备', exact: true });
      await preparation.getByRole('button', { name: '继续拆商品', exact: true }).waitFor();
      assert.deepEqual([asrCalls, discoveryCalls], before);
      assert.equal(posts.length, 0);
      await preparation.getByRole('button', { name: '继续拆商品', exact: true }).click();
      const confirm = page.getByRole('dialog', { name: '确认拆品' });
      await confirm.getByText(/预计新增请求/).waitFor();
      assert.match(await confirm.innerText(), /仅发送转写文字/);
      await confirm.getByRole('button', { name: '确认拆品', exact: true }).click();
      const saved = await prepared(page, f);
      assert.deepEqual([asrCalls, discoveryCalls], [before[0], before[1] + 1]);
      assert.equal(posts.length, 1);
      await page.reload();
      await page.getByRole('button', { name: '商品与结构', exact: true }).click();
      await prepared(page, f);
      assert.deepEqual(await readAnalysis(f), saved);
      assert.deepEqual([asrCalls, discoveryCalls, posts.length], [before[0], before[1] + 1, 1]);
      await unchanged(f);
      await page.close();
    });
  } finally {
    releaseDiscovery?.();
    await browser?.close(); await studio?.close();
    for (const name of names) { if (old[name] === undefined) delete process.env[name]; else process.env[name] = old[name]; }
    const child = relative(base, scratch);
    assert.ok(child && !child.startsWith('..') && !isAbsolute(child));
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
