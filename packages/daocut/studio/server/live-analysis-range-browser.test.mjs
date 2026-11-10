// Isolated UI -> real local route -> mock model. No external model or media requests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startStudio } from './server.mjs';

test('product navigation and explicit structure analysis use the same selected range without automatic requests', { timeout: 90000 }, async () => {
  const base = resolve('../../.tmp/review-fixes-20261031/temp'); await mkdir(base, { recursive: true });
  const scratch = await mkdtemp(join(base, 'analysis-range-'));
  const names = ['DAOCUT_STUDIO_HOME', 'DAOCUT_LIBRARY', 'DAOCUT_TRASH_DIR'];
  const old = Object.fromEntries(names.map(n => [n, process.env[n]]));
  for (const n of names) process.env[n] = join(scratch, n);
  await mkdir(process.env.DAOCUT_TRASH_DIR);
  let studio, browser;
  const calls = [], requests = [];
  let releaseDelayedA, signalStartedA;
  const delayedA = new Promise(resolve => { releaseDelayedA = resolve; });
  const startedA = new Promise(resolve => { signalStartedA = resolve; });
  const cues = [
    { startMs: 100, endMs: 900, text: '合成商品甲第一段' },
    { startMs: 2100, endMs: 2900, text: '合成商品甲第二段' },
    { startMs: 4100, endMs: 4900, text: '合成商品乙唯一段' },
  ];
  try {
    studio = await startStudio({ port: 0, openBrowser: () => {}, requireAnalysisPlan: true,
      analysisServices: async () => ({ transcription: { enabled: false, provider: 'synthetic' }, text: { enabled: true, provider: 'synthetic', name: '合成话术分析', endpoint: 'local://mock/text', model: 'isolated-mock-v1' } }),
      liveAnalysis: { modelIdentity: 'isolated-mock-v1',
      readTranscript: async () => ({ cues }),
      modelClient: async ({ input }) => {
        const parsed = JSON.parse(input); calls.push(parsed);
        if (parsed.intervalId === 'a-second') { signalStartedA(); await delayedA; }
        return { candidates: [{ firstCue: 0, lastCue: 0, tags: ['钩子'], details: { subtypes: [], reason: '隔离模拟候选', evidence: ['ASR'], context: '', repetition: '', review: ['画面待核实'] } }], issues: [] };
      },
    } });
    const api = async (path, method = 'GET', body, expected = 200) => {
      const res = await fetch(`${studio.origin}${path}`, { method, headers: { 'x-studio-key': studio.key, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const data = await res.json(); assert.equal(res.status, expected, JSON.stringify(data)); return data;
    };
    const { project } = await api('/api/projects', 'POST', { path: join(scratch, 'project') });
    await mkdir(join(project.path, 'assets'), { recursive: true });
    const sourceFile = join(project.path, 'assets', 'synthetic.mp4');
    execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=32x32:r=5:d=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', sourceFile], { windowsHide: true });
    const otherFile = join(project.path, 'assets', 'synthetic-other.mp4');
    await copyFile(sourceFile, otherFile);
    // Storage order deliberately differs from source/time order on the source timeline.
    const fixture = { version: 1, sources: [{ id: 't', assetPath: 'assets/synthetic-other.mp4', durationMs: 6000 }, { id: 's', assetPath: 'assets/synthetic.mp4', durationMs: 6000 }], products: [
      { id: 'a', name: '合成商品甲', sourceIds: ['t', 's'] }, { id: 'b', name: '合成商品乙', sourceIds: ['s'] },
    ], intervals: [
      { id: 'a-second', sourceId: 's', productId: 'a', startMs: 2000, endMs: 3000 },
      { id: 'a-other', sourceId: 't', productId: 'a', startMs: 1000, endMs: 2000 },
      { id: 'b-only', sourceId: 's', productId: 'b', startMs: 4000, endMs: 5000 },
      { id: 'a-first', sourceId: 's', productId: 'a', startMs: 0, endMs: 1000 },
    ], candidates: [{ id: 'candidate-first', sourceId: 's', productId: 'a', intervalId: 'a-first', startMs: 100, endMs: 900, text: '合成候选第一段', tags: ['钩子'], origin: 'synthetic-test', version: 1 }], unassigned: [{ id: 'pending', sourceId: 's', startMs: 3000, endMs: 3900, kind: 'uncertain', reason: '合成待确认' }] };
    fixture.candidates.push({ id: 'candidate-b', sourceId: 's', productId: 'b', intervalId: 'b-only', startMs: 4100, endMs: 4900, text: '合成乙候选', tags: ['卖点'], origin: 'synthetic-test', version: 1 });
    const initial = await api(`/api/projects/${project.id}/product-analysis`);
    await api(`/api/projects/${project.id}/product-analysis`, 'PUT', { analysis: fixture, expected: initial.analysis });
    const film = await readFile(join(project.path, 'film.html'));
    const savedAnalysis = await readFile(join(project.path, '.film', 'product-analysis.json'));
    const media = await readFile(sourceFile);
    browser = await chromium.launch({ executablePath: process.env.DAOCUT_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.setDefaultTimeout(12000);
    await page.addInitScript(() => {
      window.daocutHost = { onSelection: selection => { window.__chatSelection = selection; } };
    });
    // Allow only this isolated editor and its separate local media server; block remote activity.
    const localOrigins = new Set([studio.origin, studio.filmOrigin]);
    await page.route('**/*', route => localOrigins.has(new URL(route.request().url()).origin) ? route.continue() : route.abort());
    page.on('request', req => { if (req.method() === 'POST' && req.url().endsWith('/product-workflow/execute')) requests.push(req.postDataJSON()); });
    await page.goto(`${studio.origin}/projects/${project.id}?key=${studio.key}`);
    await page.getByRole('button', { name: '商品与结构', exact: true }).click();
    const productList = page.getByLabel('商品列表', { exact: true });
    const card = id => productList.locator(`[data-product-card="${id}"]`);
    const chooseProduct = name => productList.getByRole('button', { name: new RegExp(`^${name}`) }).click();
    await chooseProduct('合成商品甲');
    const details = page.locator('details').filter({ has: page.locator('summary').filter({ hasText: /^分析详情$/ }) });
    const showDetails = async open => {
      if (await details.evaluate(element => element.open) !== open) await details.locator('summary').first().click();
    };
    assert.equal(await page.getByText('结构分析设置', { exact: true }).count(), 0);
    assert.equal(await page.getByText('分析当前商品段', { exact: true }).count(), 0, 'there is no separate analysis area competing with product cards');
    assert.equal(await page.getByRole('region', { name: '商品讲解范围', exact: true }).count(), 0, 'routine selection uses the timeline, not a second lecture-range list');
    assert.equal(await details.evaluate(element => element.open), false, 'routine analysis does not require opening settings');
    await card('a').getByRole('button', { name: /^分析 / }).waitFor();
    const range = page.getByLabel('文字分析范围', { exact: true });
    await range.waitFor({ state: 'attached' });
    const source = page.getByLabel('分析来源视频', { exact: true });
    const position = async (ms, asset = 'synthetic.mp4') => page.waitForFunction(({ ms, asset }) => [...document.querySelectorAll('video')].some(v => v.currentSrc.includes(asset) && v.readyState >= 1 && Math.abs(v.currentTime * 1000 - ms) < 80 && v.duration === 6 && v.paused), { ms, asset });
    const selected = async (id, ms, asset) => {
      await page.waitForFunction(id => document.querySelector('select[aria-label="文字分析范围"]')?.value === id, id);
      await page.waitForFunction(id => window.__chatSelection?.productRange?.intervalId === id, id);
      const lecture = fixture.intervals.find(range => range.id === id);
      assert.deepEqual(await page.evaluate(() => window.__chatSelection.productRange), {
        sourceId: lecture.sourceId, productId: lecture.productId, intervalId: lecture.id,
        productName: fixture.products.find(product => product.id === lecture.productId).name,
        startMs: lecture.startMs, endMs: lecture.endMs,
      }, 'chat receives the selected lecture in absolute source time, not the preview/playhead');
      await page.locator(`[data-source-axis] [data-source-product-range="${id}"]`).getByRole('button', { name: /^定位商品讲解/, pressed: true }).waitFor();
      assert.equal(await page.locator('[data-source-axis] [data-source-product-range] button[aria-pressed="true"]').count(), 1, 'only the chosen lecture is marked selected, not every returning range for its product');
      await position(ms, asset);
    };
    const locate = async id => {
      await page.locator('[data-source-axis]').getByRole('button', { name: '查看全场原片' }).click();
      await page.locator(`[data-source-axis] [data-source-product-range="${id}"]`).getByRole('button', { name: /^定位商品讲解/ }).click();
    };
    assert.deepEqual(await range.locator('option').evaluateAll(es => es.map(e => e.value).filter(Boolean)), ['a-first', 'a-second']);
    await selected('a-first', 0);
    assert.equal(await source.inputValue(), 's', 'product default matches the first available lecture in the displayed order');
    await locate('a-second');
    await selected('a-second', 2000);
    await locate('a-first');
    await selected('a-first', 0);
    await locate('a-second');
    await selected('a-second', 2000);
    await page.locator('[data-source-axis] [data-source-candidate="candidate-b"]').click();
    await page.waitForFunction(() => document.querySelector('[data-source-candidate="candidate-b"]')?.getAttribute('data-source-selected') === 'true');
    assert.equal(await range.inputValue(), 'a-second', 'previewing another product candidate does not choose its lecture for chat');
    assert.equal(await page.evaluate(() => window.__chatSelection.productRange.intervalId), 'a-second');
    await locate('a-second');
    await page.getByRole('button', { name: '素材', exact: true }).click();
    await page.waitForFunction(() => window.__chatSelection?.productRange === null);
    await page.getByRole('button', { name: '商品与结构', exact: true }).click();
    await selected('a-second', 2000);
    assert.equal(await card('a').getByRole('button', { name: /^分析 / }).getAttribute('aria-label'), '分析 00:02 – 00:03', 'the card retains the lecture chosen on the timeline');
    await showDetails(true);
    await page.getByText('转写文本 · 3 条', { exact: true }).click();
    await page.getByRole('button', { name: /合成商品甲第一段/ }).click();
    await selected('a-second', 100);
    await page.getByLabel('候选显示范围', { exact: true }).getByRole('button', { name: '该商品全部讲解', exact: true }).click();
    await page.getByLabel('候选片段').getByText('合成候选第一段', { exact: true }).click();
    await selected('a-second', 100);
    await card('a').getByRole('button', { name: '编辑商品名称：合成商品甲', exact: true }).click();
    await card('a').locator('summary').filter({ hasText: /^归属与人工修正$/ }).click();
    await page.locator('summary').filter({ hasText: '待确认归属' }).click();
    await page.locator('[data-product-interval="pending"]').getByRole('button', { name: /^定位讲解/ }).click();
    await selected('a-second', 3000);
    await card('a').getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await page.getByRole('region', { name: '商品讲解范围', exact: true }).count(), 0, 'closing manual correction returns to timeline-only range selection');
    await range.selectOption('a-first');
    await selected('a-first', 0);
    await range.selectOption('a-second');
    await selected('a-second', 2000);
    await source.selectOption('t');
    await selected('a-other', 1000, 'synthetic-other.mp4');
    await source.selectOption('s');
    await locate('a-first');
    await selected('a-first', 0);
    assert.equal(await source.inputValue(), 's', 'the source selector and selected timeline lecture stay aligned');
    await source.selectOption('t');
    await source.selectOption('s');
    await selected('a-first', 0);
    await locate('a-second');
    await showDetails(false);
    await card('a').getByRole('button', { name: /^分析 / }).click();
    await page.getByRole('dialog', { name: '确认分析' }).waitFor();
    await locate('a-first');
    await selected('a-first', 0);
    await page.getByRole('dialog', { name: '确认分析' }).waitFor({ state: 'detached' });
    await chooseProduct('合成商品乙');
    await selected('b-only', 4000);
    await chooseProduct('合成商品甲');
    await selected('a-first', 0);
    await locate('a-second');
    await selected('a-second', 2000);
    await chooseProduct('合成商品甲');
    await selected('a-first', 0);
    assert.equal(calls.length, 0);
    assert.equal(requests.length, 0, 'navigation and choosing ranges never submit a model request');
    assert.deepEqual(await readFile(join(project.path, 'film.html')), film);
    assert.deepEqual(await readFile(join(project.path, '.film', 'product-analysis.json')), savedAnalysis);
    const run = async (expectedInterval, expectedProduct, expectedText, expectedCount, afterSubmit) => {
      assert.equal(await details.evaluate(element => element.open), false, 'selected-range analysis is available without opening details');
      const analyze = card(expectedProduct).getByRole('button', { name: /^分析 / });
      assert.equal(await analyze.count(), 1, 'the analysis action belongs to the selected product card');
      assert.equal(await analyze.getAttribute('aria-label'), {
        'a-second': '分析 00:02 – 00:03', 'b-only': '分析 00:04 – 00:05',
      }[expectedInterval], 'the card action identifies the selected lecture, including a returning product range');
      await analyze.click();
      const dialog = page.getByRole('dialog', { name: '确认分析' });
      await dialog.getByText(/预计新增请求/).waitFor();
      assert.match(await dialog.innerText(), /仅发送转写文字/);
      assert.equal(calls.length, expectedCount - 1, 'opening confirmation does not call the model');
      await dialog.getByRole('button', { name: '确认分析', exact: true }).click();
      if (afterSubmit) await afterSubmit();
      for (let i = 0; i < 200; i++) {
        const state = await api(`/api/projects/${project.id}/live-analysis?sourceId=s`);
        if (calls.length === expectedCount && state.analysis.status === 'complete') break;
        await new Promise(r => setTimeout(r, 10));
      }
      assert.equal(calls.length, expectedCount);
      assert.equal(requests.at(-1).confirmed, true);
      assert.deepEqual([requests.at(-1).plan.action, requests.at(-1).plan.sourceId, requests.at(-1).plan.productId, requests.at(-1).plan.intervalId], ['analysis', 's', expectedProduct, expectedInterval]);
      assert.equal(calls.at(-1).intervalId, expectedInterval);
      assert.equal(calls.at(-1).productId, expectedProduct);
      assert.deepEqual(calls.at(-1).cues.map(c => c.text), [expectedText], 'the card analyzes only the selected lecture, never all ranges for its product');
    };
    await locate('a-second');
    await selected('a-second', 2000);
    await run('a-second', 'a', cues[1].text, 1, async () => {
      await startedA;
      assert.equal((await api(`/api/projects/${project.id}/live-analysis?sourceId=s&productId=a&intervalId=a-second`)).analysis.status, 'running');
      await chooseProduct('合成商品乙');
      await selected('b-only', 4000);
      releaseDelayedA();
      for (let i = 0; i < 200; i++) {
        const state = await api(`/api/projects/${project.id}/live-analysis?sourceId=s&productId=a&intervalId=a-second`);
        if (state.analysis.status === 'complete') break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      await chooseProduct('合成商品甲');
      await locate('a-second');
      await selected('a-second', 2000);
      await page.getByLabel('候选片段').getByText(cues[1].text, { exact: true }).waitFor();
      assert.equal(calls.length, 1, 'returning to the completed background range refreshes candidates without another model request');
    });
    await chooseProduct('合成商品乙');
    await selected('b-only', 4000);
    assert.deepEqual(await range.locator('option').evaluateAll(es => es.map(e => e.value).filter(Boolean)), ['b-only']);
    assert.equal(await range.inputValue(), 'b-only', 'the only product range is selected explicitly in the request');
    await run('b-only', 'b', cues[2].text, 2);
    await page.getByLabel('候选片段').getByText(cues[2].text, { exact: true }).waitFor();
    await chooseProduct('合成商品甲');
    await locate('a-second');
    await selected('a-second', 2000);
    await card('a').getByRole('button', { name: /^已分析 / }).waitFor();
    assert.equal(await card('a').getByRole('button', { name: /^已分析 / }).isDisabled(), true);
    assert.equal(await details.evaluate(element => element.open), false);
    assert.equal(await card('a').getByRole('button', { name: /^分析 / }).count(), 0, 'a cached result is shown instead of a primary paid rerun');
    assert.equal(calls.length, 2, 'switching back to A retains its completed range result without another model call');
    await page.reload();
    await page.getByRole('button', { name: '商品与结构', exact: true }).click();
    await chooseProduct('合成商品甲');
    await locate('a-second');
    await selected('a-second', 2000);
    await card('a').getByRole('button', { name: /^已分析 / }).waitFor();
    assert.equal(await details.evaluate(element => element.open), false);
    await showDetails(true);
    await details.getByRole('button', { name: '重新分析结构', exact: true }).waitFor();
    assert.equal(calls.length, 2, 'reopening and selecting a saved range only reads its result');
    assert.equal(requests.length, 2);
    for (const body of [
      { sourceId: 's', productId: 'a', intervalId: 'missing' },
      { sourceId: 's', productId: 'a', intervalId: 'b-only' },
      { sourceId: 's', productId: 'a' },
    ]) await api(`/api/projects/${project.id}/product-workflow/plan?${new URLSearchParams({ action: 'analysis', ...body })}`, 'GET', undefined, 409);
    await api(`/api/projects/${project.id}/live-analysis/analyze`, 'POST', { sourceId: 's', productId: 'a', intervalId: 'a-first', confirmed: true }, 409);
    assert.equal(calls.length, 2, 'invalid or ambiguous scopes never invoke the model');
    assert.deepEqual(await readFile(join(project.path, 'film.html')), film);
    assert.deepEqual(await readFile(sourceFile), media);
    assert.deepEqual(await readFile(otherFile), media);
    const after = (await api(`/api/projects/${project.id}/product-analysis`)).analysis;
    assert.deepEqual(after.products, fixture.products);
    assert.deepEqual(after.intervals, fixture.intervals);
    assert.equal(after.candidates.filter(candidate => candidate.origin === 'ai-text').length, 2);
  } finally {
    releaseDelayedA();
    if (browser) await browser.close();
    if (studio) await studio.close();
    for (const n of names) { if (old[n] === undefined) delete process.env[n]; else process.env[n] = old[n]; }
    await rm(scratch, { recursive: true, force: true });
  }
});
