// Local synthetic video and injected mock models only. No NAS or external service requests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startStudio } from './server.mjs';

test('multi-product proposals, independent cached ranges, manual corrections and reopening leave the film unchanged', { timeout: 180000 }, async () => {
  const base = resolve('../../.tmp/multi-product-20261103'); await mkdir(base, { recursive: true });
  const scratch = await mkdtemp(join(base, 'ui-range-'));
  const names = ['DAOCUT_STUDIO_HOME', 'DAOCUT_LIBRARY', 'DAOCUT_TRASH_DIR'];
  const old = Object.fromEntries(names.map(n => [n, process.env[n]]));
  for (const name of names) process.env[name] = join(scratch, name);
  await mkdir(process.env.DAOCUT_TRASH_DIR);
  let studio, browser, page;
  let discoveryCalls = 0, structureCalls = 0;
  const cues = [
    { startMs: 100, endMs: 1200, text: '这是甲商品' }, { startMs: 1300, endMs: 2800, text: '甲商品卖点' },
    { startMs: 3100, endMs: 4200, text: '下面换乙商品' }, { startMs: 4300, endMs: 5800, text: '乙商品福利' },
    { startMs: 7100, endMs: 8200, text: '甲商品小白管又回来了' }, { startMs: 8300, endMs: 9800, text: '继续说甲商品' },
    { startMs: 10100, endMs: 11200, text: '顺便提及丙，稍后再讲' },
  ];
  const options = { port: 0, openBrowser: () => {}, liveAnalysis: {
    readTranscript: async () => ({ cues }), modelIdentity: 'isolated-structure-v1',
    modelClient: async ({ input }) => { structureCalls++; const data = JSON.parse(input); return { candidates: [{ firstCue: 0, lastCue: data.cues.length - 1, tags: ['卖点'], details: { subtypes: [], reason: '合成结构', evidence: ['ASR'], context: '', repetition: '', review: [] } }], issues: [] }; },
  }, productDiscovery: {
    readTranscript: async () => ({ cues }), modelIdentity: 'isolated-discovery-v1',
    modelClient: async () => { discoveryCalls++; return { products: [{ key: 'a', name: '甲商品', variant: '', aliases: [{ name: '小白管', evidence: [4] }], evidence: [0, 4] }, { key: 'b', name: '乙商品', variant: '', aliases: [], evidence: [2] }], ranges: [
      { key: 'a', firstCue: 0, lastCue: 1, kind: 'lecture', reason: '甲介绍', evidence: [0] },
      { key: 'b', firstCue: 2, lastCue: 3, kind: 'lecture', reason: '乙介绍', evidence: [2] },
      { key: 'a', firstCue: 4, lastCue: 5, kind: 'lecture', reason: '甲返场', evidence: [4] },
      { key: null, firstCue: 6, lastCue: 6, kind: 'mention', reason: '仅提及丙', evidence: [6] },
    ], issues: [] }; },
  } };
  try {
    studio = await startStudio(options);
    const api = async (path, method = 'GET', body) => {
      const response = await fetch(`${studio.origin}${path}`, { method, headers: { 'x-studio-key': studio.key, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data)); return data;
    };
    const { project } = await api('/api/projects', 'POST', { path: join(scratch, 'project') });
    await mkdir(join(project.path, 'assets'), { recursive: true });
    const media = join(project.path, 'assets', 'synthetic-live.mp4');
    execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=10:d=12', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', media], { windowsHide: true });
    const initial = { version: 1, sources: [{ id: 's', assetPath: 'assets/synthetic-live.mp4', durationMs: 12000 }], products: [{ id: 'placeholder', name: '待拆品直播', sourceIds: ['s'] }], intervals: [], candidates: [] };
    await api(`/api/projects/${project.id}/product-analysis`, 'PUT', { analysis: initial });
    const filmPath = join(project.path, 'film.html'), filmBefore = await readFile(filmPath), mediaBefore = await readFile(media);
    const read = async () => (await api(`/api/projects/${project.id}/product-analysis`)).analysis;
    const open = async () => {
      browser = await chromium.launch({ executablePath: process.env.DAOCUT_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
      page = await browser.newPage({ viewport: { width: 1600, height: 1100 } }); page.setDefaultTimeout(15000);
      page.on('response', response => { if (response.status() >= 400) { const url = new URL(response.url()); console.log('local response', { status: response.status(), path: url.pathname, what: url.searchParams.get('what'), ms: url.searchParams.get('ms') }); } });
      // Studio serves project media from a second ephemeral local HTTP port.
      await page.route('**/*', route => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
      await page.goto(`${studio.origin}/projects/${project.id}?key=${studio.key}`);
      await page.getByRole('button', { name: '商品与结构', exact: true }).click();
    };
    const select = async name => page.getByLabel('商品列表', { exact: true }).getByRole('button', { name: new RegExp(`^${name}`) }).first().click();
    const saved = async action => { const response = page.waitForResponse(r => r.url().endsWith('/product-analysis') && r.request().method() === 'PUT'); await action(); assert.equal((await response).status(), 200); };
    const openDiscovery = async () => {
      const panel = page.getByLabel('直播拆品设置', { exact: true });
      if (!(await panel.evaluate(e => e.open))) await panel.locator('summary').first().click();
      const advanced = panel.getByLabel('拆品高级操作', { exact: true });
      if (!(await advanced.evaluate(e => e.open))) await advanced.locator('summary').first().click();
      return panel;
    };
    const openCorrections = async name => {
      if (!(await page.getByLabel('商品名称', { exact: true }).isVisible())) await page.getByRole('button', { name: `编辑商品名称：${name}`, exact: true }).click();
      const advanced = page.locator('details').filter({ has: page.locator(':scope > summary', { hasText: '归属与人工修正' }) });
      if (!(await advanced.evaluate(e => e.open))) await advanced.locator('summary').first().click();
      return page.getByLabel('商品讲解范围', { exact: true });
    };
    const locate = async id => {
      await page.locator('[data-source-axis]').getByRole('button', { name: '查看全场原片' }).click();
      await page.locator(`[data-source-axis] [data-source-product-range="${id}"]`).getByRole('button', { name: /^定位商品讲解 / }).click();
    };
    await open();
    // An existing manual name must still require review; a fresh placeholder now applies directly.
    await page.getByRole('button', { name: '编辑商品名称：待拆品直播', exact: true }).click();
    await page.getByLabel('商品名称', { exact: true }).fill('拆品前的人工命名');
    await saved(() => page.getByLabel('商品名称', { exact: true }).press('Enter'));
    const beforeDiscovery = await read();
    const discovery = await openDiscovery();
    await discovery.getByRole('button', { name: '识别多商品', exact: true }).click();
    assert.equal(discoveryCalls, 0);
    await page.getByRole('dialog', { name: '确认文字拆品' }).getByRole('button', { name: '确认文字请求' }).click();
    await page.getByLabel('拆品建议差异').waitFor();
    assert.equal(discoveryCalls, 1);
    assert.deepEqual(await read(), beforeDiscovery, 'a completed proposal must not overwrite an existing manual name');
    await page.getByRole('button', { name: '核对并应用建议' }).click();
    const initialApply = page.getByRole('dialog', { name: '确认应用拆品建议' });
    assert.equal(await initialApply.getByRole('button', { name: '确认应用', exact: true }).isDisabled(), true, 'a manual rename requires explicit replacement approval even without ranges');
    await initialApply.getByLabel('确认替换已复核范围').check();
    await initialApply.getByRole('button', { name: '确认应用', exact: true }).click();
    await page.getByLabel('商品列表', { exact: true }).getByRole('button', { name: /^甲商品/ }).first().waitFor();
    let data = await read();
    const a = data.products.find(p => p.name === '甲商品'), b = data.products.find(p => p.name === '乙商品');
    const [a1, a2] = data.intervals.filter(i => i.productId === a.id), b1 = data.intervals.find(i => i.productId === b.id);
    assert.deepEqual([a1, a2].map(i => [i.startMs, i.endMs]), [[100, 2800], [7100, 9800]]);
    assert.equal(data.unassigned[0].kind, 'mention');
    await select('甲商品');
    assert.equal(await page.getByLabel('商品讲解范围', { exact: true }).isVisible(), false, 'normal navigation has no separate lecture-range list');
    assert.match(await page.getByLabel('商品列表', { exact: true }).innerText(), /2 段讲解\s+共 00:05.400/);
    for (const [name, interval] of [['甲商品', a1], ['乙商品', b1], ['甲商品', a2]]) {
      await select(name);
      await locate(interval.id);
      await page.waitForFunction(ms => [...document.querySelectorAll('video')].some(v => v.currentSrc.includes('synthetic-live.mp4') && Math.abs(v.currentTime * 1000 - ms) < 80 && v.duration === 12), interval.startMs);
    }
    assert.deepEqual(await readFile(filmPath), filmBefore, 'A B A navigation must not edit the film');
    for (const interval of [a1, b1, a2]) {
      await api(`/api/projects/${project.id}/live-analysis/analyze`, 'POST', { sourceId: 's', intervalId: interval.id, productId: interval.productId, confirmed: true });
      for (let i = 0; i < 300; i++) { const state = await api(`/api/projects/${project.id}/live-analysis?sourceId=s&intervalId=${interval.id}&productId=${interval.productId}`); if (state.analysis.status === 'complete') break; await new Promise(r => setTimeout(r, 10)); }
    }
    assert.equal(structureCalls, 3);
    await page.reload(); await page.getByRole('button', { name: '商品与结构', exact: true }).click(); await select('甲商品');
    await page.getByLabel('候选显示范围', { exact: true }).getByRole('button', { name: '该商品全部讲解', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('section[aria-label="候选片段"] button')].filter(b => b.textContent === '加入成片' && !b.disabled).length === 2);
    await select('乙商品'); await page.getByLabel('候选片段').getByRole('button', { name: '加入成片', exact: true }).waitFor();
    assert.equal(await page.getByLabel('候选片段').getByRole('button', { name: '加入成片', exact: true }).isEnabled(), true);
    await select('甲商品');
    const settings = page.locator('details').filter({ has: page.locator(':scope > summary', { hasText: '分析详情' }) });
    await page.getByLabel('候选显示范围', { exact: true }).getByRole('button', { name: '该商品全部讲解', exact: true }).click();
    await settings.locator('summary').first().click();
    await page.getByLabel('文字分析范围', { exact: true }).selectOption(a1.id);
    await page.getByRole('button', { name: '重新分析结构', exact: true }).waitFor();
    assert.equal(structureCalls, 3, 'selecting a cached range reads without posting or invoking a model');
    await page.getByRole('button', { name: '编辑商品名称：甲商品', exact: true }).click();
    await page.getByLabel('商品名称', { exact: true }).fill('甲商品手动名');
    await saved(() => page.getByLabel('商品名称', { exact: true }).press('Enter'));
    await openCorrections('甲商品手动名');
    await page.locator(`[data-product-interval="${a2.id}"]`).getByRole('button', { name: `调整范围 ${a2.id}` }).click();
    await page.getByLabel('讲解起点', { exact: true }).fill('00:07.200'); await page.getByLabel('讲解终点', { exact: true }).fill('00:09.600');
    await saved(() => page.getByRole('button', { name: '保存范围', exact: true }).click());
    data = await read(); assert.equal(data.intervals.find(i => i.id === a2.id).startMs, 7200);
    const correctedCard = page.getByLabel('候选片段').locator('article').filter({ hasText: '甲商品小白管又回来了继续说甲商品' });
    assert.equal(await correctedCard.getByRole('button', { name: '加入成片', exact: true }).isDisabled(), true, 'changed bounds invalidate the candidate immediately, before polling');
    await page.getByLabel('商品名称', { exact: true }).press('Escape');
    await locate(a2.id);
    await page.locator(`[data-product-card="${a.id}"]`).getByRole('button', { name: /^分析 / }).waitFor();
    assert.equal(structureCalls, 3, 'editing a range only refreshes saved status');
    assert.ok(data.manualEdits.length >= 2);
    await select('乙商品'); await openCorrections('乙商品'); await page.getByText('修正商品归并', { exact: true }).click();
    await page.getByRole('button', { name: '合并到其他商品', exact: true }).click(); await page.getByLabel('合并目标商品').selectOption(a.id);
    await saved(() => page.getByRole('button', { name: '确认合并', exact: true }).click());
    await select('甲商品手动名');
    assert.equal((await read()).intervals.filter(i => i.productId === a.id).length, 3);
    await openCorrections('甲商品手动名');
    await page.getByText('修正商品归并', { exact: true }).click(); await page.getByRole('button', { name: '拆出新商品', exact: true }).click();
    await page.locator(`[data-product-interval="${a2.id}"] input[type="checkbox"]`).check(); await page.getByLabel('拆出商品名称').fill('待区分规格');
    await saved(() => page.getByRole('button', { name: '确认拆分', exact: true }).click());
    await select('待区分规格');
    data = await read(); assert.equal(data.candidates.find(c => c.intervalId === a2.id).productId, data.products.find(p => p.name === '待区分规格').id);
    await openCorrections('待区分规格');
    await page.getByText('修正商品归并', { exact: true }).click(); await page.getByRole('button', { name: '移除商品', exact: true }).click();
    await saved(() => page.getByRole('button', { name: '确认移除商品', exact: true }).click());
    await select('甲商品手动名');
    data = await read(); assert.ok(data.unassigned.some(i => i.id === a2.id)); assert.ok(data.archivedCandidates.some(c => c.intervalId === a2.id));
    await openCorrections('甲商品手动名');
    await page.locator('summary').filter({ hasText: /^待确认归属/ }).click();
    await page.locator(`[data-product-interval="${a2.id}"]`).getByRole('button', { name: `分配范围 ${a2.id}` }).click();
    await page.getByLabel('范围商品归属').selectOption(a.id);
    await saved(() => page.getByRole('button', { name: '保存范围', exact: true }).click());
    const beforeRerun = await read();
    const rerun = await openDiscovery(); await rerun.getByRole('button', { name: '重新识别商品', exact: true }).click();
    const rerunResponse = page.waitForResponse(r => r.url().endsWith('/product-discovery/discover') && r.request().method() === 'POST');
    await page.getByRole('dialog', { name: '确认文字拆品' }).getByRole('button', { name: '确认文字请求' }).click();
    assert.equal((await rerunResponse).status(), 200);
    for (let n = 0; n < 300; n++) { const result = await api(`/api/projects/${project.id}/product-discovery?sourceId=s`); if (discoveryCalls === 2 && result.status === 'complete') break; await new Promise(r => setTimeout(r, 10)); }
    await page.getByLabel('拆品建议差异').waitFor();
    assert.equal(discoveryCalls, 2); assert.deepEqual(await read(), beforeRerun, 'rerun proposals never overwrite manual corrections');
    await page.getByRole('button', { name: '核对并应用建议' }).click();
    const applyDialog = page.getByRole('dialog', { name: '确认应用拆品建议' });
    assert.equal(await applyDialog.getByRole('button', { name: '确认应用', exact: true }).isDisabled(), true);
    await applyDialog.getByRole('button', { name: '取消', exact: true }).click();
    await page.evaluate(() => { const label = document.createElement('div'); label.textContent = '合成测试 · 多商品与人工修正 · 非真实直播验收'; label.style.cssText = 'position:fixed;top:8px;left:420px;z-index:99999;background:#fff;color:#164bcc;padding:8px 12px;border:1px solid #164bcc;border-radius:6px;font:14px sans-serif;pointer-events:none'; document.body.append(label); });
    await page.screenshot({ path: join(base, 'ui-multi-product-mock.png') });
    await browser.close(); browser = null; await studio.close(); studio = await startStudio(options); await open();
    await select('甲商品手动名');
    assert.deepEqual(await read(), beforeRerun);
    assert.equal(discoveryCalls, 2); assert.equal(structureCalls, 3);
    assert.equal((await read()).intervals.find(i => i.id === a2.id).startMs, 7200);
    assert.deepEqual(await readFile(filmPath), filmBefore); assert.deepEqual(await readFile(media), mediaBefore);
  } finally {
    if (page && !page.isClosed()) console.log('video diagnostics', await page.locator('video').evaluateAll(videos => videos.map(v => ({ file: v.currentSrc.split('/assets/').pop()?.split('?')[0], time: v.currentTime, duration: v.duration, error: v.error?.code, readyState: v.readyState }))));
    if (page && !page.isClosed()) await page.screenshot({ path: join(base, 'ui-multi-product-final.png') }).catch(() => {});
    if (browser) await browser.close(); if (studio) await studio.close();
    for (const name of names) { if (old[name] === undefined) delete process.env[name]; else process.env[name] = old[name]; }
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
