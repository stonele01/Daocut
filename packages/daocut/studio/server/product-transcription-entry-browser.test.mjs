// Only synthetic media and mocked workflow requests. No paid service is contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startStudio } from './server.mjs';

const artifactRoot = resolve(process.env.DAOCUT_TRANSCRIPTION_TEST_ROOT || resolve(import.meta.dirname, '../../../../.tmp/transcription-entry'));

async function fixture(initial, run, { hasInterval = true, planError = false, multipleProducts = false, needsReview = false, analysisRunning = false } = {}) {
  await mkdir(artifactRoot, { recursive: true });
  const scratch = await mkdtemp(join(artifactRoot, 'case-'));
  const names = ['DAOCUT_STUDIO_HOME', 'DAOCUT_LIBRARY', 'DAOCUT_TRASH_DIR', 'DAOCUT_NO_UPDATE_CHECK', 'TEMP', 'TMP'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  Object.assign(process.env, { DAOCUT_STUDIO_HOME: join(scratch, 'home'), DAOCUT_LIBRARY: join(scratch, 'library'), DAOCUT_TRASH_DIR: join(scratch, 'trash'), DAOCUT_NO_UPDATE_CHECK: '1', TEMP: join(scratch, 'temp'), TMP: join(scratch, 'temp') });
  await Promise.all(['home', 'trash', 'temp'].map(name => mkdir(join(scratch, name), { recursive: true })));
  let studio, browser, page, status = initial, savedSeam = false, discoveryReady = analysisRunning;
  const calls = { plans: [], executions: [], saves: [], forbidden: [] }, errors = [];
  const source = { id: 's', assetPath: 'assets/synthetic.mp4', durationMs: 12000 };
  const cues = [{ startMs: 4000, endMs: 7000, text: '合成字幕完整句子' }];
  const transcription = () => ({ status: status === 'boundary' ? 'failed' : status, segments: status === 'complete' ? cues : [], ...(status === 'boundary' ? { code: 'ASR_BOUNDARY_REVIEW', localReviewRequired: true, error: '分段转写已保存，交界处待核对' } : {}) });
  const review = () => ({ available: true, source, identity: 'synthetic-review', revision: savedSeam ? 1 : 0, pendingCount: savedSeam ? 0 : 1, complete: savedSeam, impact: { discovery: false, ranges: [] }, seams: [{ id: 'seam-1', boundaryMs: 6000, startMs: 4000, endMs: 8000, status: savedSeam ? 'confirmed' : 'pending', reason: '合成测试：两段文字不同', left: cues, right: [{ ...cues[0], text: '合成字幕另一个识别' }], proposed: cues, ...(savedSeam ? { resolved: cues } : {}) }] });
  try {
    studio = await startStudio({ port: 0, ...(process.env.DAOCUT_TRANSCRIPTION_UI ? { editorDir: resolve(process.env.DAOCUT_TRANSCRIPTION_UI) } : {}), openBrowser() {}, authorizeTask: async () => { calls.forbidden.push('authorizeTask'); throw Error('No real tasks'); } });
    const api = async (path, method = 'GET', body) => {
      const response = await fetch(studio.origin + path, { method, headers: { 'x-studio-key': studio.key, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data)); return data;
    };
    const { project } = await api('/api/projects', 'POST', { path: join(scratch, 'project') });
    await mkdir(join(project.path, 'assets'), { recursive: true });
    execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:size=96x160:rate=10:duration=12', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', join(project.path, source.assetPath)], { windowsHide: true });
    const analysis = { version: 1, sources: [source], products: [{ id: 'p', name: '全新测试视频', sourceIds: ['s'] }], intervals: hasInterval ? [{ id: 'i', sourceId: 's', productId: 'p', startMs: 0, endMs: 12000 }] : [], candidates: [] };
    if (multipleProducts) {
      analysis.products.push({ id: 'p2', name: '第二个商品', sourceIds: ['s'] });
      analysis.intervals[0].endMs = 6000;
      analysis.intervals.push({ id: 'i2', sourceId: 's', productId: 'p2', startMs: 6000, endMs: 12000 });
    }
    await api(`/api/projects/${project.id}/product-analysis`, 'PUT', { analysis });
    browser = await chromium.launch({ executablePath: process.env.DAOCUT_TEST_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.setDefaultTimeout(7000); page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (![studio.origin, studio.filmOrigin].includes(url.origin)) return route.abort();
      if (request.method() !== 'GET' && /\/(?:live-analysis|product-workflow|structure-plans|turns|chat|exports)(?:\/|$)/.test(url.pathname)) { calls.forbidden.push(url.pathname); return route.abort(); }
      return route.continue();
    });
    await page.route('**/live-analysis**', route => route.fulfill({ json: { transcription: transcription(), analysis: { status: analysisRunning ? 'running' : 'idle' } } }));
    await page.route('**/product-workflow/status**', route => route.fulfill({ json: { source, transcription: transcription(), discovery: { status: needsReview || discoveryReady ? 'complete' : 'idle' }, ready: hasInterval, discoveryReady, needsReview, busy: status === 'running' || analysisRunning } }));
    await page.route('**/product-workflow/plan**', route => {
      calls.plans.push(Object.fromEntries(new URL(route.request().url()).searchParams));
      return route.fulfill(planError ? { status: 503, json: { error: '模拟服务暂时不可用' } } : { json: { id: 'mock-confirmation', prepare: true, action: calls.plans.at(-1).action, sourceId: 's', source, enabled: true, cached: false, requestCount: 1, reusedRequests: 0, service: { name: '模拟服务', model: 'mock', endpoint: 'local://mock' }, cost: { uncertain: false, basis: '仅模拟' } } });
    });
    await page.route('**/product-workflow/execute', route => { calls.executions.push(route.request().postDataJSON()); status = 'complete'; discoveryReady = true; return route.fulfill({ json: { ok: true } }); });
    await page.route('**/product-discovery**', route => route.fulfill({ json: needsReview ? { status: 'complete', enabled: true, proposal: { runId: 'review', products: analysis.products, intervals: analysis.intervals, unassigned: [], issues: [] } } : { status: 'idle', enabled: true } }));
    await page.route('**/structure-plans**', route => route.fulfill({ json: { status: 'idle', version: 'ai-structure-plans-v6', plans: [], issues: [], error: '请先完成分析' } }));
    await page.route('**/transcript-review**', route => {
      if (route.request().method() === 'PUT') {
        const body = route.request().postDataJSON(); calls.saves.push(body);
        assert.equal(body.sourceId, 's'); assert.equal(body.confirmed, true); assert.equal(body.acknowledgeImpact, true);
        savedSeam = true; status = 'complete';
      }
      return route.fulfill({ json: initial === 'boundary' ? review() : { available: false } });
    });
    await page.goto(`${studio.origin}/projects/${project.id}?key=${studio.key}`);
    await page.getByRole('button', { name: '商品与结构', exact: true }).click();
    await run({ page, calls, scratch });
    assert.deepEqual(errors, []);
    assert.deepEqual(calls.forbidden, []);
    await page.screenshot({ path: join(scratch, 'verified.png'), fullPage: true });
  } catch (error) {
    await page?.screenshot({ path: join(scratch, 'failure.png'), fullPage: true }).catch(() => {});
    console.error('Transcription fixture:', scratch); throw error;
  } finally {
    await writeFile(join(scratch, 'requests.json'), JSON.stringify(calls, null, 2));
    await browser?.close(); await studio?.close();
    for (const name of names) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
  }
}

for (const hasInterval of [true, false]) test(`new source has a direct transcription button, including ${hasInterval ? 'manual whole-video range' : 'before product splitting'}`, { timeout: 60000 }, () => fixture('idle', async ({ page, calls }) => {
  const button = page.getByRole('button', { name: '转写并拆品 assets/synthetic.mp4', exact: true });
  await button.waitFor(); assert.equal(await button.isEnabled(), true);
  assert.equal(await page.getByRole('region', { name: '原视频转写', exact: true }).getByRole('button', { name: /^转写并拆品/ }).count(), 1);
  assert.equal(await page.locator('[data-product-card]').getByRole('button', { name: /转写/ }).count(), 0);
  assert.ok((await button.boundingBox()).height >= 39);
  await button.click();
  const dialog = page.getByRole('dialog', { name: '确认转写并拆品', exact: true });
  await dialog.getByRole('button', { name: '确认转写并拆品', exact: true }).waitFor();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(calls.executions.length, 0);
  await button.click();
  await dialog.getByRole('button', { name: '确认转写并拆品', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(calls.executions.length, 1);
  assert.equal(calls.executions[0].plan.action, 'transcription');
  assert.ok(calls.plans.every(plan => plan.action === 'transcription' && plan.sourceId === 's'));
  assert.ok(calls.plans.every(plan => !plan.productId && !plan.intervalId));
  if (hasInterval) await page.getByRole('button', { name: /^分析 00:00/ }).waitFor();
}, { hasInterval }));

test('saved segmented transcript opens seam review directly and only saves the correction', { timeout: 60000 }, () => fixture('boundary', async ({ page, calls, scratch }) => {
  const button = page.getByRole('button', { name: '核对转写 assets/synthetic.mp4', exact: true });
  await button.waitFor();
  assert.equal(await page.getByRole('region', { name: '原视频转写', exact: true }).getByRole('button', { name: /^核对转写/ }).count(), 1);
  assert.equal(await page.locator('[data-product-card]').getByRole('button', { name: /转写/ }).count(), 0);
  assert.equal(await page.getByLabel('直播拆品设置', { exact: true }).getAttribute('open'), null);
  await page.screenshot({ path: join(scratch, 'entry.png'), fullPage: true });
  await button.click();
  const review = page.getByRole('region', { name: '字幕接缝核对', exact: true });
  await review.getByRole('button', { name: '播放接缝原片', exact: true }).click();
  assert.equal(await review.getByRole('button', { name: '确认并保存接缝', exact: true }).isEnabled(), false);
  await review.getByRole('checkbox', { name: '已知悉字幕修改影响', exact: true }).check();
  await review.getByRole('button', { name: '确认并保存接缝', exact: true }).click();
  await page.getByRole('button', { name: /^分析 00:00/ }).waitFor();
  assert.equal(calls.saves.length, 1);
  const video = page.getByRole('region', { name: '原视频转写', exact: true });
  await video.getByRole('button', { name: /^继续拆品/ }).waitFor();
  assert.equal(await video.getByText('商品已准备好', { exact: true }).count(), 0);
  assert.deepEqual(calls.plans, []);
  assert.deepEqual(calls.executions, []);
}));

test('completed transcript with an old manual card keeps discovery available after reopening', { timeout: 60000 }, () => fixture('complete', async ({ page, calls }) => {
  const video = page.getByRole('region', { name: '原视频转写', exact: true });
  await video.getByRole('button', { name: /^继续拆品/ }).waitFor();
  await page.reload();
  await video.getByRole('button', { name: /^继续拆品/ }).waitFor();
  assert.equal(await video.getByText('商品已准备好', { exact: true }).count(), 0);
  assert.equal(calls.executions.length, 0);
  await video.getByRole('button', { name: /^继续拆品/ }).click();
  const dialog = page.getByRole('dialog', { name: '确认转写并拆品', exact: true });
  await dialog.getByRole('button', { name: '确认转写并拆品', exact: true }).click();
  await video.getByText('商品已准备好', { exact: true }).waitFor();
  assert.equal(calls.executions.length, 1);
  assert.equal(calls.executions[0].plan.action, 'discovery');
  assert.ok(calls.plans.every(plan => plan.action === 'discovery' && plan.prepare === 'true'));
}));

test('a failed plan is shown in the dialog without submitting a transcription', { timeout: 60000 }, () => fixture('idle', async ({ page, calls }) => {
  await page.getByRole('button', { name: '转写并拆品 assets/synthetic.mp4', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '确认转写并拆品', exact: true });
  await dialog.getByText('模拟服务暂时不可用', { exact: true }).waitFor();
  assert.equal(await dialog.getByRole('button', { name: '确认转写并拆品', exact: true }).isEnabled(), false);
  await dialog.getByRole('button', { name: '返回任务状态', exact: true }).click();
  assert.equal(calls.executions.length, 0);
}, { planError: true }));

test('running transcription is visible and cannot be resubmitted', { timeout: 60000 }, () => fixture('running', async ({ page, calls }) => {
  const button = page.getByRole('button', { name: '转写中… assets/synthetic.mp4', exact: true });
  await button.waitFor(); assert.equal(await button.isEnabled(), false);
  assert.equal(calls.plans.length, 0); assert.equal(calls.executions.length, 0);
}));

test('existing manual product ranges have a direct review entry rather than an endless prepare button', { timeout: 60000 }, () => fixture('complete', async ({ page, calls }) => {
  await page.getByRole('region', { name: '原视频转写', exact: true }).getByRole('button', { name: /^核对拆品/ }).click();
  await page.getByRole('button', { name: '核对并应用建议', exact: true }).waitFor();
  assert.equal(calls.executions.length, 0); assert.equal(calls.plans.length, 0);
}, { needsReview: true }));

test('several products share one full-video transcription rather than transcribing each product range', { timeout: 60000 }, () => fixture('idle', async ({ page, calls }) => {
  const video = page.getByRole('region', { name: '原视频转写', exact: true });
  await video.getByRole('button', { name: /^转写并拆品/ }).click();
  const dialog = page.getByRole('dialog', { name: '确认转写并拆品', exact: true });
  await dialog.getByText('范围：00:00 – 00:12', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: '确认转写并拆品', exact: true }).click();
  await video.getByText('商品已准备好', { exact: true }).waitFor();
  await page.locator('[data-product-card="p2"]').getByRole('button', { name: /^第二个商品/ }).click();
  await video.getByText('商品已准备好', { exact: true }).waitFor();
  assert.equal(await video.getByRole('button', { name: /转写/ }).count(), 0);
  assert.equal(await page.locator('[data-product-card]').getByRole('button', { name: /转写/ }).count(), 0);
  assert.equal(calls.executions.length, 1);
  assert.equal(calls.plans[0].sourceId, 's');
  assert.equal(calls.plans[0].productId, undefined);
  assert.equal(calls.plans[0].intervalId, undefined);
}, { multipleProducts: true }));

test('analysis running does not relabel completed product discovery as splitting', { timeout: 60000 }, () => fixture('complete', async ({ page, calls }) => {
  const video = page.getByRole('region', { name: '原视频转写', exact: true });
  await video.getByText('商品已准备好', { exact: true }).waitFor();
  assert.equal(await video.getByRole('button', { name: /拆品中/ }).count(), 0);
  const analyzing = page.getByRole('button', { name: /^分析中… / });
  await analyzing.waitFor();
  assert.equal(await analyzing.isEnabled(), false);
  assert.equal(calls.executions.length, 0);
}, { analysisRunning: true }));
