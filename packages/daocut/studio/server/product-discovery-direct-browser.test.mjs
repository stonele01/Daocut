// Synthetic local media and an injected model only; never opens a real project.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { chromium } from 'playwright-core';
import { startStudio } from './server.mjs';

test('first product cuts save directly while existing edits and save conflicts stay protected', { timeout: 120000 }, async t => {
  const base = resolve('../../.tmp/product-direct-20261103');
  await mkdir(base, { recursive: true });
  const scratch = await mkdtemp(join(base, 'browser-'));
  const names = ['DAOCUT_STUDIO_HOME', 'DAOCUT_LIBRARY', 'DAOCUT_TRASH_DIR', 'DAOCUT_NO_UPDATE_CHECK'];
  const old = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names.slice(0, 3)) process.env[name] = join(scratch, name);
  process.env.DAOCUT_NO_UPDATE_CHECK = '1';
  await mkdir(process.env.DAOCUT_TRASH_DIR);
  let studio, browser, modelCalls = 0, modelGate;
  const cues = [{ startMs: 100, endMs: 1900, text: '合成商品甲的完整介绍' }, { startMs: 2100, endMs: 2900, text: '稍后再讲乙' }];
  try {
    studio = await startStudio({ port: 0, openBrowser: () => {},
      analysisServices: async () => ({ transcription: { enabled: false, provider: 'synthetic' }, text: { enabled: true, provider: 'synthetic', name: '合成拆品', endpoint: 'local://mock/text', model: 'isolated-direct-cuts-v1' } }),
      liveAnalysis: { readTranscript: async () => ({ cues }) },
      productDiscovery: {
      modelIdentity: 'isolated-direct-cuts-v1', readTranscript: async () => ({ cues }),
      modelClient: async () => {
        modelCalls++;
        if (modelGate) await modelGate;
        return { products: [{ key: 'a', name: '合成商品甲', variant: '', aliases: [], evidence: [0] }], ranges: [
          { key: 'a', firstCue: 0, lastCue: 0, kind: 'lecture', reason: '介绍甲', evidence: [0] },
          { key: null, firstCue: 1, lastCue: 1, kind: 'mention', reason: '只提及乙', evidence: [1] },
        ], issues: ['普通识别疑点不阻塞切点保存'] };
      },
    } });
    const api = async (path, method = 'GET', body) => {
      const response = await fetch(`${studio.origin}${path}`, { method, headers: { 'x-studio-key': studio.key, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const value = await response.json();
      assert.equal(response.status, 200, JSON.stringify(value));
      return value;
    };
    browser = await chromium.launch({ executablePath: process.env.DAOCUT_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const fixture = async name => {
      const { project } = await api('/api/projects', 'POST', { path: join(scratch, name) });
      await mkdir(join(project.path, 'assets'), { recursive: true });
      const mediaPath = join(project.path, 'assets', 'synthetic.mp4');
      execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=32x32:r=5:d=3', '-c:v', 'mpeg4', '-y', mediaPath], { windowsHide: true });
      const analysis = { version: 1, sources: [{ id: 's', assetPath: 'assets/synthetic.mp4', durationMs: 3000 }], products: [{ id: 'placeholder', name: '导入素材占位名', sourceIds: ['s'] }], intervals: [], candidates: [] };
      await api(`/api/projects/${project.id}/product-analysis`, 'PUT', { analysis });
      return { project, analysis, mediaPath, media: await readFile(mediaPath), film: await readFile(join(project.path, 'film.html')) };
    };
    const read = async f => (await api(`/api/projects/${f.project.id}/product-analysis`)).analysis;
    const openPanel = async page => {
      const panel = page.getByLabel('直播拆品设置', { exact: true });
      if (!(await panel.evaluate(el => el.open))) await panel.locator('summary').first().click();
      const advanced = panel.getByLabel('拆品高级操作', { exact: true });
      if (!(await advanced.evaluate(el => el.open))) await advanced.locator('summary').first().click();
      return panel;
    };
    const open = async f => {
      const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
      page.setDefaultTimeout(15000);
      await page.route('**/*', route => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
      await page.goto(`${studio.origin}/projects/${f.project.id}?key=${studio.key}`);
      await page.getByRole('button', { name: '商品与结构', exact: true }).click();
      await openPanel(page);
      return page;
    };
    const start = async page => {
      const before = modelCalls;
      await page.getByRole('button', { name: '识别多商品', exact: true }).click();
      assert.equal(modelCalls, before, 'opening the request confirmation never starts a model');
      await page.getByRole('dialog', { name: '确认拆品' }).getByRole('button', { name: '确认拆品', exact: true }).click();
    };
    const unchangedMedia = async f => {
      assert.deepEqual(await readFile(f.mediaPath), f.media);
      assert.deepEqual(await readFile(join(f.project.path, 'film.html')), f.film);
    };

    await t.test('initial placeholder becomes saved cuts with no application dialogue; reopening only reads', async () => {
      const f = await fixture('initial');
      let page = await open(f), applies = 0;
      page.on('request', req => { if (req.method() === 'POST' && req.url().endsWith('/product-discovery/apply')) applies++; });
      let release;
      modelGate = new Promise(resolve => { release = resolve; });
      await start(page);
      await page.getByLabel('直播拆品设置', { exact: true }).locator('summary').first().click();
      release(); modelGate = undefined;
      await page.getByLabel('商品列表', { exact: true }).getByRole('button', { name: /^合成商品甲/ }).waitFor();
      const saved = await read(f);
      assert.equal(applies, 0, 'workflow saves first cuts on the server without a separate application POST');
      assert.equal(modelCalls, 1);
      assert.equal(saved.intervals.length, 1);
      assert.deepEqual([saved.intervals[0].startMs, saved.intervals[0].endMs], [100, 1900]);
      assert.equal(saved.unassigned.length, 1);
      assert.equal(saved.manualEdits.length, 1);
      assert.equal(saved.manualEdits[0].action, 'apply-proposal');
      assert.equal(await page.getByRole('dialog', { name: '确认应用拆品建议' }).count(), 0);
      await openPanel(page);
      await page.getByText('拆品：切点已保存', { exact: true }).waitFor();
      const original = page.getByLabel('拆品建议差异', { exact: true });
      assert.equal(await original.evaluate(el => el.open), false, 'AI evidence stays available but collapsed after saving');
      await original.locator('summary').first().click();
      await original.getByLabel('建议讲解范围').waitFor();
      assert.equal(applies, 0, 'reading the same completed run does not apply twice');
      await page.close();
      page = await open(f);
      const posts = [];
      page.on('request', req => { if (req.method() === 'POST' && req.url().includes('/product-discovery/')) posts.push(req.url()); });
      await page.getByText('拆品：切点已保存', { exact: true }).waitFor();
      assert.deepEqual(await read(f), saved);
      assert.equal(modelCalls, 1);
      assert.deepEqual(posts, []);
      await unchangedMedia(f);
      await page.close();
    });

    await t.test('a recorded manual product rename requires a reviewed replacement even without lecture ranges', async () => {
      const f = await fixture('manual');
      const edited = structuredClone(f.analysis); edited.products[0].name = '已人工命名';
      await api(`/api/projects/${f.project.id}/product-analysis`, 'PUT', { analysis: edited, expected: f.analysis });
      const before = await read(f), page = await open(f), applies = [];
      page.on('request', req => { if (req.method() === 'POST' && req.url().endsWith('/product-discovery/apply')) applies.push(req.postDataJSON()); });
      await start(page);
      await page.getByLabel('拆品建议差异').waitFor();
      assert.equal(modelCalls, 2);
      assert.deepEqual(await read(f), before);
      assert.deepEqual(applies, []);
      await page.getByRole('button', { name: '核对并应用建议', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '确认应用拆品建议' });
      assert.equal(await dialog.getByRole('button', { name: '确认应用', exact: true }).isDisabled(), true);
      await unchangedMedia(f);
      await page.close();
    });

    await t.test('an edit during discovery wins and marks its response stale without automatic retry', async () => {
      const f = await fixture('conflict'), page = await open(f);
      let applies = 0;
      page.on('request', req => { if (req.method() === 'POST' && req.url().endsWith('/product-discovery/apply')) applies++; });
      let release;
      modelGate = new Promise(resolve => { release = resolve; });
      const beforeCalls = modelCalls;
      await start(page);
      for (let n = 0; modelCalls === beforeCalls && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(modelCalls, beforeCalls + 1, 'manual change is made after the confirmed mock request begins');
      const changed = structuredClone(f.analysis); changed.products[0].name = '并发人工命名';
      await api(`/api/projects/${f.project.id}/product-analysis`, 'PUT', { analysis: changed, expected: f.analysis });
      release(); modelGate = undefined;
      await page.getByRole('button', { name: '显式重试拆品', exact: true }).waitFor();
      const interrupted = await api(`/api/projects/${f.project.id}/product-discovery?sourceId=s`);
      assert.equal(interrupted.status, 'failed'); assert.equal(interrupted.stale, true);
      assert.equal(interrupted.runs[0].completedWindows, 1, 'completed response is retained but not applied over concurrent manual changes');
      const saved = await read(f);
      assert.equal(saved.products[0].name, '并发人工命名');
      assert.equal(saved.intervals.length, 0);
      assert.equal(applies, 0);
      await page.reload();
      await page.getByRole('button', { name: '商品与结构', exact: true }).click();
      await openPanel(page);
      await page.getByRole('button', { name: '显式重试拆品', exact: true }).waitFor();
      assert.equal(applies, 0);
      assert.equal(modelCalls, 3);
      assert.deepEqual(await read(f), saved);
      await unchangedMedia(f);
      await page.close();
    });

    await t.test('a failed rerun submission cannot automatically apply an older unapplied proposal', async () => {
      const f = await fixture('failed-rerun');
      await api(`/api/projects/${f.project.id}/product-discovery/discover`, 'POST', { sourceId: 's', confirmed: true });
      let original;
      for (let n = 0; n < 200; n++) {
        original = await api(`/api/projects/${f.project.id}/product-discovery?sourceId=s`);
        if (original.status !== 'running') break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(original.status, 'complete');
      assert.ok(original.proposal);
      const before = await read(f), beforeCalls = modelCalls;
      assert.equal(before.intervals.length, 0, 'the existing completed proposal has not been applied');
      const page = await open(f);
      let applies = 0, rejected = 0;
      page.on('request', req => { if (req.method() === 'POST' && req.url().endsWith('/product-discovery/apply')) applies++; });
      await page.route('**/product-workflow/execute', async route => {
        if (route.request().method() !== 'POST') return route.continue();
        rejected++;
        assert.equal(route.request().postDataJSON().plan.rerun, true);
        await route.fulfill({ status: 503, json: { error: 'synthetic rerun submission rejected' } });
      });
      await page.getByRole('button', { name: '重新识别商品', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '确认拆品' });
      await dialog.getByRole('button', { name: '确认拆品', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'synthetic rerun submission rejected' }).waitFor();
      const refreshed = page.waitForResponse(response => response.request().method() === 'GET' && response.url().includes('/product-discovery?'));
      await dialog.getByRole('button', { name: '返回任务状态', exact: true }).click();
      await dialog.waitFor({ state: 'detached' });
      // Refresh the old proposal after dismissing the failed request. Neither
      // this GET nor the prior rejected POST authorizes applying that proposal.
      await refreshed;
      await page.getByRole('button', { name: '核对并应用建议', exact: true }).waitFor();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(rejected, 1);
      assert.equal(applies, 0, 'a rejected rerun must not give the previous proposal auto-apply authority');
      assert.equal(modelCalls, beforeCalls, 'the intercepted submission never reaches the mock model');
      assert.equal((await api(`/api/projects/${f.project.id}/product-discovery?sourceId=s`)).runId, original.runId);
      assert.deepEqual(await read(f), before);
      await unchangedMedia(f);
      await page.close();
    });
  } finally {
    await browser?.close(); await studio?.close();
    for (const name of names) { if (old[name] === undefined) delete process.env[name]; else process.env[name] = old[name]; }
    const child = relative(base, scratch);
    assert.ok(child && !child.startsWith('..') && !isAbsolute(child));
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
